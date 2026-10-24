// Harness adapters (NOTES providers wiring step 3): one role run executed by the harness the router picked.
// Entered ONLY from claude() in lib.ts when config `providers.enabled` is true; absent/false = this file is never loaded.
// Hard rules:
//   - deny by default: a run leaves claude only when its tools are provably read-only (editsCode); kind build, a sandboxed kind,
//     or any tool that can edit or run code keeps it on claude native inside Dobby's sandbox (sandbox.ts) and guard hook;
//   - a run that resumes a session (o.session) stays on claude;
//   - runs that see untrusted PR content or publish their output (review, review-chat, check) stay on claude: codex reads are
//     not scoped, and real Gemini CLI does not ask permission for reads, so ACP reads are not scoped either (until verified);
//   - codex also never gets design, pm, area-pm, brainstorm or cos (posted or owner-data output) until its reads are scoped;
//   - ACP harnesses (gemini-cli) only with `providers.acp: true` (default off, not yet verified against a real agent);
//   - plain providers (no harness) only serve runs with no tools at all (`--tools ""`), through an injected ModelCall, and
//     tool-less runs go only to claude or a plain provider; a role with owner data (DOBBY_ROLES ownerData) never goes to a
//     plain provider unless providers.policy.allowUnsafe names "owner-data-to-providers";
//   - non-claude harnesses get a scrubbed env: no Claude login (Pro/Max), no ANTHROPIC_*, no other credentials but their own key.
// A failed non-claude profile cools 15 min and the route's next profile is tried; claude native ends the chain, so routing can
// only add options, never lose a run.
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, relative, resolve as resolvePath, isAbsolute, sep } from "node:path"
import { z } from "zod"
import { decide as guardDecide } from "../bin/guard-hook.mjs"
import { config } from "./config.ts"
import { logRun, type DB } from "./db.ts"
import { decide as policyDecide } from "./policy.ts"
import { ROOT, runAsync, trackGroup, untrackGroup, type claude } from "./lib.ts"
import type { ProvidersConfig } from "./providers/config.ts"
import { detect, type Detected } from "./providers/detect.ts"
import { HARNESSES } from "./providers/presets.ts"
import { resolve, type Health, type ModelCall, type RosterEntry, type RoutingTable } from "./providers/router.ts"
import { DOBBY_ROLES, routingState, runner } from "./providers/wire.ts"
import { builderEnv, CLAUDE_AUTH, sandboxMode } from "./sandbox.ts"
import { readSecrets } from "./telegram.ts"

export type RunOpts = Parameters<typeof claude>[1]
/** agents = how many agents this run used when more than one (claude() skips its stall retry at 2). */
export type Result = { ok: boolean; text: string; reason?: string; cost?: number; agents?: number }
export type Once = (db: DB, o: RunOpts) => Promise<Result>
/** guarded = runs inside Dobby's sandbox + guard hook (claude native only). */
export interface Adapter { name: string; guarded: boolean; run: Once }

const DEFAULT_TIMEOUT = 45 * 60_000 // same as claudeOnce
const UNTRUSTED_MS = 10 * 60_000 // review/check on a non-claude harness: a hung agent must not hold the PR for 45 min
const COOL_MS = 15 * 60_000 // a failed non-claude profile sits out this long
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x)

// ---- which runs may leave claude ------------------------------------------------------------------
/** Run kinds (claude() `kind`) that map to a routed role (DOBBY_ROLES). Anything else stays on claude. */
export const KIND_ROLE: Record<string, string> = {
  build: "builder", check: "checker", review: "reviewer", "review-chat": "reviewer", design: "designer",
  "safety-classify": "safety-classifier",
  pm: "product-manager", "area-pm": "area-pm", cos: "chief-of-staff", brainstorm: "brainstorm", onboard: "onboarder",
}
/** Kinds that see untrusted PR content or publish what they write: claude only (no other harness has scoped reads yet). */
export const UNTRUSTED_KINDS = new Set(["review", "review-chat", "check"])
/** Kinds whose output is posted or carries owner data: never codex until its reads are scoped (read-only sandbox still reads ~). */
export const NO_CODEX_KINDS = new Set([...UNTRUSTED_KINDS, "design", "pm", "area-pm", "brainstorm", "cos"])
export const harnessTimeout = (o: Pick<RunOpts, "kind" | "stallMs">) => Math.min(o.stallMs ?? DEFAULT_TIMEOUT, UNTRUSTED_KINDS.has(o.kind) ? UNTRUSTED_MS : DEFAULT_TIMEOUT)

/** Every value of a flag: `--f a b`, `--f=a`, repeated flags. undefined = the flag is absent. */
function flagValues(args: string[], names: string[]): string[] | undefined {
  let out: string[] | undefined
  for (let i = 0; i < args.length; i++) {
    const eq = args[i].indexOf("=")
    if (!names.includes(eq > 0 ? args[i].slice(0, eq) : args[i])) continue
    out ??= []
    if (eq > 0) out.push(args[i].slice(eq + 1))
    else while (i + 1 < args.length && !args[i + 1].startsWith("-")) out.push(args[++i]) // variadic, like claude's own parser
  }
  return out
}
/** Tool entries split on commas/whitespace outside parentheses (`Bash(npm run:*)` stays one entry). */
function toolList(values: string[]): string[] {
  const out: string[] = []
  let cur = "", depth = 0
  for (const ch of values.join(",")) {
    if (ch === "(") depth++
    else if (ch === ")") depth = Math.max(0, depth - 1)
    if (depth === 0 && (ch === "," || /\s/.test(ch))) { if (cur) out.push(cur); cur = "" } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}
const RO_TOOL = /^(Read|Grep|Glob|WebSearch|WebFetch)(\([^()]*\))?$/
/** Bash commands that only read. `Bash(<cmd>)`, `Bash(<cmd>:*)`, `Bash(<cmd> *)`; any other wildcard or command = not read-only. */
// rg and git grep are out: `rg --pre <cmd>` and `git grep -O<cmd>` run a program.
const RO_BASH = new Set(["ls", "cat", "head", "tail", "wc", "grep", "git diff", "git log", "git show", "git status", "git blame", "git ls-files"])
const readOnly = (t: string) => {
  if (RO_TOOL.test(t)) return true
  const cmd = t.match(/^Bash\((.+)\)$/)?.[1].replace(/(:\*| \*)$/, "").trim()
  return !!cmd && !cmd.includes("*") && RO_BASH.has(cmd)
}
/** The owner's builder-sandbox setting puts this kind in Claude Code's OS sandbox: it runs code, so it stays on claude. */
const sandboxed = (kind: string, env = process.env) =>
  sandboxMode(kind, env.DOBBY_BUILDER_SANDBOX ?? readSecrets().DOBBY_BUILDER_SANDBOX, env.DOBBY_SANDBOX_ROLES, true) !== "off"
/** claude flags that widen what a run may do (or that we cannot read past): any of them keeps the run on claude. */
const WIDENING = /^(--dangerously-skip-permissions|--permission-mode|--settings|--mcp-config|--agents)(=|$)/
/** Deny by default: true unless `--tools ""`, or `--tools` / `--allowedTools` (`--allowed-tools`) lists only read-only entries. */
export function editsCode(o: Pick<RunOpts, "kind" | "args">, env = process.env): boolean {
  if (o.kind === "build" || sandboxed(o.kind, env)) return true
  const args = o.args ?? []
  if (args.some((a, i) => a === "--" || WIDENING.test(a) || (a === "--tools" && (i + 1 >= args.length || args[i + 1].startsWith("-"))))) return true
  const tools = flagValues(args, ["--tools"]), allowed = flagValues(args, ["--allowedTools", "--allowed-tools"])
  if (tools && toolList(tools).includes("default")) return true
  const ro = (v?: string[]) => v !== undefined && toolList(v).every(readOnly)
  return !(ro(tools) || (!!allowed && toolList(allowed).length > 0 && ro(allowed)))
}
export const noTools = (o: Pick<RunOpts, "args">) => { const t = flagValues(o.args ?? [], ["--tools"]); return !!t && toolList(t).length === 0 }
/** Why this run must stay on claude whatever the table says, or undefined. Checked before detection or routing. */
export const claudeOnly = (o: Pick<RunOpts, "kind" | "args" | "session">) =>
  o.session ? "resumes a session: claude only" : editsCode(o) ? "edits code: claude only (sandbox + guard hook)" : undefined
/** The ACP role's Bash allowlist, from `--tools` itself: none unless `--tools` allows Bash. A bare `Bash` there takes the
 *  `--allowedTools` patterns (read-only, or editsCode would have kept the run on claude); `Bash(x)` entries are the patterns. */
export function acpBash(args: string[]): string[] {
  const tools = flagValues(args, ["--tools"])
  if (!tools || toolList(flagValues(args, ["--disallowedTools", "--disallowed-tools"]) ?? []).includes("Bash")) return []
  const bashOf = (v?: string[]) => toolList(v ?? []).flatMap((t) => t.match(/^Bash\((.+)\)$/)?.[1] ?? [])
  return toolList(tools).includes("Bash") ? bashOf(flagValues(args, ["--allowedTools", "--allowed-tools"])) : bashOf(tools)
}

// ---- resolve: role -> adapter ---------------------------------------------------------------------
export interface Makers {
  claude: Adapter
  codex?: (e: RosterEntry) => Adapter
  acp?: (e: RosterEntry, bin: string, argv: string[]) => Adapter
  provider?: (e: RosterEntry) => Adapter | undefined // undefined = no ModelCall injected for it
}
export interface Routing { table: RoutingTable; roster: RosterEntry[]; health: Health; cfg?: Pick<ProvidersConfig, "providers" | "acp"> & Partial<Pick<ProvidersConfig, "policy">> }

/** The adapter for `role` from the router's table. Profiles this run cannot use are skipped; nothing usable = claude native. */
/** The caller's Claude model is a quality floor (the review gate's haiku/sonnet/opus choice): a profile below it is not used. */
const TIER_RANK: Record<string, number> = { top: 3, mid: 2, cheap: 1, local: 0 }
const floor = (model?: string) => (/opus/i.test(model ?? "") ? 3 : /sonnet/i.test(model ?? "") ? 2 : 0)
export function resolveAdapter(role: string, o: Pick<RunOpts, "kind" | "args" | "session"> & { model?: string }, r: Routing, make: Makers, now = Date.now()): { adapter: Adapter; profile: string; why: string } {
  const stay = claudeOnly(o)
  if (stay) return { adapter: make.claude, profile: "claude-code", why: stay }
  const byName = new Map(r.roster.map((e) => [e.name, e]))
  const route = r.table.roles[role]
  const built = new Map<string, Adapter>()
  const health: Health = { ...r.health }
  for (const name of route ? [route.primary, ...route.fallback] : []) {
    const e = byName.get(name)
    const a = e && r.cfg?.providers[e.provider]?.enabled !== false && (e.provider === "claude-code" || TIER_RANK[e.tier] >= floor(o.model)) ? adapterFor(e, role, o, make, r.cfg) : undefined
    if (a) built.set(name, a)
    else health[name] = { down: true }
  }
  const pick = resolve(role, r.table, health, now)
  return pick ? { adapter: built.get(pick)!, profile: pick, why: "routed" } : { adapter: make.claude, profile: "claude-code", why: "no usable profile: claude" }
}

function adapterFor(e: RosterEntry, role: string, o: Pick<RunOpts, "kind" | "args">, make: Makers, cfg: Routing["cfg"]): Adapter | undefined {
  if (e.provider === "claude-code") return make.claude
  if (UNTRUSTED_KINDS.has(o.kind)) return undefined // no other harness has scoped reads; a plain provider's output is unchecked
  const h = HARNESSES.find((x) => x.id === e.provider)
  if (h) {
    if (noTools(o)) return undefined // a tool-less run never needs a harness: claude or a plain provider only
    if (h.acp) return cfg?.acp === true ? make.acp?.(e, h.bin, h.acp) : undefined // opt-in: providers.acp
    return e.provider === "codex-cli" && !NO_CODEX_KINDS.has(o.kind) ? make.codex?.(e) : undefined
  }
  if (!noTools(o)) return undefined // a plain provider cannot read files or run tools
  if (DOBBY_ROLES[role]?.ownerData && !cfg?.policy?.allowUnsafe.includes("owner-data-to-providers")) return undefined // privacy flag
  return make.provider?.(e)
}

// ---- env for non-claude harnesses ---------------------------------------------------------------
/** builderEnv's scrub, minus Claude's login and any ANTHROPIC_* (a Pro/Max plan never leaves the claude CLI), plus the harness's own key names. */
export function harnessEnv(base: NodeJS.ProcessEnv, cwd: string, keep: string[]): NodeJS.ProcessEnv {
  const env = builderEnv(base, cwd)
  for (const k of Object.keys(env)) if (CLAUDE_AUTH.includes(k) || /^(ANTHROPIC_|CLAUDE_CODE_OAUTH)/.test(k)) delete env[k]
  for (const k of keep) if (base[k] && !CLAUDE_AUTH.includes(k) && !k.startsWith("ANTHROPIC_")) env[k] = base[k]
  return env
}

// ---- codex native: `codex exec`, read-only sandbox, prompt on stdin --------------------------------
// Flags from `codex exec --help` (codex-cli 0.155.1, 20 Oct 2026). --ignore-user-config + `-c mcp_servers={}`: no MCP servers or
// approval/sandbox overrides from ~/.codex/config.toml or a repo's .codex/config.toml (the -c layer wins over both). --ignore-rules:
// no user or project execpolicy .rules files. A repo's .codex/config.toml cannot set model_provider, model_providers or
// openai_base_url (codex strips them from every project layer: PROJECT_LOCAL_CONFIG_DENYLIST in codex-rs/config/src/loader), and
// project layers load disabled for untrusted dirs (trust lives in the user config, which we skip), so no -c override is needed. --json: usage.
// Model: the roster/table model (`default` = codex's own). Effort: the caller's, capped at high. Sessions (resume) are claude-only: dropped.
export function codexArgs(cwd: string, outFile: string, model: string, effort?: string): string[] {
  const eff = effort && (["low", "medium", "high"].includes(effort) ? effort : ["xhigh", "max"].includes(effort) ? "high" : undefined)
  return ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "-c", "mcp_servers={}",
    ...(eff ? ["-c", `model_reasoning_effort="${eff}"`] : []), "--color", "never", "--json", "--cd", cwd,
    "--output-last-message", outFile, ...(model && model !== "default" ? ["--model", model] : []), "-"]
}
/** Tokens from `codex exec --json` (turn.completed usage events), summed; cost from the roster's price per Mtok. */
export function codexUsage(out: string, e: Pick<RosterEntry, "costPerMtok">) {
  let input_tokens = 0, output_tokens = 0, cache_read = 0
  for (const line of out.split("\n")) {
    let m: unknown
    try { m = JSON.parse(line) } catch { continue }
    if (!isObj(m) || m.type !== "turn.completed" || !isObj(m.usage)) continue
    input_tokens += Number(m.usage.input_tokens) || 0; output_tokens += Number(m.usage.output_tokens) || 0; cache_read += Number(m.usage.cached_input_tokens) || 0
  }
  return { input_tokens, output_tokens, cache_read, cost_usd: (input_tokens * e.costPerMtok.input + output_tokens * e.costPerMtok.output) / 1e6 }
}
/** Key names a harness may keep: the owner's providers.<id>.keyEnv, else the harness's own. */
const HARNESS_KEYS: Record<string, string[]> = { "codex-cli": ["OPENAI_API_KEY", "CODEX_API_KEY"] }
export const keysFor = (provider: string, cfg?: Pick<ProvidersConfig, "providers">) =>
  cfg?.providers[provider]?.keyEnv ?? HARNESS_KEYS[provider] ?? HARNESSES.find((h) => h.id === provider)?.loginCheck.envVars ?? []
export function codexAdapter(e: RosterEntry, bin = "codex", keys = keysFor("codex-cli")): Adapter {
  const keep = [...keys, "CODEX_HOME"] // CODEX_HOME = where its own login lives, not a key
  return {
    name: "codex-cli", guarded: false,
    run: async (db, o) => {
      const cwd = o.cwd ?? process.cwd()
      const dir = mkdtempSync(join(tmpdir(), "dobby-codex-"))
      const t0 = Date.now()
      const r = await runAsync(bin, codexArgs(cwd, join(dir, "last.txt"), e.model, o.effort), { cwd, env: harnessEnv(process.env, cwd, keep), timeoutMs: harnessTimeout(o), input: o.prompt, keep: 256 * 1024, all: true })
      let text = ""
      try { text = readFileSync(join(dir, "last.txt"), "utf8").trim() } catch {}
      rmSync(dir, { recursive: true, force: true })
      const ok = r.ok && !!text
      // Fixed reason codes only: codex's own output may echo the prompt, paths or PR text (and must never read as Claude signed out).
      const reason = ok ? undefined : r.timedOut && o.stallMs ? "stalled" : r.timedOut ? "codex: timed out" : !r.ok ? (/not logged in|login required|unauthori[sz]ed|401/i.test(r.out) ? "codex: not signed in" : "codex: exited with an error") : "codex: no answer"
      logRun(db, { project: o.project, kind: o.kind, ticket: o.ticket, model: `codex:${e.model}`, ok, reason, duration_ms: Date.now() - t0, ...codexUsage(r.out, e) })
      return { ok, text, reason }
    },
  }
}

// ---- strict ACP client (JSON-RPC 2.0, newline-delimited, over stdio) ---------------------------------
// We offer no client capabilities (no fs, no terminal), so fs/* and terminal/* requests get "method not found". Any line that is
// not JSON-RPC 2.0, an unknown notification, an unknown session update, a reply to an id we never sent, or a wrong sessionId
// ends the run and kills the agent's process group. Docs: https://agentclientprotocol.com/protocol/overview
const UPDATES = new Set(["user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan",
  "available_commands_update", "current_mode_update", "config_option_update", "session_info_update", "usage_update"])
/** Errors whose message is ours (fixed text): the only ones that reach a run's reason or the log. */
class AcpError extends Error {}
const STOPS = new Set(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"])
const MAX_LINE = 8 * 1024 * 1024
const MAX_TEXT = 1024 * 1024 // the answer itself
const MAX_TOTAL = 32 * 1024 * 1024 // everything the agent may send in one run

export interface AcpOpts { cwd: string; env: NodeJS.ProcessEnv; prompt: string; timeoutMs: number; requestMs?: number; permit: (toolCall: unknown) => boolean }
type Usage = { input_tokens?: number; output_tokens?: number; cache_read?: number; cost_usd?: number }
export function acpRun(bin: string, argv: string[], o: AcpOpts): Promise<Result & { timedOut?: boolean; usage?: Usage }> {
  return new Promise((done) => {
    let p: ReturnType<typeof spawn>
    try { p = spawn(bin, argv, { cwd: o.cwd, env: o.env, detached: true, stdio: ["pipe", "pipe", "pipe"] }) } catch { return done({ ok: false, text: "", reason: "acp: spawn failed" }) }
    if (p.pid) trackGroup(p.pid) // lib stops it if Dobby itself exits or is signalled
    let finished = false, text = "", buf = "", total = 0, nextId = 1, sessionId: string | undefined
    const usage: Usage = {}
    const pending = new Map<number, { method: string; ok: (v: unknown) => void; no: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>()
    const finish = (r: Result & { timedOut?: boolean; usage?: Usage }) => {
      if (finished) return
      finished = true
      clearTimeout(overall)
      for (const x of pending.values()) clearTimeout(x.timer)
      try { process.kill(-p.pid!, "SIGKILL") } catch {} // the agent and anything it started
      if (p.pid) untrackGroup(p.pid)
      done(Object.keys(usage).length ? { ...r, usage } : r)
    }
    const fail = (reason: string, timedOut = false) => finish({ ok: false, text, reason, ...(timedOut ? { timedOut } : {}) })
    const overall = setTimeout(() => fail("timed out", true), o.timeoutMs)
    const send = (m: object) => { if (!finished) p.stdin!.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n") }
    const request = (method: string, params: object, ms?: number) => new Promise<unknown>((ok, no) => {
      const id = nextId++
      // setup requests only: a setup timeout is a broken agent, not a stall (claude() must not read it as one)
      const timer = ms ? setTimeout(() => fail(`ACP setup: ${method} got no answer in ${Math.round(ms / 1000)} s`), ms) : undefined
      pending.set(id, { method, ok, no, timer })
      send({ id, method, params })
    })

    const onRequest = (id: unknown, method: string, params: unknown) => {
      if (method !== "session/request_permission") return send({ id, error: { code: -32601, message: `method not found: ${method}` } })
      if (!sessionId) return fail("protocol: request before session/new")
      if (!isObj(params) || params.sessionId !== sessionId || !Array.isArray(params.options)) return send({ id, error: { code: -32602, message: "invalid params" } })
      const pickKind = (k: string) => params.options.find((x: unknown) => isObj(x) && x.kind === k && typeof x.optionId === "string")
      // allow_once only (never allow_always); otherwise a reject. `cancelled` is only valid after session/cancel, which we never send.
      const opt = (o.permit(params.toolCall) && pickKind("allow_once")) || pickKind("reject_once") || pickKind("reject_always")
      if (!opt) return fail("protocol: permission request without a reject option")
      send({ id, result: { outcome: { outcome: "selected", optionId: opt.optionId } } })
    }
    const onNotification = (method: string, params: unknown) => {
      if (method !== "session/update") return fail("protocol: unknown notification")
      if (!sessionId) return fail("protocol: update before session/new")
      if (!isObj(params) || params.sessionId !== sessionId || !isObj(params.update) || !UPDATES.has(params.update.sessionUpdate)) return fail("protocol: bad session/update")
      const u = params.update
      if (u.sessionUpdate === "agent_message_chunk" && isObj(u.content) && u.content.type === "text" && typeof u.content.text === "string") {
        if (text.length + u.content.text.length > MAX_TEXT) return fail("answer too large")
        text += u.content.text
      }
      if (u.sessionUpdate === "usage_update" && isObj(u.cost) && typeof u.cost.amount === "number" && u.cost.currency === "USD") usage.cost_usd = u.cost.amount
    }
    const onLine = (line: string) => {
      let m: unknown
      try { m = JSON.parse(line) } catch { return fail("protocol: not JSON") }
      if (!isObj(m) || m.jsonrpc !== "2.0") return fail("protocol: not JSON-RPC 2.0")
      if (typeof m.method === "string") return "id" in m ? onRequest(m.id, m.method, m.params) : onNotification(m.method, m.params)
      const w = typeof m.id === "number" ? pending.get(m.id) : undefined
      if (!w || "method" in m) return fail("protocol: unexpected message")
      pending.delete(m.id as number)
      clearTimeout(w.timer)
      if (isObj(m.error)) return w.no(new AcpError(`acp: ${w.method} failed`)) // fixed code: the agent's error text never reaches logs
      if (!("result" in m)) return fail("protocol: response without result")
      // set synchronously: updates for the new session may sit in the same chunk as this reply
      if (w.method === "session/new" && isObj(m.result) && typeof m.result.sessionId === "string") sessionId = m.result.sessionId
      w.ok(m.result)
    }

    p.stdout!.setEncoding("utf8").on("data", (d: string) => {
      if ((total += d.length) > MAX_TOTAL) return fail("protocol: too much output")
      buf += d
      for (let i = buf.indexOf("\n"); i >= 0 && !finished; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) onLine(line)
      }
      if (buf.length > MAX_LINE) fail("protocol: message too large")
    })
    p.stderr!.resume() // drained, never logged (may echo env or paths)
    p.stdin!.on("error", () => {})
    p.on("error", () => fail("acp: spawn failed"))
    p.on("close", (code) => fail(`agent exited (${Number.isInteger(code) ? code : "signal"})`))

    ;(async () => {
      const init = await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, o.requestMs ?? 30_000)
      if (!isObj(init) || init.protocolVersion !== 1) throw new AcpError("unsupported ACP protocol version")
      const s = await request("session/new", { cwd: o.cwd, mcpServers: [] }, o.requestMs ?? 30_000)
      if (!isObj(s) || typeof s.sessionId !== "string") throw new AcpError("session/new: no sessionId")
      const r = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: o.prompt }] }) // the overall timeout governs
      const stop = isObj(r) ? r.stopReason : undefined
      const u = isObj(r) && isObj(r.usage) ? r.usage : undefined // optional in the spec: token counts for this turn
      if (u) for (const [k, from] of [["input_tokens", "inputTokens"], ["output_tokens", "outputTokens"], ["cache_read", "cachedReadTokens"]] as const)
        if (typeof u[from] === "number") usage[k] = u[from]
      finish(stop === "end_turn" ? { ok: true, text } : { ok: false, text, reason: `stopped: ${STOPS.has(stop as string) ? stop : "other"}` })
    })().catch((e: Error) => fail(e instanceof AcpError ? e.message : "acp: error"))
  })
}

/** Deny by default. think: yes. read/search: only existing regular files inside cwd that are not secret files (never the root or
 *  a directory: a search over a tree would cover .env and the like). execute: the role's Bash allowlist
 *  through the guard hook's rules, then policy.ts `command` rules (deny/ask = no). Everything else (edit, delete, move, fetch...): no. */
const SECRET_PATH = /(^|\/)(\.env[^/]*|secrets\.env|\.ssh|\.config|\.aws|\.netrc|\.npmrc|\.git-credentials|\.git\/config)(\/|$)/
const isFile = (p: string) => { try { return statSync(p).isFile() } catch { return false } }
export function permit(toolCall: unknown, ctx: { cwd: string; bash: string[]; wtRoot?: string; branch?: () => string }): boolean {
  if (!isObj(toolCall)) return false
  if (toolCall.kind === "think") return true
  if (toolCall.kind === "read" || toolCall.kind === "search") {
    const paths = Array.isArray(toolCall.locations) ? toolCall.locations.map((l: unknown) => (isObj(l) && typeof l.path === "string" ? l.path : "")) : []
    const real = (p: string) => { try { return realpathSync(p) } catch { return p } } // a symlink out of the repo counts as out
    const roots = [...new Set([ctx.cwd, real(ctx.cwd)])]
    return paths.length > 0 && paths.every((p: string) => {
      if (!p) return false
      const abs = real(resolvePath(ctx.cwd, p))
      return isFile(abs) && roots.some((root) => {
        const rel = relative(root, abs)
        return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && !SECRET_PATH.test(rel)
      })
    })
  }
  if (toolCall.kind === "execute") {
    const c = isObj(toolCall.rawInput) ? toolCall.rawInput.command : undefined
    const cmd = typeof c === "string" ? c : Array.isArray(c) && c.every((x) => typeof x === "string") ? c.join(" ") : undefined
    if (!cmd) return false
    const g = guardDecide(cmd, { cwd: ctx.cwd, wtRoot: ctx.wtRoot ?? ctx.cwd, home: homedir(), foremanRoot: ROOT.replace(/\/$/, ""), dataDir: process.env.DOBBY_DIR || `${homedir()}/.local/share/dobby`, branch: ctx.branch ?? (() => ""), allow: ctx.bash })
    return !!g.allow && policyDecide("command", cmd).action === "allow"
  }
  return false
}

/** The same git facts the guard hook reads for claude (bin/guard-hook.mjs): worktree top level and the current branch. */
export function gitCtx(cwd: string) {
  const git = (...a: string[]) => spawnSync("git", ["-C", cwd, ...a], { encoding: "utf8", timeout: 10_000 }).stdout?.trim() ?? ""
  return { wtRoot: git("rev-parse", "--show-toplevel") || cwd, branch: () => git("rev-parse", "--abbrev-ref", "HEAD") }
}

/** Per-harness lockdown on top of the ACP flag. gemini-cli (flags from local `gemini --help` 0.9.0): approvals stay on (a repo's
 *  .gemini/settings.json cannot turn on yolo/auto_edit), no MCP servers, no extensions; a system settings file (highest precedence,
 *  over user and workspace settings) empties mcpServers, turns autoAccept off and limits tools.core to the read tools (plus
 *  run_shell_command only when the role has a Bash allowlist); web search/fetch, writes and memory are excluded. Gemini does not
 *  ask permission for reads, so its reads are NOT scoped by permit(): unverified against a real agent (NOTES).
 *  Model: the roster/table model unless `default`. */
const GEMINI_READ = ["read_file", "read_many_files", "list_directory", "glob", "search_file_content"]
const GEMINI_OFF = ["google_web_search", "web_fetch", "write_file", "replace", "save_memory"]
export function acpHarden(e: Pick<RosterEntry, "provider" | "model">, dir: string, shell = false): { args: string[]; env: NodeJS.ProcessEnv } {
  if (e.provider !== "gemini-cli") return { args: [], env: {} }
  const settings = join(dir, "system-settings.json")
  const tools = { autoAccept: false, core: [...GEMINI_READ, ...(shell ? ["run_shell_command"] : [])], exclude: [...GEMINI_OFF, ...(shell ? [] : ["run_shell_command"])] }
  writeFileSync(settings, JSON.stringify({ mcpServers: {}, tools }))
  return {
    args: ["--approval-mode", "default", "--allowed-mcp-server-names", "", "--extensions", "none", ...(e.model && e.model !== "default" ? ["--model", e.model] : [])],
    env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings },
  }
}

export function acpAdapter(e: RosterEntry, bin: string, argv: string[], keep = keysFor(e.provider)): Adapter {
  return {
    name: e.provider, guarded: false,
    run: async (db, o) => {
      const cwd = o.cwd ?? process.cwd()
      const t0 = Date.now()
      const bash = acpBash(o.args ?? []) // from --tools itself, never --allowedTools alone
      const g = gitCtx(cwd)
      const dir = mkdtempSync(join(tmpdir(), "dobby-acp-"))
      const h = acpHarden(e, dir, bash.length > 0)
      // Sessions (resume) and effort are claude-only and dropped here: ACP has no effort setting; each run is a fresh session.
      const r = await acpRun(bin, [...argv, ...h.args], { cwd, env: { ...harnessEnv(process.env, cwd, keep), ...h.env }, prompt: o.prompt, timeoutMs: harnessTimeout(o), permit: (tc) => permit(tc, { cwd, bash, ...g }) })
        .finally(() => rmSync(dir, { recursive: true, force: true }))
      const reason = r.timedOut && o.stallMs ? "stalled" : r.reason
      logRun(db, { project: o.project, kind: o.kind, ticket: o.ticket, model: `acp:${e.name}`, ok: r.ok, reason, duration_ms: Date.now() - t0, ...r.usage,
        ...(r.usage?.cost_usd === undefined && r.usage?.input_tokens !== undefined ? { cost_usd: ((r.usage.input_tokens ?? 0) * e.costPerMtok.input + (r.usage.output_tokens ?? 0) * e.costPerMtok.output) / 1e6 } : {}) })
      return { ok: r.ok, text: r.text, reason }
    },
  }
}

// ---- plain providers: an injected ModelCall (step 2: an AI SDK provider stays optional) -----------------
/** Owner-supplied: a ModelCall for a roster profile (e.g. an AI SDK provider's generate), or undefined to skip it. */
export type ProviderCalls = (e: RosterEntry) => ModelCall | undefined
let providerCalls: ProviderCalls | undefined
export const setProviderCalls = (f?: ProviderCalls) => { providerCalls = f }

export function providerAdapter(e: RosterEntry, call: ModelCall): Adapter {
  return {
    name: e.provider, guarded: false,
    run: async (db, o) => {
      const t0 = Date.now()
      try {
        const { value, usage } = await call<string>({ schema: z.string(), instructions: "", input: o.prompt, signal: AbortSignal.timeout(harnessTimeout(o)) })
        const text = String(value ?? "").trim()
        logRun(db, { project: o.project, kind: o.kind, ticket: o.ticket, model: `provider:${e.name}`, ok: !!text, reason: text ? undefined : "empty answer", turns: 1, duration_ms: Date.now() - t0,
          ...(usage ? { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cost_usd: (usage.inputTokens * e.costPerMtok.input + usage.outputTokens * e.costPerMtok.output) / 1e6 } : {}) })
        return text ? { ok: true, text } : { ok: false, text: "", reason: "empty answer" }
      } catch (err) {
        const reason = `provider: ${(err as Error)?.name === "TimeoutError" ? "timed out" : "error"}` // fixed code: an SDK message may echo the request
        logRun(db, { project: o.project, kind: o.kind, ticket: o.ticket, model: `provider:${e.name}`, ok: false, reason, duration_ms: Date.now() - t0 })
        return { ok: false, text: "", reason }
      }
    },
  }
}

// ---- the wrapper claude() uses when providers.enabled -------------------------------------------
// ponytail: detection (which + `claude auth status` + `codex login status` + port probes) cached 10 min per process.
let seen: { at: number; d: Promise<Detected> } | undefined
function detectedNow(now = Date.now()): Promise<Detected> {
  if (!seen || now - seen.at > 10 * 60_000) {
    const r = runner()
    seen = { at: now, d: detect(process.env, r.which, r.probe, r.runStatus) }
  }
  return seen.d
}

export interface RoutedDeps { cfg?: ProvidersConfig; detected?: () => Promise<Detected>; makers?: Partial<Omit<Makers, "claude">>; log?: (m: string) => void }
const COOL = "harness-cool:"
const DAY_MS = 24 * 3600_000
/** The runs table's model name for a profile's runs, as each adapter logs them. */
const runModel = (e: RosterEntry) => (e.provider === "codex-cli" ? `codex:${e.model}` : HARNESSES.some((h) => h.id === e.provider && h.acp) ? `acp:${e.name}` : `provider:${e.name}`)
/** Providers at their pace (providers.<id>.limit: dollars or runs over the last 24 hours): every profile of theirs is skipped. */
export function paced(db: DB, cfg: Pick<ProvidersConfig, "providers">, roster: RosterEntry[], now = Date.now()): Health {
  const out: Health = {}
  for (const [id, p] of Object.entries(cfg.providers)) {
    const es = roster.filter((e) => e.provider === id)
    if (!p.limit || id === "claude-code" || !es.length) continue
    const names = es.map(runModel)
    const r = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS s FROM runs WHERE at >= ? AND model IN (${names.map(() => "?").join(",")})`).get(new Date(now - DAY_MS).toISOString(), ...names) as { n: number; s: number }
    if ((p.limit.dailyUsd && r.s >= p.limit.dailyUsd) || (p.limit.dailyRuns && r.n >= p.limit.dailyRuns)) for (const e of es) out[e.name] = { down: true }
  }
  return out
}
/** Profiles still cooling after a failure (kv, so a restarted tick remembers). */
function cooling(db: DB, now: number): Health {
  const rows = db.prepare("SELECT k, v FROM kv WHERE k LIKE ?").all(`${COOL}%`) as { k: string; v: string }[]
  return Object.fromEntries(rows.filter((r) => Number(r.v) > now).map((r) => [r.k.slice(COOL.length), { coolUntil: Number(r.v) }]))
}
/** `once` (claudeOnce) wrapped: routed kinds go to the resolved adapter; a failed non-claude profile cools and the route's next
 *  profile is tried; claude native (`once`) ends the chain. */
export function routed(once: Once, deps: RoutedDeps = {}): Once {
  return async (db, o) => {
    const role = KIND_ROLE[o.kind]
    const cfg = deps.cfg ?? config().providers
    if (!role || !cfg?.enabled || claudeOnly(o)) return once(db, o) // before detection: no probes for a run that cannot leave claude
    const log = deps.log ?? console.error
    const make: Makers = {
      claude: { name: "claude-code", guarded: true, run: once },
      codex: (e) => codexAdapter(e, "codex", keysFor(e.provider, cfg)), acp: (e, bin, argv) => acpAdapter(e, bin, argv, keysFor(e.provider, cfg)),
      provider: (e) => { const c = providerCalls?.(e); return c && providerAdapter(e, c) },
      ...deps.makers,
    }
    let st: Routing
    try {
      const now = Date.now()
      const s = routingState(db, await (deps.detected ?? detectedNow)(), cfg, now)
      st = { ...s, health: { ...s.health, ...cooling(db, now), ...paced(db, cfg, s.roster, now) }, cfg }
    } catch (e) {
      log(`agents: routing failed (${(e as Error).message}), ${o.kind} runs on claude`)
      return once(db, o)
    }
    for (let agents = 0; ; agents++) { // ends: every failure cools its profile, so claude native comes up at the latest when all have
      const pick = resolveAdapter(role, o, st, make)
      if (pick.adapter.guarded) { const r = await pick.adapter.run(db, o); return agents ? { ...r, agents: agents + 1 } : r }
      let r: Result
      try { r = await pick.adapter.run(db, o) } catch { r = { ok: false, text: "", reason: "adapter threw" } } // fixed code: a thrown message may carry agent text
      if (r.ok) return agents ? { ...r, agents: agents + 1 } : r
      const until = Date.now() + COOL_MS
      log(`agents: ${o.kind} on ${pick.profile} failed (${r.reason ?? "no answer"}); it cools ${COOL_MS / 60_000} min, trying the next profile`)
      db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`${COOL}${pick.profile}`, String(until))
      st.health = { ...st.health, [pick.profile]: { coolUntil: until } }
    }
  }
}

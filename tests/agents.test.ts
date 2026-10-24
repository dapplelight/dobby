// Harness adapters (src/agents.ts): resolve, the opt-in gate, codex exec and strict ACP against fake binaries. No network.
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-agents-`)
process.env.DOBBY_DIR ??= dir
process.env.DOBBY_SECRETS ??= `${dir}/secrets.env`
const A = await import("../src/agents.ts")
const L = await import("../src/lib.ts")
const { open } = await import("../src/db.ts")
const { config, setConfig } = await import("../src/config.ts")
const { providersConfigSchema } = await import("../src/providers/config.ts")
const { DEFAULT_ROSTER } = await import("../src/providers/router.ts")
type Adapter = import("../src/agents.ts").Adapter

const bin = (name: string, src: string) => { const p = `${dir}/${name}`; writeFileSync(p, `#!/usr/bin/env node\n${src}`); chmodSync(p, 0o755); return p }
const fake = (name: string, text = name): Adapter => ({ name, guarded: false, run: async () => ({ ok: true, text }) })
const claudeA: Adapter = { name: "claude-code", guarded: true, run: async () => ({ ok: true, text: "claude" }) }
const byName = (n: string) => DEFAULT_ROSTER.find((e) => e.name === n)!
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

test("gate: providers absent or not enabled = claude() calls the original once with the same options", async () => {
  const db = open(":memory:")
  const base = config()
  for (const providers of [undefined, providersConfigSchema.parse({})]) {
    setConfig({ ...base, providers })
    const seen: unknown[] = []
    const o = { project: "p", kind: "review", model: "opus", prompt: "x", args: ["--allowedTools", "Read"] }
    const r = await L.claude(db, o, async (_d, got) => { seen.push(got); return { ok: true, text: "native" } })
    assert.equal(r.text, "native")
    assert.equal(seen[0], o, "same object, untouched")
  }
  setConfig(undefined)
})

test("resolveAdapter: code-editing runs stay on claude; disabled/unusable profiles are skipped; providers only for tool-less runs", () => {
  const roster = DEFAULT_ROSTER
  const table = { main: "codex", roles: {
    builder: { primary: "codex", fallback: [] }, reviewer: { primary: "codex", fallback: ["claude-code"] },
    "chief-of-staff": { primary: "gpt-5-mini", fallback: ["codex"] }, designer: { primary: "gemini-cli", fallback: [] },
  } }
  const make = { claude: claudeA, codex: () => fake("codex"), provider: () => fake("provider"), acp: (_e: unknown, b: string, argv: string[]) => fake(`acp:${b} ${argv.join(" ")}`) }
  const r = (role: string, o: { kind: string; args?: string[] }, extra: object = {}, m: object = make) => A.resolveAdapter(role, o, { roster, table, health: {}, ...extra }, m as any)
  assert.equal(r("builder", { kind: "build" }).adapter.name, "claude-code")
  assert.equal(r("reviewer", { kind: "review", args: ["--allowedTools", "Read,Edit"] }).adapter.name, "claude-code", "Edit = edits code")
  assert.equal(r("reviewer", { kind: "review", args: ["--allowedTools", "Read,Bash"] }).adapter.name, "claude-code", "bare Bash = edits code")
  assert.equal(r("reviewer", { kind: "review", args: ["--allowedTools", "Read,Bash(git diff:*)"] }).adapter.name, "claude-code", "untrusted PR content: never codex")
  const ro = ["--allowedTools", "Read,Grep"]
  const ob = { ...table, roles: { ...table.roles, onboarder: { primary: "gpt-5-mini", fallback: ["codex"] } } }
  assert.equal(r("onboarder", { kind: "onboard", args: ro }, { table: ob }).adapter.name, "codex")
  assert.equal(r("onboarder", { kind: "onboard", args: ro, session: "t1" } as any, { table: ob }).profile, "claude-code", "a resumed session stays on claude")
  assert.equal(r("onboarder", { kind: "onboard", args: ro }, { table: ob, cfg: { providers: { "codex-cli": { enabled: false } } } }).adapter.name, "claude-code")
  assert.equal(r("onboarder", { kind: "onboard", args: ro }, { table: ob, health: { codex: { down: true }, "gpt-5-mini": { down: true } } }).profile, "claude-code")
  assert.equal(r("onboarder", { kind: "onboard", args: ["--tools", ""] }, { table: ob }).adapter.name, "provider")
  assert.equal(r("onboarder", { kind: "onboard", args: ["--tools", ""] }, { table: ob }, { ...make, provider: () => undefined }).profile, "claude-code", "no ModelCall injected; a tool-less run never goes to codex")
  assert.equal(r("onboarder", { kind: "onboard", args: ["--allowedTools", "Read"] }, { table: ob }).adapter.name, "codex", "a run with tools never goes to a plain provider")
  for (const kind of ["cos", "design", "pm", "area-pm", "brainstorm"]) {
    const t = { ...table, roles: { x: { primary: "codex", fallback: [] } } }
    assert.equal(r("x", { kind, args: ro }, { table: t }).profile, "claude-code", `${kind}: posted or owner-data output, never codex`)
  }
  // privacy flag: chief-of-staff has owner data, so no plain provider unless the owner allows it
  assert.equal(r("chief-of-staff", { kind: "cos", args: ["--tools", ""] }).profile, "claude-code")
  assert.equal(r("chief-of-staff", { kind: "cos", args: ["--tools", ""] }, { cfg: { providers: {}, policy: { allowUnsafe: ["owner-data-to-providers"] } } }).adapter.name, "provider")
  assert.equal(r("designer", { kind: "design", args: ro }).profile, "claude-code", "ACP is opt-in (providers.acp)")
  assert.equal(r("designer", { kind: "design", args: ro }, { cfg: { providers: {}, acp: true } }).adapter.name, "acp:gemini --experimental-acp")
  assert.equal(r("designer", { kind: "design", args: ["--tools", ""] }, { cfg: { providers: {}, acp: true } }).profile, "claude-code", "a tool-less run never goes to ACP")
  assert.equal(r("designer", { kind: "design", args: ro, model: "opus" } as any, { cfg: { providers: {}, acp: true } }).profile, "claude-code", "opus floor: mid-tier gemini skipped")
  const rev = { ...table, roles: { ...table.roles, reviewer: { primary: "gemini-cli", fallback: ["codex", "claude-code"] } } }
  for (const kind of ["review", "review-chat", "check"])
    assert.equal(r("reviewer", { kind, args: ro }, { table: rev, cfg: { providers: {}, acp: true } }).profile, "claude-code", `${kind}: ACP reads are not scoped (Gemini reads without asking), never codex`)
  assert.equal(r("lead", { kind: "lead" }).profile, "claude-code", "no route = claude")
})

test("routed: unmapped kind or disabled = once; non-claude success returned; non-claude failure falls back to claude once", async () => {
  const db = open(":memory:")
  const detected = async () => ({ harnesses: [{ id: "claude-code", path: "/c", loggedIn: true as const }, { id: "codex-cli", path: "/x", loggedIn: true as const }], apiKeys: [], local: [] })
  const cfg = providersConfigSchema.parse({ enabled: true, roles: { onboarder: { primary: "codex", fallback: ["claude-code"] } } })
  let natives = 0
  const once = async () => (natives++, { ok: true, text: "native" })
  const o = { project: "p", kind: "onboard", model: "sonnet", prompt: "x", args: ["--allowedTools", "Read"] }
  const logs: string[] = []
  const ok = A.routed(once, { cfg, detected, makers: { codex: () => fake("codex", "from codex") }, log: (m) => logs.push(m) })
  assert.equal((await ok(db, o)).text, "from codex")
  assert.equal(natives, 0)
  assert.equal((await ok(db, { ...o, kind: "dedupe" })).text, "native")
  assert.equal((await A.routed(once, { cfg: { ...cfg, enabled: false }, detected })(db, o)).text, "native")
  const bad = A.routed(once, { cfg, detected, log: (m) => logs.push(m), makers: { codex: () => ({ name: "codex", guarded: false, run: async () => ({ ok: false, text: "", reason: "boom" }) }) } })
  assert.equal((await bad(db, o)).text, "native")
  assert.match(logs.join("\n"), /onboard on codex failed \(boom\); it cools 15 min/)
  const until = Number((db.prepare("SELECT v FROM kv WHERE k='harness-cool:codex'").get() as { v: string }).v)
  assert.ok(until > Date.now() + 14 * 60_000, "cool-down stored")
  // while it cools, codex is skipped without being run
  let ran = 0
  const cooled = A.routed(once, { cfg, detected, makers: { codex: () => ({ name: "codex", guarded: false, run: async () => (ran++, { ok: true, text: "codex" }) }) } })
  assert.equal((await cooled(db, o)).text, "native")
  assert.equal(ran, 0)
})

test("routed: a failed profile tries the route's next non-claude profile before claude; a throw falls back with a fixed reason", async () => {
  const db = open(":memory:")
  const detected = async () => ({ harnesses: [{ id: "claude-code", path: "/c", loggedIn: true as const }], apiKeys: [{ provider: "openai", envVar: "OPENAI_API_KEY" }], local: [] })
  const cfg = providersConfigSchema.parse({ enabled: true, roles: { onboarder: { primary: "gpt-5", fallback: ["gpt-5-mini", "claude-code"] } } })
  const o = { project: "p", kind: "onboard", model: "haiku", prompt: "x", args: ["--tools", ""] }
  const order: string[] = [], logs: string[] = []
  const f = A.routed(async () => (order.push("claude"), { ok: true, text: "native" }), { cfg, detected, log: (m) => logs.push(m), makers: {
    provider: (e) => ({ name: e.name, guarded: false, run: async () => {
      order.push(e.name)
      if (e.name === "gpt-5") throw new Error("leaked secret sk-123 from the agent")
      return { ok: true, text: "mini" }
    } }) } })
  const r = await f(db, o)
  assert.deepEqual(order, ["gpt-5", "gpt-5-mini"])
  assert.equal(r.text, "mini")
  assert.equal(r.agents, 2)
  assert.match(logs.join("\n"), /failed \(adapter threw\)/)
  assert.doesNotMatch(logs.join("\n"), /sk-123/)
})

test("routed: runs that cannot leave claude skip detection entirely", async () => {
  const db = open(":memory:")
  const cfg = providersConfigSchema.parse({ enabled: true })
  let detects = 0
  const f = A.routed(async () => ({ ok: true, text: "native" }), { cfg, detected: async () => { detects++; throw new Error("no") } })
  for (const o of [{ kind: "onboard" }, { kind: "onboard", args: ["--tools", ""], session: "t1" }, { kind: "onboard", args: ["--allowedTools", "Edit"] }])
    assert.equal((await f(db, { project: "p", model: "sonnet", prompt: "x", ...o })).text, "native")
  assert.equal(detects, 0)
})

test("claude(): a stalled routed run that already fell back to claude is not retried again (2 agents max)", async () => {
  const db = open(":memory:")
  const base = config()
  setConfig({ ...base, providers: providersConfigSchema.parse({ enabled: true }) })
  try {
    let calls = 0
    const r = await L.claude(db, { project: "p", kind: "lead", model: "sonnet", prompt: "x" }, async () => (calls++, { ok: false, text: "", reason: "stalled", agents: 2 }), async () => {})
    assert.equal(calls, 1)
    assert.equal(r.reason, "stalled")
  } finally { setConfig(undefined) }
})

test("editsCode: deny by default; only provably read-only tool lists leave claude", () => {
  const e = (args?: string[], kind = "cos", env: NodeJS.ProcessEnv = {}) => A.editsCode({ kind, args }, env)
  assert.equal(e(undefined), true, "no --allowedTools = claude")
  assert.equal(e(["--model", "x"]), true)
  assert.equal(e(["--tools", ""]), false)
  assert.equal(e(["--tools="]), false)
  assert.equal(e(["--allowedTools", "Read,Grep,Glob"]), false)
  assert.equal(e(["--allowedTools=Read,WebSearch"]), false)
  assert.equal(e(["--allowed-tools", "Read", "Grep", "--model", "x"]), false, "space-separated variadic list")
  assert.equal(e(["--allowedTools", "Read Grep"]), false)
  assert.equal(e(["--allowedTools", "Read,Bash(git diff:*),Bash(ls *),Bash(npm run:*)"]), true, "npm run is not read-only")
  assert.equal(e(["--allowedTools", "Read,Bash(git diff:*),Bash(ls *)"]), false)
  assert.equal(e(["--allowedTools", "Edit(src/**)"]), true)
  assert.equal(e(["--allowedTools", "Read,Bash(*)"]), true)
  assert.equal(e(["--allowedTools", "Read,Bash"]), true)
  assert.equal(e(["--allowedTools", "Read,mcp__x__y"]), true, "unknown tool = edits")
  assert.equal(e(["--allowedTools", "Read", "--allowedTools", "Write"]), true, "repeated flag")
  assert.equal(e(["--tools", "Read,Grep,Glob"]), false)
  assert.equal(e(["--tools", "Read,Grep,Glob,Bash", "--allowedTools", "Read,Bash(git log:*)"]), false)
  assert.equal(e(["--allowedTools", "Read"], "build"), true)
  assert.equal(e(["--allowedTools", "Read"], "cos", { DOBBY_SANDBOX_ROLES: "build,cos" }), true, "sandboxed kind stays on claude")
  assert.equal(e(["--allowedTools", "Read"], "cos", { DOBBY_SANDBOX_ROLES: "build,cos", DOBBY_BUILDER_SANDBOX: "off" }), false)
  for (const extra of [["--dangerously-skip-permissions"], ["--permission-mode", "plan"], ["--permission-mode=bypassPermissions"], ["--settings", "x.json"], ["--mcp-config", "m.json"], ["--agents", "{}"], ["--"]])
    assert.equal(e(["--tools", "", ...extra]), true, `${extra[0]} keeps the run on claude`)
  assert.equal(e(["--tools", "default"]), true, "--tools default = every tool")
  assert.equal(e(["--tools"]), true, "bare --tools")
  assert.equal(e(["--tools", "--model", "x"]), true, "bare --tools before another flag")
  assert.equal(e(["--allowedTools", "Read,Bash(rg:*)"]), true, "rg --pre runs a program")
  assert.equal(e(["--allowedTools", "Read,Bash(git grep:*)"]), true, "git grep -O runs a program")
  assert.equal(A.noTools({ args: ["--tools", ""] }), true)
  assert.equal(A.noTools({ args: ["--tools", "Read"] }), false)
})

test("harness settings: per-harness keys from providers.<id>.keyEnv; review/check get a 10 min cap; gemini lockdown flags", () => {
  assert.deepEqual(A.keysFor("codex-cli"), ["OPENAI_API_KEY", "CODEX_API_KEY"])
  assert.deepEqual(A.keysFor("gemini-cli"), ["GEMINI_API_KEY", "GOOGLE_API_KEY"])
  assert.deepEqual(A.keysFor("gemini-cli", { providers: { "gemini-cli": { enabled: true, keyEnv: ["MY_GEMINI"], strategy: "fill_first" } } }), ["MY_GEMINI"])
  assert.equal(A.harnessTimeout({ kind: "review" }), 10 * 60_000)
  assert.equal(A.harnessTimeout({ kind: "check", stallMs: 60_000 }), 60_000)
  assert.equal(A.harnessTimeout({ kind: "cos" }), 45 * 60_000)
  const h = A.acpHarden({ provider: "gemini-cli", model: "gemini-2.5-pro" }, dir)
  assert.deepEqual(h.args, ["--approval-mode", "default", "--allowed-mcp-server-names", "", "--extensions", "none", "--model", "gemini-2.5-pro"])
  const read = ["read_file", "read_many_files", "list_directory", "glob", "search_file_content"]
  assert.deepEqual(JSON.parse(readFileSync(h.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, "utf8")), { mcpServers: {}, tools: { autoAccept: false, core: read,
    exclude: ["google_web_search", "web_fetch", "write_file", "replace", "save_memory", "run_shell_command"] } })
  const hs = A.acpHarden({ provider: "gemini-cli", model: "default" }, dir, true)
  assert.deepEqual(JSON.parse(readFileSync(hs.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH!, "utf8")).tools.core, [...read, "run_shell_command"])
  assert.ok(A.codexArgs("/w", "/o", "default", "max").includes('model_reasoning_effort="high"'))
  for (const f of ["--ignore-user-config", "--ignore-rules"]) assert.ok(A.codexArgs("/w", "/o", "default").includes(f), f)
  // ACP Bash allowlist comes from --tools itself
  assert.deepEqual(A.acpBash(["--allowedTools", "Read,Bash(git log:*)"]), [], "--allowedTools alone gives no shell")
  assert.deepEqual(A.acpBash(["--tools", "Read,Grep"]), [])
  assert.deepEqual(A.acpBash(["--tools", "Read,Bash", "--allowedTools", "Read,Bash(git log:*)"]), ["git log:*"])
  assert.deepEqual(A.acpBash(["--tools", "Read,Bash(ls:*)"]), ["ls:*"])
  assert.deepEqual(A.acpBash(["--tools", "Read,Bash", "--allowedTools", "Bash(ls:*)", "--disallowedTools", "Bash"]), [])
})

test("codex adapter: argv array, read-only sandbox, prompt on stdin, no Claude or other credentials in its env", async () => {
  const db = open(":memory:")
  const log = `${dir}/codex.json`
  const codex = bin("codex", `const fs = require("fs"); const a = process.argv.slice(2); let input = ""
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ a, input, env: Object.keys(process.env) }))
  if (process.env.FAKE_MODE === "fail") { process.stderr.write("codex: not logged in"); process.exit(2) }
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 10, output_tokens: 500 } }) + "\\n")
  fs.writeFileSync(a[a.indexOf("--output-last-message") + 1], "codex says hi\\n")
})`)
  const saved = { ...process.env }
  Object.assign(process.env, { FAKE_LOG: log, CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x", ANTHROPIC_API_KEY: "sk-ant-y", ANTHROPIC_BASE_URL: "http://z", GH_TOKEN: "ghp_z", OPENAI_API_KEY: "sk-o" })
  try {
    const cwd = mkdtempSync(`${dir}/wt-`)
    const a = A.codexAdapter({ ...byName("codex"), model: "gpt-5-codex", costPerMtok: { input: 2, output: 10 } }, codex)
    const r = await a.run(db, { project: "p", kind: "review", model: "opus", prompt: "review $(rm -rf ~) 'quoted'", cwd })
    assert.deepEqual(r, { ok: true, text: "codex says hi", reason: undefined })
    const got = JSON.parse(readFileSync(log, "utf8"))
    assert.deepEqual(got.a.slice(0, 3), ["exec", "--sandbox", "read-only"])
    assert.equal(got.a.at(-1), "-")
    assert.ok(got.a.includes("--model") && got.a.includes("gpt-5-codex"))
    assert.equal(got.input, "review $(rm -rf ~) 'quoted'", "prompt passed verbatim on stdin, never through a shell")
    for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "GH_TOKEN"]) assert.ok(!got.env.includes(k), k)
    assert.ok(got.env.includes("OPENAI_API_KEY"), "codex keeps its own key")
    const row = db.prepare("SELECT model, ok, input_tokens, output_tokens, cost_usd FROM runs").get() as object
    assert.deepEqual({ ...row }, { model: "codex:gpt-5-codex", ok: 1, input_tokens: 1000, output_tokens: 500, cost_usd: 0.007 })
    process.env.FAKE_MODE = "fail"
    const f = await a.run(db, { project: "p", kind: "review", model: "opus", prompt: "x", cwd })
    assert.equal(f.ok, false)
    assert.equal(f.reason, "codex: not signed in", "fixed reason code, never codex's raw output")
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
  }
})

test("permit: deny by default; reads inside cwd only and never secret files; execute through the guard + policy table", () => {
  const cwd = mkdtempSync(`${dir}/repo-`)
  mkdirSync(`${cwd}/src`); mkdirSync(`${cwd}/.git`)
  for (const f of ["src/a.ts", ".env.local", ".git/config", "..foo"]) writeFileSync(`${cwd}/${f}`, "x")
  const bash = L.roleArgs(["--allowedTools", "Read,Bash(ls:*),Bash(git:*)"]).bash
  const p = (tc: unknown) => A.permit(tc, { cwd, bash })
  assert.equal(p({ kind: "think" }), true)
  assert.equal(p({ kind: "read", locations: [{ path: `${cwd}/src/a.ts` }] }), true)
  assert.equal(p({ kind: "read", locations: [{ path: "..foo" }] }), true, "a file named ..foo is inside")
  assert.equal(p({ kind: "search", locations: [{ path: cwd }] }), false, "the root covers .env")
  assert.equal(p({ kind: "search", locations: [{ path: "src" }] }), false, "a directory")
  assert.equal(p({ kind: "read", locations: [{ path: ".git/config" }] }), false)
  assert.equal(p({ kind: "read", locations: [{ path: "src/missing.ts" }] }), false)
  assert.equal(p({ kind: "read", locations: [{ path: "src/a.ts" }, { path: "../other/x" }] }), false)
  assert.equal(p({ kind: "read", locations: [{ path: `${cwd}/.env.local` }] }), false)
  assert.equal(p({ kind: "read" }), false, "no locations = no")
  assert.equal(p({ kind: "execute", rawInput: { command: "ls src" } }), true)
  assert.equal(p({ kind: "execute", rawInput: { command: "cat /etc/passwd" } }), false, "not in the role's allowlist")
  assert.equal(p({ kind: "execute", rawInput: { command: "git push origin main" } }), false, "guard/policy deny")
  assert.equal(p({ kind: "edit", locations: [{ path: `${cwd}/src/a.ts` }] }), false)
  assert.equal(p({ kind: "fetch" }), false)
  assert.equal(p("nonsense"), false)
})

// A fake ACP agent: FAKE_MODE ok | unknown | hang. Logs the client's permission answers to FAKE_LOG.
const ACP = `const fs = require("fs"); const mode = process.env.FAKE_MODE; let buf = "", answers = {}
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n")
if (mode === "hang") { fs.writeFileSync(process.env.FAKE_LOG, String(process.pid)); setInterval(() => {}, 1000) }
if (mode === "early") { fs.writeFileSync(process.env.FAKE_LOG, String(process.pid)); send({ method: "session/update", params: { update: { sessionUpdate: "plan", entries: [] } } }); setInterval(() => {}, 1000) }
let promptId
process.stdin.setEncoding("utf8").on("data", (d) => {
  buf += d; let i
  while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); on(m) }
})
function on(m) {
  if (mode === "hang") return
  if (mode === "err") return send({ id: m.id, error: { code: -32000, message: "agent says sk-secret /Users/me/.env" } })
  if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } })
  if (m.method === "session/new") {
    // reply and an update in one write: the client must already know the session id
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { sessionId: "s1" } }) + "\\n" + JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "available_commands_update", availableCommands: [] } } }) + "\\n")
    if (mode === "unknown") { fs.writeFileSync(process.env.FAKE_LOG, String(process.pid)); send({ method: "weird/thing", params: {} }) }
    return
  }
  if (m.method === "session/prompt") {
    promptId = m.id
    if (mode === "big") { fs.writeFileSync(process.env.FAKE_LOG, String(process.pid)); for (let i = 0; i < 3; i++) send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x".repeat(400 * 1024) } } } }); return setInterval(() => {}, 1000) }
    if (mode === "noreject") { fs.writeFileSync(process.env.FAKE_LOG, String(process.pid)); send({ id: 100, method: "session/request_permission", params: { sessionId: "s1", options: [{ optionId: "y", name: "Allow", kind: "allow_always" }], toolCall: { kind: "edit" } } }); return setInterval(() => {}, 1000) }
    const opts = [{ optionId: "y", name: "Allow", kind: "allow_once" }, { optionId: "n", name: "Reject", kind: "reject_once" }]
    send({ id: 100, method: "session/request_permission", params: { sessionId: "s1", options: opts, toolCall: { toolCallId: "t1", kind: "execute", rawInput: { command: "rm -rf /" } } } })
    send({ id: 101, method: "session/request_permission", params: { sessionId: "s1", options: opts, toolCall: { toolCallId: "t2", kind: "read", locations: [{ path: process.cwd() + "/src/a.ts" }] } } })
    send({ id: 102, method: "fs/read_text_file", params: { sessionId: "s1", path: "/etc/passwd" } })
    return
  }
  if (m.id >= 100) {
    answers[m.id] = m.result ? m.result.outcome.optionId : m.error.code
    if (Object.keys(answers).length === 3) {
      fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify(answers))
      for (const t of ["hello ", "world"]) send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } } })
      send({ id: promptId, result: { stopReason: "end_turn", usage: { inputTokens: 7, outputTokens: 3 } } })
    }
  }
}`

test("ACP: a full turn; permissions answered by policy (deny by default); capabilities we did not offer are refused", async () => {
  const agent = bin("acp-agent", ACP)
  const cwd = mkdtempSync(`${dir}/acp-`)
  mkdirSync(`${cwd}/src`)
  writeFileSync(`${cwd}/src/a.ts`, "x")
  const log = `${dir}/acp-ok.json`
  const r = await A.acpRun(agent, [], { cwd, env: { ...process.env, FAKE_MODE: "ok", FAKE_LOG: log }, prompt: "hi", timeoutMs: 10_000, permit: (tc) => A.permit(tc, { cwd, bash: [] }) })
  assert.deepEqual(r, { ok: true, text: "hello world", usage: { input_tokens: 7, output_tokens: 3 } })
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), { 100: "n", 101: "y", 102: -32601 })
})

test("ACP: an unknown message ends the run and kills the agent; a silent agent is killed at the timeout", async () => {
  const agent = bin("acp-agent2", ACP)
  for (const [mode, ms, want] of [["unknown", 10_000, /^protocol: unknown notification$/], ["hang", 300, /ACP setup: initialize got no answer/], ["early", 10_000, /update before session\/new/],
    ["big", 10_000, /answer too large/], ["noreject", 10_000, /without a reject option/]] as const) {
    const log = `${dir}/acp-${mode}.pid`
    const r = await A.acpRun(agent, [], { cwd: dir, env: { ...process.env, FAKE_MODE: mode, FAKE_LOG: log }, prompt: "hi", timeoutMs: 10_000, requestMs: ms, permit: () => true })
    assert.equal(r.ok, false)
    assert.match(r.reason!, want)
    assert.ok(!r.timedOut, `${mode}: not a stall`)
    const pid = Number(readFileSync(log, "utf8"))
    for (let i = 0; i < 20 && alive(pid); i++) await L.sleep(50)
    assert.equal(alive(pid), false, `${mode}: agent killed`)
  }
})

test("ACP: run reasons are fixed codes, never the agent's own text", async () => {
  const agent = bin("acp-agent3", ACP)
  const r = await A.acpRun(agent, [], { cwd: dir, env: { ...process.env, FAKE_MODE: "err" }, prompt: "hi", timeoutMs: 10_000, permit: () => true })
  assert.deepEqual([r.ok, r.reason], [false, "acp: initialize failed"])
  const s = await A.acpRun(`${dir}/no-such-agent`, [], { cwd: dir, env: process.env, prompt: "hi", timeoutMs: 10_000, permit: () => true })
  assert.deepEqual([s.ok, s.reason], [false, "acp: spawn failed"])
})

test("pace per provider: two providers, each skipped at its own 24-hour dollar or run cap; older runs age out; claude-code never paced here", async () => {
  const { logRun } = await import("../src/db.ts")
  const db = open(":memory:")
  const roster = [
    { name: "codex", provider: "codex-cli", model: "gpt-5", tier: "top" },
    { name: "flash", provider: "gemini", model: "gemini-3-flash", tier: "cheap" },
    { name: "claude-code", provider: "claude-code", model: "sonnet", tier: "top" },
  ] as any
  const cfg = providersConfigSchema.parse({ providers: { "codex-cli": { limit: { dailyRuns: 2 } }, gemini: { limit: { dailyUsd: 1 } }, "claude-code": { limit: { dailyRuns: 1 } } } })
  assert.deepEqual(A.paced(db, cfg, roster), {})
  logRun(db, { project: "p", kind: "onboard", model: "codex:gpt-5", ok: true })
  logRun(db, { project: "p", kind: "dedupe", model: "provider:flash", ok: true, cost_usd: 0.6 })
  logRun(db, { project: "p", kind: "build", model: "sonnet", ok: true })
  assert.deepEqual(A.paced(db, cfg, roster), {}, "under both caps")
  logRun(db, { project: "p", kind: "onboard", model: "codex:gpt-5", ok: true })
  assert.deepEqual(A.paced(db, cfg, roster), { codex: { down: true } }, "codex at 2 runs; gemini still under $1")
  logRun(db, { project: "p", kind: "dedupe", model: "provider:flash", ok: true, cost_usd: 0.5 })
  assert.deepEqual(Object.keys(A.paced(db, cfg, roster)).sort(), ["codex", "flash"])
  assert.deepEqual(A.paced(db, cfg, roster, Date.now() + 25 * 3600_000), {}, "a day later the runs have aged out")
  // the router honours it: codex at its pace, so the onboard run goes on to claude
  const detected = async () => ({ harnesses: [{ id: "claude-code", path: "/c", loggedIn: true as const }, { id: "codex-cli", path: "/x", loggedIn: true as const }], apiKeys: [], local: [] })
  const rcfg = providersConfigSchema.parse({ enabled: true, providers: { "codex-cli": { limit: { dailyRuns: 1 } } }, roles: { onboarder: { primary: "codex", fallback: ["claude-code"] } } })
  const db2 = open(":memory:")
  const route = A.routed(async () => ({ ok: true, text: "native" }), { cfg: rcfg, detected, makers: { codex: (e) => ({ name: "codex", guarded: false, run: async () => (logRun(db2, { project: "p", kind: "onboard", model: `codex:${e.model}`, ok: true }), { ok: true, text: "codex" }) }) } })
  const o = { project: "p", kind: "onboard", model: "sonnet", prompt: "x", args: ["--allowedTools", "Read"] }
  assert.deepEqual([(await route(db2, o)).text, (await route(db2, o)).text], ["codex", "native"])
})

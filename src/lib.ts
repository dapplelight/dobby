// Shared pieces: shell, roles, projects (dobby.md), the usage budget, tickets, and one claude call that always logs itself.
import { paused } from "./pause.ts"
import { loginShell } from "./shell.ts"
import { spawn, spawnSync } from "node:child_process"
import { apiKey, callApi, useApi } from "./api.ts"
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { format } from "node:util"
import { logRun, type DB } from "./db.ts"
import { parseResult } from "./run.ts"
import type { Ctx } from "./policy.ts"
import { ticketGate, unsureOwner } from "./safety.ts"
import { clip, outbound, readSecrets, shortTitle } from "./telegram.ts"
import { builderEnv, INSTALL_DOMAINS, SAFE_GIT, sandboxMode, sandboxSettings, scratchDir, stepSettings, withGitConfig } from "./sandbox.ts"
import { withTelemetry } from "./telemetry.ts"
import { rules } from "./tools.ts"
import { config, draftDirs, zoned, zonedDay } from "./config.ts"
import { CEILING, contextTokens, lastAssistantText, repoSlug, runUsage, transcriptDir } from "./savings.ts"
export { repoSlug }

export const ROOT = new URL("..", import.meta.url).pathname
// Every git this process and its children start runs without hooks or fsmonitor (SAFE_GIT in sandbox.ts).
Object.assign(process.env, withGitConfig(process.env, SAFE_GIT))
// Rules for every agent (src/tools.ts, agent-rules/): core plus caveman, graph first, rtk, ponytail, jev when on and found. They go in as
// text, not via the caveman/ponytail plugins: their hooks write the owner's global mode flag and would flip their sessions.
export const home = (p: string) => p.replace(/^~/, homedir())
/**
 * Secret files no agent reads. Read rules are the ones Claude Code applies to Grep and Glob too ("Claude makes a best-effort
 * attempt to apply Read rules to all built-in tools that read files like Grep and Glob"; a Glob(path) rule is accepted but never
 * consulted: https://code.claude.com/docs/en/permissions). Bash reads of these paths are denied by bin/guard-hook.mjs.
 */
export const NO_SECRETS = ["Read(~/.config/**)", "Read(~/.ssh/**)", "Read(**/.env*)", "Read(**/secrets.env)"]

/**
 * The flags every `claude -p` gets on top of its role's: NO_SECRETS added to --disallowedTools (every role, security review
 * 20 Oct), and the role's Bash patterns for bin/guard-hook.mjs, which allows only those (DOBBY_BASH_ALLOW; none = no shell).
 */
export function roleArgs(args: string[]): { args: string[]; bash: string[] } {
  const out = args.slice()
  const d = out.indexOf("--disallowedTools")
  if (d >= 0) out[d + 1] = [...out[d + 1].split(",").filter(Boolean), ...NO_SECRETS.filter((x) => !out[d + 1].split(",").includes(x))].join(",")
  else out.push("--disallowedTools", NO_SECRETS.join(","))
  const a = out.indexOf("--allowedTools")
  const allowed = a >= 0 ? out[a + 1].split(",") : []
  const denied = out[out.indexOf("--disallowedTools") + 1].split(",")
  const bash = denied.includes("Bash") ? [] : allowed.flatMap((t) => (t === "Bash" ? ["*"] : t.match(/^Bash\((.+)\)$/)?.[1] ?? []))
  return { args: out, bash }
}
/** The time in India as a Date whose getUTC* fields read IST (schedules: Mon 06:30, daily 06:00, night 23-08). */
export const ist = zoned // the configured zone (config timezone, the machine's zone by default), named for the first owner's IST
export const istDay = (ms = Date.now()) => ist(ms).toISOString().slice(0, 10)

/** Run a shell command. Output keeps its last `keep` chars (logs); pass Infinity when the whole output matters (diffs). Blocks: tiny local calls only. */
export function sh(cmd: string, cwd: string, keep = 4000) {
  const r = spawnSync(...loginShell(cmd), { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).slice(-keep) }
}

// ---- non-blocking shell (audit #26: spawnSync froze every worker, the lock heartbeat and Discord timers) ------------------
/**
 * Default timeouts; override with DOBBY_TIMEOUT_<NAME>_MS in the environment or secrets.env. push = verify's limit (a repo's
 * pre-push hook may run its CI); do/doLong = a listener child (cheap verbs / landing, deploy, run); scan = review-scan.
 */
export const TIMEOUTS = { git: 2 * 60_000, push: 30 * 60_000, install: 30 * 60_000, verify: 30 * 60_000, deploy: 30 * 60_000, do: 20 * 60_000, do_long: 3 * 3600_000, scan: 90 * 60_000 }
export function timeoutMs(k: keyof typeof TIMEOUTS, env = process.env): number {
  const name = `DOBBY_TIMEOUT_${k.toUpperCase()}_MS`
  const v = Number(env[name] ?? readSecrets()[name])
  return v > 0 ? v : TIMEOUTS[k]
}
/** Owner commands that may land a PR (checks wait up to 40 min, rebase, install, verify) or deploy: the long child limit. */
const LONG_VERBS = /^(approve|decline|reviewaccept|reviewfix|scoutmerge|undo-scout|deploynow|send|run|company|buildidea)\b/i
export const doTimeoutMs = (command: string, env = process.env) => timeoutMs(LONG_VERBS.test(command.trim()) ? "do_long" : "do", env)
/** SIGTERM first, SIGKILL after this grace, so a child's own hook can stop its groups and clean up. */
export const KILL_GRACE_MS = 5_000
export type Out = { ok: boolean; out: string }
/** A runner that may be sync (test stubs, review.ts run) or async (runAsync): callers await it either way. */
export type ARun = (cmd: string, args: string[], cwd?: string) => Out | Promise<Out>
export type RunOpts = { cwd?: string; timeoutMs?: number; signal?: AbortSignal; keep?: number; all?: boolean; env?: NodeJS.ProcessEnv; graceMs?: number; input?: string }
const OUT_CAP = 64 * 1024 * 1024 // like spawnSync's maxBuffer, but the tail is kept instead of failing
const groups = new Set<number>() // process groups still running: stopped when this process exits or is signalled
const signalGroup = (pid: number, sig: NodeJS.Signals) => { try { process.kill(-pid, sig) } catch {} }
/** SIGTERM the group, SIGKILL whatever is left after `grace`. */
function stopGroup(pid: number, grace = KILL_GRACE_MS) {
  signalGroup(pid, "SIGTERM")
  setTimeout(() => signalGroup(pid, "SIGKILL"), grace).unref()
}
/** Register / forget a detached child's process group so this process stops it on exit or signal (ACP agents in agents.ts). */
export const trackGroup = (pid: number) => { stopGroupsOnExit(); groups.add(pid) }
export const untrackGroup = (pid: number) => { groups.delete(pid) }
let hooked = false
function stopGroupsOnExit() {
  if (hooked) return
  hooked = true
  process.on("exit", () => { for (const g of groups) signalGroup(g, "SIGKILL") }) // last resort: no time left to wait
  // Children run in their own process group (so a timeout can stop the whole tree); before, `kill -<tick pgid>` (pause all)
  // reached them too. Keep that: on a signal SIGTERM them, give them the grace to clean up, SIGKILL the rest, then die of the same signal.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(sig, () => {
    for (const g of groups) signalGroup(g, "SIGTERM")
    const end = () => { for (const g of groups) signalGroup(g, "SIGKILL"); process.kill(process.pid, sig) }
    if (!groups.size) return end()
    const t = setInterval(() => { if (!groups.size) clearInterval(t), end() }, 100)
    setTimeout(() => { clearInterval(t); end() }, KILL_GRACE_MS)
  })
}
/**
 * Run `cmd args` without blocking the event loop. Its own process group: on timeout or abort the group gets SIGTERM, then
 * SIGKILL after the grace; leftovers (a `vite preview` still holding a port) get the same once the command itself exits.
 * out = stdout on success, else stdout + stderr + why (like review.ts run); `all` = always stdout + stderr (like sh).
 */
export function runAsync(cmd: string, args: string[], o: RunOpts = {}): Promise<Out & { timedOut?: boolean }> {
  return new Promise((resolve) => {
    let p: ReturnType<typeof spawn>
    try { p = spawn(cmd, outbound(cmd, args), { cwd: o.cwd, env: o.env, detached: true, stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }) } catch (e) { return resolve({ ok: false, out: (e as Error).message }) }
    if (o.input !== undefined) p.stdin!.on("error", () => {}).end(o.input) // input = stdin (a prompt); a child that exits early is not an error here
    stopGroupsOnExit()
    const pid = p.pid
    if (pid) groups.add(pid)
    let so = "", se = "", timedOut = false, aborted = false, done = false, grace: ReturnType<typeof setTimeout> | undefined
    const cap = (s: string) => (s.length > OUT_CAP ? s.slice(-OUT_CAP) : s)
    p.stdout!.setEncoding("utf8").on("data", (d: string) => (so = cap(so + d)))
    p.stderr!.setEncoding("utf8").on("data", (d: string) => (se = cap(se + d)))
    const stop = () => { if (pid) stopGroup(pid, o.graceMs) }
    const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; stop() }, o.timeoutMs) : undefined
    const onAbort = () => { aborted = true; stop() }
    o.signal?.addEventListener("abort", onAbort, { once: true })
    if (o.signal?.aborted) onAbort()
    const finish = (code: number | null, err = "") => {
      if (done) return
      done = true
      clearTimeout(timer), clearTimeout(grace)
      o.signal?.removeEventListener("abort", onAbort)
      if (pid) groups.delete(pid)
      const ok = code === 0 && !timedOut && !aborted && !err
      const why = timedOut ? `\n(timed out after ${Math.round(o.timeoutMs! / 1000)} s: stopped)` : aborted ? "\n(aborted: stopped)" : err
      const out = (ok && !o.all ? so : so + se) + why
      resolve({ ok, out: o.keep === undefined ? out : out.slice(-o.keep), ...(timedOut ? { timedOut } : {}) })
    }
    p.on("error", (e) => finish(null, e.message))
    p.on("close", (code) => finish(code))
    p.on("exit", (code) => {
      if (pid) stopGroup(pid, o.graceMs) // leftovers in the group (background servers) stop with the command
      grace = setTimeout(() => { p.stdout?.destroy(); p.stderr?.destroy(); finish(code) }, (o.graceMs ?? KILL_GRACE_MS) + 2000) // a pipe held open outside the group
    })
  })
}
/** sh() without blocking: a project's own command line (install, verify, deploy from dobby.md) under a login shell (zsh, else bash, else sh). */
export const shAsync = (cmd: string, cwd: string, keep = 4000, o: Omit<RunOpts, "cwd" | "keep" | "all"> = {}) => runAsync(...loginShell(cmd), { ...o, cwd, keep, all: true })
/**
 * A project's install or verify line on code an agent or a PR wrote, with the builder's protections (audit 24 Oct H1): the
 * credential-scrubbed env and, where the OS sandbox is available, srt with the builder's read rules. `net` = install: package
 * registries only; verify: no network. DOBBY_BUILDER_SANDBOX=off runs it as before.
 */
export function stepSh(cmd: string, cwd: string, net: "install" | "verify", keep = 4000, o: Omit<RunOpts, "cwd" | "keep" | "all" | "env"> = {}) {
  const box = isolation("build", cwd)
  if (box.mode === "off") return shAsync(cmd, cwd, keep, o)
  if (box.mode === "env-only") return runAsync(...loginShell(cmd), { ...o, cwd, keep, all: true, env: box.env })
  const file = `${scratchDir(cwd)}/srt-${net}.json`
  writeFileSync(file, JSON.stringify(stepSettings(cwd, net === "install" ? [...INSTALL_DOMAINS, ...(config().installDomains ?? [])] : [])))
  return runAsync(`${ROOT}node_modules/.bin/srt`, ["-s", file, ...loginShell(cmd).flat()], { ...o, cwd, keep, all: true, env: box.env })
}
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** At most `n` at once; the rest wait in order. `run(label, job)` logs a wait (so a slow verify queue shows in tick.log). */
export function semaphore(n: number, log = (m: string) => console.log(m)) {
  let busy = 0
  const waiting: (() => void)[] = []
  return async <T>(label: string, job: () => Promise<T>): Promise<T> => {
    if (busy >= n) {
      const t0 = Date.now()
      await new Promise<void>((r) => waiting.push(r))
      log(`${label}: waited ${Math.round((Date.now() - t0) / 1000)} s for a free slot (${n} at once)`)
    } else busy++
    try { return await job() } finally { const next = waiting.shift(); if (next) next(); else busy-- }
  }
}
/** Installs and verifies at once in this process (DOBBY_VERIFY_CONCURRENCY, default 2): 4-6 workers testing together starved the Mac. */
export const heavy = semaphore(Number(process.env.DOBBY_VERIFY_CONCURRENCY) > 0 ? Number(process.env.DOBBY_VERIFY_CONCURRENCY) : 2)

/** One queue per key: `withKey(key, job)` runs after earlier jobs on that key finish. */
export function keyedMutex() {
  const tails = new Map<string, Promise<unknown>>()
  return <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const run = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(job)
    const tail = run.catch(() => {})
    tails.set(key, tail)
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key) })
    return run
  }
}
const repoLock = keyedMutex()
const commonDirs = new Map<string, string>()
/** The main .git a working dir belongs to (worktrees share it), cached. */
function gitCommonDir(cwd = process.cwd()) {
  let d = commonDirs.get(cwd)
  if (!d) {
    const r = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" })
    d = r.status === 0 ? r.stdout.trim() : cwd
    commonDirs.set(cwd, d)
  }
  return d
}
const LOCKED_GIT = new Set(["fetch", "push", "worktree", "config"])
const LOCK_ERROR = /\.lock'?:? File exists|Unable to create '.*\.lock'|cannot lock ref|could not lock config file/i
/**
 * gh and git over the network: argument arrays, 2-minute timeout (DOBBY_TIMEOUT_GIT_MS; pushes DOBBY_TIMEOUT_PUSH_MS). git
 * fetch/push/worktree/config in one repo queue behind each other (they share its .git) and a lock error is retried once after 2 s.
 * Same output as review.ts run.
 */
export const netRun: ARun = (cmd, args, cwd) => {
  const go = () => runAsync(cmd, args, { cwd, timeoutMs: timeoutMs(cmd === "git" && args[0] === "push" ? "push" : "git") })
  if (cmd !== "git" || !LOCKED_GIT.has(args[0])) return go()
  return repoLock(gitCommonDir(cwd), async () => {
    const r = await go()
    if (r.ok || !LOCK_ERROR.test(r.out)) return r
    await sleep(2000)
    return go()
  })
}

/** Set-if-absent claim in kv (`<pid>:<ms>`): true for the one caller that gets it. A dead holder's claim is taken over (compare-and-swap). */
export function claimKey(db: DB, key: string, now = Date.now()): boolean {
  const mine = `${process.pid}:${now}`
  if (db.prepare("INSERT OR IGNORE INTO kv VALUES (?, ?)").run(key, mine).changes) return true
  const v = (db.prepare("SELECT v FROM kv WHERE k=?").get(key) as { v: string } | undefined)?.v ?? ""
  const pid = Number(v.split(":")[0])
  let alive = true
  try { if (pid) process.kill(pid, 0); else alive = false } catch { alive = false }
  return !alive && db.prepare("UPDATE kv SET v=? WHERE k=? AND v=?").run(mine, key, v).changes === 1
}

/** Throwaway `-rebase` worktrees (rebaseAndPush) left by a killed process, over an hour old: removed and unregistered at startup. */
export function sweepRebaseWorktrees(wt: string, now = Date.now(), maxAgeMs = 3600_000): string[] {
  const gone: string[] = []
  let names: string[] = []
  try { names = readdirSync(wt).filter((n) => n.endsWith("-rebase")) } catch { return gone }
  for (const n of names) {
    const d = `${wt}/${n}`
    try {
      if (now - statSync(d).mtimeMs < maxAgeMs) continue
      const gitdir = readFileSync(`${d}/.git`, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
      rmSync(d, { recursive: true, force: true })
      const common = gitdir?.replace(/\/worktrees\/[^/]+\/?$/, "")
      if (common) spawnSync("git", ["--git-dir", common, "worktree", "prune"], { encoding: "utf8" })
      gone.push(n)
    } catch {}
  }
  return gone
}

/**
 * Processes still running from a worktree that no longer exists (a builder's `wrangler dev` outlives its session:
 * 24 Oct, 683 workerd from 18 deleted worktrees held 4.8 GB). `ps` = `ps -axo pid=,command=` output.
 */
export function orphanPids(ps: string, wt: string, exists: (d: string) => boolean = existsSync, self = process.pid): number[] {
  const pids: number[] = []
  const prefix = `${wt}/`
  for (const line of ps.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/)
    if (!m || Number(m[1]) === self) continue
    const at = m[2].indexOf(prefix)
    if (at < 0) continue
    const name = m[2].slice(at + prefix.length).split(/[/\s]/)[0]
    if (name && !exists(`${wt}/${name}`)) pids.push(Number(m[1]))
  }
  return pids
}

/** orphanPids, stopped (SIGTERM). Returns the pids it signalled. */
export function sweepOrphanProcesses(wt: string): number[] {
  const pids = orphanPids(spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).stdout ?? "", wt)
  for (const p of pids) { try { process.kill(p, "SIGTERM") } catch {} }
  return pids
}

/** ISO time in front of every console line (tick.log, telegram.log). Only the tick and listen entry points call it. */
export function stampLogs(c: Pick<Console, "log" | "error"> = console, now = () => new Date().toISOString()) {
  for (const k of ["log", "error"] as const) {
    const orig = c[k].bind(c)
    c[k] = (...a: unknown[]) => orig(format(...a).replace(/^/gm, `${now()} `))
  }
}

// ---- markdown with frontmatter (roles and dobby.md) ---------------------------
export type Doc = { meta: Record<string, string>; body: string }
/** `---` frontmatter of `key: value` lines (a trailing `# comment` is dropped), then the body. */
export function parseDoc(src: string): Doc {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: src.trim() }
  const meta: Record<string, string> = {}
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":")
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).replace(/\s+#.*$/, "").trim()
  }
  return { meta, body: m[2].trim() }
}
const RENAMED: Record<string, string> = { "front-desk": "telegram" } // old file names still load
export const loadRole = (name: string) => {
  const f = `${ROOT}roles/${name}.md`
  const doc = parseDoc(readFileSync(existsSync(f) || !RENAMED[name] ? f : `${ROOT}roles/${RENAMED[name]}.md`, "utf8"))
  // Skills the owner approved for this role (Scout card 👍): appended to its instructions, frontmatter stripped.
  const skills = (doc.meta.skills ?? "").split(",").map((s) => s.trim()).filter((s) => s && existsSync(`${ROOT}skills/${s}/SKILL.md`))
  if (skills.length) doc.body += `\n\nSKILLS YOU HAVE (use them when they fit; your role's rules above win if they conflict):\n${skills.map((s) => `\n### ${s}\n${parseDoc(readFileSync(`${ROOT}skills/${s}/SKILL.md`, "utf8").replace(/^<!--.*-->\n/, "")).body}`).join("\n")}`
  return doc
}

// ---- projects ------------------------------------------------------------------
/** Tell the owner (#system-status) that Dobby found a problem and fixed it. Plain words, names not numbers. `key` throttles repeats to one per 6 hours. */
export function fixed(db: DB, text: string, key?: string) {
  if (process.env.NODE_TEST_CONTEXT) return // `node --test` child: fixtures like "Invite link API" must not post to the real #system-status
  if (key) {
    const last = Number((db.prepare("SELECT v FROM kv WHERE k=?").get(`fixed:${key}`) as { v: string } | undefined)?.v ?? 0)
    if (Date.now() - last < 6 * 3600_000) return
    db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`fixed:${key}`, String(Date.now()))
  }
  void import("./discord.ts").then((d) => d.team({ kind: "health" }, `🔧 ${text}`)).catch(() => {})
}

/**
 * Read-only roles (Lead, PM) run `claude` here, not in the repo: a `node_modules` at the repo top level makes claude hang at
 * startup (18 Oct: 8 s without it, never with it). Tracked files only, refreshed from the repo's origin/<base>.
 */
/**
 * A worktree or clone made from origin has no graph (graphify-out is not committed), so an agent's first `graphify query` failed with
 * "graph file not found" (audit 24 Oct: 22% of graph calls). Copy the main checkout's graph in. A copy, not a link: `graphify update .`
 * in a worktree must not rewrite the main graph with a branch's code. Re-copied when the main graph is newer (the 05:30 refresh), so
 * long-lived read-only clones stay current. Kept out of commits through the repo's info/exclude.
 */
export function seedGraph(repo: string, dir: string) {
  const from = `${repo}/graphify-out`, to = `${dir}/graphify-out`
  if (!existsSync(`${from}/graph.json`)) return
  if (existsSync(`${to}/graph.json`) && statSync(`${to}/graph.json`).mtimeMs >= statSync(`${from}/graph.json`).mtimeMs) return // as new (or updated in place by the agent)
  try {
    mkdirSync(to, { recursive: true })
    for (const f of ["graph.json", "GRAPH_REPORT.md", "manifest.json"]) if (existsSync(`${from}/${f}`)) copyFileSync(`${from}/${f}`, `${to}/${f}`)
    const common = spawnSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).stdout?.trim()
    const exclude = common && `${common.startsWith("/") ? common : `${dir}/${common}`}/info/exclude`
    if (exclude && !(existsSync(exclude) && readFileSync(exclude, "utf8").split("\n").includes("graphify-out/"))) mkdirSync(exclude.replace(/\/exclude$/, ""), { recursive: true }), appendFileSync(exclude, "\ngraphify-out/\n")
  } catch {} // no graph is the old behaviour, never a failed ticket
}

export function readOnlyDir(db: DB, p: { name: string; repo: string; base: string }): string {
  const dir = `${home(config().paths.data)}/ro/${p.name}`
  const git = (...a: string[]) => spawnSync("git", a, { encoding: "utf8" }).status === 0
  if (!existsSync(`${dir}/.git`) && !git("clone", "-q", "--local", "--no-checkout", p.repo, dir)) return p.repo
  const ok = git("-C", dir, "fetch", "-q", "origin", `+refs/remotes/origin/${p.base}:refs/src/base`) && git("-C", dir, "checkout", "-q", "-f", "--detach", "refs/src/base")
  if (ok) seedGraph(p.repo, dir)
  if (!ok) fixed(db, `The clean read-only copy of ${p.name} could not be refreshed, so planning for ${p.name} is using the full project folder (it can freeze). I'll keep trying.`, `ro:${p.name}`)
  return ok ? dir : p.repo
}

export type Project = { name: string; repo: string; base: string; install: string; verify: string; priority: number; jev: boolean; paused: boolean; rules: string; deploy?: string; deploy_dir?: string; deploy_copy?: string[]; migrations?: string; areas?: string[]; ownerWords?: boolean; scoutMerge?: "auto" | "ask"; autoPromote?: boolean }
/** The project file in a repo root: dobby.md, or foreman.md from before the rename. */
const repoDoc = (dir: string) => [`${dir}/dobby.md`, `${dir}/foreman.md`].map(home).find((p) => existsSync(p))
/** A project joins the company by having a dobby.md: in its repo root, or a draft <name>.md in ~/.config/dobby/projects (or this repo's projects/). `paused: true` = no Lead runs. */
export function loadProjects(): Record<string, Project> {
  const out: Record<string, Project> = {}
  const root = config().paths.projects
  const draft = (name: string) => draftDirs().map((d) => `${d}/${name}.md`).find((p) => existsSync(p))
  const names = new Set([...(existsSync(home(root)) ? readdirSync(home(root)) : []).filter((n) => repoDoc(`${root}/${n}`)), ...draftDirs().flatMap((d) => readdirSync(d).filter((f) => /^[^.]+\.md$/.test(f)).map((f) => f.slice(0, -3)))])
  for (const name of names) {
    const d = parseDoc(readFileSync(repoDoc(`${root}/${name}`) ?? draft(name)!, "utf8"))
    out[name] = { name, repo: home(d.meta.repo ?? `${root}/${name}`), base: d.meta.base ?? "main", install: d.meta.install ?? "true", verify: d.meta.verify ?? "true", priority: Number(d.meta.priority ?? 5), jev: d.meta.jev !== "off", paused: d.meta.paused === "true", rules: d.body, deploy: d.meta.deploy, deploy_dir: d.meta.deploy_dir, deploy_copy: (d.meta.deploy_copy ?? "").split(",").map((x) => x.trim()).filter(Boolean), migrations: d.meta.migrations, areas: (d.meta.areas ?? "").split(",").map((x) => x.trim()).filter(Boolean), ownerWords: d.meta.owner_words !== "off", scoutMerge: d.meta.scout_merge === "auto" ? "auto" : "ask", autoPromote: d.meta.auto_promote !== "off" }
  }
  return out
}

/** Policy context for a project's tickets: `owner_words: off` in projects/<p>.md (ownerWords false) turns the soft ticket-text words off. Add `title` per ticket. */
export const policyCtx = (project?: string): Ctx => ({ project, ownerWords: project ? loadProjects()[project]?.ownerWords : undefined })
/** Scout PRs: `scout_merge: auto` in projects/foreman.md = strict review + injection check merge them without a tap (default ask). */
export const scoutMerge = () => loadProjects().dobby?.scoutMerge ?? "ask"

// ---- budget ------------------------------------------------------------------
export type Usage = { fiveUsed: number; weekUsed: number; weekMsToReset: number; fiveMsToReset?: number; ageMs?: number }
const FIVE_H = 5 * 3600_000
/**
 * Pacing (owner, 17 Oct): spend the weekly remainder evenly over the 5-hour windows left, heavier at night (23-08, Dobby
 * alone: x1.6) and lighter by day (the owner's own sessions share the window: x0.64; 9 of 24 hours are night, so they
 * average out to 1). Returns the 5-hour % cap for now: day 20-60%, night 30-90%.
 * weekPerFive = weekly % per 1% of a 5-hour window (measured from usage ticks; ~0.1: a full window is ~10% of the week).
 * Behind weekly pace (less used than the share of the week gone, owner 17 Oct): no day cut, and the gap is caught up within a day.
 */
export function paceCap(u: Usage, night: boolean, weekPerFive = 0.1) {
  const windowsLeft = Math.max(1, u.weekMsToReset / FIVE_H)
  const perWindow = Math.max(0, 100 - u.weekUsed) / windowsLeft / weekPerFive // this window's share, in 5-hour %
  // Unused room (owner, 17 Oct): the gap behind weekly pace is spent over the next 5 windows (~1 day), not the whole week.
  const behindBy = Math.max(0, 100 * (1 - u.weekMsToReset / (7 * 24 * 3600_000)) - u.weekUsed)
  const want = perWindow + behindBy / Math.min(windowsLeft, 5) / weekPerFive
  // Use it or lose it (owner, 17 Oct: "let it decide on its own", no fixed hour or %): this window's unused room vanishes at
  // reset, so it is fair game when spending it still leaves the week at or behind pace at that reset. The owner keeps a
  // reserve for urgent work ("we would need some tokens left"): the day/night ceiling's share, shrinking to 0 as reset nears.
  const left = (u.fiveMsToReset ?? FIVE_H) / FIVE_H
  const paceAtReset = 100 * (1 - (u.weekMsToReset - left * FIVE_H) / (7 * 24 * 3600_000))
  if (u.weekUsed + (100 - u.fiveUsed) * weekPerFive <= paceAtReset) return Math.round(100 - (100 - (night ? 90 : 60)) * left)
  return Math.round(night ? Math.min(90, Math.max(30, want * 1.6)) : Math.min(60, Math.max(20, want * (behindBy > 0 ? 1 : 0.64))))
}

/** Idle 5-hour window (owner, 19 Oct): at or past its midpoint and still under 30% used, so there is room the queue is not filling. */
export const windowIdle = (u: Usage) => u.fiveMsToReset !== undefined && u.fiveMsToReset <= FIVE_H / 2 && u.fiveUsed < 30

/** May an unattended run start now? The 5-hour window stays under the pace cap (or the owner's one-window override); the last 5% of the week stays the owner's. */
export function budgetAllows(u: Usage, hour: number, capOverride?: number, weekPerFive?: number): { ok: boolean; why: string; cap: number } {
  const night = hour >= 23 || hour < 8
  const cap = capOverride ?? paceCap(u, night, weekPerFive) // the owner can raise it for one window from the pause ping
  if (u.fiveUsed >= cap) return { ok: false, why: `5-hour window at ${u.fiveUsed}% (pace cap ${cap}%)`, cap }
  if (u.weekUsed >= 95) return { ok: false, why: `weekly at ${u.weekUsed}% (the last 5% stays yours)`, cap }
  return { ok: true, why: `5-hour ${u.fiveUsed}%/${cap}, weekly ${u.weekUsed}%`, cap }
}

/** API-key mode (config billing.mode): runs pay by the token, so there are no plan windows to pace. */
export const apiKeyMode = () => config().billing?.mode === "apiKey"
/** May a run start in API-key mode? Dollars spent (runs.cost_usd) stay under dailyUsd for the last 24 hours and weeklyUsd for the last 7 days. */
export function spendAllows(db: DB, b = config().billing ?? { mode: "apiKey" as const, dailyUsd: 20 }, now = Date.now()): { ok: boolean; why: string; cap: number } {
  const spent = (ms: number) => (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM runs WHERE at >= ?").get(new Date(now - ms).toISOString()) as { s: number }).s
  const day = spent(24 * 3600_000), week = b.weeklyUsd ? spent(7 * 24 * 3600_000) : 0
  if (day >= b.dailyUsd) return { ok: false, why: `API key: $${day.toFixed(2)} in 24 hours (cap $${b.dailyUsd})`, cap: 0 }
  if (b.weeklyUsd && week >= b.weeklyUsd) return { ok: false, why: `API key: $${week.toFixed(2)} in 7 days (cap $${b.weeklyUsd})`, cap: 0 }
  return { ok: true, why: `API key: $${day.toFixed(2)} of $${b.dailyUsd} in 24 hours${b.weeklyUsd ? `, $${week.toFixed(2)} of $${b.weeklyUsd} in 7 days` : ""}`, cap: 100 }
}

/** review-scan's budget: the builders' answer, or the looser reviewCap when that still has room (never the owner's last 5% of the week). */
export function reviewBudget(g: { ok: boolean; why: string; cap: number }, u: Usage | null, reviewCap?: number) {
  if (g.ok || !u || !reviewCap || reviewCap <= g.cap || u.weekUsed >= 95 || u.fiveUsed >= reviewCap) return g
  return { ok: true, why: `5-hour ${u.fiveUsed}%/${reviewCap} (review cap; builders stop at ${g.cap}%)`, cap: reviewCap }
}

/** The usage reader: the owner's explicit paths.usageCli wins, else the claude-usage-limits package bundled in node_modules. */
export function resolveUsageCli(explicit = config().paths.usageCli, bundled = bundledUsageCli) {
  return explicit ? home(explicit) : bundled()
}
function bundledUsageCli() {
  try { return join(dirname(createRequire(import.meta.url).resolve("claude-usage-limits/package.json")), "bin/cli.js") } catch { return "" }
}
const USAGE_CLI = resolveUsageCli()
const USAGE_TIMEOUT_MS = 30_000 // audit #14: no timeout meant a hung CLI hung the tick while health said "running"
const USAGE_STALE_MS = 30 * 60_000
const usageCli = () => spawnSync("node", [USAGE_CLI, "--json", "--host", "claude"], { cwd: homedir(), encoding: "utf8", timeout: USAGE_TIMEOUT_MS }).stdout ?? ""
// The snapshot only moves when Claude Code calls the API, so with no session open it goes stale and builds stop: nothing then
// refreshes it (a deadlock until the owner opens Claude). The plugin's own live reader takes a fresh one (the /usage endpoint).
const USAGE_LIVE = USAGE_CLI.replace(/bin\/cli\.js$/, "skills/usage-limits/scripts/live.js")
const USAGE_REFRESH_EVERY_MS = 10 * 60_000
const liveRefresh = () => spawnSync("node", ["-e", "require(process.argv[1]).refresh().then((r) => process.exit(r.outcome.ok ? 0 : 1), () => process.exit(1))", USAGE_LIVE], { cwd: homedir(), timeout: USAGE_TIMEOUT_MS }).status === 0

/** The CLI's JSON to Usage. null when unreadable. ageMs = snapshotAgeMs when the CLI says how old its snapshot is. */
export function parseUsage(stdout: string): Usage | null {
  try {
    const j = JSON.parse(stdout)
    const w = j.windows as { key: string; percentUsed: number; msToReset: number }[]
    const five = w.find((x) => x.key === "five_hour"), week = w.find((x) => x.key === "seven_day")
    return five && week ? { fiveUsed: five.percentUsed, weekUsed: week.percentUsed, weekMsToReset: week.msToReset, fiveMsToReset: five.msToReset, ...(typeof j.snapshotAgeMs === "number" ? { ageMs: j.snapshotAgeMs } : {}) } : null
  } catch {
    return null
  }
}

/**
 * Live numbers from the usage-limits plugin. null when unreadable: then nothing runs. With a db, an outage (unreadable, or a snapshot
 * older than 30 minutes) is tracked: after 30 minutes the owner hears about it once (audit #14: builds stopped silently).
 */
/**
 * Usage unreadable (no reader, or it errors): builders do not run unpaced; at most pacing.fallbackBuildsPerDay start per day in the
 * configured timezone. One plain warning per day. `fallbackStarted` counts a started build.
 */
export const fallbackLimit = () => config().pacing?.fallbackBuildsPerDay ?? 3
export function fallbackAllows(db: DB, tell: typeof fixed = fixed, now = Date.now()): { ok: boolean; why: string; cap: number } {
  const day = zonedDay(now), n = fallbackLimit(), used = fallbackUsed(db, now)
  if (kv(db, "usage:fallback-told") !== day) {
    db.prepare("INSERT OR REPLACE INTO kv VALUES ('usage:fallback-told', ?)").run(day)
    tell(db, `I cannot read your Claude usage, so I cannot pace builders. Until I can, at most ${n} builds start per day.`, "usage-fallback")
  }
  return used < n ? { ok: true, why: `usage unreadable: ${used}/${n} builds today`, cap: 100 } : { ok: false, why: `usage unreadable: ${n} builds today already`, cap: 0 }
}
const kv = (db: DB, k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
const fallbackUsed = (db: DB, now: number) => { const [d, n] = (kv(db, "usage:fallback") ?? "").split(":"); return d === zonedDay(now) ? Number(n) : 0 }
export const fallbackStarted = (db: DB, now = Date.now()) => void db.prepare("INSERT OR REPLACE INTO kv VALUES ('usage:fallback', ?)").run(`${zonedDay(now)}:${fallbackUsed(db, now) + 1}`)

/** No usage reader installed (#194): builders run with no pacing instead of never starting. A reader that is there but fails still stops them. */
export const noUsageReader = (path = USAGE_CLI) => !path || !existsSync(path)

export function readUsage(db?: DB, read: () => string = usageCli, now = Date.now(), tell: typeof fixed = fixed, refresh: () => boolean = liveRefresh, missing = () => read === usageCli && noUsageReader()): Usage | null {
  if (missing()) {
    if (db && !db.prepare("SELECT 1 FROM kv WHERE k='usage:missing-told'").get()) {
      db.prepare("INSERT OR REPLACE INTO kv VALUES ('usage:missing-told', '1')").run()
      tell(db, `No usage reader (${USAGE_CLI || "claude-usage-limits is not installed"}), so I cannot pace builders against your Claude limits. Until it works they run at most ${fallbackLimit()} a day. Reinstall Dobby's dependencies, or set paths.usageCli in the config.`, "usage-missing")
    }
    return null
  }
  db?.prepare("DELETE FROM kv WHERE k='usage:missing-told'").run()
  let u = parseUsage(read())
  if (db) {
    const kv = (k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
    // stale or unreadable: ask for a live reading (at most every 10 minutes) and read again before counting an outage
    if ((!u || (u.ageMs ?? 0) > USAGE_STALE_MS) && now - Number(kv("usage:refresh-at") ?? 0) >= USAGE_REFRESH_EVERY_MS) {
      db.prepare("INSERT OR REPLACE INTO kv VALUES ('usage:refresh-at', ?)").run(String(now))
      if (refresh()) u = parseUsage(read())
    }
    const bad = !u || (u.ageMs ?? 0) > USAGE_STALE_MS
    if (!bad) db.prepare("DELETE FROM kv WHERE k IN ('usage:bad-since','usage:bad-told')").run()
    else {
      const since = Number(kv("usage:bad-since") ?? (u?.ageMs ? now - u.ageMs : now)) // a stale snapshot has been bad for as long as it is old
      if (kv("usage:bad-since") === undefined) db.prepare("INSERT OR REPLACE INTO kv VALUES ('usage:bad-since', ?)").run(String(since))
      if (now - since > USAGE_STALE_MS && kv("usage:bad-told") === undefined) {
        db.prepare("INSERT OR REPLACE INTO kv VALUES ('usage:bad-told', '1')").run()
        tell(db, `I cannot read your Claude usage numbers (${u ? "the reading is stale" : "the usage tool gave no answer"} for ${Math.round((now - since) / 60_000)} minutes), so no builds are starting. Check that the Mac is signed in to Claude.`, "usage-unreadable")
      }
    }
  }
  return u
}

// ---- goals ---------------------------------------------------------------------
// The owner sets them as GitHub milestones in the app's repo (owner, 24 Oct: a stable id, a due date and a progress bar),
// or, with no milestones there, in projects/<app>.md under "## Goals", most important first. The table mirrors either.
export type Goal = { id: number; project: string; title: string; rank: number; status: string; milestone: number | null }
export type Milestone = { number: number; title: string; description?: string | null; due_on?: string | null }
/** The repo's open milestones as the board sync last saw them (kv gh:ms:<app>, every 10 min), soonest due first, undated last. */
export function milestonesOf(db: DB, project: string): Milestone[] {
  const v = (db.prepare("SELECT v FROM kv WHERE k=?").get(`gh:ms:${project}`) as { v: string } | undefined)?.v
  const ms = (v ? JSON.parse(v) : []) as Milestone[]
  return ms.sort((a, b) => (a.due_on ?? "9999").localeCompare(b.due_on ?? "9999") || a.number - b.number)
}
/** The "- " or "1. " lines under a "## Goals" heading, in order, up to the next "## " heading. */
export function parseGoals(rules: string): string[] {
  const lines = rules.split("\n")
  const at = lines.findIndex((l) => /^##\s+Goals\b/i.test(l))
  if (at < 0) return []
  const out: string[] = []
  for (const l of lines.slice(at + 1)) {
    if (/^##\s/.test(l)) break
    const g = l.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)/)?.[1]?.trim()
    if (g) out.push(g)
  }
  return out
}
/**
 * Mirror the file into the table: same title = same goal (keeps its id and tickets), gone from the file = dropped.
 * Tickets and ideas with no goal join the top goal, so every ticket links to one. Returns the active goals, rank order.
 * In the file, a goal reworded on its own line keeps its id; reworded and moved, it becomes a new one (milestones avoid that).
 */
const same = (a: string, b: string) => titleKey(a.replace(/^draft:\s*/i, "")) === titleKey(b.replace(/^draft:\s*/i, "")) // "DRAFT: x" -> "x" is the same goal
export function syncGoals(db: DB, project: string, rules: string): Goal[] {
  const ms = milestonesOf(db, project)
  const titles = ms.length ? ms.map((m) => m.description?.trim() || m.title) : parseGoals(rules)
  const have = db.prepare("SELECT * FROM goals WHERE project=?").all(project) as Goal[]
  db.transaction(() => {
    const keep = new Set<number>()
    if (ms.length) ms.forEach((m, i) => { // milestones: matched by number, so any rewording keeps the goal
      const g = have.find((h) => h.milestone === m.number)
      if (g) db.prepare("UPDATE goals SET title=?, rank=?, status='active', updated_at=? WHERE id=?").run(titles[i], i + 1, now(), g.id), keep.add(g.id)
      else db.prepare("INSERT INTO goals (project,title,rank,milestone,updated_at) VALUES (?,?,?,?,?)").run(project, titles[i], i + 1, m.number, now())
    })
    else titles.forEach((title, i) => {
      // reworded in place (same line, new words): the same goal, so its tickets and ideas stay linked
      const g = have.find((h) => same(h.title, title)) ?? have.find((h) => h.status === "active" && h.rank === i + 1 && !keep.has(h.id) && !titles.some((t) => same(h.title, t)))
      if (g) db.prepare("UPDATE goals SET title=?, rank=?, status='active', updated_at=? WHERE id=?").run(title, i + 1, now(), g.id), keep.add(g.id)
      else db.prepare("INSERT INTO goals (project,title,rank,updated_at) VALUES (?,?,?,?)").run(project, title, i + 1, now())
    })
    for (const g of have) if (!keep.has(g.id) && g.status !== "dropped") db.prepare("UPDATE goals SET status='dropped', updated_at=? WHERE id=?").run(now(), g.id)
    const top = topGoal(db, project)
    if (top) for (const t of ["tickets", "ideas"]) db.prepare(`UPDATE ${t} SET goal=? WHERE project=? AND goal IS NULL`).run(top, project)
  })()
  return goals(db, project)
}
export const goals = (db: DB, project: string) => db.prepare("SELECT * FROM goals WHERE project=? AND status='active' ORDER BY rank").all(project) as Goal[]
export const topGoal = (db: DB, project: string) => goals(db, project)[0]?.id ?? null
/** A goal id the planner gave, if it is one of this project's active goals; else the top goal. */
export const goalFor = (db: DB, project: string, id: unknown) => goals(db, project).find((g) => g.id === Number(id))?.id ?? topGoal(db, project)
/** "G1 Launch on Play" lines for a prompt; the id is what tickets link to. */
export const goalsText = (gs: Goal[]) => gs.map((g) => `G${g.id} (rank ${g.rank}): ${g.title}`).join("\n") || "(no goals set yet: rank by the project rules)"

// ---- tickets -----------------------------------------------------------------
// engineer: mobile | web | backend (the EM assigns it; null = plain Engineer). prd: the PM's PRD (L). design: the Designer's UI spec (M/L UI).
export type Ticket = { id: number; project: string; title: string; done_when: string; size: string; risk: string; priority: number; status: string; branch: string | null; note: string | null; onto: string | null; goal: number | null; engineer: string | null; prd: string | null; design: string | null; depends_on: number | null }
const now = () => new Date().toISOString()
/** onto = an open PR's head branch: the ticket builds on it and pushes back to it (no new PR, no merge). goal: default the project's top goal. depends_on = a parent ticket id: this one is not built until the parent is shipped. */
export function addTicket(db: DB, t: { project: string; title: string; done_when?: string; size?: string; risk?: string; priority?: number; onto?: string; goal?: number | null; depends_on?: number | null }) {
  return db.prepare("INSERT INTO tickets (project,title,done_when,size,risk,priority,onto,goal,depends_on,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id")
    .get(t.project, t.title, t.done_when ?? "", t.size ?? "S", t.risk ?? "high", t.priority ?? 50, t.onto ?? null, t.goal ?? topGoal(db, t.project), t.depends_on ?? null, now(), now()) as { id: number }
}
/** SQL: the ticket (table or alias a) is not waiting on a parent. A parent row that no longer exists is no dependency. */
export const unblocked = (a = "tickets") => `(${a}.depends_on IS NULL OR NOT EXISTS (SELECT 1 FROM tickets d WHERE d.id=${a}.depends_on AND d.status!='shipped'))`
/** A parent id the planner named, if it is a live ticket of this project (not split, declined or failed); else null (a made-up id must not strand the child). */
export const parentFor = (db: DB, project: string, id: unknown) => (db.prepare("SELECT id FROM tickets WHERE id=? AND project=? AND status NOT IN ('split','declined','failed')").get(Number(id), project) as { id: number } | undefined)?.id ?? null
/** Children still waiting on a parent that failed, was declined or was split, grouped by parent; each parent state is returned once (kv dep-ping:<parent>:<updated_at>, so a re-queued parent that fails again pings again). */
export function orphanedParents(db: DB) {
  const rows = db.prepare(`SELECT p.id pid, p.project, p.title ptitle, p.status pstatus, p.id || ':' || p.updated_at pkey, c.id cid, c.title ctitle FROM tickets c JOIN tickets p ON p.id=c.depends_on
    WHERE c.status IN ('backlog','ready') AND p.status IN ('failed','declined','split') AND NOT EXISTS (SELECT 1 FROM kv WHERE k='dep-ping:' || p.id || ':' || p.updated_at) ORDER BY c.id`).all() as { pid: number; project: string; ptitle: string; pstatus: string; pkey: string; cid: number; ctitle: string }[]
  const out = new Map<number, { id: number; key: string; project: string; title: string; status: string; children: { id: number; title: string }[] }>()
  for (const r of rows) (out.get(r.pid) ?? out.set(r.pid, { id: r.pid, key: r.pkey, project: r.project, title: r.ptitle, status: r.pstatus, children: [] }).get(r.pid)!).children.push({ id: r.cid, title: r.ctitle })
  return [...out.values()]
}
export function setTicket(db: DB, id: number, patch: Partial<Pick<Ticket, "status" | "branch" | "note" | "priority" | "goal" | "engineer" | "prd" | "design">>) {
  const keys = Object.keys(patch) as (keyof typeof patch)[]
  db.prepare(`UPDATE tickets SET ${keys.map((k) => `${k}=?`).join(",")}, updated_at=? WHERE id=?`).run(...keys.map((k) => patch[k] ?? null), now(), id)
}
export const getTicket = (db: DB, id: number) => db.prepare("SELECT * FROM tickets WHERE id=?").get(id) as Ticket | undefined

// ---- pickable vs owner-only backlog (audit #2, 20 Oct) ---------------------------------------------------------------
// The Lead kept choosing owner-flagged tickets (the word list flags them, Jev falls back to "owner" when unsure), promoted nothing and
// slept 6 h. So the backlog is split BEFORE it is shown: pickable = no rule flags it, or Jev already freed it (cached per ticket in
// kv owner-verdict:<id> as {k: the text it judged, owner}); everything else is owner-only. Used by the Lead and the dashboard.
/** Tickets an agent filed (`dobby add` with DOBBY_ROLE set; the front desk reads mail): only the owner's queue starts them (audit 24 Oct H2). */
export const agentFiledKey = (id: number) => `agent-filed:${id}`
export const agentFiled = (db: DB, id: number) => !!db.prepare("SELECT 1 FROM kv WHERE k=?").get(agentFiledKey(id))
export const ticketText = (t: { title: string; done_when: string }) => `${t.title} ${t.done_when}`.trim()
export const verdictKey = (id: number) => `owner-verdict:${id}`
/** Jev's cached verdict for this ticket (true = owner-only), undefined when none or the ticket was edited since. */
export function cachedOwnerVerdict(db: DB, t: Pick<Ticket, "id" | "title" | "done_when">): boolean | undefined {
  try {
    const j = JSON.parse((db.prepare("SELECT v FROM kv WHERE k=?").get(verdictKey(t.id)) as { v: string } | undefined)?.v ?? "null") as { k: string; owner: boolean } | null
    return j && j.k === ticketText(t) ? j.owner : undefined
  } catch { return undefined }
}
/** The project's open backlog (S/M and L), highest goal rank then priority first, split into what the Lead may pick and what only the owner may start. unjudged = flagged by a soft word, no Jev verdict yet. */
export function splitBacklog(db: DB, project: string, rank: (goal: number | null) => number | undefined = () => undefined) {
  const all = db.prepare("SELECT * FROM tickets WHERE project=? AND dup_of IS NULL AND status='backlog' ORDER BY priority DESC, id").all(project) as Ticket[]
  all.sort((a, b) => (rank(a.goal) ?? 999) - (rank(b.goal) ?? 999)) // stable: priority, then id, inside a rank
  const pickable: Ticket[] = [], owner: Ticket[] = [], unjudged: Ticket[] = []
  const base = policyCtx(project)
  for (const t of all) {
    const g = ticketGate(ticketText(t), { ...base, title: t.title })
    const v = cachedOwnerVerdict(db, t)
    if (agentFiled(db, t.id)) owner.push(t)
    else if (g === "free" || (g === "ask" && (v === false || (v === undefined && !unsureOwner())))) pickable.push(t)
    else {
      owner.push(t)
      if (g === "ask" && v === undefined) unjudged.push(t)
    }
  }
  return { pickable, owner, unjudged }
}

// Card text names things in words (owner, 20 Oct): "Shop · Sign-in full state", never #309, a commit code or a model name.
/** A title for a phone: up to 50 characters, no paths. */
export const short = (title: string) => clip(shortTitle(title), 50)
export const labelOf = (app: string, title: string) => `${app[0].toUpperCase()}${app.slice(1)} · ${short(title)}`
/** "<App> · <short title>" for a ticket; "a ticket" if it is gone. */
export function label(db: DB, id: number) {
  const t = getTicket(db, id)
  return t ? labelOf(t.project, t.title) : "a ticket"
}
export const ideaTitle = (db: DB, id: number) => (db.prepare("SELECT title FROM ideas WHERE id=?").get(id) as { title: string } | undefined)?.title
// ---- the path a ticket takes (owner, 17 Oct: process scales with risk) --------------------
// S: Engineer, QA, Code Reviewer. M: + Designer when it touches screens. L: + PRD, split into a program, Program Manager launch check.
// Sensitive (auth, payments, personal data, security, schema): Opus review (the Engineer stays Sonnet unless the ticket is L).
// ponytail: word lists, not judgment; the EM can put "sensitive" or "UI" in a title when they miss.
const SENSITIVE = /\b(sensitive|auth\w*|log ?in|sign[- ]?(in|up)|sessions?|passwords?|encrypt\w*|permissions?|payments?|billing|subscriptions?|migrations?|schema|privacy|personal data|pii|security)\b/i
const UI = /\b(screens?|pages?|ui|ux|buttons?|layout|modal|dialog|forms?|tabs?|styles?|css|theme|dark mode|onboarding|empty state|charts?|cards?|icons?|navigation)\b/i
export const ENGINEERS = ["mobile", "web", "backend"]
export function riskPath(t: Pick<Ticket, "title" | "done_when" | "size">) {
  const text = `${t.title} ${t.done_when}`
  const sensitive = SENSITIVE.test(text)
  // strong = the Opus Builder. Only L (audit #8: sensitive words put $153 in 5 days on Opus builders); sensitive still means a strict Opus REVIEW and a big merge.
  return { sensitive, design: t.size !== "S" && UI.test(text), prd: t.size === "L", launch: t.size === "L", strong: t.size === "L" }
}

/**
 * Apps run in parallel (owner, 17 Oct: no app always first): a free worker takes the app with the fewest running tickets,
 * then the highest priority ready ticket there, oldest first. L tickets wait for the Engineering Manager to split them.
 */
export function nextTicket(db: DB) {
  // A ready ticket that already used its builds (BUILD_CAP, across retries) is parked, not claimed again
  // Builds before the cap shipped (20 Oct) don't count: every ticket without a baseline gets one at today's count, so nothing live is parked on rollout
  seedBuildBases(db)
  for (const { id } of db.prepare(`SELECT id FROM tickets t WHERE status='ready' AND (SELECT COUNT(*) FROM runs r WHERE r.kind='build' AND r.ticket=t.id AND COALESCE(r.reason,'') NOT LIKE '${CEILING}%') - COALESCE((SELECT CAST(v AS INTEGER) FROM kv WHERE k='build-base:'||t.id), 0) >= ?`).all(BUILD_CAP) as { id: number }[])
    setTicket(db, id, { status: "failed", note: `${BUILD_CAP} builds without shipping; a hand re-queue gives it ${BUILD_CAP} more` })
  // a paused project or ticket (src/pause.ts) is skipped, the next one is taken
  // a ticket with depends_on waits until its parent is shipped (a parent row that no longer exists is no dependency)
  return (db.prepare(`SELECT * FROM tickets t WHERE status='ready' AND size!='L' AND ${unblocked("t")}
    ORDER BY (SELECT COUNT(*) FROM tickets r WHERE r.status='running' AND r.project=t.project), priority DESC, id ASC`).all() as Ticket[]).find((t) => !paused(db, { kind: "builders", project: t.project, ticket: t.id }))
}

// A hand re-queue refuses on the title alone, no classifier: a hard rule (Owner:, a real client's name) on title + done_when, or a
// title word for a category the safety rules put at owner/never (src/safety.ts ticketGate) that no cached verdict freed.
const buildRuns = (db: DB, id: number) => (db.prepare(`SELECT COUNT(*) n FROM runs WHERE kind='build' AND ticket=? AND COALESCE(reason,'') NOT LIKE '${CEILING}%'`).get(id) as { n: number }).n
/** Build runs on a ticket since the owner last queued it by hand (kv build-base:<id> holds the count back then). */
export const buildsUsed = (db: DB, id: number) => buildRuns(db, id) - Number((db.prepare("SELECT v FROM kv WHERE k=?").get(`build-base:${id}`) as { v: string } | undefined)?.v ?? 0)
/** First sighting sets the baseline to the current count (idempotent), so the cap counts builds from rollout on, never history. */
export function seedBuildBases(db: DB) {
  db.prepare(`INSERT OR IGNORE INTO kv (k, v) SELECT 'build-base:'||t.id, (SELECT COUNT(*) FROM runs r WHERE r.kind='build' AND r.ticket=t.id AND COALESCE(r.reason,'') NOT LIKE '${CEILING}%') FROM tickets t WHERE t.status NOT IN ('shipped','declined')`).run()
}
/** Most builds one ticket gets across retries and requeues (audit #8: up to 9 per ticket). A hand re-queue starts a fresh count. */
export const BUILD_CAP = 4
/** A hand (re)queue starts afresh: builds and cost count from now, and the same-failure comparison begins again. */
export function resetCounts(db: DB, id: number) {
  db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`build-base:${id}`, String(buildRuns(db, id)))
  db.prepare("INSERT OR REPLACE INTO kv SELECT ?, COALESCE(SUM(cost_usd),0) FROM runs WHERE ticket=?").run(`cost-base:${id}`, id) // the ticket budget (savings.ts) counts from the hand re-queue on
  db.prepare("DELETE FROM kv WHERE k=?").run(`lastfail:${id}`)
}
/** backlog/failed -> ready. Owner:/deploy-type/client tickets stay put (the same rule the Lead follows), a ticket that failed the same way twice stays failed, and the answer says what happened. */
export function queueTicket(db: DB, id: number): string {
  const t = getTicket(db, id)
  if (!t) return `no ticket #${id}`
  const ctx = { ...policyCtx(t.project), title: t.title }
  const gate = ticketGate(t.title, ctx)
  if (gate === "deny" || ticketGate(`${t.title} ${t.done_when}`, ctx) === "deny" || (gate === "ask" && (cachedOwnerVerdict(db, t) ?? unsureOwner())))
    return `#${t.id} needs the owner, not an agent: ${t.title.slice(0, 80)}`
  // Same failure on a second hand re-queue: another try repeats it (audit #8). Editing the ticket (title or done rule) makes a new key.
  const key = t.status === "failed" ? `${titleKey(t.note ?? "").slice(0, 80)}|${t.title}|${t.done_when.length}` : undefined
  if (key !== undefined && (db.prepare("SELECT v FROM kv WHERE k=?").get(`fail-key:${t.id}`) as { v: string } | undefined)?.v === key)
    return `#${t.id} failed the same way as the last time it was queued, so another try would repeat it. Change the ticket or its done rule first: ${t.title.slice(0, 80)}`
  const n = db.prepare("UPDATE tickets SET status='ready' WHERE id=? AND status IN ('backlog','failed')").run(t.id).changes
  if (!n) return `#${t.id} was not queued: it is ${t.status}, and only backlog or failed tickets can be queued`
  if (key !== undefined) db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`fail-key:${t.id}`, key)
  resetCounts(db, t.id)
  return `#${t.id} queued; a builder picks it up within about a minute`
}

/** Owner liked an idea: it becomes a backlog ticket, then goes through queueTicket. */
export function ideaToTicket(db: DB, ideaId: number): string {
  const i = db.prepare("SELECT * FROM ideas WHERE id=?").get(ideaId) as { id: number; project: string; title: string; size: string | null; experiment: string | null; status: string; goal: number | null } | undefined
  if (!i) return `no idea #${ideaId}`
  if (i.status === "approved" || i.status === "rejected") return `idea #${i.id} is already ${i.status}`
  const { id } = addTicket(db, { project: i.project, title: i.title, done_when: i.experiment ?? "", size: ["S", "M", "L"].includes(i.size ?? "") ? i.size! : "M", goal: i.goal })
  setTicket(db, id, { status: "backlog", note: `from idea #${i.id}` })
  db.prepare("UPDATE ideas SET status='approved' WHERE id=?").run(i.id)
  return `idea #${i.id} is ticket #${id}. ${queueTicket(db, id)}`
}

// ---- claude ------------------------------------------------------------------
let warnedNoSandbox = false
/**
 * Settings and environment for one run (src/sandbox.ts). Builders by default: credentials scrubbed + Claude Code's OS sandbox
 * (DOBBY_BUILDER_SANDBOX=off | env-only in the environment or secrets.env; DOBBY_SANDBOX_ROLES adds other run kinds). Other roles: as before.
 */
export function isolation(kind: string, cwd: string, env = process.env, setting = env.DOBBY_BUILDER_SANDBOX ?? readSecrets().DOBBY_BUILDER_SANDBOX, supported?: boolean): { settings: string; env: NodeJS.ProcessEnv; mode: string } {
  const mode = sandboxMode(kind, setting, env.DOBBY_SANDBOX_ROLES, supported)
  if (mode === "off") return { settings: `${ROOT}agent-settings.json`, env, mode }
  if (mode === "env-only" && (setting ?? "on").trim().toLowerCase() === "on" && !warnedNoSandbox) {
    warnedNoSandbox = true
    console.error(`foreman: no Claude Code sandbox on this platform (${process.platform}; Linux needs bubblewrap and socat), so ${kind} runs get the credential scrub only`)
  }
  const scratch = scratchDir(cwd)
  for (const d of ["gh", "config"]) mkdirSync(`${scratch}/${d}`, { recursive: true })
  const base = JSON.parse(readFileSync(`${ROOT}agent-settings.json`, "utf8"))
  return { settings: mode === "on" ? JSON.stringify({ ...base, sandbox: sandboxSettings(cwd, scratch) }) : `${ROOT}agent-settings.json`, env: builderEnv(env, cwd, scratch), mode }
}
/** One logged `claude -p` call. Prompt goes on stdin; killed after 45 minutes. */
/** effort = the role's `effort:` frontmatter (low | medium | high | xhigh | max); plan runs only, the API call ignores it (why: see callApi in api.ts). */
async function claudeOnce(db: DB, o: { project: string; kind: string; ticket?: number; model: string; prompt: string; cwd?: string; args?: string[]; effort?: string; session?: string; stallMs?: number; ceiling?: number }): Promise<{ ok: boolean; text: string; reason?: string; cost?: number }> {
  // One session per ticket and role (owner, 18 Oct): `session` names it; a later build/fix/retry resumes it, so the agent keeps
  // what it learned and the prompt cache stays warm instead of re-exploring the repo cold.
  const sk = o.session && `sess:${o.session}`
  const resume = sk ? (db.prepare("SELECT v FROM kv WHERE k=?").get(sk) as { v: string } | undefined)?.v : undefined
  // Text-only calls spend the Max plan's monthly API credits first; any API failure (or an empty balance) falls back to the plan.
  if (!apiKeyMode() && useApi(db, o.args ?? [])) { // in API-key mode every run already pays by the token
    const t0 = Date.now()
    const r = await callApi(db, o.model, o.prompt)
    logRun(db, { project: o.project, kind: o.kind, ticket: o.ticket, model: `api:${o.model}`, ok: r.ok, reason: r.ok ? undefined : r.reason, turns: 1, duration_ms: Date.now() - t0, ...(r.ok ? { input_tokens: r.input_tokens, output_tokens: r.output_tokens } : {}) })
    if (r.ok) return { ok: true, text: r.text }
    fixed(db, `The Claude API credits path failed (${r.reason}). I switched to your plan for this call and will keep using it when needed.`, "api-fallback")
  }
  if (apiKeyMode() && !apiKey()) return { ok: false, text: "", reason: "API-key mode but no DOBBY_API_KEY in the secrets file" }
  return new Promise<{ ok: boolean; text: string; reason?: string; cost?: number }>((resolve) => {
    const role = roleArgs(o.args ?? [])
    const box = isolation(o.kind, o.cwd ?? process.cwd())
    const p = spawn("claude", ["-p", ...(o.kind === "front-desk" ? [] : ["--strict-mcp-config"]), "--settings", box.settings, "--plugin-dir", `${ROOT}agent-kit`, "--append-system-prompt", rules(), "--output-format", "json", "--model", o.model, ...(resume ? ["--resume", resume] : []), ...(o.effort ? ["--effort", o.effort] : []), ...role.args], { cwd: o.cwd, env: { ...withTelemetry(box.env, { project: o.project, kind: o.kind, ticket: o.ticket }), DOBBY_ROOT: ROOT, DOBBY_BASH_ALLOW: JSON.stringify(role.bash), DOBBY_ROLE: o.kind, ...(apiKeyMode() ? { ANTHROPIC_API_KEY: apiKey() } : {}) }, stdio: ["pipe", "pipe", "pipe"] })
    let raw = ""
    p.stdout.on("data", (d) => (raw += d))
    p.stdin.end(o.prompt)
    // stallMs (short read-only roles): a run that has not answered by then is hung (18 Oct: claude froze at startup); kill it so the tick is not blocked 45 minutes
    let stalled = false
    const timer = setTimeout(() => { stalled = !!o.stallMs; p.kill("SIGKILL") }, o.stallMs ?? 45 * 60_000)
    // Context ceiling (config builderContextCeiling, builders only): the session transcript says how big the context is; past the ceiling the run is ended and the caller continues fresh.
    let capped = 0
    const dir = o.ceiling ? transcriptDir(o.cwd ?? process.cwd()) : ""
    const t0 = Date.now() - 2000
    const poll = o.ceiling ? setInterval(() => {
      const n = contextTokens(dir, t0)
      if (n > o.ceiling! && !capped) { capped = n; p.kill("SIGTERM"); setTimeout(() => p.kill("SIGKILL"), 5000).unref() }
    }, 10_000) : undefined
    // A spawn that cannot start (missing cwd, claude mid-update) is a failed run, not a crash of the whole tick.
    p.on("error", (e) => {
      clearTimeout(timer); clearInterval(poll)
      logRun(db, { project: o.project, kind: o.kind, ticket: o.ticket, model: o.model, ok: false, reason: `spawn: ${e.message}` })
      resolve({ ok: false, text: "", reason: `spawn: ${e.message}` })
    })
    p.on("close", (code) => {
      clearTimeout(timer); clearInterval(poll)
      if (capped) {
        const reason = `${CEILING}: ${capped} tokens`
        logRun(db, { project: o.project, kind: o.kind, ticket: o.ticket, model: o.model, ok: false, reason, duration_ms: Date.now() - t0 - 2000, ...runUsage(dir, t0) }) // paid work: ticketBudget and the build caps must see it
        return resolve({ ok: false, text: "", reason })
      }
      if (stalled) {
        logRun(db, { project: o.project, kind: o.kind, ticket: o.ticket, model: o.model, ok: false, reason: `stalled ${Math.round(o.stallMs! / 60_000)} min` })
        return resolve({ ok: false, text: "", reason: "stalled" })
      }
      let { text, ...run } = parseResult(o.project, o.kind, o.model, raw, code ?? 1)
      let sid = (() => { try { return JSON.parse(raw).session_id as string | undefined } catch { return undefined } })()
      // Unreadable output from a builder (config recoverOutput): its words and session are still in the transcript, so the build is not wasted.
      if (config().recoverOutput && o.kind === "build" && run.reason?.startsWith("unparsable")) {
        const got = lastAssistantText(transcriptDir(o.cwd ?? process.cwd()), t0)
        if (got) { text = got.text; sid = got.session; run = { ...run, ok: true, reason: undefined } }
      }
      if (sk && sid) db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(sk, sid)
      logRun(db, { ...run, ticket: o.ticket })
      resolve({ ok: run.ok, text, reason: run.reason, cost: run.cost_usd })
    })
  })
}

/** The Checker's one JSON line. Anything unreadable is a fail. */
export function parseVerdict(text: string): { pass: boolean; reason: string } {
  const line = text.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"))
  try {
    const j = JSON.parse(line ?? "")
    return { pass: j.pass === true, reason: String(j.reason ?? "") }
  } catch {
    return { pass: false, reason: `unreadable verdict: ${text.slice(0, 120)}` }
  }
}

// ---- duplicates --------------------------------------------------------------
/** Title key for exact-duplicate checks: lowercase letters and digits only. */
export const titleKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
/** True when a live (not rejected/duplicate) ticket or idea in this project already has this title. */
export function isDuplicate(db: DB, project: string, title: string): boolean {
  const k = titleKey(title)
  const rows = db.prepare(`SELECT title FROM tickets WHERE project=? AND dup_of IS NULL AND status NOT IN ('declined')
                           UNION ALL SELECT title FROM ideas WHERE project=? AND dup_of IS NULL AND status!='rejected'`).all(project, project) as { title: string }[]
  return rows.some((r) => titleKey(r.title) === k)
}
/** Haiku's answer: groups of ids that are the same piece of work, first id = the one to keep. */
export function parseGroups(text: string): string[][] {
  const line = text.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"))
  try {
    const g = JSON.parse(line ?? "").groups
    return Array.isArray(g) ? g.filter((x: unknown) => Array.isArray(x) && x.length > 1).map((x: unknown[]) => x.map(String)) : []
  } catch {
    return []
  }
}

// ---- memory ------------------------------------------------------------------
/** Claude Code's auto-memory folder for a repo path: ~/.claude/projects/<path with / and . as ->/memory. */
export const memoryDir = (repo: string) => home(`~/.claude/projects/${repo.replace(/[/.]/g, "-")}/memory`)
/** The founder's working rules (built by `dobby company`), for roles that make judgment calls. Empty until built. */
export function company(): string {
  try {
    return `\n\nHOW THE FOUNDER WORKS (company.md):\n${readFileSync(`${ROOT}company.md`, "utf8")}`
  } catch {
    return ""
  }
}

/** Claude itself is signed out (18 Oct: "OAuth session expired" ate every ticket's three builds and its retry as "nothing committed"). Not the ticket's fault. */
export const signedOut = (r: { ok: boolean; reason?: string | null; text?: string }) =>
  !r.ok && /failed to authenticate|oauth session expired|not logged in|please run \/login/i.test(`${r.reason ?? ""} ${r.text ?? ""}`)

export type DoctorInput = {
  tickets: { id: number; status: string; updated_at: string }[]
  pauses: { text: string; at: number }[] // pauseList(): ms since epoch
  origins: { project: string; base: string; ok: boolean }[] // does origin/<base> resolve in the project's repo (all its worktrees share refs)
  auth: { ok: boolean; reason?: string | null; text?: string }
  scan?: { at: number; todo: number; reviewed: number; skipped: string } // kv review:scan:last, written by each review-scan
}
const STUCK_MS = 2 * 3600_000
const STALE_PAUSE_MS = 7 * 86_400_000
/** `dobby doctor`: one {name, ok, detail} per check. Pure: the caller reads the db rows, runs git and probes claude. */
export function doctor(i: DoctorInput, at = Date.now()) {
  const old = (t: number, ms: number) => at - t > ms
  const stuck = i.tickets.filter((t) => t.status === "running" && old(Date.parse(t.updated_at), STUCK_MS))
  const badOrigin = i.origins.filter((o) => !o.ok)
  const stale = i.pauses.filter((p) => old(p.at, STALE_PAUSE_MS))
  const list = (xs: string[]) => xs.join(", ")
  return [
    { name: "stuck tickets", ok: !stuck.length, detail: stuck.length ? `running over 2 hours: ${list(stuck.map((t) => `#${t.id}`))}` : "none running over 2 hours" },
    { name: "origin/base", ok: !badOrigin.length, detail: badOrigin.length ? `origin/<base> does not resolve: ${list(badOrigin.map((o) => `${o.project} (${o.base})`))}` : "resolves in every project" },
    { name: "claude session", ok: i.auth.ok, detail: i.auth.ok ? "signed in" : signedOut(i.auth) ? "signed out: run `claude`, then `/login`" : i.auth.reason === "stalled" ? "claude did not answer in 60 s" : `claude probe failed: ${i.auth.reason ?? i.auth.text ?? "unknown"}`.slice(0, 200) },
    { name: "old pauses", ok: !stale.length, detail: stale.length ? `paused over 7 days: ${list(stale.map((p) => p.text))}` : "none older than 7 days" },
    // a skip is a fact to see, not a broken pipeline: ok stays true unless no scan ran for 2 hours (it runs every 15 minutes)
    { name: "review scan", ok: !i.scan || !old(i.scan.at, STUCK_MS), detail: !i.scan ? "no scan recorded yet" : `last ${new Date(i.scan.at).toISOString().slice(11, 16)} UTC: reviewed ${i.scan.reviewed} of ${i.scan.todo}${i.scan.skipped ? `; skipped the rest: ${i.scan.skipped}` : ""}` },
  ]
}

const authPing = async (text: string) => {
  if (process.env.NODE_TEST_CONTEXT) return // `node --test` child: never post to the real #system-status
  await import("./telegram.ts").then((t) => t.notify(text, fetch, undefined, { kind: "health" })).catch(() => {})
}

/**
 * claude() with one retry when a stall-guarded run hung. Signed out: no retry, and one ping to the owner at most every 6 hours,
 * whichever role hit it (build, check, review, lead...). Callers that loop stop on signedOut(r).
 */
export async function claude(db: DB, o: Parameters<typeof claudeOnce>[1], once = claudeOnce, ping = authPing) {
  // Build cap per ticket across retries (audit #8): no spawn once a ticket has used its builds; the run ends as a failed build
  if (o.kind === "build" && o.ticket != null && buildsUsed(db, o.ticket) >= BUILD_CAP) return { ok: false, text: "", reason: `build cap: ${BUILD_CAP} builds on this ticket` }
  // Opt-in harness routing (providers.enabled in config, default off; src/agents.ts). Off or absent: agents.ts is never loaded.
  const routed = config().providers?.enabled === true
  if (routed) once = (await import("./agents.ts")).routed(once)
  const r = await once(db, o)
  if (signedOut(r)) {
    const last = Number((db.prepare("SELECT v FROM kv WHERE k='auth:ping'").get() as { v: string } | undefined)?.v ?? 0)
    if (Date.now() - last > 6 * 3600_000) {
      db.prepare("INSERT OR REPLACE INTO kv VALUES ('auth:ping', ?)").run(String(Date.now()))
      await ping(apiKeyMode() ? "🔑 Dobby is stopped: the API key was refused. Check DOBBY_API_KEY in the secrets file and the key's balance. Tickets and reviews are waiting untouched." : "🔑 Dobby is stopped: Claude is signed out on the Mac. Open a terminal, run `claude`, then `/login`. Tickets and reviews are waiting untouched.")
    }
    return r
  }
  // A routed run that already fell back to claude (2 agents) is not retried again: at most 2 agents per stall, as before routing.
  if (r.reason !== "stalled" || o.kind === "doctor" || ((r as { agents?: number }).agents ?? 1) >= 2) return r // doctor is a one-shot probe: no retry, no health post
  const r2 = await claudeOnce(db, o)
  // Tell the owner in plain words (#system-status) what froze, and whether the retry fixed it.
  const what = `${o.kind.replace("-week", "")} step for ${o.project}`
  const mins = Math.round((o.stallMs ?? 0) / 60_000)
  const msg = r2.reason === "stalled"
    ? `⚠️ The ${what} froze twice (${mins} minutes each) and I killed both. It is still not working, so ${o.project} may get no new tasks until it recovers.`
    : `🔧 The ${what} froze for ${mins} minutes. I killed it and retried, and the retry worked.`
  fixed(db, msg.replace(/^[^ ]+ /, ""))
  return r2
}

/** 👎 on an idea: it is rejected (only from the given statuses) and the answer names it. Undo = undoIdea. */
export function dropIdea(db: DB, id: number, from: string[]) {
  db.prepare(`UPDATE ideas SET status='rejected' WHERE id=? AND status IN (${from.map(() => "?").join(",")})`).run(id, ...from)
  return `👎 Dropped "${short(ideaTitle(db, id) ?? "that idea")}"`
}
/** ↩️ Undo on a dropped idea: back to 'new', like a fresh seed. */
export function undoIdea(db: DB, id: number) {
  const n = db.prepare("UPDATE ideas SET status='new' WHERE id=? AND status='rejected'").run(id).changes
  return n ? `↩️ Brought back "${short(ideaTitle(db, id)!)}"` : "Nothing to undo: that idea is not dropped."
}

/** `--repo owner/repo` from the dir's origin remote, so gh never picks an `upstream` remote. Empty when origin is unknown. */
export function repoArgs(dir: string, git: (args: string[], cwd: string) => { ok: boolean; out: string }): string[] {
  const o = git(["remote", "get-url", "origin"], dir)
  const slug = o.ok ? repoSlug(o.out) : null
  return slug ? ["--repo", slug] : []
}
/**
 * The newest PR on `branch` is MERGED or CLOSED: a fix ticket onto it has nothing left to do. GitHub deletes the
 * branch on merge, but a later push recreates it (23 Oct: #920 merged, ticket #749 kept fixing it), so the branch
 * still existing proves nothing. null = open, no PR, or GitHub unreadable (build as before).
 */
export async function prDone(dir: string, branch: string, run: ARun = netRun): Promise<"MERGED" | "CLOSED" | null> {
  const o = await run("gh", ["pr", "list", ...(await repoArgsAsync(dir)), "--head", branch, "--state", "all", "--json", "state", "-q", ".[0].state"], dir)
  const s = o.ok ? o.out.trim() : ""
  return s === "MERGED" || s === "CLOSED" ? s : null
}

/** repoArgs for the async callers (the ticket graph): the same `--repo` flag, without blocking the event loop. */
export async function repoArgsAsync(dir: string): Promise<string[]> {
  const o = await netRun("git", ["remote", "get-url", "origin"], dir)
  const slug = o.ok ? repoSlug(o.out) : null
  return slug ? ["--repo", slug] : []
}

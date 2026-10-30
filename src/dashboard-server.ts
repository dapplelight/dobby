// `dobby dashboard`: one page + JSON endpoints over the live DB, opened read-only. GET, plus the one allowlisted POST /api/action (runs `dobby do` in a child; this process never writes).
// Loopback by default. Any other --host needs DASHBOARD_TOKEN (secrets file). The server makes one on first start; `dobby dashboard open` visits /auth?token= so the browser holds it as an HttpOnly cookie. The owner never sees or pastes it.
import { KINDS } from "./pause.ts"
import Database from "better-sqlite3"
import { spawn } from "node:child_process"
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { createAdaptorServer, type HttpBindings } from "@hono/node-server"
import { Hono, type Context } from "hono"
import { streamSSE } from "hono/streaming"
import type { Server } from "node:http"
import { config, expand } from "./config.ts"
import { extname, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { DB } from "./db.ts"
import { UserError } from "./actions.ts"
import { DATA, open as openWritable } from "./db.ts"
import { reviewsPage, snapshot, ticketDetail } from "./dashboard.ts"
import { findingById } from "./findings.ts"
import { diffReader, diffTextReader } from "./diffstat.ts"
import { NewTicket, type Held } from "./api-schema.ts"
import { doTimeoutMs, loadProjects, readUsage, timeoutMs } from "./lib.ts"
import { limitsNow } from "./view.ts"
import { ensureToken, readSecrets, redact } from "./notify.ts"
import { bodyLimit } from "hono/body-limit"
import { mountMcp } from "@nimit9/signet-server/mcp/hono"
import { createDobbyServer } from "./mcp.ts"
import { noteUse, showText as statsShow } from "./stats.ts"
import { real, type Deps } from "./actions.ts"
import { activityPage, freshEvents, KINDS as ACTIVITY_KINDS, morningSummary, type ActivityKind } from "./activity.ts"
import { spendPage } from "./spend.ts"
// Settings, Team and First run (PR 6)
import { ConfigError, configView, prepareSet } from "./config-edit.ts"
import { ROLES_DIR, MAX_ROLE, isEdited, roleText, teamView } from "./dashboard-team.ts"
import { healthView, providersView, schedulesView, welcomeView, type HealthView, type ProvidersView } from "./dashboard-settings.ts"
import { apiKeyMode, type Project } from "./lib.ts"
import { createSetup, type SetupDeps } from "./dashboard-setup.ts"

export const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"])
const BUILT = fileURLToPath(new URL("../dashboard/dist", import.meta.url)) // the same path from src/ and from dist/
/** Where the built React app lives: DOBBY_DASHBOARD_DIST, then the config path, then dashboard/dist in the package. When index.html is not there, a one-line page says to build it. */
export const defaultDist = () => process.env.DOBBY_DASHBOARD_DIST || (config().paths.dashboardDist ? expand(config().paths.dashboardDist) : BUILT)
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".map": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
  ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
}

/** A request path mapped to a regular file inside `dist`, or null. Rejects encoded traversal, NUL bytes and symlinks that lead out. */
export function distFile(dist: string, pathname: string): string | null {
  let rel: string
  try { rel = decodeURIComponent(pathname) } catch { return null }
  if (rel.includes("\0")) return null
  try {
    const root = realpathSync(dist)
    const p = resolve(root, `.${rel}`)
    if (p !== root && !p.startsWith(root + sep)) return null
    const real = realpathSync(p) // a symlink inside dist must not point out of it
    if (!real.startsWith(root + sep) || !statSync(real).isFile()) return null
    return real
  } catch { return null }
}

/** The CSP for the built app: its own files, plus exactly the inline scripts index.html contains (the theme prelude), by hash. */
function spaCsp(indexHtml: string) {
  const hashes = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`)
  return `default-src 'none'; connect-src 'self'; script-src 'self' ${hashes.join(" ")}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'`
}

/** No built app: say what to run. */
const NOT_BUILT = "<!doctype html><meta charset=utf-8><title>dobby</title><p>The dashboard is not built. In a checkout run <code>npm run build</code>; from npm, reinstall dobby-ai."

export function parseArgs(a: string[]) {
  const val = (flag: string) => { const i = a.indexOf(flag); return i < 0 ? undefined : a[i + 1] }
  const port = Number(val("--port") ?? 4710)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad --port: ${val("--port")}`)
  return { port, host: val("--host") ?? "127.0.0.1", tunnel: a.includes("--tunnel") }
}

/** The same file Dobby writes, opened so nothing can change it. */
export function openReadOnly(path = `${DATA}/dobby.db`): DB {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  db.pragma("query_only = ON")
  return db
}

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y) } // byte lengths, not string lengths: timingSafeEqual throws on unequal buffers
type Env = { Bindings: HttpBindings }
type Ctx = Context<Env>
const send = (code: number, type: string, body: string | Uint8Array<ArrayBuffer>, extra: Record<string, string> = {}) =>
  new Response(body, { status: code, headers: { "content-type": type, ...extra } })
/** A browser that is not signed in gets a small styled page with the one command; scripts and fetches keep the plain text. */
const signedOut = (c: Ctx, text: string) => {
  if (!(c.req.header("accept") ?? "").includes("text/html")) return send(401, "text/plain", text)
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signed out - dobby</title><style>
:root{color-scheme:light dark;--bg:#fff;--ink:#16161a;--ink2:#5b5b66;--line:#dcdce2}@media(prefers-color-scheme:dark){:root{--bg:#101012;--ink:#ececf0;--ink2:#9a9aa6;--line:#2c2c33}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}main{max-width:30rem;padding:0 20px}h1{font-size:1.5rem;font-weight:500;margin:0 0 .5rem}p{margin:0 0 1rem;color:var(--ink2)}code{display:inline-block;padding:.4rem .75rem;border:1px solid var(--line);border-radius:8px;font:14px ui-monospace,monospace;color:var(--ink)}
</style></head><body><main><h1>This browser is signed out</h1><p>${text.startsWith("wrong token") ? "The sign-in link did not match this dashboard." : "This dashboard needs the sign-in you get from the terminal."} Run this in a terminal, then reload:</p><code>dobby dashboard open</code></main></body></html>`
  return send(401, "text/html; charset=utf-8", page)
}
const cookie = (c: Ctx, name: string) => (c.req.header("cookie") ?? "").split(/;\s*/).map((x) => x.split("=")).find(([k]) => k === name)?.[1]
const COOKIE = "foreman_dash"
const safeDecode = (c: string) => { try { return decodeURIComponent(c) } catch { return "" } }
/** The caller holds the token: our cookie (the owner's browser) or the x-foreman-token header. Agents on this Mac have neither. */
function authed(c: Ctx, token?: string) {
  if (!token) return false
  const h = c.req.header("x-foreman-token")
  const k = cookie(c, COOKIE)
  return (typeof h === "string" && same(h, token)) || (!!k && same(safeDecode(k), token))
}

/** tunnel: listens on loopback for a local HTTPS tunnel (Tailscale Serve, cloudflared), so every request needs the token, as off loopback. pollMs and heartbeatMs are for the live stream (tests shorten them). */
/** Where Settings, Team and First run read from. Tests inject all of them; the real server uses the defaults. */
type SettingsOpts = { configFile?: string; repoConfig?: string; projects?: () => Record<string, { repo: string; base: string; paused: boolean }>; rolesDir?: string; overrideDir?: string; checks?: () => Promise<import("./checks.ts").Check[]>; providers?: () => Promise<ProvidersView> }
type Opts = { setup?: SetupDeps; host: string; mcp?: { db: DB; deps?: Deps }; tunnel?: boolean; token?: string; now?: () => number; dist?: string; exec?: Exec; diff?: ReturnType<typeof diffReader>; diffText?: ReturnType<typeof diffTextReader>; limits?: () => unknown; pollMs?: number; heartbeatMs?: number } & SettingsOpts
/** Runs `dobby do <command...>` (or, with `direct`, `dobby <verb> ...`) and resolves with its output. Injected in tests; real one spawns bin/dobby with an argument array (no shell). */
type Exec = (args: string[], direct?: boolean) => Promise<{ ok: boolean; out: string }>

/** /mcp: the owner's Dobby over streamable HTTP. Bearer (or x-foreman-token) only, never the cookie, so a web page cannot drive it; on loopback too. */
const mcpGuards = (o: Opts) => [
  async (c: Ctx, next: () => Promise<void>) => {
    if (!o.token) return send(403, "text/plain", "MCP is off: no DASHBOARD_TOKEN is set. Start the dashboard once so it makes one (secrets file), then restart it.")
    const given = (c.req.header("authorization") ?? "").match(/^Bearer (.+)$/i)?.[1] ?? c.req.header("x-foreman-token") ?? ""
    if (!same(given, o.token)) return send(401, "text/plain", "token required: send Authorization: Bearer <DASHBOARD_TOKEN>", { "www-authenticate": "Bearer" })
    await next()
  },
  async (c: Ctx, next: () => Promise<void>) => { // DNS-rebinding guard (MCP transport spec): a browser Origin must be our own
    const origin = c.req.header("origin")
    let ours = origin === undefined
    try { ours ||= new URL(origin ?? "").host === c.req.header("host") } catch {}
    if (!ours) return send(403, "text/plain", "forbidden origin")
    await next()
  },
  bodyLimit({ maxSize: 1024 * 1024, onError: () => send(413, "text/plain", "body too large (1 MB max)") }),
  async (c: Ctx, next: () => Promise<void>) => {
    if (c.req.method === "POST" && !/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return send(415, "text/plain", "JSON only")
    await next()
  },
]

const MAX_BODY = 10 * 1024
const REPO = /^(?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}$)[\w.-]+$/ // owner/name, neither part "." or ".."
const INT = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v < 1e9 ? v : null)
const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).pop()?.slice(0, 300) ?? ""

/** The same child limits Discord gives these verbs (20 min, 3 h for landing, deploying, retrying): a merge is never cut off at 2 minutes. */
const LONG_DIRECT = new Set(["merge", "decline", "retry", "deploy", "allowround", "applyfinding", "answer"])
export const execTimeoutMs = (args: string[], direct?: boolean) => direct ? timeoutMs(LONG_DIRECT.has(args[0]) ? "do_long" : "do") : doTimeoutMs(args.join(" "))
export const execForeman: Exec = (args, direct) => new Promise((done) => {
  const p = spawn(fileURLToPath(new URL("../bin/dobby", import.meta.url)), direct ? args : ["do", ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DOBBY_BY: "the dashboard" }, timeout: execTimeoutMs(args, direct) })
  let out = ""
  p.stdout.on("data", (d) => (out += d))
  p.stderr.on("data", (d) => (out += d))
  p.on("error", (e) => done({ ok: false, out: e.message }))
  p.on("close", (code) => done({ ok: code === 0, out }))
})

/** What a request means: the command to run, whether it is a CLI verb (else a `dobby do` text), and, for the ones that can be undone, how it reads while held. */
type Plan = { args: string[]; direct?: boolean; /** runs right away; this puts it back (the `undo` action runs it) */ undo?: { args: string[]; ref: string }; hold?: { action: string; id: number | null; project: string | null; ref: string; title: string } }
const WORDS = (v: unknown) => (typeof v === "string" && v.trim() && v.length <= 2000 ? v.trim() : null)
/** A project name is a file name: letters, digits, _ and -, with single dots between parts (example.com); never a slash or "..". */
const PROJECT = /^\w[\w-]*(\.\w[\w-]*)*$/
const VERBS = { merge: "merge", decline: "decline", retry: "retry", answer: "answer", hint: "hint", takeOver: "takeover", allowRound: "allowround" } as const

/** The names POST /api/action takes (plus "undo"). A test keeps this list, the switch below and the dashboard's key registry in step. */
export const DASHBOARD_ACTIONS = ["pause", "resume", "pauseTeam", "queue", "reviewfix", "reviewaccept", "merge", "decline", "retry", "answer", "hint", "takeOver", "allowRound", "deploy", "add", "unqueue", "reorder", "makeTicket", "dismissIdea", "applyFinding", "dismissFinding", "ruleFromFinding", "configSet", "saveRole", "resetRole"] as const

/** The allowlist: an action name and its arguments to the one `dobby` command it means, or an error. Nothing else is ever run. */
export function actionArgs(db: DB, b: Record<string, unknown>, so: SettingsOpts = {}): Plan | { error: string; code?: number } {
  const ticket = (id: number) => db.prepare("SELECT id, project, title FROM tickets WHERE id=?").get(id) as { id: number; project: string; title: string } | undefined
  switch (b.action) {
    case "pause": case "resume": { // optional scope: all | a kind | project <name> | ticket <id>; pause may take "for 30m|2h|1d"
      let kind = typeof b.kind === "string" ? b.kind : ""
      if (!kind && b.id !== undefined) kind = "ticket" // { action: "pause", id } = this ticket
      const extra: string[] = []
      if (kind === "project") { if (typeof b.project !== "string" || !PROJECT.test(b.project)) return { error: "project needs a name" }; extra.push("project", b.project) }
      else if (kind === "ticket") { const id = INT(b.ticket ?? b.id); if (!id) return { error: "ticket needs a number" }; extra.push("ticket", String(id)) }
      else if (kind) { if (kind !== "all" && !(KINDS as readonly string[]).includes(kind)) return { error: `unknown pause kind: ${kind}` }; extra.push(kind) }
      if (b.action === "pause" && b.for !== undefined) { if (typeof b.for !== "string" || !/^\d{1,3}[mhd]$/.test(b.for)) return { error: "for must look like 30m, 2h or 1d" }; extra.push("for", b.for) }
      return { args: [b.action, ...extra] }
    }
    case "pauseTeam": return { args: ["pause"] } // the builders: nothing new starts, running ones finish their step
    case "queue": {
      const id = INT(b.ticket)
      if (!id) return { error: "queue needs a ticket number" }
      const st = (db.prepare("SELECT status FROM tickets WHERE id=?").get(id) as { status: string } | undefined)?.status
      if (!st) return { error: `no ticket #${id}`, code: 404 }
      if (st !== "backlog" && st !== "failed") return { error: `ticket #${id} is ${st}; only backlog or failed tickets can be queued`, code: 409 }
      return { args: ["queue", String(id)] }
    }
    case "reviewfix": case "reviewaccept": {
      const pr = INT(b.pr)
      if (typeof b.repo !== "string" || !REPO.test(b.repo) || !pr) return { error: `${b.action} needs repo (owner/name) and pr` }
      return { args: [b.action, b.repo, String(pr)] }
    }
    case "merge": case "decline": case "retry": case "answer": case "hint": case "takeOver": case "allowRound": {
      const id = INT(b.id), t = id ? ticket(id) : undefined
      if (!id) return { error: `${b.action} needs a ticket id` }
      if (!t) return { error: `no ticket #${id}`, code: 404 }
      const words = b.action === "answer" || b.action === "hint" ? WORDS(b.text) : undefined
      if (words === null) return { error: `${b.action} needs words (up to 2000 characters)` }
      const args = [VERBS[b.action], String(id), ...(words ? [words] : [])]
      if (b.action === "merge" || b.action === "decline" || b.action === "retry") return { args, direct: true, hold: { action: b.action, id, project: t.project, ref: `${t.project} #${id}`, title: t.title } }
      return { args, direct: true }
    }
    case "deploy": { // the Deploy tap only: `dobby deploy` never passes "migrate", so a data-changing migration still waits for its own tap
      if (typeof b.project !== "string" || !PROJECT.test(b.project)) return { error: "deploy needs a project name" }
      return { args: ["deploy", b.project], direct: true, hold: { action: "deploy", id: null, project: b.project, ref: b.project, title: "" } }
    }
    case "unqueue": case "reorder": {
      const id = INT(b.id)
      if (!id) return { error: `${b.action} needs a ticket id` }
      if (!ticket(id)) return { error: `no ticket #${id}`, code: 404 }
      if (b.action === "unqueue") return { args: ["unqueue", String(id)], direct: true }
      const before = b.before === undefined || b.before === null ? null : INT(b.before) // missing = last
      if (b.before !== undefined && b.before !== null && !before) return { error: "before must be a ticket id" }
      return { args: ["reorder", String(id), ...(before ? [String(before)] : [])], direct: true }
    }
    case "makeTicket": case "dismissIdea": { // the idea's id travels as `idea`; dismissing is held 8 s so it can be undone
      const id = INT(b.idea), idea = id ? db.prepare("SELECT project, title FROM ideas WHERE id=?").get(id) as { project: string; title: string } | undefined : undefined
      if (!id) return { error: `${b.action} needs an idea id` }
      if (!idea) return { error: `no idea #${id}`, code: 404 }
      if (b.action === "makeTicket") return { args: ["ideaticket", String(id)], direct: true }
      return { args: ["ideadrop", String(id)], direct: true, hold: { action: "dismissIdea", id: null, project: idea.project, ref: `idea #${id}`, title: idea.title } }
    }
    case "applyFinding": case "dismissFinding": case "ruleFromFinding": { // the finding's id travels as `finding`; dismissing is held 8 s so it can be undone
      const id = INT(b.finding)
      if (!id) return { error: `${b.action} needs a finding id` }
      const f = findingById(db, id)
      if (!f) return { error: `no finding #${id}`, code: 404 }
      if (b.action === "applyFinding") return { args: ["applyfinding", String(id)], direct: true }
      if (b.action === "dismissFinding") return { args: ["dismissfinding", String(id)], direct: true, hold: { action: "dismissFinding", id: null, project: f.repo.split("/")[1], ref: `finding #${id}`, title: `${f.path}:${f.line}` } }
      const words = b.text === undefined ? undefined : WORDS(b.text)
      if (words === null) return { error: "the rule needs words (up to 2000 characters)" }
      return { args: ["findingrule", String(id), ...(words ? [words] : [])], direct: true }
    }
    case "add": {
      const t = NewTicket.safeParse({ project: b.project, title: b.title, done_when: b.done_when || undefined, size: b.size || undefined })
      if (!t.success) return { error: t.error.issues[0]?.message ?? "That ticket is not valid." }
      return { args: ["add", t.data.project, t.data.title, t.data.done_when ?? "", ...(t.data.size ? [t.data.size] : [])], direct: true }
    }
    case "configSet": { // one setting in the private config; runs at once, and `undo` puts the old value back
      try {
        const p = prepareSet({ key: typeof b.key === "string" ? b.key : "", value: b.value, unset: b.unset === true }, { file: so.configFile })
        const args = p.unset ? ["config", "unset", p.key] : ["config", "set", p.key, JSON.stringify(p.value)]
        return { args, direct: true, undo: { args: p.before === undefined ? ["config", "unset", p.key] : ["config", "set", p.key, JSON.stringify(p.before)], ref: p.key } }
      } catch (e) { if (e instanceof ConfigError) return { error: e.message }; throw e }
    }
    case "saveRole": { // a role file's text, inside the roles folder only (the CLI checks the path again)
      const name = typeof b.name === "string" ? b.name : "", text = typeof b.text === "string" ? b.text : ""
      let before: string
      try { before = roleText(name, so.rolesDir ?? ROLES_DIR, so.overrideDir) } catch (e) { return { error: (e as Error).message, code: 400 } }
      if (!text.trim() || text.length > MAX_ROLE) return { error: `A role file is 1 to ${MAX_ROLE} characters.` }
      return { args: ["role", "save", name, text], direct: true, undo: { args: isEdited(name, so.overrideDir) ? ["role", "save", name, before] : ["role", "reset", name], ref: `roles/${name}.md` } }
    }
    case "resetRole": { // drop the owner's edited copy; undo puts it back
      const name = typeof b.name === "string" ? b.name : ""
      let before: string
      try { before = roleText(name, so.rolesDir ?? ROLES_DIR, so.overrideDir) } catch (e) { return { error: (e as Error).message, code: 400 } }
      if (!isEdited(name, so.overrideDir)) return { error: `${name} is already the default.`, code: 400 }
      return { args: ["role", "reset", name], direct: true, undo: { args: ["role", "save", name, before], ref: `roles/${name}.md` } }
    }
    default: return { error: "that action is not allowed from the dashboard" }
  }
}

/** Held actions: a Plan waits HOLD_MS, then runs; undo cancels it. Lives in this process, so closing the tab does not cancel (the timer is here, not in the browser). */
export const HOLD_MS = 8000
const SHOW_DONE_MS = 15_000
function holds(o: Opts) {
  const now = () => (o.now ?? Date.now)()
  type Entry = Held & { timer?: NodeJS.Timeout; doneAt?: number }
  const all = new Map<string, Entry>()
  const applied = new Map<string, { args: string[]; ref: string; at: number }>()
  const run = (e: Entry, p: Plan) => async () => {
    e.state = "running" // from here Undo cannot stop it: the command is already started
    const r = await (o.exec ?? execForeman)(p.args, p.direct)
    Object.assign(e, { state: r.ok ? "ran" : "failed", message: lastLine(r.out) || (r.ok ? "Done." : "That did not work."), doneAt: now() })
    console.log(`dashboard: ${e.action} ${e.ref} ${r.ok ? "ran" : "failed"}`)
  }
  return {
    hold(p: Plan & Required<Pick<Plan, "hold">>) {
      const same = [...all.values()].find((e) => (e.state === "held" || e.state === "running") && e.action === p.hold.action && e.ref === p.hold.ref)
      if (same) return same // a double tap must not run it twice
      const e: Entry = { ...p.hold, actionId: randomBytes(6).toString("hex"), runsAt: now() + HOLD_MS, state: "held" }
      e.timer = setTimeout(run(e, p), HOLD_MS)
      e.timer.unref()
      all.set(e.actionId, e)
      console.log(`dashboard: held ${e.action} ${e.ref} for ${HOLD_MS / 1000} s`)
      return e
    },
    undo(id: string) {
      const e = all.get(id)
      if (!e || e.state !== "held") return false // only an action still waiting on its timer
      clearTimeout(e.timer); all.delete(id)
      console.log(`dashboard: undone ${e.action} ${e.ref}`)
      return true
    },
    /** A change that already ran and can be put back: kept 30 min, then forgotten. */
    keep(plan: { args: string[]; ref: string }): string {
      for (const [k, v] of applied) if (now() - v.at > 30 * 60_000) applied.delete(k)
      const id = randomBytes(6).toString("hex")
      applied.set(id, { ...plan, at: now() })
      return id
    },
    async revert(id: string) {
      const e = applied.get(id)
      if (!e) return null
      applied.delete(id)
      const r = await (o.exec ?? execForeman)(e.args, true)
      console.log(`dashboard: undone ${e.ref} ${r.ok ? "ok" : "failed"}`)
      return r
    },
    list(): Held[] {
      for (const [k, e] of all) if (e.doneAt && now() - e.doneAt > SHOW_DONE_MS) all.delete(k)
      return [...all.values()].map(({ timer, doneAt, ...h }) => h)
    },
  }
}
type Holds = ReturnType<typeof holds>


async function readBody(req: Request): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return null
  const r = req.body?.getReader()
  if (!r) return ""
  let n = 0
  const chunks: Uint8Array[] = []
  for (;;) {
    const { done, value } = await r.read()
    if (done) break
    n += value.length
    if (n > MAX_BODY) { void r.cancel(); return null }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/** The guards every write has, on loopback too: token (cookie or header), same-origin, JSON, small body. A refusal is the response; otherwise the parsed JSON object. */
async function postBody(o: Opts, c: Ctx, json: (code: number, message: string) => Response): Promise<Response | Record<string, unknown>> {
  if (!o.token) return json(403, "Actions are off: restart the dashboard so it can make its token, then run `dobby dashboard open`.")
  if (!authed(c, o.token)) return json(401, "This browser is not signed in: run `dobby dashboard open`.")
  const origin = c.req.header("origin")
  let originHost = ""
  try { originHost = typeof origin === "string" ? new URL(origin).host : "" } catch {}
  if (!originHost || originHost !== c.req.header("host")) return json(403, "Cross-site request refused.")
  if (!/^application\/json\s*(;|$)/i.test(c.req.header("content-type") ?? "")) return json(415, "Send application/json.")
  const raw = await readBody(c.req.raw)
  if (raw === null) return json(413, "Request too large.")
  let body: unknown
  try { body = JSON.parse(raw) } catch { return json(400, "Body is not valid JSON.") }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, "Body must be a JSON object.")
  return body as Record<string, unknown>
}

/** POST /api/action. */
async function postAction(db: DB, o: Opts, h: Holds, c: Ctx) {
  const json = (code: number, message: string, extra: object = {}) => send(code, "application/json", JSON.stringify({ ok: code === 200, message, ...extra }))
  const body = await postBody(o, c, json)
  if (body instanceof Response) return body
  const req = body
  if (req.action === "undo") {
    if (typeof req.actionId === "string" && h.undo(req.actionId)) return json(200, "Undone. Nothing ran.")
    const back = typeof req.actionId === "string" ? await h.revert(req.actionId) : null // a setting or role file that already changed: put it back
    if (back) return json(back.ok ? 200 : 500, back.ok ? `Undone. ${lastLine(back.out)}` : lastLine(back.out) || "That could not be put back.")
    return json(404, "That action already ran or was undone.")
  }
  const a = actionArgs(db, req, o)
  if ("error" in a) return json(a.code ?? 400, a.error)
  if (a.hold) { const e = h.hold({ ...a, hold: a.hold }); return json(200, `${a.hold.action} ${a.hold.ref} in ${HOLD_MS / 1000} s. Undo stops it.`, { actionId: e.actionId, runsAt: e.runsAt }) }
  const r = await (o.exec ?? execForeman)(a.args, a.direct)
  const msg = lastLine(r.out) || (r.ok ? "Done." : "That did not work.")
  if (r.ok && a.undo) return json(200, msg, { actionId: h.keep(a.undo) })
  return json(r.ok ? 200 : 500, msg)
}

/** One poller shared by every /api/events client: the snapshot is read every pollMs and pushed only when it changed (ignoring its clock), and each new run, review or merge is pushed once as its own event. It runs only while someone listens. */
function feed(db: DB, o: Opts, h: Holds) {
  const subs = new Set<(event: string, json: string) => void>()
  const seen = new Set<string>()
  let timer: NodeJS.Timeout | undefined, key = "", json = ""
  const now = () => (o.now ?? Date.now)()
  const read = () => {
    const s = { ...snapshot(db, now(), 7, o.limits?.(), o.diff), held: h.list(), projects: Object.keys((o.projects ?? loadProjects)()) }
    const k = JSON.stringify({ ...s, at: 0 })
    if (k === key) return false
    key = k; json = redact(JSON.stringify(s))
    return true
  }
  const tick = () => {
    try { if (read()) for (const f of subs) f("snapshot", json) } catch {}
    try { for (const e of freshEvents(db, seen, now())) { const data = redact(JSON.stringify(e)); for (const f of subs) f(e.kind, data) } } catch {}
  }
  const sub = (f: (event: string, json: string) => void) => {
    if (!subs.size) { key = ""; seen.clear(); read(); try { freshEvents(db, seen, now(), true) } catch {}; timer = setInterval(tick, o.pollMs ?? 2000); timer.unref() }
    subs.add(f); f("snapshot", json)
    return () => { subs.delete(f); if (!subs.size) clearInterval(timer) }
  }
  return Object.assign(sub, { emit: (event: string, data: string) => { for (const f of subs) f(event, data) } })
}

export function app(db: DB, o: Opts) {
  const loopback = LOOPBACK.has(o.host) && !o.tunnel // behind a tunnel, a loopback peer can be anyone on the internet
  const dist = o.dist ?? defaultDist()
  o = { diff: diffReader(), diffText: diffTextReader(), ...o }
  const hold = holds(o)
  const listen = feed(db, o, hold)
  const h = new Hono<Env>()
  h.onError((e) => send(500, "text/plain", `dashboard error: ${e.message}`))
  // Every response carries these, errors and redirects included.
  h.use("*", async (c, next) => {
    await next()
    c.header("cache-control", "no-store"); c.header("x-content-type-options", "nosniff"); c.header("referrer-policy", "no-referrer")
  })
  h.use("*", async (c, next) => {
    const url = new URL(c.req.url)
    if (o.mcp && url.pathname === "/mcp") return next() // its own guards (mountMcp below): the token is a bearer, not the cookie
    const post = c.req.method === "POST" && url.pathname === "/api/action"
    if (url.pathname.startsWith("/api/setup/") && !o.setup) return send(404, "text/plain", "not found") // setup mode only
    const setupPost = c.req.method === "POST" && !!o.setup && url.pathname.startsWith("/api/setup/")
    if (c.req.method !== "GET" && c.req.method !== "HEAD" && !post && !setupPost) return send(405, "text/plain", "GET only (the one write is POST /api/action)", { allow: "GET, HEAD, POST" })
    // A web page on another site must not be able to read a loopback-only dashboard (DNS rebinding): the Host header has to be local.
    if (loopback && !LOOPBACK.has((c.req.header("host") ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, ""))) return send(403, "text/plain", "forbidden host")
    // /auth?token= (also ?token= on any path off loopback, for old phone links): right token sets the HttpOnly cookie and redirects to the clean URL; wrong is a plain 401.
    const given = url.searchParams.get("token")
    if (url.pathname === "/auth" || (!loopback && given !== null)) {
      if (!o.token || !same(given ?? "", o.token)) return signedOut(c, "wrong token: run `dobby dashboard open`")
      const secure = c.req.header("x-forwarded-proto") === "https" || (c.env?.incoming?.socket as { encrypted?: boolean } | undefined)?.encrypted ? "; Secure" : ""
      const dest = url.pathname === "/auth" ? "/" : url.pathname
      return send(302, "text/plain", "", { location: dest, "set-cookie": `${COOKIE}=${o.token}; HttpOnly; SameSite=Strict; Path=/${secure}` })
    }
    // Off loopback every request needs the token. On loopback the page loads without it, but its data does not: any local process
    // (a sandboxed builder may reach localhost) could read tickets and notes (audit 24 Oct L1). Writes need it too, see postAction.
    const data = url.pathname.startsWith("/api/") && url.pathname !== "/api/session"
    if ((!loopback || (data && o.token)) && !authed(c, o.token)) return signedOut(c, "token required: run `dobby dashboard open`")
    await next()
  })
  if (o.mcp) { const m = o.mcp; mountMcp(h, "/mcp", { middleware: mcpGuards(o), server: () => (noteUse(m.db, "mcp_http"), createDobbyServer(m.db, m.deps ?? real)) }) }
  h.post("/api/action", (c) => postAction(db, o, hold, c))
  h.get("/api/session", (c) => (noteUse(o.mcp?.db, "dashboard"), send(200, "application/json", JSON.stringify({ canAct: authed(c, o.token), ...(o.setup ? { setup: true } : {}) }))))
  if (o.setup) { // `dobby init --ui` only: the browser face of setup
    const setup = createSetup(o.setup, (st) => listen.emit("setup", redact(JSON.stringify(st))))
    h.get("/api/setup/state", () => send(200, "application/json", redact(JSON.stringify(setup.state()))))
    h.post("/api/setup/:step{.+}", async (c) => {
      const reply = (code: number, message: string) => send(code, "application/json", JSON.stringify({ ok: false, message }))
      const body = await postBody(o, c, reply)
      if (body instanceof Response) return body
      const r = await setup.handle(c.req.param("step"), body)
      return send(r.code, "application/json", redact(JSON.stringify(r.body)))
    })
  }
  h.get("/api/snapshot", (c) => send(200, "application/json", redact(JSON.stringify({ ...snapshot(db, (o.now ?? Date.now)(), c.req.query("days") === "30" ? 30 : 7, o.limits?.(), o.diff), held: hold.list(), projects: Object.keys((o.projects ?? loadProjects)()) }))))
  // Server-sent events: a `snapshot` event on connect and whenever it changes, a `heartbeat` every heartbeatMs.
  h.get("/api/events", (c) => streamSSE(c, async (stream) => {
    const off = listen((event, data) => { stream.writeSSE({ event, data }).catch(() => {}) })
    stream.onAbort(off)
    while (!stream.aborted) {
      await new Promise<void>((done) => { const t = setTimeout(done, o.heartbeatMs ?? 25_000); stream.onAbort(() => { clearTimeout(t); done() }) })
      if (!stream.aborted) await stream.writeSSE({ event: "heartbeat", data: "{}" })
    }
    off()
  }))
  h.get("/api/activity", (c) => {
    const n = (v: string | undefined) => (v === undefined ? undefined : /^\d{1,15}$/.test(v) ? Number(v) : NaN)
    const now = (o.now ?? Date.now)(), kind = (c.req.query("kind") ?? "all") as ActivityKind
    const since = n(c.req.query("since")) ?? now - 12 * 3_600_000, before = n(c.req.query("before"))
    if (Number.isNaN(since) || Number.isNaN(before) || !(ACTIVITY_KINDS as readonly string[]).includes(kind)) return send(400, "text/plain", "since and before are milliseconds; kind is all, merges, reviews or problems")
    const from = Math.max(since, now - 31 * 86_400_000) // a month back at most
    const page = activityPage(db, { now, since: from, before, kind })
    const summary = before === undefined ? morningSummary(db, { now, since: from, projects: loadProjects(), limits: o.limits?.() as never }) : null
    return send(200, "application/json", redact(JSON.stringify({ ...page, summary })))
  })
  h.get("/api/spend", () => send(200, "application/json", redact(JSON.stringify(spendPage(db, (o.now ?? Date.now)(), o.limits?.() as never, config().billing)))))
  h.get("/api/reviews", (c) => send(200, "application/json", redact(JSON.stringify(reviewsPage(db, (o.now ?? Date.now)(), o.diff)))))
  h.get("/api/ticket/:id{[0-9]{1,9}}", (c) => {
    const t = ticketDetail(db, Number(c.req.param("id")), (o.now ?? Date.now)(), o.diffText)
    return t ? send(200, "application/json", redact(JSON.stringify(t))) : send(404, "text/plain", "no such ticket")
  })
  // Settings, Team and First run. The slow reads (they run commands) are kept for a short while.
  const memo = <T,>(ms: number, f: () => Promise<T>) => { let at = 0, v: Promise<T> | undefined; return () => { if (!v || Date.now() - at > ms) { at = Date.now(); v = f(); v.catch(() => { v = undefined }) } return v } }
  const projectsOf = o.projects ?? loadProjects
  const health = memo(20_000, async (): Promise<HealthView & { schedules: ReturnType<typeof schedulesView> }> => ({ ...(await healthView({ checks: o.checks, apiKeyMode: apiKeyMode() })), schedules: schedulesView(config(), (o.now ?? Date.now)()) }))
  const providers = memo(30_000, () => (o.providers ?? providersView)())
  const json = (v: unknown) => send(200, "application/json", redact(JSON.stringify(v)))
  h.get("/api/config", () => json(configView({ file: o.configFile, repo: o.repoConfig, now: (o.now ?? Date.now)() })))
  h.get("/api/team", () => json(teamView(db, { projects: projectsOf, rolesDir: o.rolesDir, overrideDir: o.overrideDir, now: (o.now ?? Date.now)() })))
  h.get("/api/role/:name{[a-z][a-z0-9-]{0,40}}", (c) => { try { return json({ name: c.req.param("name"), text: roleText(c.req.param("name"), o.rolesDir ?? ROLES_DIR, o.overrideDir) }) } catch (e) { return send(404, "text/plain", (e as Error).message) } })
  h.get("/api/stats/show", async () => json({ text: await statsShow(db) }))
  h.get("/api/health", async () => json(await health()))
  h.get("/api/providers", async () => json(await providers()))
  h.get("/api/welcome", () => json(welcomeView({ projects: projectsOf })))
  h.all("/api/*", () => send(404, "text/plain", "not found"))
  h.get("*", (c) => {
    const pathname = new URL(c.req.url).pathname
    // The built React app, when it exists; otherwise a one-line page.
    const index = `${dist}/index.html`
    if (existsSync(index)) {
      const file = distFile(dist, pathname)
      if (file) return send(200, TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", readFileSync(file), file.endsWith(`${sep}index.html`) ? { "content-security-policy": spaCsp(readFileSync(file, "utf8")) } : {})
      if (!extname(pathname)) { // a client-side route: the app decides what to show
        const html = readFileSync(index, "utf8")
        return send(200, "text/html; charset=utf-8", html, { "content-security-policy": spaCsp(html) })
      }
      return send(404, "text/plain", "not found")
    }
    if (pathname === "/") return send(200, "text/html; charset=utf-8", NOT_BUILT, { "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'" })
    return send(404, "text/plain", "not found")
  })
  return h
}

/** The live plan limits for the snapshot, read at most once a minute (the reader is a child process). */
function cachedLimits(db: DB) {
  let at = 0, v: unknown = null
  return () => {
    if (Date.now() - at > 60_000) {
      at = Date.now()
      try { v = limitsNow(db, readUsage()) } catch { v = null } // readUsage gets no db: this one is read-only
    }
    return v
  }
}

/** Not listening yet: the caller (or a test) calls .listen. Throws when the host is not loopback and no token is configured. */
export function createDashboard(db: DB, o: Omit<Opts, "host"> & { host?: string } = {}): Server {
  const host = o.host ?? "127.0.0.1"
  if ((!LOOPBACK.has(host) || o.tunnel) && !o.token) throw new Error("--host other than loopback needs DASHBOARD_TOKEN in the secrets file (~/.config/dobby/secrets.env)")
  return createAdaptorServer({ fetch: app(db, { ...o, host }).fetch }) as Server
}

/** [command, args] that opens `url` in the default browser. Argument arrays only, never a shell string. */
export function openerFor(platform: string, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]]
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]]
  return ["xdg-open", [url]]
}

/** Whether the dashboard on `port` signs in with `token` (a 302 from /auth; a 401 means it is another install's dashboard). */
export const tokenAccepted = (port: number, token: string, f: typeof fetch = fetch) => f(`http://127.0.0.1:${port}/auth?token=${encodeURIComponent(token)}`, { redirect: "manual", signal: AbortSignal.timeout(2000) }).then((r) => r.status === 302, () => false)

/** `dobby dashboard open`: sign this browser in without anyone seeing the token. Needs the server already running. */
async function openInBrowser(args: string[]) {
  const { port } = parseArgs(args)
  const up = await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)
  const token = readSecrets().DASHBOARD_TOKEN
  if (!up) { console.error(`The dashboard is not running on port ${port}. Start it with \`dobby dashboard\`, then run this again.`); process.exitCode = 1; return }
  if (!token) { console.error("The dashboard has no token yet: restart it (it makes one on start), then run this again."); process.exitCode = 1; return }
  if (!(await tokenAccepted(port, token))) { console.error(`The dashboard on port ${port} does not accept this install's token: it belongs to another Dobby install. Stop it, or start this install's with \`dobby dashboard --port <other port>\`, then run \`dobby dashboard open --port <other port>\`.`); process.exitCode = 1; return }
  const [cmd, argv] = openerFor(process.platform, `http://127.0.0.1:${port}/auth?token=${token}`)
  const p = spawn(cmd, argv, { stdio: "ignore", detached: true })
  p.on("error", () => { console.error(`Could not run ${cmd}. Open http://127.0.0.1:${port}/ yourself; actions stay off until this works.`); process.exitCode = 1 })
  p.unref()
  console.log("Opened the dashboard in your browser; actions are on there.")
}

/** The sign-in URL: https://<host>/auth?token= for a tunnel or Tailscale name (--host), else this machine's port. */
export function linkUrl(token: string, port: number, host?: string) {
  const base = host ? (/^https?:\/\//.test(host) ? host.replace(/\/+$/, "") : `https://${host}`) : `http://127.0.0.1:${port}`
  return `${base}/auth?token=${token}`
}

/** `dobby dashboard link [--host <name>]`: prints the sign-in URL, on request only. The one place the token is printed; it never goes to a log. No QR code: no QR library is a dependency. */
async function printLink(args: string[]) {
  const { port } = parseArgs(args)
  const i = args.indexOf("--host"), host = i < 0 ? undefined : args[i + 1]
  if (i >= 0 && (!host || host.startsWith("--"))) { console.error("--host needs a name, like dobby dashboard link --host my-mac.tailnet.ts.net"); process.exitCode = 1; return }
  const token = readSecrets().DASHBOARD_TOKEN
  if (!token) { console.error("The dashboard has no token yet: start it once (dobby dashboard, or dobby add dashboard), then run this again."); process.exitCode = 1; return }
  console.log(`${linkUrl(token, port, host)}\nOpen it once on the device you want signed in. Anyone with this link can act on your dashboard, so do not share it.`)
}

export function listenError(e: NodeJS.ErrnoException, port: number, tunnel: boolean) {
  if (e.code !== "EADDRINUSE") return e
  return new UserError("port_in_use", `Port ${port} is already in use, most likely by the dashboard job (dobby add dashboard). ${tunnel ? `A tunnel needs its own copy of the dashboard: run \`dobby dashboard --tunnel --port ${port + 1}\` and point the tunnel at ${port + 1}.` : `Use that one (dobby dashboard open), or pick another port with --port.`}`)
}

export async function run(args: string[]) {
  if (args[0] === "open") return openInBrowser(args.slice(1))
  if (args[0] === "link") return printLink(args.slice(1))
  const { port, host, tunnel } = parseArgs(args)
  const db = openReadOnly()
  const server = createDashboard(db, { host, tunnel, token: ensureToken(), limits: cachedLimits(db), mcp: { db: openWritable() } })
  await new Promise<void>((ok, bad) => { server.once("error", (e) => bad(listenError(e, port, tunnel))); server.listen(port, host, ok) })
  const addr = server.address()
  console.log(`dashboard on http://${host.includes(":") ? `[${host}]` : host}:${typeof addr === "object" && addr ? addr.port : port}/ (actions on; run \`dobby dashboard open\` to sign your browser in)`)
}

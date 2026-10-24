// `dobby dashboard`: one page + JSON endpoints over the live DB, opened read-only. GET, plus the one allowlisted POST /api/action (runs `dobby do` in a child; this process never writes).
// Loopback by default. Any other --host needs DASHBOARD_TOKEN (secrets file). The server makes one on first start; `dobby dashboard open` visits /auth?token= so the browser holds it as an HttpOnly cookie. The owner never sees or pastes it.
import { KINDS } from "./pause.ts"
import Database from "better-sqlite3"
import { spawn } from "node:child_process"
import { createHash, timingSafeEqual } from "node:crypto"
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { config, expand } from "./config.ts"
import { extname, resolve, sep } from "node:path"
import type { DB } from "./db.ts"
import { DATA } from "./db.ts"
import { snapshot, ticketDetail } from "./dashboard.ts"
import { ensureToken, readSecrets } from "./telegram.ts"

export const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"])
const PAGE = new URL("./dashboard.html", import.meta.url)
/** Where the built React app lives (a separate React build, optional). Override with DOBBY_DASHBOARD_DIST. When index.html is not there, the single HTML page above is served. */
export const defaultDist = () => process.env.DOBBY_DASHBOARD_DIST || expand(config().paths.dashboardDist)
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
const send = (res: ServerResponse, code: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...extra })
  res.end(body)
}
const cookie = (req: IncomingMessage, name: string) => (req.headers.cookie ?? "").split(/;\s*/).map((c) => c.split("=")).find(([k]) => k === name)?.[1]
const COOKIE = "foreman_dash"
const safeDecode = (c: string) => { try { return decodeURIComponent(c) } catch { return "" } }
/** The caller holds the token: our cookie (the owner's browser) or the x-foreman-token header. Agents on this Mac have neither. */
function authed(req: IncomingMessage, token?: string) {
  if (!token) return false
  const h = req.headers["x-foreman-token"]
  const c = cookie(req, COOKIE)
  return (typeof h === "string" && same(h, token)) || (!!c && same(safeDecode(c), token))
}

/** tunnel: listens on loopback for a local HTTPS tunnel (Tailscale Serve, cloudflared), so every request needs the token, as off loopback. */
type Opts = { host: string; tunnel?: boolean; token?: string; now?: () => number; page?: () => string; dist?: string; exec?: Exec }
/** Runs `dobby do <command...>` and resolves with its output. Injected in tests; real one spawns bin/dobby with an argument array (no shell). */
type Exec = (args: string[]) => Promise<{ ok: boolean; out: string }>

const MAX_BODY = 10 * 1024
const REPO = /^(?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}$)[\w.-]+$/ // owner/name, neither part "." or ".."
const INT = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v < 1e9 ? v : null)
const lastLine = (s: string) => s.trim().split("\n").filter(Boolean).pop()?.slice(0, 300) ?? ""

export const execForeman: Exec = (args) => new Promise((done) => {
  const p = spawn(new URL("../bin/dobby", import.meta.url).pathname, ["do", ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, DOBBY_BY: "the dashboard" }, timeout: 120_000 })
  let out = ""
  p.stdout.on("data", (d) => (out += d))
  p.stderr.on("data", (d) => (out += d))
  p.on("error", (e) => done({ ok: false, out: e.message }))
  p.on("close", (code) => done({ ok: code === 0, out }))
})

/** The allowlist: an action name and its arguments to the one `dobby do` command it means, or an error. Nothing else is ever run. */
export function actionArgs(db: DB, b: Record<string, unknown>): { args: string[] } | { error: string; code?: number } {
  switch (b.action) {
    case "pause": case "resume": { // optional scope: all | a kind | project <name> | ticket <id>; pause may take "for 30m|2h|1d"
      const kind = typeof b.kind === "string" ? b.kind : ""
      const extra: string[] = []
      if (kind === "project") { if (typeof b.project !== "string" || !/^[\w-]+$/.test(b.project)) return { error: "project needs a name" }; extra.push("project", b.project) }
      else if (kind === "ticket") { const id = INT(b.ticket); if (!id) return { error: "ticket needs a number" }; extra.push("ticket", String(id)) }
      else if (kind) { if (kind !== "all" && !(KINDS as readonly string[]).includes(kind)) return { error: `unknown pause kind: ${kind}` }; extra.push(kind) }
      if (b.action === "pause" && b.for !== undefined) { if (typeof b.for !== "string" || !/^\d{1,3}[mhd]$/.test(b.for)) return { error: "for must look like 30m, 2h or 1d" }; extra.push("for", b.for) }
      return { args: [b.action, ...extra] }
    }
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
    default: return { error: "that action is not allowed from the dashboard" }
  }
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return null
  let n = 0
  const chunks: Buffer[] = []
  for await (const c of req) { n += (c as Buffer).length; if (n > MAX_BODY) return null; chunks.push(c as Buffer) }
  return Buffer.concat(chunks).toString("utf8")
}

/** POST /api/action. Every guard applies on loopback too: token (cookie or header), same-origin, JSON, small body. */
async function postAction(db: DB, o: Opts, req: IncomingMessage, res: ServerResponse) {
  const json = (code: number, message: string) => send(res, code, "application/json", JSON.stringify({ ok: code === 200, message }))
  if (!o.token) return json(403, "Actions are off: restart the dashboard so it can make its token, then run `dobby dashboard open`.")
  if (!authed(req, o.token)) return json(401, "This browser is not signed in: run `dobby dashboard open`.")
  const origin = req.headers.origin
  let originHost = ""
  try { originHost = typeof origin === "string" ? new URL(origin).host : "" } catch {}
  if (!originHost || originHost !== req.headers.host) return json(403, "Cross-site request refused.")
  if (!/^application\/json\s*(;|$)/i.test(req.headers["content-type"] ?? "")) return json(415, "Send application/json.")
  const raw = await readBody(req)
  if (raw === null) return json(413, "Request too large.")
  let body: unknown
  try { body = JSON.parse(raw) } catch { return json(400, "Body is not valid JSON.") }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, "Body must be a JSON object.")
  const a = actionArgs(db, body as Record<string, unknown>)
  if ("error" in a) return json(a.code ?? 400, a.error)
  const r = await (o.exec ?? execForeman)(a.args)
  json(r.ok ? 200 : 500, lastLine(r.out) || (r.ok ? "Done." : "That did not work."))
}

export function handler(db: DB, o: Opts) {
  const loopback = LOOPBACK.has(o.host) && !o.tunnel // behind a tunnel, a loopback peer can be anyone on the internet
  const page = o.page ?? (() => readFileSync(PAGE, "utf8"))
  const dist = o.dist ?? defaultDist()
  return (req: IncomingMessage, res: ServerResponse) => {
    const post = req.method === "POST" && new URL(req.url ?? "/", "http://dashboard.local").pathname === "/api/action"
    if (req.method !== "GET" && req.method !== "HEAD" && !post) return send(res, 405, "text/plain", "GET only (the one write is POST /api/action)", { allow: "GET, HEAD, POST" })
    const url = new URL(req.url ?? "/", "http://dashboard.local")
    // A web page on another site must not be able to read a loopback-only dashboard (DNS rebinding): the Host header has to be local.
    if (loopback && !LOOPBACK.has((req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, ""))) return send(res, 403, "text/plain", "forbidden host")
    // /auth?token= (also ?token= on any path off loopback, for old phone links): right token sets the HttpOnly cookie and redirects to the clean URL; wrong is a plain 401.
    const given = url.searchParams.get("token")
    if (url.pathname === "/auth" || (!loopback && given !== null)) {
      if (!o.token || !same(given ?? "", o.token)) return send(res, 401, "text/plain", "wrong token: run `dobby dashboard open`")
      const secure = req.headers["x-forwarded-proto"] === "https" || (req.socket as { encrypted?: boolean }).encrypted ? "; Secure" : ""
      const dest = url.pathname === "/auth" ? "/" : url.pathname
      return send(res, 302, "text/plain", "", { location: dest, "set-cookie": `${COOKIE}=${o.token}; HttpOnly; SameSite=Strict; Path=/${secure}` })
    }
    // Off loopback every request needs the token. On loopback the page loads without it, but its data does not: any local process
    // (a sandboxed builder may reach localhost) could read tickets and notes (audit 24 Oct L1). Writes need it too, see postAction.
    const data = url.pathname.startsWith("/api/") && url.pathname !== "/api/session"
    if ((!loopback || (data && o.token)) && !authed(req, o.token)) return send(res, 401, "text/plain", "token required: run `dobby dashboard open`")
    const extra: Record<string, string> = {}
    try {
      if (post) return void postAction(db, o, req, res).catch((e) => send(res, 500, "text/plain", `dashboard error: ${(e as Error).message}`))
      if (url.pathname === "/api/session") return send(res, 200, "application/json", JSON.stringify({ canAct: authed(req, o.token) }))
      if (url.pathname === "/api/snapshot") return send(res, 200, "application/json", JSON.stringify(snapshot(db, (o.now ?? Date.now)(), url.searchParams.get("days") === "30" ? 30 : 7)), extra)
      const tid = url.pathname.match(/^\/api\/ticket\/(\d{1,9})$/)
      if (tid) {
        const t = ticketDetail(db, Number(tid[1]), (o.now ?? Date.now)())
        return t ? send(res, 200, "application/json", JSON.stringify(t), extra) : send(res, 404, "text/plain", "no such ticket", extra)
      }
      if (url.pathname.startsWith("/api/")) return send(res, 404, "text/plain", "not found", extra)
      // The built React app, when it exists; otherwise the single HTML page.
      const index = `${dist}/index.html`
      if (existsSync(index)) {
        const file = distFile(dist, url.pathname)
        if (file) return send(res, 200, TYPES[extname(file).toLowerCase()] ?? "application/octet-stream", readFileSync(file), file.endsWith(`${sep}index.html`) ? { ...extra, "content-security-policy": spaCsp(readFileSync(file, "utf8")) } : extra)
        if (!extname(url.pathname)) { // a client-side route: the app decides what to show
          const html = readFileSync(index, "utf8")
          return send(res, 200, "text/html; charset=utf-8", html, { ...extra, "content-security-policy": spaCsp(html) })
        }
        return send(res, 404, "text/plain", "not found", extra)
      }
      if (url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", page(), { ...extra, "content-security-policy": "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" })
      send(res, 404, "text/plain", "not found", extra)
    } catch (e) {
      send(res, 500, "text/plain", `dashboard error: ${(e as Error).message}`)
    }
  }
}

/** Not listening yet: the caller (or a test) calls .listen. Throws when the host is not loopback and no token is configured. */
export function createDashboard(db: DB, o: Omit<Opts, "host"> & { host?: string } = {}): Server {
  const host = o.host ?? "127.0.0.1"
  if ((!LOOPBACK.has(host) || o.tunnel) && !o.token) throw new Error("--host other than loopback needs DASHBOARD_TOKEN in the secrets file (~/.config/dobby/secrets.env)")
  return createServer(handler(db, { ...o, host }))
}

/** [command, args] that opens `url` in the default browser. Argument arrays only, never a shell string. */
export function openerFor(platform: string, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]]
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]]
  return ["xdg-open", [url]]
}

/** `dobby dashboard open`: sign this browser in without anyone seeing the token. Needs the server already running. */
async function openInBrowser(args: string[]) {
  const { port } = parseArgs(args)
  const up = await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false)
  const token = readSecrets().DASHBOARD_TOKEN
  if (!up) { console.error(`The dashboard is not running on port ${port}. Start it with \`dobby dashboard\`, then run this again.`); process.exitCode = 1; return }
  if (!token) { console.error("The dashboard has no token yet: restart it (it makes one on start), then run this again."); process.exitCode = 1; return }
  const [cmd, argv] = openerFor(process.platform, `http://127.0.0.1:${port}/auth?token=${token}`)
  const p = spawn(cmd, argv, { stdio: "ignore", detached: true })
  p.on("error", () => { console.error(`Could not run ${cmd}. Open http://127.0.0.1:${port}/ yourself; actions stay off until this works.`); process.exitCode = 1 })
  p.unref()
  console.log("Opened the dashboard in your browser; actions are on there.")
}

export async function run(args: string[]) {
  if (args[0] === "open") return openInBrowser(args.slice(1))
  const { port, host, tunnel } = parseArgs(args)
  const server = createDashboard(openReadOnly(), { host, tunnel, token: ensureToken() })
  await new Promise<void>((ok, bad) => { server.once("error", bad); server.listen(port, host, ok) })
  const addr = server.address()
  console.log(`dashboard on http://${host.includes(":") ? `[${host}]` : host}:${typeof addr === "object" && addr ? addr.port : port}/ (actions on; run \`dobby dashboard open\` to sign your browser in)`)
}

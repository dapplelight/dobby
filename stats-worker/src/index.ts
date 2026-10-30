// Dobby's opt-in stats collector (Hono on a Cloudflare Worker + D1). It stores what src/stats-schema.ts allows and nothing else:
// no IP, no headers, no free text. Cloudflare sees the IP on the request; this code never reads or writes it.
// POST /v1/events (the CLI), GET /v1/report (the owner, bearer REPORT_TOKEN), and a purge of rows older than 180 days on the first request each day (no cron: the free plan caps cron triggers per account).
// No CORS: only the CLI calls it. D1 is typed by hand below so the repo needs no Workers type package.
import { Hono } from "hono"
import { Event, MAX_BODY, MAX_CRASHES_PER_DAY, MAX_EVENTS_PER_INSTALL_PER_DAY, type StatsEvent } from "../../src/stats-schema.ts"

type Stmt = { bind(...v: unknown[]): Stmt; run(): Promise<unknown>; all<T = Record<string, unknown>>(): Promise<{ results: T[] }>; first<T = Record<string, unknown>>(): Promise<T | null> }
export type D1 = { prepare(sql: string): Stmt; batch(s: Stmt[]): Promise<unknown[]> }
export type Env = { DB: D1; REPORT_TOKEN?: string }

export const MAX_EVENTS_PER_REQUEST = 50
export const KEEP_DAYS = 180
const DAY = 86_400_000
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Constant-time string compare. */
function same(a: string, b: string): boolean {
  let d = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return d === 0
}

export function createApp(now: () => number = Date.now) {
  const app = new Hono<{ Bindings: Env }>()

  app.post("/v1/events", async (c) => {
    const text = await c.req.text()
    if (text.length > MAX_BODY || new TextEncoder().encode(text).length > MAX_BODY) return c.json({ error: "too large" }, 413)
    let body: unknown
    try { body = JSON.parse(text) } catch { return c.json({ error: "not JSON" }, 400) }
    if (!Array.isArray(body) || !body.length) return c.json({ error: "expected a non-empty array" }, 400)
    if (body.length > MAX_EVENTS_PER_REQUEST) return c.json({ error: `at most ${MAX_EVENTS_PER_REQUEST} events a request` }, 400)
    const events: StatsEvent[] = []
    for (const x of body) {
      const r = Event.safeParse(x)
      if (!r.success) return c.json({ error: "invalid event" }, 400)
      events.push(r.data)
    }
    const today = dayOf(now())
    if (events.some((e) => e.day < dayOf(now() - 2 * DAY) || e.day > dayOf(now() + DAY))) return c.json({ error: "day out of range" }, 400)
    if (new Set(events.map((e) => e.install)).size !== 1) return c.json({ error: "one install per request" }, 400)
    const install = events[0].install, crashes = events.filter((e) => e.name === "crash").length
    const db = c.env.DB
    const q = await db.prepare("SELECT n, crashes FROM quota WHERE day = ? AND install = ?").bind(today, install).first<{ n: number; crashes: number }>()
    if ((q?.n ?? 0) + events.length > MAX_EVENTS_PER_INSTALL_PER_DAY || (q?.crashes ?? 0) + crashes > MAX_CRASHES_PER_DAY) return c.json({ error: "rate limit" }, 429)
    const stmts: Stmt[] = [db.prepare("INSERT INTO quota (day, install, n, crashes) VALUES (?, ?, ?, ?) ON CONFLICT (day, install) DO UPDATE SET n = n + excluded.n, crashes = crashes + excluded.crashes").bind(today, install, events.length, crashes)]
    for (const e of events) {
      if (e.name === "crash") {
        const p = (e as { props: { kind: string; where: string[]; command: string; code?: string } }).props
        stmts.push(db.prepare('INSERT INTO crashes (day, install, kind, "where", command, code, v, os) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(e.day, e.install, p.kind, p.where.join(" "), p.command, p.code ?? null, e.v, e.os))
      }
      else stmts.push(db.prepare("INSERT OR IGNORE INTO events (day, install, name, props) VALUES (?, ?, ?, ?)").bind(e.day, e.install, e.name, JSON.stringify("props" in e ? e.props : {})))
    }
    await db.batch(stmts)
    return c.json({ ok: true, stored: events.length }, 202)
  })

  app.get("/v1/report", async (c) => {
    const want = c.env.REPORT_TOKEN, got = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1]
    if (!want || !got || !same(got, want)) return c.json({ error: "unauthorized" }, 401)
    const date = /^\d{4}-\d{2}-\d{2}$/
    const from = c.req.query("from") ?? dayOf(now() - 30 * DAY), to = c.req.query("to") ?? dayOf(now())
    if (!date.test(from) || !date.test(to)) return c.json({ error: "from and to are YYYY-MM-DD" }, 400)
    const db = c.env.DB, all = async <T>(sql: string, ...v: unknown[]) => (await db.prepare(sql).bind(...v).all<T>()).results
    const [funnel, steps, daily, weekly, heartbeats, crashes] = await Promise.all([
      all("SELECT name, COUNT(DISTINCT install) AS installs FROM events WHERE name NOT IN ('heartbeat','setup_step') AND day BETWEEN ? AND ? GROUP BY name ORDER BY installs DESC", from, to),
      all("SELECT json_extract(props,'$.step') AS step, json_extract(props,'$.ok') AS ok, json_extract(props,'$.reason') AS reason, COUNT(DISTINCT install) AS installs FROM events WHERE name = 'setup_step' AND day BETWEEN ? AND ? GROUP BY step, ok, reason ORDER BY step, ok DESC", from, to),
      all("SELECT day, COUNT(DISTINCT install) AS installs FROM events WHERE name = 'heartbeat' AND day BETWEEN ? AND ? GROUP BY day ORDER BY day", from, to),
      all("SELECT strftime('%Y-%W', day) AS week, COUNT(DISTINCT install) AS installs FROM events WHERE name = 'heartbeat' AND day BETWEEN ? AND ? GROUP BY week ORDER BY week", from, to),
      all<{ props: string }>("SELECT props FROM events WHERE name = 'heartbeat' AND day BETWEEN ? AND ?", from, to),
      all("SELECT kind, \"where\" AS place, COUNT(*) AS crashes, COUNT(DISTINCT install) AS installs, group_concat(DISTINCT v) AS versions FROM crashes WHERE day BETWEEN ? AND ? GROUP BY kind, \"where\" ORDER BY crashes DESC LIMIT 20", from, to),
    ])
    const used: Record<string, number> = {}
    let n = 0
    for (const h of heartbeats) {
      try { const f = (JSON.parse(h.props) as { features?: Record<string, boolean> }).features ?? {}; n++; for (const [k, v] of Object.entries(f)) used[k] = (used[k] ?? 0) + (v ? 1 : 0) } catch {}
    }
    const featureShare = Object.fromEntries(Object.entries(used).map(([k, v]) => [k, n ? Math.round((100 * v) / n) : 0]))
    return c.json({ from, to, funnel, setupSteps: steps, activeInstallsPerDay: daily, activeInstallsPerWeek: weekly, featureSharePercent: featureShare, heartbeats: n, topCrashes: crashes })
  })

  return app
}

/** Rows older than 180 days. */
export async function purge(db: D1, ms: number = Date.now()): Promise<void> {
  const cut = dayOf(ms - KEEP_DAYS * DAY)
  await db.batch(["events", "crashes", "quota"].map((t) => db.prepare(`DELETE FROM ${t} WHERE day < ?`).bind(cut)))
}

const app = createApp()
let purgedDay = ""
/** Purge at most once a day per isolate, after the response, so a request never waits on it. */
export function purgeOnce(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, ms: number = Date.now()): boolean {
  const today = dayOf(ms)
  if (purgedDay === today) return false
  purgedDay = today
  ctx.waitUntil(purge(env.DB, ms).catch(() => { purgedDay = "" }))
  return true
}
export default {
  fetch: (req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) => { purgeOnce(env, ctx); return app.fetch(req, env, ctx as never) },
}

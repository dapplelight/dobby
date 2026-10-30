// The stats collector (stats-worker/): strict validation, limits, no IP stored, the token-gated report, the 180-day purge.
// D1 is replaced by an in-memory SQLite (better-sqlite3) running the real migration; no network, no Cloudflare.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import Database from "better-sqlite3"
import { createApp, purge, purgeOnce, type D1, type Env } from "../stats-worker/src/index.ts"

const MIGRATION = readFileSync(new URL("../stats-worker/migrations/0001_init.sql", import.meta.url), "utf8")
const NOW = Date.parse("2026-10-26T10:00:00Z")
const ID = "6f1c2d3e-0000-4000-8000-000000000000"

function d1() {
  const sql = new Database(":memory:")
  sql.exec(MIGRATION)
  const stmt = (q: string, args: unknown[] = []): ReturnType<D1["prepare"]> => ({
    bind: (...v: unknown[]) => stmt(q, v),
    run: async () => sql.prepare(q).run(...args),
    all: async <T,>() => ({ results: sql.prepare(q).all(...args) as T[] }),
    first: async <T,>() => (sql.prepare(q).get(...args) as T | undefined) ?? null,
  }) as never
  const db: D1 = { prepare: (q) => stmt(q), batch: async (ss) => { const run = sql.transaction(() => ss.map((s) => (s as unknown as { run(): unknown }).run())); return run() as unknown[] } }
  return { db, sql }
}
const setup = (token = "report-token") => { const x = d1(); const app = createApp(() => NOW); const env: Env = { DB: x.db, REPORT_TOKEN: token }; return { ...x, env, app } }
const ev = (name: string, props?: object, over: object = {}) => ({ install: ID, v: "0.1.0", os: "linux", node: 24, day: "2026-10-26", name, ...(props ? { props } : {}), ...over })
const post = (s: ReturnType<typeof setup>, body: unknown, headers: Record<string, string> = {}) =>
  s.app.request("/v1/events", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }, s.env)
const HB = { plan: "pro", projects: "2-3", shipped: "1-2", sent_back: "0", safety: "balanced", review_auto: "off", merges_paused: false, chat: "terminal", week_cap: 90, features: { dashboard: true, mcp_stdio: false, mcp_http: false, discord_buttons: false, brief_sent: false, deploy_tap: false, role_override: false, config_set: true }, roles: { builder: "3-5" } }
const CRASH = { kind: "TypeError", where: ["src/cli.ts:12", "src/lib.ts:3"], command: "tick" }

test("a valid batch is stored; a repeated funnel event is not stored twice", async () => {
  const s = setup()
  const r = await post(s, [ev("setup_started"), ev("setup_step", { step: "checks", ok: true }), ev("heartbeat", HB), ev("crash", CRASH)])
  assert.equal(r.status, 202)
  assert.equal((s.sql.prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n, 3)
  assert.deepEqual(s.sql.prepare('SELECT kind, "where", command, v, os FROM crashes').get(), { kind: "TypeError", where: "src/cli.ts:12 src/lib.ts:3", command: "tick", v: "0.1.0", os: "linux" })
  await post(s, [ev("setup_started")])
  assert.equal((s.sql.prepare("SELECT COUNT(*) n FROM events WHERE name='setup_started'").get() as { n: number }).n, 1)
})

test("unknown fields, unknown values, a missing install, bad JSON, empty and oversize batches are refused", async () => {
  const s = setup()
  const bad = [
    [ev("setup_done", undefined, { extra: 1 })], [ev("setup_done", undefined, { os: "win32" })], [ev("nope")], [ev("setup_step", { step: "repos", ok: true, title: "x" })],
    [ev("heartbeat", { ...HB, repo: "acme/ledger" })], [ev("crash", { ...CRASH, message: "boom" })], [ev("crash", { ...CRASH, where: ["/Users/me/x.ts:1"] })],
    [{ ...ev("setup_done"), install: undefined }], [ev("setup_done", undefined, { install: "not-a-uuid" })], [ev("setup_done", undefined, { day: "2020-01-01" })],
    [], {}, "not json",
    [ev("setup_done"), ev("setup_done", undefined, { install: "7f1c2d3e-0000-4000-8000-000000000000" })],
  ]
  for (const b of bad) assert.equal((await post(s, b)).status, 400, JSON.stringify(b).slice(0, 80))
  assert.equal((await post(s, Array.from({ length: 51 }, () => ev("setup_done")))).status, 400, "too many in one request")
  assert.equal((await post(s, JSON.stringify([ev("setup_done")]) + " ".repeat(16 * 1024))).status, 413)
  assert.equal((s.sql.prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n, 0, "a refused batch stores none of it")
})

test("200 events a day and 10 crashes a day per install", async () => {
  const s = setup()
  const steps = ["checks", "repos", "chat", "tools", "settings", "jobs", "first_ticket"] as const
  for (let i = 0; i < 4; i++) assert.equal((await post(s, Array.from({ length: 50 }, (_, j) => ev("setup_step", { step: steps[j % 7], ok: j % 2 === 0 }, { node: 10 + i * 10 + (j % 5) }))))?.status, 202)
  assert.equal((await post(s, [ev("setup_done")])).status, 429, "the 201st event of the day")
  const c = setup()
  for (let i = 0; i < 10; i++) assert.equal((await post(c, [ev("crash", CRASH)])).status, 202)
  assert.equal((await post(c, [ev("crash", CRASH)])).status, 429)
  assert.equal((c.sql.prepare("SELECT COUNT(*) n FROM crashes").get() as { n: number }).n, 10)
})

test("no IP and no header is stored: every row of every table is free of them", async () => {
  const s = setup()
  const headers = { "cf-connecting-ip": "203.0.113.77", "x-forwarded-for": "198.51.100.9", "user-agent": "curl/9 secret-agent", "x-real-ip": "192.0.2.5" }
  assert.equal((await post(s, [ev("setup_started"), ev("heartbeat", HB), ev("crash", CRASH)], headers)).status, 202)
  const dump = JSON.stringify(["events", "crashes", "quota"].map((t) => s.sql.prepare(`SELECT * FROM ${t}`).all()))
  for (const v of Object.values(headers)) assert.ok(!dump.includes(v), v)
  const cols = ["events", "crashes", "quota"].flatMap((t) => (s.sql.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name))
  assert.ok(!cols.some((c) => /ip|addr|agent|header/i.test(c)), cols.join())
})

test("no CORS: no allow-origin header, and a preflight is not answered", async () => {
  const s = setup()
  const r = await post(s, [ev("setup_done")], { origin: "https://evil.example" })
  assert.equal(r.headers.get("access-control-allow-origin"), null)
  assert.equal((await s.app.request("/v1/events", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } }, s.env)).status, 404)
})

test("the report needs the bearer token, and fails closed when none is set", async () => {
  const s = setup()
  const get = (headers: Record<string, string> = {}, env = s.env, q = "") => s.app.request(`/v1/report${q}`, { headers }, env)
  assert.equal((await get()).status, 401)
  assert.equal((await get({ authorization: "Bearer wrong" })).status, 401)
  assert.equal((await get({ authorization: "report-token" })).status, 401)
  assert.equal((await get({ authorization: "Bearer report-token" }, { DB: s.db })).status, 401, "no REPORT_TOKEN secret: closed, even for an empty bearer")
  assert.equal((await get({ authorization: "Bearer " }, { DB: s.db })).status, 401)
  assert.equal((await get({ authorization: "Bearer report-token" }, s.env, "?from=bad")).status, 400)
  assert.equal((await get({ authorization: "Bearer report-token" })).status, 200)
})

test("the report: funnel counts, active installs, feature share, top crashes with versions", async () => {
  const s = setup()
  const other = "7f1c2d3e-0000-4000-8000-000000000000"
  await post(s, [ev("setup_started"), ev("setup_step", { step: "checks", ok: true }), ev("setup_step", { step: "repos", ok: false, reason: "tests_failed" }), ev("first_ticket"), ev("heartbeat", HB), ev("crash", CRASH)])
  await post(s, [ev("setup_started", undefined, { install: other }), ev("setup_step", { step: "checks", ok: false, reason: "gh_signed_out" }, { install: other }), ev("heartbeat", { ...HB, features: { ...HB.features, dashboard: false } }, { install: other }), ev("crash", CRASH, { install: other, v: "0.2.0" })])
  const r = await (await s.app.request("/v1/report?from=2026-10-01&to=2026-10-31", { headers: { authorization: "Bearer report-token" } }, s.env)).json() as Record<string, any>
  assert.deepEqual(r.funnel.find((f: any) => f.name === "setup_started"), { name: "setup_started", installs: 2 })
  assert.deepEqual(r.funnel.find((f: any) => f.name === "first_ticket"), { name: "first_ticket", installs: 1 })
  assert.ok(r.setupSteps.some((x: any) => x.step === "checks" && x.ok === 0 && x.reason === "gh_signed_out" && x.installs === 1))
  assert.deepEqual(r.activeInstallsPerDay, [{ day: "2026-10-26", installs: 2 }])
  assert.equal(r.activeInstallsPerWeek[0].installs, 2)
  assert.equal(r.featureSharePercent.dashboard, 50); assert.equal(r.featureSharePercent.config_set, 100); assert.equal(r.heartbeats, 2)
  assert.equal(r.topCrashes[0].kind, "TypeError"); assert.equal(r.topCrashes[0].crashes, 2); assert.equal(r.topCrashes[0].installs, 2)
  assert.deepEqual(String(r.topCrashes[0].versions).split(",").sort(), ["0.1.0", "0.2.0"])
})

test("the daily purge deletes rows older than 180 days and keeps the rest", async () => {
  const s = setup()
  const put = (day: string) => {
    s.sql.prepare("INSERT INTO events (day, install, name, props) VALUES (?, ?, 'heartbeat', '{}')").run(day, ID)
    s.sql.prepare('INSERT INTO crashes (day, install, kind, "where", command, v, os) VALUES (?, ?, \'E\', \'a.ts:1\', \'tick\', \'0.1.0\', \'linux\')').run(day, ID)
    s.sql.prepare("INSERT INTO quota (day, install, n) VALUES (?, ?, 1)").run(day, ID)
  }
  put("2026-04-01"); put("2026-04-28"); put("2026-04-29"); put("2026-10-25")
  await purge(s.db, NOW)
  for (const t of ["events", "crashes", "quota"]) assert.deepEqual((s.sql.prepare(`SELECT day FROM ${t} ORDER BY day`).all() as { day: string }[]).map((r) => r.day), ["2026-04-29", "2026-10-25"], t)
})

test("purgeOnce runs the purge once per day, then again the next day", async () => {
  const s = setup(), waits: Promise<unknown>[] = [], ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p) } }
  s.sql.prepare("INSERT INTO events (day, install, name, props) VALUES (?, ?, 'heartbeat', '{}')").run("2026-01-01", ID)
  assert.equal(purgeOnce({ DB: s.db }, ctx, NOW), true)
  assert.equal(purgeOnce({ DB: s.db }, ctx, NOW + 1000), false)
  await Promise.all(waits)
  assert.equal((s.sql.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n, 0)
  assert.equal(purgeOnce({ DB: s.db }, ctx, NOW + 86_400_000), true)
})

test("the migration can run twice", () => {
  const s = setup()
  s.sql.exec(MIGRATION)
  assert.ok(s.sql.prepare("SELECT 1 FROM sqlite_master WHERE name='events_once'").get())
})

test("the saved queries run against the schema", () => {
  const s = setup()
  for (const f of ["funnel", "retention-by-week", "crashes-by-version"]) {
    for (const q of readFileSync(new URL(`../stats-worker/queries/${f}.sql`, import.meta.url), "utf8").split(/;\s*\n/).map((x) => x.replace(/^(--.*\n)+/, "").trim()).filter(Boolean)) s.sql.prepare(q).all()
  }
})

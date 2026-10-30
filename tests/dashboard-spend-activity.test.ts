// Spend (GET /api/spend) and Activity (GET /api/activity, the live run/review events, the morning summary). Offline, in-memory DB, made-up projects.
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-spend-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/none.txt`
process.env.DOBBY_CONFIG = `${dir}/config.json`
process.env.SHOTS_FAKE_API_KEY = "sk-live-0123456789abcdef" // looks like a secret to redact(): its value must never leave the server
const { open } = await import("../src/db.ts")
const S = await import("../src/dashboard-server.ts")
const { ensure } = await import("../src/usage.ts")
const A = await import("../src/activity.ts")
const SP = await import("../src/spend.ts")
const { ActivityPage, SpendPage, ActivityEvent, EVENT_SCHEMAS } = await import("../src/api-schema.ts")
const { firstLoad, overBudget } = await import("../scripts/check-bundle.ts")
const cos = await import("../src/graphs/cos.ts")
const { buildBrief, briefMarkdown } = await import("../src/brief.ts")

const HOUR = 3_600_000, DAY = 24 * HOUR, WEEK = 7 * DAY
const NOW = Date.parse("2026-10-27T10:00:00Z")
const RESET = NOW + 2 * DAY
const iso = (ms: number) => new Date(ms).toISOString()
const LIMITS = { five: { used: 31, resetsAt: NOW + 3 * HOUR }, week: { used: 58, cap: 95, resetsAt: RESET }, ratio: 0.1, state: "running", resumesAt: null, line: "Running" }
const TOKEN = "t".repeat(24)

const run = (db: any, project: string, kind: string, ticket: number | null, cost: number, ago: number, ok = 1, reason: string | null = null) =>
  db.prepare("INSERT INTO runs (at,project,kind,ticket,ok,reason,cost_usd) VALUES (?,?,?,?,?,?,?)").run(iso(NOW - ago), project, kind, ticket, ok, reason, cost)
const ticket = (db: any, id: number, project: string, title: string, status: string, ago: number, note: string | null = null) =>
  db.prepare("INSERT INTO tickets (id,project,title,status,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, project, title, status, note, iso(NOW - ago - DAY), iso(NOW - ago))
const review = (db: any, repo: string, pr: number, sha: string, verdict: string, ago: number) =>
  db.prepare("INSERT INTO reviews (repo,pr,sha,choice,by,verdict,cost,at) VALUES (?,?,?,'sonnet','rule',?,0.2,?)").run(repo, pr, sha, verdict, iso(NOW - ago))
const tick = (db: any, at: number, week: number, weekReset: number) => db.prepare("INSERT OR REPLACE INTO usage_ticks VALUES (?,?,?,?,?)").run(at, 20, week, at + HOUR, weekReset)

async function up(db: any, opts: Parameters<typeof S.createDashboard>[1] = {}) {
  const server = S.createDashboard(db, { token: TOKEN, now: () => NOW, limits: () => LIMITS, dist: `${dir}/no-dist`, pollMs: 30, heartbeatMs: 5000, ...opts })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const get = (path: string, token: string | false = TOKEN) => fetch(base + path, { headers: token === false ? {} : { "x-foreman-token": token } })
  return { server, base, get, close: () => { server.closeAllConnections(); server.close() } }
}

/** Two projects, one planning run, a review per ticket: the week the design shows. */
function week() {
  const db = open(":memory:")
  ensure(db)
  ticket(db, 1, "tally", "CSV export", "shipped", 5 * HOUR, "https://github.com/acme/tally/pull/11")
  ticket(db, 2, "tally", "Dark mode", "shipped", 10 * HOUR, "https://github.com/acme/tally/pull/12")
  ticket(db, 3, "shopfront", "Gift cards", "shipped", 8 * HOUR, "https://github.com/acme/shopfront/pull/21")
  run(db, "tally", "build", 1, 4, 20 * HOUR); run(db, "tally", "build", 2, 3, 30 * HOUR); run(db, "tally", "check", 1, 1, 19 * HOUR)
  run(db, "shopfront", "build", 3, 2.5, 25 * HOUR); run(db, "shopfront", "review", null, 1, 24 * HOUR); run(db, "tally", "lead", null, 0.5, 40 * HOUR)
  run(db, "tally", "build", 1, 5, 9 * DAY) // before this week's reset window: not counted
  review(db, "acme/tally", 11, "a", "pass", 6 * HOUR); review(db, "acme/shopfront", 21, "b", "fail", 9 * HOUR)
  return db
}

// ---- Spend ----
test("spend: project and role shares each add up to the used percent; merged counts and the share per merged PR", () => {
  const db = week()
  const s = SP.spendPage(db, NOW, LIMITS)
  SpendPage.parse(JSON.parse(JSON.stringify(s)))
  assert.equal(s.used, 58)
  assert.equal(s.projects.reduce((a, r) => a + r.pct, 0), 58)
  assert.equal(s.roles.reduce((a, r) => a + r.pct, 0), 58)
  assert.deepEqual(s.projects.map((r) => r.name), ["tally", "shopfront", "Planning"]) // biggest first; planning is its own row
  assert.equal(s.top, "tally")
  const tally = s.projects[0]
  assert.equal(tally.merged, 2); assert.equal(tally.perMerged, Math.round(tally.pct / 2)); assert.equal(tally.countWord, "2 merged")
  assert.deepEqual(s.roles.map((r) => r.name), ["Builders", "Reviewer", "Tester", "Lead and PM"])
  assert.equal(s.roles[0].countWord, "3 tickets"); assert.equal(s.roles[1].countWord, "2 reviews"); assert.equal(s.roles[2].countWord, "1 run")
  assert.equal(SP.shares([1, 1, 1], 10).reduce((a, b) => a + b, 0), 10, "largest remainder keeps the total exact")
  assert.deepEqual(SP.shares([0, 0], 5), [0, 0])
})

test("spend: past weeks show where each landed from stored readings; a week with none says no reading, not 0; unused plan sums the last 4", () => {
  const db = week()
  // weeks 1, 2 and 4 back have readings (landing at 94, 91, 88); week 3 back has none
  for (const [i, landed] of [[1, 94], [2, 91], [4, 88]] as const) {
    const reset = RESET - i * WEEK
    tick(db, reset - 5 * DAY, Math.round(landed / 2), reset + 4000) // a few seconds off the exact reset: still the same week
    tick(db, reset - 1 * DAY, landed, reset + 4000)
  }
  const s = SP.spendPage(db, NOW, LIMITS)
  assert.deepEqual(s.past.slice(0, 5).map((p) => p.landed), [94, 91, null, 88, null])
  assert.equal(s.past.length, 8)
  assert.ok(s.past[0].series.length >= 2)
  assert.deepEqual(s.unused, { pct: 1 + 4 + 7, weeks: 3, usd: null }) // (95-94) + (95-91) + (95-88): the week with no reading is left out, not counted as 0
})

test("spend: on an API key the page shows dollars against the daily and weekly budget, not percent of the plan", () => {
  const db = week()
  const s = SP.spendPage(db, NOW, null, { mode: "apiKey", dailyUsd: 20, weeklyUsd: 100 })
  SpendPage.parse(JSON.parse(JSON.stringify(s)))
  assert.equal(s.mode, "apiKey")
  assert.equal(s.api!.weeklyUsd, 100); assert.equal(s.api!.dailyUsd, 20)
  assert.equal(s.api!.spentUsd, 12) // the 9-day-old run is outside the last 7 days
  assert.ok(s.api!.todayUsd! >= 5)
  assert.equal(s.projects[0].name, "tally"); assert.equal(s.projects[0].usd, 8); assert.equal(s.projects[0].pct, 8) // 8 of the 100-dollar week
  assert.equal(s.projects.reduce((a, r) => a + r.usd, 0), 12)
  assert.equal(s.past[0].usd, 5) // the 9-day-old run is last week's
  assert.equal(s.unused!.usd, 95, "dollars unused against the weekly budget; weeks before the first run are not counted")
  assert.equal(s.past[3].landed, null, "a week before the first run has no reading")
})

test("spend: a fresh API-key install has no unused budget to show, and the weeks before the first run read as no reading", () => {
  const db = open(":memory:")
  ensure(db)
  assert.equal(SP.spendPage(db, NOW, null, { mode: "apiKey", dailyUsd: 10 }).unused!.weeks, 0)
  run(db, "tally", "build", 1, 12, HOUR) // first run an hour ago
  const s = SP.spendPage(db, NOW, null, { mode: "apiKey", dailyUsd: 10 })
  assert.equal(s.unused!.weeks, 0)
  assert.equal(s.unused!.usd, 0, "not the $280 of four empty weeks")
})

// ---- Activity ----
function busy() {
  const db = week()
  ticket(db, 4, "tally", "Search by SKU", "running", HOUR)
  run(db, "tally", "build", 4, 1, 3 * HOUR, 0, "tests failed") // failed, then ran again: one retry
  run(db, "tally", "build", 4, 1, 2 * HOUR)
  ticket(db, 5, "shopfront", "Wishlist", "failed", 4 * HOUR)
  return db
}

test("/api/activity: events are {t, role, kind, text, ref, result}, newest first, valid against the schema, with the counts and the since-headline", async () => {
  const { get, close } = await up(busy())
  try {
    const r = await get(`/api/activity?since=${NOW - 12 * HOUR}`)
    assert.equal(r.status, 200)
    const page = ActivityPage.parse(await r.json())
    assert.ok(page.events.length > 5)
    assert.deepEqual(page.events.map((e) => e.t), [...page.events.map((e) => e.t)].sort((a, b) => b - a))
    assert.deepEqual(page.counts, { all: page.events.length, merges: 3, reviews: 2, problems: 2 }) // 3 merged, 2 reviews, a failed run and a failed ticket
    assert.deepEqual(page.headline, { merged: 3, sentBack: 1, retries: 1 })
    const sent = page.events.find((e) => e.sentBack)!
    assert.equal(sent.role, "Reviewer"); assert.equal(sent.ref, "shopfront #3"); assert.equal(sent.result, "Changes requested"); assert.equal(sent.ticket, 3); assert.match(sent.text, /Gift cards, round 1/)
    assert.ok(page.summary, "the first page carries the morning summary")
  } finally { close() }
})

test("/api/activity: kind and since filter; bad parameters are refused", async () => {
  const { get, close } = await up(busy())
  try {
    const kinds = async (k: string, since = NOW - 12 * HOUR) => ActivityPage.parse(await (await get(`/api/activity?since=${since}&kind=${k}`)).json())
    assert.ok((await kinds("merges")).events.every((e) => e.result === "Merged")); assert.equal((await kinds("merges")).events.length, 3)
    assert.ok((await kinds("reviews")).events.every((e) => e.kind === "review")); assert.equal((await kinds("reviews")).events.length, 2)
    assert.ok((await kinds("problems")).events.every((e) => e.problem)); assert.equal((await kinds("problems")).events.length, 2)
    assert.equal((await kinds("merges", NOW - 6 * HOUR)).events.length, 1, "since drops the older merges (only the one 5 hours ago is left)")
    assert.equal((await kinds("all", NOW - 6 * HOUR)).counts.merges, 1)
    for (const bad of ["kind=nope", "since=abc", "since=-5", "before=x"]) assert.equal((await get(`/api/activity?${bad}`)).status, 400, bad)
    assert.equal((await get("/api/activity")).status, 200, "since defaults to the last 12 hours")
  } finally { close() }
})

test("/api/activity: 100 a page, `before` pages back, nothing repeats or is lost", async () => {
  const db = open(":memory:")
  for (let i = 0; i < 130; i++) run(db, "tally", "build", null, 0.1, 10 * 60_000 + i * 60_000)
  const { get, close } = await up(db)
  try {
    const since = NOW - 12 * HOUR
    const p1 = ActivityPage.parse(await (await get(`/api/activity?since=${since}`)).json())
    assert.equal(p1.events.length, 100); assert.equal(p1.more, true); assert.equal(p1.counts.all, 130)
    const p2 = ActivityPage.parse(await (await get(`/api/activity?since=${since}&before=${p1.events.at(-1)!.t}`)).json())
    assert.equal(p2.events.length, 30); assert.equal(p2.more, false); assert.equal(p2.summary, null, "the summary goes with the first page only")
    assert.equal(new Set([...p1.events, ...p2.events].map((e) => e.id)).size, 130)
    assert.equal(p2.counts.all, 130, "the counts cover the whole window, not the page")
  } finally { close() }
})

test("/api/activity and /api/spend need the token; text goes through redact", async () => {
  const db = busy()
  ticket(db, 9, "tally", `Rotate ${process.env.SHOTS_FAKE_API_KEY}`, "shipped", 2 * HOUR)
  const { get, close } = await up(db)
  try {
    for (const path of ["/api/activity", "/api/spend"]) {
      assert.equal((await get(path, false)).status, 401, `${path} without a token`)
      assert.equal((await get(path, "x".repeat(24))).status, 401, `${path} with a wrong token`)
      assert.equal((await get(path)).status, 200)
    }
    const body = await (await get(`/api/activity?since=${NOW - 12 * HOUR}`)).text()
    assert.match(body, /Rotate/); assert.ok(!body.includes(process.env.SHOTS_FAKE_API_KEY!), "the secret value is redacted")
  } finally { close() }
})

/** A test client for /api/events: frames one at a time. */
async function stream(url: string) {
  const ac = new AbortController()
  const res = await fetch(url, { headers: { "x-foreman-token": TOKEN }, signal: ac.signal })
  const reader = res.body!.getReader(), dec = new TextDecoder()
  let buf = ""
  const next = async (ms = 3000) => {
    const stop = setTimeout(() => ac.abort(), ms)
    try {
      for (;;) {
        const i = buf.indexOf("\n\n")
        if (i >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          const f = { event: "", data: "" }
          for (const line of block.split("\n")) { if (line.startsWith("event:")) f.event = line.slice(6).trim(); else if (line.startsWith("data:")) f.data += line.slice(5).trim() }
          return f
        }
        const { done, value } = await reader.read()
        if (done) throw new Error("stream ended")
        buf += dec.decode(value, { stream: true })
      }
    } finally { clearTimeout(stop) }
  }
  return { next, close: () => ac.abort() }
}

test("/api/events: a new run and a new review each arrive once as their own event, valid against the schema", async () => {
  const db = busy()
  const { base, close } = await up(db)
  const c = await stream(`${base}/api/events`)
  try {
    assert.equal((await c.next()).event, "snapshot")
    run(db, "shopfront", "build", 3, 0.4, 1000)
    review(db, "acme/tally", 12, "zz", "pass", 500)
    const got = new Map<string, any>()
    while (got.size < 2) { const f = await c.next(); if (f.event === "run" || f.event === "review") got.set(f.event, EVENT_SCHEMAS[f.event].parse(JSON.parse(f.data))) }
    assert.equal(got.get("run").role, "Builder"); assert.equal(got.get("run").ref, "shopfront #3")
    assert.equal(got.get("review").result, "Passed"); assert.equal(got.get("review").ticket, 2)
    // nothing old is replayed: the next frames are snapshots or heartbeats, never the same events again
    const more = await Promise.race([c.next(400).catch(() => null), new Promise((r) => setTimeout(() => r(null), 450))]) as { event: string } | null
    assert.ok(!more || !["run", "review"].includes(more.event))
  } finally { c.close(); close() }
})

// ---- the morning summary ----
const projects = { tally: { name: "tally", paused: false }, shopfront: { name: "shopfront", paused: false } } as never
const usage = { fiveUsed: 31, weekUsed: 58, weekMsToReset: 2 * DAY }

test("morning summary: before it is sent it is the Chief of Staff's own template over the same facts; after, it is the exact text sent, with where it went", async () => {
  const db = week()
  const now = Date.now() // sendBrief files its text under today's date
  const o = { now, since: now - 12 * HOUR, projects, limits: LIMITS as never }
  const facts = cos.gather(db, projects, { ...usage, weekMsToReset: RESET - now }, now)
  const preview = A.morningSummary(db, o)
  assert.equal(preview.preview, true)
  assert.equal(preview.text, briefMarkdown(buildBrief(db, facts, now)))
  assert.equal(preview.sent.state, "not-sent"); assert.match(preview.sent.text, /no channel set up/)
  db.prepare("INSERT INTO kv VALUES ('discord:wh:daily-update', 'x')").run()
  const waiting = A.morningSummary(db, o)
  assert.equal(waiting.sent.state, "waiting"); assert.match(waiting.sent.text, /Discord #daily-update at 08:05/)

  const sent: string[] = []
  await cos.sendBrief(db, { facts, now, dir }, async (text: string) => (sent.push(text), true))
  const after = A.morningSummary(db, o)
  assert.equal(after.preview, false)
  assert.equal(after.text, sent[0].trim(), "the dashboard shows what the Chief of Staff sent")
  assert.equal(JSON.parse((db.prepare("SELECT v FROM kv WHERE k=?").get(`brief:json:${cos.istDay(now)}`) as { v: string }).v).sentTo, "Discord #daily-update")
  assert.equal(after.sent.state, "sent"); assert.equal(after.sent.to, "Discord #daily-update")
})

test("morning summary: the numbers beside it cover the same window as the page", () => {
  const db = busy()
  tick(db, NOW - 13 * HOUR, 44, RESET); tick(db, NOW - HOUR, 58, RESET)
  db.prepare("INSERT INTO runs (at,project,kind,ticket,ok,human) VALUES (?,?,?,?,1,'reverted')").run(iso(NOW - HOUR), "tally", "build", 1)
  db.prepare("INSERT INTO kv VALUES ('deploy:fails:shopfront', '2')").run()
  const s = A.morningSummary(db, { now: NOW, since: NOW - 12 * HOUR, projects, limits: LIMITS as never })
  assert.equal(s.plan, 14) // 58 now, 44 when the window opened
  assert.equal(s.retried, 1); assert.equal(s.main.reverts, 1); assert.deepEqual(s.main.failingDeploys, ["shopfront"])
  assert.ok(s.runs >= 3)
  tick(db, NOW - 30 * HOUR, 90, RESET - WEEK) // a reading from the last week, before the window: a reset in between is no reading
  db.prepare("DELETE FROM usage_ticks WHERE at=?").run(NOW - 13 * HOUR)
  assert.equal(A.morningSummary(db, { now: NOW, since: NOW - 12 * HOUR, projects, limits: LIMITS as never }).plan, null)
})

// ---- copy and size ----
test("no night or overnight wording in the dashboard, the activity feed or the spend page", () => {
  const files = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)]))
  const own = [...files(new URL("../dashboard/src", import.meta.url).pathname), new URL("../src/activity.ts", import.meta.url).pathname, new URL("../src/spend.ts", import.meta.url).pathname]
  for (const f of own) assert.ok(!/night/i.test(readFileSync(f, "utf8")), `${f} says night`)
})

test("the built entry stays under the first-load budget and does not carry Spend or Activity", { skip: !existsSync(new URL("../dashboard/dist/.vite/manifest.json", import.meta.url)) }, () => {
  const s = firstLoad(new URL("../dashboard/dist", import.meta.url).pathname)
  assert.deepEqual(overBudget(s), [])
  assert.ok(!s.files.some((f) => /spend|activity/.test(f)), `first load pulls in ${s.files.join(", ")}`)
})

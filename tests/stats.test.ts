// Opt-in crash reports and usage stats (src/stats.ts): consent, what a payload may hold, crashes, transport. No network: fetch is replaced.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-stats-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_CONFIG = `${dir}/config.json`
process.env.DOBBY_SECRETS = `${dir}/keys.txt`
const { open } = await import("../src/db.ts")
const S = await import("../src/stats.ts")
const X = await import("../src/stats-schema.ts")
const { UserError } = await import("../src/actions.ts")

const ENDPOINT = "https://stats.example.workers.dev"
const ON = { crashes: true, usage: true, endpoint: ENDPOINT }
const ID = "6f1c2d3e-0000-4000-8000-000000000000"
let n = 0
/** A fresh world: its own database, config folder and data folder, and a fetch that records its calls. */
function world(cfg: object = ON, env: NodeJS.ProcessEnv = {}) {
  const base = `${dir}/w${n++}`
  mkdirSync(base, { recursive: true })
  const calls: { url: string; body: unknown[]; signal?: AbortSignal | null }[] = []
  const fetchFn = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)), signal: init.signal }); return new Response("{}", { status: 202 }) }) as unknown as typeof fetch
  const o = { cfg, env, fetch: fetchFn, configDir: `${base}/cfg`, dataDir: `${base}/data`, now: Date.parse("2026-10-26T10:00:00Z") }
  return { db: open(":memory:"), o, calls, base }
}
const sent = (w: ReturnType<typeof world>) => w.calls.flatMap((c) => c.body) as { name: string; props?: Record<string, unknown> }[]

// ---- consent ----

test("nothing is on by default, and no answer is off", () => {
  assert.deepEqual(S.consent({ cfg: undefined, env: {} }), { crashes: false, usage: false })
  assert.deepEqual(S.consent({ cfg: { endpoint: ENDPOINT }, env: {} }), { crashes: false, usage: false })
})

test("DO_NOT_TRACK, DOBBY_STATS=off and CI force both off, whatever the config says", async () => {
  for (const env of [{ DO_NOT_TRACK: "1" }, { DOBBY_STATS: "off" }, { CI: "true" }]) {
    const w = world(ON, env)
    assert.equal(S.consent(w.o).usage, false); assert.equal(S.consent(w.o).crashes, false)
    S.record(w.db, "first_ticket", undefined, w.o)
    assert.equal(await S.flushUsage(w.db, w.o), "")
    assert.equal(await S.reportCrash(new Error("x"), "tick", w.db, w.o), false)
    assert.equal(w.calls.length, 0)
  }
  assert.equal(S.forcedOff({ DO_NOT_TRACK: "0" }), undefined, "DO_NOT_TRACK=0 is not a request")
})

test("init, Enter on both questions: both off, nothing queued, nothing sent, no id made", async () => {
  const w = world({})
  const saved: Record<string, boolean> = {}
  S.holdEvents()
  S.record(w.db, "setup_started", undefined, w.o)
  S.record(w.db, "setup_step", { step: "checks", ok: true }, w.o)
  const c = await S.askStats(w.db, async () => false, (k, v) => { saved[k] = v }, w.o)
  assert.deepEqual(saved, { "stats.crashes": false, "stats.usage": false })
  assert.deepEqual(c, { crashes: false, usage: false })
  assert.equal(w.db.prepare("SELECT 1 FROM kv WHERE k LIKE 'stats:%'").get(), undefined, "nothing queued")
  assert.equal(S.installId(w.o), undefined, "no id without a yes")
  S.record(w.db, "setup_done", undefined, w.o)
  assert.equal(await S.flushUsage(w.db, w.o), "")
  assert.equal(w.calls.length, 0)
})

test("a yes after the held funnel queues the held events and the next flush sends them", async () => {
  const w = world({})
  S.holdEvents()
  S.record(w.db, "setup_started", undefined, w.o)
  S.record(w.db, "setup_step", { step: "checks", ok: false, reason: "gh_signed_out" }, w.o)
  assert.equal(w.db.prepare("SELECT 1 FROM kv WHERE k='stats:queue'").get(), undefined, "held in memory, not in the database")
  const answers = [false, true] // crashes no, usage yes
  const c = await S.askStats(w.db, async () => answers.shift()!, () => {}, w.o)
  assert.deepEqual(c, { crashes: false, usage: true })
  assert.match(S.installId(w.o)!, /^[0-9a-f-]{36}$/)
  assert.match(await S.flushUsage(w.db, { ...w.o, cfg: { ...ON, crashes: false } }), /usage stats/)
  const names = sent(w).map((e) => e.name)
  assert.deepEqual(names.slice(0, 2), ["setup_started", "setup_step"])
  assert.ok(names.includes("heartbeat"))
  assert.deepEqual(sent(w)[1].props, { step: "checks", ok: false, reason: "gh_signed_out" })
})

test("stats on / off write the two keys; reset-id makes a new id", () => {
  const set: Record<string, boolean> = {}, put = (k: string, v: boolean) => { set[k] = v }
  const w = world({})
  assert.match(S.setStats(true, "usage", put, w.o), /Usage stats: on/)
  assert.deepEqual(set, { "stats.usage": true })
  assert.match(S.setStats(false, undefined, put, w.o), /Crash reports and usage stats: off/)
  assert.deepEqual(set, { "stats.usage": false, "stats.crashes": false })
  assert.match(S.setStats(true, "everything", () => {}, w.o), /usage: dobby stats/)
  const id = S.installId(w.o, true)
  assert.notEqual(S.resetId(w.o), id)
})

test("the dobby stats command: status, on, show, off, against a temp home", () => {
  const home = `${dir}/home`
  mkdirSync(home, { recursive: true })
  const env = { ...process.env, HOME: home, DOBBY_DIR: `${dir}/cli-data`, DOBBY_CONFIG: `${dir}/cli-config.json`, DOBBY_SECRETS: `${dir}/cli-keys.txt`, DOBBY_STATS: "", DO_NOT_TRACK: "", CI: "" }
  const run = (...a: string[]) => spawnSync(new URL("../bin/dobby", import.meta.url).pathname, a, { encoding: "utf8", env }).stdout
  assert.match(run("stats"), /Crash reports: off\nUsage stats: off\nNothing is sent\./)
  assert.match(run("stats", "on", "usage"), /Usage stats: on/)
  assert.match(run("stats"), /Usage stats: on/)
  assert.match(run("stats"), /Sent to https:\/\/dobby-stats\./)
  assert.doesNotMatch(run("stats", "show"), /not sent/)
  assert.deepEqual(JSON.parse(readFileSync(`${dir}/cli-config.json`, "utf8")), { stats: { usage: true } })
  assert.match(run("stats", "off"), /off/)
  assert.match(run("stats", "show"), /Usage stats are off/)
})

// ---- payload ----

test("every event validates against the schema, and an unknown field or value does not", async () => {
  const w = world()
  w.db.prepare("INSERT INTO tickets (project, title, status, created_at, updated_at, note) VALUES ('a', 't', 'shipped', ?, ?, 'https://github.com/o/r/pull/1')").run("2026-10-26T09:00:00Z", "2026-10-26T09:30:00Z")
  const { events } = await S.nextUsage(w.db, w.o)
  assert.deepEqual(events.map((e) => e.name), ["first_ticket", "first_pr", "first_merge", "heartbeat"])
  for (const e of events) assert.ok(X.Event.safeParse(e).success, e.name)
  const hb = events.at(-1) as unknown as { props: Record<string, unknown> }
  assert.deepEqual(Object.keys(hb.props).sort(), ["chat", "features", "merges_paused", "plan", "projects", "review_auto", "roles", "safety", "sent_back", "shipped", "week_cap"])
  const ok = { install: ID, v: "0.1.0", os: "linux", node: 24, day: "2026-10-26", name: "setup_done" }
  assert.ok(X.Event.safeParse(ok).success)
  assert.ok(!X.Event.safeParse({ ...ok, extra: 1 }).success, "unknown field")
  assert.ok(!X.Event.safeParse({ ...ok, os: "win32" }).success, "unknown value")
  assert.ok(!X.Event.safeParse({ ...ok, name: "setup_step", props: { step: "repos", ok: true, title: "x" } }).success, "unknown prop")
  assert.ok(!X.Event.safeParse({ ...ok, name: "crash", props: { kind: "TypeError", where: ["/Users/me/code/x.ts:1"], command: "tick" } }).success, "absolute path")
  assert.ok(!X.Event.safeParse({ ...ok, name: "heartbeat", props: {} }).success)
})

test("fuzz: titles, paths, URLs, emails and names in the state never appear in any payload", async () => {
  const w = world()
  const FUZZ = ["Fix Zebra checkout for Acme Corp", "/Users/jane/hidden-project", "https://internal.example.com/tok_abc123", "jane.doe@example.org", "sk-ant-ZZZZ-hidden", "jane-the-owner", "ledger-private-repo", "PR title with 'quotes' and \"more\""]
  const ins = w.db.prepare("INSERT INTO tickets (project, title, done_when, status, note, created_at, updated_at) VALUES (?, ?, ?, 'shipped', ?, ?, ?)")
  FUZZ.forEach((f, i) => ins.run(f, f, f, `https://github.com/${FUZZ[7 - i].replace(/\W/g, "")}/x/pull/${i + 1} ${f}`, "2026-10-26T08:00:00Z", "2026-10-26T09:00:00Z"))
  w.db.prepare("INSERT INTO reviews (repo, pr, sha, verdict, at) VALUES (?, 1, 'abc', 'fail', ?)").run("jane-the-owner/ledger-private-repo", "2026-10-25T00:00:00Z")
  for (const f of FUZZ) w.db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`misc:${f}`, f)
  w.db.prepare("INSERT INTO runs (at, project, kind, ok) VALUES (?, ?, 'builder', 1)").run("2026-10-26T09:00:00Z", FUZZ[0])
  for (const f of FUZZ) w.db.prepare("INSERT INTO runs (at, project, kind, ok) VALUES (?, ?, ?, 1)").run("2026-10-26T09:00:00Z", f, f) // a run kind that is not a role name
  const crash = Object.assign(new Error(`failed on ${FUZZ.join(" ")}`), { code: "E_X" })
  S.holdEvents(); S.record(w.db, "setup_step", { step: "repos", ok: true }, w.o); S.releaseHeld(w.db, w.o)
  const { events } = await S.nextUsage(w.db, w.o)
  const text = JSON.stringify([...events, S.crashEvent(crash, FUZZ[1], ID, w.o)])
  for (const f of FUZZ) assert.ok(!text.includes(f) && !text.toLowerCase().includes(f.toLowerCase()), `payload holds ${f}`)
  for (const word of ["jane", "acme", "zebra", "ledger", "example", "hidden", "/users"]) assert.ok(!text.toLowerCase().includes(word), `payload holds ${word}`)
  S.installId(w.o, true)
  await S.flushUsage(w.db, w.o)
  assert.ok(w.calls.length > 0)
  const wire = JSON.stringify(w.calls) + readFileSync(`${w.base}/data/stats/sent.jsonl`, "utf8")
  for (const f of FUZZ) assert.ok(!wire.includes(f), `wire holds ${f}`)
})

test("show prints exactly what the next flush sends", async () => {
  const w = world()
  w.db.prepare("INSERT INTO tickets (project, title, status, created_at, updated_at) VALUES ('p', 't', 'ready', ?, ?)").run("2026-10-26T09:00:00Z", "2026-10-26T09:00:00Z")
  S.installId(w.o, true)
  const shown = JSON.parse((await S.showText(w.db, w.o)).split("payload:\n")[1])
  await S.flushUsage(w.db, w.o)
  assert.deepEqual(w.calls[0].body, shown)
  assert.match(await S.showText(w.db, { ...w.o, cfg: {} }), /Usage stats are off/)
})

// ---- crashes ----

test("a crash keeps only Dobby's own frames as relative paths, and never the message", () => {
  const root = new URL("../", import.meta.url).pathname
  const stack = [
    "Error: boom at /Users/jane/hidden-project and jane@example.org",
    `    at run (file://${root}src/cli.ts:120:5)`,
    `    at Object.<anonymous> (${root}src/lib.ts:45:9)`,
    `    at file://${root}node_modules/zod/lib/index.js:10:2`,
    "    at node:internal/modules/run_main:123:5",
    "    at user (/Users/jane/hidden-project/index.ts:3:1)",
  ].join("\n")
  assert.deepEqual(S.ownFrames(stack), ["src/cli.ts:120", "src/lib.ts:45"])
  const err = Object.assign(new TypeError("boom jane@example.org /Users/jane"), { stack })
  const ev = S.crashEvent(err, "tick", ID, world().o) as unknown as { props: Record<string, unknown> }
  assert.deepEqual(ev.props, { kind: "TypeError", where: ["src/cli.ts:120", "src/lib.ts:45"], command: "tick" })
  assert.ok(!JSON.stringify(ev).includes("jane"))
  assert.equal((S.crashEvent(new Error("x"), "Bad Command!", ID, world().o) as unknown as { props: { command: string } }).props.command, "unknown")
})

test("a UserError is not a crash; an unexpected error is, at most 10 a day", async () => {
  const w = world()
  S.installId(w.o, true)
  assert.equal(await S.reportCrash(new UserError("BAD_REQUEST", "no ticket"), "show", w.db, w.o), false)
  assert.equal(w.calls.length, 0)
  const results: boolean[] = []
  for (let i = 0; i < 12; i++) results.push(await S.reportCrash(new RangeError("x"), "tick", w.db, w.o))
  assert.equal(results.filter(Boolean).length, 10)
  assert.equal(w.calls.length, 10)
  assert.equal(await S.reportCrash(new RangeError("x"), "tick", w.db, { ...w.o, now: w.o.now + 86_400_000 }), true, "the next day counts again")
  const c = world({ crashes: false, usage: true, endpoint: ENDPOINT })
  assert.equal(await S.reportCrash(new RangeError("x"), "tick", c.db, c.o), false, "crash reports off = nothing, even with usage on")
})

// ---- transport ----

test("an empty endpoint sends nothing, even when both are on", async () => {
  const w = world({ crashes: true, usage: true, endpoint: "" })
  S.installId(w.o, true)
  w.db.prepare("INSERT INTO tickets (project, title, created_at, updated_at) VALUES ('p', 't', 'a', 'b')").run()
  await S.flushUsage(w.db, w.o); await S.reportCrash(new Error("x"), "tick", w.db, w.o)
  assert.equal(w.calls.length, 0)
  assert.equal(existsSync(`${w.base}/data/stats/sent.jsonl`), false)
  assert.match(S.statusText(w.o), /No endpoint is set yet/)
  const bad = world({ ...ON, endpoint: "ftp://x" })
  await S.flushUsage(bad.db, bad.o)
  assert.equal(bad.calls.length, 0, "only https (or localhost) endpoints")
})

test("a failing, throwing or timed-out fetch never throws, and nothing is retried", async () => {
  const failing = [
    async () => { throw new Error("offline") },
    () => { throw new Error("sync") },
    async () => new Response("no", { status: 500 }),
    (_u: string, i: RequestInit) => new Promise((_, rej) => i.signal!.addEventListener("abort", () => rej(new DOMException("timeout", "TimeoutError")))),
  ]
  for (const f of failing) {
    const w = world(); S.installId(w.o, true)
    let calls = 0
    const o = { ...w.o, fetch: ((u: string, i: RequestInit) => { calls++; return (f as (u: string, i: RequestInit) => Promise<Response>)(u, i) }) as unknown as typeof fetch }
    const t = Date.now()
    const r = await Promise.race([S.reportCrash(new Error("x"), "tick", w.db, o), new Promise((r) => setTimeout(() => r("hung"), 5000))])
    assert.equal(r, false)
    assert.ok(Date.now() - t < 4500)
    assert.equal(calls, 1, "one try")
    await S.flushUsage(w.db, o)
  }
})

test("usage goes out once a day, with a 3 s timeout, and every payload is appended to sent.jsonl", async () => {
  const w = world()
  S.installId(w.o, true)
  assert.match(await S.flushUsage(w.db, w.o), /usage stats/)
  assert.equal(w.calls.length, 1)
  assert.equal(w.calls[0].url, `${ENDPOINT}/v1/events`)
  assert.ok(w.calls[0].signal instanceof AbortSignal)
  assert.equal(await S.flushUsage(w.db, w.o), "usage stats: 0 event(s)", "the same day: no second heartbeat")
  assert.equal(w.calls.length, 1, "nothing queued, nothing sent")
  await S.flushUsage(w.db, { ...w.o, now: w.o.now + 86_400_000 })
  assert.equal(w.calls.length, 2, "the next day sends again")
  const lines = readFileSync(`${w.base}/data/stats/sent.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.equal(lines.length, 2)
  assert.deepEqual(lines[0].events, w.calls[0].body)
  assert.match(S.sentLog(w.o), /"heartbeat"/)
  assert.equal(S.sentLog({ ...w.o, dataDir: `${w.base}/none` }), "Nothing has been sent.")
})

test("a funnel event is queued once per install", () => {
  const w = world()
  S.record(w.db, "first_ticket", undefined, w.o); S.record(w.db, "first_ticket", undefined, w.o)
  S.record(w.db, "setup_step", { step: "repos", ok: true }, w.o); S.record(w.db, "setup_step", { step: "chat", ok: true }, w.o); S.record(w.db, "setup_step", { step: "chat", ok: true }, w.o)
  assert.equal((JSON.parse((w.db.prepare("SELECT v FROM kv WHERE k='stats:queue'").get() as { v: string }).v) as unknown[]).length, 3)
})

test("the report needs the token from the environment", async () => {
  const w = world()
  assert.match(await S.reportText(30, w.o), /DOBBY_STATS_REPORT_TOKEN/)
  let seen = ""
  const o = { ...w.o, env: { DOBBY_STATS_REPORT_TOKEN: "t0k" }, fetch: (async (u: string, i: RequestInit) => { seen = `${u} ${(i.headers as Record<string, string>).authorization}`; return new Response(JSON.stringify({ funnel: [] })) }) as unknown as typeof fetch }
  assert.match(await S.reportText(7, o), /funnel/)
  assert.equal(seen, `${ENDPOINT}/v1/report?from=2026-10-19&to=2026-10-26 Bearer t0k`)
})

test("the schema describes every field it lists, and the manual shows them", () => {
  const rows = X.fieldRows()
  assert.ok(rows.length > 25)
  for (const r of rows.filter((r) => r.field)) assert.ok(r.text.length > 0, `${r.event}.${r.field} has no description`)
  assert.ok(readFileSync(new URL("../docs/manual/stats.md", import.meta.url), "utf8").includes("`props.features`"))
})

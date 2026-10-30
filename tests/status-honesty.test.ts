// #381 and #382: status, list, show, limits, doctor, brief and the job installer must say what is true. Offline, temp dirs, injected runners.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-honest-`)
process.env.DOBBY_DIR = dir
const { open } = await import("../src/db.ts")
const { addTicket, setTicket, doctor } = await import("../src/lib.ts")
const { statusText, listView, limitsNow, tickRuns } = await import("../src/view.ts")
const { listText, showText } = await import("../src/actions.ts")
const { setPause } = await import("../src/pause.ts")
const { installJobs, LISTENER_SKIPPED } = await import("../src/jobs.ts")
const { pipelineChecks } = await import("../src/health.ts")
const { buildBrief, briefMarkdown } = await import("../src/brief.ts")

const NOW = Date.parse("2026-10-27T10:00:00Z"), WEEK = new Date(NOW - 7 * 86_400_000).toISOString()
const mk = (db: any, status: string, updated = new Date(NOW).toISOString(), title = "Add a thing") => {
  const { id } = addTicket(db, { project: "tally", title })
  setTicket(db, id, { status })
  db.prepare("UPDATE tickets SET updated_at=? WHERE id=?").run(updated, id)
  return id
}

test("#382 status: no tick ever and no tick job says how to fix it", () => {
  const db = open(":memory:")
  assert.match(statusText(db, NOW), /Last tick unknown: no tick job is installed\. Run dobby start in a terminal, or dobby jobs install/)
  db.prepare("INSERT INTO kv VALUES ('tick:last', ?)").run(String(NOW - 1000))
  assert.doesNotMatch(statusText(db, NOW), /no tick job/)
  assert.equal(tickRuns(open(":memory:"), NOW, () => false), false)
  assert.equal(tickRuns(open(":memory:"), NOW, () => true), true)
})

test("#382 status and list: a running ticket with no change for 7 days is marked stuck", () => {
  const db = open(":memory:")
  const id = mk(db, "running", WEEK)
  assert.match(statusText(db, NOW), /Building now \(1\): Add a thing \(Stuck: no change for \d+d\)/)
  assert.match(listText(db), new RegExp(`#${id}\\n    Stuck: no change for \\d+d`))
  const fresh = open(":memory:")
  mk(fresh, "running", new Date(NOW - 60_000).toISOString())
  assert.doesNotMatch(statusText(fresh, NOW), /Stuck/)
})

test("#382 doctor: the stuck row names the command to reset the ticket", () => {
  const rows = doctor({ tickets: [{ id: 12, status: "running", updated_at: WEEK }], pauses: [], origins: [], auth: { ok: true } }, NOW)
  const r = rows.find((x) => x.name === "stuck tickets") as { ok: boolean; fix?: string }
  assert.equal(r.ok, false)
  assert.equal(r.fix, "dobby retry 12")
})

test("#382 brief --dry agrees with status on Needs you (failed in the last 7 days)", () => {
  const db = open(":memory:")
  const at = new Date(NOW - 3 * 86_400_000).toISOString()
  const id = mk(db, "failed", at, "Fix the login")
  setTicket(db, id, { note: "tests failed twice" })
  db.prepare("UPDATE tickets SET updated_at=? WHERE id=?").run(at, id)
  assert.match(statusText(db, NOW), /Needs you \(1\)/)
  const md = briefMarkdown(buildBrief(db, { done: [], waiting: [], ready: [], leads: [], health: [], spend: 0, usage: null, active: [], paused: [] }, NOW))
  assert.doesNotMatch(md, /Nothing needs you today/)
  assert.match(md, /Fix the login, tests failed twice/)
})

test("#382 limits: pause all reads Everything paused, builders-only still Builders paused", () => {
  const db = open(":memory:")
  const u = { fiveUsed: 10, weekUsed: 10, fiveMsToReset: 3_600_000, weekMsToReset: 86_400_000, ageMs: 0 } as never
  setPause(db, { all: true }, true, "me", { now: NOW })
  assert.match(limitsNow(db, u, NOW).line, /^Everything paused by me/)
  const b = open(":memory:")
  setPause(b, { kind: "builders" }, true, "me", { now: NOW })
  assert.match(limitsNow(b, u, NOW).line, /^Builders paused by me/)
})

test("#382 list: an empty queue says so when paused", () => {
  const db = open(":memory:")
  assert.equal(listText(db), "nothing open")
  setPause(db, { all: true }, true, "me")
  assert.match(listText(db), /^nothing open\n⏸ Paused: /)
})

test("#382 list and show: a ready ticket held by the cap says Waiting: cap", async () => {
  const db = open(":memory:")
  const id = mk(db, "ready")
  assert.doesNotMatch(listText(db), /Waiting/)
  assert.match(await showText(db, id, "short"), /note: -/)
  db.prepare("INSERT INTO kv VALUES ('cap:blocked-since', '1')").run()
  db.prepare("INSERT INTO kv VALUES ('cap:why', ?)").run("5-hour window at 82% (pace cap 70%)")
  assert.match(listText(db), /Ready \(1\)\n.*#\d+\n    Waiting: cap \(5-hour window at 82%/)
  assert.match(await showText(db, id, "short"), /note: Waiting: cap \(5-hour window at 82%/)
  assert.match(listView([{ id: 1, status: "ready", project: "t", title: "x", note: null, updated_at: new Date(NOW).toISOString() }], NOW, 10, "cap"), /Waiting: cap/)
})

test("#381 install: no listener when Discord is not set up, and the row says what to run", () => {
  const calls: string[] = []
  const run = (c: string, a: string[]) => (calls.push(`${c} ${a.join(" ")}`), { ok: true, out: "" })
  const rows = installJobs({ bin: "/b", home: dir, uid: 1, os: "darwin", dry: true, discord: false, log: (s) => calls.push(s), run })
  assert.deepEqual(rows.filter((r) => r.name === "listener"), [{ name: "listener", ok: true, detail: LISTENER_SKIPPED }])
  assert.equal(calls.some((c) => /listener\.plist/.test(c)), false)
  assert.match(LISTENER_SKIPPED, /dobby discord/)
  const withDiscord = installJobs({ bin: "/b", home: dir, uid: 1, os: "darwin", dry: true, discord: true, log: () => {}, run })
  assert.equal(withDiscord.find((r) => r.name === "listener")!.detail, "dry run")
})

test("#381 status: a failing background job shows in the health checks", () => {
  const db = open(":memory:")
  db.prepare("INSERT INTO kv VALUES ('health:raw', ?)").run(JSON.stringify(["job dobby-listener.service: exit 1", "disk: 11 GB free"]))
  const jobs = pipelineChecks(db, { now: NOW, freeGb: () => 50 }).find((c) => c.check === "jobs")!
  assert.equal(jobs.ok, false)
  assert.match(jobs.text, /dobby-listener\.service: exit 1/)
  assert.equal(pipelineChecks(open(":memory:"), { now: NOW, freeGb: () => 50 }).find((c) => c.check === "jobs")!.ok, true)
})

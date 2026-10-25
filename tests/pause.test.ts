// One pause system with levels: the pure check, back-compat, parsing, and every place that must honour it. Offline.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-pause-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/keys`
const { open } = await import("../src/db.ts")
const P = await import("../src/pause.ts")
const { nextTicket } = await import("../src/lib.ts")

const add = (db: any, project: string, status = "ready") => Number(db.prepare("INSERT INTO tickets (project,title,status,created_at,updated_at) VALUES (?,?,?,datetime('now'),datetime('now'))").run(project, "Add a thing", status).lastInsertRowid)

test("levels: all, kind, project, ticket; until auto-resumes; scout and notify ignore projects", () => {
  const db = open(":memory:")
  assert.equal(P.paused(db, { kind: "builders" }), null)
  P.setPause(db, { project: "tally" }, true, "me", { now: 1000 })
  assert.match(P.paused(db, { kind: "reviews", project: "tally" })!, /project tally paused by me/)
  assert.equal(P.paused(db, { kind: "reviews", project: "shopfront" }), null)
  assert.equal(P.paused(db, { kind: "scout", project: "tally" }), null)
  P.setPause(db, { ticket: 7 }, true, "me", { now: 1000 })
  assert.match(P.paused(db, { kind: "merges", ticket: 7 })!, /ticket #7/)
  assert.equal(P.paused(db, { kind: "planning", ticket: 7 }), null)
  P.setPause(db, { kind: "deploys" }, true, "me", { now: Date.now(), until: Date.now() + 3600_000 })
  assert.match(P.paused(db, { kind: "deploys", project: "x" })!, /until/)
  P.setPause(db, { kind: "notify" }, true, "me", { now: 1, until: 2 }) // already over
  assert.equal(P.paused(db, { kind: "notify" }, 5), null)
  P.setPause(db, { all: true }, true, "me")
  assert.match(P.paused(db, { kind: "scout" })!, /everything/); assert.ok(P.paused(db, { kind: "all" }))
  assert.equal(P.setPause(db, { all: true }, true).changed, false)
  P.setPause(db, { all: true }, false); assert.equal(P.paused(db, { kind: "all" }), null)
  assert.match(P.pauseLine(db), /^⏸ Paused: deploys.*project tally.*ticket #7/)
})

test("back-compat: old builders:paused and paused:all migrate on read; pause/resume = builders", () => {
  const db = open(":memory:")
  db.prepare("INSERT INTO kv VALUES ('builders:paused', ?)").run(JSON.stringify({ at: 5, by: "the dashboard" }))
  assert.deepEqual(P.pausedState(db), { at: 5, by: "the dashboard" })
  assert.equal(db.prepare("SELECT 1 FROM kv WHERE k='builders:paused'").get(), undefined)
  db.prepare("INSERT INTO kv VALUES ('paused:all', '99')").run()
  assert.match(P.paused(db, { kind: "all" })!, /everything paused by the owner/)
  P.setPause(db, { all: true }, false)
  assert.match(P.setPaused(db, false, "x").line!, /Builders resumed by x/)
  assert.match(P.setPaused(db, true, "x", 10).line!, /Builders paused by x: no new tickets start; 0 running/)
  assert.deepEqual((P.parsePause("pause") as any).scope, { kind: "builders" })
})

test("parsePause: targets, durations, status, errors", () => {
  const now = 1_000_000
  assert.deepEqual(P.parsePause("pause everything", now), { on: true, scope: { all: true }, until: undefined })
  assert.deepEqual(P.parsePause("resume all", now), { on: false, scope: { all: true }, until: undefined })
  assert.deepEqual(P.parsePause("pause merges for 2h", now), { on: true, scope: { kind: "merges" }, until: now + 7200_000 })
  assert.deepEqual(P.parsePause("pause project tally for 30m", now), { on: true, scope: { project: "tally" }, until: now + 1800_000 })
  assert.deepEqual(P.parsePause("resume ticket #12", now), { on: false, scope: { ticket: 12 }, until: undefined })
  assert.deepEqual(P.parsePause("pause status"), { status: true })
  assert.ok("error" in (P.parsePause("pause for soon") as any)); assert.ok("error" in (P.parsePause("pause banana") as any)); assert.ok("error" in (P.parsePause("resume for 1h") as any))
  assert.equal(P.parsePause("start"), null); assert.equal(P.parsePause("queue 4"), null)
})

test("builders: nextTicket skips a paused project and a paused ticket", () => {
  const db = open(":memory:")
  const a = add(db, "tally"), b = add(db, "shopfront"), c = add(db, "shopfront")
  P.setPause(db, { project: "tally" }, true)
  assert.equal(nextTicket(db)!.id, b)
  P.setPause(db, { ticket: b }, true)
  assert.equal(nextTicket(db)!.id, c)
  P.setPause(db, { project: "tally" }, false)
  assert.equal(nextTicket(db)!.id, a)
})

test("planning: Lead, PM, Area PM, weekly and Program skip a paused project", async () => {
  const db = open(":memory:")
  const { leadDue, weeklyDue } = await import("../src/graphs/lead.ts")
  const { pmDue, areaDue } = await import("../src/graphs/product.ts")
  const { runPrograms } = await import("../src/graphs/program.ts")
  const projects = { tally: { name: "tally", paused: false, areas: ["a"] } } as any
  const monday = Date.parse("2026-10-19T06:00:00Z")
  assert.equal(leadDue(db, projects).length, 1); assert.equal(pmDue(db, projects, monday).length, 1); assert.equal(weeklyDue(db, projects, monday).length, 1)
  P.setPause(db, { kind: "planning" }, true)
  assert.equal(leadDue(db, projects).length, 0); assert.equal(pmDue(db, projects, monday).length, 0); assert.equal(weeklyDue(db, projects, monday).length, 0)
  db.prepare("INSERT INTO kv VALUES ('pm-at:tally', '2026-10-19')").run()
  assert.equal(areaDue(db, projects, monday).length, 0)
  assert.deepEqual(await runPrograms(db, "tally"), [])
  P.setPause(db, { kind: "planning" }, false); P.setPause(db, { project: "tally" }, true)
  assert.equal(leadDue(db, projects).length, 0)
  assert.equal(areaDue(db, projects, monday).length, 0)
})

test("reviews: runReview and scan stop; merges: landAutomerge holds the key; sweep still runs", async () => {
  const db = open(":memory:")
  const rv = await import("../src/graphs/review.ts")
  const calls: string[] = []
  const run = (cmd: string, args: string[]) => (calls.push(`${cmd} ${args.join(" ")}`), { ok: false, out: "" })
  const deps = { run, claude: null as any, notify: (async () => true) as any, projects: {} } as any
  P.setPause(db, { project: "tally" }, true)
  const r = await rv.runReview(db, "ownerdev/tally", 3, { deps })
  assert.equal(r.state, "paused"); assert.match(r.why, /reviews project tally paused/); assert.equal(calls.length, 0)
  P.setPause(db, { project: "tally" }, false)
  P.setPause(db, { kind: "reviews" }, true)
  const out = await rv.scan(db, { deps, budget: () => ({ ok: true, why: "" }) })
  assert.match(out[0], /^reviews reviews paused/); assert.equal(calls.length, 0)
  P.setPause(db, { kind: "reviews" }, false)
  const t = add(db, "tally", "fixing")
  db.prepare("INSERT INTO kv VALUES (?, ?)").run("automerge:ownerdev/tally#7", JSON.stringify({ ticket: t }))
  P.setPause(db, { ticket: t }, true)
  assert.match(await rv.landAutomerge(db, deps, "ownerdev/tally", 7), /^merges ticket #\d+ paused.*lands after resume/)
  assert.equal(calls.length, 0); assert.ok(db.prepare("SELECT 1 FROM kv WHERE k='automerge:ownerdev/tally#7'").get())
  P.setPause(db, { ticket: t }, false); P.setPause(db, { kind: "merges" }, true)
  assert.match((await rv.sweepAutomerge(db, deps))[0], /automerge: merges merges paused/)
})

test("deploys: a paused deploy is queued and runs on resume", async () => {
  const db = open(":memory:")
  const { deployProject, runQueuedDeploys } = await import("../src/deploy.ts")
  const ran: string[] = []
  const sh = (cmd: string) => (cmd.includes("bun run deploy") && ran.push(cmd), cmd === "git rev-parse HEAD" ? { ok: true, out: "abc1234\n" } : cmd.includes("deploy/prod") ? { ok: false, out: "" } : { ok: true, out: cmd.includes("status") ? "" : "ok" })
  const o = { sh: sh as any, notify: (async () => true) as any, projects: { tally: { name: "tally", repo: dir, deploy: "bun run deploy", base: "main", install: "true" } } as any }
  P.setPause(db, { kind: "deploys" }, true)
  assert.match(await deployProject(db, "tally", o), /queued and runs on resume/)
  assert.equal(ran.length, 0); assert.deepEqual(await runQueuedDeploys(db, o), [])
  P.setPause(db, { kind: "deploys" }, false)
  assert.deepEqual(await runQueuedDeploys(db, o), ["tally: deployed abc1234"])
  assert.equal(ran.length, 1); assert.deepEqual(await runQueuedDeploys(db, o), [])
})

test("scout: paused scout is not due and does not run", async () => {
  const db = open(":memory:")
  const { scoutDue, scout } = await import("../src/scout.ts")
  assert.equal(scoutDue(db, 2), true)
  P.setPause(db, { kind: "scout" }, true)
  assert.equal(scoutDue(db, 2), false)
  assert.match(await scout(db, async () => {}), /^scout scout paused/)
})

test("notify: a paused notify holds non-#needs-you posts in the outbox, #needs-you still goes out", async () => {
  writeFileSync(process.env.DOBBY_SECRETS!, "DISCORD_BOT_TOKEN=xxxxxxxxxxxx\n")
  const db = open() // the same file discordOn() uses
  db.prepare("INSERT OR REPLACE INTO kv VALUES ('discord:wh:needs-you', 'id/token')").run()
  const { notify, asIs } = await import("../src/telegram.ts")
  P.setPause(db, { kind: "notify" }, true)
  const box = `${dir}/outbox.log`
  assert.equal(await notify("quiet news", fetch, undefined, { kind: "health" }, asIs), false)
  assert.match(readFileSync(box, "utf8"), /\[notify paused\] quiet news/)
  const fetcher = (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "{}", headers: new Headers() })) as any
  await notify("urgent", fetcher, undefined, { kind: "approval" }, asIs).catch(() => {})
  assert.doesNotMatch(readFileSync(box, "utf8"), /notify paused\] urgent/)
  db.prepare("DELETE FROM kv WHERE k='pause'").run()
})

test("status board and snapshot show what is paused; dashboard actions take a scope", async () => {
  const db = open(":memory:")
  const { statusText } = await import("../src/view.ts")
  const { snapshot } = await import("../src/dashboard.ts")
  P.setPause(db, { project: "tally" }, true, "the dashboard")
  assert.match(statusText(db), /⏸ Paused: project tally by the dashboard since/)
  assert.equal(snapshot(db).paused, null)
  assert.equal((snapshot(db) as any).pause[0].scope, "project tally")
  const { actionArgs } = await import("../src/dashboard-server.ts")
  assert.deepEqual(actionArgs(db, { action: "pause", kind: "project", project: "tally", for: "2h" }), { args: ["pause", "project", "tally", "for", "2h"] })
  assert.deepEqual(actionArgs(db, { action: "resume", kind: "reviews" }), { args: ["resume", "reviews"] })
  assert.deepEqual(actionArgs(db, { action: "pause" }), { args: ["pause"] })
  assert.ok("error" in actionArgs(db, { action: "pause", kind: "x; rm" }))
})

test("deploys: safety.deploy ask sends a Deploy tap instead of deploying; the tap deploys", async () => {
  const db = open(":memory:")
  const { deployProject } = await import("../src/deploy.ts")
  const { config, setConfig } = await import("../src/config.ts")
  const base = config()
  const ran: string[] = [], cards: string[] = []
  const sh = (cmd: string) => (cmd.includes("bun run deploy") && ran.push(cmd), cmd === "git rev-parse HEAD" ? { ok: true, out: "abc1234\n" } : cmd.includes("deploy/prod") ? { ok: false, out: "" } : { ok: true, out: cmd.includes("status") ? "" : "ok" })
  const o = { sh: sh as any, notify: (async (t: string, _f: unknown, b?: { data: string }[]) => (cards.push(`${t} | ${b?.map((x) => x.data).join(",")}`), true)) as any, projects: { tally: { name: "tally", repo: dir, deploy: "bun run deploy", base: "main", install: "true" } } as any }
  setConfig({ ...base, safety: { ...base.safety, deploy: "ask" } })
  try {
    assert.match(await deployProject(db, "tally", o), /waits for your tap/)
    assert.equal(ran.length, 0)
    assert.match(cards[0], /ready to deploy \| deploynow tally$/)
    assert.equal(await deployProject(db, "tally", { ...o, tapped: true }), "tally: deployed abc1234")
  } finally { setConfig(undefined) }
})

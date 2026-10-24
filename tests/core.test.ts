import assert from "node:assert/strict"
import { test } from "node:test"
import { logRun, open } from "../src/db.ts"
import { changed, jobProblem, parseLaunchctl, plain } from "../src/health.ts"
import { addTicket, budgetAllows, nextTicket, orphanPids, orphanedParents, prDone, parentFor, parseDoc, parseVerdict, setTicket, sh, windowIdle } from "../src/lib.ts"
import { parseResult } from "../src/run.ts"

test("parseResult reads usage and cost from claude json", () => {
  const raw = JSON.stringify({ subtype: "success", is_error: false, num_turns: 4, duration_ms: 9000, result: "done", session_id: "s1", total_cost_usd: 0.12, usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 }, modelUsage: { "claude-haiku-5-5": {} } })
  const r = parseResult("shopfront", "reddit", undefined, raw, 0)
  assert.deepEqual([r.ok, r.turns, r.output_tokens, r.cache_read, r.cost_usd, r.model, r.text], [true, 4, 200, 5000, 0.12, "claude-haiku-5-5", "done"])
  assert.equal(parseResult("p", "k", undefined, JSON.stringify({ is_error: true, subtype: "error_max_turns" }), 0).reason, "error_max_turns")
  assert.equal(parseResult("p", "k", undefined, "not json", 1).ok, false)
})

test("launchctl parsing and job health", () => {
  const jobs = parseLaunchctl("PID\tStatus\tLabel\n-\t0\tcom.acme.reddit-hourly\n-\t1\tcom.acme.discover\n-\t0\tcom.acme.agent\n123\t0\tcom.acme.dm-server\n1541\t1\tcom.acme.dm-tunnel\n24626\t-15\tcom.foreman.dashboard\n-\t-15\tcom.foreman.cos")
  // running now = restarted, whatever its last exit; a stopped job keeps its exit code
  assert.deepEqual(jobs.map(jobProblem), [null, "last exit 1", "not running", null, null, null, "last exit -15"])
})

test("budget: the weekly remainder spread over the windows left, heavier at night, lighter by day", () => {
  const day3 = 4 * 24 * 3600_000 // 4 days left = 19.2 windows; 80% left = 4.2% of the week per window = ~42% of a window
  assert.equal(budgetAllows({ fiveUsed: 20, weekUsed: 20, weekMsToReset: day3 }, 14).cap, 60) // day, 23 points behind pace: caught up within a day, day ceiling 60
  assert.equal(budgetAllows({ fiveUsed: 10, weekUsed: 50, weekMsToReset: day3 }, 14).cap, 20) // day, ahead of pace: x0.64 (16), floor 20
  assert.equal(budgetAllows({ fiveUsed: 20, weekUsed: 20, weekMsToReset: day3 }, 2).cap, 90) // night, behind pace: night ceiling 90
  assert.equal(budgetAllows({ fiveUsed: 60, weekUsed: 20, weekMsToReset: day3 }, 14).ok, false) // the day ceiling holds
  assert.equal(budgetAllows({ fiveUsed: 61, weekUsed: 20, weekMsToReset: day3, fiveMsToReset: 15 * 60_000 }, 14).cap, 98) // far behind pace, 15 min to reset: nearly all of it; the owner's reserve shrank to 2%
  assert.equal(budgetAllows({ fiveUsed: 61, weekUsed: 50, weekMsToReset: day3, fiveMsToReset: 15 * 60_000 }, 14).cap, 20) // ahead of pace: no
  assert.equal(budgetAllows({ fiveUsed: 65, weekUsed: 20, weekMsToReset: day3 }, 14).ok, false)
  assert.equal(budgetAllows({ fiveUsed: 65, weekUsed: 20, weekMsToReset: day3 }, 2).ok, true)
  assert.equal(budgetAllows({ fiveUsed: 65, weekUsed: 20, weekMsToReset: day3 }, 14, 80).ok, true) // owner pressed 80%
  assert.equal(budgetAllows({ fiveUsed: 82, weekUsed: 20, weekMsToReset: day3 }, 14, 80).ok, false)
  assert.equal(budgetAllows({ fiveUsed: 95, weekUsed: 20, weekMsToReset: day3 }, 14, 100).ok, true)
  assert.equal(budgetAllows({ fiveUsed: 10, weekUsed: 50, weekMsToReset: day3 }, 2).cap, 42) // ahead of pace: night x1.6 of the even share only
  assert.equal(budgetAllows({ fiveUsed: 10, weekUsed: 95, weekMsToReset: day3 }, 2).ok, false) // the last 5% is the owner's
  assert.equal(budgetAllows({ fiveUsed: 10, weekUsed: 20, weekMsToReset: day3 }, 2, undefined, 0.2).cap, 90) // measured: a window costs more of the week (still far behind pace: night ceiling)
  assert.equal(budgetAllows({ fiveUsed: 0, weekUsed: 5, weekMsToReset: 3 * 3600_000 }, 14).cap, 60) // weekly reset soon, lots left: the day cap tops out at 60
})

test("frontmatter, verdicts", () => {
  assert.deepEqual(parseDoc("---\nmodel: haiku  # cheap\nverify: bun run a && b\n---\nbody").meta, { model: "haiku", verify: "bun run a && b" })
  assert.deepEqual(parseVerdict('thinking...\n{"pass": true, "reason": "ok"}'), { pass: true, reason: "ok" })
  assert.equal(parseVerdict("looks fine").pass, false)
})

test("tickets: priority order, L waits for a lead", () => {
  const db = open(":memory:")
  addTicket(db, { project: "tally", title: "low", priority: 10 })
  const hi = addTicket(db, { project: "tally", title: "high", priority: 90 })
  addTicket(db, { project: "tally", title: "big", size: "L", priority: 99 })
  assert.equal(nextTicket(db)?.id, hi.id)
  setTicket(db, hi.id, { status: "running" })
  assert.equal(nextTicket(db)?.title, "low")
  const st = addTicket(db, { project: "shopfront", title: "shopfront", priority: 5 })
  assert.equal(nextTicket(db)?.id, st.id) // tally already has one running: the free worker takes shopfront, despite lower priority
  logRun(db, { project: "tally", kind: "build", ticket: hi.id, ok: true, output_tokens: 5 })
  assert.deepEqual(db.prepare("SELECT ticket, ok, output_tokens FROM runs").get(), { ticket: hi.id, ok: 1, output_tokens: 5 })
})

test("tickets: a child waits for its parent to ship, a missing parent is no dependency, a failed parent is reported once", () => {
  const db = open(":memory:")
  const parent = addTicket(db, { project: "tally", title: "parent", priority: 10 })
  const child = addTicket(db, { project: "tally", title: "child", priority: 90, depends_on: parent.id })
  setTicket(db, child.id, { status: "ready" })
  setTicket(db, parent.id, { status: "backlog" })
  assert.equal(nextTicket(db), undefined) // parent not shipped: child skipped
  setTicket(db, parent.id, { status: "failed" })
  assert.equal(nextTicket(db), undefined)
  assert.deepEqual(orphanedParents(db).map((o) => [o.id, o.children.map((c) => c.id)]), [[parent.id, [child.id]]])
  db.prepare("INSERT INTO kv VALUES (?, '1')").run(`dep-ping:${orphanedParents(db)[0].key}`)
  assert.equal(orphanedParents(db).length, 0)
  db.prepare("UPDATE tickets SET updated_at=? WHERE id=?").run("2099-01-01T00:00:00Z", parent.id) // re-queued and failed again
  assert.equal(orphanedParents(db).length, 1)
  setTicket(db, parent.id, { status: "shipped" })
  assert.equal(nextTicket(db)?.id, child.id) // parent shipped: child picked
  assert.equal(parentFor(db, "tally", parent.id), parent.id)
  assert.equal(parentFor(db, "shopfront", parent.id), null)
  const big = addTicket(db, { project: "tally", title: "big", size: "L" })
  setTicket(db, big.id, { status: "split" })
  assert.equal(parentFor(db, "tally", big.id), null) // a split L ticket never ships
  setTicket(db, child.id, { status: "shipped" })
  const lone = addTicket(db, { project: "tally", title: "lone", depends_on: 9999 })
  setTicket(db, lone.id, { status: "ready" })
  assert.equal(nextTicket(db)?.id, lone.id) // parent row gone: not stuck forever
})

import { judge, triage } from "../src/jev.ts"
test("jev: below floor, bad labels and errors fall back to the careful path", async () => {
  const q = { type: "choice" as const, question: "?", options: ["S", "M"], fallback: "M" }
  assert.deepEqual(judge(q, { choice: "S", confidence: 0.97 }), { value: "S", fromJev: true })
  assert.deepEqual(judge(q, { choice: "S", confidence: 0.9 }), { value: "M", fromJev: false })
  assert.deepEqual(judge(q, { choice: "XL", confidence: 0.99 }), { value: "M", fromJev: false })
  process.env.JEV_API_KEY = "test"
  const down = (async () => { throw new Error("offline") }) as unknown as typeof fetch // (key set just above)
  assert.deepEqual(await triage("Add login", "", undefined, down), { size: "M", risk: "high", fromJev: false })
  const ok = (async () => new Response(JSON.stringify({ answers: { size: { choice: "S", confidence: 0.99 }, risk: { score: 0, confidence: 0.98 } } }))) as unknown as typeof fetch
  assert.deepEqual(await triage("Fix typo in footer", "", undefined, ok), { size: "S", risk: "low", fromJev: true })
  process.env.JEV_API_KEY = ""
})

import { isDuplicate, parseGroups, titleKey } from "../src/lib.ts"
test("duplicates: exact titles caught on insert, Haiku groups parsed safely", () => {
  const db = open(":memory:")
  addTicket(db, { project: "tally", title: "Fix Zerodha owner bug!" })
  assert.equal(titleKey("Fix  zerodha OWNER bug"), "fix zerodha owner bug")
  assert.equal(isDuplicate(db, "tally", "fix zerodha owner bug"), true)
  assert.equal(isDuplicate(db, "shopfront", "fix zerodha owner bug"), false)
  assert.deepEqual(parseGroups('{"groups": [["t1","i3"], ["i9"]]}'), [["t1", "i3"]])
  assert.deepEqual(parseGroups("no idea"), [])
})

import { mergeIsBig } from "../src/jev.ts"
import { clip, parseReply, readSecrets, shortTitle, silentAt } from "../src/telegram.ts"
test("merge size: hard rules first, Jev unsure means big; Telegram secrets and quiet hours", async () => {
  process.env.JEV_API_KEY = "" // no key: never reach the real Jev from tests
  assert.equal((await mergeIsBig("x", [{ path: "apps/api/drizzle/0058_add.sql", lines: 3 }])).big, true)
  assert.equal((await mergeIsBig("x", [{ path: "apps/docs/src/content/docs/android/sort-payments.md", lines: 40 }])).big, false)
  assert.equal((await mergeIsBig("x", [{ path: "src/a.ts", lines: 500 }])).big, true)
  assert.equal((await mergeIsBig("x", [{ path: "src/a.ts", lines: 5 }])).big, false) // clearly small: no judge needed
  assert.equal((await mergeIsBig("x", [{ path: "src/a.ts", lines: 200 }])).big, true) // middle band, no key: waits
  process.env.JEV_API_KEY = "test"
  const small = (async () => new Response(JSON.stringify({ answers: { size: { choice: "small", confidence: 0.98 } } }))) as unknown as typeof fetch
  assert.equal((await mergeIsBig("Fix typo", [{ path: "src/a.ts", lines: 200 }], true, small)).big, false)
  assert.equal((await mergeIsBig("Fix typo", [{ path: "src/a.ts", lines: 200 }], false, small)).big, true)
  process.env.JEV_API_KEY = ""
  assert.deepEqual(readSecrets('TELEGRAM_BOT_TOKEN="1:abc"\n# note\nTELEGRAM_CHAT_ID=42\n'), { TELEGRAM_BOT_TOKEN: "1:abc", TELEGRAM_CHAT_ID: "42" })
  assert.deepEqual([silentAt(23), silentAt(3), silentAt(8), silentAt(14)], [true, true, false, false])
})

test("health pings Telegram only when the problems change", () => {
  assert.equal(changed(undefined, []).send, false)
  assert.equal(changed(undefined, ["disk: 9 GB"]).send, true)
  assert.equal(changed('["a","b"]', ["b", "a"]).send, false)
  assert.equal(changed('["a"]', []).send, true)
  // a new reading of the same problem is not a change
  assert.equal(changed('["disk: 11.9 GB free"]', ["disk: 11.5 GB free"]).send, false)
  assert.equal(changed('["disk: 11.9 GB free"]', ["disk: 11.5 GB free", "job x: last exit 1"]).send, true)
})

test("telegram replies: explicit ids, bare replies to a ping, and noise", () => {
  assert.deepEqual(parseReply("dobby approve 214"), { decision: "approve", id: 214 })
  assert.deepEqual(parseReply("Approved", "🟡 Ready for you: tally #213 Open sign-up"), { decision: "approve", id: 213 })
  assert.deepEqual(parseReply("no", "tally #9 x"), { decision: "decline", id: 9 })
  assert.equal(parseReply("Approved"), null) // no id anywhere
  assert.equal(parseReply("what is 214?"), null)
})

test("phone-friendly messages: plain job names, short titles, clean cuts", () => {
  assert.equal(plain("job com.acme.discover: last exit 1"), "acme discover job failed (exit 1)")
  assert.equal(plain("config com.acme.ig-refresh.plist: whatever"), "acme ig-refresh job file is broken")
  assert.equal(shortTitle("Rename the people in the demo seed (apps/api/src/db/seed/demo.ts, users.ts): no real names"), "Rename the people in the demo seed")
  assert.equal(clip("one two three four", 10), "one two…")
  assert.equal(clip("short", 10), "short")
})

import { applyPlan, buildLeadGraph, leadDue, parsePlan, type Plan } from "../src/graphs/lead.ts"
import { buildCosGraph, fallbackBrief, gather, noMoney, type Facts } from "../src/graphs/cos.ts"
import { buildTicketGraph } from "../src/graphs/ticket.ts"
import type { Project } from "../src/lib.ts"
const backlog = (db: ReturnType<typeof open>, title: string, size = "S") => {
  const { id } = addTicket(db, { project: "tally", title, size })
  setTicket(db, id, { status: "backlog" })
  return id
}
const status = (db: ReturnType<typeof open>, id: number) => (db.prepare("SELECT status FROM tickets WHERE id=?").get(id) as { status: string }).status

test("lead: owner-only work, L tickets and bad ids never become ready", () => {
  const db = open(":memory:")
  const owner = backlog(db, "Owner: confirm the listing")
  const deploy = backlog(db, "Deploy the admin console")
  const mig = backlog(db, "Add column via migration 0059")
  const big = backlog(db, "Rebuild import", "L")
  const ok = backlog(db, "Fix footer typo")
  const plan: Plan = { promote: [owner, deploy, mig, big, ok, 999], new: [{ title: "Split import into steps", size: "L", why: "too big" }, { title: "Run the db migrate script", size: "S" }, { title: "Rotate the Play Console token", size: "S" }], note: "" }
  const a = applyPlan(db, "tally", plan)
  // balanced safety: only an Owner: marker and a release (Play Console) wait for the owner; deploys and migrations are judged by files at land time
  assert.deepEqual([owner, big].map((id) => status(db, id)), ["backlog", "backlog"])
  assert.deepEqual([deploy, mig, ok].map((id) => status(db, id)), ["ready", "ready", "ready"])
  assert.equal(a.needsOwner.length, 2)
  assert.match(a.created[0], /\(backlog, L\)/) // a new L ticket is written, but waits in the backlog
  assert.equal(a.skipped.some((s) => s.startsWith("#999")), true)
})

test("lead: at most 6 promoted + 3 new, ready queue capped at 8, duplicates skipped, dry changes nothing", () => {
  const db = open(":memory:")
  const ids = [1, 2, 3, 4, 5, 6, 7].map((i) => backlog(db, `Task ${i}`))
  const fresh = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `New ${i}`, size: "S", done_when: "test passes" }))
  const dry = applyPlan(db, "tally", { promote: ids, new: [{ title: "task 1!" }, ...fresh(4)], note: "" }, true)
  assert.equal(dry.promoted.length, 6)
  assert.equal(dry.created.length, 3)
  assert.equal(dry.skipped.some((s) => s.includes("duplicate")), true)
  assert.equal(dry.created.filter((c) => c.includes("(ready")).length, 2) // 6 promoted + 2 new = queue full
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status='ready'").get() as { n: number }).n, 0)
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n, 7)
  const real = applyPlan(db, "tally", { promote: ids, new: fresh(4), note: "" })
  assert.deepEqual([real.promoted.length, real.created.length], [6, 3])
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status='ready'").get() as { n: number }).n, 8)
  assert.deepEqual(parsePlan('thinking\n{"promote":[4,"x"],"new":[{"title":"A"},{"nope":1}],"note":"n"}'), { promote: [4], new: [{ title: "A" }], note: "n" })
  assert.equal(parsePlan("no plan"), null)
})

test("lead, cos and ticket graphs compile", () => { buildTicketGraph(open(":memory:")).compile()
  buildLeadGraph(open(":memory:")).compile()
  buildCosGraph(open(":memory:")).compile()
})

test("lead: paused projects and queues above the low-water mark are skipped, 10 minutes between runs, an empty run sleeps", () => {
  const db = open(":memory:")
  const p = (name: string, paused = false) => ({ name, paused } as Project)
  const projects = { tally: p("tally"), shopfront: p("shopfront", true), busy: p("busy") }
  for (const t of ["q1", "q2", "q3", "q4"]) addTicket(db, { project: "busy", title: t })
  assert.deepEqual(leadDue(db, projects).map((x) => x.name), ["tally"])
  db.prepare("INSERT INTO kv VALUES ('lead-at:tally', ?)").run(String(Date.now() - 300_000))
  assert.deepEqual(leadDue(db, projects), [])
  assert.deepEqual(leadDue(db, projects, Date.now() + 10 * 60_000).map((x) => x.name), ["tally"])
  db.prepare("INSERT OR REPLACE INTO kv VALUES ('lead-noop:tally', ?)").run(`${Date.now()}:0`) // last run found nothing and the backlog is still empty
  assert.deepEqual(leadDue(db, projects, Date.now() + 10 * 60_000), [])
  assert.deepEqual(leadDue(db, projects, Date.now() + 7 * 3600_000).map((x) => x.name), ["tally"]) // 6 h later it looks again
})

test("idle window: under 30% at the midpoint fires, 30% or more does not; the Lead then tops up a short queue", () => {
  const half = 2.5 * 3600_000, u = { weekUsed: 20, weekMsToReset: 3 * 86_400_000 }
  assert.equal(windowIdle({ ...u, fiveUsed: 29, fiveMsToReset: half }), true)
  assert.equal(windowIdle({ ...u, fiveUsed: 30, fiveMsToReset: half }), false)
  assert.equal(windowIdle({ ...u, fiveUsed: 10, fiveMsToReset: half + 60_000 }), false) // before the midpoint
  assert.equal(windowIdle({ ...u, fiveUsed: 10 }), false) // reset time unknown
  const db = open(":memory:")
  const projects = { tally: { name: "tally", paused: false } as Project }
  for (const t of ["a", "b", "c", "d"]) addTicket(db, { project: "tally", title: t })
  assert.deepEqual(leadDue(db, projects), []) // normally a queue at the low-water mark needs no Lead
  assert.deepEqual(leadDue(db, projects, Date.now(), true).map((x) => x.name), ["tally"])
  for (const t of ["e", "f", "g", "h"]) addTicket(db, { project: "tally", title: t })
  assert.deepEqual(leadDue(db, projects, Date.now(), true), []) // queue already at READY_CAP
})

test("cos: the template always has the three sections and no money amounts", () => {
  const db = open(":memory:")
  const { id } = addTicket(db, { project: "tally", title: "Show $500 left and ₹1,200 spent (apps/web/x.tsx)" })
  setTicket(db, id, { status: "shipped", note: "https://github.com/ownerdev/tally/pull/600" })
  addTicket(db, { project: "tally", title: "Budget alert at Rs 5000" })
  db.prepare("INSERT INTO kv VALUES (?, ?)").run(`lead:tally:${new Date().toLocaleDateString("sv")}`, "Lead · tally\nnote: queue refilled\nneeds owner: #9 Deploy it")
  logRun(db, { project: "tally", kind: "build", ok: true, cost_usd: 1.5 })
  const f: Facts = gather(db, { tally: { name: "tally", paused: false } as Project, shopfront: { name: "shopfront", paused: true } as Project }, { fiveUsed: 4, weekUsed: 25, weekMsToReset: 1 })
  const brief = fallbackBrief(f)
  for (const s of ["Do first", "Shipped", "Building today", "Shopfront paused", "Deploy it"]) assert.ok(brief.includes(s), s)
  assert.ok(brief.startsWith("Do first: Tally: Deploy it"), brief)
  assert.ok(!/[$₹]/.test(brief) && !/Rs 5000/.test(brief), brief)
  assert.ok(brief.split("\n").length <= 12)
  assert.equal(noMoney("left $500, ₹1,200.50 and INR 3k; 500 households"), "left [amount], [amount] and [amount]; 500 households")
})

test("ship policy: schema-only migrations deploy on their own, data changes wait for the owner", async () => {
  const { changesData } = await import("../src/deploy.ts")
  assert.equal(changesData("CREATE TABLE app_settings (k text primary key, v text);\nALTER TABLE users ADD COLUMN cap int;"), false)
  assert.equal(changesData("CREATE INDEX ix ON t(a); -- update later"), false) // comments ignored
  assert.equal(changesData("UPDATE users SET plan = 'free' WHERE plan IS NULL;"), true)
  assert.equal(changesData("INSERT INTO settings VALUES ('cap', '500');"), true)
  assert.equal(changesData("ALTER TABLE t DROP COLUMN old;"), true)
  assert.equal(changesData("DROP TABLE legacy;"), true)
})

test("front desk memory: last 10 messages within 2 hours", async () => {
  const { recent } = await import("../src/telegram.ts")
  const now = 10 * 3600_000
  const msgs = [{ at: now - 3 * 3600_000, who: "you", text: "old" }, ...Array.from({ length: 12 }, (_, i) => ({ at: now - 60_000, who: "you", text: `m${i}` }))]
  const r = recent(JSON.stringify(msgs), now)
  assert.equal(r.length, 10)
  assert.ok(!r.some((m) => m.text === "old"))
  assert.equal(recent(undefined, now).length, 0)
})

test("evening digest: plain summaries and PR links, or a clear nothing", async () => {
  const { digest } = await import("../src/telegram.ts")
  assert.equal(digest([], () => undefined), "🌙 Today: nothing merged.")
  const d = digest([{ id: 46, project: "tally", title: "Zerodha connect saves every account under user_1: fix", note: "https://github.com/x/pull/9" }], () => "• Each person's Zerodha shows under them")
  for (const s of ["Shipped today: Tally 1", "• Zerodha connect saves every account under user_1", "Nothing goes live"]) assert.ok(d.includes(s), s)
})

test("capacity: windows recorded by reset time, advice from the week", async () => {
  const { capacityLine, noteWindow, open: openDb } = await import("../src/db.ts")
  const db = openDb(":memory:")
  noteWindow(db, 40, 3_600_000, {}, 0); noteWindow(db, 65, 3_000_000, { paused: true }, 600_000); noteWindow(db, 50, 3_600_000, { build: true }, 0)
  assert.deepEqual(db.prepare("SELECT peak, paused, builds FROM windows").all(), [{ peak: 65, paused: 1, builds: 1 }])
  assert.match(capacityLine([{ peak: 100, paused: 0, builds: 3 }, { peak: 99, paused: 0, builds: 2 }, { peak: 98, paused: 1, builds: 1 }]), /3 maxed out.*hit the limit often/)
  assert.match(capacityLine([{ peak: 62, paused: 1, builds: 1 }, { peak: 61, paused: 1, builds: 1 }, { peak: 63, paused: 1, builds: 0 }]), /raise the daytime cap/)
  assert.equal(capacityLine([]), "")
})

test("empty diff: the Builder's ALREADY DONE closes, BLOCKED parks, silence gets one told-off rebuild", async () => {
  const { emptyDiff } = await import("../src/graphs/ticket.ts")
  assert.equal(emptyDiff("Checked.\nALREADY DONE: grep finds no 'coming soon' in apps/docs").reason, "already done")
  assert.equal(emptyDiff("**BLOCKED:** writes to .claude/ are denied").reason, "blocked")
  assert.match(emptyDiff("BLOCKED: denied").feedback, /^BLOCKED: denied/)
  assert.equal(emptyDiff("Updated the docs.").reason, "nothing committed")
})

test("build session: fresh when the branch has no commits (a resumed session would remember lost edits), else per freshRetries", async () => {
  const { freshSession } = await import("../src/graphs/ticket.ts")
  assert.equal(freshSession("", 1), true)
  assert.equal(freshSession("abc1234 foreman #5: add x\n src/x.ts | 3 +", 1), false) // work on the branch: resume it
  assert.equal(freshSession("abc1234 foreman #5: add x", 1, true), true)
  assert.equal(freshSession("abc1234 foreman #5: add x", 0, true), false)
})

test("nothing new: a fix on an open PR counts commits on top of the PR head, not the diff against base", async () => {
  const { nothingNew } = await import("../src/graphs/ticket.ts")
  const cmds: string[] = []
  const sh = (n: string) => async (cmd: string) => (cmds.push(cmd), { ok: true, out: `${n}\n` })
  assert.equal(await nothingNew(sh("0"), "/wt", "+the PR's own change", "foreman/7-x"), true) // the PR's diff is not the fix's
  assert.equal(cmds[0], "git rev-list --count origin/foreman/7-x..HEAD")
  assert.equal(await nothingNew(sh("1"), "/wt", "", "foreman/7-x"), false)
  assert.equal(await nothingNew(sh("0"), "/wt", "+a line", null), false) // a normal ticket: the diff decides
  assert.equal(await nothingNew(sh("0"), "/wt", "  \n", null), true)
})

test("checker prompt: fixed text first, ticket and diff only after the shared prefix", async () => {
  const { checkPrompt } = await import("../src/graphs/ticket.ts")
  const body = "You are the Checker. Pass or fail the diff against DONE WHEN."
  const a = checkPrompt(body, { title: "Add alpha button", doneWhen: "alpha shows", verify: "npm test", baseNote: "", summary: "did alpha", diff: "+alpha line" })
  const b = checkPrompt(body, { title: "Fix beta crash", doneWhen: "beta stays up", verify: "npm test", baseNote: "1 test also fails on base", summary: "did beta", diff: "+beta line" })
  let n = 0
  while (a[n] === b[n]) n++
  assert.ok(n >= body.length, "the whole role text is in the shared prefix")
  assert.ok(a.indexOf("alpha") >= n && b.indexOf("beta") >= n, "ticket and diff text come after the shared prefix")
})

/** Length of the shared prefix of two strings. */
const sharedPrefix = (a: string, b: string) => { let n = 0; while (a[n] === b[n]) n++; return n }

test("builder prompt: role text and project rules first, ticket text only after the shared prefix", async () => {
  const { buildPrompt } = await import("../src/graphs/ticket.ts")
  const role = "You are a Builder. Do only what the ticket asks.", rules = "## Goal\nRun overnight."
  const x = { rules, verify: "npm test", retry: "", work: "" }
  const a = buildPrompt(role, { ...x, id: 1, title: "Add alpha button", doneWhen: "alpha shows", prd: "alpha prd", design: "alpha spec" })
  const b = buildPrompt(role, { ...x, id: 2, title: "Fix beta crash", doneWhen: "beta stays up", prd: "beta prd", design: null, work: "abc beta work" })
  const n = sharedPrefix(a, b)
  assert.ok(n >= `${role}\n\nPROJECT RULES (dobby.md):\n${rules}\n\nTICKET #`.length, "role and rules are in the shared prefix")
  assert.ok(a.indexOf("alpha") >= n && b.indexOf("beta") >= n, "ticket text comes after the shared prefix")
})

test("lead prompt: role text and Monday block first, the board only after the shared prefix", async () => {
  const { leadPrompt } = await import("../src/graphs/lead.ts")
  const role = "You are the Engineering Manager for {project}. You PLAN and ASSIGN."
  const a = leadPrompt(role, "tally", true, "READY:\n#1 alpha")
  const b = leadPrompt(role, "tally", true, "READY:\n#2 beta")
  const n = sharedPrefix(a, b)
  assert.ok(n >= role.replace("{project}", "tally").length, "the whole role text is in the shared prefix")
  assert.ok(a.indexOf("alpha") >= n && b.indexOf("beta") >= n, "board text comes after the shared prefix")
})

test("pm prompt: role text first, today's board only after the shared prefix", async () => {
  const { pmPrompt } = await import("../src/graphs/product.ts")
  const role = "You are the Product Manager for {project}. You decide WHICH PROBLEMS are worth solving."
  const a = pmPrompt(role, "tally", "", "OPEN TICKETS:\n#1 alpha")
  const b = pmPrompt(role, "tally", "", "OPEN TICKETS:\n#2 beta")
  const n = sharedPrefix(a, b)
  assert.ok(n >= role.replace("{project}", "tally").length, "the whole role text is in the shared prefix")
  assert.ok(a.indexOf("alpha") >= n && b.indexOf("beta") >= n, "board text comes after the shared prefix")
})

test("reviewer prompt: the role file has no per-PR placeholders; range, PR and title come after the shared prefix", async () => {
  const { reviewPrompt } = await import("../src/graphs/review.ts")
  const { loadRole } = await import("../src/lib.ts")
  const body = loadRole("reviewer").body
  assert.ok(!/\{(range|scope|base)\}/.test(body), "no placeholder left in the role text")
  const a = reviewPrompt(body, { range: "origin/main...HEAD", scope: "the whole PR", base: "origin/main", pr: 1, repo: "o/alpha", title: "Add alpha", only: "" })
  const b = reviewPrompt(body, { range: "abc1234..HEAD", scope: "only what changed since abc1234", base: "origin/dev", pr: 2, repo: "o/beta", title: "Fix beta", only: "" })
  const n = sharedPrefix(a, b)
  assert.ok(n >= body.length, "the whole role text is in the shared prefix")
  assert.ok(a.indexOf("alpha") >= n && b.indexOf("beta") >= n && b.indexOf("abc1234") >= n, "per-PR text comes after the shared prefix")
})

test("verify: failing test names are read from bun output; failures also on base are not the Builder's", async () => {
  const { failedTests } = await import("../src/graphs/ticket.ts")
  const out = [
    "@tally/parsers:test: (pass) parseHdfc > reads rows [0.4ms]",
    "@tally/parsers:test: (fail) readGeneralStatement — generated statements > kotak > reads every row, with the balance after it [0.62ms]",
    "@tally/parsers:test: (fail) readGeneralStatement — generated statements > kotak > reads every row, with the balance after it [0.70ms]", // same test twice: kept once
    "(fail) readGeneralStatement",
    "@tally/parsers:test:  1 fail",
  ].join("\n")
  const mine = failedTests(out)
  assert.deepEqual(mine, ["readGeneralStatement — generated statements > kotak > reads every row, with the balance after it", "readGeneralStatement"])
  assert.deepEqual(failedTests("error: Cannot find name 'x'\ntypecheck failed"), []) // a non-test failure is never excused
})

test("verify: worktree runs set DOBBY_WORKTREE for the whole command; known-broken failures reach the ticket note", async () => {
  const { inWorktree, knownBroken, ticketBrokenOnBase } = await import("../src/graphs/ticket.ts")
  const db = open(":memory:")
  const p = { base: "main", verify: "bun test" }
  ticketBrokenOnBase(db, "tally", p, ["parseHdfcSavingsPdf live file", "other"])
  ticketBrokenOnBase(db, "tally", p, ["parseHdfcSavingsPdf live file"]) // a later run: no second ticket
  ticketBrokenOnBase(db, "shopfront", p, ["other"]) // another project gets its own
  const rows = db.prepare("SELECT project, title FROM tickets ORDER BY id").all() as { project: string; title: string }[]
  assert.equal(rows.length, 3)
  assert.equal(rows[0].title, "Fix test failing on main: parseHdfcSavingsPdf live file")
  assert.equal(sh(inWorktree('true && echo "w=$DOBBY_WORKTREE"'), ".").out.trim(), "w=1") // a && chain keeps the variable
  assert.equal(knownBroken({}), "")
  assert.match(knownBroken({ baseNote: "1 failing test(s) also fail on origin/main" }), /^\nKnown-broken on base/)
})

test("stuck loop: same complaint twice is stuck; out-of-scope files come from git's list; unwired work gets told how to wire; one blip is not an alert", async () => {
  const { failKey, outOfScopePaths, wiringHint } = await import("../src/graphs/ticket.ts")
  assert.equal(failKey("Out-of-scope edit at statement.ts:292"), failKey("out-of-scope edit at statement.ts:310")) // line numbers differ, same complaint
  assert.notEqual(failKey("Nothing is wired"), failKey("Out-of-scope edit"))
  const changed = ["packages/parsers/src/general/statement.ts", "apps/mobile/src/lib/a.ts"]
  assert.deepEqual(outOfScopePaths("Out-of-scope edits at packages/parsers/src/general/statement.ts:292 and ../../etc/passwd.json", changed), ["packages/parsers/src/general/statement.ts"])
  assert.deepEqual(outOfScopePaths("Out-of-scope: nothing here", changed), [])
  assert.match(wiringHint("Nothing is wired: share-capture-core.ts is imported only by its own test"), /connect it/)
  assert.equal(wiringHint("Out-of-scope edit"), "")
  const { confirmed } = await import("../src/health.ts")
  assert.deepEqual(confirmed(["job a: last exit 1", "job b: last exit 1"], ["job a: last exit 1"]), ["job a: last exit 1"])
  assert.deepEqual(confirmed(["job a: last exit 1"], []), [])
  assert.deepEqual(confirmed(["disk: 11.5 GB free"], ["disk: 11.9 GB free"]), ["disk: 11.5 GB free"])
})

test("signed out: an expired Claude login is recognised, an ordinary failed build is not", async () => {
  const { signedOut } = await import("../src/lib.ts")
  assert.equal(signedOut({ ok: false, reason: "Failed to authenticate: OAuth session expired and could not be refreshed", text: "" }), true)
  assert.equal(signedOut({ ok: false, reason: "unparsable output (exit 1): ", text: "" }), false)
  assert.equal(signedOut({ ok: true, text: "Please run /login" }), false) // a build that succeeded is never "signed out"
})

test("did not start: a failed claude spawn is recognised, a build that ran and failed is not", async () => {
  const { didNotStart } = await import("../src/graphs/ticket.ts")
  assert.equal(didNotStart({ ok: false, reason: "spawn: spawn claude ENOENT" }), true)
  assert.equal(didNotStart({ ok: false, reason: "error_max_turns" }), false)
  assert.equal(didNotStart({ ok: true, reason: "spawn: x" }), false)
})

test("board: tickets mirror to issues and one Stage column each; closed on ship; PR body closes the issue", async () => {
  const { syncBoard, closesLine, stageOf } = await import("../src/board.ts")
  const db = open(":memory:")
  const calls: string[] = []
  let n = 0
  const run = (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.slice(0, 2).join(" ")}`)
    if (cmd === "git") return { ok: true, out: "https://github.com/acmeorg/tally.git\n" }
    if (args[1] === "create" && args[0] === "project") return { ok: true, out: JSON.stringify({ id: "P1", number: 3, url: "u" }) }
    if (args[1] === "field-create") return { ok: true, out: JSON.stringify({ id: "F1", options: ["Backlog", "Ready", "Building", "In review", "Shipped", "Failed", "Declined"].map((name) => ({ name, id: `o-${name}` })) }) }
    if (args[1] === "item-add") return { ok: true, out: JSON.stringify({ id: `I${++n}` }) }
    if (args[0] === "issue" && args[1] === "create") return { ok: true, out: `https://github.com/acmeorg/tally/issues/${40 + ++n}\n` }
    return { ok: true, out: "" }
  }
  const a = addTicket(db, { project: "tally", title: "Reader", priority: 99 })
  addTicket(db, { project: "tally", title: "Old", priority: 1 })
  db.prepare("UPDATE tickets SET status='shipped' WHERE title='Old'").run()
  assert.equal(stageOf("running"), "Building")
  assert.equal(stageOf("split"), "Declined") // split into children: closed, not left open in Backlog
  syncBoard(db, { run })
  assert.equal(calls.filter((c) => c === "gh issue create").length, 1) // shipped history stays off the board
  assert.match(closesLine(db, a.id), /^\nCloses acmeorg\/tally#\d+$/)
  calls.length = 0
  syncBoard(db, { run })
  assert.deepEqual(calls.filter((c) => c.startsWith("gh") && !c.includes("/milestones?")), []) // nothing changed: no GitHub calls but the goals read
  setTicket(db, a.id, { status: "shipped" })
  syncBoard(db, { run, only: a.id })
  assert.ok(calls.includes("gh issue close") && calls.includes("gh project item-edit"))
})

test("deploy lock: a dead holder frees it; a live or old-format holder keeps it", async () => {
  const { alive } = await import("../src/deploy.ts")
  assert.equal(alive(process.pid), true)
  assert.equal(alive(2 ** 22 + 12345), false) // above macOS/Linux pid_max: never a live process
  assert.equal(alive(undefined), true)
})

test("build preflight: a ticket naming a path in another repo stops with 'targets other repo', in-repo paths still build", async () => {
  const { preflight } = await import("../src/graphs/ticket.ts")
  const { mkdtempSync, mkdirSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { execSync } = await import("node:child_process")
  const repo = `${mkdtempSync(`${tmpdir()}/pf-`)}/foreman`
  mkdirSync(`${repo}/src/graphs`, { recursive: true })
  execSync("git init -q -b main && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m init && git update-ref refs/remotes/origin/main HEAD", { cwd: repo, stdio: "pipe" })
  // #357 and #369 failed: the ticket named code in shopfront while building in a foreman worktree
  assert.equal(await preflight(repo, "main", "Fix the landing copy\nDONE WHEN: ~/projects/shopfront/src/content/landing.ts has the new headline"), "targets other repo: shopfront")
  assert.equal(await preflight(repo, "main", `Update docs\nDONE WHEN: ${process.env.HOME}/projects/tally/README.md mentions Dobby`), "targets other repo: tally")
  assert.equal(await preflight(repo, "main", "Fix it\nDONE WHEN: ~/projects/foreman/src/graphs/ticket.ts and src/lib.ts are changed"), "") // own repo
  assert.equal(await preflight(repo, "main", "Fix it\nDONE WHEN: the headline is fixed in ~/projects/foreman."), "") // sentence-ending dot is not part of the name
  assert.equal(await preflight(repo, "main", "Deploy of ~/projects/tally skips migrations\nDONE WHEN: src/deploy.ts runs them for ~/projects/tally"), "") // other repo is only context
  assert.equal(await preflight(repo, "main", "Port retry logic\nDONE WHEN: ~/projects/foreman/src/lib.ts matches ~/projects/tally/src/retry.ts"), "") // own absolute path counts as work here
  assert.equal(await preflight(repo, "main", "Fix the landing copy\nDONE WHEN: ~/projects/shopfront/src/content/landing.ts has the new headline, e.g. 'Ship faster', UI/UX and/or client/server"), "targets other repo: shopfront") // prose is not a path
  assert.equal(await preflight(repo, "main", "Port retry logic\nDONE WHEN: ~/projects/tally/src/retry.ts logic lives under src/graphs/"), "") // directory-only local path
  assert.equal(await preflight(repo, "main", "Copy\nDONE WHEN: ~/projects/tally/README.md section is copied into README.md"), "")
  assert.equal(await preflight(repo, "main", "Fix toggle\nDONE WHEN: ~/projects/shopfront/src/landing.ts toggle switches on/off, see shopfront.com/pricing"), "targets other repo: shopfront")
  assert.equal(await preflight(repo, "main", "Fix copy\nDONE WHEN: ~/projects/shopfront/src/landing.ts renders in the Next.js page, see ../shopfront/"), "targets other repo: shopfront")
  assert.equal(await preflight(repo, "main", "Port ~/projects/tally/src/retry.ts into index.js"), "")
  assert.equal(await preflight(repo, "main", "Port ~/projects/tally/src/Button.tsx into App.jsx"), "")
  assert.equal(await preflight(repo, "main", "Port ~/projects/tally/src/retry.ts logic into ./src/graphs/"), "")
  assert.equal(await preflight(repo, "main", "Fix src/graphs/ticket.ts"), "")
})
test("build preflight: a repo without origin/main is named, dirty files the ticket mentions are named, a clean repo passes", async () => {
  const { preflight } = await import("../src/graphs/ticket.ts")
  const { mkdtempSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { execSync } = await import("node:child_process")
  const repo = mkdtempSync(`${tmpdir()}/preflight-`)
  const git = (c: string) => execSync(`git ${c}`, { cwd: repo, stdio: "pipe" })
  git("init -q -b main"); writeFileSync(`${repo}/a.ts`, "1"); git("add ."); git("-c user.email=a@b -c user.name=a commit -qm init")
  assert.match(await preflight(repo, "main", "edit a.ts"), /origin\/main is missing/) // no remote yet
  git("update-ref refs/remotes/origin/main HEAD")
  assert.equal(await preflight(repo, "main", "edit a.ts"), "") // clean
  writeFileSync(`${repo}/a.ts`, "2"); writeFileSync(`${repo}/b.ts`, "x")
  assert.match(await preflight(repo, "main", "edit a.ts"), /uncommitted changes in a\.ts/)
  assert.equal(await preflight(repo, "main", "edit c.ts"), "") // dirty files the ticket does not name are the owner's
})


test("checker tools: read-only by default; a UI done rule adds only the Playwright screenshot command", async () => {
  const { checkerArgs } = await import("../src/graphs/ticket.ts")
  assert.deepEqual(checkerArgs("parser keeps the sign of amounts"), ["--setting-sources", "project", "--tools", "Read,Grep,Glob"])
  assert.deepEqual(checkerArgs(null), ["--setting-sources", "project", "--tools", "Read,Grep,Glob"])
  const ui = checkerArgs("docs page has no horizontal scroll at 375px and 768px widths").join(" ")
  assert.match(ui, /Bash\(npx playwright screenshot:\*\)/)
  assert.doesNotMatch(ui, /Bash\(npx:|Bash\(bun:|Edit|Write/)
})

test("doctor: each check passes on healthy rows and fails on its own problem", async () => {
  const { doctor } = await import("../src/lib.ts")
  const at = Date.parse("2026-10-21T12:00:00Z")
  const ago = (ms: number) => new Date(at - ms).toISOString()
  const good = { tickets: [{ id: 1, status: "running", updated_at: ago(3600_000) }], pauses: [{ text: "all", at: at - 86_400_000 }], origins: [{ project: "p", base: "main", ok: true }], auth: { ok: true } }
  const failing = (i: Parameters<typeof doctor>[0]) => doctor(i, at).filter((c) => !c.ok).map((c) => c.name)
  assert.deepEqual(failing(good), [])
  assert.deepEqual(failing({ ...good, tickets: [{ id: 2, status: "running", updated_at: ago(3 * 3600_000) }] }), ["stuck tickets"])
  assert.deepEqual(failing({ ...good, tickets: [{ id: 3, status: "failed", updated_at: ago(3 * 3600_000) }] }), [])
  assert.deepEqual(failing({ ...good, origins: [{ project: "p", base: "main", ok: false }] }), ["origin/base"])
  assert.deepEqual(failing({ ...good, auth: { ok: false, reason: "OAuth session expired" } }), ["claude session"])
  assert.deepEqual(failing({ ...good, auth: { ok: false, reason: "stalled" } }), ["claude session"])
  assert.deepEqual(failing({ ...good, pauses: [{ text: "project tally", at: at - 8 * 86_400_000 }] }), ["old pauses"])
  // review scan: a skip is shown, not failed; no scan for 2 hours fails
  const skipped = doctor({ ...good, scan: { at: at - 600_000, todo: 4, reviewed: 1, skipped: "5-hour window at 61% (pace cap 60%)" } }, at).find((c) => c.name === "review scan")!
  assert.equal(skipped.ok, true)
  assert.match(skipped.detail, /reviewed 1 of 4; skipped the rest: 5-hour window at 61%/)
  assert.deepEqual(failing({ ...good, scan: { at: at - 3 * 3600_000, todo: 0, reviewed: 0, skipped: "" } }), ["review scan"])
})

test("review budget: a looser reviewCap lets reviews run past the builders' cap, never into the owner's last 5% of the week", async () => {
  const { reviewBudget } = await import("../src/lib.ts")
  const no = { ok: false, why: "5-hour window at 65% (pace cap 60%)", cap: 60 }
  const u = (fiveUsed: number, weekUsed = 40) => ({ fiveUsed, weekUsed, weekMsToReset: 3 * 86_400_000 })
  assert.equal(reviewBudget(no, u(65)).ok, false) // no reviewCap: the builders' answer, as before
  assert.equal(reviewBudget(no, u(65), 80).ok, true)
  assert.equal(reviewBudget(no, u(82), 80).ok, false)
  assert.equal(reviewBudget({ ...no, why: "weekly at 96%" }, u(65, 96), 80).ok, false)
  assert.equal(reviewBudget(no, u(65), 50).ok, false) // a reviewCap under the builders' cap never tightens or loosens
})

test("orphanPids: processes from a deleted worktree, not from live ones, foreign paths or Dobby itself", () => {
  const wt = "/d/wt"
  const ps = [
    "  101 /d/wt/shopfront-577/studio/node_modules/workerd serve --binary",
    "  102 /d/wt/tally-749/node_modules/.bin/wrangler dev",
    "  103 node /d/wt/shopfront-577 something",
    "  104 /usr/bin/node /elsewhere/wt/shopfront-577/x",
    "  105 node /d/wt/shopfront-577/x",
    "",
  ].join("\n")
  assert.deepEqual(orphanPids(ps, wt, (d) => d === "/d/wt/tally-749", 105), [101, 103])
})

test("prDone: a merged or closed PR on the branch ends its fix ticket; open, none or unreadable builds as before", async () => {
  const at = (out: string, ok = true) => async () => ({ ok, out })
  assert.equal(await prDone("/nowhere", "fix/x", at("MERGED\n")), "MERGED")
  assert.equal(await prDone("/nowhere", "fix/x", at("CLOSED\n")), "CLOSED")
  assert.equal(await prDone("/nowhere", "fix/x", at("OPEN\n")), null)
  assert.equal(await prDone("/nowhere", "fix/x", at("")), null)
  assert.equal(await prDone("/nowhere", "fix/x", at("MERGED", false)), null)
})

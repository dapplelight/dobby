// 20 Oct audit fixes: queue starvation, policy false positives, queueTicket, status board + metrics, builder routing, usage reading.
// Offline: temp data dir, temp HOME for projects, :memory: databases, Jev forced to its fallback. Never reaches Discord, GitHub or the live data.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-fixq-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/s.txt`
writeFileSync(process.env.DOBBY_SECRETS, "")
process.env.JEV_API_KEY = "" // forces every Jev decision to its fallback
const { open, logRun } = await import("../src/db.ts")
const L = await import("../src/lib.ts")
const { decide, loadRules, DEFAULT_RULES } = await import("../src/policy.ts")
const lead = await import("../src/graphs/lead.ts")
const view = await import("../src/view.ts")
const usage = await import("../src/usage.ts")
const D = await import("../src/dashboard.ts")
const { digest } = await import("../src/telegram.ts")

type DBt = ReturnType<typeof open>
const mk = (db: DBt, o: { project?: string; title: string; done_when?: string; size?: string; priority?: number; status?: string; goal?: number | null; note?: string; onto?: string; updated?: string }) => {
  const { id } = L.addTicket(db, { project: o.project ?? "tally", title: o.title, done_when: o.done_when ?? "", size: o.size ?? "S", priority: o.priority ?? 50, onto: o.onto, goal: o.goal ?? null })
  db.prepare("UPDATE tickets SET status=?, note=?, updated_at=COALESCE(?, updated_at) WHERE id=?").run(o.status ?? "backlog", o.note ?? null, o.updated ?? null, id)
  return id
}
const status = (db: DBt, id: number) => (db.prepare("SELECT status FROM tickets WHERE id=?").get(id) as { status: string }).status
const kv = (db: DBt, k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v

// ---- 2. policy ---------------------------------------------------------------------------------------------------------------------

test("policy: client-invite and client-name apply to shopfront only; the owner marker stays global", () => {
  const t = "Couple check-in screen for household budgets"
  assert.equal(decide("ticket-text", t, undefined, { project: "tally", title: t }).action, "allow")
  assert.equal(decide("ticket-text", t, undefined, { project: "shopfront", title: t }).rule, "client-invite")
  assert.equal(decide("ticket-text", t).rule, "client-invite", "no project given: the rule applies, as before")
  assert.equal(decide("ticket-text", "Fix Orion's wedding page", undefined, { project: "shopfront" }).action, "deny")
  assert.equal(decide("ticket-text", "Fix Orion's wedding page", undefined, { project: "tally" }).action, "allow")
  assert.equal(decide("ticket-text", "Owner: pick a name", undefined, { project: "tally" }).rule, "owner-marker")
  assert.equal(decide("ticket-text", "Add a secret scanner", undefined, { project: "tally" }).rule, "secrets", "other soft rules stay global")
})

test("policy: deploy / migrate / production / release flag the title only, never done_when", () => {
  const title = "Show the monthly summary", done = "ready for release; no production changes; migration not needed"
  assert.equal(decide("ticket-text", `${title} ${done}`, undefined, { project: "tally", title }).action, "allow")
  assert.equal(decide("ticket-text", `${title} ${done}`).rule, "ship", "no title given: the whole text is read, as before")
  const bad = "Publish the Play Store release"
  assert.equal(decide("ticket-text", `${bad} nothing`, undefined, { project: "tally", title: bad }).rule, "ship")
  // other soft words still read done_when
  assert.equal(decide("ticket-text", `${title} rotate the api token`, undefined, { project: "tally", title }).rule, "secrets")
})

test("policy: rules carry optional projects; policy.json may add a scoped rule, a bad projects field is ignored", () => {
  assert.deepEqual(DEFAULT_RULES.filter((r) => r.projects).map((r) => [r.id, r.projects]), [["client-name", ["shopfront"]], ["client-invite", ["shopfront"]]])
  const f = `${mkdtempSync(`${tmpdir()}/policy-`)}/policy.json`
  writeFileSync(f, JSON.stringify([{ id: "x", applies: "ticket-text", match: "zebra", action: "ask", why: "w", projects: ["tally"] }]))
  const r = loadRules(f).rules
  assert.equal(decide("ticket-text", "zebra", r, { project: "tally" }).rule, "x")
  assert.equal(decide("ticket-text", "zebra", r, { project: "shopfront" }).rule, "default")
  writeFileSync(f, JSON.stringify([{ id: "x", applies: "ticket-text", match: "zebra", action: "ask", why: "w", projects: "tally" }]))
  assert.match(loadRules(f).error ?? "", /policy\.json ignored/)
})

// ---- 1. queue starvation -------------------------------------------------------------------------------------------------------------

test("lead: the backlog splits into pickable and owner-only; a cached Jev verdict frees a flagged ticket until it is edited", () => {
  const db = open(":memory:")
  const plain = mk(db, { title: "Add a copy button" })
  const flagged = mk(db, { title: "Submit the Play Store release", priority: 90 })
  const hard = mk(db, { title: "Owner: confirm the listing" })
  let s = L.splitBacklog(db, "tally")
  assert.deepEqual(s.pickable.map((t) => t.id), [plain])
  assert.deepEqual(s.owner.map((t) => t.id).sort(), [flagged, hard].sort())
  assert.deepEqual(s.unjudged.map((t) => t.id), [flagged], "a hard rule is never asked about")
  db.prepare("INSERT INTO kv VALUES (?, ?)").run(L.verdictKey(flagged), JSON.stringify({ k: L.ticketText(L.getTicket(db, flagged)!), owner: false }))
  s = L.splitBacklog(db, "tally")
  assert.deepEqual(s.pickable.map((t) => t.id), [flagged, plain], "priority order, flagged ticket now pickable")
  db.prepare("UPDATE tickets SET done_when='also push it to production' WHERE id=?").run(flagged)
  assert.deepEqual(L.splitBacklog(db, "tally").pickable.map((t) => t.id), [plain], "an edited ticket needs a fresh verdict")
  db.prepare("UPDATE kv SET v=? WHERE k=?").run(JSON.stringify({ k: L.ticketText(L.getTicket(db, flagged)!), owner: true }), L.verdictKey(flagged))
  assert.deepEqual(L.splitBacklog(db, "tally").unjudged, [], "an owner verdict is final: not asked again")
})

test("lead fallback: ready under LOW_WATER promotes pickable S/M by goal rank, then priority, up to READY_CAP", () => {
  const db = open(":memory:")
  const gs = L.syncGoals(db, "tally", "## Goals\n- First\n- Second")
  const [g1, g2] = gs
  const low = mk(db, { title: "Low priority, top goal", priority: 10, goal: g1.id })
  const hi2 = mk(db, { title: "High priority, second goal", priority: 99, goal: g2.id })
  const big = mk(db, { title: "Rebuild everything", size: "L", priority: 100, goal: g1.id })
  const owner = mk(db, { title: "Publish the Play Store release", priority: 100, goal: g1.id })
  const more = Array.from({ length: 10 }, (_, i) => mk(db, { title: `Filler ${i}`, priority: 20 + i, goal: g2.id }))
  const a = lead.fallbackPromote(db, "tally")
  assert.equal(a.promoted.length, lead.MAX_PROMOTE, "applyPlan's per-run cap")
  assert.match(a.promoted[0], new RegExp(`· #${low}$`), "goal rank 1 first even at low priority")
  assert.match(a.promoted[1], new RegExp(`· #${hi2}$`))
  assert.deepEqual([big, owner].map((id) => status(db, id)), ["backlog", "backlog"], "L and owner-only never")
  assert.deepEqual(lead.fallbackPromote(db, "tally").promoted, [], "6 ready is over LOW_WATER: nothing more")
  assert.equal(more.length, 10)
  // fills up to READY_CAP, not past it
  const db2 = open(":memory:")
  for (let i = 0; i < 3; i++) mk(db2, { title: `Ready ${i}`, status: "ready" })
  for (let i = 0; i < 10; i++) mk(db2, { title: `Backlog ${i}` })
  assert.equal(lead.fallbackPromote(db2, "tally").promoted.length, lead.READY_CAP - 3)
  assert.equal((db2.prepare("SELECT COUNT(*) n FROM tickets WHERE status='ready'").get() as { n: number }).n, lead.READY_CAP)
})

test("a ticket an agent filed (front desk after mail) is owner-only: never picked, never promoted by the Lead (audit H2)", () => {
  const db = open(":memory:")
  const mail = mk(db, { title: "Add a status beacon to index.html", priority: 100 })
  const plain = mk(db, { title: "Fix the footer spacing" })
  db.prepare("INSERT INTO kv VALUES (?, ?)").run(L.agentFiledKey(mail), "front-desk")
  const s = L.splitBacklog(db, "tally")
  assert.deepEqual(s.pickable.map((t) => t.id), [plain])
  assert.deepEqual(s.owner.map((t) => t.id), [mail])
  assert.equal(status(db, mail), "backlog")
  const a = lead.applyPlan(db, "tally", { promote: [mail], new: [], note: "" })
  assert.deepEqual(a.promoted, [])
  assert.equal(a.needsOwner.length, 1)
  assert.equal(status(db, mail), "backlog")
})

test("goals from milestones: matched by number (any rewording keeps the goal), soonest due first; import links the file's goals", async () => {
  const M = await import("../src/milestones.ts")
  const db = open(":memory:")
  const [launch, trust] = L.syncGoals(db, "tally", "## Goals\n- DRAFT: Launch on Play (you set the date)\n- Trust: zero wrong totals")
  assert.deepEqual([M.shortTitle(launch.title), M.shortTitle(trust.title)], ["DRAFT: Launch on Play", "Trust"])
  let n = 40
  const calls: string[][] = []
  const lines = M.importGoals(db, "tally", "o/r", (_c, a) => (calls.push(a), { ok: true, out: JSON.stringify({ number: ++n }) }))
  assert.equal(lines.length, 2)
  assert.deepEqual(calls[0].slice(0, 4), ["api", "-X", "POST", "repos/o/r/milestones"])
  const save = (ms: object[]) => db.prepare("INSERT OR REPLACE INTO kv VALUES ('gh:ms:tally', ?)").run(JSON.stringify(ms))
  save([{ number: 42, title: "Trust", description: "Trust, reworded", due_on: "2026-12-31T00:00:00Z" }, { number: 41, title: "Launch", description: "", due_on: "2026-11-30T00:00:00Z" }])
  const gs = L.syncGoals(db, "tally", "## Goals\n- ignored while milestones exist")
  assert.deepEqual(gs.map((g) => [g.id, g.title, g.milestone]), [[launch.id, "Launch", 41], [trust.id, "Trust, reworded", 42]])
  save([{ number: 42, title: "Trust" }, { number: 43, title: "New goal" }])
  assert.deepEqual(L.syncGoals(db, "tally", "").map((g) => [g.title, g.milestone]), [["Trust", 42], ["New goal", 43]]) // 41 closed: dropped
  assert.deepEqual(M.fetchMilestones("o/r", () => ({ ok: false, out: "" })), null) // unreadable: the last list stays
})

test("goals: a goal reworded on its own line keeps its id; a removed one is dropped", () => {
  const db = open(":memory:")
  const [a, b] = L.syncGoals(db, "tally", "## Goals\n- DRAFT: Launch\n- Trust")
  const after = L.syncGoals(db, "tally", "## Goals\n- Launch by 30 Nov, 100 households\n- Trust")
  assert.deepEqual(after.map((g) => g.id), [a.id, b.id])
  assert.equal(after[0].title, "Launch by 30 Nov, 100 households")
  assert.deepEqual(L.syncGoals(db, "tally", "## Goals\n- Trust").map((g) => g.id), [b.id])
})

test("lead fallback: nothing happens at or above LOW_WATER", () => {
  const db = open(":memory:")
  for (let i = 0; i < lead.LOW_WATER; i++) mk(db, { title: `Ready ${i}`, status: "ready" })
  mk(db, { title: "Pickable" })
  assert.deepEqual(lead.fallbackPromote(db, "tally").promoted, [])
})

test("lead run: owner-flagged picks do not set lead-noop, and the no-AI fallback fills the queue", async () => {
  const home = process.env.HOME
  process.env.HOME = mkdtempSync(`${tmpdir()}/foreman-leadhome-`)
  try {
    mkdirSync(`${process.env.HOME}/projects/tally`, { recursive: true })
    writeFileSync(`${process.env.HOME}/projects/tally/dobby.md`, "---\nbase: main\n---\n## Goals\n- Ship")
    const db = open(":memory:")
    const owner = mk(db, { title: "Publish the Play Store release", priority: 100 })
    const ok = [1, 2, 3].map((i) => mk(db, { title: `Small fix ${i}`, priority: 10 * i }))
    let seen: { stallMs?: number; prompt: string } | undefined
    const c = (async (_db: unknown, o: { stallMs?: number; prompt: string }) => (seen = o, { ok: true, text: `{"promote":[${owner}],"new":[],"note":"pick the deploy"}` })) as any
    const out = await lead.runLead(db, "tally", false, false, c)
    assert.equal(seen!.stallMs, 3 * 60_000, "the Lead keeps its 3 minute guard")
    assert.match(seen!.prompt, /OWNER-ONLY BACKLOG \(1;/)
    assert.doesNotMatch(seen!.prompt.split("OWNER-ONLY BACKLOG")[0].split("BACKLOG YOU MAY PICK FROM")[1] ?? "", /Publish the Play Store release/, "owner-only tickets are not offered as picks")
    assert.equal(status(db, owner), "backlog")
    assert.deepEqual(ok.map((id) => status(db, id)), ["ready", "ready", "ready"], "the fallback promoted what the Lead could not")
    assert.equal(kv(db, "lead-noop:tally"), undefined, "promotions and a needs-owner list both keep the Lead awake")
    assert.match(out.report, /promoted by goal rank without the model/)
    // a run that finds nothing, with nothing left for the owner, still sleeps
    const db2 = open(":memory:")
    const c2 = (async () => ({ ok: true, text: '{"promote":[],"new":[],"note":"nothing"}' })) as any
    await lead.runLead(db2, "tally", false, false, c2)
    assert.ok(kv(db2, "lead-noop:tally"))
    // needs-owner but nothing pickable: no noop either
    const db3 = open(":memory:")
    const o3 = mk(db3, { title: "Publish the Play Store release" })
    await lead.runLead(db3, "tally", false, false, (async () => ({ ok: true, text: `{"promote":[${o3}],"new":[],"note":"x"}` })) as any)
    assert.equal(kv(db3, "lead-noop:tally"), undefined)
  } finally {
    process.env.HOME = home
  }
})

// ---- 3. queueTicket ------------------------------------------------------------------------------------------------------------------

test("queueTicket: refuses any deny on title + done_when, a shopfront client name included; says so when nothing changed", () => {
  const db = open(":memory:")
  const client = mk(db, { project: "shopfront", title: "Fix the gallery page", done_when: "for Orion" })
  assert.match(L.queueTicket(db, client), /needs the owner/)
  assert.equal(status(db, client), "backlog")
  const marker = mk(db, { title: "Fix the footer", done_when: "owner: decide the copy first" })
  assert.equal(decide("ticket-text", "Fix the footer owner: decide", undefined, {}).action, "allow", "marker only counts at the start")
  assert.match(L.queueTicket(db, mk(db, { title: "Owner: pick", done_when: "" })), /needs the owner/)
  assert.match(L.queueTicket(db, mk(db, { project: "shopfront", title: "Vega gallery" })), /needs the owner/)
  const ok = mk(db, { title: "Add a copy button" })
  assert.match(L.queueTicket(db, ok), /queued/)
  assert.equal(status(db, ok), "ready")
  // 0 rows changed: truthful message, status untouched
  const running = mk(db, { title: "Already running", status: "running" })
  assert.match(L.queueTicket(db, running), /was not queued: it is running/)
  assert.equal(status(db, running), "running")
  assert.doesNotMatch(L.queueTicket(db, ok), /queued; a builder/, "a ready ticket is not 'queued' again")
  assert.equal(L.queueTicket(db, 9999), "no ticket #9999")
  assert.equal(marker > 0, true)
})

test("queueTicket: a ticket that failed the same way as at its last re-queue stays failed until it is edited", () => {
  const db = open(":memory:")
  const id = mk(db, { title: "Flaky import", status: "failed", note: "verify: import test fails" })
  assert.match(L.queueTicket(db, id), /queued/)
  setT(db, id, "failed", "verify: import test fails")
  assert.match(L.queueTicket(db, id), /failed the same way/)
  assert.equal(status(db, id), "failed")
  db.prepare("UPDATE tickets SET done_when='use the fixture' WHERE id=?").run(id) // edited: a new key
  assert.match(L.queueTicket(db, id), /queued/)
  setT(db, id, "failed", "a different failure")
  db.prepare("UPDATE tickets SET done_when='' WHERE id=?").run(id)
  assert.match(L.queueTicket(db, id), /queued/)
})
const setT = (db: DBt, id: number, st: string, note: string) => db.prepare("UPDATE tickets SET status=?, note=? WHERE id=?").run(st, note, id)

test("dashboard queue.next lists only tickets an agent may take, by goal rank, and counts the owner-only ones", () => {
  const db = open(":memory:")
  const gs = L.syncGoals(db, "tally", "## Goals\n- First\n- Second")
  const flagged = mk(db, { title: "Publish the Play Store release", priority: 100, goal: gs[0].id })
  const second = mk(db, { title: "Second goal, high priority", priority: 90, goal: gs[1].id })
  const first = mk(db, { title: "First goal, low priority", priority: 5, goal: gs[0].id })
  mk(db, { title: "Rebuild everything", size: "L", priority: 99, goal: gs[0].id })
  const q = D.queue(db, Date.now())
  assert.deepEqual(q.next.map((n) => n.id), [first, second])
  assert.equal(q.ownerOnly, 1)
  assert.equal(q.next.some((n) => n.id === flagged), false)
})

// ---- 4. status board + metrics -------------------------------------------------------------------------------------------------------

test("status board: building counts only running; fixing is its own line; shipped today skips fix pushes; stuck is the last 7 days with a total", () => {
  const db = open(":memory:")
  const now = Date.now()
  mk(db, { title: "Voice notes", status: "running" })
  for (const t of ["Fix A", "Fix B"]) mk(db, { title: t, status: "fixing" })
  mk(db, { title: "Dark mode", status: "shipped" })
  mk(db, { title: "Fix on a PR", status: "shipped", onto: "foreman/12-x" })
  mk(db, { title: "Fresh failure", status: "failed", note: "tests keep failing" })
  mk(db, { title: "Old failure", status: "failed", note: "ancient", updated: new Date(now - 20 * 86_400_000).toISOString() })
  const t = view.statusText(db, now)
  assert.match(t, /Building now \(1\): Voice notes/)
  assert.match(t, /Waiting on a review fix \(2\)/)
  assert.match(t, /Shipped today \(1\)/)
  assert.match(t, /Stuck \(1 this week, 2 failed in all\): Fresh failure - tests keep failing/)
  assert.doesNotMatch(t, /Old failure/)
  const quiet = open(":memory:")
  assert.doesNotMatch(view.statusText(quiet, now), /review fix/, "no fixing tickets: no line")
})

test("last tick: reads tick:last and both spellings of the health key, newest wins; health's text form is parsed as IST", async () => {
  const db = open(":memory:")
  const now = Date.parse("2026-10-20T10:00:00Z") // 15:30 IST
  assert.equal(view.lastTick(db, now), null)
  db.prepare("INSERT INTO kv VALUES ('health:lasttick', 'Last tick: 14:03 IST')").run()
  assert.equal(view.lastTick(db, now), Date.parse("2026-10-20T08:33:00Z"), "health.ts spelling, no hyphen")
  db.prepare("INSERT INTO kv VALUES ('health:last-tick', ?)").run(String(now - 60_000))
  assert.equal(view.lastTick(db, now), now - 60_000)
  db.prepare("INSERT INTO kv VALUES ('tick:last', ?)").run(String(now - 5000))
  assert.equal(view.lastTick(db, now), now - 5000)
  const late = open(":memory:")
  late.prepare("INSERT INTO kv VALUES ('health:lasttick', 'Last tick: 23:50 IST')").run()
  assert.equal(view.lastTick(late, now), Date.parse("2026-10-19T18:20:00Z"), "a clock time still ahead is yesterday's")
  // health writes the configured label (#127): another label still reads back
  const { config, setConfig } = await import("../src/config.ts")
  setConfig({ ...config(), timezoneLabel: "GMT+5:30" })
  try {
    const other = open(":memory:")
    other.prepare("INSERT INTO kv VALUES ('health:lasttick', 'Last tick: 14:03 GMT+5:30')").run()
    assert.equal(view.lastTick(other, now), Date.parse("2026-10-20T08:33:00Z"))
  } finally { setConfig(undefined) }
})

test("metrics: shipped excludes fix pushes everywhere (outcomes, rework, spend per ticket, goals, autonomy); fixes are reported as rework", () => {
  const db = open(":memory:"); usage.ensure(db)
  const now = Date.now(), recent = new Date(now - 3600_000).toISOString()
  const gs = L.syncGoals(db, "tally", "## Goals\n- First")
  const a = mk(db, { title: "Real one", status: "shipped", goal: gs[0].id, updated: recent })
  mk(db, { title: "Fix push 1", status: "shipped", onto: "b1", goal: gs[0].id, updated: recent })
  mk(db, { title: "Fix push 2", status: "shipped", onto: "b2", goal: gs[0].id, updated: recent })
  logRun(db, { project: "tally", kind: "build", ok: true, cost_usd: 3 }, recent)
  const o = D.outcomes(db, now, 7)
  assert.deepEqual([o.shipped, o.reworkFixes], [1, 2])
  assert.equal(D.quality(db, now, 7).rework.tickets, 1)
  const sp = D.spend(db, now, 7).perShippedByApp.find((x) => x.app === "tally")!
  assert.deepEqual([sp.shipped, sp.reworkFixes, sp.perTicket], [1, 2, 3])
  assert.equal((D.goals(db)[0].goals[0] as { shipped: number }).shipped, 1)
  const au = usage.autonomy(db, 1, now)
  assert.deepEqual([au.shipped, au.alone, au.fixes], [1, 1, 2])
  assert.match(usage.autonomyLine(db, 1, now), /1 of 1 shipped.*Review fixes pushed \(rework\): 2\./)
  db.prepare("INSERT INTO touches (at, ticket, kind, tag) VALUES (?,?,?,?)").run(now, a, "broke", "broke")
  assert.equal(usage.autonomy(db, 1, now).alone, 0)
})

test("digest: fix pushes are reported as rework, not as shipped", () => {
  assert.match(digest([], () => undefined, 3), /nothing merged\.\n🔁 3 review fixes pushed onto open PRs/)
  const d = digest([{ id: 1, project: "tally", title: "Dark mode", note: null }], () => undefined, 1)
  assert.match(d, /Shipped today: Tally 1[\s\S]*🔁 1 review fix pushed/)
  assert.doesNotMatch(digest([{ id: 1, project: "tally", title: "Dark mode", note: null }], () => undefined), /rework/)
})

// ---- 5. builder routing --------------------------------------------------------------------------------------------------------------

test("builders: Sonnet unless size L; sensitive still means a strict review", () => {
  const sensitive = L.riskPath({ title: "Privacy settings for login sessions", done_when: "", size: "M" })
  assert.deepEqual([sensitive.sensitive, sensitive.strong], [true, false])
  assert.equal(L.riskPath({ title: "Household sharing", done_when: "", size: "L" }).strong, true)
})

test("build cap: 4 builds per ticket across retries; a hand re-queue starts a fresh count; nothing is spawned over the cap", async () => {
  const db = open(":memory:")
  const id = mk(db, { title: "Stubborn", status: "ready" })
  L.seedBuildBases(db) // rollout baseline: 0 builds so far
  let spawned = 0
  const once = (async () => (spawned++, { ok: true, text: "done" })) as any
  const build = () => L.claude(db, { project: "tally", kind: "build", ticket: id, model: "sonnet", prompt: "p" }, once)
  for (let i = 0; i < L.BUILD_CAP; i++) {
    assert.equal((await build()).ok, true)
    logRun(db, { project: "tally", kind: "build", ticket: id, ok: false }) // what the real claudeOnce logs
  }
  assert.equal(L.buildsUsed(db, id), 4)
  const over = await build()
  assert.deepEqual([over.ok, spawned, /^build cap/.test(over.reason ?? "")], [false, 4, true])
  // a text-only role or another kind is not capped
  assert.equal((await L.claude(db, { project: "tally", kind: "check", ticket: id, model: "haiku", prompt: "p" }, once)).ok, true)
  // claiming: a ready ticket over the cap is parked as failed, not handed to a worker
  const next = L.nextTicket(db)
  assert.equal(next, undefined)
  assert.equal(status(db, id), "failed")
  assert.match(L.getTicket(db, id)!.note ?? "", /4 builds without shipping/)
  // the owner re-queues by hand: four more
  setT(db, id, "failed", "other reason")
  assert.match(L.queueTicket(db, id), /queued/)
  assert.equal(L.buildsUsed(db, id), 0)
  assert.equal(L.nextTicket(db)?.id, id)
  assert.equal((await build()).ok, true)
})

test("PM stall guard is 10 minutes, longer than the Lead's 3", async () => {
  const { PM_STALL_MS } = await import("../src/graphs/product.ts")
  assert.equal(PM_STALL_MS, 10 * 60_000)
})

// ---- 7. readUsage --------------------------------------------------------------------------------------------------------------------

const cliJson = (extra: Record<string, unknown> = {}) => JSON.stringify({ windows: [{ key: "five_hour", percentUsed: 40, msToReset: 3600_000 }, { key: "seven_day", percentUsed: 20, msToReset: 4 * 86_400_000 }], ...extra })

test("readUsage: parses the CLI, keeps snapshotAgeMs, null when unreadable", () => {
  assert.deepEqual(L.readUsage(undefined, () => cliJson({ snapshotAgeMs: 164116 })), { fiveUsed: 40, weekUsed: 20, weekMsToReset: 4 * 86_400_000, fiveMsToReset: 3600_000, ageMs: 164116 })
  assert.equal(L.readUsage(undefined, () => cliJson())!.ageMs, undefined)
  assert.equal(L.readUsage(undefined, () => ""), null)
  assert.equal(L.readUsage(undefined, () => "not json"), null)
})

test("readUsage: unreadable for more than 30 minutes tells the owner once; a good reading resets it", () => {
  const db = open(":memory:")
  const told: string[] = []
  const tell = ((_db: unknown, text: string, key?: string) => told.push(`${key}: ${text}`)) as typeof L.fixed
  const t0 = Date.parse("2026-10-20T10:00:00Z"), min = 60_000
  L.readUsage(db, () => "", t0, tell, () => false)
  L.readUsage(db, () => "", t0 + 29 * min, tell, () => false)
  assert.equal(told.length, 0, "not yet 30 minutes")
  L.readUsage(db, () => "", t0 + 31 * min, tell, () => false)
  L.readUsage(db, () => "", t0 + 90 * min, tell, () => false)
  assert.equal(told.length, 1, "once")
  assert.match(told[0], /^usage-unreadable: I cannot read your Claude usage numbers/)
  L.readUsage(db, () => cliJson({ snapshotAgeMs: 1000 }), t0 + 100 * min, tell, () => false)
  assert.equal(kv(db, "usage:bad-since"), undefined)
  L.readUsage(db, () => "", t0 + 200 * min, tell, () => false)
  L.readUsage(db, () => "", t0 + 240 * min, tell, () => false)
  assert.equal(told.length, 2, "a new outage is a new alert")
})

test("readUsage: no reader installed = no pacing, said once; the reader coming back clears it", () => {
  const db = open(":memory:")
  const told: string[] = []
  const tell = ((_db: unknown, text: string, key?: string) => told.push(`${key}: ${text}`)) as typeof L.fixed
  let reads = 0
  const read = () => (reads++, cliJson())
  assert.equal(L.readUsage(db, read, Date.now(), tell, () => false, () => true), null)
  L.readUsage(db, read, Date.now(), tell, () => false, () => true)
  assert.equal(reads, 0, "nothing to spawn")
  assert.equal(told.length, 1)
  assert.match(told[0], /^usage-missing: No usage reader at .+, so builders run with no pacing/)
  assert.equal(L.readUsage(db, read, Date.now(), tell, () => false, () => false)!.fiveUsed, 40)
  assert.equal(kv(db, "usage:missing-told"), undefined)
  assert.equal(L.noUsageReader("/nonexistent/cli.js"), true)
  assert.equal(L.noUsageReader(new URL(import.meta.url).pathname), false)
})

test("readUsage: a snapshot older than 30 minutes counts as an outage but still returns the numbers", () => {
  const db = open(":memory:")
  const told: string[] = []
  const u = L.readUsage(db, () => cliJson({ snapshotAgeMs: 45 * 60_000 }), Date.now(), (() => told.push("x")) as typeof L.fixed, () => false)
  assert.equal(u!.fiveUsed, 40)
  assert.equal(told.length, 1)
})

test("readUsage: a stale snapshot asks for a live reading (every 10 minutes at most); a fresh one is no outage", () => {
  const db = open(":memory:")
  const told: string[] = [], t0 = Date.parse("2026-10-20T10:00:00Z"), min = 60_000
  const tell = (() => told.push("x")) as typeof L.fixed
  let age = 45 * min, asked = 0
  const refresh = () => (asked++, age = 1000, true)
  const u = L.readUsage(db, () => cliJson({ snapshotAgeMs: age }), t0, tell, refresh)
  assert.equal(asked, 1)
  assert.equal(u!.ageMs, 1000)
  assert.equal(told.length, 0)
  assert.equal(kv(db, "usage:bad-since"), undefined)
  // the live reading failed: no second ask within 10 minutes, and the outage counts as before
  age = 45 * min
  const fail = () => (asked++, false)
  L.readUsage(db, () => cliJson({ snapshotAgeMs: age }), t0 + 5 * min, tell, fail)
  assert.equal(asked, 1)
  L.readUsage(db, () => cliJson({ snapshotAgeMs: age }), t0 + 11 * min, tell, fail)
  assert.equal(asked, 2)
  assert.equal(told.length, 1)
})

test("build cap rollout: tickets with old builds get a baseline and are not parked", async () => {
  const db = open(":memory:")
  const id = mk(db, { title: "Old ticket with many builds", status: "ready" })
  for (let i = 0; i < 9; i++) logRun(db, { project: "tally", kind: "build", ticket: id, ok: false })
  assert.equal(L.nextTicket(db)?.id, id) // claimed, not parked
  assert.equal(L.buildsUsed(db, id), 0)
})

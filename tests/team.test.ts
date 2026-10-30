// The team build (17 Oct): goals, Engineering Manager, Product/Program Manager, Designer, router, autonomy, #needs-you summaries.
import assert from "node:assert/strict"
import { test } from "node:test"
import { open } from "../src/db.ts"
import { addTicket, getTicket, parseGoals, setTicket, syncGoals } from "../src/lib.ts"
import { applyPlan } from "../src/graphs/lead.ts"

test("goals: parsed from projects/<app>.md, mirrored with stable ids, every ticket linked", () => {
  const rules = "## Goal (DRAFT)\nold text\n\n## Goals (yours)\n- DRAFT: Launch on Play\n2. Trust the numbers\n\n## Always ask me\n- not a goal"
  assert.deepEqual(parseGoals(rules), ["DRAFT: Launch on Play", "Trust the numbers"])
  assert.deepEqual(parseGoals("## Goal\nno list"), [])
  const db = open(":memory:")
  const orphan = addTicket(db, { project: "tally", title: "before goals" }).id
  assert.equal(getTicket(db, orphan)!.goal, null)
  const [g1, g2] = syncGoals(db, "tally", rules)
  assert.deepEqual([g1.rank, g2.rank, g2.title], [1, 2, "Trust the numbers"])
  assert.equal(getTicket(db, orphan)!.goal, g1.id) // backfilled to the top goal
  assert.equal(getTicket(db, addTicket(db, { project: "tally", title: "new" }).id)!.goal, g1.id)
  // owner drops "DRAFT:", swaps the order and removes nothing: same ids, new ranks
  const again = syncGoals(db, "tally", "## Goals\n- Trust the numbers\n- Launch on Play")
  assert.deepEqual(again.map((g) => [g.id, g.rank]), [[g2.id, 1], [g1.id, 2]])
  assert.deepEqual(syncGoals(db, "tally", "## Goals\n- Launch on Play").map((g) => g.id), [g1.id]) // the other is dropped
  // the planner's goal is kept when it is a live goal of this project, else the top goal
  const a = applyPlan(db, "tally", { promote: [], new: [{ title: "x one", size: "S", goal: g1.id }, { title: "x two", size: "S", goal: 999 }], note: "" })
  const ids = a.created.map((c) => Number(c.match(/· #(\d+)/)![1]))
  assert.deepEqual(ids.map((id) => getTicket(db, id)!.goal), [g1.id, g1.id])
})

test("engineering manager: signed out, the first of two due runs pings once and stops the rest; no lead-at or em-week-at stamp is left", async () => {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { claude } = await import("../src/lib.ts")
  const { runLeads } = await import("../src/graphs/lead.ts")
  const home = process.env.HOME
  process.env.HOME = mkdtempSync(`${tmpdir()}/foreman-lead-`) // loadProjects and the read-only copies live under ~
  try {
    for (const n of ["alpha", "beta"]) {
      mkdirSync(`${process.env.HOME}/projects/${n}`, { recursive: true })
      writeFileSync(`${process.env.HOME}/projects/${n}/dobby.md`, "---\nbase: main\n---\n## Goals\n- Ship")
    }
    const db = open(":memory:")
    const runs: string[] = [], pings: string[] = []
    const once = (async (_db: unknown, o: { project: string }) => (runs.push(o.project), { ok: false, text: "", reason: "Failed to authenticate: OAuth session expired" })) as any
    const c = ((d: any, o: any) => claude(d, o, once, async (t: string) => { pings.push(t) })) as typeof claude
    const out = await runLeads(db, false, c)
    assert.deepEqual(runs, ["alpha"]) // beta (and the draft projects) never started
    assert.equal(pings.length, 1)
    assert.match(out.join("\n"), /lead runs stop: Claude is signed out/)
    assert.deepEqual(db.prepare("SELECT k FROM kv WHERE k LIKE 'lead-at:%' OR k LIKE 'em-week-at:%'").all(), []) // still due once signed in
    await runLeads(db, false, c)
    assert.deepEqual([runs.length, pings.length], [2, 1]) // the next tick tries again, no second ping
  } finally {
    process.env.HOME = home
  }
})

test("engineering manager: assigns engineers, keeps the week's plan, weekly run Mondays from 06:30 IST", async () => {
  const { parsePlan, weeklyDue } = await import("../src/graphs/lead.ts")
  const p = parsePlan('{"promote":[3,{"id":4,"engineer":"mobile"},{"id":5,"engineer":"chef"}],"new":[],"note":"n","week":"Mon: #4\\nTue: #3"}')!
  assert.deepEqual([p.promote, p.assign, p.week], [[3, 4, 5], { 4: "mobile" }, "Mon: #4\nTue: #3"])
  const db = open(":memory:")
  const t = addTicket(db, { project: "tally", title: "Fix the import button", size: "S" }).id
  db.prepare("UPDATE tickets SET status='backlog' WHERE id=?").run(t)
  const a = applyPlan(db, "tally", { promote: [t], assign: { [t]: "web" }, new: [{ title: "Sync worker retries", size: "S", engineer: "backend" }, { title: "Odd one", size: "S", engineer: "chef" }], note: "" })
  const made = a.created.map((c) => getTicket(db, Number(c.match(/· #(\d+)/)![1]))!.engineer)
  assert.deepEqual([getTicket(db, t)!.engineer, ...made], ["web", "backend", null])
  const projects = { tally: { name: "tally", paused: false }, shopfront: { name: "shopfront", paused: true } } as any
  const mon0700 = Date.parse("2026-10-19T01:30:00Z") // Monday 07:00 IST
  assert.deepEqual(weeklyDue(db, projects, mon0700).map((x) => x.name), ["tally"])
  assert.deepEqual(weeklyDue(db, projects, Date.parse("2026-10-19T00:30:00Z")), []) // 06:00 IST: too early
  assert.deepEqual(weeklyDue(db, projects, Date.parse("2026-10-20T01:30:00Z")), []) // Tuesday
  db.prepare("INSERT INTO kv VALUES ('em-week-at:tally', '2026-10-19')").run()
  assert.deepEqual(weeklyDue(db, projects, mon0700), []) // once per Monday
})

test("risk-scaled path: S plain, M+UI gets the Designer, L gets PRD + launch check, sensitive gets the strict review, only L the Opus builder", async () => {
  const { riskPath } = await import("../src/lib.ts")
  assert.deepEqual(riskPath({ title: "Fix typo in README", done_when: "", size: "S" }), { sensitive: false, design: false, prd: false, launch: false, strong: false })
  assert.equal(riskPath({ title: "New budgets screen", done_when: "", size: "M" }).design, true)
  assert.equal(riskPath({ title: "New budgets screen", done_when: "", size: "S" }).design, false)
  assert.deepEqual(riskPath({ title: "Household sharing", done_when: "", size: "L" }), { sensitive: false, design: false, prd: true, launch: true, strong: true })
  // audit #8: a sensitive S/M ticket is reviewed strictly but built by Sonnet; only L gets the Opus builder
  const login = riskPath({ title: "Rate-limit the login endpoint", done_when: "", size: "S" })
  assert.deepEqual([login.sensitive, login.strong], [true, false])
})

test("skills: every role's skills are installed, pinned to a commit, from an allowed license; no Expo store skills", async () => {
  const { readdirSync, readFileSync, existsSync } = await import("node:fs")
  const { parseDoc, ROOT } = await import("../src/lib.ts")
  for (const f of readdirSync(`${ROOT}roles`)) {
    for (const s of (parseDoc(readFileSync(`${ROOT}roles/${f}`, "utf8")).meta.skills ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
      assert.ok(existsSync(`${ROOT}skills/${s}/SKILL.md`), `${f}: ${s} missing`)
      assert.match(readFileSync(`${ROOT}skills/${s}/SKILL.md`, "utf8").split("\n")[0], /^<!-- from [\w.-]+\/[\w.-]+\/\S+SKILL\.md @ [0-9a-f]{40} \((MIT|Apache-2\.0|BSD-[23]-Clause|ISC)\)/, s)
    }
  }
  assert.ok(!readdirSync(`${ROOT}skills`).some((s) => /^eas-/.test(s)))
})

test("product manager: ranked problems filed to the backlog, only new ideas posted, PRDs only for this app's L tickets, daily 06:00 IST then one area", async () => {
  const { applyCards, areaDue, nextArea, parseCards, pmDue } = await import("../src/graphs/product.ts")
  const db = open(":memory:")
  const [g1, g2] = syncGoals(db, "tally", "## Goals\n- Launch\n- Trust")
  const big = addTicket(db, { project: "tally", title: "Household sharing v2", size: "L" }).id
  const other = addTicket(db, { project: "shopfront", title: "Big shopfront thing", size: "L" }).id
  const lines = [
    { type: "problem", title: "Imports fail silently on old PDFs", goal: g2.id, score: 80, size: "M" },
    { type: "problem", title: "New users don't find the import button", goal: g1.id, score: 95 },
    { type: "problem", title: "Weak one", score: 10 },
    { type: "problem", title: "Weaker one", score: 5, goal: 999 },
    { type: "prd", ticket: big, prd: "Summary: ..." }, { type: "prd", ticket: other, prd: "nope" },
    { type: "idea", title: "Split a dinner bill from a receipt photo", pitch: "Snap the bill, Tally splits it", how: "...", size: "M" },
    { type: "note", text: "imports first" }, { nonsense: true },
  ].map((x) => JSON.stringify(x)).join("\n") + "\nnot json"
  const cards = parseCards(lines)
  assert.equal(cards.length, 8)
  const posted: string[] = []
  const a = await applyCards(db, "tally", "pm", cards, async (i) => { posted.push(i.title) })
  assert.deepEqual(posted, ["Split a dinner bill from a receipt photo"]) // only new ideas are posted; problems are not
  const filed = db.prepare("SELECT title, status, priority FROM tickets WHERE project='tally' AND note LIKE 'from the Product Manager%' ORDER BY priority DESC").all() as { title: string; status: string; priority: number }[]
  assert.deepEqual(filed.map((t) => [t.title, t.status, t.priority]).slice(0, 2), [["New users don't find the import button", "backlog", 95], ["Imports fail silently on old PDFs", "backlog", 80]])
  assert.deepEqual([a.stored, a.prds, a.note], [4, [big], "imports first"])
  assert.equal(getTicket(db, other)!.prd, null)
  const goalsOf = db.prepare("SELECT title, goal FROM ideas WHERE source='pm' AND lens='problem' ORDER BY score DESC").all() as { title: string; goal: number }[]
  assert.deepEqual(goalsOf.map((x) => x.goal), [g1.id, g2.id, g1.id, g1.id]) // unknown goal = the top goal
  assert.equal((await applyCards(db, "tally", "pm", cards, async () => {})).stored, 0) // duplicates skipped
  const projects = { tally: { name: "tally", paused: false, areas: ["import", "budgets"] }, foreman: { name: "foreman", paused: false } } as any
  const at0630 = Date.parse("2026-10-17T01:00:00Z"), at0530 = Date.parse("2026-10-17T00:00:00Z")
  assert.deepEqual(pmDue(db, projects, at0530), [])
  assert.deepEqual(pmDue(db, projects, at0630).map((p) => p.name), ["tally"]) // foreman has no areas: no PM
  assert.deepEqual(areaDue(db, projects, at0630), []) // waits for the PM
  db.prepare("INSERT INTO kv VALUES ('pm-at:tally', '2026-10-17')").run()
  assert.deepEqual([pmDue(db, projects, at0630), areaDue(db, projects, at0630).map((p) => p.name)], [[], ["tally"]])
  assert.equal(nextArea(db, projects.tally), "import")
  db.prepare("INSERT INTO kv VALUES ('area:next:tally', '3')").run()
  assert.equal(nextArea(db, projects.tally), "budgets")
})

test("program manager: EM splits an L ticket with a PRD, PgM runs it in order, unblocks once, closes merged PRs, launch-checks, one living status", async () => {
  const { buildProgramGraph, closeFinishedPrs, programTickets, statusText } = await import("../src/graphs/program.ts")
  const db = open(":memory:")
  const [g] = syncGoals(db, "tally", "## Goals\n- Launch")
  const big = addTicket(db, { project: "tally", title: "Household sharing v2", size: "L" }).id
  db.prepare("UPDATE tickets SET status='backlog' WHERE id=?").run(big)
  const split = { from: big, title: "Sharing v2", tickets: [{ title: "Invite link API", size: "S", engineer: "backend" }, { title: "Invite screen", size: "M", engineer: "mobile" }, { title: "Publish the Play Store release" }] }
  assert.match(applyPlan(db, "tally", { promote: [], new: [], note: "", programs: [split] }).skipped.join(), /needs an L ticket with a PRD/)
  db.prepare("UPDATE tickets SET prd='first version: invite by link' WHERE id=?").run(big)
  const a = applyPlan(db, "tally", { promote: [], new: [], note: "", programs: [split] })
  assert.equal(a.programs!.length, 1)
  assert.equal(getTicket(db, big)!.status, "split")
  const pg = db.prepare("SELECT * FROM programs").get() as any
  assert.deepEqual([pg.goal, pg.source_ticket], [g.id, big])
  const [t1, t2] = programTickets(db, pg.id)
  assert.equal(programTickets(db, pg.id).length, 2) // the owner-only "Publish release" part was dropped
  assert.deepEqual([t1.engineer, t2.engineer, t2.size], ["backend", "mobile", "M"])

  const upserts: string[] = []
  let launchReply = '{"ready":false,"gaps":[{"title":"Invite expiry check","done_when":"test","size":"S"}],"note":"needs expiry"}'
  const claude = (async () => ({ ok: true, text: launchReply })) as any
  const gh: Record<string, string> = {}
  const run = ((_c: string, args: string[]) => ({ ok: true, out: gh[args[2]] ?? "OPEN" })) as any
  const cycle = async () => (await buildProgramGraph(db, { run, claude, upsert: async (_k, _p, text) => { upserts.push(text) } }).compile().invoke({ project: "tally", notes: {} })).log as string[]
  await cycle()
  assert.deepEqual([getTicket(db, t1.id)!.status, getTicket(db, t2.id)!.status], ["ready", "backlog"]) // in order
  assert.equal(upserts.length, 1)
  await cycle()
  assert.equal(upserts.length, 1) // nothing changed: no edit
  // t1 fails: re-queued once with QA's notes; a second failure stays failed
  setTicket(db, t1.id, { status: "failed", note: "QA: button missing" })
  await cycle()
  assert.equal(getTicket(db, t1.id)!.status, "ready")
  assert.match(getTicket(db, t1.id)!.done_when, /QA: button missing/)
  setTicket(db, t1.id, { status: "failed", note: "again" })
  await cycle()
  assert.equal(getTicket(db, t1.id)!.status, "failed")
  // its PR merged meanwhile (outside Dobby): shipped; then t2 is next
  setTicket(db, t1.id, { status: "fixing", note: "fix round 1\nhttps://github.com/acmeorg/tally/pull/700" })
  gh["https://github.com/acmeorg/tally/pull/700"] = "MERGED"
  await cycle()
  assert.deepEqual([getTicket(db, t1.id)!.status, getTicket(db, t2.id)!.status], ["shipped", "ready"])
  // all done: launch check finds a gap -> new program ticket; next check says ready -> launched
  setTicket(db, t2.id, { status: "shipped" })
  await cycle()
  await cycle() // the gap ticket is next on the following cycle
  const all = programTickets(db, pg.id)
  assert.deepEqual([all.length, all[2].title, all[2].status], [3, "Invite expiry check", "ready"])
  setTicket(db, all[2].id, { status: "shipped" })
  launchReply = '{"ready":true,"gaps":[],"note":"sharing v2 is ready"}'
  await cycle()
  assert.equal((db.prepare("SELECT status FROM programs").get() as any).status, "done")
  assert.match(upserts.at(-1)!, /launched ✅[\s\S]*sharing v2 is ready/)
  assert.match(statusText({ ...pg, status: "open" }, all), /^📈 Sharing v2 · \d\/3 done\n(.* Invite.*\n)+Next: Invite expiry check/)
  assert.deepEqual(await closeFinishedPrs(db, "tally", run), [])
})

test("budget split: process roles max 20% of spend and throttled first; autonomy counts shipped tickets with zero owner touches", async () => {
  const { autonomyLine, processAllowed, tagFor, touch, usageLine } = await import("../src/usage.ts")
  const { logRun } = await import("../src/db.ts")
  const db = open(":memory:")
  assert.equal(processAllowed(db).ok, true) // no spend yet
  logRun(db, { project: "tally", kind: "build", ok: true, cost_usd: 8 })
  logRun(db, { project: "tally", kind: "pm", ok: true, cost_usd: 1.5 })
  assert.equal(processAllowed(db).ok, true) // 16%
  logRun(db, { project: "tally", kind: "lead", ok: true, cost_usd: 1 })
  assert.match(processAllowed(db).why, /process roles at 24%/)
  assert.equal(processAllowed(db).ok, false)
  const fresh = open(":memory:")
  assert.equal(processAllowed(fresh, { ok: true, cap: 40 }, 35).ok, false) // within 10 points of the builders' cap
  assert.equal(processAllowed(fresh, { ok: true, cap: 40 }, 25).ok, true)
  assert.equal(processAllowed(fresh, { ok: false, cap: 40 }, 0).ok, false)

  assert.deepEqual(["approve 3", "deploynow tally migrate", "deploynow tally", "reviewfix o/r 5", "send ab12"].map(tagFor), ["decision", "decision", "broke", "broke", "decision"])
  const ids = [1, 2, 3].map((i) => addTicket(db, { project: "tally", title: `t${i}` }).id)
  for (const id of ids) setTicket(db, id, { status: "shipped" })
  touch(db, { ticket: ids[0], kind: "tap", tag: "broke" })
  touch(db, { kind: "needs-you", tag: "decision" })
  assert.equal(autonomyLine(db), "🤖 Autonomy: 2 of 3 shipped with zero owner touches (67%). Interruptions: 2 (1 broke, 1 decision). Tickets touched: 1.")
  assert.match(usageLine(db, { fiveUsed: 12, weekUsed: 30, weekMsToReset: 3.5 * 86400_000 }), /^📊 Usage: 5-hour 12%, weekly 30% \(even pace by now: 50%\)/)

  // daily-update block: $ per 1%, cache hit per role (flag under 80%), idle-window warning, day vs night (IST)
  const t0 = Date.now(), ins = db.prepare("INSERT INTO usage_calls VALUES (?,?,'s','automated','p','m',0,0,0,0,0,0,0,?)")
  ins.run("c", t0 - 2400_000, 3) // $3 between two ticks that are 1% apart
  db.prepare("INSERT INTO usage_ticks VALUES (?,?,?,?,?)").run(t0 - 3600_000, 10, 30, 1, 1)
  db.prepare("INSERT INTO usage_ticks VALUES (?,?,?,?,?)").run(t0 - 1800_000, 11, 30, 1, 1)
  logRun(db, { project: "tally", kind: "build", ok: true, input_tokens: 10, cache_read: 90, cache_write: 0 } as any)
  logRun(db, { project: "tally", kind: "pm", ok: true, input_tokens: 50, cache_read: 50, cache_write: 0 } as any)
  const idle = { fiveUsed: 12, weekUsed: 30, weekMsToReset: 3.5 * 86400_000, fiveMsToReset: 3600_000 }
  const out = usageLine(db, idle, Date.now()).split("\n")
  assert.match(out[1], /5-hour \$3\.00, weekly measuring…/)
  assert.match(out[1], /build 90%, pm 50% ⚠️/)
  assert.match(out[2], /^⚠️ 5-hour window idle: 12% used/)
  assert.equal(usageLine(db, { ...idle, fiveMsToReset: 4 * 3600_000 }).split("\n").length, 2)
  const base = Date.parse("2020-01-01T00:00:00Z") - 5.5 * 3600_000 // 00:00 IST
  ins.run("a", base + 10 * 3600_000, 3) // 10:00 IST: day
  ins.run("b", base + 23.5 * 3600_000, 1) // 23:30 IST: night
  assert.match(usageLine(db, idle, base + 24 * 3600_000), /day \(08-23 IST\) \$3\.00, night \(23-08 IST\) \$1\.00/)
})

test("#needs-you cards: 3 plain lines on top (Haiku), button meanings as the fallback, and the owner touch is logged", async () => {
  const { buttonsText, needsYou } = await import("../src/notify.ts")
  const db = open(":memory:")
  const buttons = [{ text: "🚀 Migrate & deploy", data: "deploynow tally migrate" }, { text: "🔗 Open PR", data: "", url: "https://github.com/x/y/pull/1" }]
  assert.equal(buttonsText(buttons), "Migrate & deploy = runs the migration on production, then deploys · Open PR = opens the page")
  const good = "What happened: a deploy is waiting.\nWhy it needs you: a migration changes saved data.\nButtons: Migrate & deploy = runs it, then deploys."
  let prompt = ""
  const card = await needsYou("🟡 Needs you · tally deploy", buttons, { db, ask: (async (_db: unknown, o: { prompt: string }) => ((prompt = o.prompt), { ok: true, text: good })) as any })
  assert.equal(card, `${good}\n\n🟡 Needs you · tally deploy`)
  assert.match(prompt, /runs the migration on production/)
  const broken = await needsYou("🔴 Deploy failed", [{ text: "🔁 Retry deploy", data: "deploynow tally" }], { db, ask: (async () => ({ ok: true, text: "Sure! Here you go" })) as any })
  assert.equal(broken, "Buttons: Retry deploy = tries the deploy again\n\n🔴 Deploy failed")
  assert.deepEqual(db.prepare("SELECT kind, tag FROM touches ORDER BY id").all().map((r: any) => `${r.kind}:${r.tag}`), ["needs-you:decision", "needs-you:broke"])
})

test("near-duplicate tickets: word overlap picks candidates, Jev says which is the same work, no answer files it", async () => {
  const { nearTickets, sameWork } = await import("../src/jev.ts")
  const db = open(":memory:")
  const a = addTicket(db, { project: "tally", title: "Retry failed sync uploads with backoff", done_when: "x" })
  addTicket(db, { project: "tally", title: "Dark mode for settings screen", done_when: "x" })
  const near = nearTickets(db, "tally", "Sync uploads retry with exponential backoff")
  assert.deepEqual(near.map((n) => n.id), [a.id])
  assert.deepEqual(nearTickets(db, "tally", "Dark theme palette"), []) // too little overlap: Jev is never asked
  assert.equal(await sameWork("x", [], (async () => assert.fail("no candidates, no call")) as any), null)
  const prev = process.env["JEV_API_KEY"]
  process.env["JEV_API_KEY"] = "test"
  const says = (choice: string) => (async () => new Response(JSON.stringify({ answers: { same: { choice, confidence: 1 } } }))) as any
  assert.equal(await sameWork("Sync uploads retry", near, says(`#${a.id} ${near[0].title}`)), a.id)
  assert.equal(await sameWork("Sync uploads retry", near, says("none")), null)
  assert.equal(await sameWork("Sync uploads retry", near, (async () => { throw new Error("down") }) as any), null) // Jev down: file it
  process.env["JEV_API_KEY"] = prev
})

test("roles: every file in roles/ is loaded by code or listed under Supporting roles in docs/team.md", async () => {
  const { readdirSync, readFileSync } = await import("node:fs")
  const { ROOT } = await import("../src/lib.ts")
  const code = readdirSync(`${ROOT}src`, { recursive: true }).filter((f) => String(f).endsWith(".ts")).map((f) => readFileSync(`${ROOT}src/${f}`, "utf8")).join("\n")
  const team = readFileSync(`${ROOT}docs/team.md`, "utf8").split("## Supporting roles")[1]?.split("\n## ")[0] ?? ""
  for (const f of readdirSync(`${ROOT}roles`)) {
    const role = f.replace(/\.md$/, "")
    assert.ok(code.includes(`"${role}"`) || team.includes(`\`${role}\``), `roles/${f} is not loaded by any code and not listed in docs/team.md`)
  }
})

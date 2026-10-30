// Queue and Goals: the estimates, the stop line, reorder (the order holds for the builders), ideas, goal rows, and the three doors for the new actions.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { mock, test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-queue-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/none.txt`
const { open } = await import("../src/db.ts")
const D = await import("../src/dashboard.ts")
const S = await import("../src/dashboard-server.ts")
const A = await import("../src/actions.ts")
const { nextTicket } = await import("../src/lib.ts")
const { parsePause } = await import("../src/pause.ts")
const { markFits, fitsAfter } = await import("../src/queue-math.ts")
const { Snapshot } = await import("../src/api-schema.ts")
const { ACTIONS, KEYS } = await import("../dashboard/src/actions.ts")

const NOW = Date.parse("2026-10-20T12:00:00Z")
const iso = (h = 1) => new Date(NOW - h * 3_600_000).toISOString()
const add = (db: any, o: { status: string; size?: string; priority?: number; project?: string; title?: string; dep?: number; goal?: number; updated?: number }) =>
  Number(db.prepare("INSERT INTO tickets (project,title,status,size,priority,depends_on,goal,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(o.project ?? "tally", o.title ?? `Thing: ${o.status}`, o.status, o.size ?? "M", o.priority ?? 50, o.dep ?? null, o.goal ?? null, iso(30), iso(o.updated ?? 1)).lastInsertRowid)
const spend = (db: any, ticket: number, usd: number) => db.prepare("INSERT INTO runs (at,project,kind,ticket,ok,cost_usd) VALUES (?, 'tally', 'build', ?, 1, ?)").run(iso(), ticket, usd)
const limits = (used: number, cap = 95) => ({ week: { used, cap, resetsAt: NOW + 86_400_000 } })
const ids = (rows: { id: number }[]) => rows.map((r) => r.id)
const status = (db: any, id: number) => (db.prepare("SELECT status FROM tickets WHERE id=?").get(id) as any).status

test("estimates: median week-% of shipped tickets of the size; too few samples fall back to the default", () => {
  const db = open(":memory:")
  for (const usd of [104, 130, 156]) spend(db, add(db, { status: "shipped", size: "M" }), usd) // 4%, 5%, 6% at $26 a point
  for (const usd of [26, 52]) spend(db, add(db, { status: "shipped", size: "S" }), usd) // two samples: not enough
  spend(db, add(db, { status: "shipped", size: "M" }), 0) // no spend: ignored
  const fix = add(db, { status: "shipped", size: "L" }); db.prepare("UPDATE tickets SET onto='dobby/1' WHERE id=?").run(fix); spend(db, fix, 999) // a fix push is not a ticket
  assert.deepEqual(D.estimates(db), { S: 2, M: 5, L: 11 })
  for (const usd of [260, 260, 260]) spend(db, add(db, { status: "shipped", size: "L" }), usd)
  assert.equal(D.estimates(db).L, 10)
  assert.deepEqual(D.estimates(open(":memory:")), { S: 2, M: 5, L: 11 })
})

test("fits: the running total from the top against the week's room; a running ticket counts only what it has left", () => {
  assert.deepEqual(markFits([{ leftPct: 5 }, { leftPct: 2 }, { leftPct: 5 }], 10), [true, true, false])
  assert.deepEqual(markFits([{ leftPct: 5 }, { leftPct: 0 }, { leftPct: 6 }], 5), [true, true, false]) // exactly the room fits
  assert.deepEqual(markFits([{ leftPct: 50 }], null), [true]) // no plan reading: nothing is cut
  assert.ok(fitsAfter(5, 5, 10)); assert.ok(!fitsAfter(6, 5, 10)); assert.ok(fitsAfter(99, 99, null))
  const db = open(":memory:")
  const run = add(db, { status: "running", size: "M" }); spend(db, run, 52) // 2% of its 5% is spent
  const a = add(db, { status: "ready", size: "S", priority: 60 }), b = add(db, { status: "ready", size: "M", priority: 55 }), c = add(db, { status: "ready", size: "M", priority: 50 })
  const v = D.queueView(db, NOW, limits(85)) // room 10
  assert.deepEqual(ids(v.order), [run, a, b, c])
  assert.deepEqual(v.order.map((r) => r.leftPct), [3, 2, 5, 5])
  assert.deepEqual(v.order.map((r) => r.fits), [true, true, true, false]) // 3, 5, 10, 15
  assert.equal(v.room, 10); assert.equal(v.stopPct, 95); assert.equal(v.queuedPct, 15)
  assert.deepEqual(v.order.map((r) => r.state), ["Building", "Next", "Ready", "Ready"])
  assert.deepEqual(D.queueView(db, NOW, null).order.map((r) => r.fits), [true, true, true, true]) // no limits reading
  const over = D.queueView(db, NOW, limits(99)) // past the cap: nothing fits, and room never goes negative
  assert.equal(over.room, 0); assert.ok(over.order.slice(1).every((r) => !r.fits))
})

test("waitsOn: an open parent, a paused ticket; a shipped parent is no wait", async () => {
  const db = open(":memory:")
  const parent = add(db, { status: "running" }), child = add(db, { status: "ready", dep: parent }), p = add(db, { status: "ready" }), done = add(db, { status: "shipped" }), after = add(db, { status: "ready", dep: done })
  await A.pauseAct(db, parsePause(`pause ticket ${p}`)!)
  const rows = Object.fromEntries(D.queueView(db, NOW).order.map((r) => [r.id, r]))
  assert.equal(rows[child].waitsOn, `#${parent}`); assert.equal(rows[child].state, `After #${parent}`)
  assert.equal(rows[after].waitsOn, null)
  assert.equal(rows[p].waitsOn, "paused"); assert.equal(rows[p].state, "Paused")
})

test("reorder: writes priorities so builders take that order; last when no `before`; refuses a ticket that is not queued", async () => {
  const db = open(":memory:")
  const a = add(db, { status: "ready", priority: 70, title: "A" }), b = add(db, { status: "ready", priority: 50, title: "B" }), c = add(db, { status: "ready", priority: 50, title: "C" }), d = add(db, { status: "ready", priority: 10, title: "D" })
  const order = () => ids(D.queueView(db, NOW).order)
  assert.deepEqual(order(), [a, b, c, d])
  assert.match((await A.runAction(db, "reorder", { id: d, before: a })).text, /now 1 of 4/)
  assert.deepEqual(order(), [d, a, b, c])
  assert.equal((nextTicket(db) as { id: number }).id, d, "the builders take the new top")
  await A.runAction(db, "reorder", { id: d }) // last
  assert.deepEqual(order(), [a, b, c, d])
  assert.equal((nextTicket(db) as { id: number }).id, a)
  await A.runAction(db, "reorder", { id: b, before: b }) // before itself: stays put
  assert.deepEqual(order(), [a, b, c, d])
  const pri = (db.prepare("SELECT priority p FROM tickets WHERE status='ready' ORDER BY priority DESC").all() as any[]).map((r) => r.p)
  assert.equal(new Set(pri).size, 4, "every queued ticket has its own priority, so the order cannot tie")
  const run = add(db, { status: "running" }), back = add(db, { status: "backlog" })
  assert.match((await A.runAction(db, "reorder", { id: run })).text, /not queued/)
  assert.match((await A.runAction(db, "reorder", { id: a, before: back })).text, /not queued/)
  assert.deepEqual(order().slice(1), [a, b, c, d]) // a refusal changes nothing
  await assert.rejects(A.runAction(db, "reorder", {}), /needs a ticket id/)
})

test("unqueue: a ready ticket goes back to the backlog; others are left alone", async () => {
  const db = open(":memory:")
  const r = add(db, { status: "ready" }), run = add(db, { status: "running" })
  assert.match((await A.runAction(db, "unqueue", { id: r })).text, /back in the backlog/)
  assert.equal(status(db, r), "backlog")
  assert.deepEqual(ids(D.queueView(db, NOW).parked), [r])
  assert.match((await A.runAction(db, "unqueue", { id: run })).text, /only a queued/)
  assert.equal(status(db, run), "running")
})

const idea = (db: any, o: { title: string; score?: number | null; status?: string; project?: string }) =>
  Number(db.prepare("INSERT INTO ideas (project,title,source,why,score,status,created_at) VALUES (?,?,'pm','because',?,?,?)").run(o.project ?? "tally", o.title, o.score ?? null, o.status ?? "proposed", iso()).lastInsertRowid)

test("ideas: best first, only open ones; make a ticket queues it; dismiss drops it; over MCP a ticket waits for the owner", async () => {
  const db = open(":memory:")
  const low = idea(db, { title: "Low", score: 3 }), top = idea(db, { title: "Top", score: 9 }), none = idea(db, { title: "Unscored" })
  idea(db, { title: "Dropped", status: "rejected" })
  assert.deepEqual(ids(D.queueView(db, NOW).ideas), [top, low, none])
  const sent: unknown[][] = []
  const deps = { ...A.real, inbox: async (...a: unknown[]) => (sent.push(a), null) } as any
  const agent = await A.runAction(db, "idea-ticket", { id: top, agent: true }, deps)
  assert.equal(agent.pending, true); assert.equal(sent.length, 1)
  assert.equal((db.prepare("SELECT count(*) n FROM tickets").get() as any).n, 0, "an agent's ask makes no ticket")
  const made = await A.runAction(db, "idea-ticket", { id: top }, deps)
  assert.match(made.text, /is ticket #1/)
  assert.equal((db.prepare("SELECT status FROM ideas WHERE id=?").get(top) as any).status, "approved")
  assert.equal(status(db, 1), "ready")
  assert.match((await A.runAction(db, "idea-drop", { id: low })).text, /Dropped/)
  assert.deepEqual(ids(D.queueView(db, NOW).ideas), [none])
  assert.match((await A.runAction(db, "idea-drop", { id: 999 })).text, /no idea #999/)
})

test("goal rows: a mark per ticket, the count, the due date and a pace-based status", () => {
  const db = open(":memory:")
  const due = new Date(NOW + 10 * 86_400_000).toISOString()
  db.prepare("INSERT INTO goals (id,project,title,rank,milestone,updated_at) VALUES (1,'tally','Public beta',1,7,'x'),(2,'tally','DRAFT: Later',2,NULL,'x'),(3,'tally','Empty',3,NULL,'x')").run()
  db.prepare("INSERT INTO kv VALUES ('gh:ms:tally', ?)").run(JSON.stringify([{ number: 7, title: "Public beta", due_on: due }]))
  for (let i = 0; i < 14; i++) add(db, { status: "shipped", goal: 1, updated: 24 * i + 1 }) // a ticket a day for 14 days
  add(db, { status: "running", goal: 1 }); add(db, { status: "approval", goal: 1 }); add(db, { status: "backlog", goal: 1 }); add(db, { status: "declined", goal: 1 })
  add(db, { status: "shipped", goal: 2 })
  const g = D.goalRows(db, NOW)
  assert.deepEqual(g.map((x) => x.title), ["Public beta", "Later", "Empty"])
  assert.deepEqual([g[0].done, g[0].total], [14, 17])
  assert.deepEqual(g[0].marks.slice(14), ["running", "running", "waiting"]); assert.equal(g[0].marks.filter((m) => m === "done").length, 14)
  assert.deepEqual(g[0].left.map((l) => l.mark), ["running", "running", "waiting"])
  assert.equal(g[0].due, due); assert.match(g[0].status, /^On track, \d+ days early$/); assert.equal(g[0].late, false)
  assert.equal(g[1].draft, true); assert.equal(g[1].status, "Done")
  assert.equal(g[2].total, 0); assert.equal(g[2].status, "")
  const late = open(":memory:")
  late.prepare("INSERT INTO goals (id,project,title,rank,milestone,updated_at) VALUES (1,'tally','Soon',1,7,'x')").run()
  late.prepare("INSERT INTO kv VALUES ('gh:ms:tally', ?)").run(JSON.stringify([{ number: 7, title: "Soon", due_on: new Date(NOW + 2 * 86_400_000).toISOString() }]))
  add(late, { status: "shipped", goal: 1, updated: 5 }); for (let i = 0; i < 6; i++) add(late, { status: "ready", goal: 1 })
  const l = D.goalRows(late, NOW)[0]
  assert.equal(l.late, true); assert.match(l.status, /^Tight: \d+ days late at this pace$/)
})

test("the snapshot carries the queue and goal rows and the schema accepts them", () => {
  const db = open(":memory:")
  add(db, { status: "ready" }); idea(db, { title: "An idea" })
  db.prepare("INSERT INTO goals (id,project,title,rank,updated_at) VALUES (1,'tally','Beta',1,'x')").run(); add(db, { status: "shipped", goal: 1 })
  const s = Snapshot.parse(JSON.parse(JSON.stringify(D.snapshot(db, NOW, 7, { ...limits(50), five: { used: 10, resetsAt: null }, ratio: 0.1, state: "running", resumesAt: null, line: "" }))))
  assert.equal(s.queue.order.length, 1); assert.equal(s.queue.ideas.length, 1); assert.equal(s.queue.room, 45); assert.equal(s.goalRows[0].done, 1)
})

// ---- the server and the three doors ----
const TOKEN = "tok-queue"
const post = (base: string, body: object) => new Promise<{ status: number; body: any }>((ok, bad) => {
  const u = new URL(base)
  const req = request({ host: u.hostname, port: u.port, path: "/api/action", method: "POST", headers: { "x-foreman-token": TOKEN, origin: base, "content-type": "application/json" } }, (res) => {
    let b = ""; res.on("data", (x) => (b += x)); res.on("end", () => ok({ status: res.statusCode!, body: JSON.parse(b) }))
  })
  req.on("error", bad); req.end(JSON.stringify(body))
})
async function up() {
  const db = open(":memory:"), calls: { args: string[]; direct?: boolean }[] = []
  const server = S.createDashboard(db, { token: TOKEN, now: () => NOW, dist: `${dir}/no-dist`, exec: async (args, direct) => (calls.push({ args, direct }), { ok: true, out: "done\n" }) })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  return { db, server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls }
}

test("POST /api/action: unqueue, reorder, makeTicket run their CLI verb; dismissIdea is held 8 s and can be undone; bad input is refused", async () => {
  const { db, server, base, calls } = await up()
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    const a = add(db, { status: "ready" }), b = add(db, { status: "ready" }), i = idea(db, { title: "An idea" })
    for (const body of [{ action: "unqueue", id: a }, { action: "reorder", id: a, before: b }, { action: "reorder", id: b }, { action: "makeTicket", idea: i }]) assert.equal((await post(base, body)).status, 200, JSON.stringify(body))
    assert.deepEqual(calls, [
      { args: ["unqueue", String(a)], direct: true }, { args: ["reorder", String(a), String(b)], direct: true },
      { args: ["reorder", String(b)], direct: true }, { args: ["ideaticket", String(i)], direct: true },
    ])
    for (const body of [{ action: "unqueue" }, { action: "unqueue", id: 999 }, { action: "reorder", id: a, before: "x" }, { action: "reorder", id: a, before: -1 }, { action: "makeTicket" }, { action: "makeTicket", idea: 999 }, { action: "dismissIdea", idea: "1; ls" }]) {
      const r = await post(base, body); assert.ok(r.status === 400 || r.status === 404, JSON.stringify(body)); assert.equal(r.body.ok, false)
    }
    assert.equal(calls.length, 4, "a refusal runs nothing")
    const d = await post(base, { action: "dismissIdea", idea: i })
    assert.equal(d.status, 200); assert.ok(d.body.actionId); assert.equal(calls.length, 4, "held, not run")
    assert.equal((await post(base, { action: "undo", actionId: d.body.actionId })).status, 200)
    mock.timers.tick(20_000); await new Promise((r) => setImmediate(r))
    assert.equal(calls.length, 4, "an undone dismissal never runs")
    await post(base, { action: "dismissIdea", idea: i }); mock.timers.tick(8000); await new Promise((r) => setImmediate(r))
    assert.deepEqual(calls.at(-1), { args: ["ideadrop", String(i)], direct: true })
  } finally { mock.timers.reset(); server.close() }
})

test("parity: the Queue and Ideas keys each have a label, a CLI verb and an MCP op, and no key repeats in a scope", () => {
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")
  for (const id of ["reorder-up", "reorder-down", "unqueue", "queue-ticket", "make-ticket", "dismiss-idea"]) {
    const e = ACTIONS.find((x) => x.id === id)!
    assert.ok(e, id); assert.ok(e.keys.length && e.label, id)
    assert.match(cli, new RegExp(`case "${e.cli}"`), `${id}: no CLI verb ${e.cli}`)
    const [tool, op] = e.mcp!.split("/")
    assert.ok(A.actions.some((x) => x.mcp.tool === tool && x.mcp.op === op), `${id}: no MCP op ${e.mcp}`)
    assert.ok((S.DASHBOARD_ACTIONS as readonly string[]).includes(e.action!), `${id}: ${e.action} is not an allowed action`)
  }
  const seen = new Set<string>()
  for (const k of [...KEYS, ...ACTIONS.filter((a) => a.keys[0] === "Enter" && a.scope !== "list")]) { const id = `${k.scope}:${k.keys.join(" ")}`; assert.ok(!seen.has(id), `${k.id} repeats ${id}`); seen.add(id) }
})

// Home: the snapshot's inbox/working/week fields, held actions with undo through POST /api/action, the words actions, and the three-doors parity.
import assert from "node:assert/strict"
import { readFileSync, mkdtempSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { mock, test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-home-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/secrets.txt`
const { open } = await import("../src/db.ts")
const S = await import("../src/dashboard-server.ts")
const { snapshot, weekSeries } = await import("../src/dashboard.ts")
const { Snapshot, NewTicket, ActionReply } = await import("../src/api-schema.ts")
const { parseShortstat, diffReader } = await import("../src/diffstat.ts")
const A = await import("../src/actions.ts")
const { ensure } = await import("../src/usage.ts")
const { ACTIONS, KEYS } = await import("../dashboard/src/actions.ts")

const NOW = Date.parse("2026-10-20T12:00:00Z")
const stamp = new Date(NOW - 3_600_000).toISOString()
const add = (db: any, status: string, title: string, note: string | null = null, branch: string | null = null) =>
  Number(db.prepare("INSERT INTO tickets (project,title,status,note,branch,created_at,updated_at) VALUES ('tally',?,?,?,?,?,?)").run(title, status, note, branch, stamp, stamp).lastInsertRowid)
const run = (db: any, ticket: number, kind: string, ok: number) => db.prepare("INSERT INTO runs (at,project,kind,ticket,ok) VALUES (?, 'tally', ?, ?, ?)").run(stamp, kind, ticket, ok)

test("snapshot: inbox rows by kind with checks, diff, age; working rows with round and step; schema accepts it", () => {
  const db = open(":memory:")
  const merge = add(db, "approval", "CSV export", "https://github.com/o/tally/pull/7", "dobby/1")
  run(db, merge, "build", 1); run(db, merge, "check", 1)
  db.prepare("INSERT INTO reviews (repo,pr,sha,verdict,at) VALUES ('o/tally',7,'abc','pass',?)").run(stamp)
  const ask = add(db, "failed", "Login loop", "BLOCKED: needs an answer from the owner: keep the old cookie?")
  const stuck = add(db, "fixing", "Bulk delete", "review still fails: no undo\nhttps://github.com/o/tally/pull/9")
  run(db, stuck, "build", 0)
  const building = add(db, "running", "Dark mode"); run(db, building, "build", 1)
  const early = add(db, "running", "Empty cart")
  db.prepare("INSERT INTO kv VALUES ('deploy:fails:shopfront','2')").run()
  const s = snapshot(db, NOW, 7, null, (_project, branch) => (branch ? { add: 318, del: 41, files: 9 } : null))
  const by: Record<string, any> = Object.fromEntries(s.inbox.rows.map((r) => [r.kind === "deploy" ? "deploy" : r.id, r]))
  assert.equal(s.inbox.total, 4)
  assert.equal(by[merge].kind, "merge"); assert.equal(by[merge].primary, "Merge"); assert.equal(by[merge].status, "Passed review and testing")
  assert.deepEqual(by[merge].checks.map((c: any) => c.state), ["pass", "pass", "pass", "pass", "pass"])
  assert.deepEqual(by[merge].diff, { add: 318, del: 41, files: 9 }); assert.equal(by[merge].age, "1h"); assert.equal(by[merge].url, "https://github.com/o/tally/pull/7")
  assert.deepEqual(by[merge].offers, ["merge", "decline"])
  assert.equal(by[ask].kind, "answer"); assert.match(by[ask].status, /keep the old cookie/); assert.equal(by[ask].diff, null)
  assert.equal(by[stuck].kind, "decide"); assert.equal(by[stuck].warn, true); assert.deepEqual(by[stuck].offers, ["retry", "decline", "takeOver", "allowRound"])
  assert.equal(by[stuck].checks[0].state, "fail"); assert.equal(by[stuck].checks[3].state, "wait")
  assert.equal(by.deploy.status, "Failed 2 times in a row"); assert.equal(by.deploy.id, null)
  const w: Record<number, any> = Object.fromEntries(s.working.map((r) => [r.id, r]))
  assert.deepEqual([w[building].role, w[building].step, w[building].round, w[building].of], ["Testing", "checking", 1, 3])
  assert.deepEqual([w[early].role, w[early].step, w[early].round], ["Builder", "building", 1])
  const parsed = Snapshot.parse(JSON.parse(JSON.stringify(s)))
  assert.deepEqual(parsed.held, []) // the server adds held; a bare snapshot has none
})

test("week.series: this week's stored readings, in order, thinned to at most the limit; an old week is left out", () => {
  const db = open(":memory:"); ensure(db)
  const reset = NOW + 86_400_000
  const put = db.prepare("INSERT INTO usage_ticks VALUES (?,?,?,?,?)")
  put.run(NOW - 9 * 86_400_000, 5, 99, 1, reset - 7 * 86_400_000) // last week
  for (let i = 0; i < 10; i++) put.run(NOW - (10 - i) * 3_600_000, 5, 40 + i, 1, reset)
  const s = snapshot(db, NOW)
  assert.deepEqual(s.week.series.map((p) => p.pct), [40, 41, 42, 43, 44, 45, 46, 47, 48, 49])
  assert.ok(s.week.series[0].t < s.week.series[9].t)
  assert.ok(weekSeries(db, 4).length <= 5); assert.equal(weekSeries(db, 4).at(-1)!.pct, 49)
  assert.deepEqual(snapshot(open(":memory:"), NOW).week.series, [])
})

test("diffstat: parses --shortstat; one rev-parse per poll, one diff per head sha; unsafe branches read as null", () => {
  assert.deepEqual(parseShortstat(" 9 files changed, 318 insertions(+), 41 deletions(-)\n"), { add: 318, del: 41, files: 9 })
  assert.deepEqual(parseShortstat(" 1 file changed, 2 insertions(+)\n"), { add: 2, del: 0, files: 1 })
  assert.equal(parseShortstat(""), null)
  const calls: string[][] = []; let sha = "aaa"
  const read = diffReader((args) => { calls.push(args); return args[0] === "rev-parse" ? sha : " 2 files changed, 5 insertions(+), 1 deletion(-)" }, () => ({ tally: { repo: "/r", base: "main" } }) as any)
  assert.deepEqual(read("tally", "dobby/1"), { add: 5, del: 1, files: 2 }); read("tally", "dobby/1")
  assert.equal(calls.filter((c) => c[0] === "diff").length, 1); assert.equal(calls.filter((c) => c[0] === "rev-parse").length, 2)
  sha = "bbb"; read("tally", "dobby/1"); assert.equal(calls.filter((c) => c[0] === "diff").length, 2)
  assert.equal(read("tally", "--output=x"), null); assert.equal(read("nope", "dobby/1"), null); assert.equal(read("tally", null), null)
})

// ---- POST /api/action ----
const TOKEN = "tok-home"
const post = (base: string, body: object, o: { headers?: Record<string, string> } = {}) => new Promise<{ status: number; body: any }>((ok, bad) => {
  const u = new URL(base)
  const req = request({ host: u.hostname, port: u.port, path: "/api/action", method: "POST", headers: { "x-foreman-token": TOKEN, origin: base, "content-type": "application/json", ...o.headers } }, (res) => {
    let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => ok({ status: res.statusCode!, body: b.startsWith("{") ? JSON.parse(b) : { ok: false, message: b } }))
  })
  req.on("error", bad); req.end(JSON.stringify(body))
})
async function up() {
  const db = open(":memory:"), calls: { args: string[]; direct?: boolean }[] = []
  let fail = false, hang: Promise<void> | null = null, release = () => {}
  const server = S.createDashboard(db, { token: TOKEN, now: () => NOW, dist: `${dir}/no-dist`, exec: async (args, direct) => { calls.push({ args, direct }); if (hang) await hang; return { ok: !fail, out: fail ? "boom\n" : "done\n" } } })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return { db, server, base, calls, failNext: () => { fail = true }, hangNext: () => { hang = new Promise<void>((r) => (release = r)) }, finish: () => release() }
}
const settle = () => new Promise((r) => setImmediate(r))
const held = async (base: string) => ((await (await fetch(`${base}/api/snapshot`, { headers: { "x-foreman-token": TOKEN } })).json()) as any).held

test("every new action: token required, same-origin required, and a bad ticket or body is refused", async () => {
  const { db, server, base, calls } = await up()
  try {
    const id = add(db, "approval", "CSV")
    const bodies = [{ action: "merge", id }, { action: "decline", id }, { action: "retry", id }, { action: "answer", id, text: "yes" }, { action: "hint", id, text: "x" }, { action: "takeOver", id }, { action: "allowRound", id }, { action: "deploy", project: "tally" }, { action: "pauseTeam" }, { action: "pause", id }, { action: "add", project: "tally", title: "x" }, { action: "undo", actionId: "abc" }]
    for (const b of bodies) {
      assert.equal((await post(base, b, { headers: { "x-foreman-token": "wrong" } })).status, 401, `${b.action} token`)
      assert.equal((await post(base, b, { headers: { origin: "http://evil.example" } })).status, 403, `${b.action} origin`)
    }
    assert.equal(calls.length, 0)
    for (const b of [{ action: "merge" }, { action: "merge", id: 999 }, { action: "answer", id }, { action: "answer", id, text: "  " }, { action: "hint", id, text: "x".repeat(2001) }, { action: "deploy", project: "a b;ls" }, { action: "add", project: "tally", title: "" }, { action: "add", project: "tally", title: "x", size: "XL" }]) {
      const r = await post(base, b); assert.ok(r.status === 400 || r.status === 404, JSON.stringify(b)); assert.equal(r.body.ok, false)
    }
    assert.equal(calls.length, 0)
  } finally { server.close() }
})

test("direct actions run at once through their CLI verb: answer, hint, takeOver, allowRound, add, pauseTeam, pause {id}", async () => {
  const { db, server, base, calls } = await up()
  try {
    const id = add(db, "failed", "Login loop")
    for (const b of [{ action: "answer", id, text: "keep it" }, { action: "hint", id, text: "see utils" }, { action: "takeOver", id }, { action: "allowRound", id }]) assert.equal((await post(base, b)).status, 200)
    assert.equal((await post(base, { action: "add", project: "tally", title: "Add a thing", done_when: "it works", size: "S" })).status, 200)
    assert.equal((await post(base, { action: "pauseTeam" })).status, 200)
    assert.equal((await post(base, { action: "pause", id })).status, 200)
    assert.deepEqual(calls, [
      { args: ["answer", String(id), "keep it"], direct: true }, { args: ["hint", String(id), "see utils"], direct: true },
      { args: ["takeover", String(id)], direct: true }, { args: ["allowround", String(id)], direct: true },
      { args: ["add", "tally", "Add a thing", "it works", "S"], direct: true },
      { args: ["pause"], direct: undefined }, { args: ["pause", "ticket", String(id)], direct: undefined },
    ])
  } finally { server.close() }
})

test("merge, decline, retry, deploy are held 8 s then run; undo cancels; closing the tab does not; a double tap runs once", async () => {
  const { db, server, base, calls } = await up()
  const id = add(db, "approval", "CSV export")
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    const r = await post(base, { action: "merge", id })
    assert.equal(r.status, 200); ActionReply.parse(r.body); assert.equal(r.body.runsAt, NOW + 8000)
    assert.equal((await post(base, { action: "merge", id })).body.actionId, r.body.actionId) // double tap: the same hold
    assert.equal(calls.length, 0)
    const h = await held(base); assert.equal(h.length, 1); assert.equal(h[0].state, "held"); assert.equal(h[0].ref, `tally #${id}`)
    mock.timers.tick(7999); await settle(); assert.equal(calls.length, 0)
    mock.timers.tick(1); await settle()
    assert.deepEqual(calls, [{ args: ["merge", String(id)], direct: true }]) // no browser was needed to finish it
    assert.equal((await held(base))[0].state, "ran")
    assert.equal((await post(base, { action: "undo", actionId: r.body.actionId })).status, 404) // too late

    const d = await post(base, { action: "decline", id })
    assert.equal((await post(base, { action: "undo", actionId: d.body.actionId })).status, 200)
    assert.equal((await post(base, { action: "undo", actionId: d.body.actionId })).status, 404)
    mock.timers.tick(20_000); await settle()
    assert.equal(calls.length, 1, "an undone decline never runs")

    await post(base, { action: "retry", id }); await post(base, { action: "deploy", project: "shopfront" })
    mock.timers.tick(8000); await settle()
    assert.deepEqual(calls.slice(1).map((c) => c.args), [["retry", String(id)], ["deploy", "shopfront"]])
  } finally { mock.timers.reset(); server.close() }
})

test("undo after the hold fired is refused: the action is running, shows as running, and a second tap does not start it again", async () => {
  const { db, server, base, calls, hangNext, finish } = await up()
  const id = add(db, "approval", "CSV export")
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    hangNext()
    const m = await post(base, { action: "merge", id })
    mock.timers.tick(8000); await settle()
    assert.equal(calls.length, 1)
    assert.equal((await held(base))[0].state, "running")
    const u = await post(base, { action: "undo", actionId: m.body.actionId })
    assert.equal(u.status, 404); assert.doesNotMatch(u.body.message, /Nothing ran/)
    await post(base, { action: "merge", id }); mock.timers.tick(8000); await settle()
    assert.equal(calls.length, 1, "a tap while it runs does not run it twice")
    assert.equal((await held(base)).length, 1)
    finish(); await settle(); await settle()
    assert.equal((await held(base))[0].state, "ran")
  } finally { mock.timers.reset(); server.close() }
})

test("deploy: only the Deploy tap. No way to pass migrate; the action itself never asks for it", async () => {
  const { server, base, calls } = await up()
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    await post(base, { action: "deploy", project: "shopfront", migrate: true, at: "abc1234" })
    mock.timers.tick(8000); await settle()
    assert.deepEqual(calls, [{ args: ["deploy", "shopfront"], direct: true }])
    assert.doesNotMatch(JSON.stringify(calls), /migrate/)
  } finally { mock.timers.reset(); server.close() }
  const seen: unknown[][] = []
  const deps = { ...A.real, deploy: async (...a: unknown[]) => (seen.push(a), "ok") } as any
  await A.runAction(open(":memory:"), "deploy", { project: "shopfront" }, deps)
  assert.equal(seen[0].length, 2) // (db, project): no options here
  assert.match(readFileSync(new URL("../src/actions.ts", import.meta.url), "utf8"), /deployProject\(db, project, \{ tapped: true \}\)/) // tapped, never migrate
})

test("a held action that fails stays in the list with the reason", async () => {
  const { db, server, base, failNext } = await up()
  const id = add(db, "approval", "CSV")
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    failNext(); await post(base, { action: "merge", id }); mock.timers.tick(8000); await settle()
    const h = (await held(base))[0]; assert.equal(h.state, "failed"); assert.equal(h.message, "boom")
  } finally { mock.timers.reset(); server.close() }
})

// ---- actions.ts ----
const stub = () => { const calls: any[] = []; return { calls, d: { ...A.real, pause: async (_db: any, t: string) => (calls.push(["pause", t]), "paused"), fix: async (_db: any, repo: string, pr: number) => (calls.push(["fix", repo, pr]), "queued"), inbox: async (t: string, b: any, k: string) => void calls.push(["inbox", k]), } as any } }

test("answer and hint add the owner's words to the done rule; an answer queues, an agent's answer does not", async () => {
  const db = open(":memory:"), { d } = stub()
  const id = add(db, "failed", "Login loop")
  assert.match((await A.runAction(db, "hint", { id, text: "look at utils" }, d)).text, /Recorded/)
  assert.equal((db.prepare("SELECT done_when FROM tickets WHERE id=?").get(id) as any).done_when, "Owner's hint: look at utils")
  const o = await A.runAction(db, "answer", { id, text: "keep the old cookie", agent: true }, d)
  assert.equal(o.pending, true); assert.equal((db.prepare("SELECT done_when FROM tickets WHERE id=?").get(id) as any).done_when, "Owner's hint: look at utils"); assert.equal((db.prepare("SELECT status FROM tickets WHERE id=?").get(id) as any).status, "failed")
  await A.runAction(db, "answer", { id, text: "keep the old cookie" }, d)
  assert.equal((db.prepare("SELECT status FROM tickets WHERE id=?").get(id) as any).status, "ready")
  await assert.rejects(A.runAction(db, "answer", { id, text: " " }, d), /needs text/)
  await assert.rejects(A.runAction(db, "hint", { id: 999, text: "x" }, d), /no ticket #999/)
})

test("takeOver pauses that one ticket; allowRound resets the round count and asks for one more fix; retry guards a shipped ticket", async () => {
  const db = open(":memory:"), s = stub()
  const id = add(db, "fixing", "Bulk delete", "https://github.com/o/tally/pull/9", "dobby/5")
  assert.match((await A.runAction(db, "take-over", { id }, s.d)).text, /yours now/)
  assert.deepEqual(s.calls[0], ["pause", `pause ticket ${id}`])
  db.prepare("INSERT INTO kv VALUES ('automerge:o/tally#9', ?)").run(JSON.stringify({ ticket: id, rounds: 2 }))
  await A.runAction(db, "allow-round", { id }, s.d)
  assert.equal(JSON.parse((db.prepare("SELECT v FROM kv WHERE k='automerge:o/tally#9'").get() as any).v).rounds, 1)
  assert.deepEqual(s.calls.at(-1), ["fix", "o/tally", 9])
  const bare = add(db, "failed", "No PR")
  assert.match((await A.runAction(db, "allow-round", { id: bare }, s.d)).text, /no pull request/)
  const done = add(db, "shipped", "Old")
  await assert.rejects(A.runAction(db, "retry", { id: done }, s.d), /already shipped/)
})

test("NewTicket schema: the form and the server share it", () => {
  assert.ok(NewTicket.safeParse({ project: "tally", title: "Add export" }).success)
  assert.equal(NewTicket.safeParse({ project: "tally", title: "  " }).success, false)
  assert.equal(NewTicket.safeParse({ project: "a b", title: "x" }).success, false)
  assert.equal(NewTicket.safeParse({ project: "tally", title: "x", size: "XL" }).success, false)
})

// ---- the three doors ----
test("parity: every dashboard action has a key, a label, a CLI verb and an MCP op; no key is used twice in a scope", () => {
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")
  const verb = (v: string) => new RegExp(`case "${v}"|cmd === "${v}"`).test(cli)
  for (const a of ACTIONS) {
    assert.ok(a.keys.length && a.label, `${a.id}: keys and label`)
    if (a.local) continue // undo only cancels a hold in the dashboard server
    assert.ok(verb(a.cli!), `${a.id}: no CLI verb ${a.cli}`)
    const [tool, op] = a.mcp!.split("/")
    assert.ok(A.actions.some((x) => x.mcp.tool === tool && x.mcp.op === op), `${a.id}: no MCP op ${a.mcp}`)
  }
  const seen = new Map<string, string>()
  for (const k of KEYS) {
    assert.ok(k.keys.length && k.label, k.id)
    const id = `${k.scope}:${k.keys.join(" ")}`
    assert.ok(!seen.has(id), `${k.id} and ${seen.get(id)} share ${id}`)
    seen.set(id, k.id)
  }
  // The server's allowlist and the registry agree. reviewfix and reviewaccept belong to the Reviews page (PR 4).
  const later = ["reviewfix", "reviewaccept"]
  for (const name of S.DASHBOARD_ACTIONS) if (!later.includes(name)) assert.ok(ACTIONS.some((a) => a.action === name), `${name} has no key entry`)
  for (const a of ACTIONS) if (a.action && a.action !== "undo") assert.ok((S.DASHBOARD_ACTIONS as readonly string[]).includes(a.action), `${a.id}: ${a.action} is not an allowed action`)
})

test("an owner-gated draft PR (every merge waits for you) is a Merge card, not a Retry card (#359)", () => {
  const db = open(":memory:")
  const id = add(db, "failed", "Add export", "needs you: every merge waits for you (the strict preset). The finished work is a draft PR: https://github.com/o/tally/pull/12. Dobby will not merge it; merge it yourself if you agree.", "dobby/3")
  const other = add(db, "failed", "Touch auth", "needs you: auth: owner rule. The finished work is a draft PR: https://github.com/o/tally/pull/13. Dobby will not merge it.", "dobby/4")
  const rows = Object.fromEntries(snapshot(db, NOW, 7, null).inbox.rows.map((r) => [r.id, r]))
  assert.equal(rows[id].kind, "merge"); assert.equal(rows[id].primary, "Merge"); assert.deepEqual(rows[id].offers, ["merge", "decline"])
  assert.equal(rows[other].kind, "decide") // a category gate refuses the owner's Merge, so no Merge button
})

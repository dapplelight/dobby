// Reviews and the pull request view: findings kept per row, the review numbers, GET /api/ticket/:id and /api/reviews, the diff (clipped, read only from the project's clone), and the finding actions through their three doors.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { mock, test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-reviews-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/none.txt`
const { open } = await import("../src/db.ts")
const D = await import("../src/dashboard.ts")
const S = await import("../src/dashboard-server.ts")
const A = await import("../src/actions.ts")
const F = await import("../src/findings.ts")
const G = await import("../src/graphs/review.ts")
const { DIFF_MAX, diffTextReader } = await import("../src/diffstat.ts")
const { parseDiff } = await import("../src/diff-parse.ts")
const { TicketDetail, ReviewsPage } = await import("../src/api-schema.ts")
const { ACTIONS } = await import("../dashboard/src/actions.ts")

const NOW = Date.parse("2026-10-20T12:00:00Z")
const WEEK = 7 * 86_400_000
const at = (ms: number) => new Date(ms).toISOString()
const kv = (db: any, k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
const find = (path: string, line: number, severity: "high" | "medium" | "low" = "medium", problem = `Problem at ${path}:${line}`, suggestion?: string) => ({ path, line, severity, problem, fix: "", suggestion })
const review = (db: any, repo: string, pr: number, sha: string, verdict: string, when: number, tookMin: number | null = 6) =>
  db.prepare("INSERT INTO reviews (repo,pr,sha,choice,by,verdict,cost,at,took_ms) VALUES (?,?,?,'sonnet','rule',?,0.2,?,?)").run(repo, pr, sha, verdict, at(when), tookMin === null ? null : tookMin * 60_000)
const DIFF = ["diff --git a/api/orders.ts b/api/orders.ts", "--- a/api/orders.ts", "+++ b/api/orders.ts", "@@ -1,2 +1,4 @@", " keep", "+one", "+two", " tail", ""].join("\n")

test("findings: stored per head, unsafe paths dropped, a re-reported one is not doubled, a gone one is fixed, an open thread stays open", () => {
  const db = open(":memory:")
  F.saveFindings(db, "acme/shop", 7, "s1", 1, at(NOW - 3000), [find("a.ts", 10, "high"), find("b.ts", 5), find("c.ts", 1, "low"), find("../../etc/passwd", 1), find("/abs/path", 2)])
  const rows = (sha: string) => db.prepare("SELECT path, state FROM findings WHERE sha=? ORDER BY path").all(sha) as { path: string; state: string }[]
  assert.deepEqual(rows("s1").map((r) => r.path), ["a.ts", "b.ts", "c.ts"], "paths up a directory or absolute are never stored")
  F.saveFindings(db, "acme/shop", 7, "s2", 2, at(NOW - 2000), [find("a.ts", 10, "high", "Same problem again")], [{ path: "b.ts", line: 5 }])
  assert.deepEqual(rows("s1").map((r) => [r.path, r.state]), [["b.ts", "open"], ["c.ts", "fixed"]]) // a.ts moved to s2; b.ts has an open thread; c.ts is gone
  assert.equal(rows("s2").length, 1)
  assert.equal(F.findingsOf(db, "acme/shop", 7).length, 3)
  assert.equal(F.findingsOf(db, "fork/shop", 7).length, 3, "matched on repo name and number")
  assert.equal(F.kindOf("Add a test for the empty list"), "Missing test"); assert.equal(F.kindOf("User input reaches the query unescaped"), "Security"); assert.equal(F.kindOf("Hmm"), "Other")
})

test("review numbers: six weekly send-back rates, median review time, share of findings fixed, reverts", () => {
  const db = open(":memory:")
  // week w (0 = oldest of the six) holds w+2 reviews, the first of them failing: rates 50, 33, 25, 20, 17, 14
  let n = 0
  for (let w = 0; w < 6; w++) for (let i = 0; i < w + 2; i++) review(db, "acme/shop", 100 + n, `h${n++}`, i === 0 ? "fail" : "pass", NOW - (6 - w) * WEEK + 3_600_000 * (i + 1) + 1000, 2 + (n % 5))
  const m = F.reviewNumbers(db, NOW)
  assert.deepEqual(m.weeks.map((w) => w.pct), [50, 33, 25, 20, 17, 14])
  assert.equal(m.weeks.at(-1)!.reviews, 7)
  assert.equal(m.reviewed, 7); assert.equal(m.sentBackPct, 14) // this week's reviews only
  assert.ok(m.medianMinutes! >= 2 && m.medianMinutes! <= 6)
  // 10 findings: 4 fixed, 1 queued, 2 dismissed, 3 open; fixed + queued + ruled = 50 %
  const states = ["fixed", "fixed", "fixed", "fixed", "queued", "dismissed", "dismissed", "open", "open", "open"]
  states.forEach((st, i) => db.prepare("INSERT INTO findings (repo,pr,sha,path,line,severity,kind,problem,round,state,at) VALUES ('acme/shop',1,?,?,?,?,?,?,1,?,?)").run(`s${i}`, "f.ts", i, i < 2 ? "high" : i < 5 ? "medium" : "low", i < 4 ? "Missing test" : "Edge case", "p", st, at(NOW - 3_600_000)))
  db.prepare("INSERT INTO runs (at,project,kind,ok,human) VALUES (?, 'shop', 'build', 1, 'reverted')").run(at(NOW - 3_600_000))
  const m2 = F.reviewNumbers(db, NOW)
  assert.deepEqual(m2.findings, { total: 10, fixed: 5, dismissed: 2, open: 3 }); assert.equal(m2.fixedPct, 50); assert.equal(m2.reverts, 1)
  assert.deepEqual(m2.kinds.map((k) => [k.kind, k.b, k.s, k.n]), [["Edge case", 0, 1, 5], ["Missing test", 2, 2, 0]])
  assert.equal(F.reviewNumbers(open(":memory:"), NOW).medianMinutes, null, "no reviews: no median")
})

const withPr = () => {
  const db = open(":memory:")
  db.prepare("INSERT INTO tickets (id,project,title,status,note,branch,created_at,updated_at) VALUES (198,'shop','Bulk delete','fixing','https://github.com/acme/shop/pull/198','dobby/198-bulk',?,?)").run(at(NOW - WEEK), at(NOW - 3600))
  review(db, "acme/shop", 198, "r1", "fail", NOW - 7200_000, 9); review(db, "acme/shop", 198, "r2", "fail", NOW - 3600_000, 8)
  F.saveFindings(db, "acme/shop", 198, "r1", 1, at(NOW - 7200_000), [find("api/orders.ts", 3, "high", "No undo.", "two2")])
  F.saveFindings(db, "acme/shop", 198, "r2", 2, at(NOW - 3600_000), [find("api/orders.ts", 3, "high", "Still no undo.", "two2"), find("api/orders.ts", 99, "low", "Naming.")])
  return db
}
const diffOf = (text = DIFF) => () => ({ text, clipped: 0 })

test("ticketDetail: files with add and del, findings with their line's own text, rounds, and the diff; shaped as the schema says", () => {
  const db = withPr()
  const t = D.ticketDetail(db, 198, NOW, diffOf())!
  TicketDetail.parse(JSON.parse(JSON.stringify(t)))
  assert.deepEqual(t.files, [{ path: "api/orders.ts", add: 2, del: 0, blocking: 1, findings: 2 }])
  const f = t.findings.find((x) => x.line === 3)!
  assert.equal(f.was, "two"); assert.equal(f.suggestion, "two2"); assert.equal(f.round, 2); assert.equal(f.state, "open"); assert.equal(f.word, "Blocking"); assert.equal(t.findings.find((x) => x.line === 99)!.was, null)
  assert.deepEqual(t.rounds.map((r) => [r.n, r.verdict]), [[1, "fail"], [2, "fail"]]); assert.match(t.rounds[1].what, /^Changes requested: Still no undo; Naming/)
  assert.equal(D.ticketDetail(db, 198, NOW)!.diff, null, "no reader: no diff"); assert.equal(D.ticketDetail(db, 1, NOW), null)
  const r = D.reviewsPage(db, NOW)
  ReviewsPage.parse(JSON.parse(JSON.stringify(r)))
  assert.equal(r.prs[0].ticket, 198); assert.equal(r.prs[0].round, 2); assert.deepEqual([r.prs[0].b, r.prs[0].s, r.prs[0].n], [1, 0, 1]); assert.equal(r.prs[0].tookMin, 8)
})

test("diff: clipped at 200 KB with the count left out; read with git in the project's own clone only; a finding's path outside it is never used", () => {
  const calls: { args: string[]; cwd: string }[] = []
  const big = `${DIFF}${"+x\n".repeat(DIFF_MAX)}`
  const read = diffTextReader((args, cwd) => (calls.push({ args, cwd }), big), () => ({ shop: { repo: "/clones/shop", base: "main" } as any }))
  const d = read("shop", "dobby/198-bulk")!
  assert.equal(d.text.length, DIFF_MAX); assert.equal(d.clipped, big.length - DIFF_MAX)
  assert.deepEqual(calls, [{ args: ["diff", "main...dobby/198-bulk"], cwd: "/clones/shop" }])
  for (const bad of ["../../etc", "-x", "a b", "a;b", ""]) assert.equal(read("shop", bad), null, bad)
  assert.equal(read("nope", "dobby/1"), null); assert.equal(calls.length, 1, "nothing else reached git")
  assert.equal(diffTextReader(() => null, () => ({ shop: { repo: "/c", base: "main" } as any }))("shop", "dobby/1"), null)
  // a stored finding whose path leaves the clone (an old row) is not served, and no file is ever opened for it
  const db = withPr()
  for (const p of ["../../etc/passwd", "/etc/passwd"]) db.prepare("INSERT INTO findings (repo,pr,sha,path,line,severity,kind,problem,round,state,at) VALUES ('acme/shop',198,'r2',?,1,'high','Other','x',2,'open',?)").run(p, at(NOW))
  const t = D.ticketDetail(db, 198, NOW, diffOf())!
  assert.ok(t.findings.length === 2 && t.findings.every((f) => !f.file.includes("..") && !f.file.startsWith("/")))
  assert.equal(parseDiff(DIFF)[0].lines.find((l) => l.new === 3)!.text, "two")
})

const TOKEN = "tok-reviews"
type Reply = { status: number; body: any }
const call = (base: string, o: { method?: string; path: string; body?: object; token?: boolean; origin?: string }) => new Promise<Reply>((ok, bad) => {
  const u = new URL(base)
  const req = request({ host: u.hostname, port: u.port, path: o.path, method: o.method ?? "GET", headers: { ...(o.token === false ? {} : { "x-foreman-token": TOKEN }), origin: o.origin ?? base, "content-type": "application/json" } }, (res) => {
    let b = ""; res.on("data", (x) => (b += x)); res.on("end", () => { let j: any = b; try { j = JSON.parse(b) } catch {} ok({ status: res.statusCode!, body: j }) })
  })
  req.on("error", bad); req.end(o.body ? JSON.stringify(o.body) : undefined)
})
async function up(db = withPr()) {
  const calls: { args: string[]; direct?: boolean }[] = []
  const server = S.createDashboard(db, { token: TOKEN, now: () => NOW, dist: `${dir}/no-dist`, diffText: diffOf(), exec: async (args, direct) => (calls.push({ args, direct }), { ok: true, out: "done\n" }) })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  return { db, server, calls, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}

test("GET /api/ticket/:id and /api/reviews need the token like every /api route, and send the schema's shape", async () => {
  const { server, base } = await up()
  try {
    for (const path of ["/api/ticket/198", "/api/reviews"]) { assert.equal((await call(base, { path, token: false })).status, 401, path); assert.equal((await call(base, { path })).status, 200, path) }
    const t = (await call(base, { path: "/api/ticket/198" })).body
    assert.equal(TicketDetail.safeParse(t).success, true); assert.equal(t.files.length, 1); assert.equal(t.diff.clipped, 0)
    assert.equal(ReviewsPage.safeParse((await call(base, { path: "/api/reviews" })).body).success, true)
    assert.equal((await call(base, { path: "/api/ticket/9999" })).status, 404)
  } finally { server.close() }
})

test("finding actions over POST /api/action: token and same-origin first; apply and rule run their verb, dismiss is held 8 s and undo stops it; bad input runs nothing", async () => {
  const { db, server, base, calls } = await up()
  mock.timers.enable({ apis: ["setTimeout"] })
  try {
    const id = F.findingsOf(db, "acme/shop", 198)[0].id
    const go = (body: object, o: object = {}) => call(base, { method: "POST", path: "/api/action", body, ...o })
    assert.equal((await go({ action: "applyFinding", finding: id }, { token: false })).status, 401)
    assert.equal((await go({ action: "applyFinding", finding: id }, { origin: "http://evil.example" })).status, 403)
    assert.equal(calls.length, 0)
    assert.equal((await go({ action: "applyFinding", finding: id })).status, 200)
    assert.equal((await go({ action: "ruleFromFinding", finding: id, text: "Soft delete is fine here" })).status, 200)
    assert.equal((await go({ action: "ruleFromFinding", finding: id })).status, 200)
    assert.deepEqual(calls, [{ args: ["applyfinding", String(id)], direct: true }, { args: ["findingrule", String(id), "Soft delete is fine here"], direct: true }, { args: ["findingrule", String(id)], direct: true }])
    for (const body of [{ action: "applyFinding" }, { action: "dismissFinding", finding: "1" }, { action: "ruleFromFinding", finding: -1 }, { action: "applyFinding", finding: 9999 }, { action: "ruleFromFinding", finding: id, text: 5 }]) {
      const r = await go(body); assert.ok(r.status === 400 || r.status === 404, JSON.stringify(body)); assert.equal(r.body.ok, false)
    }
    assert.equal(calls.length, 3, "a refusal runs nothing")
    const d = await go({ action: "dismissFinding", finding: id })
    assert.equal(d.status, 200); assert.ok(d.body.actionId); assert.equal(calls.length, 3, "held, not run")
    assert.equal((await go({ action: "undo", actionId: d.body.actionId })).status, 200)
    mock.timers.tick(20_000); await new Promise((r) => setImmediate(r))
    assert.equal(calls.length, 3, "an undone dismissal never runs")
    await go({ action: "dismissFinding", finding: id }); mock.timers.tick(8000); await new Promise((r) => setImmediate(r))
    assert.deepEqual(calls.at(-1), { args: ["dismissfinding", String(id)], direct: true })
  } finally { mock.timers.reset(); server.close() }
})

test("finding actions: dismiss and rule store a learning for the repo and set the state; apply goes through the injected fix", async () => {
  const db = withPr()
  const [a, b] = F.findingsOf(db, "acme/shop", 198)
  const learned = () => JSON.parse(kv(db, "review:learn:acme/shop") ?? "[]") as { path: string; problem: string }[]
  assert.match((await A.runAction(db, "dismiss-finding", { id: a.id })).text, /Dismissed/)
  assert.deepEqual(learned().map((l) => [l.path, l.problem]), [["api/orders.ts", a.problem]])
  assert.equal(F.findingById(db, a.id)!.state, "dismissed")
  assert.match((await A.runAction(db, "dismiss-finding", { id: a.id })).text, /already dismissed/)
  assert.match((await A.runAction(db, "rule-from-finding", { id: b.id, text: "  Names are the owner's call.  " })).text, /Rule saved/)
  assert.equal(learned()[0].path, "any file"); assert.equal(learned()[0].problem, "Names are the owner's call."); assert.equal(F.findingById(db, b.id)!.state, "ruled")
  assert.equal(G.ruleText("x".repeat(500)).length, 300)
  const seen: number[] = []
  const d = { ...A.real, applyFinding: async (_db: any, id: number) => (seen.push(id), "queued") }
  assert.equal((await A.runAction(db, "apply-finding", { id: b.id }, d)).text, "queued"); assert.deepEqual(seen, [b.id])
  assert.match((await A.runAction(db, "dismiss-finding", { id: 9999 })).text, /no finding/)
  await assert.rejects(A.runAction(db, "apply-finding", {}, d), /ticket id/)
})

test("apply: a fixed or unknown finding is refused before anything runs", async () => {
  const db = withPr()
  const [a] = F.findingsOf(db, "acme/shop", 198)
  const ran: string[] = []
  const d = { run: (cmd: string) => (ran.push(cmd), { ok: false, out: "" }) } as any
  db.prepare("UPDATE findings SET state='fixed' WHERE id=?").run(a.id)
  assert.match(await G.applyFinding(db, a.id, d, {}), /is fixed; there is nothing to apply/)
  assert.match(await G.applyFinding(db, 9999, d, {}), /no finding/)
  assert.deepEqual(ran, [])
})

test("three doors: every finding action has keys, a label, a CLI verb and an MCP op, and is on the server's allowlist", () => {
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")
  for (const [id, action] of [["apply-finding", "applyFinding"], ["dismiss-finding", "dismissFinding"], ["rule-from-finding", "ruleFromFinding"]]) {
    const e = ACTIONS.find((x) => x.id === id)!
    assert.ok(e && e.keys.length && e.label && e.scope === "detail", id); assert.equal(e.action, action)
    assert.match(cli, new RegExp(`case "${e.cli}"`), `${id}: no CLI verb ${e.cli}`)
    const [tool, op] = e.mcp!.split("/")
    assert.ok(A.actions.some((x) => x.mcp.tool === tool && x.mcp.op === op), `${id}: no MCP op ${e.mcp}`)
    assert.ok((S.DASHBOARD_ACTIONS as readonly string[]).includes(action))
  }
})

test("a pass settles the earlier findings as fixed", () => {
  const db = open(":memory:")
  review(db, "acme/shop", 3, "p1", "fail", NOW - 100_000, 5)
  F.saveFindings(db, "acme/shop", 3, "p1", 1, at(NOW), [find("a.ts", 1, "high")])
  review(db, "acme/shop", 3, "p2", "pass", NOW, 3)
  F.saveFindings(db, "acme/shop", 3, "p2", 2, at(NOW), [], [])
  assert.deepEqual(F.findingsOf(db, "acme/shop", 3).map((f) => f.state), ["fixed"])
})

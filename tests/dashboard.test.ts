// Dashboard panels over an in-memory DB, and the server's guards. Offline: no network, nothing written outside the temp dir.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

process.env.DOBBY_DIR = mkdtempSync(`${tmpdir()}/foreman-dash-`)
const { open, logRun, logCheck } = await import("../src/db.ts")
const D = await import("../src/dashboard.ts")
const { ensure } = await import("../src/usage.ts")

const NOW = Date.parse("2026-10-20T12:00:00Z")
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
let n = 0
function ticket(db: any, o: { project?: string; title?: string; status: string; created?: number; updated?: number; note?: string; goal?: number }) {
  const id = ++n
  db.prepare("INSERT INTO tickets (id,project,title,status,note,goal,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, o.project ?? "tally", o.title ?? `Thing ${id}: details`, o.status, o.note ?? null, o.goal ?? null, hoursAgo(o.created ?? 48), hoursAgo(o.updated ?? 1))
  return id
}

test("now: building, ready, stuck with reasons, last tick, failing jobs", () => {
  const db = open(":memory:")
  ticket(db, { status: "running", title: "Add dark mode: toggle", updated: 2 })
  ticket(db, { status: "ready" }); ticket(db, { status: "ready" })
  ticket(db, { status: "failed", title: "Fix import", note: "merge conflict" })
  db.prepare("INSERT INTO kv VALUES ('tick:last', ?)").run(String(NOW - 5 * 60_000))
  logCheck(db, "disk", true, "", hoursAgo(3)); logCheck(db, "disk", false, "98% full", hoursAgo(1)); logCheck(db, "launchd", true, "", hoursAgo(1))
  const p = D.nowPanel(db, NOW)
  assert.deepEqual(p.building.map((b) => [b.title, b.app, b.since]), [["Add dark mode", "tally", "2h"]])
  assert.equal(p.ready.length, 2)
  assert.deepEqual(p.stuck.map((s) => [s.title, s.reason]), [["Fix import", "merge conflict"]])
  assert.equal(p.lastTickAgo, "5m"); assert.equal(p.lastRunAgo, null)
  assert.equal(D.nowPanel(open(":memory:"), NOW).lastTickAgo, null)
  assert.deepEqual(p.jobs, { ok: 1, total: 2, failing: [{ name: "disk", detail: "98% full", since: "1h" }] }) // latest result per check only
})

test("now: fixing tickets are listed as waiting on a fix, not as building", () => {
  const db = open(":memory:")
  ticket(db, { status: "fixing", title: "Review found issues: x", note: "needs a fix" })
  logRun(db, { project: "tally", kind: "build", ok: true }, hoursAgo(1))
  const p = D.nowPanel(db, NOW)
  assert.equal(p.building.length, 0); assert.equal(p.stuck[0].state, "waiting on a fix"); assert.equal(p.lastRunAgo, "1h")
})

test("needs me: grouped by why, one plain action per group, biggest first, titles without ticket numbers", () => {
  const db = open(":memory:")
  ticket(db, { status: "failed", title: "Add export: csv", note: "BLOCKED: the Dobby guard hook refused every command that runs Python" })
  ticket(db, { status: "failed", title: "Fix footer", note: "BLOCKED: I couldn't run anything the ticket needs" })
  ticket(db, { status: "failed", title: "Ship QA browser", note: "BLOCKED: Ticket #346 can't be finished without the owner's written yes/no" })
  ticket(db, { status: "failed", title: "Merge main in", note: "needs you: 2 builds did not get it through QA: Checker: No merge was done: the worktree has no merge" })
  ticket(db, { status: "fixing", title: "Review found issues: y", note: "Review found issues; auto-fix round 1/2" })
  ticket(db, { status: "failed", title: "Old one", note: "triage 21 Oct: merged #363 into this" })
  ticket(db, { status: "failed", title: "Odd", note: "something new" })
  ticket(db, { status: "shipped", title: "Done thing" })
  db.prepare("INSERT INTO kv VALUES ('deploy:fails:tally', '3')").run()
  logCheck(db, "disk", false, "98% full", hoursAgo(1))
  const g = D.needsMe(db, NOW)
  assert.deepEqual([g[0].reason, g[0].action, g[0].items.length], ["Blocked by the guard", "Allow the command in the role, or do this one by hand.", 2])
  assert.ok(g[0].items.every((i) => i.id && i.app === "tally" && i.since === "1h"))
  const by = Object.fromEntries(g.map((x) => [x.reason, x.items.map((i) => i.title)]))
  assert.deepEqual(by, {
    "Blocked by the guard": ["Add export", "Fix footer"],
    "Waiting on your answer": ["Ship QA browser"],
    "Merge conflict to fix by hand": ["Merge main in"],
    "Review fix not landing": ["Review found issues"],
    "Merged into another ticket": ["Old one"],
    "Something else": ["Odd"],
    "Deploy failing": ["tally: failed 3 times in a row"],
    "A Dobby job is failing": ["disk: 98% full"],
  })
  for (const x of g) { assert.ok(x.action.length > 10, x.reason); for (const i of x.items) assert.doesNotMatch(i.title, /#\d/) }
  assert.deepEqual(D.needsMe(open(":memory:"), NOW), [])
})

test("outcomes: per day, median hours, share shipped with no owner touch", () => {
  const db = open(":memory:"); ensure(db)
  const a = ticket(db, { status: "shipped", created: 10, updated: 2 })  // 8h
  ticket(db, { status: "shipped", created: 30, updated: 6 })            // 24h
  ticket(db, { status: "shipped", created: 600, updated: 24 * 20 })     // 20 days ago: only in the 30-day window
  ticket(db, { status: "failed", updated: 1 })
  db.prepare("INSERT INTO touches (at, ticket, kind, tag) VALUES (?,?,?,?)").run(NOW, a, "broke", "broke")
  const w7 = D.outcomes(db, NOW, 7), w30 = D.outcomes(db, NOW, 30)
  assert.equal(w7.shipped, 2); assert.equal(w30.shipped, 3)
  assert.equal(w7.perDay.length, 7); assert.equal(w7.perDay.at(-1)!.n, 2); assert.equal(w30.perDay.length, 30)
  assert.equal(w7.medianHours, 16)
  assert.equal(w7.noTouchPct, 50)
  assert.equal(D.outcomes(open(":memory:"), NOW, 7).medianHours, null) // nothing shipped: no number, not zero
})

test("quality: verdicts per day, pass rate by repo (skips and errors are not judgements), rework, Checker sent-back rate", () => {
  const db = open(":memory:")
  const rv = db.prepare("INSERT INTO reviews (repo,pr,sha,choice,by,verdict,cost,at) VALUES (?,?,?,?,?,?,?,?)")
  rv.run("o/tally", 1, "a", "opus", "rule", "pass", 0.1, hoursAgo(1)); rv.run("o/tally", 2, "b", "opus", "rule", "fail", 0.1, hoursAgo(2))
  rv.run("o/tally", 3, "c", "none", "rule", "skip", 0, hoursAgo(3)); rv.run("o/foreman", 4, "d", "sonnet", "fallback", "pass", 0.1, hoursAgo(4))
  const q = D.quality(db, NOW, 7)
  assert.deepEqual(q.verdictsPerDay.at(-1), { day: "2026-10-20", pass: 2, fail: 1, skip: 1, error: 0 })
  assert.deepEqual(q.passRateByRepo, [{ repo: "o/tally", pass: 1, total: 2, pct: 50 }, { repo: "o/foreman", pass: 1, total: 1, pct: 100 }])
  assert.equal(q.passPct, 67)

  const t1 = ticket(db, { status: "shipped" }), t2 = ticket(db, { status: "shipped" })
  const run = (kind: string, ticket: number, ok = true) => logRun(db, { project: "tally", kind, ticket, ok }, hoursAgo(5))
  run("build", t1); run("check", t1)                    // passed first time
  run("build", t2); run("check", t2); run("build", t2)  // check sent it back, built again
  const q2 = D.quality(db, NOW, 7)
  assert.deepEqual(q2.rework, { tickets: 2, avgBuilds: 1.5, once: 1, twice: 1, more: 0 })
  assert.deepEqual(q2.checker, { checks: 2, sentBack: 1, pct: 50 })
})

test("spend: by role and model, per day, per shipped ticket by app, latest plan usage", () => {
  const db = open(":memory:"); ensure(db)
  logRun(db, { project: "tally", kind: "build", model: "opus", ok: true, cost_usd: 3 }, hoursAgo(1))
  logRun(db, { project: "tally", kind: "check", model: "sonnet", ok: true, cost_usd: 1 }, hoursAgo(2))
  logRun(db, { project: "foreman", kind: "build", model: "sonnet", ok: true, cost_usd: 2 }, hoursAgo(30))
  logRun(db, { project: "tally", kind: "build", model: "opus", ok: true, cost_usd: 99 }, hoursAgo(24 * 10)) // outside 7 days
  ticket(db, { status: "shipped" }); ticket(db, { status: "shipped" })
  db.prepare("INSERT INTO usage_ticks VALUES (?,?,?,?,?)").run(NOW - 60_000, 40, 12, NOW + 3600_000, NOW + 86400_000)
  db.prepare("INSERT INTO usage_ticks VALUES (?,?,?,?,?)").run(NOW - 600_000, 38, 12, NOW + 3600_000, NOW + 86400_000)
  const s = D.spend(db, NOW, 7)
  assert.equal(s.total, 6)
  assert.deepEqual(s.byRole, [{ name: "build", usd: 5 }, { name: "check", usd: 1 }])
  assert.deepEqual(s.byModel.map((m) => m.usd), [3, 3])
  assert.equal(s.perDay.at(-1)!.usd, 4); assert.equal(s.perDay.at(-1)!.parts.build, 3)
  assert.deepEqual(s.perShippedByApp.find((a) => a.app === "tally"), { app: "tally", usd: 4, shipped: 2, reworkFixes: 0, perTicket: 2 })
  assert.equal(s.perShippedByApp.find((a) => a.app === "foreman")!.perTicket, null) // spend without a shipped ticket: no ratio
  assert.deepEqual(s.usage, { fivePct: 40, weekPct: 12, fiveResetAt: NOW + 3600_000, weekResetAt: NOW + 86400_000, readAgo: "1m" })
  assert.equal(D.spend(open(":memory:"), NOW, 7).usage, null) // no usage table rows
})

test("goals: shipped, open, failed per active goal; dropped ones hidden", () => {
  const db = open(":memory:")
  db.prepare("INSERT INTO goals (id,project,title,rank,status,updated_at) VALUES (1,'tally','DRAFT: Launch',1,'active','x'),(2,'tally','Old',2,'dropped','x'),(3,'foreman','Overnight',1,'active','x')").run()
  ticket(db, { status: "shipped", goal: 1 }); ticket(db, { status: "backlog", goal: 1 }); ticket(db, { status: "running", goal: 1 }); ticket(db, { status: "failed", goal: 1 }); ticket(db, { status: "declined", goal: 1 })
  assert.deepEqual(D.goals(db), [
    { app: "foreman", goals: [{ rank: 1, title: "Overnight", draft: false, shipped: 0, open: 0, failed: 0 }] },
    { app: "tally", goals: [{ rank: 1, title: "Launch", draft: true, shipped: 1, open: 2, failed: 1 }] },
  ])
})

test("queue: backlog by app and age bucket, failed with reason", () => {
  const db = open(":memory:")
  ticket(db, { status: "backlog", created: 5 }); ticket(db, { status: "backlog", created: 24 * 2 }); ticket(db, { status: "backlog", created: 24 * 9 })
  ticket(db, { project: "shopfront", status: "backlog", created: 24 * 4 })
  ticket(db, { status: "failed", note: "" })
  const q = D.queue(db, NOW)
  assert.deepEqual(q.backlog[0], { app: "tally", total: 3, buckets: { "under 1 day": 1, "1-3 days": 1, "3-7 days": 0, "over 7 days": 1 } })
  assert.equal(q.backlog[1].app, "shopfront")
  assert.equal(q.failed[0].reason, "no reason recorded")
  assert.equal(q.next.length, 4); assert.deepEqual(q.next.map((t) => t.since), ["5h", "2d", "9d", "4d"]) // backlog rows the owner can queue, oldest first at equal priority
})

test("reviews: newest first, title from the ticket that holds the PR link, none when unknown, running hidden", () => {
  const db = open(":memory:")
  ticket(db, { status: "shipped", title: "Fix the thing: details", note: "https://github.com/ownerdev/tally/pull/600" })
  const rv = db.prepare("INSERT INTO reviews (repo,pr,sha,choice,by,verdict,cost,at) VALUES (?,?,?,?,?,?,?,?)")
  rv.run("acmeorg/tally", 600, "a", "opus", "rule", "pass", 0.1072, hoursAgo(1)); rv.run("acmeorg/tally", 60, "b", "sonnet", "jev", "fail", 0.05, hoursAgo(2))
  rv.run("acmeorg/tally", 9, "c", null, null, "running", null, hoursAgo(0))
  const r = D.reviews(db)
  assert.deepEqual(r.map((x) => [x.pr, x.title, x.verdict, x.cost]), [[600, "Fix the thing", "pass", 0.11], [60, null, "fail", 0.05]]) // #60 must not match #600
  assert.equal(r[0].url, "https://github.com/acmeorg/tally/pull/600")
})

test("ticketDetail: ticket, its runs, and the reviews of the PR its note links", () => {
  const db = open(":memory:")
  const id = ticket(db, { title: "Add dark mode: toggle in settings", status: "shipped", note: "merged https://github.com/acmeorg/tally/pull/600", updated: 3 })
  ticket(db, { status: "shipped", note: "https://github.com/acmeorg/tally/pull/6" })
  db.prepare("INSERT INTO runs (at,project,kind,model,ok,reason,duration_ms,cost_usd,ticket) VALUES (?,?,?,?,?,?,?,?,?)").run(hoursAgo(5), "tally", "build", "sonnet", 0, "tests failed", 150_000, 0.456, id)
  db.prepare("INSERT INTO runs (at,project,kind,model,ok,reason,duration_ms,cost_usd,ticket) VALUES (?,?,?,?,?,?,?,?,?)").run(hoursAgo(4), "tally", "build", "sonnet", 1, null, 600_000, 1.2, id)
  db.prepare("INSERT INTO runs (at,project,kind,ok,ticket) VALUES (?,?,?,?,?)").run(hoursAgo(1), "tally", "check", 1, id + 1) // another ticket's run
  const rv = db.prepare("INSERT INTO reviews (repo,pr,sha,choice,by,verdict,cost,at) VALUES (?,?,?,?,?,?,?,?)")
  rv.run("other/tally", 600, "a", "opus", "rule", "pass", 0.1072, hoursAgo(2)); rv.run("acmeorg/tally", 6, "b", null, null, "fail", null, hoursAgo(2)); rv.run("acmeorg/tally", 600, "c", null, null, "running", null, hoursAgo(0))
  const d = D.ticketDetail(db, id, NOW)!
  assert.equal(d.title, "Add dark mode"); assert.equal(d.app, "tally"); assert.equal(d.status, "shipped"); assert.equal(d.updated, "3h")
  assert.deepEqual(d.runs.map((r) => [r.kind, r.ok, r.minutes, r.usd, r.reason]), [["build", false, 2.5, 0.46, "tests failed"], ["build", true, 10, 1.2, null]])
  assert.equal(d.runsUsd, 1.66)
  assert.equal(d.pr?.url, "https://github.com/acmeorg/tally/pull/600")
  assert.deepEqual(d.reviews.map((r) => [r.pr, r.verdict, r.cost]), [[600, "pass", 0.11]]) // not PR 6, not the running one
  assert.equal(D.ticketDetail(db, 999, NOW), null)
  assert.deepEqual(D.ticketDetail(db, id + 1, NOW)!.runs.map((r) => r.kind), ["check"])
  assert.equal(D.ticketDetail(open(":memory:"), 1, NOW), null) // empty DB: no throw
})

test("snapshot is plain JSON", () => {
  const s = JSON.parse(JSON.stringify(D.snapshot(open(":memory:"), NOW, 30)))
  assert.equal(s.days, 30); assert.equal(s.outcomes.perDay.length, 30)
})

const S = await import("../src/dashboard-server.ts")
async function up(opts: Parameters<typeof S.createDashboard>[1] = {}) {
  const server = S.createDashboard(open(":memory:"), { page: () => "<h1>ok</h1>", now: () => NOW, dist: `${process.env.DOBBY_DIR}/no-dist`, ...opts })
  await new Promise<void>((ok) => server.listen(0, opts.host ?? "127.0.0.1", ok))
  const { port } = server.address() as { port: number }
  return { server, base: `http://127.0.0.1:${port}`, port }
}

test("server: binds loopback by default, serves page and snapshot on GET", async () => {
  assert.deepEqual(S.parseArgs([]), { port: 4710, host: "127.0.0.1", tunnel: false })
  assert.deepEqual(S.parseArgs(["--port", "5000", "--host", "0.0.0.0", "--tunnel"]), { port: 5000, host: "0.0.0.0", tunnel: true })
  assert.throws(() => S.parseArgs(["--port", "x"]))
  const { server, base } = await up()
  try {
    assert.equal((server.address() as any).address, "127.0.0.1")
    assert.equal(await (await fetch(`${base}/`)).text(), "<h1>ok</h1>")
    const j = await (await fetch(`${base}/api/snapshot?days=30`)).json() as any
    assert.equal(j.days, 30); assert.equal((await (await fetch(`${base}/api/snapshot`)).json() as any).days, 7)
    assert.equal((await fetch(`${base}/nope`)).status, 404)
  } finally { server.close() }
})

test("server: on loopback with a token, the page loads but its data needs the token (audit 24 Oct L1)", async () => {
  const { server, base } = await up({ token: "s3cret" })
  try {
    assert.equal((await fetch(`${base}/`)).status, 200)
    assert.equal((await fetch(`${base}/api/snapshot`)).status, 401)
    assert.equal((await fetch(`${base}/api/ticket/1`)).status, 401)
    assert.equal((await fetch(`${base}/api/session`)).status, 200)
    const auth = await fetch(`${base}/auth?token=s3cret`, { redirect: "manual" })
    const cookie = (auth.headers.get("set-cookie") ?? "").split(";")[0]
    assert.equal((await fetch(`${base}/api/snapshot`, { headers: { cookie } })).status, 200)
  } finally { server.close() }
})

test("server: refuses anything but GET, and a foreign Host header (DNS rebinding)", async () => {
  const { server, base } = await up()
  try {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) assert.equal((await fetch(`${base}/api/snapshot`, { method })).status, 405, method)
    const r = await new Promise<number>((ok) => {
      import("node:http").then((h) => h.get(base + "/", { headers: { host: "evil.example" } }, (res) => { res.resume(); ok(res.statusCode!) }))
    })
    assert.equal(r, 403)
  } finally { server.close() }
})

test("server: --tunnel stays on loopback but every request needs the token (a tunnel's peer is 127.0.0.1); a tunnel Host is fine", async () => {
  assert.throws(() => S.createDashboard(open(":memory:"), { tunnel: true }), /DASHBOARD_TOKEN/)
  const { server, base } = await up({ tunnel: true, token: "s3cret" })
  try {
    const h = { host: "mac.tail1234.ts.net" }
    assert.equal((await fetch(`${base}/`, { headers: h })).status, 401)
    assert.equal((await fetch(`${base}/api/snapshot`)).status, 401)
    const auth = await fetch(`${base}/auth?token=s3cret`, { headers: { ...h, "x-forwarded-proto": "https" }, redirect: "manual" })
    assert.equal(auth.status, 302)
    assert.match(auth.headers.get("set-cookie") ?? "", /HttpOnly; SameSite=Strict; Path=\/; Secure/)
  } finally { server.close() }
})

test("server: a non-loopback host needs a configured token and the right ?token=", async () => {
  assert.throws(() => S.createDashboard(open(":memory:"), { host: "0.0.0.0" }), /DASHBOARD_TOKEN/)
  const { server, base } = await up({ host: "0.0.0.0", token: "s3cret" })
  try {
    assert.equal((await fetch(`${base}/`)).status, 401)
    assert.equal((await fetch(`${base}/?token=wrong`)).status, 401)
    assert.equal((await fetch(`${base}/?token=s3cret`, { redirect: "manual" })).status, 302)
    assert.equal((await fetch(`${base}/api/snapshot`)).status, 401)
  } finally { server.close() }
})

test("server: read-only handle cannot write", () => {
  const dir = process.env.DOBBY_DIR!
  open(`${dir}/ro.db`).close()
  const ro = S.openReadOnly(`${dir}/ro.db`)
  assert.throws(() => ro.prepare("INSERT INTO kv VALUES ('a','b')").run(), /readonly/i)
  assert.equal(D.snapshot(ro, NOW, 7).days, 7)
  ro.close()
})

test("server: /api/ticket/:id returns the ticket, 404 for unknown or malformed ids, GET only", async () => {
  const db = open(":memory:")
  const id = ticket(db, { title: "Fix import: csv", status: "failed", note: "merge conflict" })
  const server = S.createDashboard(db, { now: () => NOW, dist: `${process.env.DOBBY_DIR}/no-dist` })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const j = await (await fetch(`${base}/api/ticket/${id}`)).json() as any
    assert.equal(j.title, "Fix import"); assert.equal(j.note, "merge conflict"); assert.deepEqual(j.runs, [])
    for (const bad of ["999", "abc", "1/2", "-1", "99999999999"]) assert.equal((await fetch(`${base}/api/ticket/${bad}`)).status, 404, bad)
    assert.equal((await fetch(`${base}/api/ticket/${id}`, { method: "POST" })).status, 405)
  } finally { server.close() }
})

test("distFile: stays inside dist (traversal, encoded traversal, NUL, symlink out)", () => {
  const dir = mkdtempSync(`${tmpdir()}/foreman-dist-`)
  mkdirSync(`${dir}/dist/assets`, { recursive: true }); mkdirSync(`${dir}/secret`)
  writeFileSync(`${dir}/dist/index.html`, "<html></html>"); writeFileSync(`${dir}/dist/assets/a.js`, "1"); writeFileSync(`${dir}/secret/x.txt`, "no"); writeFileSync(`${dir}/dist-secret.txt`, "no")
  symlinkSync(`${dir}/secret`, `${dir}/dist/out`); symlinkSync(`${dir}/dist-secret.txt`, `${dir}/dist/link.txt`)
  const dist = `${dir}/dist`
  assert.ok(S.distFile(dist, "/index.html")?.endsWith("/dist/index.html")); assert.ok(S.distFile(dist, "/assets/a.js"))
  assert.equal(S.distFile(dist, "/"), null); assert.equal(S.distFile(dist, "/assets"), null) // directories are not files
  for (const bad of ["/../secret/x.txt", "/assets/../../secret/x.txt", "/%2e%2e/secret/x.txt", "/..%2fsecret/x.txt", "/assets/%2e%2e/%2e%2e/dist-secret.txt", "/index.html%00.js", "/out/x.txt", "/link.txt", "/%zz", "/missing.js", "/../dist-secret.txt"]) assert.equal(S.distFile(dist, bad), null, bad)
})

test("server: serves the built app (assets, SPA fallback, CSP by hash) and keeps every guard; falls back to the single page without dist", async () => {
  const dir = mkdtempSync(`${tmpdir()}/foreman-spa-`)
  mkdirSync(`${dir}/assets`)
  const inline = "document.title='x'"
  writeFileSync(`${dir}/index.html`, `<html><script>${inline}</script><script type="module" src="/assets/a.js"></script></html>`); writeFileSync(`${dir}/assets/a.js`, "console.log(1)"); writeFileSync(`${dir}/assets/b.css`, "a{}")
  const hash = createHash("sha256").update(inline).digest("base64")
  const { server, base } = await up({ dist: dir })
  try {
    const r = await fetch(`${base}/`)
    assert.match(r.headers.get("content-type")!, /text\/html/); assert.match(await r.text(), /assets\/a\.js/)
    const csp = r.headers.get("content-security-policy")!
    assert.ok(csp.includes(`'sha256-${hash}'`) && csp.includes("script-src 'self'") && !csp.includes("script-src 'unsafe-inline'"))
    const js = await fetch(`${base}/assets/a.js`); assert.match(js.headers.get("content-type")!, /javascript/); assert.equal(await js.text(), "console.log(1)")
    assert.match((await fetch(`${base}/assets/b.css`)).headers.get("content-type")!, /text\/css/)
    assert.match(await (await fetch(`${base}/some/route`)).text(), /assets\/a\.js/) // client-side route -> index.html
    assert.equal((await fetch(`${base}/assets/missing.js`)).status, 404)
    assert.equal((await fetch(`${base}/api/nope`)).status, 404)
    assert.equal((await fetch(`${base}/assets/a.js`, { method: "POST" })).status, 405)
    assert.doesNotMatch(await (await fetch(`${base}/assets/..%2f..%2f..%2f..%2f..%2fetc/passwd`)).text(), /root:/) // never the file; at most the app shell
    assert.equal((await fetch(`${base}/assets/..%2f..%2f..%2f..%2f..%2fetc/hosts.txt`)).status, 404)
    const h = await new Promise<number>((ok) => { import("node:http").then((m) => m.get(base + "/assets/a.js", { headers: { host: "evil.example" } }, (res) => { res.resume(); ok(res.statusCode!) })) })
    assert.equal(h, 403) // Host check covers assets too
  } finally { server.close() }
  const { server: s2, base: b2 } = await up({ dist: `${dir}/nothing` })
  try { assert.equal(await (await fetch(`${b2}/`)).text(), "<h1>ok</h1>") } finally { s2.close() }
})

test("server: off loopback, assets and the API need the token (cookie set by the first ?token= visit)", async () => {
  const dir = mkdtempSync(`${tmpdir()}/foreman-spa-`)
  writeFileSync(`${dir}/index.html`, "<html></html>"); writeFileSync(`${dir}/a.js`, "1")
  const { server, base } = await up({ host: "0.0.0.0", token: "s3cret", dist: dir })
  try {
    assert.equal((await fetch(`${base}/a.js`)).status, 401); assert.equal((await fetch(`${base}/api/ticket/1`)).status, 401)
    const first = await fetch(`${base}/?token=s3cret`, { redirect: "manual" }); assert.equal(first.status, 302); assert.equal(first.headers.get("location"), "/")
    const set = first.headers.get("set-cookie")!; assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/)
    const c = set.split(";")[0]
    assert.equal((await fetch(`${base}/a.js`, { headers: { cookie: c } })).status, 200)
    assert.equal((await fetch(`${base}/api/snapshot`, { headers: { cookie: c } })).status, 200)
    assert.equal((await fetch(`${base}/a.js`, { headers: { cookie: "foreman_dash=wrong" } })).status, 401)
  } finally { server.close() }
})

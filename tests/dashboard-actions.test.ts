// Owner actions: global pause, and POST /api/action with every guard. Offline; temp data dir, in-memory DBs, a stubbed `dobby do`.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { request } from "node:http"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-actions-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/secrets.env` // empty: nothing can reach Discord
const { open } = await import("../src/db.ts")
const { pausedState, setPaused } = await import("../src/pause.ts")
const S = await import("../src/dashboard-server.ts")
const { snapshot } = await import("../src/dashboard.ts")

const add = (db: any, status: string, title = "Add a thing") => Number(db.prepare("INSERT INTO tickets (project,title,status,created_at,updated_at) VALUES ('tally',?,?,datetime('now'),datetime('now'))").run(title, status).lastInsertRowid)

test("pause: records who and when, is idempotent, shows in the snapshot, resume clears it", () => {
  const db = open(":memory:")
  add(db, "running")
  assert.equal(pausedState(db), null); assert.equal(snapshot(db).paused, null)
  const p = setPaused(db, true, "the dashboard", 1000)
  assert.equal(p.changed, true); assert.match(p.line!, /paused by the dashboard.*1 running finish/)
  assert.deepEqual(pausedState(db), { at: 1000, by: "the dashboard" }); assert.deepEqual(snapshot(db).paused, { at: 1000, by: "the dashboard" })
  assert.equal(setPaused(db, true, "x").line, null) // second pause: no second post, original kept
  assert.equal(pausedState(db)!.by, "the dashboard")
  assert.equal((db.prepare("SELECT status FROM tickets").get() as any).status, "running") // nothing killed or changed
  assert.match(setPaused(db, false, "the owner").line!, /resumed/)
  assert.equal(pausedState(db), null); assert.equal(setPaused(db, false).line, null)
  db.prepare("INSERT INTO kv VALUES ('builders:paused','garbage')").run()
  assert.equal(pausedState(db), null) // a bad value never wedges the builders
})

test("pause/resume/queue through the real `dobby do` command (temp data dir, no Discord)", () => {
  const run = (...a: string[]) => spawnSync(new URL("../bin/dobby", import.meta.url).pathname, a, { encoding: "utf8", env: process.env })
  const db = open()
  const id = add(db, "backlog", "Add a copy button")
  const kv = () => pausedState(db)
  assert.match(run("do", "pause").stdout, /Paused/); assert.equal(kv()!.by, "the owner")
  assert.match(run("pause").stdout, /already paused/)
  assert.match(run("do", "resume").stdout, /Resumed/); assert.equal(kv(), null)
  assert.match(run("do", "queue", String(id)).stdout, /queued/)
  assert.equal((db.prepare("SELECT status FROM tickets WHERE id=?").get(id) as any).status, "ready")
  const t = db.prepare("SELECT kind, tag, ticket FROM touches").all()
  assert.ok(t.some((x: any) => x.ticket === id && x.tag === "decision"), "the queue tap is an owner touch")
  db.close()
})

// ---- server ----
const TOKEN = "tok-123"
type Reply = { status: number; body: string }
function post(base: string, o: { path?: string; headers?: Record<string, string>; body?: string; method?: string } = {}): Promise<Reply> {
  const u = new URL(base)
  return new Promise((ok, bad) => {
    const req = request({ host: u.hostname, port: u.port, path: o.path ?? "/api/action", method: o.method ?? "POST", headers: { "x-foreman-token": TOKEN, origin: base, "content-type": "application/json", ...o.headers } }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => ok({ status: res.statusCode!, body: b }))
    })
    req.on("error", bad); req.end(o.body ?? "{}")
  })
}
async function up(o: { token?: string | null; calls?: string[][] } = {}) {
  const db = open(":memory:")
  const calls = o.calls ?? []
  const server = S.createDashboard(db, { token: o.token === null ? undefined : (o.token ?? TOKEN), dist: `${dir}/no-dist`, exec: async (a) => { calls.push(a); return { ok: true, out: `ran ${a.join(" ")}\n` } } })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  return { db, server, calls, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}
const j = (o: object) => JSON.stringify(o)

test("action guards: no configured token = 403 with a plain message; wrong/missing token = 401", async () => {
  const off = await up({ token: null })
  try {
    const r = await post(off.base, { body: j({ action: "pause" }) })
    assert.equal(r.status, 403); assert.match(JSON.parse(r.body).message, /dobby dashboard open/)
    assert.equal(off.calls.length, 0)
  } finally { off.server.close() }
  const { server, base, calls } = await up()
  try {
    assert.equal((await post(base, { headers: { "x-foreman-token": "nope" }, body: j({ action: "pause" }) })).status, 401)
    assert.equal((await post(base, { headers: { "x-foreman-token": "" }, body: j({ action: "pause" }) })).status, 401)
    assert.equal((await post(base, { headers: { "x-foreman-token": TOKEN + "x" }, body: j({ action: "pause" }) })).status, 401)
    const noHeader = await new Promise<number>((ok) => { const q = request({ host: "127.0.0.1", port: new URL(base).port, path: "/api/action", method: "POST", headers: { origin: base, "content-type": "application/json" } }, (res) => { res.resume(); ok(res.statusCode!) }); q.end("{}") })
    assert.equal(noHeader, 401)
    assert.equal(calls.length, 0)
  } finally { server.close() }
})

test("action guards: Origin must be the server's own, content-type must be JSON, body at most 10 KB, Host must be local", async () => {
  const { server, base, calls } = await up()
  try {
    const ok = j({ action: "pause" })
    assert.equal((await post(base, { headers: { origin: "http://evil.example" }, body: ok })).status, 403)
    assert.equal((await post(base, { headers: { origin: "null" }, body: ok })).status, 403)
    assert.equal((await post(base, { headers: { origin: "" }, body: ok })).status, 403)
    assert.equal((await post(base, { headers: { "content-type": "text/plain" }, body: ok })).status, 415)
    assert.equal((await post(base, { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "action=pause" })).status, 415)
    assert.equal((await post(base, { body: j({ action: "pause", pad: "x".repeat(11 * 1024) }) })).status, 413)
    assert.equal((await post(base, { headers: { host: "evil.example", origin: "http://evil.example" }, body: ok })).status, 403) // DNS rebinding
    assert.equal((await post(base, { body: "{nope" })).status, 400)
    assert.equal((await post(base, { body: "[]" })).status, 400)
    assert.equal(calls.length, 0, "no guard failure ever ran a command")
    assert.equal((await post(base, { headers: { "content-type": "application/json; charset=utf-8" }, body: ok })).status, 200)
    assert.deepEqual(calls, [["pause"]])
  } finally { server.close() }
})

test("action allowlist: queue (backlog/failed only), reviewfix, reviewaccept, pause, resume; everything else is 400", async () => {
  const { db, server, base, calls } = await up()
  try {
    const bl = add(db, "backlog"), failed = add(db, "failed"), shipped = add(db, "shipped")
    const go = (o: object) => post(base, { body: j(o) })
    assert.equal((await go({ action: "queue", ticket: bl })).status, 200)
    assert.equal((await go({ action: "queue", ticket: failed })).status, 200)
    assert.equal((await go({ action: "queue", ticket: shipped })).status, 409)
    assert.equal((await go({ action: "queue", ticket: 9999 })).status, 404)
    for (const t of ["1", -1, 0, 1.5, null, "1; rm -rf /", [1]]) assert.equal((await go({ action: "queue", ticket: t })).status, 400, String(t))
    assert.equal((await go({ action: "reviewfix", repo: "o/r", pr: 12 })).status, 200)
    assert.equal((await go({ action: "reviewaccept", repo: "o/r.git-x", pr: 3 })).status, 200)
    for (const bad of [{ repo: "o/r;ls", pr: 1 }, { repo: "o r/x", pr: 1 }, { repo: "../x", pr: 1 }, { repo: "o/r", pr: "1 2" }, { repo: "o/r" }, { pr: 1 }, { repo: "o/r/s", pr: 1 }]) assert.equal((await go({ action: "reviewfix", ...bad })).status, 400, j(bad))
    assert.equal((await go({ action: "pause" })).status, 200)
    assert.equal((await go({ action: "resume" })).status, 200)
    for (const a of ["deploynow", "deploynow tally", "migrate", "approve", "decline", "send", "discard", "run", "buildidea", "keepgoing", "queue 1", "pause everything", "", null, 5, "PAUSE", "undo-scout", "ask", "__proto__"]) {
      const r = await go({ action: a, ticket: bl, project: "tally", repo: "o/r", pr: 1 })
      assert.equal(r.status, 400, String(a)); assert.match(JSON.parse(r.body).message, /not allowed/)
    }
    assert.equal((await go({})).status, 400)
    assert.deepEqual(calls, [["queue", String(bl)], ["queue", String(failed)], ["reviewfix", "o/r", "12"], ["reviewaccept", "o/r.git-x", "3"], ["pause"], ["resume"]])
  } finally { server.close() }
})

test("action result: one line from the command; a failing command is 500; other methods and paths stay refused", async () => {
  const db = open(":memory:")
  const server = S.createDashboard(db, { token: TOKEN, dist: `${dir}/no-dist`, exec: async () => ({ ok: false, out: "noise\nPR closed already.\n" }) })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const r = await post(base, { body: j({ action: "reviewfix", repo: "o/r", pr: 1 }) })
    assert.equal(r.status, 500); assert.deepEqual(JSON.parse(r.body), { ok: false, message: "PR closed already." })
    assert.equal((await post(base, { path: "/api/snapshot", body: "{}" })).status, 405)
    assert.equal((await post(base, { method: "PUT" })).status, 405)
    assert.equal((await post(base, { method: "DELETE" })).status, 405)
  } finally { server.close() }
})

test("action: off loopback the token gate still applies first", async () => {
  const db = open(":memory:")
  const server = S.createDashboard(db, { host: "0.0.0.0", token: TOKEN, dist: `${dir}/no-dist`, exec: async () => ({ ok: true, out: "ok" }) })
  await new Promise<void>((ok) => server.listen(0, "0.0.0.0", ok))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    assert.equal((await post(base, { headers: { "x-foreman-token": "" }, body: j({ action: "pause" }) })).status, 401) // no header, no cookie
    assert.equal((await post(base, { body: j({ action: "pause" }) })).status, 200) // the header is still accepted
  } finally { server.close() }
})

test("execForeman: argument array, no shell (a hostile argument stays one argument)", async () => {
  const mark = `${dir}/pwned`
  await S.execForeman([`x; touch ${mark}`]) // `dobby do` prints Unknown; a shell would have created the file
  assert.equal(existsSync(mark), false)
})

// ---- sign-in without pasting: ensureToken, /auth cookie, /api/session ----
test("ensureToken: creates a 600 file with a long token, is idempotent, never overwrites", async () => {
  const { ensureToken } = await import("../src/telegram.ts")
  const { statSync, readFileSync, writeFileSync } = await import("node:fs")
  const f = `${mkdtempSync(`${tmpdir()}/foreman-tok-`)}/sub/secrets.env`
  const t = ensureToken(f)
  assert.ok(t.length >= 43 && /^[\w-]+$/.test(t))
  assert.equal(statSync(f).mode & 0o777, 0o600); assert.equal(statSync(f.slice(0, f.lastIndexOf("/"))).mode & 0o777, 0o700)
  assert.equal(ensureToken(f), t); assert.equal(readFileSync(f, "utf8"), `DASHBOARD_TOKEN=${t}\n`)
  const g = `${dir}/other.env`
  writeFileSync(g, "DISCORD_BOT_TOKEN=abc"); const u = ensureToken(g) // no trailing newline: the existing key survives
  assert.equal(readFileSync(g, "utf8"), `DISCORD_BOT_TOKEN=abc\nDASHBOARD_TOKEN=${u}\n`)
  writeFileSync(g, "DASHBOARD_TOKEN=mine-keep-me\n"); assert.equal(ensureToken(g), "mine-keep-me")
})

test("openerFor: argument arrays per platform", () => {
  assert.deepEqual(S.openerFor("darwin", "u"), ["open", ["u"]])
  assert.deepEqual(S.openerFor("linux", "u"), ["xdg-open", ["u"]])
  assert.deepEqual(S.openerFor("win32", "u"), ["cmd", ["/c", "start", "", "u"]])
})

test("/auth sets the cookie and redirects; bad token 401; cookie + Origin runs actions; /api/session", async () => {
  const { server, base, calls } = await up()
  try {
    const bad = await fetch(`${base}/auth?token=nope`, { redirect: "manual" }); assert.equal(bad.status, 401); assert.equal(bad.headers.get("set-cookie"), null)
    assert.equal((await fetch(`${base}/auth`, { redirect: "manual" })).status, 401)
    const ok = await fetch(`${base}/auth?token=${TOKEN}`, { redirect: "manual" })
    assert.equal(ok.status, 302); assert.equal(ok.headers.get("location"), "/")
    const set = ok.headers.get("set-cookie")!
    assert.match(set, /^foreman_dash=tok-123; HttpOnly; SameSite=Strict; Path=\/$/) // no Secure over plain http
    const cookie = set.split(";")[0]
    assert.deepEqual(await (await fetch(`${base}/api/session`)).json(), { canAct: false })
    assert.deepEqual(await (await fetch(`${base}/api/session`, { headers: { cookie } })).json(), { canAct: true })
    assert.deepEqual(await (await fetch(`${base}/api/session`, { headers: { "x-foreman-token": TOKEN } })).json(), { canAct: true })
    assert.deepEqual(await (await fetch(`${base}/api/session`, { headers: { cookie: "foreman_dash=wrong" } })).json(), { canAct: false })
    const s = await fetch(`${base}/auth?token=${TOKEN}`, { redirect: "manual", headers: { "x-forwarded-proto": "https" } }); assert.match(s.headers.get("set-cookie")!, /; Secure$/)
    const go = (h: Record<string, string>) => post(base, { headers: { "x-foreman-token": "", ...h }, body: j({ action: "pause" }) })
    assert.equal((await go({ cookie })).status, 200); assert.deepEqual(calls, [["pause"]])
    assert.equal((await go({ cookie, origin: "http://evil.example" })).status, 403) // cookie without a matching Origin
    assert.equal((await go({ cookie: "foreman_dash=wrong" })).status, 401)
    assert.equal(calls.length, 1)
  } finally { server.close() }
})

test("/api/session without any configured token says canAct false", async () => {
  const { server, base } = await up({ token: null })
  try { assert.deepEqual(await (await fetch(`${base}/api/session`)).json(), { canAct: false }) } finally { server.close() }
})

// `dobby dashboard` serving /mcp: bearer token (never the cookie), origin check, caps, job_status. Offline: in-process app.request, in-memory DB, fake deps.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-mcp-http-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/secrets`
process.env.DOBBY_CONFIG = `${dir}/config.json`
process.env.JEV_API_KEY = ""

const { open } = await import("../src/db.ts")
const { app } = await import("../src/dashboard-server.ts")
const { real } = await import("../src/actions.ts")

const TOKEN = "tok-fixture-9f3a1c7e5b2d4a60"
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" }

function setup(o: { token?: string | null; host?: string } = {}) {
  const db = open(":memory:")
  const calls = { land: [] as unknown[], inbox: [] as string[] }
  const deps: typeof real = { ...real, land: async (...a) => (calls.land.push(a), "landed"), inbox: async (t) => void calls.inbox.push(t) }
  const token = o.token === null ? undefined : (o.token ?? TOKEN)
  const a = app(db, { host: o.host ?? "127.0.0.1", token, mcp: { db, deps }, dist: `${dir}/none` })
  const rpc = (method: string, params: unknown = {}, h: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, id = 1) =>
    a.request("/mcp", { method: "POST", headers: { ...HEADERS, host: "127.0.0.1:4710", ...h }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })
  const call = async (name: string, args: unknown) => {
    const r = await rpc("tools/call", { name, arguments: args })
    return { res: r, body: await r.text() }
  }
  const ticket = (title: string, status = "backlog", note: string | null = null) => Number(db.prepare("INSERT INTO tickets (project,title,status,note,created_at,updated_at) VALUES ('tally',?,?,?,datetime('now'),datetime('now'))").run(title, status, note).lastInsertRowid)
  return { db, calls, rpc, call, ticket, app: a }
}
const result = (body: string) => {
  const line = body.startsWith("{") ? body : (body.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5)
  return JSON.parse(line) as { result?: { tools?: { name: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> }; error?: unknown }
}
const INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }

test("initialize and tools/list with the bearer token: 200 and the five tools", async () => {
  const s = setup()
  const i = await s.rpc("initialize", INIT)
  assert.equal(i.status, 200)
  const l = await s.rpc("tools/list")
  assert.equal(l.status, 200)
  assert.deepEqual(result(await l.text()).result?.tools?.map((t) => t.name), ["dobby_read", "dobby_docs", "dobby_ticket", "dobby_pause", "dobby_decide"])
  const x = await s.rpc("tools/list", {}, { "x-foreman-token": TOKEN }) // the dashboard's own header works too
  assert.equal(x.status, 200)
})

for (const host of ["127.0.0.1", "100.64.0.1"]) {
  test(`auth and origin guards (host ${host}: loopback or not)`, async () => {
    const none = setup({ token: null, host: "127.0.0.1" })
    const r0 = await none.rpc("tools/list")
    assert.equal(r0.status, 403)
    assert.match(await r0.text(), /DASHBOARD_TOKEN/)
    const s = setup({ host })
    assert.equal((await s.rpc("tools/list", {}, {})).status, 401)
    assert.equal((await s.rpc("tools/list", {}, { authorization: "Bearer nope" })).status, 401)
    assert.equal((await s.rpc("tools/list", {}, { authorization: `Bearer ${TOKEN}x` })).status, 401)
    assert.equal((await s.rpc("tools/list", {}, { cookie: `foreman_dash=${TOKEN}` })).status, 401) // the cookie does not count
    assert.equal((await s.rpc("tools/list", {}, { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" })).status, 403)
    assert.equal((await s.rpc("tools/list", {}, { authorization: `Bearer ${TOKEN}`, origin: "http://127.0.0.1:4710" })).status, 200) // our own origin
    assert.equal((await s.rpc("tools/list", {}, { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" })).status, 415)
    const big = await s.app.request("/mcp", { method: "POST", headers: { ...HEADERS, host: "127.0.0.1:4710", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }) })
    assert.equal(big.status, 413)
  })
}

test("dobby_decide merge over HTTP: confirm is unsupported, merge never runs, the owner's inbox gets one card", async () => {
  const s = setup()
  const id = s.ticket("Fix footer", "approval", "PR https://github.com/acme/tally/pull/12")
  const { res, body } = await s.call("dobby_decide", { op: "merge", id })
  assert.equal(res.status, 200)
  assert.equal(s.calls.land.length, 0)
  assert.equal(s.calls.inbox.length, 1)
  assert.equal(result(body).result?.structuredContent?.outcome, "sent_to_inbox")
})

test("over-cap input is a tool error and the handler never runs", async () => {
  const s = setup()
  const { body } = await s.call("dobby_ticket", { op: "add", project: "tally", title: "x".repeat(10_001) })
  const r = result(body)
  assert.ok(r.error || r.result?.isError, body.slice(0, 200))
  assert.equal((s.db.prepare("SELECT COUNT(*) n FROM tickets").get() as { n: number }).n, 0)
})

test("dobby_read job: a running ticket, a non-running one, an unknown id", async () => {
  const s = setup()
  const run = s.ticket("Add export", "running")
  s.db.prepare("INSERT INTO runs (at,project,kind,ticket,ok) VALUES (datetime('now'),'tally','build',?,1)").run(run)
  const text = async (id: number) => String(result((await s.call("dobby_read", { view: "job", id })).body).result?.structuredContent?.text)
  assert.match(await text(run), new RegExp(`#${run} running\\. Stage: .+Last update: .+Last step: .+Builds used: 25% of 4`))
  assert.match(await text(s.ticket("Waiting")), /is not running \(it is backlog\)/)
  assert.match(await text(999), /no ticket #999/)
})

test("the token is never in a response body, nor in `dobby add mcp --http` output", async () => {
  const s = setup()
  for (const [m, p] of [["initialize", INIT], ["tools/list", {}]] as const) assert.ok(!(await (await s.rpc(m, p)).text()).includes(TOKEN))
  assert.ok(!(await (await s.rpc("tools/list", {}, { authorization: "Bearer wrong" })).text()).includes(TOKEN))
  const r = spawnSync(new URL("../bin/dobby", import.meta.url).pathname, ["add", "mcp", "--http", "--url", "https://m.example.ts.net"], { encoding: "utf8", env: { ...process.env, DASHBOARD_TOKEN: TOKEN }, input: "" })
  assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN))
  assert.match(r.stdout, /claude mcp add --scope user --transport http dobby https:\/\/m\.example\.ts\.net\/mcp --header "Authorization: Bearer \$DASHBOARD_TOKEN"/)
})

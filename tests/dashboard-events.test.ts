// /api/events (SSE) and the shared API schemas. Offline, in-memory DB.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

process.env.DOBBY_DIR = mkdtempSync(`${tmpdir()}/foreman-events-`)
const { open } = await import("../src/db.ts")
const S = await import("../src/dashboard-server.ts")
const { snapshot } = await import("../src/dashboard.ts")
const { Snapshot, EVENT_SCHEMAS } = await import("../src/api-schema.ts")

const NOW = Date.parse("2026-10-20T12:00:00Z")
const stamp = new Date(NOW - 3_600_000).toISOString()
const add = (db: any, status: string, title: string) => db.prepare("INSERT INTO tickets (project,title,status,created_at,updated_at) VALUES ('tally',?,?,?,?)").run(title, status, stamp, stamp)

async function up(opts: Parameters<typeof S.createDashboard>[1] = {}) {
  const db = open(":memory:")
  const server = S.createDashboard(db, { now: () => NOW, pollMs: 30, heartbeatMs: 80, dist: `${process.env.DOBBY_DIR}/no-dist`, ...opts })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  return { db, server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}

type Frame = { event: string; data: string }
/** A test client: reads the stream and hands out frames one at a time. */
async function connect(url: string, init: RequestInit = {}) {
  const ac = new AbortController()
  const res = await fetch(url, { ...init, signal: ac.signal })
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ""
  const next = async (ms = 3000): Promise<Frame> => {
    const stop = setTimeout(() => ac.abort(), ms)
    try {
      for (;;) {
        const i = buf.indexOf("\n\n")
        if (i >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2)
          const f = { event: "", data: "" }
          for (const line of block.split("\n")) { if (line.startsWith("event:")) f.event = line.slice(6).trim(); else if (line.startsWith("data:")) f.data += line.slice(5).trim() }
          return f
        }
        const { done, value } = await reader.read()
        if (done) throw new Error("stream ended")
        buf += dec.decode(value, { stream: true })
      }
    } finally { clearTimeout(stop) }
  }
  return { res, next, close: () => ac.abort() }
}

test("events: a snapshot on connect, another after a DB change, both valid against the schema", async () => {
  const { db, server, base } = await up()
  const c = await connect(`${base}/api/events`)
  try {
    assert.match(c.res.headers.get("content-type")!, /text\/event-stream/)
    const first = await c.next()
    assert.equal(first.event, "snapshot")
    assert.equal(Snapshot.parse(JSON.parse(first.data)).now.ready.length, 0)
    add(db, "ready", "Add dark mode: toggle")
    let f = await c.next()
    while (f.event === "heartbeat") f = await c.next() // a heartbeat may land first
    assert.equal(f.event, "snapshot")
    assert.equal(EVENT_SCHEMAS.snapshot.parse(JSON.parse(f.data)).now.ready.length, 1)
  } finally { c.close(); server.closeAllConnections(); server.close() }
})

test("events: no change, no snapshot; a heartbeat keeps the line alive", async () => {
  const { server, base } = await up()
  const c = await connect(`${base}/api/events`)
  try {
    assert.equal((await c.next()).event, "snapshot")
    for (let i = 0; i < 2; i++) { const f = await c.next(); assert.equal(f.event, "heartbeat"); EVENT_SCHEMAS.heartbeat.parse(JSON.parse(f.data)) }
  } finally { c.close(); server.closeAllConnections(); server.close() }
})

test("events: the token is required like any other /api path", async () => {
  const { server, base } = await up({ token: "s3cret" })
  try {
    assert.equal((await fetch(`${base}/api/events`)).status, 401)
    assert.equal((await fetch(`${base}/api/events`, { headers: { host: "127.0.0.1" }, method: "POST" })).status, 405)
    const c = await connect(`${base}/api/events`, { headers: { "x-foreman-token": "s3cret" } })
    assert.equal(c.res.status, 200); assert.equal((await c.next()).event, "snapshot")
    c.close()
  } finally { server.closeAllConnections(); server.close() }
})

test("schemas: a seeded snapshot validates; a wrong shape does not", () => {
  const db = open(":memory:")
  add(db, "running", "Build the thing: x"); add(db, "ready", "Next one"); add(db, "failed", "Broken: y")
  const limits = { five: { used: 31, resetsAt: NOW + 3_600_000 }, week: { used: 58, cap: 95, resetsAt: NOW + 86_400_000 }, ratio: 0.1, state: "running", resumesAt: null, line: "Running" }
  for (const l of [limits, { state: "unknown", line: "Plan usage unknown" }, null]) {
    const s = JSON.parse(JSON.stringify(snapshot(db, NOW, 7, l)))
    const p = Snapshot.parse(s)
    assert.equal(p.now.building.length, 1); assert.equal(p.now.stuck.length, 1)
  }
  assert.throws(() => Snapshot.parse({ at: 1 }))
})

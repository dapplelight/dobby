// Owner-phone UX: brief content, outbox read-back, silent-death watch. Temp data dir, in-memory DB, fake senders: nothing is posted.
import assert from "node:assert/strict"
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-ux-`)
process.env.DOBBY_DIR = dir
const { open, logRun } = await import("../src/db.ts")
const { addTicket, setTicket } = await import("../src/lib.ts")
const { buildBrief, briefMarkdown } = await import("../src/brief.ts")
const { gather, sendBrief, istDay } = await import("../src/graphs/cos.ts")
const { briefWatch } = await import("../src/health.ts")
const { digest, takeOutbox } = await import("../src/notify.ts")

const projects = { tally: { name: "tally", paused: false } } as any
const usage = { fiveUsed: 12, weekUsed: 40, weekMsToReset: 1 }

test("brief: newest report per project, settled tickets dropped from needs owner", () => {
  const db = open(":memory:")
  const shipped = addTicket(db, { project: "tally", title: "Old thing" }).id
  setTicket(db, shipped, { status: "shipped" })
  const live = addTicket(db, { project: "tally", title: "Live thing" }).id
  const day = new Date().toLocaleDateString("sv")
  const rep = (note: string, owner: string) => `Engineering Manager · tally · 08:00\nnote: ${note}\nneeds owner: ${owner}`
  db.prepare("INSERT INTO kv VALUES (?, ?)").run(`lead:tally:${day}`, `${rep("first", `#${shipped} Old thing`)}\n\n${rep("second", `#${shipped} Old thing; #${live} Live thing`)}`)
  const f = gather(db, projects, usage)
  assert.equal(f.leads.length, 1)
  assert.ok(f.leads[0].text.includes("second") && !f.leads[0].text.includes("first"))
  assert.ok(f.leads[0].text.includes("Live thing") && !f.leads[0].text.includes("Old thing"))
})

test("brief: first line is the one action, or says nothing is needed", () => {
  const db = open(":memory:")
  const none = briefMarkdown(buildBrief(db, gather(db, projects, usage)))
  assert.equal(none.split("\n")[1], "Nothing needs you today.")
  const id = addTicket(db, { project: "tally", title: "Add dark mode: toggle" }).id
  setTicket(db, id, { status: "approval" })
  const b = briefMarkdown(buildBrief(db, gather(db, projects, usage)))
  assert.match(b.split("\n")[1], /^\*\*Do first:\*\* tally · Add dark mode, waiting for your merge$/)
  assert.ok(!/#\d/.test(b) && !/buttons below/.test(b), b)
})

test("send: one budget line, usage detail to #system-status once a day, outbox read back", async () => {
  const db = open(":memory:")
  const sent: { text: string; kind: string }[] = []
  const fake = (async (text: string, _f: unknown, _b: unknown, e: { kind: string }) => (sent.push({ text, kind: e.kind }), true)) as any
  appendFileSync(`${dir}/outbox.log`, `2026-10-18T10:00:00.000Z [fetch failed] Build paused\nsecond line\n2026-10-18T11:00:00.000Z [discord not set up] Review needs you\n`)
  const s = { facts: gather(db, projects, usage), dir }
  await sendBrief(db, s, fake)
  const brief = sent.find((m) => m.text.includes("Nothing needs you today."))!
  assert.match(brief.text, /### Not posted\n- Build paused\n- Review needs you\n/)
  assert.match(brief.text, /### Budget\nWeek 40%.* · 5-hour 12%/)
  assert.ok(!brief.text.includes("$") && !/cache/i.test(brief.text))
  assert.equal(sent.filter((m) => m.kind === "health").length, 1)
  assert.equal(readFileSync(`${dir}/outbox.log`, "utf8"), "") // cleared
  assert.ok(db.prepare("SELECT 1 FROM kv WHERE k=?").get(`brief:sent:${istDay()}`))
  sent.length = 0
  await sendBrief(db, s, fake)
  assert.equal(sent.filter((m) => m.kind === "health").length, 0) // already posted today
})

test("outbox: missing file is empty", () => assert.deepEqual(takeOutbox(`${dir}/none.log`), []))

test("outbox: discord test hellos are not replayed; other posts are, multi-line kept", () => {
  writeFileSync(`${dir}/o.log`, "2026-10-24T01:00:00.000Z [discord 500] Test: the morning brief lands here.\n2026-10-24T01:00:01.000Z [discord 500] 🔴 Deploy failed · tally\nline 2\n")
  assert.deepEqual(takeOutbox(`${dir}/o.log`).map((m) => m.text), ["🔴 Deploy failed · tally\nline 2"])
})

test("digest: one short message, counts per app and the 3 biggest of each", () => {
  const rows = Array.from({ length: 56 }, (_, i) => ({ id: i, project: i % 4 ? "tally" : "foreman", title: `Change number ${i}: long detail`, note: "https://github.com/x/pull/1" }))
  const d = digest(rows, (id) => "• ".padEnd(id + 3, "x"))
  assert.ok(d.length < 500, String(d.length))
  assert.ok(d.includes("foreman 14, tally 42"))
  assert.equal(d.split("\n").filter((l) => l.startsWith("•")).length, 6)
  assert.match(d, /\ntally\n• Change number 55\n/)
})

test("health: silent-death alert after 09:00 IST, once a day; last tick for the board", async () => {
  const db = open(":memory:")
  const posts: string[] = []
  const send = async (t: string) => void posts.push(t)
  const at = (h: number) => Date.parse(`2026-10-20T${String(h).padStart(2, "0")}:00:00+05:30`)
  assert.equal(await briefWatch(db, send, at(8)), false) // too early
  assert.equal(await briefWatch(db, send, at(9)), true)
  assert.match(posts[0], /did not run today/)
  assert.equal(await briefWatch(db, send, at(10)), false) // once
  const db2 = open(":memory:")
  db2.prepare("INSERT INTO kv VALUES (?, '1')").run("brief:sent:2026-10-20")
  assert.equal(await briefWatch(db2, send, at(11)), false) // brief went out
})

// #369: the first backlog of a newly onboarded project is not queued behind the owner's back. Offline: :memory: db, injected chooser.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-onbpromote-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/s.txt`
writeFileSync(process.env.DOBBY_SECRETS, "")
process.env.JEV_API_KEY = ""
const { open } = await import("../src/db.ts")
const L = await import("../src/lib.ts")
const lead = await import("../src/graphs/lead.ts")

const fresh = () => {
  const db = open(":memory:")
  for (let i = 1; i <= 5; i++) L.addTicket(db, { project: "tally", title: `Tidy part ${i}`, size: "S" })
  db.prepare("UPDATE tickets SET status='backlog'").run()
  return db
}
const ready = (db: ReturnType<typeof open>) => (db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status='ready'").get() as { n: number }).n
const proj = { tally: { name: "tally", paused: false, autoPromote: true } } as unknown as Parameters<typeof lead.leadDue>[1]
const later = Date.now() + 1e9

test("ask, no terminal: nothing is queued, the Lead stays away, the output says how to queue", async () => {
  const db = fresh()
  const line = await lead.onboardPromote(db, "tally", "ask")
  assert.match(line, /dobby queue \d+/)
  assert.deepEqual(lead.fallbackPromote(db, "tally").promoted, [])
  assert.deepEqual(lead.leadDue(db, proj, later), [])
  assert.equal(ready(db), 0)
})

test("auto: no hold, the Lead promotes as before", async () => {
  const db = fresh()
  await lead.onboardPromote(db, "tally", "auto")
  assert.equal(lead.leadDue(db, proj, later).length, 1)
  assert.ok(lead.fallbackPromote(db, "tally").promoted.length >= 3)
})

test("none: never promoted at onboarding, even with a chooser", async () => {
  const db = fresh()
  await lead.onboardPromote(db, "tally", "none", async () => [0, 1, 2])
  assert.equal(ready(db), 0)
  assert.equal(lead.fallbackPromote(db, "tally").promoted.length, 0)
})

test("ask in a terminal: yes queues the top 3, pick queues the chosen, no holds", async () => {
  let shown: string[] = []
  let db = fresh()
  await lead.onboardPromote(db, "tally", "ask", async (t) => { shown = t; return t.map((_, i) => i) })
  assert.equal(shown.length, 3); assert.equal(ready(db), 3)
  db = fresh()
  await lead.onboardPromote(db, "tally", "ask", async () => [1])
  assert.equal(ready(db), 1)
  db = fresh()
  await lead.onboardPromote(db, "tally", "ask", async () => [])
  assert.equal(ready(db), 0); assert.equal(lead.leadDue(db, proj, later).length, 0)
})

test("queueing a ticket by hand lifts the hold", async () => {
  const db = fresh()
  await lead.onboardPromote(db, "tally", "ask")
  L.queueTicket(db, 1)
  assert.equal(lead.promoteHeld(db, "tally"), false)
})

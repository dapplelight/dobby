// The tick lock (kv `lock`, "<ms>:<pid>"): a dead holder or a heartbeat older than the longest tick is stale and gets cleared. Offline, injected pid check.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-lock-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/s.txt`
process.env.DOBBY_CONFIG = `${dir}/config.json`
process.env.JEV_API_KEY = ""
mkdirSync(`${dir}/projects`, { recursive: true })
const { open } = await import("../src/db.ts")
const { LOCK_MS, lockHeld, reapDead, addTicket, getTicket, setTicket } = await import("../src/lib.ts")
const { retryText } = await import("../src/actions.ts")

const db = open()
const setLock = (v: string) => db.prepare("INSERT OR REPLACE INTO kv VALUES ('lock', ?)").run(v)
const has = () => !!db.prepare("SELECT 1 FROM kv WHERE k='lock'").get()
const now = Date.now()

test("a lock held by a live pid with a fresh heartbeat is not stale", () => {
  setLock(`${now - 60_000}:4242`)
  const l = lockHeld(db, now, () => true)
  assert.equal(l?.stale, null)
  assert.equal(l?.pid, 4242)
  assert.equal(reapDead(db, now, () => true), null)
  assert.ok(has())
})

test("a lock whose pid is dead is stale and cleared, however fresh", () => {
  setLock(`${now - 1000}:4242`)
  assert.match(lockHeld(db, now, () => false)?.stale ?? "", /process 4242 is gone/)
  assert.match(reapDead(db, now, () => false) ?? "", /gone/)
  assert.ok(!has())
})

test("an old timestamp is stale even if the pid looks alive (reused pid); an old pid-less lock too", () => {
  setLock(`${now - LOCK_MS - 1}:4242`)
  assert.match(lockHeld(db, now, () => true)?.stale ?? "", /no heartbeat/)
  setLock(String(now - LOCK_MS - 1))
  assert.match(lockHeld(db, now, () => true)?.stale ?? "", /no heartbeat/)
  setLock(String(now - 1000)) // old format, fresh: still held
  assert.equal(lockHeld(db, now, () => true)?.stale, null)
  db.prepare("DELETE FROM kv WHERE k='lock'").run()
  assert.equal(lockHeld(db, now), null)
})

test("retry after a hard crash: the ticket left running with no builder goes back in the queue", () => {
  const { id } = addTicket(db, { project: "tally", title: "Cut off" })
  setTicket(db, id, { status: "running" })
  setLock(`${now}:999999999`) // a pid that cannot exist
  assert.match(retryText(db, id), /back in the queue/)
  assert.equal(getTicket(db, id)?.status, "ready")
  assert.ok(!has())
})

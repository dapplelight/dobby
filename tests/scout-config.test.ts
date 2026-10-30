// Scout's window from config: scout.hour 2 in UTC opens 02:00-09:00 (own file: config is read once per process).
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-scout-config-`)
writeFileSync(`${dir}/c.json`, JSON.stringify({ timezone: "UTC", scout: { hour: 2 } }))
process.env.DOBBY_CONFIG = `${dir}/c.json`
process.env.DOBBY_DIR = dir
const { open } = await import("../src/db.ts")
const { scoutDue } = await import("../src/scout.ts")

test("scout.hour 2: not due at 01:30, due 02:30, same night at 08:30, closed at 09:30", () => {
  const db = open(":memory:")
  assert.equal(scoutDue(db, undefined, Date.parse("2026-10-25T01:30:00Z")), false)
  assert.equal(scoutDue(db, undefined, Date.parse("2026-10-25T02:30:00Z")), true)
  db.prepare("INSERT INTO kv VALUES ('scout:last', '2026-10-25')").run()
  assert.equal(scoutDue(db, undefined, Date.parse("2026-10-25T08:30:00Z")), false)
  db.prepare("DELETE FROM kv WHERE k='scout:last'").run()
  assert.equal(scoutDue(db, undefined, Date.parse("2026-10-25T09:30:00Z")), false)
})

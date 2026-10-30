// Scout's night in a UTC configuration (own file: the time zone is config, read once per process).
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-scout-utc-`)
writeFileSync(`${dir}/c.json`, JSON.stringify({ timezone: "UTC" }))
process.env.DOBBY_CONFIG = `${dir}/c.json`
process.env.DOBBY_DIR = dir
const { open } = await import("../src/db.ts")
const { scoutDue } = await import("../src/scout.ts")

test("scout in UTC: due at 23:30, not again at 05:45 the next morning, due the next night", () => {
  const db = open(":memory:")
  assert.equal(scoutDue(db, undefined, Date.parse("2026-10-24T23:30:00Z")), true)
  db.prepare("INSERT INTO kv VALUES ('scout:last', '2026-10-24')").run()
  assert.equal(scoutDue(db, undefined, Date.parse("2026-10-25T05:45:00Z")), false)
  assert.equal(scoutDue(db, undefined, Date.parse("2026-10-25T23:30:00Z")), true)
})

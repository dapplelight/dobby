// Without Discord the tick job starts the PR review scan on the listener's 15-minute cadence. Offline: the starter is a stub.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

process.env.DOBBY_DIR = mkdtempSync(`${tmpdir()}/dobby-scandue-`)
const { open } = await import("../src/db.ts")
const { scanIfDue } = await import("../src/scan-due.ts")

const M = 60_000, STALE = 90 * M

test("review scan without Discord: starts when none ran for 15 minutes, not twice, not with the listener", () => {
  const db = open(":memory:")
  let n = 0
  const go = (now: number, discord = false) => scanIfDue(db, { discord, now, staleMs: STALE, start: () => void n++ })
  assert.equal(go(1_000_000, true), false, "Discord on: the listener owns the scan")
  assert.equal(n, 0)
  assert.equal(go(1_000_000), true, "never scanned: starts")
  assert.equal(go(1_000_000 + M), false, "the claimed scan is still running")
  db.prepare("INSERT OR REPLACE INTO kv VALUES ('review:scan:last', ?)").run(JSON.stringify({ at: 1_000_000 + 5 * M }))
  assert.equal(go(1_000_000 + 10 * M), false, "scanned 5 minutes ago")
  assert.equal(go(1_000_000 + 21 * M), true, "15 minutes since the last scan")
  assert.equal(go(1_000_000 + 22 * M + STALE), true, "a claim past its timeout (killed scan) is retaken")
  assert.equal(n, 3)
})

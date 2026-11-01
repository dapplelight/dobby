// #910: builder caps from config, and no new builder while free memory is low.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-builder-cap-`)
process.env.DOBBY_DIR = `${dir}/data`
process.env.DOBBY_SECRETS = `${dir}/none`
const { open } = await import("../src/db.ts")
const { builderCap, memHoldLine, memoryHold, parseFreePct } = await import("../src/builders.ts")

test("caps: read from config, 4, and 6 in quiet hours, by default", () => {
  assert.equal(builderCap(undefined, 12), 4)
  assert.equal(builderCap(undefined, 2), 6)
  assert.equal(builderCap({ max: 2, maxQuietHours: 3 }, 12), 2)
  assert.equal(builderCap({ max: 2, maxQuietHours: 3 }, 23), 3, "23:00 is in quiet hours")
  assert.equal(builderCap({ max: 2 }, 7), 6, "a missing quiet-hours cap keeps its default")
})

test("free memory: macOS memory_pressure and Linux /proc/meminfo", () => {
  assert.equal(parseFreePct("The system has 17179869184 ...\nSystem-wide memory free percentage: 73%\n"), 73)
  assert.equal(parseFreePct("MemTotal:       16000000 kB\nMemFree: 100 kB\nMemAvailable:    4000000 kB\n"), 25)
  assert.equal(parseFreePct("nothing useful"), null)
})

test("low free memory holds the next builder and says why in status; enough memory clears it", () => {
  const db = open(":memory:")
  assert.equal(memoryHold(db, 25, 40, 1000), "")
  assert.deepEqual(memHoldLine(db, 1000), [])
  const why = memoryHold(db, 25, 12, 1000)
  assert.match(why, /free memory 12% is under 25%/)
  assert.deepEqual(memHoldLine(db, 2000), [`🧠 Held: ${why}`])
  assert.deepEqual(memHoldLine(db, 1000 + 16 * 60_000), [], "an old hold is not shown")
  assert.equal(memoryHold(db, 25, 30, 3000), "")
  assert.deepEqual(memHoldLine(db, 3000), [], "cleared once memory is back")
})

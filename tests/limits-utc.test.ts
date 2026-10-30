// The plan limits line in a UTC configuration (own file: the zone is read once per process). limits.test.ts is the Asia/Kolkata one.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-limits-utc-`)
writeFileSync(`${dir}/c.json`, JSON.stringify({ timezone: "UTC", timezoneLabel: "UTC" }))
process.env.DOBBY_CONFIG = `${dir}/c.json`
process.env.DOBBY_DIR = dir
const { limits } = await import("../src/view.ts")

const H = 3600_000, D = 24 * H
const now = Date.parse("2026-10-25T08:00:00Z") // a Sunday


test("limits in UTC: resume times carry the UTC label and no offset", () => {
  const five = limits({ fiveUsed: 95, weekUsed: 40, weekMsToReset: 4 * D, fiveMsToReset: 2 * H }, { weekCap: 95, capOverride: 60 }, now)
  assert.equal(five.line, "Paused: 5-hour window at 95% (pace cap), resumes 10:00 UTC")
  const week = limits({ fiveUsed: 5, weekUsed: 71, weekMsToReset: 3 * D + 4 * H, fiveMsToReset: 2 * H }, { weekCap: 70 }, now)
  assert.equal(week.line, "Paused at 71% of your week (your cap), resumes Wed 12:00 UTC")
})

// The plan limits line and the weekly cap (offline: fixed readings and times). Asia/Kolkata config; limits-utc.test.ts is the UTC one (the zone is read once per process).
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-limits-`)
writeFileSync(`${dir}/c.json`, JSON.stringify({ timezone: "Asia/Kolkata", timezoneLabel: "IST" }))
process.env.DOBBY_CONFIG = `${dir}/c.json`
process.env.DOBBY_DIR = dir
const { open } = await import("../src/db.ts")
const { budgetAllows, paceCap } = await import("../src/lib.ts")
const { liftHint, limits, limitsNow, limitsText, statusText } = await import("../src/view.ts")
const { setPause } = await import("../src/pause.ts")

const H = 3600_000, D = 24 * H
const now = Date.parse("2026-10-25T08:00:00Z") // 13:30 IST, a Sunday

// Expected values come from the pre-weekCap paceCap (git show 45bc9cb:src/lib.ts), run on these same readings.
test("weekCap 100 gives exactly today's pace caps", () => {
  const fixtures: [Parameters<typeof paceCap>[0], boolean, number, number][] = [
    [{ fiveUsed: 10, weekUsed: 30, weekMsToReset: 3 * D, fiveMsToReset: 4 * H }, false, 0.1, 68],
    [{ fiveUsed: 50, weekUsed: 80, weekMsToReset: 1 * D, fiveMsToReset: 1 * H }, true, 0.1, 98],
    [{ fiveUsed: 20, weekUsed: 20, weekMsToReset: 5 * D, fiveMsToReset: 2 * H }, false, 0.15, 34],
    [{ fiveUsed: 50, weekUsed: 60, weekMsToReset: 5 * D, fiveMsToReset: 4 * H }, false, 0.1, 20],
    [{ fiveUsed: 50, weekUsed: 60, weekMsToReset: 5 * D, fiveMsToReset: 4 * H }, true, 0.1, 30],
    [{ fiveUsed: 50, weekUsed: 30, weekMsToReset: 2 * D, fiveMsToReset: 4 * H }, false, 0.1, 68],
    [{ fiveUsed: 20, weekUsed: 50, weekMsToReset: 3 * D, fiveMsToReset: 4 * H }, true, 0.1, 92],
    [{ fiveUsed: 20, weekUsed: 50, weekMsToReset: 3 * D, fiveMsToReset: 4 * H }, false, 0.1, 68],
  ]
  for (const [u, night, ratio, want] of fixtures) {
    assert.equal(paceCap(u, night, ratio, 100), want)
    assert.equal(paceCap(u, night, ratio), want) // the default is 100
  }
})

test("a lower weekCap lowers the pace cap, and the week stops at it", () => {
  const u = { fiveUsed: 20, weekUsed: 50, weekMsToReset: 3 * D, fiveMsToReset: 4 * H }
  assert.equal(paceCap(u, false, 0.1, 70), 20) // 68 at 100
  assert.equal(paceCap(u, true, 0.1, 70), 30) // 92 at 100
  const at70 = { fiveUsed: 10, weekUsed: 70, weekMsToReset: 3 * D, fiveMsToReset: 4 * H }
  assert.equal(budgetAllows(at70, 12, undefined, 0.1, 70).ok, false)
  assert.equal(budgetAllows(at70, 12, undefined, 0.1, 70).why, "weekly at 70% (your cap is 70%)")
  assert.equal(budgetAllows({ ...at70, weekUsed: 69 }, 12, undefined, 0.1, 70).why.startsWith("weekly"), false)
  assert.equal(budgetAllows({ ...at70, weekUsed: 71 }, 12, undefined, 0.1, 100).why.startsWith("weekly"), false)
})

test("limits: running", () => {
  const l = limits({ fiveUsed: 34, weekUsed: 30, weekMsToReset: 3 * D, fiveMsToReset: 2 * H }, { weekCap: 70 }, now)
  assert.equal(l.state, "running")
  assert.equal(l.line, "Running · 5-hour 34% (cap 84%) · week 30% of 70%")
})

test("limits: paused by the 5-hour pace cap resumes at the window reset, in IST", () => {
  const l = limits({ fiveUsed: 95, weekUsed: 40, weekMsToReset: 4 * D, fiveMsToReset: 2 * H }, { weekCap: 95, capOverride: 60 }, now)
  assert.equal(l.state, "paused-5h")
  assert.equal(l.line, "Paused: 5-hour window at 95% (pace cap), resumes 15:30 IST")
  assert.equal("resumesAt" in l && l.resumesAt, now + 2 * H)
})

test("limits: paused by the week cap resumes at the weekly reset, in IST", () => {
  const l = limits({ fiveUsed: 5, weekUsed: 71, weekMsToReset: 3 * D + 4 * H, fiveMsToReset: 2 * H }, { weekCap: 70 }, now)
  assert.equal(l.state, "paused-week")
  assert.equal(l.line, "Paused at 71% of your week (your cap), resumes Wed 17:30 IST")
  assert.equal("resumesAt" in l && l.resumesAt, now + 3 * D + 4 * H)
})

test("limits: no reading, or a stale one, says unknown", () => {
  assert.equal(limits(null, { weekCap: 95 }, now).line, "Plan usage unknown (no reading; sign in to Claude, then wait 10 minutes)")
  const stale = limits({ fiveUsed: 1, weekUsed: 1, weekMsToReset: D, ageMs: 45 * 60_000 }, { weekCap: 95 }, now)
  assert.equal(stale.state, "unknown")
  assert.equal(stale.line, "Plan usage unknown (no reading for 45 min; sign in to Claude, then wait 10 minutes)")
})

test("dobby limits prints the line and both bars; status starts with the line", () => {
  const l = limits({ fiveUsed: 34, weekUsed: 49, weekMsToReset: 4 * D, fiveMsToReset: 2 * H }, { weekCap: 95 }, now)
  const out = limitsText(l).split("\n")
  assert.equal(out[0], l.line)
  assert.equal(out[1], "5-hour ▕███░░░░░░░▏ 34%")
  assert.equal(out[2], "week   ▕█████░░░░░▏ 49% (cap 95%)")
  assert.equal(statusText(open(":memory:"), now, l).split("\n")[0], l.line)
})

test("an owner pause replaces Running; usage numbers stay", () => {
  const db = open(":memory:")
  const u = { fiveUsed: 15, weekUsed: 77, weekMsToReset: 2 * D, fiveMsToReset: 2 * H }
  assert.match(limitsNow(db, u, now).line, /^Running · /)
  setPause(db, { all: true }, true, "owner", { now })
  const line = limitsNow(db, u, now).line
  assert.match(line, /^Everything paused by owner since .+ · 5-hour 15%/)
  assert.doesNotMatch(line, /Running/)
})

test("a held plan names the command that lifts it, in limits and status; nothing when it runs (#406)", () => {
  const five = limits({ fiveUsed: 67, weekUsed: 40, weekMsToReset: 4 * D, fiveMsToReset: 2 * H }, { weekCap: 95, capOverride: 44 }, now)
  assert.equal(liftHint(five), "Lift it for this window: dobby do keepgoing 90")
  assert.equal(limitsText(five).split("\n").at(-1), "Lift it for this window: dobby do keepgoing 90")
  assert.equal(statusText(open(":memory:"), now, five).split("\n")[1], "Lift it for this window: dobby do keepgoing 90")
  assert.equal(liftHint(limits({ fiveUsed: 95, weekUsed: 40, weekMsToReset: 4 * D, fiveMsToReset: 2 * H }, { weekCap: 95, capOverride: 60 }, now)), "Lift it for this window: dobby do keepgoing 100")
  assert.equal(liftHint(limits({ fiveUsed: 10, weekUsed: 96, weekMsToReset: 4 * D, fiveMsToReset: 2 * H }, { weekCap: 95 }, now)), "Raise your weekly cap: dobby config set pacing.weekCap <percent, up to 100>")
  const run = limits({ fiveUsed: 34, weekUsed: 30, weekMsToReset: 3 * D, fiveMsToReset: 2 * H }, { weekCap: 70 }, now)
  assert.equal(liftHint(run), "")
  assert.equal(limitsText(run).split("\n").length, 3)
})

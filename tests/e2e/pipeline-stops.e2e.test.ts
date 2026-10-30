// When the pipeline must stop: Claude signed out, the weekly cap reached, merges paused (a fresh install). Scenarios 5, 6 and the
// fresh-install pause. Fake Claude and fake GitHub, temp dirs only (tests/e2e/harness.ts).
import assert from "node:assert/strict"
import { test } from "node:test"
import { world } from "./harness.ts"

const TICKET = ["Add a farewell helper", "src/farewell.js exports farewell(name) and a test covers it"] as const

test("5. Claude is signed out: work stops, the owner hears once, the ticket waits untouched, nothing merges", () => {
  const w = world({ scenario: "signed-out" })
  try {
    const id = w.addTicket(...TICKET)
    const first = w.tick(), second = w.tick()
    assert.match(first.out, /Claude is signed out/)
    assert.match(first.out, /ticket put back, worker stops/)
    assert.equal(w.ticket(id).status, "ready", "put back, not failed")
    assert.deepEqual(w.roles(), ["build", "build"], "one attempt per tick, never a retry loop")
    assert.equal((w.outbox().match(/Claude is signed out on the Mac/g) ?? []).length, 1, "the notice goes out once, not on every tick")
    assert.deepEqual(w.prs(), [])
    assert.deepEqual(w.mainLog(), ["Fixture app"])
    assert.match(second.out, /signed out/)
  } finally { w.clean() }
})

test("6. the week cap is reached: no build starts, and `dobby limits` says why", () => {
  const w = world({ scenario: "happy-path", usage: { five: 5, week: 99 } })
  try {
    const id = w.addTicket(...TICKET)
    const t = w.tick()
    assert.match(t.out, /skip: /)
    assert.deepEqual(w.roles(), [], "no claude call at all, not even a card summary")
    assert.equal(w.ticket(id).status, "ready")
    const limits = w.dobby("limits").out
    assert.match(limits, /Paused at 99% of your week \(your cap\)/)
    assert.match(limits, /week {3}▕█+▏ 99% \(cap 95%\)/)
    assert.equal((w.outbox().match(/Builders paused/g) ?? []).length, 1, "one ping that builders paused for the budget")
    // room again: the same ticket builds
    w.usage({ five: 20, week: 20 })
    w.runUntilIdle()
    assert.equal(w.ticket(id).status, "shipped")
  } finally { w.clean() }
})

// Real bug the end-to-end run found, fixed (budgetAllows in src/lib.ts used to check the 5-hour pace cap before the weekly cap). Over the weekly cap,
// the pace cap collapses to 20%, so with the 5-hour window at 20% or more the reason given is the 5-hour one, and the ping offers
// "keep building up to 70-100%" buttons that cannot help: the week is what blocks.
test("6b. over the weekly cap with the 5-hour window also high, the reason is the weekly cap", () => {
  const w = world({ scenario: "happy-path", usage: { five: 20, week: 99 } })
  try {
    w.addTicket(...TICKET)
    const t = w.tick()
    assert.match(t.out, /skip: Paused at 99% of your week/)
    assert.doesNotMatch(w.outbox(), /keep building up to a higher share/, "no keep-building buttons when the week is what blocks")
    assert.deepEqual(w.roles(), [], "and no model call for a card about it")
    assert.match(w.outbox(), /weekly at 99% \(your cap is 95%\)/, "the ping names the weekly cap")
    assert.match(w.outbox(), /resumes /, "and when it resets")
    assert.doesNotMatch(w.outbox(), /5-hour window at/, "and does not blame the 5-hour window")
  } finally { w.clean() }
})

test("merges paused on a fresh install: the PR opens and waits; nothing merges until `resume merges`", () => {
  const w = world({ scenario: "happy-path" })
  try {
    w.dobby("pause", "merges") // what `dobby init` does on a fresh install: the first merge waits for the owner
    const id = w.addTicket(...TICKET)
    w.runUntilIdle()
    assert.equal(w.ticket(id).status, "fixing", "held, waiting for the merge pause to end")
    assert.match(w.ticket(id).note ?? "", /Held: merges paused/)
    assert.equal(w.prs().length, 1)
    assert.equal(w.prs()[0].state, "OPEN", "the PR is open, not merged")
    assert.deepEqual(w.mainLog(), ["Fixture app"])
    assert.ok(!w.roles().includes("review"), "a held PR is not even reviewed until the pause ends")
    w.dobby("resume", "merges")
    const scan = w.dobby("review-scan")
    assert.equal(scan.code, 0, scan.out)
    assert.equal(w.prs()[0].state, "MERGED", scan.out)
    assert.equal(w.ticket(id).status, "shipped")
    assert.deepEqual(w.mainLog(), ["Add a farewell helper (#1)", "Fixture app"])
  } finally { w.clean() }
})

// A project that was never onboarded (newcomer test #406): `dobby add` says the first build reads the repo first, and `dobby run`
// onboards and then builds in the same call. A run that builds nothing exits 1 with the reason.
import assert from "node:assert/strict"
import { test } from "node:test"
import { world } from "./harness.ts"

test("never onboarded: add says so; run onboards, then builds the ticket in the same call", () => {
  const w = world({ scenario: "happy-path" })
  try {
    w.sql("DELETE FROM kv WHERE k='onboarded:tally' RETURNING k")
    const add = w.dobby("add", "tally", "Add a farewell helper", "src/farewell.js exports farewell(name)", "S")
    assert.match(add.out, /tally is new to Dobby: before the first build, Dobby reads the repo once \(a few minutes\)\. dobby run 1 does both now\./)
    const r = w.dobby("run", "1")
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /tally was never onboarded; onboarding first/)
    assert.ok(w.roles().includes("onboard"), w.roles().join(","))
    assert.ok(w.roles().includes("build"), `the same run built the ticket: ${w.roles().join(",")}`)
    assert.notEqual(w.ticket(1).status, "ready")
    assert.doesNotMatch(w.dobby("add", "tally", "Second", "x", "S").out, /new to Dobby/)
  } finally { w.clean() }
})

test("run: onboarding fails, so nothing is built and the exit is 1 with the reason", () => {
  const w = world({ scenario: { roles: { onboard: [{ error: "onboarding broke" }] } } })
  try {
    w.sql("DELETE FROM kv WHERE k='onboarded:tally' RETURNING k")
    const id = w.addTicket("Add a farewell helper")
    const r = w.dobby("run", String(id))
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, new RegExp(`#${id} was not built and is back in the queue.*Run dobby run ${id} again`))
    assert.equal(w.ticket(id).status, "ready")
  } finally { w.clean() }
})

test("pace cap with no Discord: the tick prints the command that lifts it, and no button or approve text", () => {
  const w = world({ usage: { five: 95, week: 10 } })
  try {
    w.addTicket("Add a farewell helper")
    const r = w.tick()
    assert.match(r.out, /⏸ Builders paused · 5-hour window at 95%/)
    assert.match(r.out, /Lift it for this window: dobby do keepgoing 100/)
    assert.doesNotMatch(r.out, /Buttons:|dobby approve <id>|keep building up to a higher share/)
    const lift = w.dobby("do", "keepgoing", "100") // the printed command works as printed
    assert.equal(lift.code, 0, lift.out)
    assert.match(lift.out, /Building again up to 100% of this 5-hour window/)
  } finally { w.clean() }
})

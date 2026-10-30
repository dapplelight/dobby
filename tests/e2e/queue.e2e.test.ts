// The queue loop (`dobby tick`): which ready ticket a builder takes first, spreading across projects, and what a pause skips.
// Claude is signed out in these worlds, so every build stops at its first call and the ticket goes back: the claim order is
// the only thing left to read, and it is printed by the tick. Temp world, fake Claude and GitHub (tests/e2e/harness.ts).
import assert from "node:assert/strict"
import { test } from "node:test"
import { world } from "./harness.ts"

/** Ticket ids in the order the tick claimed them: "[w1] #4 tally: ..." lines. */
const claimed = (out: string) => [...out.matchAll(/\[w\d+\] #(\d+) \w+:/g)].map((m) => Number(m[1]))

test("claim order: highest priority first, then a project with nothing running before one that is already building", () => {
  const w = world({ moreProjects: ["shopfront"], scenario: { signedOut: true } })
  try {
    const low = w.addTicket("Low priority tally work", "", "S", 50)
    const high = w.addTicket("High priority tally work", "", "S", 90)
    const other = w.addTicket("Shopfront work", "", "S", 60, "shopfront")
    const out = w.tick().out
    // worker 1 takes the top ticket (90). Tally is now building, so worker 2 spreads to shopfront (60) rather than tally's 50; worker 3 takes what is left
    assert.deepEqual(claimed(out), [high, other, low], out)
  } finally { w.clean() }
})

test("a paused project and a paused ticket are skipped, the next one is taken; resume brings them back", () => {
  const w = world({ moreProjects: ["shopfront"], scenario: { signedOut: true } })
  try {
    const a = w.addTicket("Tally one", "", "S", 90)
    const b = w.addTicket("Tally two", "", "S", 80)
    const c = w.addTicket("Shopfront one", "", "S", 70, "shopfront")
    assert.match(w.dobby("pause", "project", "shopfront").out, /Paused project shopfront/)
    assert.match(w.dobby("pause", "ticket", String(a)).out, new RegExp(`Paused ticket #${a}`))
    const out = w.tick().out
    assert.deepEqual(claimed(out), [b], out)
    assert.match(out, /\[w\d\] done after 0 ticket\(s\): nothing ready/)
    assert.match(w.dobby("pause", "status").out, /project shopfront[\s\S]*ticket #1|ticket #1[\s\S]*project shopfront/)
    w.dobby("resume", "project", "shopfront"); w.dobby("resume", "ticket", String(a))
    const after = w.tick().out
    assert.deepEqual(claimed(after).sort(), [a, b, c].sort(), after)
  } finally { w.clean() }
})

test("builders paused: the tick starts nothing until they are resumed", () => {
  const w = world({ scenario: { signedOut: true } })
  try {
    const id = w.addTicket("Some work")
    w.dobby("pause", "builders")
    const out = w.tick().out
    assert.deepEqual(claimed(out), [])
    assert.match(out, /stops: builders builders paused by the owner/)
    assert.equal(w.ticket(id).status, "ready")
    assert.deepEqual(w.roles(), [])
    w.dobby("resume", "builders")
    assert.deepEqual(claimed(w.tick().out), [id])
  } finally { w.clean() }
})

test("everything paused: the tick says so and exits; the lock keeps a second tick out", () => {
  const w = world({ scenario: { signedOut: true } })
  try {
    w.addTicket("Some work")
    w.dobby("pause", "all")
    assert.match(w.tick().out, /everything paused by the owner/)
    w.dobby("resume", "all")
    // a fresh lock from another live tick: this one backs off without touching the ticket
    w.setKv("lock", String(Date.now()))
    const busy = w.dobby("tick")
    assert.match(busy.out, /busy: another tick is running/)
    assert.deepEqual(w.roles(), [])
  } finally { w.clean() }
})

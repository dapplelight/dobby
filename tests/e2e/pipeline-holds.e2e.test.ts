// When a merge must not go through on its own: the safety rules hold it (7), the branch moved after the review (8), and the deploy
// waits for the owner's tap (9). Fake Claude and fake GitHub, temp dirs only (tests/e2e/harness.ts).
import assert from "node:assert/strict"
import { test } from "node:test"
import { world } from "./harness.ts"

const TICKET = ["Add a farewell helper", "src/farewell.js exports farewell(name) and a test covers it"] as const

test("7. safety holds it: a data migration under the balanced preset becomes a draft PR that waits for the owner, who merges it", () => {
  const w = world({ scenario: "migration" })
  try {
    const id = w.addTicket("Add a farewell helper and backfill the currency", "src/farewell.js exports farewell(name); a migration fills in a missing currency")
    const out = w.runUntilIdle()
    assert.match(out, /size: owner, migrations\.data/)
    const t = w.ticket(id)
    assert.equal(t.status, "failed", "parked for the owner, not merged")
    assert.match(t.note ?? "", /^needs you: migrations\.data/)
    assert.match(t.note ?? "", /draft PR: https:\/\/github\.com\/acme\/tally\/pull\/1/)
    assert.equal(w.prs().length, 1)
    assert.equal(w.prs()[0].draft, true, "a draft")
    assert.equal(w.prs()[0].state, "OPEN")
    assert.ok(!w.roles().includes("review"), "nothing reviews or auto-merges a held PR")
    assert.deepEqual(w.mainLog(), ["Fixture app"])
    assert.match(w.outbox(), /Needs you/)
    // Dobby never lands owner-level work, not even on `dobby merge`: it says so, and the PR stays a draft
    const refused = w.dobby("merge", String(id))
    assert.match(refused.out, /owner-only work \(migrations\.data/)
    assert.equal(w.prs()[0].draft, true, "refused before it is marked ready")
    assert.equal(w.prs()[0].state, "OPEN")
    // the owner reads it, marks it ready and merges it on GitHub (here: the fake gh, as the owner)
    w.sh("gh", ["pr", "ready", "https://github.com/acme/tally/pull/1", "-R", "acme/tally"], w.repo)
    assert.match(w.dobby("merge", String(id)).out, /owner-only work \(migrations\.data/, "even when ready, Dobby still leaves the merge to the owner")
    assert.equal(w.prs()[0].state, "OPEN")
    w.sh("gh", ["pr", "merge", "1", "-R", "acme/tally", "--squash", "--delete-branch"], w.repo)
    assert.equal(w.prs()[0].state, "MERGED")
    assert.deepEqual(w.mainLog(), ["Add a farewell helper and backfill the currency (#1)", "Fixture app"])
    assert.match(w.mainFile("migrations/0002_backfill.sql") ?? "", /UPDATE accounts/)
  } finally { w.clean() }
})

// Gap the end-to-end run found, now closed by the review scan: nothing told Dobby the owner merged a held draft, so the ticket stays "failed: needs you" (a Stuck
// card on the board) after the work is on main.
test("7b. after the owner merges the held draft, the ticket is shipped", () => {
  const w = world({ scenario: "migration" })
  try {
    const id = w.addTicket("Add a farewell helper and backfill the currency", "a migration fills in a missing currency")
    w.runUntilIdle()
    w.sh("gh", ["pr", "ready", "https://github.com/acme/tally/pull/1", "-R", "acme/tally"], w.repo)
    w.sh("gh", ["pr", "merge", "1", "-R", "acme/tally", "--squash", "--delete-branch"], w.repo)
    w.dobby("tick"); w.dobby("review-scan")
    assert.equal(w.ticket(id).status, "shipped")
    assert.equal(w.ticket(id).note, "https://github.com/acme/tally/pull/1")
    assert.match(w.outbox(), /Merged/)
  } finally { w.clean() }
})

test("8. the branch moves after the review: the merge is refused (it would merge code nobody reviewed)", () => {
  const w = world({ scenario: "branch-moves" })
  try {
    const id = w.addTicket(...TICKET)
    w.runUntilIdle()
    const t = w.ticket(id)
    assert.equal(t.status, "failed")
    assert.match(t.note ?? "", /Head branch was modified/)
    assert.equal(w.prs()[0].state, "OPEN", "the PR stays open")
    assert.deepEqual(w.mainLog(), ["Fixture app"], "nothing reached main")
    assert.ok(!w.mainFile("NOTES.md"))
    const merge = w.ghCalls().find((c) => c.args[0] === "pr" && c.args[1] === "merge")
    assert.ok(merge?.args.includes("--match-head-commit"), "Dobby asked GitHub to merge only the head it reviewed")
    assert.equal(merge?.code, 1)
  } finally { w.clean() }
})

test("9. a project with a deploy command: after the merge the deploy waits for the tap, and the tap runs it once", () => {
  const w = world({
    project: ["deploy: sh scripts/deploy.sh"],
    config: { safety: { preset: "balanced", rules: {}, classifier: "none", unsure: "allow", deploy: "ask" } },
    files: { "scripts/deploy.sh": "echo \"deployed $(git rev-parse --short HEAD)\" >> \"$HOME/deploys.log\"\ngit tag -f deploy/prod > /dev/null\n" },
    scenario: "happy-path",
  })
  try {
    const id = w.addTicket(...TICKET)
    const out = w.runUntilIdle()
    assert.equal(w.ticket(id).status, "shipped")
    assert.equal(w.prs()[0].state, "MERGED")
    assert.match(out, /tally: merged; the deploy waits for your tap/)
    assert.match(w.outbox(), /tally is merged and ready to deploy/)
    const log = `${w.dir.home}/deploys.log`
    const ran = () => { try { return w.sh("cat", [log], w.root).trim().split("\n").filter(Boolean) } catch { return [] } }
    assert.deepEqual(ran(), [], "nothing deployed before the tap")
    const tap = w.dobby("deploy", "tally")
    assert.match(tap.out, /tally: deployed [0-9a-f]{7}/, tap.out)
    assert.equal(ran().length, 1, "the tap deployed once")
    const again = w.dobby("deploy", "tally")
    assert.match(again.out, /nothing to deploy/, again.out)
    assert.equal(ran().length, 1, "a second tap on the same head does not deploy again")
  } finally { w.clean() }
})

// The ticket pipeline, start to merge, through the real CLI (`dobby tick`) with a fake Claude and a fake GitHub (tests/e2e/bin).
// Each test builds its own temp world (tests/e2e/harness.ts). Scenarios 1-4; the others live in the sibling *.e2e.test.ts files so
// node --test runs the three files in parallel.
import assert from "node:assert/strict"
import { test } from "node:test"
import { world } from "./harness.ts"

const TICKET = ["Add a farewell helper", "src/farewell.js exports farewell(name) and a test covers it"] as const

test("1. happy path: build, test, QA, PR with the cost comment, review, merge into main", () => {
  const w = world({ scenario: "happy-path" })
  try {
    const id = w.addTicket(...TICKET)
    w.runUntilIdle()
    assert.deepEqual(w.roles(), ["build", "check", "explain", "review"], "roles in order: engineer, QA, owner summary, reviewer")
    assert.equal(w.ticket(id).status, "shipped")
    assert.equal(w.ticket(id).note, "https://github.com/acme/tally/pull/1")
    const [pr] = w.prs()
    assert.equal(w.prs().length, 1)
    assert.equal(pr.state, "MERGED")
    assert.equal(pr.head, "dobby/1")
    assert.ok(pr.comments.some((c) => c.body.includes("<!-- dobby-cost -->")), "the cost comment is on the PR")
    assert.ok(pr.comments.some((c) => c.body.includes("## Claude Review") && c.body.includes("✅ pass")), "the review walkthrough is on the PR")
    assert.deepEqual(w.mainLog(), ["Add a farewell helper (#1)", "Fixture app"], "one squash commit on main")
    assert.match(w.mainFile("src/farewell.js") ?? "", /Goodbye/)
    // the models: the builder on sonnet, QA on sonnet, the summary on haiku
    const model = (r: string) => w.log().find((c) => c.role === r)?.model
    assert.equal(model("build"), "sonnet")
    assert.equal(model("explain"), "haiku")
    assert.match(w.outbox(), /✅ Merged · tally · Add a farewell helper/)
  } finally { w.clean() }
})

test("2. the review sends it back twice, the third review passes: two fix rounds, then merged", () => {
  const w = world({ scenario: "review-twice" })
  try {
    const id = w.addTicket(...TICKET)
    w.runUntilIdle({ maxSteps: 8 })
    assert.deepEqual(w.roles(), ["build", "check", "explain", "review", "build", "check", "review", "build", "check", "review"])
    assert.deepEqual(w.sql<{ verdict: string }>("SELECT verdict FROM reviews ORDER BY at, rowid").map((r) => r.verdict), ["fail", "fail", "pass"])
    // the two fix rounds are tickets on the PR branch; the original ticket ships when the last review passes
    const fixes = w.sql<{ id: number; onto: string; status: string; title: string }>("SELECT id, onto, status, title FROM tickets WHERE onto IS NOT NULL ORDER BY id")
    assert.deepEqual(fixes.map((f) => [f.onto, f.status]), [["dobby/1", "shipped"], ["dobby/1", "shipped"]])
    assert.equal(w.ticket(id).status, "shipped")
    assert.equal(w.prs().length, 1, "fix rounds push to the same PR, no new PR")
    assert.equal(w.prs()[0].state, "MERGED")
    assert.match(w.mainFile("src/farewell.js") ?? "", /Goodbye, \$\{name\}!/, "the last fix is what landed")
    assert.equal(w.mainLog().length, 2)
    assert.match(w.outbox(), /Review found issues; they were fixed automatically, then it passed/)
    assert.equal(w.kv("automerge:acme/tally#1"), undefined, "the wait is cleared once it merged")
  } finally { w.clean() }
})

test("3. QA fails once, the engineer fixes it, QA passes: merged", () => {
  const w = world({ scenario: "qa-fails-once" })
  try {
    const id = w.addTicket(...TICKET)
    const out = w.runUntilIdle()
    assert.deepEqual(w.roles(), ["build", "check", "build", "check", "explain", "review"])
    assert.match(out, /check \(sonnet\): fail, farewell\(\) with no name prints undefined/)
    assert.equal(w.ticket(id).status, "shipped")
    assert.equal(w.prs()[0]?.state, "MERGED")
    // the retry resumes the engineer's own session (the prompt cache stays warm)
    const builds = w.log().filter((c) => c.role === "build")
    assert.equal(builds[0].resume, undefined)
    assert.equal(builds[1].resume, "fake-build-0")
    assert.match(w.mainFile("src/farewell.js") ?? "", /friend/)
  } finally { w.clean() }
})

test("4. the build never passes the tests: out of builds, the ticket fails, its branch stays, nothing merges", () => {
  const w = world({ scenario: "build-never-passes" })
  try {
    const id = w.addTicket(...TICKET)
    w.runUntilIdle({ maxSteps: 6 })
    const t = w.ticket(id)
    assert.equal(t.status, "failed")
    assert.ok(w.roles().filter((r) => r === "build").length >= 2, "it was rebuilt before giving up")
    assert.ok(w.roles().filter((r) => r === "build").length <= 4, "never more than the build cap")
    assert.ok(!w.roles().includes("review"), "a ticket that fails verify is never reviewed")
    assert.deepEqual(w.prs(), [], "no PR was opened")
    assert.deepEqual(w.mainLog(), ["Fixture app"], "main is untouched")
    assert.match(w.git(w.repo, "branch", "--list", "dobby/1"), /dobby\/1/, "the branch is kept for the owner")
    assert.match(t.note ?? "", /^needs you: the same failure came back: .*Verify failed/s, "the same failure twice goes to the owner, not to another round")
    assert.equal(w.roles().filter((r) => r === "build").length, 2, "two builds, then it stops")
  } finally { w.clean() }
})

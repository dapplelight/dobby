// `dobby review <repo> <pr>` by hand on a PR somebody else opened (here: made with the fake gh), and the 15-minute sweep that finds
// new heads. The reviewer is the fake Claude answering in the reviewer's JSON; GitHub is the fake gh. Temp world only.
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { test } from "node:test"
import { world, type World } from "./harness.ts"

const finding = (severity: string) => ({ path: "src/farewell.js", line: 1, severity, problem: "A missing name prints 'undefined'.", trigger: "farewell()", fix: "Default the name.", suggestion: "export const farewell = (name = \"friend\") => `Goodbye, ${name}`" })

/** The owner's own PR on branch `feature/farewell` (not a Dobby branch): one new file. */
function openPr(w: World) {
  w.git(w.repo, "checkout", "-q", "-b", "feature/farewell")
  writeFileSync(`${w.repo}/src/farewell.js`, "export const farewell = (name) => `Goodbye, ${name}`\n")
  w.git(w.repo, "add", "-A"); w.git(w.repo, "commit", "-qm", "Add farewell")
  w.git(w.repo, "push", "-q", "origin", "feature/farewell")
  w.git(w.repo, "checkout", "-q", "main")
  return w.sh("gh", ["pr", "create", "--repo", "acme/tally", "--head", "feature/farewell", "--base", "main", "--title", "Add a farewell", "--body", "By hand."], w.repo).trim()
}

test("a clean review posts the walkthrough, sets the Claude Review status, and is not repeated for the same head", () => {
  const w = world({ scenario: { roles: { review: [{ summary: "Adds a helper.", risk: "low", changes: [{ path: "src/farewell.js", change: "new helper" }] }] } } })
  try {
    assert.equal(openPr(w), "https://github.com/acme/tally/pull/1")
    const r = w.dobby("review", "acme/tally", "1")
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /success|pass/i)
    const [pr] = w.prs()
    const walk = pr.comments.find((c) => c.body.includes("## Claude Review"))
    assert.ok(walk, "the walkthrough comment")
    assert.match(walk.body, /\*\*Verdict:\*\* ✅ pass: no open bugs found/)
    assert.match(walk.body, /\| `src\/farewell\.js` \| new helper \|/)
    assert.deepEqual(w.roles(), ["review"])
    // the commit status the merge gate reads
    const statuses = JSON.parse(w.sh("cat", [`${w.dir.gh}/state.json`], w.root)).statuses as Record<string, { context: string; state: string }[]>
    assert.deepEqual(Object.values(statuses).flat().map((s) => [s.context, s.state]), [["Claude Review", "success"]])
    // same head again: reported, not reviewed twice; --force reviews it again
    const again = w.dobby("review", "acme/tally", "1")
    assert.match(again.out, /already reviewed: pass at [0-9a-f]{7}; add --force for a fresh review/)
    assert.deepEqual(w.roles(), ["review"])
    w.dobby("review", "acme/tally", "1", "--force")
    assert.deepEqual(w.roles(), ["review", "review"])
    assert.equal(w.prs()[0].comments.filter((c) => c.body.includes("## Claude Review")).length, 1, "the walkthrough is edited in place, never duplicated")
  } finally { w.clean() }
})

test("a finding on a changed line becomes an inline comment, the verdict is fail, the status says failure, and a fix ticket is queued on the PR's branch", () => {
  const w = world({ scenario: { roles: { review: [{ findings: [finding("high")] }] } } })
  try {
    openPr(w)
    const r = w.dobby("review", "acme/tally", "1")
    assert.equal(r.code, 0, r.out)
    const [pr] = w.prs()
    assert.equal(pr.reviews.length, 1)
    assert.equal(pr.reviews[0].comments.length, 1, "one inline comment on the diff line")
    assert.match(JSON.stringify(pr.reviews[0].comments), /A missing name prints 'undefined'/)
    assert.match(JSON.stringify(pr.reviews[0].comments), /suggestion/, "the suggested fix is a GitHub suggestion block")
    assert.match(pr.comments.find((c) => c.body.includes("## Claude Review"))?.body ?? "", /\*\*Verdict:\*\* ❌ fail: 1 new inline comment/)
    const statuses = JSON.parse(w.sh("cat", [`${w.dir.gh}/state.json`], w.root)).statuses as Record<string, { state: string; description: string }[]>
    assert.match(JSON.stringify(Object.values(statuses).flat()), /"state":"failure"/)
    // a PR Dobby did not open gets up to two automatic fix rounds, as a ticket on its own branch, before the owner is pinged
    const fix = w.sql<{ onto: string; title: string; status: string }>("SELECT onto, title, status FROM tickets")
    assert.deepEqual(fix.map((t) => [t.onto, t.title, t.status]), [["feature/farewell", "Fix review findings on acme/tally#1", "ready"]])
    assert.doesNotMatch(w.outbox(), /Review failed/, "no ping while a fix round is queued")
    assert.equal(pr.state, "OPEN")
    assert.deepEqual(w.mainLog(), ["Fixture app"])
  } finally { w.clean() }
})

test("the sweep reviews open PRs it has not seen, once each head, and a reviewer that cannot read its own answer fails the review", () => {
  const w = world({ scenario: { roles: { review: [{ reply: "I could not decide." }] } }, config: { review: { auto: "on" } } })
  try {
    openPr(w)
    const first = w.dobby("review-scan")
    assert.equal(first.code, 0, first.out)
    assert.match(first.out, /acme\/tally #1/)
    assert.deepEqual(w.roles().filter((r) => r === "review"), ["review"])
    // an unreadable answer is a failed review, never a pass: the PR must not look approved
    const walk = w.prs()[0].comments.find((c) => c.body.includes("## Claude Review"))?.body ?? ""
    assert.match(walk, /❌ fail:.*the review was not readable|Raw reviewer answer/)
    assert.match(w.outbox(), /🔴 Review failed · tally/, "nothing to auto-fix from an unreadable answer, so the owner is pinged")
    const second = w.dobby("review-scan")
    assert.deepEqual(w.roles().filter((r) => r === "review"), ["review"], `the same head is not reviewed again: ${second.out}`)
  } finally { w.clean() }
})

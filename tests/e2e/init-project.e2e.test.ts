// `dobby init <repo>` when onboarding fails: no placeholder project file (install true, verify true) is left, exit 1 with the fix.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { test } from "node:test"
import { world } from "./harness.ts"

test("init <repo>: onboarding fails (signed out), so no project file is written and the exit is 1 with the fix line", () => {
  const w = world({ scenario: { signedOut: true } })
  try {
    const d = `${w.dir.projects}/widget`
    mkdirSync(d); w.git(d, "init", "-q", "-b", "main"); w.git(d, "commit", "-q", "--allow-empty", "-m", "x") // no dobby.md: a new project
    const r = w.dobby("init", "widget")
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /onboarder failed/)
    assert.match(r.out, /no project file was written\. Fix the error above, then run: dobby init /)
    assert.ok(!existsSync(`${w.dir.projects}/widget.md`), `left behind: ${readdirSync(w.dir.projects)}`)
  } finally { w.clean() }
})

test("a project whose verify is `true` is never built: the ticket stops with the no-test-command notice", () => {
  const w = world({ project: ["verify: true"] })
  try {
    const id = w.addTicket("Add a farewell")
    w.runUntilIdle()
    const t = w.ticket(id)
    assert.equal(t.status, "failed")
    assert.match(t.note ?? "", /no test command for tally: set verify in projects\/tally\.md/)
    assert.equal(w.prs().length, 0)
    assert.ok(!w.roles().includes("builder"), "no builder ran")
  } finally { w.clean() }
})

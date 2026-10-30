// A branch that conflicts with main costs nothing: no build runs, the ticket waits for the owner (issue 365).
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { test } from "node:test"
import { world } from "./harness.ts"

test("a ticket branch that conflicts with main is not built: Needs you, no Claude call, no PR", () => {
  const w = world({ scenario: "happy-path" })
  try {
    const id = w.addTicket("Change the greeting", "src/greet.js says hi")
    const edit = (text: string) => { writeFileSync(`${w.repo}/src/greet.js`, text); w.git(w.repo, "commit", "-qam", text) }
    w.git(w.repo, "checkout", "-qb", `dobby/${id}`)
    edit("export const greet = (name) => `Hi, ${name}`\n")
    w.git(w.repo, "push", "-q", "origin", `dobby/${id}`)
    w.git(w.repo, "checkout", "-q", "main")
    edit("export const greet = (name) => `Hey, ${name}`\n")
    w.git(w.repo, "push", "-q", "origin", "main")
    const t = w.tick()
    assert.ok(!w.roles().includes("build"), "no build ran")
    assert.equal(w.ticket(id).status, "failed")
    assert.match(w.ticket(id).note ?? "", /^needs you: the branch conflicts with main in src\/greet\.js\. Nothing was built/)
    assert.deepEqual(w.prs(), [])
    assert.match(t.out, /stopped before building/)
    w.tick()
    assert.ok(!w.roles().includes("build"), "and a second tick does not build it either")
  } finally { w.clean() }
})

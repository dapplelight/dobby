// CLI error paths: `goals import` must not say "Goals now live" when GitHub refused, and a machine without claude gets a plain line from `ask` and `doctor`, not a raw ENOENT.
import assert from "node:assert/strict"
import { test } from "node:test"
import { world } from "./harness.ts"

const goals = { "dobby.md": "---\nbase: main\ninstall: true\nverify: node --test\npriority: 5\n---\n## Goals\n- Ship the beta (due 2026-12-01)\n" }

test("goals import: gh missing from PATH exits 1 with the fix, not the success line", () => {
  const w = world({ files: goals })
  try {
    const r = w.dobbyEnv({ PATH: "/usr/bin:/bin" }, "goals", "import", "tally")
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /✗ Ship the beta: the GitHub CLI \(gh\) is not installed/)
    assert.match(r.out, /Goals import did not finish/)
    assert.doesNotMatch(r.out, /Goals now live/)
  } finally { w.clean() }
})

test("goals import: GitHub answering without a milestone exits 1; no goals to import says so", () => {
  const w = world({ files: goals })
  try {
    const r = w.dobby("goals", "import", "tally") // the fake gh answers [] to a milestone POST
    assert.equal(r.code, 1, r.out)
    assert.doesNotMatch(r.out, /Goals now live/)
  } finally { w.clean() }
  const none = world()
  try {
    const r = none.dobby("goals", "import", "tally")
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /Nothing to import/)
  } finally { none.clean() }
})

test("no claude on PATH: ask and doctor say Claude Code is not installed", () => {
  const w = world()
  try {
    const env = { PATH: "/usr/bin:/bin" } // plan mode: nothing here reaches the network
    const ask = w.dobbyEnv(env, "ask", "how many tickets are open?")
    assert.match(ask.out, /Couldn't handle that \(Claude Code is not installed or not on PATH/)
    assert.doesNotMatch(ask.out, /ENOENT/)
    const doc = w.dobbyEnv(env, "doctor")
    assert.match(doc.out, /✗ Claude Code: not installed/)
    assert.match(doc.out, /claude probe failed: Claude Code is not installed or not on PATH/)
  } finally { w.clean() }
})

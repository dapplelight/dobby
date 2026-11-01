import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { hostMerge, neededMerge } from "../src/graphs/ticket.ts"

const r = (cmd: string, args: string[], cwd?: string) => { const p = spawnSync(cmd, args, { cwd, encoding: "utf8" }); return { ok: p.status === 0, out: `${p.stdout}${p.stderr}` } }

test("NEEDS MERGE in the Builder's answer names a local dobby branch only", () => {
  assert.equal(neededMerge("Done the part I could.\nNEEDS MERGE: dobby/465\n"), "dobby/465")
  assert.equal(neededMerge("NEEDS MERGE: origin/main"), undefined)
  assert.equal(neededMerge("I never merge"), undefined)
})

test("hostMerge merges the asked branch once, then does nothing", () => {
  const d = mkdtempSync(`${tmpdir()}/dobby-hostmerge-`)
  const g = (...a: string[]) => r("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], d)
  g("init", "-q", "-b", "main"); writeFileSync(`${d}/a`, "1"); g("add", "a"); g("commit", "-qm", "a")
  g("checkout", "-qb", "dobby/1"); writeFileSync(`${d}/b`, "2"); g("add", "b"); g("commit", "-qm", "b")
  g("checkout", "-q", "main"); g("checkout", "-qb", "dobby/2")
  process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "t"; process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "t@t"
  assert.match(hostMerge(r, d, "dobby/1"), /^Dobby merged dobby\/1 into your branch on the host\. Continue/)
  assert.equal(hostMerge(r, d, "dobby/1"), "")
})

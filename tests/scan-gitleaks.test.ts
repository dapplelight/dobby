// scan.ts with gitleaks installed: the fake in tests/e2e/bin stands in for it (a line holding LEAKME is a finding). No real scanner runs.
import assert from "node:assert/strict"
import { test } from "node:test"
import { addedFiles, gitleaksHits, scanBranch } from "../src/scan.ts"

const BIN = new URL("./e2e/bin", import.meta.url).pathname
const diff = (file: string, lines: string[], start = 1) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -${start},0 +${start},${lines.length} @@\n${lines.join("\n")}\n`
/** Run `f` with the fake gitleaks first on PATH (or the scrubbed PATH when `installed` is false). */
function withPath<T>(installed: boolean, f: () => T, env: Record<string, string> = {}): T {
  const saved = { PATH: process.env.PATH, FAKE_GITLEAKS_EXIT: process.env.FAKE_GITLEAKS_EXIT }
  process.env.PATH = installed ? `${BIN}:${process.env.PATH}` : "/usr/bin:/bin"
  Object.assign(process.env, env)
  try { return f() } finally { process.env.PATH = saved.PATH; if (saved.FAKE_GITLEAKS_EXIT === undefined) delete process.env.FAKE_GITLEAKS_EXIT; else process.env.FAKE_GITLEAKS_EXIT = saved.FAKE_GITLEAKS_EXIT }
}

test("addedFiles places added lines at their real line numbers and skips lockfiles", () => {
  const d = diff("src/a.ts", ["+one", " ctx", "+three"], 4) + diff("package-lock.json", ['+  "version": "1.0.0"'])
  const files = addedFiles(d)
  assert.deepEqual([...files.keys()], ["src/a.ts"])
  assert.deepEqual(files.get("src/a.ts"), ["", "", "", "one", "", "three"])
})

test("gitleaks installed and clean: no hits", () => {
  assert.deepEqual(withPath(true, () => gitleaksHits(diff("src/a.ts", ["+const a = 1"]))), [])
})

test("gitleaks installed and finding something: file, line and rule, relative to the branch", () => {
  const hits = withPath(true, () => gitleaksHits(diff("src/deep/a.ts", ["+const a = 1", "+const k = 'LEAKME'"], 10)))
  assert.deepEqual(hits, [{ file: "src/deep/a.ts", line: 11, rule: "fake-rule" }])
})

test("gitleaks not installed, or crashed: null, so the regexes alone decide", () => {
  assert.equal(withPath(false, () => gitleaksHits(diff("src/a.ts", ["+LEAKME"]))), null)
  assert.equal(withPath(true, () => gitleaksHits(diff("src/a.ts", ["+LEAKME"])), { FAKE_GITLEAKS_EXIT: "2" }), null)
})

test("scanBranch merges regex and gitleaks hits once each and names the tool", () => {
  const key = "AK" + "IA" + "A".repeat(16)
  const d = diff("src/a.ts", [`+const k = "${key}" // LEAKME`])
  const both = withPath(true, () => scanBranch(d))
  assert.equal(both.tool, "gitleaks+regex")
  assert.deepEqual(both.hits.map((h) => h.rule).sort(), ["aws-key", "fake-rule"])
  const regexOnly = withPath(false, () => scanBranch(d))
  assert.equal(regexOnly.tool, "regex")
  assert.deepEqual(regexOnly.hits.map((h) => h.rule), ["aws-key"])
})

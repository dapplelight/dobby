// scanDiff on hand-made diffs. Every fake key is built by concatenation so this file holds no literal key pattern.
import assert from "node:assert/strict"
import { test } from "node:test"
import { hitLines, scanDiff } from "../src/scan.ts"

const rep = (c: string, n: number) => c.repeat(n)
// a one-hunk diff for `file` starting at line `start`; "+" lines are added, others context
const diff = (file: string, lines: string[], start = 1, isNew = false) =>
  `diff --git a/${file} b/${file}\n--- ${isNew ? "/dev/null" : `a/${file}`}\n+++ b/${file}\n@@ -${start},0 +${start},${lines.length} @@\n${lines.join("\n")}\n`

const FAKES: [string, string][] = [
  ["private-key", "-----BEGIN RSA " + "PRIVATE KEY-----"],
  ["aws-key", "AK" + "IA" + rep("A", 16)],
  ["google-api-key", "AI" + "za" + rep("b", 35)],
  ["stripe-key", "sk_" + "live_" + rep("c", 24)],
  ["anthropic-key", "sk-" + "ant-" + rep("d", 30)],
  ["openai-key", "sk-" + "proj-" + rep("e", 40)],
  ["github-token", "gh" + "p_" + rep("f", 36)],
  ["github-token", "github_" + "pat_" + rep("g", 30)],
  ["jwt", "ey" + "J" + rep("h", 12) + ".ey" + "J" + rep("i", 12) + "." + rep("j", 12)],
  ["discord-bot-token", "M" + rep("k", 24) + "." + rep("l", 6) + "." + rep("m", 27)],
  ["telegram-bot-token", rep("1", 9) + ":" + rep("n", 35)],
]

test("each secret shape is caught with file:line and rule, and the value is never in the output", () => {
  for (const [rule, key] of FAKES) {
    const r = scanDiff(diff("src/a.ts", [" const a = 1", `+const k = "${key}"`], 7))
    assert.deepEqual(r.hits, [{ file: "src/a.ts", line: 8, rule }], rule)
    assert.ok(!JSON.stringify(r).includes(key) && !hitLines(r.hits).includes(key))
  }
})

test("only added lines count: context and removed lines are ignored", () => {
  const key = "AK" + "IA" + rep("A", 16)
  const d = diff("a.ts", [` const k = "${key}"`, `-const old = "${key}"`, "+const ok = 1"])
  assert.deepEqual(scanDiff(d).hits, [])
})

test("a new .env is a hit, .env.example and an edit of an existing .env are not", () => {
  assert.deepEqual(scanDiff(diff(".env", ["+A=1"], 1, true)).hits, [{ file: ".env", line: 1, rule: "env-file" }])
  assert.equal(scanDiff(diff("app/.env.production", ["+A=1", "+B=2"], 1, true)).hits.length, 1)
  assert.deepEqual(scanDiff(diff(".env.example", ["+A=1"], 1, true)).hits, [])
  assert.deepEqual(scanDiff(diff(".env", ["+A=1"])).hits, [])
})

test("ordinary code is clean", () => {
  const d = diff("a.ts", ["+const ratio = 12345678 / 2", "+// sk- is the prefix we look for", "+const s = 'hello world'"])
  assert.deepEqual(scanDiff(d), { hits: [], deps: [] })
})

test("package.json: added and changed dependencies are listed, scripts and name are not", () => {
  const d = diff("package.json", ['+  "name": "foreman"', '+  "version": "1.0.0"', '+  "test": "node --test"', '+    "zod": "^3.23.8",', '+    "@scope/pkg": "1.2.3"'])
  assert.deepEqual(scanDiff(d), { hits: [], deps: ["@scope/pkg@1.2.3", "zod@^3.23.8"] })
})

test("lockfiles: package-lock, bun.lock, yarn.lock and pnpm names and versions; integrity hashes are not secrets", () => {
  const hash = rep("A", 86) + "=="
  const npm = diff("package-lock.json", [' "node_modules/left-pad": {', '+      "version": "1.3.0",', `+      "integrity": "sha512-${hash}"`])
  assert.deepEqual(scanDiff(npm), { hits: [], deps: ["left-pad@1.3.0"] })
  assert.deepEqual(scanDiff(diff("bun.lock", ['+    "zod": ["zod@3.23.8", "", {}, "sha512-x"],'])).deps, ["zod@3.23.8"])
  assert.deepEqual(scanDiff(diff("yarn.lock", ['+"ms@^2.1.3":', '+  version "2.1.3"'])).deps, ["ms@2.1.3"])
  assert.deepEqual(scanDiff(diff("pnpm-lock.yaml", ["+  /ms@2.1.3:", "+  '@scope/x@4.5.6':"])).deps, ["@scope/x@4.5.6", "ms@2.1.3"])
})

test("line numbers follow the hunks across several files", () => {
  const key = "gh" + "p_" + rep("f", 36)
  const d = diff("a.ts", ["+x"], 1) + diff("b.ts", [" y", " z", `+k = "${key}"`], 10)
  assert.deepEqual(scanDiff(d).hits, [{ file: "b.ts", line: 12, rule: "github-token" }])
})

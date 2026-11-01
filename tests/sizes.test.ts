// Ticket sizes come only from config (owner, 1 Nov): no size name, cost, cap or action in src, any number of sizes, any names.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.ts"

test("no size is hard-coded in src or the dashboard", () => {
  // A size literal next to `size`, an S/M/L enum or list, or an SQL size compare.
  const pattern = String.raw`size ?(===|!==|==|!=) ?["'][A-Z]{1,3}["']|size ?(=|!=) ?'[A-Z]{1,3}'|size: ?["'][A-Z]{1,3}["']|\["S", ?"M"|"S" ?\| ?"M"|BUILD_CAP|SIZE_PCT`
  let hits = ""
  try {
    hits = execFileSync("git", ["grep", "-nE", pattern, "--", "src", "dashboard/src", ":!*.test.*"], { encoding: "utf8" })
  } catch (e) {
    if ((e as { status?: number }).status !== 1) throw e // 1 = no match
  }
  assert.equal(hits, "", `sizes must come from config (src/sizes.ts):\n${hits}`)
})

test("the shipped default list loads when the user sets none", () => {
  const shipped = JSON.parse(readFileSync(new URL("../sizes.defaults.json", import.meta.url), "utf8")).sizes
  assert.deepEqual(loadConfig({ repo: "/nonexistent", private: null }).config.sizes, shipped)
})

test("a user list of any length and names replaces the shipped one; a bad list is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "sizes-"))
  const mine = [
    { name: "tiny", action: "build", tier: "small", estimatePct: 1, builds: 2 },
    { name: "mid", action: "build", tier: "medium", estimatePct: 4, builds: 3, model: "opus" },
    { name: "huge", action: "ask", tier: "large", estimatePct: 15, builds: 4 },
    { name: "epic", action: "split", tier: "large", estimatePct: 30, builds: 4, budget: 10 },
    { name: "XXL", action: "split", tier: "large", estimatePct: 40, builds: 4 },
  ]
  writeFileSync(join(dir, "ok.json"), JSON.stringify({ sizes: mine }))
  assert.deepEqual(loadConfig({ repo: "/nonexistent", private: join(dir, "ok.json") }).config.sizes, mine)
  writeFileSync(join(dir, "dup.json"), JSON.stringify({ sizes: [mine[0], mine[0]] }))
  const bad = loadConfig({ repo: "/nonexistent", private: join(dir, "dup.json") })
  assert.equal(bad.config.sizes.length, 4) // the shipped list stays
  assert.ok(bad.warnings.some((w) => /sizes/.test(w)), bad.warnings.join("\n"))
})

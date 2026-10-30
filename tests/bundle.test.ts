// The first-load budget check: a fake build over the budget fails, one under it passes, and dynamic imports are not counted.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { test } from "node:test"
import { BUDGET, firstLoad, overBudget } from "../scripts/check-bundle.ts"

function fake(entryBytes: number, lazyBytes: number) {
  const dist = mkdtempSync(`${tmpdir()}/dobby-bundle-`)
  mkdirSync(`${dist}/.vite`); mkdirSync(`${dist}/assets`)
  writeFileSync(`${dist}/assets/index.js`, randomBytes(entryBytes)) // random bytes do not compress
  writeFileSync(`${dist}/assets/lazy.js`, randomBytes(lazyBytes))
  writeFileSync(`${dist}/assets/index.css`, "a{}")
  writeFileSync(`${dist}/.vite/manifest.json`, JSON.stringify({ "index.html": { file: "assets/index.js", isEntry: true, css: ["assets/index.css"], dynamicImports: ["lazy.tsx"] }, "lazy.tsx": { file: "assets/lazy.js" } }))
  return dist
}

test("bundle budget: the entry's gzipped JS must stay under 200 KB; lazy chunks do not count", () => {
  const ok = firstLoad(fake(150_000, 900_000))
  assert.deepEqual(overBudget(ok), []); assert.ok(ok.js < BUDGET.js)
  const bad = overBudget(firstLoad(fake(210_000, 10)))
  assert.equal(bad.length, 1); assert.match(bad[0], /first-load JS .* over the 200\.0 KB budget/)
  assert.equal(overBudget({ js: 1, css: 61_000 }).length, 1)
})

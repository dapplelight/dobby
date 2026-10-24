// Public repo cut (bin/public-cut.mjs): which files stay out, and what the scan catches.
import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const script: string = "../bin/public-cut.mjs" // a plain .mjs script: no types to resolve
const { kept, patterns, scan } = await import(script)

test("public cut: owner files stay out, generic files stay in", () => {
  assert.deepEqual(kept(["projects/x.md", "projects.json", "company.md", "NOTES.md", "docs/audits/a.md", "docs/billing.md", "src/lib.ts", "README.md"]), ["docs/billing.md", "src/lib.ts", "README.md"])
})

test("public cut: whole private words in any case, home folders and personal emails are hits; parts of other words are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "dobby-cut-"))
  writeFileSync(join(dir, "a.ts"), ["const p = 'Acme-tickets'", `a cut path /Us${"ers"}/sam/x`, `mail sam@${"gmail"}.com`, "acmeorg is fine", "/Users/me/x is fine", "ok"].join("\n"))
  const hits = scan(dir, ["a.ts"], patterns(["acme", "ab"]))
  assert.deepEqual(hits, ["a.ts:1: acme", "a.ts:2: home folder", "a.ts:3: personal email"])
})

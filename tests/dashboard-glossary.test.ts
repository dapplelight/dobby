// Every glossary entry points at a real manual file and a real heading, so a rename cannot leave a dead "Learn more" link.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { GLOSSARY, MANUAL, roleKey, SETTING_TERMS, termUrl } from "../dashboard/src/lib/glossary.ts"

const slug = (h: string) => h.toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/ /g, "-")
const anchors = (file: string) => new Set(readFileSync(new URL(`../docs/manual/${file}`, import.meta.url), "utf8").split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, ""))))

test("every glossary docs path resolves to a manual file and heading", () => {
  for (const [key, e] of Object.entries(GLOSSARY)) {
    const [file, anchor] = e.docs.split("#")
    assert.ok(anchor, `${key} has no anchor`)
    assert.ok(anchors(file).has(anchor), `${key}: ${e.docs} does not exist`)
    assert.equal(termUrl(e.docs), `${MANUAL}/${e.docs}`)
  }
})

test("copy is plain: short, no em dashes", () => {
  for (const [key, e] of Object.entries(GLOSSARY)) {
    assert.ok(!/[—–]/.test(e.short + e.name), `${key} has a dash`)
    assert.ok(e.short.length <= 220, `${key} is long`)
  }
})

test("role names and setting keys map to real entries", () => {
  assert.equal(roleKey("Engineering Manager"), "engineering-manager")
  assert.equal(roleKey("checker"), "tester")
  assert.equal(roleKey("Nobody"), undefined)
  for (const t of Object.values(SETTING_TERMS)) assert.ok(t in GLOSSARY)
})

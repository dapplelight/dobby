// A repo folder named like a domain (example.com) is a project: its name keeps the dot in the draft, the project list, tickets and actions; unsafe names stay out.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-dots-`)
process.env.DOBBY_PROJECTS = `${dir}/drafts`
process.env.DOBBY_CONFIG = `${dir}/config.json`
mkdirSync(`${dir}/drafts`, { recursive: true })
const { isProjectDraft } = await import("../src/config.ts")
const { loadProjects } = await import("../src/lib.ts")
const { NewTicket } = await import("../src/api-schema.ts")
const { actionArgs } = await import("../src/dashboard-server.ts")
const { open } = await import("../src/db.ts")
const { findRepos } = await import("../src/setup-steps.ts")

test("isProjectDraft: dots between parts are fine; notes, hidden files and odd names are not projects", () => {
  for (const ok of ["tally.md", "example.com.md", "my-app.v2.md", "a_b.md"]) assert.equal(isProjectDraft(ok), true, ok)
  for (const bad of ["tally.knowledge.md", "example.com.onboard.md", ".hidden.md", "a..b.md", "a b.md", "a/b.md", "notes.txt", ".md", "-x.md"]) assert.equal(isProjectDraft(bad), false, bad)
})

test("a draft named example.com.md loads as the project example.com", () => {
  writeFileSync(`${dir}/drafts/example.com.md`, `---\nrepo: ${dir}/example.com\nbase: main\n---\n## Goal\nx\n`)
  writeFileSync(`${dir}/drafts/example.com.knowledge.md`, "notes")
  writeFileSync(`${dir}/drafts/tally.md`, `---\nrepo: ${dir}/tally\n---\n`)
  const names = Object.keys(loadProjects())
  assert.ok(names.includes("example.com") && names.includes("tally"))
  assert.ok(!names.some((n) => /knowledge|onboard/.test(n)), "notes are not projects")
})

test("tickets and actions accept a dotted project name and refuse path-like ones", () => {
  for (const ok of ["example.com", "tally", "my-app.v2"]) assert.equal(NewTicket.safeParse({ project: ok, title: "x" }).success, true, ok)
  for (const bad of ["../x", "a/b", ".hidden", "a..b", "a b", ""]) assert.equal(NewTicket.safeParse({ project: bad, title: "x" }).success, false, bad)
  const db = open(":memory:")
  assert.ok(!("error" in actionArgs(db, { action: "deploy", project: "example.com" })))
  assert.ok("error" in actionArgs(db, { action: "deploy", project: "../x" }))
  assert.ok(!("error" in actionArgs(db, { action: "pause", kind: "project", project: "example.com" })))
})

test("setup lists a repo folder named example.com, slugs one with a space, and leaves out a hidden one", () => {
  const root = mkdtempSync(`${dir}/root-`)
  for (const n of ["example.com", "with space", ".dotfirst"]) mkdirSync(`${root}/${n}/.git`, { recursive: true })
  const d = (dir: string) => ({ dir, pm: "npm", install: "true", test: null, deploy: null, base: "main", remote: "acme/x" })
  assert.deepEqual(findRepos(root, d).map((r) => r.dir.split("/").pop()), ["example.com", "with space"]) // the project name of the second is with-space (slugName)
})

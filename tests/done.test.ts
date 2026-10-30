// `dobby done`: a ticket finished outside Dobby is marked shipped. Offline: temp data dir, fake git; nothing else is reachable.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-done-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/s.txt` // missing: nothing can reach Discord or GitHub
process.env.DOBBY_CONFIG = `${dir}/config.json`
process.env.JEV_API_KEY = ""
mkdirSync(`${dir}/projects/tally`, { recursive: true })
writeFileSync(`${dir}/config.json`, JSON.stringify({ paths: { projects: `${dir}/projects` } }))
writeFileSync(`${dir}/projects/tally/dobby.md`, "---\nbase: main\n---\n## Goals\n- Ship")
const { open } = await import("../src/db.ts")
const { addTicket, getTicket, setTicket } = await import("../src/lib.ts")
const { doneText } = await import("../src/actions.ts")

const db = open()
const mk = (status: string) => { const { id } = addTicket(db, { project: "tally", title: `T ${status}` }); setTicket(db, id, { status: status as never }); return id }
const gitCalls: string[][] = []
const git = (a: string[]) => (gitCalls.push(a), "git@github.com:o/tally.git\n")

test("done on a ready ticket ships it and records the PR; only a read-only git call is made", () => {
  const id = mk("ready")
  assert.match(doneText(db, id, 12, git), /marked shipped/)
  const t = getTicket(db, id)!
  assert.equal(t.status, "shipped")
  assert.match(t.note!, /marked done by owner/i)
  assert.match(t.note!, /https:\/\/github\.com\/o\/tally\/pull\/12/)
  assert.deepEqual(gitCalls, [["remote", "get-url", "origin"]])
})

test("done without --pr makes no git call", () => {
  gitCalls.length = 0
  const id = mk("failed")
  doneText(db, id, undefined, git)
  assert.equal(getTicket(db, id)!.status, "shipped")
  assert.equal(gitCalls.length, 0)
})

test("done refuses a running, shipped or declined ticket and leaves it alone", () => {
  for (const s of ["running", "shipped", "declined"]) {
    const id = mk(s)
    assert.throws(() => doneText(db, id, undefined, git), /running|already/)
    assert.equal(getTicket(db, id)!.status, s)
  }
  assert.throws(() => doneText(db, 9999, undefined, git), /no ticket/)
})

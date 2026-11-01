// Update check: once a day, announce or install a newer dobby-ai; a git checkout never updates.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-update-`)
process.env.DOBBY_DIR = `${dir}/data`
process.env.DOBBY_SECRETS = `${dir}/none`
const { open } = await import("../src/db.ts")
const { compareVersions, updateCheck, updateLine } = await import("../src/update.ts")

const install = (v: string, git = false) => {
  const root = `${mkdtempSync(`${tmpdir()}/dobby-pkg-`)}/`
  writeFileSync(`${root}package.json`, JSON.stringify({ name: "dobby-ai", version: v }))
  if (git) mkdirSync(`${root}.git`)
  return root
}

test("compareVersions: numbers as numbers, a release beats its prereleases", () => {
  assert.equal(compareVersions("0.1.0-beta.3", "0.1.0-beta.2"), 1)
  assert.equal(compareVersions("0.1.0-beta.10", "0.1.0-beta.9"), 1)
  assert.equal(compareVersions("0.1.0", "0.1.0-beta.9"), 1)
  assert.equal(compareVersions("0.1.0-beta.2", "0.1.0-beta.2"), 0)
  assert.equal(compareVersions("0.2.0", "0.10.0"), -1)
})

test("a newer version is announced once a day; status says so; same version says nothing", () => {
  const db = open(":memory:")
  const calls: string[][] = []
  const run = (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { ok: true, out: "0.1.0-beta.3" } }
  const root = install("0.1.0-beta.2")
  assert.match(updateCheck(db, { run, root, now: 1e12 }), /Dobby 0\.1\.0-beta\.3 is out \(you have 0\.1\.0-beta\.2\)/)
  assert.match(updateLine(db)[0], /0\.1\.0-beta\.3 is out/)
  assert.equal(updateCheck(db, { run, root, now: 1e12 + 1000 }), "", "checked today already")
  assert.equal(calls.length, 1, "npm asked once")
  assert.ok(!calls.some((c) => c.includes("i")), "not installed without autoUpdate")
  const fresh = open(":memory:")
  assert.equal(updateCheck(fresh, { run, root: install("0.1.0-beta.3"), now: 1e12 }), "")
  assert.deepEqual(updateLine(fresh), [])
})

test("autoUpdate installs only while nothing builds; a git checkout is never touched", async () => {
  const db = open(":memory:")
  const calls: string[][] = []
  const run = (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return { ok: true, out: "0.2.0" } }
  const root = install("0.1.0")
  const at = new Date().toISOString()
  db.prepare("INSERT INTO tickets (project,title,status,created_at,updated_at) VALUES ('p','t','running',?,?)").run(at, at)
  assert.match(updateCheck(db, { auto: true, run, root, now: 1e12 }), /installing after the 1 running build/)
  assert.ok(!calls.some((c) => c[1] === "i"))
  db.prepare("UPDATE tickets SET status='shipped'").run()
  assert.match(updateCheck(db, { auto: true, run, root, now: 1e12 + 3_600_001 }), /installed Dobby 0\.2\.0/, "retried within the hour")
  assert.deepEqual(calls.at(-1), ["npm", "i", "-g", "dobby-ai@0.2.0"])
  assert.deepEqual(updateLine(db), [])
  calls.length = 0
  assert.equal(updateCheck(open(":memory:"), { auto: true, run, root: install("0.1.0", true), now: 1e12 }), "")
  assert.equal(calls.length, 0, "a git checkout never asks npm")
})

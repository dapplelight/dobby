// UAT 26 Oct, CLI group: --help never runs the command, refusals are one line and exit 1, flags come before the project word. Real CLI, temp data dir.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { commandHelp } from "../src/view.ts"

const dir = mkdtempSync(`${tmpdir()}/dobby-uat-cli-`)
const base = { ...process.env, DOBBY_DIR: dir, DOBBY_SECRETS: `${dir}/s.txt`, DOBBY_CONFIG: `${dir}/config.json`, JEV_API_KEY: "", DOBBY_DEBUG: "" }
const bin = new URL("../bin/dobby", import.meta.url).pathname
const run = (a: string[], extra: Record<string, string> = {}) => spawnSync(bin, a, { encoding: "utf8", env: { ...base, ...extra }, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 })

test("--help or -h anywhere prints that command's row and runs nothing", () => {
  for (const a of [["dashboard", "--help"], ["init", "-h"], ["add", "mcp", "--help"], ["add", "--help"], ["mcp", "--help"]]) {
    const r = run(a)
    assert.equal(r.status, 0, a.join(" "))
    assert.equal(r.stderr, "")
    assert.match(r.stdout, new RegExp(`^${a[0]}\\b`, "m"))
  }
  assert.match(run(["dashboard", "--help"]).stdout, /local web dashboard/)
  assert.match(run(["pause", "-h"]).stdout, /^pause \| resume/m)
  assert.match(commandHelp("// ---\n//   x <id>   y\n", "nope"), /No help for nope/)
})

test("a refusal is one line on stderr, exit 1, no stack; DOBBY_DEBUG=1 keeps the stack", () => {
  const r = run(["idea"])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /usage: idea/)
  assert.doesNotMatch(r.stderr, /\n\s+at /)
  assert.match(run(["idea"], { DOBBY_DEBUG: "1" }).stderr, /\n\s+at /)
})

test("a missing ticket exits 1 for every verb; both lists say the same when empty", () => {
  for (const v of ["cancel", "approve", "decline", "show", "cost", "retry", "merge", "queue", "takeover"]) {
    const r = run([v, "1"])
    assert.equal(r.status, 1, v)
    assert.match(r.stderr, /no ticket #1/, v)
  }
  assert.equal(run(["list"]).stdout.trim(), "nothing open")
  assert.equal(run(["list", "--all"]).stdout.trim(), "nothing open")
})

test("flags come before the project word: add mcp --yes is not a project", () => {
  assert.doesNotMatch(run(["add", "-y", "mcp", "--http"]).stderr, /no dobby\.md for mcp/)
  assert.match(run(["add", "nosuch", "a ticket"]).stderr, /Run dobby init/)
})

test("small wording: config path and stats forced off", () => {
  assert.match(run(["config", "path"]).stdout, /dobby init or dobby config set creates it/)
  assert.match(run(["stats"], { DO_NOT_TRACK: "1" }).stdout, /Crash reports: off\nUsage stats: off\nForced off: DO_NOT_TRACK/)
})

test("safety explain on ticket text says migrations are judged from the PR's files", () => {
  const r = run(["safety", "explain", "drop the users table"])
  assert.match(r.stdout, /migrations are checked from the PR's files, not the ticket text/)
})

// #908: a test that fails once on clean base and passes on a second run is a flake: logged, no fix ticket.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-flaky-base-`)
process.env.DOBBY_DIR = `${dir}/data`
process.env.DOBBY_SECRETS = `${dir}/none`
const { open } = await import("../src/db.ts")
const { splitFlaky, logFlakes, ticketBrokenOnBase } = await import("../src/graphs/ticket.ts")

test("splitFlaky: failed on both runs = broken, failed only on the first = flaky", () => {
  assert.deepEqual(splitFlaky(["a", "b", "c"], ["b"]), { broken: ["b"], flaky: ["a", "c"] })
  assert.deepEqual(splitFlaky(["a"], []), { broken: [], flaky: ["a"] }, "passes alone: a flake")
  assert.deepEqual(splitFlaky([], []), { broken: [], flaky: [] })
})

test("a flake files no ticket and is counted; a test broken on both runs files one", () => {
  const db = open(":memory:")
  const { broken, flaky } = splitFlaky(["flaky one", "broken one"], ["broken one"])
  logFlakes(db, "p", flaky, 1000)
  ticketBrokenOnBase(db, "p", { base: "main", verify: "bun test" }, broken)
  const titles = (db.prepare("SELECT title FROM tickets").all() as { title: string }[]).map((r) => r.title)
  assert.deepEqual(titles, ["Fix tests failing on main"])
  logFlakes(db, "p", ["flaky two"], 2000)
  const v = JSON.parse((db.prepare("SELECT v FROM kv WHERE k='flakes:p'").get() as { v: string }).v)
  assert.equal(v.total, 2)
  assert.deepEqual(v.recent.map((r: { name: string }) => r.name), ["flaky two", "flaky one"], "newest first")
})

test("#909: 13 failing tests file 1 ticket, grouped by file; a later failure adds to it; a shipped one starts a new one", async () => {
  const { brokenGroups, failedByFile } = await import("../src/graphs/ticket.ts")
  const db = open(":memory:")
  const p = { base: "main", verify: "bun test" }
  const out = ["@shop/web:test: src/a.test.ts:", ...Array.from({ length: 8 }, (_, i) => `@shop/web:test: (fail) a > case ${i} [1.0ms]`),
    "src/b.test.ts:", ...Array.from({ length: 5 }, (_, i) => `(fail) b > case ${i}`), "(pass) b > fine"].join("\n")
  const byFile = failedByFile(out)
  assert.deepEqual(Object.keys(byFile), ["src/a.test.ts", "src/b.test.ts"])
  const names = Object.values(byFile).flat()
  assert.equal(names.length, 13)
  ticketBrokenOnBase(db, "p", p, names, byFile)
  let rows = db.prepare("SELECT id, title, done_when FROM tickets").all() as { id: number; title: string; done_when: string }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, "Fix tests failing on main")
  assert.match(rows[0].done_when, /These 13 test\(s\)/)
  assert.equal(brokenGroups(rows[0].done_when).get("src/b.test.ts")?.length, 5)
  ticketBrokenOnBase(db, "p", p, ["c > new one"], { "src/c.test.ts": ["c > new one"] })
  ticketBrokenOnBase(db, "p", p, ["a > case 0"], byFile) // already listed: no change
  rows = db.prepare("SELECT id, title, done_when FROM tickets").all() as typeof rows
  assert.equal(rows.length, 1, "added to the open ticket")
  assert.match(rows[0].done_when, /These 14 test\(s\)/)
  assert.deepEqual(brokenGroups(rows[0].done_when).get("src/c.test.ts"), ["c > new one"])
  db.prepare("UPDATE tickets SET status='shipped'").run()
  ticketBrokenOnBase(db, "p", p, ["d > later"])
  rows = db.prepare("SELECT id, title, done_when FROM tickets ORDER BY id").all() as typeof rows
  assert.equal(rows.length, 2, "the old one shipped: a new ticket")
  assert.deepEqual(brokenGroups(rows[1].done_when).get("(file not known)"), ["d > later"])
})

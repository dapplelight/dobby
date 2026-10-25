// Usage reader resolution (explicit path > bundled) and the daily build cap while usage is unreadable. Offline, :memory: db.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-pace-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/s.txt`
writeFileSync(process.env.DOBBY_SECRETS, "")
const { open } = await import("../src/db.ts")
const L = await import("../src/lib.ts")
const { config, setConfig } = await import("../src/config.ts")

test("resolveUsageCli: explicit path wins, else the bundled reader", () => {
  assert.equal(L.resolveUsageCli("/x/cli.js", () => "/bundled/cli.js"), "/x/cli.js")
  assert.equal(L.resolveUsageCli("", () => "/bundled/cli.js"), "/bundled/cli.js")
  assert.equal(L.resolveUsageCli("~/y.js", () => "/b").startsWith("/"), true, "~ expanded")
})

test("fallback cap: counts started builds per day, blocks at the limit, warns once a day", () => {
  setConfig({ ...config(), pacing: { fallbackBuildsPerDay: 2 } })
  const db = open(":memory:")
  const told: string[] = []
  const tell = ((_d: unknown, text: string) => told.push(text)) as typeof L.fixed
  const day1 = Date.UTC(2026, 0, 5, 12), day2 = day1 + 86_400_000
  assert.equal(L.fallbackAllows(db, tell, day1).ok, true)
  L.fallbackStarted(db, day1)
  assert.equal(L.fallbackAllows(db, tell, day1).ok, true)
  L.fallbackStarted(db, day1)
  const g = L.fallbackAllows(db, tell, day1)
  assert.equal(g.ok, false)
  assert.equal(g.cap, 0)
  assert.equal(told.length, 1, "one warning per day")
  assert.match(told[0], /at most 2 builds/)
  assert.equal(L.fallbackAllows(db, tell, day2).ok, true, "a new day resets the count")
  assert.equal(told.length, 2)
  setConfig(undefined)
})

test("fallback cap: default is 3", () => {
  setConfig(undefined)
  assert.equal(L.fallbackLimit(), 3)
})

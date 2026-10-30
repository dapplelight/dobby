// A long-running process (dashboard, tick loop) sees a `dobby config set` made elsewhere. Temp files only.
import assert from "node:assert/strict"
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-reload-`)
const file = `${dir}/private.json`
process.env.DOBBY_DIR = dir
process.env.DOBBY_CONFIG = file
writeFileSync(file, JSON.stringify({ billing: { mode: "apiKey", dailyUsd: 10 } }))
const { config, setConfig } = await import("../src/config.ts")

test("config(): a changed config file is picked up by a process that already read it", async () => {
  assert.equal(config().billing?.dailyUsd, 10)
  writeFileSync(file, JSON.stringify({ billing: { mode: "apiKey", dailyUsd: 3 } }))
  const later = new Date(Date.now() + 5000)
  utimesSync(file, later, later)
  await new Promise((r) => setTimeout(r, 1100)) // the file check runs at most once a second
  assert.equal(config().billing?.dailyUsd, 3)
})

test("config(): setConfig pins a test's own config against reloads", async () => {
  setConfig({ ...config(), billing: { mode: "apiKey", dailyUsd: 7 } })
  await new Promise((r) => setTimeout(r, 1100))
  assert.equal(config().billing?.dailyUsd, 7)
  setConfig()
  assert.equal(config().billing?.dailyUsd, 3)
})

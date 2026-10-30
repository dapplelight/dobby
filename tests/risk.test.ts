// Risk without a Jev answer (src/jev.ts riskFromWords): offline, fake fetcher only, no ticket text leaves the machine.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-risk-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_PROJECTS = `${dir}/projects`
process.env.JEV_API_KEY = ""
const { riskFromWords, triage } = await import("../src/jev.ts")

test("riskFromWords: sensitive words are high, ordinary work is medium, never low", () => {
  assert.equal(riskFromWords("Fix typo on settings page", ""), "medium")
  assert.equal(riskFromWords("Add Stripe refunds", ""), "high")
  assert.equal(riskFromWords("Rotate the API token in config", ""), "high")
  assert.equal(riskFromWords("Drop the old users table", ""), "high")
  assert.equal(riskFromWords("Tidy the footer", "no more orphans: delete the old rows"), "high") // done-when counts
})

test("triage: no Jev answer uses the words, not blanket high", async () => {
  process.env.JEV_API_KEY = "test"
  const down = (async () => { throw new Error("offline") }) as unknown as typeof fetch
  assert.deepEqual(await triage("Fix typo on settings page", "", undefined, down), { size: "M", risk: "medium", riskBy: "words", fromJev: false })
  assert.equal((await triage("Add Stripe refunds", "", undefined, down)).risk, "high")
  process.env.JEV_API_KEY = ""
  assert.equal((await triage("Fix typo on settings page", "")).riskBy, "words") // no key at all
})

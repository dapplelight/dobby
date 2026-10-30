// The dashboard on an API key, in a real browser: over the daily cap it says paused, and plan-reading settings are not offered. Needs `npm run build` and Chromium, else skipped.
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { after, test } from "node:test"

const tmp = mkdtempSync(`${tmpdir()}/dobby-apikey-ui-`)
process.env.DOBBY_DIR = tmp
process.env.DOBBY_CONFIG = `${tmp}/config.json`
process.env.DOBBY_SECRETS = `${tmp}/vault.txt`
writeFileSync(process.env.DOBBY_CONFIG, JSON.stringify({ billing: { mode: "apiKey", dailyUsd: 10 } }))
const dist = new URL("../dashboard/dist", import.meta.url).pathname
const { open } = await import("../src/db.ts")
const { createDashboard } = await import("../src/dashboard-server.ts")
const { chromium } = await import("@playwright/test")

const db = open(":memory:")
db.prepare("INSERT INTO runs (at,kind,project,cost_usd,ok) VALUES (?,?,?,?,1)").run(new Date().toISOString(), "build", "tally", 12)
const built = existsSync(`${dist}/index.html`)
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try { if (built) browser = await chromium.launch({ executablePath: process.env.UI_CHROMIUM || undefined }) } catch {}
const skip = !browser && "no dashboard build or no Chromium here"
const server = createDashboard(db, { token: "k", dist, limits: () => ({ state: "apiKey", line: "Paused" }), pollMs: 300 })
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
after(async () => { await browser?.close(); server.close() })

test("API key: Spend says paused over the daily cap and has no unused budget on a fresh install; Settings hides plan-reading rows", { skip }, async () => {
  const p = await (await browser!.newContext()).newPage()
  await p.goto(`${base}/auth?token=k`)
  await p.goto(`${base}/spend`)
  await p.getByText("Paused: over the cap.").waitFor()
  assert.equal(await p.getByText(/Unused budget/).count(), 0)
  await p.goto(`${base}/settings`)
  await p.getByText("Daily cap (USD)").waitFor()
  for (const gone of ["Builds a day without a plan reading", "What your plan costs (USD)", "Reviews may use up to (5-hour %)"]) assert.equal(await p.getByText(gone).count(), 0, gone)
})

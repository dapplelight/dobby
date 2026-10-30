// Screenshots of `dobby init --ui` (setup in the browser): a failing machine check, the repo checks in progress, a failing repo with Claude's suggestion, the finish page,
// dark/light x desktop 1440x900 and phone 390x844, with made-up repos (tally, shopfront, notes) and fake machine checks, repo runs and model calls.
// Usage: SHOTS_CHANNEL=chrome node --no-warnings scripts/setup-shots.ts [outDir]   (needs `npm run build` first). Output is gitignored.
// Runs on a temp HOME, DOBBY_DIR and free ports: the real config, database and dashboard job are never touched.
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

const tmp = mkdtempSync(`${tmpdir()}/dobby-setup-shots-`)
const realHome = process.env.HOME
Object.assign(process.env, { DOBBY_DIR: `${tmp}/data`, DOBBY_SECRETS: `${tmp}/vault.txt`, DOBBY_CONFIG: `${tmp}/.config/dobby/config.json`, DOBBY_PROJECTS: `${tmp}/.config/dobby/projects`, HOME: tmp })
for (const k of ["DOBBY_STATS", "DO_NOT_TRACK", "CI"]) delete process.env[k]
mkdirSync(`${tmp}/.config/dobby`, { recursive: true })
writeFileSync(`${tmp}/vault.txt`, "DASHBOARD_TOKEN=shots-token\n")
for (const r of ["tally", "shopfront", "notes"]) {
  const d = `${tmp}/projects/${r}`
  mkdirSync(d, { recursive: true })
  writeFileSync(`${d}/package.json`, JSON.stringify({ scripts: r === "notes" ? {} : { test: "vitest run", "test:unit": "vitest run unit" } }))
  writeFileSync(`${d}/package-lock.json`, "{}")
  spawnSync("git", ["init", "-q", "-b", "main", d]); spawnSync("git", ["-C", d, "remote", "add", "origin", `https://github.com/acme/${r}.git`]); spawnSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"])
}
const { open } = await import("../src/db.ts")
const { createDashboard } = await import("../src/dashboard-server.ts")
const { chromium } = await import("@playwright/test")
const out = process.argv[2] ?? "docs/design/dashboard/shots/init-ui"
mkdirSync(out, { recursive: true })

const GOOD = [
  { name: "Node", ok: true, detail: "24.1.0", required: true }, { name: "git", ok: true, detail: "2.45.0", required: true }, { name: "GitHub CLI", ok: true, detail: "2.62.0", required: true },
  { name: "GitHub sign-in", ok: true, detail: "signed in as acme", required: true }, { name: "Claude Code", ok: true, detail: "2.1.0", required: true }, { name: "Claude sign-in", ok: true, detail: "signed in", required: true },
  { name: "graphify", ok: false, detail: "not installed (optional: code maps for builders and reviews)", fix: "uv tool install graphifyy", required: false },
]
const BAD = GOOD.map((r) => (r.name === "GitHub sign-in" ? { ...r, ok: false, detail: "not signed in", fix: "gh auth login --web" } : r.name === "Claude sign-in" ? { ...r, ok: false, detail: "not signed in", fix: "run claude, then /login" } : r))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** A setup server with fake checks, repo runs and Claude, so every state can be shown. */
async function server() {
  let checks = 0
  writeFileSync(`${tmp}/.config/dobby/config.json`, JSON.stringify({ github: { owner: "someone-else", accounts: ["someone-else"] } })) // a config from another account: setup asks which owner to use
  const unit = new Set<string>()
  const db = open(":memory:")
  const s = createDashboard(db, {
    token: "shots-token",
    setup: {
      db, root: `${tmp}/_npx/abc/node_modules/dobby-ai/`, onPath: () => false, home: tmp, platform: "darwin", fresh: true, configFile: `${tmp}/.config/dobby/config.json`,
      rights: async () => [], fork: (r: string) => (r === "acme/shopfront" ? "upstream-org/shopfront" : null), machine: "machine-aaaaaa", gh: () => ({ ok: false, out: "" }),
      verify: { has: () => true, lfs: () => false },
      check: async () => (checks++ === 0 ? BAD : GOOD) as never,
      run: async (cmd: string) => { await sleep(900); return cmd === "npm run test" && !unit.has("failed") && (unit.add("failed"), true) ? { ok: false, out: "FAIL tests/orders.test.ts\nError: connect ECONNREFUSED 127.0.0.1:5432\n2 tests failed" } : { ok: true, out: "12 passed" } },
      tools: { found: (t) => t === "rtk", run: () => ({ ok: true, out: "" }) },
      jobs: () => ["dashboard", "listener", "scheduler"].map((name) => ({ name, ok: true, detail: "loaded" })),
      issues: () => JSON.stringify([{ number: 41, title: "Export reports to CSV", body: "Done when: the report page has an Export button and the file opens in Excel.", labels: [] }]),
      claude: async () => ({ ok: true, text: JSON.stringify({ cause: "The tests connect to a Postgres database on localhost, which is not running.", fix: "Run the unit tests, which do not use the database.", test: "npm run test:unit" }) }),
      onFinish: () => {},
    },
  })
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok))

  return { base: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => s.close() }
}

const only = process.env.SHOTS_ONLY?.split(",") // e.g. SHOTS_ONLY=dark-desktop,dark-phone
const browser = await chromium.launch({ channel: process.env.SHOTS_CHANNEL ?? undefined, env: { ...process.env, HOME: realHome } as Record<string, string> })
for (const [scheme, size, name] of [["dark", { width: 1440, height: 900 }, "desktop"], ["light", { width: 1440, height: 900 }, "desktop"], ["dark", { width: 390, height: 844 }, "phone"], ["light", { width: 390, height: 844 }, "phone"]] as const) {
  if (only && !only.includes(`${scheme}-${name}`)) continue
  const srv = await server()
  const ctx = await browser.newContext({ viewport: size, colorScheme: scheme, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  page.on("pageerror", (e) => console.log("pageerror", e.message)); page.on("console", (m) => m.type() === "error" && console.log("console", m.text()))
  await page.goto(`${srv.base}/auth?token=shots-token`)
  const shot = async (n: string) => { await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(300); await page.screenshot({ path: `${out}/${n}-${scheme}-${name}.png`, fullPage: size.width < 768 }) }
  const press = (label: string | RegExp) => page.getByRole("button", { name: label }).first().click()
  // 1. This machine, with GitHub sign-in failing
  await page.getByRole("list", { name: "Checks" }).waitFor()
  await shot("1-machine-failing")
  await page.getByRole("list", { name: "Other rows" }).scrollIntoViewIfNeeded()
  await shot("1-terminal-only")
  await press("Check again"); await page.getByText(/signed in as acme/).waitFor()
  await press("Continue")
  // 2. the two optional questions: nothing preselected, no answer = off
  await page.getByText("Send crash reports?").waitFor()
  await shot("2-questions")
  await press("Continue")
  // 3. projects: repos from the folders, then the checks, with progress
  await page.getByRole("group", { name: /projects/ }).first().waitFor()
  await press(/^Check \d+ repos?/)
  await page.getByText(/Running/).first().waitFor()
  await page.waitForTimeout(500)
  await shot("3-verify-progress")
  await page.getByText(/ECONNREFUSED|2 tests failed/).first().waitFor({ timeout: 15_000 })
  await page.getByText(/passed in/).first().waitFor({ timeout: 15_000 }) // the checks run one repo at a time: wait for the last one
  await shot("3-verify-failed")
  const row = page.getByRole("checkbox", { name: "shopfront" }).locator("xpath=ancestor::div[contains(@class,'border-t')][1]")
  await row.getByRole("button", { name: /^Ask Claude/ }).click()
  await page.getByLabel("Suggested test command").waitFor()
  await shot("3-verify-suggestion")
  await press("Use these")
  await page.getByText(/passed in/).nth(1).waitFor({ timeout: 15_000 })
  await shot("3-verify-fixed")
  await page.getByRole("group", { name: "shopfront fork" }).scrollIntoViewIfNeeded()
  await shot("3-fork-question")
  await press("Continue")
  // chat, safety, stop at, tools, start
  await press("Continue")
  await press("Continue")
  await page.getByText(/Saved GitHub owner/).waitFor()
  await shot("5-owner-question")
  await press("Use acme")
  await press("Save and continue")
  await page.getByRole("list", { name: "Tools" }).waitFor()
  await shot("4-tools")
  await press("Continue")
  await press(/^Install these background jobs/)
  await page.getByText("Export reports to CSV").waitFor()
  await press("Skip")
  await shot("5-start")
  await press("Finish setup")
  await page.getByRole("heading", { name: "Setup is done." }).waitFor()
  await shot("6-finish")
  await ctx.close(); srv.close()
}
await browser.close()
console.log(`shots in ${out}`)
process.exit(0)

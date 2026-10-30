// The dashboard in a real browser (Chromium from @playwright/test), on a temp DOBBY_DIR and a free port: first run, offline, dialogs, signed out.
// Needs `npm run build` first (it serves dashboard/dist). Skipped when there is no build or no browser.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { after, test } from "node:test"

const tmp = mkdtempSync(`${tmpdir()}/dobby-ui-`)
process.env.DOBBY_DIR = tmp
process.env.DOBBY_CONFIG = `${tmp}/config.json`
process.env.DOBBY_SECRETS = `${tmp}/vault.txt`
process.env.DOBBY_PROJECTS = `${tmp}/projects`
writeFileSync(process.env.DOBBY_CONFIG, JSON.stringify({ paths: { projects: `${tmp}/projects` } }))
for (const r of ["tally", "shopfront"]) mkdirSync(`${tmp}/projects/${r}/.git`, { recursive: true })
const dist = new URL("../dashboard/dist", import.meta.url).pathname
const { open } = await import("../src/db.ts")
const { createDashboard } = await import("../src/dashboard-server.ts")
const { chromium } = await import("@playwright/test")

const TOKEN = "ui-token"
const db = open(":memory:")
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
const add = (id: number, status: string, title: string, project: string, note?: string, branch?: string) =>
  db.prepare("INSERT INTO tickets (id,project,title,status,note,branch,size,priority,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, project, title, status, note ?? null, branch ?? null, "M", 50, ago(24), ago(1))
add(412, "approval", "CSV export for reports", "tally", "https://github.com/acme/tally/pull/412", "dobby/412-csv-export")
add(409, "failed", "Login loop on Safari", "tally", "BLOCKED: needs an answer from the owner: keep the old cookie?")
add(205, "running", "Checkout on phone", "shopfront")
const listen = async (projects: () => Record<string, unknown>) => {
  const server = createDashboard(db, { token: TOKEN, dist, projects: projects as never, exec: async () => ({ ok: true, out: "done" }), pollMs: 300 })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` }
}
const known = { tally: { repo: `${tmp}/projects/tally`, base: "main", paused: false }, shopfront: { repo: `${tmp}/projects/shopfront`, base: "main", paused: false } }
const built = existsSync(`${dist}/index.html`)
const app = built ? await listen(() => known) : undefined
const fresh = built ? await listen(() => ({})) : undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
try { if (built) browser = await chromium.launch({ executablePath: process.env.UI_CHROMIUM || undefined }) } catch {}
const skip = !browser && "no dashboard build or no Chromium here"
after(async () => { await browser?.close(); app?.server.close(); fresh?.server.close() })

async function page(base: string, signedIn = true) {
  const ctx = await browser!.newContext({ viewport: { width: 1440, height: 900 } })
  const p = await ctx.newPage()
  const errors: string[] = []
  p.on("pageerror", (e) => errors.push(e.message))
  if (signedIn) await p.goto(`${base}/auth?token=${TOKEN}`)
  return { ctx, p, errors }
}

test("first run: Add on a found repo opens the dialog instead of crashing the page", { skip }, async () => {
  const { ctx, p, errors } = await page(fresh!.base)
  await p.goto(`${fresh!.base}/welcome`)
  await p.getByRole("button", { name: /^Add/ }).first().click()
  await p.getByRole("heading", { name: "Add a project" }).waitFor()
  assert.match(await p.getByText(/^dobby init /).first().innerText(), /^dobby init (tally|shopfront)$/)
  await p.getByRole("combobox", { name: "Repo" }).click() // the Select's items carry the Tooltip that needs its provider
  await p.getByRole("option").first().waitFor()
  assert.deepEqual(errors, [])
  await ctx.close()
})

test("New ticket: letters typed right after N go into the field, and the button says what is missing", { skip }, async () => {
  const { ctx, p, errors } = await page(app!.base)
  await p.goto(`${app!.base}/`)
  await p.getByRole("listbox", { name: "Needs you" }).waitFor()
  await p.keyboard.press("n")
  await p.getByRole("dialog").waitFor()
  assert.equal(await p.evaluate(() => (document.activeElement as HTMLInputElement | null)?.id), "nt-title") // focus is in the field as soon as the dialog is there
  await p.keyboard.type("gr") // "g" then "r" is the Reviews shortcut
  assert.equal(await p.getByLabel("What to build").inputValue(), "gr")
  assert.equal(new URL(p.url()).pathname, "/")
  await p.getByLabel("What to build").fill("")
  await p.getByText("Needs what to build.").waitFor()
  assert.equal(await p.getByRole("button", { name: "Add ticket" }).isDisabled(), true)
  await p.getByRole("combobox").first().click() // the project Select
  await p.getByRole("option").first().waitFor()
  assert.deepEqual(errors, [])
  await ctx.close()
})

test("Answer shows the question above the answer box", { skip }, async () => {
  const { ctx, p } = await page(app!.base)
  await p.goto(`${app!.base}/`)
  await p.getByRole("option", { name: /Login loop on Safari/ }).click()
  await p.getByRole("button", { name: /^Answer/ }).click()
  await p.getByRole("dialog").getByText("keep the old cookie?").waitFor()
  assert.doesNotMatch(await p.locator("[data-question]").innerText(), /BLOCKED/)
  await ctx.close()
})

test("offline: the first failed action shows the banner and a failed line, not silence", { skip }, async () => {
  const { ctx, p } = await page(app!.base)
  await p.goto(`${app!.base}/`)
  await p.getByRole("option", { name: /CSV export/ }).click()
  await ctx.setOffline(true)
  await p.getByRole("button", { name: /^Merge/ }).click()
  await p.getByRole("alert").filter({ hasText: "Merge did not run: Could not reach the dashboard" }).waitFor()
  await p.locator('[data-state="offline"]').waitFor()
  await p.getByRole("option", { name: /CSV export/ }).waitFor() // the page keeps what it had, and the row is still there
  await ctx.close()
})

test("signed out is one state: one banner and one command, no reconnect banner, no dialogs", { skip }, async () => {
  const { ctx, p } = await page(app!.base, false)
  await p.goto(`${app!.base}/`)
  await p.locator('[data-state="expired"]').waitFor()
  await p.waitForTimeout(500) // the event stream has failed its own 401 by now
  assert.equal(await p.locator("[data-state]").count(), 1)
  assert.equal(await p.getByRole("button", { name: "New ticket" }).isDisabled(), true)
  assert.equal(await p.getByRole("button", { name: "Pause the team" }).isDisabled(), true)
  await p.keyboard.press("n")
  assert.equal(await p.getByRole("dialog").count(), 0)
  await ctx.close()
})

test("/ticket/<id> opens the ticket's own page, with or without a pull request", { skip }, async () => {
  const { ctx, p } = await page(app!.base)
  await p.goto(`${app!.base}/ticket/205`)
  await p.waitForURL(/\/pr\/205$/)
  await p.getByRole("heading", { level: 1 }).waitFor()
  assert.doesNotMatch(await p.locator("body").innerText(), /Not Found/i)
  await ctx.close()
})

test("Team: Edit rules keeps Save on screen in a short window, and saving shows a line", { skip }, async () => {
  const { ctx, p } = await page(app!.base)
  await p.setViewportSize({ width: 1280, height: 640 })
  await p.goto(`${app!.base}/team`)
  await p.locator('[data-row="role:builder"]').click()
  await p.getByRole("button", { name: /Edit rules/ }).click()
  const box = p.locator("#role-text")
  await p.waitForFunction(() => !(document.querySelector("#role-text") as HTMLTextAreaElement).disabled)
  await box.press("Control+End"); await box.pressSequentially("\n- one more rule")
  const save = p.getByRole("button", { name: "Save", exact: true }), at = await save.boundingBox()
  assert.ok(at && at.y + at.height <= 640, `Save is inside the 640 px window (bottom at ${at && at.y + at.height})`)
  await save.click({ timeout: 3000 })
  await p.getByRole("status").filter({ hasText: "Saved roles/builder.md" }).waitFor({ timeout: 5000 })
  await ctx.close()
})

test("Queue: arrow keys on a row's drag handle move it and send the new place to the server", { skip }, async () => {
  for (const [id, title] of [[601, "Alpha job"], [602, "Beta job"], [603, "Gamma job"]] as const) add(id, "ready", title, "tally")
  const calls: string[][] = []
  const server = createDashboard(db, { token: TOKEN, dist, projects: (() => known) as never, exec: async (args: string[]) => (calls.push(args), { ok: true, out: "done" }), pollMs: 300 })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const { ctx, p } = await page(base)
  await p.goto(`${base}/queue`)
  await p.locator('[data-row="601"]').click()
  await p.getByRole("button", { name: "Drag Alpha job" }).press("ArrowDown")
  for (let i = 0; i < 50 && !calls.length; i++) await p.waitForTimeout(100)
  assert.deepEqual(calls.at(-1), ["reorder", "601", "603"], "Alpha moved down one: it now sits above Gamma, so the server is told")
  await ctx.close(); server.close()
})

test("every file that uses Signet's Select also provides its Tooltip", () => {
  for (const f of ["components/add-project.tsx", "components/dialogs.tsx", "routes/settings.tsx", "routes/welcome.tsx"]) {
    assert.match(readFileSync(new URL(`../dashboard/src/${f}`, import.meta.url), "utf8"), /TooltipProvider/, f)
  }
})

// Screenshots of the dashboard from seeded data (PR 7 adds: every page on a phone at 390 and 360, the five states, the ⌘K palette). Home, Queue, Goals, Reviews, the pull request, Spend and Activity in dark/light x desktop/phone, plus the undo strip, the ? overlay, a drag in progress and the Ideas tab.
// Usage: node --no-warnings scripts/dashboard-shots.ts [outDir]   (needs `npm run build` first)
// Everything runs on a temp DOBBY_DIR and a free port: the real database, config and dashboard job are never touched.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"

const tmp = mkdtempSync(`${tmpdir()}/dobby-shots-`)
process.env.DOBBY_DIR = tmp
mkdirSync(`${tmp}/.config/dobby`, { recursive: true }) // the same place a real install keeps it, so the page shows ~/.config/dobby/config.json
process.env.DOBBY_CONFIG = `${tmp}/.config/dobby/config.json`
process.env.DOBBY_SECRETS = `${tmp}/secrets.txt`
// Settings, Team and First run (PR 6): "~" is the temp dir, so paths read ~/projects/tally and nothing of the real home is listed. The browser keeps the real HOME.
const realHome = process.env.HOME
process.env.HOME = tmp
for (const r of ["tally", "shopfront", "notes"]) mkdirSync(`${tmp}/projects/${r}/.git`, { recursive: true })
const { open } = await import("../src/db.ts")
const { createDashboard } = await import("../src/dashboard-server.ts")
const { ensure } = await import("../src/usage.ts")
const { chromium } = await import("@playwright/test")

const out = process.argv[2] ?? "docs/design/dashboard/shots/pr7"
const only = process.env.SHOTS_ONLY?.split(",") // e.g. SHOTS_ONLY=reviews,pr,queue: just those groups (extras = the interactive ones)
const want = (g: string) => !only || only.includes(g)
const NOW = Date.now()
const DAY = 86_400_000
const db = open(":memory:")
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
const add = (id: number, status: string, title: string, project: string, h: number, note?: string, branch?: string, extra: { size?: string; priority?: number; dep?: number; goal?: number; done?: string } = {}) =>
  db.prepare("INSERT INTO tickets (id,project,title,status,note,branch,size,priority,depends_on,goal,done_when,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, project, title, status, note ?? null, branch ?? null, extra.size ?? "M", extra.priority ?? 50, extra.dep ?? null, extra.goal ?? null, extra.done ?? "", ago(h + 24), ago(h))
const run = (ticket: number, project: string, kind: string, ok: number) => db.prepare("INSERT INTO runs (at,project,kind,ticket,ok) VALUES (?,?,?,?,?)").run(ago(1), project, kind, ticket, ok)
add(412, "approval", "CSV export for reports", "tally", 0.2, "https://github.com/acme/tally/pull/412", "dobby/412-csv-export")
add(409, "failed", "Login loop on Safari", "tally", 0.7, "BLOCKED: needs an answer from the owner: keep the old cookie?")
add(198, "fixing", "Bulk delete", "shopfront", 2, "review still fails: no undo\nhttps://github.com/acme/shopfront/pull/198", "dobby/198-bulk-delete")
add(415, "running", "Dark mode for settings", "tally", 0.3); add(210, "running", "Empty cart state", "shopfront", 0.1, undefined, undefined, { size: "S" }); add(205, "running", "Checkout on phone", "shopfront", 0.05)
const FILLER = ["Empty states for lists", "Faster order search", "Keyboard shortcuts help", "Sort by date on tables", "Print layout for invoices", "Better error on failed upload", "Remember last used filter", "Export settings page", "Tooltips on chart points", "Compact table rows", "Password reset email text", "Currency formatting fix"]
for (let i = 0; i < 6; i++) add(400 + i, "shipped", FILLER[i], i % 2 ? "tally" : "shopfront", 20 + i * 8)
// the queue, in builder order: priority high to low (made-up projects tally and shopfront)
const ready: [number, string, string, string, string, number, number?, string?][] = [
  [418, "Recurring reports", "tally", "L", "A report can repeat weekly or monthly, the next run shows on the report, and a skipped run is never sent twice.", 90],
  [212, "Gift cards", "shopfront", "M", "", 85, 210],
  [420, "Import from Excel", "tally", "M", "", 80],
  [413, "Receipt email layout", "tally", "S", "", 75],
  [414, "Order history filters", "shopfront", "S", "", 70],
  [422, "Team accounts", "tally", "L", "", 65],
  [216, "Wishlist", "shopfront", "M", "", 60],
  [425, "Audit log", "tally", "M", "", 55],
]
for (const [id, title, project, size, done, priority, dep] of ready) add(id, "ready", title, project, 20 + (id % 7) * 5, undefined, undefined, { size, priority, dep, done })
for (const [id, title, project, size] of [[430, "Saved filters", "tally", "M"], [431, "Low stock alerts", "shopfront", "S"], [432, "CSV import errors", "tally", "S"]] as const) add(id, "backlog", title, project, 10 + (id % 5) * 9, undefined, undefined, { size })
const idea = db.prepare("INSERT INTO ideas (project,title,source,lens,why,size,score,status,created_at) VALUES (?,?,?,?,?,?,?,'proposed',?)")
idea.run("tally", "Remind people about unpaid invoices", "pm", "revenue", "Three of the last five support emails ask where an invoice stands. A weekly reminder removes the question.", "M", 8, ago(30))
idea.run("shopfront", "Show stock left on the product page", "pm", "conversion", "Shoppers leave when a size is out. Showing what is left, or a back-in-stock sign-up, keeps them.", "S", 6, ago(50))
idea.run("tally", "Export the audit log as CSV", "scout", null, "The audit log is read-only today; accountants ask for it every quarter.", "S", 4, ago(70))
for (const t of [412, 198, 415, 205]) run(t, t === 198 || t === 412 ? (t === 198 ? "shopfront" : "tally") : t === 415 ? "tally" : "shopfront", "build", t === 198 ? 0 : 1)
run(412, "tally", "check", 1); run(205, "shopfront", "build", 1)
// goals: tally Public beta (11 of 16 done), shopfront Payments v2 (4 of 9, late), tally Mobile app, shopfront Docs site (done); due dates as GitHub milestones
{
  const g = db.prepare("INSERT INTO goals (id,project,title,rank,milestone,updated_at) VALUES (?,?,?,?,?,?)")
  g.run(1, "tally", "Public beta", 1, 11, ago(1)); g.run(2, "shopfront", "Payments v2", 2, 12, ago(1)); g.run(3, "tally", "Mobile app", 3, 13, ago(1)); g.run(4, "shopfront", "Docs site", 4, 14, ago(1))
  const due = (n: number, days: number) => ({ number: n, title: "x", due_on: new Date(NOW + days * DAY).toISOString() })
  db.prepare("INSERT INTO kv VALUES ('gh:ms:tally', ?)").run(JSON.stringify([{ ...due(11, 8), title: "Public beta" }, { ...due(13, 26), title: "Mobile app" }]))
  db.prepare("INSERT INTO kv VALUES ('gh:ms:shopfront', ?)").run(JSON.stringify([{ ...due(12, 4), title: "Payments v2" }, { ...due(14, -4), title: "Docs site" }]))
  let id = 500
  const many = (n: number, status: string, project: string, goal: number, spread: number, titles: string[] = []) => { for (let i = 0; i < n; i++) add(id++, status, titles[i] ?? FILLER[id % FILLER.length], project, status === "shipped" ? 12 + (i / n) * spread * 24 : 6, undefined, undefined, { goal }) }
  many(11, "shipped", "tally", 1, 12); many(2, "shipped", "tally", 3, 12); many(4, "shipped", "shopfront", 2, 12); many(5, "shipped", "shopfront", 4, 12)
  for (const [tid, goal] of [[415, 1], [418, 1], [420, 1], [413, 1], [425, 1], [210, 2], [212, 2], [414, 2], [216, 2], [205, 2]] as const) db.prepare("UPDATE tickets SET goal=? WHERE id=?").run(goal, tid)
  many(10, "backlog", "tally", 3, 0, ["Sign in with Face ID", "Offline invoices", "Push reminders", "Receipt scanner", "Home screen widgets", "Share a report", "Tablet layout", "Onboarding tour", "Biometric lock", "Dark theme"])
}
db.prepare("INSERT INTO reviews (repo,pr,sha,verdict,at) VALUES ('acme/tally',412,'a1',?,?)").run("pass", ago(0.3))
// ---- reviews: PRs, six weeks of verdicts, findings on diff lines (made-up projects tally and shopfront)
const { saveFindings } = await import("../src/findings.ts")
const rv = db.prepare("INSERT INTO reviews (repo,pr,sha,choice,by,verdict,cost,at,took_ms) VALUES (?,?,?,?,?,?,?,?,?)")
const MIN = 60_000
{
  db.prepare("DELETE FROM reviews").run()
  const weeks = [[31, 13], [28, 11], [26, 12], [24, 11], [22, 9], [22, 9]] // [percent sent back, reviews] for the six weeks, oldest first
  let n = 0
  weeks.forEach(([pct, count], w) => { for (let i = 0; i < count; i++) { if (w === 5) add(600 + i, "shipped", ["Invoice reminders", "Stock on product page", "Saved filters", "Receipt layout", "Cart totals", "Search by SKU", "Export audit log", "Team invites", "Order notes"][i], i % 2 ? "tally" : "shopfront", 30 + i, `https://github.com/acme/${i % 2 ? "tally" : "shopfront"}/pull/${1000 + n}`, `dobby/${600 + i}-x`); rv.run(i % 2 ? "acme/tally" : "acme/shopfront", 1000 + n, `h${n}`, "sonnet", "rule", i < (count * pct) / 100 ? "fail" : "pass", 0.2, ago((5 - w) * 168 + 10 + i * 9), (4 + (i % 7)) * MIN) ; n++ } })
  rv.run("acme/shopfront", 198, "r1", "opus", "rule", "fail", 0.5, ago(60), 9 * MIN); rv.run("acme/shopfront", 198, "r2", "opus", "rule", "fail", 0.5, ago(30), 7 * MIN); rv.run("acme/shopfront", 198, "r3", "opus", "rule", "fail", 0.5, ago(2), 8 * MIN)
  rv.run("acme/tally", 412, "a0", "sonnet", "rule", "fail", 0.3, ago(5), 6 * MIN); rv.run("acme/tally", 412, "a1", "sonnet", "rule", "pass", 0.3, ago(0.3), 6 * MIN)
  rv.run("acme/tally", 409, "c1", "sonnet", "rule", "running", 0, ago(0.05), null)
  rv.run("acme/shopfront", 207, "d1", "sonnet", "rule", "pass", 0.3, ago(9), 7 * MIN)
  rv.run("acme/tally", 405, "e1", "haiku", "rule", "pass", 0.1, ago(40), 5 * MIN)
  add(207, "approval", "Empty cart state", "shopfront", 8, "https://github.com/acme/shopfront/pull/207", "dobby/207-empty-cart")
  db.prepare("UPDATE tickets SET title='Dark mode for reports', note='https://github.com/acme/tally/pull/405', branch='dobby/405-dark-reports' WHERE id=405").run()
  db.prepare("UPDATE tickets SET note=note || char(10) || 'https://github.com/acme/tally/pull/409' WHERE id=409").run()
  const F = (path: string, line: number, severity: "high" | "medium" | "low", problem: string, suggestion?: string) => ({ path, line, severity, problem, fix: "", suggestion })
  const at = (h: number) => ago(h)
  saveFindings(db, "acme/shopfront", 198, "r1", 1, at(60), [F("api/orders.ts", 42, "high", "Deletes up to 500 rows with no undo and no confirmation."), F("orders/BulkBar.tsx", 14, "high", "Select-all also picks rows hidden by the filter."), F("orders/BulkBar.tsx", 30, "medium", "There is no test for the delete bar.")])
  saveFindings(db, "acme/shopfront", 198, "r2", 2, at(30), [F("api/orders.ts", 42, "high", "Round 1 asked for a confirm and it is there. There is still no way back."), F("orders/BulkBar.tsx", 21, "medium", "The count shown can differ from what is deleted when the list changes under it.")], [])
  saveFindings(db, "acme/shopfront", 198, "r3", 3, at(2), [
    F("api/orders.ts", 42, "high", "Deletes up to 500 rows with no undo and no confirmation. Round 2 added a confirm; there is still no way back.", "  await db.orders.update({ deletedAt: now() }).where('id', 'in', ids)\n  schedulePurge(ids, { after: '10s' })"),
    F("orders/BulkBar.tsx", 21, "medium", "The count shown can differ from what is deleted when the list changes under it."),
    F("orders/List.tsx", 9, "low", "Name this prop selectedIds, like the rest of the file."),
  ], [])
  db.prepare("UPDATE findings SET state='fixed' WHERE sha='r1' AND path='orders/BulkBar.tsx'").run()
  saveFindings(db, "acme/tally", 412, "a0", 1, at(5), [F("api/export.ts", 18, "medium", "An empty report exports a header row only, with no message."), F("reports/Export.tsx", 7, "low", "Rename csvData to rows."), F("reports/Export.tsx", 33, "low", "A comment says TODO.")])
  saveFindings(db, "acme/tally", 412, "a1", 2, at(0.3), [])
  // older weeks: findings by kind and severity, so the page has something to show
  const more: [string, "high" | "medium" | "low", string, string][] = [
    ["Naming and style", "low", "Rename this variable to match the file's naming", "open"], ["Naming and style", "low", "Typo in a comment", "fixed"], ["Naming and style", "medium", "Format this block like the others", "fixed"],
    ["Missing test", "high", "No test covers the new branch", "fixed"], ["Missing test", "medium", "Add a test for the empty list", "fixed"], ["Missing test", "medium", "Assert the error message", "fixed"],
    ["Edge case", "high", "Crashes on an empty list", "fixed"], ["Edge case", "medium", "Null date is not handled", "fixed"], ["Accessibility", "medium", "The button has no label for a screen reader", "fixed"],
    ["Security", "high", "User input reaches the query unescaped", "fixed"], ["Security", "medium", "The token is logged", "dismissed"], ["Performance", "medium", "The list re-renders on every key", "fixed"], ["Performance", "low", "Cache this lookup", "dismissed"],
  ]
  more.forEach(([kind, sev, text, state], i) => db.prepare("INSERT INTO findings (repo,pr,sha,path,line,severity,kind,problem,fix,round,state,at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("acme/tally", 1000 + i, `h${i}`, `src/f${i}.ts`, 10 + i, sev, kind, text, "", 1, state, ago(24 + i * 6)))
}
db.prepare("INSERT INTO kv VALUES ('deploy:fails:shopfront', '2')").run()
db.prepare("INSERT INTO kv VALUES ('tick:last', ?)").run(String(NOW - 120_000))

// A week that is 61% through with 58% used, stop at 95: the design's example.
const week = { used: 58, cap: 95, resetsAt: NOW + 2.7 * DAY }
ensure(db) // the readings behind the curve: 58% so far, a slow start and a steeper middle
const start = week.resetsAt - 7 * DAY
for (const [d, u] of [[0.1, 1], [0.5, 5], [1, 12], [1.5, 15], [2, 20], [2.5, 26], [3, 33], [3.5, 40], [4, 52], [4.25, 58]] as const) db.prepare("INSERT INTO usage_ticks VALUES (?,?,?,?,?)").run(Math.round(start + d * DAY), 30, u, NOW + 3_600_000, week.resetsAt)
// ---- spend and activity: runs with a cost this week, three past weeks of readings (the third week back has none), recent merges and a retry
{
  const cost = db.prepare("INSERT INTO runs (at,project,kind,ticket,ok,cost_usd) VALUES (?,?,?,?,?,?)")
  const wk = (d: number) => new Date(week.resetsAt - 7 * DAY + d * DAY).toISOString()
  const spread: [string, string, number, number][] = [["tally", "build", 9, 4], ["tally", "check", 9, 1.5], ["tally", "review", 5, 1.4], ["shopfront", "build", 6, 2.6], ["shopfront", "check", 6, 1.2], ["shopfront", "review", 4, 1.1], ["tally", "lead", 3, 0.8], ["shopfront", "pm", 2, 0.5], ["tally", "build", 12, 2]]
  spread.forEach(([project, kind, n, usd], j) => { for (let i = 0; i < n; i++) cost.run(wk(0.3 + ((i * 7 + j * 3) % 40) / 10), project, kind, null, 1, usd / n) })
  for (const [i, landed] of [[1, 94], [2, 91], [4, 88]] as const) for (const [d, f] of [[0.5, 0.06], [2, 0.3], [3.5, 0.55], [5, 0.78], [6.8, 1]] as const) db.prepare("INSERT OR REPLACE INTO usage_ticks VALUES (?,?,?,?,?)").run(Math.round(week.resetsAt - i * 7 * DAY - 7 * DAY + d * DAY), 20, Math.round(landed * f), 0, week.resetsAt - i * 7 * DAY)
  const merged: [number, string, string, number][] = [[700, "Dark mode for reports", "tally", 0.4], [701, "Gift card validation", "shopfront", 1.6], [702, "Receipt email layout", "tally", 3.1], [703, "Order history filters", "shopfront", 5], [704, "Saved filters", "tally", 7.5], [705, "Search by SKU", "shopfront", 10]]
  for (const [id, title, project, h] of merged) add(id, "shipped", title, project, h)
  db.prepare("INSERT INTO runs (at,project,kind,ticket,ok,reason) VALUES (?,?,?,?,0,?)").run(ago(3.2), "tally", "build", 409, "tests failed")
  db.prepare("INSERT INTO runs (at,project,kind,ticket,ok) VALUES (?,?,?,?,1)").run(ago(2.7), "tally", "build", 409)
  db.prepare("INSERT INTO runs (at,project,kind,ticket,ok) VALUES (?,?,?,?,1)").run(ago(0.9), "shopfront", "check", 205)
  db.prepare("INSERT INTO runs (at,project,kind,ticket,ok) VALUES (?,?,?,?,1)").run(ago(1.4), "tally", "lead", null)
}
const limits = { five: { used: 31, resetsAt: NOW + 3 * 3_600_000 }, week, ratio: 0.1, state: "running", resumesAt: null, line: "Running · 5-hour 31% (cap 60%) · week 58% of 95%" }
const DIFF = [
  "diff --git a/api/orders.ts b/api/orders.ts", "--- a/api/orders.ts", "+++ b/api/orders.ts", "@@ -35,3 +35,10 @@ import { audit } from './audit'",
  " const MAX = 500", " ", " export const orders = router()",
  "+export async function bulkDelete(ids: string[]) {", "+  if (ids.length > 500) throw new TooMany(ids.length)", "+  const rows = await db.orders.where('id', 'in', ids)", "+  await audit.log('bulk-delete', ids.length)",
  "+  await db.orders.delete().where('id', 'in', ids)", "+  return { deleted: rows.length }", "+}",
  "diff --git a/orders/BulkBar.tsx b/orders/BulkBar.tsx", "--- a/orders/BulkBar.tsx", "+++ b/orders/BulkBar.tsx", "@@ -18,4 +18,8 @@ export function BulkBar({ selected }: Props) {",
  " const count = selected.length", " ", "-  return null", "+  return (", "+    <div role=\"toolbar\" aria-label=\"Bulk actions\">", "+      <span>{count} selected</span>", "+      <button onClick={() => bulkDelete(selected)}>Delete {count}</button>", "+    </div>", "+  )",
  "diff --git a/orders/List.tsx b/orders/List.tsx", "--- a/orders/List.tsx", "+++ b/orders/List.tsx", "@@ -7,3 +7,4 @@ export function List({ rows }: Props) {",
  " const [sel, setSel] = useState<string[]>([])", " ", "+  const selectedIds = sel", " return <Table rows={rows} />",
  "diff --git a/tests/orders.test.ts b/tests/orders.test.ts", "--- a/tests/orders.test.ts", "+++ b/tests/orders.test.ts", "@@ -1,2 +1,4 @@", " import { test } from 'node:test'", "+test('bulk delete counts rows', () => {", "+  assert.equal(1, 1)", "+})",
].join("\n") + "\n"
let discord: string[] = []
{ // the morning summary goes through the Chief of Staff's own send path, with a stand-in for Discord
  const cos = await import("../src/graphs/cos.ts")
  const projects = { tally: { name: "tally", paused: false }, shopfront: { name: "shopfront", paused: false } } as never
  const facts = cos.gather(db, projects, { fiveUsed: 31, weekUsed: 58, weekMsToReset: 2.7 * DAY }, NOW)
  db.prepare("INSERT INTO kv VALUES ('discord:wh:daily-update', 'x')").run()
  await cos.sendBrief(db, { facts, now: NOW, dir: tmp }, async () => true)
  const { buildBrief, richSections } = await import("../src/brief.ts")
  discord = richSections(buildBrief(db, facts, NOW))
}
// ---- Settings, Team and First run: made-up config, roles, runs, checks and providers (tally and shopfront only) ----
const C = await import("../src/config-edit.ts")
const shotsConfig = JSON.stringify({ pacing: { weekCap: 90 }, quietHours: { start: 22, end: 7 }, scout: { hour: 22 }, github: { owner: "acme-dev", accounts: ["acme"] } }, null, 2) + "\n"
writeFileSync(process.env.DOBBY_CONFIG!, shotsConfig)
const roles = `${tmp}/roles`
mkdirSync(roles)
for (const r of ["lead", "builder", "reviewer", "checker", "product-manager", "scout"]) copyFileSync(new URL(`../roles/${r}.md`, import.meta.url).pathname, `${roles}/${r}.md`)
{ const T = await import("../src/dashboard-team.ts"); T.saveRole("reviewer", readFileSync(`${roles}/reviewer.md`, "utf8") + "- Say what you could not check.\n", roles) } // one role the owner has edited, so Team shows "edited"
// what the dashboard's child `dobby config set|unset` does, on the temp file
const shotsExec = async (args: string[]) => {
  if (cur.mode === "bugfix" && args[0] === "merge") await new Promise((r) => setTimeout(r, 120_000)) // the merge keeps running: the strip shows it with no Undo
  if (cur.mode === "bugfix" && args[0] === "retry") return { ok: false, out: "#409 needs the owner, not an agent: Login loop on Safari" } // a refusal, as `dobby retry` now prints it with exit 1
  try {
    if (args[0] === "config") return { ok: true, out: args[1] === "unset" ? C.configSetText({ key: args[2], unset: true }) : C.configSetText({ key: args[2], value: args.slice(3).join(" ") }) }
    if (args[0] === "role") { const T = await import("../src/dashboard-team.ts"); return { ok: true, out: args[1] === "reset" ? T.resetRole(args[2], roles) : T.saveRole(args[2], args[3], roles) } }
  } catch (e) { return { ok: false, out: (e as Error).message } }
  return { ok: true, out: "done" }
}
const projectsNow = { tally: { repo: "~/projects/tally", base: "main", paused: false }, shopfront: { repo: "~/projects/shopfront", base: "main", paused: false } }
const settingsOpts = {
  rolesDir: roles, projects: () => projectsNow,
  checks: async () => [
    { name: "Node", ok: true, detail: "24.1.0", required: true }, { name: "git", ok: true, detail: "2.50.1", required: true }, { name: "GitHub CLI", ok: true, detail: "2.79.0", required: true },
    { name: "GitHub sign-in", ok: true, detail: "signed in as acme-dev", required: true }, { name: "Claude Code", ok: true, detail: "2.1.4", required: true }, { name: "Claude sign-in", ok: true, detail: "signed in", required: true },
    { name: "config", ok: true, detail: "~/.config/dobby/config.json", required: true }, { name: "graphify", ok: false, detail: "not installed (optional: code maps for builders and reviews)", fix: "uv tool install graphifyy", required: false },
    { name: "Discord", ok: false, detail: "off (optional: buttons for approve and decline)", fix: "add DISCORD_BOT_TOKEN to the secrets file, then dobby discord setup", required: false },
    { name: "background jobs", ok: false, detail: "not loaded: health, graphify", fix: "dobby jobs install", required: true },
  ],
  providers: async () => ({ at: NOW, routing: false, hidden: 24, rows: [
    { id: "claude-code", label: "Claude Code", kind: "code tool" as const, detected: true, key: "signed in" as const, enabled: null },
    { id: "codex-cli", label: "OpenAI Codex CLI", kind: "code tool" as const, detected: false, key: "not set" as const, enabled: null },
    { id: "gemini-cli", label: "Gemini CLI", kind: "code tool" as const, detected: false, key: "not set" as const, enabled: null },
    { id: "ollama", label: "Ollama (local)", kind: "local" as const, detected: true, key: "none needed" as const, enabled: null },
  ] }),
}
// what each role and project spent this week (usd; 26 usd = 1% of the week): builder 35%, reviewer 11%, checker 8%, lead 2%, product manager 2%; tally 38%, shopfront 19%
for (const [project, kind, usd] of [["tally", "build", 600], ["shopfront", "build", 310], ["tally", "review", 190], ["shopfront", "review", 96], ["tally", "check", 130], ["shopfront", "check", 78], ["tally", "lead", 30], ["shopfront", "lead", 22], ["tally", "pm", 52]] as const)
  db.prepare("INSERT INTO runs (at,project,kind,ok,cost_usd) VALUES (?,?,?,1,?)").run(ago(30), project, kind, usd)
const cur = { limits: undefined as unknown, mode: "" } // the usage-unknown shot swaps the reading
const server = createDashboard(db, { token: "shots-token", diffText: (_p, branch) => (branch === "dobby/198-bulk-delete" ? { text: DIFF, clipped: 0 } : null), exec: shotsExec, ...settingsOpts, diff: () => ({ add: 318, del: 41, files: 9 }), limits: () => (cur.limits ?? limits) as never, dist: new URL("../dashboard/dist", import.meta.url).pathname, pollMs: 500 })
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
// First run is for a Dobby with no project yet: the same database, a server that knows no projects
const fresh = createDashboard(db, { token: "shots-token", exec: shotsExec, ...settingsOpts, projects: () => ({}), limits: () => limits, dist: new URL("../dashboard/dist", import.meta.url).pathname, pollMs: 500 })
await new Promise<void>((ok) => fresh.listen(0, "127.0.0.1", ok))
const freshBase = `http://127.0.0.1:${(fresh.address() as { port: number }).port}`

const browser = await chromium.launch({ channel: process.env.SHOTS_CHANNEL ?? undefined, env: { ...process.env, HOME: realHome } as Record<string, string> })
const open_ = async (scheme: "dark" | "light", size: { width: number; height: number }, path = "/", ready: "option" | "heading" = "option") => {
  const ctx = await browser.newContext({ viewport: size, colorScheme: scheme, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  page.on("pageerror", (e) => console.log("pageerror", e.message)); page.on("console", (m) => m.type() === "error" && console.log("console", m.text()))
  await page.addInitScript(() => { try { localStorage.setItem("dobby:last-visit", String(Date.now() - 12 * 3_600_000)) } catch {} }) // a full load must not reset "since you last looked"
  await page.goto(`${base}/auth?token=shots-token`) // the sign-in cookie, as `dobby dashboard open` sets it
  if (path !== "/" && size.width < 768) await page.goto(`${base}${path}`) // the bottom bar has five tabs; Activity, Team and Settings sit behind More
  else if (path !== "/") await page.getByRole("navigation", { name: "Views" }).getByRole("link", { name: path.slice(1), exact: false }).first().click() // by the nav link, not a fresh load
  await (ready === "option" ? page.getByRole("option").first() : page.getByRole("heading", { level: 1 }).first()).waitFor()
  await page.evaluate(() => document.fonts.ready)
  return { ctx, page }
}
if (want("home")) for (const [scheme, size, name] of [["dark", { width: 1440, height: 900 }, "desktop"], ["light", { width: 1440, height: 900 }, "desktop"], ["dark", { width: 390, height: 844 }, "phone"], ["light", { width: 390, height: 844 }, "phone"]] as const) {
  const { ctx, page } = await open_(scheme, size)
  await page.screenshot({ path: `${out}/home-${scheme}-${name}.png` })
  await ctx.close()
}
for (const [page_, label] of [["/queue", "queue"], ["/goals", "goals"]] as const) {
  if (!want(label)) continue
  for (const [scheme, size, name] of [["dark", { width: 1440, height: 900 }, "desktop"], ["light", { width: 1440, height: 900 }, "desktop"], ["dark", { width: 390, height: 844 }, "phone"], ["light", { width: 390, height: 844 }, "phone"]] as const) {
    const { ctx, page } = await open_(scheme, size, page_)
    await page.waitForTimeout(400) // the digits and stripes settle
    await page.screenshot({ path: `${out}/${label}-${scheme}-${name}.png` })
    await ctx.close()
  }
}
if (want("extras")) {
{ // a drag in progress: the third ticket is held by its handle and moved down past two others; the stop line has not moved yet
  const { ctx, page } = await open_("dark", { width: 1440, height: 900 }, "/queue")
  for (let i = 0; i < 4; i++) await page.keyboard.press("j") // past the three building ones, onto the first ready ticket
  const row = page.locator('[role=option][aria-selected=true]')
  await row.hover()
  const handle = row.getByRole("button", { name: /^Drag/ })
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
  await page.mouse.move(box.x + 4, box.y + 40, { steps: 6 }); await page.mouse.move(box.x + 4, box.y + 95, { steps: 8 })
  await page.waitForTimeout(250)
  await page.screenshot({ path: `${out}/queue-drag-dark-desktop.png` })
  await page.mouse.up(); await ctx.close()
}
{ // a keyboard move: the selected ticket goes down one place with Shift+J and stays highlighted
  const { ctx, page } = await open_("dark", { width: 1440, height: 900 }, "/queue")
  for (let i = 0; i < 4; i++) await page.keyboard.press("j") // past the three building ones, onto the first ready ticket
  const ref = await page.locator('[role=option][aria-selected=true]').getAttribute("data-row")
  await page.keyboard.press("Shift+J")
  await page.waitForFunction((r) => document.querySelector(`[data-row="${r}"]`)?.getAttribute("aria-selected") === "true", ref)
  console.log("keyboard move ok")
  await ctx.close()
}
{ // the Ideas tab
  const { ctx, page } = await open_("dark", { width: 1440, height: 900 }, "/queue")
  await page.getByRole("tab", { name: /^Ideas/ }).click()
  await page.getByRole("option").first().waitFor()
  await page.screenshot({ path: `${out}/queue-ideas-dark-desktop.png` })
  await ctx.close()
}
{ // the undo strip: Enter on the selected row merges it, held for 8 s
  const { ctx, page } = await open_("dark", { width: 1440, height: 900 })
  await page.getByRole("button", { name: /^Merge/ }).click()
  await page.getByRole("status").first().waitFor()
  await page.waitForTimeout(1500) // the rule is part way down
  await page.screenshot({ path: `${out}/home-undo-dark-desktop.png` })
  await ctx.close()
}
{ // the ? overlay
  const { ctx, page } = await open_("dark", { width: 1440, height: 900 })
  await page.keyboard.press("?")
  await page.getByRole("dialog").waitFor()
  await page.screenshot({ path: `${out}/home-keys-dark-desktop.png` })
  await ctx.close()
}
{ // keys, no mouse: j moves the selection, g then o goes to Goals (and does not open the row), x holds a decline, u undoes it
  const { ctx, page } = await open_("dark", { width: 1440, height: 900 })
  const sel = () => page.locator('[role=option][aria-selected=true]').getAttribute("data-row")
  const first = await sel()
  await page.keyboard.press("j"); const second = await sel()
  if (!first || !second || first === second) throw new Error(`j did not move: ${first} -> ${second}`)
  await page.keyboard.press("x"); await page.getByRole("status").first().waitFor() // this page is its own context: the decline's strip is the only one
  await page.keyboard.press("u"); await page.waitForFunction(() => document.querySelectorAll("[role=status]").length === 0)
  await page.keyboard.press("g"); await page.keyboard.press("o")
  await page.waitForURL("**/goals")
  console.log("keys ok")
  await ctx.close()
}
}
if (want("bugfix")) for (const [name, size] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) { // a merge that has started (no Undo), then a refused retry
  cur.mode = "bugfix"
  const { ctx, page } = await open_("dark", size)
  await page.getByRole("button", { name: /^Merge/ }).first().click()
  await page.getByText(/^Merging/).waitFor()
  await page.getByRole("button", { name: /^Undo/ }).waitFor({ state: "detached", timeout: 15_000 }) // the 8 s hold has run out
  await page.screenshot({ path: `${out}/home-running-dark-${name}.png` })
  await page.getByText("Bulk delete").first().click()
  await page.getByRole("button", { name: /^Retry/ }).first().click()
  await page.getByText(/did not run/).waitFor({ timeout: 15_000 })
  await page.screenshot({ path: `${out}/home-refused-dark-${name}.png` })
  await ctx.close(); cur.mode = ""
}
if (want("queue")) { // each page's own footer hints (the viewport shots end above the footer)
  const { ctx, page } = await open_("dark", { width: 1440, height: 900 }, "/queue")
  await page.locator("footer").scrollIntoViewIfNeeded()
  await page.locator("footer").screenshot({ path: `${out}/queue-footer-dark-desktop.png` })
  await ctx.close()
}
const PHONE = { width: 390, height: 844 }, DESK = { width: 1440, height: 900 }
for (const [scheme, size, name] of [["dark", DESK, "desktop"], ["light", DESK, "desktop"], ["dark", PHONE, "phone"], ["light", PHONE, "phone"]] as const) {
  if (want("reviews")) {
    const { ctx, page } = await open_(scheme, size, "/reviews")
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${out}/reviews-${scheme}-${name}.png` })
    await ctx.close()
  }
  if (want("pr")) {
    const ctx = await browser.newContext({ viewport: size, colorScheme: scheme, deviceScaleFactor: 2 })
    const page = await ctx.newPage()
    page.on("pageerror", (e) => console.log("pageerror", e.message)); page.on("console", (m) => m.type() === "error" && console.log("console", m.text()))
    await page.goto(`${base}/auth?token=shots-token`)
    await page.goto(`${base}/pr/198`)
    await page.locator("[data-finding]").first().waitFor()
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${out}/pr-${scheme}-${name}.png` })
    if (want("pr") && scheme === "dark" && name === "desktop") { // R opens the rule with its text before saving; D holds a dismissal 8 s
      await page.keyboard.press("r"); await page.getByRole("dialog").waitFor()
      await page.screenshot({ path: `${out}/pr-rule-dark-desktop.png` })
      await page.keyboard.press("Escape")
      await page.keyboard.press("d"); await page.getByRole("status").first().waitFor(); await page.waitForTimeout(1200)
      await page.screenshot({ path: `${out}/pr-dismiss-dark-desktop.png` })
    }
    await ctx.close()
  }
}
for (const [scheme, size, name] of [["dark", DESK, "desktop"], ["light", DESK, "desktop"], ["dark", PHONE, "phone"], ["light", PHONE, "phone"]] as const) {
  for (const label of ["spend", "activity"] as const) {
    if (!want(label)) continue
    const { ctx, page } = await open_(scheme, size, `/${label}`, "heading")
    if (label === "activity") await page.getByRole("option").first().waitFor()
    await page.waitForTimeout(500)
    await page.screenshot({ path: `${out}/${label}-${scheme}-${name}.png` })
    await ctx.close()
  }
}
if (want("spend")) { // the other tabs, and the 5-hour window on W/F
  const { ctx, page } = await open_("dark", DESK, "/spend", "heading")
  await page.getByRole("tab", { name: "By role" }).click(); await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/spend-role-dark-desktop.png` })
  await page.getByRole("tab", { name: "Past weeks" }).click(); await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/spend-past-dark-desktop.png` })
  await page.keyboard.press("f"); await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/spend-five-dark-desktop.png` })
  await ctx.close()
}
if (want("activity")) { // the same sections as a Discord Components V2 message: container with an accent bar, a text per section, dividers, a link button (an HTML mock in Discord's dark theme)
  const md = (t: string) => t.split("\n").map((l) => {
    const x = l.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>').replace(/\\([*_[\]<>`])/g, "$1")
    return l.startsWith("## ") ? `<h2>${x.slice(3)}</h2>` : l.startsWith("### ") ? `<h3>${x.slice(4)}</h3>` : l.startsWith("-# ") ? `<small>${x.slice(3)}</small>` : l.startsWith("- ") ? `<li>${x.slice(2)}</li>` : `<p>${x}</p>`
  }).join("")
  const html = `<style>body{margin:0;background:#313338;color:#dbdee1;font:16px/1.375 "gg sans",system-ui,sans-serif;padding:24px}.name{font-weight:600;color:#fff}.tag{background:#5865f2;color:#fff;font-size:10px;border-radius:3px;padding:1px 4px;margin-left:6px}.box{margin:6px 0 0 52px;max-width:520px;background:#2b2d31;border-left:4px solid #3ddc84;border-radius:8px;padding:12px 16px}h2{margin:0 0 4px;font-size:20px;color:#fff}h3{margin:0 0 4px;font-size:16px;color:#fff}p{margin:2px 0}li{margin:2px 0 2px 18px}a{color:#00a8fc;text-decoration:none}small{color:#949ba4;font-size:12px}hr{border:0;border-top:1px solid #3f4147;margin:10px 0}.btn{display:inline-block;margin-top:10px;background:#4e5058;color:#fff;border-radius:3px;padding:6px 14px;font-size:14px}.av{float:left;width:40px;height:40px;border-radius:50%;background:#3ddc84}</style><div class="av"></div><div style="margin-left:52px"><span class="name">Chief of Staff</span><span class="tag">APP</span> <small>Today at 08:05</small></div><div class="box">${discord.map(md).join("<hr>")}<div class="btn">Open dashboard</div></div>`
  const ctx = await browser.newContext({ viewport: { width: 640, height: 10 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  await page.setContent(html)
  await page.screenshot({ path: `${out}/discord-message.png`, fullPage: true })
  await ctx.close()
}
if (want("activity")) { // a filter on the 4 key, and the page keys: j moves, 3 filters to reviews
  const { ctx, page } = await open_("dark", DESK, "/activity", "heading")
  await page.getByRole("option").first().waitFor()
  await page.keyboard.press("4"); await page.waitForTimeout(500)
  await page.screenshot({ path: `${out}/activity-problems-dark-desktop.png` })
  await page.keyboard.press("3"); await page.waitForTimeout(400)
  if (!(await page.getByRole("button", { name: /^Reviews/ }).getAttribute("aria-pressed") === "true")) throw new Error("3 did not filter to reviews")
  console.log("activity keys ok")
  await ctx.close()
}
// Settings, Team and First run: dark/light x desktop/phone
for (const [scheme, size, name] of [["dark", DESK, "desktop"], ["light", DESK, "desktop"], ["dark", PHONE, "phone"], ["light", PHONE, "phone"]] as const) {
  const at = async (b: string, path: string, ready: (p: import("@playwright/test").Page) => Promise<unknown>) => {
    const ctx = await browser.newContext({ viewport: size, colorScheme: scheme, deviceScaleFactor: 2 })
    const page = await ctx.newPage()
    page.on("pageerror", (e) => console.log("pageerror", e.message)); page.on("console", (m) => m.type() === "error" && console.log("console", m.text()))
    await page.goto(`${b}/auth?token=shots-token`)
    await page.goto(`${b}${path}`)
    await ready(page)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(500)
    return { ctx, page }
  }
  if (want("settings")) {
    const { ctx, page } = await at(base, "/settings", (p) => p.getByRole("slider", { name: "Stop at" }).waitFor())
    await page.screenshot({ path: `${out}/settings-${scheme}-${name}.png` })
    { // Crash reports and usage stats: both switches are off until the owner turns them on; "Show what's sent" prints the next payload
      await page.getByRole("button", { name: "Crash reports and usage stats" }).click()
      for (const sw of ["Crash reports", "Usage stats"]) if ((await page.getByRole("switch", { name: sw }).getAttribute("aria-checked")) !== "false") throw new Error(`${sw} is not off by default`)
      await page.getByRole("button", { name: "Show what's sent" }).click(); await page.getByLabel("What is sent").waitFor()
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${out}/settings-stats-${scheme}-${name}.png` })
      await page.getByRole("button", { name: "Plan and pacing" }).click()
    }
    if (scheme === "dark" && name === "desktop") {
      await page.getByRole("button", { name: "Health" }).click(); await page.getByRole("list", { name: "Health checks" }).waitFor()
      await page.screenshot({ path: `${out}/settings-health-dark-desktop.png` })
      await page.getByRole("button", { name: "Safety" }).click(); await page.getByRole("list", { name: "Rules by category" }).waitFor()
      await page.screenshot({ path: `${out}/settings-safety-dark-desktop.png` })
    }
    await ctx.close()
  }
  if (want("settings") && scheme === "dark" && name === "desktop") { // a change: the slider moves with ArrowLeft, saves to the file, and the preview shows it
    const { ctx, page } = await at(base, "/settings", (p) => p.getByRole("slider", { name: "Stop at" }).waitFor())
    const slider = page.getByRole("slider", { name: "Stop at" })
    await slider.focus(); for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft")
    await page.waitForFunction(() => document.querySelector('[role=slider]')?.getAttribute("aria-valuenow") === "85")
    await page.getByRole("button", { name: /^Undo/ }).waitFor({ state: "visible" }); await page.waitForFunction(() => !(document.querySelector("aside button:nth-of-type(2)") as HTMLButtonElement | null)?.disabled)
    await page.waitForTimeout(900)
    await page.screenshot({ path: `${out}/settings-changed-dark-desktop.png` })
    await ctx.close()
    writeFileSync(process.env.DOBBY_CONFIG!, shotsConfig) // the later shots start from the same file
  }
  if (want("team")) {
    const { ctx, page } = await at(base, "/team", (p) => p.getByRole("option").first().waitFor())
    await page.screenshot({ path: `${out}/team-${scheme}-${name}.png` })
    if (scheme === "dark" && name === "desktop") {
      await page.getByRole("option", { name: /Code Reviewer|Reviewer/ }).first().click()
      await page.keyboard.press("e"); await page.getByRole("dialog").waitFor(); await page.getByRole("textbox").waitFor()
      await page.waitForFunction(() => (document.querySelector("textarea") as HTMLTextAreaElement | null)?.value.length)
      await page.screenshot({ path: `${out}/team-edit-dark-desktop.png` })
    }
    await ctx.close()
  }
  if (want("welcome")) {
    const { ctx, page } = await at(freshBase, "/welcome", (p) => p.getByRole("option").first().waitFor())
    await page.screenshot({ path: `${out}/welcome-${scheme}-${name}.png` })
    await ctx.close()
  }
}

// ---- PR 7: a phone at 360, the five states on desktop, the ⌘K palette (desktop and phone) ----
if (want("phone")) {
  for (const [path, label] of [["/", "home"], ["/queue", "queue"]] as const) {
    const { ctx, page } = await open_("dark", { width: 360, height: 780 }, path)
    await page.waitForTimeout(400)
    if (await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)) throw new Error(`${label} scrolls sideways at 360`)
    await page.screenshot({ path: `${out}/${label}-dark-phone360.png` })
    await ctx.close()
  }
  { // 400% zoom of a 1280 px window is a 320 px wide layout viewport: nothing may scroll sideways
    const { ctx, page } = await open_("dark", { width: 320, height: 420 }, "/")
    console.log("320 wide (400% zoom) sideways scroll:", await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth))
    await ctx.close()
  }
  { // a swipe in progress on the first row (touch-sized drag with the mouse), then the More sheet
    const { ctx, page } = await open_("dark", PHONE, "/")
    const row = page.getByRole("option").first(); const box = (await row.boundingBox())!
    await page.mouse.move(box.x + 60, box.y + 30); await page.mouse.down(); await page.mouse.move(box.x + 120, box.y + 32, { steps: 6 }); await page.mouse.move(box.x + 170, box.y + 32, { steps: 6 }); await page.waitForTimeout(200)
    await page.screenshot({ path: `${out}/home-swipe-dark-phone.png` })
    await page.mouse.move(box.x + 60, box.y + 30, { steps: 4 }); await page.mouse.up()
    await page.getByRole("button", { name: /^More/ }).click(); await page.getByRole("dialog").waitFor(); await page.waitForTimeout(400)
    await page.screenshot({ path: `${out}/more-dark-phone.png` })
    await ctx.close()
  }
  { // the swipe does the action: past the threshold a merge is held, with its Undo
    const { ctx, page } = await open_("dark", PHONE, "/")
    const row = page.getByRole("option").first(); const box = (await row.boundingBox())!
    await page.mouse.move(box.x + 40, box.y + 30); await page.mouse.down(); await page.mouse.move(box.x + 100, box.y + 32, { steps: 6 }); await page.mouse.move(box.x + 220, box.y + 32, { steps: 8 }); await page.mouse.up()
    await page.getByRole("status").first().waitFor(); console.log("swipe right held:", await page.getByRole("status").first().innerText())
    await ctx.close()
  }
  { // reduced motion: no drag
    const ctx = await browser.newContext({ viewport: PHONE, colorScheme: "dark", reducedMotion: "reduce" })
    const page = await ctx.newPage(); await page.goto(`${base}/auth?token=shots-token`); await page.getByRole("option").first().waitFor()
    console.log("swipe wrappers with reduced motion:", await page.locator("[data-swipe]").count())
    await ctx.close()
  }
}
if (want("states")) {
  const P = await import("../src/pause.ts")
  const shot = async (name: string, prep?: (p: import("@playwright/test").Page, c: import("@playwright/test").BrowserContext) => Promise<unknown>) => {
    const { ctx, page } = await open_("dark", DESK, "/")
    if (prep) await prep(page, ctx)
    await page.waitForTimeout(600)
    await page.screenshot({ path: `${out}/state-${name}-dark-desktop.png` })
    return { ctx, page }
  }
  { // paused: the instrument greys, reads Paused, one Resume button
    P.setPause(db, { all: true }, true, "owner", { now: NOW })
    const { ctx, page } = await shot("paused", (p) => p.locator('[data-state="paused"]').waitFor())
    await ctx.close(); P.setPause(db, { all: true }, false, "owner", { now: NOW })
  }
  { // usage unknown / provider down
    cur.limits = { state: "unknown", line: "Plan usage unknown (no reading for 42 min)" }
    const { ctx } = await shot("usage-unknown", (p) => p.locator('[data-state="usage"]').waitFor())
    await ctx.close(); cur.limits = undefined
  }
  { // stuck: a ticket running with no change for over two hours
    add(221, "running", "Order export", "shopfront", 3.4)
    const { ctx } = await shot("stuck", (p) => p.getByRole("link", { name: "See last step" }).waitFor())
    await ctx.close(); db.prepare("DELETE FROM tickets WHERE id=221").run()
  }
  { // offline: the stream drops, the page keeps the last data and polls
    const { ctx } = await shot("offline", async (p) => { await p.waitForTimeout(800); await p.route("**/api/events", (r) => r.abort()); server.closeAllConnections(); await p.locator('[data-state="offline"]').waitFor() })
    await ctx.close()
  }
  { // expired: the session check says this browser can no longer act
    const { ctx } = await shot("expired", async (p) => { await p.route("**/api/session", (r) => r.fulfill({ json: { canAct: false } })); await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange", { bubbles: true }))); await p.locator('[data-state="expired"]').waitFor() })
    await ctx.close()
  }
  { // the same on a phone: paused
    P.setPause(db, { all: true }, true, "owner", { now: NOW })
    const { ctx, page } = await open_("dark", PHONE, "/"); await page.locator('[data-state="paused"]').waitFor(); await page.waitForTimeout(500)
    await page.screenshot({ path: `${out}/state-paused-dark-phone.png` }); await ctx.close(); P.setPause(db, { all: true }, false, "owner", { now: NOW })
  }
}
if (want("palette")) {
  { // desktop: ⌘K, typed "me", "merge 412" finds Merge tally #412; Enter posts it for that ticket (held 8 s)
    const { ctx, page } = await open_("dark", DESK, "/")
    await page.keyboard.press("ControlOrMeta+k"); await page.getByRole("dialog").waitFor(); await page.getByRole("option").first().waitFor(); await page.waitForTimeout(300)
    await page.screenshot({ path: `${out}/palette-dark-desktop.png` })
    await page.keyboard.type("receipt"); await page.waitForTimeout(250)
    await page.screenshot({ path: `${out}/palette-search-dark-desktop.png` })
    await page.keyboard.press("Escape"); await page.getByRole("dialog").waitFor({ state: "hidden" })
    await page.keyboard.press("ControlOrMeta+k"); await page.keyboard.type("merge 412"); await page.keyboard.press("Enter")
    await page.getByRole("status").first().waitFor(); console.log("palette merge held:", await page.getByRole("status").first().innerText())
    await ctx.close()
  }
  { // light desktop
    const { ctx, page } = await open_("light", DESK, "/")
    await page.keyboard.press("ControlOrMeta+k"); await page.getByRole("option").first().waitFor(); await page.waitForTimeout(300)
    await page.screenshot({ path: `${out}/palette-light-desktop.png` }); await ctx.close()
  }
  { // phone: a full sheet from the header button
    const { ctx, page } = await open_("dark", PHONE, "/")
    await page.getByRole("button", { name: "Search or run" }).click(); await page.getByRole("option").first().waitFor(); await page.waitForTimeout(500)
    await page.screenshot({ path: `${out}/palette-dark-phone.png` }); await ctx.close()
  }
}
await browser.close()
server.closeAllConnections(); server.close(); fresh.closeAllConnections(); fresh.close()
console.log(`shots in ${out}`)

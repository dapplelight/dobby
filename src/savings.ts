// Token savings: small pure helpers behind config keys (ticketBudget, retryLimit, builderContextCeiling, shipPreflight, sameFailure,
// harnessInstall, freshRetries, recoverOutput). Every key is off when absent, so Dobby behaves as before until the owner's config turns it on.
import { classifyRemote } from "./detect.ts"
import { existsSync, closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { config } from "./config.ts"
import type { DB } from "./db.ts"
import { toCall } from "./usage.ts"
import { loginShell } from "./shell.ts"
import { samlUrl } from "./repo-rights.ts"

/** A run ended at the context ceiling has this reason; it does not count as a build. */
export const CEILING = "context ceiling"
const kvGet = (db: DB, k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v

// ---- 1. ticket budget ------------------------------------------------------------------------------------------------------------
export const usdPerPoint = () => config().ticketBudget?.usdPerWeekPoint ?? 26 // measured: ~$26 per 1% of the week
/** Dollars spent on a ticket since the owner last queued it by hand (kv cost-base holds the earlier total). */
export function ticketUsd(db: DB, id: number): number {
  const sum = (db.prepare("SELECT COALESCE(SUM(cost_usd),0) s FROM runs WHERE ticket=?").get(id) as { s: number }).s
  return Math.max(0, sum - Number(kvGet(db, `cost-base:${id}`) ?? 0))
}
export const weekPoints = (usd: number) => usd / usdPerPoint()

// ---- 1b. cost per PR -------------------------------------------------------------------------------------------------------------
export const PR_RE = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/
const STAGE_OF: Record<string, string> = { pm: "Planning", brainstorm: "Planning", explain: "Planning", design: "Planning", build: "Build", check: "Tester", test: "Tester", smoke: "Tester" }
export type PrCost = { stages: { name: string; usd: number; runs: number; rounds?: number }[]; usd: number; weekPct: number }
/** What a ticket's PR cost: its runs, its fix tickets' runs (onto = its branch) and its reviews' heads. `url` overrides the PR link in the note (read-only SQL). */
export function prCost(db: DB, id: number, url?: string): PrCost {
  const t = db.prepare("SELECT branch, note FROM tickets WHERE id=?").get(id) as { branch: string | null; note: string | null } | undefined
  const ids = [id, ...(t?.branch ? (db.prepare("SELECT id FROM tickets WHERE onto=?").all(t.branch) as { id: number }[]).map((r) => r.id) : [])]
  const by = new Map<string, { usd: number; runs: number; rounds?: number }>(["Planning", "Build", "Tester", "Review"].map((n) => [n, { usd: 0, runs: 0 }]))
  for (const r of db.prepare(`SELECT kind, COALESCE(cost_usd,0) c FROM runs WHERE ticket IN (${ids.map(() => "?").join(",")})`).all(...ids) as { kind: string; c: number }[]) {
    const n = STAGE_OF[r.kind] ?? "Other", g = by.get(n) ?? by.set(n, { usd: 0, runs: 0 }).get(n)!
    g.usd += r.c; g.runs++
  }
  by.get("Build")!.rounds = by.get("Build")!.runs
  const m = (url ?? t?.note ?? "").match(PR_RE)
  const rv = by.get("Review")!
  if (m) for (const r of db.prepare("SELECT repo, COALESCE(cost,0) c FROM reviews WHERE pr=?").all(Number(m[2])) as { repo: string; c: number }[]) if (r.repo === m[1] || r.repo.split("/")[1] === m[1].split("/")[1]) rv.usd += r.c, rv.runs++
  rv.rounds = rv.runs
  const stages = [...by].filter(([n, g]) => n !== "Other" || g.usd || g.runs).map(([name, g]) => ({ name, ...g }))
  const usd = stages.reduce((a, g) => a + g.usd, 0)
  return { stages, usd, weekPct: weekPoints(usd) }
}
/** The PR comment (marker first, so a later run finds and updates it). Plan mode: % of the week; API-key mode: dollars. */
export const COST_MARK = "<!-- dobby-cost -->"
export function prCostText(c: PrCost, apiKey: boolean): string {
  const f = (usd: number) => apiKey ? (usd > 0 && usd < 0.005 ? "<$0.01" : `$${usd.toFixed(2)}`) : usd > 0 && weekPoints(usd) < 0.005 ? "<0.01%" : `${weekPoints(usd).toFixed(2)}%`
  const runs = (g: PrCost["stages"][number]) => g.name === "Build" ? (g.rounds! > 1 ? `${g.runs} (${g.rounds! - 1} fix round${g.rounds! > 2 ? "s" : ""})` : `${g.runs}`) : g.name === "Review" ? `${g.runs} head${g.runs === 1 ? "" : "s"}` : `${g.runs}`
  return [COST_MARK, `**Cost of this PR:** ${f(c.usd)}${apiKey ? "" : " of your week"}`, "| Stage | Cost | Runs |", "|---|---|---|", ...c.stages.map((g) => `| ${g.name} | ${f(g.usd)} | ${runs(g)} |`)].join("\n")
}
/** The cap in week points for this size, or undefined when the budget is off. */
export const budgetCap = (size: string) => config().ticketBudget?.[size as "S" | "M" | "L"]
/** "" when the ticket may go on, else the owner-facing reason. */
export function overBudget(db: DB, t: { id: number; size: string }): string {
  const cap = budgetCap(t.size)
  if (cap === undefined) return ""
  const pts = weekPoints(ticketUsd(db, t.id))
  return pts >= cap ? `over its budget: it has used ${pts.toFixed(2)}% of the week and a size ${t.size} ticket is capped at ${cap}%. Stopped so it does not keep spending; the work so far is on its branch` : ""
}
/** The costliest recent open tickets, for the status board. */
export function costliest(db: DB, n = 3, now = Date.now()) {
  const rows = db.prepare(`SELECT t.id, t.title, t.size, COALESCE(SUM(r.cost_usd),0) AS usd FROM tickets t JOIN runs r ON r.ticket=t.id
    WHERE t.status IN ('running','ready','fixing','failed') AND t.updated_at>=? GROUP BY t.id ORDER BY usd DESC LIMIT 20`).all(new Date(now - 7 * 86_400_000).toISOString()) as { id: number; title: string; size: string; usd: number }[]
  return rows.map((r) => ({ ...r, usd: ticketUsd(db, r.id) })).sort((a, b) => b.usd - a.usd).slice(0, n).filter((r) => r.usd > 0)
}

// ---- 2. retry limit --------------------------------------------------------------------------------------------------------------
// (the retry limit itself lives in lib.ts buildsUsed; an "outside failure" pattern list was removed: it matched ordinary test output and Checker reasons)

// ---- 3. context ceiling ----------------------------------------------------------------------------------------------------------
/** Where Claude Code keeps the session transcripts of a run started in `cwd`. */
export function transcriptDir(cwd: string) {
  let real = cwd
  try { real = realpathSync(cwd) } catch {}
  return `${homedir()}/.claude/projects/${real.replace(/[/.]/g, "-")}`
}
/** Newest transcript in dir written at or after `since` (ms), or "". */
function newest(dir: string, since: number): string {
  if (!existsSync(dir)) return ""
  let best = "", at = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue
    const m = statSync(`${dir}/${f}`).mtimeMs
    if (m >= since && m > at) best = `${dir}/${f}`, at = m
  }
  return best
}
function tail(file: string, bytes = 400_000): string[] {
  const size = statSync(file).size
  const fd = openSync(file, "r")
  try {
    const buf = Buffer.alloc(Math.min(size, bytes))
    readSync(fd, buf, 0, buf.length, size - buf.length)
    return buf.toString("utf8").split("\n").slice(size > bytes ? 1 : 0).filter(Boolean)
  } finally { closeSync(fd) }
}
const asJson = (l: string) => { try { return JSON.parse(l) } catch { return null } }
/** Context size now (input + cache tokens of the last model call) of the run that started at `since`; 0 when unknown. Never throws. */
export function contextTokens(dir: string, since: number): number {
  try {
    const f = newest(dir, since)
    if (!f) return 0
    for (const l of tail(f).reverse()) {
      const u = asJson(l)?.message?.usage
      if (u) return (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    }
  } catch {}
  return 0
}
/** Tokens and estimated cost (usage.ts prices) of the run that started at `since`, summed over its transcript once per API message. All zero when unknown. Never throws. */
export function runUsage(dir: string, since: number) {
  const u = { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_write: 0, cost_usd: 0 }
  try {
    const f = newest(dir, since)
    const seen = new Set<string>()
    for (const l of f ? readFileSync(f, "utf8").split("\n") : []) {
      const c = toCall(l, "")
      if (!c || c.at < since || seen.has(c.id)) continue
      seen.add(c.id)
      u.input_tokens += c.input; u.output_tokens += c.output; u.cache_read += c.read; u.cache_write += c.write5m + c.write1h; u.cost_usd += c.usd
    }
  } catch {}
  return u
}
/** The last thing the assistant said in that run's transcript (recovers a result whose JSON output was lost) with the session id. */
export function lastAssistantText(dir: string, since: number): { text: string; session: string } | null {
  try {
    const f = newest(dir, since)
    if (!f) return null
    for (const l of tail(f).reverse()) {
      const j = asJson(l)
      const c = j?.type === "assistant" ? j.message?.content : undefined
      const text = Array.isArray(c) ? c.filter((x: { type: string }) => x.type === "text").map((x: { text: string }) => x.text).join("\n").trim() : ""
      if (text) return { text, session: f.split("/").pop()!.replace(/\.jsonl$/, "") }
    }
  } catch {}
  return null
}


/** "owner/repo" from a GitHub remote URL (ssh or https, or an ssh host alias resolved with ssh -G); null for anything else. */
export function repoSlug(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)
  if (m) return m[1]
  const c = classifyRemote(url) // an alias such as git@github-work:org/repo.git; only reached when the URL is not plainly github.com
  return "slug" in c ? c.slug : null
}

// ---- 4. ship pre-flight ----------------------------------------------------------------------------------------------------------
type Out = { ok: boolean; out: string }
/** What shipping needs, checked before any builder runs. Returns why not, or "". `run` is netRun (argument arrays, timeouts). */
export async function shipPreflight(run: (cmd: string, args: string[], cwd?: string) => Out | Promise<Out>, o: { wt: string; branch: string; verify: string; onto?: string | null }): Promise<string> {
  const r = async (cmd: string, args: string[]) => run(cmd, args, o.wt)
  const first = (x: Out) => x.out.trim().split("\n")[0]?.slice(0, 160) ?? ""
  const auth = await r("gh", ["auth", "status"])
  if (!auth.ok) return `gh is not signed in (${first(auth)}); run gh auth login`
  const remote = await r("git", ["remote", "get-url", "origin"])
  if (!remote.ok) return "the repo has no git remote called origin, so nothing can be pushed"
  const slug = repoSlug(remote.out) // explicit: with an upstream remote gh would check the wrong repo
  const view = await r("gh", ["repo", "view", ...(slug ? [slug] : []), "--json", "nameWithOwner,viewerPermission", "-q", '.nameWithOwner + " " + .viewerPermission'])
  if (!view.ok) return samlUrl(view.out) ? `the organization requires SSO for this token; authorize it at ${samlUrl(view.out)}` : `GitHub does not know this repo or cannot be reached (${first(view)})`
  if (/\b(READ|TRIAGE)\s*$/.test(view.out.trim())) return `no write access to ${view.out.trim().split(" ")[0]}`
  if (!o.onto) {
    const push = await r("git", ["push", "--dry-run", "origin", `HEAD:refs/heads/${o.branch}`])
    if (!push.ok) return `a push of ${o.branch} would be refused (${first(push)})`
  }
  const cmd = o.verify.trim().split(/\s+/).find((w) => !/^\w+=/.test(w))
  if (cmd && cmd !== "true" && /^[\w./$~{}-]+$/.test(cmd)) {
    const v = await r(...loginShell(`command -v -- ${cmd} >/dev/null 2>&1 || test -x ${cmd}`))
    if (!v.ok) return `the verify command cannot run here: ${cmd} was not found in the workspace`
  }
  return ""
}

// ---- 6. same failure -------------------------------------------------------------------------------------------------------------
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9_./-]+/g, " ").split(" ").filter((w) => w.length > 3))
/** Two failure texts describe the same cause when they share most of their distinctive words (wording and numbers differ between builds). */
export function sameCause(a: string, b: string): boolean {
  const x = words(a), y = words(b)
  if (!x.size || !y.size) return false
  let both = 0
  for (const w of x) if (y.has(w)) both++
  return both / Math.min(x.size, y.size) >= 0.7 && both / (x.size + y.size - both) >= 0.5
}

// ---- 7. harness install ----------------------------------------------------------------------------------------------------------
export const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|requirements[\w-]*\.txt|Cargo\.toml|go\.mod|Gemfile|composer\.json|pubspec\.yaml)$/
export const touchesManifest = (files: string[]) => files.some((f) => MANIFEST.test(f))

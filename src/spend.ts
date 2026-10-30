// GET /api/spend: where the week's plan went, from the runs' cost, the stored plan readings and the live limits.
// Pure over a (read-only) DB handle, the clock and the limits it is given; nothing here writes or calls out.
import type { DB } from "./db.ts"

const DAY = 86_400_000, WEEK = 7 * DAY
const q = <T>(db: DB, sql: string, ...a: unknown[]) => { try { return db.prepare(sql).all(...a) as T[] } catch { return [] as T[] } }

/** Run kinds by the team member they belong to. Anything not listed counts under Lead and PM. */
export const BUILDER_KINDS = ["build", "fix"]
export const REVIEW_KINDS = ["review", "review-chat", "review-resolve"]
export const QA_KINDS = ["check", "test", "smoke", "launch-check"]
/** Planning runs belong to no one project: they are one "Planning" row. */
export const PLANNING_KINDS = ["lead", "lead-week", "pm", "area-pm", "brainstorm", "scout", "cos", "program", "onboard", "explain"]
export const roleOf = (kind: string) => BUILDER_KINDS.includes(kind) ? "Builders" : REVIEW_KINDS.includes(kind) ? "Reviewer" : QA_KINDS.includes(kind) ? "Tester" : "Lead and PM"
export const ROLES = ["Builders", "Reviewer", "Tester", "Lead and PM"] as const

export type Limits = { five: { used: number; resetsAt: number | null }; week: { used: number; cap: number; resetsAt: number } } | { state: "unknown" } | null | undefined
export type Billing = { mode?: "plan" | "apiKey"; dailyUsd?: number; weeklyUsd?: number } | undefined
export type SpendRow = { name: string; pct: number; usd: number; merged: number | null; perMerged: number | null; count: number | null; countWord: string }
export type PastWeek = { start: number; landed: number | null; usd: number; series: { t: number; pct: number }[] }

/** Whole-number shares that add up to exactly `total` (largest remainder), in the order given. */
export function shares(parts: number[], total: number): number[] {
  const sum = parts.reduce((a, b) => a + b, 0)
  if (sum <= 0 || total <= 0) return parts.map(() => 0)
  const raw = parts.map((p) => (p / sum) * total), out = raw.map(Math.floor)
  let left = Math.round(total) - out.reduce((a, b) => a + b, 0)
  for (const i of raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]).map((x) => x[1])) { if (left-- <= 0) break; out[i]++ }
  return out
}

/** The stored readings that fall in the week that ended at `resetsAt` (reset times drift by seconds, so match to the nearest week). */
function weekReadings(db: DB, resetsAt: number) {
  const rows = q<{ at: number; week: number; week_reset: number }>(db, "SELECT at, week, week_reset FROM usage_ticks WHERE week_reset BETWEEN ? AND ? ORDER BY at", resetsAt - WEEK / 2, resetsAt + WEEK / 2)
  return rows.map((r) => ({ t: r.at, pct: r.week }))
}
const thin = <T>(xs: T[], max = 40) => { const step = Math.ceil(xs.length / max) || 1; return xs.filter((_, i) => i % step === 0 || i === xs.length - 1) }

export function spendPage(db: DB, now: number, limits: Limits, billing: Billing = undefined) {
  const apiKey = billing?.mode === "apiKey"
  const week = limits && "week" in limits ? limits.week : null
  const five = limits && "five" in limits ? limits.five : null
  const weeklyUsd = billing?.weeklyUsd ?? (billing?.dailyUsd ?? 20) * 7
  // Plan: the window is the plan's week (its reset minus 7 days). API key: there is no reset, so the last 7 days.
  const from = apiKey ? now - WEEK : week ? week.resetsAt - WEEK : null
  const runs = from === null ? [] : q<{ project: string; kind: string; ticket: number | null; cost_usd: number }>(db, "SELECT project, kind, ticket, cost_usd FROM runs WHERE at>=? AND cost_usd>0", new Date(from).toISOString())
  const total = runs.reduce((a, r) => a + r.cost_usd, 0)
  const used = apiKey ? Math.round(100 * total / weeklyUsd) : week?.used ?? 0 // what the headline calls "the week used"
  const shipped = from === null ? [] : q<{ project: string }>(db, "SELECT project FROM tickets WHERE status='shipped' AND onto IS NULL AND updated_at>=?", new Date(from).toISOString())
  const reviewsN = from === null ? 0 : q<{ n: number }>(db, "SELECT count(*) n FROM reviews WHERE at>=? AND verdict IN ('pass','fail')", new Date(from).toISOString())[0]?.n ?? 0

  // Each row's share of what was used: the usd split, scaled so the rows add up to the week's used % (API key: to the dollars).
  type G = { usd: number; tickets: Set<number>; runs: number }
  const group = (key: (r: (typeof runs)[number]) => string) => {
    const m = new Map<string, G>()
    for (const r of runs) { const g = m.get(key(r)) ?? m.set(key(r), { usd: 0, tickets: new Set(), runs: 0 }).get(key(r))!; g.usd += r.cost_usd; g.runs++; if (r.ticket) g.tickets.add(r.ticket) }
    return m
  }
  const rows = (groups: Map<string, G>, order: readonly string[] | undefined, more: (name: string, g: G, pct: number) => Partial<SpendRow>): SpendRow[] => {
    const names = order ? order.filter((n) => groups.has(n)) : [...groups.keys()].sort((a, b) => groups.get(b)!.usd - groups.get(a)!.usd)
    const pcts = apiKey ? names.map((n) => Math.round(100 * groups.get(n)!.usd / (weeklyUsd || 1))) : shares(names.map((n) => groups.get(n)!.usd), used)
    return names.map((name, i) => ({ name, pct: pcts[i], usd: Math.round(groups.get(name)!.usd * 100) / 100, merged: null, perMerged: null, count: null, countWord: "", ...more(name, groups.get(name)!, pcts[i]) }))
  }
  const byProject = group((r) => PLANNING_KINDS.includes(r.kind) ? "Planning" : r.project)
  const byRole = group((r) => roleOf(r.kind))
  const projects = rows(byProject, undefined, (name, _g, pct) => {
    if (name === "Planning") return { countWord: "Lead and PM" }
    const merged = shipped.filter((s) => s.project === name).length
    return { merged, perMerged: merged ? Math.round(pct / merged) : null, countWord: `${merged} merged` }
  })
  const roles = rows(byRole, ROLES, (name, g) => {
    const [n, word] = name === "Builders" ? [g.tickets.size, "ticket"] : name === "Reviewer" ? [reviewsN, "review"] : name === "Tester" ? [g.runs, "run"] : [0, ""]
    return { count: word ? n : null, countWord: word ? `${n} ${word}${n === 1 ? "" : "s"}` : "" }
  })

  // Past weeks: where each of the last 8 landed, from the stored readings; a week with none says so (null), never 0.
  const cap = week?.cap ?? null
  const past: PastWeek[] = []
  const anchor = week?.resetsAt ?? q<{ w: number }>(db, "SELECT max(week_reset) w FROM usage_ticks")[0]?.w ?? null
  const firstRun = apiKey ? q<{ f: string | null }>(db, "SELECT min(at) f FROM runs")[0]?.f ?? null : null // a key week before the first run is not "unused budget"
  for (let i = 1; i <= 8; i++) {
    const end = apiKey ? now - i * WEEK : anchor === null ? null : anchor - i * WEEK
    if (end === null) { past.push({ start: now - i * WEEK, landed: null, usd: 0, series: [] }); continue }
    const usd = q<{ s: number }>(db, "SELECT COALESCE(SUM(cost_usd),0) s FROM runs WHERE at>=? AND at<?", new Date(end - WEEK).toISOString(), new Date(end).toISOString())[0]?.s ?? 0
    const series = apiKey ? [] : weekReadings(db, end)
    const landed = apiKey ? (firstRun === null || new Date(end).toISOString() <= firstRun ? null : Math.round(100 * usd / weeklyUsd)) : series.length ? Math.max(...series.map((p) => p.pct)) : null
    past.push({ start: end - WEEK, landed, usd: Math.round(usd * 100) / 100, series: thin(series) })
  }
  // Unused plan: what the last 4 weeks left under the cap, counted only for weeks that have a reading, as a share of one week.
  const last4 = past.slice(0, 4).filter((p) => p.landed !== null)
  const capPct = apiKey ? 100 : cap
  const unused = capPct === null ? null : { pct: Math.round(last4.reduce((a, p) => a + Math.max(0, capPct - p.landed!), 0)), weeks: last4.length, usd: apiKey ? Math.round(last4.reduce((a, p) => a + Math.max(0, weeklyUsd - p.usd), 0) * 100) / 100 : null }

  const fiveSeries = five && five.resetsAt ? thin(q<{ at: number; five: number }>(db, "SELECT at, five FROM usage_ticks WHERE five_reset BETWEEN ? AND ? ORDER BY at", five.resetsAt - 600_000, five.resetsAt + 600_000).map((r) => ({ t: r.at, pct: r.five }))) : []
  const today = apiKey ? Math.round(100 * (q<{ s: number }>(db, "SELECT COALESCE(SUM(cost_usd),0) s FROM runs WHERE at>=?", new Date(now - DAY).toISOString())[0]?.s ?? 0)) / 100 : null
  return {
    at: now, mode: apiKey ? ("apiKey" as const) : ("plan" as const), used, cap: apiKey ? 100 : cap, startsAt: from, resetsAt: week?.resetsAt ?? null,
    five: five ? { used: five.used, resetsAt: five.resetsAt, series: fiveSeries } : null,
    top: projects.find((p) => p.name !== "Planning")?.name ?? null, projects, roles, past, unused,
    api: apiKey ? { spentUsd: Math.round(total * 100) / 100, weeklyUsd, weeklySet: billing?.weeklyUsd !== undefined, dailyUsd: billing?.dailyUsd ?? 20, todayUsd: today } : null,
  }
}
export type SpendPage = ReturnType<typeof spendPage>

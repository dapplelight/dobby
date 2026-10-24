// The web dashboard's numbers. Every function is pure over a (read-only) DB handle and a clock; nothing here writes or calls out.
// Days are IST days (the owner's), titles come first, ids only as a small suffix.
import { pausedState, pauseList } from "./pause.ts"
import type { DB } from "./db.ts"
import { zonedDay } from "./config.ts"
import { clip, shortTitle } from "./telegram.ts"
import { splitBacklog } from "./lib.ts"
import { healthSnapshot, lastTick } from "./view.ts"

const DAY = 86_400_000
const q = <T>(db: DB, sql: string, ...a: unknown[]) => { try { return db.prepare(sql).all(...a) as T[] } catch { return [] as T[] } } // a table that does not exist yet reads as empty
const day = zonedDay
const ms = (iso: string) => Date.parse(iso)
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d
const title = (t: string) => clip(shortTitle(t), 90)

/** The last `days` IST days ending today, oldest first. */
export function daysBack(days: number, now: number) {
  return Array.from({ length: days }, (_, i) => day(now - (days - 1 - i) * DAY))
}

type T = { id: number; project: string; title: string; status: string; note: string | null; created_at: string; updated_at: string; goal: number | null; onto: string | null }
const tickets = (db: DB) => q<T>(db, "SELECT id, project, title, status, note, created_at, updated_at, goal, onto FROM tickets")
// A ticket with `onto` is a fix pushed onto an open PR: rework, not a shipped ticket (audit #12: 41 of 118 "shipped" were fix pushes).
const shippedSince = (ts: T[], since: number) => ts.filter((t) => t.status === "shipped" && !t.onto && ms(t.updated_at) >= since)
const fixPushesSince = (ts: T[], since: number) => ts.filter((t) => t.status === "shipped" && t.onto && ms(t.updated_at) >= since)

/** "35m", "2h", "3d" */
export function ago(iso: string | number, now: number) {
  const m = Math.max(0, Math.round((now - (typeof iso === "number" ? iso : ms(iso))) / 60_000))
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

// ── 1. Now ──────────────────────────────────────────────────────────────────
export function nowPanel(db: DB, now: number) {
  const ts = tickets(db)
  const row = (t: T) => ({ id: t.id, title: title(t.title), app: t.project, since: ago(t.updated_at, now), minutes: Math.round((now - ms(t.updated_at)) / 60_000) })
  const building = ts.filter((t) => t.status === "running").sort((a, b) => a.updated_at.localeCompare(b.updated_at)).map(row)
  const ready = ts.filter((t) => t.status === "ready").sort((a, b) => a.created_at.localeCompare(b.created_at)).map(row)
  // failed = gave up; fixing = a review found problems and the fix has not landed (it can sit for days)
  const stuck = ts.filter((t) => t.status === "failed" || t.status === "fixing").sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map((t) => ({ ...row(t), state: t.status === "fixing" ? "waiting on a fix" : "failed", reason: t.note ? clip(t.note, 140) : "no reason recorded" }))
  const tick = lastTick(db)
  const lastRun = q<{ at: string }>(db, "SELECT max(at) at FROM runs")[0]?.at
  // latest result per check name
  const checks = q<{ name: string; ok: number; detail: string | null; at: string }>(db, "SELECT name, ok, detail, at FROM checks WHERE id IN (SELECT max(id) FROM checks GROUP BY name) ORDER BY name")
  const failing = checks.filter((c) => !c.ok).map((c) => ({ name: c.name, detail: clip(c.detail ?? "", 120), since: ago(c.at, now) }))
  return {
    building, ready, stuck,
    lastTick: tick, lastTickAgo: tick ? ago(tick, now) : null,
    lastRunAgo: lastRun ? ago(lastRun, now) : null, // fallback while no tick time is recorded: the newest agent run
    jobs: { ok: checks.length - failing.length, total: checks.length, failing },
  }
}

// ── 1b. Needs me ────────────────────────────────────────────────────────────
/** Why a stuck ticket is stuck, as a group the owner acts on once (#174). First match wins; the order puts the owner's own answers first. */
export const STUCK_REASONS: { reason: string; action: string; match: (t: { status: string; note: string }) => boolean }[] = [
  { reason: "Waiting for your OK", action: "Approve or decline it in #needs-you.", match: (t) => t.status === "approval" },
  { reason: "Waiting on your answer", action: "Answer the question in the ticket's thread, then queue it again.", match: (t) => /needs (an )?answer|owner'?s? (written )?(yes|decision)|decisions? (a )?precondition|asks? the owner/i.test(t.note) },
  { reason: "Not a code change", action: "Do it yourself, then close the ticket.", match: (t) => /operations task|not a code change|can't be done from a c|real .* API calls/i.test(t.note) },
  { reason: "Merge conflict to fix by hand", action: "Merge main into the PR branch yourself, push, and the review runs again.", match: (t) => /no merge (was|exists|commit)|merge was (done|performed)|conflicts? in /i.test(t.note) },
  { reason: "Blocked by the guard", action: "Allow the command in the role, or do this one by hand.", match: (t) => /guard hook|denied every command|can't run|couldn't run|not allowed to/i.test(t.note) },
  { reason: "Merged into another ticket", action: "Close these; the other ticket carries the work.", match: (t) => /merged #\d+ into this|duplicate of/i.test(t.note) },
  { reason: "Review fix not landing", action: "Open the PR: fix it by hand, or close it.", match: (t) => t.status === "fixing" || /review still fails|fix for the review findings failed/i.test(t.note) },
  { reason: "PR closed without merging", action: "Queue it again, or close the ticket.", match: (t) => /closed without merging/i.test(t.note) },
  { reason: "Git or GitHub problem", action: "Queue it again; if it fails twice, check the branch on GitHub.", match: (t) => /^(prepare|preflight|ship|push to)\b|couldn't find remote ref|rate limited|GraphQL/i.test(t.note) },
  { reason: "Checks keep failing", action: "Read the failure, then queue it again or split it.", match: (t) => /verify failed|same failure came back|through QA|checker:/i.test(t.note) },
  { reason: "Something else", action: "Open it and decide: queue again or close.", match: () => true },
]

/** What waits on the owner, grouped by why, biggest group first: stuck tickets, failing deploys, failing Dobby jobs. Titles, no ticket numbers. */
export function needsMe(db: DB, now: number) {
  const groups = new Map<string, { reason: string; action: string; items: { id?: number; title: string; app?: string; since: string }[] }>()
  const add = (reason: string, action: string, item: { id?: number; title: string; app?: string; since: string }) => {
    const g = groups.get(reason) ?? { reason, action, items: [] }
    g.items.push(item)
    groups.set(reason, g)
  }
  for (const t of tickets(db).filter((t) => ["failed", "fixing", "approval"].includes(t.status)).sort((a, b) => b.updated_at.localeCompare(a.updated_at))) {
    const r = STUCK_REASONS.find((x) => x.match({ status: t.status, note: t.note ?? "" }))!
    add(r.reason, r.action, { id: t.id, title: title(t.title), app: t.project, since: ago(t.updated_at, now) })
  }
  for (const { k, v } of q<{ k: string; v: string }>(db, "SELECT k, v FROM kv WHERE k LIKE 'deploy:fails:%'"))
    add("Deploy failing", "Open the deploy card in #needs-you and tap Retry once the fix is in.", { title: `${k.slice("deploy:fails:".length)}: failed ${v} time${v === "1" ? "" : "s"} in a row`, app: k.slice("deploy:fails:".length), since: "" })
  for (const c of nowPanel(db, now).jobs.failing) add("A Dobby job is failing", "Run dobby doctor on the Mac; it says what to fix.", { title: c.detail ? `${c.name}: ${c.detail}` : c.name, since: c.since })
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length)
}

// ── 2. Outcomes ─────────────────────────────────────────────────────────────
const median = (xs: number[]) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** A ticket's updated_at is when it shipped (nothing touches it afterwards). Touched = an owner touch is logged against it, ever. */
export function outcomes(db: DB, now: number, days: number) {
  const since = now - days * DAY
  const all = tickets(db)
  const shipped = shippedSince(all, since)
  const touched = new Set(q<{ ticket: number }>(db, "SELECT DISTINCT ticket FROM touches WHERE ticket IS NOT NULL").map((r) => r.ticket))
  const perDay = daysBack(days, now).map((d) => ({ day: d, n: shipped.filter((t) => day(ms(t.updated_at)) === d).length }))
  const med = median(shipped.map((t) => (ms(t.updated_at) - ms(t.created_at)) / 3_600_000))
  const alone = shipped.filter((t) => !touched.has(t.id)).length
  return {
    shipped: shipped.length, reworkFixes: fixPushesSince(all, since).length, perDay,
    medianHours: med === null ? null : round(med),
    noTouchPct: shipped.length ? Math.round((100 * alone) / shipped.length) : null,
  }
}

// ── 3. Quality ──────────────────────────────────────────────────────────────
export function quality(db: DB, now: number, days: number) {
  const since = new Date(now - days * DAY).toISOString()
  const rv = q<{ repo: string; verdict: string; at: string }>(db, "SELECT repo, verdict, at FROM reviews WHERE at>=? AND verdict IN ('pass','fail','skip','error')", since)
  const verdictsPerDay = daysBack(days, now).map((d) => {
    const o = { day: d, pass: 0, fail: 0, skip: 0, error: 0 }
    for (const r of rv) if (day(ms(r.at)) === d) o[r.verdict as "pass"]++
    return o
  })
  const byRepo = new Map<string, { pass: number; fail: number }>()
  for (const r of rv) if (r.verdict === "pass" || r.verdict === "fail") { // a skip or error is not a judgement
    const c = byRepo.get(r.repo) ?? { pass: 0, fail: 0 }
    c[r.verdict]++
    byRepo.set(r.repo, c)
  }
  const passRateByRepo = [...byRepo].map(([repo, c]) => ({ repo, pass: c.pass, total: c.pass + c.fail, pct: Math.round((100 * c.pass) / (c.pass + c.fail)) })).sort((a, b) => b.total - a.total)

  // Rework: builds per ticket that shipped in the window.
  const shipped = shippedSince(tickets(db), now - days * DAY)
  const builds = new Map(q<{ ticket: number; n: number }>(db, "SELECT ticket, count(*) n FROM runs WHERE kind='build' AND ticket IS NOT NULL GROUP BY ticket").map((r) => [r.ticket, r.n]))
  const counts = shipped.map((t) => Math.max(1, builds.get(t.id) ?? 1))
  const rework = {
    tickets: shipped.length,
    avgBuilds: counts.length ? round(counts.reduce((a, b) => a + b, 0) / counts.length) : null,
    once: counts.filter((n) => n === 1).length, twice: counts.filter((n) => n === 2).length, more: counts.filter((n) => n >= 3).length,
  }

  // The Checker's verdict is not stored on its run; a check counts as failed when the ticket built again afterwards, or its run itself failed.
  const runs = q<{ id: number; kind: string; ticket: number; ok: number }>(db, "SELECT id, kind, ticket, ok FROM runs WHERE ticket IS NOT NULL AND kind IN ('build','check') AND at>=? ORDER BY id", since)
  const lastBuild = new Map<number, number>()
  for (const r of runs) if (r.kind === "build") lastBuild.set(r.ticket, r.id)
  const checks = runs.filter((r) => r.kind === "check")
  const sentBack = checks.filter((r) => !r.ok || (lastBuild.get(r.ticket) ?? 0) > r.id).length
  const checker = { checks: checks.length, sentBack, pct: checks.length ? Math.round((100 * sentBack) / checks.length) : null }

  const judged = rv.filter((r) => r.verdict === "pass" || r.verdict === "fail")
  return { verdictsPerDay, passRateByRepo, passPct: judged.length ? Math.round((100 * judged.filter((r) => r.verdict === "pass").length) / judged.length) : null, rework, checker }
}

// ── 4. Spend ────────────────────────────────────────────────────────────────
const TOP_ROLES = 5
export function spend(db: DB, now: number, days: number) {
  const since = new Date(now - days * DAY).toISOString()
  const rs = q<{ at: string; project: string; kind: string; model: string | null; cost_usd: number }>(db, "SELECT at, project, kind, model, cost_usd FROM runs WHERE at>=? AND cost_usd IS NOT NULL AND cost_usd>0", since)
  const sum = (key: (r: (typeof rs)[number]) => string) => {
    const m = new Map<string, number>()
    for (const r of rs) m.set(key(r), (m.get(key(r)) ?? 0) + r.cost_usd)
    return [...m].map(([name, usd]) => ({ name, usd: round(usd, 2) })).sort((a, b) => b.usd - a.usd)
  }
  const byRole = sum((r) => r.kind), byModel = sum((r) => r.model ?? "unknown")
  const top = new Set(byRole.slice(0, TOP_ROLES).map((r) => r.name))
  const roles = byRole.length > TOP_ROLES ? [...top, "other"] : [...top]
  const perDay = daysBack(days, now).map((d) => {
    const parts: Record<string, number> = Object.fromEntries(roles.map((r) => [r, 0]))
    for (const r of rs) if (day(ms(r.at)) === d) parts[top.has(r.kind) ? r.kind : "other"] += r.cost_usd
    for (const k in parts) parts[k] = round(parts[k], 2)
    return { day: d, usd: round(Object.values(parts).reduce((a, b) => a + b, 0), 2), parts }
  })
  const all = tickets(db)
  const shipped = shippedSince(all, now - days * DAY), fixes = fixPushesSince(all, now - days * DAY)
  const apps = [...new Set([...rs.map((r) => r.project), ...shipped.map((t) => t.project)])]
  const perShippedByApp = apps.map((app) => {
    const usd = rs.filter((r) => r.project === app).reduce((a, r) => a + r.cost_usd, 0), n = shipped.filter((t) => t.project === app).length
    return { app, usd: round(usd, 2), shipped: n, reworkFixes: fixes.filter((t) => t.project === app).length, perTicket: n ? round(usd / n, 2) : null }
  }).sort((a, b) => b.usd - a.usd)
  const t = q<{ five: number; week: number; five_reset: number; week_reset: number; at: number }>(db, "SELECT at, five, week, five_reset, week_reset FROM usage_ticks ORDER BY at DESC LIMIT 1")[0]
  return {
    total: round(rs.reduce((a, r) => a + r.cost_usd, 0), 2), roles, byRole, byModel, perDay, perShippedByApp,
    usage: t ? { fivePct: t.five, weekPct: t.week, fiveResetAt: t.five_reset, weekResetAt: t.week_reset, readAgo: ago(t.at, now) } : null,
  }
}

// ── 5. Goals ────────────────────────────────────────────────────────────────
export function goals(db: DB) {
  const ts = tickets(db)
  const gs = q<{ id: number; project: string; title: string; rank: number }>(db, "SELECT id, project, title, rank FROM goals WHERE status='active' ORDER BY project, rank")
  const byApp = new Map<string, unknown[]>()
  for (const g of gs) {
    const mine = ts.filter((t) => t.goal === g.id)
    const shipped = mine.filter((t) => t.status === "shipped" && !t.onto).length
    const failed = mine.filter((t) => t.status === "failed").length
    const open = mine.filter((t) => !["shipped", "declined", "failed"].includes(t.status)).length
    byApp.set(g.project, [...(byApp.get(g.project) ?? []), { rank: g.rank, title: g.title.replace(/^DRAFT:\s*/, ""), draft: g.title.startsWith("DRAFT:"), shipped, open, failed }])
  }
  return [...byApp].map(([app, list]) => ({ app, goals: list as { rank: number; title: string; draft: boolean; shipped: number; open: number; failed: number }[] }))
}

// ── 6. Queue ────────────────────────────────────────────────────────────────
export const BUCKETS = ["under 1 day", "1-3 days", "3-7 days", "over 7 days"] as const
export function queue(db: DB, now: number) {
  const ts = tickets(db)
  const bucket = (iso: string) => { const d = (now - ms(iso)) / DAY; return d < 1 ? 0 : d < 3 ? 1 : d < 7 ? 2 : 3 }
  const apps = new Map<string, number[]>()
  for (const t of ts.filter((t) => t.status === "backlog")) {
    const b = apps.get(t.project) ?? [0, 0, 0, 0]
    b[bucket(t.created_at)]++
    apps.set(t.project, b)
  }
  const backlog = [...apps].map(([app, b]) => ({ app, total: b.reduce((x, y) => x + y, 0), buckets: Object.fromEntries(BUCKETS.map((n, i) => [n, b[i]])) })).sort((a, b) => b.total - a.total)
  const failed = ts.filter((t) => t.status === "failed").sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map((t) => ({ id: t.id, title: title(t.title), app: t.project, since: ago(t.updated_at, now), reason: t.note ? clip(t.note, 160) : "no reason recorded" }))
  // The ten the Lead would promote first (goal rank, then priority): S/M tickets an agent may take, rows the owner can queue by hand.
  // Owner-flagged ones (audit #19: 9 of 10 were) are left out and only counted.
  const rows: { id: number; rank: number; priority: number }[] = []
  let ownerOnly = 0
  for (const app of apps.keys()) {
    try {
      const rank = new Map(q<{ id: number; rank: number }>(db, "SELECT id, rank FROM goals WHERE project=? AND status='active'", app).map((g) => [g.id, g.rank]))
      const rankOf = (g: number | null) => (g == null ? undefined : rank.get(g))
      const { pickable, owner } = splitBacklog(db, app, rankOf)
      ownerOnly += owner.length
      rows.push(...pickable.filter((p) => p.size !== "L").map((p) => ({ id: p.id, rank: rankOf(p.goal) ?? 999, priority: p.priority })))
    } catch {} // a database without these tables reads as empty
  }
  const next = rows.sort((a, b) => a.rank - b.rank || b.priority - a.priority || a.id - b.id).slice(0, 10).map(({ id }) => ts.find((t) => t.id === id)!)
    .map((t) => ({ id: t.id, title: title(t.title), app: t.project, since: ago(t.created_at, now) }))
  return { backlog, failed, next, ownerOnly }
}

// ── 7. Reviews ──────────────────────────────────────────────────────────────
/** Last `limit` reviewed PRs. A title comes from the ticket whose note holds that PR's link (matched on repo name + number, the owner part differs between forks). */
export function reviews(db: DB, limit = 20) {
  const titles = new Map<string, string>()
  for (const t of tickets(db)) {
    const m = t.note?.match(/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/)
    if (m) titles.set(`${m[1]}#${m[2]}`, title(t.title))
  }
  return q<{ repo: string; pr: number; choice: string | null; by: string | null; verdict: string; cost: number | null; at: string }>(db, "SELECT repo, pr, choice, by, verdict, cost, at FROM reviews WHERE verdict!='running' ORDER BY at DESC LIMIT ?", limit)
    .map((r) => ({ ...r, title: titles.get(`${r.repo.split("/")[1]}#${r.pr}`) ?? null, url: `https://github.com/${r.repo}/pull/${r.pr}`, cost: r.cost === null ? null : round(r.cost, 2) }))
}

// ── 8. Where time goes (Claude Code telemetry) ─────────────────────────────
type TRow = { at: string; session_id: string | null; kind: string | null; ticket: number | null; event: string; tool_name: string | null; success: number | null; duration_ms: number | null; decision: string | null; decision_source: string | null; error_type: string | null; error: string | null; status_code: number | null; cost_usd: number | null; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_creation_tokens: number | null }
const TCOLS = "at, session_id, kind, ticket, event, tool_name, success, duration_ms, decision, decision_source, error_type, error, status_code, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens"
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null } // nearest rank
const group = <R, K>(rows: R[], key: (r: R) => K) => { const m = new Map<K, R[]>(); for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]); return m }
const secs = (xs: number[]) => round(xs.reduce((a, b) => a + b, 0) / 1000, 0)

/** Per tool: calls, failures, p50/p90 duration, total seconds. Rows are tool_result events. */
function toolStats(rows: TRow[]) {
  return [...group(rows, (r) => r.tool_name ?? "unknown")].map(([tool, rs]) => {
    const dur = rs.map((r) => r.duration_ms).filter((x): x is number => x != null)
    const failed = rs.filter((r) => r.success === 0).length
    return { tool, calls: rs.length, failed, failPct: Math.round((100 * failed) / rs.length), p50Ms: pct(dur, 0.5), p90Ms: pct(dur, 0.9), totalSec: secs(dur) }
  })
}

/** Where agents lose time and money, from the allowlisted Claude Code events the listener stored. Empty `has: false` until the first event arrives. */
export function telemetryPanel(db: DB, now: number, days: number) {
  const since = new Date(now - days * DAY).toISOString()
  const rows = q<TRow>(db, `SELECT ${TCOLS} FROM telemetry WHERE at>=?`, since)
  const ev = (e: string) => rows.filter((r) => r.event === e)
  const results = ev("tool_result")
  const stats = toolStats(results)
  const toolFailures = stats.filter((t) => t.failed > 0).sort((a, b) => b.failed - a.failed).slice(0, 8).map(({ tool, calls, failed, failPct }) => ({ tool, calls, failed, failPct }))
  const slowest = stats.filter((t) => t.calls >= 3 && t.p90Ms != null).sort((a, b) => b.p90Ms! - a.p90Ms!).slice(0, 8).map(({ tool, calls, p50Ms, p90Ms, totalSec }) => ({ tool, calls, p50Ms, p90Ms, totalSec }))
  const tix = new Map(tickets(db).map((t) => [t.id, t]))
  const denials = [...group(ev("tool_decision").filter((r) => r.decision === "reject"), (r) => `${r.tool_name}|${r.decision_source}|${r.ticket}`)]
    .map(([, rs]) => ({ tool: rs[0].tool_name ?? "unknown", source: rs[0].decision_source ?? "unknown", count: rs.length, ticket: rs[0].ticket, ticketTitle: rs[0].ticket == null ? null : tix.has(rs[0].ticket) ? title(tix.get(rs[0].ticket)!.title) : null }))
    .sort((a, b) => b.count - a.count).slice(0, 10)
  const errs = ev("api_error")
  const errLabel = (r: TRow) => (r.status_code != null ? String(r.status_code) : clip(r.error_type ?? r.error ?? "unknown", 40))
  const apiErrors = {
    total: errs.length,
    byKind: [...group(errs, errLabel)].map(([label, rs]) => ({ label, count: rs.length })).sort((a, b) => b.count - a.count).slice(0, 8),
    perDay: daysBack(days, now).map((d) => ({ day: d, n: errs.filter((r) => day(ms(r.at)) === d).length })),
  }
  const reqs = ev("api_request")
  const costByKind = [...group(reqs, (r) => r.kind ?? "unknown")].map(([kind, rs]) => {
    const read = rs.reduce((a, r) => a + (r.cache_read_tokens ?? 0), 0), fresh = rs.reduce((a, r) => a + (r.input_tokens ?? 0) + (r.cache_creation_tokens ?? 0), 0)
    return { kind, requests: rs.length, usd: round(rs.reduce((a, r) => a + (r.cost_usd ?? 0), 0), 2), cachePct: read + fresh ? Math.round((100 * read) / (read + fresh)) : null }
  }).sort((a, b) => b.usd - a.usd)
  // Share of the window's Claude CLI runs (API-credit text calls never spawn claude) whose session sent any event.
  const runs = q<{ session_id: string | null }>(db, "SELECT session_id FROM runs WHERE at>=? AND model NOT LIKE 'api:%'", since)
  const seen = new Set(rows.map((r) => r.session_id))
  const withData = runs.filter((r) => r.session_id && seen.has(r.session_id)).length
  const toolSec = secs(results.map((r) => r.duration_ms ?? 0)), modelSec = secs(reqs.map((r) => r.duration_ms ?? 0))
  return {
    has: rows.length > 0, events: rows.length, toolFailures, slowest, denials, apiErrors, costByKind,
    time: { toolMin: round(toolSec / 60), modelMin: round(modelSec / 60) },
    coverage: { runs: runs.length, withData, pct: runs.length ? Math.round((100 * withData) / runs.length) : null },
  }
}

// ── Ticket telemetry ────────────────────────────────────────────────────────
/** What the agents did on one ticket, from telemetry: tools used, failures, denials, API errors, and the newest problems. */
export function ticketTelemetry(db: DB, id: number) {
  const rows = q<TRow>(db, `SELECT ${TCOLS} FROM telemetry WHERE ticket=? ORDER BY at`, id)
  if (!rows.length) return null
  const results = rows.filter((r) => r.event === "tool_result")
  const tools = toolStats(results).sort((a, b) => b.totalSec - a.totalSec).slice(0, 8).map(({ tool, calls, failed, p90Ms, totalSec }) => ({ tool, calls, failed, p90Ms, totalSec }))
  const problems = rows.filter((r) => (r.event === "tool_result" && r.success === 0) || (r.event === "tool_decision" && r.decision === "reject") || r.event === "api_error")
    .slice(-10).reverse().map((r) => ({ at: r.at, kind: r.kind, what: r.event === "api_error" ? "api error" : r.event === "tool_decision" ? "denied" : "failed", tool: r.tool_name, detail: r.event === "api_error" ? (r.status_code != null ? String(r.status_code) : clip(r.error_type ?? r.error ?? "", 80)) : r.event === "tool_decision" ? (r.decision_source ?? "") : clip(r.error_type ?? "", 80) }))
  return {
    events: rows.length, firstAt: rows[0].at, lastAt: rows[rows.length - 1].at, toolCalls: results.length, toolFailures: results.filter((r) => r.success === 0).length,
    denials: rows.filter((r) => r.event === "tool_decision" && r.decision === "reject").length, apiErrors: rows.filter((r) => r.event === "api_error").length,
    toolMin: round(secs(results.map((r) => r.duration_ms ?? 0)) / 60), modelMin: round(secs(rows.filter((r) => r.event === "api_request").map((r) => r.duration_ms ?? 0)) / 60),
    usd: round(rows.reduce((a, r) => a + (r.event === "api_request" ? r.cost_usd ?? 0 : 0), 0), 2), tools, problems,
  }
}

// ── Ticket drill-down ───────────────────────────────────────────────────────
/** One ticket with its agent runs and, when its note links a PR, that PR's review verdicts. null = no such ticket. */
export function ticketDetail(db: DB, id: number, now: number) {
  const t = q<T & { size: string; done_when: string; branch: string | null }>(db, "SELECT id, project, title, status, note, created_at, updated_at, goal, size, done_when, branch FROM tickets WHERE id=?", id)[0]
  if (!t) return null
  const runs = q<{ id: number; at: string; kind: string; model: string | null; ok: number; reason: string | null; duration_ms: number | null; cost_usd: number | null }>(db, "SELECT id, at, kind, model, ok, reason, duration_ms, cost_usd FROM runs WHERE ticket=? ORDER BY id", id)
    .map((r) => ({ id: r.id, at: r.at, kind: r.kind, model: r.model, ok: !!r.ok, reason: r.reason ? clip(r.reason, 200) : null, minutes: r.duration_ms == null ? null : round(r.duration_ms / 60_000), usd: r.cost_usd == null ? null : round(r.cost_usd, 2) }))
  const m = t.note?.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/)
  const pr = m ? { repo: m[1], pr: Number(m[2]), url: `https://github.com/${m[1]}/pull/${m[2]}` } : null
  // The owner part differs between forks: match on repo name + number, like reviews().
  const rv = pr
    ? q<{ repo: string; pr: number; choice: string | null; by: string | null; verdict: string; cost: number | null; at: string }>(db, "SELECT repo, pr, choice, by, verdict, cost, at FROM reviews WHERE pr=? AND verdict!='running' ORDER BY at DESC", pr.pr)
      .filter((r) => r.repo.split("/")[1] === pr.repo.split("/")[1]).map((r) => ({ ...r, cost: r.cost === null ? null : round(r.cost, 2) }))
    : []
  const goal = t.goal == null ? null : q<{ title: string }>(db, "SELECT title FROM goals WHERE id=?", t.goal)[0]?.title.replace(/^DRAFT:\s*/, "") ?? null
  return {
    id: t.id, app: t.project, title: title(t.title), fullTitle: t.title, status: t.status, size: t.size, goal,
    note: t.note ? clip(t.note, 1000) : null, doneWhen: t.done_when ? clip(t.done_when, 1000) : null, branch: t.branch,
    created: ago(t.created_at, now), updated: ago(t.updated_at, now),
    runs, runsUsd: round(runs.reduce((a, r) => a + (r.usd ?? 0), 0), 2), pr, reviews: rv, telemetry: ticketTelemetry(db, id),
  }
}

/** Everything the page shows, for a 7 or 30 day window. */
export function snapshot(db: DB, now = Date.now(), days = 7) {
  return { at: now, days, now: nowPanel(db, now), needsMe: needsMe(db, now), outcomes: outcomes(db, now, days), quality: quality(db, now, days), spend: spend(db, now, days), goals: goals(db), queue: queue(db, now), reviews: reviews(db), telemetry: telemetryPanel(db, now, days), paused: pausedState(db), pause: pauseList(db), health: healthSnapshot(db) }
}

// The web dashboard's numbers. Every function is pure over a (read-only) DB handle and a clock; nothing here writes or calls out.
// Days are IST days (the owner's), titles come first, ids only as a small suffix.
import { paused, pausedState, pauseList } from "./pause.ts"
import type { DB } from "./db.ts"
import { config, zonedDay } from "./config.ts"
import { clip, shortTitle } from "./notify.ts"
import { buildsUsed, MAX_BUILDS, milestonesOf, splitBacklog } from "./lib.ts"
import { markFits } from "./queue-math.ts"
import { ticketUsd, weekPoints } from "./savings.ts"
/** What a ticket cost, as the PR comment says it: dollars on an API key, share of the week on a plan. */
const spentText = (usd: number) => config().billing?.mode === "apiKey" ? `$${usd.toFixed(2)}` : `${weekPoints(usd).toFixed(2)}% of week`
import type { DiffStat, DiffText } from "./diffstat.ts"
import { parseDiff } from "./diff-parse.ts"
import { findingsOf, reviewNumbers, safePath, SEVERITY_WORD } from "./findings.ts"
import { lastTick } from "./health.ts"
import { healthSnapshot, receipt, scoreboard, STUCK_MS } from "./view.ts"

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
  { reason: "Checks keep failing", action: "Read the failure, then queue it again or split it.", match: (t) => /verify failed|same failure came back|through (?:QA|testing)|(?:tester|checker):/i.test(t.note) },
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

// ── 1c. Home: the inbox, working now, the week's curve ──────────────────────
const PR = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/
const INBOX_MAX = 12
export type Check = { name: string; state: "pass" | "fail" | "wait" }
export type InboxKind = "merge" | "deploy" | "answer" | "decide"
export type InboxRow = { key: string; kind: InboxKind; id: number | null; project: string; ref: string; title: string; status: string; primary: string; warn: boolean; url: string | null; branch: string | null; checks: Check[]; diff: DiffStat | null; age: string; offers: string[] }
/** The actions a row offers, by the names POST /api/action takes. */
const OFFERS: Record<InboxKind, string[]> = { merge: ["merge", "decline"], deploy: ["deploy"], answer: ["answer", "decline"], decide: ["retry", "decline", "takeOver"] }

/** Five checks for a ticket: the build's verify stands for Tests, Types and Lint (one command), then testing and the PR review. */
function ticketChecks(db: DB, t: T): Check[] {
  const last = (kind: string) => q<{ ok: number }>(db, "SELECT ok FROM runs WHERE ticket=? AND kind=? ORDER BY id DESC LIMIT 1", t.id, kind)[0]
  const st = (r?: { ok: number }): Check["state"] => (r ? (r.ok ? "pass" : "fail") : "wait")
  const pr = t.note?.match(PR)
  const rv = pr ? q<{ verdict: string }>(db, "SELECT verdict FROM reviews WHERE pr=? AND repo LIKE ? ORDER BY at DESC LIMIT 1", Number(pr[3]), `%/${pr[2]}`)[0]?.verdict : undefined
  const build = st(last("build"))
  return [
    { name: "Tests", state: build }, { name: "Types", state: build }, { name: "Lint", state: build },
    { name: "Tester", state: st(last("check")) }, { name: "Review", state: rv === "pass" ? "pass" : rv === "fail" ? "fail" : "wait" },
  ]
}

/** What waits on the owner, by kind then newest: a PR at its gate (merge), a failing deploy (deploy), a question (answer), a stuck ticket (decide). */
export function inbox(db: DB, now: number, diff?: (project: string, branch: string | null) => DiffStat | null) {
  const rows: { at: number; row: InboxRow }[] = []
  const ticketRow = (t: T & { branch: string | null }, kind: InboxKind, status: string, primary: string, warn: boolean): InboxRow => ({
    key: `t${t.id}`, kind, id: t.id, project: t.project, ref: `${t.project} #${t.id}`, title: title(t.title), status, primary, warn, branch: t.branch, url: t.note?.match(PR)?.[0] ? `https://${t.note.match(PR)![0]}` : null,
    checks: ticketChecks(db, t), diff: diff?.(t.project, t.branch) ?? null, age: ago(t.updated_at, now),
    offers: kind === "decide" && t.status === "fixing" && PR.test(t.note ?? "") ? [...OFFERS.decide, "allowRound"] : OFFERS[kind],
  })
  for (const t of q<T & { branch: string | null }>(db, "SELECT id, project, title, status, note, created_at, updated_at, goal, onto, branch FROM tickets WHERE status IN ('approval','failed','fixing')")) {
    const note = t.note ?? ""
    const reason = STUCK_REASONS.find((x) => x.match({ status: t.status, note }))!.reason
    let row: InboxRow | null = null
    if (t.status === "approval") {
      row = ticketRow(t, "merge", "Waiting for your OK", "Merge", false)
      if (row.checks.every((c) => c.state === "pass")) row.status = "Passed review and testing"
    } else if (reason === "Waiting on your answer") row = ticketRow(t, "answer", clip(note.replace(/^BLOCKED:\s*(needs (an )?answer( from the owner)?:?\s*)?/i, ""), 90), "Answer", false)
    else if (/needs you:.*every merge waits for you.*draft PR: https/s.test(note)) row = ticketRow(t, "merge", "Draft PR waits for your merge", "Merge", false) // strict / everyMerge owner: the owner's Merge marks the draft ready and lands it
    else if (reason !== "Not a code change" && reason !== "Merged into another ticket") row = ticketRow(t, "decide", reason, "Retry", true)
    if (row) rows.push({ at: ms(t.updated_at), row })
  }
  for (const { k, v } of q<{ k: string; v: string }>(db, "SELECT k, v FROM kv WHERE k LIKE 'deploy:fails:%'")) {
    const name = k.slice("deploy:fails:".length)
    rows.push({ at: now, row: { key: `d-${name}`, kind: "deploy", id: null, project: name, ref: name, title: `Deploy ${name}`, status: `Failed ${v} time${v === "1" ? "" : "s"} in a row`, primary: "Retry deploy", warn: true, url: null, branch: null, checks: [], diff: null, age: "", offers: OFFERS.deploy } })
  }
  const order: InboxKind[] = ["merge", "deploy", "answer", "decide"]
  rows.sort((a, b) => order.indexOf(a.row.kind) - order.indexOf(b.row.kind) || b.at - a.at) // by kind, then newest
  return { total: rows.length, rows: rows.slice(0, INBOX_MAX).map((r) => r.row) }
}

/** Running tickets: who has it, which round of how many, what it is doing. The runs table only has finished steps, so a build that finished means testing is up next. */
export function working(db: DB, now: number) {
  return q<T>(db, "SELECT id, project, title, status, note, created_at, updated_at, goal, onto FROM tickets WHERE status='running' ORDER BY updated_at").map((t) => {
    const lastRun = q<{ kind: string; ok: number }>(db, "SELECT kind, ok FROM runs WHERE ticket=? ORDER BY id DESC LIMIT 1", t.id)[0]
    const qa = lastRun?.kind === "build" && !!lastRun.ok
    const used = buildsUsed(db, t.id)
    return { key: `t${t.id}`, id: t.id, project: t.project, ref: `${t.project} #${t.id}`, title: title(t.title), role: qa ? "Testing" : "Builder", round: Math.min(MAX_BUILDS, Math.max(1, qa ? used : used + 1)), of: MAX_BUILDS, step: qa ? "checking" : "building", age: ago(t.updated_at, now), stuck: now - ms(t.updated_at) > STUCK_MS }
  })
}

/** A ticket that has been running with no update for this long is stuck (the working row gets a badge and "See last step"). */
export { STUCK_MS }

/** The roles doing something right now: builder and checker from the running tickets, reviewer from a review that started in the last half hour. */
export function teamLive(db: DB, now: number): string[] {
  const live = new Set<string>(working(db, now).map((w) => (w.role === "Testing" ? "checker" : "builder")))
  if (q<{ n: number }>(db, "SELECT COUNT(*) n FROM reviews WHERE verdict='running' AND at>=?", new Date(now - 1_800_000).toISOString())[0]?.n) live.add("reviewer")
  return [...live]
}

/** This week's stored plan readings, at most `max` points, for the instrument's real curve. */
export function weekSeries(db: DB, max = 120) {
  const last = q<{ week_reset: number }>(db, "SELECT week_reset FROM usage_ticks ORDER BY at DESC LIMIT 1")[0]
  if (!last) return []
  const all = q<{ at: number; week: number }>(db, "SELECT at, week FROM usage_ticks WHERE week_reset>? AND week_reset<=? ORDER BY at", last.week_reset - 3_600_000, last.week_reset)
  const step = Math.ceil(all.length / max) || 1
  return all.filter((_, i) => i % step === 0 || i === all.length - 1).map((r) => ({ t: r.at, pct: r.week }))
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

  // The Tester's verdict is not stored on its run; a check counts as failed when the ticket built again afterwards, or its run itself failed.
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
export function queue(db: DB, now: number, limits?: unknown) {
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
  return { backlog, failed, next, ownerOnly, ...queueView(db, now, limits) }
}

// ── 6b. The order of work: estimates, the stop line, backlog and ideas ──────
/** What a size costs when there is no history to go on, in % of the week. */
const SIZE_PCT: Record<string, number> = { S: 2, M: 5, L: 11 }
const MIN_SAMPLES = 3
/** Per size: the median week-% of shipped tickets of that size (their runs' cost over the plan's $ per point), else the default. */
export function estimates(db: DB): Record<"S" | "M" | "L", number> {
  const spent = q<{ size: string; usd: number }>(db, "SELECT t.size, SUM(r.cost_usd) usd FROM tickets t JOIN runs r ON r.ticket=t.id WHERE t.status='shipped' AND t.onto IS NULL GROUP BY t.id HAVING usd > 0")
  const est = (size: string) => {
    const xs = spent.filter((r) => r.size === size).map((r) => weekPoints(r.usd))
    return Math.max(1, Math.round(xs.length >= MIN_SAMPLES ? median(xs)! : SIZE_PCT[size]))
  }
  return { S: est("S"), M: est("M"), L: est("L") }
}

type QRow = { id: number; project: string; title: string; done_when: string; size: string; priority: number; status: string; depends_on: number | null; created_at: string }
/** Queued tickets in the order builders take them (running first, then priority, then id), each with its estimate, whether it fits the week's room, and what it waits on. */
export function queueView(db: DB, now: number, limits?: unknown) {
  const est = estimates(db)
  const w = (limits as { week?: { used: number; cap: number; resetsAt: number } } | null | undefined)?.week
  const room = w ? Math.max(0, w.cap - w.used) : null
  const rows = q<QRow>(db, "SELECT id, project, title, done_when, size, priority, status, depends_on, created_at FROM tickets WHERE status IN ('running','ready') AND dup_of IS NULL ORDER BY status='running' DESC, priority DESC, id")
  const open = new Set(q<{ id: number }>(db, "SELECT id FROM tickets WHERE status NOT IN ('shipped')").map((r) => r.id))
  let next = true
  const rest = rows.map((t) => {
    const estPct = est[t.size as "S" | "M" | "L"] ?? est.M
    // a running ticket has spent part of its estimate already: that part is in the week's used figure
    return { t, estPct, leftPct: t.status === "running" ? Math.max(0, estPct - weekPoints(ticketUsd(db, t.id))) : estPct }
  })
  const fits = markFits(rest, room)
  const order = rest.map(({ t, estPct, leftPct }, i) => {
    const blocked = t.status === "ready" ? (t.depends_on && open.has(t.depends_on) ? `#${t.depends_on}` : paused(db, { kind: "builders", project: t.project, ticket: t.id }) ? "paused" : null) : null
    const state = t.status === "running" ? "Building" : blocked ? (blocked === "paused" ? "Paused" : `After ${blocked}`) : next ? "Next" : "Ready"
    if (t.status === "ready" && !blocked) next = false
    return { id: t.id, n: i + 1, ref: `${t.project} #${t.id}`, project: t.project, title: title(t.title), doneWhen: clip(t.done_when, 400), filed: ago(t.created_at, now), size: t.size, estPct, leftPct, fits: fits[i], waitsOn: blocked, state, running: t.status === "running" }
  })
  const total = rest.reduce((a, r) => a + r.leftPct, 0)
  const parked = q<{ id: number; project: string; title: string; size: string; created_at: string }>(db, "SELECT id, project, title, size, created_at FROM tickets WHERE status='backlog' AND dup_of IS NULL ORDER BY priority DESC, id LIMIT 50")
    .map((t) => ({ id: t.id, ref: `${t.project} #${t.id}`, project: t.project, title: title(t.title), size: t.size, estPct: est[t.size as "S" | "M" | "L"] ?? est.M, age: ago(t.created_at, now) }))
  const ideas = q<{ id: number; project: string; title: string; source: string; lens: string | null; why: string | null; size: string | null; score: number | null }>(db, "SELECT id, project, title, source, lens, why, size, score FROM ideas WHERE status IN ('new','proposed') AND dup_of IS NULL ORDER BY score DESC NULLS LAST, id LIMIT 50")
    .map((i) => ({ ...i, title: title(i.title), why: i.why ? clip(i.why, 240) : null }))
  return { order, parked, ideas, estimates: est, room, queuedPct: total, stopPct: w?.cap ?? null, resetsAt: w?.resetsAt ?? null }
}

/** One row per active goal: a mark per ticket (done, in progress, waiting), the count, the milestone's due date and a plain status from this project's pace over 14 days. */
export function goalRows(db: DB, now: number) {
  const ts = q<T & { size: string }>(db, "SELECT id, project, title, status, note, created_at, updated_at, goal, onto, size FROM tickets WHERE goal IS NOT NULL AND dup_of IS NULL AND status!='declined' AND onto IS NULL ORDER BY id")
  const gs = q<{ id: number; project: string; title: string; rank: number; milestone: number | null }>(db, "SELECT id, project, title, rank, milestone FROM goals WHERE status='active' ORDER BY rank, project")
  const markOf = (s: string) => (s === "shipped" ? "done" : ["running", "fixing", "approval"].includes(s) ? "running" : "waiting") as "done" | "running" | "waiting"
  return gs.map((g) => {
    const mine = ts.filter((t) => t.goal === g.id), done = mine.filter((t) => t.status === "shipped").length
    const dueIso = g.milestone ? milestonesOf(db, g.project).find((m) => m.number === g.milestone)?.due_on ?? null : null
    const rate = ts.filter((t) => t.project === g.project && t.status === "shipped" && now - ms(t.updated_at) <= 14 * DAY).length / 14 // tickets a day
    const left = mine.length - done
    const days = rate > 0 ? left / rate : null
    const diff = dueIso && days !== null ? Math.round((ms(dueIso) - (now + days * DAY)) / DAY) : null // + = early
    const status = left === 0 && mine.length ? "Done" : diff === null ? (dueIso ? "No pace yet" : "") : diff >= 1 ? `On track, ${diff} days early` : diff >= 0 ? "On track" : `Tight: ${-diff} days late at this pace`
    return {
      id: g.id, project: g.project, title: g.title.replace(/^DRAFT:\s*/, ""), draft: g.title.startsWith("DRAFT:"), done, total: mine.length, due: dueIso, status, late: left > 0 && diff !== null && diff < 0,
      marks: mine.map((t) => markOf(t.status)), left: mine.filter((t) => t.status !== "shipped").slice(0, 8).map((t) => ({ id: t.id, ref: `#${t.id}`, title: title(t.title), mark: markOf(t.status) })),
    }
  })
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
export function ticketDetail(db: DB, id: number, now: number, diffText?: (project: string, branch: string | null) => DiffText | null) {
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
  // The diff of the ticket's branch, the findings stored for the PR (their paths are data: unsafe ones are dropped), and the rounds between them.
  const diff = pr && t.branch ? diffText?.(t.project, t.branch) ?? null : null
  const dfiles = diff ? parseDiff(diff.text) : []
  const lineText = (path: string, line: number) => dfiles.find((f) => f.path === path)?.lines.find((l) => l.new === line && l.t !== "del")?.text ?? null
  const fr = pr ? findingsOf(db, pr.repo, pr.pr).filter((f) => safePath(f.path)) : []
  const findings = fr.map((f) => ({
    id: f.id, file: f.path, line: f.line, severity: f.severity as "high" | "medium" | "low", word: SEVERITY_WORD[f.severity as keyof typeof SEVERITY_WORD] ?? "Should fix", kind: f.kind,
    text: f.problem, fix: f.fix, suggestion: f.suggestion, was: lineText(f.path, f.line), round: f.round, state: f.state, rule: clip(f.problem.replace(/\s+/g, " "), 300),
  }))
  const blocking = (path: string) => findings.filter((f) => f.file === path && f.state === "open" && f.severity !== "low").length
  const files = dfiles.map((f) => ({ path: f.path, add: f.add, del: f.del, blocking: blocking(f.path), findings: findings.filter((x) => x.file === f.path && x.state === "open").length }))
  const rounds = rv.filter((r) => r.verdict === "pass" || r.verdict === "fail").sort((a, b) => a.at.localeCompare(b.at)).map((r, i) => {
    const mine = fr.filter((f) => f.round === i + 1)
    return { n: i + 1, at: r.at, verdict: r.verdict, what: r.verdict === "pass" ? "Passed." : mine.length ? `Changes requested: ${mine.slice(0, 2).map((f) => clip(f.problem, 90).replace(/[.\s]+$/, "")).join("; ")}${mine.length > 2 ? `; and ${mine.length - 2} more` : ""}` : "Changes requested." }
  })
  return {
    id: t.id, app: t.project, title: title(t.title), fullTitle: t.title, status: t.status, size: t.size, goal,
    note: t.note ? clip(t.note, 1000) : null, doneWhen: t.done_when ? clip(t.done_when, 1000) : null, branch: t.branch,
    created: ago(t.created_at, now), updated: ago(t.updated_at, now),
    runs, runsUsd: round(runs.reduce((a, r) => a + (r.usd ?? 0), 0), 2), spent: spentText(runs.reduce((a, r) => a + (r.usd ?? 0), 0)), pr, reviews: rv, telemetry: ticketTelemetry(db, id),
    files, findings, rounds, diff,
  }
}

/** Everything the page shows, for a 7 or 30 day window. */
export function snapshot(db: DB, now = Date.now(), days = 7, limits: unknown = null, diff?: Parameters<typeof inbox>[2]) {
  return { at: now, limits, days, inbox: inbox(db, now, diff), working: working(db, now), teamLive: teamLive(db, now), week: { series: weekSeries(db) }, now: nowPanel(db, now), needsMe: needsMe(db, now), outcomes: outcomes(db, now, days), quality: quality(db, now, days), spend: spend(db, now, days), goals: goals(db), queue: queue(db, now, limits), goalRows: goalRows(db, now), reviews: reviews(db), telemetry: telemetryPanel(db, now, days), paused: pausedState(db), pause: pauseList(db), health: healthSnapshot(db), scoreboard: scoreboard(db, 7, now), receipt: receipt(db, days, now) }
}

// ── Reviews page ────────────────────────────────────────────────────────────
/** The review dashboard: this week's numbers, and the PRs under review or needing changes (the scoreboard's data), newest first. */
export function reviewsPage(db: DB, now: number, diff?: (project: string, branch: string | null) => DiffStat | null) {
  const numbers = reviewNumbers(db, now)
  const sb = scoreboard(db, 7, now)
  const ts = tickets(db).filter((t) => t.status !== "backlog")
  const tix = (t: T & { branch?: string | null }, repo: string, pr: number) => { const m = t.note?.match(/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/); return !!m && m[1] === repo.split("/")[1] && Number(m[2]) === pr }
  const latest = q<{ repo: string; pr: number; sha: string; verdict: string; choice: string | null; at: string; took_ms: number | null }>(db,
    "SELECT repo, pr, sha, verdict, choice, at, took_ms FROM reviews r WHERE at=(SELECT max(at) FROM reviews x WHERE x.repo=r.repo AND x.pr=r.pr) ORDER BY at DESC LIMIT 20")
  const prs = latest.map((r) => {
    const t = ts.find((x) => tix(x, r.repo, r.pr))
    const fs = findingsOf(db, r.repo, r.pr)
    const rounds = q<{ n: number }>(db, "SELECT count(*) n FROM reviews WHERE repo=? AND pr=? AND verdict IN ('pass','fail')", r.repo, r.pr)[0]?.n ?? 0
    const last = Math.max(0, ...fs.map((f) => f.round)), mine = fs.filter((f) => f.round === last) // the counts are the newest round that raised anything
    const count = (sev: string) => mine.filter((f) => f.severity === sev).length
    const branch = q<{ branch: string | null }>(db, "SELECT branch FROM tickets WHERE id=?", t?.id ?? 0)[0]?.branch ?? null
    return {
      repo: r.repo, pr: r.pr, ref: `${r.repo.split("/")[1]} #${r.pr}`, ticket: t?.id ?? null, title: t ? title(t.title) : `Pull request ${r.pr}`, url: `https://github.com/${r.repo}/pull/${r.pr}`,
      verdict: t?.status === "shipped" && r.verdict === "pass" ? "merged" : r.verdict, b: count("high"), s: count("medium"), n: count("low"), round: Math.max(1, rounds),
      files: (t && diff?.(t.project, branch)?.files) ?? null, tookMin: r.took_ms ? Math.max(1, Math.round(r.took_ms / 60_000)) : null, at: r.at,
    }
  })
  return { at: now, numbers, scoreboard: sb, prs }
}
export type ReviewsPage = ReturnType<typeof reviewsPage>

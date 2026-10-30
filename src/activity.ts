// GET /api/activity: what the team did, newest first, built from the runs, the reviews and the tickets that finished.
// There is no status-change log, so a ticket's event is its final status at updated_at (merged, declined, failed); the runs and reviews carry the rest.
// Read-only over the DB handle; the clock and the limits are given.
import type { DB } from "./db.ts"
import { clip, shortTitle } from "./notify.ts"
import { JOBS } from "./jobs.ts"
import { route } from "./chat/platform.ts"
import { gather, istDay, type Facts, type StoredBrief } from "./graphs/cos.ts"
import { buildBrief, briefMarkdown } from "./brief.ts"
import type { Project, Usage } from "./lib.ts"

const DAY = 86_400_000
export const PAGE = 100
export const KINDS = ["all", "merges", "reviews", "problems"] as const
export type ActivityKind = (typeof KINDS)[number]
const q = <T>(db: DB, sql: string, ...a: unknown[]) => { try { return db.prepare(sql).all(...a) as T[] } catch { return [] as T[] } }

export type ActivityEvent = {
  id: string; t: number; role: string; kind: "run" | "review" | "merge" | "ticket"; text: string; ref: string; result: string
  tone: "plain" | "good" | "warn"; problem: boolean; sentBack: boolean; ticket: number | null
}

/** Runs worth a line. Classifier, summary and chat runs are plumbing, and review runs are already a review row. */
export const RUN_ROLE: Record<string, [string, string]> = {
  build: ["Builder", "Built"], fix: ["Builder", "Fixed"], check: ["Tester", "Checked"], test: ["Tester", "Tested"], smoke: ["Tester", "Smoke-tested"], "launch-check": ["Tester", "Launch check for"],
  lead: ["Lead", "Planned"], "lead-week": ["Lead", "Planned the week for"], pm: ["PM", "Looked for work in"], "area-pm": ["PM", "Looked for work in"], scout: ["Scout", "Scouted"],
  cos: ["Chief of Staff", "Wrote the morning summary for"], design: ["Designer", "Designed"], brainstorm: ["PM", "Brainstormed"], explain: ["Dobby", "Explained"], program: ["Lead", "Split into a program:"], onboard: ["Dobby", "Set up"],
}
type TRow = { id: number; project: string; title: string; status: string; note: string | null; updated_at: string; onto: string | null }
const t0 = (iso: string) => Date.parse(iso)

/** Every event in (since, before), newest first, before the kind filter and the page limit. */
function events(db: DB, since: number, before: number): ActivityEvent[] {
  const lo = new Date(since).toISOString(), hi = new Date(before).toISOString()
  const tix = new Map(q<TRow>(db, "SELECT id, project, title, status, note, updated_at, onto FROM tickets").map((t) => [t.id, t]))
  const byPr = (repo: string, pr: number) => [...tix.values()].find((t) => { const m = t.note?.match(/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/); return !!m && m[1] === repo.split("/")[1] && Number(m[2]) === pr })
  const out: ActivityEvent[] = []

  for (const r of q<{ id: number; at: string; project: string; kind: string; ticket: number | null; ok: number; reason: string | null }>(db, "SELECT id, at, project, kind, ticket, ok, reason FROM runs WHERE at>? AND at<? ORDER BY at DESC LIMIT 500", lo, hi)) {
    const w = RUN_ROLE[r.kind]
    if (!w) continue
    const t = r.ticket ? tix.get(r.ticket) : undefined
    out.push({
      id: `run:${r.id}`, t: t0(r.at), role: w[0], kind: "run", text: `${w[1]} ${t ? shortTitle(t.title) : r.project}`, ref: t ? `${t.project} #${t.id}` : r.project,
      result: r.ok ? "Done" : `Failed${r.reason ? `: ${clip(r.reason, 60)}` : ""}`, tone: r.ok ? "plain" : "warn", problem: !r.ok, sentBack: false, ticket: t?.id ?? null,
    })
  }

  const rounds = new Map<string, number>()
  const rv = q<{ repo: string; pr: number; sha: string; verdict: string; at: string }>(db, "SELECT repo, pr, sha, verdict, at FROM reviews WHERE verdict IN ('pass','fail','skip','error') ORDER BY at")
  for (const r of rv) {
    if (r.verdict === "pass" || r.verdict === "fail") rounds.set(`${r.repo}#${r.pr}`, (rounds.get(`${r.repo}#${r.pr}`) ?? 0) + 1)
    if (r.at <= lo || r.at >= hi) continue
    const t = byPr(r.repo, r.pr), round = rounds.get(`${r.repo}#${r.pr}`) ?? 1
    const result = r.verdict === "fail" ? "Changes requested" : r.verdict === "pass" ? "Passed" : r.verdict === "skip" ? "Skipped" : "Could not run"
    out.push({
      id: `review:${r.repo}#${r.pr}:${r.sha}`, t: t0(r.at), role: "Reviewer", kind: "review", text: `${r.verdict === "fail" ? "Changes requested" : r.verdict === "pass" ? "Passed" : "Reviewed"} ${t ? shortTitle(t.title) : `pull request ${r.pr}`}${r.verdict === "fail" || r.verdict === "pass" ? `, round ${round}` : ""}`,
      ref: t ? `${t.project} #${t.id}` : `${r.repo.split("/")[1]} #${r.pr}`, result, tone: r.verdict === "fail" || r.verdict === "error" ? "warn" : "plain", problem: r.verdict === "error", sentBack: r.verdict === "fail", ticket: t?.id ?? null,
    })
  }

  for (const t of tix.values()) {
    const at = t0(t.updated_at)
    if (!(at > since && at < before) || t.onto) continue // a fix pushed onto an open PR is rework, not a merge
    if (t.status === "shipped") out.push({ id: `merge:${t.id}`, t: at, role: "Dobby", kind: "merge", text: `Merged ${shortTitle(t.title)}`, ref: `${t.project} #${t.id}`, result: "Merged", tone: "good", problem: false, sentBack: false, ticket: t.id })
    else if (t.status === "declined") out.push({ id: `ticket:${t.id}`, t: at, role: "Dobby", kind: "ticket", text: `Declined ${shortTitle(t.title)}`, ref: `${t.project} #${t.id}`, result: "Declined", tone: "plain", problem: false, sentBack: false, ticket: t.id })
    else if (t.status === "failed") out.push({ id: `ticket:${t.id}`, t: at, role: "Dobby", kind: "ticket", text: `Gave up on ${shortTitle(t.title)}`, ref: `${t.project} #${t.id}`, result: "Needs you", tone: "warn", problem: true, sentBack: false, ticket: t.id })
  }
  // A declined or failed ticket is not a merge: only "Merged" feeds the Merges filter.
  return out.sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : -1))
}

const isMerge = (e: ActivityEvent) => e.result === "Merged"
const FILTERS: Record<ActivityKind, (e: ActivityEvent) => boolean> = { all: () => true, merges: isMerge, reviews: (e) => e.kind === "review", problems: (e) => e.problem }

/** A failed run that the same ticket and kind ran again after: a retry. */
function retries(db: DB, since: number, now: number) {
  const rs = q<{ id: number; ticket: number | null; kind: string; ok: number; at: string }>(db, "SELECT id, ticket, kind, ok, at FROM runs WHERE ticket IS NOT NULL AND at>? AND at<=? ORDER BY at", new Date(since).toISOString(), new Date(now).toISOString())
  return rs.filter((r, i) => !r.ok && rs.slice(i + 1).some((x) => x.ticket === r.ticket && x.kind === r.kind)).length
}

export type Page = ReturnType<typeof activityPage>
/** One page of events plus the counts the filter chips and the headline show. `before` pages back through older events; `summary` goes with the first page only. */
export function activityPage(db: DB, o: { now: number; since: number; before?: number; kind?: ActivityKind }) {
  const all = events(db, o.since, o.before ?? o.now + 1)
  const kind = o.kind ?? "all"
  const shown = all.filter(FILTERS[kind])
  const counts = { all: 0, merges: 0, reviews: 0, problems: 0 }
  const window = o.before === undefined ? all : events(db, o.since, o.now + 1)
  for (const e of window) { counts.all++; for (const k of ["merges", "reviews", "problems"] as const) if (FILTERS[k](e)) counts[k]++ }
  return {
    at: o.now, since: o.since, kind, events: shown.slice(0, PAGE), more: shown.length > PAGE, counts,
    headline: { merged: counts.merges, sentBack: window.filter((e) => e.sentBack).length, retries: retries(db, o.since, o.now) },
  }
}

// ---- new events for the live stream ----
/** What /api/events sends after the snapshot: the events that appeared since the last look. `seen` remembers what was sent. */
export function freshEvents(db: DB, seen: Set<string>, now: number, first = false): ActivityEvent[] {
  const fresh = events(db, now - 2 * DAY, now + 1).filter((e) => !seen.has(e.id))
  for (const e of fresh) seen.add(e.id)
  return first ? [] : fresh.reverse() // the first call only learns what is already there
}

// ---- the morning summary ----
const asUsage = (l: LimitsLike, now: number): Usage | null => l && "week" in l ? { fiveUsed: l.five.used, weekUsed: l.week.used, weekMsToReset: l.week.resetsAt ? Math.max(0, l.week.resetsAt - now) : 0 } : null
type LimitsLike = { five: { used: number }; week: { used: number; resetsAt?: number | null } } | { state: string } | null | undefined

/** The summary the Chief of Staff sends, for the aside: today's stored text if it was sent (or tried), else what its no-AI template builds from the same facts right now. */
export function morningSummary(db: DB, o: { now: number; since: number; projects: Record<string, Project>; limits?: LimitsLike; channel?: { name: string } | null }) {
  const day = istDay(o.now)
  const get = (k: string) => q<{ v: string }>(db, "SELECT v FROM kv WHERE k=?", k)[0]?.v
  let meta: { text: string; at: number; ok: boolean } | null = null
  try { // brief:text is read for one release (written before the Markdown summary)
    const j = get(`brief:json:${day}`), old = get(`brief:text:${day}`)
    if (j) { const m = JSON.parse(j) as StoredBrief; meta = { text: m.markdown, at: m.at, ok: m.ok } } else if (old) meta = JSON.parse(old)
  } catch {}
  const usage = asUsage(o.limits, o.now)
  let text = meta?.text ?? ""
  if (!meta) {
    try { text = briefMarkdown(buildBrief(db, gather(db, o.projects, usage, o.now), o.now)) } catch {}
  }
  const channel = `Discord #${route({ kind: "brief" }).channel}`
  const [h, m] = JOBS.find((j) => j.name === "cos")?.at ?? [8, 5]
  const hasChannel = !!q(db, "SELECT 1 FROM kv WHERE k=?", `discord:wh:${route({ kind: "brief" }).channel}`)[0]
  const sent: { state: "sent" | "failed" | "not-sent" | "waiting"; to: string; at: number | null; text: string } =
    meta ? (meta.ok ? { state: "sent", to: channel, at: meta.at, text: `Sent to ${channel}` } : { state: "failed", to: channel, at: meta.at, text: hasChannel ? `Not sent: ${channel} did not take it. It is kept in outbox.log.` : "Not sent: no channel set up. Run `dobby discord setup`." })
    : !hasChannel ? { state: "not-sent", to: channel, at: null, text: "Not sent: no channel set up. Run `dobby discord setup`." }
    : { state: "waiting", to: channel, at: null, text: `Not sent yet today. It goes to ${channel} at ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}.` }

  // The numbers beside it, for the same window as the page: since the browser last looked.
  const tick = (cond: string, ...a: unknown[]) => q<{ at: number; week: number; week_reset: number }>(db, `SELECT at, week, week_reset FROM usage_ticks WHERE ${cond}`, ...a)[0]
  const now = tick("1=1 ORDER BY at DESC LIMIT 1"), base = tick("at<=? ORDER BY at DESC LIMIT 1", o.since)
  const plan = now && base && now.week_reset === base.week_reset ? Math.max(0, now.week - base.week) : null // a reset in between is no reading
  const since = new Date(o.since).toISOString()
  const runs = q<{ n: number }>(db, "SELECT count(*) n FROM runs WHERE at>?", since)[0]?.n ?? 0
  const failing = q<{ k: string }>(db, "SELECT k FROM kv WHERE k LIKE 'deploy:fails:%' AND CAST(v AS INTEGER)>0").map((r) => r.k.slice("deploy:fails:".length))
  const reverts = q<{ n: number }>(db, "SELECT count(*) n FROM runs WHERE human='reverted' AND at>?", since)[0]?.n ?? 0
  return {
    text: text.trim(), preview: !meta, sent,
    plan, runs, retried: retries(db, o.since, o.now), main: { reverts, failingDeploys: failing },
  }
}

// The Engineering Manager graph (was "the Lead"; code names stay lead): one planning pass for one project, so the owner
// no longer picks or types tickets. It ranks by the owner's goals and assigns each ticket to a Mobile, Web or Backend Engineer.
// Mondays 06:30 IST it also writes the week's plan (Opus); the daily runs read that plan.
//
//   START → gather → plan → apply → report → END
//
// gather reads the board, goal, roadmap and recent commits (no AI). plan is one read-only Sonnet run (roles/lead.md).
// apply enforces the rules in code: the prompt only asks, applyPlan decides. report keeps a summary in kv for the Chief of Staff.
import { paused } from "../pause.ts"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import type { DB } from "../db.ts"
import { team } from "../discord.ts"
import { clip } from "../telegram.ts"
import { addProgram } from "./program.ts"
import { nearTickets, sameWork } from "../jev.ts"
import { check, ownerLevel, ticketGate, unsureOwner } from "../safety.ts"
import type { Ctx } from "../policy.ts"
import { readOnlyDir, addTicket, agentFiled, claude, ENGINEERS, getTicket, goalFor, goals as activeGoals, policyCtx, goalsText, cachedOwnerVerdict, splitBacklog, ticketText, verdictKey, ist, istDay, isDuplicate, loadProjects, loadRole, netRun, shAsync, timeoutMs, parentFor, setTicket, unblocked, signedOut, syncGoals, type Project, type Ticket } from "../lib.ts"

// A proper queue (owner, 20 Oct): refill when ready drops under LOW_WATER, fill up to READY_CAP (to 2 x the 4 day workers); 6 promotions per run.
export const MAX_PROMOTE = 6, MAX_NEW = 3, READY_CAP = 8, LOW_WATER = 4
const EVERY_MS = 10 * 60_000
const DAY = 24 * 3600_000
// Work only the owner may start, matched on title + done_when (src/safety.ts ticketGate): a hard rule (an "owner:" marker, a real
// client's name) always; otherwise only a word that suggests a category the configured safety rules put at owner/never, and then the
// classifier's verdict decides (true = owner). No verdict: the `unsure` setting. ctx: the ticket's project and title.
export const needsOwner = (text: string, verdicts?: Map<string, boolean>, ctx: Ctx = {}) => {
  const t = text.trim()
  const g = ticketGate(t, ctx)
  if (g !== "ask") return g === "deny"
  return verdicts?.get(t) ?? unsureOwner()
}
/** The classifier's verdict for every ticket text the word pre-filter flags at owner level. Texts: "<title> <done_when>". Only a real answer is recorded. */
export async function ownerVerdicts(texts: { title: string; done_when?: string }[], fetcher?: typeof fetch, project?: string, db?: DB, useJev = true) {
  const out = new Map<string, boolean>()
  await Promise.all(texts.map(async (t) => {
    const key = `${t.title} ${t.done_when ?? ""}`.trim()
    const ctx = { ...policyCtx(project), title: t.title }
    if (ticketGate(key, ctx) !== "ask" || out.has(key)) return
    const r = await check({ text: key, title: t.title, project, ownerWords: ctx.ownerWords }, { fetcher, db, useJev })
    // record only a real answer, or an owner-level category that needs no answer (a firm word, path or hard rule)
    const open = new Set([...r.result.unsure, ...(r.result.noAnswer ?? [])])
    if (!open.size || r.result.denied || r.per.some((p) => ownerLevel(p.action) && !open.has(p.category))) out.set(key, ownerLevel(r.action))
  }))
  return out
}

// ---- Jev's owner-only verdicts, cached per ticket (kv owner-verdict:<id>); splitBacklog (lib.ts) reads them ------------------------
/** Jev's cached verdicts for these tickets, in the shape needsOwner reads (ticket text -> owner-only). */
export function cachedVerdicts(db: DB, ts: Ticket[]) {
  const out = new Map<string, boolean>()
  for (const t of ts) { const v = cachedOwnerVerdict(db, t); if (v !== undefined) out.set(ticketText(t), v) }
  return out
}
const cacheVerdicts = (db: DB, ts: Ticket[], v: Map<string, boolean>) => {
  for (const t of ts) if (v.has(ticketText(t))) db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(verdictKey(t.id), JSON.stringify({ k: ticketText(t), owner: v.get(ticketText(t)) }))
}
const WARM = 5 // flagged tickets Jev judges per Lead run, so the owner-only list drains instead of staying shut

// Read-only on the repo: look, never touch.
const LEAD_TOOLS = ["Read", "Grep", "Glob", "Bash(git log:*)", "Bash(git show:*)", "Bash(graphify query:*)", "Bash(graphify path:*)", "Bash(graphify explain:*)"]
const LEAD_DENY = ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"]

export type NewTicket = { title: string; done_when?: string; size?: string; priority?: number; why?: string; goal?: number; engineer?: string; depends_on?: number }
// assign: ticket id -> mobile | web | backend for promoted tickets. week: the Monday plan's text.
// programs: an L ticket with a PRD split into S/M tickets in build order (the Program Manager runs it from there).
export type Split = { from: number; title?: string; tickets: NewTicket[] }
export type Plan = { promote: number[]; new: NewTicket[]; note: string; assign?: Record<number, string>; week?: string; programs?: Split[] }
export type Applied = { promoted: string[]; created: string[]; needsOwner: string[]; skipped: string[]; programs?: string[] }
const MAX_PROGRAMS = 1, PROGRAM_TICKETS = [2, 6]

/** The Lead's JSON (last `{` line, or the outermost braces). null when unreadable. */
export function parsePlan(text: string): Plan | null {
  const lines = text.trim().split("\n").reverse().filter((l) => l.trim().startsWith("{"))
  for (const c of [...lines, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    try {
      const j = JSON.parse(c)
      if (!j || typeof j !== "object" || (!("promote" in j) && !("new" in j))) continue
      // promote entries: a ticket id, or {"id", "engineer"}
      const promote: number[] = [], assign: Record<number, string> = {}
      for (const x of Array.isArray(j.promote) ? j.promote : []) {
        const id = Number(x && typeof x === "object" ? x.id : x)
        if (!Number.isInteger(id)) continue
        promote.push(id)
        if (ENGINEERS.includes(x?.engineer)) assign[id] = x.engineer
      }
      return {
        promote,
        new: Array.isArray(j.new) ? j.new.filter((n: NewTicket) => n && typeof n.title === "string" && n.title.trim()) : [],
        note: String(j.note ?? ""),
        ...(Object.keys(assign).length ? { assign } : {}),
        ...(typeof j.week === "string" && j.week.trim() ? { week: j.week.trim() } : {}),
        ...(Array.isArray(j.programs) && j.programs.length ? { programs: j.programs.filter((x: Split) => Number.isInteger(x?.from) && Array.isArray(x.tickets)) } : {}),
      }
    } catch {}
  }
  return null
}

/**
 * Apply a plan with the rules in code: owner-only work is never promoted or created (listed as needs owner),
 * only S/M become ready, at most 3 promoted + 3 new, new titles go through isDuplicate, ready queue capped at 4.
 * dry = do everything inside a savepoint, then roll it back: the result says what WOULD happen.
 */
export function applyPlan(db: DB, project: string, plan: Plan, dry = false, verdicts?: Map<string, boolean>, twins?: Map<string, number>): Applied {
  const out: Applied = { promoted: [], created: [], needsOwner: [], skipped: [] }
  if (loadProjects()[project]?.autoPromote === false) return { ...out, skipped: [`${project} has auto_promote: off, nothing is promoted or queued`] }
  const base = policyCtx(project)
  const ready = () => (db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE project=? AND status='ready' AND ${unblocked()}`).get(project) as { n: number }).n
  db.exec("SAVEPOINT lead")
  try {
    for (const id of plan.promote) {
      const t = db.prepare("SELECT * FROM tickets WHERE id=? AND project=?").get(id, project) as Ticket | undefined
      const label = t ? `${t.title} · #${t.id}` : `#${id}` // names first, the number as a tag at the end
      if (!t || t.status !== "backlog") out.skipped.push(`${label}: not in the backlog`)
      else if (agentFiled(db, t.id) || needsOwner(`${t.title} ${t.done_when}`, verdicts, { ...base, title: t.title })) out.needsOwner.push(label)
      else if (t.size === "L") out.skipped.push(`${label}: size L, split it first`)
      else if (out.promoted.length >= MAX_PROMOTE) out.skipped.push(`${label}: over ${MAX_PROMOTE} promotions this run`)
      else if (ready() >= READY_CAP) out.skipped.push(`${label}: ready queue full (${READY_CAP})`)
      else {
        setTicket(db, t.id, { status: "ready", ...(plan.assign?.[t.id] ? { engineer: plan.assign[t.id] } : {}) })
        out.promoted.push(label)
      }
    }
    for (const n of plan.new) {
      const title = n.title.trim()
      if (needsOwner(`${title} ${n.done_when ?? ""}`, verdicts, { ...base, title })) out.needsOwner.push(`new: ${title}`)
      else if (out.created.length >= MAX_NEW) out.skipped.push(`new: ${title}: over ${MAX_NEW} new this run`)
      else if (isDuplicate(db, project, title)) out.skipped.push(`new: ${title}: duplicate`)
      else if (twins?.has(title)) out.skipped.push(`new: ${title}: same work as #${twins.get(title)}`)
      else {
        const size = ["S", "M", "L"].includes(String(n.size)) ? String(n.size) : "M"
        const status = size !== "L" && ready() < READY_CAP ? "ready" : "backlog"
        const { id } = addTicket(db, { project, title, done_when: n.done_when ?? "", size, priority: Math.max(0, Math.min(100, Number(n.priority) || 50)), goal: goalFor(db, project, n.goal), depends_on: parentFor(db, project, n.depends_on) })
        setTicket(db, id, { status, note: `Engineering Manager: ${n.why ?? ""}`.trim(), engineer: ENGINEERS.includes(n.engineer ?? "") ? n.engineer! : null })
        out.created.push(`${title} · #${id} (${status}, ${size})`)
      }
    }
    for (const sp of plan.programs ?? []) {
      const l = db.prepare("SELECT * FROM tickets WHERE id=? AND project=?").get(sp.from, project) as Ticket | undefined
      const parts = sp.tickets.filter((n) => n && typeof n.title === "string" && n.title.trim() && !needsOwner(`${n.title} ${n.done_when ?? ""}`, verdicts, { ...base, title: n.title }) && !isDuplicate(db, project, n.title.trim()))
      if (!l || l.size !== "L" || !l.prd || !["backlog", "ready"].includes(l.status)) out.skipped.push(`program from #${sp.from}: needs an L ticket with a PRD`)
      else if ((out.programs ?? []).length >= MAX_PROGRAMS) out.skipped.push(`program from #${sp.from}: one new program per run`)
      else if (parts.length < PROGRAM_TICKETS[0]) out.skipped.push(`program from #${sp.from}: fewer than ${PROGRAM_TICKETS[0]} usable tickets`)
      else {
        const ids = parts.slice(0, PROGRAM_TICKETS[1]).map((n) => {
          const size = n.size === "M" ? "M" : "S"
          const { id } = addTicket(db, { project, title: n.title.trim(), done_when: `${n.done_when ?? ""}\nPart of "${sp.title ?? l.title}" (PRD on #${l.id}).`.trim(), size, priority: l.priority, goal: l.goal })
          setTicket(db, id, { status: "backlog", note: `Engineering Manager: split from #${l.id}`, engineer: ENGINEERS.includes(n.engineer ?? "") ? n.engineer! : null })
          return id
        })
        const pid = addProgram(db, { project, title: sp.title?.trim() || l.title, goal: l.goal, source_ticket: l.id, tickets: ids })
        setTicket(db, l.id, { status: "split", note: `split into program #${pid}: #${ids.join(", #")}` })
        ;(out.programs ??= []).push(`program #${pid} from #${l.id}: #${ids.join(", #")}`)
      }
    }
    db.exec(dry ? "ROLLBACK TO lead; RELEASE lead" : "RELEASE lead")
  } catch (e) {
    db.exec("ROLLBACK TO lead; RELEASE lead")
    throw e
  }
  return out
}

/**
 * No-AI fallback (audit #2): when the queue is still under LOW_WATER after a Lead run (it chose badly, failed or found nothing),
 * promote the top pickable S/M backlog tickets by goal rank, then priority, up to READY_CAP. Same rules as a plan (applyPlan).
 */
export function fallbackPromote(db: DB, project: string): Applied {
  const ready = (db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE project=? AND status='ready' AND ${unblocked()}`).get(project) as { n: number }).n
  if (ready >= LOW_WATER) return { promoted: [], created: [], needsOwner: [], skipped: [] }
  const gs = activeGoals(db, project)
  const { pickable } = splitBacklog(db, project, (id) => gs.find((g) => g.id === id)?.rank)
  const ids = pickable.filter((t) => t.size !== "L").slice(0, READY_CAP - ready).map((t) => t.id)
  return applyPlan(db, project, { promote: ids, new: [], note: "fallback" }, false, cachedVerdicts(db, pickable))
}

/** Active (not paused) projects with nothing ready (or, while the 5-hour window sits idle, fewer than READY_CAP ready) whose Lead has not run in 10 minutes. */
export function leadDue(db: DB, projects: Record<string, Project>, now = Date.now(), idle = false): Project[] {
  return Object.values(projects).filter((p) => {
    if (p.paused || p.autoPromote === false || paused(db, { kind: "planning", project: p.name })) return false
    const ready = (db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE project=? AND status='ready' AND ${unblocked()}`).get(p.name) as { n: number }).n
    const last = Number((db.prepare("SELECT v FROM kv WHERE k=?").get(`lead-at:${p.name}`) as { v: string } | undefined)?.v ?? 0)
    // A run that found nothing to promote or write sleeps up to 6 h, unless the backlog size changed since (20 Oct audit: ~112 idle runs a day per project)
    const noop = (db.prepare("SELECT v FROM kv WHERE k=?").get(`lead-noop:${p.name}`) as { v: string } | undefined)?.v?.split(":")
    const backlog = (db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE project=? AND status='backlog' AND dup_of IS NULL").get(p.name) as { n: number }).n
    if (noop && now - Number(noop[0]) < 6 * 3600_000 && Number(noop[1]) === backlog) return false
    return ready < (idle ? READY_CAP : LOW_WATER) && now - last >= EVERY_MS
  })
}

export const today = (d = new Date()) => d.toLocaleDateString("sv") // YYYY-MM-DD, local time

export function leadReport(project: string, plan: Plan, a: Applied, dry: boolean) {
  const list = (xs: string[]) => xs.join("; ") || "none"
  return `Engineering Manager · ${project} · ${new Date().toTimeString().slice(0, 5)}${dry ? " (dry run: nothing changed)" : ""}\nnote: ${plan.note || "-"}\npromoted: ${list(a.promoted)}\nnew: ${list(a.created)}\nneeds owner: ${list(a.needsOwner)}\nskipped: ${list(a.skipped)}${a.programs?.length ? `\nprograms: ${list(a.programs)}` : ""}`
}

/** A "Roadmap" heading in the rules or a root .md of the repo, first 4000 chars from it. */
// ponytail: first match only, cut at 4000 chars rather than at the next heading; add a roadmap: path in dobby.md if it picks the wrong doc.
function roadmap(p: Project) {
  const docs = existsSync(p.repo) ? readdirSync(p.repo).filter((f) => f.endsWith(".md") && !f.includes(".original.")).map((f) => readFileSync(`${p.repo}/${f}`, "utf8")) : []
  for (const src of [p.rules, ...docs]) {
    const i = src.search(/^#+ .*roadmap/im)
    if (i >= 0) return src.slice(i, i + 4000)
  }
  return "(none)"
}

/** Monday from 06:30 IST, once per Monday: the week's plan (Opus). */
export function weeklyDue(db: DB, projects: Record<string, Project>, now = Date.now()): Project[] {
  const t = ist(now)
  if (t.getUTCDay() !== 1 || t.getUTCHours() * 60 + t.getUTCMinutes() < 6 * 60 + 30) return []
  return Object.values(projects).filter((p) => !p.paused && p.autoPromote !== false && !paused(db, { kind: "planning", project: p.name }) && (db.prepare("SELECT v FROM kv WHERE k=?").get(`em-week-at:${p.name}`) as { v: string } | undefined)?.v !== istDay(now))
}

const WEEKLY = `\n\nTODAY IS MONDAY: ALSO WRITE THIS WEEK'S PLAN. Order the week's work by goal (what ships first, what waits on what, what "done" looks like on Friday), using the board above. Pick and assign as usual for today; the daily runs follow your plan.
Add a "week" field to your JSON line: 4-8 plain lines (joined with \\n), ticket ids where they exist.`

/** The Lead prompt: role text and the Monday block first, the board (changes every run) last, so the prompt cache reuses the prefix. */
export const leadPrompt = (roleBody: string, project: string, weekly: boolean, context: string) =>
  `${roleBody.replaceAll("{project}", project)}${weekly ? WEEKLY : ""}\n\n${context}`

const State = Annotation.Root({
  project: Annotation<string>,
  dry: Annotation<boolean>,
  weekly: Annotation<boolean>,
  context: Annotation<string>,
  picks: Annotation<Plan>, // the Lead's plan (a state key may not share a node's name)
  applied: Annotation<Applied>,
  summary: Annotation<string>,
})
type S = typeof State.State

export function buildLeadGraph(db: DB, c = claude) {
  const proj = (s: S) => loadProjects()[s.project]

  const gather = async (s: S): Promise<Partial<S>> => {
    const p = proj(s)
    const gs = syncGoals(db, p.name, p.rules)
    const rank = (id: number | null) => gs.find((g) => g.id === id)?.rank
    // Jev judges a few of the flagged tickets (cached per ticket), then the backlog splits into pickable and owner-only
    if (!s.dry) {
      const todo = splitBacklog(db, p.name).unjudged.slice(0, WARM)
      cacheVerdicts(db, todo, await ownerVerdicts(todo, undefined, p.name, db, p.jev))
    }
    const { pickable, owner } = splitBacklog(db, p.name, rank)
    const q = (where: string, ...args: unknown[]) => db.prepare(`SELECT * FROM tickets WHERE project=? AND dup_of IS NULL AND ${where}`).all(p.name, ...args) as Ticket[]
    const fmt = (t: Ticket, notes = 0) => `#${t.id} [${t.size} p${t.priority}${rank(t.goal) ? ` G${t.goal}` : ""}] ${t.title}${t.done_when ? ` | done when: ${clip(t.done_when, 200)}` : ""}${notes && t.note ? `\n    note: ${clip(t.note, notes)}` : ""}`
    const block = (name: string, ts: Ticket[], notes = 0) => `${name}:\n${ts.map((t) => fmt(t, notes)).join("\n") || "(none)"}`
    const week = new Date(Date.now() - 7 * DAY).toISOString()
    const ideas = db.prepare("SELECT id, title, why FROM ideas WHERE project=? AND dup_of IS NULL AND status IN ('new','proposed','approved') ORDER BY score DESC NULLS LAST, id LIMIT 15").all(p.name) as { id: number; title: string; why: string | null }[]
    await netRun("git", ["fetch", "-q", "origin", p.base], p.repo)
    const commits = (await shAsync(`git log --oneline -20 origin/${p.base}`, p.repo, 4000, { timeoutMs: timeoutMs("git") })).out.trim()
    const context = [
      `GOALS (the owner's, most important first; rank work by which goal it moves):\n${goalsText(gs)}`,
      `GOAL AND RULES:\n${p.rules}`,
      `ROADMAP:\n${roadmap(p)}`,
      `PRODUCT MANAGER TODAY:\n${(db.prepare("SELECT v FROM kv WHERE k=?").get(`pm:${p.name}:${istDay()}`) as { v: string } | undefined)?.v ?? "(no note yet)"}`,
      `THIS WEEK'S PLAN (written Monday):\n${(db.prepare("SELECT v FROM kv WHERE k=?").get(`em:week:${p.name}`) as { v: string } | undefined)?.v ?? "(none yet)"}`,
      `LAST 20 COMMITS ON ${p.base}:\n${commits}`,
      block("READY (queued for Builders)", q("status='ready' ORDER BY priority DESC")),
      block("RUNNING", q("status='running'")),
      block("WAITING FOR OWNER APPROVAL", q("status='approval'"), 400),
      block("FAILED, LAST 7 DAYS", q("status='failed' AND updated_at>=?", week), 600),
      block("SHIPPED, LAST 7 DAYS (summaries may mention follow-ups)", q("status='shipped' AND updated_at>=?", week), 400),
      `L TICKETS WITH A PRD (split each into a program):\n${q("size='L' AND prd IS NOT NULL AND status IN ('backlog','ready')").map((t) => `${fmt(t)}\n    PRD: ${clip(t.prd ?? "", 3000)}`).join("\n") || "(none)"}`,
      block("BACKLOG YOU MAY PICK FROM, TOP 40 (goal rank, then priority)", pickable.slice(0, 40)),
      `OWNER-ONLY BACKLOG (${owner.length}; only the owner may start these: never promote them, never re-create them, and do not list them as needs-owner):\n${owner.slice(0, 15).map((t) => `#${t.id} ${t.title}`).join("\n") || "(none)"}${owner.length > 15 ? `\n+${owner.length - 15} more` : ""}`,
      `IDEAS, TOP 15:\n${ideas.map((i) => `- ${i.title}${i.why ? ` (${clip(i.why, 150)})` : ""}`).join("\n") || "(none)"}`,
    ].join("\n\n")
    return { context }
  }

  const plan = async (s: S): Promise<Partial<S>> => {
    const p = proj(s)
    const role = loadRole("lead")
    const r = await c(db, {
      project: p.name, kind: s.weekly ? "lead-week" : "lead", model: (s.weekly ? role.meta.model_weekly : role.meta.model) ?? "sonnet", effort: role.meta.effort, cwd: readOnlyDir(db, p), stallMs: 3 * 60_000,
      args: ["--setting-sources", "project", "--allowedTools", LEAD_TOOLS.join(","), "--disallowedTools", LEAD_DENY.join(",")],
      prompt: leadPrompt(role.body, p.name, s.weekly, s.context),
    })
    if (signedOut(r)) throw new Error(`Claude is signed out: ${r.reason ?? r.text}`.slice(0, 200)) // claude() pinged the owner; runLeads stops
    const parsed = r.ok ? parsePlan(r.text) : null
    return { picks: parsed ?? { promote: [], new: [], note: r.ok ? `unreadable plan: ${clip(r.text, 120)}` : `lead run failed: ${r.reason}` } }
  }

  const apply = async (s: S): Promise<Partial<S>> => {
    // Jev reads each ticket the word list flagged (skipped for projects with `jev: off`)
    const ids = s.picks.promote.map((id) => getTicket(db, id)).filter((t): t is Ticket => !!t && t.project === s.project)
    const texts = [...ids.map((t) => ({ title: t.title, done_when: t.done_when })), ...s.picks.new, ...(s.picks.programs ?? []).flatMap((sp) => sp.tickets)]
    // verdicts already cached per ticket are reused; new ones from Jev are cached for next time
    const verdicts = new Map([...cachedVerdicts(db, ids), ...await ownerVerdicts(texts, undefined, s.project, db, proj(s).jev)])
    if (!s.dry) cacheVerdicts(db, ids, verdicts)
    // Jev also spots near-duplicates the exact-title check misses (reworded titles for the same work); no answer = file it
    const twins = new Map<string, number>()
    if (proj(s).jev) await Promise.all(s.picks.new.map(async (n) => { const id = await sameWork(n.title.trim(), nearTickets(db, s.project, n.title)); if (id) twins.set(n.title.trim(), id) }))
    return { applied: applyPlan(db, s.project, s.picks, s.dry, verdicts, twins) }
  }

  const report = async (s: S): Promise<Partial<S>> => {
    const text = leadReport(s.project, s.picks, s.applied, s.dry)
    if (!s.dry && s.weekly && s.picks.week) {
      db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`em:week:${s.project}`, s.picks.week)
      await team({ kind: "lead", project: s.project }, `🗓 This week · ${s.project}\n${s.picks.week}`)
    }
    if (!s.dry) {
      // Discord only: the report in the project channel, and each newly ready ticket's thread starts with the Lead's pick
      // the report posts only when something is left for the owner; promotions show in each ticket's thread below
      if (s.applied.needsOwner.length) await team({ kind: "lead", project: s.project }, text)
      for (const label of [...s.applied.promoted, ...s.applied.created.filter((c) => c.includes("(ready"))]) {
        const t = getTicket(db, Number(label.match(/· #(\d+)/)?.[1]))
        if (t) await team({ kind: "ticket", project: t.project, ticket: t.id, title: t.title, step: "picked" }, `📌 Picked: ${t.title} · #${t.id}${t.engineer ? `\nAssigned to the ${t.engineer} Engineer` : ""}`)
      }
      const k = `lead:${s.project}:${today()}`
      const prev = (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
      db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(k, prev ? `${prev}\n\n${text}` : text) // a second run the same day appends
    }
    return { summary: text }
  }

  return new StateGraph(State)
    .addNode("gather", gather)
    .addNode("plan", plan)
    .addNode("apply", apply)
    .addNode("report", report)
    .addEdge(START, "gather")
    .addEdge("gather", "plan")
    .addEdge("plan", "apply")
    .addEdge("apply", "report")
    .addEdge("report", END)
}

/**
 * One Engineering Manager run (weekly = the Monday plan). Not paused, or it throws. Real runs stamp lead-at first, so a crash still waits 6 hours.
 * Signed out is not a crash: nothing ran, so the stamps go back and the run happens once the owner logs in.
 */
export async function runLead(db: DB, project: string, dry = false, weekly = false, c = claude) {
  const p = loadProjects()[project]
  if (!p) throw new Error(`no dobby.md for ${project}`)
  if (p.paused) throw new Error(`${project} is paused`)
  if (p.autoPromote === false) throw new Error(`${project} has auto_promote: off`)
  const pz = paused(db, { kind: "planning", project })
  if (pz) throw new Error(`${project} planning ${pz}`)
  const keys = dry ? [] : [`lead-at:${project}`, ...(weekly ? [`em-week-at:${project}`] : [])]
  const before = keys.map((k) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v)
  if (!dry) db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`lead-at:${project}`, String(Date.now()))
  if (!dry && weekly) db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`em-week-at:${project}`, istDay())
  try {
    const out = await buildLeadGraph(db, c).compile().invoke({ project, dry, weekly })
    const ap = out.applied as Applied | undefined
    let report = out.summary as string
    if (!dry && ap) {
      const fb = fallbackPromote(db, project)
      if (fb.promoted.length) {
        ap.promoted.push(...fb.promoted)
        const line = `Engineering Manager · ${project}: the queue was still short, so ${fb.promoted.length} ticket(s) were promoted by goal rank without the model: ${fb.promoted.join("; ")}`
        report += `\n${line}` // in the run's summary only: nothing here for the owner to do
      }
    }
    if (!dry && !weekly) {
      const backlog = (db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE project=? AND status='backlog' AND dup_of IS NULL").get(project) as { n: number }).n
      // lead-noop sleeps the next runs for hours: only when the run found nothing at all, and nothing was left for the owner either (audit #2)
      if (ap && !ap.promoted.length && !ap.created.length && !ap.needsOwner.length) db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`lead-noop:${project}`, `${Date.now()}:${backlog}`)
      else db.prepare("DELETE FROM kv WHERE k=?").run(`lead-noop:${project}`)
    }
    return { plan: out.picks as Plan, report }
  } catch (e) {
    if (/^Claude is signed out/.test((e as Error).message))
      keys.forEach((k, i) => before[i] === undefined ? db.prepare("DELETE FROM kv WHERE k=?").run(k) : db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(k, before[i]))
    throw e
  }
}

/** The tick's Engineering Manager runs: Monday's weekly plans, then the daily top-ups. Signed out: the first run stops the rest (claude() already pinged once). */
export async function runLeads(db: DB, idle: boolean, c = claude): Promise<string[]> {
  const out: string[] = []
  try {
    for (const p of weeklyDue(db, loadProjects())) out.push((await runLead(db, p.name, false, true, c)).report)
    for (const p of leadDue(db, loadProjects(), Date.now(), idle)) out.push((await runLead(db, p.name, false, false, c)).report)
  } catch (e) {
    if (!/^Claude is signed out/.test((e as Error).message)) throw e
    out.push(`lead runs stop: ${(e as Error).message}`)
  }
  return out
}

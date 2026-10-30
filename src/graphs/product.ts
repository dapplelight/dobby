// The Product Manager graph (absorbs the Strategist): per app, which problems are worth solving next, ranked by the
// owner's goals, plus lean PRDs for L tickets. Daily from 06:00 IST on Opus; after it, the Area PM (Sonnet) digs into
// one area of the app a day (projects/<app>.md `areas:`, in rotation) and leaves notes for the next PM run.
//
//   START → gather → think → apply → END
//
// gather reads goals, board and notes (no AI). think is one read-only run (roles/product-manager.md or area-pm.md).
// apply files problems (fixes, UX, features) straight into the backlog for the Engineering Manager, posts only genuinely
// new ideas to #<app>-ideas (👍 = ticket; owner, 17 Oct: ideas are new bets, not fixes), writes PRDs into L tickets,
// and keeps the run's note in kv for the Engineering Manager and the Chief of Staff.
import { paused } from "../pause.ts"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import type { DB } from "../db.ts"
import { platform, type Platform } from "../chat/platform.ts"
import { nearTickets, sameWork } from "../jev.ts"
import { clip } from "../notify.ts"
import { readOnlyDir, addTicket, claude, company, goalFor, goalsText, istDay, ist, isDuplicate, loadProjects, loadRole, setTicket, syncGoals, type Project, type Ticket } from "../lib.ts"

export type Problem = { type: "problem"; title: string; goal?: number; score?: number; why?: string; evidence?: string; size?: string; experiment?: string }
export type Idea = { type: "idea"; title: string; pitch?: string; why?: string; how?: string; experiment?: string; size?: string; goal?: number }
export type Card = Problem | Idea | { type: "prd"; ticket: number; prd: string } | { type: "note"; text: string }
export type Mode = "pm" | "area"
const POSTS: Record<Mode, number> = { pm: 2, area: 0 } // new ideas only: at most 2 a day, from the PM
const MAX_PRDS = 2

const postIdea: Platform["postIdea"] = async (i) => (await platform()).postIdea(i)
const kvGet = (db: DB, k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
const kvSet = (db: DB, k: string, v: string) => db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(k, v)

/** The run's JSON lines, strictly: unknown shapes are dropped. */
export function parseCards(text: string): Card[] {
  const out: Card[] = []
  for (const line of text.split("\n")) {
    try {
      const c = JSON.parse(line.trim())
      if ((c?.type === "problem" || c?.type === "idea") && typeof c.title === "string" && c.title.trim()) out.push(c)
      else if (c?.type === "prd" && Number.isInteger(c.ticket) && typeof c.prd === "string" && c.prd.trim()) out.push(c)
      else if (c?.type === "note" && typeof c.text === "string") out.push(c)
    } catch {}
  }
  return out
}

/** Problems (best score first) become backlog tickets for the Engineering Manager; new ideas are stored and posted; PRDs go into this project's L tickets that have none. */
export async function applyCards(db: DB, project: string, mode: Mode, cards: Card[], post: typeof postIdea = postIdea, twin: (title: string) => Promise<number | null> = async () => null) {
  const now = new Date().toISOString()
  const ins = db.prepare("INSERT INTO ideas (project,title,source,lens,why,evidence,size,experiment,score,goal,status,created_at) VALUES (?,?,?,'problem',?,?,?,?,?,?,'proposed',?) RETURNING id")
  const problems = cards.filter((c): c is Problem => c.type === "problem").sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
  const sizeOf = (x: unknown) => (["S", "M", "L"].includes(String(x)) ? String(x) : null)
  let stored = 0
  for (const p of problems) {
    const title = p.title.trim().slice(0, 200)
    if (isDuplicate(db, project, title) || (await twin(title))) continue
    const score = Math.max(0, Math.min(100, Number(p.score) || 0))
    const { id } = ins.get(project, title, mode, p.why ?? null, p.evidence ?? null, sizeOf(p.size), p.experiment ?? null, score, goalFor(db, project, p.goal), now) as { id: number }
    const t = addTicket(db, { project, title, done_when: p.experiment ?? "", size: sizeOf(p.size) ?? "M", priority: score, goal: goalFor(db, project, p.goal) })
    setTicket(db, t.id, { status: "backlog", note: `from the Product Manager (idea #${id})` })
    db.prepare("UPDATE ideas SET status='approved' WHERE id=?").run(id)
    stored++
  }
  const insIdea = db.prepare("INSERT INTO ideas (project,title,source,lens,why,evidence,size,experiment,goal,status,created_at) VALUES (?,?,?,'idea',?,?,?,?,?,'proposed',?) RETURNING id")
  let posted = 0
  for (const i of cards.filter((c): c is Idea => c.type === "idea").slice(0, POSTS[mode])) {
    const title = i.title.trim().slice(0, 120)
    if (isDuplicate(db, project, title)) continue
    const { id } = insIdea.get(project, title, mode, [i.pitch, i.why].filter(Boolean).join(" ") || null, i.how ?? null, sizeOf(i.size), i.experiment ?? null, goalFor(db, project, i.goal), now) as { id: number }
    await post({ id, project, title, pitch: i.pitch, why: i.why, how: i.how, experiment: i.experiment, size: sizeOf(i.size) })
    posted++
  }
  const prds: number[] = []
  for (const c of cards) {
    if (c.type !== "prd" || prds.length >= MAX_PRDS) continue
    const t = db.prepare("SELECT id FROM tickets WHERE id=? AND project=? AND size='L' AND prd IS NULL").get(c.ticket, project) as { id: number } | undefined
    if (t) setTicket(db, t.id, { prd: c.prd.trim().slice(0, 12_000) }), prds.push(t.id)
  }
  const note = cards.find((c): c is { type: "note"; text: string } => c.type === "note")?.text ?? ""
  return { stored, posted, prds, note }
}

/** Apps with areas (not paused) whose PM has not run today, from 06:00 IST. */
export function pmDue(db: DB, projects: Record<string, Project>, now = Date.now()): Project[] {
  if (ist(now).getUTCHours() < 6) return []
  return Object.values(projects).filter((p) => !p.paused && !paused(db, { kind: "planning", project: p.name }) && p.areas?.length && kvGet(db, `pm-at:${p.name}`) !== istDay(now))
}
/** After today's PM run: one Area PM run per app per day. */
export const areaDue = (db: DB, projects: Record<string, Project>, now = Date.now()): Project[] =>
  Object.values(projects).filter((p) => !p.paused && !paused(db, { kind: "planning", project: p.name }) && p.areas?.length && kvGet(db, `pm-at:${p.name}`) === istDay(now) && kvGet(db, `area-at:${p.name}`) !== istDay(now))
/** Today's area: the next one in the list after the last run's (kv area:next:<app>). */
export const nextArea = (db: DB, p: Project) => { const a = p.areas ?? []; return a[Number(kvGet(db, `area:next:${p.name}`) ?? 0) % a.length] }

const READ_ONLY = ["--setting-sources", "project", "--allowedTools", "Read,Glob,Grep,WebSearch,Bash(graphify:*)", "--disallowedTools", "Edit,Write,NotebookEdit,WebFetch"]

const State = Annotation.Root({
  project: Annotation<string>,
  mode: Annotation<Mode>,
  area: Annotation<string>,
  context: Annotation<string>,
  cards: Annotation<Card[]>,
  why: Annotation<string>, // why the run produced nothing, if it did not
  result: Annotation<string>,
})
type S = typeof State.State

/** The PM prompt: role text and the founder's rules first, today's board last, so the prompt cache reuses the prefix. */
export const pmPrompt = (roleBody: string, project: string, area: string, context: string) =>
  `${roleBody.replaceAll("{project}", project).replaceAll("{area}", area)}${company()}\n\n${context}`

/** Real Opus PM runs take 2.5-3.7 min (audit #13: a 3 min stall guard killed them and 19 Oct's PM produced nothing). */
export const PM_STALL_MS = 10 * 60_000

export function buildProductGraph(db: DB, post: typeof postIdea = postIdea) {
  const gather = (s: S): Partial<S> => {
    const p = loadProjects()[s.project]
    const gs = syncGoals(db, p.name, p.rules)
    const q = (where: string, ...args: unknown[]) => db.prepare(`SELECT * FROM tickets WHERE project=? AND dup_of IS NULL AND ${where}`).all(p.name, ...args) as Ticket[]
    const list = (ts: Ticket[]) => ts.map((t) => `#${t.id} [${t.size} ${t.status}${t.goal ? ` G${t.goal}` : ""}] ${t.title}${t.note && t.status === "failed" ? ` | why: ${clip(t.note, 200)}` : ""}`).join("\n") || "(none)"
    const ideas = db.prepare("SELECT title, status FROM ideas WHERE project=? AND dup_of IS NULL AND status!='new' ORDER BY id DESC LIMIT 60").all(p.name) as { title: string; status: string }[]
    const seeds = db.prepare("SELECT title FROM ideas WHERE project=? AND status='new' AND dup_of IS NULL").all(p.name) as { title: string }[]
    const week = new Date(Date.now() - 7 * 86400_000).toISOString()
    const notes = (db.prepare("SELECT k, v FROM kv WHERE k LIKE ? ORDER BY k DESC LIMIT 3").all(`area:${p.name}:%`) as { k: string; v: string }[]).map((r) => `${r.k.split(":").slice(2).join(":")}: ${r.v}`)
    const context = [
      `GOALS (the owner's, most important first):\n${goalsText(gs)}`,
      `PROJECT RULES:\n${p.rules}`,
      ...(s.mode === "pm" ? [
        `AREA PM NOTES (latest first):\n${notes.join("\n") || "(none yet)"}`,
        `FOUNDER SEED IDEAS (develop each honestly):\n${seeds.map((x) => `- ${x.title}`).join("\n") || "(none)"}`,
        `L TICKETS WITHOUT A PRD:\n${list(q("size='L' AND prd IS NULL AND status IN ('backlog','ready') ORDER BY priority DESC LIMIT 5"))}`,
      ] : []),
      `OPEN TICKETS (top 40):\n${list(q("status IN ('backlog','ready','running','fixing') ORDER BY priority DESC LIMIT 40"))}`,
      `SHIPPED OR FAILED, LAST 7 DAYS:\n${list(q("status IN ('shipped','failed') AND updated_at>=?", week))}`,
      `IDEAS ALREADY ON THE LIST (do not repeat):\n${ideas.map((i) => `- ${i.title} [${i.status}]`).join("\n") || "(none)"}`,
    ].join("\n\n")
    return { context }
  }

  const think = async (s: S): Promise<Partial<S>> => {
    const p = loadProjects()[s.project]
    const role = loadRole(s.mode === "pm" ? "product-manager" : "area-pm")
    const r = await claude(db, {
      project: p.name, kind: s.mode === "pm" ? "pm" : "area-pm", model: role.meta.model ?? (s.mode === "pm" ? "opus" : "sonnet"), effort: role.meta.effort,
      cwd: readOnlyDir(db, p), stallMs: PM_STALL_MS, args: READ_ONLY,
      prompt: pmPrompt(role.body, p.name, s.area ?? "", s.context),
    })
    return r.ok ? { cards: parseCards(r.text), why: "" } : { cards: [], why: `run failed: ${r.reason}` }
  }

  const apply = async (s: S): Promise<Partial<S>> => {
    const a = await applyCards(db, s.project, s.mode, s.cards, post, loadProjects()[s.project]?.jev ? (t) => sameWork(t, nearTickets(db, s.project, t)) : undefined)
    if (s.mode === "pm") db.prepare("UPDATE ideas SET status='proposed' WHERE project=? AND status='new' AND source='you'").run(s.project) // seeds were developed
    if (a.note) kvSet(db, s.mode === "pm" ? `pm:${s.project}:${istDay()}` : `area:${s.project}:${istDay()}:${s.area}`, a.note)
    const who = s.mode === "pm" ? "Product Manager" : `Product Manager (${s.area})`
    return { result: `${who} · ${s.project}: ${a.stored} problem(s) to the backlog, ${a.posted} new idea(s) posted${a.prds.length ? `, PRD for #${a.prds.join(", #")}` : ""}${s.why ? ` (${s.why})` : ""}${a.note ? `\nnote: ${a.note}` : ""}` }
  }

  return new StateGraph(State)
    .addNode("gather", gather)
    .addNode("think", think)
    .addNode("apply", apply)
    .addEdge(START, "gather")
    .addEdge("gather", "think")
    .addEdge("think", "apply")
    .addEdge("apply", END)
}

/** One PM (or Area PM) run. Stamps the day first, so a crash still waits until tomorrow. */
export async function runProduct(db: DB, project: string, mode: Mode = "pm", post: typeof postIdea = postIdea): Promise<string> {
  const p = loadProjects()[project]
  if (!p) throw new Error(`no dobby.md for ${project}`)
  const pz = paused(db, { kind: "planning", project })
  if (pz) return `${project}: planning ${pz}`
  let area = ""
  if (mode === "pm") kvSet(db, `pm-at:${project}`, istDay())
  else {
    if (!p.areas?.length) return `${project}: no areas: in its dobby.md, so no Area PM`
    area = nextArea(db, p)
    kvSet(db, `area-at:${project}`, istDay())
    kvSet(db, `area:next:${project}`, String((p.areas.indexOf(area) + 1) % p.areas.length))
  }
  const out = await buildProductGraph(db, post).compile().invoke({ project, mode, area })
  return out.result as string
}

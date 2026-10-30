// The Program Manager graph: keeps multi-ticket work moving, per app, every cycle while a program is open. Mostly no AI.
//
//   START → sweep → launch → status → END
//
// sweep: tickets whose PR merged become shipped, closed PRs become declined (whole app, not only programs); a failed
//        program ticket is re-queued once with Tester's notes; then only the first unfinished ticket of each program is ready
//        (the order is the plan: later tickets wait in the backlog).
// launch: a program whose tickets all finished gets one launch check against its PRD (Sonnet, low effort, text-only).
//         Gaps become new program tickets (at most 2 checks); ready = done.
// status: one living message per program in #<app>-tickets (upsert, edited in place; only when it changed).
import { paused } from "../pause.ts"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import type { DB } from "../db.ts"
import { chatOn as discordOn, platform } from "../chat/platform.ts"
import { clip } from "../notify.ts"
import { fixed, addTicket, claude, getTicket, loadRole, netRun, policyCtx, setTicket, short, type ARun, type Ticket } from "../lib.ts"
import { needsOwner } from "./lead.ts"

export type Program = { id: number; project: string; title: string; goal: number | null; source_ticket: number | null; status: string; checks: number }
const DONE = ["shipped", "declined"]
const MAX_CHECKS = 2, MAX_GAPS = 3, MAX_PR_LOOKUPS = 5, PR_RECHECK_MS = 10 * 60_000

const kvGet = (db: DB, k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
const kvSet = (db: DB, k: string, v: string) => db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(k, v)
const now = () => new Date().toISOString()

export const openPrograms = (db: DB, project: string) => db.prepare("SELECT * FROM programs WHERE project=? AND status='open' ORDER BY id").all(project) as Program[]
export const programTickets = (db: DB, id: number) =>
  db.prepare("SELECT t.* FROM program_tickets pt JOIN tickets t ON t.id=pt.ticket WHERE pt.program=? ORDER BY pt.pos").all(id) as Ticket[]

/** A new program: its tickets in build order (backlog; sweep makes the first one ready). */
export function addProgram(db: DB, p: { project: string; title: string; goal: number | null; source_ticket?: number | null; tickets: number[] }) {
  const { id } = db.prepare("INSERT INTO programs (project,title,goal,source_ticket,created_at,updated_at) VALUES (?,?,?,?,?,?) RETURNING id").get(p.project, p.title, p.goal, p.source_ticket ?? null, now(), now()) as { id: number }
  p.tickets.forEach((t, i) => db.prepare("INSERT OR IGNORE INTO program_tickets VALUES (?,?,?)").run(id, t, i))
  return id
}

/**
 * Merged PR = shipped, closed PR = declined, for this app's tickets stuck in fixing/failed/approval with a PR link.
 * Audit #21 (27 gh calls a tick, always the 10 oldest, some never checked): least recently checked first (kv prcheck:<id> =
 * when), each at most every 10 minutes, at most `cap` gh calls per run, off the event loop with a timeout.
 */
export async function closeFinishedPrs(db: DB, project: string, r: ARun = netRun, now = Date.now(), cap = MAX_PR_LOOKUPS): Promise<string[]> {
  const out: string[] = []
  const rows = db.prepare(`SELECT t.id, t.note FROM tickets t LEFT JOIN kv ON kv.k='prcheck:'||t.id
    WHERE t.project=? AND t.status IN ('fixing','failed','approval') AND t.note LIKE '%github.com/%/pull/%' AND COALESCE(CAST(kv.v AS INTEGER), 0) <= ?
    ORDER BY COALESCE(CAST(kv.v AS INTEGER), 0), t.id LIMIT ?`).all(project, now - PR_RECHECK_MS, cap) as { id: number; note: string }[]
  for (const t of rows) {
    const url = t.note.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0]
    kvSet(db, `prcheck:${t.id}`, String(now))
    if (!url) continue
    const v = await r("gh", ["pr", "view", url, "--json", "state", "--jq", ".state"])
    const state = v.ok ? v.out.trim() : ""
    if (state === "MERGED") setTicket(db, t.id, { status: "shipped", note: url }), out.push(`#${t.id} shipped (PR merged)`)
    else if (state === "CLOSED") setTicket(db, t.id, { status: "declined", note: `PR closed: ${url}` }), out.push(`#${t.id} closed (PR closed)`)
  }
  return out
}

/** Re-queue failed program tickets once (with Tester's notes), then make each program's next ticket ready. */
export function moveForward(db: DB, project: string): string[] {
  const out: string[] = [], requeued: string[] = []
  for (const pg of openPrograms(db, project)) {
    for (const t of programTickets(db, pg.id)) {
      if (t.status !== "failed" || kvGet(db, `pgm:requeued:${t.id}`)) continue
      kvSet(db, `pgm:requeued:${t.id}`, now())
      db.prepare("UPDATE tickets SET done_when=? WHERE id=?").run(`${t.done_when}\nProgram Manager re-queued it once; last Tester notes: ${clip(t.note ?? "", 600)}`, t.id)
      setTicket(db, t.id, { status: "ready", note: "re-queued once by the Program Manager with Tester's notes" })
      out.push(`#${t.id} re-queued with Tester's notes`)
      requeued.push(t.title)
    }
    const next = programTickets(db, pg.id).find((t) => !DONE.includes(t.status))
    if (next?.status === "backlog") setTicket(db, next.id, { status: "ready" }), out.push(`#${next.id} is next in "${pg.title}"`)
  }
  // one line per pass, not one per ticket: a program with several failures was a burst in #system-status (#640)
  if (requeued.length) fixed(db, requeued.length === 1 ? `${project}: "${requeued[0]}" failed. The Program Manager re-queued it once with Tester's notes.` : `${project}: ${requeued.length} program tickets failed. The Program Manager re-queued each once with Tester's notes:\n${requeued.map((x) => `• ${x}`).join("\n")}`)
  return out
}

/** The launch check's JSON line. null = unreadable (no gaps, not ready). */
export function parseLaunch(text: string): { ready: boolean; gaps: { title: string; done_when?: string; size?: string }[]; note: string } | null {
  const line = text.trim().split("\n").reverse().find((l) => l.trim().startsWith("{"))
  try {
    const j = JSON.parse(line ?? "")
    return { ready: j.ready === true, gaps: Array.isArray(j.gaps) ? j.gaps.filter((g: { title?: unknown }) => typeof g?.title === "string" && g.title.trim()) : [], note: String(j.note ?? "") }
  } catch {
    return null
  }
}

const ICON: Record<string, string> = { shipped: "✅", declined: "➖", running: "🔨", fixing: "🔁", ready: "▶️", failed: "⚠️", backlog: "⏳", approval: "🟡" }
/** The living status message: one line per ticket, in order. */
export function statusText(pg: Program, ts: Ticket[], note = "") {
  const done = ts.filter((t) => DONE.includes(t.status)).length
  const next = ts.find((t) => !DONE.includes(t.status))
  return [
    `📈 ${short(pg.title)} · ${pg.status === "done" ? "launched ✅" : `${done}/${ts.length} done`}`,
    ...ts.map((t) => `${ICON[t.status] ?? "•"} ${short(t.title)}`),
    ...(pg.status !== "done" && next ? [`Next: ${short(next.title)}${next.status === "failed" ? " (stuck after two tries: the Engineering Manager re-plans it)" : ""}`] : []),
    ...(note ? [note] : []),
  ].join("\n")
}

const State = Annotation.Root({
  project: Annotation<string>,
  notes: Annotation<Record<number, string>>, // launch-check notes per program, for the status line
  log: Annotation<string[]>({ reducer: (a, b) => a.concat(b), default: () => [] }),
})
type S = typeof State.State

export type Deps = { run: ARun; claude: typeof claude; upsert: (key: string, project: string, text: string) => Promise<unknown> }
const realUpsert = async (key: string, project: string, text: string) => {
  const ddb = discordOn()
  if (ddb) await (await platform()).upsert(ddb, key, { kind: "program", project }, text).catch((e) => console.log(`discord: ${(e as Error).message}`))
}

export function buildProgramGraph(db: DB, deps: Deps = { run: netRun, claude, upsert: realUpsert }) {
  const sweep = async (s: S): Promise<Partial<S>> => ({ log: [...(await closeFinishedPrs(db, s.project, deps.run)), ...moveForward(db, s.project)] })

  const launch = async (s: S): Promise<Partial<S>> => {
    const notes: Record<number, string> = {}, log: string[] = []
    for (const pg of openPrograms(db, s.project)) {
      const ts = programTickets(db, pg.id)
      if (!ts.length || ts.some((t) => !DONE.includes(t.status))) continue
      const prd = pg.source_ticket ? getTicket(db, pg.source_ticket)?.prd : null
      const role = loadRole("program-manager")
      db.prepare("UPDATE programs SET checks=checks+1, updated_at=? WHERE id=?").run(now(), pg.id)
      // text-only (--tools ""): eligible for API credits
      const r = await deps.claude(db, {
        project: s.project, kind: "launch-check", model: role.meta.model ?? "sonnet", effort: role.meta.effort, args: ["--setting-sources", "project", "--tools", ""],
        prompt: `${role.body.replaceAll("{project}", s.project)}\n\nPROGRAM: ${pg.title}\n\nPRD:\n${prd ?? "(none: judge by the program title and the tickets)"}\n\nTICKETS:\n${ts.map((t) => `#${t.id} [${t.status}] ${t.title} | done when: ${clip(t.done_when, 300)}`).join("\n")}`,
      })
      const v = r.ok ? parseLaunch(r.text) : null
      const gaps = (v?.gaps ?? []).filter((g) => !needsOwner(`${g.title} ${g.done_when ?? ""}`, undefined, { ownerWords: policyCtx(s.project).ownerWords })).slice(0, MAX_GAPS)
      if (v?.ready || pg.checks + 1 >= MAX_CHECKS || (v && !gaps.length)) {
        db.prepare("UPDATE programs SET status='done', updated_at=? WHERE id=?").run(now(), pg.id)
        notes[pg.id] = v?.note || (v ? "" : "launch check unreadable; closed after the last check")
        log.push(`program #${pg.id} done${v?.ready ? "" : " (checks used up)"}`)
      } else {
        const pos = ts.length
        gaps.forEach((g, i) => {
          const { id } = addTicket(db, { project: s.project, title: g.title.trim(), done_when: g.done_when ?? "", size: g.size === "M" ? "M" : "S", goal: pg.goal })
          setTicket(db, id, { status: "backlog", note: `Program Manager: launch gap in "${pg.title}"` })
          db.prepare("INSERT OR IGNORE INTO program_tickets VALUES (?,?,?)").run(pg.id, id, pos + i)
        })
        notes[pg.id] = v?.note ?? ""
        log.push(`program #${pg.id}: ${gaps.length} launch gap(s) added`)
      }
    }
    return { notes, log }
  }

  const status = async (s: S): Promise<Partial<S>> => {
    const changed: string[] = []
    const rows = db.prepare("SELECT * FROM programs WHERE project=? AND (status='open' OR updated_at>=?)").all(s.project, new Date(Date.now() - 86400_000).toISOString()) as Program[]
    for (const pg of rows) {
      const text = statusText(pg, programTickets(db, pg.id), s.notes?.[pg.id] ?? "")
      if (kvGet(db, `program:text:${pg.id}`) === text) continue // nothing new: no edit
      await deps.upsert(`program:${pg.id}`, s.project, text)
      kvSet(db, `program:text:${pg.id}`, text)
      changed.push(`#${pg.id}`)
    }
    return { log: changed.length ? [`status updated: ${changed.join(", ")}`] : [] }
  }

  return new StateGraph(State)
    .addNode("sweep", sweep)
    .addNode("launch", launch)
    .addNode("status", status)
    .addEdge(START, "sweep")
    .addEdge("sweep", "launch")
    .addEdge("launch", "status")
    .addEdge("status", END)
}

/** Every cycle, per active app: cheap when nothing changed (no AI, no Discord edit). */
export async function runPrograms(db: DB, project: string, deps?: Deps) {
  if (paused(db, { kind: "planning", project })) return []
  const out = await buildProgramGraph(db, deps).compile().invoke({ project, notes: {} })
  return (out.log as string[]).map((l) => `Program Manager · ${project}: ${l}`)
}

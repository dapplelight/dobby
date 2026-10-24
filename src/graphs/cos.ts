// The Chief of Staff graph: the owner's morning brief on Discord (launchd, 07:30).
//
//   START → gather → write → send → END
//
// gather reads the last 24 hours from the DB (no AI). write is one Haiku call; when it fails or breaks the format,
// a plain template built from the same facts goes out instead: the brief always sends.
// send posts the brief (first line = the one thing to do), then one Approve/Decline message per ticket waiting at the gate.
import { pauseList } from "../pause.ts"
import { capacityFromDb } from "../db.ts"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import type { DB } from "../db.ts"
import { plain } from "../health.ts"
import { claude, loadProjects, loadRole, readUsage, type Project, type Usage } from "../lib.ts"
import { clip, notify, shortTitle, takeOutbox } from "../telegram.ts"
import { today } from "./lead.ts"
import { reviewsFromDb } from "./review.ts"
import { autonomy, autonomyLine, usageLine } from "../usage.ts"
import { zonedDay } from "../config.ts"

const DAY = 24 * 3600_000

export type Facts = {
  done: { project: string; id: number; title: string; status: string; pr: string | null }[]
  waiting: { project: string; id: number; title: string; checker: string }[]
  ready: { project: string; id: number; title: string }[]
  leads: { project: string; text: string }[]
  health: string[]
  spend: number
  usage: Usage | null
  active: string[]
  paused: string[]
  pauses?: string[] // what is paused right now (src/pause.ts), plain words with since/until
}

/** Money never leaves the finance app: any amount with a currency sign or code becomes [amount]. */
export const noMoney = (s: string) => s.replace(/(?:[$₹€£]|\b(?:rs|inr|usd)\.?)\s?\d+(?:[,.]\d+)*(?:\s?(?:k|lakhs?|cr|crores?)\b)?/gi, "[amount]")

/** The newest Engineering Manager report per project (a day's value holds every run, the same plan again and again), minus "needs owner" items whose ticket is shipped or declined. */
function newestLeads(db: DB, days: string[]) {
  const best = new Map<string, { day: string; v: string }>()
  for (const r of db.prepare("SELECT k, v FROM kv WHERE k LIKE 'lead:%'").all() as { k: string; v: string }[]) {
    const [, project, day] = r.k.split(":")
    if (days.includes(day) && day >= (best.get(project)?.day ?? "")) best.set(project, { day, v: r.v })
  }
  const settled = (label: string) => {
    const id = Number((label.match(/· #(\d+)/) ?? label.match(/^#(\d+)/))?.[1]) // "title · #9"; "#9 title" in reports from before 24 Oct
    const st = id ? (db.prepare("SELECT status FROM tickets WHERE id=?").get(id) as { status: string } | undefined)?.status : undefined
    return st === "shipped" || st === "declined"
  }
  return [...best].map(([project, { v }]) => {
    const text = v.split(/\n\n(?=Engineering Manager · )/).at(-1)!.split("\n").map((l) => {
      if (!l.startsWith("needs owner: ")) return l
      const keep = l.slice(13).split("; ").filter((x) => !settled(x))
      return `needs owner: ${keep.join("; ") || "none"}`
    }).join("\n")
    return { project, text }
  })
}

export function gather(db: DB, projects: Record<string, Project>, usage: Usage | null, now = Date.now()): Facts {
  const since = new Date(now - DAY).toISOString()
  const rows = (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args) as { id: number; project: string; title: string; status: string; note: string | null }[]
  const days = [today(new Date(now)), today(new Date(now - DAY))]
  const lastCheck = (db.prepare("SELECT MAX(at) AS at FROM checks").get() as { at: string | null }).at
  const checksFrom = lastCheck ? new Date(Date.parse(lastCheck) - 5 * 60_000).toISOString() : "" // one health pass = rows within a few seconds
  return {
    done: rows("SELECT * FROM tickets WHERE status IN ('shipped','failed','declined') AND NOT (status='shipped' AND onto IS NOT NULL) AND dup_of IS NULL AND updated_at>=? ORDER BY updated_at", since)
      .map((t) => ({ project: t.project, id: t.id, title: t.title, status: t.status, pr: t.note?.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0] ?? null })),
    waiting: rows("SELECT * FROM tickets WHERE status='approval' ORDER BY id").map((t) => ({ project: t.project, id: t.id, title: t.title, checker: t.note?.match(/Checker: (.*)/)?.[1] ?? "" })),
    ready: rows("SELECT * FROM tickets WHERE status='ready' ORDER BY priority DESC, id"),
    leads: newestLeads(db, days),
    health: lastCheck ? (db.prepare("SELECT name, detail FROM checks WHERE ok=0 AND at>=?").all(checksFrom) as { name: string; detail: string }[]).map((c) => plain(`${c.name}: ${c.detail}`)) : [],
    spend: (db.prepare("SELECT COALESCE(SUM(cost_usd),0) AS s FROM runs WHERE at>=?").get(since) as { s: number }).s,
    usage,
    active: Object.values(projects).filter((p) => !p.paused).map((p) => p.name),
    paused: Object.values(projects).filter((p) => p.paused).map((p) => p.name),
    pauses: pauseList(db, now).map((x) => x.text),
  }
}

const name = (p: string) => p[0].toUpperCase() + p.slice(1)
/** The brief's one budget line: percent of the windows and how much shipped alone, never dollars or cache stats (owner, 16 Oct). */
export function budgetLine(db: DB, u: Usage | null, now = Date.now()) {
  const a = autonomy(db, 1, now)
  return `Budget: ${u ? `5-hour ${u.fiveUsed}%, week ${u.weekUsed}%` : "unknown"} · ${a.alone} of ${a.shipped} shipped without you`
}
/** Lines from the Lead reports that start with `key:`, without the empty ones. */
const leadLines = (f: Facts, key: string) => f.leads.flatMap((l) => l.text.split("\n").filter((x) => x.startsWith(`${key}: `) && !/: (none|-)$/.test(x)).map((x) => ({ project: l.project, text: x.slice(key.length + 2) })))

/** The facts as plain text for the model. */
export function factsText(f: Facts) {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n") || "- none"
  return [
    `FINISHED (shipped, failed or declined):\n${list(f.done.map((t) => `${t.project} ${t.status}: ${shortTitle(t.title)}`))}`,
    `WAITING FOR THE OWNER'S OK (Approve/Decline buttons follow the brief; Approve merges it, Decline drops it):\n${list(f.waiting.map((t) => `${t.project}: ${shortTitle(t.title)}`))}`,
    `QUEUED FOR TODAY:\n${list(f.ready.map((t) => `${t.project}: ${shortTitle(t.title)}`))}`,
    `ENGINEERING MANAGER REPORTS:\n${f.leads.map((l) => l.text).join("\n\n") || "- none"}`,
    `HEALTH PROBLEMS:\n${list(f.health)}`,
    `ACTIVE PROJECTS: ${f.active.join(", ")}. PAUSED: ${f.paused.join(", ") || "none"}.${f.pauses?.length ? ` PAUSED BY THE OWNER RIGHT NOW (say so in the brief): ${f.pauses.join("; ")}.` : ""}`,
  ].join("\n\n")
}

/** The no-AI brief: the one thing to do first, other owner items, what shipped, what is building. */
export function fallbackBrief(f: Facts) {
  const section = (title: string, items: string[]) => (items.length ? [title, ...items.slice(0, 3).map((x) => `• ${x}`)] : [])
  const owner = [
    ...f.waiting.map((t) => `${name(t.project)}: ${shortTitle(t.title)}. Approve merges it, Decline drops it (1 min, buttons below)`),
    ...leadLines(f, "needs owner").map((l) => `${name(l.project)}: ${clip(l.text.replace(/\s*· #\d+|#\d+\s*/g, ""), 110)} (5 min, the Engineering Manager set it aside for you)`),
    ...f.health.map((h) => `Mac job: ${clip(h, 100)} (5 min)`),
  ]
  const [first, ...rest] = owner
  const wins = f.done.map((t) => `${name(t.project)}: ${t.status === "shipped" ? "" : `${t.status}, `}${shortTitle(t.title)}`)
  const queued = f.active.filter((p) => f.ready.some((t) => t.project === p)).map((p) => {
    const r = f.ready.filter((t) => t.project === p)
    return `${name(p)}: ${r.length} queued, next "${shortTitle(r[0].title)}"`
  })
  const notes = leadLines(f, "note").map((l) => `${name(l.project)}: ${clip(l.text, 100)}`).slice(-1)
  return noMoney([
    first ? `Do first: ${first}` : "Nothing needs you today.",
    ...section("Also for you", rest),
    ...section("Shipped", wins),
    ...section("Building today", [...queued, ...notes].slice(0, 2)),
    ...(f.paused.length ? [`${f.paused.map(name).join(", ")} paused.`] : []),
    ...(f.pauses?.length ? [`⏸ Paused: ${f.pauses.join("; ")}`] : []),
  ].join("\n"))
}

/** The model's brief is used only when it leads with the action, has the wins and today's work, and fits on a phone. */
export const briefOk = (text: string) => /^\W*(Do first|Nothing needs you)/i.test(text.trim()) && /^\W*Shipped\b/m.test(text) && /^\W*Building today\b/m.test(text) && text.split("\n").filter((l) => l.trim()).length <= 12

const State = Annotation.Root({
  dry: Annotation<boolean>,
  facts: Annotation<Facts>,
  brief: Annotation<string>,
  source: Annotation<string>, // haiku | template: <why>
  sent: Annotation<number>,
})
type S = typeof State.State

/** IST calendar day, for the once-a-day keys (health reads brief:sent:<day> at 09:00 IST). */
export const istDay = zonedDay

/** One short unsent-posts block for the top of the brief; the first few are tried again, the file is cleared. */
async function outboxBlock(send: typeof notify) {
  const lost = takeOutbox()
  if (!lost.length) return ""
  for (const m of lost.slice(0, 5)) await send(m.text, fetch, undefined, { kind: "brief" }) // fails again = back in outbox.log for tomorrow
  return `${lost.length} message${lost.length > 1 ? "s" : ""} could not be posted yesterday:\n${lost.slice(0, 5).map((m) => `• ${clip(m.text.split("\n")[0], 100)}`).join("\n")}\n\n`
}

export async function sendBrief(db: DB, s: { dry?: boolean; facts: Facts; brief: string; source?: string }, send: typeof notify = notify): Promise<{ sent: number }> {
  const pings = s.facts.waiting.map((t) => noMoney(`🟡 Waiting for you · ${shortTitle(t.title)} (${name(t.project)})${t.checker ? `\n\nChecked: ${clip(t.checker.split(/(?<=\.)\s/)[0], 200)}` : ""}`))
  if (s.dry) {
    console.log(`--- brief (${s.source}) ---\n${s.brief}\n${budgetLine(db, s.facts.usage)}\n${pings.map((p) => `--- ping ---\n${p}`).join("\n")}`)
    return { sent: 0 }
  }
  const reviews = new Date().getDay() === 1 ? reviewsFromDb(db) : "" // Mondays: the past week
  const text = `${await outboxBlock(send)}${s.brief}\n\n${budgetLine(db, s.facts.usage)}${reviews ? `\n${reviews}` : ""}`
  // one retry: at 08:05 the Mac may be just awake with no network yet (the first live send failed with "fetch failed")
  const ok = (await send(text, fetch, undefined, { kind: "brief" })) || (await new Promise((r) => setTimeout(r, 30_000)), await send(text, fetch, undefined, { kind: "brief" }))
  if (ok) db.prepare("INSERT OR REPLACE INTO kv VALUES (?, '1')").run(`brief:sent:${istDay()}`)
  // the detailed numbers (dollars, cache hits, windows) go to #system-status, once a day
  const k = `usage:posted:${istDay()}`
  if (!db.prepare("SELECT 1 FROM kv WHERE k=?").get(k)) {
    const cap = capacityFromDb(db)
    if (await send([usageLine(db, s.facts.usage), autonomyLine(db, 1), cap].filter(Boolean).join("\n"), fetch, undefined, { kind: "health" })) db.prepare("INSERT OR REPLACE INTO kv VALUES (?, '1')").run(k)
  }
  let sent = Number(ok)
  for (const [i, p] of pings.entries()) sent += Number(await send(p, fetch, [{ text: "✅ Approve", data: `approve ${s.facts.waiting[i].id}` }, { text: "✖️ Decline", data: `decline ${s.facts.waiting[i].id}` }], { kind: "approval" }))
  return { sent }
}

export function buildCosGraph(db: DB, send: typeof notify = notify) {
  const gatherNode = (): Partial<S> => ({ facts: gather(db, loadProjects(), readUsage()) })

  const write = async (s: S): Promise<Partial<S>> => {
    const role = loadRole("chief-of-staff")
    const r = await claude(db, {
      project: "dobby", kind: "cos", model: role.meta.model ?? "haiku", effort: role.meta.effort, args: ["--setting-sources", "project", "--tools", ""],
      prompt: `${role.body}\n\nFACTS (last 24 hours, ${today()}):\n${noMoney(factsText(s.facts))}`,
    })
    const text = noMoney(r.text.trim())
    if (r.ok && briefOk(text)) return { brief: !s.facts.pauses?.length || text.includes("⏸") ? text : `${text}\n⏸ Paused: ${s.facts.pauses.join("; ")}`, source: "haiku" }
    return { brief: fallbackBrief(s.facts), source: `template: ${r.ok ? "model broke the format" : r.reason}` }
  }

  const sendNode = (s: S) => sendBrief(db, s, send)

  return new StateGraph(State)
    .addNode("gather", gatherNode)
    .addNode("write", write)
    .addNode("send", sendNode)
    .addEdge(START, "gather")
    .addEdge("gather", "write")
    .addEdge("write", "send")
    .addEdge("send", END)
}

export async function runCos(db: DB, dry = false) {
  const out = await buildCosGraph(db).compile().invoke({ dry })
  return { brief: out.brief as string, source: out.source as string, sent: out.sent as number, pings: (out.facts as Facts).waiting.length }
}

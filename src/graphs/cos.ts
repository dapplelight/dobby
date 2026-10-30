// The Chief of Staff graph: the owner's morning summary (launchd, 08:05).
//
//   START → gather → send → END
//
// gather reads the last 24 hours from the DB; send builds the Brief (src/brief.ts, no model), writes <data>/briefs/<day>.md,
// posts it to Discord (a Components V2 message, plain Markdown if Discord refuses it), then one Approve/Decline message per ticket waiting at the gate.
import { mkdirSync, writeFileSync } from "node:fs"
import { pauseList } from "../pause.ts"
import { capacityFromDb, DATA } from "../db.ts"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import type { DB } from "../db.ts"
import { plain } from "../health.ts"
import { loadProjects, readUsage, type Project, type Usage } from "../lib.ts"
import { clip, notify, shortTitle, takeOutbox } from "../notify.ts"
import { buildBrief, briefMarkdown, briefParts, noMoney, richSections } from "../brief.ts"
import { autonomyLine, usageLine } from "../usage.ts"
import { today } from "./lead.ts"
import { zonedDay } from "../config.ts"

export { noMoney }
const DAY = 24 * 3600_000

export type Facts = {
  done: { project: string; id: number; title: string; status: string; pr: string | null; reason?: string }[]
  waiting: { project: string; id: number; title: string; checker: string; pr?: string | null }[]
  ready: { project: string; id: number; title: string }[]
  leads: { project: string; text: string }[]
  health: string[]
  spend: number
  usage: Usage | null
  active: string[]
  paused: string[]
  pauses?: string[] // what is paused right now (src/pause.ts), plain words with since/until
}

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
      .map((t) => ({ project: t.project, id: t.id, title: t.title, status: t.status, pr: t.note?.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0] ?? null, reason: t.status === "failed" ? clip(noMoney(t.note?.split("\n")[0] ?? ""), 80) : undefined })),
    waiting: rows("SELECT * FROM tickets WHERE status='approval' ORDER BY id").map((t) => ({ project: t.project, id: t.id, title: t.title, checker: t.note?.match(/(?:Tester|Checker): (.*)/)?.[1] ?? "", pr: t.note?.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0] ?? null })),
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


const State = Annotation.Root({
  dry: Annotation<boolean>,
  facts: Annotation<Facts>,
  brief: Annotation<string>,
  sent: Annotation<number>,
})
type S = typeof State.State

/** IST calendar day, for the once-a-day keys (health reads brief:sent:<day> at 09:00 IST). */
export const istDay = zonedDay

/** Unsent posts from yesterday (outbox.log): the first few are tried again, the file is cleared. Returns their first lines for the summary. */
async function outboxLines(send: typeof notify) {
  const lost = takeOutbox()
  for (const m of lost.slice(0, 5)) await send(m.text, fetch, undefined, { kind: "brief" }) // fails again = back in outbox.log for tomorrow
  return lost.slice(0, 5).map((m) => clip(m.text.split("\n")[0], 100))
}

/** What the dashboard keeps of a sent summary (kv brief:json:<day>). */
export type StoredBrief = { markdown: string; at: number; sentTo: string | null; ok: boolean }

export async function sendBrief(db: DB, s: { dry?: boolean; facts: Facts; now?: number; dir?: string; link?: string }, send: typeof notify = notify): Promise<{ sent: number; markdown: string }> {
  const now = s.now ?? Date.now()
  const pings = s.facts.waiting.map((t) => noMoney(`🟡 Waiting for you · ${shortTitle(t.title)} (${t.project})${t.checker ? `\n\nChecked: ${clip(t.checker.split(/(?<=\.)\s/)[0], 200)}` : ""}`))
  if (s.dry) {
    const markdown = briefMarkdown(buildBrief(db, s.facts, now))
    console.log(`--- brief ---\n${markdown}\n${pings.map((p) => `--- ping ---\n${p}`).join("\n")}`)
    return { sent: 0, markdown }
  }
  const b = buildBrief(db, s.facts, now, await outboxLines(send))
  const markdown = briefMarkdown(b)
  const day = b.day
  const dir = `${s.dir ?? DATA}/briefs`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/${day}.md`, `${markdown}\n`) // the archive: `dobby brief <day>` prints it
  const link = s.link ?? process.env.DOBBY_DASHBOARD_URL
  const to = { kind: "brief" as const, rich: { sections: richSections(b), plain: briefParts(b), link: link && /^https?:\/\//.test(link) ? link : undefined } }
  // one retry: at 08:05 the Mac may be just awake with no network yet (the first live send failed with "fetch failed")
  const ok = (await send(markdown, fetch, undefined, to)) || (await new Promise((r) => setTimeout(r, 30_000)), await send(markdown, fetch, undefined, to))
  if (ok) db.prepare("INSERT OR REPLACE INTO kv VALUES (?, '1')").run(`brief:sent:${day}`)
  const stored: StoredBrief = { markdown, at: now, sentTo: ok ? "Discord #daily-update" : null, ok: Boolean(ok) }
  db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`brief:json:${day}`, JSON.stringify(stored)) // the dashboard's Activity page shows this and where it went
  // the detailed numbers (dollars, cache hits, windows) go to #system-status, once a day
  const k = `usage:posted:${day}`
  if (!db.prepare("SELECT 1 FROM kv WHERE k=?").get(k)) {
    const cap = capacityFromDb(db)
    if (await send([usageLine(db, s.facts.usage), autonomyLine(db, 1), cap].filter(Boolean).join("\n"), fetch, undefined, { kind: "health" })) db.prepare("INSERT OR REPLACE INTO kv VALUES (?, '1')").run(k)
  }
  let sent = Number(ok)
  for (const [i, p] of pings.entries()) sent += Number(await send(p, fetch, [{ text: "✅ Approve", data: `approve ${s.facts.waiting[i].id}` }, { text: "✖️ Decline", data: `decline ${s.facts.waiting[i].id}` }], { kind: "approval" }))
  return { sent, markdown }
}

export function buildCosGraph(db: DB, send: typeof notify = notify) {
  const gatherNode = (): Partial<S> => ({ facts: gather(db, loadProjects(), readUsage()) })
  const sendNode = async (s: S): Promise<Partial<S>> => {
    const r = await sendBrief(db, s, send)
    return { sent: r.sent, brief: r.markdown }
  }
  return new StateGraph(State)
    .addNode("gather", gatherNode)
    .addNode("send", sendNode)
    .addEdge(START, "gather")
    .addEdge("gather", "send")
    .addEdge("send", END)
}

export async function runCos(db: DB, dry = false) {
  const out = await buildCosGraph(db).compile().invoke({ dry })
  return { brief: out.brief as string, sent: out.sent as number, pings: (out.facts as Facts).waiting.length }
}

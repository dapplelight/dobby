// One pause system with levels (kv `pause`). Pure check: paused(db, {kind, project?, ticket?}) -> reason | null.
//   all (everything, the tick exits), kinds (builders | reviews | merges | deploys | planning | scout | notify), projects (<name>), tickets (<id>).
// Each entry is {at, by, until?}; past `until` it is off (auto-resume). A project pause stops every kind for that project except scout and notify;
// a ticket pause stops its pickup (builders) and its merge. Old keys migrate on read: `builders:paused` -> kinds.builders, `paused:all` -> all.
// Running builds finish their step and keep their sessions; `pause everything` additionally kills the tick (cli.ts).
import type { DB } from "./db.ts"
import { config, zoned } from "./config.ts"

export const KINDS = ["builders", "reviews", "merges", "deploys", "planning", "scout", "notify"] as const
export type Kind = (typeof KINDS)[number]
export type Entry = { at: number; by: string; until?: number }
export type PauseState = { all?: Entry; kinds?: Partial<Record<Kind, Entry>>; projects?: Record<string, Entry>; tickets?: Record<string, Entry> }
export type Scope = { all: true } | { kind: Kind } | { project: string } | { ticket: number }
export type Paused = { at: number; by: string; until?: number }

const KEY = "pause"
const get = (db: DB, k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
const live = (e: Entry | undefined, now: number): Entry | undefined => (e && typeof e.at === "number" && (!e.until || e.until > now) ? e : undefined)

function read(db: DB): PauseState {
  let s: PauseState = {}
  try { s = JSON.parse(get(db, KEY) ?? "{}") ?? {} } catch {}
  // old keys: fold into the new state once, then delete them
  const legacyB = get(db, "builders:paused"), legacyA = get(db, "paused:all")
  if (legacyB || legacyA) {
    if (legacyB) { try { const p = JSON.parse(legacyB); if (typeof p?.at === "number") (s.kinds ??= {}).builders ??= { at: p.at, by: String(p.by ?? "owner") } } catch {} }
    if (legacyA) s.all ??= { at: Number(legacyA) || Date.now(), by: "the owner" }
    db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(KEY, JSON.stringify(s))
    db.prepare("DELETE FROM kv WHERE k IN ('builders:paused','paused:all')").run()
  }
  return s
}
const write = (db: DB, s: PauseState) => {
  if (!s.all && !Object.keys(s.kinds ?? {}).length && !Object.keys(s.projects ?? {}).length && !Object.keys(s.tickets ?? {}).length) db.prepare("DELETE FROM kv WHERE k=?").run(KEY)
  else db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(KEY, JSON.stringify(s))
}

const hm = (ms: number) => zoned(ms).toISOString().slice(5, 16).replace("T", " ") + ` ${config().timezoneLabel}`
/** "by the owner since 10-20 14:03 IST until 10-20 16:03 IST" */
export const describe = (e: Entry) => `by ${e.by} since ${hm(e.at)}${e.until ? ` until ${hm(e.until)}` : ""}`

/** The dashboard's own words: "Everything paused by you since 10:09" (today), "since Sun 10:09" (this week), "since 12 Oct" (older), in the configured timezone. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
export function plain(scope: string, e: Entry, now = Date.now()): string {
  const z = zoned(e.at), age = zoned(now).setUTCHours(0, 0, 0, 0) - new Date(z).setUTCHours(0, 0, 0, 0), time = z.toISOString().slice(11, 16)
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...o }).format(z)
  const when = age <= 0 ? time : age < 7 * 86_400_000 ? `${fmt({ weekday: "short" })} ${time}` : `${z.getUTCDate()} ${MONTHS[z.getUTCMonth()]}`
  const by = /^(the )?owner$/.test(e.by) ? "you" : e.by
  return `${scope[0].toUpperCase()}${scope.slice(1)} paused by ${by} since ${when}`
}

/** Why this work may not run now, or null. kind "all" asks only about the everything level (the tick). */
export function paused(db: DB, q: { kind: Kind | "all"; project?: string; ticket?: number }, now = Date.now()): string | null {
  const s = read(db)
  const hit = (label: string, e?: Entry) => { const l = live(e, now); return l ? `${label} paused ${describe(l)}` : null }
  const a = hit("everything", s.all)
  if (a || q.kind === "all") return a
  return hit(q.kind, s.kinds?.[q.kind])
    ?? (q.project && q.kind !== "scout" && q.kind !== "notify" ? hit(`project ${q.project}`, s.projects?.[q.project]) : null)
    ?? (q.ticket && (q.kind === "builders" || q.kind === "merges") ? hit(`ticket #${q.ticket}`, s.tickets?.[String(q.ticket)]) : null)
}

/** The builders level on its own (everything or builders, no project or ticket): the old `pausedState`. */
export function pausedState(db: DB, now = Date.now()): Paused | null {
  const s = read(db)
  const e = live(s.all, now) ?? live(s.kinds?.builders, now)
  return e ? { at: e.at, by: e.by, ...(e.until ? { until: e.until } : {}) } : null
}

/** Everything that is paused now, plain words, for the status board, the brief and the dashboard. */
export function pauseList(db: DB, now = Date.now()): { scope: string; at: number; by: string; until?: number; text: string; plain: string }[] {
  const s = read(db)
  const out: { scope: string; e: Entry }[] = []
  if (live(s.all, now)) out.push({ scope: "everything", e: s.all! })
  for (const [k, e] of Object.entries(s.kinds ?? {})) if (live(e, now)) out.push({ scope: k, e: e! })
  for (const [k, e] of Object.entries(s.projects ?? {})) if (live(e, now)) out.push({ scope: `project ${k}`, e })
  for (const [k, e] of Object.entries(s.tickets ?? {})) if (live(e, now)) out.push({ scope: `ticket #${k}`, e })
  return out.map(({ scope, e }) => ({ scope, at: e.at, by: e.by, ...(e.until ? { until: e.until } : {}), text: `${scope} ${describe(e)}`, plain: plain(scope, e, now) }))
}
export const pauseLine = (db: DB, now = Date.now()) => { const l = pauseList(db, now); return l.length ? `⏸ Paused: ${l.map((x) => x.text).join("; ")}` : "" }

const EFFECT: Record<Kind, string> = {
  builders: "no new tickets start; running ones finish their current step and keep their sessions",
  reviews: "no new reviews start",
  merges: "no pull request is merged; reviewed ones wait and land after resume",
  deploys: "deploys are queued and run on resume",
  planning: "the Lead, Product Managers and Program Manager do not run",
  scout: "the Talent Scout does not run",
  notify: "posts other than #needs-you are held in the outbox",
}
const name = (sc: Scope) => ("all" in sc ? "Everything" : "kind" in sc ? (sc.kind === "builders" ? "Builders" : sc.kind[0].toUpperCase() + sc.kind.slice(1)) : "project" in sc ? `Project ${sc.project}` : `Ticket #${sc.ticket}`)

/** Idempotent. `line` is the one plain sentence for #system-status (null when nothing changed); `reply` answers the owner. */
export function setPause(db: DB, sc: Scope, on: boolean, by = "owner", o: { until?: number; now?: number } = {}): { changed: boolean; line: string | null; reply: string } {
  const now = o.now ?? Date.now()
  const s = read(db)
  // drop expired entries while we are here
  const prune = <T extends Record<string, Entry> | undefined>(m: T) => { for (const k of Object.keys(m ?? {})) if (!live((m as Record<string, Entry>)[k], now)) delete (m as Record<string, Entry>)[k] }
  prune(s.kinds); prune(s.projects); prune(s.tickets); if (!live(s.all, now)) delete s.all
  const slot = (): [Record<string, Entry>, string] | null =>
    "all" in sc ? null : "kind" in sc ? [(s.kinds ??= {}) as Record<string, Entry>, sc.kind] : "project" in sc ? [(s.projects ??= {}), sc.project] : [(s.tickets ??= {}), String(sc.ticket)]
  const sl = slot()
  const cur = sl ? sl[0][sl[1]] : s.all
  const label = "kind" in sc && sc.kind === "builders" ? "Builders" : name(sc)
  if (on === !!cur && (!on || !o.until || cur?.until === o.until)) return { changed: false, line: null, reply: on ? `${label} ${"all" in sc ? "is" : label === "Builders" ? "are" : "is"} already paused.` : `${label} ${label === "Builders" ? "are" : "is"} not paused.` }
  if (on) { const e: Entry = { at: cur?.at ?? now, by: cur?.by ?? by, ...(o.until ? { until: o.until } : {}) }; if (sl) sl[0][sl[1]] = e; else s.all = e }
  else if (sl) delete sl[0][sl[1]]
  else delete s.all
  write(db, s)
  const until = o.until ? ` until ${hm(o.until)}` : ""
  const eff = "kind" in sc ? EFFECT[sc.kind] : "all" in sc ? "nothing new starts and the tick stops" : "project" in sc ? "nothing new starts, reviews, merges or deploys for it" : "it is not picked up and its pull request does not merge"
  if (sc && "kind" in sc && sc.kind === "builders") {
    const running = (db.prepare("SELECT count(*) n FROM tickets WHERE status='running'").get() as { n: number }).n
    return on
      ? { changed: true, line: `Builders paused by ${by}${until}: no new tickets start; ${running} running finish their current step and keep their sessions. Resume to start again.`, reply: `Paused${until}. No new tickets start; ${running} running finish their step.` }
      : { changed: true, line: `Builders resumed by ${by}: new tickets start again within a minute.`, reply: "Resumed. Builders start again within a minute." }
  }
  const rest = pauseList(db, now).map((x) => x.scope)
  return on
    ? { changed: true, line: `${label} paused by ${by}${until}: ${eff}. Resume to start again.`, reply: `Paused ${label.toLowerCase()}${until}: ${eff}.` }
    : { changed: true, line: `${label} resumed by ${by}.`, reply: `Resumed ${label.toLowerCase()}.${rest.length ? ` Still paused: ${rest.join(", ")}.` : ""}` }
}

/** Back-compat: the old builders-only switch. */
export const setPaused = (db: DB, on: boolean, by = "owner", now = Date.now()) => setPause(db, { kind: "builders" }, on, by, { now })

const DUR = /^for\s+(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)$/i
/**
 * `pause [all|<kind>|project <name>|ticket <id>] [for 30m|2h|1d]`, `resume [...]`, `pause status` (also "pause everything", "stop all", "unpause").
 * null = not a pause command. A bare pause/resume is the builders level.
 */
export function parsePause(text: string, now = Date.now()): { on: boolean; scope: Scope; until?: number } | { status: true } | { error: string } | null {
  const w = text.trim().replace(/\s+/g, " ")
  const m = w.match(/^(pause|stop|resume|unpause|start)(?: (.*))?$/i)
  if (!m) return null
  const on = /^(pause|stop)$/i.test(m[1])
  let rest = (m[2] ?? "").trim()
  const legacy = /^(everything|all|dobby|foreman)\b/i.test(rest)
  if (/^(stop|start)$/i.test(m[1]) && !legacy) return null // "start"/"stop" alone are not ours
  if (/^status$/i.test(rest) && /^pause$/i.test(m[1])) return { status: true }
  let until: number | undefined
  const d = rest.match(/(?:^| )(for .*)$/i)
  if (d) {
    const x = d[1].match(DUR)
    if (!x) return { error: "How long? Use for 30m, for 2h or for 1d." }
    if (!on) return { error: "Resume does not take a time." }
    until = now + Number(x[1]) * ({ m: 60_000, h: 3600_000, d: 86_400_000 } as Record<string, number>)[x[2][0].toLowerCase()]
    rest = rest.slice(0, d.index).trim()
  }
  const r = rest.toLowerCase()
  if (!r) return { on, scope: { kind: "builders" }, until }
  if (/^(everything|all|dobby|foreman)$/.test(r)) return { on, scope: { all: true }, until }
  if ((KINDS as readonly string[]).includes(r)) return { on, scope: { kind: r as Kind }, until }
  const p = rest.match(/^project ([\w-]+)$/i), t = rest.match(/^ticket #?(\d+)$/i)
  if (p) return { on, scope: { project: p[1] }, until }
  if (t) return { on, scope: { ticket: Number(t[1]) }, until }
  return { error: `Pause what? Say: pause, pause all, pause ${KINDS.join("|")}, pause project <name>, pause ticket <id> (add "for 30m" to auto-resume).` }
}

// What the owner reads: the CLI help and ticket list, and the status board (one message that is edited, plus the instant "status" reply).
// No AI anywhere in here.
import { pauseLine } from "./pause.ts"
import type { DB } from "./db.ts"
import { api, kv, setKv, upsert } from "./discord.ts"
import { istDay, short } from "./lib.ts"
import { costliest, weekPoints } from "./savings.ts"
import { config } from "./config.ts"
import { tzOffset, zoned, zonedDay } from "./config.ts"
import { clip, readSecrets } from "./telegram.ts"

/** The help is the usage comment at the top of cli.ts (one source): its `//` lines up to the first line of code. */
export function helpText(src: string) {
  const lines = src.split("\n")
  const end = lines.findIndex((l) => !l.startsWith("//"))
  return lines.slice(0, end < 0 ? lines.length : end).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")
}

const STAGES: [string, string[]][] = [["Building", ["running", "fixing"]], ["Ready", ["ready"]], ["Waiting", ["approval", "split"]], ["Failed", ["failed"]]]
export type Row = { id: number; status: string; project: string; title: string; note: string | null; updated_at: string }

/** "35m", "2h", "3d" */
export function age(iso: string, now = Date.now()) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

/** Open tickets by stage, then app, then oldest first; 10 rows per stage; titles first, ids last. Failed ones say why. */
export function listView(rows: Row[], now = Date.now(), perStage = 10) {
  const out: string[] = []
  for (const [name, statuses] of STAGES) {
    const rs = rows.filter((r) => statuses.includes(r.status)).sort((a, b) => a.project.localeCompare(b.project) || a.updated_at.localeCompare(b.updated_at))
    if (!rs.length) continue
    out.push(`${name} (${rs.length})`)
    for (const r of rs.slice(0, perStage)) {
      out.push(`  ${short(r.title)}  ${r.project}  ${age(r.updated_at, now)}  #${r.id}`)
      if (name === "Failed" && r.note) out.push(`    why: ${clip(r.note, 70)}`)
    }
    if (rs.length > perStage) out.push(`  +${rs.length - perStage} more`)
  }
  return out.join("\n") || "nothing open"
}

const n = (db: DB, sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as { title: string; note: string | null }[]
const list = (xs: string[], max = 4) => xs.slice(0, max).join(", ") + (xs.length > max ? ` +${xs.length - max} more` : "")

/**
 * When the tick last ran: the newest of tick:last (written by tick), health:last-tick and health:lasttick (the health check; audit #11: the
 * board read the first spelling while health.ts wrote the second). Values are ms, an ISO time, or health's "Last tick: 14:03 IST" (the latest past 14:03 IST).
 */
export function lastTick(db: DB, now = Date.now()) {
  const get = (k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
  const parse = (raw: string | undefined) => {
    if (raw === undefined) return NaN
    if (/^\d+$/.test(raw)) return Number(raw)
    const hm = raw.match(new RegExp(`(\\d\\d):(\\d\\d) (IST|${config().timezoneLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`)) // the configured label; IST = values written before it was configurable
    if (hm) { // today's IST clock time, or yesterday's when that is still ahead
      const dayStart = Date.parse(zonedDay(now)) - tzOffset(now)
      const t = dayStart + (Number(hm[1]) * 60 + Number(hm[2])) * 60_000
      return t > now ? t - 86_400_000 : t
    }
    return Date.parse(raw)
  }
  const all = ["tick:last", "health:last-tick", "health:lasttick"].map((k) => parse(get(k))).filter((x) => !isNaN(x))
  return all.length ? Math.max(...all) : null
}

/** The board: what is building, what waits on a review fix, what shipped today (IST), what failed this week and why, and when the scheduler last ran. */
export function statusText(db: DB, now = Date.now()) {
  const building = n(db, "SELECT title, note FROM tickets WHERE status='running' ORDER BY updated_at")
  const fixing = n(db, "SELECT title, note FROM tickets WHERE status='fixing' ORDER BY updated_at")
  // fix pushes (onto set) land on an open PR and are rework, not a shipped ticket (audit #12)
  const shipped = n(db, `SELECT title, note FROM tickets WHERE status='shipped' AND onto IS NULL AND date(updated_at, '${tzOffset(now) >= 0 ? "+" : ""}${tzOffset(now) / 60_000} minutes') = ?`, istDay(now))
  const stuck = n(db, "SELECT title, note FROM tickets WHERE status='failed' AND updated_at>=? ORDER BY updated_at DESC", new Date(now - 7 * 86_400_000).toISOString())
  const stuckAll = (db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status='failed'").get() as { n: number }).n
  const tick = lastTick(db, now)
  const hhmm = tick ? zoned(tick).toISOString().slice(11, 16) : "unknown"
  return [
    `🔨 Building now (${building.length})${building.length ? `: ${list(building.map((t) => short(t.title)))}` : ""}`,
    ...(fixing.length ? [`🔁 Waiting on a review fix (${fixing.length})`] : []),
    `✅ Shipped today (${shipped.length})`,
    `⚠️ Stuck (${stuck.length}${stuckAll > stuck.length ? ` this week, ${stuckAll} failed in all` : ""})${stuck.length ? `: ${list(stuck.map((t) => `${short(t.title)} - ${clip(t.note ?? "no reason recorded", 60)}`), 3)}` : ""}`,
    ...(config().ticketBudget ? costLine(db, now) : []),
    ...(pauseLine(db, now) ? [pauseLine(db, now)] : []),
    ...(healthLine(db) ? [healthLine(db)] : []),
    `🕒 Last tick ${hhmm}`,
  ].join("\n")
}

/** "💸 Costliest tickets this week: ..." in percent of the week; [] when nothing cost anything. Only with ticketBudget configured. */
export function costLine(db: DB, now = Date.now()): string[] {
  const top = costliest(db, 3, now)
  return top.length ? [`💸 Costliest tickets: ${top.map((t) => `${short(t.title)} ${weekPoints(t.usd).toFixed(2)}%`).join(", ")} of the week`] : []
}

/** The last stored checks (health job), for the status board and the dashboard: [] before the first run. */
export function healthSnapshot(db: DB): { check: string; ok: boolean; text: string }[] {
  try { return (JSON.parse((db.prepare("SELECT v FROM kv WHERE k='health:pipeline'").get() as { v: string } | undefined)?.v ?? "{}").checks ?? []) } catch { return [] }
}
/** "🩺 Health: all 10 checks ok" or the problems; "" before the first health run. */
export function healthLine(db: DB) {
  const hs = healthSnapshot(db)
  if (!hs.length) return ""
  const bad = hs.filter((h) => !h.ok)
  return bad.length ? `🩺 Health: ${bad.map((h) => h.text).join(" · ").slice(0, 400)}` : `🩺 Health: all ${hs.length} checks ok`
}

/** The word "status" on its own (the front desk answers it without AI). */
export const isStatusAsk = (text: string) => /^\s*((?:dobby|foreman)\s+)?status[\s?!.]*$/i.test(text)

/**
 * The one status message in #daily-update (kv discord:msg:status), edited at the end of every tick: edits never ping, and it is skipped when
 * nothing changed. Records the tick time in kv tick:last. Pinned on its first post when the bot may (it needs Manage Messages; failure is ignored).
 */
export async function updateBoard(db: DB, on: boolean, fetcher: typeof fetch = fetch, now = Date.now()) {
  setKv(db, "tick:last", String(now))
  if (!on) return
  const text = `📋 Status\n${statusText(db, now)}`
  if (kv(db, "status:text") === text) return
  const fresh = !kv(db, "discord:msg:status")
  const id = await upsert(db, "status", { kind: "brief" }, text, undefined, fetcher)
  setKv(db, "status:text", text)
  const token = readSecrets().DISCORD_BOT_TOKEN
  if (fresh && token) await api(token, "PUT", `/channels/${kv(db, "discord:ch:daily-update")}/pins/${id}`, undefined, fetcher).catch(() => {})
}

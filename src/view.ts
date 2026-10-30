// What the owner reads: the CLI help and ticket list, and the status board (one message that is edited, plus the instant "status" reply).
// No AI anywhere in here.
import { lastTick } from "./health.ts"
import { pauseLine, paused } from "./pause.ts"
import type { DB } from "./db.ts"
import { kv, setKv } from "./chat/common.ts"
import { platform } from "./chat/platform.ts"
import { apiKeyMode, capOverride, istDay, paceCap, readUsage, short, spendAllows, USAGE_STALE_MS, weekCapSetting, type Usage } from "./lib.ts"
import { weekPerFive } from "./usage.ts"
import { costliest, prCost, prCostText, weekPoints } from "./savings.ts"
import { config, tzOffset, zoned, zonedDay } from "./config.ts"
import { clip, readSecrets, shortTitle } from "./notify.ts"
import { homedir } from "node:os"
import { JOBS, ownedHere } from "./jobs.ts"

/** A ticket marked running with no change for this long is stuck (status, list, the dashboard). */
export const STUCK_MS = 2 * 3_600_000
/** Why ready tickets are not starting because of the budget cap, from the last tick (kv cap:why), or null when the cap is not holding them. */
export function capHold(db: DB): string | null {
  const get = (k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
  return get("cap:blocked-since") ? get("cap:why") ?? "budget cap" : null
}
/** Does anything run the tick: the tick job installed here, or a tick in the last day (dobby start)? */
export const tickRuns = (db: DB, now = Date.now(), jobInstalled = () => ownedHere(JOBS[0], process.platform, homedir())) => (lastTick(db) ?? 0) > now - 86_400_000 || jobInstalled()

/** The help is the usage comment at the top of cli.ts (one source): its `//` lines up to the first line of code. `// ---` splits the short help from the advanced list; `all` prints both. */
export const NOTHING_OPEN = "nothing open"
export function helpText(src: string, all = true) {
  const lines = src.split("\n")
  const end = lines.findIndex((l) => !l.startsWith("//"))
  return lines.slice(0, end < 0 ? lines.length : end).filter((l) => !all || !l.startsWith("// More:")).map((l) => (all && l === "// ---" ? "//" : l)).slice(0, all ? undefined : lines.indexOf("// ---")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n")
}

/** The row(s) of the command list for one command (`dobby <cmd> --help`): the same source `dobby help --all` prints. */
export function commandHelp(src: string, cmd: string) {
  const rows = helpText(src, true).split("\n").filter((l) => /^  \S/.test(l) && l.trim().split(/ {2,}/)[0].split(" | ").some((u) => u.split(/[ |]/)[0] === cmd))
  return rows.length ? rows.map((l) => l.trim()).join("\n") : `No help for ${cmd}. Run dobby help --all.`
}

const STAGES: [string, string[]][] = [["Building", ["running", "fixing"]], ["Ready", ["ready"]], ["Waiting", ["approval", "split"]], ["Needs you", ["failed"]]]
export type Row = { id: number; status: string; project: string; title: string; note: string | null; updated_at: string }

/** "35m", "2h", "3d" */
export function age(iso: string, now = Date.now()) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

/** Open tickets by stage, then app, then oldest first; 10 rows per stage; titles first, ids last. Failed ones say why. */
export function listView(rows: Row[], now = Date.now(), perStage = 10, hold: string | null = null) {
  const out: string[] = []
  for (const [name, statuses] of STAGES) {
    const rs = rows.filter((r) => statuses.includes(r.status)).sort((a, b) => a.project.localeCompare(b.project) || a.updated_at.localeCompare(b.updated_at))
    if (!rs.length) continue
    out.push(`${name} (${rs.length})`)
    for (const r of rs.slice(0, perStage)) {
      out.push(`  ${short(r.title)}  ${r.project}  ${age(r.updated_at, now)}  #${r.id}`)
      if (name === "Needs you" && r.note) out.push(`    why: ${clip(r.note, 70)}`)
      if (r.status === "running" && now - Date.parse(r.updated_at) > STUCK_MS) out.push(`    Stuck: no change for ${age(r.updated_at, now)}`)
      if (r.status === "ready" && hold) out.push(`    Waiting: cap (${clip(hold, 70)})`)
    }
    if (rs.length > perStage) out.push(`  +${rs.length - perStage} more`)
  }
  return out.join("\n") || NOTHING_OPEN
}

const n = (db: DB, sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as { title: string; note: string | null; updated_at: string }[]
const list = (xs: string[], max = 4) => xs.slice(0, max).join(", ") + (xs.length > max ? ` +${xs.length - max} more` : "")

/** The board: what is building, what waits on a review fix, what shipped today (IST), what failed this week and why, and when the scheduler last ran. */
export function statusText(db: DB, now = Date.now(), lim?: Limits) {
  const building = n(db, "SELECT title, note, updated_at FROM tickets WHERE status='running' ORDER BY updated_at")
  const fixing = n(db, "SELECT title, note FROM tickets WHERE status='fixing' ORDER BY updated_at")
  // fix pushes (onto set) land on an open PR and are rework, not a shipped ticket (audit #12)
  const shipped = n(db, `SELECT title, note FROM tickets WHERE status='shipped' AND onto IS NULL AND date(updated_at, '${tzOffset(now) >= 0 ? "+" : ""}${tzOffset(now) / 60_000} minutes') = ?`, istDay(now))
  const stuck = n(db, "SELECT title, note FROM tickets WHERE status='failed' AND updated_at>=? ORDER BY updated_at DESC", new Date(now - 7 * 86_400_000).toISOString())
  const stuckAll = (db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status='failed'").get() as { n: number }).n
  const tick = lastTick(db)
  const hhmm = tick ? zoned(tick).toISOString().slice(11, 16) : tickRuns(db, now) ? "unknown (no tick has run yet)" : "unknown: no tick job is installed. Run dobby start in a terminal, or dobby jobs install"
  return [
    ...(lim ? [lim.line, ...(liftHint(lim) ? [liftHint(lim)] : [])] : []),
    `🔨 Building now (${building.length})${building.length ? `: ${list(building.map((t) => `${short(t.title)}${now - Date.parse(t.updated_at) > STUCK_MS ? ` (Stuck: no change for ${age(t.updated_at, now)})` : ""}`))}` : ""}`,
    ...(fixing.length ? [`🔁 Waiting on a review fix (${fixing.length})`] : []),
    `✅ Shipped today (${shipped.length})`,
    `⚠️ Needs you (${stuck.length}${stuckAll > stuck.length ? ` this week, ${stuckAll} failed in all` : ""})${stuck.length ? `: ${list(stuck.map((t) => `${short(t.title)} - ${clip(t.note ?? "no reason recorded", 60)}`), 3)}` : ""}`,
    ...(config().ticketBudget ? costLine(db, now) : []),
    ...(pauseLine(db, now) ? [pauseLine(db, now)] : []),
    ...(healthLine(db) ? [healthLine(db)] : []),
    `🕒 Last tick ${hhmm}`,
  ].join("\n")
}

export type Limits = {
  five: { used: number; resetsAt: number | null }
  week: { used: number; cap: number; resetsAt: number }
  ratio: number
  state: "running" | "paused-5h" | "paused-week" | "unknown"
  resumesAt: number | null
  line: string
} | { state: "unknown"; line: string } | { state: "apiKey"; line: string }

/**
 * Where the plan stands and when held work resumes (pure: the reading, the settings and the time are given). The week cap holds until the weekly reset,
 * the pace cap until the 5-hour reset. Times are in the configured timezone. A missing or stale reading is "unknown", never a guess.
 */
export function limits(u: Usage | null, o: { weekCap: number; weekPerFive?: number; capOverride?: number }, now = Date.now()): Limits {
  if (!u || (u.ageMs ?? 0) > USAGE_STALE_MS) return { state: "unknown", line: `Plan usage unknown (${u?.ageMs ? `no reading for ${Math.round(u.ageMs / 60_000)} min` : "no reading"}; sign in to Claude, then wait 10 minutes)` }
  const label = config().timezoneLabel
  const hm = (ms: number) => `${zoned(ms).toISOString().slice(11, 16)} ${label}`
  const dhm = (ms: number) => `${zoned(ms).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" })} ${hm(ms)}`
  const night = zoned(now).getUTCHours() >= 23 || zoned(now).getUTCHours() < 8
  const cap = o.capOverride ?? paceCap(u, night, o.weekPerFive, o.weekCap)
  const fiveAt = u.fiveMsToReset === undefined ? null : now + u.fiveMsToReset, weekAt = now + u.weekMsToReset
  const weekHeld = u.weekUsed >= o.weekCap, fiveHeld = u.fiveUsed >= cap
  const state = weekHeld ? "paused-week" : fiveHeld ? "paused-5h" : "running"
  const resumesAt = weekHeld ? weekAt : fiveHeld ? fiveAt : null
  const line = weekHeld ? `Paused at ${u.weekUsed}% of your week (your cap), resumes ${dhm(weekAt)}`
    : fiveHeld ? `Paused: 5-hour window at ${u.fiveUsed}% (pace cap), resumes ${fiveAt === null ? "at the next reset" : hm(fiveAt)}`
    : `Running · 5-hour ${u.fiveUsed}% (cap ${cap}%) · week ${u.weekUsed}% of ${o.weekCap}%`
  return { five: { used: u.fiveUsed, resetsAt: fiveAt }, week: { used: u.weekUsed, cap: o.weekCap, resetsAt: weekAt }, ratio: o.weekPerFive ?? 0.1, state, resumesAt, line }
}

/** limits() from the live reading and this machine's settings. */
export function limitsNow(db: DB, u?: Usage | null, now = Date.now()): Limits {
  if (apiKeyMode()) { const s = spendAllows(db, undefined, now); return { state: "apiKey", line: s.ok ? s.why : `Paused: ${s.why}, resumes when spend in the last 24 hours falls under the cap` } } // no plan windows on a key: dollars against the daily cap
  if (u === undefined) u = readUsage(db)
  const l = limits(u, { weekCap: weekCapSetting(), weekPerFive: weekPerFive(db), capOverride: capOverride(db, now) }, now)
  const p = paused(db, { kind: "builders" }, now) // the plan has room, but the owner paused the builders: never say "Running"
  return p && l.line.startsWith("Running") ? { ...l, line: l.line.replace(/^Running/, `${p.startsWith("everything") ? "Everything" : "Builders"} ${p.replace(/^(everything|builders) /, "")}`) } : l
}

/** The command that lifts a plan hold, so a terminal-only owner is not left waiting for a Discord button. "" when nothing is held or nothing can lift it. */
export function liftHint(l: Limits): string {
  if (!("five" in l)) return ""
  if (l.state === "paused-week") return l.week.cap < 100 ? "Raise your weekly cap: dobby config set pacing.weekCap <percent, up to 100>" : ""
  return l.state === "paused-5h" && l.five.used < 100 ? `Lift it for this window: dobby do keepgoing ${l.five.used < 90 ? 90 : 100}` : ""
}

/** `dobby limits`: the line, then both bars as plain text, then the command that lifts a hold. */
export function limitsText(l: Limits) {
  if (!("five" in l)) return l.line
  const bar = (p: number) => `▕${"█".repeat(Math.round(Math.min(100, p) / 10))}${"░".repeat(10 - Math.round(Math.min(100, p) / 10))}▏ ${p}%`
  return [l.line, `5-hour ${bar(l.five.used)}`, `week   ${bar(l.week.used)} (cap ${l.week.cap}%)`, ...(liftHint(l) ? [liftHint(l)] : [])].join("\n")
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
 * The one status message in #daily-update (kv <platform>:msg:status), edited at the end of every tick: edits never ping, and it is skipped when
 * nothing changed. Records the tick time in kv tick:last. Pinned on its first post when the bot may (it needs Manage Messages; failure is ignored).
 */
export async function updateBoard(db: DB, on: boolean, fetcher: typeof fetch = fetch, now = Date.now()) {
  setKv(db, "tick:last", String(now))
  if (!on) return
  const text = `📋 Status\n${statusText(db, now)}`
  if (kv(db, "status:text") === text) return
  const chat = await platform(), fresh = !kv(db, `${chat.prefix}:msg:status`)
  const id = await chat.upsert(db, "status", { kind: "brief" }, text, undefined, fetcher)
  setKv(db, "status:text", text)
  const token = readSecrets().DISCORD_BOT_TOKEN
  if (fresh && token && chat.name === "discord") await chat.api(token, "PUT", `/channels/${kv(db, "discord:ch:daily-update")}/pins/${id}`, undefined, fetcher).catch(() => {})
}

export type Scoreboard = { opened: number; sentBack: number; merged: number; sentBackPrs: { repo: string; pr: number; url: string; title?: string; rounds: number }[] }

/**
 * PRs in the last `days`, read from the DB only (no GitHub). Opened = a PR whose first review row or first Dobby ticket (note holds the PR link, not a fix
 * round) is in the window, so owner PRs Dobby reviewed count too. Needed changes = a PR with a `fail` review head in the window (rounds = fail heads).
 * Merged = Dobby tickets shipped in the window, fix rounds excluded; merges of owner PRs are not recorded, so they are not counted.
 * PRs match on repo name + number (the owner part differs between forks).
 */
export function scoreboard(db: DB, days = 7, now = Date.now()): Scoreboard {
  const since = new Date(now - days * 86_400_000).toISOString()
  const key = (repo: string, pr: number | string) => `${repo.split("/").pop()}#${pr}`
  const first = new Map<string, string>() // first time Dobby saw the PR
  const seen = (k: string, at: string) => { if (!first.has(k) || at < first.get(k)!) first.set(k, at) }
  const titles = new Map<string, string>()
  for (const t of db.prepare("SELECT title, note, created_at, onto FROM tickets WHERE note LIKE '%/pull/%'").all() as { title: string; note: string; created_at: string; onto: string | null }[]) {
    const m = t.note.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/)
    if (!m || t.onto) continue
    seen(key(m[1], m[2]), t.created_at)
    titles.set(key(m[1], m[2]), shortTitle(t.title))
  }
  const rows = db.prepare("SELECT repo, pr, verdict, at FROM reviews WHERE verdict != 'running' ORDER BY at").all() as { repo: string; pr: number; verdict: string; at: string }[]
  for (const r of rows) seen(key(r.repo, r.pr), r.at)
  const sent = new Map<string, Scoreboard["sentBackPrs"][number]>()
  for (const r of rows.filter((r) => r.verdict === "fail" && r.at >= since)) {
    const k = key(r.repo, r.pr), e = sent.get(k)
    if (e) e.rounds++
    else sent.set(k, { repo: r.repo, pr: r.pr, url: `https://github.com/${r.repo}/pull/${r.pr}`, title: titles.get(k), rounds: 1 })
  }
  const merged = (db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status='shipped' AND onto IS NULL AND updated_at>=?").get(since) as { n: number }).n
  return { opened: [...first.values()].filter((at) => at >= since).length, sentBack: sent.size, merged, sentBackPrs: [...sent.values()].sort((a, b) => b.rounds - a.rounds || a.pr - b.pr) }
}

/** "This week: 14 PRs opened · 3 needed changes · 11 merged", then one line per PR that needed changes (5 at most). */
export function scoreboardText(sb: Scoreboard, label = "This week") {
  const s = (n: number) => (n === 1 ? "" : "s")
  return [
    `${label}: ${sb.opened} PR${s(sb.opened)} opened · ${sb.sentBack} needed changes · ${sb.merged} merged`,
    ...sb.sentBackPrs.slice(0, 5).map((p) => `• ${p.repo}#${p.pr}${p.title ? ` ${p.title}` : ""} · ${p.rounds} round${p.rounds === 1 ? "" : "s"} of changes`),
    ...(sb.sentBackPrs.length > 5 ? [`+${sb.sentBackPrs.length - 5} more`] : []),
  ].join("\n")
}

// ---- the receipt: what a window shipped and what it cost -------------------------------------------------------------------------
export type Receipt = { shipped: number; days: number; mode: "plan" | "apiKey"; planUsd?: number; extraUsd: number; weekPctUsed: number; from: string; to: string }
/** Tickets shipped in the last `days` days (fix rounds excluded); plan mode costs nothing extra, API-key mode pays the window's run costs. */
export function receipt(db: DB, days = 7, now = Date.now()): Receipt {
  const since = new Date(now - days * 86_400_000).toISOString()
  const shipped = (db.prepare("SELECT COUNT(*) n FROM tickets WHERE status='shipped' AND onto IS NULL AND updated_at>=?").get(since) as { n: number }).n
  const usd = (db.prepare("SELECT COALESCE(SUM(cost_usd),0) s FROM runs WHERE at>=?").get(since) as { s: number }).s
  const mode = config().billing?.mode === "apiKey" ? "apiKey" : "plan"
  return { shipped, days, mode, planUsd: mode === "plan" ? config().billing?.planUsd : undefined, extraUsd: mode === "apiKey" ? usd : 0, weekPctUsed: weekPoints(usd), from: since.slice(0, 10), to: new Date(now).toISOString().slice(0, 10) }
}
const money = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`
export function receiptLine(r: Receipt) {
  const prs = `${r.shipped} PR${r.shipped === 1 ? "" : "s"}`
  return r.mode === "apiKey" ? `Shipped ${prs} for ${money(r.extraUsd)}` : `Shipped ${prs} on ${r.planUsd ? `a ${money(r.planUsd)} plan` : "your Claude plan"}, $0 extra`
}
const xml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
/** 1200x630, self-contained: system fonts, no images. */
export function receiptSvg(r: Receipt) {
  const line = receiptLine(r), size = Math.min(72, Math.floor(1040 / (line.length * 0.56)))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#0e0f0d"/>
<text x="80" y="120" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="40" font-weight="600" fill="#3ddc84">dobby</text>
<text x="80" y="340" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="${size}" font-weight="700" fill="#f4f5f2">${xml(line)}</text>
<text x="80" y="550" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" font-size="28" fill="#8a8f86">${r.from} to ${r.to}</text>
</svg>
`
}

/** `dobby cost <id>`: the same table the PR comment has, as plain text. */
export const costText = (db: DB, id: number) => prCostText(prCost(db, id), config().billing?.mode === "apiKey").split("\n").slice(1).join("\n")

// Opt-in crash reports and usage stats (docs/manual/stats.md). Off until the owner says yes; DO_NOT_TRACK, DOBBY_STATS=off and CI force it off.
// What may be sent is the schema in src/stats-schema.ts and nothing else. Never throws into the caller, never retries, never waits more than 3 s.
// (src/telemetry.ts is something else: the local Claude Code OpenTelemetry receiver.)
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { config, configDir, type Config } from "./config.ts"
import { DATA, type DB } from "./db.ts"
import { countBucket, Event, FEATURES, ROLES, type StatsEvent } from "./stats-schema.ts"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const DAY_MS = 86_400_000
const CRASH_CAP = 10
const TIMEOUT_MS = 3000

export type Opts = {
  cfg?: Config["stats"]; env?: NodeJS.ProcessEnv
  fetch?: typeof fetch; now?: number
  /** the config folder (the install id lives here) and the data folder (stats/sent.jsonl lives here) */
  configDir?: string; dataDir?: string
}
type Props = Record<string, unknown>
type Pre = { name: StatsEvent["name"]; props?: Props }

const cfgOf = (o: Opts) => o.cfg ?? config().stats
const envOf = (o: Opts) => o.env ?? process.env
const dataDir = (o: Opts) => o.dataDir ?? DATA
const dayOf = (o: Opts) => new Date(o.now ?? Date.now()).toISOString().slice(0, 10)
const kvGet = (db: DB, k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
const kvSet = (db: DB, k: string, v: string) => void db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(k, v)

/** Why stats are off no matter what the config says, or undefined. */
export function forcedOff(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.DO_NOT_TRACK && env.DO_NOT_TRACK !== "0") return "DO_NOT_TRACK is set"
  if (env.DOBBY_STATS === "off") return "DOBBY_STATS=off"
  if (env.CI) return "CI is set"
  return undefined
}
export type Consent = { crashes: boolean; usage: boolean; forced?: string }
export function consent(o: Opts = {}): Consent {
  const forced = forcedOff(envOf(o)), c = cfgOf(o)
  return forced ? { crashes: false, usage: false, forced } : { crashes: c?.crashes === true, usage: c?.usage === true }
}
/** The owner's collector (stats-worker/). Used only after you opt in; set stats.endpoint to "" to send nowhere. */
export const DEFAULT_ENDPOINT = "https://dobby-stats.nimitharia1.workers.dev"
const endpointOf = (o: Opts) => { const e = (cfgOf(o)?.endpoint ?? DEFAULT_ENDPOINT).trim(); return /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(e) ? e : "" }

// ---- the install id -----------------------------------------------------------------------------------------------------------------

const idFile = (o: Opts) => `${o.configDir ?? configDir()}/stats-id`
export function installId(o: Opts = {}, create = false): string | undefined {
  try {
    const f = idFile(o), have = existsSync(f) ? readFileSync(f, "utf8").trim() : ""
    if (/^[0-9a-f-]{36}$/.test(have)) return have
    if (!create) return undefined
    const id = randomUUID()
    mkdirSync(dirname(f), { recursive: true }), writeFileSync(f, `${id}\n`, { mode: 0o600 })
    return id
  } catch { return undefined }
}
/** `dobby stats reset-id`: a new random id; what was sent under the old one is not linked to it. */
export function resetId(o: Opts = {}): string {
  rmSync(idFile(o), { force: true })
  return installId(o, true) ?? "(could not write the id file)"
}

// ---- recording ------------------------------------------------------------------------------------------------------------------------

let held: Pre[] | null = null
/** During `dobby init`, before the questions are answered: events wait in memory. */
export const holdEvents = () => { held = [] }
const sendable = (o: Opts) => consent(o).usage

function queueOf(db: DB): Pre[] { try { return JSON.parse(kvGet(db, "stats:queue") ?? "[]") as Pre[] } catch { return [] } }
function enqueue(db: DB, e: Pre) {
  const q = queueOf(db)
  if (q.length < 100) kvSet(db, "stats:queue", JSON.stringify([...q, e]))
}
/** A funnel event, once per install (a step once per step). Held in memory until the questions are answered, then queued only on a yes. */
export function record(db: DB, name: StatsEvent["name"], props?: Props, o: Opts = {}): void {
  try {
    if (held) { held.push({ name, props }); return }
    if (!sendable(o)) return
    const key = `stats:once:${name}${typeof props?.step === "string" ? `:${props.step}` : ""}`
    if (kvGet(db, key)) return
    kvSet(db, key, "1")
    enqueue(db, { name, props })
  } catch {}
}
/** The questions are answered: the held events are queued on a yes and dropped on a no. */
export function releaseHeld(db: DB, o: Opts = {}): void {
  const h = held ?? []
  held = null
  for (const e of h) record(db, e.name, e.props, o)
}

/** Local note that a feature was used (a number in the local database; nothing leaves the machine unless usage stats are on). */
export function noteUse(db: DB | undefined, name: string, now = Date.now()): void {
  try { if (db) kvSet(db, `stats:use:${name}`, String(now)) } catch {}
}

// ---- the daily heartbeat and the funnel milestones ------------------------------------------------------------------------------

const MILESTONES: [StatsEvent["name"], string][] = [
  ["first_ticket", "SELECT 1 FROM tickets LIMIT 1"],
  ["first_pr", "SELECT 1 FROM tickets WHERE note LIKE '%/pull/%' LIMIT 1"],
  ["first_merge", "SELECT 1 FROM tickets WHERE status='shipped' AND onto IS NULL LIMIT 1"],
]
const used = (db: DB, name: string, now: number) => Number(kvGet(db, `stats:use:${name}`) ?? 0) > now - DAY_MS
const tens = (n: number) => Math.max(0, Math.min(100, Math.floor(n / 10) * 10))

export async function heartbeatProps(db: DB, o: Opts = {}): Promise<Props> {
  const now = o.now ?? Date.now(), cfg = config(), since = new Date(now - DAY_MS).toISOString(), wk = new Date(now - 7 * DAY_MS).toISOString()
  const n = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n
  const { loadProjects } = await import("./lib.ts"), { paused } = await import("./pause.ts"), { chatOn: discordOn } = await import("./chat/platform.ts")
  const projects = Object.keys(loadProjects()).length
  const planUsd = cfg.billing?.planUsd
  const prs = n("SELECT COUNT(DISTINCT repo || '#' || pr) n FROM reviews WHERE verdict != 'running' AND at>=?", wk)
  const back = n("SELECT COUNT(DISTINCT repo || '#' || pr) n FROM reviews WHERE verdict='fail' AND at>=?", wk)
  const share = prs ? Math.round((100 * back) / prs) : 0
  let last: { week: number } | undefined
  try { last = db.prepare("SELECT week FROM usage_ticks WHERE week_reset<=? ORDER BY at DESC LIMIT 1").get(now) as { week: number } | undefined } catch {} // no usage readings yet: no such table
  const roles: Record<string, string> = {}
  for (const r of db.prepare("SELECT kind, COUNT(*) n FROM runs WHERE at>=? GROUP BY kind").all(since) as { kind: string; n: number }[]) if ((ROLES as readonly string[]).includes(r.kind)) roles[r.kind] = countBucket(r.n)
  const day = new Date(now).toISOString().slice(0, 10), yday = new Date(now - DAY_MS).toISOString().slice(0, 10)
  const features: Record<string, boolean> = Object.fromEntries(FEATURES.map((f) => [f, used(db, f, now)]))
  features.brief_sent = !!(kvGet(db, `brief:sent:${day}`) ?? kvGet(db, `brief:sent:${yday}`))
  return {
    plan: cfg.billing?.mode === "apiKey" ? "api" : planUsd === 20 ? "pro" : planUsd === 100 ? "max" : planUsd === 200 ? "max20" : "unknown",
    projects: projects === 0 ? "0" : projects === 1 ? "1" : projects <= 3 ? "2-3" : "4+",
    shipped: countBucket(n("SELECT COUNT(*) n FROM tickets WHERE status='shipped' AND onto IS NULL AND updated_at>=?", since)),
    sent_back: share === 0 ? "0" : share < 25 ? "<25" : share <= 50 ? "25-50" : "50+",
    safety: cfg.safety.preset, review_auto: (cfg.review?.auto as string | undefined) ?? "off", merges_paused: !!paused(db, { kind: "merges" }),
    chat: discordOn() ? "discord" : "terminal", week_cap: tens(cfg.pacing?.weekCap ?? 95),
    ...(last ? { week_used: tens(last.week) } : {}), features, roles,
  }
}

const platform = (): "darwin" | "linux" | undefined => (process.platform === "darwin" || process.platform === "linux" ? process.platform : undefined)
const version = () => { try { return (JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")) as { version: string }).version.split("-")[0] } catch { return "0.0.0" } } // "0.1.0-beta.0" reports as 0.1.0: the stats schema takes plain x.y.z
function wrap(e: Pre, id: string, o: Opts): StatsEvent | undefined {
  const os = platform()
  if (!os) return undefined
  const r = Event.safeParse({ install: id, v: version(), os, node: Number(process.versions.node.split(".")[0]), day: dayOf(o), name: e.name, ...(e.props ? { props: e.props } : {}) })
  return r.success ? r.data : undefined
}

/** The usage events due now, without changing anything: the queue, the milestones reached, and today's heartbeat. */
export async function nextUsage(db: DB, o: Opts = {}): Promise<{ events: StatsEvent[]; pending: Pre[]; marks: string[] }> {
  const id = installId(o) ?? "00000000-0000-4000-8000-000000000000"
  const pending: Pre[] = [...queueOf(db)], marks: string[] = []
  for (const [name, sql] of MILESTONES) if (!kvGet(db, `stats:once:${name}`) && db.prepare(sql).get()) pending.push({ name }), marks.push(`stats:once:${name}`)
  if (!kvGet(db, "stats:once:first_week_report") && kvGet(db, "stats:use:week_report")) pending.push({ name: "first_week_report" }), marks.push("stats:once:first_week_report")
  if (kvGet(db, "stats:flushed") !== dayOf(o)) pending.push({ name: "heartbeat", props: await heartbeatProps(db, o) })
  return { events: pending.map((e) => wrap(e, id, o)).filter((e): e is StatsEvent => !!e), pending, marks }
}

// ---- sending --------------------------------------------------------------------------------------------------------------------------

/** One POST, 3 s, one try. Every payload is appended to <data>/stats/sent.jsonl first. Returns whether the server took it; never throws. */
export async function post(events: StatsEvent[], o: Opts = {}): Promise<boolean> {
  try {
    const url = endpointOf(o)
    if (!url || !events.length) return false
    const valid = events.filter((e) => Event.safeParse(e).success)
    if (!valid.length) return false
    const f = `${dataDir(o)}/stats/sent.jsonl`
    mkdirSync(dirname(f), { recursive: true })
    appendFileSync(f, `${JSON.stringify({ at: new Date(o.now ?? Date.now()).toISOString(), to: url, events: valid })}\n`)
    const res = await (o.fetch ?? fetch)(`${url.replace(/\/$/, "")}/v1/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(valid), signal: AbortSignal.timeout(TIMEOUT_MS) })
    return res.ok
  } catch { return false }
}

/** Called by the tick job: at most once a day, usage stats only. The queue is cleared whether or not the server answered (no retries). */
export async function flushUsage(db: DB, o: Opts = {}): Promise<string> {
  try {
    if (!consent(o).usage) return ""
    const { events, marks } = await nextUsage(db, o)
    kvSet(db, "stats:flushed", dayOf(o))
    kvSet(db, "stats:queue", "[]")
    for (const k of marks) kvSet(db, k, "1")
    if (!endpointOf(o)) return "" // nothing is sent until an endpoint is set
    for (let i = 0; i < events.length; i += 20) if (!(await post(events.slice(i, i + 20), o))) break
    return `usage stats: ${events.length} event(s)`
  } catch { return "" }
}

// ---- crashes --------------------------------------------------------------------------------------------------------------------------

/** file:line of the frames inside Dobby's own package; paths relative to it; every other frame (node, dependencies, your code) is dropped. */
export function ownFrames(stack: string | undefined, root = ROOT): string[] {
  const out: string[] = []
  for (const m of (stack ?? "").matchAll(/\(?((?:file:\/\/)?\/[^\s():]+):(\d+):\d+\)?/g)) {
    const path = decodeURIComponent(m[1].replace(/^file:\/\//, ""))
    if (!path.startsWith(root) || path.slice(root.length).startsWith("node_modules/") || path.includes("/node_modules/")) continue
    const rel = `${path.slice(root.length)}:${m[2]}`
    if (/^[\w-][\w./-]{0,119}:\d{1,6}$/.test(rel)) out.push(rel)
  }
  return out.slice(0, 8)
}

let crashesThisProcess = 0
/** The payload for one error: class name, own frames, the command, Dobby's own code. Never the message. */
export function crashEvent(err: unknown, command: string, id: string, o: Opts = {}): StatsEvent | undefined {
  const e = err as { name?: unknown; constructor?: { name?: string }; stack?: string; code?: unknown } | null
  const kind = String(e?.constructor?.name ?? e?.name ?? "Error")
  const code = typeof e?.code === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(e.code) ? e.code : undefined
  return wrap({ name: "crash", props: { kind: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(kind) ? kind : "Error", where: ownFrames(typeof e?.stack === "string" ? e.stack : undefined), command: /^[a-z][a-z0-9-]{0,40}$/.test(command) ? command : "unknown", ...(code ? { code } : {}) } }, id, o)
}
/** Report an unexpected failure. A UserError (an expected, user-facing refusal) is not a crash. At most 10 a day. Never throws. */
export async function reportCrash(err: unknown, command: string, db?: DB, o: Opts = {}): Promise<boolean> {
  try {
    if (!consent(o).crashes || (err as { name?: string } | null)?.name === "HTTPException") return false
    const id = installId(o)
    if (!id || !endpointOf(o)) return false
    const key = `stats:crashes:${dayOf(o)}`
    const count = db ? Number(kvGet(db, key) ?? 0) : crashesThisProcess
    if (count >= CRASH_CAP) return false
    crashesThisProcess++
    if (db) kvSet(db, key, String(count + 1))
    const ev = crashEvent(err, command, id, o)
    return ev ? await post([ev], o) : false
  } catch { return false }
}

// ---- the commands -----------------------------------------------------------------------------------------------------------------------

const yes = (b: boolean) => (b ? "on" : "off")
export function statusText(o: Opts = {}): string {
  const c = consent(o), cfg = cfgOf(o), end = endpointOf(o)
  return [
    `Crash reports: ${yes(c.crashes)}`, `Usage stats: ${yes(c.usage)}`,
    c.forced ? `Forced off: ${c.forced}. Nothing is sent.` : (c.crashes || c.usage) ? (end ? `Sent to ${end}` : "No endpoint is set yet, so nothing is sent.") : "Nothing is sent.",
    `Install id: ${installId(o) ?? "none (made when you turn one on)"}`,
    `Sent log: ${dataDir(o)}/stats/sent.jsonl`, "What is sent: dobby docs stats",
  ].join("\n")
}
/** `dobby stats show`: exactly the payload the next daily send would carry. */
export async function showText(db: DB, o: Opts = {}): Promise<string> {
  const c = consent(o)
  const crash = c.crashes ? "Crash reports are on: an unexpected error sends its class name, the file:line of Dobby's own frames and the command. Never its message." : "Crash reports are off."
  if (!c.usage) return `Usage stats are off${c.forced ? ` (${c.forced})` : ""}: nothing is queued or sent.\n${crash}`
  const { events } = await nextUsage(db, o)
  return `${crash}\nThe next usage payload${endpointOf(o) ? "" : " (no endpoint is set yet, so it is not sent)"}:\n${JSON.stringify(events, null, 2)}`
}
export function sentLog(o: Opts = {}): string {
  const f = `${dataDir(o)}/stats/sent.jsonl`
  return existsSync(f) ? readFileSync(f, "utf8").trimEnd() : "Nothing has been sent."
}
/** `dobby stats on|off [crashes|usage]`: no word after it means both. Turning one on makes the install id. */
export function setStats(on: boolean, what: string | undefined, set: (key: string, value: boolean) => void, o: Opts = {}): string {
  if (what !== undefined && what !== "crashes" && what !== "usage") return "usage: dobby stats on|off [crashes|usage]"
  for (const k of what ? [what] : ["crashes", "usage"]) set(`stats.${k}`, on)
  if (on) installId(o, true)
  return `${what ? `${what === "crashes" ? "Crash reports" : "Usage stats"}: ${yes(on)}` : `Crash reports and usage stats: ${yes(on)}`}${on ? "\nWhat is sent: dobby stats show, dobby docs stats" : ""}`
}

/** `dobby stats report [--days 30]` (the owner only): the Worker's report. The token is read from the environment, never from a config file. */
export async function reportText(days = 30, o: Opts = {}): Promise<string> {
  const token = envOf(o).DOBBY_STATS_REPORT_TOKEN, url = endpointOf(o)
  if (!token) return "Set DOBBY_STATS_REPORT_TOKEN in your environment (the Worker's REPORT_TOKEN). It is never read from a config file."
  if (!url) return "No stats.endpoint is set."
  const to = dayOf(o), from = new Date((o.now ?? Date.now()) - days * DAY_MS).toISOString().slice(0, 10)
  try {
    const res = await (o.fetch ?? fetch)(`${url.replace(/\/$/, "")}/v1/report?from=${from}&to=${to}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
    return res.ok ? JSON.stringify(await res.json(), null, 2) : `The report endpoint answered ${res.status}.`
  } catch (e) { return `The report endpoint did not answer (${(e as Error).name}).` }
}

/** For the browser setup later: ask the two questions with whatever prompt the caller has. Held funnel events are sent on a yes and dropped on a no. */
export async function askStats(db: DB, ask: (message: string) => Promise<boolean>, set: (key: string, value: boolean) => void, o: Opts = {}): Promise<Consent> {
  const crashes = await ask("Send crash reports? (error type and place in Dobby's code, no text)")
  const usage = await ask("Send usage stats? (which features you use and how far setup got, counts only)")
  set("stats.crashes", crashes), set("stats.usage", usage)
  if (crashes || usage) installId(o, true)
  releaseHeld(db, { ...o, cfg: { ...cfgOf(o), crashes, usage } })
  return consent({ ...o, cfg: { ...cfgOf(o), crashes, usage } })
}

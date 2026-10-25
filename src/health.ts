// Watchman: hourly health check, no AI. Are the background jobs alive, are their configs valid, is there disk left?
// Prints a summary, logs to the checks table, exits 1 if anything is wrong.
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, statfsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { DATA, dailyPrune, logCheck, open, type DB } from "./db.ts"
import { config, zoned, zonedDay } from "./config.ts"
import { paused } from "./pause.ts"
import { loadProjects, signedOut, unblocked } from "./lib.ts"
import { loginShell } from "./shell.ts"

// Dobby's own launchd jobs, plus any the owner asks it to watch (config watchJobs)
const prefixes = () => ["com.dobby.", ...(config().watchJobs?.prefixes ?? [])]
const MIN_FREE_GB = 15
// Long-running servers: exit status 0 with no pid means they died.
const daemons = () => new Set(["com.dobby.telegram", ...(config().watchJobs?.daemons ?? [])])

export type Job = { label: string; pid: number | null; status: number }

/** Parse `launchctl list` (PID, Status, Label columns). */
export function parseLaunchctl(out: string): Job[] {
  return out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length === 3)
    .map(([pid, status, label]) => ({ label, pid: pid === "-" ? null : Number(pid), status: Number(status) }))
}

/** A job is unhealthy when its last exit was non-zero, or it is a daemon that is not running. */
export function jobProblem(j: Job): string | null {
  // A job that is running now was restarted by launchd; its old exit code (-15 = stopped for a restart) is history, not a problem.
  if (j.pid !== null) return null
  if (j.status !== 0) return `last exit ${j.status}`
  if (daemons().has(j.label) && j.pid === null) return "not running"
  return null
}

const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" })
  return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? "") }
}

export function healthCheck() {
  const db = open()
  const bad: string[] = []
  const check = (name: string, ok: boolean, detail = "") => {
    logCheck(db, name, ok, detail)
    if (!ok) bad.push(`${name}: ${detail}`)
  }
  const jobs = parseLaunchctl(run("launchctl", ["list"]).out).filter((j) => prefixes().some((p) => j.label.startsWith(p)))
  for (const j of jobs) check(`job ${j.label}`, !jobProblem(j), jobProblem(j) ?? "")
  const agents = `${homedir()}/Library/LaunchAgents`
  for (const f of readdirSync(agents).filter((f) => prefixes().some((p) => f.startsWith(p)))) {
    const lint = run("plutil", ["-lint", `${agents}/${f}`])
    check(`config ${f}`, lint.ok, lint.ok ? "" : lint.out.trim().split("\n").pop() ?? "")
  }
  const freeGb = Number(run("df", ["-k", "/"]).out.split("\n")[1]?.split(/\s+/)[3] ?? 0) / 1024 / 1024
  check("disk", freeGb >= MIN_FREE_GB, `${freeGb.toFixed(1)} GB free`)
  return { bad, jobs: jobs.length, freeGb }
}

/** "job com.acme.discover: last exit 1" -> "acme discover job failed (exit 1)" */
export function plain(problem: string) {
  const name = (l: string) => l.replace(/\.plist$/, "").replace(/^com\.(dobby|foreman)\./, "Dobby ").replace(/^[a-z]+\.([\w-]+)\./, "$1 ")
  return problem
    .replace(/^job (\S+): last exit (-?\d+)$/, (_, l, c) => `${name(l)} job failed (exit ${c})`)
    .replace(/^job (\S+): not running$/, (_, l) => `${name(l)} stopped running`)
    .replace(/^config (\S+): .*$/, (_, l) => `${name(l)} job file is broken`)
    .replace(/^disk: (.*)$/, "Disk is low: $1")
}

const istTime = (ms: number) => zoned(ms).toISOString().slice(0, 16).replace("T", " ")

/** No brief sent by 09:00 IST: one #needs-you post that day, with the reason. Returns whether it posted. */
export async function briefWatch(db: DB, send: (text: string) => Promise<unknown>, now = Date.now()) {
  const day = zonedDay(now)
  const has = (k: string) => !!db.prepare("SELECT 1 FROM kv WHERE k=?").get(k)
  if (zoned(now).getUTCHours() < 9 || has(`brief:sent:${day}`) || has(`brief:alerted:${day}`)) return false
  const last = db.prepare("SELECT at, ok, reason FROM runs WHERE kind='cos' ORDER BY at DESC LIMIT 1").get() as { at: string; ok: number; reason: string | null } | undefined
  const ranToday = last && istTime(Date.parse(last.at)).startsWith(day)
  const why = !ranToday ? "the morning brief job did not run today (Mac asleep or off, or the job stopped)" : last.ok ? "the brief was written but could not be posted" : `the brief writer failed (${last.reason ?? "unknown"})`
  await send(`No morning brief yet today: ${why}. Check the machine Dobby runs on.`)
  db.prepare("INSERT OR REPLACE INTO kv VALUES (?, '1')").run(`brief:alerted:${day}`)
  return true
}

/** For the status board: when Dobby last did any work (latest agent run). */
export function lastTick(db: DB) {
  const at = (db.prepare("SELECT MAX(at) AS at FROM runs").get() as { at: string | null }).at
  return `Last tick: ${at ? istTime(Date.parse(at)) + ` ${config().timezoneLabel}` : "never"}`
}

/** What a problem is about, without its reading: "disk: 11.9 GB free" -> "disk". A new number is the same problem. */
const what = (b: string) => b.split(": ")[0]
const whats = (bad: string[]) => JSON.stringify(bad.map(what).sort())

/** Problems seen by this check and the one before it. */
export const confirmed = (now: string[], prev: string[]) => now.filter((b) => prev.some((p) => what(p) === what(b)))

/** A message (Discord) only when the set of problems changes, so a known failure (or a new disk reading) does not ping every hour. */
export function changed(last: string | undefined, bad: string[]) {
  const now = JSON.stringify([...bad].sort())
  return { now, send: whats(bad) !== whats(JSON.parse(last ?? "[]") as string[]) }
}

// ---- the pipeline itself (no AI) -----------------------------------------------------------------------------------------
export type Health = { check: string; ok: boolean; text: string }
const H = 3600_000, M = 60_000
const fileMs = (f: string) => { try { return statSync(f).mtimeMs } catch { return null } }
const fileMb = (f: string) => [f, `${f}-wal`].reduce((n, x) => { try { return n + statSync(x).size / 1048576 } catch { return n } }, 0)
export type PipelineEnv = { now?: number; dir?: string; claudeFound?: () => boolean; freeGb?: () => number; persist?: boolean; projects?: Record<string, { paused: boolean }> }
/**
 * Is the pipeline moving? Each check is {check, ok, text}. `claudeFound` (health job only) looks for the binary; without it the
 * last answer stored in kv is used (the dashboard's DB is read-only, so `persist: false` writes nothing).
 */
export function pipelineChecks(db: DB, o: PipelineEnv = {}): Health[] {
  const now = o.now ?? Date.now(), dir = o.dir ?? DATA, iso = (ms: number) => new Date(now - ms).toISOString()
  const all = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as T[]
  const out: Health[] = []
  const add = (check: string, ok: boolean, bad: string, good = "ok") => out.push({ check, ok, text: ok ? good : bad })
  const titles = (r: { title: string }[]) => r.slice(0, 3).map((t) => t.title.slice(0, 50)).join("; ") + (r.length > 3 ? ` +${r.length - 3} more` : "")

  const kv = (k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
  const ms = (k: string) => { const v = kv(k); return v && /^\d+$/.test(v) ? Number(v) : 0 }
  const lockAt = ms("lock") // the tick's heartbeat: refreshed every 5 minutes while its workers run
  const tickAlive = now - lockAt <= 15 * M
  const fixing = all<{ title: string }>("SELECT title FROM tickets WHERE status='fixing' AND updated_at < ? ORDER BY updated_at", iso(24 * H))
  add("fixing", !fixing.length, `${fixing.length} ticket(s) waiting on a review fix for over 24 hours: ${titles(fixing)}`)
  const stuck = all<{ title: string }>("SELECT title FROM tickets WHERE status IN ('running','approval') AND updated_at < ? ORDER BY updated_at", iso(24 * H))
  add("stuck", !stuck.length, `${stuck.length} ticket(s) have not moved for over 24 hours: ${titles(stuck)}`)
  const skippedAt = ms("review:skipped-since")
  add("reviews", !skippedAt || now - skippedAt < 2 * H, `reviews have been skipped for ${Math.round((now - skippedAt) / H)} hours (budget): PRs wait unreviewed`)
  const capAt = ms("cap:blocked-since")
  add("cap", !capAt || now - capAt < 3 * H, `ready tickets have been held by the budget cap for ${Math.round((now - capAt) / H)} hours`)
  // A long build with the tick's heartbeat fresh (a claude run, checks wait or verify in progress) or live telemetry is working, not hung.
  const hung = tickAlive ? [] : all<{ title: string }>(`SELECT title FROM tickets t WHERE status='running' AND updated_at < ? AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.ticket=t.id AND r.at >= ?)
    AND NOT EXISTS (SELECT 1 FROM telemetry e WHERE e.ticket=t.id AND e.at >= ?)`, iso(2 * H), iso(30 * M), iso(30 * M))
  add("running", !hung.length, `${hung.length} ticket(s) marked building for over 2 hours with no agent run in the last 30 minutes: ${titles(hung)}`)
  const b = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(ok=0), 0) bad FROM runs WHERE kind='build' AND at >= ?").get(iso(6 * H)) as { n: number; bad: number }
  add("builds", b.n < 6 || b.bad * 2 <= b.n, `${b.bad} of ${b.n} builds failed in the last 6 hours`, b.n ? `${b.n - b.bad} of ${b.n} builds ok in 6 h` : "ok")
  // only work a builder would take (nextTicket): not L, project not paused (dobby.md or pause), ticket not paused; none while the
  // budget paused this 5-hour window (windows.paused) or builders are paused
  const projects = o.projects ?? (() => { try { return loadProjects() } catch { return {} } })()
  const ready = all<{ id: number; project: string }>(`SELECT id, project FROM tickets WHERE status='ready' AND size!='L' AND dup_of IS NULL AND ${unblocked()}`)
    .filter((t) => !projects[t.project]?.paused && !paused(db, { kind: "builders", project: t.project, ticket: t.id }, now)).length
  const budgetPaused = !!db.prepare("SELECT 1 FROM windows WHERE paused=1 AND reset_at > ?").get(now)
  const last = Date.parse((db.prepare("SELECT MAX(at) at FROM runs").get() as { at: string | null }).at ?? "") || 0
  const idle = ready > 0 && now - last > 2 * H && !budgetPaused && !paused(db, { kind: "builders" }, now)
  add("idle", !idle, `${ready} ticket(s) ready but no agent has run for ${last ? `${Math.round((now - last) / H)} hours` : "ever"} (and nothing is paused)`)
  // the tick: its lock heartbeat (every 5 min while it works) or tick:last (end of every run); neither yet = not set up, fine
  const tickAt = Math.max(lockAt, ms("tick:last"))
  add("tick log", !tickAt || now - tickAt <= 30 * M, `the tick has not run for ${Math.round((now - tickAt) / M)} minutes (is the job running?)`)
  const at = fileMs(`${dir}/logs/telegram.log`) // the listener logs a review-scan line every 15 minutes
  add("listener log", at === null || now - at <= 30 * M, `telegram.log has not changed for ${Math.round((now - (at ?? 0)) / M)} minutes (is the listener running?)`)
  // claude: binary missing (as last seen by the health job) or every run since the last good one signed out, for over 30 minutes
  if (o.claudeFound && o.persist !== false) {
    if (o.claudeFound()) db.prepare("DELETE FROM kv WHERE k='health:claude-missing'").run()
    else if (!kv("health:claude-missing")) db.prepare("INSERT INTO kv VALUES ('health:claude-missing', ?)").run(String(now))
  }
  const missing = Number(kv("health:claude-missing") ?? 0)
  const lastOk = (db.prepare("SELECT MAX(at) at FROM runs WHERE ok=1").get() as { at: string | null }).at ?? ""
  const out1 = all<{ at: string; reason: string | null }>("SELECT at, reason FROM runs WHERE ok=0 AND at > ? ORDER BY at", lastOk).find((r) => signedOut({ ok: false, reason: r.reason }))
  const since = out1 ? Date.parse(out1.at) : 0
  add("claude", !(missing && now - missing > 30 * M) && !(since && now - since > 30 * M),
    missing && now - missing > 30 * M ? `the claude command has been missing for ${Math.round((now - missing) / M)} minutes` : `Claude has been signed out for ${Math.round((now - since) / M)} minutes (run claude, then /login)`)
  for (const f of ["graph.db", "dobby.db"]) { const mb = fileMb(`${dir}/${f}`); add(f, mb <= 500, `${f} is ${Math.round(mb)} MB`) }
  const gb = o.freeGb ? o.freeGb() : (() => { try { const s = statfsSync(existsSync(dir) ? dir : "/"); return (s.bavail * s.bsize) / 1024 ** 3 } catch { return Infinity } })()
  add("disk", gb >= MIN_FREE_GB, `only ${gb.toFixed(1)} GB free on disk`, `${gb.toFixed(0)} GB free`)
  return out
}

/** Hourly: run the checks, keep them for the board and dashboard (kv health:pipeline), and post each problem to #needs-you once a day. */
export async function pipelineWatch(db: DB, send: (text: string) => Promise<unknown>, o: PipelineEnv = {}) {
  const now = o.now ?? Date.now(), day = new Date(now + 19_800_000).toISOString().slice(0, 10)
  const hs = pipelineChecks(db, o)
  db.prepare("INSERT OR REPLACE INTO kv VALUES ('health:pipeline', ?)").run(JSON.stringify({ at: now, checks: hs }))
  const sent: string[] = []
  for (const h of hs.filter((x) => !x.ok)) {
    const k = `health:told:${h.check}:${day}`
    if (db.prepare("SELECT 1 FROM kv WHERE k=?").get(k)) continue
    // told only once it went out: a failed post is tried again next hour
    const ok = await send(`🩺 Dobby pipeline: ${h.text}`).then((r) => r !== false, () => false)
    if (!ok) continue
    db.prepare("INSERT OR REPLACE INTO kv VALUES (?, '1')").run(k)
    sent.push(h.check)
  }
  return { checks: hs, sent }
}

if (import.meta.main || process.argv[2] === "health") {
  const { bad, jobs, freeGb } = healthCheck()
  const msg = bad.length ? `${bad.length} problem(s):\n- ${bad.join("\n- ")}` : `All ${jobs} jobs healthy, ${freeGb.toFixed(0)} GB free.`
  console.log(msg)
  const db = open()
  // A problem counts only when two checks in a row see it: a Wi-Fi blip (17 Oct: four jobs "failed" at once, all fine an hour later) is not an alert.
  const prevRaw = JSON.parse((db.prepare("SELECT v FROM kv WHERE k='health:raw'").get() as { v: string } | undefined)?.v ?? "[]") as string[]
  db.prepare("INSERT OR REPLACE INTO kv VALUES ('health:raw', ?)").run(JSON.stringify(bad))
  db.prepare("INSERT OR REPLACE INTO kv VALUES ('health:lasttick', ?)").run(lastTick(db))
  const { notify: tell, asIs } = await import("./telegram.ts")
  await briefWatch(db, (t) => tell(t, fetch, undefined, { kind: "approval" }, asIs)).catch((e) => console.log(`brief watch: ${e}`))
  const { notify: say } = await import("./telegram.ts")
  const claudeFound = () => spawnSync(...loginShell("command -v claude"), { encoding: "utf8" }).status === 0
  await pipelineWatch(db, (t) => say(t, fetch, undefined, { kind: "approval" }), { claudeFound }).catch((e) => console.log(`pipeline checks: ${e}`))
  try { const p = dailyPrune(db); if (p) console.log(p) } catch (e) { console.log(`prune: ${(e as Error).message}`) }
  const sure = confirmed(bad, prevRaw)
  const c = changed((db.prepare("SELECT v FROM kv WHERE k='health'").get() as { v: string } | undefined)?.v, sure)
  if (c.send) {
    const { notify } = await import("./telegram.ts")
    await notify(sure.length ? `⚠️ Something needs a look\n${sure.map((b) => `• ${plain(b)}`).join("\n")}` : "✅ All background jobs healthy again", fetch, undefined, { kind: "health" })
    db.prepare("INSERT OR REPLACE INTO kv VALUES ('health', ?)").run(c.now)
  }
}

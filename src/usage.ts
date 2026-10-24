// Usage tracking (owner, 17 Oct): exact tokens per API call from every Claude Code session file, the plan's 5-hour and
// weekly % every couple of minutes, and Dobby's own API-credit calls. Each +1 tick of a limit gets the API-$ spent
// since the previous tick, so "$ per 1%" is measured, not guessed. Read-only on ~/.claude; writes only Dobby's DB.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { config, expand, quietAt, zoned } from "./config.ts"
import type { DB } from "./db.ts"
import { windowIdle, type Usage } from "./lib.ts"

const PROJECTS = `${homedir()}/.claude/projects`

export function ensure(db: DB) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_calls (id TEXT PRIMARY KEY, at INTEGER, session TEXT, source TEXT, project TEXT, model TEXT,
      input INTEGER, write5m INTEGER, write1h INTEGER, read INTEGER, output INTEGER, thinking INTEGER, web INTEGER, usd REAL);
    CREATE INDEX IF NOT EXISTS usage_calls_at ON usage_calls(at);
    CREATE TABLE IF NOT EXISTS usage_files (path TEXT PRIMARY KEY, offset INTEGER);
    CREATE TABLE IF NOT EXISTS usage_ticks (at INTEGER PRIMARY KEY, five INTEGER, week INTEGER, five_reset INTEGER, week_reset INTEGER);
    CREATE TABLE IF NOT EXISTS usage_steps (at INTEGER NOT NULL, win TEXT NOT NULL, pct INTEGER NOT NULL, usd REAL NOT NULL, tokens INTEGER NOT NULL, usd_per_pct REAL NOT NULL, PRIMARY KEY (at, win));
    CREATE TABLE IF NOT EXISTS usage_readings (at INTEGER PRIMARY KEY, since INTEGER NOT NULL, five INTEGER, week INTEGER, last_row INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS usage_log (at INTEGER NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, tokens INTEGER NOT NULL, usd REAL NOT NULL, PRIMARY KEY (at, model, kind));
    CREATE TABLE IF NOT EXISTS touches (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, ticket INTEGER, kind TEXT NOT NULL, tag TEXT NOT NULL, note TEXT, n INTEGER DEFAULT 1);
  `)
  try { db.exec("ALTER TABLE touches ADD COLUMN n INTEGER DEFAULT 1") } catch {} // databases from before the count column
}

// $ per million tokens (Anthropic pricing page, 17 Oct 2026). Cache read: 5% of input on Opus/Sonnet 5.5, 10% otherwise
// (2.5% on Fable). Cache write: 1.25x input (5 min), 2x input (1 hour). Haiku 5.5 costs 5x for prompts over 100K.
type Price = { in: number; out: number; read: number }
export function price(model: string, promptTokens: number): Price {
  const m = model.toLowerCase()
  if (m.includes("fable")) return { in: 10, out: 50, read: 0.25 }
  if (m.includes("opus")) return m.includes("5-5") ? { in: 4, out: 20, read: 0.2 } : { in: 5, out: 25, read: 0.5 }
  if (m.includes("sonnet")) return m.includes("5-5") ? { in: 2, out: 10, read: 0.1 } : { in: 3, out: 15, read: 0.3 }
  if (m.includes("haiku")) return promptTokens > 100_000 ? { in: 0.5, out: 2.5, read: 0.05 } : { in: 0.1, out: 0.5, read: 0.01 }
  return { in: 0, out: 0, read: 0 } // "<synthetic>" and unknowns: not billed
}

export type Call = { id: string; at: number; session: string; source: string; project: string; model: string; input: number; write5m: number; write1h: number; read: number; output: number; thinking: number; web: number; usd: number }

/** One transcript line to a priced call, or null. source: "you" (interactive) or "automated" (claude -p: Dobby, background jobs). */
export function toCall(line: string, project: string): Call | null {
  let e: any
  try { e = JSON.parse(line) } catch { return null }
  const u = e?.type === "assistant" ? e.message?.usage : null
  if (!u || !e.message?.id) return null
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? (u.cache_creation ? 0 : u.cache_creation_input_tokens ?? 0)
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const input = u.input_tokens ?? 0, read = u.cache_read_input_tokens ?? 0, output = u.output_tokens ?? 0
  const web = u.server_tool_use?.web_search_requests ?? 0
  const p = price(e.message.model ?? "", input + read + w5 + w1)
  const usd = (input * p.in + w5 * p.in * 1.25 + w1 * p.in * 2 + read * p.read + output * p.out) / 1e6 + web * 0.01
  return {
    id: e.message.id, at: Date.parse(e.timestamp ?? "") || Date.now(), session: e.sessionId ?? "", source: e.entrypoint === "cli" ? "you" : "automated", project,
    model: e.message.model ?? "", input, write5m: w5, write1h: w1, read, output, thinking: u.output_tokens_details?.thinking_tokens ?? 0, web, usd,
  }
}

/** A transcript line where the owner's own (interactive) session edits a file on a ticket branch (dobby/<id>): that ticket, session and time, else null. */
export function sessionFix(line: string): { ticket: number; session: string; at: number } | null {
  let e: any
  try { e = JSON.parse(line) } catch { return null }
  const ticket = /^(?:dobby|foreman)\/(\d+)$/.exec(e?.gitBranch ?? "")?.[1]
  if (!ticket || e.type !== "assistant" || e.entrypoint !== "cli" || !e.sessionId) return null
  const edits = Array.isArray(e.message?.content) && e.message.content.some((c: any) => c?.type === "tool_use" && ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(c.name))
  return edits ? { ticket: Number(ticket), session: e.sessionId, at: Date.parse(e.timestamp ?? "") || Date.now() } : null
}

/** Read only what was appended since last time (byte offsets), across every session file. Returns new calls stored.
 * Also logs one "broke" touch per owner session and ticket the first time that session edits a file on the ticket's branch. */
export function ingest(db: DB, root = PROJECTS): number {
  ensure(db)
  if (!existsSync(root)) return 0
  const ins = db.prepare(`INSERT OR IGNORE INTO usage_calls VALUES (@id,@at,@session,@source,@project,@model,@input,@write5m,@write1h,@read,@output,@thinking,@web,@usd)`)
  const getOff = db.prepare("SELECT offset FROM usage_files WHERE path=?"), setOff = db.prepare("INSERT OR REPLACE INTO usage_files VALUES (?, ?)")
  let n = 0
  const files: [string, string][] = []
  for (const dir of readdirSync(root)) {
    const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(`${d}/${f.name}`) : f.name.endsWith(".jsonl") && files.push([`${d}/${f.name}`, dir]) }
    try { walk(`${root}/${dir}`) } catch {}
  }
  for (const [path, project] of files) {
    const size = statSync(path).size
    let off = (getOff.get(path) as { offset: number } | undefined)?.offset ?? 0
    if (off > size) off = 0 // file rewritten
    if (off === size) continue
    const fd = openSync(path, "r")
    try {
      const buf = Buffer.alloc(Math.min(size - off, 64 * 1024 * 1024))
      readSync(fd, buf, 0, buf.length, off)
      const text = buf.toString("utf8")
      const end = text.lastIndexOf("\n") + 1 // only complete lines; the rest is read next time
      db.transaction(() => {
        for (const line of text.slice(0, end).split("\n")) {
          const c = line.includes('"usage"') ? toCall(line, project) : null
          if (c) n += ins.run(c).changes
          const fix = /"gitBranch":"(dobby|foreman)\//.test(line) && line.includes('"tool_use"') ? sessionFix(line) : null
          const note = fix ? `session ${fix.session}` : ""
          if (fix && !db.prepare("SELECT 1 FROM touches WHERE kind='session' AND ticket=? AND note=?").get(fix.ticket, note)) touch(db, { ticket: fix.ticket, kind: "session", tag: "broke", note }, fix.at)
        }
        setOff.run(path, off + Buffer.byteLength(text.slice(0, end)))
      })()
    } finally {
      closeSync(fd)
    }
  }
  return n
}

/** The plan's live reading (usage-limits plugin). Logs a tick whenever 5-hour or weekly changed. Each +1..3 step of a window
 * (same reset, so not a rollover) also stores the API-$ and tokens spent since that window's previous change and the measured $ per 1%.
 * Ticks of the other window in between don't cut the span; a window whose previous change isn't a same-reset change (first
 * ever tick, rollover) has no known start, so that step is skipped. */
export function poll(db: DB, read = readLimits): { five: number; week: number } | null {
  ensure(db)
  const r = read()
  if (!r) return null
  const last = db.prepare("SELECT at, five, week, five_reset, week_reset FROM usage_ticks ORDER BY at DESC LIMIT 1").get() as { at: number; five: number; week: number; five_reset: number; week_reset: number } | undefined
  if (!last || last.five !== r.five || last.week !== r.week) {
    db.transaction(() => {
      if (last && r.at > last.at) {
        const spent = db.prepare("SELECT COALESCE(SUM(usd),0) usd, COALESCE(SUM(input+write5m+write1h+read+output),0) tokens FROM usage_calls WHERE at>=? AND at<?")
        const put = db.prepare("INSERT OR REPLACE INTO usage_steps VALUES (?,?,?,?,?,?)")
        for (const [win, d, now] of [["five", r.five - last.five, r.fiveReset], ["week", r.week - last.week, r.weekReset]] as const) {
          if (d <= 0 || d > 3 || now !== last[`${win}_reset` as const]) continue
          // this window's previous change: the first tick of the run that holds `last`'s value, after a differing tick of the same reset
          const prev = db.prepare(`SELECT at, ${win}_reset r FROM usage_ticks WHERE NOT (${win}=? AND ${win}_reset=?) ORDER BY at DESC LIMIT 1`).get(last[win], now) as { at: number; r: number } | undefined
          if (!prev || prev.r !== now) continue
          const from = (db.prepare("SELECT MIN(at) a FROM usage_ticks WHERE at>?").get(prev.at) as { a: number }).a
          const s = spent.get(from, r.at) as { usd: number; tokens: number }
          put.run(r.at, win, d, s.usd, s.tokens, s.usd / d)
        }
      }
      db.prepare("INSERT OR REPLACE INTO usage_ticks VALUES (?,?,?,?,?)").run(r.at, r.five, r.week, r.fiveReset, r.weekReset)
    })()
  }
  return r
}

const KINDS = ["input", "write5m", "write1h", "read", "output", "web"] as const

/** The 10-minute reading: 5h %, weekly %, and the API-$ and tokens since the previous reading, per model and token kind.
 * "Since" is a call-row watermark, not a clock time, so a gap (listener down, limits unreadable) just makes the next reading
 * cover more calls: nothing is lost or counted twice. `since` records the previous reading time so a gap is visible. */
export function logReading(db: DB, r: { five: number; week: number } | null, now = Date.now()) {
  ensure(db)
  const prev = db.prepare("SELECT at, last_row FROM usage_readings ORDER BY at DESC LIMIT 1").get() as { at: number; last_row: number } | undefined
  const top = (db.prepare("SELECT COALESCE(MAX(rowid),0) m FROM usage_calls").get() as { m: number }).m
  if (!prev) { // first reading: start from now, don't dump history into one row
    db.prepare("INSERT INTO usage_readings VALUES (?,?,?,?,?)").run(now, now, r?.five ?? null, r?.week ?? null, top)
    return
  }
  const calls = db.prepare("SELECT model, input, write5m, write1h, read, output, web FROM usage_calls WHERE rowid>? AND rowid<=?").all(prev.last_row, top) as Record<string, any>[]
  const acc = new Map<string, { model: string; kind: string; tokens: number; usd: number }>()
  for (const c of calls) {
    const p = price(c.model, c.input + c.read + c.write5m + c.write1h)
    const usd = { input: c.input * p.in, write5m: c.write5m * p.in * 1.25, write1h: c.write1h * p.in * 2, read: c.read * p.read, output: c.output * p.out, web: c.web * 1e4 }
    for (const kind of KINDS) {
      if (!c[kind]) continue
      const a = acc.get(`${c.model}|${kind}`) ?? { model: c.model, kind, tokens: 0, usd: 0 }
      a.tokens += c[kind], a.usd += usd[kind] / 1e6
      acc.set(`${c.model}|${kind}`, a)
    }
  }
  const put = db.prepare("INSERT OR REPLACE INTO usage_log VALUES (?,?,?,?,?)")
  db.transaction(() => {
    for (const a of acc.values()) put.run(now, a.model, a.kind, a.tokens, a.usd)
    db.prepare("INSERT OR REPLACE INTO usage_readings VALUES (?,?,?,?,?)").run(now, prev.at, r?.five ?? null, r?.week ?? null, top)
  })()
}

function readLimits() {
  const p = spawnSync("node", [expand(config().paths.usageCli), "--json", "--host", "claude"], { cwd: homedir(), encoding: "utf8", timeout: 30_000 })
  try {
    const j = JSON.parse(p.stdout)
    const u = j.utilization, at = Number(j.snapshotFetchedAt ?? j.now)
    if (!u?.five_hour || !u?.seven_day) return null
    return { at, five: Math.round(u.five_hour.utilization), week: Math.round(u.seven_day.utilization), fiveReset: Date.parse(u.five_hour.resets_at), weekReset: Date.parse(u.seven_day.resets_at) }
  } catch {
    return null
  }
}

const sum = (db: DB, from: number, to: number, where = "1=1") =>
  db.prepare(`SELECT COALESCE(SUM(usd),0) usd, COUNT(*) n FROM usage_calls WHERE at>=? AND at<? AND ${where}`).get(from, to) as { usd: number; n: number }
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN)

/** $ per 1% from consecutive ticks: each +1 step is exactly 1% (no whole-number noise), ignoring steps across a reset. */
export function perPercent(db: DB, key: "five" | "week", days = 7) {
  const t = db.prepare(`SELECT at, ${key} v, ${key}_reset r FROM usage_ticks WHERE at>=? ORDER BY at`).all(Date.now() - days * 86400_000) as { at: number; v: number; r: number }[]
  const xs: number[] = []
  for (let i = 1; i < t.length; i++) {
    const d = t[i].v - t[i - 1].v
    if (d > 0 && d <= 3 && t[i].r === t[i - 1].r) xs.push(sum(db, t[i - 1].at, t[i].at).usd / d)
  }
  return { median: median(xs), samples: xs.length }
}

const hh = (h: number) => String(h).padStart(2, "0")
/** Hour of day (0-23) in the configured zone for an epoch ms. */
const istHour = (ms: number) => zoned(ms).getUTCHours()
/** API-$ since `from`, split into day and night (config quietHours, default 23-08). */
function nightSplit(db: DB, from: number, to = Date.now()) {
  const rows = db.prepare("SELECT at, usd FROM usage_calls WHERE at>=? AND at<?").all(from, to) as { at: number; usd: number }[]
  let day = 0, night = 0
  for (const c of rows) quietAt(istHour(c.at), config().quietHours) ? (night += c.usd) : (day += c.usd)
  return { day, night }
}

/** The report: TLDR first. `dobby usage [days]`. */
export function report(db: DB, days = 1): string {
  ensure(db)
  const to = Date.now(), from = to - days * 86400_000
  const all = sum(db, from, to), you = sum(db, from, to, "source='you'"), auto = sum(db, from, to, "source='automated'")
  const api = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM runs WHERE model LIKE 'api:%' AND at>=?").get(new Date(from).toISOString()) as { n: number; i: number; o: number }
  const apiUsd = (api.i * 0.1 + api.o * 0.5) / 1e6 // ponytail: priced as Haiku 5.5 (all API-routed calls today are Haiku); split by model if that changes
  const f = perPercent(db, "five"), w = perPercent(db, "week")
  const nightUsd = nightSplit(db, from).night
  const models = db.prepare("SELECT model, ROUND(SUM(usd),2) usd FROM usage_calls WHERE at>=? GROUP BY model ORDER BY usd DESC LIMIT 4").all(from) as { model: string; usd: number }[]
  const tok = db.prepare("SELECT SUM(input) i, SUM(write5m) w5, SUM(write1h) w1, SUM(read) r, SUM(output) o, SUM(thinking) th FROM usage_calls WHERE at>=?").get(from) as Record<string, number>
  const hit = tok.r / Math.max(1, tok.r + tok.i + tok.w5 + tok.w1)
  const usd = (x: number) => `$${x.toFixed(2)}`
  const k = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(0)}k` : String(x ?? 0))
  const step = (win: string) => {
    const x = db.prepare("SELECT usd_per_pct u, tokens / pct t FROM usage_steps WHERE win=? AND at>=?").all(win, from) as { u: number; t: number }[]
    return x.length ? `${usd(median(x.map((y) => y.u)))} · ${k(Math.round(median(x.map((y) => y.t))))} tokens (${x.length} steps)` : "measuring…"
  }
  const fullWindow = f.median * 100, fullWeek = w.median * 100
  return [
    `📊 Usage · last ${days === 1 ? "24 hours" : `${days} days`}`,
    `TLDR: ${usd(all.usd)} API-equivalent (${Math.round((100 * you.usd) / Math.max(all.usd, 1e-9))}% you, ${Math.round((100 * auto.usd) / Math.max(all.usd, 1e-9))}% Dobby/automated). Night ${usd(nightUsd)}.`,
    `1% of 5-hour ≈ ${isNaN(f.median) ? "measuring…" : usd(f.median)}${f.samples ? ` (${f.samples} ticks)` : ""} · 1% of week ≈ ${isNaN(w.median) ? "measuring…" : usd(w.median)}${w.samples ? ` (${w.samples} ticks)` : ""}${!isNaN(fullWindow) && !isNaN(fullWeek) ? ` · a full 5-hour window ≈ ${((100 * fullWindow) / fullWeek).toFixed(1)}% of the week` : ""}`,
    `Measured per +1% (stored at each step): 5-hour ${step("five")} · week ${step("week")}`,
    `Tokens: ${k(tok.i)} fresh in · ${k((tok.w5 ?? 0) + (tok.w1 ?? 0))} cache write (${k(tok.w1)} of it 1-hour) · ${k(tok.r)} cache read (${(100 * hit).toFixed(1)}% hit) · ${k(tok.o)} out (${k(tok.th)} of it thinking)`,
    `By model: ${models.map((m) => `${m.model.replace("claude-", "")} ${usd(m.usd)}`).join(" · ") || "-"}`,
    `API credits (Dobby's own key): ${api.n} calls, ${usd(apiUsd)}`,
  ].join("\n")
}

// ---- builders first (owner, 17 Oct): Engineers, QA and reviews get at least 80% of Dobby's own spend --------------
// Process roles (planning, design, launch checks, the Trainer, the brief) share at most 20%, and they are throttled first:
// they stop 10 points of the 5-hour window before the builders do.
export const PROCESS_KINDS = ["lead", "lead-week", "pm", "area-pm", "design", "launch-check", "scout", "cos"]
const PROCESS_MAX = 0.2, WARM_UP_USD = 2

/** Process roles' share of Dobby's plan spend (runs.cost_usd) over the last `days`. */
export function processShare(db: DB, days = 7, now = Date.now()) {
  const r = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) total, COALESCE(SUM(CASE WHEN kind IN (${PROCESS_KINDS.map(() => "?").join(",")}) THEN cost_usd END),0) process FROM runs WHERE at>=?`)
    .get(...PROCESS_KINDS, new Date(now - days * 86400_000).toISOString()) as { total: number; process: number }
  return { ...r, share: r.total ? r.process / r.total : 0 }
}

/** May a process role run now? gate/fiveUsed = the builders' budget check this cycle (omit to check the share only). */
export function processAllowed(db: DB, gate?: { ok: boolean; cap: number }, fiveUsed?: number, now = Date.now()): { ok: boolean; why: string } {
  if (gate && !gate.ok) return { ok: false, why: "builders paused" }
  if (gate && fiveUsed !== undefined && fiveUsed > gate.cap - 10) return { ok: false, why: `5-hour window at ${fiveUsed}%: the last 10 points before the cap (${gate.cap}%) are for builders` }
  const s = processShare(db, 7, now)
  if (s.total >= WARM_UP_USD && s.share >= PROCESS_MAX) return { ok: false, why: `process roles at ${Math.round(100 * s.share)}% of this week's spend (max ${100 * PROCESS_MAX}%)` }
  return { ok: true, why: `process roles at ${Math.round(100 * s.share)}% of spend` }
}

/** The weekly % one 5-hour % costs, from measured ticks; 0.1 (a full window is ~10% of the week) until there are enough. */
export function weekPerFive(db: DB) {
  try {
    const r = perPercent(db, "five").median / perPercent(db, "week").median
    return r > 0.03 && r < 0.3 ? r : 0.1
  } catch {
    return 0.1
  }
}

// ---- autonomy (owner, 17 Oct): how much Dobby did alone ----------------------------------------------------------
// A touch = the owner had to act: a button tap, a #needs-you card, a re-queue or a fix by hand. Each gets a reason tag:
// decision (only the owner can make it) | broke (Dobby broke or got stuck) | unclear (the message didn't say enough) | permission (missing access).
export const TAGS = ["decision", "broke", "unclear", "permission"]
export function touch(db: DB, t: { ticket?: number | null; kind: string; tag: string; note?: string }, now = Date.now()) {
  ensure(db)
  const tag = TAGS.includes(t.tag) ? t.tag : "decision"
  // One burst = same kind and tag within 60 s (18 re-queues in 3 s is one interruption): the first row counts them in n.
  // A burst ticket other than the row's own gets a row with n=0, so "tickets touched" still sees it.
  const burst = db.prepare("SELECT id, ticket FROM touches WHERE kind=? AND tag=? AND n>0 AND at>? AND at<=? ORDER BY at DESC LIMIT 1").get(t.kind, tag, now - 60_000, now) as { id: number; ticket: number | null } | undefined
  if (burst) {
    db.prepare("UPDATE touches SET n=n+1 WHERE id=?").run(burst.id)
    if (t.ticket != null && (t.ticket !== burst.ticket || t.kind === "session")) db.prepare("INSERT INTO touches (at, ticket, kind, tag, note, n) VALUES (?,?,?,?,?,0)").run(now, t.ticket, t.kind, tag, t.note ?? null)
    return
  }
  db.prepare("INSERT INTO touches (at, ticket, kind, tag, note, n) VALUES (?,?,?,?,?,1)").run(now, t.ticket ?? null, t.kind, tag, t.note ?? null)
}
/** The reason tag for an owner action, from its button data / command. */
export const tagFor = (cmd: string) =>
  /^deploynow\s+\S+\s+migrate/i.test(cmd) ? "decision" : /^(deploynow|reviewfix|reviewaccept|stuckretry)\b/i.test(cmd) ? "broke" : "decision"

/** "N of M shipped with zero owner touches", plus the touches by reason. */
export function autonomy(db: DB, days = 1, now = Date.now()) {
  ensure(db)
  // shipped = new tickets; a fix pushed onto an open PR (onto set) is rework and counted apart (audit #12)
  const since0 = new Date(now - days * 86400_000).toISOString()
  const shipped = db.prepare("SELECT id FROM tickets WHERE status='shipped' AND onto IS NULL AND updated_at>=?").all(since0) as { id: number }[]
  const fixes = (db.prepare("SELECT COUNT(*) n FROM tickets WHERE status='shipped' AND onto IS NOT NULL AND updated_at>=?").get(since0) as { n: number }).n
  const touched = new Set((db.prepare("SELECT DISTINCT ticket FROM touches WHERE ticket IS NOT NULL").all() as { ticket: number }[]).map((r) => r.ticket))
  const alone = shipped.filter((t) => !touched.has(t.id)).length
  const since = now - days * 86400_000
  const tags = db.prepare("SELECT tag, COUNT(*) n FROM touches WHERE at>=? AND n>0 GROUP BY tag ORDER BY n DESC, tag").all(since) as { tag: string; n: number }[]
  const tickets = (db.prepare("SELECT COUNT(DISTINCT ticket) n FROM touches WHERE at>=? AND ticket IS NOT NULL").get(since) as { n: number }).n
  return { alone, shipped: shipped.length, fixes, tags, tickets }
}

export function autonomyLine(db: DB, days = 1, now = Date.now()) {
  const { alone, shipped, fixes, tags, tickets } = autonomy(db, days, now)
  const pct = shipped ? ` (${Math.round((100 * alone) / shipped)}%)` : ""
  const bursts = tags.reduce((n, t) => n + t.n, 0)
  return `🤖 Autonomy: ${alone} of ${shipped} shipped with zero owner touches${pct}. Interruptions: ${bursts}${bursts ? ` (${tags.map((t) => `${t.n} ${t.tag}`).join(", ")})` : ""}. Tickets touched: ${tickets}.${fixes ? ` Review fixes pushed (rework): ${fixes}.` : ""}`
}

/** The daily update's usage block: limits against pace, API-$ per 1% of each window, cache hit per role (flagged under 80%), idle-window warning, day vs night split. */
export function usageLine(db: DB, u: Usage | null, now = Date.now()) {
  ensure(db)
  const from = now - 86400_000
  const all = sum(db, from, now), auto = sum(db, from, now, "source='automated'")
  const tok = db.prepare("SELECT COALESCE(SUM(input),0) i, COALESCE(SUM(write5m)+SUM(write1h),0) w, COALESCE(SUM(read),0) r FROM usage_calls WHERE at>=?").get(from) as { i: number; w: number; r: number }
  const hit = tok.r / Math.max(1, tok.r + tok.i + tok.w)
  const pace = u ? Math.round(100 * Math.min(1, Math.max(0, 1 - u.weekMsToReset / (7 * 86400_000)))) : 0
  const limits = u ? `5-hour ${u.fiveUsed}%, weekly ${u.weekUsed}% (even pace by now: ${pace}%)` : "limits unreadable"
  const f = perPercent(db, "five"), w = perPercent(db, "week")
  const per = (x: number) => (isNaN(x) ? "measuring…" : `$${x.toFixed(2)}`)
  const roles = db.prepare("SELECT kind, COALESCE(SUM(cache_read),0) r, COALESCE(SUM(COALESCE(input_tokens,0)+COALESCE(cache_write,0)),0) o FROM runs WHERE at>=? GROUP BY kind HAVING r+o>0 ORDER BY kind").all(new Date(from).toISOString()) as { kind: string; r: number; o: number }[]
  const cache = roles.map((x) => { const h = Math.round((100 * x.r) / (x.r + x.o)); return `${x.kind} ${h}%${h < 80 ? " ⚠️" : ""}` }).join(", ") || "no runs"
  const { day, night } = nightSplit(db, from, now)
  return [
    `📊 Usage: ${limits} · last 24h $${all.usd.toFixed(2)} API-equivalent, ${Math.round((100 * auto.usd) / Math.max(all.usd, 1e-9))}% Dobby · cache hit ${(100 * hit).toFixed(0)}%`,
    `API-$ per 1%: 5-hour ${per(f.median)}, weekly ${per(w.median)} · cache hit by role (⚠️ under 80%): ${cache} · day (${hh(config().quietHours.end)}-${hh(config().quietHours.start)} ${config().timezoneLabel}) $${day.toFixed(2)}, night (${hh(config().quietHours.start)}-${hh(config().quietHours.end)} ${config().timezoneLabel}) $${night.toFixed(2)}`,
    ...(u && windowIdle(u) ? [`⚠️ 5-hour window idle: ${u.fiveUsed}% used with under 2.5 hours left. Queue more work or that room is lost at reset.`] : []),
  ].join("\n")
}

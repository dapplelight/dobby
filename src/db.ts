// One SQLite file for Dobby's own records: agent runs, health checks, tickets. LangGraph keeps its checkpoints in graph.db.
import Database from "better-sqlite3"
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite"
import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { config, expand } from "./config.ts"

export type DB = Database.Database
export const DATA = process.env.DOBBY_DIR ?? expand(config().paths.data)

/**
 * Every ticket status in use (docs and tests read this list; the column has no CHECK constraint on purpose, so an old row never
 * breaks a migration). backlog -> ready -> running -> shipped | failed | declined; fixing = a review fix on its PR; approval =
 * waits at the old gate; split = an L ticket turned into a program.
 */
export const STATUSES = ["backlog", "ready", "running", "fixing", "approval", "split", "shipped", "declined", "failed"] as const
/** Guarded ALTERs: a column that is already there is fine, anything else (disk full, locked, a typo) is a real error. */
export function addColumn(db: DB, sql: string) {
  try { db.exec(sql) } catch (e) { if (!/duplicate column/i.test((e as Error).message)) throw e }
}

/** The data folder holds ticket text, logs and PR details: 700 for the folder, 600 for the database files (an older install made them 755/644). */
function lockDown(path: string) {
  try { chmodSync(DATA, 0o700) } catch {}
  for (const f of [path, `${path}-wal`, `${path}-shm`]) try { if (existsSync(f)) chmodSync(f, 0o600) } catch {}
}
export function open(path = `${DATA}/dobby.db`): DB {
  if (path !== ":memory:") mkdirSync(DATA, { recursive: true, mode: 0o700 }), lockDown(path)
  const db = new Database(path)
  db.pragma("journal_mode = WAL")
  if (path !== ":memory:") lockDown(path) // the -wal and -shm files exist now
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY, at TEXT NOT NULL, project TEXT NOT NULL, kind TEXT NOT NULL, ticket INTEGER,
      model TEXT, ok INTEGER NOT NULL, reason TEXT, turns INTEGER, duration_ms INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, cache_read INTEGER, cache_write INTEGER,
      cost_usd REAL, session_id TEXT, human TEXT -- approved | declined | edited | reverted, filled in later
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, done_when TEXT NOT NULL DEFAULT '',
      size TEXT NOT NULL DEFAULT 'S', priority INTEGER NOT NULL DEFAULT 50,
      risk TEXT NOT NULL DEFAULT 'high', -- low | medium | high, from Jev triage; high when unsure
      status TEXT NOT NULL DEFAULT 'ready', -- ready | running | approval | shipped | declined | failed
      branch TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ideas (
      id INTEGER PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, -- you | strategist (old) | pm | area | scout
      lens TEXT, why TEXT, evidence TEXT, risks TEXT, size TEXT, experiment TEXT, score INTEGER,
      status TEXT NOT NULL DEFAULT 'new', -- new (your seed, not developed) | proposed | approved | rejected
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
    -- one row per 5-hour usage window: how full it got, whether builders paused, how many builds started
    CREATE TABLE IF NOT EXISTS windows (reset_at INTEGER PRIMARY KEY, peak REAL NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, builds INTEGER NOT NULL DEFAULT 0);
    -- one row per reviewed PR head: choice none|haiku|sonnet|opus, by rule|jev|fallback, verdict running|pass|fail|skip|error
    CREATE TABLE IF NOT EXISTS reviews (
      repo TEXT NOT NULL, pr INTEGER NOT NULL, sha TEXT NOT NULL, choice TEXT, by TEXT, verdict TEXT NOT NULL, cost REAL, at TEXT NOT NULL,
      PRIMARY KEY (repo, pr, sha)
    );
    -- owner-set goals per project, mirrored from the "## Goals" list in projects/<app>.md (rank 1 = most important)
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, rank INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', -- active | dropped
      updated_at TEXT NOT NULL
    );
    -- a program = one goal's multi-ticket work in build order (the Engineering Manager splits an L ticket with a PRD into one)
    CREATE TABLE IF NOT EXISTS programs (
      id INTEGER PRIMARY KEY, project TEXT NOT NULL, title TEXT NOT NULL, goal INTEGER, source_ticket INTEGER,
      status TEXT NOT NULL DEFAULT 'open', -- open | done
      checks INTEGER NOT NULL DEFAULT 0, -- launch checks run
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS program_tickets (program INTEGER NOT NULL, ticket INTEGER NOT NULL, pos INTEGER NOT NULL, PRIMARY KEY (program, ticket));
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY, at TEXT NOT NULL, name TEXT NOT NULL, ok INTEGER NOT NULL, detail TEXT
    );
    -- Claude Code OpenTelemetry events from Dobby's own runs (src/telemetry.ts): an allowlist of fields only, pruned after 30 days
    CREATE TABLE IF NOT EXISTS telemetry (
      id INTEGER PRIMARY KEY, at TEXT NOT NULL, session_id TEXT, project TEXT, kind TEXT, ticket INTEGER, event TEXT NOT NULL,
      model TEXT, tool_name TEXT, success INTEGER, duration_ms REAL, decision TEXT, decision_source TEXT, error_type TEXT, error TEXT, status_code INTEGER,
      cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_creation_tokens INTEGER, attempt INTEGER
    );
    CREATE INDEX IF NOT EXISTS telemetry_at ON telemetry (at);
    CREATE INDEX IF NOT EXISTS telemetry_ticket ON telemetry (ticket);`)
  // columns added after the first schema; ignore "duplicate column" on databases that have them
  for (const sql of ["ALTER TABLE runs ADD COLUMN ticket INTEGER", "ALTER TABLE tickets ADD COLUMN risk TEXT NOT NULL DEFAULT 'high'", "ALTER TABLE tickets ADD COLUMN dup_of TEXT", "ALTER TABLE ideas ADD COLUMN dup_of TEXT", "ALTER TABLE tickets ADD COLUMN onto TEXT", "ALTER TABLE tickets ADD COLUMN goal INTEGER", "ALTER TABLE goals ADD COLUMN milestone INTEGER", "ALTER TABLE ideas ADD COLUMN goal INTEGER", "ALTER TABLE tickets ADD COLUMN engineer TEXT", "ALTER TABLE tickets ADD COLUMN prd TEXT", "ALTER TABLE tickets ADD COLUMN design TEXT", "ALTER TABLE tickets ADD COLUMN depends_on INTEGER"]) {
    addColumn(db, sql)
  }
  addColumn(db, "ALTER TABLE reviews ADD COLUMN pid INTEGER") // the review claim's holder: a dead pid frees it (review.ts claim)
  return db
}

export type Run = {
  project: string; kind: string; ticket?: number; model?: string; ok: boolean; reason?: string; turns?: number; duration_ms?: number
  input_tokens?: number; output_tokens?: number; cache_read?: number; cache_write?: number; cost_usd?: number; session_id?: string
}

export function logRun(db: DB, r: Run, at = new Date().toISOString()) {
  db.prepare(`INSERT INTO runs (at,project,kind,ticket,model,ok,reason,turns,duration_ms,input_tokens,output_tokens,cache_read,cache_write,cost_usd,session_id)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(at, r.project, r.kind, r.ticket ?? null, r.model ?? null, r.ok ? 1 : 0, r.reason ?? null, r.turns ?? null, r.duration_ms ?? null,
      r.input_tokens ?? null, r.output_tokens ?? null, r.cache_read ?? null, r.cache_write ?? null, r.cost_usd ?? null, r.session_id ?? null)
}

export function logCheck(db: DB, name: string, ok: boolean, detail = "", at = new Date().toISOString()) {
  db.prepare("INSERT INTO checks (at,name,ok,detail) VALUES (?,?,?,?)").run(at, name, ok ? 1 : 0, detail)
}

/** Remember a 5-hour window: its peak use, and optionally that builders paused or a build started. Keyed by reset time (to 10 min). */
export function noteWindow(db: DB, fiveUsed: number, fiveMsToReset: number | undefined, mark: { paused?: boolean; build?: boolean } = {}, now = Date.now()) {
  if (!fiveMsToReset) return
  const key = Math.round((now + fiveMsToReset) / 600_000) * 600_000
  db.prepare("INSERT INTO windows (reset_at, peak) VALUES (?, ?) ON CONFLICT(reset_at) DO UPDATE SET peak = max(peak, excluded.peak)").run(key, fiveUsed)
  if (mark.paused) db.prepare("UPDATE windows SET paused = 1 WHERE reset_at = ?").run(key)
  if (mark.build) db.prepare("UPDATE windows SET builds = builds + 1 WHERE reset_at = ?").run(key)
}

/** Last 7 days of windows in one line, plus what to change. Pure over the rows. */
export function capacityLine(rows: { peak: number; paused: number; builds: number }[]) {
  if (!rows.length) return ""
  const maxed = rows.filter((r) => r.peak >= 98).length
  const paused = rows.filter((r) => r.paused).length
  const avg = Math.round(rows.reduce((n, r) => n + r.peak, 0) / rows.length)
  const builds = rows.reduce((n, r) => n + r.builds, 0)
  const advice = maxed >= 3 ? "you hit the limit often: lower builders to 1 by day, or the daytime cap to 50%"
    : paused >= 3 && maxed === 0 ? "builders often wait with room to spare: raise the daytime cap to 70% or add a builder"
    : avg < 40 ? "lots of unused budget: add a builder by day"
    : "about right"
  return `📊 Last 7 days: ${rows.length} five-hour windows, average peak ${avg}%, ${maxed} maxed out, builders paused in ${paused}, ${builds} builds. Suggestion: ${advice}.`
}

export function capacityFromDb(db: DB, now = Date.now()) {
  return capacityLine(db.prepare("SELECT peak, paused, builds FROM windows WHERE reset_at > ? AND reset_at <= ?").all(now - 7 * 86_400_000, now) as { peak: number; paused: number; builds: number }[])
}

// ---- graph.db (LangGraph checkpoints) -----------------------------------------------------------------------------------------
const savers = new Map<string, SqliteSaver>()
/** One SqliteSaver per graph.db per process (audit #27: a new connection per ticket), in WAL mode. */
export function graphSaver(path = `${DATA}/graph.db`): SqliteSaver {
  let s = savers.get(path)
  if (!s) {
    if (path !== ":memory:") mkdirSync(DATA, { recursive: true })
    const g = new Database(path)
    g.pragma("journal_mode = WAL")
    savers.set(path, (s = new SqliteSaver(g)))
  }
  return s
}

const DAY = 86_400_000
/**
 * Checkpoints of tickets that ended (shipped, declined, failed) more than `days` ago, and of review threads (review-<repo>-<pr>-<sha>)
 * whose PR had no review for that long (the local stand-in for merged or closed): only the newest top-level checkpoint per thread
 * stays (`dobby show` still reads its log); older ones, subgraph rows (ship:<uuid> namespaces) and orphaned writes go.
 * Returns rows deleted. A graph.db without tables is fine.
 */
export function pruneCheckpoints(db: DB, graph: Database.Database, now = Date.now(), days = 7): number {
  if (!graph.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoints'").get()) return 0
  const cut = new Date(now - days * DAY).toISOString()
  const threads = (db.prepare("SELECT id FROM tickets WHERE status IN ('shipped','declined','failed') AND updated_at < ?").all(cut) as { id: number }[]).map(({ id }) => `ticket-${id}`)
  const lastReview = db.prepare("SELECT MAX(at) at FROM reviews WHERE (repo=? OR repo LIKE ?) AND pr=?")
  for (const { thread_id } of graph.prepare("SELECT DISTINCT thread_id FROM checkpoints WHERE thread_id LIKE 'review-%'").all() as { thread_id: string }[]) {
    const m = thread_id.match(/^review-(.+)-(\d+)-[0-9a-f]{7,40}$/)
    const at = m ? (lastReview.get(m[1], `%/${m[1]}`, Number(m[2])) as { at: string | null }).at : null
    if (at && at < cut) threads.push(thread_id)
  }
  const cp = graph.prepare("DELETE FROM checkpoints WHERE thread_id=? AND (checkpoint_ns != '' OR checkpoint_id < (SELECT MAX(c.checkpoint_id) FROM checkpoints c WHERE c.thread_id=checkpoints.thread_id AND c.checkpoint_ns=''))")
  const wr = graph.prepare("DELETE FROM writes WHERE thread_id=? AND NOT EXISTS (SELECT 1 FROM checkpoints c WHERE c.thread_id=writes.thread_id AND c.checkpoint_ns=writes.checkpoint_ns AND c.checkpoint_id=writes.checkpoint_id)")
  let n = 0
  graph.transaction(() => { for (const t of threads) n += cp.run(t).changes + wr.run(t).changes })()
  return n
}

/**
 * kv and checks rows older than `days` (audit #30: they only grew): dated keys (lead:<project>:<day>, digest:<day>,
 * budget:paused:<window>, usage/brief/health day markers), per-ticket gh:* and discord:* keys of tickets shipped that long ago or
 * declined over 90 days ago (a declined ticket may be revived; failed ones may be re-queued, so their board issue and thread stay),
 * prcheck:<id> of failed tickets, and checks rows. Channel, webhook and board keys stay.
 */
export function pruneKv(db: DB, now = Date.now(), days = 30): number {
  const cut = now - days * DAY, cutDay = new Date(cut).toISOString().slice(0, 10)
  let n = 0
  const del = db.prepare("DELETE FROM kv WHERE k=?")
  db.transaction(() => {
    for (const { k } of db.prepare("SELECT k FROM kv WHERE k LIKE 'lead:%' OR k LIKE 'digest:%' OR k LIKE 'budget:paused:%' OR k LIKE 'brief:%' OR k LIKE 'health:told:%'").all() as { k: string }[]) {
      const day = k.match(/(\d{4}-\d{2}-\d{2})$/)?.[1]
      const win = k.match(/^budget:paused:(\d+)$/)?.[1]
      if ((day && day < cutDay) || (win && Number(win) * 600_000 < cut)) n += del.run(k).changes
    }
    const old = db.prepare("SELECT id FROM tickets WHERE (status='shipped' AND updated_at < ?) OR (status='declined' AND updated_at < ?)").all(new Date(cut).toISOString(), new Date(now - 90 * DAY).toISOString()) as { id: number }[]
    for (const { id } of db.prepare("SELECT id FROM tickets WHERE status='failed' AND updated_at < ?").all(new Date(cut).toISOString()) as { id: number }[]) n += del.run(`prcheck:${id}`).changes
    for (const { id } of old) for (const k of [`gh:issue:${id}`, `gh:stage:${id}`, `gh:item:${id}`, `discord:thread:${id}`, `discord:status:${id}`, `discord:msg:ticket:${id}`, `prcheck:${id}`]) n += del.run(k).changes
    n += db.prepare("DELETE FROM checks WHERE at < ?").run(new Date(cut).toISOString()).changes
  })()
  return n
}

/** Once a day (kv prune:day): pruneCheckpoints on graph.db and pruneKv. Called by the hourly health job. */
export function dailyPrune(db: DB, now = Date.now(), graphPath = `${DATA}/graph.db`): string | null {
  const day = new Date(now).toISOString().slice(0, 10)
  if ((db.prepare("SELECT v FROM kv WHERE k='prune:day'").get() as { v: string } | undefined)?.v === day) return null
  db.prepare("INSERT OR REPLACE INTO kv VALUES ('prune:day', ?)").run(day)
  const g = existsSync(graphPath) ? graphSaver(graphPath).db : null
  const cps = g ? pruneCheckpoints(db, g, now) : 0
  // Deleted rows leave free pages: once a month, while no tick holds the lock (heartbeat older than 15 min), VACUUM gives them back.
  const month = day.slice(0, 7), lock = Number((db.prepare("SELECT v FROM kv WHERE k='lock'").get() as { v: string } | undefined)?.v ?? 0)
  let vac = ""
  if (g && (db.prepare("SELECT v FROM kv WHERE k='vacuum:month'").get() as { v: string } | undefined)?.v !== month && now - lock > 15 * 60_000) {
    db.prepare("INSERT OR REPLACE INTO kv VALUES ('vacuum:month', ?)").run(month)
    try { g.exec("VACUUM"); vac = ", graph.db vacuumed" } catch (e) { vac = `, vacuum skipped: ${(e as Error).message}` }
  }
  return `pruned ${cps} checkpoint row(s), ${pruneKv(db, now)} kv/checks row(s)${vac}`
}

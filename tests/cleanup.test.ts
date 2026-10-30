// Daily cleanup (dailyPrune): old table rows, ticket worktrees and branches, oversized logs, weekly VACUUM. Offline: temp data dir and temp git repos.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-cleanup-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_CONFIG = `${dir}/config.json`
const { open, DATA, pruneTables, trimLogs, dailyPrune } = await import("../src/db.ts")
const { addTicket, setTicket, sweepTicketWorktrees, sweepTicketBranches } = await import("../src/lib.ts")

const D = 86_400_000, T = Date.parse("2026-10-25T10:00:00Z")
const g = (cwd: string, ...a: string[]) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout }
const repo = `${dir}/repo`
mkdirSync(repo)
g(repo, "init", "-q", "-b", "main"); g(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i")
const remote = `${dir}/remote.git` // branches are only pruned when their tip is on a remote
g(dir, "init", "-q", "--bare", "-b", "main", remote)
g(repo, "remote", "add", "origin", remote)
g(repo, "push", "-q", "origin", "main")
const repos = { tally: repo }
const db = open()
const ticket = (status: string, ageDays: number) => {
  const { id } = addTicket(db, { project: "tally", title: "t" })
  setTicket(db, id, { status })
  db.prepare("UPDATE tickets SET updated_at=? WHERE id=?").run(new Date(T - ageDays * D).toISOString(), id)
  return id
}
const old = (p: string, days: number) => utimesSync(p, (T - days * D) / 1000, (T - days * D) / 1000)
const n = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n

test("tables: old rows go, recent rows and runs of recent or open tickets stay", () => {
  const done = ticket("shipped", 200), recent = ticket("shipped", 10), open_ = ticket("ready", 400)
  const run = (at: number, t: number | null) => db.prepare("INSERT INTO runs (at, project, kind, ok, ticket) VALUES (?, 'tally', 'build', 1, ?)").run(new Date(T - at * D).toISOString(), t)
  run(200, done); run(200, recent); run(200, open_); run(200, null); run(5, null); run(190, done)
  assert.equal(pruneTables(db, T), 3) // no usage_* tables yet: skipped; only the runs go
  db.exec("CREATE TABLE IF NOT EXISTS usage_log (at INTEGER NOT NULL, model TEXT NOT NULL, kind TEXT NOT NULL, tokens INTEGER NOT NULL, usd REAL NOT NULL, PRIMARY KEY (at, model, kind))")
  db.exec("CREATE TABLE IF NOT EXISTS usage_ticks (at INTEGER PRIMARY KEY, five INTEGER, week INTEGER, five_reset INTEGER, week_reset INTEGER)")
  for (const d of [40, 5]) db.prepare("INSERT INTO usage_log VALUES (?, 'm', 'k', 1, 1)").run(T - d * D)
  for (const d of [90, 60]) db.prepare("INSERT INTO usage_ticks VALUES (?, 1, 1, 1, 1)").run(T - d * D) // idle for months: the newest tick stays
  db.prepare("INSERT INTO telemetry (at, event) VALUES (?, 'e'), (?, 'e')").run(new Date(T - 40 * D).toISOString(), new Date(T - 1 * D).toISOString())
  // usage_log 1, usage_ticks 1 (not the newest), telemetry 1
  assert.equal(pruneTables(db, T), 3) // the runs went already
  assert.equal(n("runs"), 3) // recent ticket, open ticket, recent run without a ticket
  assert.equal(n("usage_log"), 1); assert.equal(n("usage_ticks"), 1); assert.equal(n("telemetry"), 1)
})

test("worktrees: stale ended ticket goes; a live claim, open tickets and young dirs stay", () => {
  const wt = `${DATA}/wt`
  mkdirSync(wt, { recursive: true })
  const add = (id: number, ageDays: number) => { const d = `${wt}/tally-${id}`; g(repo, "worktree", "add", "-q", "--detach", d); old(d, ageDays); return d }
  const shipped = add(ticket("shipped", 3), 3), young = add(ticket("shipped", 3), 0), ready = add(ticket("ready", 3), 3)
  const running = ticket("running", 3), runningD = add(running, 3)
  db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`build:${running}`, `${process.pid}:${Date.now()}`)
  const failed = ticket("failed", 3), failedD = add(failed, 3)
  db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`build:${failed}`, `${process.pid}:${Date.now()}`) // ended but a live claim: keep
  mkdirSync(`${wt}/tally-base-9`); old(`${wt}/tally-base-9`, 3) // not a ticket dir, held by nothing: goes
  assert.deepEqual(sweepTicketWorktrees(db, wt, repos, T).sort(), [shipped.split("/").pop(), "tally-base-9"].sort())
  assert.ok(!existsSync(shipped) && !existsSync(`${wt}/tally-base-9`))
  for (const d of [runningD, young, ready, failedD]) assert.ok(existsSync(d))
  assert.ok(!g(repo, "worktree", "list").includes(shipped)) // git forgot it too
})

test("branches: ended tickets' dobby/<id> go; ready, young and checked-out stay", () => {
  const declined = ticket("declined", 10), ready = ticket("ready", 10), young = ticket("failed", 2), head = ticket("shipped", 10)
  for (const id of [declined, ready, young, head]) g(repo, "branch", `dobby/${id}`)
  g(repo, "checkout", "-q", `dobby/${head}`)
  assert.equal(sweepTicketBranches(db, repos, T), 1)
  const left = g(repo, "branch", "--format=%(refname:short)")
  assert.ok(!left.includes(`dobby/${declined}\n`))
  for (const id of [ready, young, head]) assert.ok(left.includes(`dobby/${id}\n`))
  g(repo, "checkout", "-q", "main")
})

test("branches: a branch whose tip is on no remote is the only copy of the work and is never deleted", () => {
  const local = ticket("failed", 10), pushed = ticket("failed", 10)
  g(repo, "branch", `dobby/${pushed}`)
  g(repo, "checkout", "-q", "-b", `dobby/${local}`)
  g(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "finished work, kept local")
  g(repo, "checkout", "-q", "main")
  sweepTicketBranches(db, repos, T)
  const left = g(repo, "branch", "--format=%(refname:short)")
  assert.ok(left.includes(`dobby/${local}\n`) && !left.includes(`dobby/${pushed}\n`))
})

test("logs: 6 MB is cut to 1 MB plus a marker and keeps its last line; 1 MB is untouched", () => {
  const logs = `${DATA}/logs`
  mkdirSync(logs, { recursive: true })
  const line = "x".repeat(99) + "\n"
  writeFileSync(`${logs}/big.log`, line.repeat(60_000) + "the last line\n")
  writeFileSync(`${logs}/small.log`, line.repeat(10_000))
  const out = trimLogs([logs], T)
  assert.equal(out.length, 1); assert.match(out[0], /^big\.log \d\.\d MB → 1\.0 MB$/)
  const s = readFileSync(`${logs}/big.log`, "utf8")
  assert.ok(statSync(`${logs}/big.log`).size <= 1048576 + 40)
  assert.ok(s.startsWith("… older lines removed 2026-10-25\n"))
  assert.ok(s.endsWith("the last line\n")); assert.equal(s.split("\n")[1].length, 99) // starts on a line boundary
  assert.equal(statSync(`${logs}/small.log`).size, 1_000_000)
})

test("vacuum: once a week, never with a running ticket", () => {
  const v = open(`${dir}/v.db`)
  const { id } = addTicket(v, { project: "tally", title: "t" })
  setTicket(v, id, { status: "running" })
  const go = (at: number) => dailyPrune(v, at, `${dir}/none.db`)!
  assert.doesNotMatch(go(T), /vacuum/)
  setTicket(v, id, { status: "shipped" })
  assert.match(go(T + D), /dobby\.db vacuumed/)
  assert.doesNotMatch(go(T + 2 * D), /vacuum/)
  assert.doesNotMatch(go(T + 6 * D), /vacuum/)
  assert.match(go(T + 8 * D), /dobby\.db vacuumed/)
})

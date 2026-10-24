// Review fixes on async-health: per-verb child timeouts, kill escalation, push limit + repo git queue, semaphore, typed/button
// race, stale rebase worktree sweep, health idle/tick/running/told, review-thread and subgraph prune, monthly vacuum. Offline.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import Database from "better-sqlite3"

const dir = mkdtempSync(`${tmpdir()}/foreman-review-fix-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/secrets.env`

const lib = await import("../src/lib.ts")
const { open, graphSaver, pruneCheckpoints, pruneKv, dailyPrune, logRun } = await import("../src/db.ts")
const { addTicket } = lib
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" })
const LONG = "30" // seconds a test child would sleep if nothing stopped it

test("child timeouts by verb: landing/deploy verbs 3 h, cheap ones 20 min, scan 90 min, all overridable", () => {
  for (const c of ["approve 12", "reviewaccept a/b 3", "scoutmerge a/b 4", "deploynow tally", "run 5", "company"]) assert.equal(lib.doTimeoutMs(c, {}), 3 * 3600_000, c)
  for (const c of ["queue 12", "dropidea 3", "discard x", "pause"]) assert.equal(lib.doTimeoutMs(c, {}), 20 * 60_000, c)
  assert.equal(lib.doTimeoutMs("approve 1", { DOBBY_TIMEOUT_DO_LONG_MS: "7000" }), 7000)
  assert.equal(lib.doTimeoutMs("queue 1", { DOBBY_TIMEOUT_DO_MS: "9000" }), 9000)
  assert.equal(lib.timeoutMs("scan", {}), 90 * 60_000)
  assert.equal(lib.timeoutMs("push", {}), lib.timeoutMs("verify", {}))
})

test("kill escalation: SIGTERM first so the child can clean up; SIGKILL after the grace for one that ignores it", async () => {
  const f = `${dir}/cleaned`
  const t0 = Date.now()
  const r = await lib.runAsync("zsh", ["-c", `trap 'echo cleaned > ${f}; exit 0' TERM; sleep ${LONG} & wait`], { timeoutMs: 200, graceMs: 2000 })
  assert.equal(r.timedOut, true)
  assert.equal(readFileSync(f, "utf8"), "cleaned\n") // its own trap ran
  assert.ok(Date.now() - t0 < 2000, "it exited on SIGTERM, no wait for the grace")
  const t1 = Date.now()
  const stubborn = await lib.runAsync("zsh", ["-c", `trap '' TERM; sleep ${LONG}`], { timeoutMs: 200, graceMs: 300 })
  assert.equal(stubborn.timedOut, true)
  assert.ok(Date.now() - t1 < 4000, "SIGKILL after the grace")
})

test("pushes get the push limit (pre-push hooks run CI), other git calls 2 min; git writes in one repo queue; a lock error is retried once", async () => {
  const root = mkdtempSync(`${tmpdir()}/foreman-push-`)
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git"); git(root, "clone", "-q", `${root}/origin.git`, "repo")
  const repo = `${root}/repo`
  git(repo, "config", "user.name", "t"); git(repo, "config", "user.email", "t@t")
  writeFileSync(`${repo}/a`, "a"); git(repo, "add", "."); git(repo, "commit", "-qm", "a")
  writeFileSync(`${repo}/.git/hooks/pre-push`, "#!/bin/sh\nsleep 1\n", { mode: 0o755 })
  process.env.DOBBY_TIMEOUT_GIT_MS = "300"
  try {
    const p = await lib.netRun("git", ["push", "-q", "origin", "HEAD:main"], repo) // 1 s hook > 300 ms git limit: the push limit applies
    assert.equal(p.ok, true, p.out)
    // config.lock held by "another git": the first try fails on the lock, the retry 2 s later succeeds
    process.env.DOBBY_TIMEOUT_GIT_MS = "10000"
    writeFileSync(`${repo}/.git/config.lock`, "")
    setTimeout(() => rmSync(`${repo}/.git/config.lock`), 500)
    const c = await lib.netRun("git", ["config", "foreman.test", "1"], repo)
    assert.equal(c.ok, true, c.out)
    assert.equal(git(repo, "config", "foreman.test").stdout.trim(), "1")
  } finally { delete process.env.DOBBY_TIMEOUT_GIT_MS }
  const order: string[] = []
  const m = lib.keyedMutex()
  await Promise.all([m("r", async () => { order.push("a+"); await lib.sleep(50); order.push("a-") }), m("r", async () => { order.push("b+"); order.push("b-") }), m("other", async () => { order.push("o") })])
  assert.ok(order.indexOf("a-") < order.indexOf("b+") && order.indexOf("o") < order.indexOf("a-"))
})

test("semaphore: at most n at once (installs/verifies, button children), waits logged, a failing job frees its slot", async () => {
  const logs: string[] = []
  const sem = lib.semaphore(2, (m) => logs.push(m))
  let now = 0, max = 0
  const job = (fail = false) => async () => { now++; max = Math.max(max, now); await lib.sleep(30); now--; if (fail) throw new Error("x") }
  await Promise.allSettled([sem("verify a", job(true)), sem("verify b", job()), sem("verify c", job()), sem("verify d", job())])
  assert.equal(max, 2)
  assert.equal(logs.length, 2)
  assert.match(logs[0], /^verify c: waited \d+ s for a free slot \(2 at once\)$/)
  await sem("after", job()) // slots all free again
})

test("typed command and button share a lane; the gate resume is claimed once (a typed approve plus a tap cannot ship twice)", async () => {
  const { laneOf } = await import("../src/discord.ts")
  const b = (data: string) => ({ kind: "button" as const, data, id: "", token: "", content: "", app: "" })
  assert.equal(laneOf({ kind: "ask", text: "approve 12" }), laneOf(b("approve 12")))
  assert.equal(laneOf({ kind: "ask", text: "Reviewaccept ownerdev/tally 7" }), laneOf(b("reviewfix ownerdev/tally 7")))
  assert.equal(laneOf({ kind: "ask", text: "what is building?" }), "ask")
  const db = open(":memory:")
  // the race: both see the gate, both try to claim; exactly one wins
  assert.deepEqual([lib.claimKey(db, "resume:12:gate"), lib.claimKey(db, "resume:12:gate")], [true, false])
  // a holder that died (killed child) does not block the gate forever
  db.prepare("UPDATE kv SET v='999999:1' WHERE k='resume:12:gate'").run()
  assert.equal(lib.claimKey(db, "resume:12:gate"), true)
  assert.equal(lib.claimKey(db, "resume:12:gate"), false)
})

test("startup sweep: -rebase worktrees over an hour old are removed and unregistered; fresh ones stay", () => {
  const root = mkdtempSync(`${tmpdir()}/foreman-sweep-`)
  git(root, "init", "-q", "-b", "main", "repo")
  const repo = `${root}/repo`
  git(repo, "config", "user.name", "t"); git(repo, "config", "user.email", "t@t"); git(repo, "commit", "-q", "--allow-empty", "-m", "a")
  mkdirSync(`${root}/wt`)
  git(repo, "worktree", "add", "-q", "--detach", `${root}/wt/tally-1-rebase`); git(repo, "worktree", "add", "-q", "--detach", `${root}/wt/tally-2-rebase`)
  const old = new Date(Date.now() - 2 * 3600_000)
  utimesSync(`${root}/wt/tally-1-rebase`, old, old)
  assert.deepEqual(lib.sweepRebaseWorktrees(`${root}/wt`), ["tally-1-rebase"])
  assert.deepEqual(readdirSync(`${root}/wt`), ["tally-2-rebase"])
  assert.doesNotMatch(git(repo, "worktree", "list").stdout, /tally-1-rebase/)
  assert.deepEqual(lib.sweepRebaseWorktrees(`${root}/missing`), [])
})

test("health fixes: idle counts only takeable work and not while the budget window is paused; tick heartbeat; running with a live tick; told after a good send", async () => {
  const { pipelineChecks, pipelineWatch } = await import("../src/health.ts")
  const T = Date.parse("2026-10-20T10:00:00Z"), H = 3600_000
  const home = mkdtempSync(`${tmpdir()}/foreman-health2-`)
  const env = { now: T, dir: home, freeGb: () => 100, projects: { tally: { paused: false }, shopfront: { paused: true } } as Record<string, { paused: boolean }> }
  const get = (db: ReturnType<typeof open>) => Object.fromEntries(pipelineChecks(db, env).map((x) => [x.check, x]))
  const db = open(":memory:")
  logRun(db, { project: "tally", kind: "build", ok: true }, new Date(T - 3 * H).toISOString())
  addTicket(db, { project: "tally", title: "big", size: "L" }); addTicket(db, { project: "shopfront", title: "paused app" })
  assert.equal(get(db).idle.ok, true) // an L ticket and a paused project's ticket are not takeable
  const t = addTicket(db, { project: "tally", title: "small" }).id
  assert.equal(get(db).idle.ok, false)
  db.prepare("INSERT INTO kv VALUES ('pause', ?)").run(JSON.stringify({ tickets: { [t]: { at: T - H, by: "the owner" } } }))
  assert.equal(get(db).idle.ok, true) // that ticket is paused
  db.prepare("DELETE FROM kv WHERE k='pause'").run()
  db.prepare("INSERT INTO windows (reset_at, peak, paused) VALUES (?, 80, 1)").run(T + H)
  assert.equal(get(db).idle.ok, true) // the budget paused this window
  // tick: lock heartbeat or tick:last; a running ticket with the heartbeat fresh is working
  db.prepare("UPDATE tickets SET status='running', updated_at=? WHERE id=?").run(new Date(T - 3 * H).toISOString(), t)
  assert.equal(get(db)["tick log"].ok, true) // never ran yet
  db.prepare("INSERT INTO kv VALUES ('tick:last', ?)").run(String(T - 3 * H))
  assert.match(get(db)["tick log"].text, /the tick has not run for 180 minutes/)
  assert.equal(get(db).running.ok, false)
  db.prepare("INSERT INTO kv VALUES ('lock', ?)").run(String(T - 4 * 60_000))
  assert.deepEqual([get(db)["tick log"].ok, get(db).running.ok], [true, true])
  // told only after a good send
  db.prepare("DELETE FROM kv WHERE k='lock'").run()
  let tries = 0
  assert.deepEqual((await pipelineWatch(db, async () => (tries++, false), env)).sent, [])
  const w2 = await pipelineWatch(db, async () => { tries++; return true }, env)
  assert.ok(w2.sent.length > 0 && tries > w2.sent.length)
  assert.deepEqual((await pipelineWatch(db, async () => true, env)).sent, [])
})

test("prune: review threads idle 7 days and ship subgraph rows go (newest top-level kept); declined board keys stay 90 days; failed prcheck goes; vacuum monthly when idle", () => {
  const db = open(":memory:")
  const T = Date.parse("2026-10-20T10:00:00Z"), D = 86_400_000
  const id = addTicket(db, { project: "p", title: "a" }).id
  db.prepare("UPDATE tickets SET status='shipped', updated_at=? WHERE id=?").run(new Date(T - 8 * D).toISOString(), id)
  db.prepare("INSERT INTO reviews (repo,pr,sha,verdict,at) VALUES ('ownerdev/tally', 7, 'aaaaaaa', 'pass', ?), ('ownerdev/my-app', 8, 'bbbbbbb', 'pass', ?)").run(new Date(T - 9 * D).toISOString(), new Date(T - D).toISOString())
  const g = new Database(":memory:")
  g.exec("CREATE TABLE checkpoints (thread_id TEXT, checkpoint_ns TEXT DEFAULT '', checkpoint_id TEXT, parent_checkpoint_id TEXT, type TEXT, checkpoint BLOB, metadata BLOB); CREATE TABLE writes (thread_id TEXT, checkpoint_ns TEXT DEFAULT '', checkpoint_id TEXT, task_id TEXT, idx INTEGER, channel TEXT, type TEXT, value BLOB)")
  const add = (t: string, ns: string, c: string) => g.prepare("INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id) VALUES (?, ?, ?)").run(t, ns, c)
  for (const t of [`ticket-${id}`, "review-tally-7-aaaaaaa", "review-my-app-8-bbbbbbb"]) { add(t, "", "c1"); add(t, "", "c2") }
  add(`ticket-${id}`, "ship:1234", "c9")
  pruneCheckpoints(db, g, T)
  const left = (g.prepare("SELECT thread_id||'/'||checkpoint_ns||'/'||checkpoint_id x FROM checkpoints ORDER BY x").all() as { x: string }[]).map((r) => r.x)
  assert.deepEqual(left, ["review-my-app-8-bbbbbbb//c1", "review-my-app-8-bbbbbbb//c2", "review-tally-7-aaaaaaa//c2", `ticket-${id}//c2`])
  // kv: declined 40 days ago keeps its board issue (it may be revived), 100 days ago loses it; failed loses only prcheck
  const dec = addTicket(db, { project: "p", title: "d" }).id, decOld = addTicket(db, { project: "p", title: "e" }).id, fail = addTicket(db, { project: "p", title: "f" }).id
  db.prepare("UPDATE tickets SET status='declined', updated_at=? WHERE id=?").run(new Date(T - 40 * D).toISOString(), dec)
  db.prepare("UPDATE tickets SET status='declined', updated_at=? WHERE id=?").run(new Date(T - 100 * D).toISOString(), decOld)
  db.prepare("UPDATE tickets SET status='failed', updated_at=? WHERE id=?").run(new Date(T - 40 * D).toISOString(), fail)
  for (const k of [`gh:issue:${dec}`, `gh:issue:${decOld}`, `gh:issue:${fail}`, `prcheck:${fail}`]) db.prepare("INSERT INTO kv VALUES (?, '1')").run(k)
  pruneKv(db, T)
  const keys = (db.prepare("SELECT k FROM kv WHERE k LIKE 'gh:%' OR k LIKE 'prcheck:%' ORDER BY k").all() as { k: string }[]).map((r) => r.k)
  assert.deepEqual(keys, [`gh:issue:${dec}`, `gh:issue:${fail}`].sort())
  // monthly vacuum: not while a tick holds the lock; once a month otherwise
  const gp = `${dir}/graph-vac.db`
  graphSaver(gp).db.exec("CREATE TABLE IF NOT EXISTS checkpoints (thread_id TEXT, checkpoint_ns TEXT DEFAULT '', checkpoint_id TEXT); CREATE TABLE IF NOT EXISTS writes (thread_id TEXT, checkpoint_ns TEXT DEFAULT '', checkpoint_id TEXT)")
  db.prepare("INSERT OR REPLACE INTO kv VALUES ('lock', ?)").run(String(T - 60_000))
  assert.doesNotMatch(dailyPrune(db, T, gp)!, /vacuum/)
  db.prepare("DELETE FROM kv WHERE k='lock'").run()
  assert.match(dailyPrune(db, T + D, gp)!, /graph\.db vacuumed/)
  assert.doesNotMatch(dailyPrune(db, T + 2 * D, gp)!, /vacuum/)
})

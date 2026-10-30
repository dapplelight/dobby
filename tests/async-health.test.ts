// Non-blocking shell, listener lanes, PR sweep pacing, graph.db/kv pruning, pipeline health checks, log stamps, schema guards. Offline.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import Database from "better-sqlite3"

const dir = mkdtempSync(`${tmpdir()}/foreman-async-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/secrets.env`

const { runAsync, shAsync, stampLogs, timeoutMs, TIMEOUTS, addTicket, setTicket } = await import("../src/lib.ts")
const { open, addColumn, STATUSES, graphSaver, pruneCheckpoints, pruneKv, dailyPrune, logRun, logCheck } = await import("../src/db.ts")
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const waitDead = async (pid: number) => { for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20)); return !alive(pid) }

test("runAsync: argument arrays, stdout on success, stdout+stderr+why on failure, keep, all", async () => {
  assert.deepEqual(await runAsync("node", ["-e", "process.stdout.write('hi'); process.stderr.write('warn')"]), { ok: true, out: "hi" })
  const bad = await runAsync("node", ["-e", "process.stdout.write('a'); process.stderr.write('b'); process.exit(3)"])
  assert.deepEqual(bad, { ok: false, out: "ab" })
  assert.equal((await runAsync("node", ["-e", "process.stdout.write('x'.repeat(100))"], { keep: 10 })).out, "x".repeat(10))
  assert.deepEqual(await shAsync("echo out; echo err >&2", dir), { ok: true, out: "out\nerr\n" }) // like sh(): both streams
  const missing = await runAsync("no-such-binary-foreman", [])
  assert.equal(missing.ok, false)
  assert.match(missing.out, /ENOENT/)
  assert.equal((await runAsync("node", ["-e", "process.stdout.write(process.cwd())"], { cwd: dir })).out.endsWith(dir.split("/").pop()!), true)
})

test("runAsync: a timeout or abort SIGKILLs the whole process group; leftovers die when the command exits", async () => {
  const pidFile = `${dir}/grandchild.pid`
  const t0 = Date.now()
  const r = await runAsync("zsh", ["-c", `sleep 30 & echo $! > ${pidFile}; wait`], { timeoutMs: 300 })
  assert.equal(r.ok, false)
  assert.equal(r.timedOut, true)
  assert.match(r.out, /timed out after 0 s: stopped/)
  assert.ok(Date.now() - t0 < 5000)
  assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8"))), "the background sleep in the group is gone too")
  const ac = new AbortController()
  const p = runAsync("sleep", ["30"], { signal: ac.signal })
  setTimeout(() => ac.abort(), 50)
  assert.deepEqual(await p, { ok: false, out: "\n(aborted: stopped)" })
  // a server left running in the background (vite preview on 4173) dies with the command that started it
  const ok = await runAsync("zsh", ["-c", `sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}; echo started`])
  assert.deepEqual(ok, { ok: true, out: "started\n" })
  assert.ok(await waitDead(Number(readFileSync(pidFile, "utf8"))))
})

test("runAsync does not block the event loop (the tick heartbeat and Discord timers keep running)", async () => {
  let beats = 0
  const iv = setInterval(() => beats++, 10)
  await runAsync("sleep", ["0.3"])
  clearInterval(iv)
  assert.ok(beats >= 10, `heartbeat fired ${beats} times`)
})

test("timeouts: defaults 2 min git, 30 min install/verify/deploy; env overrides; junk falls back", () => {
  assert.deepEqual(TIMEOUTS, { git: 120_000, push: 1_800_000, install: 1_800_000, verify: 1_800_000, deploy: 1_800_000, do: 1_200_000, do_long: 10_800_000, scan: 5_400_000 })
  assert.equal(timeoutMs("git", {}), 120_000)
  assert.equal(timeoutMs("deploy", { DOBBY_TIMEOUT_DEPLOY_MS: "5000" }), 5000)
  assert.equal(timeoutMs("verify", { DOBBY_TIMEOUT_VERIFY_MS: "soon" }), 1_800_000)
})

test("waitChecks with an async sleep lets other work run while checks are pending", async () => {
  const { waitChecks } = await import("../src/merge.ts")
  let n = 0, beats = 0
  const iv = setInterval(() => beats++, 5)
  const r = await waitChecks(async () => ({ ok: true, out: JSON.stringify([{ name: "t", bucket: n++ < 2 ? "pending" : "pass" }]) }), "r/r", 1, () => new Promise((res) => setTimeout(res, 30)))
  clearInterval(iv)
  assert.deepEqual(r, { ok: true, out: "required checks passed (1)" })
  assert.ok(beats >= 5)
})

test("stamp: local time with the zone offset, not UTC", async () => {
  const { logStamp: stamp } = await import("../src/config.ts")
  const t = Date.parse("2026-10-27T15:34:07Z")
  const s = stamp(t)
  assert.match(s, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d$/)
  assert.equal(Date.parse(s.replace(" ", "T").replace(/ ([+-]\d\d:\d\d)$/, "$1")), t) // same instant, written in the configured zone
})

test("stampLogs: every line of every console.log/error gets the time", () => {
  const lines: string[] = []
  const c = { log: (s: string) => lines.push(s), error: (s: string) => lines.push(`E ${s}`) } as unknown as Console
  stampLogs(c, () => "2026-10-20T10:00:00.000Z")
  c.log("one\ntwo", 3)
  c.error("bad")
  assert.deepEqual(lines, ["2026-10-20T10:00:00.000Z one\n2026-10-20T10:00:00.000Z two 3", "E 2026-10-20T10:00:00.000Z bad"])
})

test("listener lanes: same ticket/PR/thread waits its turn, other lanes run at once, errors never stop a lane, serial switch", async () => {
  const { laneOf, lanes } = await import("../src/discord.ts")
  const b = (data: string) => ({ kind: "button" as const, data, id: "", token: "", content: "", app: "" })
  assert.equal(laneOf(b("approve 12")), laneOf(b("queue 12")))
  assert.notEqual(laneOf(b("approve 12")), laneOf(b("approve 13")))
  assert.equal(laneOf(b("reviewfix ownerdev/tally 7")), "button:ownerdev/tally#7")
  assert.notEqual(laneOf(b("reviewfix ownerdev/tally 7")), laneOf(b("reviewaccept ownerdev/tally 8")))
  assert.equal(laneOf(b("deploynow tally migrate abc1234")), "button:tally")
  assert.equal(laneOf({ kind: "ask", text: "hi" }), "ask")
  assert.equal(laneOf({ kind: "brain", thread: "9", text: "x" }), "brain:9")
  assert.equal(laneOf(b("approve 12"), { DOBBY_LISTEN_SERIAL: "1" }), laneOf({ kind: "ask", text: "x" }, { DOBBY_LISTEN_SERIAL: "1" }))

  const logs: string[] = [], order: string[] = []
  const run = lanes((m) => logs.push(m))
  const slow = (tag: string, ms: number) => async () => { order.push(`${tag}+`); await new Promise((r) => setTimeout(r, ms)); order.push(`${tag}-`) }
  const a1 = run("a", slow("a1", 60)), a2 = run("a", slow("a2", 1)), bb = run("b", slow("b", 1))
  const boom = run("c", async () => { throw new Error("boom") }), c2 = run("c", slow("c2", 1))
  await Promise.all([a1, a2, bb, boom, c2])
  assert.ok(order.indexOf("b-") < order.indexOf("a1-"), "b did not wait for a's slow merge")
  assert.ok(order.indexOf("a1-") < order.indexOf("a2+"), "a2 waited for a1")
  assert.ok(order.includes("c2-"))
  assert.deepEqual(logs, ["discord: boom"])
})

test("closeFinishedPrs: least recently checked first, each at most every 10 min, capped per run", async () => {
  const { closeFinishedPrs } = await import("../src/graphs/program.ts")
  const db = open(":memory:")
  const ids = Array.from({ length: 8 }, (_, i) => { const { id } = addTicket(db, { project: "tally", title: `t${i}` }); setTicket(db, id, { status: "fixing", note: `https://github.com/a/tally/pull/${100 + i}` }); return id })
  const asked: string[] = []
  const gh = async (_c: string, args: string[]) => (asked.push(args[2]), { ok: true, out: args[2].endsWith("/107") ? "MERGED" : "OPEN" })
  const T = Date.parse("2026-10-20T10:00:00Z")
  assert.deepEqual(await closeFinishedPrs(db, "tally", gh, T, 3), [])
  assert.deepEqual(asked.map((u) => u.split("/").pop()), ["100", "101", "102"])
  asked.length = 0
  // a minute later: the ones never checked go first, the three just checked wait their 10 minutes
  assert.deepEqual(await closeFinishedPrs(db, "tally", gh, T + 60_000, 10), [`#${ids[7]} shipped (PR merged)`])
  assert.deepEqual(asked.map((u) => u.split("/").pop()), ["103", "104", "105", "106", "107"])
  asked.length = 0
  assert.deepEqual(await closeFinishedPrs(db, "tally", gh, T + 2 * 60_000, 10), [])
  assert.equal(asked.length, 0) // everything was checked in the last 10 minutes: no gh call at all
  await closeFinishedPrs(db, "tally", gh, T + 11 * 60_000, 2)
  assert.deepEqual(asked.map((u) => u.split("/").pop()), ["100", "101"]) // oldest check first
})

test("graph.db: one saver per process; prune keeps the last checkpoint of tickets ended over 7 days ago", async () => {
  const path = `${dir}/graph-test.db`
  assert.equal(graphSaver(path), graphSaver(path))
  assert.equal(graphSaver(path).db.pragma("journal_mode", { simple: true }), "wal")
  const db = open(":memory:")
  const T = Date.parse("2026-10-20T10:00:00Z")
  const old = addTicket(db, { project: "p", title: "old" }).id, fresh = addTicket(db, { project: "p", title: "fresh" }).id, live = addTicket(db, { project: "p", title: "live" }).id
  db.prepare("UPDATE tickets SET status='shipped', updated_at=? WHERE id=?").run(new Date(T - 8 * 86_400_000).toISOString(), old)
  db.prepare("UPDATE tickets SET status='failed', updated_at=? WHERE id=?").run(new Date(T - 86_400_000).toISOString(), fresh)
  db.prepare("UPDATE tickets SET status='running', updated_at=? WHERE id=?").run(new Date(T - 30 * 86_400_000).toISOString(), live)
  const g = new Database(":memory:")
  assert.equal(pruneCheckpoints(db, g, T), 0) // no tables yet: nothing to do
  g.exec("CREATE TABLE checkpoints (thread_id TEXT, checkpoint_ns TEXT DEFAULT '', checkpoint_id TEXT, parent_checkpoint_id TEXT, type TEXT, checkpoint BLOB, metadata BLOB); CREATE TABLE writes (thread_id TEXT, checkpoint_ns TEXT DEFAULT '', checkpoint_id TEXT, task_id TEXT, idx INTEGER, channel TEXT, type TEXT, value BLOB)")
  for (const id of [old, fresh, live]) for (const c of ["c1", "c2", "c3"]) {
    g.prepare("INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id) VALUES (?, '', ?)").run(`ticket-${id}`, c)
    g.prepare("INSERT INTO writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel) VALUES (?, '', ?, 't', 0, 'x')").run(`ticket-${id}`, c)
  }
  assert.equal(pruneCheckpoints(db, g, T), 4) // 2 checkpoints + 2 writes of the old ticket
  const left = (id: number) => (g.prepare("SELECT checkpoint_id FROM checkpoints WHERE thread_id=? ORDER BY checkpoint_id").all(`ticket-${id}`) as { checkpoint_id: string }[]).map((r) => r.checkpoint_id)
  assert.deepEqual([left(old), left(fresh), left(live)], [["c3"], ["c1", "c2", "c3"], ["c1", "c2", "c3"]])
  assert.deepEqual(g.prepare("SELECT checkpoint_id FROM writes WHERE thread_id=?").all(`ticket-${old}`), [{ checkpoint_id: "c3" }])
})

test("kv/checks prune: dated keys and ended tickets' board/thread keys over 30 days; channels and live tickets stay; once a day", () => {
  const db = open(":memory:")
  const T = Date.parse("2026-10-20T10:00:00Z")
  const shipped = addTicket(db, { project: "p", title: "a" }).id, failed = addTicket(db, { project: "p", title: "b" }).id
  db.prepare("UPDATE tickets SET status='shipped', updated_at='2026-08-01T00:00:00Z' WHERE id=?").run(shipped)
  db.prepare("UPDATE tickets SET status='failed', updated_at='2026-08-01T00:00:00Z' WHERE id=?").run(failed)
  const set = (k: string) => db.prepare("INSERT OR REPLACE INTO kv VALUES (?, '1')").run(k)
  const gone = ["lead:tally:2026-09-01", "digest:2026-09-01", `budget:paused:${Math.round((T - 40 * 86_400_000) / 600_000)}`, "brief:sent:2026-09-01", "health:told:disk:2026-09-01", `gh:issue:${shipped}`, `discord:thread:${shipped}`, `discord:status:${shipped}`, `prcheck:${shipped}`]
  const kept = ["lead:tally:2026-10-19", "digest:2026-10-01", `budget:paused:${Math.round(T / 600_000)}`, "discord:owner", "discord:ch:needs-you", "gh:board:tally", `gh:issue:${failed}`, `discord:thread:${failed}`, "lock"]
  for (const k of [...gone, ...kept]) set(k)
  logCheck(db, "disk", true, "", "2026-09-01T00:00:00Z"); logCheck(db, "disk", true, "", "2026-10-19T00:00:00Z")
  assert.equal(pruneKv(db, T), gone.length + 1)
  const keys = (db.prepare("SELECT k FROM kv ORDER BY k").all() as { k: string }[]).map((r) => r.k)
  assert.deepEqual(keys, [...kept].sort())
  assert.equal((db.prepare("SELECT COUNT(*) n FROM checks").get() as { n: number }).n, 1)
  assert.match(dailyPrune(db, T, `${dir}/no-graph.db`)!, /^pruned: \d+ rows, 0 worktrees, 0 branches, 0 logs/)
  assert.equal(dailyPrune(db, T + 3600_000, `${dir}/no-graph.db`), null) // once a day
})

test("schema: only 'duplicate column' is ignored; every status in src is in STATUSES", () => {
  const db = open(":memory:")
  addColumn(db, "ALTER TABLE tickets ADD COLUMN onto TEXT") // already there: fine
  assert.throws(() => addColumn(db, "ALTER TABLE no_such_table ADD COLUMN x TEXT"), /no such table/)
  const src = `${new URL("../src", import.meta.url).pathname}`
  const files = [...readdirSync(src).map((f) => `${src}/${f}`), ...readdirSync(`${src}/graphs`).map((f) => `${src}/graphs/${f}`)].filter((f) => f.endsWith(".ts"))
  const used = new Set<string>()
  for (const f of files) {
    const text = readFileSync(f, "utf8")
    for (const m of text.matchAll(/status\s*!?=\s*'([a-z]+)'/g)) used.add(m[1])
    for (const m of text.matchAll(/status (?:NOT )?IN \(([^)]*)\)/g)) for (const q of m[1].matchAll(/'([a-z]+)'/g)) used.add(q[1])
    for (const m of text.matchAll(/setTicket\([^\n]*?status: "([a-z]+)"/g)) used.add(m[1])
  }
  assert.ok(used.has("fixing") && used.has("split"))
  for (const s of used) if (!["open", "done", "active", "dropped", "new", "proposed", "approved", "rejected", "brainstorm"].includes(s)) assert.ok((STATUSES as readonly string[]).includes(s), `ticket status "${s}" is missing from STATUSES`)
})

test("pipeline health: each check, one #needs-you line per problem per day, Health line on the board and in the snapshot", async () => {
  const { pipelineChecks, pipelineWatch } = await import("../src/health.ts")
  const { statusText, healthLine } = await import("../src/view.ts")
  const { snapshot } = await import("../src/dashboard.ts")
  const db = open(":memory:")
  const T = Date.parse("2026-10-20T10:00:00Z"), iso = (msAgo: number) => new Date(T - msAgo).toISOString(), H = 3600_000
  const home = mkdtempSync(`${tmpdir()}/foreman-health-`)
  mkdirSync(`${home}/logs`)
  for (const f of ["tick.log", "telegram.log"]) { writeFileSync(`${home}/logs/${f}`, "x"); utimesSync(`${home}/logs/${f}`, new Date(T - 60_000), new Date(T - 60_000)) }
  const env = { now: T, dir: home, freeGb: () => 100, claudeFound: () => true, projects: {} }
  const byName = (o = env) => Object.fromEntries(pipelineChecks(db, o).map((h) => [h.check, h]))
  assert.deepEqual(Object.values(byName()).filter((h) => !h.ok), []) // a quiet, healthy pipeline
  assert.equal(healthLine(db), "") // nothing stored yet: no board line

  const t1 = addTicket(db, { project: "tally", title: "Fix the footer" }).id, t2 = addTicket(db, { project: "tally", title: "Budget screen" }).id
  db.prepare("UPDATE tickets SET status='fixing', updated_at=? WHERE id=?").run(iso(25 * H), t1)
  db.prepare("UPDATE tickets SET status='running', updated_at=? WHERE id=?").run(iso(3 * H), t2)
  logRun(db, { project: "tally", kind: "build", ticket: t2, ok: true }, iso(45 * 60_000))
  for (let i = 0; i < 6; i++) logRun(db, { project: "tally", kind: "build", ok: i < 2 }, iso(3 * H))
  db.prepare("INSERT OR REPLACE INTO kv VALUES ('tick:last', ?)").run(String(T - 40 * 60_000))
  writeFileSync(`${home}/dobby.db`, Buffer.alloc(10)) // small
  let h = byName({ ...env, freeGb: () => 9 })
  assert.match(h.fixing.text, /1 ticket\(s\) waiting on a review fix for over 24 hours: Fix the footer/)
  assert.match(h.running.text, /building for over 2 hours with no agent run in the last 30 minutes: Budget screen/)
  assert.match(h.builds.text, /^4 of 7 builds failed in the last 6 hours$/)
  assert.match(h["tick log"].text, /the tick has not run for 40 minutes/)
  assert.equal(h["listener log"].ok, true)
  assert.match(h.disk.text, /only 9\.0 GB free/)
  assert.equal(h["dobby.db"].ok, true)
  // a run in the last 30 minutes means it is working, not hung; under 6 builds is too few to judge
  logRun(db, { project: "tally", kind: "check", ticket: t2, ok: true }, iso(5 * 60_000))
  assert.equal(byName().running.ok, true)

  // idle: ready work, no agent run for over 2 hours, nothing paused
  const db2 = open(":memory:")
  addTicket(db2, { project: "tally", title: "x" })
  logRun(db2, { project: "tally", kind: "build", ok: true }, iso(3 * H))
  const idle = () => Object.fromEntries(pipelineChecks(db2, env).map((x) => [x.check, x])).idle
  assert.match(idle().text, /1 ticket\(s\) ready but no agent has run for 3 hours/)
  db2.prepare("INSERT INTO kv VALUES ('pause', ?)").run(JSON.stringify({ kinds: { builders: { at: T - H, by: "the owner" } } }))
  assert.equal(idle().ok, true) // paused on purpose is not a problem

  // claude: signed out since the last good run, for over 30 minutes; missing binary for over 30 minutes
  logRun(db2, { project: "tally", kind: "build", ok: false, reason: "OAuth session expired" }, iso(45 * 60_000))
  assert.match(Object.fromEntries(pipelineChecks(db2, env).map((x) => [x.check, x])).claude.text, /signed out for 45 minutes/)
  const db3 = open(":memory:")
  pipelineChecks(db3, { ...env, now: T - 40 * 60_000, claudeFound: () => false })
  assert.match(Object.fromEntries(pipelineChecks(db3, { ...env, claudeFound: () => false }).map((x) => [x.check, x])).claude.text, /claude command has been missing for 40 minutes/)
  assert.equal(Object.fromEntries(pipelineChecks(db3, env).map((x) => [x.check, x])).claude.ok, true) // found again: cleared

  // big database files
  writeFileSync(`${home}/graph.db`, ""); writeFileSync(`${home}/graph.db-wal`, Buffer.alloc(501 * 1048576))
  assert.match(byName()["graph.db"].text, /graph\.db is 501 MB/)

  // the watch: stored for the board, each problem once a day
  const sent: string[] = []
  const w = await pipelineWatch(db, async (t) => sent.push(t), { ...env, freeGb: () => 9 })
  assert.ok(sent.length >= 4 && sent.every((t) => t.startsWith("🩺 Dobby pipeline: ")))
  assert.deepEqual(w.sent.sort(), w.checks.filter((x) => !x.ok).map((x) => x.check).sort())
  await pipelineWatch(db, async (t) => sent.push(t), { ...env, now: T + 60_000, freeGb: () => 9 })
  assert.equal(sent.length, w.sent.length) // same day: no repeats
  await pipelineWatch(db, async (t) => sent.push(t), { ...env, now: T + 24 * H, freeGb: () => 9 })
  assert.ok(sent.length > w.sent.length) // next day: told again
  assert.match(statusText(db, T), /\n🩺 Health: .*review fix/)
  assert.ok(snapshot(db, T).health.some((x: { check: string; ok: boolean }) => x.check === "disk" && !x.ok))
  rmSync(`${home}/graph.db-wal`)
  const ok = open(":memory:")
  await pipelineWatch(ok, async () => {}, env)
  assert.equal(healthLine(ok), `🩺 Health: all ${pipelineChecks(ok, env).length} checks ok`)
})

test("pipeline health: a ticket that has not moved for 24 hours, reviews skipped for 2 hours, builders held by the cap for 3 hours", async () => {
  const { pipelineChecks, pipelineWatch } = await import("../src/health.ts")
  const db = open(":memory:")
  const T = Date.parse("2026-10-20T10:00:00Z"), H = 3600_000
  const env = { now: T, dir: mkdtempSync(`${tmpdir()}/foreman-health3-`), freeGb: () => 100, claudeFound: () => true, projects: {}, persist: false }
  const bad = () => pipelineChecks(db, env).filter((h) => !h.ok && ["stuck", "reviews", "cap"].includes(h.check)).map((h) => h.check)
  const t = addTicket(db, { project: "tally", title: "Waiting card" }).id
  db.prepare("UPDATE tickets SET status='approval', updated_at=? WHERE id=?").run(new Date(T - 23 * H).toISOString(), t)
  db.prepare("INSERT INTO kv VALUES ('review:skipped-since', ?), ('cap:blocked-since', ?)").run(String(T - H), String(T - 2 * H))
  assert.deepEqual(bad(), []) // under each limit
  db.prepare("UPDATE tickets SET updated_at=? WHERE id=?").run(new Date(T - 25 * H).toISOString(), t)
  db.prepare("UPDATE kv SET v=? WHERE k='review:skipped-since'").run(String(T - 3 * H))
  db.prepare("UPDATE kv SET v=? WHERE k='cap:blocked-since'").run(String(T - 4 * H))
  assert.deepEqual(bad(), ["stuck", "reviews", "cap"])
  // one card per condition per day
  const sent: string[] = []
  await pipelineWatch(db, async (x) => void sent.push(x), env)
  await pipelineWatch(db, async (x) => void sent.push(x), env)
  assert.equal(sent.filter((s) => /not moved for over 24 hours|skipped for 3 hours|budget cap for 4 hours/.test(s)).length, 3)
})

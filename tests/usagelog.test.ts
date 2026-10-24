import assert from "node:assert/strict"
import { test } from "node:test"
import { open } from "../src/db.ts"
import { ensure, logReading } from "../src/usage.ts"

test("usage log: a reading stores 5h/weekly % and $ per model and token kind since the last one; a gap is not lost", () => {
  const db = open(":memory:")
  ensure(db)
  const ins = db.prepare("INSERT INTO usage_calls VALUES (?,?,'s','automated','p',?,?,?,?,?,?,0,0,0)")
  const get = (sql: string) => ({ ...(db.prepare(sql).get() as object) })
  logReading(db, { five: 10, week: 20 }, 1_000) // first reading: baseline only
  assert.equal((db.prepare("SELECT COUNT(*) n FROM usage_log").get() as { n: number }).n, 0)

  ins.run("a", 1_500, "claude-opus-5-5", 1_000_000, 0, 0, 1_000_000, 1_000_000) // $4 fresh in, $0.2 cache read, $20 out
  logReading(db, { five: 11, week: 20 }, 601_000)
  const rows = db.prepare("SELECT kind, tokens, usd FROM usage_log WHERE at=601000 AND model='claude-opus-5-5' ORDER BY kind").all() as { kind: string; tokens: number; usd: number }[]
  assert.deepEqual(rows.map((r) => [r.kind, r.tokens, +r.usd.toFixed(2)]), [["input", 1_000_000, 4], ["output", 1_000_000, 20], ["read", 1_000_000, 0.2]])
  assert.deepEqual(get("SELECT since, five, week FROM usage_readings WHERE at=601000"), { since: 1_000, five: 11, week: 20 })

  // gap: listener down for hours and limits unreadable; the next reading still carries every call since, once
  ins.run("b", 5_000_000, "claude-opus-5-5", 1_000_000, 0, 0, 0, 0)
  logReading(db, null, 9_000_000)
  logReading(db, { five: 3, week: 21 }, 9_600_000)
  assert.deepEqual(get("SELECT since, five FROM usage_readings WHERE at=9000000"), { since: 601_000, five: null })
  assert.equal((db.prepare("SELECT SUM(usd) s FROM usage_log WHERE at=9000000").get() as { s: number }).s, 4)
  assert.equal((db.prepare("SELECT COUNT(*) n FROM usage_log WHERE at=9600000").get() as { n: number }).n, 0)
})

test("usage steps: each +1 stores $ and tokens since that window's previous change (the other window's ticks don't cut it); rollovers and baselines are skipped; report shows it", async () => {
  const { poll, report } = await import("../src/usage.ts")
  const db = open(":memory:")
  ensure(db)
  const now = Date.now()
  const lim = (at: number, five: number, week: number, fiveReset = 1, weekReset = 9) => () => ({ at, five, week, fiveReset, weekReset })
  const call = (id: string, at: number, tokens: number, usd: number) => db.prepare("INSERT INTO usage_calls VALUES (?,?,'s','automated','p','claude-opus-5-5',?,0,0,0,0,0,0,?)").run(id, at, tokens, usd)
  poll(db, lim(now - 9000, 10, 5))
  poll(db, lim(now - 8000, 11, 5)) // 5-hour changes, but its previous change is the baseline tick: no known start, no step
  call("a", now - 7500, 1_000_000, 4)
  poll(db, lim(now - 7000, 12, 5)) // 5-hour step 1: $4, 1M (since -8000)
  poll(db, lim(now - 7000, 12, 5)) // unchanged: no tick, no step
  call("b", now - 6500, 500_000, 2)
  poll(db, lim(now - 6000, 12, 6)) // weekly changes; its previous change is the baseline tick: no step
  call("c", now - 5500, 1_000_000, 6)
  poll(db, lim(now - 5000, 13, 6)) // 5-hour step 2: b + c = $8, 1.5M (since -7000)
  call("d", now - 4500, 500_000, 3)
  poll(db, lim(now - 4000, 13, 7)) // weekly step: c + d = $9, 1.5M since its change at -6000, even though a 5-hour tick fell at -5000
  poll(db, lim(now - 3000, 1, 7, 2)) // 5-hour rollover (new reset, value dropped): no step
  const rows = db.prepare("SELECT win, pct, usd, tokens, usd_per_pct FROM usage_steps ORDER BY at").all() as Record<string, any>[]
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { win: "five", pct: 1, usd: 4, tokens: 1_000_000, usd_per_pct: 4 },
    { win: "five", pct: 1, usd: 8, tokens: 1_500_000, usd_per_pct: 8 },
    { win: "week", pct: 1, usd: 9, tokens: 1_500_000, usd_per_pct: 9 },
  ])
  assert.match(report(db, 7), /Measured per \+1% \(stored at each step\): 5-hour \$8\.00 · 1\.5M tokens \(2 steps\) · week \$9\.00 · 1\.5M tokens \(1 steps\)/)
})

test("session fixes: an owner session editing a file on a dobby/<id> branch logs one touch per session and ticket; Dobby's own runs, other branches and reads do not", async () => {
  const { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { ingest } = await import("../src/usage.ts")
  const root = mkdtempSync(`${tmpdir()}/foreman-sessions-`)
  mkdirSync(`${root}/proj`)
  const line = (o: { branch: string; entrypoint?: string; tool?: string; session?: string; ts?: string }) => JSON.stringify({
    type: "assistant", entrypoint: o.entrypoint ?? "cli", sessionId: o.session ?? "s1", gitBranch: o.branch, timestamp: o.ts ?? "2026-10-21T10:00:00Z",
    message: { id: Math.random().toString(), model: "claude-opus-5-5", usage: { input_tokens: 1 }, content: [{ type: "tool_use", name: o.tool ?? "Edit", input: {} }] },
  }) + "\n"
  const file = `${root}/proj/a.jsonl`
  writeFileSync(file, line({ branch: "foreman/344" }) + line({ branch: "foreman/344" }) + line({ branch: "foreman/345", session: "s2" }) + line({ branch: "main" }) +
    line({ branch: "foreman/346", entrypoint: "sdk-cli" }) + line({ branch: "foreman/347", tool: "Read" }))
  const db = open(":memory:")
  ingest(db, root)
  const rows = () => db.prepare("SELECT ticket, kind, tag, note FROM touches ORDER BY ticket").all().map((r: any) => ({ ...r }))
  assert.deepEqual(rows(), [
    { ticket: 344, kind: "session", tag: "broke", note: "session s1" },
    { ticket: 345, kind: "session", tag: "broke", note: "session s2" },
  ])
  appendFileSync(file, line({ branch: "foreman/344" }) + line({ branch: "foreman/344", session: "s3", })) // same session again: nothing; a new session: one more
  ingest(db, root)
  assert.equal(rows().length, 3)
})

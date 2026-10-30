// Scheduler: a live builder's ticket is not reset, Scout runs once a night in IST, paused: true in dobby.md stops builds. Offline.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-sched-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/keys`
process.env.DOBBY_PROJECTS = `${dir}/projects`
mkdirSync(`${dir}/projects`)
const proj = (n: string, extra = "") => writeFileSync(`${dir}/projects/${n}.md`, `---\nrepo: ~/projects/${n}\npriority: 5\n${extra}---\n## Goal\nx\n`)
proj("alpha", "paused: true\n"); proj("beta")
const { open } = await import("../src/db.ts")
const { nextTicket, resetOrphans, setBuildClaim, clearBuildClaim } = await import("../src/lib.ts")
const { scoutDue } = await import("../src/scout.ts")

const add = (db: any, project: string, status = "ready") => Number(db.prepare("INSERT INTO tickets (project,title,status,created_at,updated_at) VALUES (?,?,?,datetime('now'),datetime('now'))").run(project, "Add a thing", status).lastInsertRowid)
const status = (db: any, id: number) => (db.prepare("SELECT status FROM tickets WHERE id=?").get(id) as { status: string }).status

test("orphan reset: a live claim stays running; a dead pid or no claim goes back to ready", () => {
  const db = open(":memory:")
  const live = add(db, "beta", "running"), dead = add(db, "beta", "running"), none = add(db, "beta", "running")
  setBuildClaim(db, live) // this process
  const child = spawnSync(process.execPath, ["-e", "0"])
  db.prepare("INSERT INTO kv VALUES (?, ?)").run(`build:${dead}`, `${child.pid}:${Date.now()}`)
  assert.deepEqual(resetOrphans(db).map((t) => t.id).sort(), [dead, none].sort())
  assert.deepEqual([status(db, live), status(db, dead), status(db, none)], ["running", "ready", "ready"])
  clearBuildClaim(db, live)
  assert.equal(resetOrphans(db).length, 1) // claim cleared (build ended): now an orphan
})

test("scout: once a night in IST (23:30 runs, 05:45 next morning is the same night, 23:30 next day is a new one)", () => {
  const db = open(":memory:")
  const n1 = Date.parse("2026-10-24T23:30:00+05:30"), m1 = Date.parse("2026-10-25T05:45:00+05:30"), n2 = Date.parse("2026-10-25T23:30:00+05:30")
  assert.equal(scoutDue(db, undefined, n1), true)
  db.prepare("INSERT INTO kv VALUES ('scout:last', ?)").run("2026-10-24") // what scout() stores at n1: zonedDay(n1 - 6h)
  assert.equal(scoutDue(db, undefined, m1), false) // the UTC date flips at 05:30 IST: the old bug ran Scout again here
  assert.equal(scoutDue(db, undefined, n2), true)
})

test("nextTicket skips a project with paused: true in dobby.md and takes the next project's", () => {
  const db = open(":memory:")
  const a = add(db, "alpha"), b = add(db, "beta")
  assert.ok(a < b)
  assert.equal(nextTicket(db)?.id, b)
})

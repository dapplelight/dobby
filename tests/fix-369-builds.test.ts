// Issue #369, builds and queue: pause all, cancel note, verify output order, auto-commit staging. Offline: temp HOME and data dir.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-369-`)
process.env.HOME = dir // pauseAct looks for the real launch agent under HOME: it must not find one
process.env.DOBBY_DIR = `${dir}/data`
process.env.DOBBY_SECRETS = `${dir}/s.txt`
process.env.JEV_API_KEY = ""
mkdirSync(`${dir}/data`, { recursive: true })
const { open } = await import("../src/db.ts")
const { addTicket, getTicket, setTicket, shAsync } = await import("../src/lib.ts")
const { pauseAct } = await import("../src/actions.ts")
const { parsePause } = await import("../src/pause.ts")
const { stageWork } = await import("../src/graphs/ticket.ts")
const db = open()
const kv = (k: string) => db.prepare("INSERT OR REPLACE INTO kv VALUES (?, '1')").run(k)

test("pause all: running tickets read ready with a paused note and no claim; resume leaves them queued", async () => {
  const { id } = addTicket(db, { project: "tally", title: "Build it" })
  setTicket(db, id, { status: "running" })
  kv(`build:${id}`)
  assert.match(await pauseAct(db, parsePause("pause all") as never), /Paused everything/)
  const t = getTicket(db, id)!
  assert.equal(t.status, "ready")
  assert.match(t.note ?? "", /paused by you/)
  assert.equal(db.prepare("SELECT 1 FROM kv WHERE k=?").get(`build:${id}`), undefined)
  assert.match(await pauseAct(db, parsePause("resume all") as never), /Resumed/)
  assert.equal(getTicket(db, id)!.status, "ready") // the queue takes it again; the graph resumes from its checkpoint
})

test("a cancelled build winding down cannot overwrite 'cancelled by the owner' with its own failure note", () => {
  const { id } = addTicket(db, { project: "tally", title: "Cancelled" })
  setTicket(db, id, { status: "declined", note: "cancelled by the owner" })
  kv(`cancel:${id}`); kv(`build:${id}`)
  setTicket(db, id, { status: "ready", note: "Claude did not start: spawn claude ENOENT" })
  setTicket(db, id, { note: "crashed: spawn claude ENOENT" })
  const t = getTicket(db, id)!
  assert.equal(t.status, "declined")
  assert.equal(t.note, "cancelled by the owner")
})

test("verify output keeps arrival order: the failing check's stderr is not buried under a later check's stdout", async () => {
  const r = await shAsync("echo FAILING-CHECK >&2; sleep 0.3; echo later-passing-output; exit 1", dir, 4000)
  assert.equal(r.ok, false)
  assert.match(r.out.trim().split("\n")[0], /FAILING-CHECK/)
  assert.match(r.out, /later-passing-output/)
})

const git = (cwd: string, ...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" })
const repo = () => {
  const r = mkdtempSync(`${dir}/repo-`)
  git(r, "init", "-q", "-b", "main"); writeFileSync(`${r}/a.txt`, "a"); writeFileSync(`${r}/package.json`, "{}"); writeFileSync(`${r}/.gitignore`, "ignored.txt\n")
  git(r, "add", "."); git(r, "commit", "-qm", "base"); git(r, "update-ref", "refs/remotes/origin/main", "HEAD")
  return r
}
const staged = (r: string) => git(r, "diff", "--cached", "--name-only").stdout.split("\n").filter(Boolean).sort()

test("auto-commit staging leaves untracked lockfiles, build output and ignored files alone", async () => {
  const r = repo()
  writeFileSync(`${r}/a.txt`, "changed"); writeFileSync(`${r}/new.ts`, "x"); writeFileSync(`${r}/package-lock.json`, "{}"); writeFileSync(`${r}/ignored.txt`, "i")
  mkdirSync(`${r}/dist`); writeFileSync(`${r}/dist/x.js`, "x")
  await stageWork(r, "main")
  assert.deepEqual(staged(r), ["a.txt", "new.ts"])
})

test("a lockfile goes in when the ticket changed package.json", async () => {
  const r = repo()
  writeFileSync(`${r}/package.json`, `{"dependencies":{"x":"1"}}`); writeFileSync(`${r}/package-lock.json`, "{}")
  await stageWork(r, "main")
  assert.deepEqual(staged(r), ["package-lock.json", "package.json"])
})

test("an API-key pause ping offers no plan-window buttons", async () => {
  const { keepGoingCaps } = await import("../src/lib.ts")
  assert.deepEqual(keepGoingCaps(50, true), [])
  assert.deepEqual(keepGoingCaps(75, false), [80, 90, 100])
})

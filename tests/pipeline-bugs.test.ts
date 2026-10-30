// Ticket pipeline bugs (issue #336): stale branch, crash resume, verify excuse, cancel, fetch routing, reused pid, repo-less PR lookup. Offline.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-pipeline-`)
process.env.DOBBY_DIR = `${dir}/data`
process.env.DOBBY_SECRETS = `${dir}/s.txt`
process.env.DOBBY_PROJECTS = `${dir}/projects`
process.env.DOBBY_BUILDER_SANDBOX = "off"
process.env.JEV_API_KEY = ""
mkdirSync(`${dir}/projects`, { recursive: true })
writeFileSync(process.env.DOBBY_SECRETS, "")
writeFileSync(`${dir}/claude`, `#!/bin/sh\ncat > /dev/null\nsleep 1\necho '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s1","num_turns":1,"total_cost_usd":0}'\n`)
chmodSync(`${dir}/claude`, 0o755)
process.env.PATH = `${dir}:${process.env.PATH}`
const { run } = await import("../src/graphs/review.ts")
const { open, DATA } = await import("../src/db.ts")
const { claude, claimAlive, ticketScope, resetOrphans, addTicket, setTicket } = await import("../src/lib.ts")
const { setupWorktree, resumeInput, otherFailure, reviewPushed, State, NEW_RUN, FRESH_RUN } = await import("../src/graphs/ticket.ts")

const g = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" })

test("a re-queued ticket starts from origin's branch when fix rounds pushed to it; a diverged local branch is left alone", async () => {
  const root = mkdtempSync(`${dir}/wt-`)
  g(root, "init", "-q", "--bare", "-b", "main", "origin.git")
  g(root, "clone", "-q", `${root}/origin.git`, "repo")
  const repo = `${root}/repo`, other = `${root}/other`
  const commit = (cwd: string, f: string) => { writeFileSync(`${cwd}/${f}`, f); g(cwd, "add", "."); g(cwd, "commit", "-qm", f) }
  commit(repo, "a.txt"); g(repo, "push", "-q", "origin", "HEAD:main")
  g(repo, "checkout", "-qb", "dobby/1"); commit(repo, "built.txt"); g(repo, "push", "-qu", "origin", "dobby/1"); g(repo, "checkout", "-q", "main")
  g(root, "clone", "-q", `${root}/origin.git`, "other") // a fix round pushes to origin/dobby/1; the local branch stays behind
  g(other, "checkout", "-q", "dobby/1"); commit(other, "fix-round.txt"); g(other, "push", "-q", "origin", "dobby/1")
  const x = { repo, base: "main", install: "true" }
  assert.equal(await setupWorktree(run, { ...x, wt: `${root}/wt1`, branch: "dobby/1" }), "")
  assert.equal(g(`${root}/wt1`, "rev-parse", "HEAD").stdout, g(other, "rev-parse", "HEAD").stdout)
  // a local branch with commits origin lacks is not rewound
  g(repo, "worktree", "remove", "--force", `${root}/wt1`)
  g(repo, "checkout", "-q", "dobby/1"); commit(repo, "local-only.txt"); g(repo, "checkout", "-q", "main")
  const tip = g(repo, "rev-parse", "dobby/1").stdout
  assert.equal(await setupWorktree(run, { ...x, wt: `${root}/wt2`, branch: "dobby/1" }), "")
  assert.equal(g(`${root}/wt2`, "rev-parse", "HEAD").stdout, tip)
})

test("prepare fetches through the injected net runner (lock + timeout), never the plain one", async () => {
  const root = mkdtempSync(`${dir}/net-`)
  g(root, "init", "-q", "--bare", "-b", "main", "origin.git")
  g(root, "clone", "-q", `${root}/origin.git`, "repo")
  writeFileSync(`${root}/repo/a`, "a"); g(`${root}/repo`, "add", "."); g(`${root}/repo`, "commit", "-qm", "a"); g(`${root}/repo`, "push", "-q", "origin", "HEAD:main")
  const plain: string[][] = [], net: string[][] = []
  const r = (cmd: string, args: string[], cwd?: string) => (plain.push([cmd, ...args]), run(cmd, args, cwd))
  const n = (cmd: string, args: string[], cwd?: string) => (net.push([cmd, ...args]), run(cmd, args, cwd))
  const x = { repo: `${root}/repo`, base: "main", install: "true" }
  assert.equal(await setupWorktree(r, { ...x, wt: `${root}/w1`, branch: "dobby/5", fetchBase: true }, undefined, n), "")
  assert.equal(await setupWorktree(r, { ...x, wt: `${root}/w2`, branch: "dobby/6", onto: "main" }, undefined, n), "")
  assert.ok(net.some((c) => c[1] === "fetch"))
  assert.deepEqual(plain.filter((c) => c[1] === "fetch"), [])
  assert.match(await setupWorktree(r, { ...x, wt: `${root}/w3`, branch: "dobby/7", onto: "gone" }, undefined, n), /^can't check out gone/)
})

test("a crashed ticket resumes only when the worktree its node needs still exists", () => {
  const here = () => true, gone = () => false
  assert.equal(resumeInput({ next: ["build"], values: { wt: "/w" } }, 4, here), null)
  assert.deepEqual(resumeInput({ next: ["build"], values: { wt: "/w" } }, 4, gone), { ticketId: 4 }) // pruned: start fresh
  assert.deepEqual(resumeInput({ next: ["verify"], values: {} }, 4, here), { ticketId: 4 })
  assert.equal(resumeInput({ next: ["ship"], values: { wt: "/w" } }, 4, gone), null) // size removed it on purpose
  assert.deepEqual(resumeInput({ next: ["gate"] }, 4, here), { ticketId: 4 })
  assert.deepEqual(resumeInput({ next: [] }, 4, here), { ticketId: 4 })
})

test("verify excuse: the same base failure reads the same from another worktree; a ticket-only error does not", () => {
  const A = `${DATA}/wt/tally-base-4`, B = `${DATA}/wt/tally-9`
  const bun = (wt: string, header: string) => `${header}\n(fail) foo [0.4ms]\nerror: expect(received).toBe(expected)\n      at <anonymous> (${wt}/src/a.test.ts:12:5)\n      at ${wt}/node_modules/x/y.js:3:1\n 1 fail\nRan 2 tests across 1 files. [12.00ms]`
  const turbo = (hash: string) => `@t/web:test: cache miss, executing ${hash}\n@t/web:test: error: Cannot find module './gone' from '/x/y.ts'`
  const base = bun(A, "src/a.test.ts:") + "\n" + turbo("aaaa1111")
  const mine = bun(B, "src/a.test.ts:\nsrc/new.test.ts:") + "\n" + turbo("bbbb2222")
  const sub = (x: string, y: string) => otherFailure(x).every((l) => otherFailure(y).includes(l))
  assert.ok(otherFailure(base).length > 0)
  assert.ok(sub(mine, base)) // excused
  assert.ok(!sub(mine + `\nsrc/a.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'.`, base)) // a ticket-only type error is not
})

test("a new run starts clean: the log restarts and per-run fields reset", () => {
  const op = (State.spec.log as unknown as { operator: (a: string[], b: string[]) => string[] }).operator
  assert.deepEqual(op(["old"], ["more"]), ["old", "more"])
  assert.deepEqual(op(["old"], [NEW_RUN, "prepare"]), ["prepare"])
  for (const k of ["lastReason", "verdict", "summary", "verifyOk", "scanOk", "baseNote", "big", "review", "plain"]) assert.ok(k in FRESH_RUN, k)
})

test("cancel can stop the builder: claude runs in its own process group recorded under the ticket", async () => {
  const db = open()
  const p = ticketScope.run({ db, id: 77 }, () => claude(db, { project: "tally", kind: "build", ticket: 77, model: "sonnet", prompt: "hi", cwd: dir }))
  await new Promise((res) => setTimeout(res, 400))
  const seen = (db.prepare("SELECT k FROM kv WHERE k LIKE 'pgid:77:%'").all() as { k: string }[]).map((r) => r.k)
  assert.equal(seen.length, 1)
  const pid = Number(seen[0].split(":")[2])
  assert.doesNotThrow(() => process.kill(-pid, 0)) // pid leads its own group: kill(-pgid) reaches it
  assert.equal((await p).ok, true)
  assert.equal((db.prepare("SELECT COUNT(*) n FROM kv WHERE k LIKE 'pgid:77:%'").get() as { n: number }).n, 0)
})

test("a claim whose pid was reused by a newer process is dead", () => {
  const c = spawn("sleep", ["5"], { stdio: "ignore" })
  try {
    assert.equal(claimAlive(`${c.pid}:${Date.now() + 1000}`), true) // claim written after the process started: the holder
    assert.equal(claimAlive(`${c.pid}:${Date.now() - 3_600_000}`), false) // process started long after the claim: a reused pid
    assert.equal(claimAlive(`${process.pid}:${Date.now()}`), true)
    assert.equal(claimAlive(undefined), false)
  } finally { c.kill() }
})

test("reviewPushed looks the PR up in the project's repo", async () => {
  const calls: string[][] = []
  const r = (cmd: string, args: string[]) => (calls.push([cmd, ...args]), cmd === "git" ? { ok: true, out: "abc\n" } : { ok: true, out: JSON.stringify({ number: 7, headRefOid: "abc", url: "https://github.com/o/tally/pull/7" }) })
  await reviewPushed(open(), { run: r, repo: "/r", upstream: "orig/tally", branch: "dobby/9", onto: "dobby/5", ticket: 9, review: async () => ({ state: "success", why: "ok" }), sleep: async () => {} })
  const view = calls.find((c) => c[0] === "gh")!
  assert.ok(view.includes("--repo") && view.includes("orig/tally"), view.join(" "))
})

test("resetOrphans stops the recorded process groups of a dead build before re-queueing", async () => {
  const db = open()
  const { id } = addTicket(db, { project: "tally", title: "orphan" })
  setTicket(db, id, { status: "running" })
  const c = spawn("sleep", ["30"], { stdio: "ignore", detached: true })
  const gone = new Promise((res) => c.on("exit", res))
  db.prepare("INSERT INTO kv VALUES (?, '1')").run(`pgid:${id}:${c.pid}`)
  assert.equal(resetOrphans(db).some((t) => t.id === id), true)
  await gone // SIGTERM reached the group
  assert.equal((db.prepare("SELECT COUNT(*) n FROM kv WHERE k LIKE ?").get(`pgid:${id}:%`) as { n: number }).n, 0)
})

test("claimAlive tolerates a clock that stepped back 5 minutes", () => {
  const c = spawn("sleep", ["5"], { stdio: "ignore" })
  try { assert.equal(claimAlive(`${c.pid}:${Date.now() - 300_000}`), true) } finally { c.kill() }
})

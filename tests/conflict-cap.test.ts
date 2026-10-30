// Issue 365: conflict probe, spend reservation, install prose, retry of a ticket whose PR was closed by hand. Offline, injected runners.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-conflict-cap-`)
process.env.DOBBY_DIR = `${dir}/data`
process.env.DOBBY_SECRETS = `${dir}/none`
const { open, logRun } = await import("../src/db.ts")
const { addTicket, buildEstimate, runEndText, getTicket, installCmd, setTicket, spendAllows } = await import("../src/lib.ts")
const { baseConflicts } = await import("../src/graphs/ticket.ts")
const { run } = await import("../src/graphs/review.ts")
const { retryText, showText, listText } = await import("../src/actions.ts")

test("baseConflicts: clean = [], conflicting = the files, a merge left open is aborted", () => {
  const g = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" })
  const repo = mkdtempSync(`${tmpdir()}/dobby-bc-`)
  g(repo, "init", "-q", "-b", "main"); g(repo, "config", "user.name", "t"); g(repo, "config", "user.email", "t@t")
  const commit = (f: string, text: string) => { writeFileSync(`${repo}/${f}`, text); g(repo, "add", "."); g(repo, "commit", "-qm", text) }
  commit("a.txt", "base\n")
  g(repo, "checkout", "-qb", "work"); commit("a.txt", "mine\n")
  g(repo, "checkout", "-q", "main"); g(repo, "update-ref", "refs/remotes/origin/main", "HEAD"); g(repo, "checkout", "-q", "work")
  assert.deepEqual(baseConflicts(run, repo, "main"), [])
  g(repo, "checkout", "-q", "main"); commit("a.txt", "theirs\n"); g(repo, "update-ref", "refs/remotes/origin/main", "HEAD"); g(repo, "checkout", "-q", "work")
  assert.deepEqual(baseConflicts(run, repo, "main"), ["a.txt"])
  g(repo, "merge", "origin/main") // leaves a merge open with a.txt conflicted
  assert.equal(g(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD").status, 0)
  assert.deepEqual(baseConflicts(run, repo, "main"), ["a.txt"])
  assert.notEqual(g(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD").status, 0, "aborted")
  assert.deepEqual(baseConflicts(() => ({ ok: false, out: "fatal: unknown option" }), repo, "main"), [], "an unreadable answer does not stop the ticket")
})

test("spend cap: running builds are reserved at the estimate, so parallel workers overshoot by at most one build", () => {
  const db = open(":memory:")
  const b = { mode: "apiKey" as const, dailyUsd: 5 }
  logRun(db, { project: "p", kind: "build", model: "sonnet", ok: true, cost_usd: 3 })
  const now = Date.now()
  // 4 workers check the cap one after the other, each reserving a slot when it starts; the estimate is injected: $1 per build
  let started = 0
  for (let i = 0; i < 4; i++) if (spendAllows(db, b, now, started, 1).ok) started++
  assert.equal(started, 2, "$3 spent + 2 reserved = $5 = the cap: a third does not start")
  assert.match(spendAllows(db, b, now, 2, 1).why, /\$5\.00 in 24 hours \(incl\. \$2\.00 for 2 running\) \(cap \$5\)/)
  assert.equal(spendAllows(db, { ...b, weeklyUsd: 4 }, now, 1, 1).ok, false, "the weekly cap reserves too")
  assert.equal(spendAllows(db, b, now, 0, 1).ok, true, "nothing running: as before")
})

test("build estimate: a ticket's whole cost (build, check, fix) averaged over the last tickets, $1.00 before any", () => {
  const db = open(":memory:")
  assert.equal(buildEstimate(db), 1)
  const log = (ticket: number | undefined, kind: string, c: number) => logRun(db, { project: "p", kind, ticket, model: "sonnet", ok: true, cost_usd: c })
  log(1, "build", 0.2); log(1, "check", 0.2); log(2, "build", 0); log(3, "build", 0.6)
  log(undefined, "lead", 9) // no ticket: not a ticket's cost
  assert.ok(Math.abs(buildEstimate(db) - 0.5) < 1e-9) // (0.4 + 0.6) / 2
})

test("install: prose is not a shell command", () => {
  for (const v of [undefined, "", "  ", "none needed (static site)", "None", "n/a", "nothing to install", "not needed"]) assert.equal(installCmd(v), "true", String(v))
  assert.equal(installCmd(" npm ci "), "npm ci")
  assert.equal(installCmd("bun install"), "bun install")
})

test("retry: a failed ticket whose PR was closed by hand gets it reopened, or is not queued and says why", () => {
  const db = open(":memory:")
  const projects = { shop: { name: "shop", repo: "/x/shop" } } as never
  const mk = () => { const id = addTicket(db, { project: "shop", title: "Add range" }).id; setTicket(db, id, { status: "failed", branch: `dobby/${id}` }); return id }
  const URL = "https://github.com/acme/shop/pull/14"
  const runner = (state: string, reopen: { ok: boolean; out: string }, calls: string[]) => (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.slice(0, 2).join(" ")}`)
    if (cmd === "git") return { ok: true, out: "git@github.com:acme/shop.git" }
    if (args[1] === "view") return { ok: !!state, out: state ? `${state} ${URL}\n` : "no pull requests found" }
    return reopen
  }
  const a = mk(), calls: string[] = []
  retryText(db, a, runner("CLOSED", { ok: true, out: "" }, calls), projects)
  assert.equal(getTicket(db, a)!.status, "ready")
  assert.ok(calls.includes("gh pr reopen"), calls.join(";"))

  const b = mk()
  assert.match(retryText(db, b, runner("CLOSED", { ok: false, out: "Pull request is not reopenable: branch deleted" }, []), projects), /not queued: its PR .*can't be reopened \(Pull request is not reopenable/)
  assert.equal(getTicket(db, b)!.status, "failed", "no blind rebuild")

  const c = mk()
  assert.match(retryText(db, c, runner("MERGED", { ok: true, out: "" }, []), projects), /already merged/)
  assert.equal(getTicket(db, c)!.status, "failed")

  const d = mk() // no PR (never opened): queued as before
  retryText(db, d, runner("", { ok: true, out: "" }, []), projects)
  assert.equal(getTicket(db, d)!.status, "ready")
})

test("run: a ticket handed to the owner ends as 'needs you', not 'now failed'", () => {
  assert.equal(runEndText(4, { status: "failed", note: "needs you: every merge waits for you" }), "#4 needs you: every merge waits for you")
  assert.equal(runEndText(4, { status: "failed", note: "verify failed" }), "#4 now failed")
  assert.equal(runEndText(4, { status: "approval" }), "#4 now approval")
  // still ready = nothing was built: the line says so, with the reason (the CLI exits 1 too)
  assert.equal(runEndText(4, { status: "ready", note: "Claude did not start" }), "#4 was not built and is back in the queue: Claude did not start. Run dobby run 4 again, or see dobby show 4")
  assert.equal(runEndText(4, { status: "ready" }), "#4 was not built and is back in the queue. Run dobby run 4 again, or see dobby show 4")
})

test("show and list --all say needs you, not failed, for a ticket handed to the owner (#375)", async () => {
  const db = open(":memory:")
  const a = addTicket(db, { project: "tally", title: "owner one", size: "S", risk: "low", priority: 1, done_when: "x" })
  const b = addTicket(db, { project: "tally", title: "broken one", size: "S", risk: "low", priority: 1, done_when: "x" })
  setTicket(db, a.id, { status: "failed", note: "needs you: every merge waits for you" })
  setTicket(db, b.id, { status: "failed", note: "verify failed" })
  assert.match(await showText(db, a.id), /^#\d+ \[needs you\]/)
  assert.match(await showText(db, b.id), /^#\d+ \[failed\]/)
  const l = listText(db, true)
  assert.match(l, /\[needs you\] tally.*owner one/)
  assert.match(l, /\[failed\] tally.*broken one/)
})

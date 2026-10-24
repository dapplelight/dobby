// Stuck Tally PRs: rebase sweep, review job failing without findings, a retry's old PR closed. Offline: temp dirs, gh stubbed, local git real.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-stuck-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/s.txt`
process.env.DOBBY_PROJECTS = `${dir}/projects`
process.env.JEV_API_KEY = ""
mkdirSync(`${dir}/projects/tally`, { recursive: true })
const { open } = await import("../src/db.ts")
const { addTicket, setTicket, getTicket } = await import("../src/lib.ts")
const rv = await import("../src/graphs/review.ts")
const { closeSuperseded, freshenBase, freshenBranch, pushArgs } = await import("../src/graphs/ticket.ts")

const g = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" })

test("rebase sweep: a CONFLICTING foreman PR is rebased; a conflict queues a branch ticket; one PR per project, no head twice", async () => {
  const root = mkdtempSync(`${dir}/rb-`)
  g(root, "init", "-q", "--bare", "-b", "main", "origin.git")
  g(root, "clone", "-q", `${root}/origin.git`, "repo")
  const repo = `${root}/repo`
  const commit = (f: string, t: string) => { writeFileSync(`${repo}/${f}`, t); g(repo, "add", "."); g(repo, "commit", "-qm", t) }
  commit("a.txt", "base\n"); g(repo, "push", "-q", "origin", "HEAD:main")
  for (const [n, f] of [["foreman/1", "b.txt"], ["foreman/2", "a.txt"]]) { g(repo, "checkout", "-qb", n, "main"); commit(f, `${n}\n`); g(repo, "push", "-qu", "origin", n); g(repo, "checkout", "-q", "main") }
  commit("a.txt", "main moved\n"); g(repo, "push", "-q", "origin", "main")
  g(repo, "fetch", "-q")
  const oid = (b: string) => g(repo, "rev-parse", `refs/remotes/origin/${b}`).stdout.trim()
  const prs = [1, 2].map((n) => ({ number: n, headRefName: `foreman/${n}`, headRefOid: oid(`foreman/${n}`), baseRefName: "main", mergeable: "CONFLICTING", isCrossRepository: false }))
  prs.push({ number: 3, headRefName: "feature/x", headRefOid: "z", baseRefName: "main", mergeable: "CONFLICTING", isCrossRepository: false }) // not Dobby's
  const run = (cmd: string, args: string[], cwd?: string) => {
    if (cmd === "git" && args[0] === "remote") return { ok: true, out: "https://github.com/acmeorg/tally.git\n" }
    if (cmd === "gh") { assert.ok(args.includes("--repo")); return { ok: true, out: JSON.stringify(prs) } }
    const r = g(cwd ?? repo, ...args)
    return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? "") }
  }
  const project = { name: "tally", repo, base: "main", install: "true", verify: "true", priority: 5, jev: false, paused: false, rules: "" }
  const db = open(":memory:")
  const d = { run, claude: null as any, notify: null as any }
  const first = await rv.sweepRebase(db, d, { tally: project })
  assert.equal(first.length, 1)
  assert.match(first[0], /#1 rebase: pushed/)
  assert.equal(g(repo, "--git-dir", `${root}/origin.git`, "merge-base", "--is-ancestor", "main", "foreman/1").status, 0)
  const second = await rv.sweepRebase(db, d, { tally: project }) // #1's head was tried (the stub still shows the old one): next PR
  assert.match(second[0], /#2 rebase: not mechanical, ticket #\d+/)
  const t = db.prepare("SELECT * FROM tickets").get() as any
  assert.deepEqual([t.onto, t.status, t.project], ["foreman/2", "ready", "tally"])
  assert.match(t.done_when, /git merge origin\/main[\s\S]*a\.txt/)
  assert.deepEqual(await rv.sweepRebase(db, d, { tally: project }), []) // both heads tried: nothing again
  assert.equal((db.prepare("SELECT count(*) n FROM tickets").get() as any).n, 1)
})

test("no findings: the failed Claude Review run is re-run once, the second time the ticket fails with a CI note", async () => {
  const db = open(":memory:")
  const project = { name: "tally", repo: `${dir}/projects/tally`, base: "main", install: "true", verify: "true", priority: 5, jev: false, paused: false, rules: "" }
  const { id } = addTicket(db, { project: "tally", title: "Add the thing" })
  setTicket(db, id, { status: "fixing" })
  db.prepare("INSERT INTO kv VALUES (?, ?)").run("automerge:acmeorg/tally#9", JSON.stringify({ ticket: id, rounds: 1 }))
  const calls: string[][] = [], pings: string[] = []
  const run = (_cmd: string, args: string[]) => {
    calls.push(args)
    if (args[0] === "remote") return { ok: true, out: "https://github.com/acmeorg/tally.git\n" }
    if (args[1] === "view") return { ok: true, out: JSON.stringify({ title: "Add the thing", headRefName: "foreman/5", state: "OPEN", isCrossRepository: false, files: [] }) }
    if (args[1] === "list") return { ok: true, out: JSON.stringify([{ databaseId: 77, workflowName: "Claude Review", conclusion: "failure" }]) }
    return { ok: true, out: "" }
  }
  const d = { run, claude: null as any, notify: (async (t: string) => (pings.push(t), true)) as any, ping: async (_k: string, t: string) => void pings.push(t) }
  const one = await rv.fixReview(db, "acmeorg/tally", 9, d, { tally: project })
  assert.match(one, /^🔁/)
  assert.ok(calls.some((a) => a.join(" ") === "run rerun 77 -R acmeorg/tally --failed"))
  assert.equal(getTicket(db, id)!.status, "fixing")
  const two = await rv.fixReview(db, "acmeorg/tally", 9, d, { tally: project })
  assert.match(two, /nothing to queue/i)
  assert.equal(calls.filter((a) => a[1] === "rerun").length, 1, "re-run once only")
  assert.deepEqual([getTicket(db, id)!.status, /review job failed without findings; check CI/.test(getTicket(db, id)!.note ?? "")], ["failed", true])
  assert.equal(pings.length, 1)
})

test("retry of #N: the old ticket's open PR is closed with a link, only once the new PR exists", async () => {
  const db = open(":memory:")
  const old = addTicket(db, { project: "tally", title: "Slice" }).id
  setTicket(db, old, { branch: `dobby/${old}` })
  const t = { id: addTicket(db, { project: "tally", title: "x" }).id, title: `Slice (retry of #${old}, smaller)` }
  const calls: string[][] = []
  const gh = (a: string[]) => (calls.push(a), a[1] === "list" ? { ok: true, out: JSON.stringify([{ number: 4, url: "https://github.com/o/r/pull/4" }, { number: 9, url: "https://github.com/o/r/pull/9" }]) } : { ok: true, out: "" })
  assert.deepEqual(await closeSuperseded(db, t, "", gh, ["--repo", "o/r"]), [])
  assert.equal(calls.length, 0, "no new PR, nothing closed")
  assert.deepEqual(await closeSuperseded(db, t, "https://github.com/o/r/pull/9", gh, ["--repo", "o/r"]), ["#4 closed"])
  const close = calls.find((a) => a[1] === "close")!
  assert.deepEqual(close.slice(0, 5), ["pr", "close", "4", "--repo", "o/r"])
  assert.match(close[6], /pull\/9/)
  assert.deepEqual(await closeSuperseded(db, { id: 99, title: "Plain title" }, "https://github.com/o/r/pull/9", gh, []), [])
})

test("pre-PR rebase: stale base rebases clean and verifies; a conflict resumes the builder once, a second failure keeps the branch as built", async () => {
  const root = mkdtempSync(`${dir}/fr-`)
  g(root, "init", "-q", "--bare", "-b", "main", "origin.git")
  g(root, "clone", "-q", `${root}/origin.git`, "wt")
  const wt = `${root}/wt`
  g(wt, "config", "core.editor", "true")
  const commit = (f: string, t: string) => { writeFileSync(`${wt}/${f}`, t); g(wt, "add", "."); g(wt, "commit", "-qm", t) }
  const sh = (cmd: string) => { const r = spawnSync("sh", ["-c", cmd], { cwd: wt, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? "") } }
  commit("a.txt", "base\n"); g(wt, "push", "-q", "origin", "HEAD:main")
  let mv = 0
  const moveMain = (f: string) => { g(wt, "checkout", "-q", "main"); commit(f, `main moved ${mv++}\n`); g(wt, "push", "-q", "origin", "main") }
  const branch = (n: string, f: string) => { g(wt, "checkout", "-qb", n, "main"); commit(f, `${n}\n`) }
  // clean: main moves on another file
  branch("foreman/1", "b.txt"); moveMain("c.txt"); g(wt, "checkout", "-q", "foreman/1")
  const verified: string[][] = []
  assert.equal(await freshenBase({ sh, base: "main", verify: async (c) => (verified.push(c), { ok: true, out: "" }), resume: async () => assert.fail("no resume on a clean rebase") }), "")
  assert.equal(g(wt, "merge-base", "--is-ancestor", "origin/main", "HEAD").status, 0)
  assert.deepEqual(verified, [["c.txt"]])
  // conflict: the stubbed builder resolves it once
  g(wt, "checkout", "-q", "main"); g(wt, "reset", "-q", "--hard", "origin/main"); branch("foreman/2", "a.txt"); moveMain("a.txt"); g(wt, "checkout", "-q", "foreman/2")
  const prompts: string[] = []
  const resolve = async (p: string) => { prompts.push(p); sh("git rebase origin/main"); writeFileSync(`${wt}/a.txt`, "both\n"); sh("git add a.txt && git rebase --continue") }
  assert.equal(await freshenBase({ sh, base: "main", verify: async () => ({ ok: true, out: "" }), resume: resolve }), "")
  assert.equal(prompts.length, 1)
  assert.match(prompts[0], /git rebase origin\/main/)
  assert.equal(g(wt, "merge-base", "--is-ancestor", "origin/main", "HEAD").status, 0)
  // conflict the builder cannot fix: back to the head as built, a note, one resume only
  g(wt, "checkout", "-q", "main"); g(wt, "reset", "-q", "--hard", "origin/main"); branch("foreman/3", "a.txt"); const built = g(wt, "rev-parse", "HEAD").stdout; moveMain("a.txt"); g(wt, "checkout", "-q", "foreman/3")
  let n = 0
  const note = await freshenBase({ sh, base: "main", verify: async () => ({ ok: true, out: "" }), resume: async () => void n++ })
  assert.match(note, /could not rebase/)
  assert.equal(n, 1)
  assert.equal(g(wt, "rev-parse", "HEAD").stdout, built)
})

test("conflict gate: scan skips review of a CONFLICTING foreman PR; fixReview rebases instead of starting a round; UNKNOWN goes on", async () => {
  const db = open(":memory:")
  db.prepare("INSERT INTO kv VALUES ('review:repos', ?)").run(JSON.stringify({ at: Date.now(), repos: [{ slug: "acmeorg/tally", dir: `${dir}/projects/tally` }] }))
  db.prepare("INSERT INTO kv VALUES ('review:chat:acmeorg/tally', ?)").run(new Date().toISOString())
  const list = [
    { number: 1, headRefOid: "a", isDraft: false, headRefName: "foreman/1", mergeable: "CONFLICTING" },
    { number: 2, headRefOid: "b", isDraft: false, headRefName: "foreman/2", mergeable: "UNKNOWN" },
  ]
  const calls: string[][] = []
  const run = (_c: string, args: string[]) => (calls.push(args), args[0] === "remote" ? { ok: true, out: "https://github.com/acmeorg/tally.git\n" } : args[1] === "list" ? { ok: true, out: JSON.stringify(list) } : { ok: true, out: "" })
  const reviewed: number[] = []
  await rv.scan(db, { deps: { run, claude: null as any, notify: null as any, projects: {} }, review: async (_r, n) => (reviewed.push(n), { state: "success", why: "", url: "", log: [] }), budget: () => ({ ok: true, why: "" }) })
  assert.deepEqual(reviewed, [2])
  const project = { name: "tally", repo: `${dir}/projects/tally`, base: "main", install: "true", verify: "false", priority: 5, jev: false, paused: false, rules: "" }
  calls.length = 0
  const view = (mergeable: string) => (_c: string, args: string[]) => (calls.push(args), args[0] === "remote" ? { ok: true, out: "https://github.com/acmeorg/tally.git\n" }
    : args[0] === "rev-parse" ? { ok: true, out: "abc\n" } : args[1] === "view" ? { ok: true, out: JSON.stringify({ title: "T", headRefName: "foreman/5", headRefOid: "abc", baseRefName: "main", mergeable, state: "OPEN", isCrossRepository: false, files: [] }) } : { ok: true, out: "" })
  const out = await rv.fixReview(db, "acmeorg/tally", 5, { run: view("CONFLICTING"), claude: null as any, notify: null as any }, { tally: project })
  assert.match(out, /^🔁 acmeorg\/tally#5 conflicts with main/)
  assert.ok(calls.some((a) => a[0] === "rebase"), "rebase tried first")
  calls.length = 0
  assert.match(await rv.fixReview(db, "acmeorg/tally", 5, { run: view("UNKNOWN"), claude: null as any, notify: null as any }, { tally: project }), /^(No open medium|🔁 No findings)/) // went on to the normal path
  assert.ok(!calls.some((a) => a[0] === "rebase"))
})

test("ship after a pre-PR rebase: the rewritten branch pushes with a lease on origin's sha (a plain push is refused); the resume runs in the build worktree path", async () => {
  const root = mkdtempSync(`${dir}/ship-`)
  g(root, "init", "-q", "--bare", "-b", "main", "origin.git")
  g(root, "clone", "-q", `${root}/origin.git`, "repo")
  const repo = `${root}/repo`
  const commit = (f: string, t: string) => { writeFileSync(`${repo}/${f}`, t); g(repo, "add", "."); g(repo, "commit", "-qm", t) }
  commit("a.txt", "base\n"); g(repo, "push", "-q", "origin", "HEAD:main")
  g(repo, "checkout", "-qb", "foreman/9", "main"); commit("b.txt", "b\n"); g(repo, "push", "-qu", "origin", "foreman/9")
  g(repo, "checkout", "-q", "main"); commit("c.txt", "c\n"); g(repo, "push", "-q", "origin", "main")
  const remote = g(repo, "rev-parse", "origin/foreman/9").stdout.trim()
  const sh = (cmd: string, cwd: string) => { const r = spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" }); return { ok: r.status === 0, out: (r.stdout ?? "") + (r.stderr ?? "") } }
  const wt = `${root}/build-wt`
  let seen = ""
  const note = await freshenBranch({ sh, repo, wt, branch: "foreman/9", base: "main", verify: async () => ({ ok: true, out: "" }), resume: async (_p, cwd) => (seen = cwd) })
  assert.equal(note, "")
  assert.equal(g(repo, "rev-parse", "foreman/9").stdout.trim() === remote, false, "rebase rewrote the branch")
  assert.notEqual(g(repo, ...pushArgs("foreman/9", "").slice(0, 0), "push", "origin", "foreman/9").status, 0, "plain push refused")
  assert.equal(g(repo, ...pushArgs("foreman/9", remote)).status, 0, "lease push accepted")
  // a conflict resumes in the same path the build used
  g(repo, "checkout", "-q", "main"); g(repo, "checkout", "-qb", "foreman/10", "main"); commit("a.txt", "mine\n"); g(repo, "checkout", "-q", "main"); commit("a.txt", "theirs\n"); g(repo, "push", "-q", "origin", "main")
  await freshenBranch({ sh, repo, wt, branch: "foreman/10", base: "main", verify: async () => ({ ok: true, out: "" }), resume: async (_p, cwd) => (seen = cwd) })
  assert.equal(seen, wt)
})

test("rebase failures: a transient one is not a started round and is retried (3 tries per head); a definitive one is marked", async () => {
  const db = open(":memory:")
  const project = { name: "tally", repo: `${dir}/projects/tally`, base: "main", install: "true", verify: "true", priority: 5, jev: false, paused: false, rules: "" }
  const view = JSON.stringify({ title: "T", headRefName: "foreman/5", headRefOid: "abc", baseRefName: "main", mergeable: "CONFLICTING", state: "OPEN", isCrossRepository: false, files: [] })
  let fetchOk = false
  const run = (_c: string, args: string[]) => args[0] === "remote" ? { ok: true, out: "https://github.com/acmeorg/tally.git\n" } : args[1] === "view" ? { ok: true, out: view }
    : args[0] === "fetch" ? { ok: fetchOk, out: "nope" } : args[0] === "rev-parse" ? { ok: true, out: "abc\n" } : args[0] === "rebase" ? { ok: true, out: "" } : { ok: true, out: "" }
  const d = { run, claude: null as any, notify: null as any }
  const ask = () => rv.fixReview(db, "acmeorg/tally", 5, d, { tally: project })
  for (let i = 0; i < 3; i++) assert.match(await ask(), /^Couldn't start: /) // not a 🔁 round, and not marked: tried again
  assert.match(await ask(), /^Won't: .*already tried/) // the third failure used the cap
  const db2 = open(":memory:")
  fetchOk = true
  const ok = await rv.fixReview(db2, "acmeorg/tally", 5, d, { tally: project }) // fetch fine, the stub worktree does not exist so verify is red: a definitive outcome, ticket queued
  assert.match(ok, /^🔁 .*not mechanical, ticket #1/)
  assert.equal((db2.prepare("SELECT v FROM kv WHERE k='rebase:acmeorg/tally#5'").get() as any).v, "abc")
})

test("re-run of a broken review job: the cached fail row for that head is dropped so the head is reviewed again", async () => {
  const db = open(":memory:")
  db.prepare("INSERT INTO reviews (repo,pr,sha,verdict,at) VALUES ('acmeorg/tally',9,'abc','fail','x')").run()
  const project = { name: "tally", repo: `${dir}/projects/tally`, base: "main", install: "true", verify: "true", priority: 5, jev: false, paused: false, rules: "" }
  const run = (_c: string, args: string[]) => args[0] === "remote" ? { ok: true, out: "https://github.com/acmeorg/tally.git\n" }
    : args[1] === "view" ? { ok: true, out: JSON.stringify({ title: "T", headRefName: "foreman/5", headRefOid: "abc", baseRefName: "main", mergeable: "MERGEABLE", state: "OPEN", isCrossRepository: false, files: [] }) }
    : args[1] === "list" ? { ok: true, out: JSON.stringify([{ databaseId: 1, workflowName: "Claude Review", conclusion: "failure" }]) } : { ok: true, out: "" }
  assert.match(await rv.fixReview(db, "acmeorg/tally", 9, { run, claude: null as any, notify: null as any }, { tally: project }), /^🔁/)
  assert.equal(db.prepare("SELECT 1 FROM reviews WHERE sha='abc'").get(), undefined)
  assert.equal(rv.claim(db, "acmeorg/tally", 9, "abc"), true)
})

test("rebase sweep: a head that used its 3 transient tries is skipped and the next conflicting PR gets the slot", async () => {
  const db = open(":memory:")
  const prs = [1, 2].map((n) => ({ number: n, headRefName: `foreman/${n}`, headRefOid: `h${n}`, baseRefName: "main", mergeable: "CONFLICTING", isCrossRepository: false }))
  db.prepare("INSERT INTO kv VALUES ('rebase:acmeorg/tally#1:h1', '3')").run()
  const run = (cmd: string, args: string[]) => cmd === "gh" ? { ok: true, out: JSON.stringify(prs) } : args[0] === "remote" ? { ok: true, out: "https://github.com/acmeorg/tally.git\n" } : { ok: false, out: "no network" }
  const project = { name: "tally", repo: `${dir}/projects/tally`, base: "main", install: "true", verify: "true", priority: 5, jev: false, paused: false, rules: "" }
  const out = await rv.sweepRebase(db, { run, claude: null as any, notify: null as any }, { tally: project })
  assert.equal(out.length, 1)
  assert.match(out[0], /#2 rebase/)
})

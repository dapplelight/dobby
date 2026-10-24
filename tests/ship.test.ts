// Ship's PR-exists and not-mergeable paths: fake gh results, real local git. Never touches GitHub.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-ship-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/secrets.env`
process.env.DOBBY_PROJECTS = `${dir}/projects`
process.env.JEV_API_KEY = ""
mkdirSync(`${dir}/projects`, { recursive: true })
const { run } = await import("../src/graphs/review.ts")
const { createPr, mergeOrRebase, rebaseAndPush } = await import("../src/graphs/ticket.ts")

test("create: 'already exists' reuses the PR", async () => {
  const url = "https://github.com/ownerdev/tally/pull/742"
  const exists = `a pull request for branch "foreman/254" into branch "main" already exists:\n${url}`
  assert.deepEqual(await createPr(() => ({ ok: false, out: exists }), () => assert.fail("no view needed")), { ok: true, out: url })
  assert.deepEqual(await createPr(() => ({ ok: false, out: 'a pull request for branch "x" into branch "main" already exists' }), () => ({ ok: true, out: url })), { ok: true, out: url })
  assert.equal((await createPr(() => ({ ok: false, out: "boom" }), () => assert.fail("no view"))).out, "boom")
})

test("merge: 'not mergeable' rebases once and retries once; a conflicted rebase names the files and pushes nothing", async () => {
  const root = mkdtempSync(`${tmpdir()}/foreman-rebase-`)
  const g = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" })
  const origin = (...args: string[]) => g(root, "--git-dir", `${root}/origin.git`, ...args)
  g(root, "init", "-q", "--bare", "-b", "main", "origin.git")
  g(root, "clone", "-q", `${root}/origin.git`, "repo")
  const repo = `${root}/repo`
  const commit = (f: string, text: string) => { writeFileSync(`${repo}/${f}`, text); g(repo, "add", "."); g(repo, "commit", "-qm", text) }
  commit("a.txt", "base\n"); g(repo, "push", "-q", "origin", "HEAD:main")
  const branch = (name: string, f: string) => { g(repo, "checkout", "-qb", name, "main"); commit(f, `${name}\n`); g(repo, "push", "-qu", "origin", name); g(repo, "checkout", "-q", "main") }
  branch("foreman/1", "b.txt"); branch("foreman/2", "a.txt")
  commit("a.txt", "main moved\n"); g(repo, "push", "-q", "origin", "main")
  const calls: string[] = []
  const rec = (cmd: string, args: string[], cwd?: string) => (calls.push(args.join(" ")), run(cmd, args, cwd))
  const outcomes = [{ ok: false, out: "Pull request #742 is not mergeable: merge conflicts" }, { ok: true, out: "merged" }]

  // clean rebase: verify runs in the rebase worktree, branch is force-pushed on top of main, merge retried once
  const verified: string[] = []
  let i = 0
  const ok = await mergeOrRebase(() => outcomes[Math.min(i++, 1)], () => rebaseAndPush(rec, repo, `${root}/wt1`, "foreman/1", "main", (wt) => (verified.push(wt), { ok: true, out: "" })))
  assert.deepEqual(ok, { ok: true, out: "merged" })
  assert.deepEqual(verified, [`${root}/wt1`])
  assert.equal(origin("merge-base", "--is-ancestor", "main", "foreman/1").status, 0)
  assert.ok(calls.some((c) => c.includes("--force-with-lease")))
  assert.equal(existsSync(`${root}/wt1`), false)

  // conflicted rebase: aborted, files named, merge not retried, nothing pushed
  const before = origin("rev-parse", "foreman/2").stdout
  let merges = 0
  const bad = await mergeOrRebase(() => (merges++, { ok: false, out: "not mergeable" }), () => rebaseAndPush(rec, repo, `${root}/wt2`, "foreman/2", "main", () => assert.fail("no verify on conflict")))
  assert.equal(bad.ok, false)
  assert.deepEqual(bad.conflicts, ["a.txt"])
  assert.equal(merges, 1)
  assert.equal(origin("rev-parse", "foreman/2").stdout, before)
  assert.equal(existsSync(`${root}/wt2`), false)

  // red verify after a clean rebase pushes nothing; other merge errors are not retried
  assert.match((await rebaseAndPush(rec, repo, `${root}/wt3`, "foreman/1", "main", () => ({ ok: false, out: "red" }))).out, /verify failed after rebase/)
  assert.equal((await mergeOrRebase(() => ({ ok: false, out: "auth" }), () => assert.fail("no rebase"))).out, "auth")

  // after a rebase the retried merge waits for checks on the new head; red checks skip the merge
  const order: string[] = []
  await mergeOrRebase(() => (order.push("merge"), { ok: false, out: "not mergeable" }), () => (order.push("rebase"), { ok: true, out: "" }), () => (order.push("checks"), { ok: true, out: "" }))
  assert.deepEqual(order, ["merge", "rebase", "checks", "merge"])
  const red = await mergeOrRebase(() => ({ ok: false, out: "not mergeable" }), () => ({ ok: true, out: "" }), () => ({ ok: false, out: "checks failed" }))
  assert.equal(red.out, "checks failed")
})

const { waitChecks, landPr } = await import("../src/merge.ts")
const stubGh = (answers: Record<string, () => { ok: boolean; out: string }>, calls: string[] = []) => (cmd: string, args: string[], cwd?: string) => {
  calls.push(`${cmd} ${args.join(" ")}${cwd ? ` @${cwd}` : ""}`)
  const k = Object.keys(answers).find((a) => args.join(" ").includes(a))
  return k ? answers[k]() : { ok: true, out: "" }
}
const rows = (...r: [string, string, string?][]) => JSON.stringify(r.map(([name, bucket, workflow]) => ({ name, bucket, workflow: workflow ?? "" })))

test("checks: every check counts except Dobby's own review workflow; required-only is opt-in; failing name first", async () => {
  const none = () => {}
  // 13 Tally tickets: the leftover Actions "review" job failed "Not logged in" and blocked the merge
  const all: string[] = []
  assert.deepEqual(await waitChecks(stubGh({ checks: () => ({ ok: false, out: rows(["test", "pass", "CI"], ["review", "fail", "Claude Review"]) }) }, all), "ownerdev/tally", 7, none), { ok: true, out: "checks passed (1)" })
  assert.equal(all[0].includes("--required"), false) // default: all checks, as before
  // a failing check that is not required still blocks by default (owner-safe)
  assert.equal((await waitChecks(stubGh({ checks: () => ({ ok: false, out: rows(["preview", "fail", "Vercel"], ["test", "pass", "CI"]) }) }), "r/r", 1, none)).out, "check failed: preview (Vercel). PR left open.")
  // opt-in required-only (DOBBY_CHECKS=required), all checks when the repo requires none
  assert.deepEqual(await waitChecks(stubGh({ "--required": () => ({ ok: false, out: rows(["test", "pass", "CI"]) }) }), "ownerdev/tally", 7, none, 80, true), { ok: true, out: "required checks passed (1)" })
  const calls: string[] = []
  const fallback = await waitChecks(stubGh({ "--required": () => ({ ok: false, out: "no required checks reported on the 'foreman/5' branch" }), "checks 7": () => ({ ok: false, out: rows(["build", "pass", "CI"], ["lint", "fail", "CI"], ["Claude Review", "fail"]) }) }, calls), "ownerdev/tally", 7, none, 80, true)
  assert.equal(fallback.out, "check failed: lint (CI). PR left open.")
  assert.deepEqual(calls.map((c) => c.includes("--required")), [true, false])
  assert.equal((await waitChecks(stubGh({ checks: () => ({ ok: false, out: "no checks reported on the 'x' branch" }) }), "r/r", 1, none)).ok, true) // no CI at all merges as before
  // the mergeChecks: required setting turns required-only on without the env
  const { config, setConfig } = await import("../src/config.ts")
  const before = config()
  setConfig({ ...before, mergeChecks: "required" })
  const viaCfg: string[] = []
  await waitChecks(stubGh({ "--required": () => ({ ok: false, out: rows(["test", "pass", "CI"]) }) }, viaCfg), "r/r", 1, none)
  setConfig(before)
  assert.equal(viaCfg[0].includes("--required"), true)
  // pending, then green: polls with the injected sleep; still pending at the cap: names what is still running
  let n = 0
  const slept: number[] = []
  assert.equal((await waitChecks(stubGh({ checks: () => ({ ok: false, out: rows(["test", n++ ? "pass" : "pending", "CI"]) }) }), "r/r", 1, (ms) => slept.push(ms))).ok, true)
  assert.deepEqual(slept, [20_000, 30_000])
  assert.match((await waitChecks(stubGh({ checks: () => ({ ok: false, out: rows(["e2e", "pending", "CI"]) }) }), "r/r", 1, none, 2)).out, /^checks still running after 40 min: e2e \(CI\)/)
  assert.match((await waitChecks(stubGh({ checks: () => ({ ok: false, out: "HTTP 502" }) }), "r/r", 1, none)).out, /^could not read the checks/)
})

test("landPr (ship's merge): checks first, merge by branch in the repo, MERGED confirmed; red checks never merge", async () => {
  const calls: string[] = []
  const r = stubGh({ "pr checks": () => ({ ok: true, out: "[]" }), "pr merge": () => ({ ok: true, out: "" }), "pr view": () => ({ ok: true, out: "MERGED\n" }) }, calls)
  const ok = await landPr(r, { repo: "ownerdev/tally", pr: 7, sha: "rev1", cwd: "/repo", merge: ["pr", "merge", "foreman/5", "--squash", "--delete-branch"], rebase: () => assert.fail("no rebase"), sleep: () => {} })
  assert.equal(ok.ok, true)
  assert.deepEqual(calls.map((c) => c.split(" ").slice(0, 3).join(" ")), ["gh pr checks", "gh pr merge", "gh pr view"])
  assert.match(calls[1], /foreman\/5 --squash --delete-branch --match-head-commit rev1 @\/repo$/)
  // main moved: the rebase starts from the reviewed head and the retried merge matches the pushed head
  const merges: string[] = []
  let first = true
  const moved = await landPr(stubGh({ "pr checks": () => ({ ok: true, out: "[]" }), "pr merge": () => (first ? ((first = false), { ok: false, out: "not mergeable: merge conflicts" }) : { ok: true, out: "" }), "pr view": () => ({ ok: true, out: "MERGED" }) }, merges), { repo: "ownerdev/tally", pr: 7, sha: "rev1", merge: ["pr", "merge", "7"], rebase: (sha) => ({ ok: sha === "rev1", out: "", sha: "rev2" }), sleep: () => {} })
  assert.equal(moved.ok, true)
  assert.deepEqual(merges.filter((c) => c.includes("merge")).map((c) => c.split(" ").pop()), ["rev1", "rev2"])
  const red: string[] = []
  const no = await landPr(stubGh({ "pr checks": () => ({ ok: false, out: rows(["test", "fail", "CI"]) }) }, red), { repo: "ownerdev/tally", pr: 7, sha: "rev1", merge: ["pr", "merge", "7"], rebase: () => assert.fail("no rebase"), sleep: () => {} })
  assert.deepEqual([no.ok, no.out, red.some((c) => c.includes("merge"))], [false, "check failed: test (CI). PR left open.", false])
})

const { setupWorktree, reviewPushed } = await import("../src/graphs/ticket.ts")
const { open } = await import("../src/db.ts")

test("prepare: a conflict ticket gets git merge origin/<base> started in its worktree, markers left for the Builder; failures fail plainly", async () => {
  const root = mkdtempSync(`${tmpdir()}/foreman-prep-`)
  const g = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" })
  g(root, "init", "-q", "--bare", "-b", "main", "origin.git")
  g(root, "clone", "-q", `${root}/origin.git`, "repo")
  const repo = `${root}/repo`
  g(repo, "config", "user.name", "t"); g(repo, "config", "user.email", "t@t")
  const commit = (f: string, text: string) => { writeFileSync(`${repo}/${f}`, text); g(repo, "add", "."); g(repo, "commit", "-qm", text) }
  commit("a.txt", "base\n"); g(repo, "push", "-q", "origin", "HEAD:main")
  for (const [b, f] of [["foreman/1", "a.txt"], ["foreman/2", "b.txt"]]) { g(repo, "checkout", "-qb", b, "main"); commit(f, `${b}\n`); g(repo, "push", "-qu", "origin", b); g(repo, "checkout", "-q", "main") }
  commit("a.txt", "main moved\n"); g(repo, "push", "-q", "origin", "main")
  const calls: string[][] = []
  const rec = (cmd: string, args: string[], cwd?: string) => (calls.push([cmd, ...args]), run(cmd, args, cwd))
  const x = { repo, base: "main", install: "true" }

  assert.equal(await setupWorktree(rec, { ...x, wt: `${root}/wt1`, branch: "foreman/1", conflict: true }), "")
  assert.match(readFileSync(`${root}/wt1/a.txt`, "utf8"), /^<<<<<<< /m)
  assert.equal(g(`${root}/wt1`, "rev-parse", "-q", "--verify", "MERGE_HEAD").status, 0) // in progress: the Builder resolves, git add, git commit
  assert.ok(calls.some((c) => c.join(" ") === "git merge --no-edit origin/main"))
  assert.ok(calls.every((c) => c[0] === "git")) // argument arrays, no shell

  assert.equal(await setupWorktree(rec, { ...x, wt: `${root}/wt2`, branch: "foreman/2", conflict: true }), "") // no conflict: merged and committed
  assert.equal(g(`${root}/wt2`, "merge-base", "--is-ancestor", "origin/main", "HEAD").status, 0)
  // a Resolve-merge-conflicts ticket: Dobby fetches origin/<base> itself, and no merge is started (the Builder does that)
  calls.length = 0
  assert.equal(await setupWorktree(rec, { ...x, wt: `${root}/wt5`, branch: "foreman/20", onto: "foreman/2", fetchBase: true }), "")
  assert.ok(calls.some((c) => c.join(" ") === "git fetch -q origin main"))
  assert.ok(!calls.some((c) => c[1] === "merge"))
  assert.match(await setupWorktree(rec, { ...x, base: "nope", wt: `${root}/wt6`, branch: "foreman/21", onto: "foreman/2", fetchBase: true }), /^git fetch origin nope failed/)
  assert.equal(await setupWorktree(rec, { ...x, wt: `${root}/wt3`, branch: "foreman/9" }), "") // a new ticket: fresh branch from origin/main
  assert.equal(readFileSync(`${root}/wt3/a.txt`, "utf8"), "main moved\n")

  // failures: plain reasons instead of a "Claude did not start" loop
  assert.match(await setupWorktree(rec, { ...x, base: "nope", wt: `${root}/wt4`, branch: "foreman/10" }), /^could not create the worktree on foreman\/10/)
  assert.match(await setupWorktree(rec, { ...x, install: "false", wt: `${root}/wt5`, branch: "foreman/11" }), /^install failed \(false\)/)
  assert.match(await setupWorktree(rec, { ...x, wt: `${root}/wt6`, branch: "foreman/12", onto: "no-such-branch" }), /^can't check out no-such-branch/)
  assert.match(await setupWorktree(() => ({ ok: true, out: "" }), { ...x, wt: `${root}/never`, branch: "foreman/13" }), /worktree .*never is missing/)
})

test("fix push onto a PR branch: the pushed head is reviewed inline; a GitHub head that lags 60 s pings once and skips the review", async () => {
  const db = open(":memory:")
  const view = (head: string) => (cmd: string, args: string[]) =>
    cmd === "git" ? { ok: true, out: "abc1234fff\n" } : { ok: true, out: JSON.stringify({ number: 7, headRefOid: head, url: "https://github.com/ownerdev/tally/pull/7" }) }
  const reviewed: string[] = [], pings: string[] = []
  const review = async (repo: string, n: number) => (reviewed.push(`${repo}#${n}`), { state: "success", why: "pass (haiku, rule)" })
  let polls = 0
  const lagThenOk = (cmd: string, args: string[]) => (cmd === "gh" && polls++ < 2 ? view("old0000")(cmd, args) : view("abc1234fff")(cmd, args))
  const ok = await reviewPushed(db, { run: lagThenOk, repo: "/r", branch: "foreman/9", onto: "foreman/5", ticket: 9, review, ping: (t) => pings.push(t), sleep: async () => {} })
  assert.equal(ok, "review of abc1234: success, pass (haiku, rule)")
  assert.deepEqual([reviewed, pings], [["ownerdev/tally#7"], []])
  const lag = await reviewPushed(db, { run: view("old0000"), repo: "/r", branch: "foreman/9", onto: "foreman/5", ticket: 9, review, ping: (t) => pings.push(t), sleep: async () => {} })
  assert.match(lag, /^review not run: GitHub still shows old0000 .* after 60 s, not the pushed abc1234/)
  assert.equal(reviewed.length, 1)
  assert.equal(pings.length, 1)
})

test("deployProject (stubbed sh): lock, the migrate card bound to its head, nothing-to-deploy apart from Deployed", async () => {
  const { deployProject } = await import("../src/deploy.ts")
  const db = open(":memory:")
  const dep = mkdtempSync(`${tmpdir()}/foreman-deploy-`)
  mkdirSync(`${dep}/mig`)
  writeFileSync(`${dep}/mig/0058_backfill.sql`, "UPDATE txns SET kind = 'upi' WHERE kind IS NULL;\n")
  const projects = { tally: { name: "tally", repo: dep, deploy_dir: dep, deploy: "bun run deploy", migrations: "mig", base: "main", install: "true", verify: "true", priority: 5, jev: false, paused: false, rules: "" } } as any
  const S1 = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", S2 = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  const env = { head: S1, prod: "", migs: "mig/0058_backfill.sql\n", deployOut: "Deployed api.", ran: [] as string[], all: [] as string[], cards: [] as { text: string; data?: string }[] }
  const sh = (cmd: string) => {
    env.all.push(cmd)
    if (cmd === "git rev-parse HEAD") return { ok: true, out: `${env.head}\n` }
    if (cmd.includes("deploy/prod^{commit}")) return { ok: !!env.prod, out: env.prod }
    if (cmd.startsWith("git diff --name-only")) return { ok: true, out: env.migs }
    if (cmd.includes("bun run deploy")) return (env.ran.push(cmd), { ok: true, out: env.deployOut })
    return { ok: true, out: "" } // status clean, pull ok
  }
  const notify = (async (text: string, _f: unknown, buttons?: { data: string }[]) => (env.cards.push({ text, data: buttons?.[0]?.data }), true)) as any
  const go = (o: { migrate?: boolean; at?: string } = {}) => deployProject(db, "tally", { ...o, sh: sh as any, notify, projects })

  // a live lock (this process) queues one more run instead of deploying twice
  db.prepare("INSERT INTO kv VALUES ('deploy:lock:tally', ?)").run(`${Date.now()}:${process.pid}`)
  assert.equal(await go(), "tally: a deploy is running; another one follows it")
  assert.ok(db.prepare("SELECT 1 FROM kv WHERE k='deploy:again:tally'").get())
  db.prepare("DELETE FROM kv").run()

  // a data migration waits; the card's button names the head it showed
  assert.match(await go(), /^tally: waiting for the owner \(data migration mig\/0058_backfill.sql\)$/)
  assert.equal(env.cards.at(-1)!.data, `deploynow tally migrate ${S1}`)
  assert.deepEqual(env.ran, [])
  // main moved before the tap (or an old card without a head): refused, fresh card for the new head
  env.head = S2
  assert.match(await go({ migrate: true, at: S1 }), /the tap was for 1111111, not 2222222: new card sent$/)
  assert.equal(env.cards.at(-1)!.data, `deploynow tally migrate ${S2}`)
  assert.match(await go({ migrate: true }), /new card sent$/)
  assert.deepEqual(env.ran, [])
  // the tap for this head runs the deploy with --migrate
  assert.equal(await go({ migrate: true, at: S2 }), "tally: deployed 2222222")
  assert.deepEqual(env.ran, ["true && bun run deploy --migrate"])
  // ignored build output is cleared before install, and only on a run that deploys
  const { DEPLOY_CLEAN } = await import("../src/deploy.ts")
  assert.equal(env.all.filter((c) => c === DEPLOY_CLEAN).length, 1)
  assert.ok(env.all.indexOf(DEPLOY_CLEAN) < env.all.indexOf("true && bun run deploy --migrate"))
  assert.match(env.cards.at(-1)!.text, /^🚀 Deployed · tally at 2222222\nMigrations run: 0058_backfill.sql/)

  // nothing new: said as such, no "Deployed" card, and the deploy step is not even run when prod is at HEAD
  const cards = env.cards.length
  env.migs = ""; env.deployOut = "Nothing to deploy since 1111111."
  assert.equal(await go(), "tally: nothing to deploy at 2222222 (the deploy step found no app changes)")
  env.prod = S2
  assert.equal(await go(), "tally: nothing to deploy (2222222 is already live)")
  assert.equal(env.ran.length, 2)
  assert.equal(env.cards.length, cards)
  assert.equal(db.prepare("SELECT 1 FROM kv WHERE k='deploy:lock:tally'").get(), undefined)
})

test("deployOnFailure: notify = card only; ticket = one top-priority fix ticket; fix = built at once, then quiet while it is open", async () => {
  const { deployProject } = await import("../src/deploy.ts")
  const db = open(":memory:")
  const dep = mkdtempSync(`${tmpdir()}/foreman-deployfail-`)
  const projects = { tally: { name: "tally", repo: dep, deploy_dir: dep, deploy: "bun run deploy", base: "main", install: "true", verify: "true", priority: 5, jev: false, paused: false, rules: "" } } as any
  const sh = (cmd: string) => cmd === "git rev-parse HEAD" ? { ok: true, out: "3333333cccccccccccccccccccccccccccccccc\n" } : cmd.includes("deploy/prod^{commit}") ? { ok: false, out: "" } : cmd.includes("bun run deploy") ? (good ? { ok: true, out: "Deployed api." } : { ok: false, out: "Mobile doctor FAILED\nerror: 1 check failed" }) : { ok: true, out: "" }
  let good = false
  const cards: string[] = [], started: number[] = [], keys: (string | undefined)[] = []
  const notify = (async (text: string, _f: unknown, _b: unknown, to?: { key?: string }) => (cards.push(text), keys.push(to?.key), true)) as any
  const go = (onFailure: "notify" | "ticket" | "fix") => deployProject(db, "tally", { sh: sh as any, notify, projects, onFailure, startFix: (id) => started.push(id) })
  const tickets = () => db.prepare("SELECT id, title, priority, status FROM tickets").all() as { id: number; title: string; priority: number; status: string }[]

  assert.match(await go("notify"), /^tally: deploy failed: /)
  assert.equal(tickets().length, 0)
  assert.doesNotMatch(cards.at(-1)!, /#\d/)

  assert.match(await go("ticket"), /Fix ticket #1 is first in the queue/)
  assert.deepEqual(tickets().map(({ title, priority, status }) => ({ title, priority, status })), [{ title: "Fix main: the ship step fails", priority: 100, status: "ready" }])
  assert.doesNotMatch(tickets()[0].title, /deploy|production|release|migrat/i)
  assert.deepEqual(started, [])
  // a second failure while #1 is open: no second ticket
  assert.match(await go("ticket"), /Fix #1 is already queued/)
  assert.equal(tickets().length, 1)

  // fix mode: #1 still open, so nothing new and no message
  const n = cards.length
  assert.match(await go("fix"), /fix #1 is on it/)
  assert.equal(cards.length, n)
  // #1 failed: a fresh fix ticket, started now, one message
  db.prepare("UPDATE tickets SET status='failed' WHERE id=1").run()
  assert.match(await go("fix"), /An engineer is fixing it now \(#2\)/)
  assert.deepEqual(started, [2])
  assert.equal(cards.length, n + 1)
  assert.match(cards.at(-1)!, /^🔴 Deploy failed · tally\nFailed \d+ times in a row\. Nothing new is live.*\nAn engineer is fixing it now \(#2\); its merge deploys again\.\ndetails\n> /s)
  assert.ok(keys.every((k) => k === "deploy:tally")) // one card per project, edited by later failures

  // a good deploy settles the card quietly (no buttons), resets the count, and the next failure is a new card
  db.prepare("INSERT INTO kv VALUES ('discord:wh:needs-you', 'id/token'), ('discord:msg:deploy:tally', 'm1'), ('discord:msg:deploy:tally:head', 'x')").run()
  const calls: { url: string; method?: string; body: any }[] = []
  const fetcher = (async (url: string, init?: RequestInit) => (calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) }), new Response("{}"))) as unknown as typeof fetch
  good = true
  assert.equal(await deployProject(db, "tally", { sh: sh as any, notify, projects, fetcher }), "tally: deployed 3333333")
  assert.equal(calls[0].method, "PATCH")
  assert.match(calls[0].body.content, /^✅ Deploy fixed · tally/)
  assert.deepEqual(calls[0].body.components, [])
  assert.equal((db.prepare("SELECT COUNT(*) n FROM kv WHERE k LIKE 'deploy:fails:%' OR k LIKE 'discord:msg:deploy:%'").get() as { n: number }).n, 0)
})

test("DEPLOY_CLEAN (real git): removes ignored build output, keeps node_modules, .env* and tracked files", async () => {
  const { DEPLOY_CLEAN } = await import("../src/deploy.ts")
  const d = mkdtempSync(`${tmpdir()}/foreman-clean-`)
  const git = (...a: string[]) => spawnSync("git", a, { cwd: d })
  git("init", "-q")
  writeFileSync(`${d}/.gitignore`, "node_modules\n.env*\n.expo\n")
  writeFileSync(`${d}/tracked.ts`, "")
  git("add", "-A")
  for (const f of ["node_modules/a", "apps/mobile/.expo"]) mkdirSync(`${d}/${f}`, { recursive: true })
  for (const f of ["node_modules/a/i.js", ".env.local", "apps/mobile/.expo/types.d.ts"]) writeFileSync(`${d}/${f}`, "")
  const r = spawnSync("sh", ["-c", DEPLOY_CLEAN], { cwd: d })
  assert.equal(r.status, 0)
  assert.ok(!existsSync(`${d}/apps/mobile/.expo`))
  for (const f of ["node_modules/a/i.js", ".env.local", "tracked.ts"]) assert.ok(existsSync(`${d}/${f}`), f)
})

test("verify refuses an unfinished merge or committed conflict markers (test files may hold them); install is retried once", async () => {
  const { conflictLeft, markerFiles } = await import("../src/graphs/ticket.ts")
  const add = (file: string, ...lines: string[]) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`
  assert.deepEqual(markerFiles(add("src/a.ts", "<<<<<<< HEAD", "x", "=======", "y", ">>>>>>> origin/main") + add("tests/merge.test.ts", "<<<<<<< ours") + add("README.md", "Title", "=======")), ["src/a.ts"])
  const root = mkdtempSync(`${tmpdir()}/foreman-verify-`)
  const g = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" })
  g(root, "init", "-q", "--bare", "-b", "main", "origin.git"); g(root, "clone", "-q", `${root}/origin.git`, "repo")
  const repo = `${root}/repo`
  g(repo, "config", "user.name", "t"); g(repo, "config", "user.email", "t@t")
  writeFileSync(`${repo}/a.txt`, "base\n"); g(repo, "add", "."); g(repo, "commit", "-qm", "base"); g(repo, "push", "-q", "origin", "HEAD:main")
  g(repo, "checkout", "-qb", "foreman/1"); writeFileSync(`${repo}/a.txt`, "mine\n"); g(repo, "commit", "-qam", "mine"); g(repo, "checkout", "-q", "main")
  writeFileSync(`${repo}/a.txt`, "theirs\n"); g(repo, "commit", "-qam", "theirs"); g(repo, "push", "-q", "origin", "main")
  const wt = `${root}/wt`
  let installs = 0
  assert.equal(await setupWorktree(run, { repo, wt, branch: "foreman/1", base: "main", install: "x", conflict: true }, () => ({ ok: installs++ > 0, out: "" })), "")
  assert.equal(installs, 2) // the first install failed, the retry passed
  assert.match(conflictLeft(run, wt, "main"), /^The merge with origin\/main is not finished: resolve the conflicts in a\.txt/)
  g(wt, "add", "-A"); g(wt, "commit", "-qm", "merge, markers and all")
  assert.match(conflictLeft(run, wt, "main"), /^Conflict markers .* still in a\.txt/)
  writeFileSync(`${wt}/a.txt`, "resolved\n"); g(wt, "commit", "-qam", "resolve")
  assert.equal(conflictLeft(run, wt, "main"), "")
  // the rebase refuses a branch that moved since the review
  g(repo, "push", "-q", "origin", "foreman/1")
  const moved = await rebaseAndPush(run, repo, `${root}/rb`, "foreman/1", "main", () => assert.fail("no verify"), "0000000000000000000000000000000000000000")
  assert.match(moved.out, /foreman\/1 moved since the review/)
})

test("deployFrom worktree: a fresh worktree of origin/main with the .env files, removed after a good and after a failed deploy", async () => {
  const { deployProject } = await import("../src/deploy.ts")
  const db = open(":memory:")
  const root = mkdtempSync(`${tmpdir()}/foreman-deploywt-`)
  const g = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" })
  g(root, "init", "-q", "--bare", "-b", "main", "origin.git")
  g(root, "clone", "-q", "origin.git", "repo")
  const repo = `${root}/repo`
  writeFileSync(`${repo}/.gitignore`, ".env*\n")
  writeFileSync(`${repo}/app.txt`, "v1\n")
  g(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", ".")
  g(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "v1")
  g(repo, "push", "-q", "origin", "HEAD:main")
  writeFileSync(`${repo}/app.txt`, "local edit, not committed\n") // a dirty clone is no reason to refuse: the worktree is fresh
  writeFileSync(`${repo}/.env.production`, "X=1\n")
  const out = `${root}/deployed`
  const project = (deploy: string) => ({ tally: { name: "tally", repo, deploy, base: "main", install: "true", verify: "true", priority: 5, jev: false, paused: false, rules: "" } }) as any
  const notify = (async () => true) as any
  const worktrees = () => g(repo, "worktree", "list", "--porcelain").stdout.split("\n").filter((l) => l.startsWith("worktree ")).length

  const good = `test -f .env.production && cp app.txt '${out}'`
  assert.equal(await deployProject(db, "tally", { from: "worktree", notify, projects: project(good) }), `tally: deployed ${g(repo, "rev-parse", "--short=7", "origin/main").stdout.trim()}`)
  assert.equal(readFileSync(out, "utf8"), "v1\n") // origin/main's file, not the dirty clone's
  assert.equal(worktrees(), 1)

  assert.match(await deployProject(db, "tally", { from: "worktree", notify, projects: project("echo 'error: build failed'; false") }), /^tally: deploy failed: /)
  assert.equal(worktrees(), 1)

  // deploy_copy: other gitignored files come along; one that is missing fails in plain words, and the worktree still goes
  mkdirSync(`${repo}/apps/mobile`, { recursive: true })
  writeFileSync(`${repo}/apps/mobile/google-services.json`, "{}\n")
  const copied = (deploy_copy: string[]) => ({ tally: { ...project(`test -f apps/mobile/google-services.json && cp app.txt '${out}'`).tally, deploy_copy } })
  db.prepare("DELETE FROM kv").run()
  assert.match(await deployProject(db, "tally", { from: "worktree", notify, projects: copied(["apps/mobile/google-services.json"]) }), /^tally: deployed /)
  assert.match(await deployProject(db, "tally", { from: "worktree", notify, projects: copied(["apps/mobile/missing.json"]) }), /apps\/mobile\/missing.json is listed in deploy_copy but is not in /)
  assert.equal(worktrees(), 1)
  assert.deepEqual(existsSync(`${dir}/deploy-wt`) ? readdirSync(`${dir}/deploy-wt`) : [], [])
})

// `dobby cancel`, decline on a non-gate ticket, the ship guard and the pushOnto lease. Offline: temp data dir, fake Run and kill, no real gh.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-cancel-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/s.txt` // missing: nothing can reach Discord or GitHub
process.env.DOBBY_CONFIG = `${dir}/config.json` // points paths.projects at the temp clones, not ~/projects
process.env.JEV_API_KEY = ""
mkdirSync(`${dir}/projects/tally`, { recursive: true })
writeFileSync(`${dir}/config.json`, JSON.stringify({ paths: { projects: `${dir}/projects` } }))
writeFileSync(`${dir}/projects/tally/dobby.md`, "---\nbase: main\n---\n## Goals\n- Ship")
const { open, DATA } = await import("../src/db.ts")
const { addTicket, getTicket, setTicket } = await import("../src/lib.ts")
const { cancelTicket } = await import("../src/stuck.ts")

const db = open()
const projects = { tally: { repo: "/repo/tally" } } as never
const PR = "https://github.com/o/tally/pull/7"
let prAt = "2999-01-01T00:00:00Z" // createdAt that `gh pr view <branch>` answers
const fake = () => {
  const calls: string[] = [], killed: number[] = []
  return { calls, killed, d: { r: (c: string, a: string[], cwd?: string) => (calls.push(`${c} ${a.join(" ")}${cwd ? ` @${cwd}` : ""}`), { ok: true, out: a[1] === "view" ? prAt : "" }), kill: (g: number) => void killed.push(g), projects } }
}
const mk = (title: string, patch: Record<string, string> = {}, onto?: string) => {
  const { id } = addTicket(db, { project: "tally", title })
  setTicket(db, id, { status: "running", ...patch })
  if (onto) db.prepare("UPDATE tickets SET onto=? WHERE id=?").run(onto, id)
  return id
}
const kvHas = (k: string) => !!db.prepare("SELECT 1 FROM kv WHERE k=?").get(k)
const kvSet = (k: string) => db.prepare("INSERT OR REPLACE INTO kv VALUES (?, '1')").run(k)

test("cancel a running ticket: declined, only its own process groups get SIGTERM, worktree removed, PR closed with its branch", () => {
  const id = mk("Build the thing", { note: `PR\n${PR}` })
  const other = mk("Another build")
  kvSet(`build:${id}`) // a build of it is running
  kvSet(`pgid:${id}:4242`); kvSet(`pgid:${id}:4243`); kvSet(`pgid:${other}:5555`); kvSet("automerge:o/tally#7")
  const f = fake()
  assert.equal(cancelTicket(db, id, f.d), "Cancelled: Build the thing. Build stopped, worktree removed, PR closed.")
  assert.deepEqual(f.killed.sort(), [4242, 4243])
  assert.ok(f.calls.includes(`git worktree remove --force ${DATA}/wt/tally-${id} @/repo/tally`), f.calls.join("\n"))
  assert.ok(f.calls.includes(`gh pr close ${PR} --delete-branch @/repo/tally`), f.calls.join("\n"))
  assert.equal(getTicket(db, id)?.status, "declined")
  assert.equal(getTicket(db, id)?.note, "cancelled by the owner")
  assert.equal(getTicket(db, other)?.status, "running")
  assert.ok(kvHas(`pgid:${other}:5555`) && !kvHas(`pgid:${id}:4242`) && !kvHas("automerge:o/tally#7") && kvHas(`cancel:${id}`))
  setTicket(db, id, { status: "failed" })
  assert.equal(getTicket(db, id)?.status, "declined")
  db.prepare("DELETE FROM kv WHERE k=?").run(`build:${id}`) // build over: the owner can revive it later
  setTicket(db, id, { status: "ready" })
  assert.equal(getTicket(db, id)?.status, "ready")
})

test("cancel a fix ticket: the PR it was fixing stays open", () => {
  const id = mk("Fix the footer", { note: PR }, "fix/footer")
  const f = fake()
  assert.match(cancelTicket(db, id, f.d), /^Cancelled: Fix the footer\./)
  assert.ok(!f.calls.some((c) => c.startsWith("gh ")), f.calls.join("\n"))
  assert.equal(getTicket(db, id)?.status, "declined")
})

test("cancel shipped / unknown: a plain line, nothing run", () => {
  const id = mk("Done already")
  setTicket(db, id, { status: "shipped" })
  const f = fake()
  assert.equal(cancelTicket(db, id, f.d), `#${id} is already shipped.`)
  assert.equal(cancelTicket(db, 99999, f.d), "no ticket #99999")
  assert.equal(f.calls.length, 0)
})

test("ship guard: a ticket cancelled mid-build pushes nothing", async () => {
  const { compileTicketGraph, thread, Command } = await import("../src/graphs/ticket.ts")
  const id = mk("Cancelled mid build", {}, "fix/none")
  cancelTicket(db, id, fake().d)
  const out = await compileTicketGraph(db).invoke(new Command({ goto: "ship", update: { ticketId: id, branch: "dobby/x", wt: "/nope", ontoSha: "abc", verdict: { pass: true, reason: "ok" } } }), thread(id))
  assert.equal(out.outcome, "cancelled") // not "failed: push": the push was never tried
  assert.equal(getTicket(db, id)?.status, "declined")
})

test("pushOnto leases on the sha; a branch deleted after prepare makes the push fail and stays deleted", async () => {
  const { prepareOnto, pushOnto } = await import("../src/graphs/ticket.ts")
  const { run } = await import("../src/graphs/review.ts")
  const root = mkdtempSync(`${tmpdir()}/foreman-lease-`)
  const g = (cwd: string, ...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" })
  g(root, "init", "-q", "--bare", "-b", "main", "origin.git"); g(root, "clone", "-q", `${root}/origin.git`, "repo")
  const repo = `${root}/repo`
  writeFileSync(`${repo}/a.txt`, "base\n"); g(repo, "add", "."); g(repo, "commit", "-qm", "base"); g(repo, "push", "-q", "origin", "HEAD:main")
  g(repo, "checkout", "-qb", "fix/footer"); writeFileSync(`${repo}/a.txt`, "pr\n"); g(repo, "commit", "-qam", "pr"); g(repo, "push", "-q", "origin", "fix/footer"); g(repo, "checkout", "-q", "main")
  const sha = prepareOnto(run, repo, `${root}/wt`, "dobby/1", "fix/footer")
  assert.match(sha, /^[0-9a-f]{40}$/)
  writeFileSync(`${root}/wt/a.txt`, "fixed\n"); g(`${root}/wt`, "commit", "-qam", "fix")
  const seen: string[][] = []
  const rec = (c: string, a: string[], cwd?: string) => (seen.push(a), run(c, a, cwd))
  g(root, "--git-dir", `${root}/origin.git`, "branch", "-D", "fix/footer") // the PR was closed: its branch is deleted
  assert.equal(pushOnto(rec, repo, "dobby/1", "fix/footer", sha).ok, false)
  assert.ok(seen[0].includes(`--force-with-lease=refs/heads/fix/footer:${sha}`))
  assert.equal(g(root, "--git-dir", `${root}/origin.git`, "branch", "--list", "fix/footer").stdout.trim(), "")
})

test("decline on a non-gate ticket cancels, approve prints the line; both exit 0", () => {
  const id = mk("Plain ticket", {}, "foreman/none") // onto: cancel makes no gh call
  const dobby = (...a: string[]) => spawnSync(new URL("../bin/dobby", import.meta.url).pathname, a, { encoding: "utf8", env: process.env })
  const ap = dobby("approve", String(id))
  assert.equal(ap.status, 0, ap.stderr)
  assert.match(ap.stdout, /Nothing waits for approval on Plain ticket; merges are approved on its PR card\./)
  assert.equal(getTicket(db, id)?.status, "running")
  const de = dobby("decline", String(id))
  assert.equal(de.status, 0, de.stderr)
  assert.match(de.stdout, /Cancelled: Plain ticket\./)
  assert.equal(getTicket(db, id)?.status, "declined")
  const cn = dobby("cancel", "9999")
  assert.equal(cn.status, 1)
  assert.match(cn.stderr, /no ticket #9999/)
})

test("runAsync inside a ticket's scope records the child's group in kv while it runs, and forgets it after", async () => {
  const { runAsync, ticketScope } = await import("../src/lib.ts")
  const during: string[] = []
  await ticketScope.run({ db, id: 4321 }, async () => {
    const p = runAsync("sleep", ["0.3"])
    await new Promise((r) => setTimeout(r, 100))
    during.push(...(db.prepare("SELECT k FROM kv WHERE k LIKE 'pgid:4321:%'").all() as { k: string }[]).map((x) => x.k))
    await p
  })
  assert.equal(during.length, 1)
  assert.equal((db.prepare("SELECT count(*) n FROM kv WHERE k LIKE 'pgid:4321:%'").get() as { n: number }).n, 0)
})

test("cancel closes an open PR that is not in the note, by branch, run inside the project repo", () => {
  const id = mk("PR opened by an earlier ship", { branch: "dobby/900", status: "ready" })
  const f = fake()
  assert.match(cancelTicket(db, id, f.d), /PR closed/)
  assert.ok(f.calls.includes("gh pr close dobby/900 --delete-branch @/repo/tally"), f.calls.join("\n"))
})

test("cancel leaves an older PR on the same branch alone (a fresh database reuses ticket ids)", () => {
  const id = mk("Same id as an old install's ticket", { branch: "dobby/901", status: "ready" })
  prAt = "2000-01-01T00:00:00Z"
  const f = fake()
  assert.doesNotMatch(cancelTicket(db, id, f.d), /PR closed/)
  assert.ok(!f.calls.some((c) => c.startsWith("gh pr close")), f.calls.join("\n"))
  prAt = "2999-01-01T00:00:00Z"
})

test("cancelled during prepare or before a build: no build runs, ticket stays declined", async () => {
  const { compileTicketGraph, thread, Command } = await import("../src/graphs/ticket.ts")
  const id = mk("Cancelled while preparing")
  setTicket(db, id, { branch: `dobby/${id}` })
  cancelTicket(db, id, fake().d)
  const out = await compileTicketGraph(db).invoke(new Command({ goto: "build", update: { ticketId: id, branch: `dobby/${id}`, wt: "/nope" } }), thread(id))
  assert.equal(out.outcome, "cancelled")
  assert.equal(getTicket(db, id)?.status, "declined")
})

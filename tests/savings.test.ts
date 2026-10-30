// Token savings: every piece is off by default and switched on by config. Offline: temp dirs, :memory: db, fake runners.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-savings-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/s.txt`
writeFileSync(process.env.DOBBY_SECRETS, "")
process.env.JEV_API_KEY = ""
const { open, logRun } = await import("../src/db.ts")
const { config, defaults, setConfig, loadConfig } = await import("../src/config.ts")
const L = await import("../src/lib.ts")
const S = await import("../src/savings.ts")
const lead = await import("../src/graphs/lead.ts")
const view = await import("../src/view.ts")
const { handoffText } = await import("../src/graphs/ticket.ts")
const { spawnSync } = await import("node:child_process")
const on = (c: Partial<ReturnType<typeof defaults>>) => setConfig({ ...defaults(), ...c })

const ticket = (db: ReturnType<typeof open>, size = "S", status = "ready") => {
  const { id } = L.addTicket(db, { project: "tally", title: `Ticket ${Math.random()}`, size })
  db.prepare("UPDATE tickets SET status=? WHERE id=?").run(status, id)
  return id
}

test("everything is off by default", () => {
  setConfig(defaults())
  const db = open(":memory:")
  const id = ticket(db)
  logRun(db, { project: "tally", kind: "build", ticket: id, ok: true, cost_usd: 500 })
  assert.equal(S.overBudget(db, { id, size: "S" }), "")
  assert.equal(config().retryLimit, undefined)
  assert.equal(config().builderContextCeiling, undefined)
  assert.equal(config().shipPreflight, undefined)
})

test("config accepts the new keys and rejects bad ones", () => {
  const f = `${dir}/c.json`
  writeFileSync(f, JSON.stringify({ ticketBudget: { S: 0.2, M: 0.5, L: 1 }, retryLimit: 2, builderContextCeiling: 150000, shipPreflight: true, sameFailure: true, harnessInstall: true, freshRetries: true, recoverOutput: true }))
  const l = loadConfig({ private: f, repo: `${dir}/none.json` })
  assert.deepEqual(l.warnings, [])
  assert.equal(l.config.retryLimit, 2)
  writeFileSync(f, JSON.stringify({ retryLimit: 0 }))
  assert.match(loadConfig({ private: f, repo: `${dir}/none.json` }).warnings[0], /retryLimit: got 0; allowed: at least 1/)
})

test("ticket budget: cap by size in week points, counted from the last hand re-queue", () => {
  on({ ticketBudget: { S: 0.2, M: 0.5, L: 1, usdPerWeekPoint: 10 } })
  const db = open(":memory:")
  const s = ticket(db, "S"), m = ticket(db, "M")
  logRun(db, { project: "tally", kind: "build", ticket: s, ok: true, cost_usd: 1.5 })
  logRun(db, { project: "tally", kind: "build", ticket: m, ok: true, cost_usd: 1.5 })
  assert.equal(S.overBudget(db, { id: s, size: "S" }), "")
  logRun(db, { project: "tally", kind: "check", ticket: s, ok: true, cost_usd: 0.6 })
  assert.match(S.overBudget(db, { id: s, size: "S" }), /0\.21% of the week .* capped at 0\.2%/)
  assert.equal(S.overBudget(db, { id: m, size: "M" }), "", "the same spend is under an M cap")
  db.prepare("UPDATE tickets SET status='failed', note='x' WHERE id=?").run(s)
  assert.match(L.queueTicket(db, s), /queued/)
  assert.equal(S.overBudget(db, { id: s, size: "S" }), "", "a hand re-queue starts a fresh count")
  assert.deepEqual(S.costliest(db).map((r) => r.id), [m], "the board lists what each open ticket cost since its base")
  assert.match(view.costLine(db)[0], /0\.15% of the week/)
})

test("a run's usage is summed from its transcript, once per API message", () => {
  const d = mkdtempSync(`${tmpdir()}/foreman-ru-`)
  const msg = (id: string, ts: string, u: object) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model: "claude-sonnet-4-5", usage: u } })
  const since = Date.now() - 5000
  const at = (ms: number) => new Date(since + ms).toISOString()
  const full = { input_tokens: 10, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 100, output_tokens: 50 }
  writeFileSync(`${d}/cur.jsonl`, [
    msg("m0", at(-3_600_000), { input_tokens: 999, output_tokens: 999 }), // before this run (resumed session)
    msg("m1", at(1000), full),
    msg("m1", at(1000), full), // second content block of the same message
    "not json",
  ].join("\n") + "\n")
  const run = S.runUsage(d, since)
  assert.deepEqual([run.input_tokens, run.output_tokens, run.cache_read, run.cache_write], [10, 50, 1_000_000, 100])
  assert.ok(run.cost_usd > 0.3 && run.cost_usd < 0.5, `${run.cost_usd}`) // 1M cache-read at $0.30 plus a few cents
  assert.equal(S.runUsage(`${d}/missing`, since).cost_usd, 0)
})

test("same cause: different wording and numbers, same words", () => {
  assert.ok(S.sameCause("bun.lock has no expo-speech entry, so bun install --frozen-lockfile fails", "The lockfile bun.lock still has no expo-speech entry; bun install --frozen-lockfile fails (line 12)"))
  assert.ok(!S.sameCause("bun.lock has no expo-speech entry", "the settings screen never renders the new toggle"))
  assert.ok(!S.sameCause("", "anything"))
})

test("context ceiling reads the newest transcript of this run; recovery reads the last words", () => {
  const d = mkdtempSync(`${tmpdir()}/foreman-tr-`)
  const line = (o: unknown) => JSON.stringify(o)
  const old = `${d}/old.jsonl`, cur = `${d}/cur.jsonl`
  writeFileSync(old, line({ type: "assistant", message: { usage: { input_tokens: 2, cache_read_input_tokens: 399000 } } }) + "\n")
  const past = new Date(Date.now() - 3_600_000); utimesSync(old, past, past)
  const since = Date.now() - 5000
  assert.equal(S.contextTokens(d, since), 0, "a transcript older than the run is not this run")
  writeFileSync(cur, [line({ type: "assistant", message: { usage: { input_tokens: 2, cache_read_input_tokens: 100000, cache_creation_input_tokens: 900 }, content: [{ type: "text", text: "first" }] } }),
    "not json", line({ type: "assistant", message: { usage: { input_tokens: 3, cache_read_input_tokens: 150000, cache_creation_input_tokens: 1000 }, content: [{ type: "text", text: "All done, committed." }] } })].join("\n") + "\n")
  assert.equal(S.contextTokens(d, since), 151003)
  assert.deepEqual(S.lastAssistantText(d, since), { text: "All done, committed.", session: "cur" })
  assert.equal(S.contextTokens(`${d}/missing`, since), 0)
  assert.match(S.transcriptDir("/tmp/a.b/c"), /-tmp-a-b-c$/)
})

test("handoff commits work in progress and lists done and mid-change files", async () => {
  const root = mkdtempSync(`${tmpdir()}/foreman-ho-`)
  const g = (...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: root, encoding: "utf8" })
  g("init", "-q", "-b", "main"); writeFileSync(`${root}/a.txt`, "a"); g("add", "."); g("commit", "-qm", "base")
  g("update-ref", "refs/remotes/origin/main", "HEAD")
  writeFileSync(`${root}/b.txt`, "b"); g("add", "."); g("commit", "-qm", "step one")
  writeFileSync(`${root}/c.txt`, "half")
  const h = await handoffText(root, "main")
  assert.match(h, /step one/); assert.match(h, /MID-CHANGE.*c\.txt/)
  assert.equal(g("status", "--porcelain").stdout, "", "mid-change files are committed")
})

test("ship pre-flight names the first thing shipping needs", async () => {
  const ok = async () => ({ ok: true, out: "ownerdev/x WRITE" })
  const o = { wt: "/w", branch: "foreman/1", verify: "true" }
  assert.equal(await S.shipPreflight(ok, o), "")
  const fail = (match: string, out: string) => async (c: string, a: string[]) => ({ ok: ![c, ...a].join(" ").includes(match), out: out || "ownerdev/x WRITE" })
  assert.match(await S.shipPreflight(fail("auth status", "not logged in"), o), /gh is not signed in/)
  assert.match(await S.shipPreflight(fail("remote get-url", ""), o), /no git remote/)
  assert.match(await S.shipPreflight(fail("repo view", "Could not resolve"), o), /does not know this repo/)
  assert.match(await S.shipPreflight(async (_c, a) => ({ ok: true, out: a[0] === "repo" ? "ownerdev/x READ" : "" }), o), /no write access/)
  assert.match(await S.shipPreflight(fail("push --dry-run", "denied"), o), /would be refused/)
  assert.equal(await S.shipPreflight(fail("push --dry-run", "denied"), { ...o, onto: "pr-branch" }), "", "a fix on an open PR is not pushed to a new branch")
  assert.match(await S.shipPreflight(fail("command -v", ""), { ...o, verify: "PY=x ./build.sh arg" }), /\.\/build\.sh was not found/)
})

test("manifest changes are detected", () => {
  assert.ok(S.touchesManifest(["src/a.ts", "apps/mobile/package.json"]))
  assert.ok(!S.touchesManifest(["src/package.json.ts", "bun.lock"]))
})

test("builds that stopped at the context ceiling do not count as builds", () => {
  const db = open(":memory:")
  const id = ticket(db)
  logRun(db, { project: "tally", kind: "build", ticket: id, ok: false, reason: `${S.CEILING}: 160000 tokens` })
  logRun(db, { project: "tally", kind: "build", ticket: id, ok: true })
  assert.equal(L.buildsUsed(db, id), 1)
})

test("auto_promote: off keeps the Lead away from a project", async () => {
  const home = process.env.HOME
  process.env.HOME = mkdtempSync(`${tmpdir()}/foreman-aphome-`)
  try {
    for (const [n, fm] of [["hobby", "auto_promote: off\n"], ["real", ""]]) {
      mkdirSync(`${process.env.HOME}/projects/${n}`, { recursive: true })
      writeFileSync(`${process.env.HOME}/projects/${n}/dobby.md`, `---\nbase: main\n${fm}---\n## Goals\n- Ship`)
    }
    setConfig(undefined)
    const ps = L.loadProjects()
    assert.equal(ps.hobby.autoPromote, false); assert.equal(ps.real.autoPromote, true)
    const db = open(":memory:")
    const t = L.addTicket(db, { project: "hobby", title: "Tidy the readme" }).id
    db.prepare("UPDATE tickets SET status='backlog' WHERE id=?").run(t)
    assert.deepEqual(lead.leadDue(db, ps, Date.now() + 1e9).map((p) => p.name).filter((n) => n === "real" || n === "hobby"), ["real"])
    const a = lead.applyPlan(db, "hobby", { promote: [t], new: [], note: "" })
    assert.deepEqual(a.promoted, []); assert.match(a.skipped[0], /auto_promote: off/)
    assert.deepEqual(lead.fallbackPromote(db, "hobby").promoted, [])
    await assert.rejects(lead.runLead(db, "hobby"), /auto_promote: off/)
    assert.equal((db.prepare("SELECT status FROM tickets WHERE id=?").get(t) as { status: string }).status, "backlog")
  } finally { process.env.HOME = home }
})

import { repoSlug, repoArgs } from "../src/lib.ts"
test("repoSlug parses ssh and https origins", () => {
  assert.equal(repoSlug("git@github.com:ownerdev/sidequest.git\n"), "ownerdev/sidequest")
  assert.equal(repoSlug("https://github.com/ownerdev/sidequest"), "ownerdev/sidequest")
  assert.equal(repoSlug("https://github.com/a/b.c.git/"), "a/b.c")
  assert.equal(repoSlug("https://example.com/a/b"), null)
})
test("repoArgs is empty when origin is unknown", () => {
  assert.deepEqual(repoArgs("/x", () => ({ ok: false, out: "" })), [])
  assert.deepEqual(repoArgs("/x", () => ({ ok: true, out: "git@github.com:o/r.git" })), ["--repo", "o/r"])
})

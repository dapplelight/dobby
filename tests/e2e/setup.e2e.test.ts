// `dobby init --yes`: the one-command setup, against a throwaway repo and the fake gh and claude. Nothing is installed: --no-jobs, and --yes
// never runs an install command. HOME, config, data and secrets are all temp dirs.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { test } from "node:test"
import { world, type World } from "./harness.ts"

/** A world with a fresh config (none yet), and a `ledger` repo with a Makefile test target and a GitHub origin URL, in <root>/repos. */
function fresh() {
  const w = world({ env: { DOBBY_PROJECTS: "{root}/drafts", GIT_ALLOW_PROTOCOL: "file" /* verify fetches origin: refuse https, no network */ } })
  rmSync(`${w.root}/config.json`)
  const repos = `${w.root}/repos`, ledger = `${repos}/ledger`
  mkdirSync(ledger, { recursive: true })
  w.git(ledger, "init", "-q", "-b", "main")
  writeFileSync(`${ledger}/Makefile`, "test:\n\t@echo all good\n")
  w.git(ledger, "add", "-A"); w.git(ledger, "commit", "-qm", "Ledger")
  w.git(ledger, "remote", "add", "origin", "https://github.com/acme/ledger.git")
  return { w, repos, ledger }
}
const init = (w: World, repos: string, ...more: string[]) => w.dobby("init", "--yes", "--no-jobs", "--projects", repos, ...more)

test("init --yes: checks, finds the repo, proves its test command, saves settings, drafts the project, pauses merges", () => {
  const { w, repos } = fresh()
  try {
    const r = init(w, repos)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /✓ GitHub sign-in: signed in as acme/)
    assert.match(r.out, /Found 1 repo in .*repos with a GitHub remote/)
    assert.match(r.out, /✓ ledger: install \d+s, test \d+s · all good/)
    assert.match(r.out, /Settings saved in/)
    assert.match(r.out, /Merges are paused until you run: dobby resume merges/)
    const saved = JSON.parse(readFileSync(`${w.root}/config.json`, "utf8"))
    assert.equal(saved.github.owner, "acme")
    assert.deepEqual(saved.github.accounts, ["acme"])
    assert.deepEqual(saved.safety, { preset: "balanced", deploy: "ask" })
    assert.equal(saved.pacing.weekCap, 95)
    assert.equal(saved.paths.projects, repos)
    const draft = readFileSync(`${w.root}/drafts/ledger.md`, "utf8")
    assert.match(draft, /^---\nrepo: ~?.*ledger\npriority: 5\nbase: main\ninstall: true\nverify: make test\n---/)
    assert.match(w.dobby("pause", "status").out, /merges by setup since/, "the first merge always waits for the owner")
  } finally { w.clean() }
})

test("init --yes leaves crash reports and usage stats off", () => {
  const { w, repos } = fresh()
  try {
    const r = init(w, repos)
    assert.equal(r.code, 0, r.out)
    const saved = JSON.parse(readFileSync(`${w.root}/config.json`, "utf8"))
    assert.notEqual(saved.stats?.crashes, true); assert.notEqual(saved.stats?.usage, true)
    assert.equal(existsSync(`${w.root}/data/stats`), false, "nothing was written for stats")
    assert.match(w.dobby("stats").out, /Crash reports: off\nUsage stats: off/)
  } finally { w.clean() }
})

test("init again: what is set is kept, nothing is paused a second time", () => {
  const { w, repos } = fresh()
  try {
    init(w, repos)
    const saved = JSON.parse(readFileSync(`${w.root}/config.json`, "utf8"))
    saved.pacing.weekCap = 60 // the owner changed it
    writeFileSync(`${w.root}/config.json`, JSON.stringify(saved))
    const again = init(w, repos)
    assert.equal(again.code, 0, again.out)
    assert.match(again.out, /\(your existing values kept\)/)
    assert.doesNotMatch(again.out, /Merges are paused until/)
    assert.equal(JSON.parse(readFileSync(`${w.root}/config.json`, "utf8")).pacing.weekCap, 60)
    assert.equal((w.dobby("pause", "status").out.match(/merges by setup/g) ?? []).length, 1)
  } finally { w.clean() }
})

test("init: GitHub signed out blocks setup with the fix; no repos and no terminal are said in one line", () => {
  const { w, repos } = fresh()
  try {
    const out = w.dobbyEnv({ DOBBY_FAKE_GH_SIGNEDOUT: "1" }, "init", "--yes", "--no-jobs", "--projects", repos)
    assert.equal(out.code, 1)
    assert.match(out.out, /✗ GitHub sign-in:/)
    assert.match(out.out, /Fix these, then run dobby init again:\n {2}GitHub sign-in: gh auth login --web/)
    assert.ok(!existsSync(`${w.root}/config.json`), "nothing is saved while a required check fails")
    mkdirSync(`${w.root}/empty`)
    const none = w.dobby("init", "--yes", "--no-jobs", "--projects", `${w.root}/empty`)
    assert.equal(none.code, 1)
    assert.match(none.out, /No git repos with a GitHub remote in .*empty\. Run dobby init --projects <folder>\./)
    const noTty = w.dobby("init")
    assert.equal(noTty.code, 1)
    assert.match(noTty.out, /^No terminal to ask in\. Run: dobby init --yes/m)
  } finally { w.clean() }
})

test("init: a repo whose test command fails is left out, with the command to fix", () => {
  const { w, repos, ledger } = fresh()
  try {
    writeFileSync(`${ledger}/Makefile`, "test:\n\t@echo 2 tests failed; exit 1\n")
    w.git(ledger, "commit", "-qam", "break") // verify runs on the committed base, not the working copy
    const r = init(w, repos)
    assert.match(r.out, /✗ ledger: test failed \(\d+s\)/)
    assert.match(r.out, /2 tests failed[\s\S]*Error 1/)
    assert.match(r.out, /Full output: .*dobby-verify-ledger-test\.log/)
    assert.match(r.out, /ledger is left out until `make test` passes on main/)
    assert.ok(!existsSync(`${w.root}/drafts/ledger.md`), "no draft for a repo that does not pass")
  } finally { w.clean() }
})

test("init: when no repo passes, setup stops there and says no project is ready (nothing saved, exit 1)", () => {
  const { w, repos, ledger } = fresh()
  try {
    writeFileSync(`${ledger}/Makefile`, "test:\n\t@echo 2 tests failed; exit 1\n")
    w.git(ledger, "commit", "-qam", "break") // verify runs on the committed base
    const r = init(w, repos)
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /No project is ready, so setup stops here\./)
    assert.match(r.out, /dobby init --yes never adds a repo that fails\. Run dobby init without --yes to add one anyway or set its test command/)
    assert.doesNotMatch(r.out, /Settings saved|Merges are paused/)
    assert.ok(!existsSync(`${w.root}/config.json`))
  } finally { w.clean() }
})

test("init --projects a,b and --projects a --projects b look in both folders; a repo named like a domain is kept", () => {
  const { w, repos } = fresh()
  try {
    const other = `${w.root}/more`, site = `${other}/example.com`
    mkdirSync(site, { recursive: true })
    w.git(site, "init", "-q", "-b", "main"); writeFileSync(`${site}/Makefile`, "test:\n\t@echo ok\n")
    w.git(site, "add", "-A"); w.git(site, "commit", "-qm", "Site"); w.git(site, "remote", "add", "origin", "https://github.com/acme/example.com.git")
    for (const args of [["--projects", `${repos},${other}`], ["--projects", repos, "--projects", other]]) {
      rmSync(`${w.root}/config.json`, { force: true })
      const r = w.dobby("init", "--yes", "--no-jobs", ...args)
      assert.equal(r.code, 0, r.out)
      assert.match(r.out, /Found 2 repos in /)
      assert.ok(existsSync(`${w.root}/drafts/example.com.md`) && existsSync(`${w.root}/drafts/ledger.md`))
      const saved = JSON.parse(readFileSync(`${w.root}/config.json`, "utf8"))
      assert.equal(saved.paths.projects, repos); assert.deepEqual(saved.paths.projectRoots, [other], "later runs find the second folder")
      rmSync(`${w.root}/drafts`, { recursive: true, force: true })
    }
  } finally { w.clean() }
})

test("init <path>: a repo anywhere in home gets its full path in the project file; a path outside home, a plain folder and a repo without a GitHub remote are refused", () => {
  const { w } = fresh()
  try {
    const home = realpathSync(w.dir.home), repo = `${home}/code/ledger2`
    mkdirSync(repo, { recursive: true })
    w.git(repo, "init", "-q", "-b", "main"); w.git(repo, "remote", "add", "origin", "https://github.com/acme/ledger2.git")
    const r = w.dobby("init", repo)
    assert.equal(r.code, 0, r.out)
    assert.match(readFileSync(`${w.root}/drafts/ledger2.md`, "utf8"), new RegExp(`^---\\nrepo: ${repo}\\n`))
    assert.match(w.dobby("init", "/etc").out, /outside your home folder/)
    mkdirSync(`${home}/code/plain`, { recursive: true })
    assert.match(w.dobby("init", `${home}/code/plain`).out, /not a git repo/)
    mkdirSync(`${home}/code/local`, { recursive: true }); w.git(`${home}/code/local`, "init", "-q")
    assert.match(w.dobby("init", `${home}/code/local`).out, /no GitHub remote/)
  } finally { w.clean() }
})

/** The fake GitHub knows acme/ledger (its origin in fresh()). */
const githubHasLedger = (w: World) => w.sh("git", ["init", "-q", "--bare", `${w.dir.gh}/github.com/acme/ledger.git`], w.root)

test("init: GitHub unreachable is not 'not signed in': no login is offered, and the fix says to check the connection", () => {
  const { w, repos } = fresh()
  try {
    const out = w.dobbyEnv({ DOBBY_FAKE_GH_OFFLINE: "1" }, "init", "--yes", "--no-jobs", "--projects", repos)
    assert.equal(out.code, 1)
    assert.match(out.out, /✗ GitHub sign-in: can't reach GitHub/)
    assert.doesNotMatch(out.out, /not signed in/)
  } finally { w.clean() }
})

test("init: a read-only account leaves the repo out and names gh auth switch; review rules and a closed squash are warned and set", () => {
  const { w, repos } = fresh()
  try {
    githubHasLedger(w)
    const ro = w.dobbyEnv({ DOBBY_FAKE_GH_REPO: JSON.stringify({ permissions: { push: false } }) }, "init", "--yes", "--no-jobs", "--projects", repos)
    assert.match(ro.out, /✗ GitHub access: acme\/ledger: this account can read the repo but not push/)
    assert.match(ro.out, /ledger is left out until this account can push to acme\/ledger/)
    assert.ok(!existsSync(`${w.root}/drafts/ledger.md`))
    const env = { DOBBY_FAKE_GH_REPO: JSON.stringify({ allow_squash_merge: false }), DOBBY_FAKE_GH_PROTECTION: JSON.stringify({ required_pull_request_reviews: { required_approving_review_count: 1 } }), DOBBY_FAKE_GH_SCOPES: "'gist', 'repo'" }
    const r = w.dobbyEnv(env, "init", "--yes", "--no-jobs", "--projects", repos)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /· Merge method: acme\/ledger: squash merges are turned off/)
    assert.match(r.out, /· Review rules: acme\/ledger: main needs an approving review: PRs will wait for a second reviewer/)
    assert.match(r.out, /· GitHub token scopes: missing workflow, project/)
    assert.equal(JSON.parse(readFileSync(`${w.root}/config.json`, "utf8")).github.mergeMethod, "merge")
  } finally { w.clean() }
})

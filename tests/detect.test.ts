import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { baseBranch, detectRepo, draftFor, githubRemote, lfsMissing, missingTool, repoWarnings, verifyRepo, verifyRepoAsync } from "../src/detect.ts"

const repo = (files: Record<string, string>) => {
  const d = mkdtempSync(`${tmpdir()}/dobby-detect-`)
  for (const [f, t] of Object.entries(files)) writeFileSync(`${d}/${f}`, t)
  spawnSync("git", ["init", "-q", "-b", "trunk", d])
  return d
}

const commit = (d: string) => { spawnSync("git", ["-C", d, "add", "-A"]); spawnSync("git", ["-C", d, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-qm", "init"]) }
const wts = () => readdirSync(tmpdir()).filter((n) => n.startsWith("dobby-verify-") && !n.endsWith(".log")).sort()

test("detect: lockfile picks the package manager; scripts give test and deploy; other ecosystems by their files", () => {
  const bun = detectRepo(repo({ "package.json": JSON.stringify({ scripts: { test: "bun test", deploy: "wrangler deploy" } }), "bun.lock": "" }))
  assert.deepEqual([bun.pm, bun.install, bun.test, bun.deploy], ["bun", "bun install", "bun run test", "bun run deploy"])
  const npm = detectRepo(repo({ "package.json": JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1", typecheck: "tsc" } }), "package-lock.json": "{}" }))
  assert.deepEqual([npm.pm, npm.install, npm.test, npm.deploy], ["npm", "npm ci", "npm run typecheck", null])
  assert.equal(detectRepo(repo({ "package.json": "{}", "pnpm-lock.yaml": "" })).test, null)
  assert.deepEqual([detectRepo(repo({ "Cargo.toml": "" })).test, detectRepo(repo({ "go.mod": "" })).test, detectRepo(repo({ "pyproject.toml": "", "uv.lock": "" })).install], ["cargo test", "go test ./...", "uv sync"])
  const mk = detectRepo(repo({ Makefile: "build:\n\ttrue\ntest:\n\ttrue\n" }))
  assert.deepEqual([mk.install, mk.test, mk.deploy], ["true", "make test", null])
  assert.equal(detectRepo(repo({})).pm, "none")
  // Python without uv.lock gets a venv (PEP 668); poetry.lock uses poetry; more ecosystems
  const py = detectRepo(repo({ "pyproject.toml": "" }))
  assert.deepEqual([py.install, py.test], ["python3 -m venv .venv && .venv/bin/pip install -e .", ".venv/bin/python -m pytest"])
  assert.deepEqual([detectRepo(repo({ "pyproject.toml": "", "poetry.lock": "" })).install, detectRepo(repo({ "requirements.txt": "" })).install], ["poetry install", "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"])
  assert.deepEqual(["Gemfile", "pom.xml", "build.gradle", "mix.exs"].map((f) => detectRepo(repo({ [f]: "" })).test), [null, "mvn -B test", "gradle test", "mix test"])
  assert.equal(detectRepo(repo({ "composer.json": JSON.stringify({ scripts: { test: "phpunit" } }) })).test, "composer test")
  assert.equal(detectRepo(repo({ "package.json": JSON.stringify({ scripts: { lint: "biome check" } }), "bun.lock": "" })).test, "bun run lint")
})

test("detect: base from origin/HEAD, else the current branch; GitHub remote in both URL forms", () => {
  const d = repo({})
  assert.equal(baseBranch(d), "trunk")
  assert.equal(githubRemote(d), null)
  spawnSync("git", ["-C", d, "remote", "add", "origin", "git@github.com:alice/my.app.git"])
  assert.equal(githubRemote(d), "alice/my.app")
  spawnSync("git", ["-C", d, "remote", "set-url", "origin", "https://github.com/alice/tally"])
  assert.equal(githubRemote(d), "alice/tally")
})

test("verify: runs install then test; stops after a failed install; draft carries what was found", () => {
  const d = detectRepo(repo({ "package.json": JSON.stringify({ scripts: { test: "x", deploy: "y" } }), "bun.lock": "" }))
  const ran: string[] = []
  commit(d.dir)
  const ok = verifyRepo(d, { has: () => true, run: (c) => (ran.push(c), { ok: true, out: "done\n12 passed" }) })
  assert.deepEqual(ran, ["bun install", "bun run test"])
  assert.deepEqual(ok.checks.map((c) => [c.step, c.ok, c.last]), [["install", true, "12 passed"], ["test", true, "12 passed"]])
  assert.equal(verifyRepo(d, { has: () => true, run: () => ({ ok: true, out: "all good\n# pass 5\n# duration_ms 29.1" }) }).checks[1].last, "all good", "no raw TAP counters in the summary line")
  const bad = verifyRepo(d, { has: () => true, run: () => ({ ok: false, out: "lockfile mismatch" }) })
  assert.deepEqual(bad.checks.map((c) => [c.step, c.ok, c.last]), [["install", false, "lockfile mismatch"]])
  const md = draftFor("app", d, "~/projects/app")
  assert.match(md, /^---\nrepo: ~\/projects\/app\npriority: 5\nbase: trunk\ninstall: bun install\nverify: bun run test\ndeploy: bun run deploy\n---/)
  mkdirSync(`${d.dir}/x`)
})

test("verify: runs in a detached worktree of origin/base through the run hook; the working copy is untouched; worktree gone after pass, fail and throw", async () => {
  const d = detectRepo(repo({ "package.json": JSON.stringify({ scripts: { test: "x" } }), "bun.lock": "", "tracked.txt": "t" }))
  commit(d.dir)
  mkdirSync(`${d.dir}/node_modules/pkg`, { recursive: true })
  writeFileSync(`${d.dir}/node_modules/pkg/a.js`, "1"); writeFileSync(`${d.dir}/.env`, "SECRET=1"); writeFileSync(`${d.dir}/untracked.txt`, "u")
  const before = wts()
  const seen: { cwd: string; net: string; files: string[] }[] = []
  const run = (_c: string, cwd: string, _ms: number, net: string) => (seen.push({ cwd, net, files: readdirSync(cwd) }), { ok: seen.length === 1 || false, out: "l1\nl2" })
  const v = verifyRepo(d, { has: () => true, run })
  assert.deepEqual(seen.map((s) => s.net), ["install", "verify"])
  assert.ok(seen[0].cwd !== d.dir && seen[0].files.includes("tracked.txt"))
  assert.ok(!seen[0].files.includes(".env") && !seen[0].files.includes("untracked.txt") && !seen[0].files.includes("node_modules"))
  assert.equal(v.checks[1].ok, false)
  assert.match(readFileSync(v.checks[1].log!, "utf8"), /l1/)
  assert.deepEqual(wts(), before) // worktree removed, also after a failed step
  assert.equal(spawnSync("git", ["-C", d.dir, "worktree", "list"], { encoding: "utf8" }).stdout.trim().split("\n").length, 1)
  assert.equal(readFileSync(`${d.dir}/node_modules/pkg/a.js`, "utf8"), "1")
  assert.equal(readFileSync(`${d.dir}/.env`, "utf8"), "SECRET=1"); assert.ok(existsSync(`${d.dir}/untracked.txt`))
  // a timeout or a throwing run still removes it
  assert.throws(() => verifyRepo(d, { has: () => true, run: () => { throw new Error("boom") } }), /boom/)
  assert.deepEqual(wts(), before)
  const a = await verifyRepoAsync(d, { has: () => true, run: async () => ({ ok: false, out: "x\n(timed out after 1 s: stopped)" }) })
  assert.equal(a.checks[0].ok, false); assert.deepEqual(wts(), before)
})

test("verify: submodules are initialised; a repo with no commits, a missing package manager and missing git-lfs fail plainly before running", () => {
  const sub = repo({ "s.txt": "s" }); commit(sub)
  const d = detectRepo(repo({ "a.txt": "a" }))
  spawnSync("git", ["-C", d.dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/s"])
  commit(d.dir)
  let had = false
  process.env.GIT_ALLOW_PROTOCOL = "file" // git blocks local-path submodules by default
  verifyRepo({ ...d, install: "true", test: null }, { has: () => true, run: (_c, cwd) => (had = existsSync(`${cwd}/vendor/s/s.txt`), { ok: true, out: "" }) })
  assert.equal(had, true)
  const broken = detectRepo(repo({ ".gitmodules": '[submodule "x"]\n\tpath = x\n\turl = /nonexistent/nowhere\n' }))
  spawnSync("git", ["-C", broken.dir, "add", ".gitmodules"]); spawnSync("git", ["-C", broken.dir, "update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},x`]); spawnSync("git", ["-C", broken.dir, "-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-qm", "g"])
  assert.match(verifyRepo({ ...broken, install: "true", test: null }, { has: () => true, run: () => ({ ok: true, out: "" }) }).checks[0].last, /submodule/)
  delete process.env.GIT_ALLOW_PROTOCOL
  const none = verifyRepo(detectRepo(repo({})), { has: () => true, run: () => ({ ok: true, out: "" }) })
  assert.match(none.checks[0].last, /could not check out/)
  let ran = false
  const noPnpm = verifyRepo({ ...d, pm: "pnpm", install: "pnpm install" }, { has: (b) => b !== "pnpm", run: () => ((ran = true), { ok: true, out: "" }) })
  assert.match(noPnpm.checks[0].last, /pnpm is not installed\. Install it: corepack enable/); assert.equal(ran, false)
  assert.match(missingTool({ ...d, install: "python3 -m venv .venv" }, () => false)!, /python3/)
  assert.equal(missingTool({ ...d, install: "true" }, () => false), null)
  const lfs = repo({ ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n" })
  assert.match(lfsMissing(lfs, () => false)!, /git-lfs is not installed/); assert.equal(lfsMissing(lfs, () => true), null)
})

test("warnings: no tests, WSL drive, private npm registry", () => {
  const d = detectRepo(repo({}))
  assert.match(repoWarnings(d, { npmrc: "" })[0], /merges will depend on the review alone/)
  assert.equal(repoWarnings({ ...d, test: "t" }, { npmrc: "registry=https://registry.npmjs.org/" }).length, 0)
  assert.match(repoWarnings({ ...d, test: "t", dir: "/mnt/c/x" }, { wsl: true, npmrc: "" })[0], /Windows drive/)
  const w = repoWarnings({ ...d, test: "t" }, { npmrc: "@co:registry=https://npm.pkg.example.com/\n", extraDomains: [] })
  assert.match(w[0], /npm\.pkg\.example\.com.*installDomains/)
  assert.equal(repoWarnings({ ...d, test: "t" }, { npmrc: "registry=https://npm.pkg.example.com/", extraDomains: ["npm.pkg.example.com"] }).length, 0)
})

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { baseBranch, detectRepo, draftFor, githubRemote, verifyRepo } from "../src/detect.ts"

const repo = (files: Record<string, string>) => {
  const d = mkdtempSync(`${tmpdir()}/dobby-detect-`)
  for (const [f, t] of Object.entries(files)) writeFileSync(`${d}/${f}`, t)
  spawnSync("git", ["init", "-q", "-b", "trunk", d])
  return d
}

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
  const ok = verifyRepo(d, { run: (c) => (ran.push(c), { ok: true, out: "done\n12 passed" }) })
  assert.deepEqual(ran, ["bun install", "bun run test"])
  assert.deepEqual(ok.checks.map((c) => [c.step, c.ok, c.last]), [["install", true, "12 passed"], ["test", true, "12 passed"]])
  const bad = verifyRepo(d, { run: () => ({ ok: false, out: "lockfile mismatch" }) })
  assert.deepEqual(bad.checks.map((c) => [c.step, c.ok, c.last]), [["install", false, "lockfile mismatch"]])
  const md = draftFor("app", d, "~/projects/app")
  assert.match(md, /^---\nrepo: ~\/projects\/app\npriority: 5\nbase: trunk\ninstall: bun install\nverify: bun run test\ndeploy: bun run deploy\n---/)
  mkdirSync(`${d.dir}/x`)
})

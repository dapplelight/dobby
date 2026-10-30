// Batch 8 re-test friction: project names print as typed, and a leftover origin branch is not reported as a conflict with main.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-uat-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/s.env`
process.env.DOBBY_PROJECTS = `${dir}/projects`
process.env.JEV_API_KEY = ""
mkdirSync(`${dir}/projects`, { recursive: true })
const { labelOf } = await import("../src/lib.ts")
const { digest } = await import("../src/notify.ts")
const { route } = await import("../src/discord.ts")
const { run } = await import("../src/graphs/review.ts")
const { setupWorktree } = await import("../src/graphs/ticket.ts")

test("project names print as typed, not capitalised", () => {
  assert.equal(labelOf("uat-shopfront", "Add clamp helper"), "uat-shopfront · Add clamp helper")
  assert.match(digest([{ id: 1, project: "uat-shopfront", title: "x", note: null }], () => undefined), /uat-shopfront 1\nuat-shopfront\n/)
  assert.equal(route({ kind: "shipped", project: "uat-shopfront" }).as, "Engineer · uat-shopfront")
})

test("prepare: a branch left on origin by an earlier run is named as such, not checked out; one already in main is reused", async () => {
  const root = mkdtempSync(`${tmpdir()}/foreman-left-`)
  const g = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" })
  g(root, "init", "-q", "--bare", "-b", "main", "origin.git")
  g(root, "clone", "-q", `${root}/origin.git`, "repo")
  const repo = `${root}/repo`
  g(repo, "config", "user.name", "t"); g(repo, "config", "user.email", "t@t")
  const commit = (f: string, text: string) => { writeFileSync(`${repo}/${f}`, text); g(repo, "add", "."); g(repo, "commit", "-qm", text) }
  commit("a.txt", "base\n"); g(repo, "push", "-q", "origin", "HEAD:main")
  g(repo, "push", "-q", "origin", "HEAD:refs/heads/dobby/4") // tip == main: already merged
  g(repo, "checkout", "-qb", "dobby/3", "main"); commit("a.txt", "old run\n"); g(repo, "push", "-q", "origin", "dobby/3"); g(repo, "checkout", "-q", "main"); g(repo, "branch", "-D", "dobby/3")
  commit("a.txt", "main moved\n"); g(repo, "push", "-q", "origin", "main")
  const x = { repo, base: "main", install: "true", fresh: true }

  const why = await setupWorktree(run, { ...x, wt: `${root}/wt3`, branch: "dobby/3" })
  assert.match(why, /^a branch named dobby\/3 already exists on origin from an earlier run\. Delete it .*or rename the ticket/)
  assert.doesNotMatch(why, /conflict/)
  assert.ok(g(repo, "ls-remote", "--heads", "origin", "dobby/3").stdout.includes("refs/heads/dobby/3")) // never deleted

  assert.equal(await setupWorktree(run, { ...x, wt: `${root}/wt4`, branch: "dobby/4" }), "") // merged leftover: start from main
  assert.equal(g(`${root}/wt4`, "rev-parse", "HEAD").stdout, g(repo, "rev-parse", "origin/main").stdout)

  // a retried ticket (not fresh) keeps the old behaviour
  assert.equal(await setupWorktree(run, { ...x, fresh: false, wt: `${root}/wt3b`, branch: "dobby/3" }), "")
})

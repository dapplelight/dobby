// The setup steps as plain functions: folders merged, paths validated, settings written like the terminal does, tools from the fixed list, first-ticket candidates.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import type { Check } from "../src/checks.ts"
import type { Detected } from "../src/detect.ts"
import { blockingChecks, checkRepoPath, defaultRoots, findRepos, firstTicketCandidates, installTool, issueArgs, loginOf, saveSettings, toolRows, toolsMissing } from "../src/setup-steps.ts"

const home = mkdtempSync(`${tmpdir()}/dobby-steps-`)
const repo = (dir: string, remote: string | null = "https://github.com/acme/x.git") => {
  mkdirSync(dir, { recursive: true })
  spawnSync("git", ["init", "-q", "-b", "main", dir])
  if (remote) spawnSync("git", ["-C", dir, "remote", "add", "origin", remote])
  return dir
}
const fake = (dir: string): Detected => ({ dir, pm: "npm", install: "true", test: "true", deploy: null, base: "main", remote: dir.includes("noremote") ? null : `acme/${dir.split("/").pop()}` })

test("findRepos: several folders are merged; a repo in two folders (same real dir) or with the same name is listed once; no remote is left out", () => {
  repo(`${home}/projects/tally`); repo(`${home}/code/shop`); repo(`${home}/code/noremote`, null)
  symlinkSync(`${home}/code/shop`, `${home}/projects/shop-link`)
  repo(`${home}/work/tally`) // same name as projects/tally: the first folder wins
  const found = findRepos([`${home}/projects`, `${home}/code`, `${home}/work`, `${home}/missing`], fake)
  const names = found.map((d) => d.dir.split("/").pop())
  assert.deepEqual([...new Set(names)].length, names.length, "no name twice")
  assert.ok(names.includes("tally") && (names.includes("shop") || names.includes("shop-link")))
  assert.equal(found.filter((d) => /shop/.test(d.dir)).length, 1, "the symlink and the folder are one repo")
  assert.ok(!names.includes("noremote"))
  assert.ok(found.find((d) => d.dir.endsWith("/tally"))!.dir.includes("/projects/"))
})

test("defaultRoots: the configured folders first, then the common ones that exist, each once", () => {
  const exists = (d: string) => /\/(projects|code|work)$/.test(d) || d === "/elsewhere"
  const r = defaultRoots({ paths: { projects: "~/projects", projectRoots: ["/elsewhere", "~/code"] } }, exists)
  assert.deepEqual(r.map((x) => x.replace(/^~\//, "")), ["projects", "/elsewhere", "code", "work"])
})

test("checkRepoPath: inside home only; a symlink out, a plain folder and a repo without a GitHub remote are each refused with a reason", () => {
  const ok = repo(`${home}/code/good`)
  const r = checkRepoPath(ok, { home })
  assert.ok(r.ok); assert.equal(r.ok && r.d.remote !== null, true)
  const bad = (p: unknown) => { const x = checkRepoPath(p, { home }); assert.equal(x.ok, false); return x.ok ? "" : x.reason }
  assert.match(bad("/etc"), /outside your home folder/)
  const outside = repo(mkdtempSync(`${tmpdir()}/dobby-outside-`))
  symlinkSync(outside, `${home}/code/escape`)
  assert.match(bad(`${home}/code/escape`), /outside your home folder/, "a symlink that leads out of home")
  assert.match(bad(`${home}/../${home.split("/").pop()}/../elsewhere`), /outside your home folder|does not exist/)
  mkdirSync(`${home}/code/plain`)
  assert.match(bad(`${home}/code/plain`), /not a git repo/)
  repo(`${home}/code/local-only`, null)
  assert.match(bad(`${home}/code/local-only`), /no GitHub remote/)
  repo(`${home}/code/gitlab`, "https://gitlab.com/acme/x.git")
  assert.match(bad(`${home}/code/gitlab`), /no GitHub remote/)
  assert.match(bad(`${home}/nope`), /does not exist/)
  assert.match(bad(""), /not a folder path/); assert.match(bad(5), /not a folder path/); assert.match(bad("a\0b"), /not a folder path/)
  writeFileSync(`${home}/file.txt`, "x")
  assert.match(bad(`${home}/file.txt`), /not a folder/)
})

test("saveSettings: the same JSON the terminal writes, mode 0600, existing values kept, extra folders kept in paths.projectRoots", () => {
  const f = `${mkdtempSync(`${tmpdir()}/dobby-save-`)}/config.json`
  const a = saveSettings({ preset: "balanced", auto: "off", deploy: "ask", weekCap: 95 }, { login: "acme", remotes: ["acme/x", "other/y"], projects: ["~/projects", "~/code"] }, f)
  assert.equal(a.kept, false)
  const j = JSON.parse(readFileSync(f, "utf8"))
  assert.deepEqual([j.github, j.safety, j.review, j.pacing, j.paths], [{ owner: "acme", accounts: ["acme", "other"] }, { preset: "balanced", deploy: "ask" }, { auto: "off" }, { weekCap: 95 }, { projects: "~/projects", projectRoots: ["~/code"] }])
  assert.equal(statSync(f).mode & 0o777, 0o600)
  writeFileSync(f, JSON.stringify({ ...j, pacing: { weekCap: 60 } }))
  const b = saveSettings({ preset: "strict", auto: "on", deploy: "auto", weekCap: 80 }, { login: "acme", remotes: [] }, f)
  assert.equal(b.kept, true)
  const k = JSON.parse(readFileSync(f, "utf8"))
  assert.equal(k.pacing.weekCap, 60); assert.equal(k.safety.preset, "balanced")
})

test("checks: the blocking rows and the GitHub login come from the rows", () => {
  const rows: Check[] = [{ name: "GitHub sign-in", ok: true, detail: "signed in as acme", required: true }, { name: "git", ok: false, detail: "not installed", required: true, fix: "xcode-select --install" }, { name: "config", ok: false, detail: "none yet", required: true }, { name: "graphify", ok: false, detail: "", required: false }]
  assert.deepEqual(blockingChecks(rows).map((r) => r.name), ["git"])
  assert.equal(loginOf(rows), "acme")
})

test("tools: all five are listed; only graphify and rtk install, with their fixed commands; any other name is refused", () => {
  const rows = toolRows((t) => t === "rtk", (t) => t !== "jev", () => true)
  assert.deepEqual(rows.map((r) => r.name), ["graphify", "rtk", "caveman", "ponytail", "jev"])
  assert.deepEqual(rows.map((r) => r.on), [true, true, true, true, false])
  assert.match(rows[2].note, /text rules, nothing to install/); assert.match(rows[4].note, /paid, needs JEV_API_KEY in secrets.env/)
  assert.deepEqual(toolsMissing((t) => t === "rtk"), ["graphify"])
  const ran: string[] = []
  const r = installTool("graphify", (c) => (ran.push(c), { ok: true, out: "done" }), () => true)
  assert.deepEqual(ran, rows[0].install); assert.equal(r.results[0].ok, true)
  for (const name of ["caveman", "jev", "rm -rf /", "../x", ""]) assert.throws(() => installTool(name, () => (ran.push("RAN"), { ok: true, out: "" })), /nothing to install/)
  assert.ok(!ran.includes("RAN"))
})

test("first ticket candidates: asks GitHub for the owner's own issues only, ranks them, three per repo", () => {
  assert.ok(issueArgs("acme/x").join(" ").includes("--author @me"))
  const issues = [{ number: 1, title: "Login loop", body: "Steps to reproduce: open the page twice. Expected: one sign-in. Done when it is fixed.", labels: [{ name: "bug" }] }, { number: 2, title: "tiny", body: "x", labels: [] }]
  const c = firstTicketCandidates([fake("/p/tally")], () => JSON.stringify(issues))
  assert.deepEqual(c.map((x) => [x.project, x.remote, x.number]), [["tally", "acme/tally", 1]])
  assert.deepEqual(firstTicketCandidates([fake("/p/tally")], () => "not json"), [])
})

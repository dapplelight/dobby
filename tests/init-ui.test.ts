// `dobby init --ui`: the dashboard app in setup mode on loopback and a free port (never 4710), signed in through /auth, and gone when setup finishes.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-initui-`)
process.env.TMPDIR = dir // clean-copy checks make dobby-verify-* folders: keep them out of the shared temp dir (tests/detect.test.ts counts them)
process.env.DOBBY_DIR = `${dir}/data`; process.env.DOBBY_SECRETS = `${dir}/vault.txt`; process.env.DOBBY_CONFIG = `${dir}/config.json`; process.env.DOBBY_PROJECTS = `${dir}/drafts`
for (const k of ["DOBBY_STATS", "DO_NOT_TRACK", "CI"]) delete process.env[k]
const { initUi, listenFree, DASHBOARD_PORT } = await import("../src/init-ui.ts")
const { open } = await import("../src/db.ts")
const TOKEN = "tok-ui"

test("listenFree: a port that comes up as 4710 is given back and another is taken", async () => {
  const ports = [DASHBOARD_PORT, 41234]
  const s = Object.assign(new EventEmitter(), { listen: (_p: number, _h: string, cb: () => void) => cb(), address: () => ({ port: ports[0] }), close: (cb: () => void) => (ports.shift(), cb()) })
  assert.equal(await listenFree(s as never), 41234)
})

test("initUi: serves setup on a free loopback port, opens the browser at /auth with the sign-in, and ends when setup finishes", async () => {
  const home = mkdtempSync(`${dir}/home-`), repo = `${home}/projects/tally`
  mkdirSync(repo, { recursive: true }); spawnSync("git", ["init", "-q", "-b", "main", repo]); spawnSync("git", ["-C", repo, "remote", "add", "origin", "https://github.com/acme/tally.git"]); writeFileSync(`${repo}/Makefile`, "test:\n\ttrue\n"); spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"])
  const opened: string[] = [], logs: string[] = []
  const db = open(":memory:")
  const up = initUi({
    db, token: TOKEN, signals: false, open: (u) => opened.push(u), log: (s) => logs.push(s), projects: [`${home}/projects`],
    setup: { home, platform: "linux", rights: async () => [], machine: "machine-aaaaaa", gh: () => ({ ok: false, out: "" }), onPath: () => true, verify: { has: () => true, lfs: () => false }, configFile: `${dir}/c.json`, check: async () => [{ name: "Node", ok: true, detail: "24", required: true }, { name: "GitHub sign-in", ok: true, detail: "signed in as acme", required: true }] as never, run: async () => ({ ok: true, out: "ok" }) },
  })
  for (let i = 0; i < 100 && !opened.length; i++) await new Promise((r) => setTimeout(r, 20))
  const url = new URL(opened[0])
  assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/auth"); assert.equal(url.searchParams.get("token"), TOKEN)
  assert.notEqual(Number(url.port), DASHBOARD_PORT)
  assert.ok(logs.join("\n").includes(`http://127.0.0.1:${url.port}/auth?token=${TOKEN}`), "the full sign-in link is printed for SSH or another profile")
  const base = `http://127.0.0.1:${url.port}`
  const login = await fetch(`${base}/auth?token=${TOKEN}`, { redirect: "manual" })
  const cookie = login.headers.get("set-cookie")!.split(";")[0]
  const post = (p: string, body: object) => fetch(`${base}/api/setup/${p}`, { method: "POST", headers: { cookie, origin: base, "content-type": "application/json" }, body: JSON.stringify(body) })
  assert.equal((await post("check", {})).status, 200)
  assert.equal((await post("repos/verify", { names: ["tally"] })).status, 200)
  for (let i = 0; i < 100; i++) { const s = (await (await fetch(`${base}/api/setup/state`, { headers: { cookie } })).json()) as { verify: Record<string, { state: string }> }; if (s.verify.tally?.state === "ok") break; await new Promise((r) => setTimeout(r, 20)) }
  assert.equal((await post("finish", {})).status, 200)
  const { port } = await up
  assert.equal(port, Number(url.port))
  await assert.rejects(fetch(`${base}/api/session`), "the server is gone after setup")
})

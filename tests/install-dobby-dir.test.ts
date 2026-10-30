// An isolated install (its own DOBBY_DIR) under the same user and HOME shares launchd and systemd labels with the owner's real install:
// uninstall, jobs status, jobs install and add jobs must not touch or list the real jobs. Injected runners only: no real launchctl or systemctl.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { jobsGate } from "../src/install.ts"
import { installJobs, JOBS, ownedHere, plistFor, plistPath, uninstallJobs, unitsFor } from "../src/jobs.ts"
import { plan, sameInstall, servicePath } from "../src/service.ts"

const home = () => mkdtempSync(`${tmpdir()}/dobby-dir-`)
const os = process.platform === "linux" ? "linux" : "darwin"
/** Install the first job's file under h the way a shell with `dir` as DOBBY_DIR would have. */
const install = (h: string, dir?: string) => {
  const env: Record<string, string> = dir ? { DOBBY_DIR: dir } : {}
  const f = os === "linux" ? unitsFor(JOBS[0], "/b", h, { env })[0] : { file: plistPath(h, JOBS[0]), text: plistFor(JOBS[0], "/b", h, { env }) }
  mkdirSync(f.file.replace(/\/[^/]*$/, ""), { recursive: true }); writeFileSync(f.file, f.text)
}
const withDir = <T>(dir: string | undefined, fn: () => T): T => {
  const was = process.env.DOBBY_DIR
  if (dir === undefined) delete process.env.DOBBY_DIR; else process.env.DOBBY_DIR = dir
  try { return fn() } finally { if (was === undefined) delete process.env.DOBBY_DIR; else process.env.DOBBY_DIR = was }
}
const rec = () => { const calls: string[] = []; return { calls, run: (c: string, a: string[]) => (calls.push(`${c} ${a.join(" ")}`), { ok: true, out: "" }) } }

test("an isolated install does not own the real jobs, and the real install does not own the isolated ones", () => {
  const h = home(); install(h)
  assert.equal(withDir(undefined, () => ownedHere(JOBS[0], os, h)), true)
  assert.equal(withDir("/tmp/iso", () => ownedHere(JOBS[0], os, h)), false)
  const h2 = home(); install(h2, "/tmp/iso")
  assert.equal(withDir("/tmp/iso", () => ownedHere(JOBS[0], os, h2)), true)
  assert.equal(withDir(undefined, () => ownedHere(JOBS[0], os, h2)), false)
})

test("uninstall --dry and uninstall from an isolated install touch none of the real jobs", () => {
  const h = home(), r = rec(); install(h)
  withDir("/tmp/iso", () => {
    assert.deepEqual(uninstallJobs({ bin: "/b", home: h, uid: 501, os, run: r.run, dry: true }), [])
    assert.deepEqual(uninstallJobs({ bin: "/b", home: h, uid: 501, os, run: r.run }), [])
  })
  assert.deepEqual(r.calls, [])
  assert.equal(existsSync(os === "linux" ? unitsFor(JOBS[0], "/b", h)[0].file : plistPath(h, JOBS[0])), true)
  assert.equal(withDir(undefined, () => uninstallJobs({ bin: "/b", home: h, uid: 501, os, run: r.run, dry: true })).length, 1)
})

test("jobs install from an isolated install refuses to take over the real jobs", () => {
  const h = home(), r = rec(); install(h)
  const rows = withDir("/tmp/iso", () => installJobs({ bin: "/opt/dobby/bin/dobby", home: h, uid: 501, os, run: r.run }))
  assert.ok(rows.every((x) => !x.ok && /another Dobby install/.test(x.detail)), JSON.stringify(rows))
  assert.deepEqual(r.calls, [])
})

test("the CLI: uninstall --dry in an isolated install lists no jobs and Kept names DOBBY_DIR", () => {
  const h = home(), dir = home(); install(h)
  const r = spawnSync(new URL("../bin/dobby", import.meta.url).pathname, ["uninstall", "--dry"], { encoding: "utf8", env: { ...process.env, HOME: h, DOBBY_DIR: dir, DOBBY_CONFIG: `${dir}/config.json`, DOBBY_SECRETS: `${dir}/s.txt` }, stdio: ["ignore", "pipe", "pipe"] })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /no Dobby jobs were installed/)
  assert.doesNotMatch(r.stdout, /would (unload|stop)/)
  assert.ok(r.stdout.includes(`and ${dir} (database, logs)`), r.stdout)
})

test("add jobs: no config or no sign-in never installs; no terminal without --yes never installs; a no never installs", async () => {
  let asked = 0
  const ok = { config: true, signedIn: true, tty: true, yes: false, ask: async () => (asked++, true) }
  assert.match((await jobsGate({ ...ok, config: false }))!, /no config/)
  assert.match((await jobsGate({ ...ok, signedIn: false }))!, /not signed in/)
  assert.match((await jobsGate({ ...ok, tty: false }))!, /no terminal/)
  assert.equal(asked, 0)
  assert.equal(await jobsGate({ ...ok, ask: async () => false }), "Jobs not installed.")
  assert.equal(await jobsGate(ok), undefined)
  assert.equal(await jobsGate({ ...ok, tty: false, yes: true }), undefined)
  assert.match((await jobsGate({ ...ok, yes: true, config: false }))!, /no config/) // --yes answers the question, not the missing config
})

test("the service PATH has each folder once and only folders that exist", () => {
  assert.equal(servicePath(["/a:/b", "/b:/c:/gone"], (d) => d !== "/gone"), "/a:/b:/c")
})

test("jobs install --dry on Linux says it would enable lingering", () => {
  const lines: string[] = []
  installJobs({ bin: "/b", home: home(), uid: 1000, os: "linux", dry: true, log: (s) => lines.push(s) })
  assert.ok(lines.some((l) => /loginctl enable-linger/.test(l)), lines.join("\n"))
})

test("the service file records DOBBY_DIR, so uninstall in the same install finds it and another install does not", () => {
  const s = { exec: ["/n", "start"], path: "/p", log: "/l", home: "/h", uid: 1, dir: "/tmp/iso" }
  const f = home(); writeFileSync(`${f}/svc`, plan(os, s).text)
  assert.equal(withDir("/tmp/iso", () => sameInstall(`${f}/svc`)), true)
  assert.equal(withDir(undefined, () => sameInstall(`${f}/svc`)), false)
  writeFileSync(`${f}/svc2`, plan(os, { ...s, dir: undefined }).text)
  assert.equal(withDir(undefined, () => sameInstall(`${f}/svc2`)), true)
})

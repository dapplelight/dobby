// A second install under the same OS user shares launchd and systemd labels with the first: jobs, doctor, health, service and
// dashboard open must only see and touch what has a file under THIS HOME. Injected runners only: no real launchctl or systemctl.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { basics } from "../src/checks.ts"
import { tokenAccepted } from "../src/dashboard-server.ts"
import { JOBS, NOT_HERE, OLD_LISTENER, ownedHere, plistPath, uninstallJobs, uninstallService, unitsFor } from "../src/jobs.ts"
import { noTestCommand } from "../src/lib.ts"

const home = () => mkdtempSync(`${tmpdir()}/dobby-iso-`)
const withPlists = (h: string, names: string[]) => { mkdirSync(`${h}/Library/LaunchAgents`, { recursive: true }); for (const n of names) writeFileSync(`${h}/Library/LaunchAgents/com.dobby.${n}.plist`, "x") }
const recorder = () => { const calls: string[] = []; return { calls, run: (c: string, a: string[]) => (calls.push(`${c} ${a.join(" ")}`), { ok: true, out: "" }) } }

test("uninstall: a HOME with no plists unloads nothing, even though the labels are loaded for this user", () => {
  const h = home(), r = recorder()
  assert.deepEqual(uninstallJobs({ bin: "/b", home: h, uid: 501, os: "darwin", run: r.run }), [])
  assert.deepEqual(uninstallJobs({ bin: "/b", home: h, uid: 501, os: "darwin", run: r.run, dry: true }), [])
  assert.deepEqual(uninstallService({ bin: "/b", home: h, uid: 501, os: "darwin", run: r.run }), [])
  assert.deepEqual(r.calls, [])
})

test("uninstall: only the jobs with a plist here are unloaded; the old listener name says what it is", () => {
  const h = home(), r = recorder()
  withPlists(h, ["tick", "telegram"])
  const dry = uninstallJobs({ bin: "/b", home: h, uid: 501, os: "darwin", run: r.run, dry: true })
  assert.equal(dry.length, 2)
  assert.match(dry[1], /com\.dobby\.telegram.*\(old name of the listener, from earlier installs\)/)
  assert.deepEqual(r.calls, [])
  assert.deepEqual(uninstallJobs({ bin: "/b", home: h, uid: 501, os: "darwin", run: r.run }), ["removed com.dobby.tick", "removed com.dobby.telegram"])
  assert.deepEqual(r.calls, ["launchctl bootout gui/501/com.dobby.tick", "launchctl bootout gui/501/com.dobby.telegram"])
  assert.equal(existsSync(plistPath(h, JOBS[0])), false)
})

test("uninstall on Linux: only units with a service file here are stopped", () => {
  const h = home(), r = recorder()
  assert.deepEqual(uninstallJobs({ bin: "/b", home: h, uid: 1000, os: "linux", run: r.run }), [])
  assert.deepEqual(r.calls, [])
  for (const f of unitsFor(JOBS[0], "/b", h)) { mkdirSync(f.file.replace(/\/[^/]*$/, ""), { recursive: true }); writeFileSync(f.file, "x") }
  assert.deepEqual(uninstallJobs({ bin: "/b", home: h, uid: 1000, os: "linux", run: r.run }), ["removed dobby-tick"])
  assert.ok(r.calls.every((c) => !/dobby-(listener|health|cos|graphify|dashboard|telegram)/.test(c)), r.calls.join("\n"))
})

test("ownedHere: a plist or service file under this HOME, nothing else", () => {
  const h = home(); withPlists(h, ["cos"])
  assert.equal(ownedHere(JOBS.find((j) => j.name === "cos")!, "darwin", h), true)
  assert.equal(ownedHere(JOBS[0], "darwin", h), false)
  assert.equal(ownedHere(OLD_LISTENER, "linux", h), false)
})

test("doctor: jobs with no file here are never probed and read 'not installed here', not '6 loaded'", async () => {
  const h = home(), probed: string[] = []
  const probe = async (c: string, a: string[]) => { if (c === "launchctl") probed.push(a.join(" ")); return { ok: true, out: "x 1.0" } } // every label loaded: another install's
  const rows = await basics({ probe, node: "24.18.0", platform: "darwin", uid: 501, secrets: {}, env: {}, configPath: `${h}/c.json`, jobs: true, home: h, bin: "/b", warnings: [], freeGb: 90, dataDir: h, mounts: "", version: "1", zone: "UTC", read: () => "" })
  assert.deepEqual(probed, [])
  const row = rows.find((r) => r.name === "background jobs")!
  assert.equal(row.ok, false)
  assert.match(row.detail, new RegExp(NOT_HERE))
  assert.doesNotMatch(row.detail, /loaded/)
  // no job installed: dobby start is offered too; with DOBBY_DIR set the fix warns that jobs install writes the real jobs (#406)
  assert.equal(row.fix, "dobby start (runs Dobby in this terminal), or dobby jobs install")
  const iso = await basics({ probe, node: "24.18.0", platform: "darwin", uid: 501, secrets: {}, env: { DOBBY_DIR: h }, configPath: `${h}/c.json`, jobs: true, home: h, bin: "/b", warnings: [], freeGb: 90, dataDir: h, mounts: "", version: "1", zone: "UTC", read: () => "" })
  assert.match(iso.find((r) => r.name === "background jobs")!.fix!, /^dobby start .*, or dobby jobs install\. DOBBY_DIR is set, but jobs install writes your user's real launchd or systemd jobs/)
})

test("dashboard open: a 302 from /auth means the token is accepted, a 401 means another install's dashboard", async () => {
  const seen: string[] = []
  const f = (code: number) => (async (u: string | URL | Request) => (seen.push(String(u)), new Response("", { status: code }))) as typeof fetch
  assert.equal(await tokenAccepted(4710, "tok", f(302)), true)
  assert.equal(await tokenAccepted(4710, "tok", f(401)), false)
  assert.equal(await tokenAccepted(4710, "tok", (async () => { throw new Error("down") }) as typeof fetch), false)
  assert.equal(seen[0], "http://127.0.0.1:4710/auth?token=tok")
})

test("noTestCommand: empty or `true` verify has no test command; a real one does", () => {
  assert.match(noTestCommand({ name: "app", verify: "true" }), /^no test command for app: set verify in projects\/app\.md$/)
  assert.match(noTestCommand({ name: "app", verify: "  " }), /no test command for app/)
  assert.equal(noTestCommand({ name: "app", verify: "npm test" }), "")
})

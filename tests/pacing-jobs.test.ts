// Stale usage is no usage, parallel builds are counted, jobs do not clash with the service, uninstall removes the service. Offline, injected runners.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-pj-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/s.txt`
writeFileSync(process.env.DOBBY_SECRETS, "")
const { open } = await import("../src/db.ts")
const L = await import("../src/lib.ts")
const { installJobs, uninstallService, jobState } = await import("../src/jobs.ts")
const { readLimits } = await import("../src/usage.ts")
const { pipelineWatch } = await import("../src/health.ts")
const { config, setConfig } = await import("../src/config.ts")

const cliJson = (extra: Record<string, unknown> = {}) => JSON.stringify({ windows: [{ key: "five_hour", percentUsed: 40, msToReset: 3600_000 }, { key: "seven_day", percentUsed: 60, msToReset: 4 * 86_400_000 }], ...extra })
const quiet = (() => {}) as typeof L.fixed

test("a stale reading that cannot be refreshed is no reading: pacing falls back instead of using it", () => {
  const db = open(":memory:")
  assert.equal(L.readUsage(db, () => cliJson({ snapshotAgeMs: 31 * 60_000 }), Date.now(), quiet, () => false, () => false), null)
  assert.notEqual(L.readUsage(db, () => cliJson({ snapshotAgeMs: 5 * 60_000 }), Date.now(), quiet, () => false, () => false), null)
})

test("budget: builds already running count against the week cap", () => {
  const u = { fiveUsed: 10, weekUsed: 94, weekMsToReset: 86_400_000, fiveMsToReset: 3600_000 }
  assert.equal(L.budgetAllows(u, 12, undefined, undefined, 95, 0).ok, true)
  assert.equal(L.budgetAllows(u, 12, undefined, undefined, 95, 2).ok, false)
  const rel = L.reserveBuild(), rel2 = L.reserveBuild()
  assert.equal(L.budgetAllows(u, 12, undefined, undefined, 95).ok, false) // module count: 2 running
  rel(); rel(); rel2()
  assert.equal(L.budgetAllows(u, 12, undefined, undefined, 95).ok, true, "released once each, even when released twice")
})

test("usage sampler resolves the bundled reader when paths.usageCli is empty", () => {
  setConfig({ ...config(), paths: { ...config().paths, usageCli: "" } })
  let used = ""
  readLimits(((_c: string, a: string[]) => (used = a[0], { stdout: "" })) as never)
  assert.match(used, /cli\.js$/)
  setConfig(undefined)
})

test("jobs install refuses beside the service or a running dobby start; the dashboard alone is fine", () => {
  const home = mkdtempSync(`${tmpdir()}/foreman-pj-home-`)
  mkdirSync(`${home}/Library/LaunchAgents`, { recursive: true }); writeFileSync(`${home}/Library/LaunchAgents/com.dobby.service.plist`, "x")
  mkdirSync(`${home}/.config/systemd/user`, { recursive: true }); writeFileSync(`${home}/.config/systemd/user/dobby.service`, "x") // this install's service
  const seen: string[] = []
  const run = (c: string, a: string[]) => (seen.push(`${c} ${a.join(" ")}`), { ok: a.includes("gui/501/com.dobby.service"), out: "" })
  const rows = installJobs({ bin: "/b", home, uid: 501, os: "darwin", run, log: () => {} })
  assert.equal(rows.every((r) => !r.ok && /service/.test(r.detail)), true)
  assert.equal(seen.some((s) => s.includes("bootstrap")), false, "nothing was loaded")
  const lin = installJobs({ bin: "/b", home, uid: 1000, os: "linux", run: (_c, a) => ({ ok: a.includes("dobby.service"), out: "" }), log: () => {} })
  assert.equal(lin.every((r) => !r.ok && /dobby\.service/.test(r.detail)), true)
  const pid = installJobs({ bin: "/b", home, uid: 501, os: "darwin", run: () => ({ ok: false, out: "" }), startPid: 4242, log: () => {} })
  assert.match(pid[0].detail, /dobby start is running \(pid 4242\)/)
  const booted: string[] = []
  const dash = installJobs({ bin: "/b", home, uid: 501, os: "darwin", run: (c, a) => (booted.push(`${c} ${a[0]}`), { ok: !a.includes("gui/501/com.dobby.service"), out: "" }), only: ["dashboard"], log: () => {} })
  assert.ok(booted.includes("launchctl bootstrap"))
  assert.equal(dash.length, 1)
})

test("uninstallService removes com.dobby.service (injected runner, temp home)", () => {
  const home = mkdtempSync(`${tmpdir()}/foreman-pj-home-`)
  const file = `${home}/Library/LaunchAgents/com.dobby.service.plist`
  mkdirSync(`${home}/Library/LaunchAgents`, { recursive: true }); writeFileSync(file, "x")
  const calls: string[] = []
  const run = (c: string, a: string[]) => (calls.push(`${c} ${a.join(" ")}`), { ok: true, out: "" })
  const was = process.env.DOBBY_DIR; delete process.env.DOBBY_DIR // the file records the default data dir
  assert.equal(uninstallService({ bin: "/b", home, uid: 501, os: "darwin", run, dry: true }).length, 1)
  assert.equal(existsSync(file), true, "dry run keeps it")
  assert.deepEqual(uninstallService({ bin: "/b", home, uid: 501, os: "darwin", run }), ["removed com.dobby.service"])
  assert.equal(existsSync(file), false)
  assert.ok(calls.includes("launchctl bootout gui/501/com.dobby.service"))
  assert.deepEqual(uninstallService({ bin: "/b", home, uid: 501, os: "darwin", run: () => ({ ok: false, out: "" }) }), [], "nothing installed")
  if (was !== undefined) process.env.DOBBY_DIR = was
})

test("linux job probe: a stopped unit that systemctl show reports with exit 0 is not loaded", () => {
  assert.equal(jobState("linux", { ok: true, out: "Id=dobby-tick.service\nActiveState=inactive\nExecMainStatus=0\n" }).loaded, false)
  assert.equal(jobState("linux", { ok: true, out: "Id=dobby-tick.service\nActiveState=active\nExecMainStatus=0\n" }).loaded, true)
})

test("pipeline alert key follows the configured time zone, not IST", async () => {
  setConfig({ ...config(), timezone: "America/Los_Angeles" })
  const db = open(":memory:")
  const sent: string[] = []
  const at = (iso: string) => pipelineWatch(db, async (t) => (sent.push(t), true), { now: Date.parse(iso), dir, freeGb: () => 0.1, projects: {} })
  await at("2026-10-20T17:00:00Z") // 10:00 in Los Angeles
  const n = sent.length
  assert.ok(n > 0, "the low disk problem was posted")
  await at("2026-10-20T19:00:00Z") // 12:00 in Los Angeles; past 18:30 UTC, which IST would call a new day
  assert.equal(sent.length, n, "same local day, not told again")
  setConfig(undefined)
})

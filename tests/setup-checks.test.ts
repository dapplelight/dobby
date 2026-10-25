import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { basics, formatChecks, nodeOk } from "../src/checks.ts"
import { loginShell, shellName } from "../src/shell.ts"
import { installJobs, JOBS, loadedProbe, plistFor, plistPath, uninstallJobs, unitFor, unitsFor } from "../src/jobs.ts"

test("checks: every tool, sign-in and add-on gets a row and a fix; optional add-ons never fail setup", async () => {
  const dir = mkdtempSync(`${tmpdir()}/dobby-checks-`)
  const missing = new Set(["claude", "graphify"])
  const probe = async (cmd: string, args: string[]) => (missing.has(cmd) ? { ok: false, out: "not found" } : cmd === "gh" && args[0] === "api" ? { ok: true, out: "alice\n" } : { ok: true, out: `${cmd} version 2.47.1` })
  const rows = await basics({ probe, node: "24.18.0", platform: "darwin", secrets: {}, env: {}, configPath: `${dir}/none.json` })
  const by = Object.fromEntries(rows.map((r) => [r.name, r]))
  assert.deepEqual([by["Node"].ok, by["git"].detail, by["GitHub sign-in"].detail], [true, "2.47.1", "signed in as alice"])
  assert.deepEqual([by["Claude Code"].ok, by["Claude sign-in"].ok, by["config"].ok], [false, false, false])
  assert.equal(by["Claude Code"].fix, "npm install -g @anthropic-ai/claude-code")
  assert.deepEqual(rows.filter((r) => !r.required).map((r) => r.name), ["shell", "graphify", "Discord", "Jev"])
  assert.equal(rows.some((r) => r.name === "background jobs"), false) // only with jobs: true
  const text = formatChecks(rows)
  assert.match(text, /✗ Claude Code: not installed\n    fix: npm install -g @anthropic-ai\/claude-code/)
  assert.match(text, /· Discord: off/)
  writeFileSync(`${dir}/c.json`, "{}")
  const withJobs = await basics({ probe: async (c, a) => ({ ok: !(c === "launchctl" && a[1].endsWith("cos")), out: "x 1.0" }), node: "22.12.0", platform: "darwin", uid: 501, secrets: { DISCORD_BOT_TOKEN: "t" }, env: { JEV_API_KEY: "k" }, configPath: `${dir}/c.json`, jobs: true })
  const j = withJobs.find((r) => r.name === "background jobs")!
  assert.deepEqual([j.ok, j.detail, withJobs[0].ok], [false, "not loaded: cos", false])
  assert.deepEqual([nodeOk("22.18.0"), nodeOk("23.5.0"), nodeOk("23.6.1"), nodeOk("24.0.0")], [true, false, true, true])
})

test("jobs: six plists; always-on, interval and daily timing; install ticks only what launchd loaded; uninstall removes", () => {
  const home = mkdtempSync(`${tmpdir()}/dobby-jobs-`)
  const tick = plistFor(JOBS[0], "/opt/my dobby/bin/dobby", home)
  assert.match(tick, /<string>com\.dobby\.tick<\/string>[\s\S]*<string>\/opt\/my dobby\/bin\/dobby<\/string><string>tick<\/string>[\s\S]*<key>KeepAlive<\/key><true\/><key>ThrottleInterval<\/key><integer>60<\/integer>[\s\S]*<key>RunAtLoad<\/key><true\/>/)
  assert.match(plistFor(JOBS.find((x) => x.name === "telegram")!, "/b", home), /<string>listen<\/string>/)
  assert.match(plistFor(JOBS.find((x) => x.name === "health")!, "/b", home), /<key>StartInterval<\/key><integer>3600<\/integer>/)
  assert.match(plistFor(JOBS.find((x) => x.name === "cos")!, "/b", home), /<key>Hour<\/key><integer>8<\/integer><key>Minute<\/key><integer>5<\/integer><\/dict>[\s\S]*<key>RunAtLoad<\/key><false\/>/)
  const calls: string[] = []
  const run = (c: string, a: string[]) => (calls.push(`${c} ${a.join(" ")}`), { ok: !(a[0] === "print" && a[1].endsWith("dashboard")), out: a[0] === "bootstrap" && a[2].includes("dashboard") ? "Bootstrap failed: 5" : "" })
  const rows = installJobs({ bin: "/b", home, uid: 501, run, log: () => {} })
  assert.deepEqual(rows.map((r) => r.ok), [true, true, false, true, true, true])
  assert.match(rows[2].detail, /did not load: Bootstrap failed: 5/)
  assert.ok(existsSync(plistPath(home, JOBS[0])) && readFileSync(plistPath(home, JOBS[0]), "utf8") === plistFor(JOBS[0], "/b", home))
  assert.ok(calls.includes(`launchctl bootstrap gui/501 ${plistPath(home, JOBS[0])}`))
  const dry: string[] = []
  assert.equal(installJobs({ bin: "/b", home: `${home}/nope`, uid: 501, run, dry: true, log: (s) => dry.push(s) }).length, 6)
  assert.equal(existsSync(`${home}/nope`), false)
  assert.deepEqual(installJobs({ bin: "/b", home, uid: 501, run, only: ["dashboard"], log: () => {} }).map((r) => r.name), ["dashboard"]) // dobby add dashboard
  assert.equal(uninstallJobs({ bin: "/b", home, uid: 501, run: () => ({ ok: false, out: "" }) }).length, 6) // plists existed
  assert.equal(existsSync(plistPath(home, JOBS[0])), false)
  assert.deepEqual(uninstallJobs({ bin: "/b", home, uid: 501, run: () => ({ ok: false, out: "" }) }), [])
})

test("jobs on Linux: a restarting service for always-on jobs, service + timer for scheduled ones; ticks only active units", () => {
  const home = mkdtempSync(`${tmpdir()}/dobby-units-`)
  const by = (n: string) => JOBS.find((x) => x.name === n)!
  const [tick] = unitsFor(by("tick"), "/opt/my 100% dobby/bin/dobby", home)
  assert.match(tick.text, /Restart=always\nRestartSec=60\nExecStart="\/opt\/my 100%% dobby\/bin\/dobby" "tick"[\s\S]*WantedBy=default.target/)
  assert.equal(unitsFor(by("telegram"), "/b", home)[0].text.includes("RestartSec=10"), true)
  const [svc, timer] = unitsFor(by("cos"), "/b", home)
  assert.match(svc.text, /Type=oneshot/)
  assert.doesNotMatch(svc.text, /Restart=|\[Install\]/)
  assert.match(timer.text, /OnCalendar=\*-\*-\* 08:05:00[\s\S]*WantedBy=timers.target/)
  assert.match(unitsFor(by("health"), "/b", home)[1].text, /OnUnitActiveSec=3600/)
  assert.deepEqual([unitFor(by("tick")), unitFor(by("health"))], ["dobby-tick.service", "dobby-health.timer"])
  assert.deepEqual(loadedProbe(by("cos"), "linux", 1000), ["systemctl", ["--user", "is-active", "dobby-cos.timer"]])
  const calls: string[] = []
  const run = (c: string, a: string[]) => (calls.push(`${c} ${a.join(" ")}`), { ok: !(a[1] === "is-active" && a[2] === "dobby-graphify.timer"), out: "" })
  const rows = installJobs({ bin: "/b", home, uid: 1000, os: "linux", run, log: () => {} })
  assert.deepEqual(rows.map((r) => r.ok), [true, true, true, true, true, false])
  assert.match(rows[5].detail, /journalctl --user -u dobby-graphify/)
  assert.ok(existsSync(`${home}/.config/systemd/user/dobby-cos.timer`) && existsSync(`${home}/.config/systemd/user/dobby-cos.service`))
  assert.deepEqual(calls.slice(0, 2), ["systemctl --user daemon-reload", "loginctl enable-linger"])
  assert.ok(calls.includes("systemctl --user restart dobby-tick.service"))
  assert.equal(uninstallJobs({ bin: "/b", home, uid: 1000, os: "linux", run: () => ({ ok: false, out: "" }) }).length, 6)
  assert.equal(existsSync(`${home}/.config/systemd/user/dobby-cos.timer`), false)
})

test("setup: first-ticket ranking prefers a clear done rule, a bug label and a short body; config fill never overwrites", async () => {
  const { rankIssues, fillConfig } = await import("../src/setup.ts")
  const i = (number: number, body: string, labels: string[] = [], title = `t${number}`) => ({ number, title, body, labels: labels.map((name) => ({ name })) })
  const ranked = rankIssues([
    i(1, "x".repeat(300)), i(2, "Done when the total shows ₹0 instead of NaN on an empty month."), i(3, "Expected: no crash. ".repeat(10), ["bug"]),
    i(4, "Done when it ships. ".repeat(5), ["question"]), i(5, "too short"), i(6, "Done when the owner picks a name for it.", [], "Owner: pick a name"),
  ])
  assert.deepEqual(ranked.map((x) => x.number), [3, 2, 1])
  assert.deepEqual(fillConfig({ timezone: "Asia/Kolkata", github: { owner: "ownerdev" } }, { timezone: "UTC", timezoneLabel: "UTC", github: { owner: "x", accounts: ["x"] }, safety: { preset: "balanced" } }),
    { timezone: "Asia/Kolkata", timezoneLabel: "UTC", github: { owner: "ownerdev", accounts: ["x"] }, safety: { preset: "balanced" } })
})

test("API-key mode: dollar caps over 24 hours and 7 days replace plan pacing; doctor wants the key, not a sign-in", async () => {
  const { open, logRun } = await import("../src/db.ts")
  const { spendAllows } = await import("../src/lib.ts")
  const db = open(":memory:")
  const b = { mode: "apiKey" as const, dailyUsd: 5, weeklyUsd: 12 }
  assert.equal(spendAllows(db, b).ok, true)
  logRun(db, { project: "p", kind: "build", model: "sonnet", ok: true, cost_usd: 4 })
  assert.match(spendAllows(db, b).why, /\$4\.00 of \$5 in 24 hours, \$4\.00 of \$12 in 7 days/)
  logRun(db, { project: "p", kind: "build", model: "sonnet", ok: true, cost_usd: 1.5 })
  assert.deepEqual([spendAllows(db, b).ok, spendAllows(db, b).why], [false, "API key: $5.50 in 24 hours (cap $5)"])
  db.prepare("UPDATE runs SET at=?").run(new Date(Date.now() - 2 * 24 * 3600_000).toISOString()) // two days ago: out of the 24 hours, still in the week
  assert.equal(spendAllows(db, b).ok, true)
  assert.equal(spendAllows(db, { ...b, weeklyUsd: 5 }).ok, false)
  const dir = mkdtempSync(`${tmpdir()}/dobby-key-`)
  const probe = async (c: string, a: string[]) => ({ ok: !(c === "claude" && a[0] === "auth"), out: "x 1.0" }) // no plan sign-in
  const rows = (k: string) => basics({ probe, node: "22.12.0", platform: "darwin", secrets: k ? { DOBBY_API_KEY: k } : {}, env: {}, configPath: `${dir}/c.json`, apiKeyMode: true })
  assert.deepEqual((await rows("sk")).filter((r) => r.name === "API key" || r.name === "Claude sign-in").map((r) => [r.name, r.ok]), [["API key", true]])
  assert.equal((await rows("")).find((r) => r.name === "API key")!.ok, false)
})

test("shell: zsh when on PATH, else bash, else plain sh without the login flag", () => {
  const bin = mkdtempSync(`${tmpdir()}/dobby-shell-`)
  assert.deepEqual(loginShell("x", bin), ["sh", ["-c", "x"]])
  writeFileSync(`${bin}/bash`, "")
  assert.deepEqual(loginShell("x", bin), ["bash", ["-lc", "x"]])
  writeFileSync(`${bin}/zsh`, "")
  assert.equal(shellName(bin), "zsh")
})

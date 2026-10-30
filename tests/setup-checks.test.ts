import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { basics, formatChecks, nodeOk } from "../src/checks.ts"
import { loginShell, shellName } from "../src/shell.ts"
import type { Run } from "../src/jobs.ts"
// these tests are about the jobs, not the service: no `dobby service` is running unless a test says so (tests/pacing-jobs.test.ts)
const installJobs: typeof installJobsRaw = (o) => installJobsRaw({ ...o, run: o.run && ((c, a, e) => (a.includes("gui/501/com.dobby.service") || (a[1] === "is-active" && a[2] === "dobby.service") ? { ok: false, out: "" } : o.run!(c, a, e))) })
import { ephemeral, installedBin, installJobs as installJobsRaw, jobCtx, jobState, keepEnv, JOBS, loadedProbe, plistFor, plistPath, uninstallJobs, unitFor, unitsFor } from "../src/jobs.ts"

test("checks: every tool, sign-in and add-on gets a row and a fix; optional add-ons never fail setup", async () => {
  const dir = mkdtempSync(`${tmpdir()}/dobby-checks-`)
  const missing = new Set(["claude", "graphify"])
  const probe = async (cmd: string, args: string[]) => (missing.has(cmd) ? { ok: false, out: "not found" } : cmd === "gh" && args[0] === "api" ? { ok: true, out: "alice\n" } : { ok: true, out: `${cmd} version 2.47.1` })
  const rows = await basics({ probe, node: "24.18.0", platform: "darwin", secrets: {}, env: {}, configPath: `${dir}/none.json` })
  const by = Object.fromEntries(rows.map((r) => [r.name, r]))
  assert.deepEqual([by["Node"].ok, by["git"].detail, by["GitHub sign-in"].detail], [true, "2.47.1", "signed in as alice"])
  assert.deepEqual([by["Claude Code"].ok, by["Claude sign-in"].ok, by["config"].ok], [false, false, false])
  assert.equal(by["Claude Code"].fix, "npm install -g @anthropic-ai/claude-code")
  assert.deepEqual(rows.filter((r) => !r.required).map((r) => r.name), ["shell", "sandbox runner", "sandbox", "config warnings", "graphify", "disk", "Discord", "Jev"])
  assert.equal(by["git identity"].detail, "commits as git version 2.47.1") // the fake probe echoes the same line for every command
  assert.equal(by["sandbox"].ok, true)
  const noEmail = await basics({ probe: async (c, a) => ({ ok: !(c === "git" && a[0] === "config"), out: "" }), node: "24.18.0", platform: "linux", secrets: {}, env: {}, configPath: `${dir}/none.json` })
  assert.deepEqual([noEmail.find((r) => r.name === "git identity")!.ok, noEmail.find((r) => r.name === "git identity")!.required, noEmail.find((r) => r.name === "sandbox")!.ok], [false, true, true])
  assert.equal(rows.some((r) => r.name === "background jobs"), false) // only with jobs: true
  const text = formatChecks(rows)
  assert.match(text, /✗ Claude Code: not installed\n    fix: npm install -g @anthropic-ai\/claude-code/)
  assert.match(text, /· Discord: off/)
  writeFileSync(`${dir}/c.json`, "{}")
  const withJobs = await basics({ exists: () => true, probe: async (c, a) => ({ ok: !(c === "launchctl" && /\.(cos|telegram)$/.test(a[1])), out: "x 1.0" }), node: "22.12.0", platform: "darwin", uid: 501, secrets: { DISCORD_BOT_TOKEN: "t" }, env: { JEV_API_KEY: "k" }, configPath: `${dir}/c.json`, jobs: true, read: () => { throw new Error("no file") } })
  const j = withJobs.find((r) => r.name === "background jobs")!
  assert.deepEqual([j.ok, j.detail, withJobs[0].ok], [false, "not loaded: cos", false])
  assert.deepEqual([nodeOk("22.18.0"), nodeOk("23.6.1"), nodeOk("24.0.0"), nodeOk("25.1.2")], [false, false, true, true])
})

test("jobs: six plists; always-on, interval and daily timing; install ticks only what launchd loaded; uninstall removes", () => {
  const home = mkdtempSync(`${tmpdir()}/dobby-jobs-`)
  const tick = plistFor(JOBS[0], "/opt/my dobby/bin/dobby", home)
  assert.match(tick, /<string>com\.dobby\.tick<\/string>[\s\S]*<string>\/opt\/my dobby\/bin\/dobby<\/string><string>tick<\/string>[\s\S]*<key>KeepAlive<\/key><true\/><key>ThrottleInterval<\/key><integer>60<\/integer>[\s\S]*<key>RunAtLoad<\/key><true\/>/)
  assert.match(plistFor(JOBS.find((x) => x.name === "listener")!, "/b", home), /<string>listen<\/string>/)
  assert.match(plistFor(JOBS.find((x) => x.name === "health")!, "/b", home), /<key>StartInterval<\/key><integer>3600<\/integer>/)
  assert.match(plistFor(JOBS.find((x) => x.name === "cos")!, "/b", home), /<key>Hour<\/key><integer>8<\/integer><key>Minute<\/key><integer>5<\/integer><\/dict>[\s\S]*<key>RunAtLoad<\/key><false\/>/)
  const calls: string[] = []
  const run = (c: string, a: string[]) => (calls.push(`${c} ${a.join(" ")}`), { ok: !(a[0] === "print" && a[1].endsWith("dashboard")), out: a[0] === "bootstrap" && a[2].includes("dashboard") ? "Bootstrap failed: 5" : "" })
  const rows = installJobs({ bin: "/b", home, uid: 501, run, log: () => {} })
  assert.deepEqual(rows.map((r) => r.ok), [true, true, false, true, true, true])
  assert.match(rows[2].detail, /did not load: Bootstrap failed: 5/)
  assert.ok(existsSync(plistPath(home, JOBS[0])) && readFileSync(plistPath(home, JOBS[0]), "utf8") === plistFor(JOBS[0], "/b", home, jobCtx()))
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
  assert.equal(unitsFor(by("listener"), "/b", home)[0].text.includes("RestartSec=10"), true)
  const [svc, timer] = unitsFor(by("cos"), "/b", home)
  assert.match(svc.text, /Type=oneshot/)
  assert.doesNotMatch(svc.text, /Restart=|\[Install\]/)
  assert.match(timer.text, /OnCalendar=\*-\*-\* 08:05:00[\s\S]*WantedBy=timers.target/)
  assert.match(unitsFor(by("health"), "/b", home)[1].text, /OnUnitActiveSec=3600/)
  assert.deepEqual([unitFor(by("tick")), unitFor(by("health"))], ["dobby-tick.service", "dobby-health.timer"])
  assert.deepEqual(loadedProbe(by("cos"), "linux", 1000), ["systemctl", ["--user", "show", "-p", "Id,ActiveState,ExecMainStatus", "dobby-cos.timer", "dobby-cos.service"]])
  const calls: string[] = []
  const run = (c: string, a: string[]) => (calls.push(`${c} ${a.join(" ")}`), { ok: true, out: a[1] === "show" && a[4] ? `Id=${a[4]}\nActiveState=${a[4] === "dobby-graphify.timer" ? "inactive" : "active"}\nExecMainStatus=0` : "Linger=yes" })
  const rows = installJobs({ bin: "/b", home, uid: 1000, os: "linux", run, log: () => {} })
  assert.deepEqual(rows.map((r) => r.ok), [true, true, true, true, true, false])
  assert.match(rows[5].detail, /journalctl --user -u dobby-graphify/)
  assert.ok(existsSync(`${home}/.config/systemd/user/dobby-cos.timer`) && existsSync(`${home}/.config/systemd/user/dobby-cos.service`))
  assert.deepEqual(calls.slice(2, 4), ["systemctl --user daemon-reload", "loginctl enable-linger"])
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
  const sent: Record<string, string>[] = []
  const answer = (status: number, message = "") => (async (_u: unknown, i?: RequestInit) => { sent.push(i?.headers as Record<string, string>); return new Response(JSON.stringify(status === 200 ? { data: [] } : { error: { message } }), { status }) }) as unknown as typeof fetch
  const rows = (k: string, f = answer(200), workspaceId?: string) => basics({ probe, node: "22.12.0", platform: "darwin", secrets: k ? { DOBBY_API_KEY: k } : {}, env: {}, configPath: `${dir}/c.json`, apiKeyMode: true, fetch: f, workspaceId })
  const unscoped = answer(400, "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header")
  const bad = (await rows("sk", unscoped)).find((r) => r.name === "API key")!
  assert.equal(bad.ok, false) // a key that is set but fails a real call is not "set, fine"
  assert.equal(bad.detail, "This key isn't in a workspace: set billing.workspaceId, or create the key inside a workspace in Console.")
  sent.length = 0
  assert.equal((await rows("sk", answer(200), "wrkspc_1")).find((r) => r.name === "API key")!.ok, true)
  assert.equal(sent[0]["anthropic-workspace-id"], "wrkspc_1") // the probe carries the workspace
  const offline = (async () => { throw new Error("offline") }) as unknown as typeof fetch
  assert.equal((await rows("sk", offline)).find((r) => r.name === "API key")!.ok, true) // no network is not a bad key
  assert.deepEqual((await rows("sk")).filter((r) => r.name === "API key" || r.name === "Claude sign-in").map((r) => [r.name, r.ok]), [["API key", true]])
  assert.equal((await rows("")).find((r) => r.name === "API key")!.ok, false)
  // no claude binary at all: the Claude Code row fails, the API key row is about the key and stays fine
  const noClaude = (async (c: string) => ({ ok: c !== "claude", out: "x 1.0" })) as typeof probe
  const gone = await basics({ probe: noClaude, node: "22.12.0", platform: "darwin", secrets: { DOBBY_API_KEY: "sk" }, env: {}, configPath: `${dir}/c.json`, apiKeyMode: true, fetch: answer(200) })
  assert.deepEqual(gone.filter((r) => r.name === "Claude Code" || r.name === "API key").map((r) => [r.name, r.ok]), [["Claude Code", false], ["API key", true]])
})

test("shell: zsh when on PATH, else bash, else plain sh without the login flag", () => {
  const bin = mkdtempSync(`${tmpdir()}/dobby-shell-`)
  assert.deepEqual(loginShell("x", bin), ["sh", ["-c", "x"]])
  writeFileSync(`${bin}/bash`, "")
  assert.deepEqual(loginShell("x", bin), ["bash", ["-lc", "x"]])
  writeFileSync(`${bin}/zsh`, "")
  assert.equal(shellName(bin), "zsh")
})

test("doctor: a loaded job that runs another checkout's bin/dobby fails the jobs row; this checkout's passes", async () => {
  const dir = mkdtempSync(`${tmpdir()}/dobby-bin-`)
  let oldLoaded = false
  const probe = async (_c: string, a: string[]) => ({ ok: oldLoaded || !a.at(-1)!.includes("telegram"), out: "x 1.0\nId=u\nActiveState=active\nExecMainStatus=0" })
  const row = async (os: "darwin" | "linux", at: string) => (await basics({ exists: () => true, probe, node: "24.18.0", platform: os, uid: 501, secrets: {}, env: {}, configPath: `${dir}/c.json`, jobs: true, bin: "/here/bin/dobby", home: "/h", read: () => (os === "linux" ? unitsFor(JOBS[0], at, "/h")[0].text : plistFor(JOBS[0], at, "/h")) })).find((r) => r.name === "background jobs")!
  for (const os of ["darwin", "linux"] as const) {
    const bad = await row(os, "/old/foreman/bin/dobby"), good = await row(os, "/here/bin/dobby")
    assert.deepEqual([bad.ok, bad.detail, bad.fix], [false, "runs another install: /old/foreman/bin/dobby", "dobby jobs install"])
    assert.deepEqual([good.ok, good.detail], [true, "6 loaded"])
    oldLoaded = true // an install from before the rename still has the telegram job
    const old = await row(os, "/here/bin/dobby")
    assert.deepEqual([old.ok, old.detail, old.fix], [false, "the old telegram job is still loaded (now listener)", "dobby jobs install"])
    oldLoaded = false
  }
  assert.equal(installedBin(JOBS[0], "darwin", "/h", () => { throw new Error("gone") }), undefined)
})

test("doctor: config warnings row is ok when none, optional for a dropped setting, required for a dropped safety key", async () => {
  const dir = mkdtempSync(`${tmpdir()}/dobby-checks-`)
  const probe = async () => ({ ok: true, out: "x 1.0" })
  const row = async (warnings: string[]) => (await basics({ probe, node: "24.18.0", platform: "darwin", secrets: {}, env: {}, configPath: `${dir}/c.json`, warnings })).find((r) => r.name === "config warnings")!
  assert.deepEqual([(await row([])).ok, (await row([])).required], [true, false])
  const q = await row(["/c.json: quietHours.start: got 25; allowed: at most 23"])
  assert.deepEqual([q.ok, q.required, q.fix], [false, false, "dobby config path"])
  assert.equal((await row(["/c.json: safety.preset: got \"yolo\"; allowed: strict, balanced, autonomous"])).required, true)
  assert.match((await row(["a", "b", "c", "d", "e"])).detail, /^a; b; c; \+2 more$/)
})

test("jobs: install moves an old telegram job to listener; uninstall removes both names", () => {
  const home = mkdtempSync(`${tmpdir()}/dobby-jobs-old-`)
  mkdirSync(`${home}/Library/LaunchAgents`, { recursive: true })
  const oldPlist = `${home}/Library/LaunchAgents/com.dobby.telegram.plist`
  writeFileSync(oldPlist, "<plist/>")
  const calls: string[] = [], logs: string[] = []
  const run: Run = (c, a) => (calls.push(`${c} ${a.join(" ")}`), { ok: true, out: "" })
  installJobs({ bin: "/b", home, uid: 501, os: "darwin", run, log: (s) => logs.push(s) })
  assert.ok(calls.includes("launchctl bootout gui/501/com.dobby.telegram"))
  assert.equal(existsSync(oldPlist), false)
  assert.equal(existsSync(`${home}/Library/LaunchAgents/com.dobby.listener.plist`), true)
  assert.deepEqual(logs, ["moved the telegram job to listener"])
  writeFileSync(oldPlist, "<plist/>")
  const out = uninstallJobs({ bin: "/b", home, uid: 501, os: "darwin", run })
  assert.ok(out.includes("removed com.dobby.telegram") && out.includes("removed com.dobby.listener"))
  assert.equal(existsSync(oldPlist), false)
  // linux: the old unit is disabled and its files deleted
  const lhome = mkdtempSync(`${tmpdir()}/dobby-jobs-old-`)
  mkdirSync(`${lhome}/.config/systemd/user`, { recursive: true })
  writeFileSync(`${lhome}/.config/systemd/user/dobby-telegram.service`, "[Unit]")
  const lcalls: string[] = []
  installJobs({ bin: "/b", home: lhome, uid: 1000, os: "linux", run: (c, a) => (lcalls.push(`${c} ${a.join(" ")}`), { ok: true, out: "" }), log: () => {} })
  assert.ok(lcalls.includes("systemctl --user disable --now dobby-telegram.service"))
  assert.equal(existsSync(`${lhome}/.config/systemd/user/dobby-telegram.service`), false)
})

test("jobs: a bootstrap that fails right after bootout is retried", () => {
  const home = mkdtempSync(`${tmpdir()}/dobby-jobs-retry-`)
  let boots = 0, waits = 0
  const run = (c: string, a: string[]) => a[0] === "bootstrap" && a[2].includes("listener") ? { ok: ++boots > 1, out: boots > 1 ? "" : "Bootstrap failed: 5: Input/output error" } : { ok: true, out: "" }
  const rows = installJobs({ bin: "/b", home, uid: 501, run, log: () => {}, sleepMs: () => { waits++ }, only: ["listener"] })
  assert.deepEqual(rows.map((r) => r.ok), [true])
  assert.equal(boots, 2)
  assert.equal(waits, 1)
})

test("jobs: node's folder comes first, then claude and gh; a short env allowlist is copied; secrets are not", () => {
  const bin = mkdtempSync(`${tmpdir()}/dobby-tools-`)
  for (const n of ["claude", "gh"]) { mkdirSync(`${bin}/${n}-dir`); writeFileSync(`${bin}/${n}-dir/${n}`, "") }
  const env = { PATH: `${bin}/claude-dir:${bin}/gh-dir:/usr/bin`, HTTPS_PROXY: "http://p:1", NODE_EXTRA_CA_CERTS: "/c.pem", SSH_AUTH_SOCK: "/s", ANTHROPIC_API_KEY: "sk-secret", AWS_SECRET_ACCESS_KEY: "x", AWS_PROFILE: "me", GH_TOKEN: "t", HOME: "/h" }
  assert.deepEqual(keepEnv(env), { HTTPS_PROXY: "http://p:1", NODE_EXTRA_CA_CERTS: "/c.pem", SSH_AUTH_SOCK: "/s", AWS_PROFILE: "me" })
  const ctx = jobCtx(env, "/home/me/.nvm/versions/node/v24.1.0/bin/node")
  assert.deepEqual(ctx.lead, ["/home/me/.nvm/versions/node/v24.1.0/bin", `${bin}/claude-dir`, `${bin}/gh-dir`])
  const plist = plistFor(JOBS[0], "/b", "/h", ctx)
  assert.match(plist, /<key>PATH<\/key><string>\/home\/me\/\.nvm\/versions\/node\/v24\.1\.0\/bin:/)
  assert.match(plist, /<key>HTTPS_PROXY<\/key><string>http:\/\/p:1<\/string>/)
  assert.doesNotMatch(plist, /sk-secret|GH_TOKEN/)
  const unit = unitsFor(JOBS[0], "/b", "/h", ctx)[0].text
  assert.match(unit, /Environment="PATH=\/home\/me\/\.nvm[^\n]*\n[\s\S]*Environment="SSH_AUTH_SOCK=\/s"/)
})

test("jobs: loaded is not running; the last exit code says a crash loop", () => {
  assert.deepEqual(jobState("darwin", { ok: true, out: "state = running\n\tlast exit code = 127\n" }), { loaded: true, failing: "exit 127" })
  assert.deepEqual(jobState("darwin", { ok: true, out: "state = running\n\tlast exit code = (never exited)\n" }), { loaded: true })
  assert.deepEqual(jobState("darwin", { ok: true, out: "last exit code = 0" }), { loaded: true })
  assert.deepEqual(jobState("darwin", { ok: false, out: "" }), { loaded: false })
  const timer = "Id=dobby-cos.timer\nActiveState=active\n\nId=dobby-cos.service\nActiveState=inactive\nExecMainStatus=1\n"
  assert.deepEqual(jobState("linux", { ok: true, out: timer }), { loaded: true, failing: "exit 1" })
  assert.deepEqual(jobState("linux", { ok: true, out: "Id=dobby-tick.service\nActiveState=activating\nExecMainStatus=127\n" }), { loaded: true, failing: "exit 127" })
  assert.deepEqual(jobState("linux", { ok: true, out: "Id=dobby-tick.service\nActiveState=inactive\nExecMainStatus=0\n" }), { loaded: false })
})

test("jobs: install shows a failing last run, a bin that cannot start, a copy in the npx cache, no systemd bus, missing lingering, SSH-only Macs", () => {
  const home = mkdtempSync(`${tmpdir()}/dobby-jobs-fail-`)
  const ok = { ok: true, out: "" }
  // a loaded job whose last run failed is not ok
  const crash: Run = (c, a) => (a[0] === "print" ? { ok: true, out: "last exit code = 127" } : ok)
  const rows = installJobs({ bin: "/b", home, uid: 501, run: crash, log: () => {}, only: ["tick"] })
  assert.deepEqual([rows[0].ok, /last run failed \(exit 127\)/.test(rows[0].detail)], [false, true])
  // bin --version fails under the job's env: nothing is written, the error is on every row
  const calls: string[] = []
  const dead: Run = (c, a, env) => (calls.push(`${c} ${a.join(" ")} ${env?.PATH?.split(":")[0]}`), a[0] === "--version" ? { ok: false, out: "env: node: No such file or directory" } : ok)
  const home2 = mkdtempSync(`${tmpdir()}/dobby-jobs-fail-`)
  const r2 = installJobs({ bin: "/b", home: home2, uid: 501, run: dead, log: () => {}, node: "/n/bin/node" })
  assert.ok(r2.every((r) => !r.ok && /--version failed: env: node: No such file/.test(r.detail)))
  assert.deepEqual(calls, ["/b --version /n/bin"])
  assert.equal(existsSync(plistPath(home2, JOBS[0])), false)
  // npx cache and temp folders are refused
  for (const bin of ["/Users/me/.npm/_npx/abc/node_modules/dobby-ai/bin/dobby", "/tmp/bunx-501-dobby-ai@latest/node_modules/dobby-ai/bin/dobby", `${tmpdir()}/x/bin/dobby`])
    assert.match(installJobs({ bin, home, uid: 501, run: () => ok, log: () => {} })[0].detail, /temporary folder.*npm i -g dobby-ai/)
  assert.equal(ephemeral("/usr/local/lib/node_modules/dobby-ai/bin/dobby", ["/tmp"]), false)
  // Linux: no user bus
  const nobus: Run = (c, a) => (a[1] === "show-environment" ? { ok: false, out: "Failed to connect to bus" } : ok)
  assert.match(installJobs({ bin: "/b", home, uid: 1000, os: "linux", run: nobus, log: () => {} })[0].detail, /no systemd user session.*dobby start in tmux.*wsl\.conf/)
  // Linux: lingering refused
  const logs: string[] = []
  const nolinger: Run = (c, a) => (a[0] === "show-user" ? { ok: true, out: "Linger=no" } : { ok: true, out: "ActiveState=active\nExecMainStatus=0" })
  installJobs({ bin: "/b", home: mkdtempSync(`${tmpdir()}/dobby-l-`), uid: 1000, os: "linux", run: nolinger, log: (s) => logs.push(s), user: "ann" })
  assert.deepEqual(logs, ["Jobs stop when you log out. Run: sudo loginctl enable-linger ann"])
  // macOS over SSH: no gui session
  const nogui: Run = (c, a) => (a[0] === "bootstrap" || a[0] === "print" ? { ok: false, out: "Bootstrap failed: 125: Domain does not support specified action" } : ok)
  const ssh = installJobs({ bin: "/b", home: mkdtempSync(`${tmpdir()}/dobby-s-`), uid: 501, run: nogui, log: () => {}, only: ["tick"], sleepMs: () => {}, env: { SSH_CONNECTION: "1 2 3 4" } })
  assert.match(ssh[0].detail, /log in on its screen once.*dobby jobs install/)
  const local = installJobs({ bin: "/b", home: mkdtempSync(`${tmpdir()}/dobby-s-`), uid: 501, run: nogui, log: () => {}, only: ["tick"], sleepMs: () => {}, env: {} })
  assert.match(local[0].detail, /Login Items/)
})

test("jobs: old com.foreman.* jobs are booted out and their plists removed", () => {
  const home = mkdtempSync(`${tmpdir()}/dobby-foreman-`)
  mkdirSync(`${home}/Library/LaunchAgents`, { recursive: true })
  writeFileSync(`${home}/Library/LaunchAgents/com.foreman.tick.plist`, "<plist/>")
  const calls: string[] = []
  installJobs({ bin: "/b", home, uid: 501, os: "darwin", run: (c, a) => (calls.push(`${c} ${a.join(" ")}`), { ok: true, out: "" }), log: () => {}, only: ["dashboard"] })
  assert.ok(calls.includes("launchctl bootout gui/501/com.foreman.tick"))
  assert.equal(existsSync(`${home}/Library/LaunchAgents/com.foreman.tick.plist`), false)
})

test("the srt runner resolves where node finds it, not at ROOT/node_modules/.bin (hoisted under npx)", async () => {
  const { srtCli } = await import("../src/lib.ts")
  const f = srtCli()
  assert.ok(existsSync(f) && f.endsWith("/@anthropic-ai/sandbox-runtime/dist/cli.js"), f)
  // a layout like npx: the package at <cache>/node_modules/dobby-ai, the runner hoisted to <cache>/node_modules/@anthropic-ai
  const cache = mkdtempSync(`${tmpdir()}/dobby-npx-`)
  mkdirSync(`${cache}/node_modules/@anthropic-ai/sandbox-runtime/dist`, { recursive: true }); mkdirSync(`${cache}/node_modules/dobby-ai/dist`, { recursive: true })
  writeFileSync(`${cache}/node_modules/@anthropic-ai/sandbox-runtime/package.json`, '{"name":"@anthropic-ai/sandbox-runtime","version":"0.0.0","main":"dist/index.js"}')
  writeFileSync(`${cache}/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js`, "")
  assert.equal(srtCli(`file://${cache}/node_modules/dobby-ai/dist/lib.js`), realpathSync(`${cache}/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js`))
})

test("install: global install returns the package folder; a failed npm says why; bin/dobby says so when node is old or missing", async () => {
  const { installGlobal, onPath } = await import("../src/install.ts")
  const calls: string[] = []
  const run: Run = (c, a) => (calls.push(`${c} ${a.join(" ")}`), { ok: true, out: a[0] === "root" ? "/g/lib/node_modules\n" : "" })
  assert.deepEqual(installGlobal("1.2.3", run, () => true), { ok: true, root: "/g/lib/node_modules/dobby-ai/" })
  assert.deepEqual(calls, ["npm i -g dobby-ai@1.2.3", "npm root -g"])
  assert.deepEqual(installGlobal("1", () => ({ ok: false, out: "EACCES: permission denied" }), () => true), { ok: false, why: "EACCES: permission denied" })
  assert.equal(onPath("/nonexistent"), false)
  // bin/dobby: a fake node on PATH that is too old, then no node at all
  const { spawnSync } = await import("node:child_process")
  const d = mkdtempSync(`${tmpdir()}/dobby-oldnode-`)
  writeFileSync(`${d}/node`, "#!/bin/sh\necho v22.1.0\n", { mode: 0o755 })
  const old = spawnSync("/bin/sh", [`${process.cwd()}/bin/dobby`, "--version"], { encoding: "utf8", env: { PATH: `${d}:/usr/bin:/bin`, HOME: d } })
  assert.deepEqual([old.status, /Node 22\.1\.0 is too old\. Install Node 24 or newer/.test(old.stderr)], [1, true])
  const none = spawnSync("/bin/sh", [`${process.cwd()}/bin/dobby`, "--version"], { encoding: "utf8", env: { PATH: "/nonexistent", HOME: d } })
  assert.deepEqual([none.status, /node was not found/.test(none.stderr)], [1, true])
})

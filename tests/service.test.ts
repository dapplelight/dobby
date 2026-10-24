import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { plan, requireConfig, service, startConflicts, type Run, type Spec } from "../src/service.ts"

const dir = mkdtempSync(`${tmpdir()}/foreman-service-`)
const spec: Spec = { exec: ["/usr/bin/node", "--no-warnings", "/opt/my foreman/src/cli.ts", "start"], path: "/usr/bin:/bin", log: `${dir}/logs/service.log`, home: dir, uid: 501 }

test("start: refuses without a config file, runs with one", () => {
  const was = process.env.DOBBY_CONFIG
  process.env.DOBBY_CONFIG = `${dir}/nope.json`
  assert.throws(() => requireConfig(), /dobby migrate/)
  process.env.DOBBY_CONFIG = `${dir}/yes.json`
  assert.throws(() => requireConfig(), /dobby migrate/)
  writeFileSync(`${dir}/yes.json`, "{}")
  requireConfig()
  was === undefined ? delete process.env.DOBBY_CONFIG : (process.env.DOBBY_CONFIG = was)
})

test("macOS: plist text and launchctl argument arrays, new label only", () => {
  const p = plan("darwin", spec)
  assert.equal(p.file, `${dir}/Library/LaunchAgents/com.dobby.service.plist`)
  assert.match(p.text, /<key>Label<\/key><string>com\.dobby\.service<\/string>/)
  assert.match(p.text, /<array><string>\/usr\/bin\/node<\/string><string>--no-warnings<\/string><string>\/opt\/my foreman\/src\/cli\.ts<\/string><string>start<\/string><\/array>/)
  assert.match(p.text, /<key>KeepAlive<\/key><true\/>/)
  assert.doesNotMatch(p.text, /com\.dobby\.(tick|telegram)/)
  assert.deepEqual(p.install, [
    { cmd: "launchctl", args: ["bootout", "gui/501/com.dobby.service"], ignoreFailure: true },
    { cmd: "launchctl", args: ["bootstrap", "gui/501", p.file] },
  ])
  assert.deepEqual(p.uninstall, [{ cmd: "launchctl", args: ["bootout", "gui/501/com.dobby.service"], ignoreFailure: true }])
})

test("Linux: unit text quotes every word, systemctl --user argument arrays", () => {
  const p = plan("linux", spec)
  assert.equal(p.file, `${dir}/.config/systemd/user/dobby.service`)
  assert.match(p.text, /^ExecStart="\/usr\/bin\/node" "--no-warnings" "\/opt\/my foreman\/src\/cli\.ts" "start"$/m)
  assert.match(p.text, /^Restart=always$/m)
  assert.match(p.text, /^WantedBy=default\.target$/m)
  assert.deepEqual(p.install.map((s) => s.args), [["--user", "daemon-reload"], ["--user", "enable", "dobby.service"], ["--user", "restart", "dobby.service"], ["enable-linger"]])
  assert.deepEqual(p.uninstall.map((s) => s.args), [["--user", "disable", "--now", "dobby.service"]])
  assert.throws(() => plan("win32", spec), /not available on win32/)
})

test("macOS install refuses while the owner's tick or telegram job is loaded, and names the bootout commands", () => {
  const p = plan("darwin", spec)
  const calls: string[] = []
  const loaded = new Set(["gui/501/com.dobby.tick"])
  const run: Run = (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { ok: args[0] !== "print" || loaded.has(args[1]), out: "" } }
  assert.throws(() => service("install", false, p, run, () => {}), /launchctl bootout gui\/501\/com\.dobby\.tick/)
  assert.equal(existsSync(p.file), false)
  assert.equal(calls.some((c) => c.includes("bootstrap")), false)
  loaded.clear()
  service("install", false, p, run, () => {})
  assert.equal(calls.at(-1), `launchctl bootstrap gui/501 ${p.file}`)
})

test("macOS install also refuses while the owner's plists are still in LaunchAgents (they load again at login)", () => {
  const p = plan("darwin", spec)
  mkdirSync(dirname(p.file), { recursive: true })
  writeFileSync(p.conflictFiles[0], "x")
  const run: Run = () => ({ ok: false, out: "" }) // nothing loaded right now
  assert.throws(() => service("install", false, p, run, () => {}), /mv .*com\.dobby\.tick\.plist/)
  rmSync(p.conflictFiles[0])
})

test("service: --dry prints the file and commands and runs nothing; install writes and runs; uninstall removes", () => {
  const p = plan("linux", spec)
  const calls: string[] = []
  const run: Run = (cmd, args) => { if (args[1] === "is-active") return { ok: false, out: "" }; calls.push([cmd, ...args].join(" ")); return { ok: true, out: "" } } // the jobs are not running
  const out: string[] = []
  service("install", true, p, run, (s) => out.push(s))
  assert.deepEqual(calls, [])
  assert.equal(existsSync(p.file), false)
  assert.match(out.join("\n"), /ExecStart=[\s\S]*systemctl --user enable dobby\.service/)
  service("install", false, p, run, () => {})
  assert.equal(readFileSync(p.file, "utf8"), p.text)
  assert.deepEqual(calls, ["systemctl --user daemon-reload", "systemctl --user enable dobby.service", "systemctl --user restart dobby.service", "loginctl enable-linger"])
  service("uninstall", false, p, run, () => {})
  assert.equal(existsSync(p.file), false)
  assert.throws(() => service("nope", false, p, run, () => {}), /usage/)
  assert.throws(() => service("install", false, p, () => ({ ok: false, out: "boom" }), () => {}), /boom/)
})

test("start refuses beside the owner's jobs or the service; the service itself only minds the owner's jobs", () => {
  const loaded = new Set<string>()
  const run: Run = (_c, args) => ({ ok: loaded.has(args.at(-1)!) || loaded.has(args[1]), out: "" })
  assert.deepEqual(startConflicts("darwin", 501, run, false), [])
  loaded.add("gui/501/com.dobby.telegram")
  assert.match(startConflicts("darwin", 501, run, false)[0], /telegram is loaded/)
  loaded.clear(); loaded.add("gui/501/com.dobby.service")
  assert.equal(startConflicts("darwin", 501, run, false).length, 1)
  assert.equal(startConflicts("darwin", 501, run, true).length, 0) // the service is itself
  loaded.clear(); loaded.add("dobby.service")
  assert.equal(startConflicts("linux", 1000, run, false).length, 1)
  assert.equal(startConflicts("linux", 1000, run, true).length, 0)
  loaded.clear(); loaded.add("dobby-tick.service") // the background jobs run a queue loop too
  assert.match(startConflicts("linux", 1000, run, true)[0], /dobby-tick.service is running \(dobby jobs uninstall\)/)
})

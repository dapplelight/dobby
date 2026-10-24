// `dobby start` guard and `dobby service install|uninstall`: one background service that runs `dobby start`.
// launchd (macOS) and systemd --user (Linux). File text and commands are built as data; commands run as argument arrays, never a shell.
// The labels below are new on purpose: the owner's own com.dobby.* launchd jobs are never touched.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { privatePath } from "./config.ts"

/** Run a program with an argument array (no shell). `out` is stdout on success, everything it said on failure. */
export type Run = (cmd: string, args: string[], cwd?: string) => { ok: boolean; out: string }
const realRun: Run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" })
  return { ok: r.status === 0, out: r.status === 0 ? r.stdout : `${r.stdout ?? ""}${r.stderr ?? ""}${r.error?.message ?? ""}` }
}

export const LABEL = "com.dobby.service"
export const UNIT = "dobby.service"

/** `dobby start` refuses to run before `dobby migrate` has written the private config file. */
export function requireConfig(): void {
  if (!existsSync(privatePath())) throw new Error(`no config at ${privatePath()}: run \`dobby migrate\` first`)
}

/**
 * `dobby start` in a terminal must not run beside the owner's tick/telegram jobs or the installed service: two listeners handle every tap twice.
 * Returns the reasons it should refuse (empty = fine). The service itself (DOBBY_SERVICE=1) only checks for the owner's jobs.
 */
export function startConflicts(os: NodeJS.Platform, uid: number, run: Run = realRun, asService = !!process.env.DOBBY_SERVICE): string[] {
  if (os === "darwin") return ["tick", "telegram", ...(asService ? [] : ["service"])].filter((j) => run("launchctl", ["print", `gui/${uid}/com.dobby.${j}`]).ok).map((j) => `com.dobby.${j} is loaded (launchctl bootout gui/${uid}/com.dobby.${j})`)
  if (os === "linux") return [...["tick", "telegram"].map((j) => `dobby-${j}.service`), ...(asService ? [] : [UNIT])].filter((u) => run("systemctl", ["--user", "is-active", u]).ok).map((u) => `${u} is running (${u === UNIT ? "dobby service uninstall" : "dobby jobs uninstall"})`)
  return []
}

export type Spec = { exec: string[]; path: string; log: string; home: string; uid: number }
export type Step = { cmd: string; args: string[]; ignoreFailure?: boolean }
/** `conflicts`: read-only probes; one that succeeds means the owner's own jobs are loaded and would run beside the service. `conflictFiles`: their plists, which would load them again at the next login. */
export type Plan = { file: string; text: string; log: string; install: Step[]; uninstall: Step[]; conflicts: Step[]; conflictFiles: string[] }

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export const plist = (s: Spec) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${s.exec.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(s.path)}</string><key>DOBBY_SERVICE</key><string>1</string></dict>
  <key>StandardOutPath</key><string>${xml(s.log)}</string>
  <key>StandardErrorPath</key><string>${xml(s.log)}</string>
</dict>
</plist>
`

// systemd splits ExecStart on spaces and expands %: quote every word, double the %.
const word = (a: string) => `"${a.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`

export const unit = (s: Spec) => `[Unit]
Description=Dobby: listener and queue loop

[Service]
ExecStart=${s.exec.map(word).join(" ")}
Environment=${word(`PATH=${s.path}`)}
Environment=DOBBY_SERVICE=1
Restart=always
RestartSec=60
StandardOutput=append:${s.log}
StandardError=append:${s.log}

[Install]
WantedBy=default.target
`

export function plan(os: NodeJS.Platform, s: Spec): Plan {
  if (os === "darwin") {
    const file = `${s.home}/Library/LaunchAgents/${LABEL}.plist`
    const target = `gui/${s.uid}/${LABEL}`
    return {
      file, text: plist(s), log: s.log,
      install: [{ cmd: "launchctl", args: ["bootout", target], ignoreFailure: true }, { cmd: "launchctl", args: ["bootstrap", `gui/${s.uid}`, file] }],
      uninstall: [{ cmd: "launchctl", args: ["bootout", target], ignoreFailure: true }],
      conflicts: ["tick", "telegram"].map((j) => ({ cmd: "launchctl", args: ["print", `gui/${s.uid}/com.dobby.${j}`] })),
      conflictFiles: ["tick", "telegram"].map((j) => `${s.home}/Library/LaunchAgents/com.dobby.${j}.plist`),
    }
  }
  if (os === "linux") {
    const file = `${s.home}/.config/systemd/user/${UNIT}`
    const reload: Step = { cmd: "systemctl", args: ["--user", "daemon-reload"] }
    return {
      file, text: unit(s), log: s.log,
      install: [reload, { cmd: "systemctl", args: ["--user", "enable", UNIT] }, { cmd: "systemctl", args: ["--user", "restart", UNIT] },
        // a user unit stops with the last login session unless lingering is on (headless boxes); not fatal where polkit says no
        { cmd: "loginctl", args: ["enable-linger"], ignoreFailure: true }], // restart: enable --now leaves an already running unit on the old ExecStart
      uninstall: [{ cmd: "systemctl", args: ["--user", "disable", "--now", UNIT], ignoreFailure: true }],
      conflicts: ["tick", "telegram"].map((j) => ({ cmd: "systemctl", args: ["--user", "is-active", `dobby-${j}.service`] })),
      conflictFiles: [],
    }
  }
  throw new Error(`dobby service is not available on ${os} yet: run \`dobby start\` in a terminal`)
}

/** `dobby service install|uninstall [--dry]`. `dry` prints the file and the commands and changes nothing. */
export function service(action: string | undefined, dry: boolean, p: Plan, run: Run = realRun, log = (s: string) => console.log(s)): void {
  if (action !== "install" && action !== "uninstall") throw new Error("usage: service install|uninstall [--dry]")
  const steps = action === "install" ? p.install : p.uninstall
  const show = (s: Step) => `${s.cmd} ${s.args.join(" ")}`
  if (action === "install") {
    // the owner's tick and telegram jobs also run a listener and a queue loop: both together handle every tap twice
    const loaded = p.conflicts.filter((s) => run(s.cmd, s.args).ok).map((s) => s.args[1])
    const plists = p.conflictFiles.filter((f) => existsSync(f))
    if (loaded.length && p.conflicts[0]?.cmd === "systemctl") throw new Error("Dobby's background jobs would run beside the service and double every Discord tap and queue run. Remove them first: dobby jobs uninstall")
    if (loaded.length || plists.length) throw new Error(`the owner's launchd jobs would run beside the service and double every Discord tap and queue run. Stop them and move their plists away (bootout alone comes back at the next login):\n${[...loaded.map((t) => `launchctl bootout ${t}`), ...plists.map((f) => `mv ${f} ~/`)].join("\n")}`)
  }
  if (dry) {
    log(`dry run, nothing changed.${action === "install" ? `\nwould write ${p.file}:\n${p.text}` : `\nwould remove ${p.file}`}\nwould run:\n${steps.map(show).join("\n")}`)
    return
  }
  if (action === "install") {
    mkdirSync(dirname(p.file), { recursive: true })
    mkdirSync(dirname(p.log), { recursive: true })
    writeFileSync(p.file, p.text)
    log(`wrote ${p.file}`)
  }
  for (const s of steps) {
    const r = run(s.cmd, s.args)
    log(`${r.ok ? "ok  " : s.ignoreFailure ? "skip" : "FAIL"} ${show(s)}`)
    if (!r.ok && !s.ignoreFailure) throw new Error(r.out.trim() || `${show(s)} failed`)
  }
  if (action === "uninstall") {
    rmSync(p.file, { force: true })
    log(`removed ${p.file}`)
  }
}

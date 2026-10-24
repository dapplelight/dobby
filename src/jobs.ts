// Dobby's background jobs, as data: launchd on macOS (one plist per job), systemd --user on Linux (one service per job,
// plus a timer for the hourly and daily ones). Installed and removed with argument-array commands, never a shell.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"

/** every = seconds between runs (0 = always on, restarted after it exits); at = daily [hour, minute], not at load. */
export type Job = { name: string; cmd: string; every?: number; at?: [number, number]; what: string }
export const JOBS: Job[] = [
  { name: "tick", cmd: "tick", every: 0, what: "always on: plans and builds the next ticket" },
  { name: "telegram", cmd: "listen", every: 0, what: "always on: the Discord listener" },
  { name: "dashboard", cmd: "dashboard", every: 0, what: "always on: http://127.0.0.1:4710" },
  { name: "health", cmd: "health", every: 3600, what: "hourly: jobs, disk and pipeline checks" },
  { name: "cos", cmd: "cos", at: [8, 5], what: "daily 08:05: the morning brief" },
  { name: "graphify", cmd: "graphify", at: [5, 30], what: "daily 05:30: code maps" },
]
export type Run = (cmd: string, args: string[]) => { ok: boolean; out: string }
const realRun: Run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` } }
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
// systemd splits ExecStart on spaces and expands %: quote every word, double the %.
const word = (a: string) => `"${a.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`

export const label = (j: Job) => `com.dobby.${j.name}`
export const plistPath = (home: string, j: Job) => `${home}/Library/LaunchAgents/${label(j)}.plist`

/** The plist for one job. `bin` = this checkout's bin/dobby; PATH covers fnm, bun and Homebrew so jobs find node, gh and claude. */
export function plistFor(j: Job, bin: string, home: string): string {
  const when = j.at
    ? `<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${j.at[0]}</integer><key>Minute</key><integer>${j.at[1]}</integer></dict>`
    : j.every ? `<key>StartInterval</key><integer>${j.every}</integer>` : `<key>KeepAlive</key><true/>`
  const throttle = j.name === "tick" ? "<key>ThrottleInterval</key><integer>60</integer>" : "" // always running, 60 s between runs
  const path = `${home}/.local/share/fnm/aliases/default/bin:${home}/.local/bin:${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
  const log = xml(`${home}/.local/share/dobby/logs/${j.name}.log`)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(j)}</string>
  <key>ProgramArguments</key><array><string>${xml(bin)}</string><string>${j.cmd}</string></array>
  ${when}${throttle}
  <key>RunAtLoad</key><${j.at ? "false" : "true"}/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`
}

export const unitName = (j: Job) => `dobby-${j.name}`
const unitDir = (home: string) => `${home}/.config/systemd/user`
/** The unit enabled and checked for a job: its timer when it runs on a schedule, else the service itself. */
export const unitFor = (j: Job) => `${unitName(j)}.${j.every || j.at ? "timer" : "service"}`
const two = (n: number) => String(n).padStart(2, "0")

/** systemd files for one job: always-on = a service that restarts after it exits (tick waits 60 s, like launchd's throttle); hourly and daily = a oneshot service plus a timer. */
export function unitsFor(j: Job, bin: string, home: string): { file: string; text: string }[] {
  const path = `${home}/.local/share/fnm/aliases/default/bin:${home}/.local/bin:${home}/.bun/bin:/usr/local/bin:/usr/bin:/bin`
  const log = `${home}/.local/share/dobby/logs/${j.name}.log`
  const timed = !!(j.every || j.at)
  const service = `[Unit]
Description=Dobby ${j.name}: ${j.what}

[Service]
${timed ? "Type=oneshot" : `Restart=always\nRestartSec=${j.name === "tick" ? 60 : 10}`}
ExecStart=${[bin, j.cmd].map(word).join(" ")}
Environment=${word(`PATH=${path}`)}
StandardOutput=append:${log}
StandardError=append:${log}
${timed ? "" : "\n[Install]\nWantedBy=default.target\n"}`
  const files = [{ file: `${unitDir(home)}/${unitName(j)}.service`, text: service }]
  if (timed) files.push({ file: `${unitDir(home)}/${unitName(j)}.timer`, text: `[Unit]
Description=Dobby ${j.name} timer

[Timer]
${j.at ? `OnCalendar=*-*-* ${two(j.at[0])}:${two(j.at[1])}:00` : `OnBootSec=60\nOnUnitActiveSec=${j.every}`}
Persistent=true

[Install]
WantedBy=timers.target
` })
  return files
}

/** The read-only probe that says a job is loaded: launchd knows it, or its systemd unit is active. */
export const loadedProbe = (j: Job, os: NodeJS.Platform, uid: number): [string, string[]] =>
  os === "linux" ? ["systemctl", ["--user", "is-active", unitFor(j)]] : ["launchctl", ["print", `gui/${uid}/${label(j)}`]]

const picked = (o: { only?: string[] }) => (o.only ? JOBS.filter((j) => o.only!.includes(j.name)) : JOBS)
/** `only`: these job names (dobby add dashboard); default all six. */
type Opts = { bin: string; home: string; uid: number; only?: string[]; os?: NodeJS.Platform; run?: Run; dry?: boolean; log?: (s: string) => void }
/** Write every plist (or unit) and (re)load it. A row ticks only when launchd or systemd reports the job loaded. */
export function installJobs(o: Opts): { name: string; ok: boolean; detail: string }[] {
  const run = o.run ?? realRun, log = o.log ?? console.log, JOBS = picked(o)
  if ((o.os ?? process.platform) === "linux") return installUnits(o, run, log)
  if (!o.dry) mkdirSync(`${o.home}/.local/share/dobby/logs`, { recursive: true }), mkdirSync(`${o.home}/Library/LaunchAgents`, { recursive: true })
  return JOBS.map((j) => {
    const f = plistPath(o.home, j)
    if (o.dry) { log(`would write ${f} and load ${label(j)}`); return { name: j.name, ok: true, detail: "dry run" } }
    writeFileSync(f, plistFor(j, o.bin, o.home))
    run("launchctl", ["bootout", `gui/${o.uid}/${label(j)}`]) // not loaded yet is fine
    const boot = run("launchctl", ["bootstrap", `gui/${o.uid}`, f])
    const loaded = run("launchctl", ["print", `gui/${o.uid}/${label(j)}`]).ok
    return { name: j.name, ok: loaded, detail: loaded ? j.what : `did not load: ${boot.out.trim().split("\n").pop() ?? ""}` }
  })
}

/** Unload every job and delete its plist. Data, config and secrets stay (the caller says where). */
export function uninstallJobs(o: Opts): string[] {
  const run = o.run ?? realRun
  if ((o.os ?? process.platform) === "linux") return uninstallUnits(o, run)
  return JOBS.flatMap((j) => {
    const f = plistPath(o.home, j)
    if (o.dry) return [`would unload ${label(j)} and delete ${f}`]
    const was = run("launchctl", ["bootout", `gui/${o.uid}/${label(j)}`]).ok, had = existsSync(f)
    if (had) rmSync(f)
    return was || had ? [`removed ${label(j)}`] : []
  })
}

function installUnits(o: Opts, run: Run, log: (s: string) => void): { name: string; ok: boolean; detail: string }[] {
  const JOBS = picked(o)
  if (o.dry) return JOBS.map((j) => (log(`would write ${unitsFor(j, o.bin, o.home).map((f) => f.file).join(" and ")} and start ${unitFor(j)}`), { name: j.name, ok: true, detail: "dry run" }))
  mkdirSync(`${o.home}/.local/share/dobby/logs`, { recursive: true }), mkdirSync(unitDir(o.home), { recursive: true })
  for (const j of JOBS) for (const f of unitsFor(j, o.bin, o.home)) writeFileSync(f.file, f.text)
  run("systemctl", ["--user", "daemon-reload"])
  // user units stop at the last logout unless lingering is on (headless boxes); not fatal where polkit says no
  run("loginctl", ["enable-linger"])
  return JOBS.map((j) => {
    const en = run("systemctl", ["--user", "enable", unitFor(j)])
    run("systemctl", ["--user", "restart", unitFor(j)]) // restart, not enable --now: a running unit keeps its old ExecStart otherwise
    const [cmd, args] = loadedProbe(j, "linux", o.uid)
    const loaded = run(cmd, args).ok
    return { name: j.name, ok: loaded, detail: loaded ? j.what : `did not start: ${en.out.trim().split("\n").pop() ?? ""} (journalctl --user -u ${unitName(j)})` }
  })
}

function uninstallUnits(o: Opts, run: Run): string[] {
  const out = JOBS.flatMap((j) => {
    const files = unitsFor(j, o.bin, o.home).map((f) => f.file)
    if (o.dry) return [`would stop ${unitFor(j)} and delete ${files.join(" and ")}`]
    const was = run("systemctl", ["--user", "disable", "--now", unitFor(j)]).ok, had = files.filter((f) => existsSync(f))
    for (const f of had) rmSync(f)
    return was || had.length ? [`removed ${unitName(j)}`] : []
  })
  if (!o.dry && out.length) run("systemctl", ["--user", "daemon-reload"])
  return out
}

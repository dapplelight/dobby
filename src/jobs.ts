// Dobby's background jobs, as data: launchd on macOS (one plist per job), systemd --user on Linux (one service per job,
// plus a timer for the hourly and daily ones). Installed and removed with argument-array commands, never a shell.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { delimiter, dirname } from "node:path"
import { LABEL, plan, recordedDir, sameInstall, service, UNIT } from "./service.ts"

/** every = seconds between runs (0 = always on, restarted after it exits); at = daily [hour, minute], not at load. */
export type Job = { name: string; cmd: string; every?: number; at?: [number, number]; what: string }
export const JOBS: Job[] = [
  { name: "tick", cmd: "tick", every: 0, what: "always on: plans and builds the next ticket" },
  { name: "listener", cmd: "listen", every: 0, what: "always on: the Discord listener" },
  { name: "dashboard", cmd: "dashboard", every: 0, what: "always on: http://127.0.0.1:4710" },
  { name: "health", cmd: "health", every: 3600, what: "hourly: jobs, disk and pipeline checks" },
  { name: "cos", cmd: "cos", at: [8, 5], what: "daily 08:05: the morning brief" },
  { name: "graphify", cmd: "graphify", at: [5, 30], what: "daily 05:30: code maps" },
]
/** The listener's name before the rename: installs from then still have it, so install moves it and uninstall removes it. */
export const OLD_LISTENER: Job = { name: "telegram", cmd: "listen", every: 0, what: "the Discord listener, under its old name" }
export type Run = (cmd: string, args: string[], env?: Record<string, string>) => { ok: boolean; out: string }
const realRun: Run = (cmd, args, env) => { const r = spawnSync(cmd, args, { encoding: "utf8", ...(env ? { env } : {}), timeout: 30_000 }); return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? r.error.message : ""}` } }

/** What a job gets besides the fixed folders: `lead` goes first on PATH, `env` is copied in as it is. */
export type Ctx = { lead?: string[]; env?: Record<string, string> }
/** Env names a job keeps from the shell that installed it: proxy, certificates, GitHub host, SSH agent, Claude, Anthropic, AWS, Google. Anything that looks like a secret stays in secrets.env, not in a plist. */
const KEEP = /^(https?_proxy|all_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|GH_HOST|SSH_AUTH_SOCK|CLAUDE_CODE_.+|DOBBY_DIR|DOBBY_CONFIG|ANTHROPIC_.+|AWS_.+|GOOGLE_.+)$/i
const SECRET = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i
export const keepEnv = (env: NodeJS.ProcessEnv): Record<string, string> => Object.fromEntries(Object.entries(env).filter(([k, v]) => v && KEEP.test(k) && !SECRET.test(k) && !/[\r\n]/.test(v)) as [string, string][])
/** The folder of the first `name` on PATH, if any. */
export const dirOf = (name: string, path = process.env.PATH ?? "", has = existsSync) => path.split(delimiter).find((d) => d && has(`${d}/${name}`))
/** Install-time context: the folder of the node running this (nvm, volta, asdf, mise, fnm: not on a job's PATH otherwise), the folders of claude and gh, and the env to keep. */
export function jobCtx(env: NodeJS.ProcessEnv = process.env, node = process.execPath): Required<Ctx> {
  const lead = [dirname(node), ...["claude", "gh"].map((n) => dirOf(n, env.PATH ?? ""))].filter((d): d is string => !!d)
  return { lead: [...new Set(lead)], env: keepEnv(env) }
}
const joinPath = (lead: string[] | undefined, fixed: string) => [...new Set([...(lead ?? []), ...fixed.split(":")])].join(":")
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
// systemd splits ExecStart on spaces and expands %: quote every word, double the %.
const word = (a: string) => `"${a.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`

export const label = (j: Job) => `com.dobby.${j.name}`
export const plistPath = (home: string, j: Job) => `${home}/Library/LaunchAgents/${label(j)}.plist`

/** The plist for one job. `bin` = this checkout's bin/dobby; PATH covers fnm, bun and Homebrew so jobs find node, gh and claude. */
export function plistFor(j: Job, bin: string, home: string, x: Ctx = {}): string {
  const when = j.at
    ? `<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${j.at[0]}</integer><key>Minute</key><integer>${j.at[1]}</integer></dict>`
    : j.every ? `<key>StartInterval</key><integer>${j.every}</integer>` : `<key>KeepAlive</key><true/>`
  const throttle = j.name === "tick" ? "<key>ThrottleInterval</key><integer>60</integer>" : "" // always running, 60 s between runs
  const path = joinPath(x.lead, `${home}/.local/share/fnm/aliases/default/bin:${home}/.local/bin:${home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)
  const env = Object.entries(x.env ?? {}).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("")
  const log = xml(`${home}/.local/share/dobby/logs/${j.name}.log`)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label(j)}</string>
  <key>ProgramArguments</key><array><string>${xml(bin)}</string><string>${j.cmd}</string></array>
  ${when}${throttle}
  <key>RunAtLoad</key><${j.at ? "false" : "true"}/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string>${env}</dict>
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
export function unitsFor(j: Job, bin: string, home: string, x: Ctx = {}): { file: string; text: string }[] {
  const path = joinPath(x.lead, `${home}/.local/share/fnm/aliases/default/bin:${home}/.local/bin:${home}/.bun/bin:/usr/local/bin:/usr/bin:/bin`)
  const env = Object.entries(x.env ?? {}).map(([k, v]) => `\nEnvironment=${word(`${k}=${v}`)}`).join("")
  const log = `${home}/.local/share/dobby/logs/${j.name}.log`
  const timed = !!(j.every || j.at)
  const service = `[Unit]
Description=Dobby ${j.name}: ${j.what}

[Service]
${timed ? "Type=oneshot" : `Restart=always\nRestartSec=${j.name === "tick" ? 60 : 10}`}
ExecStart=${[bin, j.cmd].map(word).join(" ")}
Environment=${word(`PATH=${path}`)}${env}
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

/** A job is this install's only when its plist (or systemd service file) exists under this HOME and was installed with this process's DOBBY_DIR (an isolated install under the same user and HOME has its own data dir, not the owner's). launchd and systemd labels are per user, not per HOME: a second install under the same user sees the first one's loaded jobs, and must never report, probe or unload them. */
const jobFile = (j: Job, os: NodeJS.Platform, home: string) => (os === "linux" ? `${unitDir(home)}/${unitName(j)}.service` : plistPath(home, j))
export const ownedHere = (j: Job, os: NodeJS.Platform, home: string, has: (f: string) => boolean = existsSync) => has(jobFile(j, os, home)) && sameInstall(jobFile(j, os, home))
/** What a job that is not this install's is called in reports. */
export const NOT_HERE = "not installed here"

/** The read-only probe for one job: launchd's print (it has the last exit code), or systemd's state for its timer and service. */
export const loadedProbe = (j: Job, os: NodeJS.Platform, uid: number): [string, string[]] =>
  os === "linux" ? ["systemctl", ["--user", "show", "-p", "Id,ActiveState,ExecMainStatus", ...(j.every || j.at ? [unitFor(j), `${unitName(j)}.service`] : [unitFor(j)])]] : ["launchctl", ["print", `gui/${uid}/${label(j)}`]]

/** What the probe says: loaded, and whether the job's last run failed. A crash-looping job is loaded; its exit code is what shows it. */
export function jobState(os: NodeJS.Platform, r: { ok: boolean; out: string }): { loaded: boolean; failing?: string } {
  if (os !== "linux") {
    const code = /last exit code = (\d+)/.exec(r.out)?.[1]
    return { loaded: r.ok, ...(r.ok && code && code !== "0" ? { failing: `exit ${code}` } : {}) }
  }
  const blocks = r.out.split(/\n\s*\n/).map((b) => Object.fromEntries(b.split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)))) as Record<string, string>[]
  const code = blocks.at(-1)?.ExecMainStatus
  return { loaded: r.ok && /^(active|activating)$/.test(blocks[0]?.ActiveState ?? ""), ...(code && code !== "0" ? { failing: `exit ${code}` } : {}) }
}

/** The bin/dobby an installed job runs: the plist's first ProgramArguments string, or the unit's ExecStart first word. undefined = no readable file. */
export function installedBin(j: Job, os: NodeJS.Platform, home: string, read: (f: string) => string = (f) => readFileSync(f, "utf8")): string | undefined {
  try {
    if (os === "linux") return read(`${unitDir(home)}/${unitName(j)}.service`).match(/^ExecStart="?([^"\s]+)/m)?.[1]?.replace(/\\(.)/g, "$1").replace(/%%/g, "%")
    return read(plistPath(home, j)).match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/)?.[1]?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  } catch { return undefined }
}

const picked = (o: { only?: string[]; discord?: boolean }) => (o.only ? JOBS.filter((j) => o.only!.includes(j.name)) : JOBS).filter((j) => !(j.name === "listener" && o.discord === false))
/** What install says for the listener when Discord is not set up: it would exit at once and restart every minute, so it is not installed. */
export const LISTENER_SKIPPED = "skipped: Discord is not set up. Run dobby discord, then dobby jobs install"
/** `only`: these job names (dobby add dashboard); default all six. `env`/`node`: the shell and node that install the jobs (default: this process). */
type Opts = { discord?: boolean; bin: string; home: string; uid: number; only?: string[]; os?: NodeJS.Platform; run?: Run; dry?: boolean; log?: (s: string) => void; sleepMs?: (ms: number) => void; env?: NodeJS.ProcessEnv; node?: string; user?: string; startPid?: number }
type Row = { name: string; ok: boolean; detail: string }
/** A bin/dobby inside the npx, bunx or pnpm dlx cache or the temp folder is gone after a cache clean or a reboot: jobs must not point there. */
export const ephemeral = (path: string, tmp: string[] = [tmpdir(), realpathOr(tmpdir())]) => /[\\/](_npx|dlx|bunx-[^\\/]*)[\\/]/.test(path) || tmp.some((t) => path.startsWith(`${t.replace(/\/$/, "")}/`))
const realpathOr = (p: string) => { try { return realpathSync(p) } catch { return p } }
const failAll = (jobs: Job[], detail: string): Row[] => jobs.map((j) => ({ name: j.name, ok: false, detail }))
/** One run of `bin --version` under the job's own PATH and env: the missing node, bad path or old Node a job would die on shows here, not as a restart loop. */
function preflight(o: Opts, run: Run, ctx: Required<Ctx>, fixedPath: string): string | undefined {
  const r = run(o.bin, ["--version"], { PATH: joinPath(ctx.lead, fixedPath), HOME: o.home, ...ctx.env })
  return r.ok ? undefined : `${o.bin} --version failed: ${r.out.trim().split("\n").slice(-2).join(" ") || "no output"}`
}
/** Write every plist (or unit) and (re)load it. A row ticks only when launchd or systemd reports the job loaded and its last run did not fail. */
export function installJobs(o: Opts): Row[] {
  const rows = installPicked(o)
  return o.discord === false && (!o.only || o.only.includes("listener")) ? [...rows, { name: "listener", ok: true, detail: LISTENER_SKIPPED }] : rows
}
function installPicked(o: Opts): Row[] {
  const run = o.run ?? realRun, log = o.log ?? console.log, JOBS = picked(o)
  if (!o.dry && ephemeral(o.bin)) return failAll(JOBS, `${o.bin} is in a temporary folder (npx, bunx or /tmp) that goes away. Run npm i -g dobby-ai, then dobby jobs install`)
  if (!o.dry) {
    const fileOf = (j: Job) => jobFile(j, o.os ?? process.platform, o.home), other = JOBS.find((j) => existsSync(fileOf(j)) && !sameInstall(fileOf(j)))
    if (other) return failAll(JOBS, `${other.name} is already installed for another Dobby install (data in ${recordedDir(fileOf(other)) || "the default folder"}). Jobs are per user, so installing here would take them over: run dobby jobs uninstall from that install first`)
  }
  if (!o.dry) { const clash = serviceClash(o, run, JOBS); if (clash) return failAll(JOBS, clash) }
  if (!o.dry) moveOldListener(o, run, log)
  if ((o.os ?? process.platform) === "linux") return installUnits(o, run, log)
  const ctx = jobCtx(o.env, o.node)
  if (!o.dry) {
    const bad = preflight(o, run, ctx, `${o.home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`)
    if (bad) return failAll(JOBS, bad)
    mkdirSync(`${o.home}/.local/share/dobby/logs`, { recursive: true }), mkdirSync(`${o.home}/Library/LaunchAgents`, { recursive: true })
  }
  return JOBS.map((j) => {
    const f = plistPath(o.home, j)
    if (o.dry) { log(`would write ${f} and load ${label(j)}`); return { name: j.name, ok: true, detail: "dry run" } }
    writeFileSync(f, plistFor(j, o.bin, o.home, ctx), { mode: 0o600 })
    run("launchctl", ["bootout", `gui/${o.uid}/${label(j)}`]) // not loaded yet is fine
    // bootout returns before launchd has let go of the label, so an immediate bootstrap can fail ("Input/output error"): retry
    let boot = run("launchctl", ["bootstrap", `gui/${o.uid}`, f])
    for (let i = 0; i < 3 && !boot.ok; i++) o.sleepMs?.(500) ?? Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500), boot = run("launchctl", ["bootstrap", `gui/${o.uid}`, f])
    const st = jobState("darwin", run("launchctl", ["print", `gui/${o.uid}/${label(j)}`]))
    const why = boot.out.trim().split("\n").pop() ?? ""
    const detail = st.loaded && !st.failing ? j.what
      : st.failing ? `loaded, but the last run failed (${st.failing}): see ${o.home}/.local/share/dobby/logs/${j.name}.log`
      : (o.env ?? process.env).SSH_CONNECTION ? `did not load (${why}). You are on SSH and this Mac has no login session for jobs yet: log in on its screen once (or turn on auto-login), then run dobby jobs install`
      : `did not load: ${why}. If macOS blocked it, allow it in System Settings, General, Login Items & Extensions`
    return { name: j.name, ok: st.loaded && !st.failing, detail }
  })
}

/** The tick and listener jobs beside a running `dobby start` or the installed `dobby service` would each handle every Discord tap and build every ticket. Why not, or undefined. */
function serviceClash(o: Opts, run: Run, jobs: Job[]): string | undefined {
  if (!jobs.some((j) => j.name === "tick" || j.name === "listener")) return undefined // the dashboard only reads the database
  if (o.startPid) return `dobby start is running (pid ${o.startPid}): stop it with Ctrl-C first; the jobs replace it, and every Discord tap would run twice`
  const linux = (o.os ?? process.platform) === "linux"
  const on = existsSync(plan(linux ? "linux" : "darwin", { exec: [], path: "", log: "", home: o.home, uid: o.uid }).file) && (linux ? run("systemctl", ["--user", "is-active", UNIT]).ok : run("launchctl", ["print", `gui/${o.uid}/${LABEL}`]).ok)
  return on ? `the Dobby service (${linux ? UNIT : LABEL}) is running and already does the jobs' work: both together would handle every Discord tap twice. Run dobby service uninstall first, or keep the service and skip the jobs` : undefined
}

/** `dobby uninstall` also removes the `dobby service` (launchd KeepAlive would relaunch it after the package is gone). */
export function uninstallService(o: Opts): string[] {
  const os = o.os ?? process.platform, run = o.run ?? realRun
  if (os !== "darwin" && os !== "linux") return []
  const p = plan(os, { exec: [], path: "", log: "", home: o.home, uid: o.uid })
  if (!existsSync(p.file) || !sameInstall(p.file)) return [] // no service file for this install: any loaded com.dobby.service is another install's
  const name = os === "linux" ? UNIT : LABEL
  if (o.dry) return [`would unload ${name} and delete ${p.file}`]
  service("uninstall", false, p, (c, a) => run(c, a), () => {})
  if (os === "linux") run("systemctl", ["--user", "daemon-reload"])
  return [`removed ${name}`]
}

/** An install from before the rename still has the telegram job (and, from before that, com.foreman.* jobs): stop them and delete their files so only the current jobs run. */
function moveOldListener(o: Opts, run: Run, log: (s: string) => void) {
  const linux = (o.os ?? process.platform) === "linux"
  if (!linux) for (const j of [...JOBS, OLD_LISTENER]) {
    const f = `${o.home}/Library/LaunchAgents/com.foreman.${j.name}.plist`
    if (!existsSync(f)) continue
    run("launchctl", ["bootout", `gui/${o.uid}/com.foreman.${j.name}`]); rmSync(f)
    log(`stopped the old com.foreman.${j.name} job`)
  }
  if (!picked(o).some((j) => j.name === "listener")) return
  const old = OLD_LISTENER
  const had = (linux ? unitsFor(old, o.bin, o.home).map((f) => f.file) : [plistPath(o.home, old)]).filter((f) => existsSync(f))
  if (!had.length) return
  if (linux) run("systemctl", ["--user", "disable", "--now", unitFor(old)]); else run("launchctl", ["bootout", `gui/${o.uid}/${label(old)}`])
  for (const f of had) rmSync(f)
  log("moved the telegram job to listener")
}

/** Unload every job and delete its plist. Data, config and secrets stay (the caller says where). */
export function uninstallJobs(o: Opts): string[] {
  const run = o.run ?? realRun
  if ((o.os ?? process.platform) === "linux") return uninstallUnits(o, run)
  return [...JOBS, OLD_LISTENER].flatMap((j) => {
    const f = plistPath(o.home, j)
    if (!ownedHere(j, "darwin", o.home)) return [] // not this install's job (maybe another install's, same label or other DOBBY_DIR): never unload it
    const old = j === OLD_LISTENER ? " (old name of the listener, from earlier installs)" : ""
    if (o.dry) return [`would unload ${label(j)} and delete ${f}${old}`]
    run("launchctl", ["bootout", `gui/${o.uid}/${label(j)}`])
    rmSync(f)
    return [`removed ${label(j)}`]
  })
}

function installUnits(o: Opts, run: Run, log: (s: string) => void): Row[] {
  const JOBS = picked(o), ctx = jobCtx(o.env, o.node)
  if (o.dry) {
    const rows = JOBS.map((j) => (log(`would write ${unitsFor(j, o.bin, o.home).map((f) => f.file).join(" and ")} and start ${unitFor(j)}`), { name: j.name, ok: true, detail: "dry run" }))
    log("would run loginctl enable-linger, so the jobs keep running after you log out")
    return rows
  }
  // no user bus (WSL2 without systemd, a container, su or ssh without a session): nothing below can work
  if (!run("systemctl", ["--user", "show-environment"]).ok) return failAll(JOBS, "no systemd user session here. Run dobby start in tmux, or turn systemd on (in WSL2: systemd=true under [boot] in /etc/wsl.conf, then wsl --shutdown)")
  const bad = preflight(o, run, ctx, `${o.home}/.local/bin:/usr/local/bin:/usr/bin:/bin`)
  if (bad) return failAll(JOBS, bad)
  mkdirSync(`${o.home}/.local/share/dobby/logs`, { recursive: true }), mkdirSync(unitDir(o.home), { recursive: true })
  for (const j of JOBS) for (const f of unitsFor(j, o.bin, o.home, ctx)) writeFileSync(f.file, f.text, { mode: 0o600 })
  run("systemctl", ["--user", "daemon-reload"])
  // user units stop at the last logout unless lingering is on (headless boxes); polkit may say no
  const user = o.user ?? process.env.USER ?? userInfo().username
  run("loginctl", ["enable-linger"])
  if (!/Linger=yes/.test(run("loginctl", ["show-user", user, "-p", "Linger"]).out)) log(`Jobs stop when you log out. Run: sudo loginctl enable-linger ${user}`)
  return JOBS.map((j) => {
    const en = run("systemctl", ["--user", "enable", unitFor(j)])
    run("systemctl", ["--user", "restart", unitFor(j)]) // restart, not enable --now: a running unit keeps its old ExecStart otherwise
    const [cmd, args] = loadedProbe(j, "linux", o.uid)
    const st = jobState("linux", run(cmd, args))
    const detail = st.loaded && !st.failing ? j.what : st.failing ? `started, but the last run failed (${st.failing}): journalctl --user -u ${unitName(j)}` : `did not start: ${en.out.trim().split("\n").pop() ?? ""} (journalctl --user -u ${unitName(j)})`
    return { name: j.name, ok: st.loaded && !st.failing, detail }
  })
}

function uninstallUnits(o: Opts, run: Run): string[] {
  const out = [...JOBS, OLD_LISTENER].flatMap((j) => {
    const files = unitsFor(j, o.bin, o.home).map((f) => f.file)
    if (!ownedHere(j, "linux", o.home)) return [] // another install's (other HOME file or other DOBBY_DIR)
    const old = j === OLD_LISTENER ? " (old name of the listener, from earlier installs)" : ""
    if (o.dry) return [`would stop ${unitFor(j)} and delete ${files.join(" and ")}${old}`]
    run("systemctl", ["--user", "disable", "--now", unitFor(j)])
    for (const f of files.filter((f) => existsSync(f))) rmSync(f)
    return [`removed ${unitName(j)}`]
  })
  if (!o.dry && out.length) run("systemctl", ["--user", "daemon-reload"])
  return out
}

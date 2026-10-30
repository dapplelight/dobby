// Basic checks for setup and `dobby doctor`: the tools Dobby needs, their sign-ins, its config, jobs and add-ons.
// Each row says what is wrong and the command that fixes it. Probes run commands as argument arrays (no shell) and never call a model.
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync, statfsSync } from "node:fs"
import { homedir } from "node:os"
import { config, expand, loadConfig, localZone, privatePath } from "./config.ts"
import { networkFs } from "./setup-edge.ts"
import { ephemeral, installedBin, JOBS, jobState, loadedProbe, NOT_HERE, OLD_LISTENER, ownedHere } from "./jobs.ts"
import { srtCli } from "./lib.ts"
import { shellName } from "./shell.ts"
import { readSecrets } from "./notify.ts"
import { probeKey } from "./api.ts"
import { ghOffline } from "./repo-rights.ts"
import { sandboxCheck } from "./sandbox.ts"

export type Check = { name: string; ok: boolean; detail: string; fix?: string; required: boolean; offline?: boolean }
export type Probe = (cmd: string, args: string[]) => Promise<{ ok: boolean; out: string }>

export const realProbe: Probe = (cmd, args) => new Promise((done) => {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 })
  let out = ""
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d))
  p.on("error", (e) => done({ ok: false, out: e.message }))
  p.on("close", (code) => done({ ok: code === 0, out }))
})
const version = () => { try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string } catch { return "unknown" } }
const first = (s: string) => s.trim().split("\n")[0] ?? ""
const ver = (s: string) => s.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? first(s)
/** Node 24+: the one number (package.json engines, bin/dobby, the docs). */
export const nodeOk = (v: string) => Number(v.split(".")[0]) >= 24

/** Fix text by platform: Homebrew on a Mac, apt or dnf on Linux, and a way to install Node without admin rights. */
const FIX = {
  darwin: { node: "install Node 24 or newer: brew install node (or fnm install 24)", git: "xcode-select --install", gh: "brew install gh" },
  linux: { node: "install Node 24 or newer without admin rights: curl -fsSL https://fnm.vercel.app/install | bash, then fnm install 24", git: "sudo apt install git (Debian, Ubuntu) or sudo dnf install git (Fedora)", gh: "see https://cli.github.com (apt and dnf steps are on that page)" },
  other: { node: "install Node 24 from https://nodejs.org", git: "install git from https://git-scm.com", gh: "install gh from https://cli.github.com" },
}
export const MIN_FREE_GB = 15
const gbFree = (dir: string) => { try { const s = statfsSync(existsSync(dir) ? dir : "/"); return (s.bavail * s.bsize) / 1024 ** 3 } catch { return Infinity } }

/** Keys whose loss changes what Dobby may do: a warning that drops one fails doctor. */
const SAFETY_KEYS = ["safety", "github", "clientNames", "clientProjects"]
function configWarnings(w: string[]): Check {
  const hit = w.some((x) => SAFETY_KEYS.some((k) => new RegExp(`: ${k}[.:]`).test(x)))
  return { name: "config warnings", ok: !w.length, detail: w.length ? `${w.slice(0, 3).join("; ")}${w.length > 3 ? `; +${w.length - 3} more` : ""}` : "none", fix: "dobby config path", required: hit }
}

/** The sandbox runner builders and verify steps use must resolve from where Dobby is installed (npx hoists it above the package folder). Optional: without it runs fall back to the credential scrub. */
function srtRow(): Check {
  try { const f = srtCli(); return { name: "sandbox runner", ok: existsSync(f), detail: existsSync(f) ? f : `missing: ${f}`, fix: "npm i -g dobby-ai", required: false } } catch (e) { return { name: "sandbox runner", ok: false, detail: (e as Error).message.split("\n")[0], fix: "npm i -g dobby-ai", required: false } }
}

/** GitHub sign-in from `gh auth status`: offline or GitHub down is its own answer, never "not signed in" (setup would reopen gh auth login). */
function ghSignIn(ghOk: boolean, auth: { ok: boolean; out: string }, user: { ok: boolean; out: string }): Check {
  const name = "GitHub sign-in", fix = "gh auth login --web"
  if (!ghOk) return { name, ok: false, detail: "not signed in", fix, required: true }
  const login = user.ok ? first(user.out) : /account (\S+)/.exec(auth.out)?.[1]
  if (auth.ok && login) return { name, ok: true, detail: `signed in as ${login}`, required: true }
  if (!auth.ok && ghOffline(auth.out) || !auth.ok && !user.ok && ghOffline(user.out)) return { name, ok: false, detail: "can't reach GitHub", fix: "check your connection, then run again", required: true, offline: true }
  return { name, ok: false, detail: "not signed in", fix, required: true }
}
/** Scopes Dobby wants beyond repo: workflow (pushes that touch .github/workflows) and project (the board). Fine-grained tokens list none: nothing is claimed. */
export function missingScopes(out: string): string[] {
  const m = /Token scopes: (.*)/.exec(out)
  if (!m) return []
  const have = m[1].split(",").map((x) => x.replace(/['\s]/g, ""))
  return ["workflow", "project"].filter((x) => !have.includes(x))
}

/** All checks in parallel. `o.jobs`: also check the launchd jobs (setup skips it before they are installed). */
export async function basics(o: { probe?: Probe; node?: string; platform?: NodeJS.Platform; uid?: number; secrets?: Record<string, string>; env?: NodeJS.ProcessEnv; configPath?: string; jobs?: boolean; bin?: string; home?: string; read?: (f: string) => string; exists?: (f: string) => boolean; apiKeyMode?: boolean; fetch?: typeof fetch; workspaceId?: string; warnings?: string[]; freeGb?: number; dataDir?: string; mounts?: string; version?: string; zone?: string } = {}): Promise<Check[]> {
  const probe = o.probe ?? realProbe, node = o.node ?? process.versions.node, platform = o.platform ?? process.platform
  const secrets = o.secrets ?? readSecrets(), env = o.env ?? process.env, cfg = o.configPath ?? privatePath()
  const lin = platform === "linux"
  const [git, gh, ghAuth, ghUser, claude, claudeAuth, graphify, gitEmail, bwrap, socat, bwrapRun, ...jobs] = await Promise.all([
    probe("git", ["--version"]), probe("gh", ["--version"]), probe("gh", ["auth", "status"]), probe("gh", ["api", "user", "--jq", ".login"]),
    probe("claude", ["--version"]), probe("claude", ["auth", "status"]), probe("graphify", ["--help"]),
    probe("git", ["config", "user.email"]),
    ...(lin ? [probe("bwrap", ["--version"]), probe("socat", ["-V"]), probe("bwrap", ["--ro-bind", "/", "/", "true"])] : [{ ok: true, out: "" }, { ok: true, out: "" }, { ok: true, out: "" }]),
    // a job with no file under this HOME is another install's: never probed
    ...(o.jobs && (platform === "darwin" || platform === "linux") ? [...JOBS, OLD_LISTENER].map((j) => ownedHere(j, platform, o.home ?? homedir(), o.exists) ? probe(...loadedProbe(j, platform, o.uid ?? process.getuid?.() ?? 0)) : { ok: false, out: "" }) : []),
  ])
  const key = secrets.DOBBY_API_KEY || env.DOBBY_API_KEY || ""
  const keyProblem = o.apiKeyMode && key ? await probeKey(key, o.fetch, o.workspaceId) : "", offline = keyProblem.startsWith("could not reach") // offline is not a bad key
  const oldClaude = claude.ok && !claudeAuth.ok && /unknown command|unrecognized|invalid command/i.test(claudeAuth.out)
  const shell = shellName(env.PATH), fix = FIX[platform === "darwin" || platform === "linux" ? platform : "other"]
  const rows: Check[] = [
    { name: "Node", ok: nodeOk(node), detail: node, fix: fix.node, required: true },
    { name: "shell", ok: shell !== "sh", detail: shell === "sh" ? "sh (no zsh or bash found: project commands run without a login shell)" : `${shell} (runs project commands)`, fix: "install zsh or bash", required: false },
    srtRow(),
    { name: "git", ok: git.ok, detail: git.ok ? ver(git.out) : "not installed", fix: fix.git, required: true },
    { name: "git identity", ok: !git.ok || !!gitEmail.out.trim(), detail: !git.ok ? "needs git first" : gitEmail.out.trim() ? `commits as ${first(gitEmail.out)}` : "no user.email: builders cannot commit", fix: 'git config --global user.email "<your GitHub email>"', required: true },
    { name: "GitHub CLI", ok: gh.ok, detail: gh.ok ? ver(gh.out) : "not installed", fix: fix.gh, required: true },
    ghSignIn(gh.ok, ghAuth, ghUser),
    { name: "Claude Code", ok: claude.ok, detail: claude.ok ? ver(claude.out) : "not installed", fix: "npm install -g @anthropic-ai/claude-code", required: true },
    o.apiKeyMode // API-key mode (billing.mode): the key pays for every run, no plan sign-in needed
      ? { name: "API key", ok: !!key && (!keyProblem || offline), detail: !key ? "API-key mode but no DOBBY_API_KEY" : keyProblem && !offline ? keyProblem : `DOBBY_API_KEY set; runs pay by the token${offline ? ` (not checked: ${keyProblem})` : ""}`, fix: !key ? "add DOBBY_API_KEY=<key from console.anthropic.com> to the secrets file" : /workspace/.test(keyProblem) ? "dobby config set billing.workspaceId <wrkspc_...>" : "check the key and its balance in console.anthropic.com", required: true }
      : { name: "Claude sign-in", ok: claude.ok && claudeAuth.ok, detail: claudeAuth.ok ? "signed in" : oldClaude ? `Claude Code ${ver(claude.out)} is too old for \`claude auth status\`` : "not signed in", fix: oldClaude ? "claude update" : "run claude, then /login (no plan? dobby init without --yes can take an API key)", required: true },
    { name: "sandbox", ...sandboxCheck(platform, { bwrap: bwrap.ok, socat: socat.ok }, bwrapRun.ok), required: false },
    { name: "config", ok: existsSync(cfg), detail: existsSync(cfg) ? cfg : "none yet", fix: "dobby init", required: true },
    configWarnings(o.warnings ?? loadConfig().warnings),
    { name: "graphify", ok: graphify.ok, detail: graphify.ok ? "installed (code maps for builders and reviews)" : "not installed (optional: code maps for builders and reviews)", fix: "uv tool install graphifyy", required: false },
    (() => { const gb = o.freeGb ?? gbFree(process.env.DOBBY_DIR ?? expand(config().paths.data)); return { name: "disk", ok: gb >= MIN_FREE_GB, detail: `${gb === Infinity ? "unknown" : `${gb.toFixed(0)} GB`} free`, fix: `free up space: Dobby wants ${MIN_FREE_GB} GB for worktrees and builds`, required: false } })(),
    { name: "Discord", ok: !!secrets.DISCORD_BOT_TOKEN, detail: secrets.DISCORD_BOT_TOKEN ? "bot token set" : "off (optional: buttons for approve and decline)", fix: "add DISCORD_BOT_TOKEN to the secrets file, then dobby discord setup", required: false },
    { name: "Jev", ok: !!(env.JEV_API_KEY || secrets.JEV_API_KEY), detail: env.JEV_API_KEY || secrets.JEV_API_KEY ? "key set" : "off (optional: cheaper picks of which model reviews)", fix: "add JEV_API_KEY to the secrets file", required: false },
  ]
  if (o.jobs) { // doctor only: setup has no use for these
    const dir = o.dataDir ?? process.env.DOBBY_DIR ?? expand(config().paths.data), net = networkFs(dir, platform, o.mounts ?? (platform === "darwin" ? spawnSync("mount", { encoding: "utf8" }).stdout : ""))
    const zone = o.zone ?? config().timezone, here = localZone()
    rows.push(
      { name: "Dobby", ok: true, detail: o.version ?? version(), fix: "npm i -g dobby-ai@latest && dobby jobs install", required: false },
      { name: "time zone", ok: zone === here, detail: zone === here ? zone : `config says ${zone}, this machine is on ${here}`, fix: `dobby config set timezone ${here}`, required: false },
      { name: "data folder", ok: !net, detail: net ? `${dir} is on a network drive (${net}); SQLite needs a local disk` : "local disk", fix: "set DOBBY_DIR to a folder on a local disk, then run dobby jobs install", required: false },
    )
  }
  const scopes = missingScopes(ghAuth.out)
  if (scopes.length) rows.push({ name: "GitHub token scopes", ok: false, detail: `missing ${scopes.join(", ")} (workflow-file pushes need workflow, the board needs project)`, fix: `gh auth refresh -s ${scopes.join(",")}`, required: false })
  if (jobs.length) {
    const st = JOBS.map((_, i) => jobState(platform, jobs[i])) // loaded is not running: a crash-looping job is loaded, its last exit code says it
    const down = JOBS.filter((_, i) => !st[i].loaded).map((j) => ownedHere(j, platform, o.home ?? homedir(), o.exists) ? j.name : `${j.name} (${NOT_HERE})`)
    const failing = JOBS.flatMap((j, i) => (st[i].loaded && st[i].failing ? [`${j.name} (${st[i].failing})`] : []))
    const old = jobs[JOBS.length]?.ok // the listener's old name, still loaded: `dobby jobs install` moves it
    const bin = o.bin ?? fileURLToPath(new URL("../bin/dobby", import.meta.url)), other = JOBS.filter((_, i) => st[i].loaded).map((j) => installedBin(j, platform, o.home ?? homedir(), o.read)).find((b) => b && b !== bin) // a job left from another checkout still counts as loaded
    rows.push({ name: "background jobs", ok: !down.length && !failing.length && !other && !old, detail: old ? `the old ${OLD_LISTENER.name} job is still loaded (now ${JOBS.find((j) => j.cmd === OLD_LISTENER.cmd)!.name})` : down.length ? `${down.every((d) => d.endsWith(`(${NOT_HERE})`)) ? "" : "not loaded: "}${down.join(", ")}` : failing.length ? `loaded, but the last run failed: ${failing.join(", ")}. Logs: ~/.local/share/dobby/logs` : other ? `runs ${ephemeral(other) ? "a temporary npx copy that will go away" : "another install"}: ${other}` : `${JOBS.length} loaded`, fix: jobsFix(env, down.length === JOBS.length), required: true })
  }
  return rows
}

/** The background jobs row's fix. With no job installed, dobby start is offered too (it needs none). With DOBBY_DIR set (a test or second install) the jobs would still be your user's real ones, so it says so. */
export const jobsFix = (env: NodeJS.ProcessEnv, none = false) => `${none ? "dobby start (runs Dobby in this terminal), or " : ""}dobby jobs install${env.DOBBY_DIR ? ". DOBBY_DIR is set, but jobs install writes your user's real launchd or systemd jobs, not ones for this folder" : ""}`

/** One line per check: ✓ or ✗ (· for an optional add-on that is off), and the fix for anything failing. */
export const formatChecks = (rows: Check[]) => rows.map((r) => `${r.ok ? "✓" : r.required ? "✗" : "·"} ${r.name}: ${r.detail}${!r.ok && r.fix ? `\n    fix: ${r.fix}` : ""}`).join("\n")

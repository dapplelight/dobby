// Basic checks for setup and `dobby doctor`: the tools Dobby needs, their sign-ins, its config, jobs and add-ons.
// Each row says what is wrong and the command that fixes it. Probes run commands as argument arrays (no shell) and never call a model.
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { privatePath } from "./config.ts"
import { JOBS, loadedProbe } from "./jobs.ts"
import { shellName } from "./shell.ts"
import { readSecrets } from "./telegram.ts"

export type Check = { name: string; ok: boolean; detail: string; fix?: string; required: boolean }
export type Probe = (cmd: string, args: string[]) => Promise<{ ok: boolean; out: string }>

const realProbe: Probe = (cmd, args) => new Promise((done) => {
  const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 })
  let out = ""
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d))
  p.on("error", (e) => done({ ok: false, out: e.message }))
  p.on("close", (code) => done({ ok: code === 0, out }))
})
const first = (s: string) => s.trim().split("\n")[0] ?? ""
const ver = (s: string) => s.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? first(s)
/** Node 22.18+ (or 23.6+) runs .ts files without a build step; Dobby relies on it. */
export const nodeOk = (v: string) => { const [a, b] = v.split(".").map(Number); return a > 23 || (a === 23 && b >= 6) || (a === 22 && b >= 18) }

/** All checks in parallel. `o.jobs`: also check the launchd jobs (setup skips it before they are installed). */
export async function basics(o: { probe?: Probe; node?: string; platform?: NodeJS.Platform; uid?: number; secrets?: Record<string, string>; env?: NodeJS.ProcessEnv; configPath?: string; jobs?: boolean; apiKeyMode?: boolean } = {}): Promise<Check[]> {
  const probe = o.probe ?? realProbe, node = o.node ?? process.versions.node, platform = o.platform ?? process.platform
  const secrets = o.secrets ?? readSecrets(), env = o.env ?? process.env, cfg = o.configPath ?? privatePath()
  const [git, gh, ghUser, claude, claudeAuth, graphify, ...jobs] = await Promise.all([
    probe("git", ["--version"]), probe("gh", ["--version"]), probe("gh", ["api", "user", "--jq", ".login"]),
    probe("claude", ["--version"]), probe("claude", ["auth", "status"]), probe("graphify", ["--help"]),
    ...(o.jobs && (platform === "darwin" || platform === "linux") ? JOBS.map((j) => probe(...loadedProbe(j, platform, o.uid ?? process.getuid?.() ?? 0))) : []),
  ])
  const shell = shellName(env.PATH)
  const rows: Check[] = [
    { name: "Node", ok: nodeOk(node), detail: node, fix: "install Node 24: brew install node (or fnm install 24)", required: true },
    { name: "shell", ok: shell !== "sh", detail: shell === "sh" ? "sh (no zsh or bash found: project commands run without a login shell)" : `${shell} (runs project commands)`, fix: "install zsh or bash", required: false },
    { name: "git", ok: git.ok, detail: git.ok ? ver(git.out) : "not installed", fix: "xcode-select --install", required: true },
    { name: "GitHub CLI", ok: gh.ok, detail: gh.ok ? ver(gh.out) : "not installed", fix: "brew install gh", required: true },
    { name: "GitHub sign-in", ok: gh.ok && ghUser.ok, detail: ghUser.ok ? `signed in as ${first(ghUser.out)}` : "not signed in", fix: "gh auth login --web", required: true },
    { name: "Claude Code", ok: claude.ok, detail: claude.ok ? ver(claude.out) : "not installed", fix: "npm install -g @anthropic-ai/claude-code", required: true },
    o.apiKeyMode // API-key mode (billing.mode): the key pays for every run, no plan sign-in needed
      ? { name: "API key", ok: claude.ok && !!(secrets.DOBBY_API_KEY || env.DOBBY_API_KEY), detail: secrets.DOBBY_API_KEY || env.DOBBY_API_KEY ? "DOBBY_API_KEY set; runs pay by the token" : "API-key mode but no DOBBY_API_KEY", fix: "add DOBBY_API_KEY=<key from console.anthropic.com> to the secrets file", required: true }
      : { name: "Claude sign-in", ok: claude.ok && claudeAuth.ok, detail: claudeAuth.ok ? "signed in" : "not signed in", fix: "run claude, then /login", required: true },
    { name: "config", ok: existsSync(cfg), detail: existsSync(cfg) ? cfg : "none yet", fix: "dobby init", required: true },
    { name: "graphify", ok: graphify.ok, detail: graphify.ok ? "installed (code maps for builders and reviews)" : "not installed (optional: code maps for builders and reviews)", fix: "uv tool install graphifyy", required: false },
    { name: "Discord", ok: !!secrets.DISCORD_BOT_TOKEN, detail: secrets.DISCORD_BOT_TOKEN ? "bot token set" : "off (optional: buttons for approve and decline)", fix: "add DISCORD_BOT_TOKEN to the secrets file, then dobby discord setup", required: false },
    { name: "Jev", ok: !!(env.JEV_API_KEY || secrets.JEV_API_KEY), detail: env.JEV_API_KEY || secrets.JEV_API_KEY ? "key set" : "off (optional: cheaper picks of which model reviews)", fix: "add JEV_API_KEY to the secrets file", required: false },
  ]
  if (jobs.length) {
    const down = JOBS.filter((_, i) => !jobs[i].ok).map((j) => j.name)
    rows.push({ name: "background jobs", ok: !down.length, detail: down.length ? `not loaded: ${down.join(", ")}` : `${JOBS.length} loaded`, fix: "dobby jobs install", required: true })
  }
  return rows
}

/** One line per check: ✓ or ✗ (· for an optional add-on that is off), and the fix for anything failing. */
export const formatChecks = (rows: Check[]) => rows.map((r) => `${r.ok ? "✓" : r.required ? "✗" : "·"} ${r.name}: ${r.detail}${!r.ok && r.fix ? `\n    fix: ${r.fix}` : ""}`).join("\n")

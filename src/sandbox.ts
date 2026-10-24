// The real boundary for agents that run arbitrary code (Builders: node -e, bun scripts, tests). Command rules (guard hook) can't
// stop a prompt-injected builder from pushing, deploying or sending data out, so its `claude -p` gets (1) no credentials in its
// environment and (2) Claude Code's OS sandbox around every Bash command: writes only in its worktree and a scratch dir, no reads
// of Dobby's data or credential files, no network except localhost. Dobby's own steps (prepare installs, verify, push, merge)
// run in Dobby's shell, outside the agent, with network and credentials as before.
// Docs: https://code.claude.com/docs/en/sandboxing (Seatbelt on macOS, bubblewrap + socat on Linux/WSL2, none on native Windows).
import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { config } from "./config.ts"
import { basename, delimiter, join } from "node:path"

export type SandboxMode = "on" | "env-only" | "off"

/** Variables a builder never gets (exact names, then prefixes). */
const DROP = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY",
  "NPM_TOKEN", "NODE_AUTH_TOKEN", "GOOGLE_APPLICATION_CREDENTIALS", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "JEV_API_KEY", "DASHBOARD_TOKEN", "DOBBY_API_KEY",
  "DOBBY_SECRETS", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_ASKPASS", "SSH_ASKPASS"])
const DROP_PREFIX = ["CF_", "AWS_", "DISCORD_", "TELEGRAM_", "GIT_CONFIG_"]
// Anything else that looks like a credential by name. Claude's own login variables are kept (claude needs them) and hidden from
// its Bash commands by the sandbox's credentials deny list instead. Not CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: live check 20 Oct, it also
// stripped DOBBY_BASH_ALLOW from the guard hook's environment, so every builder command was denied ("this role has no shell").
const SECRETISH = /TOKEN|SECRET|PASSW|API_?KEY|PRIVATE_KEY|CREDENTIAL|AUTH/i
export const CLAUDE_AUTH = ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_OAUTH_SCOPES", "ANTHROPIC_AUTH_TOKEN"]

/** Per-worktree scratch dir under the OS temp dir: empty gh and XDG config homes (no gh / wrangler login). */
export const scratchDir = (worktree: string) => join(tmpdir(), `dobby-builder-${basename(worktree)}`)

/**
 * The environment for a builder's `claude -p`: credentials dropped, gh and wrangler pointed at empty config dirs, git with no
 * credential helper, no askpass, no ssh. PATH, HOME, LANG, TMPDIR and claude's own login stay. Pure (the caller makes `scratch`).
 */
export function builderEnv(baseEnv: NodeJS.ProcessEnv, worktree: string, scratch = scratchDir(worktree)): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v === undefined || DROP.has(k) || DROP_PREFIX.some((p) => k.startsWith(p))) continue
    if (SECRETISH.test(k) && !CLAUDE_AUTH.includes(k)) continue
    out[k] = v
  }
  const git: [string, string][] = [["credential.helper", ""], ["credential.https://github.com.helper", ""], ["core.sshCommand", "false"], ["core.askPass", "false"], ...SAFE_GIT]
  return {
    ...out,
    GH_CONFIG_DIR: join(scratch, "gh"), XDG_CONFIG_HOME: join(scratch, "config"), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1",
    GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "false", SSH_ASKPASS: "false", GIT_SSH_COMMAND: "false", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: String(git.length), ...Object.fromEntries(git.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
  }
}

/**
 * Git settings for every git Dobby starts: no hooks and no fsmonitor command. A builder can write `.husky/*` or other hook files in its
 * worktree, and Dobby's own commit, rebase, worktree add and push run outside the sandbox with credentials (audit 24 Oct).
 */
export const SAFE_GIT: [string, string][] = [["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"]]
/** `env` plus git `-c` pairs via GIT_CONFIG_COUNT, after any the environment already has. Unchanged when the first pair is already set. */
export function withGitConfig(env: NodeJS.ProcessEnv, pairs: [string, string][]): NodeJS.ProcessEnv {
  const n = Number(env.GIT_CONFIG_COUNT) || 0
  if (Array.from({ length: n }, (_, i) => env[`GIT_CONFIG_KEY_${i}`]).includes(pairs[0][0])) return env
  return { ...env, GIT_CONFIG_COUNT: String(n + pairs.length), ...Object.fromEntries(pairs.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${n + i}`, k], [`GIT_CONFIG_VALUE_${n + i}`, v]])) }
}

/** Package registries an install may reach from inside the sandbox; verify gets none. Extra hosts: config `installDomains`. */
export const INSTALL_DOMAINS = ["registry.npmjs.org", "registry.yarnpkg.com", "pypi.org", "files.pythonhosted.org", "crates.io", "index.crates.io", "static.crates.io", "proxy.golang.org", "sum.golang.org", "github.com", "codeload.github.com", "objects.githubusercontent.com"]

/**
 * srt settings (@anthropic-ai/sandbox-runtime, the engine behind Claude Code's sandbox) for Dobby's own run of code an agent or a PR
 * wrote: install and verify. The builder's read rules; writes to the worktree, scratch, temp and the package caches; network only to
 * `domains` (plus localhost on macOS, for tests that start servers).
 */
export function stepSettings(worktree: string, domains: string[], scratch = scratchDir(worktree), home = homedir(), platform = process.platform) {
  const s = sandboxSettings(worktree, scratch, platform)
  const caches = [".bun/install/cache", ".npm", ".cache", "Library/Caches", ".cargo/registry", "go/pkg/mod", ".node-gyp", ".yarn/berry/cache"].map((d) => join(home, d))
  return {
    filesystem: { ...s.filesystem, allowWrite: [worktree, scratch, tmpdir(), ...caches], denyWrite: [] as string[] },
    network: { ...s.network, allowedDomains: domains, deniedDomains: [] as string[] },
  }
}

/** The `sandbox` block of the builder's settings (passed with --settings, so a repo's .claude/settings.json can't loosen it). */
export function sandboxSettings(worktree: string, scratch = scratchDir(worktree), platform = process.platform) {
  return {
    enabled: true,
    failIfUnavailable: true, // a sandbox that can't start stops the run instead of running the builder unsandboxed
    allowUnsandboxedCommands: false, // no dangerouslyDisableSandbox retry; also makes the sandbox admin-required (repo settings can't widen it)
    autoAllowBashIfSandboxed: false, // the role allowlist + guard hook still decide which commands run
    filesystem: {
      // Writes: the worktree (cwd; git's shared .git of a linked worktree is allowed by Claude Code itself) + the per-user temp dir + scratch.
      allowWrite: [scratch],
      denyRead: ["~/.config/dobby", "~/.config/gh", "~/.ssh", "~/.aws", "~/.netrc", "~/.npmrc", "~/.git-credentials", "~/.docker", "~/.wrangler", "~/Library/Preferences/.wrangler", config().paths.data],
      allowRead: [worktree], // the own worktree under ~/.local/share/dobby/wt stays readable (narrower rule wins)
    },
    network: {
      allowedDomains: [] as string[],
      strictAllowlist: true, // any host not listed is refused, never prompted
      // Tests reach local servers and DBs. macOS: lets commands listen on and connect to localhost ports (any local service, see NOTES).
      // Linux: a sandboxed command's localhost is private to it, so this has no effect there.
      ...(platform === "darwin" ? { allowLocalBinding: true } : {}),
    },
    credentials: { envVars: [...CLAUDE_AUTH, "ANTHROPIC_API_KEY", "OTEL_EXPORTER_OTLP_LOGS_HEADERS"].map((name) => ({ name, mode: "deny" })) }, // the API key and telemetry nonce reach claude, not its commands
  }
}

/** Can Claude Code sandbox here? macOS always (Seatbelt); Linux/WSL2 with bubblewrap and socat on PATH; native Windows never. */
export function sandboxSupported(platform = process.platform, path = process.env.PATH ?? ""): boolean {
  if (platform === "darwin") return true
  if (platform !== "linux") return false
  const has = (bin: string) => path.split(delimiter).some((d) => d && existsSync(join(d, bin)))
  return has("bwrap") && has("socat")
}

/**
 * Which protection a role's run gets. `setting` = DOBBY_BUILDER_SANDBOX (on | off | env-only; default on); `roles` = the run kinds
 * it covers (DOBBY_SANDBOX_ROLES, comma list, default "build": checker, reviewer etc. opt in by adding their kind). `on` on a platform
 * without a sandbox falls back to env-only (the caller logs it).
 */
export function sandboxMode(kind: string, setting?: string, roles = "build", supported = sandboxSupported()): SandboxMode {
  if (!roles.split(",").map((r) => r.trim()).includes(kind)) return "off"
  const s = (setting ?? "on").trim().toLowerCase()
  if (s === "off" || s === "env-only") return s
  return supported ? "on" : "env-only"
}

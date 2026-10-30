// Builder sandbox: credential scrub, sandbox settings, mode switch (src/sandbox.ts, isolation() in lib.ts).
import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "foreman-sbx-"))
process.env.DOBBY_DIR ??= dir
process.env.DOBBY_SECRETS ??= join(dir, "secrets.env")
const { builderEnv, INSTALL_DOMAINS, SAFE_GIT, sandboxCheck, sandboxMode, sandboxSettings, sandboxSupported, bwrapWorks, scratchDir, stepSettings, withGitConfig } = await import("../src/sandbox.ts")
const { isolation } = await import("../src/lib.ts")

const FAKE = "fake-value-not-a-secret"
const base = {
  PATH: "/usr/bin:/bin", HOME: "/Users/me", LANG: "en_US.UTF-8", TMPDIR: "/var/tmp/x", USER: "x",
  GH_TOKEN: FAKE, GITHUB_TOKEN: FAKE, GH_ENTERPRISE_TOKEN: FAKE, CLOUDFLARE_API_TOKEN: FAKE, CLOUDFLARE_ACCOUNT_ID: FAKE, CF_API_KEY: FAKE,
  NPM_TOKEN: FAKE, NODE_AUTH_TOKEN: FAKE, AWS_ACCESS_KEY_ID: FAKE, AWS_PROFILE: FAKE, GOOGLE_APPLICATION_CREDENTIALS: FAKE, ANTHROPIC_API_KEY: FAKE,
  OPENAI_API_KEY: FAKE, JEV_API_KEY: FAKE, DISCORD_BOT_TOKEN: FAKE, TELEGRAM_CHAT: FAKE, DASHBOARD_TOKEN: FAKE, DOBBY_API_KEY: FAKE,
  SSH_AUTH_SOCK: "/tmp/agent.sock", STRIPE_SECRET_KEY: FAKE, GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "osxkeychain",
  CLAUDE_CODE_OAUTH_TOKEN: FAKE, OTEL_LOGS_EXPORTER: "otlp",
}

test("builderEnv: every credential is dropped; PATH, HOME, LANG, TMPDIR and claude's own login stay", () => {
  const e = builderEnv(base, "/w/tally-12", "/s")
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CF_API_KEY", "NPM_TOKEN", "NODE_AUTH_TOKEN",
    "AWS_ACCESS_KEY_ID", "AWS_PROFILE", "GOOGLE_APPLICATION_CREDENTIALS", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "JEV_API_KEY", "DISCORD_BOT_TOKEN", "TELEGRAM_CHAT",
    "DASHBOARD_TOKEN", "DOBBY_API_KEY", "SSH_AUTH_SOCK", "STRIPE_SECRET_KEY"]) assert.equal(e[k], undefined, k)
  assert.deepEqual(Object.keys(e).filter((k) => e[k] === FAKE), ["CLAUDE_CODE_OAUTH_TOKEN"], "only claude's own login keeps a credential")
  for (const k of ["PATH", "HOME", "LANG", "TMPDIR", "USER", "OTEL_LOGS_EXPORTER", "CLAUDE_CODE_OAUTH_TOKEN"]) assert.equal(e[k], base[k as keyof typeof base], k)
  assert.equal(base.GH_TOKEN, FAKE, "input untouched")
})

test("builderEnv: gh and wrangler get empty config homes, git gets no helper, askpass or ssh", () => {
  const e = builderEnv(base, "/w/tally-12", "/s")
  assert.equal(e.GH_CONFIG_DIR, join("/s", "gh"))
  assert.equal(e.XDG_CONFIG_HOME, join("/s", "config"))
  assert.equal(e.GIT_TERMINAL_PROMPT, "0")
  assert.equal(e.GIT_ASKPASS, "false")
  assert.equal(e.GIT_SSH_COMMAND, "false")
  assert.equal(e.GIT_CONFIG_NOSYSTEM, "1")
  assert.equal(e.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, undefined) // it strips DOBBY_BASH_ALLOW from the guard hook too
  const git = Object.fromEntries(Array.from({ length: Number(e.GIT_CONFIG_COUNT) }, (_, i) => [e[`GIT_CONFIG_KEY_${i}`], e[`GIT_CONFIG_VALUE_${i}`]]))
  assert.deepEqual(git, { "credential.helper": "", "credential.https://github.com.helper": "", "core.sshCommand": "false", "core.askPass": "false", "commit.gpgsign": "false", "tag.gpgsign": "false", "core.hooksPath": "/dev/null", "core.fsmonitor": "false" }) // the inherited osxkeychain entry is gone
  assert.ok(scratchDir("/w/tally-12").startsWith(tmpdir()), "scratch under the OS temp dir, not a hard-coded /tmp")
})

test("sandboxSettings: worktree-only writes, secret paths unreadable, no network but localhost, no unsandboxed escape", () => {
  const s = sandboxSettings("/home/me/.local/share/dobby/wt/tally-12", "/s", "darwin")
  assert.equal(s.enabled, true)
  assert.equal(s.failIfUnavailable, true)
  assert.equal(s.allowUnsandboxedCommands, false)
  assert.deepEqual(s.filesystem.allowWrite, ["/s"])
  for (const p of ["~/.config/dobby", "~/.ssh", "~/.aws", "~/.netrc", "~/.local/share/dobby"]) assert.ok(s.filesystem.denyRead.includes(p), p)
  assert.deepEqual(s.filesystem.allowRead, ["/home/me/.local/share/dobby/wt/tally-12"])
  assert.deepEqual(s.network.allowedDomains, [])
  assert.equal(s.network.strictAllowlist, true)
  assert.equal((s.network as { allowLocalBinding?: boolean }).allowLocalBinding, true)
  assert.equal("allowLocalBinding" in sandboxSettings("/w", "/s", "linux").network, false)
  assert.ok(s.credentials.envVars.some((v) => v.name === "CLAUDE_CODE_OAUTH_TOKEN" && v.mode === "deny"))
  assert.ok(s.credentials.envVars.some((v) => v.name === "ANTHROPIC_API_KEY" && v.mode === "deny")) // API-key mode: the key reaches claude, not its commands
})

test("sandboxMode: builders on by default, off/env-only by setting, other roles opt in, no sandbox platform = env-only", () => {
  assert.equal(sandboxMode("build", undefined, undefined, true), "on")
  assert.equal(sandboxMode("build", "off", undefined, true), "off")
  assert.equal(sandboxMode("build", " Env-Only ", undefined, true), "env-only")
  assert.equal(sandboxMode("build", "on", undefined, false), "env-only")
  assert.equal(sandboxMode("check", undefined, undefined, true), "off")
  assert.equal(sandboxMode("check", undefined, "build,check", true), "on")
  assert.equal(sandboxSupported("win32"), false)
  assert.equal(sandboxSupported("darwin"), true)
  assert.equal(sandboxSupported("linux", ""), false)
})

test("isolation: builder gets the sandbox inside --settings (hooks kept) and the scrubbed env; other roles unchanged", () => {
  const wt = mkdtempSync(join(tmpdir(), "foreman-wt-"))
  const b = isolation("build", wt, { ...base }, undefined, true)
  const st = JSON.parse(b.settings)
  assert.equal(st.sandbox.enabled, true)
  assert.ok(st.hooks.PreToolUse[0].hooks[0].command.includes("guard-hook.mjs"), "guard hook kept")
  assert.equal(b.env.GH_TOKEN, undefined)
  const off = isolation("build", wt, { ...base }, "off", true)
  assert.match(off.settings, /agent-settings\.json$/)
  assert.equal(off.env.GH_TOKEN, FAKE)
  const lead = isolation("lead", wt, { ...base }, undefined, true)
  assert.equal(lead.mode, "off")
  assert.equal(lead.env.GH_TOKEN, FAKE)
  const envOnly = isolation("build", wt, { ...base }, "env-only", true)
  assert.match(envOnly.settings, /agent-settings\.json$/)
  assert.equal(envOnly.env.GH_TOKEN, undefined)
})

test("install and verify on agent code: builder read rules, no network for verify, registries only for install (audit H1)", () => {
  const wt = "/tmp/wt/demo-1"
  const verify = stepSettings(wt, [], "/tmp/s", "/home/me", "linux")
  assert.deepEqual(verify.network.allowedDomains, [])
  assert.equal(verify.network.strictAllowlist, true)
  assert.ok(verify.filesystem.denyRead.includes("~/.ssh") && verify.filesystem.denyRead.includes("~/.config/dobby"))
  assert.ok(verify.filesystem.allowWrite.includes(wt) && verify.filesystem.allowWrite.includes("/home/me/.bun/install/cache"))
  assert.ok(!verify.filesystem.allowWrite.some((p) => p === "/home/me" || p.endsWith("/.bun") || p.includes(".ssh")))
  assert.deepEqual(stepSettings(wt, INSTALL_DOMAINS, "/tmp/s", "/home/me").network.allowedDomains, INSTALL_DOMAINS)
})

test("git config pairs go after the environment's own, once (hooks off for Dobby's git)", () => {
  const once = withGitConfig({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x" }, SAFE_GIT)
  assert.equal(once.GIT_CONFIG_COUNT, "3")
  assert.equal(once.GIT_CONFIG_KEY_0, "user.name")
  assert.equal(once.GIT_CONFIG_KEY_1, "core.hooksPath")
  assert.equal(once.GIT_CONFIG_VALUE_1, "/dev/null")
  assert.equal(withGitConfig(once, SAFE_GIT), once)
  assert.equal(withGitConfig({}, SAFE_GIT).GIT_CONFIG_COUNT, "2")
})

test("sandboxCheck: macOS ok; Linux names the missing tool, an AppArmor block, or passes; Windows says WSL2; bwrapWorks only probes on Linux", () => {
  assert.equal(sandboxCheck("darwin", { bwrap: false, socat: false }, false).ok, true)
  const miss = sandboxCheck("linux", { bwrap: false, socat: true }, false)
  assert.deepEqual([miss.ok, /bubblewrap not installed/.test(miss.detail), /apt install bubblewrap socat/.test(miss.fix!)], [false, true, true])
  const blocked = sandboxCheck("linux", { bwrap: true, socat: true }, false)
  assert.deepEqual([blocked.ok, /AppArmor/.test(blocked.detail), /apparmor_restrict_unprivileged_userns/.test(blocked.fix!)], [false, true, true])
  assert.equal(sandboxCheck("linux", { bwrap: true, socat: true }, true).ok, true)
  assert.match(sandboxCheck("win32", { bwrap: false, socat: false }, false).fix!, /WSL2/)
  assert.equal(bwrapWorks("darwin", () => { throw new Error("no probe off Linux") }), true)
})

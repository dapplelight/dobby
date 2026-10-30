// Repo detection for setup: read a repo's own files for its package manager, install, test and deploy commands and its base
// branch, then run install and test once to prove them. Nothing is asked of the user and no model is called.
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { release, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { config } from "./config.ts"
import { stepCommand, stepSh } from "./lib.ts"
import { INSTALL_DOMAINS, scratchDir } from "./sandbox.ts"
import { loginShell } from "./shell.ts"

/** `remote` = the GitHub "owner/name" (null when there is none; `skip` says why). `upstream` = where PRs and issues go when the owner chose the original of a fork. */
export type Detected = { dir: string; pm: string; install: string; test: string | null; deploy: string | null; base: string; remote: string | null; skip?: "ghe" | "other" | "none" | "name"; remoteName?: string; oldOrigin?: string; upstream?: string }
/** `last` = final output line; on failure `tail` = last 10 lines and `log` = a file with all of it. */
export type Verified = Detected & { checks: { step: "install" | "test"; ok: boolean; secs: number; last: string; tail?: string; log?: string }[] }

const git = (dir: string, args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 60_000, env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" } })
const has = (dir: string, f: string) => existsSync(join(dir, f))
const json = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")) } catch { return null } }

/** Runs a program with arguments and gives its stdout; tests inject this so ssh and gh are never really called. */
export type Cmd = (cmd: string, args: string[]) => { ok: boolean; out: string }
const realCmd: Cmd = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000 }); return { ok: r.status === 0, out: r.stdout ?? "" } }
let remoteRunner: Cmd = realCmd
/** Tests replace the runner behind every remote lookup, so ssh and gh are never really called. */
export const setRemoteRunner = (c: Cmd | null) => { remoteRunner = c ?? realCmd }
const GITHUB_HOSTS = new Set(["github.com", "ssh.github.com", "www.github.com"])

/**
 * Where a remote URL points: a GitHub "owner/name", or why it is skipped (`ghe` = GitHub Enterprise, `other` = GitLab, Bitbucket, a local path...).
 * An ssh host alias (`git@github-work:org/repo.git`) is resolved with `ssh -G`, which only prints the ssh config and never connects.
 * An alias that ssh has no entry for is confirmed with `gh repo view`.
 */
export function classifyRemote(url: string, run: Cmd = remoteRunner): { slug: string } | { skip: "ghe" | "other" } {
  const m = url.trim().match(/^(?:([\w+.-]+):\/\/)?(?:[^@/\s]+@)?([^/:\s]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/)
  if (!m || (!m[1] && !url.includes(":"))) return { skip: "other" }
  const [, scheme, h, path] = m
  const slug = /^[\w.-]+\/[\w.-]+$/.test(path) ? path : null
  let host = h.toLowerCase()
  if (scheme !== "http" && scheme !== "https" && /^[a-z0-9][\w.-]*$/.test(host)) {
    const r = run("ssh", ["-G", host])
    const real = r.ok ? /^hostname\s+(\S+)/im.exec(r.out)?.[1]?.toLowerCase() : undefined
    if (real && real !== host) host = real
    else if (slug && !host.includes(".") && run("gh", ["repo", "view", slug, "--json", "url", "-q", ".url"]).out.trim().startsWith("https://github.com/")) return { slug }
  }
  if (!slug) return { skip: "other" }
  if (GITHUB_HOSTS.has(host)) return { slug }
  return { skip: /(^|[.-])(github|ghe)([.-]|$)/.test(host) ? "ghe" : "other" }
}

/** A word to rename a non-GitHub origin to, from its host. */
const originWord = (url: string) => (/gitlab/i.test(url) ? "gitlab" : /bitbucket/i.test(url) ? "bitbucket" : "old-origin")

/** The repo's GitHub remote: origin first, else the first remote that points at github.com (`skip: "name"`: Dobby only uses a remote called origin). When none does, `skip` says why. */
export function remoteInfo(dir: string, run: Cmd = remoteRunner): { remote: string | null; skip?: "ghe" | "other" | "none" | "name"; remoteName?: string; oldOrigin?: string } {
  const names = (git(dir, ["remote"]).stdout ?? "").split("\n").map((x) => x.trim()).filter(Boolean).sort((a, b) => Number(b === "origin") - Number(a === "origin"))
  let skip: "ghe" | "other" | undefined
  for (const n of names) {
    const r = classifyRemote(git(dir, ["remote", "get-url", n]).stdout?.trim() ?? "", run)
    if ("slug" in r) return n === "origin" ? { remote: r.slug } : { remote: null, skip: "name", remoteName: n, ...(names.includes("origin") ? { oldOrigin: originWord(git(dir, ["remote", "get-url", "origin"]).stdout ?? "") } : {}) } // the runtime fetches, pushes and reads refs from origin only
    if (r.skip === "ghe" || !skip) skip = r.skip
  }
  return { remote: null, skip: skip ?? "none" }
}

/** The GitHub "owner/name" of the repo's remote (see remoteInfo), or null when there is none. */
export const githubRemote = (dir: string, run: Cmd = remoteRunner): string | null => remoteInfo(dir, run).remote

/** The base branch: origin/HEAD, else main or master when origin has it, else the current branch. */
export function baseBranch(dir: string): string {
  const head = git(dir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).stdout?.trim()
  if (head) return head.replace(/^refs\/remotes\/origin\//, "")
  for (const b of ["main", "master"]) if (git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`]).status === 0) return b
  return git(dir, ["branch", "--show-current"]).stdout?.trim() || "main"
}

const VENV_INSTALL = (what: string) => `python3 -m venv .venv && .venv/bin/pip install ${what}`
const VENV_TEST = ".venv/bin/python -m pytest"

/** Commands from the repo's own files, most specific first. A Node repo's lockfile picks the package manager. */
export function detectRepo(dir: string, run: Cmd = remoteRunner): Detected {
  const out = (pm: string, install: string, test: string | null, deploy: string | null = null): Detected =>
    ({ dir, pm, install, test, deploy, base: baseBranch(dir), ...remoteInfo(dir, run) } as Detected)
  const pkg = has(dir, "package.json") ? json(join(dir, "package.json")) : null
  if (pkg) {
    const pm = has(dir, "bun.lock") || has(dir, "bun.lockb") ? "bun" : has(dir, "pnpm-lock.yaml") ? "pnpm" : has(dir, "yarn.lock") ? "yarn" : "npm"
    const s = (pkg.scripts ?? {}) as Record<string, string>
    const run = (n: string) => (pm === "npm" ? `npm run ${n}` : `${pm} run ${n}`)
    const test = s.test && !/no test specified/.test(s.test) ? run("test") : s.check ? run("check") : s.typecheck ? run("typecheck") : s.lint ? run("lint") : null
    return out(pm, pm === "npm" && has(dir, "package-lock.json") ? "npm ci" : `${pm} install`, test, s.deploy ? run("deploy") : null)
  }
  if (has(dir, "Cargo.toml")) return out("cargo", "cargo build", "cargo test")
  if (has(dir, "go.mod")) return out("go", "go build ./...", "go test ./...")
  if (has(dir, "pyproject.toml")) {
    if (has(dir, "uv.lock")) return out("uv", "uv sync", "uv run pytest")
    if (has(dir, "poetry.lock")) return out("poetry", "poetry install", "poetry run pytest")
    return out("pip", VENV_INSTALL("-e ."), VENV_TEST) // a venv: system pip refuses installs (PEP 668)
  }
  if (has(dir, "requirements.txt")) return out("pip", VENV_INSTALL("-r requirements.txt"), VENV_TEST)
  if (has(dir, "Gemfile")) return out("bundler", "bundle install", has(dir, "spec") ? "bundle exec rspec" : has(dir, "test") ? "bundle exec rake test" : null)
  if (has(dir, "pom.xml")) return out("maven", "mvn -B -q -DskipTests install", "mvn -B test")
  if (has(dir, "build.gradle") || has(dir, "build.gradle.kts")) { const g = has(dir, "gradlew") ? "./gradlew" : "gradle"; return out("gradle", `${g} build -x test`, `${g} test`) }
  if (has(dir, "composer.json")) return out("composer", "composer install", json(join(dir, "composer.json"))?.scripts?.test ? "composer test" : null)
  if (has(dir, "mix.exs")) return out("mix", "mix deps.get", "mix test")
  if (has(dir, "Makefile")) {
    const mk = readFileSync(join(dir, "Makefile"), "utf8")
    return out("make", /^install:/m.test(mk) ? "make install" : "true", /^test:/m.test(mk) ? "make test" : null, /^deploy:/m.test(mk) ? "make deploy" : null)
  }
  return out("none", "true", null)
}

type Net = "install" | "verify"
type Run = (cmd: string, cwd: string, timeoutMs: number, net: Net) => { ok: boolean; out: string }
type ARun = (cmd: string, cwd: string, timeoutMs: number, net: Net) => Promise<{ ok: boolean; out: string }>
type Step = Verified["checks"][number]
type VerifyOpts = { timeoutMs?: number; has?: (bin: string) => boolean; lfs?: () => boolean }

const realRun: Run = (cmd, cwd, timeoutMs, net) => {
  const c = stepCommand(cmd, cwd, net) // the builds' sandbox and env, so a pass here is a pass there
  const r = spawnSync(c.file, c.args, { cwd, encoding: "utf8", timeout: timeoutMs, env: c.env ?? process.env, maxBuffer: 64 * 1024 * 1024 })
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}` }
}
const realArun: ARun = (cmd, cwd, timeoutMs, net) => stepSh(cmd, cwd, net, 64 * 1024, { timeoutMs })
const onPath = (bin: string) => spawnSync(...loginShell(`command -v ${bin}`), { stdio: "ignore" }).status === 0

const INSTALL_HINT: Record<string, string> = {
  pnpm: "corepack enable (or npm install -g pnpm)", yarn: "corepack enable (or npm install -g yarn)", bun: "brew install oven-sh/bun/bun (or curl -fsSL https://bun.sh/install | bash)",
  cargo: "curl https://sh.rustup.rs -sSf | sh", go: "brew install go (Linux: your package manager, or go.dev/dl)", uv: "brew install uv (or curl -LsSf https://astral.sh/uv/install.sh | sh)",
  poetry: "pipx install poetry", python3: "install Python 3 (brew install python, or apt install python3 python3-venv)", bundle: "gem install bundler", mvn: "brew install maven", gradle: "brew install gradle",
  composer: "brew install composer", mix: "brew install elixir", make: "xcode-select --install (Linux: apt install build-essential)", npm: "install Node",
}
/** The tool this repo's install needs, when it is not on the owner's PATH: plain words and the install command. Null = fine. */
export function missingTool(d: Detected, has: (bin: string) => boolean = onPath): string | null {
  const bin = d.install.split(/\s+/)[0]
  if (!bin || bin === "true" || bin.startsWith("./") || has(bin)) return null
  return `${bin} is not installed. Install it: ${INSTALL_HINT[bin] ?? bin}`
}
/** Git LFS files in the repo but no git-lfs: checkouts would hold pointer files and builds fail in odd ways. */
export function lfsMissing(dir: string, installed = () => spawnSync("git", ["lfs", "version"], { stdio: "ignore" }).status === 0): string | null {
  const attrs = join(dir, ".gitattributes")
  if (!existsSync(attrs) || !/filter=lfs/.test(readFileSync(attrs, "utf8")) || installed()) return null
  return "this repo uses Git LFS but git-lfs is not installed. Install it: brew install git-lfs (Linux: apt install git-lfs), then git lfs install"
}
/** Things to tell the owner before or after the run; none of them stop it. */
export function repoWarnings(d: Detected, o: { wsl?: boolean; extraDomains?: string[]; npmrc?: string } = {}): string[] {
  const w: string[] = []
  if (!d.test) w.push("No test command found, so merges will depend on the review alone. Add a test, check, typecheck or lint script, or set verify: in dobby.md.")
  if (d.dir.startsWith("/mnt/") && (o.wsl ?? /microsoft/i.test(release()))) w.push("This repo is on a Windows drive (/mnt/). Installs and tests are very slow there and may time out. Move it into the Linux home folder.")
  const rc = o.npmrc ?? (has(d.dir, ".npmrc") ? readFileSync(join(d.dir, ".npmrc"), "utf8") : "")
  const known = new Set([...INSTALL_DOMAINS, ...(o.extraDomains ?? config().installDomains ?? [])])
  const hosts = [...rc.matchAll(/registry\s*=\s*"?https?:\/\/([^/\s":]+)/g)].map((m) => m[1]).filter((h) => !known.has(h))
  if (hosts.length) w.push(`This repo's .npmrc uses a registry (${[...new Set(hosts)].join(", ")}). Builds can only reach it if you add it to installDomains in your Dobby config (dobby config path). Login tokens in ~/.npmrc are not readable by builders, so a private registry may still need a token in the repo's own .npmrc.`)
  return w
}

const ref = (dir: string, base: string) => [`origin/${base}`, base, "HEAD"].find((r) => git(dir, ["rev-parse", "--verify", "--quiet", `${r}^{commit}`]).status === 0)!
const cleanup = new Map<string, () => void>()
/** A detached checkout of origin/<base> in the temp dir, so the owner's working copy is never touched. */
function addWorktree(d: Detected): { wt: string } | { err: string } {
  const wt = mkdtempSync(join(tmpdir(), "dobby-verify-"))
  const drop = () => {
    git(d.dir, ["worktree", "remove", "--force", wt])
    rmSync(wt, { recursive: true, force: true }); rmSync(scratchDir(wt), { recursive: true, force: true })
    git(d.dir, ["worktree", "prune"])
  }
  cleanup.set(wt, drop)
  if (!cleanup.has("")) {
    cleanup.set("", () => {})
    process.on("exit", () => cleanup.forEach((f) => f()))
    process.on("SIGINT", () => { cleanup.forEach((f) => f()); process.exit(130) })
    process.on("SIGTERM", () => { cleanup.forEach((f) => f()); process.exit(143) })
  }
  if (d.remote) git(d.dir, ["fetch", "-q", "origin", d.base]) // best effort; a failed fetch checks out the last known origin
  const r = ref(d.dir, d.base)
  const add = r ? git(d.dir, ["worktree", "add", "-q", "--detach", wt, r]) : null
  if (!add || add.status !== 0) { drop(); cleanup.delete(wt); return { err: `could not check out ${d.base} to test it: ${add?.stderr?.trim().split("\n").pop() ?? "no commits yet"}` } }
  if (existsSync(join(wt, ".gitmodules"))) {
    const sub = spawnSync("git", ["-C", wt, "submodule", "update", "--init", "--recursive"], { encoding: "utf8", timeout: 5 * 60_000 })
    if (sub.status !== 0) { drop(); cleanup.delete(wt); return { err: `git submodule update failed: ${(sub.stderr ?? "").trim().split("\n").pop()}` } }
  }
  return { wt }
}
const dropWorktree = (wt: string) => { cleanup.get(wt)?.(); cleanup.delete(wt) }

/** One finished step: last line, last 10 lines and, on failure, the whole output in a log file. */
function stepResult(d: Detected, step: Step["step"], r: { ok: boolean; out: string }, t: number): Step {
  const lines = r.out.trim().split("\n").filter((l) => !/^\s*#\s+\w+\s+[\d.]+$/.test(l)) // not a TAP counter ("# duration_ms 29.1")
  const c: Step = { step, ok: r.ok, secs: Math.round((Date.now() - t) / 1000), last: lines.pop()?.slice(0, 200) ?? "" }
  if (!r.ok) {
    c.tail = r.out.trim().split("\n").slice(-10).join("\n")
    c.log = join(tmpdir(), `dobby-verify-${basename(d.dir)}-${step}.log`)
    try { writeFileSync(c.log, r.out) } catch { delete c.log }
  }
  return c
}
const early = (msg: string): Step => ({ step: "install", ok: false, secs: 0, last: msg, tail: msg })
const timeoutOf = (o: VerifyOpts) => o.timeoutMs ?? 10 * 60_000
/** Problems found before anything runs: a missing tool or git-lfs. */
const precheck = (d: Detected, o: VerifyOpts) => { const m = missingTool(d, o.has) ?? lfsMissing(d.dir, o.lfs); return m ? early(m) : null }

/**
 * Run install, then test, once each with a time limit, in a throwaway detached worktree of origin/<base> through the builds'
 * sandbox (no .env, no network on test, same read rules), so a pass here means builds can run it and the owner's checkout is
 * untouched. The worktree is removed on success, failure and timeout. A command passes only on exit 0. `last` = its final output line.
 */
export function verifyRepo(d: Detected, o: { run?: Run } & VerifyOpts = {}): Verified {
  const run = o.run ?? realRun, checks: Step[] = []
  const bad = precheck(d, o)
  if (bad) return { ...d, checks: [bad] }
  const w = addWorktree(d)
  if ("err" in w) return { ...d, checks: [early(w.err)] }
  try {
    for (const [step, cmd] of [["install", d.install], ["test", d.test]] as const) {
      if (!cmd) continue
      const t = Date.now(), r = run(cmd, w.wt, timeoutOf(o), step === "install" ? "install" : "verify")
      checks.push(stepResult(d, step, r, t))
      if (!r.ok) break // a failed install makes the test result meaningless
    }
  } finally { dropWorktree(w.wt) }
  return { ...d, checks }
}

/** verifyRepo without blocking: the spinner keeps moving during a slow install. `onStep` says which command starts. */
export async function verifyRepoAsync(d: Detected, o: { run?: ARun; onStep?: (step: Step["step"], cmd: string) => void } & VerifyOpts = {}): Promise<Verified> {
  const run = o.run ?? realArun, checks: Step[] = []
  const bad = precheck(d, o)
  if (bad) return { ...d, checks: [bad] }
  const w = addWorktree(d)
  if ("err" in w) return { ...d, checks: [early(w.err)] }
  try {
    for (const [step, cmd] of [["install", d.install], ["test", d.test]] as const) {
      if (!cmd) continue
      o.onStep?.(step, cmd)
      const t = Date.now(), r = await run(cmd, w.wt, timeoutOf(o), step === "install" ? "install" : "verify")
      checks.push(stepResult(d, step, r, t))
      if (!r.ok) break
    }
  } finally { dropWorktree(w.wt) }
  return { ...d, checks }
}

/** A project draft (dobby.md frontmatter) from what was detected; verify is the test command, or `true` when there is none. */
export const draftFor = (name: string, d: Detected, repoPath: string, o: { testsOff?: boolean } = {}) =>
  `---\nrepo: ${repoPath}\npriority: 5\nbase: ${d.base}\n${d.upstream ? `upstream: ${d.upstream}\n` : ""}install: ${d.install}\nverify: ${d.test ?? "true"}\n${d.deploy ? `deploy: ${d.deploy}\n` : ""}---\n## Goal\n(set by onboarding)\n${o.testsOff ? "\nTests are off: `verify: true` above checks nothing. Set `verify:` to the real test command.\n" : ""}`

/** The first project file `dobby init <project>` writes, before onboarding fills it in: the repo's own base branch, never a fixed main. */
export const joinDraft = (repoPath: string, d: { base: string }) => `---\nrepo: ${repoPath}\npriority: 5\nbase: ${d.base}\ninstall: true\nverify: true\n---\n## Goal\n(onboarding)\n`

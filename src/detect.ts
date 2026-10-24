// Repo detection for setup: read a repo's own files for its package manager, install, test and deploy commands and its base
// branch, then run install and test once to prove them. Nothing is asked of the user and no model is called.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type Detected = { dir: string; pm: string; install: string; test: string | null; deploy: string | null; base: string; remote: string | null }
export type Verified = Detected & { checks: { step: "install" | "test"; ok: boolean; secs: number; last: string }[] }
type Run = (cmd: string, cwd: string, timeoutMs: number) => { ok: boolean; out: string }

const realRun: Run = (cmd, cwd, timeoutMs) => {
  const r = spawnSync("zsh", ["-lc", cmd], { cwd, encoding: "utf8", timeout: timeoutMs })
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}` }
}
const git = (dir: string, args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" })
const has = (dir: string, f: string) => existsSync(join(dir, f))
const json = (p: string) => { try { return JSON.parse(readFileSync(p, "utf8")) } catch { return null } }

/** The GitHub "owner/name" of the origin remote, or null when there is none. */
export function githubRemote(dir: string): string | null {
  const url = git(dir, ["remote", "get-url", "origin"]).stdout?.trim() ?? ""
  return url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1] ?? null
}

/** The base branch: origin/HEAD, else main or master when origin has it, else the current branch. */
export function baseBranch(dir: string): string {
  const head = git(dir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).stdout?.trim()
  if (head) return head.replace(/^refs\/remotes\/origin\//, "")
  for (const b of ["main", "master"]) if (git(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`]).status === 0) return b
  return git(dir, ["branch", "--show-current"]).stdout?.trim() || "main"
}

/** Commands from the repo's own files, most specific first. A Node repo's lockfile picks the package manager. */
export function detectRepo(dir: string): Detected {
  const out = (pm: string, install: string, test: string | null, deploy: string | null = null): Detected =>
    ({ dir, pm, install, test, deploy, base: baseBranch(dir), remote: githubRemote(dir) })
  const pkg = has(dir, "package.json") ? json(join(dir, "package.json")) : null
  if (pkg) {
    const pm = has(dir, "bun.lock") || has(dir, "bun.lockb") ? "bun" : has(dir, "pnpm-lock.yaml") ? "pnpm" : has(dir, "yarn.lock") ? "yarn" : "npm"
    const s = (pkg.scripts ?? {}) as Record<string, string>
    const run = (n: string) => (pm === "npm" ? `npm run ${n}` : `${pm} run ${n}`)
    const test = s.test && !/no test specified/.test(s.test) ? run("test") : s.check ? run("check") : s.typecheck ? run("typecheck") : null
    return out(pm, pm === "npm" && has(dir, "package-lock.json") ? "npm ci" : `${pm} install`, test, s.deploy ? run("deploy") : null)
  }
  if (has(dir, "Cargo.toml")) return out("cargo", "cargo build", "cargo test")
  if (has(dir, "go.mod")) return out("go", "go build ./...", "go test ./...")
  if (has(dir, "pyproject.toml")) return has(dir, "uv.lock") ? out("uv", "uv sync", "uv run pytest") : out("pip", "pip install -e .", "python -m pytest")
  if (has(dir, "Makefile")) {
    const mk = readFileSync(join(dir, "Makefile"), "utf8")
    return out("make", /^install:/m.test(mk) ? "make install" : "true", /^test:/m.test(mk) ? "make test" : null, /^deploy:/m.test(mk) ? "make deploy" : null)
  }
  return out("none", "true", null)
}

/** Run install, then test, once each with a time limit. A command passes only on exit 0. `last` = its final output line. */
export function verifyRepo(d: Detected, o: { run?: Run; timeoutMs?: number } = {}): Verified {
  const run = o.run ?? realRun, limit = o.timeoutMs ?? 10 * 60_000
  const checks: Verified["checks"] = []
  for (const [step, cmd] of [["install", d.install], ["test", d.test]] as const) {
    if (!cmd) continue
    const t = Date.now(), r = run(cmd, d.dir, limit)
    checks.push({ step, ok: r.ok, secs: Math.round((Date.now() - t) / 1000), last: r.out.trim().split("\n").pop()?.slice(0, 200) ?? "" })
    if (!r.ok) break // a failed install makes the test result meaningless
  }
  return { ...d, checks }
}

/** A project draft (dobby.md frontmatter) from what was detected; verify is the test command, or `true` when there is none. */
export const draftFor = (name: string, d: Detected, repoPath: string) =>
  `---\nrepo: ${repoPath}\npriority: 5\nbase: ${d.base}\ninstall: ${d.install}\nverify: ${d.test ?? "true"}\n${d.deploy ? `deploy: ${d.deploy}\n` : ""}---\n## Goal\n(set by onboarding)\n`

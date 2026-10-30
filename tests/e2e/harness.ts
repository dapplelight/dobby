// End-to-end harness: a throwaway Dobby world in temp dirs, driven through the real CLI (`src/cli.ts tick`, the queue loop the
// background job runs). Claude is tests/e2e/bin/claude, GitHub is tests/e2e/bin/gh over local bare repos, usage is bin/usage.js.
// Nothing here reads ~/.config/dobby, ~/.claude or the real data dir, and nothing reaches the network: the child gets a minimal
// environment (HOME, DOBBY_* and PATH with the fakes first), never process.env.
import Database from "better-sqlite3"
import { spawnSync } from "node:child_process"
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname } from "node:path"

const REPO_ROOT = new URL("../../", import.meta.url).pathname
const BIN = new URL("./bin", import.meta.url).pathname
export const SLUG = "acme/tally"

export type Scenario = { signedOut?: boolean; roles?: Record<string, Record<string, unknown>[]> }
export type Opts = {
  /** A scenario object, or the name of a file in tests/e2e/scenarios/ (without .json). */
  scenario?: Scenario | string
  /** Private config merged over the defaults (safety preset, deploy, ...). */
  config?: Record<string, unknown>
  /** Extra frontmatter lines for the project's dobby.md (deploy: ..., verify: ...). */
  project?: string[]
  /** Extra files committed to the fixture repo's first commit. */
  files?: Record<string, string>
  usage?: { five?: number; week?: number }
  /** Extra environment for every child; {root} becomes the world's temp root. */
  env?: Record<string, string>
  /** More fixture projects (names), each its own repo acme/<name> with the same files as tally. */
  moreProjects?: string[]
  /** Scale for Dobby's waits (merge.ts waits 20 s for checks to register). */
  sleepScale?: number
}
export type Call = { n: number; role: string; model?: string; resume?: string; cwd: string; args: string[]; promptChars: number }
export type Pr = { repo: string; number: number; title: string; body: string; head: string; base: string; draft: boolean; state: string; author: string; lastHead: string; comments: { id: number; user: string; body: string }[]; reviews: { state: string; commit_id: string; comments: unknown[] }[] }
export type Ticket = { id: number; project: string; title: string; status: string; note: string | null; branch: string | null; done_when: string }

const asScenario = (s: Scenario | string | undefined): Scenario => (typeof s === "string" ? JSON.parse(readFileSync(new URL(`./scenarios/${s}.json`, import.meta.url), "utf8")) : s ?? {})
const DOBBY_MD = (extra: string[]) => ["---", "base: main", "install: true", "verify: node --test", "priority: 5", ...extra, "---", "## Goal", "A tiny money-tracking fixture app (made up for tests).", ""].join("\n")

export function world(o: Opts = {}) {
  // A fake that is not executable is skipped by PATH lookup and the REAL claude or gh would run: refuse before anything starts.
  for (const f of ["claude", "gh"]) { try { accessSync(`${BIN}/${f}`, constants.X_OK) } catch { throw new Error(`tests/e2e/bin/${f} must be executable (chmod +x), or the real ${f} would run`) } }
  const root = mkdtempSync(`${tmpdir()}/dobby-e2e-`)
  const dir = { home: `${root}/home`, data: `${root}/data`, projects: `${root}/projects`, gh: `${root}/gh`, logs: `${root}/logs` }
  for (const d of Object.values(dir)) mkdirSync(d, { recursive: true })
  const scenarioFile = `${root}/scenario.json`
  const usageFile = `${root}/usage.json`
  const callLog = `${dir.logs}/claude.jsonl`
  const ghLog = `${dir.logs}/gh.jsonl`
  writeFileSync(scenarioFile, JSON.stringify(asScenario(o.scenario)))
  writeFileSync(usageFile, JSON.stringify(o.usage ?? {}))
  writeFileSync(`${dir.home}/.gitconfig`, "[user]\n\tname = Dobby Test\n\temail = test@example.test\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[protocol \"file\"]\n\tallow = always\n")
  writeFileSync(`${root}/config.json`, JSON.stringify({
    timezone: "Asia/Kolkata", github: { owner: "acme", accounts: ["acme"] }, paths: { projects: dir.projects, data: dir.data, usageCli: `${BIN}/usage.js` },
    scout: { enabled: false }, safety: { preset: "balanced", rules: {}, classifier: "none", unsure: "allow" },
    ...o.config,
  }))
  writeFileSync(`${root}/secrets.env`, "")

  // The child's whole environment. process.env is not copied, so a real token or key in the test runner's shell cannot leak in.
  const env: Record<string, string> = {
    PATH: `${BIN}:${process.env.PATH ?? ""}`, HOME: dir.home, TMPDIR: process.env.TMPDIR ?? tmpdir(), LANG: "C.UTF-8",
    GIT_CONFIG_GLOBAL: `${dir.home}/.gitconfig`, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
    DOBBY_DIR: dir.data, DOBBY_SECRETS: `${root}/secrets.env`, DOBBY_CONFIG: `${root}/config.json`, DOBBY_PROJECTS: dir.projects,
    DOBBY_BUILDER_SANDBOX: "off", DOBBY_TICK_SCAN: "off", JEV_API_KEY: "", DOBBY_SLEEP_SCALE: String(o.sleepScale ?? 0),
    DOBBY_FAKE_SCENARIO: scenarioFile, DOBBY_FAKE_LOG: callLog, DOBBY_FAKE_STATE: `${dir.logs}/state`, DOBBY_FAKE_USAGE: usageFile,
    DOBBY_FAKE_GH_DIR: dir.gh, DOBBY_FAKE_GH_LOG: ghLog, DOBBY_FAKE_GH_USER: "acme",
    ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}),
    ...Object.fromEntries(Object.entries(o.env ?? {}).map(([k, v]) => [k, v.replaceAll("{root}", root)])),
  }
  const sh = (cmd: string, args: string[], cwd: string) => {
    const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8" })
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} (in ${cwd}): ${r.stderr || r.stdout}`)
    return r.stdout
  }
  const git = (cwd: string, ...a: string[]) => sh("git", a, cwd)

  // The fixture projects: each a bare "GitHub" repo with one commit, and a clone of it under projects/.
  const makeProject = (name: string) => {
    const bare = `${dir.gh}/github.com/acme/${name}.git`, clone = `${dir.projects}/${name}`, seed = `${root}/seed-${name}`
    mkdirSync(seed)
    git(seed, "init", "-q")
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: `${name}-fixture`, private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
      "src/greet.js": "export const greet = (name) => `Hello, ${name}`\n",
      "test/greet.test.js": "import assert from \"node:assert/strict\"\nimport { test } from \"node:test\"\nimport { greet } from \"../src/greet.js\"\n\ntest(\"greet\", () => assert.equal(greet(\"Asha\"), \"Hello, Asha\"))\n",
      "dobby.md": DOBBY_MD(name === "tally" ? o.project ?? [] : []),
      ".gitignore": "node_modules\n",
      ...(name === "tally" ? o.files : {}),
    }
    for (const [p, body] of Object.entries(files)) { mkdirSync(dirname(`${seed}/${p}`), { recursive: true }); writeFileSync(`${seed}/${p}`, body) }
    git(seed, "add", "-A"); git(seed, "commit", "-qm", "Fixture app")
    mkdirSync(dirname(bare), { recursive: true })
    git(root, "clone", "-q", "--bare", seed, bare)
    git(root, "clone", "-q", bare, clone)
    return { bare, clone }
  }
  const { bare: bareRepo, clone: repo } = makeProject("tally")
  for (const extra of o.moreProjects ?? []) makeProject(extra)

  const dobbyEnv = (extra: Record<string, string>, ...a: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", `${REPO_ROOT}src/cli.ts`, ...a], { cwd: dir.home, env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000 })
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr }
  }
  const dobby = (...a: string[]) => dobbyEnv({}, ...a)
  // First CLI call creates the database. These runs must not wander off: planning, scouting and the board are not under test.
  dobby("pause", "planning"); dobby("pause", "scout")
  const db = () => new Database(`${dir.data}/dobby.db`)
  const withDb = <T>(f: (d: Database.Database) => T): T => { const d = db(); try { return f(d) } finally { d.close() } }
  for (const n of ["tally", ...(o.moreProjects ?? [])]) withDb((d) => d.prepare("INSERT OR REPLACE INTO kv VALUES (?, '1')").run(`onboarded:${n}`))

  const jsonl = <T>(f: string): T[] => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [])
  const w = {
    root, dir, repo, bareRepo, env, dobby, dobbyEnv, git, sh,
    /** A ready ticket (status ready, size S); returns its id. */
    addTicket(title: string, doneWhen = "", size = "S", priority = 50, project = "tally"): number {
      const r = dobby("add", project, title, doneWhen, size, String(priority))
      const id = Number(r.stdout.match(/#(\d+)/)?.[1])
      if (!id) throw new Error(`dobby add failed: ${r.out}`)
      return id
    },
    tick: () => dobby("tick"),
    /** Ticks until no ticket is ready or running, at most maxSteps ticks. Returns the combined output. */
    runUntilIdle({ maxSteps = 6 }: { maxSteps?: number } = {}) {
      let out = ""
      for (let i = 0; i < maxSteps; i++) {
        const r = dobby("tick")
        out += `\n--- tick ${i + 1} (exit ${r.code})\n${r.out}`
        if (!withDb((d) => d.prepare("SELECT 1 FROM tickets WHERE status IN ('ready','running') LIMIT 1").get())) break
      }
      return out
    },
    ticket: (id: number) => withDb((d) => d.prepare("SELECT id, project, title, status, note, branch, done_when FROM tickets WHERE id=?").get(id)) as Ticket,
    kv: (k: string) => (withDb((d) => d.prepare("SELECT v FROM kv WHERE k=?").get(k)) as { v: string } | undefined)?.v,
    setKv: (k: string, v: string) => withDb((d) => d.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(k, v)),
    sql: <T = unknown>(q: string, ...p: unknown[]) => withDb((d) => d.prepare(q).all(...p)) as T[],
    prs: (): Pr[] => (existsSync(`${dir.gh}/state.json`) ? JSON.parse(readFileSync(`${dir.gh}/state.json`, "utf8")).prs : []),
    /** Claude calls so far, in order: role, model, args (no prompt body). */
    log: () => jsonl<Call>(callLog),
    roles: () => jsonl<Call>(callLog).map((c) => c.role),
    ghCalls: () => jsonl<{ args: string[]; cwd: string; code: number; status: string }>(ghLog),
    outbox: () => (existsSync(`${dir.data}/outbox.log`) ? readFileSync(`${dir.data}/outbox.log`, "utf8") : ""),
    /** Commit subjects on the bare repo's main, newest first. */
    mainLog: () => git(bareRepo, "log", "--format=%s", "main").trim().split("\n"),
    mainFile: (p: string) => { try { return git(bareRepo, "show", `main:${p}`) } catch { return undefined } },
    branches: () => git(bareRepo, "for-each-ref", "--format=%(refname:short)", "refs/heads").trim().split("\n").filter(Boolean),
    usage: (u: { five?: number; week?: number }) => writeFileSync(usageFile, JSON.stringify(u)),
    scenario: (s: Scenario | string) => writeFileSync(scenarioFile, JSON.stringify(asScenario(s))),
    clean: () => rmSync(root, { recursive: true, force: true }),
  }
  return w
}
export type World = ReturnType<typeof world>

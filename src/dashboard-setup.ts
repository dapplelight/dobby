// `dobby init --ui`: the browser face of setup. The state of one setup run lives here; /api/setup/* (dashboard-server.ts, setup mode only) reads and changes it
// through the same step functions the terminal uses (setup-steps.ts). A request names a folder, a repo or a tool from a list Dobby made itself; it never carries a
// command, a flag or an argument. Commands come from detection (detect.ts), the fixed tool list (tools.ts) and installJobs. Secrets are shown as set / not set.
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"
import type { SetupState, SetupVerify } from "./api-schema.ts"
import type { Check } from "./checks.ts"
import { config, configDir, loadConfig, privatePath, setConfig } from "./config.ts"
import { configSetText } from "./config-edit.ts"
import type { DB } from "./db.ts"
import { repoWarnings, verifyRepoAsync, type Detected, type Verified } from "./detect.ts"
import { installJobs, JOBS } from "./jobs.ts"
import { chatOn as discordOn } from "./chat/platform.ts"
import { setPause } from "./pause.ts"
import {
  AUTOS, blockingChecks, checkMachine, chatStatus, checkRepoPath, checkRoot, DEPLOYS, defaultRoots, expand, firstTicketCandidates, forkAsk, forkParent, scanRepos, skippedRows, installTool, INSTALLABLE, loginOf, PRESETS,
  queueCandidate, repoName, saveRepos, saveSettings, tidy, toolRows, type Candidate, type GhIssues, type RunCmd, type ToolRow,
} from "./setup-steps.ts"
import { repoRights, suggestedMethod, type RepoRow } from "./repo-rights.ts"
import { askHelp, CHECK_NAMES, helpAvailable, unsafeReason, type ClaudeFn, type HelpInput } from "./setup-help.ts"
import { onPath } from "./install.ts"
import { ephemeral } from "./jobs.ts"
import { machineId, readPrivate, repoMarkers } from "./setup-edge.ts"
import { spawnSync } from "node:child_process"
import { hostname } from "node:os"
import { askStats, forcedOff, record, releaseHeld } from "./stats.ts"
import { HELP_KINDS, REASONS } from "./stats-schema.ts"
import { enabled, type Tool } from "./tools.ts"

/** Everything that touches the machine is a field here, so a test runs the whole flow on fakes. */
export type SetupDeps = {
  db: DB
  /** the checkout's root (the bin that background jobs run) */
  root: string
  roots?: string[]
  check?: () => Promise<Check[]>
  find?: (roots: string[]) => Detected[]
  /** reads one repo's remotes (tests inject it); the real one is detectRepo, with ssh -G for host aliases */
  detect?: (dir: string) => Detected
  /** the folder `dobby init --ui` was run in: offered when it is a repo */
  cwd?: string
  /** the repo a fork was made from, or null (the real one is gh repo view) */
  fork?: (remote: string) => string | null
  /** how install and test commands run (tests inject a fake); the real one is the builds' sandbox in a clean copy */
  run?: NonNullable<Parameters<typeof verifyRepoAsync>[1]>["run"]
  verify?: { has?: (bin: string) => boolean; lfs?: () => boolean }
  tools?: { found?: (t: Tool) => boolean; run?: RunCmd; have?: (bin: string) => boolean }
  jobs?: () => { name: string; ok: boolean; detail: string }[]
  issues?: GhIssues
  discord?: (db: DB) => Promise<string>
  /** the model call for Ask Claude (tests inject it; the real one is claude() in lib.ts) */
  claude?: ClaudeFn
  /** what the signed-in account may do on a repo (repoRights in repo-rights.ts) */
  /** the DOBBY_OWNER marker: this machine's id and the `gh` runner (tests inject both) */
  machine?: string
  gh?: (args: string[]) => { ok: boolean; out: string }
  /** is a `dobby` command on PATH */
  onPath?: () => boolean
  rights?: (remote: string, o: { base: string; method?: never }) => Promise<RepoRow[]>
  configFile?: string
  home?: string
  platform?: NodeJS.Platform
  fresh?: boolean
  onFinish?: () => void
}
export type Reply = { code: number; body: Record<string, unknown> }
const ok = (message: string, extra: object = {}): Reply => ({ code: 200, body: { ok: true, message, ...extra } })
const no = (code: number, message: string): Reply => ({ code, body: { ok: false, message } })
const REASON: Record<string, (typeof REASONS)[number]> = { "GitHub CLI": "gh_missing", "GitHub sign-in": "gh_signed_out", "Claude Code": "claude_missing", "Claude sign-in": "claude_signed_out", git: "git_missing", Node: "node_old" }
const bool = (v: unknown) => v === true

type VerifyRow = SetupVerify

export function createSetup(deps: SetupDeps, emit: (state: unknown) => void = () => {}) {
  const db = deps.db, home = deps.home ?? homedir(), platform = deps.platform ?? process.platform
  const file = deps.configFile ?? privatePath()
  let checks: Check[] | null = null
  let roots = (deps.roots?.length ? deps.roots : defaultRoots()).map((r) => tidy(expand(r)))
  const byPath: Detected[] = [] // repos added one by one
  let repos: Detected[] = []
  const verify: Record<string, VerifyRow> = {}
  const forks: Record<string, { parent: string; use: "fork" | "upstream" }> = {} // forks found while checking, and where the person sends PRs
  let skipped: { text: string; fix: string | null }[] = []
  const tails: Record<string, string> = {} // the last 50 lines of a failed command, for Ask Claude; never sent to the page
  const testsOff = new Set<string>(), written = new Set<string>() // repos added anyway; drafts this run wrote (and may write again)
  const marked = new Set<string>(), markerWarnings: string[] = [] // repos that got their DOBBY_OWNER marker, and what another machine's marker said
  let suggestedMerge: string | undefined // a merge method the repos allow, when the configured one is closed
  const overrides: Record<string, { install: string; test: string | null }> = {} // commands the person typed or accepted, already checked
  let verifying = false
  let settingsSaved = false
  const installed: Record<string, boolean> = {}
  let jobs: { state: "none" | "installed" | "later"; rows: { name: string; ok: boolean; detail: string }[] } = { state: "none", rows: [] }
  let candidates: Candidate[] | null = null
  let ticket: string | null = null
  let finished = false
  let statsAnswered = false
  const fresh = deps.fresh ?? (!existsSync(file) || !JSON.parse(readFileSync(file, "utf8") || "{}").timezone)
  const relist = () => {
    const scan = deps.find ? { repos: deps.find(roots), skipped: [] } : scanRepos(roots, deps.detect, { cwd: deps.cwd })
    const found = scan.repos
    skipped = skippedRows(scan.skipped)
    const seen = new Set(found.map((d) => d.dir))
    repos = [...found, ...byPath.filter((d) => !seen.has(d.dir) && !found.some((f) => repoName(f) === repoName(d)))].map((d) => (overrides[repoName(d)] ? { ...d, ...overrides[repoName(d)] } : d))
  }
  relist()

  const ready = () => repos.filter((d) => verify[repoName(d)]?.state === "ok").map((d) => (forks[repoName(d)]?.use === "upstream" ? { ...d, upstream: forks[repoName(d)].parent } : d))
  const toolView = (): ToolRow[] => { const c = loadConfig().config; return toolRows(deps.tools?.found, (t) => enabled(t, c), deps.tools?.have) }

  /** Install and test each repo with the commands from detection (or the ones the person confirmed), one after the other; progress goes out as setup events. */
  function runVerify(picked: Detected[]) {
    for (const d of picked) { delete tails[repoName(d)]; testsOff.delete(repoName(d)); verify[repoName(d)] = { state: "waiting", step: null, command: null, secs: null, last: "", fix: null, testsOff: false, notes: [] } }
    verifying = true; push()
    void (async () => {
      try {
        for (const d of picked) {
          const row = verify[repoName(d)]
          const t0 = Date.now()
          // can this account push and merge here? A repo it cannot push to is left out; the rest are notes
          const rr = d.remote ? await (deps.rights ?? ((r: string, o: { base: string }) => repoRights(r, { base: o.base, method: config().github.mergeMethod })))(d.remote, { base: d.base }).catch(() => [] as RepoRow[]) : []
          suggestedMerge ??= suggestedMethod(rr)
          const parent = d.remote && !forks[repoName(d)] ? (deps.fork ?? forkParent)(d.remote) : null
          if (parent) forks[repoName(d)] = { parent, use: "fork" } // asked once, after the check; the default keeps the fork
          row.notes = [...repoWarnings(d), ...rr.filter((r) => r.ok === false || r.name.startsWith("Merge queue")).map((r) => `${r.name}: ${r.detail}${r.fix ? ` (${r.fix})` : ""}`)]
          const blocked = rr.find((r) => r.required && !r.ok)
          if (blocked) { Object.assign(row, { state: "failed", step: null, command: null, last: blocked.detail, fix: blocked.fix ?? null }); push(); continue }
          const v: Verified = await verifyRepoAsync(d, { run: deps.run, ...deps.verify, onStep: (step, cmd) => { Object.assign(row, { state: "running", step, command: cmd, secs: null }); push() } })
          const bad = v.checks.find((c) => !c.ok)
          if (bad?.tail) tails[repoName(d)] = bad.tail
          Object.assign(row, bad
            ? { state: "failed", step: bad.step, command: bad.step === "install" ? d.install : d.test, secs: bad.secs, last: bad.last, fix: `Run \`${bad.step === "install" ? d.install : d.test}\` in ${tidy(d.dir)} until it passes, then check again.` }
            : { state: "ok", step: null, command: null, secs: Math.round((Date.now() - t0) / 1000), last: v.checks.at(-1)?.last ?? "", testsOff: false, notes: row.notes })
          push()
        }
        saveDrafts()
        markRepos()
        record(db, "setup_step", { step: "repos", ok: ready().length > 0, ...(ready().length ? {} : { reason: "tests_failed" }) })
      } finally { verifying = false; push() }
    })()
  }
  const saveDrafts = () => { saveRepos(ready(), deps.root, (d) => testsOff.has(repoName(d)), (d) => written.has(repoName(d))); for (const d of ready()) written.add(repoName(d)) }

  const ownersOf = () => [...new Set([checks ? loginOf(checks) : "", ...ready().map((d) => d.remote!.split("/")[0])].filter(Boolean))]
  /** A config from another account or copied dotfiles: github.owner differs from the signed-in login. The page asks, like the terminal. */
  function ownerMismatch() {
    const login = checks ? loginOf(checks) : "", have = readPrivate(file)
    return login && have.github?.owner && have.github.owner !== login ? { configured: String(have.github.owner), login } : null
  }
  /** One DOBBY_OWNER marker per repo that passed: set where missing; another machine's marker comes back as a warning (the terminal's repoMarkers). */
  function markRepos() {
    const fresh = ready().map((d) => d.remote!).filter((r) => !marked.has(r))
    if (!fresh.length) return
    const run = deps.gh ?? ((args: string[]) => { const r = spawnSync("gh", args, { encoding: "utf8" }); return { ok: r.status === 0, out: r.stdout ?? "" } })
    markerWarnings.push(...repoMarkers(fresh, deps.machine ?? machineId(), run, hostname()))
    for (const r of fresh) marked.add(r)
  }
  function state(): SetupState {
    const cfg = loadConfig().config
    const forced = forcedOff()
    return {
      platform, fresh, finished,
      checks: checks?.filter((r) => r.name !== "config").map((r) => ({ name: r.name, ok: r.ok, required: r.required, detail: r.detail, fix: r.fix ?? null })) ?? null,
      blocking: checks ? blockingChecks(checks).map((r) => r.name) : [],
      stats: { answered: statsAnswered || (cfg.stats?.crashes !== undefined && cfg.stats?.usage !== undefined), forced: forced ?? null },
      roots, commonRoots: defaultRoots(undefined, () => true).filter((r) => !roots.includes(r)).filter((r) => existsSync(expand(r))),
      repos: repos.map((d) => ({ name: repoName(d), path: tidy(d.dir), from: tidy(dirname(d.dir)), pm: d.pm, install: d.install, test: d.test, base: d.base, remote: d.remote, hasTests: !!d.test, byPath: byPath.includes(d), fork: forks[repoName(d)] && d.remote ? { ...forkAsk(repoName(d), d.remote, forks[repoName(d)].parent), use: forks[repoName(d)].use } : null })),
      skipped,
      verify,
      chat: chatStatus(),
      tools: toolView(),
      installed,
      help: helpAvailable(checks),
      markerWarnings,
      ownerMismatch: ownerMismatch(),
      dobbyCommand: !(deps.onPath ?? onPath)() && ephemeral(deps.root) ? { command: "npm i -g dobby-ai", why: "The dobby command is not on your PATH yet: run this in a terminal, and make sure npm's global bin folder (npm prefix -g)/bin is on PATH." } : null,
      terminal: [
        ...(chatStatus().discordToken ? [] : [{ name: "Discord bot token", command: "dobby add discord", why: "asks for the token in the terminal, hidden. This page never takes it." }]),
        ...(checks?.some((r) => r.name === "Claude sign-in" && !r.ok) ? [{ name: "Anthropic API key", command: "dobby init", why: "no plan sign-in: dobby init in a terminal asks plan or key, hidden. This page never takes it." }] : []),
      ],
      weekCap: cfg.pacing?.weekCap ?? 95,
      settingsSaved,
      jobList: JOBS.map((j) => ({ name: j.name, what: j.what })), jobs,
      jobsAvailable: platform === "darwin" || platform === "linux",
      candidates: candidates?.map((c) => ({ project: c.project, remote: c.remote, number: c.number, title: c.title, text: c.body.slice(0, 400) })) ?? null,
      ticket,
      saved: { config: tidy(file), projects: tidy(expand(config().paths.projects)), data: tidy(expand(config().paths.data)), configDir: tidy(configDir()) },
      mergesPaused: fresh,
    }
  }
  const push = () => emit(state())

  async function handle(path: string, b: Record<string, unknown>): Promise<Reply> {
    switch (path) {
      case "check": {
        checks = await (deps.check ?? checkMachine)()
        const blocking = blockingChecks(checks)
        record(db, "setup_step", { step: "checks", ok: !blocking.length, ...(blocking.length ? { reason: REASON[blocking[0].name] ?? "other" } : {}) })
        push()
        return ok(blocking.length ? "Something on this machine needs fixing." : "This machine is ready.")
      }
      case "stats": { // the two questions; no answer = off
        const why = forcedOff()
        if (why) { releaseHeld(db); statsAnswered = true; push(); return ok(`${why}: crash reports and usage stats stay off.`) }
        const answers = [bool(b.crashes), bool(b.usage)]
        await askStats(db, async () => answers.shift()!, (key, value) => void configSetText({ key, value }, { file }))
        setConfig(); statsAnswered = true; push()
        return ok("Saved.")
      }
      case "repos/roots": { // folders to look in: each checked on the server, then only listed
        if (!Array.isArray(b.roots) || b.roots.length > 20) return no(400, "roots must be a list of folders")
        const next: string[] = []
        for (const r of b.roots) { const c = checkRoot(r, home); if (!c.ok) return no(400, c.reason); const t = tidy(c.dir); if (!next.includes(t)) next.push(t) }
        roots = next; relist(); push()
        return ok(`Looking in ${roots.length} folder${roots.length === 1 ? "" : "s"}.`)
      }
      case "repos/add": { // one repo by path
        const c = checkRepoPath(b.path, { home })
        if (!c.ok) return no(400, c.reason)
        if (!repos.some((d) => d.dir === c.d.dir)) { if (repos.some((d) => repoName(d) === repoName(c.d))) return no(409, `A repo named ${repoName(c.d)} is already listed.`); byPath.push(c.d); relist() }
        push()
        return ok(`Added ${repoName(c.d)}.`)
      }
      case "repos/verify": {
        if (verifying) return no(409, "Checking is already running.")
        const names = Array.isArray(b.names) ? b.names : null
        if (!names || !names.length || names.length > 100) return no(400, "Pick at least one repo.")
        const picked: Detected[] = []
        for (const n of names) { const d = repos.find((r) => repoName(r) === n); if (!d) return no(400, "That repo was not in the list."); if (!picked.includes(d)) picked.push(d) }
        runVerify(picked)
        return ok("Checking.")
      }
      case "repos/commands": { // install and test commands the person typed or accepted from Ask Claude: checked like any command, then verified again
        if (verifying) return no(409, "Checking is already running.")
        const d = repos.find((r) => repoName(r) === b.name)
        if (!d) return no(400, "That repo was not in the list.")
        const install = typeof b.install === "string" && b.install.trim() ? b.install.trim() : d.install
        const test = typeof b.test === "string" && b.test.trim() ? b.test.trim() : d.test
        if (b.install !== undefined && typeof b.install !== "string" || b.test !== undefined && typeof b.test !== "string") return no(400, "Commands are text.")
        for (const [field, cmd] of [["install", install], ["test", test]] as const) { const why = cmd ? unsafeReason(cmd, d.dir) : null; if (why) return no(400, `The ${field} command is refused: ${why}`) }
        overrides[repoName(d)] = { install, test }; relist()
        runVerify([repos.find((r) => repoName(r) === b.name)!])
        return ok("Checking.")
      }
      case "repos/add-anyway": { // tests off until fixed: the project file gets verify: true
        const d = repos.find((r) => repoName(r) === b.name)
        if (!d) return no(400, "That repo was not in the list.")
        if (verify[repoName(d)]?.state === "ok" && !testsOff.has(repoName(d))) return no(409, "That repo already passed.")
        testsOff.add(repoName(d))
        verify[repoName(d)] = { state: "ok", step: null, command: null, secs: null, last: "", fix: null, testsOff: true, notes: verify[repoName(d)]?.notes ?? [] }
        saveDrafts(); markRepos(); push()
        return ok(`${repoName(d)} is added with tests off. Set verify: in its project file when the tests can run.`)
      }
      case "repos/fork": { // where PRs and first-ticket issues go for a fork: the fork itself (default) or the original
        const d = repos.find((r) => repoName(r) === b.name), f = d && forks[repoName(d)]
        if (!d || !f) return no(400, "That repo is not a fork.")
        if (b.use !== "fork" && b.use !== "upstream") return no(400, "use is fork or upstream")
        f.use = b.use
        if (written.has(repoName(d))) saveDrafts()
        push()
        return ok(b.use === "upstream" ? `${repoName(d)} sends pull requests to ${f.parent}.` : `${repoName(d)} keeps its fork.`)
      }
      case "repos/skip": {
        const d = repos.find((r) => repoName(r) === b.name)
        if (!d) return no(400, "That repo was not in the list.")
        delete verify[repoName(d)]; testsOff.delete(repoName(d)); push()
        return ok("Skipped.")
      }
      case "help": { // Ask Claude: only on a click, only about a repo or a check Dobby listed; Haiku, or Sonnet when the person asks
        const avail = helpAvailable(checks)
        if (!avail.ok) return no(409, avail.reason!)
        if (!(HELP_KINDS as readonly string[]).includes(b.kind as string)) return no(400, "Ask about a repo or a check.")
        if (b.model !== undefined && b.model !== "haiku" && b.model !== "sonnet") return no(400, "model is haiku or sonnet")
        let input: HelpInput
        if (b.kind === "check") {
          const row = checks!.find((r) => !r.ok && (CHECK_NAMES as readonly string[]).includes(r.name) && r.name === b.check)
          if (!row) return no(400, "That check is not failing.")
          input = { kind: "check", name: row.name, detail: row.detail }
        } else {
          const d = repos.find((r) => repoName(r) === b.repo)
          if (!d) return no(400, "That repo was not in the list.")
          const v = verify[repoName(d)]
          if (b.kind === "verify-failed") { if (v?.state !== "failed") return no(400, "That repo did not fail."); input = { kind: "verify-failed", name: repoName(d), repoDir: d.dir, command: v.command ?? "", output: tails[repoName(d)] ?? v.last } }
          else { if (d.test) return no(400, "That repo has a test command."); input = { kind: "no-commands", name: repoName(d), repoDir: d.dir } }
        }
        const r = await askHelp(db, input, { claude: deps.claude, model: b.model === "sonnet" ? "sonnet" : "haiku" })
        return { code: 200, body: { ok: r.ok, message: r.message, suggestion: r.suggestion ?? null, refused: r.refused, model: r.model } }
      }
      case "chat": {
        if (b.chat !== "terminal" && b.chat !== "discord") return no(400, "chat is terminal or discord")
        let message = "Dobby asks you in the terminal."
        if (b.chat === "discord") {
          if (!chatStatus().discordToken) return no(409, "DISCORD_BOT_TOKEN is not set in secrets.env yet.")
          try { message = `Discord channels ready in "${await (deps.discord ?? (async (d) => (await (await import("./chat/platform.ts")).platform()).setup(d)))(db)}". Run dobby discord test to see a message in each.` } catch (e) { return no(500, `Discord: ${(e as Error).message}`) }
        }
        record(db, "setup_step", { step: "chat", ok: true }); push()
        return ok(message)
      }
      case "tools/install": {
        const name = typeof b.name === "string" ? b.name : ""
        if (!(INSTALLABLE as readonly string[]).includes(name)) return no(400, `${name || "That"} has nothing to install here.`)
        const r = installTool(name, deps.tools?.run, deps.tools?.have)
        installed[name] = r.results.every((x) => x.ok)
        push()
        return { code: r.results.every((x) => x.ok) ? 200 : 500, body: { ok: installed[name], message: installed[name] ? `${name} installed.` : `${r.results.find((x) => !x.ok)!.cmd} failed: ${r.results.find((x) => !x.ok)!.last}`, results: r.results } }
      }
      case "settings": {
        if (!checks) return no(409, "Check this machine first.")
        const preset = PRESETS.find((x) => x === b.preset), auto = AUTOS.find((x) => x === b.auto), deploy = DEPLOYS.find((x) => x === b.deploy)
        const weekCap = b.weekCap
        if (!preset || !auto || !deploy) return no(400, "Pick a safety level, automatic reviews and what happens after a merge from the lists.")
        if (typeof weekCap !== "number" || !Number.isInteger(weekCap) || weekCap < 10 || weekCap > 100) return no(400, "Stop at is a whole number from 10 to 100.")
        const mismatch = ownerMismatch()
        if (mismatch && b.owner !== "keep" && b.owner !== "login") return no(400, `config.json says github.owner is ${mismatch.configured}, but gh is signed in as ${mismatch.login}. Choose which to use.`)
        const have = readPrivate(file)
        if (mismatch && b.owner === "login") have.github = { ...have.github, owner: mismatch.login, accounts: ownersOf() } // the signed-in login wins, as in the terminal
        const r = saveSettings({ preset, auto, deploy, weekCap }, { have, login: loginOf(checks), remotes: ready().map((d) => d.remote!), projects: roots, mergeMethod: suggestedMerge && !config().github.mergeMethod ? suggestedMerge : undefined }, file)
        setConfig()
        if (fresh) setPause(db, { kind: "merges" }, true, "setup") // the first merge always waits for the owner
        const missing = toolView().filter((t) => (INSTALLABLE as readonly string[]).includes(t.name) && !t.found)
        record(db, "setup_step", { step: "tools", ok: !missing.length || Object.values(installed).some(Boolean) })
        record(db, "setup_step", { step: "settings", ok: true })
        settingsSaved = true; push()
        return ok(`Settings saved in ${tidy(file)}${r.kept ? " (your existing values kept)" : ""}`)
      }
      case "jobs": {
        if (b.install === true) {
          if (platform !== "darwin" && platform !== "linux") return no(400, `Background jobs are not available on ${platform}: run dobby start in a terminal.`)
          const rows = (deps.jobs ?? (() => installJobs({ discord: !!discordOn(), bin: `${deps.root}bin/dobby`, home, uid: process.getuid?.() ?? 0, log: () => {} })))()
          jobs = { state: "installed", rows }
          record(db, "setup_step", { step: "jobs", ok: rows.every((x) => x.ok), ...(rows.every((x) => x.ok) ? {} : { reason: "other" }) })
          push()
          return ok(rows.every((x) => x.ok) ? "Dobby is running." : "Some jobs did not start.")
        }
        jobs = { state: "later", rows: [] }
        record(db, "setup_step", { step: "jobs", ok: false, reason: "skipped" }); push()
        return ok("Later: run dobby jobs install.")
      }
      case "first-ticket/find": {
        candidates = firstTicketCandidates(ready(), deps.issues); push()
        return ok(candidates.length ? "Found." : "No open issue is small and clear enough for a first ticket.")
      }
      case "first-ticket": {
        if (b.skip === true) { record(db, "setup_step", { step: "first_ticket", ok: false, reason: "skipped" }); return ok("Skipped.") }
        let c: Candidate | undefined
        if (typeof b.issue === "number") c = candidates?.find((x) => x.number === b.issue && (b.project === undefined || x.project === b.project))
        else if (typeof b.title === "string" && b.title.trim() && b.title.length <= 300) {
          const p = typeof b.project === "string" ? b.project : repoName(ready()[0] ?? { dir: "/" } as Detected)
          if (!ready().some((d) => repoName(d) === p)) return no(400, "Pick one of the projects that passed.")
          const { addTicket, queueTicket } = await import("./lib.ts")
          ticket = queueTicket(db, addTicket(db, { project: p, title: b.title.trim(), size: "S" }).id)
          record(db, "setup_step", { step: "first_ticket", ok: true }); push()
          return ok(ticket)
        }
        if (!c) return no(400, "That issue was not offered.")
        ticket = await queueCandidate(db, c)
        record(db, "setup_step", { step: "first_ticket", ok: true }); push()
        return ok(ticket)
      }
      case "finish": {
        if (!ready().length) return no(409, "No project is ready. Fix a failing command, set the test command, or add a repo anyway, then finish.")
        if (!finished) { finished = true; record(db, "setup_done"); releaseHeldIfOpen(); if (deps.onFinish) setTimeout(deps.onFinish, 400).unref() }
        push()
        return ok("Setup is done.")
      }
      default: return no(404, "not found")
    }
  }
  /** The stats step was never answered (the page was left): the held funnel is dropped, which is the same as no. */
  const releaseHeldIfOpen = () => { if (!statsAnswered) releaseHeld(db) }
  return { state, handle }
}

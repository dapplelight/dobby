// `dobby init`: one-command setup. Checks this machine, signs in where needed, finds repos and proves their commands,
// asks at most three questions (repos, chat, settings), starts the background jobs and offers a first ticket.
// Every step can run again: what is already set (config values, project drafts, jobs) is kept. --yes takes the
// recommended answer everywhere and never builds anything; without a terminal it must be given.
import * as p from "@clack/prompts"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { config, configDir, privatePath, setConfig } from "./config.ts"
import { configSetText } from "./config-edit.ts"
import { askStats, forcedOff, holdEvents, record, releaseHeld } from "./stats.ts"
import { repoName, blockingChecks, checkMachine, chatStatus, defaultRoots, expand, firstTicketCandidates, forkAsk, forkParent, scanRepos, skippedLines, installTool, loginOf, queueCandidate, saveRepos, saveSettings, tidy, toolRows, toolsMissing, type Candidate } from "./setup-steps.ts"
import { CHECK_NAMES, helpAvailable, HELP_LABEL, NO_ANSWER, SONNET_LABEL, unsafeReason, askHelp, type HelpInput } from "./setup-help.ts"
import { repoWarnings, verifyRepoAsync, type Detected } from "./detect.ts"
import { installJobs, JOBS, ephemeral } from "./jobs.ts"
import { chatOn as discordOn } from "./chat/platform.ts"
import { installGlobal, onPath, startPid } from "./install.ts"
import { setPause } from "./pause.ts"
import { clip, readSecrets, secretsFile, setSecret } from "./notify.ts"
import { discordHint, machineId, readPrivate, repoMarkers } from "./setup-edge.ts"
import { claimKey } from "./lib.ts"
import { hostname } from "node:os"
import { repoRights, suggestedMethod, type RepoRow } from "./repo-rights.ts"
import { installPlan } from "./tools.ts"
import type { DB } from "./db.ts"

export { fillConfig, rankIssues } from "./setup-steps.ts"

type Opts = { yes?: boolean; projects?: string[]; noJobs?: boolean; root: string }
const cancelled = <T>(v: T | symbol): T => { if (p.isCancel(v)) { p.cancel("Setup stopped. Run dobby init again to pick up where it stopped."); process.exit(1) } return v as T }

/** Lists the background jobs and asks before installing them; --yes prints the list and says yes. */
/** github.owner is set and differs from the gh login, and there is a person to ask: --yes keeps the config as it is. */
export const askAdoptLogin = (have: { github?: { owner?: string } }, login: string, yes?: boolean) => !yes && !!login && !!have.github?.owner && have.github.owner !== login

/** The outro's "Next:" line. With no background jobs nothing builds until dobby start runs, so it comes first. */
export const nextLine = (jobsOk: boolean) => `Next: ${jobsOk ? "" : "dobby start (keep it open; it builds and reviews) · "}dobby status · dobby doctor · dobby uninstall`

export async function wantJobs(yes: boolean | undefined, confirm: (o: { message: string; initialValue: boolean }) => Promise<boolean | symbol>): Promise<boolean> {
  p.log.message(`Background jobs:\n${JOBS.map((j) => `  ${j.name.padEnd(10)} ${j.what}`).join("\n")}`)
  return yes ? true : cancelled<boolean>(await confirm({ message: "Install these background jobs?", initialValue: true }))
}

/** Asks for the Discord bot token in the terminal, hidden, and saves it in the secrets file (0600). Never printed or logged. Does nothing when a token is already there. */
export async function askDiscordToken(): Promise<void> {
  if (readSecrets().DISCORD_BOT_TOKEN) return
  const t = cancelled<string>(await p.password({ message: "Discord bot token (hidden; Enter to skip and add it later)" })).trim()
  if (t) setSecret("DISCORD_BOT_TOKEN", t)
}

/** Slack (beta): shows the app manifest to paste once, then asks for the bot (xoxb-) and app (xapp-) tokens, hidden, straight into the secrets file (0600). Never printed or logged. Returns true when both are saved. */
export async function askSlackTokens(): Promise<boolean> {
  const have = readSecrets()
  if (have.SLACK_BOT_TOKEN && have.SLACK_APP_TOKEN) return true
  const { manifest } = await import("./chat/slack.ts")
  p.note(`1. Open https://api.slack.com/apps, Create New App, From a manifest, pick your workspace\n2. Paste this manifest and create the app:\n\n${manifest()}\n3. Install to Workspace, then copy the Bot User OAuth Token (xoxb-) from OAuth & Permissions\n4. Basic Information, App-Level Tokens, Generate Token with the connections:write scope (xapp-)`, "Slack app manifest")
  const ask = async (name: string, prefix: string, what: string) => {
    if (readSecrets()[name]) return
    const t = cancelled<string>(await p.password({ message: `${what} (hidden; Enter to skip and add it later)`, validate: (v) => (!v || v.trim().startsWith(prefix) ? undefined : `It starts with ${prefix}`) })).trim()
    if (t) setSecret(name, t)
  }
  await ask("SLACK_BOT_TOKEN", "xoxb-", "Slack bot token (xoxb-)")
  await ask("SLACK_APP_TOKEN", "xapp-", "Slack app token (xapp-)")
  const now = readSecrets()
  return !!(now.SLACK_BOT_TOKEN && now.SLACK_APP_TOKEN)
}

/** Slack (beta): the owner's member ID, asked once and saved in kv (an id, not a secret). Nothing is guessed: whoever sends commands to Dobby must be named. Needs a terminal. */
export async function askSlackOwner(db: DB): Promise<void> {
  const { kv, setKv } = await import("./chat/common.ts"), { OWNER_ID } = await import("./chat/slack.ts")
  if (kv(db, "slack:owner")) return
  const legacy = readSecrets().SLACK_OWNER_ID
  if (legacy && OWNER_ID.test(legacy)) return void setKv(db, "slack:owner", legacy)
  if (!process.stdin.isTTY) return
  const id = cancelled<string>(await p.text({ message: "Your Slack member ID (Slack: your profile, the three dots, Copy member ID)", validate: (v) => (OWNER_ID.test((v ?? "").trim()) ? undefined : "It looks like U01ABC2DEF3") })).trim()
  setKv(db, "slack:owner", id)
}

/** Slack chosen: manifest, tokens, chat.platform = slack, then the channels. */
export async function setupSlack(db: DB, s: ReturnType<typeof p.spinner>) {
  if (!(await askSlackTokens())) return p.log.warn(`Add SLACK_BOT_TOKEN and SLACK_APP_TOKEN to ${tidy(secretsFile())}, then run: dobby add slack`)
  await askSlackOwner(db)
  configSetText({ key: "chat.platform", value: "slack" })
  setConfig()
  const d = await (await import("./chat/platform.ts")).platform()
  s.start("Setting up Slack channels")
  try { s.stop(`✓ Slack: channels ready in "${await d.setup(db)}". Run dobby slack test to see a message in each.`) } catch (e) { s.stop(`✗ Slack: ${(e as Error).message}`) }
}

export async function setup(db: DB, o: Opts): Promise<void> {
  if (!process.stdin.isTTY && !o.yes) { console.error("No terminal to ask in. Run: dobby init --yes (takes the defaults; add --projects <folder> to pick repos and --no-jobs to skip the jobs, or dobby init --ui to answer in a browser)"); process.exitCode = 1; return }
  if (!claimKey(db, "setup")) { console.error("Another dobby init is already running. Wait for it, or run this again when it ends."); process.exitCode = 1; return }
  try { await setupRun(db, o) } finally { db.prepare("DELETE FROM kv WHERE k='setup' AND v LIKE ?").run(`${process.pid}:%`) }
}

async function setupRun(db: DB, o: Opts): Promise<void> {
  // fresh: no config yet, only the stats answers so far, or a config copied from another machine with no tickets here (setup writes the timezone with the rest).
  // A config that does not parse is moved to config.json.bad and setup starts from nothing.
  const badFile = (bad: string) => p.log.warn(`${tidy(privatePath())} could not be read (comments or a trailing comma?). Moved to ${tidy(bad)}; setup starts from the defaults.`)
  const old = readPrivate(privatePath(), badFile)
  const fresh = !old.timezone || (!(db.prepare("SELECT 1 FROM tickets LIMIT 1").get()) && !db.prepare("SELECT 1 FROM kv WHERE k='setup:done'").get())
  p.intro("Dobby setup")
  holdEvents() // opt-in usage stats: the funnel waits in memory until the two questions are answered
  record(db, "setup_started")

  // 1. checks (and 2. sign-ins): nothing is asked unless something is missing
  const s = p.spinner()
  s.start("Checking this machine")
  let t = Date.now(), rows = await checkMachine()
  s.stop(`Checked this machine (${((Date.now() - t) / 1000).toFixed(1)}s)`)
  const gh = rows.find((r) => r.name === "GitHub sign-in")!
  if (!gh.ok && !gh.offline && rows.find((r) => r.name === "GitHub CLI")!.ok && !o.yes) {
    p.log.step("GitHub CLI is not signed in. A browser opens; the code is printed too, so it works over SSH.")
    spawnSync("gh", ["auth", "login", "--web", "--git-protocol", "https"], { stdio: "inherit" })
    rows = await checkMachine()
  }
  // 2b. no Claude plan sign-in: plan or API key (terminal only; the key goes to the secrets file and nowhere else)
  if (!rows.find((r) => r.name === "Claude sign-in")?.ok && rows.find((r) => r.name === "Claude sign-in") && rows.find((r) => r.name === "Claude Code")!.ok && !o.yes && (await askApiKey())) rows = await checkMachine({ apiKeyMode: true })
  p.log.message(rows.filter((r) => r.name !== "config").map((r) => `${r.ok ? "✓" : r.required ? "✗" : "·"} ${r.name}: ${r.detail}${!r.ok && r.fix ? `   (${r.fix})` : ""}`).join("\n"))
  const blocking = blockingChecks(rows)
  record(db, "setup_step", { step: "checks", ok: !blocking.length, ...(blocking.length ? { reason: REASON[blocking[0].name] ?? "other" } : {}) })
  if (blocking.length) {
    const row = blocking.find((r) => (CHECK_NAMES as readonly string[]).includes(r.name))
    if (row && !o.yes && helpAvailable(rows).ok && cancelled<boolean>(await p.confirm({ message: `${row.name} failed. ${HELP_LABEL}?`, initialValue: false }))) {
      let r = await askHelp(db, { kind: "check", name: row.name, detail: row.detail })
      if (r.ok && cancelled<boolean>(await p.confirm({ message: `${SONNET_LABEL}?`, initialValue: false }))) r = await askHelp(db, { kind: "check", name: row.name, detail: row.detail }, { model: "sonnet" })
      p.log.message(r.ok ? `${r.suggestion?.cause ? `Cause: ${r.suggestion.cause}\n` : ""}${r.suggestion?.fix ? `Fix: ${r.suggestion.fix}` : ""}`.trim() : NO_ANSWER)
    }
    p.outro(`Fix these, then run dobby init again:\n${blocking.map((r) => `  ${r.name}: ${r.fix}`).join("\n")}`)
    process.exitCode = 1
    return
  }
  await askStatsStep(db, !!o.yes) // after the blocking exit: nothing is asked of a machine that cannot finish yet
  const login = loginOf(rows)

  // 3. repos (question 1): detected, never asked; then each command is run once
  const roots = o.projects?.length ? o.projects : defaultRoots()
  const where = (roots.length ? roots : [config().paths.projects]).map((r) => tidy(expand(r))).join(", ")
  const { repos: found, skipped } = scanRepos(roots, undefined, { cwd: process.cwd() })
  for (const l of skippedLines(skipped)) p.log.info(l)
  if (!found.length) { record(db, "setup_step", { step: "repos", ok: false, reason: "no_repos" }); p.outro(`No git repos with a GitHub remote in ${where}. Run dobby init --projects <folder>.`); process.exitCode = 1; return }
  const name = repoName
  const line = (d: Detected) => `${d.pm} · test: ${d.test ?? "none found"} · base: ${d.base}`
  p.log.info(`Found ${found.length} repo${found.length > 1 ? "s" : ""} in ${where} with a GitHub remote`)
  const picked: Detected[] = o.yes ? found.filter((d) => d.test) : cancelled<Detected[]>(await p.multiselect({
    message: "Which should Dobby work on?", required: true,
    options: found.map((d) => ({ value: d, label: name(d), hint: line(d) })), initialValues: found.filter((d) => d.test),
  }))
  // 3b. can Dobby's PRs be pushed and merged here? A repo this account cannot push to is left out; the rest are warnings
  const method = config().github.mergeMethod
  let suggest: string | undefined
  const granted: Detected[] = []
  for (const d of picked) {
    const rr = await repoRights(d.remote!, { base: d.base, method })
    p.log.message(rr.map(showRight).join("\n"))
    suggest ??= suggestedMethod(rr)
    if (rr.some((r) => r.required && !r.ok)) p.log.warn(`${name(d)} is left out until this account can push to ${d.remote}. Run dobby init again after.`)
    else {
      const parent = o.yes ? null : forkParent(d.remote!) // --yes keeps the fork; the question is asked once, here
      if (parent) { const q = forkAsk(name(d), d.remote!, parent); if (cancelled<string>(await p.select({ message: q.question, options: q.options })) === "upstream") d.upstream = parent }
      granted.push(d)
    }
  }
  const ready: Detected[] = [], testsOff = new Set<string>()
  const help = helpAvailable(rows)
  for (const d0 of granted) {
    let d = d0
    for (const w of repoWarnings(d)) p.log.warn(`${name(d)}: ${w}`)
    // a repo with no test command: Claude can be asked to find one (only when the person says yes)
    if (!d.test && !o.yes && help.ok && cancelled<boolean>(await p.confirm({ message: `${name(d)}: no test command found. ${HELP_LABEL}?`, initialValue: false }))) d = (await askAbout(db, { kind: "no-commands", name: name(d), repoDir: d.dir }, d)) ?? d
    for (;;) {
      const t0 = Date.now(), msg = (what: string) => `${name(d)}: ${what} (a fresh checkout; can take a few minutes)`
      let what = d.install
      s.start(msg(what))
      const tick = setInterval(() => s.message(`${msg(what)} ${Math.round((Date.now() - t0) / 1000)}s`), 5000)
      const v = await verifyRepoAsync(d, { onStep: (_, cmd) => { what = cmd } }).finally(() => clearInterval(tick))
      const bad = v.checks.find((c) => !c.ok)
      s.stop(bad ? `✗ ${name(d)}: ${bad.step} failed (${bad.secs}s)` : `✓ ${name(d)}: ${v.checks.map((c) => `${c.step} ${c.secs}s`).join(", ") || "nothing to run"}${v.checks.at(-1)?.last ? ` · ${v.checks.at(-1)!.last}` : ""}`)
      if (!bad) { ready.push(d); break }
      p.log.warn(`${bad.tail ?? bad.last}${bad.log ? `\nFull output: ${bad.log}` : ""}`)
      const left = () => p.log.warn(`${name(d)} is left out until \`${bad.step === "install" ? d.install : d.test}\` passes on ${d.base} (checked in a clean copy; your folder is untouched). Run dobby init again after.`)
      if (o.yes) { left(); break }
      const pick = cancelled<string>(await p.select({ message: `${name(d)} did not pass. What now?`, options: [
        { value: "anyway", label: "Add anyway (tests off until fixed)", hint: "the project file gets verify: true" },
        { value: "set", label: "Set the test command", hint: "type it, then it is checked again" },
        ...(help.ok ? [{ value: "ask", label: HELP_LABEL }] : []),
        { value: "skip", label: "Skip" },
      ] }))
      if (pick === "skip") { left(); break }
      if (pick === "anyway") { testsOff.add(d.dir); ready.push(d); p.log.info(`${name(d)} is added with tests off. Set verify: in its project file when the tests can run.`); break }
      if (pick === "set") d = { ...d, test: await askCommand("Test command", d.test ?? "", d.dir) }
      else d = (await askAbout(db, { kind: "verify-failed", name: name(d), repoDir: d.dir, command: bad.step === "install" ? d.install : d.test ?? "", output: bad.tail ?? bad.last }, d)) ?? d
    }
  }
  record(db, "setup_step", { step: "repos", ok: ready.length > 0, ...(ready.length ? {} : { reason: "tests_failed" }) })
  if (!ready.length) {
    p.outro(`No project is ready, so setup stops here.\n${o.yes ? "dobby init --yes never adds a repo that fails. Run dobby init without --yes to add one anyway or set its test command, or fix the failing command and run it again." : "Fix the failing command in the repo, or run dobby init again and choose Add anyway or Set the test command."}`)
    process.exitCode = 1
    return
  }
  saveRepos(ready, o.root, (d) => testsOff.has(d.dir))

  // one marker per repo says which machine works it: a second machine gets a warning, not a fight over the same PRs
  const me = machineId()
  for (const w of repoMarkers(ready.map((d) => d.remote!), me, (args) => { const r = spawnSync("gh", args, { encoding: "utf8" }); return { ok: r.status === 0, out: r.stdout ?? "" } }, hostname())) p.log.warn(w)

  // 4. chat (question 2)
  const chat = o.yes ? "terminal" : cancelled<string>(await p.select({
    message: "Where should Dobby ask you things?",
    options: [{ value: "terminal", label: "Terminal only", hint: "what needs you prints where dobby runs; dobby add discord later" }, { value: "discord", label: "Discord", hint: "buttons for approve and decline" }, { value: "slack", label: "Slack (beta)", hint: "same buttons, Socket Mode, no public URL" }],
  }))
  if (chat === "discord") {
    // the token is asked only here, hidden, and goes straight to the secrets file (0600); the browser setup page never takes it
    if (!o.yes) await askDiscordToken()
    if (!chatStatus().discordToken) p.note(`1. Create a bot at discord.com/developers and copy its token\n2. Add DISCORD_BOT_TOKEN=<token> to ${tidy(configDir())}/secrets.env\n3. Run: dobby discord invite, then dobby add discord`, "Discord: three steps")
    else {
      const d = await (await import("./chat/platform.ts")).platform()
      s.start("Setting up Discord channels")
      try {
        s.stop(`✓ Discord: channels ready in "${await d.setup(db)}". Run dobby discord test to see a message in each.`)
        const hint = await d.intentHint().catch(() => null)
        if (hint) p.log.warn(hint)
      } catch (e) { s.stop(`✗ Discord: ${discordHint((e as Error).message)}`) }
    }
  }

  if (chat === "slack") await setupSlack(db, s)

  record(db, "setup_step", { step: "chat", ok: true })

  // 4b. free tools (graphify, rtk): the exact install commands are shown; they run only on a yes (never with --yes)
  const missing = toolsMissing()
  let installedTools = false
  const textOn = toolRows().filter((t) => (t.name === "caveman" || t.name === "ponytail") && t.on).map((t) => t.name)
  if (textOn.length) p.log.message(`${textOn.join(", ")}: on (text rules, nothing to install). Turn one off: dobby tools off <name>`)
  if (missing.length) {
    const plans = missing.map((t) => installPlan(t)), cmds = plans.flatMap((x) => x.cmds)
    p.log.message(`Recommended free tools, not installed (${missing.join(", ")}):\n${[...cmds.map((c) => `  ${c}`), ...plans.flatMap((x) => x.note ?? [])].join("\n")}`)
    if (cmds.length && !o.yes && cancelled<boolean>(await p.confirm({ message: "Install recommended free tools (graphify, rtk)?", initialValue: true }))) {
      installedTools = true
      for (const t of missing) for (const r of installTool(t, (cmd) => ({ ok: spawnSync(cmd, { shell: true, stdio: "inherit" }).status === 0, out: "" })).results) p.log.message(r.ok ? `✓ ${r.cmd}` : `✗ ${r.cmd} failed; run it yourself`)
    }
  }

  record(db, "setup_step", { step: "tools", ok: !missing.length || installedTools })

  // 5. settings (question 3)
  const have0 = readPrivate(privatePath()), answered = !!(have0.safety?.preset && have0.safety?.deploy && have0.review?.auto)
  if (answered && !o.yes) p.log.info("Safety and review settings are already set and kept. Change one with: dobby config set <key> <value>")
  const mode = o.yes || answered ? "recommended" : cancelled<string>(await p.select({
    message: "Settings",
    options: [
      { value: "recommended", label: "Recommended", hint: "asks before data migrations, client sites and releases; strict review for login, payments and secrets; deploys wait for your tap" },
      { value: "customize", label: "Customize", hint: "safety and reviews" },
    ],
  }))
  let preset = "balanced", auto = "off", deploy = "ask"
  if (mode === "customize") {
    preset = cancelled<string>(await p.select({ message: "Safety", initialValue: "balanced", options: [
      { value: "strict", label: "Strict", hint: "every merge waits for you" }, { value: "balanced", label: "Balanced", hint: "data migrations, client sites and releases wait for you; login, payments and secrets get the strict review" }, { value: "autonomous", label: "Autonomous", hint: "never waits for you; risky changes get the strict review" },
    ] }))
    auto = cancelled<string>(await p.select({ message: "Automatic reviews of your own PRs", initialValue: "off", options: [
      { value: "off", label: "Off", hint: "only when you comment @dobby review" }, { value: "drafts", label: "Drafts too" }, { value: "on", label: "Every PR" },
    ] }))
    deploy = cancelled<string>(await p.select({ message: "After a merge", initialValue: "ask", options: [
      { value: "ask", label: "Ask", hint: "a Deploy tap; nothing goes live until you tap it" }, { value: "auto", label: "Deploy at once" },
    ] }))
  }
  const owners = [...new Set([login, ...ready.map((d) => d.remote!.split("/")[0])].filter(Boolean))]
  const have = readPrivate(privatePath())
  // a config from someone else's dotfiles or another account: the signed-in login wins when the owner says yes; --yes never overwrites what is set (#375)
  if (askAdoptLogin(have, login, o.yes) && (cancelled<boolean>(await p.confirm({ message: `config.json says github.owner is ${have.github.owner}, but gh is signed in as ${login}. Use ${login}?`, initialValue: true })))) { have.github = { ...have.github, owner: login, accounts: owners }; p.log.info(`github.owner is now ${login}`) }
  const weekCap = have.pacing?.weekCap !== undefined || o.yes ? 95 : Number(cancelled<string>(await p.text({
    message: "How much of your weekly plan may Dobby use? (percent; the rest is always yours)", initialValue: "95",
    validate: (v) => (/^\d+$/.test(v ?? "") && Number(v) >= 10 && Number(v) <= 100 ? undefined : "A whole number from 10 to 100"),
  })))
  const saved = saveSettings({ preset: preset as never, auto: auto as never, deploy: deploy as never, weekCap }, { login, remotes: ready.map((d) => d.remote!), projects: o.projects, mergeMethod: suggest && !method ? suggest : undefined, have })
  p.log.success(`Settings saved in ${tidy(privatePath())}${saved.kept ? " (your existing values kept)" : ""}`)

  record(db, "setup_step", { step: "settings", ok: true })
  let later = false
  // 6. background jobs: a row ticks only once launchd or systemd reports the job loaded
  if (fresh) setPause(db, { kind: "merges" }, true, "setup") // the first merge always waits for the owner: dobby resume merges
  if (!o.noJobs && (process.platform === "darwin" || process.platform === "linux")) {
    if (await wantJobs(o.yes, p.confirm)) {
      const home = await jobsHome(db, o, s)
      if (!home.bin) { later = true; p.log.warn(home.why) } else {
        s.start("Starting Dobby")
        const r = installJobs({ discord: !!discordOn(), bin: home.bin, home: homedir(), uid: process.getuid?.() ?? 0, log: (m) => p.log.warn(m) })
        s.stop(r.every((x) => x.ok) ? "Dobby is running" : "Some jobs did not start")
        p.log.message(r.map((x) => `${x.ok ? "✓" : "✗"} ${x.name.padEnd(10)} ${x.detail}`).join("\n"))
      }
    } else later = true
  } else if (!o.noJobs) p.log.warn(`Background jobs are not available on ${process.platform}: run \`dobby start\` in a terminal`)

  const jobsOk = !later && !o.noJobs && (process.platform === "darwin" || process.platform === "linux")
  record(db, "setup_step", { step: "jobs", ok: jobsOk, ...(jobsOk ? {} : { reason: "skipped" }) })

  // 7. first ticket: only offered, never built without a yes
  const queued = !o.yes && ready.length ? await offerFirst(db, ready) : false
  record(db, "setup_step", { step: "first_ticket", ok: queued, ...(queued ? {} : { reason: "skipped" }) })
  db.prepare("INSERT OR REPLACE INTO kv VALUES ('setup:done', ?)").run(new Date().toISOString())
  record(db, "setup_done")
  p.outro(`Files: ${tidy(configDir())} · ${tidy(process.env.DOBBY_DIR ?? expand(config().paths.data))}\n${nextLine(jobsOk)}\nHelp with a setup problem in your own Claude Code: dobby add skill${later ? "\nStart later with: dobby jobs install (or dobby start in a terminal)" : ""}${fresh ? "\nMerges are paused until you run: dobby resume merges" : ""}${noDobby(o.root)}`)
}

/** The bin/dobby the jobs run: this install, or (when this one is a temporary npx or bunx copy) a global one, installed first. No bin = no jobs, with the reason. */
async function jobsHome(db: DB, o: Opts, s: ReturnType<typeof p.spinner>): Promise<{ bin?: string; why: string }> {
  const pid = startPid(db)
  if (pid) return { why: `dobby start is running (pid ${pid}): stop it with Ctrl-C, then run dobby jobs install. Jobs and dobby start together would build every ticket twice.` }
  if (!ephemeral(o.root)) return { bin: `${o.root}bin/dobby`, why: "" }
  const version = (JSON.parse(readFileSync(`${o.root}package.json`, "utf8")) as { version: string }).version
  p.log.message("This copy of Dobby is a temporary npx download. Jobs need a copy that stays, so Dobby installs itself with: npm i -g dobby-ai")
  if (o.yes || !cancelled<boolean>(await p.confirm({ message: "Run npm i -g dobby-ai now?", initialValue: true }))) return { why: "Jobs not installed. Run npm i -g dobby-ai, then dobby jobs install (or dobby start in a terminal)." }
  s.start("Installing dobby-ai globally")
  const g = installGlobal(version, (c, a) => { const r = spawnSync(c, a, { encoding: "utf8" }); return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` } })
  s.stop(g.ok ? "✓ npm i -g dobby-ai" : `✗ npm i -g dobby-ai: ${g.why}`)
  return g.ok ? { bin: `${g.root}bin/dobby`, why: "" } : { why: `Jobs not installed (${g.why}). Fix npm's global folder permissions or run dobby start in a terminal.` }
}
const noDobby = (root: string) => (onPath() || !ephemeral(root) ? "" : "\nThe dobby command is not on your PATH yet: run npm i -g dobby-ai, and make sure npm's global bin folder (npm prefix -g)/bin is on PATH.")

const showRight = (r: RepoRow) => `${r.ok ? "✓" : r.required ? "✗" : "·"} ${r.name}: ${r.detail}${!r.ok && r.fix ? `   (${r.fix})` : ""}`

/** No plan sign-in: ask plan or API key. A key is typed at a hidden prompt, written to the secrets file (0600) and never shown. true = API-key mode is now set. */
async function askApiKey(): Promise<boolean> {
  p.log.info("Dobby runs Claude Code on a Pro or Max plan sign-in, or on an Anthropic API key (paid by the token). Amazon Bedrock and Google Vertex AI are not supported.")
  const how = cancelled<string>(await p.select({ message: "Plan or API key?", options: [{ value: "plan", label: "Plan", hint: "sign in with claude, then /login" }, { value: "apiKey", label: "API key", hint: "from console.anthropic.com; capped at $20 a day unless you change billing.dailyUsd" }] }))
  if (how === "plan") { p.log.info("Run claude, then /login, then dobby init again."); return false }
  const key = cancelled<string>(await p.password({ message: "Anthropic API key (hidden; saved only in Dobby's secrets file)", validate: (v) => (v && /^\S{8,}$/.test(v) && !v.includes('"') ? undefined : "Paste the key with no spaces") }))
  setSecret("DOBBY_API_KEY", key.trim())
  configSetText({ key: "billing.mode", value: "apiKey" })
  setConfig()
  p.log.success(`Key saved in ${tidy(secretsFile())} and billing set to apiKey.`)
  return true
}

const REASON: Record<string, (typeof import("./stats-schema.ts").REASONS)[number]> = { "GitHub CLI": "gh_missing", "GitHub sign-in": "gh_signed_out", "Claude Code": "claude_missing", "Claude sign-in": "claude_signed_out", git: "git_missing", Node: "node_old" }

/** The two stats questions, asked right after the checks. Enter = no. Nothing is asked with --yes, when already answered, or when DO_NOT_TRACK, DOBBY_STATS=off or CI forces it off. */
async function askStatsStep(db: DB, yes: boolean) {
  const have = config().stats, why = forcedOff()
  if (why) p.log.info(`${why}: crash reports and usage stats stay off.`)
  if (yes || why || (have?.crashes !== undefined && have?.usage !== undefined)) return releaseHeld(db)
  p.log.message("Two optional questions. Both are off unless you say yes. What is sent: dobby docs stats")
  await askStats(db, async (message) => cancelled<boolean>(await p.confirm({ message, initialValue: false })), (key, value) => void configSetText({ key, value }))
  setConfig() // the answers are in the file now: the rest of this run reads them
}

async function offerFirst(db: DB, repos: Detected[]): Promise<boolean> {
  const pool: Candidate[] = firstTicketCandidates(repos)
  for (const c of pool) {
    const pick = cancelled<string>(await p.select({
      message: `First ticket? The smallest open issue you wrote with a clear done rule:\n  ${c.remote} #${c.number}  "${c.title}"\n  The builder gets this text:\n  ${clip(c.body, 400).replaceAll("\n", "\n  ")}`,
      options: [{ value: "queue", label: "Build it now", hint: "Dobby opens a PR; it merges only when you say so" }, { value: "next", label: "Pick another" }, { value: "skip", label: "Skip" }],
    }))
    if (pick === "skip") return false
    if (pick === "next") continue
    p.log.success(await queueCandidate(db, c))
    return true
  }
  p.log.info("No open issue is small and clear enough for a first ticket. Add one with: dobby add <project> \"<title>\"")
  return false
}

/** A command typed in the terminal passes the same safety check as one from the browser or from Claude. */
async function askCommand(message: string, initialValue: string, repoDir: string): Promise<string> {
  return cancelled<string>(await p.text({ message, initialValue, validate: (v) => (v?.trim() ? unsafeReason(v, repoDir) ?? undefined : "Type a command") })).trim()
}

/** Ask Claude about a repo: Haiku, then a stronger model (Sonnet) if the person says so. Suggested commands are editable and used only after a yes; returns the repo with them, or null. */
async function askAbout(db: DB, input: Extract<HelpInput, { repoDir: string }>, d: Detected): Promise<Detected | null> {
  const s = p.spinner()
  s.start("Asking Claude")
  let r = await askHelp(db, input)
  s.stop(r.ok ? "Claude answered" : NO_ANSWER)
  if (r.ok && cancelled<boolean>(await p.confirm({ message: `${SONNET_LABEL}?`, initialValue: false }))) { s.start("Asking Claude again"); r = await askHelp(db, input, { model: "sonnet" }); s.stop(r.ok ? "Claude answered" : NO_ANSWER) }
  for (const x of r.refused) p.log.warn(`Not used: the ${x.field} command. ${x.reason}`)
  if (!r.ok || !r.suggestion) return null
  const { cause, fix, install, test } = r.suggestion
  if (cause || fix) p.log.message(`${cause ? `Cause: ${cause}\n` : ""}${fix ? `Fix: ${fix}` : ""}`.trim())
  if (!install && !test) return null
  const next = { ...d, ...(install ? { install: await askCommand("Install command", install, d.dir) } : {}), ...(test ? { test: await askCommand("Test command", test, d.dir) } : {}) }
  return cancelled<boolean>(await p.confirm({ message: "Use these commands? They run in the repo's folder and are saved to its project file.", initialValue: false })) ? next : null
}

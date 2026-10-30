// dobby <command>
//
// Getting started
//   init [--ui] [--projects a,b] [--no-jobs] [--yes]   set up Dobby on this machine, with no name: checks, sign-ins, your repos, settings, background jobs (asks first); --ui does it in your browser; --no-jobs skips the jobs (keep `dobby start` open instead); --yes takes every recommended answer
//   add <project> "<title>" ["<done when>"] [S|M|L] [priority]   write a ticket
//   status                    the plan limits line, then what is building, shipped today and stuck
//   limits                    how much of the 5-hour and weekly plan is used, and when paused work resumes
//   list [--all]              open tickets by stage (Building, Ready, Waiting, Failed), 10 per stage; --all = every open ticket (adds backlog), old format; shipped and declined are left out
//   docs [topic]              the manual: list the pages, or print one (works offline)
//   --version                 print the version (the jobs run it once at install to prove node and the path work)
//   doctor [--json]           checks tools, sign-ins, background jobs and the pipeline (exit 1 on any failure)
//   uninstall [--dry]         stop and remove the background jobs; your data, config and secrets stay
//
// Everyday
//   cancel <id>               stop the ticket: kill its build, remove its worktree, close its own PR and branch, mark it declined
//   pause | resume            stop / allow builders claiming new tickets (running ones finish their step, nothing is killed)
//   queue <id>                move a backlog ticket to ready
//   run <id>                  build this ticket now, in this process (no worker cap, budget gate or tick lock; a new project is onboarded first; exit 1 if nothing was built)
//   show <id>                 every step the ticket's graph took, with tokens and cost
//   cost <id>                 what the ticket's PR cost, by stage (the same table Dobby posts on the PR)
//   receipt [days]            "Shipped N PRs on your plan, $0 extra" for the last 7 days, and the card at <data>/receipt.svg
//   approve <id> | decline <id>   answer a ticket waiting for you (decline on any other ticket = cancel)
//   merge <id>                merge a waiting ticket's PR now (a ticket at its gate is approved)
//   deploy <project>          the Deploy tap from the terminal (a migration that changes data still waits for its own tap)
//   answer <id> <words>       answer a ticket's question: your words join its done rule and it is queued again
//   hint <id> <words>         add a hint for the ticket's next build
//   retry <id>                a ticket stuck in fixing starts over (its PR is closed); a failed one is queued again
//   done <id> [--pr N]        work finished outside Dobby: mark the ticket shipped (and note its PR); nothing is closed, merged or posted
//   takeover <id>             pause one ticket and leave its branch to you
//   allowround <id>           one more automatic fix round on the ticket's PR
//   unqueue <id>              a queued ticket goes back to the backlog
//   reorder <id> [before]     move a queued ticket above another (or last)
//   applyfinding <id>         a fix ticket on the PR's branch for one review finding
//   dismissfinding <id>       a review finding is intentional (later reviews leave it out)
//   findingrule <id> [words]  a review finding becomes a rule for the repo
//   ideaticket <id>           an idea becomes a ticket and is queued
//   ideadrop <id>             drop an idea
//   dashboard [--port 4710] [--host 127.0.0.1]   local web dashboard (auto-refresh); makes DASHBOARD_TOKEN in secrets.env on first start
//   add discord|slack|dashboard|jobs   switch on an add-on: Discord or Slack (beta) buttons, the local dashboard job, or all six background jobs
//   add skill [--yes]         copy the dobby-setup skill into ~/.claude/skills (asks first), for fixing a setup problem in your own Claude Code
//   mcp                       the MCP server on stdio, so Claude can read status and file tickets; asks you before it merges, deploys or cancels. dobby add mcp [--yes] connects it to Claude Code; --http prints the command for the dashboard's /mcp instead
//   jobs install|uninstall|status [--dry]   the six background jobs (launchd on macOS, systemd --user on Linux)
//   config [show|path]        the merged config (secrets redacted) / where the private config file lives
//   timelapse [day] [--yes]   a private 15-second clip of a day of agents, from the event log (preview first, nothing uploaded); timelapse verify <clip> <manifest> checks one
//   stats [on|off [crashes|usage]]   opt-in crash reports and usage stats: status, or turn them on or off (both are off until you say yes)
//   config set <key> <value>  change one setting in your private config, checked against the schema (config unset <key> puts it back to the default)
//   start                     run Dobby in this terminal: the Discord listener and the queue loop (Ctrl-C stops it)
//
// More: dobby help --all
// ---
// Advanced
//   goals [app] | goals import <app>   the goals in rank order; import turns the project file's goals into GitHub milestones
//   stats show|log|reset-id|report [--days 30]   usage stats: the next payload exactly as it would be sent / every payload sent so far / a new random install id / the report from your own Worker (needs DOBBY_STATS_REPORT_TOKEN)
//   tick                      one scheduler step: run the top ticket if the budget allows (the background job calls this)
//   pause [all|builders|reviews|merges|deploys|planning|scout|notify|project <name>|ticket <id>] [for 30m|2h|1d]   one pause system with levels; resume takes the same target; all also kills the running builds; "for" auto-resumes
//   pause status              what is paused, since when, until when
//   graph                     the ticket graph as a Mermaid diagram
//   idea <project> "<idea>"   drop a seed idea for the Product Manager
//   ideas [project]           idea cards, best first
//   pm <project> [--area]     Product Manager now: ranked problems by goal, PRDs for L, idea cards (--area: today's Area PM)
//   dedupe <project>          merge tickets and ideas that are the same work (Haiku); run after onboard
//   tools [on|off <name>]     agent tools (graphify, rtk, caveman, ponytail, jev): on/off, found or not, install command; on/off edits your config
//   company                   distil your global Claude memory into company.md (work rules only)
//   init <project>            add one repo by name or path, without the machine setup: draft its dobby.md, then onboard it and ask which of the first backlog tickets to queue (also runs by itself before a project's first ticket; with --yes or no terminal nothing is queued)
//   onboard <project>         read all the project's docs and skills into Dobby (rules draft, backlog tickets, ideas, knowledge map)
//   lead [project] [--dry]    the Lead plans: promotes up to 3 backlog tickets, writes up to 3 new ones (all active projects if none given)
//   cos [--dry]               the Chief of Staff's morning summary (Discord #daily-update), plus Approve/Decline for waiting tickets
//   brief [YYYY-MM-DD] [--dry]   print a day's sent summary (<data>/briefs/<day>.md); --dry builds today's from live facts, sends nothing
//   ask <message>             talk to the front desk from the terminal ("status" answers at once, no AI)
//   listen                    always-on Discord listener (the listener background job); also runs the telemetry receiver
//   telemetry-serve [port]    only the Claude Code telemetry receiver (127.0.0.1, default 4711 or DOBBY_OTEL_PORT), for testing
//   service install|uninstall [--dry]   run `start` as a background service (launchd on macOS, systemd --user on Linux); refuses while the tick/listener background jobs exist
//   discord invite|setup|test  the bot invite link; create channels + webhooks (idempotent); one hello per channel
//   review <owner/repo> <pr> [--full]  the Reviewer on one PR by hand (a draft too): PR comment + "Claude Review" status; --full = the whole PR
//   review-scan [--dry]       review new heads of open PRs on the repos that matter (the listener runs this every 15 min; the tick job does when Discord is off)
//   usage [days]              Claude usage report: API-$ by model, cache hit, $ per 1% of each limit (reads this computer's ~/.claude logs, whatever DOBBY_DIR is)
//   scoreboard [days]         PRs opened, needed changes, merged (default 7 days)
//   usage-log                 usage reading stored every 10 min by the listener: 5h %, weekly %, API-$ by model and token kind
//   capacity                  how full the 5-hour windows got this week, and what to change
//   touch <ticket|-> <decision|broke|unclear|permission> [note]   log a fix you made by hand (counted in the autonomy line)
//   api [on|off|status]       Max plan API credits for text-only jobs
//   health                    the hourly self-check
//   graphify                  refresh every project's code graph (daily 05:30)
//   scout                     Talent Scout now (normally once a night)
//   safety explain "<ticket text>"|<pr>  categories, rule, action and why from the safety config
//   policy explain "<text or path>"   which of your rules match, per kind, and which one wins
//   migrate [--dry-run]       move an older setup into the new config (never overwrites)
//   providers [detect|models|explain]   read-only: agent CLIs, API key env var NAMES and local servers found; live model lists; planned routing per role
//   role show|save|reset <name> [text]   read a role (your edit, else the built-in), save your edit into the config folder (text as an argument, or on stdin; without a --- block at the top it keeps the role's model line), or reset puts the built-in back
//   dashboard link [--host <name>] [--port 4710]   print the sign-in link for another device (a tunnel or Tailscale name with --host); no QR code
//   dashboard --tunnel [--port 4710]   for a phone behind an HTTPS tunnel: every request needs the token. Port 4710 is the job's, so use --port 4711 beside it
//   dashboard open [--port 4710]   open the running dashboard in your browser, signed in (the token goes in an HttpOnly cookie; this command does not print it)
import { docsCommand } from "./docs.ts"
import { capacityFromDb, DATA, noteWindow, open } from "./db.ts"
import { syncBoard } from "./board.ts"
import { runEndText, installCmd, companyPath, doctor, plainReason, fixed, prDone, addTicket, dropIdea, undoIdea, syncGoals, milestonesOf, apiKeyMode, keepGoingCaps, spendAllows, budgetAllows, reviewBudget, claude, company, getTicket, setTicket, home, ideaToTicket, isDuplicate, loadProjects, loadRole, memoryDir, nextTicket, orphanedParents, parseGroups, queueTicket, readUsage, fallbackAllows, fallbackStarted, capOverride, ROOT, runAsync, semaphore, stampLogs, sweepOrphanProcesses, sweepRebaseWorktrees, timeoutMs, doTimeoutMs, windowIdle, setBuildClaim, clearBuildClaim, reserveBuild, resetOrphans, ticketScope, lockHeld, lockValue, reapDead, LOCK_MS } from "./lib.ts"
import { actionArgs, discardProposal, FRONT_DESK_ARGS, parseProposal, preview, runForeman, sendProposal, storeProposal, typedNeedsTap, type Proposal } from "./frontdesk.ts"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { plan as servicePlan, requireConfig, service, servicePath, startConflicts } from "./service.ts"
import { explain as explainPolicy } from "./policy.ts"
import { paused, pauseList, parsePause } from "./pause.ts"
import { compileTicketGraph, resumeInput, thread } from "./graphs/ticket.ts"
import { runLead, runLeads } from "./graphs/lead.ts"
import { areaDue, pmDue, runProduct } from "./graphs/product.ts"
import { runPrograms } from "./graphs/program.ts"
import { autonomyLine, processAllowed, tagFor, TAGS, touch, weekPerFive } from "./usage.ts"
import { runCos } from "./graphs/cos.ts"
import { cancelTicket, stuckScan, stuckTap } from "./stuck.ts"
import { acceptReview, automergeStrict, fixReview, manualReview, reviewOnce, scan } from "./graphs/review.ts"
import type { DB } from "./db.ts"
import { chatOn as discordOn } from "./chat/platform.ts"
import type { Event } from "./chat/common.ts"
import { scanIfDue } from "./scan-due.ts"
import { asIs, clip, digest, notify, parseReply } from "./notify.ts"
import { installSkill, mergeScout, rejectScout, scout, scoutCard, scoutDue, scoutSays, undoScout } from "./scout.ts"
import { startTelemetry } from "./telemetry.ts"
import { config, configDir, privatePath, projectsDir, strayDrafts, zoned } from "./config.ts"
import { age, commandHelp, helpText, isStatusAsk, liftHint, limitsNow, statusText, tickRuns, updateBoard } from "./view.ts"
import { configSetText } from "./config-edit.ts"
import { flushUsage, noteUse, reportCrash } from "./stats.ts"
import { UserError, applyAgentWords, refuse, addTicketText, answerTicket, doneText, listText, pauseAct, queueText, receiptText, runAction, showText } from "./actions.ts"

// the dashboard opens its own read-only handle; every other command gets the read-write one
const [cmd, ...a] = process.argv.slice(2)
// help and unknown commands never open the database (a first look must not create the data dir)
const KNOWN = new Set([...readFileSync(new URL(import.meta.url), "utf8").matchAll(/^\s+((?:case "[\w-]+":\s*)+)/gm)].flatMap((m) => [...m[1].matchAll(/"([\w-]+)"/g)].map((x) => x[1]))) // every `case "a": case "b":` on a line counts (src/cli.ts run directly used to miss resume and hint)
if (!cmd || ["help", "--help", "-h"].includes(cmd)) { console.log(helpText(readFileSync(new URL(import.meta.url), "utf8"), a.includes("--all"))); process.exit(0) }
if (["--version", "-v", "version"].includes(cmd)) { console.log((JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version); process.exit(0) } // jobs run this once at install to prove node and the path work
if (a.some((x) => x === "--help" || x === "-h") && (KNOWN.has(cmd) || cmd === "docs" || cmd === "mcp")) { console.log(commandHelp(readFileSync(new URL(import.meta.url), "utf8"), cmd)); process.exit(0) } // never runs the command: `dashboard --help` must not start a server
if (cmd === "docs") { const r = docsCommand(a[0]); if (r.err) console.error(r.err); console.log(r.out); process.exit(r.code) }
if (cmd === "mcp") { await (await import("./mcp.ts")).serve(); process.exit(0) } // stdout is the protocol: before open(), whose sweep prints
if (!KNOWN.has(cmd)) { console.error(`Unknown command: ${cmd}. Run dobby help.`); process.exit(1) }
const db = cmd === "dashboard" ? (undefined as unknown as DB) : open()
// A process killed mid-rebase (timeout, restart) leaves ${DATA}/wt/*-rebase behind: every Dobby process clears the stale ones first.
if (cmd !== "dashboard") for (const n of sweepRebaseWorktrees(`${DATA}/wt`)) console.log(`removed a stale rebase worktree: ${n}`)
// Dev servers a builder started outlive its deleted worktree (wrangler's workerd): stop them.
if (cmd === "tick") { const p = sweepOrphanProcesses(`${DATA}/wt`); if (p.length) console.log(`stopped ${p.length} process(es) left from deleted worktrees`) }

async function eveningDigest() {
  const day = new Date().toLocaleDateString("sv")
  if (zoned().getUTCHours() < 19 || db.prepare("SELECT 1 FROM kv WHERE k=?").get(`digest:${day}`)) return
  // fix pushes onto open PRs (onto set) are rework: counted apart, not shipped tickets (audit #12)
  const rows = db.prepare("SELECT id, project, title, note FROM tickets WHERE status='shipped' AND onto IS NULL AND date(updated_at, 'localtime') = ? ORDER BY updated_at").all(day) as { id: number; project: string; title: string; note: string | null }[]
  const fixes = (db.prepare("SELECT COUNT(*) n FROM tickets WHERE status='shipped' AND onto IS NOT NULL AND date(updated_at, 'localtime') = ?").get(day) as { n: number }).n
  const kvGet = (k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
  await notify(digest(rows, (id) => kvGet(`plain:${id}`), fixes), fetch, undefined, { kind: "brief" })
  db.prepare("INSERT OR REPLACE INTO kv VALUES (?, '1')").run(`digest:${day}`)
}

// "Keep building" (button on the pause ping): the daytime 5-hour cap rises to the night cap until that window resets.
const allowed = (u: ReturnType<typeof readUsage>) => (apiKeyMode() ? spendAllows(db) : u ? budgetAllows(u, zoned().getUTCHours(), capOverride(db), weekPerFive(db)) : fallbackAllows(db))

/** Once per 5-hour window: tell the owner the builders paused for budget, with a button to keep going. */
async function pausePing(u: ReturnType<typeof readUsage>, why: string) {
  const resetAt = u?.fiveMsToReset ? Date.now() + u.fiveMsToReset : 0
  const key = `budget:paused:${apiKeyMode() ? `key:${Math.floor(Date.now() / 86_400_000)}` : Math.round(resetAt / 600_000)}` // one ping per window (per day on a key)
  if (u) noteWindow(db, u.fiveUsed, u.fiveMsToReset, { paused: true })
  if (db.prepare("SELECT 1 FROM kv WHERE k=?").get(key)) return
  db.prepare("INSERT OR REPLACE INTO kv VALUES (?, '1')").run(key)
  const ready = (db.prepare("SELECT count(*) n FROM tickets WHERE status='ready' AND dup_of IS NULL").get() as { n: number }).n
  const weekly = /weekly/.test(why)
  const caps = keepGoingCaps(u?.fiveUsed)
  const lim = u || apiKeyMode() ? limitsNow(db, u) : null, head = `⏸ Builders paused · ${why}\n${ready} ticket(s) waiting. ${lim ? lim.line : "They restart on their own."}`
  // terminal only: no buttons to tap, so the command that lifts the hold is printed instead (the tick of dobby start shares this terminal)
  if (!discordOn()) { const lift = lim ? liftHint(lim) : "", text = `${head}${lift ? `\n${lift}` : ""}`; console.log(text); await notify(text, fetch, undefined, { kind: "health" }); return }
  await notify(`${head}${weekly || !caps.length ? "" : "\n\nOr keep building up to a higher share of this 5-hour window (until it resets; your own sessions get less room):"}`, fetch, weekly ? undefined : caps.map((c) => ({ text: `▶️ ${c}%`, data: `keepgoing ${c}` })), { kind: weekly || !caps.length ? "health" : "approval" }) // no button = nothing to decide: not #needs-you
}

async function tick() {
  const allPaused = paused(db, { kind: "all" })
  if (allPaused) return console.log(`${allPaused} (say "resume everything")`)
  void import("./deploy.ts").then((m) => m.runQueuedDeploys(db)).then((r) => r.forEach((l) => console.log(l))).catch((e) => console.log(`queued deploys: ${e}`)) // deploys held by a pause run once it ends (also on auto-resume)
  await eveningDigest().catch((e) => console.log(`digest: ${e}`))
  // No AI: runs even when the budget skips. At most every 10 min: the tick now runs every minute, GitHub limits issue creation.
  const boardAt = Number((db.prepare("SELECT v FROM kv WHERE k='board:at'").get() as { v: string } | undefined)?.v ?? 0)
  if (Date.now() - boardAt > 10 * 60_000) {
    db.prepare("INSERT OR REPLACE INTO kv VALUES ('board:at', ?)").run(String(Date.now()))
    try { for (const l of syncBoard(db)) console.log(l) } catch (e) { console.log(`board: ${(e as Error).message}`) }
  }
  // Tickets in fixing for over 24h: one #needs-you card each (Haiku only for a card's first summary).
  for (const l of await stuckScan(db).catch((e) => [`stuck: ${(e as Error).message}`])) console.log(l)
  const held = lockHeld(db)
  if (held && !held.stale) return console.log("busy: another tick is running")
  if (held) console.log(`took over a stale tick lock: ${held.stale}`)
  const u = readUsage(db)
  if (u) noteWindow(db, u.fiveUsed, u.fiveMsToReset)
  const gate = allowed(u)
  const waiting = (db.prepare("SELECT count(*) n FROM tickets WHERE status='ready'").get() as { n: number }).n
  // since when ready work has been held by the budget (the pipeline health check warns after 3 hours)
  if (gate.ok || !waiting) db.prepare("DELETE FROM kv WHERE k IN ('cap:blocked-since', 'cap:why')").run()
  else { db.prepare("INSERT OR IGNORE INTO kv VALUES ('cap:blocked-since', ?)").run(String(Date.now())); db.prepare("INSERT OR REPLACE INTO kv VALUES ('cap:why', ?)").run(gate.why) } // `list` and `show` say why a ready ticket is not starting
  if (!gate.ok) {
    if ((u || apiKeyMode()) && waiting) await pausePing(u, gate.why)
    return console.log(`skip: ${u && !apiKeyMode() ? limitsNow(db, u).line : gate.why}`)
  }
  db.prepare("INSERT OR REPLACE INTO kv VALUES ('lock', ?)").run(lockValue())
  // Heartbeat: the lock stays fresh while this process lives; if it dies, the next tick sees the pid gone (or the heartbeat LOCK_MS old) and takes over.
  const beat = setInterval(() => db.prepare("INSERT OR REPLACE INTO kv VALUES ('lock', ?)").run(lockValue()), 5 * 60_000)
  try {
    // We hold the lock, so a ticket still marked running was cut off (crash, reinstall, reboot): put it back.
    // Its LangGraph checkpoint makes it resume where it stopped, not start over.
    // A running ticket whose builder is still alive (`dobby run`, a fix path: they build outside this lock) is not cut off.
    const cut = resetOrphans(db)
    const orphans = cut.length
    if (orphans) {
      console.log(`resumed ${orphans} cut-off ticket(s)`)
      fixed(db, `${orphans} build${orphans > 1 ? "s were" : " was"} cut off (restart or crash) and ${orphans > 1 ? "are" : "is"} back in the queue, picking up where ${orphans > 1 ? "they" : "it"} stopped:\n${cut.map((c) => `• ${c.project}: ${c.title}`).join("\n")}`)
    }
    // A parent that failed or was declined strands its children (they wait for "shipped"): tell the owner once per parent.
    for (const o of orphanedParents(db)) {
      db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`dep-ping:${o.key}`, String(Date.now()))
      await notify(`⏸ ${o.project} #${o.id} ${o.status}, so ${o.children.length} ticket(s) that build on it are stuck waiting\n${o.title}\nWaiting: ${o.children.map((c) => `#${c.id} ${c.title}`).join("; ")}\nRe-queue the parent, or drop the dependency.`, fetch, undefined, { kind: "stuck" })
    }
    // Goals: the owner edits them in projects/<app>.md; the table follows, and every ticket links to one.
    for (const p of Object.values(loadProjects())) syncGoals(db, p.name, p.rules)
    // An active project with nothing ready gets a Lead run first (at most every 10 minutes), so the queue refills itself.
    // Program Manager every cycle (no AI unless a program finished): merged/closed PRs, one re-queue, next ticket, status.
    for (const p of Object.values(loadProjects()).filter((x) => !x.paused && !paused(db, { kind: "planning", project: x.name }))) for (const l of await runPrograms(db, p.name).catch((e) => [`programs ${p.name}: ${(e as Error).message}`])) console.log(l)
    // Idle window (owner, 19 Oct): past its midpoint under 30% used means the queue is too short: the Lead promotes more, and 3 workers run by day.
    const idle = !!u && windowIdle(u)
    // Process roles get at most 20% and are throttled first: when this says no, only builders run this cycle.
    const proc = processAllowed(db, gate, u?.fiveUsed)
    if (!proc.ok) console.log(`process roles wait: ${proc.why}`)
    // Product Manager daily from 06:00 IST (Opus), then one Area PM (Sonnet); both feed the Engineering Manager.
    if (proc.ok) for (const p of pmDue(db, loadProjects())) console.log(await runProduct(db, p.name, "pm").catch((e) => `pm ${p.name}: ${(e as Error).message}`))
    if (proc.ok) for (const p of areaDue(db, loadProjects())) console.log(await runProduct(db, p.name, "area").catch((e) => `area pm ${p.name}: ${(e as Error).message}`))
    // Engineering Manager: the week's plan on Monday from 06:30 IST (Opus), then a daily top-up when nothing is ready.
    if (proc.ok) for (const l of await runLeads(db, idle)) console.log(l)
    // Talent Scout: once a night, one role's skills + a retro on the last 24 hours (owner, 17 Oct: improve daily)
    if (proc.ok && scoutDue(db)) console.log(await scout(db, trainer).catch((e) => `scout: ${(e as Error).message}`))
    // Parallel + chained (owner, 16 Oct: "otherwise tokens won't be used"): WORKERS builders, each takes the next
    // ready ticket as soon as it finishes, while the budget allows. Claiming is synchronous (better-sqlite3), so two
    // workers can never take the same ticket. Each ticket has its own worktree and branch.
    // ponytail: two tickets touching the same lines conflict at merge; that ticket fails with "merge conflict"
    // and the Lead re-queues it. Add a pre-merge rebase if that shows up often.
    // No chain cap (owner, 18 Oct: "remove all such limits"): each worker keeps taking tickets until nothing is ready.
    // Worker cap back on 20 Oct: 16 parallel builders on the 10-core / 16 GB Mac hit load 38 and 1.9 GB free while the usage
    // budget was fine (5h window 42%), so the machine, not the budget, is the limit. 4 by day, 6 at night.
    const hr = zoned().getUTCHours(), day = hr >= 8 && hr < 23
    const workers = Math.min(day ? 4 : 6, Math.max(idle && day ? 3 : 1, (db.prepare("SELECT count(*) n FROM tickets WHERE status='ready'").get() as { n: number }).n))
    const seen = new Set<number>()
    const worker = async (w: number) => {
      for (let i = 0; ; i++) {
        const u2 = readUsage(db)
        const g2 = allowed(u2)
        if (!g2.ok) {
          if (u2 || apiKeyMode()) await pausePing(u2, g2.why)
          return console.log(`[w${w}] stops: ${u2 && !apiKeyMode() ? limitsNow(db, u2).line : g2.why}`)
        }
        const bp = paused(db, { kind: "builders" })
        if (bp) return console.log(`[w${w}] stops: builders ${bp} (resume from the dashboard or \`dobby resume\`)`)
        const t = nextTicket(db)
        if (!t) return console.log(`[w${w}] done after ${i} ticket(s): nothing ready`)
        if (seen.has(t.id)) return console.log(`[w${w}] #${t.id} was already tried in this run and is back in the queue; not building it twice. Run again for another try.`)
        seen.add(t.id)
        if (u2) noteWindow(db, u2.fiveUsed, u2.fiveMsToReset, { build: true })
        else if (!apiKeyMode()) fallbackStarted(db)
        const release = reserveBuild() // counted against the week while it runs: the next worker's check sees it
        if ((await buildTicket(t, `w${w}`, g2.why).finally(release)) === "stop") return
      }
    }
    await Promise.all(Array.from({ length: workers }, (_, i) => worker(i + 1)))
  } finally {
    clearInterval(beat)
    db.prepare("DELETE FROM kv WHERE k='lock'").run()
  }
}

/** Runs one ticket through the graph: claims it, onboards the project first if needed, never throws. `why` is the budget line shown in the log. */
async function buildTicket(t: NonNullable<ReturnType<typeof nextTicket>>, w: string, why: string): Promise<"ok" | "stop"> {
  setTicket(db, t.id, { status: "running" }) // claim before any await
  setBuildClaim(db, t.id) // so a tick's orphan reset (any process) leaves this live build alone
  try { return await ticketScope.run({ db, id: t.id }, () => buildClaimed(t, w, why)) } finally { clearBuildClaim(db, t.id); db.prepare("DELETE FROM kv WHERE k=?").run(`cancel:${t.id}`) } // the build is over: the cancel guard is no longer needed
}
async function buildClaimed(t: NonNullable<ReturnType<typeof nextTicket>>, w: string, why: string): Promise<"ok" | "stop"> {
  try { syncBoard(db, { only: t.id }) } catch {} // the board shows "Building" now, not at the next tick
  if (!db.prepare("SELECT 1 FROM kv WHERE k=?").get(`onboarded:${t.project}`)) {
    setTicket(db, t.id, { status: "ready" })
    console.log(`[${w}] ${t.project} was never onboarded; onboarding first`)
    await onboard(t.project)
    return "stop"
  }
  const dir = t.onto ? loadProjects()[t.project]?.repo : undefined
  const done = dir && t.onto ? await prDone(dir, t.onto) : null
  if (done) {
    setTicket(db, t.id, { status: "declined", note: `PR on ${t.onto} is ${done.toLowerCase()}; nothing left to fix` })
    console.log(`[${w}] #${t.id}: PR on ${t.onto} ${done.toLowerCase()}, closed`)
    return "ok"
  }
  console.log(`[${w}] #${t.id} ${t.project}: ${t.title} (${why})`)
  const app = compileTicketGraph(db)
  const cfg = thread(t.id)
  // A ticket sent back to "ready" restarts from scratch; a crashed one resumes from its last checkpoint.
  // One broken ticket must not crash the whole tick (17 Oct: #242's PR branch was gone, every tick died all night).
  try {
    const snap = await app.getState(cfg)
    const out = await app.invoke(resumeInput(snap, t.id), cfg)
    console.log(`[${w}] ` + (out.log as string[]).join(`\n[${w}] `))
    try { syncBoard(db, { only: t.id }) } catch {}
  } catch (e) {
    await reportCrash(e, "tick", db) // opt-in crash reports: class and place only
    const why = (e as Error).message.slice(0, 300)
    // Known case, healed in place: a fix ticket whose PR branch is gone (merged or closed) has nothing left to do.
    if (t.onto && /couldn't find remote ref/.test(why)) {
      setTicket(db, t.id, { status: "declined", note: `PR branch ${t.onto} is gone (merged or closed); nothing left to fix` })
      console.log(`[${w}] #${t.id}: PR branch gone, closed`)
      return "ok"
    }
    // Claude signed out: nothing is wrong with the ticket. Put it back untouched and stop this worker (every build would fail the same way); claude() already pinged the owner once.
    // Claude did not start (binary missing or mid-update): same treatment, no owner ping; the next tick tries again.
    if (/^Claude did not start/.test(why)) {
      setTicket(db, t.id, { status: "ready", note: why })
      console.log(`[${w}] #${t.id}: ${why}; ticket put back, worker stops`)
      return "stop"
    }
    if (/^Claude is signed out/.test(why)) {
      setTicket(db, t.id, { status: "ready", note: why })
      console.log(`[${w}] #${t.id}: ${why}; ticket put back, worker stops`)
      return "stop"
    }
    setTicket(db, t.id, { status: "failed", note: `crashed: ${why}` })
    console.log(`[${w}] #${t.id} crashed, marked failed, moving on: ${why}`)
    // Unknown case: Dobby files a ticket on itself (once per distinct error) and a builder fixes it like any other bug.
    const title = `Fix Dobby crash: ${why.split("\n")[0].slice(0, 120)}`
    if (!isDuplicate(db, "dobby", title)) {
      const { id } = addTicket(db, { project: "dobby", title, size: "S", priority: 95, done_when: `The tick no longer crashes this way. Ticket #${t.id} (${t.project}) hit it.\nError:\n${clip((e as Error).stack ?? why, 1500)}\nAdd a test that reproduces it.` })
      setTicket(db, id, { status: "ready" })
      await notify(`🩺 Dobby hit a crash and filed a fix for itself (#${id})\n${title}\nThe broken ticket #${t.id} was set aside; the rest keeps building.`, fetch, undefined, { kind: "health" })
    }
  }
  return "ok"
}

const answer = async (id: number, decision: "approve" | "decline") => log(await answerTicket(db, id, decision))
const log = (m: string) => (refuse(m), console.log(m), m) // a refusal ("no ticket #1", "Can't ...") is an error line and exit 1 for every verb

/** Anything that is not a command goes to a small Haiku agent: the dobby CLI, this folder, and read-only mail/calendar/Drive. */
async function usageNow() {
  try {
    const u = await import("./usage.ts")
    return `${u.report(db, 1)}\n\n${u.report(db, 7)}`
  } catch (e) {
    return `(usage not available: ${(e as Error).message})`
  }
}

/** A draft or a Dobby action as a #needs-you card with Send / Do it and Discard: never sent or run from here (audit 20 Oct, item 4). */
async function propose(proposal: Proposal) {
  const id = storeProposal(db, proposal)
  const action = proposal.kind === "command"
  await notify(preview(id, proposal, db), fetch, [{ text: action ? "✅ Do it" : "📤 Send", data: `send ${id}` }, { text: "🗑 Discard", data: `discard ${id}` }], { kind: "proposal" })
  return `${action ? `\`dobby ${proposal.body}\` is waiting for your Do it` : `Draft ${id} is waiting for your Send`} in ${discordOn() ? "#needs-you" : "the message above"}.`
}

async function frontDesk(text: string, replyTo: string) {
  if (isStatusAsk(text)) return statusText(db, Date.now(), limitsNow(db)) // no AI, instant
  // The owner typed an action word for word ("queue 12", "pause everything"): their own words, so it runs as before, no AI,
  // except deploys, migrations and review overrides, which get a Do it card even when typed (owner, 20 Oct). run/company go to
  // the background so the listener never waits on them. Anything the front desk itself wants to do is a proposal (below).
  const typed = text.trim().replace(/\s+/g, " ")
  const own = actionArgs(typed)
  if (own && typedNeedsTap(typed)) return `${await propose({ kind: "command", to: [], subject: "", body: typed })}`
  if (own?.background) return runForeman(own.args, true).out + `: dobby ${typed}`
  if (own) return inChild(own.args)
  const role = loadRole("front-desk")
  const { recent } = await import("./notify.ts")
  const past = recent((db.prepare("SELECT v FROM kv WHERE k='tg:history'").get() as { v: string } | undefined)?.v)
  const convo = past.length ? `\n\nEARLIER IN THIS CONVERSATION (oldest first):\n${past.map((m) => `${m.who}: ${m.text.slice(0, 600)}`).join("\n")}` : ""
  const r = await claude(db, {
    project: "dobby", kind: "front-desk", model: role.meta.model ?? "haiku", effort: role.meta.effort, cwd: ROOT,
    // usage is always on hand (owner, 17 Oct: "nothing should be a command"); kept fresh by the 2-minute sampler
    prompt: `${role.body}${convo}\n\nCLAUDE USAGE NOW (answer usage, cost, token and limit questions from this; API-$ = what it would cost on the API, not money spent):\n${await usageNow()}\n\nMESSAGE: ${text}${replyTo ? `\n(It replies to this Dobby message: ${replyTo.slice(0, 1500)})` : ""}`,
    args: FRONT_DESK_ARGS,
  })
  const { reply, proposal } = parseProposal(r.ok ? r.text : "")
  let answer = (r.ok ? reply : `Couldn't handle that (${plainReason(r.reason)}). Try again, or ask at the Mac.`).slice(0, 3500)
  if (proposal) answer += `\n\n${await propose(proposal)}`
  else if (/"propose"/.test(r.text)) answer += "\n\n(The draft was dropped: it was malformed or held something that looks like a secret, so nothing is waiting. Ask again.)"
  const now = Date.now()
  db.prepare("INSERT OR REPLACE INTO kv VALUES ('tg:history', ?)").run(JSON.stringify([...past, { at: now, who: "you", text }, { at: now, who: "foreman", text: answer }]))
  return answer
}

/** An owner command (button or typed): it ran, so it counts as an owner touch on its ticket, with a reason tag. */
async function command(text: string, replyTo = ""): Promise<string | null> {
  const out = await act(text, replyTo)
  if (out !== null) touch(db, { ticket: touchedTicket(text, replyTo), kind: "tap", tag: tagFor(text.trim()), note: text.trim().slice(0, 100) })
  return out
}
/** The ticket an owner command is about: "approve 12", "queue 12", a reply naming #12, or the ticket behind a PR. */
function touchedTicket(text: string, replyTo: string): number | null {
  const t = text.trim()
  const pr = t.match(/^(?:reviewfix|reviewaccept)\s+([\w.-]+\/[\w.-]+)\s+(\d+)$/i)
  if (pr) return (db.prepare("SELECT id FROM tickets WHERE note LIKE ? ORDER BY id DESC LIMIT 1").get(`%github.com/${pr[1]}/pull/${pr[2]}%`) as { id: number } | undefined)?.id ?? null
  if (/^(deploynow|keep|send|discard|buildidea|dropidea|undoidea|scoutmerge|scoutreject|undo-scout)/i.test(t)) return null
  return Number(t.match(/#?(\d+)/)?.[1] ?? replyTo.match(/#(\d+)/)?.[1]) || null
}

/** One turn of an idea brainstorm: Sonnet, read-only, one resumed session per idea so the cache stays warm. Never builds. */
async function brainstorm(ideaId: number, text: string) {
  const i = db.prepare("SELECT * FROM ideas WHERE id=?").get(ideaId) as { project: string; title: string; why: string | null; evidence: string | null; risks: string | null; size: string | null; experiment: string | null }
  const role = loadRole("brainstorm")
  const fresh = !db.prepare("SELECT 1 FROM kv WHERE k=?").get(`sess:idea-${ideaId}`)
  const card = `IDEA #${ideaId} (${i.project}): ${i.title}\nWhy now: ${i.why ?? ""}\nRisks: ${i.risks ?? ""}\nSize: ${i.size ?? ""}\nFirst test: ${i.experiment ?? ""}\nEvidence: ${(i.evidence ?? "").slice(0, 800)}`
  const r = await claude(db, {
    project: i.project, kind: "brainstorm", model: role.meta.model ?? "sonnet", effort: role.meta.effort, cwd: loadProjects()[i.project]?.repo ?? ROOT, session: `idea-${ideaId}`,
    prompt: `${fresh ? `${role.body}\n\n${card}\n\n` : ""}OWNER: ${text || "(the owner just gave this idea a 👍: open the brainstorm)"}`,
    args: ["--setting-sources", "project", "--allowedTools", "Read,Glob,Grep", "--disallowedTools", "Edit,Write,NotebookEdit,WebFetch,Bash"],
  })
  return r.ok ? r.text.trim().slice(0, 1900) : `Couldn't think that through (${r.reason}). Send it again.`
}

/** An owner command from a button or a typed reply: approve/decline/queue <ticket>, send/discard <draft>, reviewfix/reviewaccept <repo> <pr>. null = not a command. */
/** The Trainer's voice in #dobby-ideas (Scout changes, with their Undo button). */
const trainer = (text: string, buttons?: { text: string; data: string }[]) => notify(text, fetch, buttons, { kind: "idea", project: "dobby" })

async function act(text: string, replyTo = ""): Promise<string | null> {
  // "undo-scout <sha>": the ↩️ button under a Scout change: a revert pull request (or closing the change's own PR if it never
  // merged). Never the owner's checkout, never a push to main (audit 20 Oct, item 5).
  const us = text.trim().match(/^undo-scout\s+([0-9a-f]{7,40})$/i)
  if (us) return undoScout(db, us[1])
  // ✅ Approve / 🗑 Reject on a Scout card (changing what agents may do is the owner's call)
  const sc = text.trim().match(/^(scoutmerge|scoutreject)\s+([\w.-]+\/[\w.-]+)\s+(\d+)$/i)
  if (sc) return sc[1].toLowerCase() === "scoutmerge" ? mergeScout(db, sc[2], Number(sc[3])) : rejectScout(db, sc[2], Number(sc[3]))
  // pause / resume with levels (src/pause.ts): bare = builders; all|everything also stops the tick, killing the running builds (they resume from their checkpoints).
  const pc = parsePause(text)
  if (pc) return pauseAct(db, pc)
  const rv = text.trim().match(/^(reviewfix|reviewaccept)\s+([\w.-]+\/[\w.-]+)\s+(\d+)$/i)
  if (rv) return rv[1].toLowerCase() === "reviewfix" ? fixReview(db, rv[2], Number(rv[3])) : acceptReview(db, rv[2], Number(rv[3]))
  // "deploynow <project> [migrate <sha>]": the 🚀 / 🔁 buttons on deploy pings (migrate = owner OK'd the data migrations shown for <sha>)
  const dn = text.trim().match(/^deploynow\s+([\w-]+)(\s+migrate(?:\s+([0-9a-f]{7,40}))?)?$/i)
  if (dn) return (await import("./deploy.ts")).deployProject(db, dn[1], { tapped: true, migrate: Boolean(dn[2]), at: dn[3] })
  const aw = text.trim().match(/^agentwords\s+([0-9a-f]{12})$/i) // the ✅ Add it button on an agent's hint or answer
  if (aw) return applyAgentWords(db, aw[1])
  const ar = text.trim().match(/^(allowround|applyfinding)\s+(\d+)$/i) // the buttons on an agent's ask for one more fix round or a finding's fix
  if (ar) return (await runAction(db, ar[1].toLowerCase() === "allowround" ? "allow-round" : "apply-finding", { id: Number(ar[2]) })).text
  const sk = text.trim().match(/^stuck(retry|decline)\s+(\d+)$/i) // the buttons on a "stuck in fixing" card
  if (sk) return stuckTap(db, sk[1].toLowerCase() as "retry" | "decline", Number(sk[2]))
  const r = parseReply(text, replyTo)
  if (r) return answerTicket(db, r.id, r.decision) // not answer(): it prints too, and `do` prints what this returns
  const kg = text.trim().match(/^keep ?(?:going|building)(?:\s+(\d{2,3}))?%?$/i)
  if (kg) {
    const cap = Math.min(100, Math.max(60, Number(kg[1] ?? 90)))
    const u = readUsage(db)
    db.prepare("INSERT OR REPLACE INTO kv VALUES ('budget:override', ?)").run(JSON.stringify({ until: Date.now() + (u?.fiveMsToReset ?? 5 * 3600_000), cap }))
    return `▶️ Building again up to ${cap}% of this 5-hour window, until it resets. Starting within a minute.`
  }
  const bi = text.trim().match(/^(buildidea|dropidea|undoidea)\s+(\d+)$/i)
  if (bi) {
    const id = Number(bi[2]), verb = bi[1].toLowerCase()
    if (verb === "buildidea") return ideaToTicket(db, id)
    if (verb === "undoidea") return undoIdea(db, id)
    return dropIdea(db, id, ["new", "proposed", "brainstorm"])
  }
  const m = text.trim().match(/^(queue|send|discard)\s+(\w+)$/i)
  if (!m) return null
  const verb = m[1].toLowerCase()
  return verb === "queue" ? queueTicket(db, Number(m[2])) : verb === "send" ? sendProposal(db, m[2]) : discardProposal(db, m[2])
}

// PR reviews without GitHub Actions: every 15 minutes inside the always-on listener, never two scans at once.
let scanning = false

/**
 * Child time limits (audit #15: a hung child held its lane, or the scan flag, forever): `do` by verb (doTimeoutMs: 20 min, 3 h for
 * landing/deploy verbs), review-scan 90 min (DOBBY_TIMEOUT_SCAN_MS), the usage jobs 10 min. Owner-command children: at most
 * DOBBY_BUTTON_CONCURRENCY (3) at once across lanes.
 */
const USAGE_MS = 10 * 60_000
const buttonSlots = semaphore(Number(process.env.DOBBY_BUTTON_CONCURRENCY) > 0 ? Number(process.env.DOBBY_BUTTON_CONCURRENCY) : 3)
/** Run a heavy dobby command in a child process so the listener's event loop never blocks (Discord needs acks within 3 s). Stopped (whole process group) after `ms`. */
async function inChildResult(args: string[], ms = args[0] === "do" ? doTimeoutMs(args.slice(1).join(" ")) : USAGE_MS): Promise<{ text: string; ok: boolean }> {
  const go = async () => {
    const r = await runAsync(`${ROOT}bin/dobby`, args, { all: true, timeoutMs: ms })
    return { ok: r.ok, text: r.out.trim().split("\n").filter(Boolean).slice(-6).join("\n") || `${args[0]}: done` }
  }
  return args[0] === "do" ? buttonSlots(`dobby ${args.slice(0, 2).join(" ")}`, go) : go()
}
const inChild = async (args: string[], ms?: number) => (await inChildResult(args, ms)).text
/** One background job at a time per name; the flag always clears (finally), so a throw cannot stop it for good. */
const busy = new Set<string>()
async function once(name: string, args: string[]) {
  if (busy.has(name)) return
  busy.add(name)
  try { return await inChild(args, USAGE_MS) } catch (e) { return `${name}: ${(e as Error).message}` } finally { busy.delete(name) }
}

async function reviewScan() {
  if (scanning) return
  scanning = true
  try {
    console.log(`review-scan: ${await inChild(["review-scan"], timeoutMs("scan"))}`) // child process: never blocks button acks
  } catch (e) {
    console.log(`review-scan: ${(e as Error).message}`)
  } finally {
    scanning = false
  }
}

/** The listener job: Discord plus its background samplers and the telemetry receiver. Shared by `listen` and `start`. */
async function listen(ddb: DB) {
  console.log(`listening on ${config().chat?.platform === "slack" ? "Slack" : "Discord"}`)
  setInterval(reviewScan, 15 * 60_000) // backup only: GitHub Actions on the Mac runner triggers reviews instantly
  // usage sampler: limits + new session-file lines every 2 min, in a child so big files never block Discord heartbeats
  setInterval(() => void once("sampling", ["usage-sample"]), 2 * 60_000)
  setInterval(() => void once("logging", ["usage-log"]), 10 * 60_000)
  void startTelemetry(db) // Claude Code OpenTelemetry receiver (127.0.0.1); a busy port is logged, never fatal
  await discordListen(ddb)
}

/** Always-on Discord listener: buttons, #assistant messages, 👍/👎 on #ideas. Only the server owner is obeyed (filtered in ownerEvent). */
async function discordListen(ddb: DB) {
  const { answerTap, post, prefix } = await (await import("./chat/platform.ts")).platform(), { kv } = await import("./chat/common.ts")
  await (await (await import("./chat/platform.ts")).platform()).listen(ddb, async (o) => {
    if (o.kind === "button") {
      noteUse(ddb, "discord_buttons")
      // (already acknowledged on arrival in listen(), so a busy queue never makes Discord say "did not respond")
      const { text: out, ok } = await inChildResult(["do", o.data]) // heavy work (merge, fix, review) off the listener's event loop
      // The result goes into the message that was tapped (no echo posts in #needs-you); a new post only if that edit fails. A failed action leaves the card's buttons.
      if (!(await answerTap(o, out, fetch, ok))) await post(ddb, { kind: /^(send|discard)/.test(o.data) ? "proposal" : "approval" }, out)
    } else if (o.kind === "brain") {
      const { brainSay } = await (await import("./chat/platform.ts")).platform()
      const idea = Number(kv(ddb, `${prefix}:brain:${o.thread}`))
      if (/^(go|build( it)?)$/i.test(o.text)) await brainSay(o.thread, ideaToTicket(db, idea))
      else if (/^drop( it)?$/i.test(o.text)) await brainSay(o.thread, (await act(`dropidea ${idea}`)) ?? "dropped", [{ text: "↩️ Undo", data: `undoidea ${idea}` }])
      else await brainSay(o.thread, await brainstorm(idea, o.text))
    } else if (o.kind === "ask") { const a = await frontDesk(o.text, ""); if (o.dm) await (await import("./chat/slack.ts")).dm(o.dm, a); else await post(ddb, { kind: "ask" }, a) }
    else {
      const idea = Number(kv(ddb, `${prefix}:idea:${o.messageId}`))
      if (!idea) return
      const project = (db.prepare("SELECT project FROM ideas WHERE id=?").get(idea) as { project: string } | undefined)?.project ?? Object.keys(config().discord.apps)[0]
      const row = db.prepare("SELECT source, lens, evidence FROM ideas WHERE id=?").get(idea) as { source: string; lens: string | null; evidence: string | null } | undefined
      if (o.up && row?.source === "scout" && row.lens === "skill") {
        // a skill card: install it (pinned commit), no ticket needed
        db.prepare("UPDATE ideas SET status='approved' WHERE id=?").run(idea)
        const r = installSkill(db, JSON.parse(row.evidence ?? "{}"))
        if (r.pr) void scoutCard(db, r).catch((e) => console.log(`scout card: ${(e as Error).message}`))
        await post(ddb, { kind: "idea", project }, scoutSays(r), r.sha ? [{ text: "↩️ Undo", data: `undo-scout ${r.sha.slice(0, 12)}` }] : undefined)
      } else if (o.up) {
        // brainstorm first (owner, 18 Oct): a thread on the card, nothing queued until Build it / "go"
        const st = (db.prepare("SELECT status FROM ideas WHERE id=?").get(idea) as { status: string } | undefined)?.status
        if (st && !["new", "proposed"].includes(st)) return
        db.prepare("UPDATE ideas SET status='brainstorm' WHERE id=?").run(idea)
        const title = (db.prepare("SELECT title FROM ideas WHERE id=?").get(idea) as { title: string }).title
        const { openBrainThread, brainSay } = await (await import("./chat/platform.ts")).platform()
        const th = await openBrainThread(ddb, o.channelId, o.messageId, idea, title)
        await brainSay(th, await brainstorm(idea, ""), [{ text: "Build it", data: `buildidea ${idea}` }, { text: "Drop it", data: `dropidea ${idea}` }])
      } else {
        await post(ddb, { kind: "idea", project }, dropIdea(db, idea, ["new", "proposed"]), [{ text: "↩️ Undo", data: `undoidea ${idea}` }])
      }
    }
  })
}

/** Onboarder: one read-only pass over every doc and skill; results land in Dobby, nothing in the repo changes. */
/** Same work under different words: Haiku groups them; the first of each group stays, the rest point to it. Running, fixing (bound to a PR branch) and split (already a program) tickets are never merged. */
async function dedupe(project: string) {
  const items = [
    ...(db.prepare("SELECT 't'||id AS id, title, status FROM tickets WHERE project=? AND dup_of IS NULL AND status NOT IN ('declined','shipped','running','fixing','split')").all(project) as { id: string; title: string; status: string }[]),
    ...(db.prepare("SELECT 'i'||id AS id, title, status FROM ideas WHERE project=? AND dup_of IS NULL AND status NOT IN ('rejected')").all(project) as { id: string; title: string; status: string }[]),
  ]
  if (items.length < 2) return
  const r = await claude(db, {
    project, kind: "dedupe", model: "haiku", args: ["--setting-sources", "project", "--tools", ""],
    prompt: `These are work items for one product. t = ticket, i = idea. Find items that describe the SAME piece of work in different words. Similar topic is not enough; it must be the same work.
For each group, put the item to KEEP first: prefer a ticket over an idea, an approved/parked item over a new one, the more specific one otherwise.
Answer with ONLY one JSON line: {"groups": [["t12","i3"], ...]} or {"groups": []}

${items.map((i) => `${i.id} [${i.status}] ${i.title}`).join("\n")}`,
  })
  const ids = new Set(items.map((i) => i.id))
  let n = 0
  for (const g of parseGroups(r.text)) {
    const [keep, ...rest] = g.filter((id) => ids.has(id))
    for (const id of rest) {
      db.prepare(`UPDATE ${id[0] === "t" ? "tickets" : "ideas"} SET dup_of=?${id[0] === "t" ? ", status='declined'" : ", status='rejected'"} WHERE id=?`).run(keep, Number(id.slice(1)))
      n++
    }
  }
  console.log(`dedupe ${project}: ${n} duplicate(s) merged into their original`)
}

/** Join a project: a draft dobby.md (repo path only) if none exists, then onboarding fills in commands and goal. */
/** The folder for a user's project drafts and onboarding notes (made on first use). */
function notesDir(root: string) {
  const d = projectsDir() || `${root}projects`
  mkdirSync(d, { recursive: true })
  return d
}

async function init(arg: string) {
  const { existsSync, rmSync, writeFileSync } = await import("node:fs")
  const { home } = await import("./lib.ts")
  const { checkRepoPath, defaultRoots, findRepos, repoName } = await import("./setup-steps.ts")
  // a path (anywhere in your home folder) or a name (the projects folder first, then the other folders)
  let dir: string, field: string
  if (/^[~.]|\//.test(arg)) {
    const r = checkRepoPath(arg)
    if (!r.ok) throw new Error(r.reason)
    dir = r.d.dir; field = r.d.dir
  } else if (existsSync(home(`${config().paths.projects}/${arg}`))) { dir = home(`${config().paths.projects}/${arg}`); field = `${config().paths.projects}/${arg}` }
  else {
    const hit = findRepos(defaultRoots()).find((d) => repoName(d) === arg)
    if (!hit) throw new Error(`no repo at ${home(`${config().paths.projects}/${arg}`)}`)
    dir = field = hit.dir
  }
  const { slugName } = await import("./setup-steps.ts"), { baseBranch, joinDraft } = await import("./detect.ts")
  const project = slugName(dir.split("/").pop()!), base = baseBranch(dir)
  const { ROOT } = await import("./lib.ts")
  const repo = dir
  const dirN = notesDir(ROOT)
  const draft = `${dirN}/${project}.md`
  const fresh = !loadProjects()[project]
  if (fresh) { console.log(`${project} is not a Dobby project yet, so this adds it: drafting projects/${project}.md, then onboarding. For the machine setup, run \`dobby init\` with no name.`); writeFileSync(draft, joinDraft(field, { base })) }
  // code map first (AST only, free): the Onboarder and later Builders query it instead of crawling
  const { sh } = await import("./lib.ts")
  console.log(sh("[ -d graphify-out ] && graphify update . >/dev/null && echo 'graphify: graph refreshed' || echo 'graphify: no graph yet, run /graphify in this repo once'", repo).out.trim())
  const rules = await onboard(project, !!process.stdin.isTTY && !process.argv.includes("--yes")).catch((e) => { if (fresh) rmSync(draft, { force: true }); throw e }) // no placeholder project (verify: true) is left behind
  if (rules === undefined && fresh) { rmSync(draft, { force: true }); throw new UserError("onboarding_failed", `onboarding ${project} did not finish, so no project file was written. Fix the error above, then run: dobby init ${arg}`) }
  if (fresh && rules) {
    const q = (v?: string) => (v ?? "").replace(/\n/g, " ") // a missing verify stays empty: it must never become "true"
    const verify = q(rules.verify).trim()
    writeFileSync(draft, `---\nrepo: ${field}\npriority: 5\nbase: ${base}\ninstall: ${installCmd(q(rules.install))}\n${verify ? `verify: ${verify}\n` : ""}---\n## Goal (from the docs, you confirm)\n${rules.goal}\nDeadline: ${rules.deadline}\n\n## Scope now\n${rules.scope}\n\n## Agents may do on their own\n${rules.may_do}\n\n## Always ask me\n${rules.always_ask}\n\n## Specialists\n${rules.specialists}\n`)
    console.log(`drafted projects/${project}.md from its docs; confirm the goal and rules before tickets run${verify && verify !== "true" ? "" : `\nno test command for ${project}: set verify in projects/${project}.md (builds stay stopped until you do)`}`)
  }
}

/** `interactive`: a person is at the terminal (init <project> or onboard without --yes), so the first backlog can be offered for queueing. */
async function onboard(project: string, interactive = false): Promise<Record<string, string> | null | undefined> {
  const p = loadProjects()[project]
  if (!p) throw new Error(`no dobby.md for ${project}`)
  const first = !db.prepare("SELECT 1 FROM kv WHERE k=?").get(`onboarded:${project}`) // a project the owner already runs keeps its Lead as it is
  const role = loadRole("onboarder")
  const r = await claude(db, {
    project, kind: "onboard", model: role.meta.model ?? "sonnet", effort: role.meta.effort, cwd: p.repo,
    args: ["--setting-sources", "project", ...(existsSync(memoryDir(p.repo)) ? ["--add-dir", memoryDir(p.repo)] : []), "--allowedTools", "Read,Glob,Grep,Bash(ls:*),Bash(graphify:*)", "--disallowedTools", "Edit,Write,NotebookEdit,WebFetch,WebSearch"],
    prompt: role.body.replaceAll("{project}", project) + (existsSync(memoryDir(p.repo)) ? `\n\nALSO READ the founder's Claude memory notes for this project, every file in ${memoryDir(p.repo)}. "feedback" notes are how they want work done: fold them into the rules line (may_do, always_ask, specialists). "project" notes are decisions and status: use them for tickets, ideas and conflicts (a note that contradicts a doc is a conflict). Never copy secrets, tokens or personal data.` : "") + company(),
  })
  if (!r.ok) {
    console.log(`onboarder failed: ${r.reason}`)
    return undefined // failed, as opposed to null: finished with no rules block
  }
  const now = new Date().toISOString()
  const out: Record<string, number> = {}
  const docs: string[] = [], conflicts: string[] = []
  let rules: Record<string, string> | null = null
  for (const line of r.text.split("\n")) {
    let j: Record<string, string>
    try { j = JSON.parse(line.trim()) } catch { continue }
    out[j.type] = (out[j.type] ?? 0) + 1
    if ((j.type === "ticket" || j.type === "idea") && isDuplicate(db, project, j.title ?? "")) { out.skipped_duplicate = (out.skipped_duplicate ?? 0) + 1; continue }
    if (j.type === "ticket") db.prepare("INSERT INTO tickets (project,title,done_when,size,priority,status,note,created_at,updated_at) VALUES (?,?,?,?,?,'backlog',?,?,?)").run(project, j.title, j.done_when ?? "", j.size ?? "M", Number(j.priority) || 50, `from ${j.source ?? "docs"}`, now, now)
    else if (j.type === "idea") db.prepare("INSERT INTO ideas (project,title,source,lens,why,evidence,status,created_at) VALUES (?,?,'docs',?,?,?,'proposed',?)").run(project, j.title, j.lens ?? null, j.why ?? null, j.source ?? null, now)
    else if (j.type === "doc") docs.push(`- \`${j.path}\`: ${j.covers}`)
    else if (j.type === "conflict") conflicts.push(`- ${j.detail}`)
    else if (j.type === "rules") rules = j
  }
  const { writeFileSync } = await import("node:fs")
  const { ROOT } = await import("./lib.ts")
  const dir = notesDir(ROOT)
  writeFileSync(`${dir}/${project}.knowledge.md`, `# ${project}: knowledge map (from onboarding ${now.slice(0, 10)})\n\n## Documents\n${docs.join("\n")}\n\n## Conflicts or stale docs\n${conflicts.join("\n") || "none found"}\n`)
  if (rules) writeFileSync(`${dir}/${project}.onboard.md`, `Suggested dobby.md content from the docs. Review, then copy what you agree with into ${dir}/${project}.md.\n\n${Object.entries(rules).filter(([k]) => k !== "type").map(([k, v]) => `## ${k}\n${v}`).join("\n\n")}\n`)
  db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`onboarded:${project}`, now)
  await dedupe(project)
  if (first) {
    const { onboardPromote } = await import("./graphs/lead.ts")
    const choose = interactive ? async (titles: string[]) => {
      const c = await import("@clack/prompts")
      const a = await c.select({ message: `Queue these now?\n${titles.map((t) => `  ${t}`).join("\n")}`, options: [{ value: "yes", label: "Yes, queue all" }, { value: "pick", label: "Let me pick" }, { value: "no", label: "No, leave them in backlog" }] })
      if (a === "yes") return titles.map((_, i) => i)
      if (a !== "pick") return []
      const m = await c.multiselect({ message: "Which ones?", options: titles.map((t, i) => ({ value: i, label: t })), required: false })
      return c.isCancel(m) ? [] : m
    } : undefined
    const line = await onboardPromote(db, project, config().lead?.onboardPromote ?? "ask", choose)
    if (line) console.log(line)
  }
  console.log(`onboarded ${project}: ${JSON.stringify(out)}\nsee ${dir}/${project}.onboard.md, ${dir}/${project}.knowledge.md, dobby list --all, dobby ideas ${project}`)
  return rules as Record<string, string> | null
}

/** `dobby add discord|dashboard|jobs`: one add-on over a terminal-only start; tickets run without any of them. */
async function addOn(what: string, yes = false) {
  const { installJobs } = await import("./jobs.ts")
  const { startPid, jobsGate } = await import("./install.ts")
  const o = { bin: `${ROOT}bin/dobby`, home: homedir(), uid: process.getuid?.() ?? 0 }
  if (what === "discord") {
    const { readSecrets } = await import("./notify.ts")
    if (!readSecrets().DISCORD_BOT_TOKEN && process.stdin.isTTY) await (await import("./setup.ts")).askDiscordToken()
    if (!readSecrets().DISCORD_BOT_TOKEN) return console.log(`Discord in three steps:\n1. Create a bot at discord.com/developers and copy its token\n2. Add DISCORD_BOT_TOKEN=<token> to ${configDir()}/secrets.env\n3. Run: dobby discord invite, then dobby add discord again`)
    console.log(`✓ Discord: channels ready in "${await (await (await import("./chat/platform.ts")).platform(undefined, undefined, "discord")).setup(db)}". Restart dobby start (or the listener job) to get the buttons; dobby discord test sends a hello to each.`)
    const hint = await (await (await import("./chat/platform.ts")).platform(undefined, undefined, "discord")).intentHint().catch(() => null)
    if (hint) console.log(hint)
    if (config().chat?.platform === "slack") console.log("chat.platform is slack, so Dobby still talks on Slack. To switch: dobby config set chat.platform discord")
    return
  }
  if (what === "slack") {
    const p = await import("@clack/prompts")
    if (!process.stdin.isTTY) return console.log("Run dobby add slack in a terminal: it asks for the tokens, hidden.")
    return (await import("./setup.ts")).setupSlack(db, p.spinner())
  }
  if (what === "jobs") {
    const pid = startPid(db)
    if (pid) throw new Error(`dobby start is running (pid ${pid}): stop it with Ctrl-C first; the jobs replace it, and both would build every ticket twice`)
    const no = await jobsGate({ config: existsSync(privatePath()), signedIn: spawnSync("gh", ["auth", "token"], { stdio: "ignore" }).status === 0, tty: !!process.stdin.isTTY, yes,
      ask: async () => { const p = await import("@clack/prompts"); return (await p.confirm({ message: "Install the six background jobs?", initialValue: true })) === true } })
    if (no) { console.log(no); process.exitCode = 1; return }
  }
  // dashboard alone runs beside dobby start: it only reads the database and runs owner taps
  for (const r of installJobs({ ...o, discord: !!discordOn(), only: what === "dashboard" ? ["dashboard"] : undefined })) { console.log(`${r.ok ? "✓" : "✗"} ${r.name}: ${r.detail}`); if (!r.ok) process.exitCode = 1 }
}

/** `dobby add mcp`: connect the MCP server to Claude Code (asks first; --yes runs it) and print the block for Claude Desktop's config. */
async function addMcpHttp(yes: boolean, base: string) {
  const { claudeAddHttpCommand } = await import("./mcp.ts")
  const show = (a: string[]) => a.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ")
  console.log(`Claude Code over HTTP (the dashboard serves /mcp; use its https tunnel address for a phone or remote client):\n  ${show(claudeAddHttpCommand(base))}\n\nDASHBOARD_TOKEN is the token in ~/.config/dobby/secrets.env. Export it yourself; Dobby does not print it.`)
  if (!yes) return console.log("\nRun it yourself, or: dobby add mcp --http --yes (needs DASHBOARD_TOKEN exported)")
  const token = process.env.DASHBOARD_TOKEN
  if (!token) { console.log("DASHBOARD_TOKEN is not set in this shell; export it, then run this again."); process.exitCode = 1; return }
  const [bin, ...args] = claudeAddHttpCommand(base, `Authorization: Bearer ${token}`)
  const r = spawnSync(bin, args, { encoding: "utf8" })
  if (r.stdout || r.stderr) console.log(`${r.stdout}${r.stderr}`.split(token).join("$DASHBOARD_TOKEN").trim())
  if (r.status !== 0) { console.log("claude mcp add failed; run the command above yourself."); process.exitCode = 1 } else console.log("✓ Connected. Restart Claude Code, then ask it for your Dobby status.")
}

async function addMcp(yes: boolean) {
  const { claudeAddCommand, desktopConfig } = await import("./mcp.ts")
  const [bin, ...args] = claudeAddCommand(`${ROOT}bin/dobby`)
  console.log(`Claude Code:\n  ${[bin, ...args].map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ")}\n\nClaude Desktop: add this to claude_desktop_config.json:\n${desktopConfig(`${ROOT}bin/dobby`)}`)
  if (!yes) {
    if (!process.stdin.isTTY) return console.log("\nRun it yourself, or: dobby add mcp --yes")
    const { confirm, isCancel } = await import("@clack/prompts")
    const ok = await confirm({ message: "Run the Claude Code command now?" })
    if (isCancel(ok) || !ok) return
  }
  const r = spawnSync(bin, args, { stdio: "inherit" })
  if (r.status !== 0) { console.log("claude mcp add failed; run the command above yourself."); process.exitCode = 1 } else console.log("✓ Connected. Restart Claude Code, then ask it for your Dobby status.")
}

// A refused command (wrong ticket state, bad id) is a UserError: one plain line and exit 1, never a stack trace. Anything else is a real bug and still throws.
try {
switch (cmd) {
  case "dashboard":
    await (await import("./dashboard-server.ts")).run(a)
    break
  case "policy": {
    if (a[0] !== "explain" || !a[1]) { console.log('usage: dobby policy explain "<text or path>"'); break }
    console.log(explainPolicy(a.slice(1).join(" ")))
    break
  }
  case "safety": {
    if (a[0] !== "explain" || !a[1]) { console.log('usage: dobby safety explain "<ticket text>" | <pr number> | <owner/repo#pr>'); break }
    const { check, explainOutcome, isMigrationFile, sqlFromDiff } = await import("./safety.ts")
    const arg = a.slice(1).join(" ").trim()
    const m = arg.match(/^(?:([\w.-]+\/[\w.-]+)#|#)?(\d+)$/)
    let input: Parameters<typeof check>[0] = { text: arg }
    if (m) { // a PR: title, branch, files and the migration SQL, read with gh
      const R = m[1] ? ["-R", m[1]] : []
      const v = spawnSync("gh", ["pr", "view", m[2], ...R, "--json", "title,headRefName,files"], { encoding: "utf8" })
      if (v.status !== 0) { console.log(`gh could not read PR ${m[2]}: ${(v.stderr || v.stdout).slice(0, 200)}`); break }
      const j = JSON.parse(v.stdout) as { title: string; headRefName: string; files: { path: string }[] }
      const files = j.files.map((f) => f.path)
      const diff = files.some(isMigrationFile) ? spawnSync("gh", ["pr", "diff", m[2], ...R], { encoding: "utf8", maxBuffer: 50_000_000 }).stdout : ""
      const repo = m[1]?.split("/")[1]
      input = { text: `${j.title} ${j.headRefName}`, title: j.title, files, sql: sqlFromDiff(diff), project: repo && loadProjects()[repo] ? repo : undefined }
    } else {
      const proj = Object.keys(loadProjects()).find((n) => new RegExp(`\\b${n}\\b`, "i").test(arg))
      input = { text: arg, project: proj }
    }
    console.log(explainOutcome(await check(input, { db })))
    if (!m) console.log("note: migrations are checked from the PR's files, not the ticket text")
    break
  }
  case "add": {
    // flags may come before the project word: dobby add mcp --yes, dobby add --yes mcp
    const yes = a.includes("--yes") || a.includes("-y"), u = a.indexOf("--url")
    const w = a.filter((x, i) => !["--yes", "-y", "--no-issue", "--http", "--url"].includes(x) && !(u >= 0 && i === u + 1))
    if (["discord", "slack", "dashboard", "jobs"].includes(w[0]) && !w[1]) { await addOn(w[0], yes); break }
    if (w[0] === "skill" && !w[1]) { // dobby add skill: the setup-help skill, for your own Claude Code
      const { addSkill } = await import("./setup-help.ts")
      console.log(await addSkill({ yes, confirm: process.stdin.isTTY ? async (m) => { const p = await import("@clack/prompts"); const v = await p.confirm({ message: m, initialValue: true }); return v === true } : undefined }))
      break
    }
    if (w[0] === "mcp" && !w[1]) { if (a.includes("--http")) await addMcpHttp(yes, (u >= 0 && a[u + 1]) || "http://127.0.0.1:4710"); else await addMcp(yes); break }
    const noIssue = a.includes("--no-issue")
    const [project, title, done_when, size, priority] = w
    if (!project || !title) throw new Error('usage: add <project> "<title>" ["<done when>"] [S|M|L] [priority]')
    console.log(await addTicketText(db, { project, title, done_when, size, priority: priority ? Number(priority) : undefined, noIssue }, process.env.DOBBY_ROLE))
    break
  }
  case "list":
    console.log(listText(db, a[0] === "--all"))
    break
  case "status":
    console.log((await runAction(db, "status")).text)
    break
  case "limits":
    console.log((await runAction(db, "limits")).text)
    break
  case "scoreboard":
    console.log((await runAction(db, "scoreboard", { days: Number(a[0]) || 7 })).text)
    break
  case "tick":
    stampLogs() // tick.log: ISO time on every line
    await tick()
    scanIfDue(db, { discord: !!discordOn() || process.env.DOBBY_TICK_SCAN === "off", staleMs: timeoutMs("scan"), start: () => spawn(`${ROOT}bin/dobby`, ["review-scan"], { stdio: "inherit", detached: true, env: process.env }).unref() }) // no Discord = no listener = nothing else runs the PR review scan
    { const l = await flushUsage(db); if (l) console.log(l) } // opt-in usage stats: at most one batch a day
    await updateBoard(db, !!discordOn()).catch((e) => console.log(`status board: ${(e as Error).message}`)) // no AI; after every run, early returns included
    break
  case "show":
    log(await showText(db, Number(a[0]), "full"))
    break
  case "cost": // dobby cost <id>: what the ticket's PR cost, by stage
    log((await runAction(db, "cost", { id: Number(a[0]) })).text)
    break
  case "receipt": // dobby receipt [days]: the shipped-vs-spent line, and a 1200x630 card at <data>/receipt.svg
    noteUse(db, "week_report")
    console.log(receiptText(db, Number(a[0]) || 7, true))
    break
  case "approve":
  case "decline":
    await answer(Number(a[0]), cmd)
    break
  case "cancel":
    log(cancelTicket(db, Number(a[0])))
    break
  case "merge": // dobby merge <id>: the owner's merge of a waiting ticket's PR (a ticket at its gate is approved)
    log(refuse((await runAction(db, "merge", { id: Number(a[0]) })).text))
    break
  case "answer": case "hint": // dobby answer|hint <id> <words>: your words go into the ticket's done rule; an answer also queues it again
    log((await runAction(db, cmd, { id: Number(a[0]), text: a.slice(1).join(" ") })).text)
    break
  case "retry": // dobby retry <id>: a ticket stuck in fixing starts over, a failed one is queued again
    log(refuse((await runAction(db, "retry", { id: Number(a[0]) })).text))
    break
  case "done": { // dobby done <id> [--pr N]: the ticket's work is already in; mark it shipped, touch nothing else
    const p = a.indexOf("--pr")
    log(doneText(db, Number(a[0]), p >= 0 ? Number(a[p + 1]) : undefined))
    break
  }
  case "takeover": // dobby takeover <id>: pause the ticket and leave its branch to you
    log((await runAction(db, "take-over", { id: Number(a[0]) })).text)
    break
  case "allowround": // dobby allowround <id>: one more automatic fix round on its PR
    log(refuse((await runAction(db, "allow-round", { id: Number(a[0]) })).text))
    break
  case "applyfinding": // dobby applyfinding <finding id>: a fix ticket on the PR's branch for that one finding
    log(refuse((await runAction(db, "apply-finding", { id: Number(a[0]) })).text))
    break
  case "dismissfinding": // dobby dismissfinding <finding id>: the finding is intentional (like `@dobby learn`)
    log((await runAction(db, "dismiss-finding", { id: Number(a[0]) })).text)
    break
  case "findingrule": // dobby findingrule <finding id> [rule words]: a learning for the whole repo
    log((await runAction(db, "rule-from-finding", { id: Number(a[0]), text: a.slice(1).join(" ") || undefined })).text)
    break
  case "unqueue": // dobby unqueue <id>: a queued ticket goes back to the backlog
    log((await runAction(db, "unqueue", { id: Number(a[0]) })).text)
    break
  case "reorder": // dobby reorder <id> [before]: move a queued ticket above another (or last)
    log((await runAction(db, "reorder", { id: Number(a[0]), before: Number(a[1]) || undefined })).text)
    break
  case "ideaticket": // dobby ideaticket <id>: an idea becomes a backlog ticket and is queued
    log((await runAction(db, "idea-ticket", { id: Number(a[0]) })).text)
    break
  case "ideadrop": // dobby ideadrop <id>: drop an idea
    log((await runAction(db, "idea-drop", { id: Number(a[0]) })).text)
    break
  case "deploy": // dobby deploy <project>: the Deploy tap, from the terminal (a migration that changes data still waits for its own tap)
    log(refuse((await runAction(db, "deploy", { project: a[0] })).text))
    break
  case "graph":
    console.log((await compileTicketGraph(db).getGraphAsync()).drawMermaid())
    break
  case "idea": {
    const [project, ...words] = a
    if (!loadProjects()[project] || !words.length) throw new Error('usage: idea <project> "<idea>"')
    if (isDuplicate(db, project, words.join(" "))) { console.log("already on the list"); break }
    db.prepare("INSERT INTO ideas (project,title,source,created_at) VALUES (?,?,'you',?)").run(project, words.join(" "), new Date().toISOString())
    console.log("noted; the Product Manager develops it on its next run")
    break
  }
  case "usage-sample": { // the listener's 2-minute sampler (quiet)
    const u = await import("./usage.ts")
    u.ingest(db), u.poll(db)
    // the evening usage post, once a day after 21:00 IST (config eveningPostHour, timezone), in #system-status (no command needed)
    const ist = zoned(), day = ist.toISOString().slice(0, 10)
    if (ist.getUTCHours() >= config().eveningPostHour && (db.prepare("SELECT v FROM kv WHERE k='usage:posted'").get() as { v: string } | undefined)?.v !== day) {
      await notify(`${u.report(db, 1)}\n\nWeek so far:\n${u.report(db, 7).split("\n").slice(1).join("\n")}`, fetch, undefined, { kind: "health" })
      db.prepare("INSERT OR REPLACE INTO kv VALUES ('usage:posted', ?)").run(day)
    }
    break
  }
  case "usage-log": { // the listener's 10-minute logger: 5h %, weekly %, API-$ and tokens since the last reading
    const u = await import("./usage.ts")
    u.ingest(db)
    u.logReading(db, u.poll(db))
    break
  }
  case "usage": { // usage report: dobby usage [days]
    const u = await import("./usage.ts")
    const n = u.ingest(db)
    u.poll(db)
    console.log(`${n ? `(read ${n} new calls)\n` : ""}${u.report(db, Number(a[0] ?? 1))}`)
    break
  }
  case "scout": // Talent Scout now (normally once a night from tick)
    console.log(await scout(db, trainer))
    break
  case "strategize": // old name
  case "pm":
    console.log(await runProduct(db, a[0], a.includes("--area") ? "area" : "pm"))
    break
  case "ideas":
    for (const i of db.prepare("SELECT * FROM ideas WHERE status IN ('new','proposed') AND dup_of IS NULL AND (? IS NULL OR project=?) ORDER BY score DESC NULLS LAST, id").all(a[0] ?? null, a[0] ?? null) as Record<string, string>[])
      console.log(`#${i.id} [${i.project} ${i.lens ?? "seed"} ${i.size ?? "?"} ${i.score ?? "-"}] ${i.title}${i.why ? `\n    why: ${i.why}\n    risks: ${i.risks}\n    test first: ${i.experiment}` : ""}`)
    break
  case "dedupe":
    await dedupe(a[0])
    break
  case "company": {
    const dir = home(config().paths.memory)
    const r = await claude(db, { project: "dobby", kind: "company", model: "sonnet", args: ["--setting-sources", "project", "--add-dir", dir, "--allowedTools", "Read,Glob", "--disallowedTools", "Edit,Write,Bash,WebFetch,WebSearch"], prompt: `${loadRole("company").body}\n\nMEMORY FOLDER: ${dir}` })
    if (r.ok && r.text.trim()) writeFileSync(companyPath(), r.text.trim() + "\n")
    console.log(r.ok ? `wrote ${companyPath()}` : `failed: ${r.reason}`)
    break
  }
  case "init": // dobby init: one-command setup (--yes, --projects <dir>, --no-jobs); dobby init <project>: join one project
    if (!a[0] || a[0].startsWith("--")) {
      const folders = (await import("./setup-steps.ts")).projectFolders(a) // --projects a --projects b, or --projects a,b; absolute; no folder after the flag is an error
      const yes = a.includes("--yes"), ui = a.includes("--ui")
      const { askFace, initUi } = await import("./init-ui.ts")
      if (ui || (!yes && process.stdin.isTTY && (await askFace()) === "browser")) await initUi({ projects: folders })
      else await (await import("./setup.ts")).setup(db, { yes, noJobs: a.includes("--no-jobs"), projects: folders.length ? folders : undefined, root: ROOT })
    } else await init(a[0])
    break
  case "onboard":
    await onboard(a[0], !!process.stdin.isTTY && !a.includes("--yes"))
    break
  case "api": // Max plan API credits: on (auto, falls back when empty) | off | status
    console.log((await import("./api.ts")).apiCommand(db, a[0]))
    break
  case "run": { // dobby run <id>: build this ticket now, in this process. No worker cap, budget gate or tick lock; the owner asked for it.
    const t = getTicket(db, Number(a[0]))
    if (!t) throw new Error(`no ticket #${a[0]}`)
    reapDead(db) // a hard crash leaves the ticket "running" with no builder: put it back first
    if (getTicket(db, t.id)?.status === "running") throw new Error(`#${t.id} is already running`)
    if (["shipped", "declined"].includes(t.status)) throw new Error(`#${t.id} is ${t.status}`)
    setTicket(db, t.id, { status: "ready" })
    // a new project is onboarded first, which ends that step: the owner asked for this ticket, so it is built now too
    if ((await buildTicket(t, "run", "on demand")) === "stop" && db.prepare("SELECT 1 FROM kv WHERE k=?").get(`onboarded:${t.project}`) && getTicket(db, t.id)?.status === "ready") await buildTicket(t, "run", "on demand")
    const end = getTicket(db, t.id)
    console.log(runEndText(t.id, end))
    if (end?.status === "ready") process.exitCode = 1 // nothing was built: say so in the exit code too
    break
  }
  case "queue": // backlog -> ready (Owner:/deploy-type tickets stay put; same rule the Lead follows). A re-queue by hand is an owner touch.
    console.log(refuse(queueText(db, Number(a[0]))))
    break
  case "touch": { // dobby touch <ticket|-> <decision|broke|unclear|permission> [note]: log a fix you made by hand in a session
    const [id, tag, ...note] = a
    if (!TAGS.includes(tag)) throw new Error(`usage: touch <ticket|-> <${TAGS.join("|")}> [note]`)
    touch(db, { ticket: Number(id) || null, kind: "manual", tag, note: note.join(" ") })
    console.log(`noted: ${tag} touch${Number(id) ? ` on #${id}` : ""}. ${autonomyLine(db, 7)}`)
    break
  }
  case "pause": case "resume": // dobby pause|resume [all|<kind>|project <name>|ticket <id>] [for 30m|2h|1d]; pause status
    console.log((await command([cmd, ...a].join(" "))) ?? "")
    break
  case "do": { // run one button/command in its own process (used by the listener)
    console.log(refuse((await command(a.join(" "))) ?? `Unknown: ${a.join(" ")}`))
    break
  }
  case "ask": // try the front desk from the terminal
    console.log(await frontDesk(a.join(" "), ""))
    break
  case "capacity": // how full the 5-hour windows got this week, and what to change
    console.log(capacityFromDb(db) || "no windows recorded yet")
    break
  case "listen": { // the launchd job
    stampLogs() // listener.log: ISO time on every line
    const ddb = discordOn()
    if (!ddb) throw new Error(config().chat?.platform === "slack" ? "Slack is not set up (needs SLACK_BOT_TOKEN, SLACK_APP_TOKEN and a finished setup): run `dobby add slack` first" : "Discord is not set up: run `dobby discord` first")
    await listen(ddb)
    break
  }
  case "start": { // dobby start: the listener (if Discord is set up) and the queue loop, in this terminal. Ctrl-C stops it.
    requireConfig()
    const clash = startConflicts(process.platform, process.getuid?.() ?? 0)
    if (clash.length) throw new Error(`another Dobby is already running, and two would handle every tap twice: ${clash.join("; ")}`)
    stampLogs()
    db.prepare("INSERT OR REPLACE INTO kv VALUES ('start:pid', ?)").run(String(process.pid)) // dobby add jobs refuses while this runs
    process.on("exit", () => { try { db.prepare("DELETE FROM kv WHERE k='start:pid'").run() } catch {} })
    const ddb = discordOn()
    if (ddb) void listen(ddb).catch((e) => { console.log(`listener stopped: ${(e as Error).message}`); process.exitCode = 1 })
    else { console.log("Discord is not set up: running the queue loop and the PR review scan"); setInterval(reviewScan, 15 * 60_000) } // listen() starts the scan with Discord; without it the scan (and @dobby comments) would never run
    void reviewScan() // one scan now, then every 15 minutes (the intervals above): a fresh draft PR is reviewed without a wait
    console.log("queue loop running (Ctrl-C to stop)")
    // Each tick is a child process that inherits our output: a long install/verify never blocks the listener's event loop, every tick runs fresh code,
    // and its lines reach the terminal or service.log as they happen. It leads its own process group; its pid sits in kv so "pause everything" can stop it.
    const stop = () => {
      try {
        const v = (db.prepare("SELECT v FROM kv WHERE k='tick:pid'").get() as { v: string } | undefined)?.v
        if (v) { process.kill(-Number(v), "SIGTERM"); db.prepare("DELETE FROM kv WHERE k='lock'").run() } // the killed tick never reaches its finally: free the lock so the next start is not "busy" for 90 min
      } catch {}
      process.exit(0)
    }
    process.on("SIGINT", stop).on("SIGTERM", stop) // the detached child does not get the terminal's Ctrl-C
    for (;;) {
      await new Promise<void>((done) => {
        const c = spawn(`${ROOT}bin/dobby`, ["tick"], { stdio: "inherit", detached: true, env: process.env })
        if (c.pid) db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run("tick:pid", String(c.pid))
        c.on("error", (e) => { console.log(`tick: ${e.message}`); done() })
        c.on("close", () => { db.prepare("DELETE FROM kv WHERE k='tick:pid'").run(); done() })
      })
      await new Promise((r) => setTimeout(r, 60_000)) // the launchd tick job restarts 60 s after each run; same pace
    }
  }
  case "service": // dobby service install|uninstall [--dry]: run `dobby start` as a launchd (macOS) or systemd user (Linux) service
    service(a[0], a.includes("--dry"), servicePlan(process.platform, {
      exec: [process.execPath, "--no-warnings", import.meta.filename, "start"], path: servicePath([dirname(process.execPath), process.env.PATH ?? ""]), // the folder of this node first: a per-shell fnm PATH entry is gone after a reboot
      log: `${home("~/.local/share/dobby/logs")}/service.log`, home: homedir(), uid: process.getuid?.() ?? 0, dir: process.env.DOBBY_DIR,
    }))
    break
  case "telemetry-serve": // the receiver alone; stays up until killed
    if (!(await startTelemetry(db, Number(a[0]) || undefined))) process.exitCode = 1
    break
  case "slack":
  case "discord": {
    const d = await (await import("./chat/platform.ts")).platform(undefined, undefined, cmd as "slack" | "discord") // the command typed picks the platform, not the config
    const Name = d.name === "slack" ? "Slack" : "Discord"
    if (a[0] === "invite") console.log(await d.inviteUrl())
    else if (a[0] === "setup") {
      if (d.name === "slack") await (await import("./setup.ts")).askSlackOwner(db)
      console.log(`${Name} set up in "${await d.setup(db)}": #${d.channels.join(", #")}${d.name === "slack" ? ", private channels" : ", one webhook each"}`)
    }
    else if (a[0] === "test") {
      const tries: [Event, string][] = [
        [{ kind: "approval" }, "Test: this is #needs-you, the only channel that pings you."], [{ kind: "brief" }, "Test: the morning brief lands here."],
        ...Object.keys(config().discord.apps).map((p): [Event, string] => [{ kind: "lead", project: p }, `Test: ${p} tickets get one thread each here.`]),
        [{ kind: "idea", project: Object.keys(config().discord.apps)[0] }, "Test: idea cards land here. 👍 queues one, 👎 drops it."], [{ kind: "health" }, "Test: job and disk problems land here."],
        [{ kind: "ask" }, "Test: write here to talk to the front desk."],
      ]
      // asIs: no summary call for a test card; a hello that fails is not replayed by the brief (takeOutbox drops "Test: ")
      for (const [e, text] of tries) console.log(`${await notify(text, fetch, undefined, e, asIs) ? "ok " : "FAIL"} ${e.kind}`)
    } else console.log(`usage: ${d.name} invite | setup | test`)
    break
  }
  case "lead": {
    const dry = a.includes("--dry")
    const only = a.find((x) => !x.startsWith("--"))
    const names = only ? [only] : Object.values(loadProjects()).filter((p) => !p.paused).map((p) => p.name)
    if (!names.length) console.log("no projects yet: run dobby init to set up, or dobby init <project> to add one repo")
    for (const n of names) {
      if (!dry) (await import("./graphs/lead.ts")).releasePromote(db, n) // asking the Lead by hand lifts the first-backlog hold
      const r = await runLead(db, n, dry)
      if (dry) console.log(`plan: ${JSON.stringify(r.plan, null, 2)}`)
      console.log(r.report)
    }
    break
  }
  case "cos": {
    const r = await runCos(db, a.includes("--dry"))
    if (!a.includes("--dry")) console.log(r.brief) // lands in logs/cos.log
    console.log(a.includes("--dry") ? "dry run, nothing sent" : `${r.sent} of ${r.pings + 1} message(s) sent`)
    break
  }
  case "brief": { // the archived morning summary of a day (default today); --dry builds today's from live facts and sends nothing
    const { istDay, gather } = await import("./graphs/cos.ts"), { buildBrief, briefMarkdown } = await import("./brief.ts")
    const day = a.find((x) => /^\d{4}-\d\d-\d\d$/.test(x)) ?? istDay(), file = `${DATA}/briefs/${day}.md`
    if (a.includes("--dry")) { const b = buildBrief(db, gather(db, loadProjects(), readUsage())); if (!tickRuns(db)) b.building = []; console.log(briefMarkdown(b)) } // nothing builds the queue without a tick: not "Building today"
    else if (existsSync(file)) console.log(readFileSync(file, "utf8").trimEnd())
    else { console.error(`No summary was sent for ${day}.`); process.exitCode = 1 }
    break
  }
  case "review": {
    // by hand: an already-reviewed head is reported (--force: a fresh pass; --full: the whole PR); under Actions: respect the claim, so a ship or scan on the same head is not reviewed twice
    const r = process.env.GITHUB_ACTIONS ? await reviewOnce(db, a[0], Number(a[1]), { actions: true, strict: automergeStrict(db, a[0], Number(a[1])) }) : await manualReview(db, a[0], Number(a[1]), { force: a.includes("--force") || a.includes("--full"), full: a.includes("--full") })
    console.log(`${r.log.join("\n")}\n${r.state}: ${r.why}${r.url ? `\n${r.url}` : ""}`)
    if (process.env.GITHUB_ACTIONS && r.state !== "success") process.exitCode = 1 // under Actions the job's exit code is the verdict (error and busy are not a pass)
    break
  }
  case "review-scan": {
    const out = await scan(db, { dry: a.includes("--dry"), budget: () => { const u = readUsage(db); return reviewBudget(allowed(u), u, config().reviewCap) } })
    console.log(out.join("\n") || "nothing new to review")
    break
  }
  case "health":
    await import("./health.ts")
    break
  case "graphify": // daily 05:30 (before the PMs at 06:00): refresh every repo's code graph, no LLM; agents run `graphify update .` on demand
    for (const p of Object.values(loadProjects())) console.log(`${p.name}: ${spawnSync("graphify", ["update", p.repo], { encoding: "utf8" }).status === 0 ? "updated" : "FAILED"}`)
    break
  case "stats": { // dobby stats [on|off [crashes|usage] | show | log | reset-id | report [--days N]]: opt-in crash reports and usage stats (docs/manual/stats.md)
    const s = await import("./stats.ts")
    const set = (key: string, value: boolean) => void configSetText({ key, value })
    if (a[0] === "on" || a[0] === "off") console.log(s.setStats(a[0] === "on", a[1], set))
    else if (a[0] === "show") console.log(await s.showText(db))
    else if (a[0] === "log") console.log(s.sentLog())
    else if (a[0] === "reset-id") console.log(`New install id: ${s.resetId()}`)
    else if (a[0] === "report") console.log((await runAction(db, "stats-report", { days: Number(a[a.indexOf("--days") + 1]) || 30 })).text)
    else console.log(s.statusText())
    break
  }
  case "timelapse": { // dobby timelapse [YYYY-MM-DD] [--show <project>]... [--out <base>] [--yes] [--dry] | verify <clip> <manifest> [--sig file] (docs/manual/timelapse.md)
    const T = await import("./timelapse.ts")
    const miss = T.ffmpegMissing()
    if (miss) { console.error(miss); process.exit(1) }
    if (a[0] === "verify") {
      if (!a[1] || !a[2]) { console.error("usage: dobby timelapse verify <clip.mp4> <manifest.json> [--sig <file>]"); process.exit(1) }
      const v = await T.verify(a[1], a[2], a.includes("--sig") ? a[a.indexOf("--sig") + 1] : undefined)
      console.log(`${v.ok ? "OK" : "FAILED"}: ${v.detail}${v.key ? ` Signed by key ${v.key}; a signature proves the files are unedited, not that the log was honest.` : ""}`)
      process.exit(v.ok ? 0 : 1)
    }
    const flagVals = (f: string) => a.flatMap((x, i) => (x === f && a[i + 1] ? [a[i + 1]] : []))
    const day = a.find((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)) ?? new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
    const { repoOfUrl } = await import("./privacy.ts")
    const { spawnSync } = await import("node:child_process")
    const slugOf = (p: string) => { const r = loadProjects()[p]?.repo; return r ? repoOfUrl(spawnSync("git", ["remote", "get-url", "origin"], { cwd: home(r), encoding: "utf8" }).stdout ?? "") : "" }
    let m
    try { m = T.buildManifest(db, { day, show: flagVals("--show"), slugOf }) } catch (e) { console.error((e as Error).message); process.exit(1) }
    const blocked = T.privacyGate(m)
    if (blocked) { console.error(blocked); process.exit(1) }
    console.log(T.previewText(m))
    if (a.includes("--dry")) break
    let yes = a.includes("--yes")
    if (!yes && process.stdin.isTTY) {
      const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout })
      yes = /^y/i.test(await rl.question("\nWrite the clip, manifest and signature? [y/N] "))
      rl.close()
    }
    if (!yes) { console.error("Nothing written. Run again with --yes to write the files."); process.exit(1) }
    const r = await T.exportClip(m, flagVals("--out")[0] ?? `${process.cwd()}/dobby-timelapse-${day}`, `${configDir()}/timelapse-key.pem`)
    console.log(`\nWrote ${r.clip}, ${r.manifest} and ${r.sig} (signing key ${r.key}). Nothing was uploaded.`)
    break
  }
  case "tools": { // dobby tools [on|off <name>]: agent tooling (graphify, rtk, caveman, ponytail, jev)
    const t = await import("./tools.ts")
    console.log(a[0] === "on" || a[0] === "off" ? t.setTool(a[1] ?? "", a[0] === "on") : t.toolsTable())
    break
  }
  case "config":
    if (a[0] === "set" || a[0] === "unset") log((await runAction(db, "config-set", { key: a[1], value: a.slice(2).join(" ") || undefined, unset: a[0] === "unset" })).text)
    else console.log((await import("./migrate.ts")).configCmd(a[0]))
    break
  case "role": { // dobby role show <name> | save <name> [text] | reset <name>: your edited copy in <config dir>/roles/
    const { resetRole, roleText, saveRole } = await import("./dashboard-team.ts")
    if (a[0] === "show") console.log(roleText(a[1] ?? ""))
    else if (a[0] === "reset") console.log(resetRole(a[1] ?? ""))
    else if (a[0] === "save") { noteUse(db, "role_override"); console.log(saveRole(a[1] ?? "", a.length > 2 ? a.slice(2).join(" ") : readFileSync(0, "utf8"))) }
    else throw new Error("usage: dobby role show <name> | dobby role save <name> [text] | dobby role reset <name>")
    break
  }
  case "goals": { // dobby goals [app]: each app's goals in rank order; dobby goals import <app>: turn the file's goals into milestones
    const { goals: active } = await import("./lib.ts")
    if (a[0] === "import") {
      const p = loadProjects()[a[1]]
      if (!p) throw new Error("usage: dobby goals import <app>")
      const { repoOf } = await import("./board.ts"), { run: gh } = await import("./graphs/review.ts")
      const repo = repoOf(p.repo, gh)
      if (!repo) throw new Error(`${p.name} has no GitHub repo`)
      syncGoals(db, p.name, p.rules)
      const lines = (await import("./milestones.ts")).importGoals(db, p.name, repo, gh)
      for (const l of lines) console.log(l)
      if (lines.some((l) => l.startsWith("✗"))) { console.error(`Goals import did not finish. Fix the error above, then run dobby goals import ${p.name} again (goals already imported are skipped).`); process.exitCode = 1; break }
      if (!lines.length) { console.log(`Nothing to import: ${p.name} has no goals in its project file (a "## Goals" list) that are not milestones yet.`); break }
      console.log(`Goals now live at https://github.com/${repo}/milestones (soonest due date first). Remove the "## Goals" list from the project file once Dobby has read them (within 10 minutes).`)
      break
    }
    for (const p of Object.values(loadProjects()).filter((x) => !a[0] || x.name === a[0])) {
      console.log(`${p.name}${milestonesOf(db, p.name).length ? " (GitHub milestones)" : " (project file)"}`)
      for (const g of active(db, p.name)) console.log(`  ${g.rank}. ${g.title.slice(0, 120)}${g.milestone ? ` [milestone ${g.milestone}]` : ""}`)
    }
    break
  }
  case "jobs": { // dobby jobs install|uninstall|status [--dry]: the six background jobs (launchd on macOS, systemd --user on Linux)
    const { installJobs, uninstallJobs, loadedProbe, jobState, JOBS, ownedHere, NOT_HERE } = await import("./jobs.ts")
    const o = { bin: `${ROOT}bin/dobby`, home: homedir(), uid: process.getuid?.() ?? 0, dry: a.includes("--dry") }
    if (process.platform !== "darwin" && process.platform !== "linux") throw new Error(`background jobs are not available on ${process.platform}: run \`dobby start\` in a terminal`)
    if (a[0] === "install") for (const r of installJobs({ ...o, discord: !!discordOn(), startPid: (await import("./install.ts")).startPid(db) })) { console.log(`${r.ok ? "✓" : "✗"} ${r.name}: ${r.detail}`); if (!r.ok) process.exitCode = 1 }
    else if (a[0] === "uninstall") console.log(uninstallJobs(o).join("\n") || "no Dobby jobs were installed")
    else if (a[0] === "status") for (const j of JOBS) {
      if (!ownedHere(j, process.platform, o.home)) { console.log(`✗ ${j.name}: ${NOT_HERE}`); continue } // same label may be another install's: not probed
      const [c, args] = loadedProbe(j, process.platform, o.uid), r = spawnSync(c, args, { encoding: "utf8" }), st = jobState(process.platform, { ok: r.status === 0, out: `${r.stdout}${r.stderr}` })
      console.log(`${st.loaded && !st.failing ? "✓" : "✗"} ${j.name}: ${st.failing ? `loaded, last run failed (${st.failing})` : j.what}`)
    }
    else console.log("usage: dobby jobs install | uninstall | status [--dry]")
    break
  }
  case "uninstall": { // dobby uninstall: stop and remove the background jobs; data, config and secrets stay
    const { uninstallJobs, uninstallService } = await import("./jobs.ts")
    const o = { bin: `${ROOT}bin/dobby`, home: homedir(), uid: process.getuid?.() ?? 0, dry: a.includes("--dry") }
    console.log([...uninstallJobs(o), ...uninstallService(o)].join("\n") || "no Dobby jobs were installed")
    console.log(`Kept: ${configDir()} (config, secrets, project drafts) and ${DATA} (database, logs). Delete them by hand to remove everything.`)
    break
  }
  case "doctor": { // dobby doctor: the basics (tools, sign-ins, config, jobs, add-ons), then one line per pipeline check; exit 1 if a required one fails
    const { basics, formatChecks } = await import("./checks.ts")
    const base = await basics({ jobs: true, apiKeyMode: apiKeyMode() })
    const asJson = a.includes("--json") // dobby doctor --json: every row as data, for scripts and the dobby-setup skill
    if (!asJson) console.log(formatChecks(base))
    if (base.some((r) => r.required && !r.ok)) process.exitCode = 1
    const origins = Object.values(loadProjects()).map((p) => ({ project: p.name, base: p.base, ok: spawnSync("git", ["-C", p.repo, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${p.base}`]).status === 0 }))
    const auth = await claude(db, { project: "dobby", kind: "doctor", model: "haiku", prompt: "Reply with the word ok.", args: [], cwd: (await import("node:os")).tmpdir(), stallMs: 60_000 }, undefined, async () => {}) // no owner ping: you are looking at it
    const scanLast = (db.prepare("SELECT v FROM kv WHERE k='review:scan:last'").get() as { v: string } | undefined)?.v
    const lk = lockHeld(db)
    const rows = doctor({ stray: strayDrafts(), tickets: db.prepare("SELECT id, status, updated_at FROM tickets WHERE status='running'").all() as never, pauses: pauseList(db), origins, auth, scan: scanLast ? JSON.parse(scanLast) : undefined })
    if (lk) rows.push({ name: "tick lock", ok: !lk.stale, detail: `held by process ${lk.pid || "unknown"} for ${Math.round(lk.age / 60_000)} min. ${lk.stale ? `Stale (${lk.stale}): the next tick or run/retry clears it.` : `A tick is running; it frees the lock when it ends, or after ${LOCK_MS / 60_000} min without a heartbeat.`}` })
    // the pipeline checks the hourly health job posts, read only here
    const { pipelineChecks } = await import("./health.ts")
    const oldReady = (db.prepare("SELECT COUNT(*) n, MIN(updated_at) at FROM tickets WHERE status='ready' AND dup_of IS NULL AND updated_at < ?").get(new Date(Date.now() - 86_400_000).toISOString()) as { n: number; at: string | null })
    const calm: Record<string, string> = { stuck: `no ticket building or at approval over 24 hours${oldReady.n ? `; ${oldReady.n} ready ticket(s) have waited over 24 hours (oldest ${age(oldReady.at!)})` : ""}`, reviews: "no reviews skipped", cap: "nothing held by the budget cap" }
    for (const h of pipelineChecks(db, { persist: false }).filter((x) => ["stuck", "reviews", "cap"].includes(x.check))) rows.push({ name: h.check, ok: h.ok, detail: !origins.length && h.ok ? "no projects yet" : h.ok ? calm[h.check] : h.text })
    if (asJson) console.log(JSON.stringify({ checks: base.map(({ name, ok, detail, fix, required }) => ({ name, ok, detail, fix: fix ?? null, required })), pipeline: rows.map(({ name, ok, detail, fix }) => ({ name, ok, detail, fix: fix ?? null })) }, null, 2))
    else for (const r of rows) console.log(`${r.ok ? "✓" : "✗"} ${r.name}: ${r.detail}${!r.ok && r.fix ? `\n    fix: ${r.fix}` : ""}`)
    if (rows.some((r) => !r.ok)) process.exitCode = 1
    break
  }
  case "migrate":
    console.log((await import("./migrate.ts")).migrate({ dryRun: a.includes("--dry-run") || a.includes("--dry") }))
    break
  case "providers": {
    const { providersCmd, runner } = await import("./providers/wire.ts")
    const { readSecrets } = await import("./notify.ts")
    console.log(await providersCmd(db, a, { env: { ...readSecrets(), ...process.env }, run: runner(), fetch, cfg: config().providers }))
    break
  }
}
} catch (e) {
  if (!(e instanceof UserError)) await reportCrash(e, cmd, db)
  // expected refusals and real bugs alike: one line, exit 1. The stack only with DOBBY_DEBUG=1.
  const err = e as Error
  console.error(process.env.DOBBY_DEBUG === "1" && err?.stack ? err.stack : err?.message ?? String(e))
  process.exit(1)
}

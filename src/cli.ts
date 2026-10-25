// dobby <command>
//   add <project> "<title>" ["<done when>"] [S|M|L] [priority]
//   goals [app] | goals import <app>   the goals in rank order; import turns the project file's goals into GitHub milestones
//   add discord|dashboard|jobs   switch on an add-on over a terminal-only start: Discord buttons, the local dashboard job, or all six background jobs
//   list [--all]              open tickets by stage (Building, Ready, Waiting, Failed), 10 per stage; --all = every ticket, old format
//   status                    what is building, shipped today and stuck (the same text as the status board in #daily-update)
//   tick                      one scheduler step: run the top ticket if the budget allows (launchd calls this)
//   show <id>                 every step the ticket's graph took, with tokens and cost
//   approve <id> | decline <id>   answer a ticket waiting at the gate
//   pause | resume            stop / allow builders claiming new tickets (running ones finish their step, nothing is killed)
//   pause [all|builders|reviews|merges|deploys|planning|scout|notify|project <name>|ticket <id>] [for 30m|2h|1d]   one pause system with levels; resume takes the same target; all also kills the running builds; "for" auto-resumes
//   pause status              what is paused, since when, until when
//   queue <id>                move a backlog ticket to ready (a re-queue by hand counts as an owner touch)
//   run <id>                  build this ticket now, in this process (no worker cap, budget gate or tick lock)
//   graph                     the ticket graph as a Mermaid diagram
//   idea <project> "<idea>"   drop a seed idea for the Product Manager
//   ideas [project]           idea cards, best first
//   pm <project> [--area]     Product Manager now: ranked problems by goal, PRDs for L, idea cards (--area: today's Area PM)
//   dedupe <project>          merge tickets and ideas that are the same work (Haiku); run after onboard
//   tools [on|off <name>]     agent tools (graphify, rtk, caveman, ponytail, jev): on/off, found or not, install command; on/off edits your config
//   company                   distil the founder's global Claude memory into company.md (work rules only)
//   init <project>            join a project: draft its dobby.md, then onboard it (also runs by itself before a project's first ticket)
//   onboard <project>         read all the project's docs and skills into Dobby (rules draft, backlog tickets, ideas, knowledge map)
//   lead [project] [--dry]    the Lead plans: promotes up to 3 backlog tickets, writes up to 3 new ones (all active projects if none given)
//   cos [--dry]               the Chief of Staff's morning brief (Discord #daily-update), plus Approve/Decline for waiting tickets
//   ask <message>             talk to the front desk from the terminal ("status" answers at once, no AI)
//   listen                    always-on Discord listener (launchd job com.dobby.telegram); also runs the telemetry receiver
//   telemetry-serve [port]    only the Claude Code telemetry receiver (127.0.0.1, default 4711 or DOBBY_OTEL_PORT), for testing
//   start                     run the listener and the queue loop in this terminal (Ctrl-C stops it); needs the private config `migrate` writes
//   service install|uninstall [--dry]   run `start` as a background service (launchd on macOS, systemd --user on Linux); refuses while the owner's com.dobby.tick/telegram jobs exist
//   discord invite|setup|test the bot invite link; create channels + webhooks (idempotent); one hello per channel
//   review <owner/repo> <pr> [--full]  the Reviewer on one PR by hand (a draft too): PR comment + "Claude Review" status; --full = the whole PR
//   review-scan [--dry]       review new heads of open PRs on the repos that matter (the listener runs this every 15 min)
//   usage [days]              Claude usage report: API-$ by model, cache hit, $ per 1% of each limit
//   usage-log                 usage reading stored every 10 min by the listener: 5h %, weekly %, API-$ by model and token kind
//   capacity                  how full the 5-hour windows got this week, and what to change
//   touch <ticket|-> <decision|broke|unclear|permission> [note]   log a fix you made by hand (owner touches, see the autonomy line)
//   api [on|off|status]       Max plan API credits for text-only jobs
//   health                    the hourly self-check
//   graphify                  refresh every project's code graph (daily 05:30)
//   scout                     Talent Scout now (normally once a night)
//   safety explain "<ticket text>"|<pr>  categories, rule, action and why from the safety config (src/safety.ts)
//   policy explain "<text or path>"   which owner rules (src/policy.ts) match, per kind, and which one wins
//   dashboard [--port 4710] [--host 127.0.0.1]   local web dashboard (auto-refresh); makes DASHBOARD_TOKEN in secrets.env on first start
//   config [show|path]        the merged config (secrets redacted) / where the private config file lives
//   doctor                    pipeline health: stuck runs, origin/<base>, Claude sign-in, old pauses (exit 1 on any failure)
//   migrate [--dry-run]       write the private config from today's setup (never overwrites)
//   providers [detect|models|explain]   read-only: agent CLIs, API key env var NAMES and local servers found; live model lists; planned routing per role
//   dashboard open [--port 4710]   open the running dashboard in your browser, signed in (token goes in an HttpOnly cookie; you never see or paste it)
import { capacityFromDb, DATA, noteWindow, open } from "./db.ts"
import { syncBoard } from "./board.ts"
import { doctor, fixed, agentFiledKey, prDone, addTicket, dropIdea, label, undoIdea, syncGoals, milestonesOf, apiKeyMode, spendAllows, budgetAllows, reviewBudget, claude, company, getTicket, setTicket, home, ideaToTicket, isDuplicate, loadProjects, loadRole, memoryDir, nextTicket, orphanedParents, parseGroups, queueTicket, readUsage, fallbackAllows, fallbackStarted, ROOT, runAsync, semaphore, stampLogs, sweepOrphanProcesses, sweepRebaseWorktrees, timeoutMs, doTimeoutMs, claimKey, windowIdle } from "./lib.ts"
import { actionArgs, discardProposal, FRONT_DESK_ARGS, parseProposal, preview, runForeman, sendProposal, storeProposal, typedNeedsTap, type Proposal } from "./frontdesk.ts"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawn, spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { delimiter, dirname } from "node:path"
import { plan as servicePlan, requireConfig, service, startConflicts } from "./service.ts"
import { triage } from "./jev.ts"
import { explain as explainPolicy } from "./policy.ts"
import { paused, pauseList, parsePause, setPause } from "./pause.ts"
import { Command, compileTicketGraph, thread } from "./graphs/ticket.ts"
import { runLead, runLeads } from "./graphs/lead.ts"
import { areaDue, pmDue, runProduct } from "./graphs/product.ts"
import { runPrograms } from "./graphs/program.ts"
import { autonomyLine, processAllowed, tagFor, TAGS, touch, weekPerFive } from "./usage.ts"
import { runCos } from "./graphs/cos.ts"
import { stuckScan, stuckTap } from "./stuck.ts"
import { acceptReview, automergeStrict, fixReview, manualReview, reviewOnce, scan } from "./graphs/review.ts"
import type { DB } from "./db.ts"
import { discordOn, type Event } from "./discord.ts"
import { asIs, clip, digest, notify, parseReply } from "./telegram.ts"
import { installSkill, mergeScout, rejectScout, scout, scoutCard, scoutDue, scoutSays, undoScout } from "./scout.ts"
import { startTelemetry } from "./telemetry.ts"
import { config, configDir, projectsDir, zoned } from "./config.ts"
import { helpText, isStatusAsk, listView, statusText, updateBoard } from "./view.ts"

// the dashboard opens its own read-only handle; every other command gets the read-write one
const db = process.argv[2] === "dashboard" ? (undefined as unknown as DB) : open()
const [cmd, ...a] = process.argv.slice(2)
// A process killed mid-rebase (timeout, restart) leaves ${DATA}/wt/*-rebase behind: every Dobby process clears the stale ones first.
if (cmd !== "dashboard") for (const n of sweepRebaseWorktrees(`${DATA}/wt`)) console.log(`removed a stale rebase worktree: ${n}`)
// Dev servers a builder started outlive its deleted worktree (wrangler's workerd): stop them.
if (cmd === "tick") { const p = sweepOrphanProcesses(`${DATA}/wt`); if (p.length) console.log(`stopped ${p.length} process(es) left from deleted worktrees`) }
const LOCK_MS = 90 * 60_000

async function eveningDigest() {
  const day = new Date().toLocaleDateString("sv")
  if (new Date().getHours() < 19 || db.prepare("SELECT 1 FROM kv WHERE k=?").get(`digest:${day}`)) return
  // fix pushes onto open PRs (onto set) are rework: counted apart, not shipped tickets (audit #12)
  const rows = db.prepare("SELECT id, project, title, note FROM tickets WHERE status='shipped' AND onto IS NULL AND date(updated_at, 'localtime') = ? ORDER BY updated_at").all(day) as { id: number; project: string; title: string; note: string | null }[]
  const fixes = (db.prepare("SELECT COUNT(*) n FROM tickets WHERE status='shipped' AND onto IS NOT NULL AND date(updated_at, 'localtime') = ?").get(day) as { n: number }).n
  const kvGet = (k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
  await notify(digest(rows, (id) => kvGet(`plain:${id}`), fixes), fetch, undefined, { kind: "brief" })
  db.prepare("INSERT OR REPLACE INTO kv VALUES (?, '1')").run(`digest:${day}`)
}

// "Keep building" (button on the pause ping): the daytime 5-hour cap rises to the night cap until that window resets.
const capOverride = () => {
  const o = JSON.parse((db.prepare("SELECT v FROM kv WHERE k='budget:override'").get() as { v: string } | undefined)?.v ?? "null") as { until: number; cap: number } | null
  return o && o.until > Date.now() ? o.cap : undefined
}
const allowed = (u: ReturnType<typeof readUsage>) => (apiKeyMode() ? spendAllows(db) : u ? budgetAllows(u, new Date().getHours(), capOverride(), weekPerFive(db)) : fallbackAllows(db))

/** Once per 5-hour window: tell the owner the builders paused for budget, with a button to keep going. */
async function pausePing(u: ReturnType<typeof readUsage>, why: string) {
  const resetAt = u?.fiveMsToReset ? Date.now() + u.fiveMsToReset : 0
  const key = `budget:paused:${Math.round(resetAt / 600_000)}` // one ping per window
  if (u) noteWindow(db, u.fiveUsed, u.fiveMsToReset, { paused: true })
  if (db.prepare("SELECT 1 FROM kv WHERE k=?").get(key)) return
  db.prepare("INSERT OR REPLACE INTO kv VALUES (?, '1')").run(key)
  const ready = (db.prepare("SELECT count(*) n FROM tickets WHERE status='ready' AND dup_of IS NULL").get() as { n: number }).n
  const at = resetAt ? new Date(resetAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "the next reset"
  const weekly = /weekly/.test(why)
  const caps = [70, 80, 90, 100].filter((c) => c > Math.ceil(u?.fiveUsed ?? 0))
  await notify(`⏸ Builders paused · ${why}\n${ready} ticket(s) waiting. They restart on their own ${weekly ? "when the weekly pace allows" : `after the window resets at ${at}`}.${weekly || !caps.length ? "" : "\n\nOr keep building up to a higher share of this 5-hour window (until it resets; your own sessions get less room):"}`, fetch, weekly ? undefined : caps.map((c) => ({ text: `▶️ ${c}%`, data: `keepgoing ${c}` })), { kind: weekly ? "health" : "approval" }) // no button = nothing to decide: not #needs-you
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
  const lock = db.prepare("SELECT v FROM kv WHERE k='lock'").get() as { v: string } | undefined
  if (lock && Date.now() - Number(lock.v) < LOCK_MS) return console.log("busy: another tick is running")
  const u = readUsage(db)
  if (u) noteWindow(db, u.fiveUsed, u.fiveMsToReset)
  const gate = allowed(u)
  const waiting = (db.prepare("SELECT count(*) n FROM tickets WHERE status='ready'").get() as { n: number }).n
  // since when ready work has been held by the budget (the pipeline health check warns after 3 hours)
  if (gate.ok || !waiting) db.prepare("DELETE FROM kv WHERE k='cap:blocked-since'").run()
  else db.prepare("INSERT OR IGNORE INTO kv VALUES ('cap:blocked-since', ?)").run(String(Date.now()))
  if (!gate.ok) {
    if (u && waiting) await pausePing(u, gate.why)
    return console.log(`skip: ${gate.why}`)
  }
  db.prepare("INSERT OR REPLACE INTO kv VALUES ('lock', ?)").run(String(Date.now()))
  // Heartbeat: the lock stays fresh while this process lives; if it dies, the lock goes stale in LOCK_MS and the next tick takes over.
  const beat = setInterval(() => db.prepare("INSERT OR REPLACE INTO kv VALUES ('lock', ?)").run(String(Date.now())), 5 * 60_000)
  try {
    // We hold the lock, so a ticket still marked running was cut off (crash, reinstall, reboot): put it back.
    // Its LangGraph checkpoint makes it resume where it stopped, not start over.
    const cut = db.prepare("SELECT project, title FROM tickets WHERE status='running'").all() as { project: string; title: string }[]
    const orphans = db.prepare("UPDATE tickets SET status='ready' WHERE status='running'").run().changes
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
    const day = new Date().getHours() >= 8 && new Date().getHours() < 23
    const workers = Math.min(day ? 4 : 6, Math.max(idle && day ? 3 : 1, (db.prepare("SELECT count(*) n FROM tickets WHERE status='ready'").get() as { n: number }).n))
    const seen = new Set<number>()
    const worker = async (w: number) => {
      for (let i = 0; ; i++) {
        const u2 = readUsage(db)
        const g2 = allowed(u2)
        if (!g2.ok) {
          if (u2) await pausePing(u2, g2.why)
          return console.log(`[w${w}] stops: ${g2.why}`)
        }
        const bp = paused(db, { kind: "builders" })
        if (bp) return console.log(`[w${w}] stops: builders ${bp} (resume from the dashboard or \`dobby resume\`)`)
        const t = nextTicket(db)
        if (!t) return console.log(`[w${w}] done after ${i} ticket(s): nothing ready`)
        if (seen.has(t.id)) return console.log(`[w${w}] #${t.id} came back ready in this run; stopping so it cannot loop`)
        seen.add(t.id)
        if (u2) noteWindow(db, u2.fiveUsed, u2.fiveMsToReset, { build: true })
        else if (!apiKeyMode()) fallbackStarted(db)
        if ((await buildTicket(t, `w${w}`, g2.why)) === "stop") return
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
    const out = await app.invoke(snap.next.length && !snap.next.includes("gate") ? null : { ticketId: t.id }, cfg)
    console.log(`[${w}] ` + (out.log as string[]).join(`\n[${w}] `))
    try { syncBoard(db, { only: t.id }) } catch {}
  } catch (e) {
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

async function answer(id: number, decision: "approve" | "decline") {
  const app = compileTicketGraph(db)
  const snap = await app.getState(thread(id))
  if (!snap.next.includes("gate")) return log(`${label(db, id)} is not waiting for you`)
  // One resume per gate: a typed approve and a tap (two child processes) must not both ship it. Released if it is still at the gate after.
  const key = `resume:${id}:gate`
  if (!claimKey(db, key)) return log(`${label(db, id)} is already being answered`)
  try {
    const out = await app.invoke(new Command({ resume: decision }), thread(id))
    return log(`${label(db, id)}: ${out.outcome}`)
  } finally {
    if ((await app.getState(thread(id))).next.includes("gate")) db.prepare("DELETE FROM kv WHERE k=?").run(key)
  }
}
const log = (m: string) => (console.log(m), m)

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
  return `${action ? `Action ${id} (dobby ${proposal.body}) is waiting for your Do it` : `Draft ${id} is waiting for your Send`} in ${discordOn() ? "#needs-you" : "the message above"}.`
}

async function frontDesk(text: string, replyTo: string) {
  if (isStatusAsk(text)) return statusText(db) // no AI, instant
  // The owner typed an action word for word ("queue 12", "pause everything"): their own words, so it runs as before, no AI,
  // except deploys, migrations and review overrides, which get a Do it card even when typed (owner, 20 Oct). run/company go to
  // the background so the listener never waits on them. Anything the front desk itself wants to do is a proposal (below).
  const typed = text.trim().replace(/\s+/g, " ")
  const own = actionArgs(typed)
  if (own && typedNeedsTap(typed)) return `${await propose({ kind: "command", to: [], subject: "", body: typed })}`
  if (own?.background) return runForeman(own.args, true).out + `: dobby ${typed}`
  if (own) return inChild(own.args)
  const role = loadRole("front-desk")
  const { recent } = await import("./telegram.ts")
  const past = recent((db.prepare("SELECT v FROM kv WHERE k='tg:history'").get() as { v: string } | undefined)?.v)
  const convo = past.length ? `\n\nEARLIER IN THIS CONVERSATION (oldest first):\n${past.map((m) => `${m.who}: ${m.text.slice(0, 600)}`).join("\n")}` : ""
  const r = await claude(db, {
    project: "dobby", kind: "front-desk", model: role.meta.model ?? "haiku", effort: role.meta.effort, cwd: ROOT,
    // usage is always on hand (owner, 17 Oct: "nothing should be a command"); kept fresh by the 2-minute sampler
    prompt: `${role.body}${convo}\n\nCLAUDE USAGE NOW (answer usage, cost, token and limit questions from this; API-$ = what it would cost on the API, not money spent):\n${await usageNow()}\n\nMESSAGE: ${text}${replyTo ? `\n(It replies to this Dobby message: ${replyTo.slice(0, 1500)})` : ""}`,
    args: FRONT_DESK_ARGS,
  })
  const { reply, proposal } = parseProposal(r.ok ? r.text : "")
  let answer = (r.ok ? reply : `Couldn't handle that (${r.reason}). Try again, or ask at the Mac.`).slice(0, 3500)
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
  if (pc) {
    if ("error" in pc) return pc.error
    if ("status" in pc) return pauseList(db).map((x) => `• ${x.text}`).join("\n") || "Nothing is paused."
    const sc = pc.scope
    if ("project" in sc && !loadProjects()[sc.project]) return `No project called ${sc.project}.`
    if ("ticket" in sc && !getTicket(db, sc.ticket)) return `No ticket #${sc.ticket}.`
    const r = setPause(db, sc, pc.on, process.env.DOBBY_BY ?? "the owner", { until: pc.until })
    if (r.line && !("kind" in sc && sc.kind === "notify")) await notify(r.line, fetch, undefined, { kind: "health" })
    if ("all" in sc && pc.on) {
      const launchd = Number(spawnSync("launchctl", ["print", `gui/${process.getuid?.()}/com.dobby.tick`], { encoding: "utf8" }).stdout?.match(/\bpid = (\d+)/)?.[1]) // no launchctl (Linux): NaN, skipped
      const started = Number((db.prepare("SELECT v FROM kv WHERE k='tick:pid'").get() as { v: string } | undefined)?.v) // the tick child of `dobby start` and the service
      const running = (db.prepare("SELECT count(*) n FROM tickets WHERE status='running'").get() as { n: number }).n
      for (const pid of [launchd, started]) try { if (pid) process.kill(-pid, "SIGTERM") } catch {} // each leads its own process group: this stops their claude runs too
      db.prepare("DELETE FROM kv WHERE k='lock'").run()
      return `⏸ Paused everything${pc.until ? " for the time you said" : ""}.${running ? ` Stopped ${running} build(s); they pick up where they left off.` : ""} Say "resume everything" to start again.`
    }
    if ("all" in sc && !pc.on) return r.changed ? "▶️ Resumed. Builders start again within a minute." : r.reply
    if (!pc.on) for (const l of await (await import("./deploy.ts")).runQueuedDeploys(db)) r.reply += `\n${l}` // a resume releases the deploys it was holding
    return r.reply
  }
  const rv = text.trim().match(/^(reviewfix|reviewaccept)\s+([\w.-]+\/[\w.-]+)\s+(\d+)$/i)
  if (rv) return rv[1].toLowerCase() === "reviewfix" ? fixReview(db, rv[2], Number(rv[3])) : acceptReview(db, rv[2], Number(rv[3]))
  // "deploynow <project> [migrate <sha>]": the 🚀 / 🔁 buttons on deploy pings (migrate = owner OK'd the data migrations shown for <sha>)
  const dn = text.trim().match(/^deploynow\s+([\w-]+)(\s+migrate(?:\s+([0-9a-f]{7,40}))?)?$/i)
  if (dn) return (await import("./deploy.ts")).deployProject(db, dn[1], { tapped: true, migrate: Boolean(dn[2]), at: dn[3] })
  const sk = text.trim().match(/^stuck(retry|decline)\s+(\d+)$/i) // the buttons on a "stuck in fixing" card
  if (sk) return stuckTap(db, sk[1].toLowerCase() as "retry" | "decline", Number(sk[2]))
  const r = parseReply(text, replyTo)
  if (r) return answer(r.id, r.decision)
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
async function inChild(args: string[], ms = args[0] === "do" ? doTimeoutMs(args.slice(1).join(" ")) : USAGE_MS): Promise<string> {
  const go = async () => {
    const r = await runAsync(`${ROOT}bin/dobby`, args, { all: true, timeoutMs: ms })
    return r.out.trim().split("\n").filter(Boolean).slice(-6).join("\n") || `${args[0]}: done`
  }
  return args[0] === "do" ? buttonSlots(`dobby ${args.slice(0, 2).join(" ")}`, go) : go()
}
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
  console.log("listening on Discord")
  setInterval(reviewScan, 15 * 60_000) // backup only: GitHub Actions on the Mac runner triggers reviews instantly
  // usage sampler: limits + new session-file lines every 2 min, in a child so big files never block Discord heartbeats
  setInterval(() => void once("sampling", ["usage-sample"]), 2 * 60_000)
  setInterval(() => void once("logging", ["usage-log"]), 10 * 60_000)
  void startTelemetry(db) // Claude Code OpenTelemetry receiver (127.0.0.1); a busy port is logged, never fatal
  await discordListen(ddb)
}

/** Always-on Discord listener: buttons, #assistant messages, 👍/👎 on #ideas. Only the server owner is obeyed (filtered in ownerEvent). */
async function discordListen(ddb: DB) {
  const { answerTap, kv, listen, post } = await import("./discord.ts")
  await listen(ddb, async (o) => {
    if (o.kind === "button") {
      // (already acknowledged on arrival in listen(), so a busy queue never makes Discord say "did not respond")
      const out = await inChild(["do", o.data]) // heavy work (merge, fix, review) off the listener's event loop
      // The result goes into the message that was tapped (no echo posts in #needs-you); a new post only if that edit fails.
      if (!(await answerTap(o, out))) await post(ddb, { kind: /^(send|discard)/.test(o.data) ? "proposal" : "approval" }, out)
    } else if (o.kind === "brain") {
      const { brainSay, kv: dkv } = await import("./discord.ts")
      const idea = Number(dkv(ddb, `discord:brain:${o.thread}`))
      if (/^(go|build( it)?)$/i.test(o.text)) await brainSay(o.thread, ideaToTicket(db, idea))
      else if (/^drop( it)?$/i.test(o.text)) await brainSay(o.thread, (await act(`dropidea ${idea}`)) ?? "dropped", [{ text: "↩️ Undo", data: `undoidea ${idea}` }])
      else await brainSay(o.thread, await brainstorm(idea, o.text))
    } else if (o.kind === "ask") await post(ddb, { kind: "ask" }, await frontDesk(o.text, ""))
    else {
      const idea = Number(kv(ddb, `discord:idea:${o.messageId}`))
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
        const { openBrainThread, brainSay } = await import("./discord.ts")
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

async function init(project: string) {
  const { existsSync, writeFileSync } = await import("node:fs")
  const { home, ROOT } = await import("./lib.ts")
  const root = config().paths.projects
  const repo = home(`${root}/${project}`)
  if (!existsSync(repo)) throw new Error(`no repo at ${repo}`)
  const dir = notesDir(ROOT)
  const draft = `${dir}/${project}.md`
  const fresh = !loadProjects()[project]
  if (fresh) writeFileSync(draft, `---\nrepo: ${root}/${project}\npriority: 5\nbase: main\ninstall: true\nverify: true\n---\n## Goal\n(onboarding)\n`)
  // code map first (AST only, free): the Onboarder and later Builders query it instead of crawling
  const { sh } = await import("./lib.ts")
  console.log(sh("[ -d graphify-out ] && graphify update . >/dev/null && echo 'graphify: graph refreshed' || echo 'graphify: no graph yet, run /graphify in this repo once'", repo).out.trim())
  const rules = await onboard(project)
  if (fresh && rules) {
    const q = (v?: string) => (v ?? "true").replace(/\n/g, " ")
    writeFileSync(draft, `---\nrepo: ${root}/${project}\npriority: 5\nbase: main\ninstall: ${q(rules.install)}\nverify: ${q(rules.verify)}\n---\n## Goal (from the docs, you confirm)\n${rules.goal}\nDeadline: ${rules.deadline}\n\n## Scope now\n${rules.scope}\n\n## Agents may do on their own\n${rules.may_do}\n\n## Always ask me\n${rules.always_ask}\n\n## Specialists\n${rules.specialists}\n`)
    console.log(`drafted projects/${project}.md from its docs; confirm the goal and rules before tickets run`)
  }
}

async function onboard(project: string) {
  const p = loadProjects()[project]
  if (!p) throw new Error(`no dobby.md for ${project}`)
  const role = loadRole("onboarder")
  const r = await claude(db, {
    project, kind: "onboard", model: role.meta.model ?? "sonnet", effort: role.meta.effort, cwd: p.repo,
    args: ["--setting-sources", "project", ...(existsSync(memoryDir(p.repo)) ? ["--add-dir", memoryDir(p.repo)] : []), "--allowedTools", "Read,Glob,Grep,Bash(ls:*),Bash(graphify:*)", "--disallowedTools", "Edit,Write,NotebookEdit,WebFetch,WebSearch"],
    prompt: role.body.replaceAll("{project}", project) + (existsSync(memoryDir(p.repo)) ? `\n\nALSO READ the founder's Claude memory notes for this project, every file in ${memoryDir(p.repo)}. "feedback" notes are how they want work done: fold them into the rules line (may_do, always_ask, specialists). "project" notes are decisions and status: use them for tickets, ideas and conflicts (a note that contradicts a doc is a conflict). Never copy secrets, tokens or personal data.` : "") + company(),
  })
  if (!r.ok) {
    console.log(`onboarder failed: ${r.reason}`)
    return null
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
  console.log(`onboarded ${project}: ${JSON.stringify(out)}\nsee ${dir}/${project}.onboard.md, ${dir}/${project}.knowledge.md, dobby list --all, dobby ideas ${project}`)
  return rules as Record<string, string> | null
}

async function show(id: number) {
  const t = getTicket(db, id)
  if (!t) return console.log(`no ticket #${id}`)
  console.log(`#${t.id} [${t.status}] ${t.project}: ${t.title}\n  done when: ${t.done_when}\n  branch: ${t.branch ?? "-"}\n  note: ${t.note ?? "-"}\n`)
  const snap = await compileTicketGraph(db).getState(thread(id))
  for (const l of (snap.values.log as string[] | undefined) ?? []) console.log(`  ${l}`)
  if (snap.next.length) console.log(`  → next: ${snap.next.join(", ")}`)
  const runs = db.prepare("SELECT kind, model, ok, turns, output_tokens, cost_usd FROM runs WHERE ticket=? ORDER BY id").all(id) as Record<string, unknown>[]
  for (const r of runs) console.log(`  run ${r.kind} ${r.model} ${r.ok ? "ok" : "FAIL"} turns=${r.turns} out=${r.output_tokens} $${Number(r.cost_usd ?? 0).toFixed(3)}`)
}

/** `dobby add discord|dashboard|jobs`: one add-on over a terminal-only start; tickets run without any of them. */
async function addOn(what: string) {
  const { installJobs } = await import("./jobs.ts")
  const o = { bin: `${ROOT}bin/dobby`, home: homedir(), uid: process.getuid?.() ?? 0 }
  if (what === "discord") {
    const { readSecrets } = await import("./telegram.ts")
    if (!readSecrets().DISCORD_BOT_TOKEN) return console.log(`Discord in three steps:\n1. Create a bot at discord.com/developers and copy its token\n2. Add DISCORD_BOT_TOKEN=<token> to ${configDir()}/secrets.env\n3. Run: dobby discord invite, then dobby add discord again`)
    console.log(`✓ Discord: channels ready in "${await (await import("./discord.ts")).setup(db)}". Restart dobby start (or the telegram job) to get the buttons; dobby discord test sends a hello to each.`)
    return
  }
  if (what === "jobs") {
    const pid = Number((db.prepare("SELECT v FROM kv WHERE k='start:pid'").get() as { v: string } | undefined)?.v)
    let alive = false
    try { alive = !!pid && process.kill(pid, 0) } catch {} // no such process: a stale row
    if (alive) throw new Error(`dobby start is running (pid ${pid}): stop it with Ctrl-C first; the jobs replace it, and both would build every ticket twice`)
  }
  // dashboard alone runs beside dobby start: it only reads the database and runs owner taps
  for (const r of installJobs({ ...o, only: what === "dashboard" ? ["dashboard"] : undefined })) { console.log(`${r.ok ? "✓" : "✗"} ${r.name}: ${r.detail}`); if (!r.ok) process.exitCode = 1 }
}

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
    break
  }
  case "add": {
    if (["discord", "dashboard", "jobs"].includes(a[0]) && !a[1]) { await addOn(a[0]); break }
    const [project, title, done_when, size, priority] = a
    if (!project || !title) throw new Error('usage: add <project> "<title>" ["<done when>"] [S|M|L] [priority]')
    const p = loadProjects()[project]
    if (!p) throw new Error(`no dobby.md for ${project}`)
    const tri = p.jev ? await triage(title, done_when ?? "", size) : { size: size ?? "M", risk: "high", fromJev: false }
    const { id } = addTicket(db, { project, title, done_when, size: tri.size, risk: tri.risk, priority: priority ? Number(priority) : undefined })
    // An agent (the front desk reads mail) only files to the backlog; queuing it is the owner's tap (security review 20 Oct).
    if (process.env.DOBBY_ROLE) {
      setTicket(db, id, { status: "backlog" })
      db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(agentFiledKey(id), process.env.DOBBY_ROLE) // the Lead never promotes it
    }
    console.log(`#${id} size ${tri.size}, risk ${tri.risk}${tri.fromJev ? " (Jev)" : " (fallback: careful path)"}${process.env.DOBBY_ROLE ? ", in the backlog (propose queue <id> to build it)" : ""}`)
    break
  }
  case "list":
    if (a[0] === "--all") {
      for (const t of db.prepare("SELECT id, status, project, size, priority, title FROM tickets WHERE status NOT IN ('shipped','declined') ORDER BY priority DESC, id").all() as Record<string, unknown>[])
        console.log(`#${t.id} [${t.status}] ${t.project} ${t.size} p${t.priority}  ${t.title}`)
    } else console.log(listView(db.prepare("SELECT id, status, project, title, note, updated_at FROM tickets WHERE status NOT IN ('shipped','declined','backlog') AND dup_of IS NULL").all() as Parameters<typeof listView>[0]))
    break
  case "status":
    console.log(statusText(db))
    break
  case "tick":
    stampLogs() // tick.log: ISO time on every line
    await tick()
    await updateBoard(db, !!discordOn()).catch((e) => console.log(`status board: ${(e as Error).message}`)) // no AI; after every run, early returns included
    break
  case "show":
    await show(Number(a[0]))
    break
  case "approve":
  case "decline":
    await answer(Number(a[0]), cmd)
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
    if (r.ok && r.text.trim()) writeFileSync(`${ROOT}company.md`, r.text.trim() + "\n")
    console.log(r.ok ? "wrote company.md" : `failed: ${r.reason}`)
    break
  }
  case "init": // dobby init: one-command setup (--yes, --projects <dir>, --no-jobs); dobby init <project>: join one project
    if (!a[0] || a[0].startsWith("--")) {
      const at = a.indexOf("--projects")
      await (await import("./setup.ts")).setup(db, { yes: a.includes("--yes"), noJobs: a.includes("--no-jobs"), projects: at >= 0 ? a[at + 1] : undefined, root: ROOT })
    } else await init(a[0])
    break
  case "onboard":
    await onboard(a[0])
    break
  case "api": // Max plan API credits: on (auto, falls back when empty) | off | status
    console.log((await import("./api.ts")).apiCommand(db, a[0]))
    break
  case "run": { // dobby run <id>: build this ticket now, in this process. No worker cap, budget gate or tick lock; the owner asked for it.
    const t = getTicket(db, Number(a[0]))
    if (!t) throw new Error(`no ticket #${a[0]}`)
    if (t.status === "running") throw new Error(`#${t.id} is already running`)
    if (["shipped", "declined"].includes(t.status)) throw new Error(`#${t.id} is ${t.status}`)
    setTicket(db, t.id, { status: "ready" })
    await buildTicket(t, "run", "on demand")
    console.log(`#${t.id} now ${getTicket(db, t.id)?.status}`)
    break
  }
  case "queue": { // backlog -> ready (Owner:/deploy-type tickets stay put; same rule the Lead follows). A re-queue by hand is an owner touch.
    const was = getTicket(db, Number(a[0]))?.status
    console.log(queueTicket(db, Number(a[0])))
    if (was) touch(db, { ticket: Number(a[0]), kind: "queue", tag: was === "failed" ? "broke" : "decision" })
    break
  }
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
    console.log((await command(a.join(" "))) ?? `Unknown: ${a.join(" ")}`)
    break
  }
  case "ask": // try the front desk from the terminal
    console.log(await frontDesk(a.join(" "), ""))
    break
  case "capacity": // how full the 5-hour windows got this week, and what to change
    console.log(capacityFromDb(db) || "no windows recorded yet")
    break
  case "listen": { // the launchd job
    stampLogs() // telegram.log: ISO time on every line
    const ddb = discordOn()
    if (!ddb) throw new Error("Discord is not set up: run `dobby discord` first")
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
    else console.log("Discord is not set up: running the queue loop only")
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
      exec: [process.execPath, "--no-warnings", import.meta.filename, "start"], path: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter), // the folder of this node first: a per-shell fnm PATH entry is gone after a reboot
      log: `${home("~/.local/share/dobby/logs")}/service.log`, home: homedir(), uid: process.getuid?.() ?? 0,
    }))
    break
  case "telemetry-serve": // the receiver alone; stays up until killed
    if (!(await startTelemetry(db, Number(a[0]) || undefined))) process.exitCode = 1
    break
  case "discord": {
    const d = await import("./discord.ts")
    if (a[0] === "invite") console.log(await d.inviteUrl())
    else if (a[0] === "setup") console.log(`set up in "${await d.setup(db)}": #${d.CHANNELS.join(", #")}, one webhook each`)
    else if (a[0] === "test") {
      const tries: [Event, string][] = [
        [{ kind: "approval" }, "Test: this is #needs-you, the only channel that pings you."], [{ kind: "brief" }, "Test: the morning brief lands here."],
        ...Object.keys(config().discord.apps).map((p): [Event, string] => [{ kind: "lead", project: p }, `Test: ${p} tickets get one thread each here.`]),
        [{ kind: "idea", project: Object.keys(config().discord.apps)[0] }, "Test: idea cards land here. 👍 queues one, 👎 drops it."], [{ kind: "health" }, "Test: job and disk problems land here."],
        [{ kind: "ask" }, "Test: write here to talk to the front desk."],
      ]
      // asIs: no summary call for a test card; a hello that fails is not replayed by the brief (takeOutbox drops "Test: ")
      for (const [e, text] of tries) console.log(`${await notify(text, fetch, undefined, e, asIs) ? "ok " : "FAIL"} ${e.kind}`)
    } else console.log("usage: discord invite | setup | test")
    break
  }
  case "lead": {
    const dry = a.includes("--dry")
    const only = a.find((x) => !x.startsWith("--"))
    const names = only ? [only] : Object.values(loadProjects()).filter((p) => !p.paused).map((p) => p.name)
    for (const n of names) {
      const r = await runLead(db, n, dry)
      if (dry) console.log(`plan: ${JSON.stringify(r.plan, null, 2)}`)
      console.log(r.report)
    }
    break
  }
  case "cos": {
    const r = await runCos(db, a.includes("--dry"))
    if (!a.includes("--dry")) console.log(r.brief) // lands in logs/cos.log
    console.log(`brief from ${r.source}; ${a.includes("--dry") ? "dry run, nothing sent" : `${r.sent} of ${r.pings + 1} message(s) sent`}`)
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
  case "tools": { // dobby tools [on|off <name>]: agent tooling (graphify, rtk, caveman, ponytail, jev)
    const t = await import("./tools.ts")
    console.log(a[0] === "on" || a[0] === "off" ? t.setTool(a[1] ?? "", a[0] === "on") : t.toolsTable())
    break
  }
  case "config":
    console.log((await import("./migrate.ts")).configCmd(a[0]))
    break
  case "goals": { // dobby goals [app]: each app's goals in rank order; dobby goals import <app>: turn the file's goals into milestones
    const { goals: active } = await import("./lib.ts")
    if (a[0] === "import") {
      const p = loadProjects()[a[1]]
      if (!p) throw new Error("usage: dobby goals import <app>")
      const { repoOf } = await import("./board.ts"), { run: gh } = await import("./graphs/review.ts")
      const repo = repoOf(p.repo, gh)
      if (!repo) throw new Error(`${p.name} has no GitHub repo`)
      syncGoals(db, p.name, p.rules)
      for (const l of (await import("./milestones.ts")).importGoals(db, p.name, repo, gh)) console.log(l)
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
    const { installJobs, uninstallJobs, loadedProbe, JOBS } = await import("./jobs.ts")
    const o = { bin: `${ROOT}bin/dobby`, home: homedir(), uid: process.getuid?.() ?? 0, dry: a.includes("--dry") }
    if (process.platform !== "darwin" && process.platform !== "linux") throw new Error(`background jobs are not available on ${process.platform}: run \`dobby start\` in a terminal`)
    if (a[0] === "install") for (const r of installJobs(o)) { console.log(`${r.ok ? "✓" : "✗"} ${r.name}: ${r.detail}`); if (!r.ok) process.exitCode = 1 }
    else if (a[0] === "uninstall") console.log(uninstallJobs(o).join("\n") || "no Dobby jobs were installed")
    else if (a[0] === "status") for (const j of JOBS) console.log(`${spawnSync(...loadedProbe(j, process.platform, o.uid)).status === 0 ? "✓" : "✗"} ${j.name}: ${j.what}`)
    else console.log("usage: dobby jobs install | uninstall | status [--dry]")
    break
  }
  case "uninstall": { // dobby uninstall: stop and remove the background jobs; data, config and secrets stay
    const { uninstallJobs } = await import("./jobs.ts")
    console.log(uninstallJobs({ bin: `${ROOT}bin/dobby`, home: homedir(), uid: process.getuid?.() ?? 0, dry: a.includes("--dry") }).join("\n") || "no Dobby jobs were installed")
    console.log(`Kept: ${configDir()} (config, secrets, project drafts) and ${home(config().paths.data)} (database, logs). Delete them by hand to remove everything.`)
    break
  }
  case "doctor": { // dobby doctor: the basics (tools, sign-ins, config, jobs, add-ons), then one line per pipeline check; exit 1 if a required one fails
    const { basics, formatChecks } = await import("./checks.ts")
    const base = await basics({ jobs: true, apiKeyMode: apiKeyMode() })
    console.log(formatChecks(base))
    if (base.some((r) => r.required && !r.ok)) process.exitCode = 1
    const origins = Object.values(loadProjects()).map((p) => ({ project: p.name, base: p.base, ok: spawnSync("git", ["-C", p.repo, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${p.base}`]).status === 0 }))
    const auth = await claude(db, { project: "dobby", kind: "doctor", model: "haiku", prompt: "Reply with the word ok.", args: [], cwd: (await import("node:os")).tmpdir(), stallMs: 60_000 }, undefined, async () => {}) // no owner ping: you are looking at it
    const scanLast = (db.prepare("SELECT v FROM kv WHERE k='review:scan:last'").get() as { v: string } | undefined)?.v
    const rows = doctor({ tickets: db.prepare("SELECT id, status, updated_at FROM tickets WHERE status='running'").all() as never, pauses: pauseList(db), origins, auth, scan: scanLast ? JSON.parse(scanLast) : undefined })
    // the pipeline checks the hourly health job posts, read only here
    const { pipelineChecks } = await import("./health.ts")
    for (const h of pipelineChecks(db, { persist: false }).filter((x) => ["stuck", "reviews", "cap"].includes(x.check))) rows.push({ name: h.check, ok: h.ok, detail: h.text })
    for (const r of rows) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.detail}`)
    if (rows.some((r) => !r.ok)) process.exitCode = 1
    break
  }
  case "migrate":
    console.log((await import("./migrate.ts")).migrate({ dryRun: a.includes("--dry-run") || a.includes("--dry") }))
    break
  case "providers": {
    const { providersCmd, runner } = await import("./providers/wire.ts")
    const { readSecrets } = await import("./telegram.ts")
    console.log(await providersCmd(db, a, { env: { ...readSecrets(), ...process.env }, run: runner(), fetch, cfg: config().providers }))
    break
  }
  default:
    console.log(helpText(readFileSync(new URL(import.meta.url), "utf8")))
}

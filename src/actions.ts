// The owner's actions in one registry: each has a CLI verb, an MCP tool + op, a class, and one `run`. cli.ts and mcp.ts both call these;
// a CLI case with no function of its own got one here. `cls` is what the MCP tool is annotated as: read, write (reversible), destructive.
// Nothing here asks the owner: the MCP tool asks (confirm) before it calls a destructive run, and sends it to the inbox when it cannot ask.
import { spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { DATA, type DB } from "./db.ts"
import { MANUAL, docsCommand, pages } from "./docs.ts"
import { agentFiled, agentFiledKey, addTicket, repoArgs, claimKey, dropIdea, getTicket, ideaToTicket, label, loadProjects, queueTicket, reapDead, setTicket, short, type Project } from "./lib.ts"
import { cancelTicket, stuckTap } from "./stuck.ts"
import { run, type Run } from "./graphs/review.ts"
import { Command, compileTicketGraph, thread } from "./graphs/ticket.ts"
import { applyFinding, automergeKey, dismissFinding, fixCommand, getWait, ownerLand, real as reviewDeps, ruleFromFinding } from "./graphs/review.ts"
import { deployProject, runQueuedDeploys } from "./deploy.ts"
import { notify, redact, type Buttons } from "./notify.ts"
import { parsePause, pauseLine, pauseList, setPause } from "./pause.ts"
import { touch } from "./usage.ts"
import { riskFromWords, triage } from "./jev.ts"
import { capHold, costText, NOTHING_OPEN, limitsNow, limitsText, listView, receipt, receiptLine, receiptSvg, scoreboard, scoreboardText, statusText } from "./view.ts"
import { PR_RE, repoSlug } from "./savings.ts"
import { ConfigError, configSetText } from "./config-edit.ts"
import { BUILD_CAP, buildsUsed, statusWord } from "./lib.ts"
import { noteUse, reportText } from "./stats.ts"

export type Cls = "read" | "write" | "destructive"
/** One call's inputs. `agent` is set by the MCP server only (never by a client): an agent's add is filed to the backlog and its queue of an agent-filed ticket waits for the owner. */
export type Args = { id?: number; project?: string; title?: string; done_when?: string; size?: string; priority?: number; days?: number; before?: number; detail?: "short" | "full"; cursor?: string; topic?: string; query?: string; target?: string; for?: string; text?: string; key?: string; value?: string; unset?: boolean; agent?: boolean }
export type Out = { text: string; nextCursor?: string; pending?: boolean }
export type Action = { name: string; cli: string; mcp: { tool: string; op: string }; cls: Cls; run: (db: DB, a: Args, d: Deps) => Out | Promise<Out> }

/** What an action reaches outside the database. Tests replace these; `real` is the live one. */
export type Deps = {
  answer: (db: DB, id: number, decision: "approve" | "decline") => Promise<string>
  cancel: (db: DB, id: number) => string
  land: (db: DB, repo: string, pr: number) => Promise<string>
  deploy: (db: DB, project: string) => Promise<string>
  pause: (db: DB, text: string) => Promise<string>
  /** One more automatic fix round on a PR (the `@dobby fix` rules). */
  fix: (db: DB, repo: string, pr: number) => Promise<string>
  /** One review finding queued as a fix ticket on the PR's branch. */
  applyFinding: (db: DB, id: number) => Promise<string>
  /** The owner's inbox: a #needs-you card with these buttons (Discord, else the terminal and outbox.log). */
  inbox: (text: string, buttons: Buttons, key: string) => Promise<unknown>
  projects: () => Record<string, Project>
  git: (args: string[], cwd: string) => string
}

/** A refusal with a plain message. Shaped like Hono's HTTPException so Signet's error mapping keeps the message (any other error becomes "Internal error"). */
export class UserError extends Error {
  status: number
  code: string
  constructor(code: string, message: string, status = 400) { super(message), this.name = "HTTPException", this.code = code, this.status = status }
}
/**
 * The openings of the plain lines a refused owner command answers with (not landed, not queued, no such ticket, nothing to apply...).
 * The CLI turns these into a UserError (exit 1), so the dashboard and scripts see a refusal instead of a success.
 */
const REFUSED = /^(not landed|merge failed|no (ticket|finding|idea) #|Won't|Can't|Couldn't|Not on a|Unknown:|Finding #\d+ is |This PR has had|#\d+ (needs the owner|failed the same way|was not queued|has no pull|is \w+;)|[\w.-]+: (no deploy step configured|deploy failed:))/
export function refuse(text: string): string {
  if (REFUSED.test(text.trim())) throw new UserError("REFUSED", text, 409)
  return text
}
const fail = (m: string, code = "BAD_REQUEST"): never => { throw new UserError(code, m) }
const need = (id: number | undefined) => id && Number.isInteger(id) && id > 0 ? id : fail("This needs a ticket id (a whole number).")

// ---- bodies moved out of cli.ts ---------------------------------------------------------------------------------------------

/** approve|decline a ticket parked at the graph's gate (decline on any other ticket = cancel). One resume per gate: a typed approve and a tap must not both ship it. */
export async function answerTicket(db: DB, id: number, decision: "approve" | "decline"): Promise<string> {
  const app = compileTicketGraph(db)
  const snap = await app.getState(thread(id))
  if (!snap.next.includes("gate")) {
    if (decision === "decline") return cancelTicket(db, id)
    const t = getTicket(db, id)
    return t ? `Nothing waits for approval on ${t.title}; ${t.note?.match(PR_RE) ? `its PR waits for your merge: run dobby merge ${id}` : "merges are approved on its PR card"}.` : `no ticket #${id}`
  }
  const key = `resume:${id}:gate`
  if (!claimKey(db, key)) return `${label(db, id)} is already being answered`
  try {
    const out = await app.invoke(new Command({ resume: decision }), thread(id))
    return `${label(db, id)}: ${out.outcome}`
  } finally {
    if ((await app.getState(thread(id))).next.includes("gate")) db.prepare("DELETE FROM kv WHERE k=?").run(key)
  }
}

/** A parsed pause/resume. `all` also stops the tick, killing the running builds (they resume from their checkpoints). */
export async function pauseAct(db: DB, pc: Exclude<ReturnType<typeof parsePause>, null>): Promise<string> {
  if ("error" in pc) return pc.error
  if ("status" in pc) return pauseList(db).map((x) => `• ${x.text}`).join("\n") || "Nothing is paused."
  const sc = pc.scope
  if ("project" in sc && !loadProjects()[sc.project]) return `No project called ${sc.project}.`
  if ("ticket" in sc && !getTicket(db, sc.ticket)) return `No ticket #${sc.ticket}.`
  const r = setPause(db, sc, pc.on, process.env.DOBBY_BY ?? "the owner", { until: pc.until })
  if (r.line && !("kind" in sc && sc.kind === "notify")) await notify(r.line, fetch, undefined, { kind: "health" })
  if ("all" in sc && pc.on) {
    const launchd = !existsSync(`${homedir()}/Library/LaunchAgents/com.dobby.tick.plist`) ? NaN : Number(spawnSync("launchctl", ["print", `gui/${process.getuid?.()}/com.dobby.tick`], { encoding: "utf8" }).stdout?.match(/\bpid = (\d+)/)?.[1]) // no launchctl (Linux): NaN, skipped
    const started = Number((db.prepare("SELECT v FROM kv WHERE k='tick:pid'").get() as { v: string } | undefined)?.v) // the tick child of `dobby start` and the service
    const running = (db.prepare("SELECT count(*) n FROM tickets WHERE status='running'").get() as { n: number }).n
    for (const pid of [launchd, started]) try { if (pid) process.kill(-pid, "SIGTERM") } catch {} // each leads its own process group: this stops their claude runs too
    db.prepare("DELETE FROM kv WHERE k='lock'").run()
    // the killed builds no longer run: say so (back to ready with a note; the checkpoint and worktree stay, so resume continues them, and the queue reads "Paused")
    for (const t of db.prepare("SELECT id FROM tickets WHERE status='running'").all() as { id: number }[]) {
      db.prepare("DELETE FROM kv WHERE k=?").run(`build:${t.id}`)
      setTicket(db, t.id, { status: "ready", note: "paused by you; continues where it stopped when you resume" })
    }
    return `⏸ Paused everything${pc.until ? " for the time you said" : ""}.${running ? ` Stopped ${running} build(s); they pick up where they left off.` : ""} Say "resume everything" to start again.`
  }
  if ("all" in sc && !pc.on) return r.changed ? "▶️ Resumed. Builders start again within a minute." : r.reply
  if (!pc.on) for (const l of await runQueuedDeploys(db)) r.reply += `\n${l}` // a resume releases the deploys it was holding
  return r.reply
}
/** "pause all for 2h", "resume project x": null when the text is not a pause command. */
export async function pauseText(db: DB, text: string): Promise<string | null> {
  const pc = parsePause(text)
  return pc ? pauseAct(db, pc) : null
}

/** `dobby add <project> "<title>" ...`: the ticket, its triage and its issue note. `role` set = an agent filed it: backlog, and the Lead never promotes it. */
export async function addTicketText(db: DB, a: { project: string; title: string; done_when?: string; size?: string; priority?: number; noIssue?: boolean }, role?: string): Promise<string> {
  const p = loadProjects()[a.project]
  if (!p) throw new UserError("NOT_FOUND", `no dobby.md for ${a.project}. Run dobby init (or dobby init ${a.project}) first.`, 404)
  const tri = p.jev ? await triage(a.title, a.done_when ?? "", a.size) : { size: a.size ?? "M", risk: riskFromWords(a.title, a.done_when ?? ""), riskBy: "words" as const, fromJev: false }
  const { id } = addTicket(db, { project: a.project, title: a.title, done_when: a.done_when, size: tri.size, risk: tri.risk, priority: a.priority })
  // An agent (the front desk reads mail, Claude over MCP) only files to the backlog; queuing it is the owner's tap (security review 20 Oct).
  if (role) {
    setTicket(db, id, { status: "backlog" })
    db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(agentFiledKey(id), role) // the Lead never promotes it
  }
  const out = [`#${id} size ${tri.size}, risk ${tri.risk} (${tri.riskBy === "jev" ? "Jev" : "words"})${role ? ", in the backlog (propose queue <id> to build it)" : ""}`]
  // onboarding is a model run of its own, so it is not started here; the owner is told the first build reads the repo first
  if (!role && !db.prepare("SELECT 1 FROM kv WHERE k=?").get(`onboarded:${a.project}`)) out.push(`${a.project} is new to Dobby: before the first build, Dobby reads the repo once (a few minutes). dobby run ${id} does both now.`)
  const { issueRepo, noIssueKey } = await import("./board.ts")
  if (a.noIssue) db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(noIssueKey(id), "1")
  else { const repo = issueRepo(a.project); if (repo) out.push(`Will appear as an issue on ${repo} at the next sync (private repo). Turn off: --no-issue, or board.issues false in your config.`) }
  return out.join("\n")
}

/** `dobby queue <id>`: backlog/failed -> ready. A re-queue by hand is an owner touch. */
export function queueText(db: DB, id: number): string {
  const was = getTicket(db, id)?.status
  const out = queueTicket(db, id)
  if (was) touch(db, { ticket: id, kind: "queue", tag: was === "failed" ? "broke" : "decision" })
  return out
}

/** `dobby unqueue <id>`: a queued ticket goes back to the backlog (a running one is not touched; cancel it instead). */
export function unqueueText(db: DB, id: number): string {
  const t = openTicket(db, id)
  if (t.status !== "ready") return `#${id} is ${t.status}; only a queued (ready) ticket goes back to the backlog.`
  setTicket(db, id, { status: "backlog" })
  return `#${id} is back in the backlog: ${short(t.title)}`
}

/** `dobby done <id> [--pr N]`: work finished outside Dobby. Only the ticket's own row changes: no PR, branch or worktree is touched and nothing is posted. */
export function doneText(db: DB, id: number, pr?: number, git: Deps["git"] = real.git, projects = loadProjects()): string {
  const t = openTicket(db, id)
  if (t.status === "running") fail(`#${id} is running; cancel it or wait for it to end first.`)
  const slug = pr ? repoSlug(git(["remote", "get-url", "origin"], projects[t.project]?.repo ?? ".")) : null
  setTicket(db, id, { status: "shipped", note: `Marked done by owner${pr ? `\n${slug ? `https://github.com/${slug}/pull/${pr}` : `PR #${pr}`}` : ""}` })
  return `#${id} is marked shipped: ${short(t.title)}`
}

/**
 * `dobby reorder <id> [before]`: put queued ticket `id` just above ticket `before`, or last when `before` is missing.
 * Builders take the highest priority first (then the oldest id), so the order is written as priorities: the queue's top gets 100, then one less each.
 * ponytail: a queue longer than 100 ties at 0 and falls back to id order; widen the scale if that ever happens.
 */
export function reorderText(db: DB, id: number, before?: number): string {
  const ready = (db.prepare("SELECT id FROM tickets WHERE status='ready' AND dup_of IS NULL ORDER BY priority DESC, id").all() as { id: number }[]).map((r) => r.id)
  if (!ready.includes(id)) return `#${id} is not queued, so it has no place in the order.`
  const rest = ready.filter((x) => x !== id)
  const at = before === undefined || before === 0 ? rest.length : rest.indexOf(before)
  if (at < 0) return `#${before} is not queued, so #${id} cannot go above it.`
  rest.splice(at, 0, id)
  const set = db.prepare("UPDATE tickets SET priority=?, updated_at=? WHERE id=?")
  rest.forEach((x, i) => set.run(Math.max(0, 100 - i), new Date().toISOString(), x))
  return `#${id} is now ${at + 1} of ${rest.length} in the queue.`
}

/** Every step the ticket's graph took, with tokens and cost. `short` = the header, the last steps and the run totals. */
export async function showText(db: DB, id: number, detail: "short" | "full" = "full"): Promise<string> {
  const t = getTicket(db, id)
  if (!t) return `no ticket #${id}`
  const out = [`#${t.id} [${statusWord(t)}] ${t.project}: ${t.title}\n  done when: ${t.done_when}\n  branch: ${t.branch ?? "-"}\n  note: ${t.note ?? (t.status === "ready" && capHold(db) ? `Waiting: cap (${capHold(db)})` : "-")}\n`]
  const snap = await compileTicketGraph(db).getState(thread(id))
  const log = (snap.values.log as string[] | undefined) ?? []
  const keep = detail === "full" ? log : log.slice(-6)
  if (keep.length < log.length) out.push(`  (${log.length - keep.length} earlier steps; detail "full" or dobby://ticket/${id}/log has them)`)
  for (const l of keep) out.push(`  ${l}`)
  if (snap.next.length) out.push(`  → next: ${snap.next.join(", ")}`)
  const runs = db.prepare("SELECT kind, model, ok, turns, output_tokens, cost_usd FROM runs WHERE ticket=? ORDER BY id").all(id) as Record<string, unknown>[]
  if (detail === "full") for (const r of runs) out.push(`  run ${r.kind} ${r.model} ${r.ok ? "ok" : "FAIL"} turns=${r.turns} out=${r.output_tokens} $${Number(r.cost_usd ?? 0).toFixed(3)}`)
  else if (runs.length) out.push(`  ${runs.length} runs, $${runs.reduce((s, r) => s + Number(r.cost_usd ?? 0), 0).toFixed(3)} (detail "full" lists them)`)
  return out.join("\n")
}

/** MCP `dobby_read` view "job": a running ticket's stage, last update, last step and share of its build cap used. Reads what `show` reads; no new tables. */
export async function jobText(db: DB, id: number): Promise<string> {
  const t = getTicket(db, id)
  if (!t) return `no ticket #${id}`
  if (t.status !== "running") return `#${id} is not running (it is ${t.status}).`
  const snap = await compileTicketGraph(db).getState(thread(id))
  const last = ((snap.values.log as string[] | undefined) ?? []).slice(-1)[0] ?? "no steps yet"
  return `#${id} running. Stage: ${snap.next[0] ?? "building"}. Last update: ${(db.prepare("SELECT updated_at u FROM tickets WHERE id=?").get(id) as { u: string }).u}. Last step: ${short(last)}. Builds used: ${Math.min(100, Math.round((100 * buildsUsed(db, id)) / BUILD_CAP))}% of ${BUILD_CAP}.`
}

/** `dobby receipt [days]`: the shipped-vs-spent line; `card` also writes the 1200x630 card at <data>/receipt.svg (the CLI does, a read tool does not). */
export function receiptText(db: DB, days: number, card = false): string {
  const r = receipt(db, days), file = `${DATA}/receipt.svg`
  if (!card) return receiptLine(r)
  mkdirSync(DATA, { recursive: true }), writeFileSync(file, receiptSvg(r))
  return `${receiptLine(r)}\n${file}`
}

/** `dobby list`: open tickets by stage; `all` = one line per ticket. */
export function listText(db: DB, all = false): string {
  if (!all) {
    const out = listView(db.prepare("SELECT id, status, project, title, note, updated_at FROM tickets WHERE status NOT IN ('shipped','declined','backlog') AND dup_of IS NULL").all() as Parameters<typeof listView>[0], Date.now(), 10, capHold(db))
    return out === NOTHING_OPEN && pauseLine(db) ? `${out}\n${pauseLine(db)}` : out
  }
  return (db.prepare("SELECT id, status, project, size, priority, title, note FROM tickets WHERE status NOT IN ('shipped','declined') ORDER BY priority DESC, id").all() as (Record<string, unknown> & { status: string; note: string | null })[])
    .map((t) => `#${t.id} [${statusWord(t)}] ${t.project} ${t.size} p${t.priority}  ${t.title}`).join("\n") || NOTHING_OPEN
}

export const PAGE = 10
/** The MCP list: open tickets, 10 a page; the cursor is the offset. */
export function listPage(db: DB, cursor?: string, full = false): Out {
  if (cursor !== undefined && !/^\d{1,6}$/.test(cursor)) fail("That cursor is not one this server gave out.", "INVALID_CURSOR")
  const at = Number(cursor ?? 0)
  const total = (db.prepare("SELECT COUNT(*) n FROM tickets WHERE status NOT IN ('shipped','declined') AND dup_of IS NULL").get() as { n: number }).n
  const rows = db.prepare("SELECT id, status, project, size, priority, title, note FROM tickets WHERE status NOT IN ('shipped','declined') AND dup_of IS NULL ORDER BY priority DESC, id LIMIT ? OFFSET ?").all(PAGE, at) as { id: number; status: string; project: string; size: string; priority: number; title: string; note: string | null }[]
  if (!rows.length) return { text: total ? `No tickets past ${at}; ${total} open in all.` : "No open tickets." }
  const next = at + rows.length < total ? String(at + rows.length) : undefined
  const lines = rows.map((t) => `#${t.id} [${statusWord(t)}] ${t.project}: ${short(t.title)}${full ? ` (size ${t.size}, p${t.priority}${t.note ? `; ${t.note.slice(0, 80)}` : ""})` : ""}`)
  return { text: `Open tickets ${at + 1}-${at + rows.length} of ${total}:\n${lines.join("\n")}${next ? `\nMore: call again with cursor "${next}".` : ""}`, nextCursor: next }
}

/** Case-insensitive match over the manual's page text: page and matching lines, at most 20. */
export function docsSearch(query: string, dir = MANUAL): string {
  const q = query.toLowerCase(), hits: string[] = []
  for (const p of pages(dir)) {
    for (const l of readFileSync(`${dir}${p.name}.md`, "utf8").split("\n")) if (l.toLowerCase().includes(q)) hits.push(`${p.name}: ${l.trim().slice(0, 200)}`)
    if (hits.length >= 20) break
  }
  return hits.length ? hits.slice(0, 20).join("\n") : `No page mentions "${query}".`
}

const BRANCH = /^[\w./-]+$/
/** `git diff <base>...<branch>` of the ticket's branch in its project's repo, clipped at 200 KB. */
export function ticketDiff(db: DB, id: number, d: Pick<Deps, "projects" | "git"> = real): string {
  const t = getTicket(db, id)
  if (!t) fail(`no ticket #${id}`, "NOT_FOUND")
  const p = d.projects()[t!.project], branch = t!.branch ?? `dobby/${id}`
  if (!p?.repo) return `No repo known for ${t!.project}.`
  if (!BRANCH.test(branch) || branch.startsWith("-") || !BRANCH.test(p.base) || p.base.startsWith("-")) return "That branch name is not one Dobby will diff."
  const out = d.git(["diff", `${p.base}...${branch}`], p.repo)
  const max = 200 * 1024
  return out.length > max ? `${out.slice(0, max)}\n\n[diff clipped at 200 KB; ${out.length - max} more characters on the branch]` : out || `No changes on ${branch} against ${p.base}.`
}


// ---- the owner's words and second chances (the dashboard's Answer, Hint, Retry, Take over, One more round) ------------------------

const LIVE = ["shipped", "declined"]
const openTicket = (db: DB, id: number) => { const t = getTicket(db, id); if (!t) fail(`no ticket #${id}`, "NOT_FOUND"); if (LIVE.includes(t!.status)) fail(`#${id} is already ${t!.status}.`); return t! }
const wordsOf = (text: string | undefined) => { const w = req(text, "text").slice(0, 2000); return w }

/** Add the owner's words to the ticket's done rule, where the next build reads them. The edit also gives a failed ticket a new same-failure key. */
export function addOwnerWords(db: DB, id: number, kind: "answer" | "hint", text: string | undefined): void {
  const t = openTicket(db, id)
  db.prepare("UPDATE tickets SET done_when=?, updated_at=? WHERE id=?").run(`${t.done_when}${t.done_when ? "\n\n" : ""}Owner's ${kind}: ${wordsOf(text)}`, new Date().toISOString(), id)
}

/** `dobby retry <id>`: a ticket stuck in fixing starts from scratch (its PR is closed); a failed one is queued again. */
export function retryText(db: DB, id: number, r: Run = run, projects: Record<string, Project> = loadProjects()): string {
  const was = getTicket(db, id)?.status
  reapDead(db) // a hard crash leaves a ticket "running" with no builder
  const t = openTicket(db, id)
  if (was === "running" && t.status === "ready") return `#${id} was cut off by a crash and is back in the queue; a builder picks it up within about a minute.`
  if (t.status === "fixing") return stuckTap(db, "retry", id)
  if (t.status === "failed" && t.branch) {
    // The owner may have closed the ticket's PR by hand: bring it back, or say why not. Never rebuild blind into a closed PR.
    const repo = projects[t.project]?.repo
    if (repo) {
      const flag = repoArgs(repo, (a, cwd) => r("git", a, cwd), projects[t.project]?.upstream)
      const v = r("gh", ["pr", "view", t.branch, ...flag, "--json", "state,url", "-q", ".state + \" \" + .url"], repo)
      const [state, url] = v.ok ? v.out.trim().split(" ") : []
      if (state === "MERGED") return `#${id}: its PR ${url} is already merged; nothing to retry.`
      if (state === "CLOSED") {
        const o = r("gh", ["pr", "reopen", url, ...flag], repo)
        if (!o.ok) return `#${id} not queued: its PR ${url} was closed and can't be reopened (${(o.out.trim() || "no reason given").slice(0, 120)}). Reopen it on GitHub yourself, or decline the ticket and add it again.`
        return `${queueText(db, id)}\nIts PR ${url} was closed; reopened it.`
      }
    }
  }
  if (t.status === "failed" || t.status === "backlog") return queueText(db, id)
  return `#${id} is ${t.status}; there is nothing to retry.`
}

/** `dobby takeover <id>`: pause this one ticket and leave its branch to you. Resume it (`dobby resume ticket <id>`) to hand it back. */
export async function takeOverText(db: DB, id: number, d: Pick<Deps, "pause">): Promise<string> {
  const t = openTicket(db, id)
  await d.pause(db, `pause ticket ${id}`)
  setTicket(db, id, { note: `taken over by the owner${t.branch ? `; branch ${t.branch}` : ""}${t.note ? `\n${t.note}` : ""}` }) // the old note keeps its PR link
  return `Paused #${id}: ${short(t.title)}. It is yours now${t.branch ? ` (branch ${t.branch})` : ""}. \`dobby resume ticket ${id}\` hands it back.`
}

/** `dobby allowround <id>`: give the ticket's PR one more automatic fix round past the two it gets. */
export async function allowRoundText(db: DB, id: number, d: Pick<Deps, "fix">): Promise<string> {
  const t = openTicket(db, id), m = t.note?.match(PR_RE)
  if (!m) return `#${id} has no pull request to fix.`
  const repo = m[1], pr = Number(m[2]), wait = getWait(db, repo, pr)
  if (wait) db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(automergeKey(repo, pr), JSON.stringify({ ...wait, rounds: Math.min(wait.rounds ?? 1, 1) })) // rounds >= 2 is the stop
  else db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`autofix:${repo}#${pr}`, "1")
  return d.fix(db, repo, pr)
}

// ---- the owner's inbox ------------------------------------------------------------------------------------------------------

const prOf = (t: { note: string | null } | undefined) => t?.note?.match(PR_RE)
/** The plain question for a destructive op, and the buttons that already do it when the owner taps. */
export function decision(db: DB, op: string, a: Args, d: Pick<Deps, "projects"> = real): { sentence: string; buttons: Buttons; key: string } {
  if (op === "deploy") {
    const name = a.project ?? fail("deploy needs project (the project's name).")
    if (!d.projects()[name!]) fail(`No project called ${name}.`, "NOT_FOUND")
    return { sentence: `Deploy ${name} to production now? (A migration that changes data still waits for you.)`, buttons: [{ text: "🚀 Deploy", data: `deploynow ${name}` }], key: `mcp:deploy:${name}` }
  }
  const id = need(a.id), t = getTicket(db, id)
  if (!t) fail(`no ticket #${id}`, "NOT_FOUND")
  const what = `#${id} "${short(t!.title)}"`, pr = prOf(t)
  const open = pr ? [{ text: "🔗 Open PR", data: "", url: pr[0] }] : []
  switch (op) {
    case "approve": return { sentence: `Approve ${what}? Approving a ticket that waits at its gate ships it: its PR merges.`, buttons: [{ text: "✅ Approve", data: `approve ${id}` }, ...open], key: `mcp:approve:${id}` }
    case "merge": return { sentence: `Merge ${pr ? `PR #${pr[2]} ` : ""}${what} into ${d.projects()[t!.project]?.base ?? "main"}?`, buttons: [{ text: "✅ Approve", data: `approve ${id}` }, ...open], key: `mcp:merge:${id}` }
    case "retry": return { sentence: `Retry ${what}? ${t!.status === "fixing" ? "Its PR is closed and it starts again from scratch." : "It goes back in the queue."}`, buttons: [t!.status === "fixing" ? { text: "🔁 Retry", data: `stuckretry ${id}` } : { text: "🔁 Queue again", data: `queue ${id}` }, ...open], key: `mcp:retry:${id}` }
    case "decline": return { sentence: `Decline ${what}? It is dropped.`, buttons: [{ text: "✖️ Decline", data: `decline ${id}` }], key: `mcp:decline:${id}` }
    case "cancel": return { sentence: `Cancel ${what}? Its build stops and its worktree, branch and PR are removed.`, buttons: [{ text: "✖️ Cancel it", data: `decline ${id}` }, ...open], key: `mcp:cancel:${id}` }
    default: return fail(`Unknown decision: ${op}`)
  }
}

// ---- the registry -----------------------------------------------------------------------------------------------------------

const req = (v: string | undefined, what: string) => v?.trim() || fail(`This needs ${what}.`)
const PAUSE_TARGET = /^(all|builders|reviews|merges|deploys|planning|scout|notify|project [\w-]+|ticket #?\d+)$/i
const FOR = /^\d{1,3}[mhd]$/
/** "pause all for 2h" from the structured target and for; the same words the CLI takes. */
export function pauseWords(op: "pause" | "resume" | "status", target?: string, forHow?: string): string {
  if (op === "status") return "pause status"
  if (target !== undefined && !PAUSE_TARGET.test(target.trim())) fail(`Unknown pause target "${target}". Use all, builders, reviews, merges, deploys, planning, scout, notify, project <name> or ticket <id>.`)
  if (forHow !== undefined && !FOR.test(forHow)) fail('"for" must look like 30m, 2h or 1d.')
  if (forHow && op === "resume") fail("Resume does not take a time.")
  return `${op} ${target?.trim() ?? ""}${forHow ? ` for ${forHow}` : ""}`.replace(/\s+/g, " ").trim()
}
/** Does this pause call kill running builds? `pause all` does, so it is asked first like a destructive tool. */
export const pausesAll = (op: string, target?: string) => op === "pause" && /^all$/i.test(target?.trim() ?? "")
/** Does this resume let held merges or deploys run (queued deploys go out in the same call)? Asked first, like a deploy. */
export const resumesHeld = (op: string, target?: string) => op === "resume" && /^(all|merges|deploys|project [\w-]+)$/i.test(target?.trim() ?? "")

/** A card in the owner's inbox; nothing was done yet. */
async function needsTap(d: Pick<Deps, "inbox">, card: string, buttons: Buttons, key: string): Promise<Out> {
  await d.inbox(card, buttons, key)
  return { text: "Sent to your inbox for a tap. Nothing was done yet.", pending: true }
}
/** An agent's answer or hint: kept in kv under a random key, shown on the card, and written into the ticket only by the owner's tap (`agentwords <key>`). */
async function agentWords(db: DB, d: Pick<Deps, "inbox">, id: number, kind: "answer" | "hint", words: string | undefined): Promise<Out> {
  const t = openTicket(db, id), w = wordsOf(words), key = randomBytes(6).toString("hex")
  db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`agentwords:${key}`, JSON.stringify({ id, kind, text: w }))
  return needsTap(d, `🟡 Needs you · ${kind} for #${id} "${short(t.title)}"\nClaude wrote over MCP: "${short(w)}"\nIt goes into the ticket only when you tap.`, [{ text: "✅ Add it", data: `agentwords ${key}` }], `mcp:${kind}:${id}:${key}`)
}
/** The owner's tap on that card. */
export function applyAgentWords(db: DB, key: string): string {
  const row = db.prepare("SELECT v FROM kv WHERE k=?").get(`agentwords:${key}`) as { v: string } | undefined
  if (!row) return "That note was already added or is gone."
  db.prepare("DELETE FROM kv WHERE k=?").run(`agentwords:${key}`)
  const w = JSON.parse(row.v) as { id: number; kind: "answer" | "hint"; text: string }
  addOwnerWords(db, w.id, w.kind, w.text)
  return `Added the ${w.kind} to #${w.id}; the next build reads it.`
}

const A = (name: string, cli: string, tool: string, op: string, cls: Cls, run: Action["run"]): Action => ({ name, cli, mcp: { tool, op }, cls, run })
const text = (t: string): Out => ({ text: t })
const pausesRun: Action["run"] = async (db, a, d) => text(await d.pause(db, "pause status"))

export const actions: Action[] = [
  A("status", "status", "dobby_read", "status", "read", (db) => text(statusText(db, Date.now(), limitsNow(db)))),
  A("limits", "limits", "dobby_read", "limits", "read", (db) => text(limitsText(limitsNow(db)))),
  A("list", "list", "dobby_read", "list", "read", (db, a) => listPage(db, a.cursor, a.detail === "full")),
  A("show", "show", "dobby_read", "show", "read", async (db, a) => text(await showText(db, need(a.id), a.detail ?? "short"))),
  A("job", "show", "dobby_read", "job", "read", async (db, a) => text(await jobText(db, need(a.id)))),
  A("cost", "cost", "dobby_read", "cost", "read", (db, a) => text(getTicket(db, need(a.id)) ? costText(db, a.id!) : `no ticket #${a.id}`)),
  A("scoreboard", "scoreboard", "dobby_read", "scoreboard", "read", (db, a) => text(scoreboardText(scoreboard(db, a.days || 7), `Last ${a.days || 7} days`))),
  A("receipt", "receipt", "dobby_read", "receipt", "read", (db, a) => text(receiptText(db, a.days || 7))),
  A("pauses", "pause", "dobby_read", "pauses", "read", pausesRun),
  // The owner's usage-stats report from the Worker (src/stats.ts). Needs DOBBY_STATS_REPORT_TOKEN in the environment of the process that runs it.
  A("stats-report", "stats", "dobby_read", "stats-report", "read", async (_db, a) => text(await reportText(a.days || 30))),
  A("docs-list", "docs", "dobby_docs", "list", "read", () => text(docsCommand().out)),
  A("docs-read", "docs", "dobby_docs", "read", "read", (_db, a) => { const r = docsCommand(req(a.topic, "topic (a page name)")); if (r.code) fail(`No docs page "${a.topic}". Pages:\n${r.out}`, "NOT_FOUND"); return text(r.out) }),
  A("docs-search", "docs", "dobby_docs", "search", "read", (_db, a) => text(docsSearch(req(a.query, "query")))),
  A("add", "add", "dobby_ticket", "add", "write", async (db, a) => {
    const out = await addTicketText(db, { project: req(a.project, "project"), title: req(a.title, "title"), done_when: a.done_when, size: a.size, priority: a.priority }, a.agent ? "mcp" : process.env.DOBBY_ROLE)
    return text(a.agent ? `${out}\nFiled by an agent over MCP: it waits in the backlog until you queue it (dobby queue <id>, or the Queue button). It never starts on its own.` : out)
  }),
  A("queue", "queue", "dobby_ticket", "queue", "write", async (db, a, d) => {
    const id = need(a.id)
    if (a.agent && agentFiled(db, id)) { // an agent-filed ticket starts only on the owner's own queue
      await d.inbox(`🟡 Needs you · queue #${id} "${short(getTicket(db, id)?.title ?? "")}"\nClaude filed it over MCP; it starts only when you queue it.`, [{ text: "▶️ Queue", data: `queue ${id}` }], `mcp:queue:${id}`)
      return { text: "Sent to your inbox for a tap: an agent-filed ticket starts only when you queue it.", pending: true }
    }
    return text(queueText(db, id))
  }),
  // An agent never puts words into a ticket on its own: they wait in the owner's inbox (the words are shown) and go in only on the tap.
  A("answer", "answer", "dobby_ticket", "answer", "write", async (db, a, d) => {
    const id = need(a.id)
    if (a.agent) return agentWords(db, d, id, "answer", a.text)
    addOwnerWords(db, id, "answer", a.text)
    return text(`Recorded on #${id}. ${queueText(db, id)}`)
  }),
  A("hint", "hint", "dobby_ticket", "hint", "write", async (db, a, d) => {
    const id = need(a.id)
    if (a.agent) return agentWords(db, d, id, "hint", a.text)
    addOwnerWords(db, id, "hint", a.text)
    return text(`Recorded on #${id}; the next build reads it.`)
  }),
  A("take-over", "takeover", "dobby_ticket", "take-over", "write", async (db, a, d) => text(await takeOverText(db, need(a.id), d))),
  A("allow-round", "allowround", "dobby_ticket", "allow-round", "write", async (db, a, d) => {
    const id = need(a.id)
    if (a.agent) return needsTap(d, `🟡 Needs you · one more fix round on #${id} "${short(openTicket(db, id).title)}"\nClaude asked over MCP; a fix build starts only when you tap.`, [{ text: "🛠 One more round", data: `allowround ${id}` }], `mcp:allowround:${id}`)
    return text(await allowRoundText(db, id, d))
  }),
  // A review finding's three taps. Apply files a fix ticket on the PR's branch (nothing is pushed or merged); dismiss and rule only store a learning for the repo.
  A("apply-finding", "applyfinding", "dobby_ticket", "apply-finding", "write", async (db, a, d) => {
    const id = need(a.id)
    if (a.agent) return needsTap(d, `🟡 Needs you · apply review finding #${id}\nClaude asked over MCP; a fix ticket on the PR's branch starts only when you tap.`, [{ text: "🛠 Apply it", data: `applyfinding ${id}` }], `mcp:applyfinding:${id}`)
    return text(await d.applyFinding(db, id))
  }),
  A("dismiss-finding", "dismissfinding", "dobby_ticket", "dismiss-finding", "write", (db, a) => text(dismissFinding(db, need(a.id)))),
  A("rule-from-finding", "findingrule", "dobby_ticket", "rule-from-finding", "write", (db, a) => text(ruleFromFinding(db, need(a.id), a.text))),
  A("unqueue", "unqueue", "dobby_ticket", "unqueue", "write", (db, a) => text(unqueueText(db, need(a.id)))),
  A("reorder", "reorder", "dobby_ticket", "reorder", "write", (db, a) => text(reorderText(db, need(a.id), a.before))),
  // An idea becomes a ticket only on the owner's word: over MCP it goes to the owner's inbox, like queueing an agent-filed ticket.
  A("idea-ticket", "ideaticket", "dobby_ticket", "make-ticket", "write", async (db, a, d) => {
    const id = need(a.id)
    if (a.agent) {
      await d.inbox(`🟡 Needs you · make idea #${id} a ticket\nClaude asked over MCP; it starts only when you say so.`, [{ text: "✅ Make it a ticket", data: `buildidea ${id}` }], `mcp:idea:${id}`)
      return { text: "Sent to your inbox for a tap: an idea becomes a ticket only on your word.", pending: true }
    }
    return text(ideaToTicket(db, id))
  }),
  A("idea-drop", "ideadrop", "dobby_ticket", "dismiss-idea", "write", (db, a) => { const id = need(a.id); return text(db.prepare("SELECT 1 FROM ideas WHERE id=?").get(id) ? dropIdea(db, id, ["new", "proposed"]) : `no idea #${id}`) }),
  A("pause", "pause", "dobby_pause", "pause", "write", async (db, a, d) => text((await d.pause(db, pauseWords("pause", a.target, a.for))) ?? "")),
  A("resume", "resume", "dobby_pause", "resume", "write", async (db, a, d) => text((await d.pause(db, pauseWords("resume", a.target))) ?? "")),
  A("pause-status", "pause", "dobby_pause", "status", "read", pausesRun),
  // `dobby config set <key> <value>`: one setting in the private config file, checked against the config schema. An agent over MCP may change pacing-type settings only.
  A("config-set", "config", "dobby_pause", "config-set", "write", (_db, a) => {
    try { return text(configSetText({ key: a.key ?? "", value: a.value, unset: a.unset }, { agent: a.agent })) } catch (e) { if (e instanceof ConfigError) fail(e.message); throw e }
  }),
  A("approve", "approve", "dobby_decide", "approve", "destructive", async (db, a, d) => text(await d.answer(db, need(a.id), "approve"))),
  A("decline", "decline", "dobby_decide", "decline", "destructive", async (db, a, d) => text(await d.answer(db, need(a.id), "decline"))),
  A("cancel", "cancel", "dobby_decide", "cancel", "destructive", (db, a, d) => text(d.cancel(db, need(a.id)))),
  A("retry", "retry", "dobby_decide", "retry", "destructive", (db, a) => text(retryText(db, need(a.id)))),
  // An owner merge of a waiting PR: a ticket at its gate is approved (the ship step merges it); otherwise its PR is landed by ownerLand, with every refusal that has.
  A("merge", "merge", "dobby_decide", "merge", "destructive", async (db, a, d) => {
    const id = need(a.id), t = getTicket(db, id)
    if (!t) return text(`no ticket #${id}`)
    if ((await compileTicketGraph(db).getState(thread(id))).next.includes("gate")) return text(await d.answer(db, id, "approve"))
    const pr = prOf(t)
    return text(pr ? await d.land(db, pr[1], Number(pr[2])) : `#${id} has no pull request to merge (status ${t.status}).`)
  }),
  // The Deploy tap, tapped by the owner: a migration that changes data is never run from here (that takes the owner's Migrate & deploy tap).
  A("deploy", "deploy", "dobby_decide", "deploy", "destructive", async (db, a, d) => text(await d.deploy(db, req(a.project, "project")))),
]

export const real: Deps = {
  answer: answerTicket,
  cancel: (db, id) => cancelTicket(db, id),
  land: (db, repo, pr) => ownerLand(db, reviewDeps, repo, pr, true), // the owner's own Merge: the every-merge floor is theirs to waive
  deploy: (db, project) => deployProject(db, project, { tapped: true }),
  pause: async (db, t) => (await pauseText(db, t)) ?? "Not a pause command.",
  fix: (db, repo, pr) => fixCommand(db, reviewDeps, repo, pr),
  applyFinding: (db, id) => applyFinding(db, id, reviewDeps),
  inbox: (t, buttons, key) => notify(t, fetch, buttons, { kind: "approval", key }),
  projects: loadProjects,
  git: (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout ?? "",
}

const USED: Record<string, string> = { "config-set": "config_set", deploy: "deploy_tap", receipt: "week_report", scoreboard: "week_report" }

/** Run one action by name; `redact` over the text (a ticket note or a log line may hold a token). */
export async function runAction(db: DB, name: string, a: Args = {}, d: Deps = real): Promise<Out> {
  const act = actions.find((x) => x.name === name) ?? fail(`unknown action ${name}`)
  const o = await act.run(db, a, d)
  noteUse(db, USED[name]) // a local note for the usage stats' feature list; it leaves the machine only if the owner turned usage stats on
  return { ...o, text: redact(o.text) }
}

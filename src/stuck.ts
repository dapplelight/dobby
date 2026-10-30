// A ticket sitting in "fixing" for over 24h gets ONE #needs-you card (key stuck:<id>), edited on later ticks, never reposted.
// The Haiku summary is made once (kv stuck:top:<id>) and reused, so the owner-touch log counts one touch per card, not one per edit.
// Without Discord there is no edit: the terminal gets the card once (kv stuck:sent:<id>). A ticket that leaves fixing settles its card to "Resolved".
import { DATA, type DB } from "./db.ts"
import { kv, setKv } from "./chat/common.ts"
import { chatOn as discordOn, chatPrefix, platform } from "./chat/platform.ts"
import { getTicket, loadProjects, resetCounts, setTicket, type Project } from "./lib.ts"
import { asIs, clip, needsYou, notify, shortTitle, type Buttons } from "./notify.ts"
import { realSettle, run, type Run } from "./graphs/review.ts"

const STUCK_MS = 24 * 3600_000
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/

export type Deps = { top: typeof needsYou; send: (key: string, text: string, buttons: Buttons) => Promise<unknown>; settle: (key: string, text: string) => Promise<unknown>; discord: () => boolean }
const real: Deps = {
  top: needsYou,
  discord: () => discordOn() !== null,
  settle: realSettle,
  send: async (key, text, buttons) => {
    const ddb = discordOn()
    if (!ddb) return !!await notify(text, fetch, buttons, { kind: "stuck" }, asIs)
    try {
      await (await platform()).upsert(ddb, key, { kind: "stuck" }, text, buttons)
    } catch (e) {
      if (kv(ddb, `${chatPrefix()}:msg:${key}`)) return console.log(`stuck: edit failed, card left as is: ${(e as Error).message}`) // posted before: no second pinged card
      await notify(text, fetch, buttons, { kind: "stuck" }, asIs) // lands in outbox.log if Discord is down
    }
    return true
  },
}

type Row = { id: number; project: string; title: string; note: string | null; updated_at: string }

/** Post or refresh the card for every ticket stuck in fixing; settle the cards of tickets that left it. Returns log lines. */
export async function stuckScan(db: DB, d: Deps = real, now = Date.now()): Promise<string[]> {
  const out: string[] = []
  const rows = db.prepare("SELECT id, project, title, note, updated_at FROM tickets WHERE status='fixing' AND dup_of IS NULL AND updated_at<?").all(new Date(now - STUCK_MS).toISOString()) as Row[]
  const discord = d.discord()
  for (const t of rows) {
    if (!discord && kv(db, `stuck:sent:${t.id}`)) continue
    const pr = t.note?.match(PR_URL)?.[0]
    const buttons: Buttons = [{ text: "🔁 Retry from scratch", data: `stuckretry ${t.id}` }, { text: "✖️ Decline", data: `stuckdecline ${t.id}` }, ...(pr ? [{ text: "🔗 Open PR", data: "", url: pr }] : [])]
    const since = new Date(t.updated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
    const body = [`🟠 Stuck in fixing · ${t.project} #${t.id}`, `**${shortTitle(t.title)}**`, "", `In fixing since ${since} (${Math.floor((now - Date.parse(t.updated_at)) / 3600_000)}h). Last note: ${clip(t.note ?? "none", 160)}`, ...(pr ? [pr] : []), "", "Nothing merges or deploys until you pick."].join("\n")
    let top = kv(db, `stuck:top:${t.id}`)
    if (top === undefined) {
      const full = await d.top(body, buttons) // the 3-line Haiku summary + the one owner touch, once per card
      top = full.endsWith(body) ? full.slice(0, full.length - body.length) : ""
      setKv(db, `stuck:top:${t.id}`, top)
    }
    const sent = await d.send(`stuck:${t.id}`, top + body, buttons)
    if (discord || sent) setKv(db, discord ? `stuck:open:${t.id}` : `stuck:sent:${t.id}`, "1") // no Discord: only a delivered card counts as sent
    out.push(`stuck: #${t.id} card sent or refreshed`)
  }
  const stuckIds = new Set((db.prepare("SELECT id FROM tickets WHERE status='fixing' AND dup_of IS NULL").all() as { id: number }[]).map((r) => r.id)) // by status, not age: a note update must not settle the card of a ticket still in fixing
  for (const { k } of db.prepare("SELECT k FROM kv WHERE k LIKE 'stuck:sent:%'").all() as { k: string }[]) if (!stuckIds.has(Number(k.slice("stuck:sent:".length)))) forget(db, Number(k.slice("stuck:sent:".length))) // left fixing: a later stuck spell gets a new card
  for (const { k } of db.prepare("SELECT k FROM kv WHERE k LIKE 'stuck:open:%'").all() as { k: string }[]) {
    const id = Number(k.slice("stuck:open:".length))
    if (stuckIds.has(id)) continue
    const t = getTicket(db, id)
    if (t) await d.settle(`stuck:${id}`, `✅ Resolved · ${t.project} #${id}`)
    forget(db, id)
    out.push(`stuck: #${id} resolved`)
  }
  return out
}

const forget = (db: DB, id: number) => db.prepare("DELETE FROM kv WHERE k IN (?, ?, ?, ?)").run(`stuck:open:${id}`, `stuck:top:${id}`, `stuck:sent:${id}`, `${chatPrefix()}:msg:stuck:${id}`)

/**
 * The card's buttons. retry = close the PR and its branch, back to ready (a builder starts from the base branch);
 * decline = close the PR, ticket declined. Anything not in fixing is left alone. The result text lands in the tapped message.
 */
export function stuckTap(db: DB, verb: "retry" | "decline", id: number, r: Run = run, projects: Record<string, Project> = loadProjects()): string {
  const t = getTicket(db, id)
  if (!t) return `no ticket #${id}`
  if (t.status !== "fixing") return (forget(db, id), `#${id} is ${t.status} now; nothing to do.`)
  if (verb === "decline") return cancelTicket(db, id, { r, projects })
  const url = t.note?.match(PR_URL)?.[0]
  if (url) {
    const c = r("gh", ["pr", "close", url, "--delete-branch"])
    if (!c.ok && !/already closed/i.test(c.out)) return `Couldn't close the PR (${clip(c.out, 120)}); #${id} stays in fixing.`
  }
  dropPrWork(db, t, url)
  forget(db, id) // the tap result replaces the card text: nothing left to settle
  const repo = projects[t.project]?.repo
  if (repo && t.branch && /^[\w./-]+$/.test(t.branch) && !t.branch.startsWith("-")) { r("git", ["branch", "-D", t.branch], repo); r("git", ["update-ref", "-d", `refs/remotes/origin/${t.branch}`], repo) } // best effort: the local branch and its remote-tracking ref, or a new worktree re-creates the old work
  resetCounts(db, id) // as queueTicket: builds and cost count from this retry, or a ticket near its cap is parked again at once
  setTicket(db, id, { status: "ready", branch: null, note: "retried from scratch by the owner" })
  return `#${id} back in the queue from scratch; a builder picks it up within about a minute.`
}

/** A closed PR's auto-fix wait must not outlive it, and a fix ticket aimed at its branch would push it back to life. */
function dropPrWork(db: DB, t: NonNullable<ReturnType<typeof getTicket>>, url: string | undefined) {
  const m = url?.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/)
  if (m) db.prepare("DELETE FROM kv WHERE k=?").run(`automerge:${m[1]}#${m[2]}`)
  db.prepare("UPDATE tickets SET status='declined', note='its PR was closed by the owner' WHERE onto IN (?, ?) AND status IN ('backlog','ready','approval')").run(`dobby/${t.id}`, t.branch ?? `dobby/${t.id}`)
}

export type CancelDeps = { r?: Run; kill?: (pgid: number) => void; projects?: Record<string, Project> }
const killGroup = (pgid: number) => { try { process.kill(-pgid, "SIGTERM") } catch {} }

/**
 * `dobby cancel <id>`: declined first (kv cancel:<id> stops the graph's ship), then SIGTERM only this ticket's recorded child groups
 * (kv pgid:<id>:<pid>; never the Dobby process, which hosts other builds), drop its worktree and branch, close its own PR with the branch.
 * A fix ticket (onto) leaves the PR it was fixing open.
 */
export function cancelTicket(db: DB, id: number, d: CancelDeps = {}): string {
  const { r = run, kill = killGroup, projects = loadProjects() } = d
  const t = getTicket(db, id)
  if (!t) return `no ticket #${id}`
  if (t.status === "shipped" || t.status === "declined") return `#${id} is already ${t.status}.`
  setTicket(db, id, { status: "declined", note: "cancelled by the owner" })
  if (db.prepare("SELECT 1 FROM kv WHERE k=?").get(`build:${id}`)) setKv(db, `cancel:${id}`, "1") // only a live build needs the guard; its end clears it
  const did: string[] = []
  const groups = (db.prepare("SELECT k FROM kv WHERE k LIKE ?").all(`pgid:${id}:%`) as { k: string }[]).map((x) => Number(x.k.split(":")[2])).filter((n) => n > 1)
  for (const g of groups) kill(g)
  db.prepare("DELETE FROM kv WHERE k LIKE ?").run(`pgid:${id}:%`)
  if (groups.length) did.push("Build stopped")
  const repo = projects[t.project]?.repo, branch = t.branch ?? `dobby/${id}`
  if (repo && /^[\w./-]+$/.test(branch) && !branch.startsWith("-")) {
    const wt = `${DATA}/wt/${t.project}-${id}`
    if (r("git", ["worktree", "remove", "--force", wt], repo).ok) did.push("worktree removed")
    r("git", ["branch", "-D", branch], repo) // best effort
  }
  const url = t.onto ? undefined : t.note?.match(PR_URL)?.[0]
  // by branch only a PR opened after this ticket: a fresh database reuses ids, and dobby/<id> may be an older install's PR
  const born = (db.prepare("SELECT created_at c FROM tickets WHERE id=?").get(id) as { c: string } | undefined)?.c ?? ""
  const ours = (b: string) => { const at = r("gh", ["pr", "view", b, "--json", "createdAt", "-q", ".createdAt"], repo).out.trim(); return !!at && at >= born }
  const target = url ?? (t.onto || !repo || !ours(branch) ? undefined : branch)
  if (target) {
    const c = r("gh", ["pr", "close", target, "--delete-branch"], repo) // a branch name needs the repo as cwd
    if (c.ok) (dropPrWork(db, t, url), did.push("PR closed"))
  }
  forget(db, id)
  return `Cancelled: ${shortTitle(t.title)}.${did.length ? ` ${did.join(", ")}.` : ""}`
}

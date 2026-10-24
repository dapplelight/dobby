// A ticket sitting in "fixing" for over 24h gets ONE #needs-you card (key stuck:<id>), edited on later ticks, never reposted.
// The Haiku summary is made once (kv stuck:top:<id>) and reused, so the owner-touch log counts one touch per card, not one per edit.
// Telegram has no edit: it gets the card once (kv stuck:sent:<id>). A ticket that leaves fixing settles its card to "Resolved".
import type { DB } from "./db.ts"
import { discordOn, kv, setKv, upsert } from "./discord.ts"
import { getTicket, loadProjects, resetCounts, setTicket, type Project } from "./lib.ts"
import { asIs, clip, needsYou, notify, shortTitle, type Buttons } from "./telegram.ts"
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
      await upsert(ddb, key, { kind: "stuck" }, text, buttons)
    } catch (e) {
      if (kv(ddb, `discord:msg:${key}`)) return console.log(`stuck: edit failed, card left as is: ${(e as Error).message}`) // posted before: no second pinged card
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
    if (discord || sent) setKv(db, discord ? `stuck:open:${t.id}` : `stuck:sent:${t.id}`, "1") // Telegram: only a delivered card counts as sent
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

const forget = (db: DB, id: number) => db.prepare("DELETE FROM kv WHERE k IN (?, ?, ?, ?)").run(`stuck:open:${id}`, `stuck:top:${id}`, `stuck:sent:${id}`, `discord:msg:stuck:${id}`)

/**
 * The card's buttons. retry = close the PR and its branch, back to ready (a builder starts from the base branch);
 * decline = close the PR, ticket declined. Anything not in fixing is left alone. The result text lands in the tapped message.
 */
export function stuckTap(db: DB, verb: "retry" | "decline", id: number, r: Run = run, projects: Record<string, Project> = loadProjects()): string {
  const t = getTicket(db, id)
  if (!t) return `no ticket #${id}`
  if (t.status !== "fixing") return (forget(db, id), `#${id} is ${t.status} now; nothing to do.`)
  const url = t.note?.match(PR_URL)?.[0]
  if (url) {
    const c = r("gh", ["pr", "close", url, "--delete-branch"])
    if (!c.ok && !/already closed/i.test(c.out)) return `Couldn't close the PR (${clip(c.out, 120)}); #${id} stays in fixing.`
  }
  const m = url?.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/)
  if (m) db.prepare("DELETE FROM kv WHERE k=?").run(`automerge:${m[1]}#${m[2]}`) // the closed PR's auto-fix wait must not outlive it
  db.prepare("UPDATE tickets SET status='declined', note='its PR was closed by the owner' WHERE onto IN (?, ?) AND status IN ('backlog','ready','approval')").run(`dobby/${id}`, t.branch ?? `dobby/${id}`) // a fix ticket aimed at the closed branch would push it back to life
  forget(db, id) // the tap result replaces the card text: nothing left to settle
  if (verb === "decline") return (setTicket(db, id, { status: "declined", note: `declined by the owner${url ? `: ${url}` : ""}` }), `#${id} declined.`)
  const repo = projects[t.project]?.repo
  if (repo && t.branch && /^[\w./-]+$/.test(t.branch) && !t.branch.startsWith("-")) { r("git", ["branch", "-D", t.branch], repo); r("git", ["update-ref", "-d", `refs/remotes/origin/${t.branch}`], repo) } // best effort: the local branch and its remote-tracking ref, or a new worktree re-creates the old work
  resetCounts(db, id) // as queueTicket: builds and cost count from this retry, or a ticket near its cap is parked again at once
  setTicket(db, id, { status: "ready", branch: null, note: "retried from scratch by the owner" })
  return `#${id} back in the queue from scratch; a builder picks it up within about a minute.`
}

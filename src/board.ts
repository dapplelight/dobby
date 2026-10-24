// The owner's view of the work (owner, 17 Oct: "I have no view of what's being built"): every ticket of an app with a
// GitHub repo is mirrored as an issue in that repo and as a card on that app's GitHub Project board (one per app, owner,
// one app in an org, another on a personal account: wherever the repo lives), in a column per stage. Dobby's DB stays the source of truth; the board is a one-way mirror, synced each tick and
// when a worker claims a ticket. PRs say "Closes #<issue>", so GitHub links them to the card.
// The board needs the gh token's `project` scope (owner runs `gh auth refresh -s project` once); until then only issues sync.
import type { DB } from "./db.ts"
import { run as realRun, type Run } from "./graphs/review.ts"
import { loadProjects } from "./lib.ts"
import { fetchMilestones } from "./milestones.ts"
import { redact } from "./telegram.ts"

export const STAGES = ["Backlog", "Ready", "Building", "In review", "Shipped", "Failed", "Declined"] as const
const STAGE_OF: Record<string, (typeof STAGES)[number]> = { backlog: "Backlog", ready: "Ready", running: "Building", fixing: "In review", approval: "In review", shipped: "Shipped", failed: "Failed", declined: "Declined", split: "Declined" }
export const stageOf = (status: string) => STAGE_OF[status] ?? "Backlog"
const CLOSED = new Set(["Shipped", "Declined"])
const PER_SYNC = 25 // new issues per sync; GitHub limits content creation, the backlog fills over a few ticks

const kv = (db: DB, k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
const setKv = (db: DB, k: string, v: string) => db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(k, v)
const json = (out: string) => { try { return JSON.parse(out) } catch { return null } }

type Board = { owner: string; id: string; number: number; url: string; field: string; options: Record<string, string> }

/** An app's board, created once where its repo lives: a project with a single-select "Stage" field. null when the token lacks the project scope. */
export function board(db: DB, app: string, repo: string, run: Run = realRun): Board | null {
  const saved = kv(db, `gh:board:${app}`)
  if (saved) return JSON.parse(saved)
  const owner = repo.split("/")[0]
  const made = run("gh", ["project", "create", "--owner", owner, "--title", app[0].toUpperCase() + app.slice(1), "--format", "json"])
  const p = made.ok && json(made.out)
  if (!p?.id) return null
  const f = run("gh", ["project", "field-create", String(p.number), "--owner", owner, "--name", "Stage", "--data-type", "SINGLE_SELECT", "--single-select-options", STAGES.join(","), "--format", "json"])
  const field = f.ok && json(f.out)
  if (!field?.id) return null
  const b: Board = { owner, id: p.id, number: p.number, url: p.url, field: field.id, options: Object.fromEntries((field.options ?? []).map((o: { name: string; id: string }) => [o.name, o.id])) }
  setKv(db, `gh:board:${app}`, JSON.stringify(b))
  return b
}

export const repoOf = (dir: string, run: Run) => {
  const r = run("git", ["remote", "get-url", "origin"], dir)
  return r.ok ? r.out.trim().replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "") || null : null
}

/** Mirror tickets to issues and board cards. `only` = one ticket (a worker just claimed it). Returns log lines. */
export function syncBoard(db: DB, o: { only?: number; run?: Run } = {}): string[] {
  const run = o.run ?? realRun
  const log: string[] = []
  const repos: Record<string, string> = {}
  for (const p of Object.values(loadProjects())) { const r = repoOf(p.repo, run); if (r) repos[p.name] = r }
  // goals: the repo's open milestones, read by syncGoals each tick; a failed read keeps the last list
  if (!o.only) for (const [app, repo] of Object.entries(repos)) { const ms = fetchMilestones(repo, run); if (ms) setKv(db, `gh:ms:${app}`, JSON.stringify(ms)) }
  const boards: Record<string, Board | null> = {}
  const rows = db.prepare(`SELECT t.id, t.project, t.title, t.done_when, t.status, g.milestone FROM tickets t LEFT JOIN goals g ON g.id=t.goal WHERE ${o.only ? "t.id=?" : "1"} ORDER BY t.priority DESC, t.id`).all(...(o.only ? [o.only] : [])) as { id: number; project: string; title: string; done_when: string | null; status: string; milestone: number | null }[]
  let created = 0, moved = 0
  for (const t of rows) {
    const repo = repos[t.project]
    if (!repo) continue
    const b = (boards[t.project] ??= board(db, t.project, repo, run))
    const stage = stageOf(t.status)
    let url = kv(db, `gh:issue:${t.id}`)
    if (!url) {
      if (CLOSED.has(stage) || created >= PER_SYNC) continue // history and overflow stay off the board
      const c = run("gh", ["issue", "create", "--repo", repo, "--title", redact(t.title.slice(0, 250)), "--body", redact(`${(t.done_when ?? "").slice(0, 60_000)}\n\n—\nForeman ticket #${t.id}. Dobby keeps this issue in sync; edits here are not read back.`)])
      if (!c.ok) { log.push(`board: #${t.id} issue failed: ${c.out.slice(0, 120)}`); continue }
      url = c.out.trim().split("\n").pop()!
      setKv(db, `gh:issue:${t.id}`, url)
      created++
    }
    // the issue sits in its goal's milestone (a few per sync, like new issues)
    if (t.milestone && kv(db, `gh:ms-of:${t.id}`) !== String(t.milestone) && moved < PER_SYNC) {
      const n = url.match(/\/issues\/(\d+)/)?.[1]
      if (n && run("gh", ["api", "-X", "PATCH", `repos/${repo}/issues/${n}`, "-F", `milestone=${t.milestone}`]).ok) setKv(db, `gh:ms-of:${t.id}`, String(t.milestone)), moved++
    }
    const last = kv(db, `gh:stage:${t.id}`)
    if (last === stage && (!b || kv(db, `gh:item:${t.id}`))) continue
    if (CLOSED.has(stage) !== CLOSED.has(last ?? "Backlog"))
      run("gh", CLOSED.has(stage) ? ["issue", "close", url, "--reason", stage === "Shipped" ? "completed" : "not planned"] : ["issue", "reopen", url])
    if (b) {
      let item = kv(db, `gh:item:${t.id}`)
      if (!item) {
        const a = run("gh", ["project", "item-add", String(b.number), "--owner", b.owner, "--url", url, "--format", "json"])
        item = (a.ok && json(a.out)?.id) || undefined
        if (item) setKv(db, `gh:item:${t.id}`, item)
      }
      if (item) run("gh", ["project", "item-edit", "--id", item, "--project-id", b.id, "--field-id", b.field, "--single-select-option-id", b.options[stage]])
    }
    setKv(db, `gh:stage:${t.id}`, stage)
  }
  if (moved) log.push(`board: ${moved} issue(s) moved to their goal's milestone`)
  if (created) log.push(`board: ${created} new issue(s)${Object.values(boards).some((b) => !b) ? " (a board waits for the project scope)" : ""}`)
  return log
}

/** "Closes owner/repo#N" for a ticket's PR body, so GitHub links the PR to the issue and closes it on merge. */
export function closesLine(db: DB, ticket: number) {
  const url = kv(db, `gh:issue:${ticket}`)
  const m = url?.match(/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/)
  return m ? `\nCloses ${m[1]}#${m[2]}` : ""
}

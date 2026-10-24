// Goals as GitHub milestones (owner, 24 Oct): each goal of an app is an open milestone in its repo, and each ticket's
// mirrored issue sits in its goal's milestone, so GitHub shows a due date and progress per goal. Read by the board sync.
import type { DB } from "./db.ts"
import { run as realRun, type Run } from "./graphs/review.ts"
import type { Goal, Milestone } from "./lib.ts"

const json = (out: string) => { try { return JSON.parse(out) } catch { return null } }

/** The repo's open milestones, or null when GitHub could not be read (the goals then stay as they are, never dropped). */
export function fetchMilestones(repo: string, run: Run = realRun): Milestone[] | null {
  const r = run("gh", ["api", `repos/${repo}/milestones?state=open&per_page=100`])
  const ms = r.ok ? json(r.out) : null
  return Array.isArray(ms) ? ms.map((m) => ({ number: m.number, title: m.title, description: m.description, due_on: m.due_on })) : null
}

/** A milestone title from a goal line: up to its first ":" or " (", at most 60 characters; the full line is the description. */
export function shortTitle(goal: string): string {
  const t = goal.replace(/^draft:\s*/i, "DRAFT: ").split(/:\s|\s\(/).slice(0, goal.toLowerCase().startsWith("draft:") ? 2 : 1).join(": ").trim()
  return t.length <= 60 ? t : `${t.slice(0, 60).replace(/\s+\S*$/, "")}…`
}

/** `dobby goals import <app>`: one milestone per goal from the file, linked to the same goal (ids and tickets kept). */
export function importGoals(db: DB, project: string, repo: string, run: Run = realRun): string[] {
  const gs = db.prepare("SELECT * FROM goals WHERE project=? AND status='active' AND milestone IS NULL ORDER BY rank").all(project) as Goal[]
  return gs.map((g) => {
    const r = run("gh", ["api", "-X", "POST", `repos/${repo}/milestones`, "-f", `title=${shortTitle(g.title)}`, "-f", `description=${g.title}`])
    const n = r.ok ? json(r.out)?.number : null
    if (!n) return `✗ ${g.title.slice(0, 60)}: ${r.out.trim().split("\n").pop()}`
    db.prepare("UPDATE goals SET milestone=? WHERE id=?").run(n, g.id)
    return `✓ milestone ${n}: ${shortTitle(g.title)}`
  })
}

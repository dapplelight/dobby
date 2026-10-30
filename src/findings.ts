// Review findings, one row each: the reviewer writes them (graphs/review.ts record step), the dashboard reads them (read-only handle),
// the finding actions (applyfinding, dismissfinding, findingrule) change their state from the CLI process.
// States: open, fixed (a later push no longer has it), queued (a fix ticket was filed), dismissed (owner: intentional), ruled (became a repo rule).
import type { DB } from "./db.ts"
import { clip } from "./notify.ts"

export type FindingIn = { path: string; line: number; severity: "high" | "medium" | "low"; problem: string; trigger?: string; fix?: string; suggestion?: string }
export type FindingRow = { id: number; repo: string; pr: number; sha: string; path: string; line: number; severity: string; kind: string; problem: string; fix: string; suggestion: string | null; round: number; state: string; at: string }
export const SEVERITY_WORD = { high: "Blocking", medium: "Should fix", low: "Nit" } as const

const KIND_RULES: [string, RegExp][] = [
  ["Security", /secur|inject|xss|csrf|auth|secret|token|password|sanitiz|escape|traversal|permission/i],
  ["Missing test", /\btests?\b|coverage|untested|assert/i],
  ["Accessibility", /a11y|accessib|aria|screen reader|contrast|keyboard|focus/i],
  ["Performance", /perform|slow|n\+1|latency|memory|leak|cache|O\(n|loop over|re-?render/i],
  ["Naming and style", /\bnam(e|ing)\b|style|typo|format|comment|lint|readab|rename|unused/i],
  ["Edge case", /edge|null|undefined|empty|overflow|race|boundary|off-by|crash|error|fail|undo|no way|missing|unhandled|invalid/i],
]
/** A rough kind from the finding's own words: the reviewer does not label them. First rule that matches wins; nothing matching is "Other". */
export const kindOf = (text: string) => KIND_RULES.find(([, re]) => re.test(text))?.[0] ?? "Other"

/** A path from a review is data: never absolute, never up a directory. Anything else is dropped before it is stored or shown. */
export const safePath = (p: string) => !!p && !p.startsWith("/") && !p.includes("\0") && !p.split(/[\\/]/).includes("..")

/** Store this head's findings, then settle the earlier open ones: gone from the new head (and not an open thread) = fixed. */
export function saveFindings(db: DB, repo: string, pr: number, sha: string, round: number, now: string, found: FindingIn[], keep: { path: string; line: number | null }[] = []) {
  const ins = db.prepare("INSERT OR IGNORE INTO findings (repo,pr,sha,path,line,severity,kind,problem,fix,suggestion,round,state,at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'open',?)")
  for (const f of found) if (safePath(f.path)) ins.run(repo, pr, sha, f.path, f.line, f.severity, kindOf(`${f.problem} ${f.fix ?? ""}`), clip(f.problem, 2000), clip(f.fix ?? "", 2000), f.suggestion ? f.suggestion.slice(0, 20_000) : null, round, now)
  const still = new Set([...found.map((f) => `${f.path}:${f.line}`), ...keep.map((k) => `${k.path}:${k.line}`)])
  const old = db.prepare("SELECT id, path, line FROM findings WHERE repo=? AND pr=? AND sha!=? AND state='open'").all(repo, pr, sha) as { id: number; path: string; line: number }[]
  const fix = db.prepare("UPDATE findings SET state='fixed' WHERE id=?"), again = db.prepare("DELETE FROM findings WHERE id=?")
  const reported = new Set(found.map((f) => `${f.path}:${f.line}`))
  for (const o of old) { const k = `${o.path}:${o.line}`; if (reported.has(k)) again.run(o.id); else if (!still.has(k)) fix.run(o.id) } // reported again: the new row carries it (one finding, not one per round) // ponytail: matched on path and line, so a push that shifts lines reads as fixed; match on a hash of the line's text if that bites
}

const q = <T>(db: DB, sql: string, ...a: unknown[]) => { try { return db.prepare(sql).all(...a) as T[] } catch { return [] as T[] } }
const COLS = "id, repo, pr, sha, path, line, severity, kind, problem, fix, suggestion, round, state, at"
export const findingById = (db: DB, id: number): FindingRow | undefined => q<FindingRow>(db, `SELECT ${COLS} FROM findings WHERE id=?`, id)[0]
/** All findings of one PR (matched on repo name + number: the owner part differs between forks), oldest first. */
export const findingsOf = (db: DB, repo: string, pr: number) => q<FindingRow>(db, `SELECT ${COLS} FROM findings WHERE pr=? AND repo LIKE ? ORDER BY id`, pr, `%/${repo.split("/").pop()}`)

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const WEEK = 7 * 86_400_000
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

/** The Reviews page's numbers for the 7 days ending at `now`. */
export function reviewNumbers(db: DB, now: number) {
  const since = new Date(now - WEEK).toISOString()
  const rv = q<{ repo: string; pr: number; verdict: string; at: string; took_ms: number | null }>(db, "SELECT repo, pr, verdict, at, took_ms FROM reviews WHERE verdict IN ('pass','fail') AND at>=?", since)
  const reviewed = new Set(rv.map((r) => `${r.repo.split("/").pop()}#${r.pr}`)).size
  const fs = q<{ severity: string; kind: string; state: string }>(db, "SELECT severity, kind, state FROM findings WHERE at>=?", since)
  const byKind = new Map<string, { b: number; s: number; n: number }>()
  for (const f of fs) { const k = byKind.get(f.kind) ?? { b: 0, s: 0, n: 0 }; k[f.severity === "high" ? "b" : f.severity === "medium" ? "s" : "n"]++; byKind.set(f.kind, k) }
  const kinds = [...byKind].map(([kind, c]) => ({ kind, ...c, total: c.b + c.s + c.n })).sort((a, b) => b.total - a.total)
  const n = (s: string) => fs.filter((f) => f.state === s).length
  const fixed = n("fixed") + n("queued") + n("ruled")
  // send-back rate per week: reviews that failed over reviews that passed or failed, six weeks ending now, oldest first
  const all = q<{ verdict: string; at: string }>(db, "SELECT verdict, at FROM reviews WHERE verdict IN ('pass','fail') AND at>=?", new Date(now - 6 * WEEK).toISOString())
  const weeks = Array.from({ length: 6 }, (_, i) => {
    const from = now - (6 - i) * WEEK, to = from + WEEK
    const w = all.filter((r) => Date.parse(r.at) >= from && Date.parse(r.at) < to)
    return { from, label: `${new Date(to - 1).getDate()} ${MONTHS[new Date(to - 1).getMonth()]}`, reviews: w.length, pct: w.length ? Math.round((100 * w.filter((r) => r.verdict === "fail").length) / w.length) : null }
  })
  const took = rv.map((r) => r.took_ms).filter((x): x is number => typeof x === "number" && x > 0)
  const m = median(took)
  const reverts = q<{ n: number }>(db, "SELECT count(*) n FROM runs WHERE human='reverted' AND at>=?", since)[0]?.n ?? 0
  return {
    reviewed, sentBackPct: rv.length ? Math.round((100 * rv.filter((r) => r.verdict === "fail").length) / rv.length) : null, medianMinutes: m === null ? null : Math.max(1, Math.round(m / 60_000)),
    findings: { total: fs.length, fixed, dismissed: n("dismissed"), open: n("open") }, fixedPct: fs.length ? Math.round((100 * fixed) / fs.length) : null, reverts, kinds, weeks,
  }
}
export type ReviewNumbers = ReturnType<typeof reviewNumbers>

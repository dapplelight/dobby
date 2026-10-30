// The one way Dobby merges a pull request, shared by the ticket graph's ship step and the review graph's automerge
// (a passed re-review after an auto-fix): checks green -> squash merge of the reviewed head (main moved: rebase once,
// re-verify, checks again, retry once) -> GitHub says MERGED. Only then may the caller deploy.
// gh and git get argument arrays only; `r` is stubbed in tests.
import type { ARun, Out } from "./lib.ts"
import { clip, redact } from "./notify.ts"
import { config } from "./config.ts"
import type { DB } from "./db.ts"
import { COST_MARK, PR_RE, prCost, prCostText } from "./savings.ts"

export type { Out }
/** transient: a network, timeout or unreadable-state failure (retry later); queued: a merge queue still held the PR; held: a pause stopped the merge (the reason). */
export type Land = Out & { conflicts?: string[]; transient?: boolean; queued?: boolean; held?: string }
/** Sleeps may be async (the real one) or sync (test stubs); both are awaited. */
type Sleep = (ms: number) => unknown
export type Check = { name: string; bucket: string; workflow?: string }

/** Dobby's own leftover GitHub Actions workflow "Claude Review" (its "review" job failed "Not logged in") and its "Claude Review" commit status: the review gates the merge separately, never as CI. */
export const foremanOwn = (c: Check) => c.workflow === "Claude Review" || c.name === "Claude Review"

const checkName = (c: Check) => (c.workflow ? `${c.name} (${c.workflow})` : c.name)
// DOBBY_SLEEP_SCALE: test-only multiplier for these waits (the end-to-end harness sets 0; unset = real time)
const sleepAsync = (ms: number) => new Promise<void>((r) => setTimeout(r, ms * Number(process.env.DOBBY_SLEEP_SCALE ?? 1)))

const NONE_POLLS = 6 // 30-second polls for a rebased head's checks to show up
/**
 * Wait for the PR's checks, ignoring Dobby's own review workflow. By default only the repo's required checks count (every
 * check but Dobby's review when it requires none): a failing one blocks, a pending one is waited for (up to 40 min).
 * mergeChecks: "all" or DOBBY_CHECKS=all counts every check, as before. The first failing check's name leads the
 * message. No checks at all merges as before.
 * Polls with an async sleep (audit #26: the blocking sleep froze every other worker for up to 40 min).
 */
export async function waitChecks(r: ARun, repo: string, pr: number, sleep: Sleep = sleepAsync, polls = 80, requiredOnly = (process.env.DOBBY_CHECKS ?? config().mergeChecks) !== "all", expect = false): Promise<Out & { none?: boolean; transient?: boolean }> {
  await sleep(20_000) // GitHub needs a moment to register a new head's checks
  let required = requiredOnly, none = 0
  for (let i = 0; ; i++) {
    const c = await r("gh", ["pr", "checks", String(pr), "-R", repo, ...(required ? ["--required"] : []), "--json", "name,bucket,workflow"])
    if (required && /no required checks reported/i.test(c.out)) { required = false; i--; continue }
    if (/no checks reported/i.test(c.out)) {
      if (!expect) return { ok: true, out: "no checks reported", none: true }
      // expect: the previous head had checks (a rebase's new head has not got its own yet), so none yet is pending, not a pass
      if (++none > NONE_POLLS) return { ok: false, out: `no checks appeared on the new head after ${NONE_POLLS / 2} min, although the old head had some. PR left open.` }
      await sleep(30_000); i--; continue
    }
    let rows: Check[]
    try { rows = JSON.parse(c.out.split("\n").find((l) => l.trim().startsWith("[")) ?? "") } catch { return { ok: false, transient: true, out: `could not read the checks, PR left open: ${clip(c.out, 200)}` } }
    const mine = rows.filter((x) => !foremanOwn(x))
    const bad = mine.filter((x) => x.bucket === "fail" || x.bucket === "cancel")
    if (bad.length) return { ok: false, out: `check failed: ${bad.map(checkName).join(", ")}. PR left open.` }
    const pending = mine.filter((x) => x.bucket === "pending")
    if (!pending.length) return { ok: true, out: `${required ? "required " : ""}checks passed (${mine.length})` }
    if (i >= polls) return { ok: false, transient: true, out: `checks still running after 40 min: ${pending.map(checkName).join(", ")} (is the self-hosted runner up?). PR left open.` }
    await sleep(30_000)
  }
}

/** Merge; if gh says the PR conflicts with base, rebase once, wait for checks on the new head, and retry the merge once. A failed rebase is returned as is (conflicts lists the files). */
type P<T> = T | Promise<T>
export async function mergeOrRebase(merge: () => P<Out>, rebase: () => P<Out & { conflicts?: string[] }>, checks: () => P<Out & { transient?: boolean }> = () => ({ ok: true, out: "" })): Promise<Out & { conflicts?: string[]; transient?: boolean }> {
  const m = await merge()
  // "base branch policy prohibits the merge" also says "not mergeable": a rebase cannot fix a policy
  if (m.ok || !/not mergeable|merge conflicts?/i.test(m.out) || /base branch policy prohibits/i.test(m.out)) return m
  const r = await rebase()
  if (!r.ok) return { ...r, out: `${clip(m.out, 200)}; ${r.out}` }
  const c = await checks() // the force-push gave the PR a new head: its checks and mergeability must settle before the retry
  return c.ok ? merge() : c
}

/** Verify runs in a git worktree, which lacks untracked files: tests that read one (a live statement PDF) should skip when DOBBY_WORKTREE is set. */
export const inWorktree = (cmd: string) => `export DOBBY_WORKTREE=1; ${cmd}`

/**
 * Rebase `branch` (as it is on origin: a fix push may be newer than the local branch) on origin/<base> in a throwaway
 * worktree, re-verify, push with a lease on the head that was reviewed (`expect`; default: origin's head as fetched).
 * The branch moved since the review = refused. A conflicted rebase is aborted and its files returned. `sha` = the pushed head.
 */
export async function rebaseAndPush(r: ARun, repo: string, wt: string, branch: string, base: string, verify: (wt: string) => P<Out>, expect?: string): Promise<Out & { conflicts?: string[]; sha?: string }> {
  await r("git", ["worktree", "remove", "--force", wt], repo)
  try {
    if (!(await r("git", ["fetch", "-q", "origin", base, branch], repo)).ok) return { ok: false, out: `rebase: can't fetch origin/${base} and ${branch}` }
    const at = (await r("git", ["rev-parse", `refs/remotes/origin/${branch}`], repo)).out.trim()
    if (expect && at !== expect) return { ok: false, out: `rebase: ${branch} moved since the review (${at.slice(0, 7)}, reviewed ${expect.slice(0, 7)}); not rebasing` }
    const add = await r("git", ["worktree", "add", "-B", branch, wt, `refs/remotes/origin/${branch}`], repo)
    if (!add.ok) return { ok: false, out: `rebase: ${clip(add.out, 200)}` }
    if (!(await r("git", ["rebase", `origin/${base}`], wt)).ok) {
      const conflicts = (await r("git", ["diff", "--name-only", "--diff-filter=U"], wt)).out.split("\n").filter(Boolean)
      await r("git", ["rebase", "--abort"], wt)
      return { ok: false, out: `rebase onto origin/${base} conflicts in ${conflicts.join(", ") || "?"}`, conflicts }
    }
    const v = await verify(wt)
    if (!v.ok) return { ok: false, out: `verify failed after rebase:\n${clip(v.out, 300)}` }
    const sha = (await r("git", ["rev-parse", "HEAD"], wt)).out.trim()
    return { ...(await r("git", ["push", `--force-with-lease=${branch}:${expect ?? at}`, "origin", branch], wt)), sha }
  } finally {
    await r("git", ["worktree", "remove", "--force", wt], repo)
  }
}

/** The PR's state from GitHub, asked up to 3 times. "" = unreadable (counts as not merged). */
async function prState(r: ARun, repo: string, pr: number, sleep: Sleep) {
  for (let i = 0; i < 3; i++) {
    if (i) await sleep(5_000)
    const v = await r("gh", ["pr", "view", String(pr), "-R", repo, "--json", "state", "-q", ".state"])
    const s = v.out.trim()
    if (v.ok && /^[A-Z]+$/.test(s)) return s
  }
  return ""
}

const QUEUE_POLLS = 60 // 30-second polls for a queued merge to land
/**
 * Checks -> merge of exactly the reviewed head `sha` (gh --match-head-commit; after a rebase, the pushed head) ->
 * confirmed MERGED on GitHub. `merge` is the gh argument list (ship merges by branch name in the repo so gh also drops
 * the local branch; the automerge merges by number with -R). `rebase(sha)` gets the head it must start from.
 */
export async function landPr(r: ARun, o: { repo: string; pr: number; sha: string; merge: string[]; cwd?: string; rebase: (sha: string) => P<Out & { conflicts?: string[]; sha?: string }>; sleep?: Sleep; held?: () => string | null }): Promise<Land> {
  const sleep = o.sleep ?? sleepAsync
  const checks = () => waitChecks(r, o.repo, o.pr, sleep)
  const c = await checks()
  if (!c.ok) return c
  const hadChecks = !c.none
  let head = o.sha, held = ""
  // a pause set during the waits above still stops the merge: asked right before every gh pr merge (the first try and the retry after a rebase)
  const merge = async (): Promise<Out> => { held = o.held?.() ?? ""; return held ? { ok: false, out: `merges ${held}` } : r("gh", [...o.merge, "--match-head-commit", head], o.cwd) }
  const m0 = await mergeOrRebase(merge, async () => { const x = await o.rebase(head); if (x.ok && x.sha) head = x.sha; return x }, () => waitChecks(r, o.repo, o.pr, sleep, undefined, undefined, hadChecks))
  if (held) return { ...m0, held }
  // gh answering that the PR is already queued or has auto-merge on means a queue holds it: wait for MERGED like a fresh queue entry
  const m = !m0.ok && /already (queued|in (the )?merge queue)|auto-?merge (is )?(already )?enabled|already.{0,20}merge queue/i.test(m0.out) ? { ok: true, out: m0.out } : m0
  // a merge queue or auto-merge leaves the PR open with gh exiting 0; a gh error after the merge went through still merged
  let state = await prState(r, o.repo, o.pr, sleep)
  for (let i = 0; m.ok && state === "OPEN" && i < QUEUE_POLLS; i++) { await sleep(30_000); state = await prState(r, o.repo, o.pr, sleep) } // gh exited 0 and the PR is open: a merge queue or auto-merge holds it, so wait for MERGED
  if (state === "MERGED") return m.ok ? m : { ok: true, out: `merged (gh said: ${clip(m.out, 120)})` }
  if (!m.ok) return /HTTP 5\d\d|could not resolve host|connection (reset|refused)|i\/o timeout|timed out/i.test(m.out) ? { ...m, transient: true } : m
  return state === "OPEN" ? { ok: false, transient: true, queued: true, out: `merge did not land: the PR is OPEN ${QUEUE_POLLS / 2} minutes after gh pr merge (a merge queue or auto-merge is holding it). Nothing deployed.` }
    : state ? { ok: false, out: `merge did not land: the PR is ${state} after gh pr merge. Nothing deployed.` }
    : { ok: false, transient: true, out: "merge not confirmed: GitHub's PR state was unreadable 3 times. Nothing deployed." }
}

/** Post the PR's cost comment, or update the one with the marker. Never throws and never fails a merge: a gh error is logged. config costComment:false = off. */
export async function postPrCost(r: ARun, db: DB, ticket: number, url: string, log: (s: string) => void = console.log) {
  const m = url.match(PR_RE)
  if (config().costComment === false || !m || !ticket) return
  try {
    const body = redact(prCostText(prCost(db, ticket, url), config().billing?.mode === "apiKey"))
    const f = await r("gh", ["api", `repos/${m[1]}/issues/${m[2]}/comments`, "--paginate", "--jq", `.[] | select(.body | contains("${COST_MARK}")) | .id`])
    const id = f.ok ? f.out.trim().split("\n")[0] : ""
    const w = id && /^\d+$/.test(id) ? await r("gh", ["api", "-X", "PATCH", `repos/${m[1]}/issues/comments/${id}`, "-f", `body=${body}`]) : await r("gh", ["api", "-X", "POST", `repos/${m[1]}/issues/${m[2]}/comments`, "-f", `body=${body}`])
    if (!w.ok) log(`cost comment on ${url}: ${clip(w.out, 150)}`)
  } catch (e) { log(`cost comment on ${url}: ${(e as Error).message}`) }
}

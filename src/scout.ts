// Talent Scout (owner, 17 Oct: "build and improve our systems daily"). Once a night it scans one role for better skills
// (rotating through every role), turns repeated review findings into rules, and does a retro on the last 24 hours.
// It proposes its own changes as pull requests (owner, 20 Oct; through review since the 20 Oct audit, item 5): a skill
// install or a learned rule is a PR from a fresh worktree of origin/main, reviewed strictly (sensitive paths) and merged by the
// review path, with a ↩️ Undo button in #dobby-ideas (a revert PR). Nothing is live until it merges and the owner's checkout
// pulls main. A retro fix is queued as a Dobby ticket. With `scout_merge: auto` (projects/foreman.md) no tap is needed:
// strict review + scoutInjection() on the diff, then the normal landPr; any failure closes the PR (scoutCard).
import { paused } from "./pause.ts"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { DATA, type DB } from "./db.ts"
import { addTicket, claude, repoArgs, fixed, isDuplicate, loadRole, netRun, parseDoc, ROOT, scoutMerge, type ARun } from "./lib.ts"
import { mergeFlags } from "./config.ts"
import { landPr } from "./merge.ts"
import { notLandable, reviewOnce, run, type Run } from "./graphs/review.ts"
import { notify, redact } from "./telegram.ts"

const today = () => new Date().toISOString().slice(0, 10)
const get = (db: DB, k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
const set = (db: DB, k: string, v: string) => db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(k, v)
export const roles = () => readdirSync(`${ROOT}roles`).filter((f) => f.endsWith(".md") && !["company.md", "scout.md"].includes(f)).map((f) => f.slice(0, -3)).sort()

/** Due once a day, at night (it runs on the night builders' budget). */
export const scoutDue = (db: DB, hour = new Date().getHours()) => (hour >= 23 || hour < 6) && get(db, "scout:last") !== today() && !paused(db, { kind: "scout" })

export type Proposal =
  | { type: "skill"; role: string; name: string; repo: string; path: string; sha: string; license: string; stars?: number; why: string }
  | { type: "retro"; title: string; why: string; experiment?: string }
  | { type: "rule"; file: string; rule: string; why: string }
/** Where a learned rule may go: every agent, one role, or one project's rules (all read fresh by the next run). */
const RULE_FILE = /^(agent-rules\.md|roles\/[\w-]+\.md|projects\/[a-z]+\.md)$/
const SAFE = /^(MIT|Apache-2\.0|BSD-[23]-Clause|ISC)$/

/** The Scout's JSON lines, strictly: unknown shapes, bad licenses and odd names are dropped. */
export function parseProposals(text: string): Proposal[] {
  const out: Proposal[] = []
  for (const line of text.split("\n")) {
    try {
      const p = JSON.parse(line.trim())
      if (p.type === "skill" && SAFE.test(p.license) && /^[\w.-]+\/[\w.-]+$/.test(p.repo) && /^[\w./-]+SKILL\.md$/.test(p.path) && /^[0-9a-f]{7,40}$/.test(p.sha) && /^[\w-]+$/.test(p.name)) out.push(p)
      else if (p.type === "retro" && p.title && p.why) out.push(p)
      else if (p.type === "rule" && RULE_FILE.test(p.file) && typeof p.rule === "string" && p.rule.trim() && !/\n/.test(p.rule) && p.rule.length <= 300 && p.why) out.push(p)
    } catch {}
  }
  return out
}

/** Review findings of the last 7 days, one line each: what the Claude Reviewer kept sending back. */
export function reviewFindings(db: DB, since = new Date(Date.now() - 7 * 86400_000).toISOString()): string[] {
  const rows = db.prepare("SELECT id, project, done_when FROM tickets WHERE title LIKE 'Fix review findings%' AND created_at>=?").all(since) as { id: number; project: string; done_when: string }[]
  return rows.flatMap((t) => t.done_when.split("\n").filter((l) => l.startsWith("- [")).map((l) => `${t.project} #${t.id} ${l.slice(2, 260)}`)).slice(0, 80)
}

export type Applied = { msg: string; sha?: string; pr?: string; branch?: string; pushed?: boolean; why?: string }
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "change"
const LIVE_NOTE = "It goes live only after you approve it, it merges, and your checkout pulls main (nothing pulls it automatically)."

/**
 * A Scout change (or its Undo) as a pull request, never in the owner's checkout and never pushed to main (audit 20 Oct, item 5:
 * the old commit + `pull --rebase --autostash` + `push HEAD:main` in ROOT swept up the owner's own edits and flattened merges).
 * A fresh worktree from origin/main (local main if origin can't be fetched) on branch scout/<date>-<slug>; `apply` makes the
 * commit there; the branch is pushed and a PR opened (argument arrays only). Changing what agents may do is the owner's call
 * (projects/foreman.md): scoutCard() runs the strict review, then posts Approve / Reject (scout_merge: ask, the default) or merges after an injection check (scout_merge: auto).
 * Push or PR failure: the branch stays, the owner hears it through fixed(). The worktree is always removed.
 */
export function throughPr(db: DB, o: { slug: string; title: string; body: string; apply: (wt: string) => string | null }, r: Run = run, root = ROOT): Applied {
  // never based on a stale local main (security review 20 Oct): no fresh origin/main, no change
  if (!r("git", ["fetch", "-q", "origin", "main"], root).ok) return { msg: `couldn't fetch origin/main, so nothing changed for ${o.title}` }
  const base = "origin/main"
  let branch = `scout/${today()}-${slugify(o.slug)}`
  if (r("git", ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], root).ok) branch += `-${Date.now().toString(36).slice(-5)}`
  const wt = `${DATA}/wt/${branch.replace("/", "-")}`
  mkdirSync(`${DATA}/wt`, { recursive: true })
  r("git", ["worktree", "remove", "--force", wt], root)
  const add = r("git", ["worktree", "add", "-q", "--no-track", "-b", branch, wt, base], root)
  if (!add.ok) return { msg: `couldn't make a worktree for ${o.title}: ${add.out.slice(0, 150)}` }
  try {
    const start = r("git", ["rev-parse", "HEAD"], wt).out.trim()
    const bad = o.apply(wt)
    const sha = r("git", ["rev-parse", "HEAD"], wt).out.trim()
    if (bad || sha === start) {
      r("git", ["worktree", "remove", "--force", wt], root)
      r("git", ["branch", "-D", branch], root)
      return { msg: bad ?? `nothing to change for ${o.title}` }
    }
    const push = r("git", ["push", "-q", "origin", `${branch}:refs/heads/${branch}`], wt)
    const pr = push.ok ? r("gh", ["pr", "create", ...repoArgs(root, (a, c) => r("git", a, c)), "--head", branch, "--base", "main", "--title", redact(o.title.slice(0, 250)), "--body", redact(`${o.body}\n\n${LIVE_NOTE}`)], wt) : push
    const url = pr.ok ? pr.out.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/)?.[0] : undefined
    if (!url) {
      fixed(db, `The Talent Scout made a change (${o.title}) but couldn't ${push.ok ? "open its pull request" : "push its branch"}. It is kept on the local branch ${branch}; nothing is live.`)
      return { msg: o.title, sha, branch, pushed: false }
    }
    return { msg: o.title, sha, pr: url, branch, pushed: true }
  } finally {
    r("git", ["worktree", "remove", "--force", wt], root)
  }
}

/**
 * Deterministic injection check on a Scout PR's diff (unified, from `gh pr diff`): what the added lines and file names
 * must not contain. Returns the reasons, [] = clean. Fail closed: a skill that quotes a bad pattern is rejected too.
 * ponytail: regexes catch the known tricks, not paraphrases; the strict Opus review is the other half.
 */
const BAD_FILE = /(agent-settings\.json|bin\/guard-hook\.mjs)(\s|$)/
const HIDDEN = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u
const BAD_LINE: [RegExp, string][] = [
  [/\b(?:ignore|disregard|forget|override)\b[^\n]{0,40}\b(?:previous|prior|above|earlier|preceding|all)\b[^\n]{0,40}\b(?:instructions?|rules?|prompts?)\b/i, "tells the agent to ignore earlier instructions"],
  [/\byou are now\b/i, "\"you are now\" role switch"],
  [/system[ -]prompt/i, "mentions the system prompt"],
  [/\ballowedTools\b|\bdisallowedTools\b|--dangerously|dangerously-skip|bypassPermissions|\bnew permissions?\b|["']?permissions["']?\s*:/i, "touches permissions or tool allowlists"],
  [/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i, "pipes a download into a shell"],
  [/[A-Za-z0-9+/]{200,}={0,2}/, "a base64-like blob over 200 characters"],
  [HIDDEN, "hidden or bidirectional unicode characters"],
]
const OK_HOST = /(^|\.)(github\.com|githubusercontent\.com|npmjs\.com|npmjs\.org)$/i
export function scoutInjection(diff: string): string[] {
  const why = new Set<string>()
  let hunk = false
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) {
      hunk = false
      if (BAD_FILE.test(l)) why.add("edits agent-settings.json or bin/guard-hook.mjs")
    } else if (l.startsWith("@@")) hunk = true
    else if (!hunk && /^(\+\+\+|---) /.test(l)) { if (BAD_FILE.test(l)) why.add("edits agent-settings.json or bin/guard-hook.mjs") }
    else if (hunk && l.startsWith("+")) {
      const t = l.slice(1)
      for (const [re, w] of BAD_LINE) if (re.test(t)) why.add(w)
      for (const u of t.matchAll(/https?:\/\/([^/\s)"'>`\]]+)/gi)) if (!OK_HOST.test(u[1].replace(/:\d+$/, "").replace(/^[^@]*@/, ""))) why.add(`links to ${u[1]} (only github and npm hosts)`)
    }
  }
  return [...why]
}

/** Scout PR without a tap (`scout_merge: auto`): strict review + scoutInjection, then the normal landPr. Pass: merged note with Undo. Fail: PR closed, one #needs-you line. */
async function scoutAuto(db: DB, out: Applied, repo: string, n: number, review: (repo: string, n: number) => Promise<{ state: string; why: string }>, say: typeof notify, sh: ARun, sleep?: (ms: number) => void | Promise<void>): Promise<string> {
  const line = (head: string, why: string) => say(`🎓 ${head} · ${out.msg}\n${why}\n${out.pr}`, fetch, undefined, { kind: "approval" })
  const reject = async (why: string) => {
    await sh("gh", ["pr", "close", String(n), "-R", repo, "--delete-branch", "--comment", redact(`Closed by Dobby: ${why}`)])
    await line("Scout change rejected, PR closed", why)
    return `rejected: ${why}`
  }
  // "busy" = another review of this head is running: never a reason to close. Wait and ask again (3 tries), then leave it open.
  let r = { state: "busy", why: "" }
  for (let i = 0; i < 3 && r.state === "busy"; i++) {
    if (i) await (sleep ?? ((ms: number) => new Promise((res) => setTimeout(res, ms))))(5 * 60_000)
    r = await review(repo, n).catch((e: Error) => ({ state: "error", why: e.message }))
  }
  if (r.state === "busy") { await line("Scout change left open (another review of it kept running)", "Approve or close it by hand, or wait for the next Scout run."); return `left open: ${r.why || "busy"}` }
  if (r.state === "paused") return `left open: ${r.why}` // reviews paused: the PR waits, nothing is closed
  if (r.state === "error") { await line("Scout change left open (the review could not run)", r.why); return `left open: ${r.why}` }
  if (r.state !== "success") return reject(`the strict review ${r.state}: ${r.why}`)
  const v = await sh("gh", ["pr", "view", String(n), "-R", repo, "--json", "headRefName,headRefOid,state"])
  const pr = v.ok ? (JSON.parse(v.out) as { headRefName: string; headRefOid: string; state: string }) : null
  if (!pr || !pr.headRefName.startsWith("scout/") || pr.state !== "OPEN") return `left open: ${repo}#${n} is not an open Scout pull request`
  const no = notLandable(db, repo, n, pr.headRefOid, true)
  if (no) return reject(`the strict review does not cover the current head: ${no}`)
  const d = await sh("gh", ["pr", "diff", String(n), "-R", repo])
  if (!d.ok) return reject("its diff could not be read, so the injection check could not run")
  const bad = scoutInjection(d.out)
  if (bad.length) return reject(`the injection check failed: ${bad.join("; ")}`)
  const mp = paused(db, { kind: "merges", project: "dobby" })
  if (mp) return `left open: merges ${mp}`
  const m = await landPr(sh, { repo, pr: n, sha: pr.headRefOid, merge: ["pr", "merge", String(n), "-R", repo, ...mergeFlags()], rebase: () => ({ ok: false, out: "a Scout branch is never rebased" }), sleep })
  if (!m.ok) { await line("Scout change passed review but did not merge, PR left open", m.out.slice(0, 300)); return `left open: ${m.out.slice(0, 120)}` }
  await say(`🎓 Scout change merged · ${out.msg}${out.why ? `\nWhy: ${out.why}` : ""}\nStrict review passed, injection check clean. ${out.pr}\nIt is live once your checkout pulls main.`,
    fetch, out.sha ? [{ text: "↩️ Undo", data: `undo-scout ${out.sha.slice(0, 12)}` }] : undefined, { kind: "idea", project: "dobby" })
  return `merged ${out.pr}`
}

/**
 * A Scout PR: the strict review runs now. scout_merge ask (default): one #needs-you card with Approve / Reject.
 * auto: scoutAuto(), no tap. `o.mode`/`o.sh`/`o.sleep` are for tests.
 */
// reviewOnce strict: a finished Opus verdict on this head stands; anything else (or none) gets a strict review now; a running
// review is waited for, not doubled.
export async function scoutCard(db: DB, out: Applied, review = (repo: string, n: number) => reviewOnce(db, repo, n, { strict: true }), say = notify, o: { mode?: "auto" | "ask"; sh?: ARun; sleep?: (ms: number) => void | Promise<void> } = {}): Promise<string> {
  const m = out.pr?.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/)
  if (!m) return ""
  if ((o.mode ?? scoutMerge()) === "auto") return scoutAuto(db, out, m[1], Number(m[2]), review, say, o.sh ?? netRun, o.sleep)
  const r = await review(m[1], Number(m[2])).catch((e: Error) => ({ state: "error", why: e.message }))
  const passed = r.state === "success"
  await say(`🎓 Scout change waits for your OK · ${out.msg}\nReview: ${passed ? "passed" : `${r.state}, ${r.why}`}\n${out.pr}\n${passed ? "Approve merges it; Reject closes it." : "Approve works once the review passes (or you accept the review); Reject closes it."} ${LIVE_NOTE}`,
    fetch, [{ text: "✅ Approve", data: `scoutmerge ${m[1]} ${m[2]}` }, { text: "🗑 Reject", data: `scoutreject ${m[1]} ${m[2]}` }, { text: "🔗 Open PR", data: "", url: out.pr }], { kind: "approval" })
  return `review ${r.state}, waiting for the owner`
}

const okPr = (repo: string, n: number) => /^[\w.-]+\/[\w.-]+$/.test(repo) && Number.isInteger(n) && n > 0
/** ✅ Approve on a Scout card: merge (the same squash merge as every Dobby PR) only an open scout/ PR whose current head passed a strict (Opus) review or was accepted. */
export function mergeScout(db: DB, repo: string, n: number, r: Run = run): string {
  if (!okPr(repo, n)) return "usage: scoutmerge <owner/repo> <pr>"
  const v = r("gh", ["pr", "view", String(n), "-R", repo, "--json", "headRefName,headRefOid,state,url"])
  if (!v.ok) return `Couldn't read ${repo}#${n}`
  const pr = JSON.parse(v.out) as { headRefName: string; headRefOid: string; state: string; url: string }
  if (!pr.headRefName.startsWith("scout/") || pr.state !== "OPEN") return `${pr.url} is not an open Scout pull request`
  if (notLandable(db, repo, n, pr.headRefOid, true)) return `Not merged: the strict (Opus) review of ${pr.url} has not passed on its current head. Accept the review first if you want it anyway.`
  const m = r("gh", ["pr", "merge", String(n), "-R", repo, ...mergeFlags()])
  return m.ok ? `✅ Merged ${pr.url}. ${"It is live once your checkout pulls main."}` : `🔴 Couldn't merge ${pr.url}: ${m.out.slice(0, 200)}`
}
/** 🗑 Reject on a Scout card: close the scout/ PR and delete its branch. */
export function rejectScout(db: DB, repo: string, n: number, r: Run = run): string {
  if (!okPr(repo, n)) return "usage: scoutreject <owner/repo> <pr>"
  const v = r("gh", ["pr", "view", String(n), "-R", repo, "--json", "headRefName,state,url"])
  const pr = v.ok ? (JSON.parse(v.out) as { headRefName: string; state: string; url: string }) : null
  if (!pr?.headRefName.startsWith("scout/") || pr.state !== "OPEN") return `${repo}#${n} is not an open Scout pull request`
  const c = r("gh", ["pr", "close", String(n), "-R", repo, "--delete-branch", "--comment", "Rejected by the owner."])
  return c.ok ? `🗑 Rejected and closed ${pr.url}.` : `🔴 Couldn't close ${pr.url}: ${c.out.slice(0, 200)}`
}

/** ↩️ Undo on a Scout change: a revert PR when the change is on main, closing its PR when it never merged. Never touches the owner's checkout. */
export async function undoScout(db: DB, sha: string, r: Run = run, root = ROOT, card = scoutCard): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return "usage: undo-scout <commit>"
  if (!r("git", ["fetch", "-q", "origin", "main"], root).ok) return "↩️ Couldn't fetch origin/main; nothing changed. Try again later."
  const base = "origin/main"
  let target = r("git", ["merge-base", "--is-ancestor", sha, base], root).ok ? sha : ""
  if (!target) {
    // a Scout branch commit: its PR was squash-merged (revert the merge commit) or is still open (close it: nothing went live)
    const l = r("gh", ["pr", "list", "--state", "all", "--search", sha, "--json", "number,state,url,mergeCommit"], root)
    const pr = (l.ok ? (JSON.parse(l.out || "[]") as { number: number; state: string; url: string; mergeCommit?: { oid: string } | null }[]) : [])[0]
    if (!pr) return `↩️ Couldn't find ${sha.slice(0, 12)} on main or in a pull request. Revert it by hand.`
    if (pr.state === "OPEN") {
      const c = r("gh", ["pr", "close", String(pr.number), "--delete-branch", "--comment", "Undone by the owner (↩️ Undo): this Scout change never went live."], root)
      return c.ok ? `↩️ Undone: the change never merged, so its pull request is closed (${pr.url}).` : `↩️ Couldn't close ${pr.url}: ${c.out.slice(0, 150)}`
    }
    if (pr.state !== "MERGED" || !pr.mergeCommit?.oid) return `↩️ Nothing to undo: ${pr.url} is ${pr.state.toLowerCase()}.`
    target = pr.mergeCommit.oid
  }
  const subject = r("git", ["log", "-1", "--format=%s", target], root).out.trim() || target.slice(0, 12)
  const out = throughPr(db, {
    slug: `undo-${target.slice(0, 7)}`, title: `Undo Scout change: ${subject}`.slice(0, 200), body: `Reverts ${target} (the owner tapped ↩️ Undo).`,
    apply: (wt) => {
      if (r("git", ["revert", "--no-edit", target], wt).ok) return null
      r("git", ["revert", "--abort"], wt)
      return `↩️ Couldn't undo ${target.slice(0, 12)}: it conflicts with later changes. Revert it by hand.`
    },
  }, r, root)
  if (!out.sha) return out.msg
  if (out.pr) await card(db, out)
  return out.pr ? `↩️ Undo opened as a pull request: ${out.pr}. ${LIVE_NOTE}` : `↩️ Undo is committed on the local branch ${out.branch}, but the push or pull request failed; nothing is live.`
}

/** A learned rule goes under "## Learned from reviews" at the end of its file, once. */
export function addRule(text: string, rule: string): string {
  const line = `- ${rule.trim()}`
  if (text.includes(line)) return text
  return /\n## Learned from reviews\n/.test(text) ? `${text.trimEnd()}\n${line}\n` : `${text.trimEnd()}\n\n## Learned from reviews\n${line}\n`
}

/** The #dobby-ideas line for an applied (or failed) Scout change. */
export const scoutSays = (out: Applied, why?: string) =>
  out.sha ? `🎓 ${out.msg}${why ? `\nWhy: ${why}` : ""}\n${out.pr ? `Pull request: ${out.pr}\n${LIVE_NOTE}` : `Kept on the local branch ${out.branch}: the push or pull request failed, nothing is live.`}` : `🎓 Couldn't apply: ${out.msg}`

export type Say = (text: string, buttons?: { text: string; data: string }[]) => Promise<unknown>

export async function scout(db: DB, say: Say) {
  const pz = paused(db, { kind: "scout" })
  if (pz) return `scout ${pz}`
  const list = roles()
  const role = list[Number(get(db, "scout:next") ?? 0) % list.length]
  set(db, "scout:next", String((list.indexOf(role) + 1) % list.length))
  set(db, "scout:last", today())
  const r = loadRole(role)
  const since = new Date(Date.now() - 86400_000).toISOString()
  const fails = [
    ...(db.prepare("SELECT kind, project, ticket, model, reason FROM runs WHERE at>=? AND ok=0 LIMIT 40").all(since) as Record<string, string>[]).map((x) => `run ${x.kind} ${x.project} #${x.ticket ?? "-"} ${x.model}: ${String(x.reason ?? "").slice(0, 200)}`),
    ...(db.prepare("SELECT id, project, status, note FROM tickets WHERE updated_at>=? AND status IN ('failed','declined') LIMIT 20").all(since) as Record<string, string>[]).map((t) => `ticket #${t.id} ${t.project} ${t.status}: ${String(t.note ?? "").slice(0, 200)}`),
  ]
  const prompt = `${loadRole("scout").body.replaceAll("{role}", role)}\n\nTHE ROLE "${role}":\n${r.body.slice(0, 3000)}\n\nIT ALREADY HAS THESE SKILLS: ${r.meta.skills || "none"}\nINSTALLED FOR THE OWNER: ${existsSync(`${process.env.HOME}/.claude/skills`) ? readdirSync(`${process.env.HOME}/.claude/skills`).join(", ") : "none"}\n\nLAST 24 HOURS, FAILURES:\n${fails.join("\n") || "(none)"}\n\nLAST 7 DAYS, REVIEW FINDINGS (project #fix-ticket [severity] file:line finding):\n${reviewFindings(db).join("\n") || "(none)"}`
  const res = await claude(db, { project: "dobby", kind: "scout", model: loadRole("scout").meta.model ?? "opus", effort: loadRole("scout").meta.effort, cwd: ROOT, prompt,
    args: ["--setting-sources", "project", "--allowedTools", "Read,Grep,Glob,Bash(npx -y skills find:*),Bash(gh api:*),WebSearch,WebFetch", "--disallowedTools", "Edit,Write,NotebookEdit"] })
  if (!res.ok) return `scout (${role}): failed, ${res.reason}`
  const ins = db.prepare("INSERT INTO ideas (project,title,source,lens,why,evidence,experiment,size,status,created_at) VALUES ('dobby',?,'scout',?,?,?,?,'S','approved',?) RETURNING id")
  const done: string[] = []
  for (const p of parseProposals(res.text)) {
    const title = p.type === "skill" ? `Give ${p.role} the skill ${p.name} (${p.repo}, ${p.license}${p.stars ? `, ${p.stars}★` : ""})` : p.type === "rule" ? `Rule for ${p.file}: ${p.rule}`.slice(0, 200) : p.title
    if (isDuplicate(db, "dobby", title)) continue
    ins.get(title, p.type, p.why, JSON.stringify(p), p.type === "retro" ? p.experiment ?? null : null, new Date().toISOString())
    if (p.type === "retro") {
      const { id } = addTicket(db, { project: "dobby", title: p.title.slice(0, 200), done_when: p.experiment ?? "", size: "S" })
      await say(`🎓 Queued: ${p.title} · #${id}\nWhy: ${p.why}`)
      done.push(`queued #${id}`)
      continue
    }
    const out = p.type === "skill" ? installSkill(db, p) : applyRule(db, p)
    // auto mode: scoutCard's own merged note (with Undo) or rejection line replaces this post
    const res = out.pr ? await scoutCard(db, { ...out, why: p.why }) : ""
    if (!/^(merged|rejected)/.test(res)) await say(scoutSays(out, p.why), out.sha ? [{ text: "↩️ Undo", data: `undo-scout ${out.sha.slice(0, 12)}` }] : undefined)
    done.push(out.msg)
  }
  return `scout (${role}): ${done.length ? done.join("; ") : "nothing to change"}`
}

/** Commit these paths in the worktree. null = done, else why not. */
const commitIn = (r: Run, wt: string, paths: string[], msg: string) =>
  r("git", ["add", "--", ...paths], wt).ok && r("git", ["commit", "-q", "-m", redact(msg), "--", ...paths], wt).ok ? null : `couldn't commit ${paths.join(", ")}`

/** Add a learned rule to its file (as it is on origin/main) in a Scout pull request. */
export function applyRule(db: DB, p: Extract<Proposal, { type: "rule" }>, r: Run = run, root = ROOT): Applied {
  const msg = `New rule in ${p.file}: ${p.rule}`
  const out = throughPr(db, {
    slug: `rule-${p.file.replace(/\.md$/, "")}`, title: `Scout: learned rule for ${p.file}`, body: `${msg}\n\nWhy: ${p.why}`,
    apply: (wt) => {
      const f = `${wt}/${p.file}`
      if (!existsSync(f)) return `no file ${p.file}`
      const before = readFileSync(f, "utf8"), after = addRule(before, p.rule)
      if (after === before) return `rule already in ${p.file}`
      writeFileSync(f, after)
      return commitIn(r, wt, [p.file], `Scout: learned rule for ${p.file}: ${p.rule}`.slice(0, 200) + `\n\n${p.why}`)
    },
  }, r, root)
  return out.sha ? { ...out, msg } : out
}

/** Copy that SKILL.md (at the commit the Scout read) into skills/<name>/ and list it on the role, in a Scout pull request. */
export function installSkill(db: DB, p: Extract<Proposal, { type: "skill" }>, r: Run = run, root = ROOT): Applied {
  const got = r("gh", ["api", `repos/${p.repo}/contents/${p.path}?ref=${p.sha}`, "--jq", ".content"])
  if (!got.ok) return { msg: `couldn't fetch ${p.repo}/${p.path}: ${got.out.slice(0, 150)}` }
  const text = Buffer.from(got.out.trim(), "base64").toString("utf8")
  const msg = `Installed skill ${p.name} for ${p.role} (${p.repo} @ ${p.sha.slice(0, 7)})`
  const out = throughPr(db, {
    slug: `skill-${p.name}-${p.role}`, title: `Scout: give ${p.role} the skill ${p.name}`, body: `${msg}, ${p.license}.\n\nWhy: ${p.why}`,
    apply: (wt) => {
      const f = `${wt}/roles/${p.role}.md`
      if (!existsSync(f)) return `no role ${p.role}`
      mkdirSync(`${wt}/skills/${p.name}`, { recursive: true })
      writeFileSync(`${wt}/skills/${p.name}/SKILL.md`, `<!-- from ${p.repo}/${p.path} @ ${p.sha} (${p.license}), installed ${today()} after owner 👍 -->\n${text}`)
      const src = readFileSync(f, "utf8")
      const have = (parseDoc(src).meta.skills ?? "").split(",").map((s) => s.trim()).filter(Boolean)
      if (!have.includes(p.name)) {
        const next = [...have, p.name].join(", ")
        writeFileSync(f, have.length ? src.replace(/^skills:.*$/m, `skills: ${next}`) : src.replace(/^---\n/, `---\nskills: ${next}\n`))
      }
      return commitIn(r, wt, [`skills/${p.name}/SKILL.md`, `roles/${p.role}.md`], `Scout: ${msg}`)
    },
  }, r, root)
  return out.sha ? { ...out, msg } : out
}

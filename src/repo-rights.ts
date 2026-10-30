// What Dobby's PRs need from GitHub on a repo, read at setup (and by the browser setup): can this account push, does the
// base branch want a second reviewer, which merge methods are allowed, a merge queue, signed commits, an SSO block.
// Read-only: `gh api` GETs through an injected probe, no model, no writes. Rows use the same shape as the setup checks.
import type { Check, Probe } from "./checks.ts"

export type Method = "squash" | "merge" | "rebase"
export type RepoRow = Check & { set?: { key: string; value: string } }

const json = (s: string) => { try { return JSON.parse(s) } catch { return null } }
const line = (s: string) => s.trim().split("\n")[0]?.slice(0, 160) ?? ""
/** Offline or GitHub down: a different problem from being signed out. */
export const ghOffline = (out: string) => /error connecting|could not resolve host|no such host|dial tcp|network is unreachable|i\/o timeout|timed out|connection (refused|reset)|\b50[234]\b/i.test(out)
/** The page that authorizes the token for an org with SAML SSO, from a gh error; "" when it is not an SSO error. */
export function samlUrl(out: string): string {
  if (!/SAML|SSO/i.test(out)) return ""
  return out.match(/https:\/\/github\.com\/orgs\/[^\s)'"]+\/sso[^\s)'"]*/)?.[0] ?? "https://github.com/settings/applications"
}
/** Accounts `gh auth status` lists, for `gh auth switch`. */
export const ghAccounts = (out: string) => [...new Set([...out.matchAll(/account (\S+)/g)].map((m) => m[1]))]

/** One row for the access probe; the rest need a readable repo. `base` defaults to the repo's default branch; `method` is github.mergeMethod as configured (unset = squash). */
export async function repoRights(repo: string, o: { probe?: Probe; base?: string; method?: Method } = {}): Promise<RepoRow[]> {
  const probe = o.probe ?? (await import("./checks.ts")).realProbe, name = `GitHub access: ${repo}`
  const info = await probe("gh", ["api", `repos/${repo}`])
  if (!info.ok) {
    const sso = samlUrl(info.out)
    if (sso) return [{ name, ok: false, detail: "the organization requires SSO for this token", fix: `authorize it at ${sso}`, required: false }]
    if (ghOffline(info.out)) return [{ name, ok: false, detail: "can't reach GitHub", fix: "check your connection, then run dobby init again", required: false, offline: true }]
    if (/Not Found|404/.test(info.out)) {
      const who = ghAccounts((await probe("gh", ["auth", "status"])).out)
      return [{ name, ok: false, detail: `GitHub shows no ${repo} to this account (wrong account, or no access)`, fix: `gh auth switch${who.length > 1 ? ` (signed in: ${who.join(", ")})` : ""}`, required: false }]
    }
    return [{ name, ok: false, detail: line(info.out) || "could not read the repo", fix: "gh auth status", required: false }]
  }
  const r = json(info.out) ?? {}
  if (r.permissions && r.permissions.push === false) {
    const who = ghAccounts((await probe("gh", ["auth", "status"])).out)
    return [{ name, ok: false, detail: "this account can read the repo but not push", fix: who.length > 1 ? `gh auth switch (signed in: ${who.join(", ")}), or ask for write access` : "ask for write access, or gh auth login with the account that has it", required: true }]
  }
  const rows: RepoRow[] = [{ name, ok: true, detail: r.permissions?.admin ? "can push and merge (admin)" : "can push", required: true }]
  const base = o.base || r.default_branch || "main", method = o.method ?? "squash"
  const allowed: Record<Method, boolean> = { squash: r.allow_squash_merge !== false, merge: r.allow_merge_commit !== false, rebase: r.allow_rebase_merge !== false }
  if (!allowed[method]) {
    const alt = (["squash", "merge", "rebase"] as const).find((m) => allowed[m])
    rows.push({ name: `Merge method: ${repo}`, ok: false, detail: `${method} merges are turned off`, fix: alt ? `set github.mergeMethod to "${alt}"` : "turn a merge method on in the repo settings", required: false, ...(alt ? { set: { key: "github.mergeMethod", value: alt } } : {}) })
  }
  const enc = base.split("/").map(encodeURIComponent).join("/")
  const [prot, rules] = await Promise.all([probe("gh", ["api", `repos/${repo}/branches/${enc}/protection`]), probe("gh", ["api", `repos/${repo}/rules/branches/${enc}`])])
  const p = prot.ok ? json(prot.out) : null, rs: { type: string; parameters?: Record<string, unknown> }[] = (rules.ok ? json(rules.out) : null) ?? []
  const pr = p?.required_pull_request_reviews, rule = rs.find((x) => x.type === "pull_request")?.parameters
  const need = Math.max(Number(pr?.required_approving_review_count ?? 0), Number(rule?.required_approving_review_count ?? 0))
  const owners = !!(pr?.require_code_owner_reviews || rule?.require_code_owner_review)
  if (need > 0 || owners)
    rows.push({ name: `Review rules: ${repo}`, ok: false, detail: `${base} needs ${owners && !need ? "a code owner's" : need > 1 ? `${need} approving`: "an approving"} review: PRs will wait for a second reviewer (GitHub does not let you approve your own PR)`, fix: "add a reviewer who is not you, or loosen the rule in Settings, Branches", required: false })
  const signed = !!p?.required_signatures?.enabled || rs.some((x) => x.type === "required_signatures")
  if (signed && method === "rebase")
    rows.push({ name: `Signed commits: ${repo}`, ok: false, detail: `${base} requires signed commits and rebase merges are not signed by GitHub`, fix: `set github.mergeMethod to "squash"`, required: false, set: { key: "github.mergeMethod", value: "squash" } })
  if (rs.some((x) => x.type === "merge_queue"))
    rows.push({ name: `Merge queue: ${repo}`, ok: true, detail: "merges go through the queue; Dobby waits until GitHub reports the PR merged", required: false })
  return rows
}

/** The first suggested merge method among the rows, for a repo set. */
export const suggestedMethod = (rows: RepoRow[]): Method | undefined => rows.find((r) => r.set?.key === "github.mergeMethod")?.set?.value as Method | undefined

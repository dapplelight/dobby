import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { basics, missingScopes } from "../src/checks.ts"
import { setSecret } from "../src/notify.ts"
import { ghOffline, repoRights, samlUrl, suggestedMethod } from "../src/repo-rights.ts"

type Answers = Record<string, { ok?: boolean; out: unknown }>
/** A gh that answers by the api path (or "auth status"); anything unlisted is a 404. */
const gh = (a: Answers) => async (_c: string, args: string[]) => {
  const key = args[0] === "api" ? args[1].replace(/^repos\/[^/]+\/[^/]+\/?/, "") || "repo" : args.slice(0, 2).join(" ")
  const x = a[key]
  return x ? { ok: x.ok ?? true, out: typeof x.out === "string" ? x.out : JSON.stringify(x.out) } : { ok: false, out: "Not Found (HTTP 404)" }
}
const repo = { default_branch: "main", permissions: { admin: false, push: true }, allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true }

test("repoRights: a pushable repo with nothing in the way is one row", async () => {
  const rows = await repoRights("a/b", { probe: gh({ repo: { out: repo } }) })
  assert.deepEqual(rows.map((r) => [r.name, r.ok]), [["GitHub access: a/b", true]])
})

test("repoRights: read-only account is a required failure that names gh auth switch and the other accounts", async () => {
  const rows = await repoRights("a/b", { probe: gh({ repo: { out: { ...repo, permissions: { push: false } } }, "auth status": { out: "  ✓ Logged in to github.com account me (x)\n  ✓ Logged in to github.com account work (y)" } }) })
  assert.equal(rows.length, 1)
  assert.deepEqual([rows[0].required, rows[0].ok], [true, false])
  assert.match(rows[0].fix!, /gh auth switch \(signed in: me, work\)/)
})

test("repoRights: not found, SSO and offline are told apart", async () => {
  assert.match((await repoRights("a/b", { probe: gh({}) }))[0].detail, /no a\/b to this account/)
  const sso = "HTTP 403: Resource protected by organization SAML enforcement. (https://github.com/orgs/acme/sso?authorization_request=XYZ)"
  assert.equal(samlUrl(sso), "https://github.com/orgs/acme/sso?authorization_request=XYZ")
  assert.match((await repoRights("a/b", { probe: gh({ repo: { ok: false, out: sso } }) }))[0].fix!, /authorize it at https:\/\/github\.com\/orgs\/acme\/sso\?authorization_request=XYZ/)
  const off = (await repoRights("a/b", { probe: gh({ repo: { ok: false, out: "error connecting to api.github.com" } }) }))[0]
  assert.deepEqual([off.offline, off.required, off.detail], [true, false, "can't reach GitHub"])
  assert.equal(ghOffline("HTTP 401: Bad credentials"), false)
})

test("repoRights: approving review (protection or ruleset), code owners, signed commits with rebase, merge queue, squash off", async () => {
  const prot = { required_pull_request_reviews: { required_approving_review_count: 1 }, required_signatures: { enabled: true } }
  const rows = await repoRights("a/b", { method: "rebase", probe: gh({ repo: { out: { ...repo, allow_squash_merge: false, allow_rebase_merge: true } }, "branches/main/protection": { out: prot }, "rules/branches/main": { out: [{ type: "merge_queue" }] } }) })
  const by = Object.fromEntries(rows.map((r) => [r.name.split(":")[0], r]))
  assert.match(by["Review rules"].detail, /needs an approving review: PRs will wait for a second reviewer/)
  assert.match(by["Signed commits"].detail, /rebase merges are not signed/)
  assert.equal(by["Merge queue"].ok, true)
  assert.equal(by["Merge method"], undefined, "rebase is allowed, so the configured method stands")
  const owners = await repoRights("a/b", { probe: gh({ repo: { out: repo }, "rules/branches/main": { out: [{ type: "pull_request", parameters: { required_approving_review_count: 0, require_code_owner_review: true } }] } }) })
  assert.match(owners[1].detail, /a code owner's review/)
  const off = await repoRights("a/b", { probe: gh({ repo: { out: { ...repo, allow_squash_merge: false } } }) })
  assert.deepEqual([off[1].name, suggestedMethod(off)], ["Merge method: a/b", "merge"])
  const unreadable = await repoRights("a/b", { probe: gh({ repo: { out: repo }, "branches/main/protection": { ok: false, out: "HTTP 403: Upgrade to GitHub Pro" } }) })
  assert.equal(unreadable.length, 1, "protection we cannot read is not reported")
})

test("checks: offline is not 'not signed in'; missing token scopes get the refresh command", async () => {
  const mk = (auth: { ok: boolean; out: string }, user = { ok: false, out: "" }) => async (cmd: string, args: string[]) => (cmd === "gh" && args[0] === "auth" ? auth : cmd === "gh" && args[0] === "api" ? user : { ok: true, out: `${cmd} 2.1.0` })
  const o = { node: "24.18.0", platform: "darwin" as const, secrets: {}, env: {}, configPath: "/nope" }
  const off = (await basics({ ...o, probe: mk({ ok: false, out: "error connecting to api.github.com" }) })).find((r) => r.name === "GitHub sign-in")!
  assert.deepEqual([off.ok, off.offline, off.detail], [false, true, "can't reach GitHub"])
  const out = (await basics({ ...o, probe: mk({ ok: false, out: "You are not logged into any GitHub hosts. To log in, run: gh auth login" }) })).find((r) => r.name === "GitHub sign-in")!
  assert.deepEqual([out.offline, out.detail], [undefined, "not signed in"])
  const scopes = (await basics({ ...o, probe: mk({ ok: true, out: "account me\n  - Token scopes: 'gist', 'read:org', 'repo'" }, { ok: true, out: "me" }) })).find((r) => r.name === "GitHub token scopes")!
  assert.equal(scopes.fix, "gh auth refresh -s workflow,project")
  assert.deepEqual([missingScopes("no scopes line"), missingScopes("Token scopes: 'repo', 'workflow', 'project'")], [[], []])
})

test("setSecret: writes mode 0600, replaces the old line, keeps the others", () => {
  const f = `${mkdtempSync(`${tmpdir()}/dobby-sec-`)}/secrets.env`
  writeFileSync(f, "DASHBOARD_TOKEN=abc\nDOBBY_API_KEY=old\n")
  setSecret("DOBBY_API_KEY", "sk-ant-new-key", f)
  assert.equal(readFileSync(f, "utf8"), "DASHBOARD_TOKEN=abc\nDOBBY_API_KEY=sk-ant-new-key\n")
  assert.equal(statSync(f).mode & 0o777, 0o600)
  assert.throws(() => setSecret("DOBBY_API_KEY", 'a"b', f), (e: Error) => !e.message.includes('a"b'))
})

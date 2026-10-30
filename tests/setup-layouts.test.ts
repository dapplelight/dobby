// Setup finds repos in more layouts: nested folders, the current folder, ssh host aliases, other remote names, forks, repos it must skip, --projects and folder names.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { baseBranch, classifyRemote, detectRepo, draftFor, joinDraft, remoteInfo, setRemoteRunner, type Cmd, type Detected } from "../src/detect.ts"
import { repoOf } from "../src/board.ts"
import { repoOfUrl } from "../src/privacy.ts"
import { shipPreflight } from "../src/savings.ts"
import { skippedRows, firstTicketCandidates, forkAsk, forkParent, projectFolders, repoName, scanRepos, skippedLines, slugName } from "../src/setup-steps.ts"
import { prHead, repoArgs, repoArgsAsync } from "../src/lib.ts"

const home = mkdtempSync(`${tmpdir()}/dobby-layouts-`)
const repo = (dir: string, remotes: Record<string, string> = { origin: "https://github.com/acme/x.git" }, branch = "main") => {
  mkdirSync(dir, { recursive: true })
  spawnSync("git", ["init", "-q", "-b", branch, dir])
  for (const [n, u] of Object.entries(remotes)) spawnSync("git", ["-C", dir, "remote", "add", n, u])
  return dir
}
const fake = (dir: string): Detected => ({ dir, pm: "npm", install: "true", test: "true", deploy: null, base: "main", remote: /noremote|gitlab|ghe/.test(dir) ? null : `acme/${dir.split("/").pop()}`, ...(/gitlab/.test(dir) ? { skip: "other" as const } : /noremote/.test(dir) ? { skip: "none" as const } : /ghe/.test(dir) ? { skip: "ghe" as const } : {}) })
/** a runner that only answers ssh -G from a table and records every call; gh answers `ghUrl` */
const runner = (ssh: Record<string, string>, ghUrl = "") => {
  const calls: string[] = []
  const run: Cmd = (cmd, args) => {
    calls.push(`${cmd} ${args.join(" ")}`)
    if (cmd === "ssh") return ssh[args[1]] ? { ok: true, out: `user git\nhostname ${ssh[args[1]]}\nport 22\n` } : { ok: false, out: "" }
    return ghUrl ? { ok: true, out: ghUrl } : { ok: false, out: "" }
  }
  return { run, calls }
}

test("nested layouts: two levels are scanned (~/code/org/repo), three are not; the current folder is offered when it is a repo inside home", () => {
  repo(`${home}/code/flat`); repo(`${home}/code/acme/api`); repo(`${home}/code/acme/web`); repo(`${home}/code/acme/deep/too-deep`)
  mkdirSync(`${home}/code/node_modules/pkg/inner`, { recursive: true }); repo(`${home}/code/node_modules/pkg/inner`)
  const names = scanRepos([`${home}/code`], fake).repos.map((d) => d.dir.split("/").pop())
  assert.deepEqual(names.sort(), ["api", "flat", "web"])
  // the current folder: listed first when it is a repo, once, and only inside home
  const cwd = repo(`${home}/elsewhere/here`)
  assert.equal(scanRepos([`${home}/code`], fake, { cwd, home }).repos[0].dir, cwd)
  assert.equal(scanRepos([`${home}/elsewhere`], fake, { cwd, home }).repos.length, 1, "found by the folder and as the current folder: one repo")
  assert.ok(!scanRepos([`${home}/code`], fake, { cwd, home: `${home}/code` }).repos.some((d) => d.dir === cwd), "outside the home folder it is not offered")
  assert.ok(!scanRepos([`${home}/code`], fake, { cwd: `${home}/code`, home }).repos.some((d) => d.dir === `${home}/code`), "a folder that is not a repo is not offered")
})

test("ssh host alias: the real host comes from ssh -G, nothing connects; gh repo view only when ssh has no answer", () => {
  const a = runner({ "github-work": "github.com" })
  assert.deepEqual(classifyRemote("git@github-work:org/repo.git", a.run), { slug: "org/repo" })
  assert.deepEqual(a.calls, ["ssh -G github-work"], "only ssh -G ran")
  assert.deepEqual(classifyRemote("ssh://git@work-alias/org/repo", runner({ "work-alias": "ssh.github.com" }).run), { slug: "org/repo" })
  assert.deepEqual(classifyRemote("git@mygitlab:org/repo.git", runner({ mygitlab: "gitlab.com" }).run), { skip: "other" })
  assert.deepEqual(classifyRemote("git@gh-corp:org/repo.git", runner({ "gh-corp": "github.mycorp.com" }).run), { skip: "ghe" })
  // ssh has no entry (the alias comes back as itself): confirm with gh repo view, which only a github.com repo passes
  const b = runner({ "lonely-alias": "lonely-alias" }, "https://github.com/org/repo\n")
  assert.deepEqual(classifyRemote("git@lonely-alias:org/repo.git", b.run), { slug: "org/repo" })
  assert.deepEqual(b.calls, ["ssh -G lonely-alias", "gh repo view org/repo --json url -q .url"])
  assert.deepEqual(classifyRemote("git@lonely-alias:org/repo.git", runner({}, "").run), { skip: "other" })
  // plain github.com and https never ask ssh; a host starting with a dash is never passed to ssh
  const c = runner({})
  assert.deepEqual(classifyRemote("git@github.com:alice/my.app.git", c.run), { slug: "alice/my.app" })
  assert.deepEqual(classifyRemote("https://github.com/alice/tally", c.run), { slug: "alice/tally" })
  assert.deepEqual(classifyRemote("https://gitlab.com/alice/tally.git", c.run), { skip: "other" })
  assert.deepEqual(classifyRemote("ssh://-oProxyCommand=x/a/b", c.run), { skip: "other" })
  assert.ok(!c.calls.some((x) => x.startsWith("ssh -G -o")), "no option is ever passed through")
  assert.deepEqual(classifyRemote("/some/local/path", c.run), { skip: "other" })
})

test("remotes: origin first, else the first GitHub remote; GitLab, Bitbucket, none and Enterprise say why they are skipped", () => {
  const none = runner({})
  // the runtime fetches, pushes and reads refs from origin only, so a GitHub remote with another name is not accepted
  assert.deepEqual(remoteInfo(repo(`${home}/r/both`, { gitlab: "https://gitlab.com/a/b.git", "upstream-gh": "git@github.com:alice/both.git" }), none.run), { remote: null, skip: "name", remoteName: "upstream-gh" })
  assert.deepEqual(remoteInfo(repo(`${home}/r/both2`, { origin: "https://gitlab.com/a/b.git", gh: "git@github.com:alice/both.git" }), none.run), { remote: null, skip: "name", remoteName: "gh", oldOrigin: "gitlab" })
  assert.deepEqual(remoteInfo(repo(`${home}/r/two`, { fork: "https://github.com/me/two", origin: "https://github.com/up/two" }), none.run), { remote: "up/two" }, "origin wins when it is GitHub")
  assert.deepEqual(remoteInfo(repo(`${home}/r/lab`, { origin: "git@gitlab.com:a/b.git" }), none.run), { remote: null, skip: "other" })
  assert.deepEqual(remoteInfo(repo(`${home}/r/bb`, { origin: "https://bitbucket.org/a/b" }), none.run), { remote: null, skip: "other" })
  assert.deepEqual(remoteInfo(repo(`${home}/r/nothing`, {}), none.run), { remote: null, skip: "none" })
  assert.deepEqual(remoteInfo(repo(`${home}/r/ent`, { origin: "https://github.mycorp.com/a/b" }), none.run), { remote: null, skip: "ghe" })
  assert.equal(detectRepo(repo(`${home}/r/gh-only`, { "upstream-gh": "git@github.com:alice/gh-only.git" }), none.run).remote, null)
  const d = detectRepo(repo(`${home}/r/viaalias`, { origin: "git@github-work:org/repo.git" }), runner({ "github-work": "github.com" }).run)
  assert.equal(d.remote, "org/repo")
  assert.equal(d.skip, undefined)
})

test("skipped repos: one plain line with a count and names; GitHub Enterprise has its own line", () => {
  assert.deepEqual(skippedLines([]), [])
  assert.deepEqual(skippedLines([{ name: "a", why: "none" }, { name: "b", why: "other" }]), ["Skipped 2 repos without a GitHub remote: a, b"])
  assert.deepEqual(skippedLines([{ name: "solo", why: "none" }]), ["Skipped 1 repo without a GitHub remote: solo"])
  assert.deepEqual(skippedLines([{ name: "c", why: "ghe" }]), ["GitHub Enterprise isn't supported yet. Skipped 1 repo: c"])
  const many = Array.from({ length: 10 }, (_, i) => ({ name: `r${i}`, why: "none" as const }))
  assert.match(skippedLines(many)[0], /^Skipped 10 repos without a GitHub remote: r0, .*r7 and 2 more$/)
  const scan = scanRepos([`${home}/mix`], fake)
  repo(`${home}/mix/ok`); repo(`${home}/mix/noremote-a`, {}); repo(`${home}/mix/gitlab-b`, {}); repo(`${home}/mix/ghe-c`, {})
  const s = scanRepos([`${home}/mix`], fake)
  assert.deepEqual([scan.repos.length, s.repos.map((d) => d.dir.split("/").pop())], [0, ["ok"]])
  assert.deepEqual(skippedLines(s.skipped), ["Skipped 2 repos without a GitHub remote: gitlab-b, noremote-a", "GitHub Enterprise isn't supported yet. Skipped 1 repo: ghe-c"])
  assert.deepEqual(skippedRows([{ name: "x", why: "name", note: "gh" }]), [{ text: "Skipped x: its GitHub remote is gh, not origin.", fix: "git remote rename gh origin" }])
  const ten = Array.from({ length: 10 }, (_, i) => ({ name: `n${i}`, why: "name" as const, note: "gh" }))
  assert.equal(skippedLines(ten).length, 9, "eight lines and one for the rest")
  assert.deepEqual(skippedLines([{ name: "x", why: "name", note: "upstream-gh" }]), ["Skipped x: its GitHub remote is upstream-gh, not origin. Rename it with: git remote rename upstream-gh origin"])
})

test("a repo whose origin is on GitLab or elsewhere: the fix moves origin out of the way first", () => {
  const none = runner({})
  const d = detectRepo(repo(`${home}/r/lab-first`, { origin: "git@gitlab.com:a/b.git", gh: "git@github.com:alice/lab-first.git" }), none.run)
  assert.equal(d.oldOrigin, "gitlab")
  assert.equal(detectRepo(repo(`${home}/r/bb-first`, { origin: "https://bitbucket.org/a/b", gh: "git@github.com:alice/b.git" }), none.run).oldOrigin, "bitbucket")
  assert.equal(detectRepo(repo(`${home}/r/other-first`, { origin: "https://git.example.com/a/b", gh: "git@github.com:alice/b.git" }), none.run).oldOrigin, "old-origin")
  assert.equal(detectRepo(repo(`${home}/r/no-origin`, { gh: "git@github.com:alice/b.git" }), none.run).oldOrigin, undefined)
  assert.deepEqual(skippedRows([{ name: "lab-first", why: "name", note: "gh", old: "gitlab" }]), [{ text: "Skipped lab-first: its GitHub remote is gh, not origin.", fix: "git remote rename origin gitlab && git remote rename gh origin" }])
})

test("same name in two folders: the second is named in a line, not dropped silently", () => {
  repo(`${home}/dup/a/x`); repo(`${home}/dup/b/x`); repo(`${home}/dup/c/y`)
  const s = scanRepos([`${home}/dup`], fake)
  assert.deepEqual(s.repos.map((d) => d.dir.split("/").slice(-2).join("/")), ["a/x", "c/y"])
  assert.deepEqual(skippedLines(s.skipped), ["Skipped x (b/x): a project named x already exists"])
})

test("runtime lookups resolve an ssh-alias origin: board repo, PR --repo, ship preflight, privacy guard; ssh and gh are never really called", async () => {
  const fakeRun = runner({ "github-work": "github.com" })
  setRemoteRunner(fakeRun.run)
  try {
    const d = repo(`${home}/aliased`, { origin: "git@github-work:org/aliased.git" })
    const git = (a: string[], cwd: string) => { const r = spawnSync("git", a, { cwd, encoding: "utf8" }); return { ok: r.status === 0, out: r.stdout } }
    assert.equal(repoOf(d, (c, a, cwd) => git(a, cwd!)), "org/aliased", "board lookup")
    assert.deepEqual(repoArgs(d, git), ["--repo", "org/aliased"], "gh pr create --repo")
    assert.deepEqual(await repoArgsAsync(d), ["--repo", "org/aliased"])
    assert.equal(await prHead(d, "dobby/1", "up/aliased"), "org:dobby/1")
    assert.equal(repoOfUrl("git@github-work:org/aliased.git"), "org/aliased")
    const calls: string[][] = []
    const out = await shipPreflight(async (cmd, args) => { calls.push([cmd, ...args]); return { ok: true, out: cmd === "gh" && args[0] === "repo" ? "org/aliased WRITE" : "git@github-work:org/aliased.git" } }, { wt: d, branch: "dobby/1", verify: "true" })
    assert.equal(out, "")
    assert.deepEqual(calls.find((c) => c[1] === "repo"), ["gh", "repo", "view", "org/aliased", "--json", "nameWithOwner,viewerPermission", "-q", '.nameWithOwner + " " + .viewerPermission'])
    assert.deepEqual(calls.find((c) => c[1] === "push"), ["git", "push", "--dry-run", "origin", "HEAD:refs/heads/dobby/1"], "git itself resolves the alias on push and fetch")
    assert.ok(fakeRun.calls.every((c) => c.startsWith("ssh -G ")), "only ssh -G was asked")
    // a repo with only a differently named GitHub remote has no origin: the board and PR lookups find nothing, and setup does not accept it
    const g = repo(`${home}/gh-named`, { "upstream-gh": "git@github.com:org/gh-named.git" })
    assert.equal(repoOf(g, (c, a, cwd) => git(a, cwd!)), null)
    assert.deepEqual(repoArgs(g, git), [])
    assert.equal(scanRepos([`${home}`], (dir) => ({ ...fake(dir), ...detectRepo(dir, fakeRun.run) })).repos.some((x) => x.dir === g), false)
  } finally { setRemoteRunner(null) }
})

test("forks: gh repo view says isFork and the parent; a non-fork or an error is null; the question is the same text everywhere", () => {
  const gh = (out: string, ok = true) => (a: string[]) => (assert.deepEqual(a, ["repo", "view", "me/app", "--json", "isFork,parent"]), { ok, out })
  assert.equal(forkParent("me/app", gh(JSON.stringify({ isFork: true, parent: { name: "app", owner: { login: "up" } } }))), "up/app")
  assert.equal(forkParent("me/app", gh(JSON.stringify({ isFork: true, parent: { nameWithOwner: "up/app" } }))), "up/app")
  assert.equal(forkParent("me/app", gh(JSON.stringify({ isFork: false, parent: null }))), null)
  assert.equal(forkParent("me/app", gh("", false)), null)
  assert.equal(forkParent("me/app", gh("not json")), null)
  const q = forkAsk("app", "me/app", "up/app")
  assert.deepEqual(q.options.map((o) => o.value), ["fork", "upstream"])
  assert.equal(q.options[0].label, "Your fork (me/app)")
  assert.ok(!/—|–/.test(JSON.stringify(q)))
})

test("upstream: stored in the project file, used for first-ticket issues and the PR repo; a repo that is not a fork is unchanged", () => {
  const base: Detected = { dir: `${home}/app`, pm: "npm", install: "npm ci", test: "npm test", deploy: null, base: "main", remote: "me/app" }
  assert.ok(!draftFor("app", base, "~/app").includes("upstream"))
  assert.match(draftFor("app", { ...base, upstream: "up/app" }, "~/app"), /base: main\nupstream: up\/app\ninstall: npm ci/)
  const asked: string[] = []
  const issues = (r: string) => (asked.push(r), JSON.stringify([{ number: 1, title: "Do it", body: "Done when: the thing works as the issue says it should.", labels: [] }]))
  assert.deepEqual(firstTicketCandidates([base], issues).map((c) => c.remote), ["me/app"])
  assert.deepEqual(firstTicketCandidates([{ ...base, upstream: "up/app" }], issues).map((c) => c.remote), ["up/app"])
  assert.deepEqual(asked, ["me/app", "up/app"])
  const git = () => ({ ok: true, out: "git@github.com:me/app.git\n" })
  assert.deepEqual(repoArgs(base.dir, git), ["--repo", "me/app"])
  assert.deepEqual(repoArgs(base.dir, git, "up/app"), ["--repo", "up/app"])
})

test("prHead: a PR to the original of a fork names the fork's owner; otherwise the plain branch", async () => {
  const d = repo(`${home}/forked`, { origin: "https://github.com/me/forked.git" })
  assert.equal(await prHead(d, "dobby/1"), "dobby/1")
  assert.equal(await prHead(d, "dobby/1", "up/forked"), "me:dobby/1")
})

test("--projects: relative and ~ folders become absolute; a flag with no folder is an error", () => {
  const cwd = process.cwd()
  assert.deepEqual(projectFolders(["--projects", "."]), [cwd])
  assert.deepEqual(projectFolders(["--yes", "--projects", "a,b", "--projects", "/abs"]), [`${cwd}/a`, `${cwd}/b`, "/abs"])
  assert.match(projectFolders(["--projects", "~/code"])[0], /^\/.*\/code$/)
  assert.deepEqual(projectFolders(["--yes"]), [])
  for (const bad of [["--projects"], ["--projects", "--yes"], ["--yes", "--projects"]]) assert.throws(() => projectFolders(bad), /--projects needs a folder/)
})

test("folder names with spaces get a slug for the project name; the repo path keeps the real folder", () => {
  assert.equal(slugName("My Cool App"), "My-Cool-App")
  assert.equal(slugName("shop (old)"), "shop-old")
  assert.equal(slugName("tally"), "tally")
  assert.equal(slugName("my.app_v2"), "my.app_v2")
  repo(`${home}/sp/My Cool App`)
  const [d] = scanRepos([`${home}/sp`], fake).repos
  assert.equal(repoName(d), "My-Cool-App")
  assert.ok(d.dir.endsWith("/My Cool App"))
})

test("dobby init <project> starts from the repo's own base branch, not main", () => {
  const d = repo(`${home}/trunky`, { origin: "https://github.com/me/trunky" }, "trunk")
  assert.equal(baseBranch(d), "trunk")
  assert.match(joinDraft(d, { base: baseBranch(d) }), /\nbase: trunk\n/)
  assert.doesNotMatch(joinDraft(d, { base: "develop" }), /base: main/)
  writeFileSync(`${d}/x`, "")
})

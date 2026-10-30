// The steps of `dobby init` as plain functions: no prompts, no printing. The terminal (setup.ts) and the browser (dashboard-setup.ts) call the same ones.
// Nothing here takes a command, flag or path from a person: commands come from detection (detect.ts), the fixed tool list (tools.ts) and installJobs.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, resolve, sep } from "node:path"
import { basics, type Check } from "./checks.ts"
import { config, configDir, isProjectDraft, localZone, privatePath, projectsDir, zoneLabel } from "./config.ts"
import { detectRepo, draftFor, type Detected } from "./detect.ts"
import { readSecrets } from "./notify.ts"
import { detect, enabled, INFO, installPlan, TOOLS, type Tool } from "./tools.ts"
import type { DB } from "./db.ts"

export type Issue = { number: number; title: string; body: string; labels: { name: string }[] }
export const expand = (s: string) => s.replace(/^~(?=\/|$)/, homedir())
export const tidy = (s: string) => s.replace(new RegExp(`^${homedir()}`), "~")
/** A project name from a folder name: letters, digits, _ - and dots; anything else (a space) becomes one dash. */
export const slugName = (folder: string) => folder.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo"
export const repoName = (d: Detected) => slugName(basename(d.dir))

/** `--projects` values as absolute folders (`.` and `~/x` included). A flag with no folder after it is an error, never the default. */
export function projectFolders(args: string[]): string[] {
  const out: string[] = []
  args.forEach((x, i) => {
    if (x !== "--projects") return
    const v = args[i + 1]
    if (!v || v.startsWith("--")) throw new Error("--projects needs a folder, like --projects ~/code")
    for (const f of v.split(",").map((f) => f.trim()).filter(Boolean)) out.push(resolve(expand(f)))
  })
  return out
}

export type GhRun = (args: string[]) => { ok: boolean; out: string }
const realGh: GhRun = (args) => { const r = spawnSync("gh", args, { encoding: "utf8", timeout: 20_000 }); return { ok: r.status === 0, out: r.stdout ?? "" } }
/** The repo a GitHub fork was made from ("owner/name"), or null when `remote` is not a fork or gh cannot say. */
export function forkParent(remote: string, gh: GhRun = realGh): string | null {
  const r = gh(["repo", "view", remote, "--json", "isFork,parent"])
  try {
    const j = JSON.parse(r.out) as { isFork?: boolean; parent?: { nameWithOwner?: string; name?: string; owner?: { login?: string } } | null }
    const p = j.parent
    const slug = p?.nameWithOwner ?? (p?.owner?.login && p.name ? `${p.owner.login}/${p.name}` : "")
    return r.ok && j.isFork && /^[\w.-]+\/[\w.-]+$/.test(slug) ? slug : null
  } catch { return null }
}
/** The one question asked about a fork, for the terminal and the browser alike. "fork" keeps today's behaviour. */
export const forkAsk = (name: string, remote: string, parent: string) => ({
  question: `${name} is a fork of ${parent}. Send pull requests and first-ticket issues to:`,
  options: [{ value: "fork" as const, label: `Your fork (${remote})` }, { value: "upstream" as const, label: `The original (${parent})` }],
})

/** Open issues that are small and say when they are done, best first: a done rule, a bug or starter label, a short body. */
export function rankIssues(xs: Issue[]): Issue[] {
  const skip = /question|discussion|wontfix|duplicate|epic|design|owner/i
  const clear = /done when|acceptance|expected|steps to reproduce|- \[ \]/i
  const score = (i: Issue) => (clear.test(i.body) ? 0 : 1000) + (i.labels.some((l) => /good first issue|bug/i.test(l.name)) ? 0 : 500) + Math.min(i.body.length, 499)
  return xs.filter((i) => i.body.trim().length >= 40 && !i.labels.some((l) => skip.test(l.name)) && !/^owner:/i.test(i.title)).sort((a, b) => score(a) - score(b))
}

/** Existing values win: setup fills in what is missing and never overwrites a value the user set. */
export function fillConfig(have: Record<string, unknown>, add: Record<string, unknown>): Record<string, unknown> {
  const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)
  const out = { ...have }
  for (const [k, v] of Object.entries(add)) out[k] = !(k in out) ? v : obj(out[k]) && obj(v) ? fillConfig(out[k] as Record<string, unknown>, v) : out[k]
  return out
}

/** Steps 1-2: the machine checks and sign-ins. */
export const checkMachine = (o: Parameters<typeof basics>[0] = {}): Promise<Check[]> => basics({ apiKeyMode: config().billing?.mode === "apiKey", ...o })
export const blockingChecks = (rows: Check[]) => rows.filter((r) => r.required && !r.ok && r.name !== "config")
export const loginOf = (rows: Check[]) => /signed in as (\S+)/.exec(rows.find((r) => r.name === "GitHub sign-in")?.detail ?? "")?.[1] ?? ""

/** Folders people keep repos in. Only the ones that exist are looked at. */
export const COMMON_ROOTS = ["~/projects", "~/code", "~/dev", "~/src", "~/work", "~/Developer", "~/repos", "~/GitHub"]

/** The folders to look in: the configured one(s), then the common ones that exist; each once. */
export function defaultRoots(cfg: { paths: { projects: string; projectRoots?: string[] } } = config(), exists: (d: string) => boolean = (d) => existsSync(d)): string[] {
  const seen = new Set<string>(), out: string[] = []
  for (const r of [cfg.paths.projects, ...(cfg.paths.projectRoots ?? []), ...COMMON_ROOTS]) {
    const key = expand(r).replace(/\/+$/, "")
    if (seen.has(key) || !exists(key)) continue
    seen.add(key); out.push(tidy(key))
  }
  return out
}

/** `p` resolved to a real path inside the home folder (a symlink that leads out is refused), or the plain reason it is not. */
export function insideHome(p: unknown, home = homedir()): { ok: true; dir: string } | { ok: false; reason: string } {
  if (typeof p !== "string" || !p.trim() || p.includes("\0") || p.length > 500) return { ok: false, reason: "That is not a folder path." }
  const abs = resolve(expand(p.trim()))
  let real: string, root: string
  try { real = realpathSync(abs); root = realpathSync(home) } catch { return { ok: false, reason: `${tidy(abs)} does not exist.` } }
  if (!real.startsWith(root + sep)) return { ok: false, reason: "That folder is outside your home folder." }
  if (!statSync(real).isDirectory()) return { ok: false, reason: `${tidy(real)} is not a folder.` }
  return { ok: true, dir: real }
}
/** A folder to look in. Nothing in it is read until it is listed. */
export const checkRoot = insideHome
/** One repo by path: inside home, a folder with .git and a GitHub remote. Detection only reads its files; nothing is run. */
export function checkRepoPath(p: unknown, o: { home?: string; detectOne?: (dir: string) => Detected } = {}): { ok: true; d: Detected } | { ok: false; reason: string } {
  const r = insideHome(p, o.home)
  if (!r.ok) return r
  if (!existsSync(`${r.dir}/.git`)) return { ok: false, reason: `${tidy(r.dir)} is not a git repo (no .git folder).` }
  const d = (o.detectOne ?? detectRepo)(r.dir)
  return d.remote ? { ok: true, d } : { ok: false, reason: d.skip === "ghe" ? "GitHub Enterprise isn't supported yet." : d.skip === "name" ? `${tidy(r.dir)} has a GitHub remote named ${d.remoteName}; Dobby only uses origin.` : `${tidy(r.dir)} has no GitHub remote.` }
}

export type Scan = { repos: Detected[]; skipped: { name: string; why: "ghe" | "other" | "none" | "name" | "dup"; note?: string; old?: string }[] }
/**
 * Step 3: git repos with a GitHub remote in every folder, together, one or two levels down (`~/code/repo`, `~/code/org/repo`), plus the
 * current folder when it is a repo; a repo found twice (same folder or same name) is listed once. Repos without a GitHub remote are counted in `skipped`.
 */
export function scanRepos(roots: string | string[], detectOne: (dir: string) => Detected = detectRepo, o: { cwd?: string; home?: string } = {}): Scan {
  const seenDir = new Set<string>(), seenName = new Set<string>(), repos: Detected[] = [], skipped: Scan["skipped"] = []
  const take = (dir: string) => {
    const n = slugName(basename(dir))
    if (!isProjectDraft(`${n}.md`)) return // a name must be safe as a file name: letters, digits, _ - and single dots
    let key = dir
    try { key = realpathSync(dir) } catch {}
    if (seenDir.has(key)) return
    if (seenName.has(n)) { skipped.push({ name: n, why: "dup", note: `${basename(dirname(dir))}/${n}` }); return }
    seenDir.add(key)
    const d = detectOne(dir)
    if (!d.remote) { skipped.push({ name: n, why: d.skip ?? "none", ...(d.remoteName ? { note: d.remoteName } : {}), ...(d.oldOrigin ? { old: d.oldOrigin } : {}) }); return }
    seenName.add(n); repos.push(d)
  }
  const kids = (dir: string, links: boolean) => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => (e.isDirectory() || (links && e.isSymbolicLink())) && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => e.name).sort() } catch { return [] } }
  if (o.cwd && existsSync(`${o.cwd}/.git`) && insideHome(o.cwd, o.home).ok) take(o.cwd)
  for (const root of [roots].flat()) {
    const r = expand(root)
    if (!existsSync(r)) continue
    if (existsSync(`${r}/.git`)) take(r)
    for (const n of kids(r, true)) {
      const dir = `${r}/${n}`
      if (existsSync(`${dir}/.git`)) take(dir)
      else for (const m of kids(dir, false)) if (existsSync(`${dir}/${m}/.git`)) take(`${dir}/${m}`)
    }
  }
  return { repos, skipped }
}
export const findRepos = (roots: string | string[], detectOne?: (dir: string) => Detected, o?: { cwd?: string; home?: string }): Detected[] => scanRepos(roots, detectOne, o).repos

/** What to tell the owner about repos that were left out: plain text, and the command that fixes it when there is one. */
export function skippedRows(skipped: Scan["skipped"]): { text: string; fix: string | null }[] {
  const list = (xs: string[]) => (xs.length > 8 ? `${xs.slice(0, 8).join(", ")} and ${xs.length - 8} more` : xs.join(", "))
  const repos = (n: number) => `${n} repo${n === 1 ? "" : "s"}`
  const of = (why: string) => skipped.filter((x) => x.why === why)
  const plain = skipped.filter((x) => x.why === "none" || x.why === "other").map((x) => x.name), ghe = of("ghe").map((x) => x.name), named = of("name")
  const rows = (xs: typeof named) => xs.slice(0, 8).map((x) => ({ text: `Skipped ${x.name}: its GitHub remote is ${x.note}, not origin.`, fix: `${x.old ? `git remote rename origin ${x.old} && ` : ""}git remote rename ${x.note} origin` }))
  return [
    ...(plain.length ? [{ text: `Skipped ${repos(plain.length)} without a GitHub remote: ${list(plain)}`, fix: null }] : []),
    ...(ghe.length ? [{ text: `GitHub Enterprise isn't supported yet. Skipped ${repos(ghe.length)}: ${list(ghe)}`, fix: null }] : []),
    ...rows(named), ...(named.length > 8 ? [{ text: `and ${named.length - 8} more repos whose GitHub remote is not named origin`, fix: null }] : []),
    ...of("dup").map((x) => ({ text: `Skipped ${x.name} (${x.note}): a project named ${x.name} already exists`, fix: null })),
  ]
}
/** The same rows as one plain line each (the terminal). */
export const skippedLines = (skipped: Scan["skipped"]): string[] => skippedRows(skipped).map((r) => (r.fix ? `${r.text} Rename it with: ${r.fix}` : r.text))

/** Draft projects/<name>.md for each repo that passed, unless the repo or the drafts folder already has one. */
export function saveRepos(ready: Detected[], root: string, testsOff: (d: Detected) => boolean = () => false, again: (d: Detected) => boolean = () => false): void {
  const drafts = projectsDir() || `${root}projects`
  mkdirSync(drafts, { recursive: true })
  for (const d of ready) {
    const f = `${drafts}/${repoName(d)}.md`
    if ((again(d) || !existsSync(f)) && !existsSync(`${d.dir}/dobby.md`) && !existsSync(`${d.dir}/foreman.md`)) writeFileSync(f, draftFor(repoName(d), testsOff(d) ? { ...d, test: null } : d, tidy(d.dir), { testsOff: testsOff(d) }))
  }
}

/** Step 4: is the Discord bot token set (never the token itself). */
export const chatStatus = (secrets: Record<string, string> = readSecrets()) => ({ discordToken: !!secrets.DISCORD_BOT_TOKEN })

/** Step 4b: the five agent tools. graphify and rtk install with a fixed command; caveman and ponytail are text rules (on by default); jev is paid and needs a key in secrets.env. */
export type ToolRow = { name: Tool; what: string; on: boolean; found: boolean; install: string[] | null; note: string }
export function toolRows(found: (t: Tool) => boolean = detect, on: (t: Tool) => boolean = (t) => enabled(t), have?: (bin: string) => boolean): ToolRow[] {
  return TOOLS.map((name) => ({
    name, what: INFO[name].what, on: on(name), found: found(name), install: name === "graphify" || name === "rtk" ? installPlan(name, have).cmds : null,
    note: name === "caveman" || name === "ponytail" ? "text rules, nothing to install" : name === "jev" ? "paid, needs JEV_API_KEY in secrets.env" : (name === "graphify" || name === "rtk") && installPlan(name, have).note ? installPlan(name, have).note! : "free",
  }))
}
export const INSTALLABLE = ["graphify", "rtk"] as const
export const toolsMissing = (found: (t: Tool) => boolean = detect) => INSTALLABLE.filter((t) => !found(t))
export type RunCmd = (cmd: string) => { ok: boolean; out: string }
const realCmd: RunCmd = (cmd) => { const r = spawnSync(cmd, { shell: true, encoding: "utf8", timeout: 10 * 60_000 }); return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` } }
/** Runs the fixed install commands of one tool. Any other name is refused. */
export function installTool(name: string, run: RunCmd = realCmd, have?: (bin: string) => boolean): { name: string; results: { cmd: string; ok: boolean; last: string }[] } {
  if (!(INSTALLABLE as readonly string[]).includes(name)) throw new Error(`${name} has nothing to install here (${INSTALLABLE.join(", ")})`)
  const plan = installPlan(name as "graphify" | "rtk", have)
  if (!plan.cmds.length) throw new Error(plan.note ?? `${name} cannot be installed here`)
  return { name, results: plan.cmds.map((cmd) => { const r = run(cmd); return { cmd, ok: r.ok, last: r.out.trim().split("\n").pop()?.slice(0, 200) ?? "" } }) }
}

export const PRESETS = ["strict", "balanced", "autonomous"] as const
export const AUTOS = ["off", "drafts", "on"] as const
export const DEPLOYS = ["ask", "auto"] as const
export type Settings = { preset: (typeof PRESETS)[number]; auto: (typeof AUTOS)[number]; deploy: (typeof DEPLOYS)[number]; weekCap?: number }

/** Step 5: write the settings (existing values kept) to the private config, mode 0600. `login` and `remotes` come from the checks and the repos that passed. */
export function saveSettings(s: Settings, who: { login: string; remotes: string[]; projects?: string[]; mergeMethod?: string; have?: Record<string, unknown> }, file = privatePath()): { have: Record<string, unknown>; kept: boolean } {
  const tz = localZone()
  const owners = [...new Set([who.login, ...who.remotes.map((r) => r.split("/")[0])].filter(Boolean))]
  const have = who.have ?? (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {})
  const next = fillConfig(have, { timezone: tz, timezoneLabel: zoneLabel(tz), github: { owner: who.login, accounts: owners, ...(who.mergeMethod ? { mergeMethod: who.mergeMethod } : {}) }, safety: { preset: s.preset, deploy: s.deploy }, review: { auto: s.auto }, pacing: { weekCap: s.weekCap ?? 95 } })
  // explicit folders are the owner's choice: the first replaces paths.projects, the rest are kept in paths.projectRoots so a later run finds them
  if (who.projects?.length) next.paths = { ...(next.paths as object), projects: who.projects[0], ...(who.projects.length > 1 ? { projectRoots: who.projects.slice(1) } : {}) }
  mkdirSync(file.replace(/\/[^/]*$/, "") || ".", { recursive: true })
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  return { have, kept: !!have.timezone }
}

/** Step 7: the smallest open issues the owner wrote (never other people's: a public repo lets anyone open one, and its body becomes the builder's instructions). */
export type Candidate = { project: string; remote: string; number: number; title: string; body: string }
export type GhIssues = (remote: string) => string
export const issueArgs = (remote: string) => ["issue", "list", "-R", remote, "--state", "open", "--author", "@me", "--limit", "50", "--json", "number,title,body,labels"]
const realIssues: GhIssues = (remote) => spawnSync("gh", issueArgs(remote), { encoding: "utf8" }).stdout
export function firstTicketCandidates(repos: Detected[], issues: GhIssues = realIssues): Candidate[] {
  return repos.flatMap((d) => {
    try { return rankIssues(JSON.parse(issues(d.upstream ?? d.remote!))).slice(0, 3).map((i) => ({ project: repoName(d), remote: d.upstream ?? d.remote!, number: i.number, title: i.title, body: i.body })) } catch { return [] }
  })
}
/** Adds the candidate as a ticket and queues it. Returns the queue message. */
export async function queueCandidate(db: DB, c: Candidate): Promise<string> {
  const { addTicket, queueTicket } = await import("./lib.ts")
  const { id } = addTicket(db, { project: c.project, title: `${c.title} (#${c.number})`.slice(0, 200), done_when: c.body.slice(0, 2000), size: "S" })
  return queueTicket(db, id)
}
export { configDir }

// Private words never reach a public repo. The owner's words: the private config's GitHub accounts, client names and Discord app
// names, plus ~/.config/dobby/private-terms.txt (one word or phrase per line; that file never leaves the machine), plus home folders
// and personal email addresses. Used by the public cut (bin/public-cut.mjs), by every gh call that posts text (redacted on public
// repos), and by every git push (refused to a public repo when the pushed diff or commit messages hold a private word).
import { repoSlug } from "./savings.ts"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

export type Pattern = { name: string; re: RegExp }
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Built-in patterns plus the owner's words (whole words, any case). Words under 3 letters are skipped: they match everywhere. */
export function patterns(words: string[]): Pattern[] {
  const own = [...new Set(words.map((w) => String(w).trim()).filter((w) => w.length >= 3))]
  return [
    { name: "home folder", re: /\/(Users|home)\/(?!runner\b|user\b|me\b|you\b)[a-z][\w.-]*/i },
    { name: "personal email", re: /[\w.+-]+@(gmail|googlemail|yahoo|outlook|hotmail|icloud|proton(mail)?)\.[a-z]+/i },
    ...own.map((w) => ({ name: w, re: new RegExp(`(?<![A-Za-z0-9])${esc(w)}(?![A-Za-z0-9])`, "i") })),
  ]
}

/** The owner's words. `allow` = words that are public anyway (the account hosting a public repo). dobby and foreman are the product's own names. */
export function ownerWords(home = homedir(), allow: string[] = []): string[] {
  const words: unknown[] = []
  try {
    const c = JSON.parse(readFileSync(`${home}/.config/dobby/config.json`, "utf8"))
    words.push(c.github?.owner, ...(c.github?.accounts ?? []), ...(c.clientNames ?? []), ...Object.keys(c.discord?.apps ?? {}))
  } catch {}
  try { words.push(...readFileSync(`${home}/.config/dobby/private-terms.txt`, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"))) } catch {}
  const ok = new Set(["dobby", "foreman", ...allow.map((a) => a.toLowerCase())])
  return words.filter((w): w is string => typeof w === "string" && !!w.trim() && !ok.has(w.trim().toLowerCase()))
}

/** Every pattern name that matches, line by line, as "line N: name". */
export function hits(text: string, pats: Pattern[]): string[] {
  const out: string[] = []
  text.split("\n").forEach((line, i) => { for (const p of pats) if (p.re.test(line)) out.push(`line ${i + 1}: ${p.name}`) })
  return out
}

export const redactPrivate = (text: string, pats: Pattern[]) =>
  pats.reduce((t, p) => t.replace(new RegExp(p.re.source, p.re.flags.includes("g") ? p.re.flags : p.re.flags + "g"), "‹private›"), text)

/** owner/name → public? Asked once per repo per process. Tests fill it; outside a test an unknown answer counts as public (fail closed). */
export const visibility = new Map<string, boolean>()
export function isPublic(repo: string): boolean {
  const key = repo.toLowerCase()
  if (!visibility.has(key)) {
    if (process.env.NODE_TEST_CONTEXT) return false
    const r = spawnSync("gh", ["repo", "view", repo, "--json", "visibility", "--jq", ".visibility"], { encoding: "utf8" })
    visibility.set(key, r.status === 0 ? r.stdout.trim() === "PUBLIC" : true)
  }
  return visibility.get(key)!
}

/** owner/name from a GitHub remote URL (https or ssh), else "". */
export const repoOfUrl = (url: string) => url.trim().match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/)?.[1] ?? repoSlug(url) ?? ""
const originRepo = (cwd?: string) => repoOfUrl(spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" }).stdout ?? "")

/** The repo a gh call targets: --repo/-R, a repos/<owner>/<name> api path, else the cwd's origin. */
export function ghRepo(args: string[], cwd?: string): string {
  const i = args.findIndex((a) => a === "--repo" || a === "-R")
  if (i >= 0) return args[i + 1] ?? ""
  const flag = args.find((a) => a.startsWith("--repo="))
  if (flag) return flag.slice(7)
  const path = args.find((a) => /^\/?repos\/[^/]+\/[^/]+/.test(a))
  if (path) return path.replace(/^\//, "").split("/").slice(1, 3).join("/")
  return originRepo(cwd)
}

/** gh subcommands that put text on GitHub. gh api counts only with a repos/<owner>/<name> path (graphql reads name their repo inside the query). */
const POSTS = /^(pr (create|edit|comment|review)|issue (create|edit|comment)|release (create|edit))$/
const posts = (args: string[]) => POSTS.test(args.slice(0, 2).join(" ")) || (args[0] === "api" && args.some((a) => /^\/?repos\/[^/]+\/[^/]+/.test(a)))
const pats = (repo: string) => patterns(ownerWords(homedir(), [repo.split("/")[0]]))

/** gh args with private words replaced, when the call posts text to a public repo. */
export function outboundPrivate(args: string[], cwd?: string): string[] {
  if (!posts(args)) return args
  const repo = ghRepo(args, cwd)
  if (!repo || !isPublic(repo)) return args
  const p = pats(repo)
  return args.map((a) => redactPrivate(a, p))
}

/** A JSON body for gh api to a public repo, with private words replaced. */
export function bodyPrivate(path: string, body: string): string {
  const repo = ghRepo([path])
  return repo && isPublic(repo) ? redactPrivate(body, pats(repo)) : body
}

/**
 * Why a `git push` to a public origin must not go (null = it may). Checks the added lines and the commit messages of what is
 * pushed that the remote's default branch does not have. A branch delete (`:branch`) or a push to a private repo always goes.
 */
export function pushRefusal(args: string[], cwd?: string): string | null {
  const refs = args.slice(1).filter((a) => !a.startsWith("-"))
  const spec = refs.length > 1 ? refs[refs.length - 1] : "HEAD"
  const src = spec.split(":")[0].replace(/^\+/, "")
  if (!src) return null
  const repo = originRepo(cwd)
  if (!repo || !isPublic(repo)) return null
  const git = (...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).stdout ?? ""
  const base = git("rev-parse", "--verify", "-q", "origin/HEAD").trim() || git("rev-parse", "--verify", "-q", "origin/main").trim()
  const range = base ? `${base}..${src}` : src
  const added = git("diff", ...(base ? ["--merge-base", base, src] : [`${src}~1`, src])).split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n")
  const found = [...new Set(hits(`${added}\n${git("log", "--format=%B", range)}`, pats(repo)).map((h) => h.split(": ").pop()))]
  return found.length ? `privacy: not pushed to public ${repo}: the change holds private words (${found.join(", ")}). Remove them and push again.` : null
}

// node src/privacy.ts < text: exit 1 and list the hits (a pre-push hook pipes `git log -p` here).
if (import.meta.url === `file://${process.argv[1]}`) {
  const found = hits(readFileSync(0, "utf8"), patterns(ownerWords(homedir(), process.argv.slice(2))))
  if (found.length) { console.error(`private words found:\n${found.join("\n")}`); process.exit(1) }
}

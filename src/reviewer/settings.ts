// Reviewer settings: the `review` section of the config. Standalone (zod + node only) so src/reviewer/ can leave Dobby later.
//
// DEFAULTS below are what runs with no `review` section; any `review.*` key turns one piece on or retunes it, and
// `review.repos["owner/name"]` overrides those for one repo. Safety limits stay on by default: commands only from users with
// write access, a full-review cap per PR per day, 4 auto reviews per scan, and `fix` only queues a builder ticket (never pushes).
import { matchesGlob } from "node:path"
import { z } from "zod"

const fields = {
  // on = auto-review every open PR, drafts too; drafts = auto-review all but drafts (what Dobby always did); off = only on request
  auto: z.enum(["on", "drafts", "off"]),
  includePaths: z.array(z.string()), // globs; non-empty = only these files are reviewed
  excludePaths: z.array(z.string()), // globs never reviewed (lockfiles, generated code)
  branches: z.array(z.string()), // base-branch globs auto-reviewed; empty = every base branch
  skipLabel: z.string(), // a PR with this label is not auto-reviewed ("" = none)
  mentionOnly: z.boolean(), // no auto reviews; only `@<handle> review` (turns commands on)
  // On a public repo @dobby may be a real GitHub user who gets pinged: pick a handle you control (a bot account, your org's name).
  handle: z.string().regex(/^[\w-]+$/).refine((h) => h.toLowerCase() !== "foreman", "@foreman is the owner chat; pick another handle"),
  botLogin: z.string().regex(/^([\w-]+(\[bot\])?)?$/), // also answer `@<botLogin> <verb>` (the GitHub App or bot account you review as); "" = only the handle
  commands: z.boolean(), // PR comment commands from users with write access
  fullReviewsPerDay: z.number().int().min(0), // `full review` per PR per day
  maxPerScan: z.number().int().min(1), // auto reviews per review-scan
  maxChats: z.number().int().min(0), // owner @foreman chat answers per scan
  maxCommandsPerScan: z.number().int().min(0), // commands, thread questions and learnings handled per scan
  ask: z.boolean(), // `@<handle> ask` and replies in our review threads get an answer
  describe: z.boolean(), // `@<handle> describe` fills an EMPTY PR description (off: the suggestion goes in the walkthrough)
  maxFindings: z.number().int().min(0), // 0 = no cap (ranked, most severe first)
  strictness: z.enum(["chill", "default", "assertive"]),
  riskBump: z.boolean(), // a haiku/sonnet pick on a diff touching riskPaths becomes opus
  riskPaths: z.array(z.string()),
  contextPack: z.boolean(), // callers, tests and history of the changed files from graphify-out/graph.json, when present
  contextFiles: z.number().int().min(1), // changed files the context pack covers
  learn: z.boolean(), // a 👎 or "won't fix" reply on our thread = a "known intentional" hint for later reviews of the repo
  maxLearnings: z.number().int().min(1), // kept per repo, newest first
  fix: z.boolean(), // `@<handle> fix` queues the open high/medium findings as a builder ticket (never pushes itself)
  fixesPerDay: z.number().int().min(0), // `@<handle> fix` per PR per day (the 2 auto-fix rounds per PR still apply)
  // Send replies in our threads to Jev (redacted) to tell a "won't fix" from a question. Off: no Jev call; every reply that is
  // not a plain "thanks" is answered as a question and never becomes a learning (comment text stays on the Mac).
  jevReplies: z.boolean(),
}
const Base = z.object(fields)
export type Settings = z.infer<typeof Base>

// A plain word matches a whole word of the path (segments split on . _ - / and camelCase, JWTSecret = jwt secret; a trailing
// "s" allowed): "auth" hits src/auth/x.ts, useAuth.ts and .env-style files hit "env", but author.ts and tokenizer.ts do not.
// An entry with a dot is a file name: ".env" hits app/.env and .env.local, "schema.prisma" hits prisma/schema.prisma.
// Anything with / * ? [ is a glob.
const RISK = ["auth", "oauth", "oauth2", "auth0", "authn", "authz", "authentication", "authorization", "secret", "token", "credential", "jwt", "apikey", "env", "dotenv",
  "payment", "billing", "money", "wallet", "invoice", "refund", "pricing", "migration", "migrate", "sql", "permission", "crypto", "cryptography", "**/guard-hook*"]
// Off until asked (owner, 24 Oct): no automatic reviews, so nothing spends usage unless someone comments `@dobby review` (or
// sets `auto`). The comment features (commands, ask, describe, learn, fix) are on: each runs only on a comment. Dobby's own
// ticket PRs are still reviewed by the pipeline. The model is picked by the rules and Jev; riskBump is off unless set.
export const DEFAULTS: Settings = {
  auto: "off", includePaths: [], excludePaths: [], branches: [], skipLabel: "no-review", mentionOnly: false, handle: "dobby", commands: true,
  fullReviewsPerDay: 3, maxPerScan: 4, maxChats: 3, maxCommandsPerScan: 5, ask: true, describe: true, maxFindings: 0, strictness: "default",
  riskBump: false, riskPaths: RISK, contextPack: true, contextFiles: 10, learn: true, maxLearnings: 30, fix: true, botLogin: "", fixesPerDay: 1, jevReplies: false,
}

const Partial = Base.partial().strip()
export const reviewConfigSchema = Partial.extend({ repos: z.record(Partial).optional() }).strip()
export type ReviewConfig = z.infer<typeof reviewConfigSchema>

/** The settings in force for one repo (or globally): DEFAULTS < review.* < review.repos[repo]. */
export function resolve(c: ReviewConfig | undefined, repo?: string): Settings {
  const { repos, ...top } = c ?? {}
  const s: Settings = { ...DEFAULTS, ...defined(top), ...defined((repo && repos?.[repo]) || {}) }
  return s.mentionOnly ? { ...s, auto: "off", commands: true } : s
}
const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>

const any = (globs: string[], p: string) => globs.some((g) => matchesGlob(p, g))
/** May this changed file be reviewed under the path filters? */
export const pathReviewed = (s: Pick<Settings, "includePaths" | "excludePaths">, path: string) =>
  (!s.includePaths.length || any(s.includePaths, path)) && !any(s.excludePaths, path)
// the camelCase pieces (JWTSecret = jwt, secret) and the unsplit runs (apikey from APIKey)
const words = (path: string) => [...path.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/), ...path.toLowerCase().split(/[^a-z0-9]+/)].filter(Boolean)
export const risky = (s: Pick<Settings, "riskPaths">, path: string) => {
  const w = words(path), names = path.toLowerCase().split("/")
  return s.riskPaths.some((g) => {
    const x = g.toLowerCase()
    if (/[/*?[]/.test(g)) return matchesGlob(path, g)
    if (x.includes(".")) return names.some((n) => n === x || n.startsWith(`${x}.`))
    return w.some((y) => y === x || y === `${x}s`)
  })
}

/**
 * Commands answer `@<handle>`, and the default handle (dobby) is somebody's GitHub username. On a public repo commands stay
 * off until the config names a handle (review.handle, for the repo or top-level) or a botLogin. isPublic: unreadable = true.
 */
export function handleGuard(s: Settings, c: ReviewConfig | undefined, repo: string, isPublic: () => boolean): Settings {
  if (!s.commands || s.botLogin || c?.repos?.[repo]?.handle || c?.handle) return s
  return isPublic() ? { ...s, commands: false } : s
}

export type PrBrief = { isDraft: boolean; baseRefName?: string; labels?: { name: string }[]; body?: string }
/** Why an automatic review skips this PR ("" = review it). Requested reviews (commands) skip none of this. */
export function autoSkip(s: Settings, p: PrBrief, pausedPr = false): string {
  if (s.auto === "off") return s.mentionOnly ? "mention-only" : "auto reviews off"
  if (p.isDraft && s.auto === "drafts") return "draft"
  if (s.branches.length && !any(s.branches, p.baseRefName ?? "")) return `base ${p.baseRefName} not in review.branches`
  if (s.skipLabel && p.labels?.some((l) => l.name === s.skipLabel)) return `label ${s.skipLabel}`
  if (s.commands && ignoredIn(s, p.body)) return `@${s.handle} ignore in the description`
  if (pausedPr) return "paused on this PR"
  return ""
}
export const ignoredIn = (s: Pick<Settings, "handle">, body = "") => new RegExp(`(^|[^\\w@])@${s.handle}\\s+ignore\\b`, "i").test(unquoted(body))
/** Comment text minus what only quotes or shows: fenced and inline code, and `>` quote lines (a quoted command is not a command). */
export const unquoted = (body: string) => body.replace(/^ {0,3}(```|~~~)[\s\S]*?(^ {0,3}\1|(?![\s\S]))/gm, "").replace(/`[^`\n]*`/g, "").replace(/^ {0,3}>.*$/gm, "")

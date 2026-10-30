// One config for everything owner-specific (projects/foreman.md, goal 2: configurable, not personal).
// Layers, later wins: built-in defaults (= the owner's values, so nothing changes for them) < dobby.config.json at the repo
// root (checked in, generic; may only TIGHTEN safety keys, like policy.json) < the private file (anything goes):
// DOBBY_CONFIG, else ~/.config/dobby/config.json on macOS/Linux, %APPDATA%\dobby\config.json on Windows.
// Paths keep their "~" (expand with expand()) so every default reads exactly like the literal it replaced.
// Under `node --test` the private file is read only when DOBBY_CONFIG names one (tests never see the owner's file).
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { z } from "zod"
import { EVERY_MERGE, PRESETS } from "./presets.ts"
import { providersConfigSchema } from "./providers/config.ts"
import { reviewConfigSchema } from "./reviewer/settings.ts"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

const App = z.object({ label: z.string(), ideas: z.boolean() })
export const Schema = z.object({
  // timezone: the clock Dobby reads times and daily hours in; an IANA name like Asia/Kolkata (the default is this Mac's own).
  timezone: z.string().refine((tz) => { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true } catch { return false } }, { message: "unknown time zone", params: { allowed: "IANA time zone like Asia/Kolkata" } }),
  timezoneLabel: z.string(), // shown after clock times ("14:03 IST")
  quietHours: z.object({ start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }), // notifications go out silent
  eveningPostHour: z.number().int().min(0).max(23), // the daily usage post in #system-status
  github: z.object({
    owner: z.string(), // the person whose @dobby PR chat is answered ("" = nobody)
    accounts: z.array(z.string()), // users/orgs whose repos get reviewed
    mergeMethod: z.enum(["squash", "merge", "rebase"]).optional(), // how Dobby merges a PR (default squash)
    deleteBranch: z.boolean().optional(), // delete the PR branch after Dobby merges it (default true)
    mirrorPublic: z.boolean().optional(), // mirror tickets as issues on public repos too (default false: the backlog stays private until you say)
  }),
  // board.issues false: new tickets are not filed as GitHub issues (existing ones still sync status and close). `dobby add --no-issue` does it per ticket.
  board: z.object({ issues: z.boolean() }).partial().optional(),
  clientNames: z.array(z.string()), // real clients: tickets naming them are never agent work (policy rule client-name)
  clientProjects: z.array(z.string()), // the projects those client rules apply to
  frontDeskDenyMcp: z.array(z.string()), // MCP servers the front desk may never call (the owner's money, health or shopping apps)
  // other launchd jobs the hourly health check watches: label prefixes, and long-running ones (no pid = died)
  watchJobs: z.object({ prefixes: z.array(z.string()), daemons: z.array(z.string()) }).partial().optional(),
  paths: z.object({
    projects: z.string(), // where project clones live
    projectRoots: z.array(z.string()).optional(), // more folders that hold project clones; setup looks in these too (each must be inside your home folder)
    data: z.string(), // Dobby's data dir (DOBBY_DIR still wins)
    memory: z.string(), // the owner's Claude Code memory folder (dobby company)
    usageCli: z.string(), // the claude-code-usage-limits reader; "" = the copy bundled in node_modules
    dashboardDist: z.string(), // the built dashboard app (DOBBY_DASHBOARD_DIST still wins)
    agentRules: z.string().optional(), // your own rules file, appended to every agent's rules after Dobby's (src/tools.ts)
  }),
  // Agent tooling (src/tools.ts, `dobby tools`). A tool's rules reach agents only when it is on AND found on this machine.
  // Absent = graphify, rtk, caveman, ponytail on (free); jev on only when safety.classifier is "jev" (paid: opt in).
  tools: z.object({ graphify: z.boolean(), rtk: z.boolean(), caveman: z.boolean(), ponytail: z.boolean(), jev: z.boolean() }).partial().optional(),
  chat: z.object({ platform: z.enum(["discord", "slack"]) }).partial().optional(), // where Dobby talks to you; absent = "discord". "slack" is beta (docs/manual/slack.md); the channel layout still comes from discord.*
  discord: z.object({
    hq: z.array(z.string()), // channels in the HQ category
    apps: z.record(z.string(), App), // one category per app: <app>-tickets, <app>-releases, <app>-ideas when ideas
    extraChannels: z.record(z.string(), z.array(z.string())), // more channels in an app's category
    listener: z.enum(["chat-sdk", "legacy"]).optional(), // how the listener job reads Discord: "legacy" (default, the hand-written gateway) or "chat-sdk" (opt-in until a live test passes)
  }),
  // Model providers and routing (src/providers, docs/manual/providers.md). Absent = unused: Dobby calls claude exactly as before.
  // strip, not strict: an unknown key here warns and is ignored like everywhere else, instead of discarding the whole file.
  providers: providersConfigSchema.strip().optional(),
  // The PR reviewer (src/reviewer, docs/manual/reviews.md): overrides of its DEFAULTS (everything on, safety limits kept). Absent = the defaults.
  // provider: who gates merges (src/reviewer-external.ts, docs/manual/external-reviewer.md); absent = "local", Dobby's own reviewer.
  review: reviewConfigSchema.extend(z.object({
    provider: z.enum(["local", "external", "both"]),
    external: z.enum(["coderabbit", "greptile", "copilot"]), externalCheck: z.string(), externalBots: z.array(z.string()),
    externalFix: z.boolean(), externalFixCap: z.number().int().min(0).max(10), externalTimeoutMin: z.number().int().min(1),
  }).partial().shape).optional(),
  // Token savings (src/savings.ts). Every key is absent by default = Dobby behaves as before; the private config turns each on.
  // ticketBudget: most one ticket may spend, by size, in percent-of-the-week points (usdPerWeekPoint dollars = 1 point; default 26, measured). Over it, the ticket goes to the owner.
  ticketBudget: z.object({ S: z.number().positive(), M: z.number().positive(), L: z.number().positive(), usdPerWeekPoint: z.number().positive() }).partial().optional(),
  // pacing.fallbackBuildsPerDay: builds started per day (configured timezone) while the Claude usage cannot be read (default 3).
  // pacing.weekCap: most of your weekly plan Dobby may use, in percent; the rest is always yours (default 95).
  pacing: z.object({ fallbackBuildsPerDay: z.number().int().min(0), weekCap: z.number().int().min(10).max(100) }).partial().optional(),
  // scout: the Talent Scout's daily run, at `scout.hour`. enabled false = never runs on its own (`dobby scout` still works); hour = when its 7-hour window opens, configured timezone (default on, 23).
  scout: z.object({
    enabled: z.boolean(), // Whether the Talent Scout runs on its own each day.
    hour: z.number().int().min(0).max(23), // The hour its 7-hour window opens, in your time zone.
  }).partial().optional(),
  // lead.onboardPromote: what happens to the first backlog of a newly onboarded project. ask (default) = `dobby init <project>` shows the tickets the Lead would queue (up to 3) and asks; with --yes, no terminal or a scheduled start nothing is queued until you run `dobby queue <id>`. auto = the Lead queues them as before. none = never at onboarding.
  lead: z.object({
    onboardPromote: z.enum(["ask", "auto", "none"]), // What happens to the first tickets of a new project. ask: you choose which to queue. auto: the Lead queues them. none: nothing is queued.
  }).partial().optional(),
  // stats: opt-in crash reports and usage stats (src/stats.ts, docs/manual/stats.md). Both are off until you say yes; no answer is off. DO_NOT_TRACK, DOBBY_STATS=off and CI force them off.
  // stats.crashes: send the error class, the place in Dobby's own code and the command when Dobby fails (never the message). stats.usage: send how far setup got and daily counts (what you can see with `dobby stats show`). stats.endpoint: where they go (default: the owner's collector, dobby-stats.nimitharia1.workers.dev); empty string = nothing is sent.
  stats: z.object({ crashes: z.boolean(), usage: z.boolean(), endpoint: z.string() }).partial().optional(),
  // retryLimit: builds one ticket may use before it goes to the owner instead of being rebuilt.
  retryLimit: z.number().int().min(1).optional(),
  // builderContextCeiling: tokens of context at which a builder run is ended and continued in a fresh run with a short handoff.
  builderContextCeiling: z.number().int().min(20_000).optional(),
  // shipPreflight: before a builder starts, check gh auth, the remote, push access and the verify command; a failure blocks the ticket with the reason. On by default; false = off.
  shipPreflight: z.boolean().optional(),
  // sameFailure: a failure with the same cause as the last build's goes to the owner instead of another build.
  sameFailure: z.boolean().optional(),
  // harnessInstall: when a build changes a dependency manifest, Dobby runs the project's install step itself (with network) before verify.
  harnessInstall: z.boolean().optional(),
  // installDomains: hosts an install may reach from inside the sandbox, besides the public package registries (a private registry).
  installDomains: z.array(z.string()).optional(),
  // freshRetries: a retry or fix build starts a fresh run (Tester notes + work so far in the prompt) instead of resuming the old, large session.
  freshRetries: z.boolean().optional(),
  // recoverOutput: a builder whose output cannot be read is recovered from its session transcript instead of counting as a wasted build.
  recoverOutput: z.boolean().optional(),
  // deployOnFailure: what a failed deploy does. notify (default) = the Retry card only; ticket = also a top-priority fix ticket;
  // fix = that ticket is built at once (`dobby run <id>`), one message, and the fix's merge deploys again. One open fix per project.
  deployOnFailure: z.enum(["notify", "ticket", "fix"]).optional(),
  // deployFrom: checkout (default) = the project's deploy_dir, pulled; worktree = a fresh worktree of origin/<base> from the
  // project's repo for each deploy (its .env* files copied in), removed afterwards, so no separate release checkout is needed.
  deployFrom: z.enum(["checkout", "worktree"]).optional(),
  // mergeChecks: which PR checks gate a merge. required (default) = the repo's required
  // checks only (every check but Dobby's review when it requires none); all = every check. DOBBY_CHECKS=all|required overrides.
  mergeChecks: z.enum(["all", "required"]).optional(),
  // reviewCap: the 5-hour % review-scan may use, when looser than the builders' pace cap (reviews unblock merges). Unset = the
  // builders' cap, as before. The week stays under pacing.weekCap either way.
  reviewCap: z.number().min(1).max(100).optional(),
  // billing: plan (default) = a Claude Pro/Max sign-in, paced by its 5-hour and weekly windows. apiKey = no plan: every run,
  // builders included, pays by the token through DOBBY_API_KEY, capped at dailyUsd per 24 hours and weeklyUsd per 7 days (the plan limits pacing.weekCap and the 5-hour pace do not apply; over the cap, `dobby limits` says Paused).
  // workspaceId: the Console workspace id (wrkspc_...), for an organisation-level key not scoped to a workspace; sent as the anthropic-workspace-id header. Not a secret.
  billing: z.object({ mode: z.enum(["plan", "apiKey"]), dailyUsd: z.number().positive().default(20), weeklyUsd: z.number().positive().optional(), workspaceId: z.string().trim().min(1).optional(), planUsd: z.number().positive().optional() }).optional(),
  // costComment: false = no cost comment on Dobby PRs (default on). billing.planUsd = what the owner pays for the plan; only the receipt card reads it.
  costComment: z.boolean().optional(),
  // Safety (src/safety.ts, README "Safety"). preset: strict (every sensitive category waits for the owner) | balanced | autonomous.
  // rules: per-category override of the preset: auto (normal review, then merge) | review (strict Opus review) | owner (needs-you card, no fix, no merge) | never (agents do not touch it).
  // classifier: model (default) | jev | none. jev = the TypeSafe classifier (@typesafe-ai/sdk), optional: needs JEV_API_KEY in the environment, else the model is used.
  // none = words only. unsure: what a classifier that cannot decide means: ask (send the owner a card) | allow (go on, at most a strict review).
  safety: z.object({
    preset: z.enum(["strict", "balanced", "autonomous"]),
    rules: z.partialRecord(z.enum(["migrations.schema", "migrations.data", "payments", "auth", "secrets", "deploys", "config", "client-sites", "releases"]), z.enum(["auto", "review", "owner", "never"])),
    classifier: z.enum(["jev", "model", "none"]),
    unsure: z.enum(["ask", "allow"]),
    // everyMerge: the floor for every merge, including changes in no category: auto | review (strict review) | owner (draft PR, the
    // owner merges). Unset = the preset's (strict: owner, else auto). deploy: after a merge, ask (a Deploy tap; also when unset) | auto (deploy at once, only when you set it).
    everyMerge: z.enum(["auto", "review", "owner"]).optional(),
    deploy: z.enum(["auto", "ask"]).optional(),
  }),
  // What `dobby migrate` found in the setup it migrated (a record; nothing reads it). Secret key NAMES only. launchdJobs is the file names of the com.dobby.* and com.foreman.* launch agents that were in ~/Library/LaunchAgents when it ran; Dobby does not install, remove or read them from here (`dobby jobs` does that).
  migrated: z.object({ at: z.string(), projects: z.array(z.string()), secretKeys: z.array(z.string()), discord: z.record(z.string(), z.string()), launchdJobs: z.array(z.string()) }).partial().optional(),
})
export type Config = z.infer<typeof Schema>

/** Keys a checked-in repo config may only add to, never replace (same rule as policy.json). */
const SAFETY = ["clientNames", "clientProjects", "frontDeskDenyMcp"] as const

const ACT = { auto: 0, review: 1, owner: 2, never: 3 } as const
const PRESET_ORDER = ["autonomous", "balanced", "strict"] as const
/** A checked-in repo file may only make safety stricter: a looser preset or rule, or another classifier, keeps the layer below's value. */
function tightenSafety(prev: Config["safety"], next: Config["safety"]): Config["safety"] {
  const eff = (s: Config["safety"]) => ({ ...PRESETS[s.preset], ...s.rules })
  const [a, b] = [eff(prev), eff(next)]
  const rules: Config["safety"]["rules"] = { ...prev.rules }
  for (const c of Object.keys(b) as (keyof typeof b)[]) if (ACT[b[c]] > ACT[a[c]]) rules[c] = b[c]
  const preset = PRESET_ORDER.indexOf(next.preset) > PRESET_ORDER.indexOf(prev.preset) ? next.preset : prev.preset
  const floor = (s: Config["safety"]) => s.everyMerge ?? EVERY_MERGE[s.preset]
  const everyMerge = ACT[floor(next)] > ACT[floor(prev)] ? floor(next) : prev.everyMerge
  const deploy = prev.deploy === "ask" || next.deploy === "ask" ? "ask" : prev.deploy
  return { preset, rules, classifier: prev.classifier, unsure: prev.unsure === "ask" || next.unsure === "ask" ? "ask" : "allow", ...(everyMerge ? { everyMerge } : {}), ...(deploy ? { deploy } : {}) }
}

/** The folder of per-install files (projects/, company.md, secrets.env, roles): where DOBBY_CONFIG lives when it is set, so a second install with its own DOBBY_CONFIG shares nothing with the first. */
export const configDir = (home = homedir(), platform = process.platform, env = process.env) =>
  env.DOBBY_CONFIG ? dirname(env.DOBBY_CONFIG) : platform === "win32" ? `${env.APPDATA ?? `${home}\\AppData\\Roaming`}\\dobby` : `${home}/.config/dobby`
export const dataDir = (home = homedir(), platform = process.platform, env = process.env) =>
  platform === "win32" ? `${env.LOCALAPPDATA ?? `${home}\\AppData\\Local`}\\dobby` : "~/.local/share/dobby"
export const privatePath = (env = process.env) => env.DOBBY_CONFIG || `${configDir(undefined, undefined, env)}/config.json`
/** The private file loadConfig reads: under `node --test` the owner fixture unless DOBBY_CONFIG names one (tests never see the owner's file). */
export const privateConfigPath = (env = process.env) => (env.NODE_TEST_CONTEXT && !env.DOBBY_CONFIG ? `${ROOT}tests/fixtures/owner-config.json` : privatePath(env))
export const repoPath = () => `${ROOT}dobby.config.json`
/**
 * Each user's project drafts, onboarding notes and knowledge maps (not in the code folder: an npx install has no writable checkout).
 * Tests read only this repo's projects/ unless DOBBY_PROJECTS is set.
 */
export const projectsDir = (env = process.env) => env.DOBBY_PROJECTS || (env.NODE_TEST_CONTEXT ? `${ROOT}tests/fixtures/projects` : `${configDir(undefined, undefined, env)}/projects`) // tests: made-up projects
/** Where drafts are read: the user's folder first, then this repo's projects/ (drafts from before the move). */
/** projects/<name>.md is a project file; <name>.knowledge.md and <name>.onboard.md are notes. A name may hold dots (example.com). */
export const isProjectDraft = (f: string) => /^\w[\w-]*(\.\w[\w-]*)*\.md$/.test(f) && !/\.(knowledge|onboard)\.md$/.test(f)
export const draftDirs = () => [projectsDir(), `${ROOT}projects`].filter((d) => d && existsSync(d))
/** An isolated install (own DOBBY_CONFIG) with no project files, while the default config folder has some: builds before 0.1.x wrote drafts there. The default folder's projects/ path, else "". Read only. */
export const strayDrafts = (env = process.env, home = homedir(), platform = process.platform) => {
  if (!env.DOBBY_CONFIG) return ""
  const has = (d: string) => existsSync(d) && readdirSync(d).some(isProjectDraft)
  const own = `${configDir(home, platform, env)}/projects`, def = `${configDir(home, platform, {})}/projects`
  return own !== def && !has(own) && has(def) ? def : ""
}
export const expand = (p: string) => p.replace(/^~/, homedir())

/** The Mac's own time zone, and its short name ("GMT+5:30", "PDT"). */
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
export const zoneLabel = (tz: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(0).find((p) => p.type === "timeZoneName")?.value ?? tz

/** Neutral starting values for a new user: the Mac's time zone, nobody's names. Each user's own values live in their private config. */
export function defaults(home = homedir(), platform = process.platform, tz = localZone()): Config {
  return {
    timezone: tz,
    timezoneLabel: zoneLabel(tz),
    quietHours: { start: 23, end: 8 },
    eveningPostHour: 21,
    github: { owner: "", accounts: [] },
    clientNames: [],
    clientProjects: [],
    frontDeskDenyMcp: [],
    safety: { preset: "balanced", rules: {}, classifier: "model", unsure: "ask" },
    paths: {
      projects: "~/projects",
      data: dataDir(home, platform),
      memory: `~/.claude/projects/${home.replace(/[/.]/g, "-")}/memory`,
      usageCli: "", // "" = the bundled claude-usage-limits; set a path to use your own copy
      dashboardDist: "", // none: the single-file dashboard
    },
    discord: {
      hq: ["needs-you", "daily-update", "system-status", "assistant"],
      apps: {},
      extraChannels: {},
    },
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)
const merge = (a: unknown, b: unknown): unknown =>
  isObj(a) && isObj(b) ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, k in b ? merge(a[k], b[k]) : a[k]])) : b === undefined ? a : b

/**
 * "unknown key <path> (ignored)" lines for dotted paths in `x` the schema does not know (records accept any key). Only review.repos["a/b"] has its values checked:
 * other records (discord.apps, providers) warned about nothing before and still do not.
 */
function unknownKeys(x: unknown, s: z.ZodTypeAny, at = ""): string[] {
  while (s instanceof z.ZodOptional || s instanceof z.ZodDefault || s instanceof z.ZodPrefault) s = s.def.innerType as z.ZodTypeAny
  if (s instanceof z.ZodRecord && isObj(x) && at.startsWith("review.")) { const v = s.valueType as z.ZodTypeAny; return Object.keys(x).flatMap((k) => unknownKeys(x[k], v, `${at}${k}.`)) }
  if (!(s instanceof z.ZodObject) || !isObj(x)) return []
  const shape = s.shape as Record<string, z.ZodTypeAny>
  return Object.keys(x).flatMap((k) => (k in shape ? unknownKeys(x[k], shape[k], `${at}${k}.`) : [`unknown key ${at}${k} (ignored)${didYouMean(k, Object.keys(shape), at)}`]))
}

/** Edit distance (insert, delete, change one letter). */
const dist = (a: string, b: string) => {
  let row = [...Array(b.length + 1).keys()]
  for (let i = 1; i <= a.length; i++) row = row.reduce<number[]>((n, _, j) => (n.push(j ? Math.min(n[j - 1] + 1, row[j] + 1, row[j - 1] + +(a[i - 1] !== b[j - 1])) : i), n), [])
  return row[b.length]
}
/** "; did you mean <key>?" when a known key at the same level is within 2 edits (case ignored). */
export const didYouMean = (k: string, known: string[], at: string) => {
  const best = known.map((n) => [n, dist(k.toLowerCase(), n.toLowerCase())] as const).sort((x, y) => x[1] - y[1])[0]
  return best && best[1] <= 2 ? `; did you mean ${at}${best[0]}?` : ""
}

const valueAt = (x: unknown, path: (string | number)[]): unknown => path.reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string | number, unknown>)[k] : undefined), x)
/** One zod issue as "<key.path>: got <value>; allowed: <values>", the key path starting at the top-level key. */
export function describeIssue(i: z.ZodIssue, key: string, value: unknown): string {
  const path = [key, ...i.path.map(String)].join("."), got = JSON.stringify(valueAt(value, i.path as (string | number)[])) ?? "nothing"
  const [problem, allowed] =
    i.code === "invalid_value" ? [`got ${got}`, i.values.join(", ")]
    : i.code === "too_big" ? [`got ${got}`, `at most ${i.maximum}`]
    : i.code === "too_small" ? [`got ${got}`, `at least ${i.minimum}`]
    : i.code === "invalid_type" ? [`got ${got}`, i.expected === "boolean" ? "true or false" : i.expected === "integer" ? "a whole number" : i.expected]
    : i.code === "custom" ? [`got ${got}`, (i.params as { allowed?: string } | undefined)?.allowed]
    : [i.message, undefined]
  return `${path}: ${problem}${allowed ? `; allowed: ${allowed}` : ""}`
}

type Load = { config: Config; warnings: string[]; sources: string[] }
/** Merge defaults < repo file < private file. A file that does not parse or validate is skipped with a warning (the layers below stay in force). */
export function loadConfig(o: { repo?: string; private?: string | null; home?: string; platform?: NodeJS.Platform } = {}): Load {
  const env = process.env
  // tests run on the owner's values (tests/fixtures/owner-config.json) unless one points DOBBY_CONFIG elsewhere
  const priv = o.private !== undefined ? o.private : privateConfigPath(env)
  let cfg = defaults(o.home, o.platform)
  const warnings: string[] = [], sources = ["defaults"]
  for (const [path, tighten] of [[o.repo ?? repoPath(), true], [priv, false]] as const) {
    if (!path || !existsSync(path)) continue
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"))
      if (!isObj(raw)) throw new Error("expected a JSON object")
      for (const w of unknownKeys(raw, Schema)) warnings.push(`${path}: ${w}`)
      const next = merge(cfg, raw) as Config
      // A bad value drops only its own top-level key (the layer below keeps it), not the whole file.
      for (const k of Object.keys(Schema.shape) as (keyof Config)[]) {
        const v = k in raw && Schema.shape[k].safeParse(next[k])
        if (!v || v.success) continue
        warnings.push(...v.error.issues.map((i) => `${path}: ${describeIssue(i, k, next[k])}`))
        ;(next as Record<string, unknown>)[k] = cfg[k]
      }
      if (tighten) for (const k of SAFETY) next[k] = [...new Set([...cfg[k], ...((raw[k] as string[] | undefined) ?? [])])]
      if (tighten) next.safety = tightenSafety(cfg.safety, next.safety)
      const r = Schema.safeParse(next)
      if (!r.success) throw new Error(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "))
      cfg = r.data
      sources.push(path)
    } catch (e) {
      warnings.push(`${path} ignored: ${(e as Error).message}`)
    }
  }
  return { config: cfg, warnings, sources }
}

/** Print warnings only when they differ from the last printed set (a hash in `file`), so a job that ticks every minute says it once. */
export function warnOnce(warnings: string[], file: string, print: (s: string) => void = console.error) {
  const hash = warnings.length ? createHash("sha1").update(warnings.join("\n")).digest("hex") : ""
  try {
    if ((existsSync(file) ? readFileSync(file, "utf8") : "") === hash) return
    if (hash) mkdirSync(dirname(file), { recursive: true }), writeFileSync(file, hash)
    else rmSync(file)
  } catch {} // no writable data dir: print every time rather than stay silent
  for (const w of warnings) print(`config: ${w}`)
}

let cached: Config | undefined
let pinned = false // setConfig(c): a test's own config, never reloaded
let stamp = "", checkedAt = 0
const stampOf = () => [repoPath(), privateConfigPath(process.env)].map((f) => { try { return statSync(f).mtimeMs } catch { return 0 } }).join(":")
/**
 * The merged config. Loaded once, then reloaded when a config file changes (checked at most once a second): a long-running process
 * (the dashboard, the tick loop) must see `dobby config set` from another terminal, not the value it started with.
 * Warnings go to stderr, once per change.
 */
export function config(): Config {
  if (cached && !pinned && Date.now() - checkedAt > 1000) { checkedAt = Date.now(); if (stampOf() !== stamp) cached = undefined }
  if (cached) return cached
  stamp = stampOf(); checkedAt = Date.now()
  const l = loadConfig()
  if (!process.env.NODE_TEST_CONTEXT) warnOnce(l.warnings, `${process.env.DOBBY_DIR ?? expand(l.config.paths.data)}/config-warnings.sha`)
  return (cached = l.config)
}
/** Tests: use this config (undefined = load again on next use). */
export const setConfig = (c?: Config) => { cached = c; pinned = !!c }

// ---- time in the configured zone ---------------------------------------------------
const fmts = new Map<string, Intl.DateTimeFormat>()
/** Milliseconds the configured zone is ahead of UTC at `ms` (Asia/Kolkata: 19_800_000, always). */
export function tzOffset(ms = Date.now(), tz = config().timezone) {
  const f = fmts.get(tz) ?? fmts.set(tz, new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })).get(tz)!
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, Number(x.value)]))
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}
/** A Date whose getUTC* fields read the configured zone's wall clock. */
export const zoned = (ms = Date.now()) => new Date(ms + tzOffset(ms))
/** "2026-10-27 21:04:07 +05:30": wall clock in the configured zone with its offset, for log lines (status shows the same zone). */
export function logStamp(ms = Date.now()) {
  const o = tzOffset(ms), a = Math.abs(o) / 60_000
  return `${zoned(ms).toISOString().slice(0, 19).replace("T", " ")} ${o < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`
}
export const zonedDay = (ms = Date.now()) => zoned(ms).toISOString().slice(0, 10)
/** Quiet hours (default 23:00-08:00): still sent at once, but silent. */
export const quietAt = (hour: number, q = config().quietHours) => (q.start > q.end ? hour >= q.start || hour < q.end : hour >= q.start && hour < q.end)

/** `gh pr merge` flags from config.github: squash and delete the branch unless the owner set otherwise. */
export function mergeFlags(c: Pick<Config, "github"> = config()): string[] {
  return [`--${c.github.mergeMethod ?? "squash"}`, ...(c.github.deleteBranch === false ? [] : ["--delete-branch"])]
}

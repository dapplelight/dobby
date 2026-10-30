// The wire shapes of the dashboard API, shared by the server (tests validate against them) and the client (parses with them).
// Panels the app does not read yet are z.unknown(); each later PR tightens the ones it starts using.
import { z } from "zod"

const Limits = z.union([
  z.object({
    five: z.object({ used: z.number(), resetsAt: z.number().nullable() }),
    week: z.object({ used: z.number(), cap: z.number(), resetsAt: z.number() }),
    ratio: z.number(),
    state: z.enum(["running", "paused-5h", "paused-week", "unknown"]),
    resumesAt: z.number().nullable(),
    line: z.string(),
  }),
  z.object({ state: z.enum(["unknown", "apiKey"]), line: z.string() }),
])

const NowRow = z.looseObject({ id: z.number(), title: z.string(), app: z.string(), since: z.string(), minutes: z.number() })

const Check = z.object({ name: z.string(), state: z.enum(["pass", "fail", "wait"]) })
const Diff = z.object({ add: z.number(), del: z.number(), files: z.number() })
/** One Needs-you row. `offers` are the action names it can send to POST /api/action. */
export const InboxRow = z.object({
  key: z.string(), kind: z.enum(["merge", "deploy", "answer", "decide"]), id: z.number().nullable(), project: z.string(), ref: z.string(), title: z.string(),
  status: z.string(), primary: z.string(), warn: z.boolean(), url: z.string().nullable(), branch: z.string().nullable(), checks: z.array(Check), diff: Diff.nullable(), age: z.string(), offers: z.array(z.string()),
})
export const WorkingRow = z.object({ key: z.string(), id: z.number(), project: z.string(), ref: z.string(), title: z.string(), role: z.string(), round: z.number(), of: z.number(), step: z.string(), age: z.string(), stuck: z.boolean() })
/** An action the server holds for 8 s (merge, deploy, decline, retry) so it can be undone; a finished one stays a few seconds with its result. */
export const Held = z.object({
  actionId: z.string(), action: z.string(), id: z.number().nullable(), project: z.string().nullable(), ref: z.string(), title: z.string(),
  runsAt: z.number(), state: z.enum(["held", "running", "ran", "failed"]), message: z.string().optional(),
})

/** The order of work. `estPct` is the Lead's estimate in % of the week; `fits` is false from the stop line down. */
export const QueueRow = z.object({
  id: z.number(), n: z.number(), ref: z.string(), project: z.string(), title: z.string(), size: z.string(), estPct: z.number(), leftPct: z.number(), doneWhen: z.string(), filed: z.string(), fits: z.boolean(),
  waitsOn: z.string().nullable(), state: z.string(), running: z.boolean(),
})
export const ParkedRow = z.object({ id: z.number(), ref: z.string(), project: z.string(), title: z.string(), size: z.string(), estPct: z.number(), age: z.string() })
export const IdeaCard = z.object({
  id: z.number(), project: z.string(), title: z.string(), source: z.string(), lens: z.string().nullable(), why: z.string().nullable(), size: z.string().nullable(), score: z.number().nullable(),
})
const Sizes = z.object({ S: z.number(), M: z.number(), L: z.number() })
export const QueuePanel = z.looseObject({
  order: z.array(QueueRow), parked: z.array(ParkedRow), ideas: z.array(IdeaCard), estimates: Sizes,
  room: z.number().nullable(), queuedPct: z.number(), stopPct: z.number().nullable(), resetsAt: z.number().nullable(),
})
const Mark = z.enum(["done", "running", "waiting"])
/** One goal: a mark per ticket, the count, the milestone's due date (ISO) and a plain status. */
export const GoalRow = z.object({
  id: z.number(), project: z.string(), title: z.string(), draft: z.boolean(), done: z.number(), total: z.number(), due: z.string().nullable(), status: z.string(), late: z.boolean(),
  marks: z.array(Mark), left: z.array(z.object({ id: z.number(), ref: z.string(), title: z.string(), mark: Mark })),
})

/** New ticket: the form and POST /api/action { action: "add" } validate with the same schema. */
export const NewTicket = z.object({
  project: z.string().regex(/^\w[\w-]*(\.\w[\w-]*)*$/, "Pick a project"),
  title: z.string().trim().min(1, "Say what to build").max(300, "Keep it under 300 characters"),
  done_when: z.string().trim().max(2000, "Keep it under 2000 characters").optional(),
  size: z.enum(["S", "M", "L"]).optional(),
})

const Severity = z.enum(["high", "medium", "low"])
/** One review finding on a PR: where it sits, what the reviewer said, the replacement it suggested, and what became of it. `was` is the diff's own text on that line. */
export const FindingView = z.object({
  id: z.number(), file: z.string(), line: z.number(), severity: Severity, word: z.string(), kind: z.string(), text: z.string(), fix: z.string(),
  suggestion: z.string().nullable(), was: z.string().nullable(), round: z.number(), state: z.enum(["open", "fixed", "queued", "dismissed", "ruled"]), rule: z.string(),
})
export const FileView = z.object({ path: z.string(), add: z.number(), del: z.number(), blocking: z.number(), findings: z.number() })
export const RoundView = z.object({ n: z.number(), at: z.string(), verdict: z.enum(["pass", "fail"]), what: z.string() })
/** GET /api/ticket/:id. `diff` is `git diff <base>...<branch>` from the ticket's clone, clipped at 200 KB (`clipped` = characters left out). */
export const TicketDetail = z.looseObject({
  id: z.number(), app: z.string(), title: z.string(), status: z.string(), branch: z.string().nullable(), note: z.string().nullable(), doneWhen: z.string().nullable(),
  runs: z.array(z.unknown()), runsUsd: z.number(), spent: z.string(),
  pr: z.object({ repo: z.string(), pr: z.number(), url: z.string() }).nullable(),
  files: z.array(FileView), findings: z.array(FindingView), rounds: z.array(RoundView), diff: z.object({ text: z.string(), clipped: z.number() }).nullable(),
})
export const ReviewRow = z.object({
  repo: z.string(), pr: z.number(), ref: z.string(), ticket: z.number().nullable(), title: z.string(), url: z.string(), verdict: z.string(),
  b: z.number(), s: z.number(), n: z.number(), round: z.number(), files: z.number().nullable(), tookMin: z.number().nullable(), at: z.string(),
})
/** GET /api/reviews: the review dashboard. */
export const ReviewsPage = z.object({
  at: z.number(),
  numbers: z.object({
    reviewed: z.number(), sentBackPct: z.number().nullable(), medianMinutes: z.number().nullable(), fixedPct: z.number().nullable(), reverts: z.number(),
    findings: z.object({ total: z.number(), fixed: z.number(), dismissed: z.number(), open: z.number() }),
    kinds: z.array(z.object({ kind: z.string(), b: z.number(), s: z.number(), n: z.number(), total: z.number() })),
    weeks: z.array(z.object({ from: z.number(), label: z.string(), reviews: z.number(), pct: z.number().nullable() })),
  }),
  scoreboard: z.looseObject({ opened: z.number(), sentBack: z.number(), merged: z.number() }),
  prs: z.array(ReviewRow),
})

/** One line of Activity: who did what, to which ticket, and how it came out. `tone` colours the result; `problem` is what the Problems filter counts. */
export const ActivityEvent = z.object({
  id: z.string(), t: z.number(), role: z.string(), kind: z.enum(["run", "review", "merge", "ticket"]), text: z.string(), ref: z.string(), result: z.string(),
  tone: z.enum(["plain", "good", "warn"]), problem: z.boolean(), sentBack: z.boolean(), ticket: z.number().nullable(),
})
const Sent = z.object({ state: z.enum(["sent", "failed", "not-sent", "waiting"]), to: z.string(), at: z.number().nullable(), text: z.string() })
/** The morning summary: the Chief of Staff's text (`preview` = not sent yet, built from today's facts), where it went, and the numbers beside it. */
export const MorningSummary = z.object({
  text: z.string(), preview: z.boolean(), sent: Sent, plan: z.number().nullable(), runs: z.number(), retried: z.number(),
  main: z.object({ reverts: z.number(), failingDeploys: z.array(z.string()) }),
})
/** GET /api/activity?since=&before=&kind=: a page of events (100), the filter counts, and, on the first page, the summary. */
export const ActivityPage = z.object({
  at: z.number(), since: z.number(), kind: z.enum(["all", "merges", "reviews", "problems"]), events: z.array(ActivityEvent), more: z.boolean(),
  counts: z.object({ all: z.number(), merges: z.number(), reviews: z.number(), problems: z.number() }),
  headline: z.object({ merged: z.number(), sentBack: z.number(), retries: z.number() }),
  summary: MorningSummary.nullable(),
})
const SpendRow = z.object({ name: z.string(), pct: z.number(), usd: z.number(), merged: z.number().nullable(), perMerged: z.number().nullable(), count: z.number().nullable(), countWord: z.string() })
const Reading = z.object({ t: z.number(), pct: z.number() })
/** GET /api/spend. Plan mode: percent of the plan's week. API-key mode (`mode`): rows hold dollars (`usd`) and `pct` is the share of the weekly budget. */
export const SpendPage = z.object({
  at: z.number(), mode: z.enum(["plan", "apiKey"]), used: z.number(), cap: z.number().nullable(), startsAt: z.number().nullable(), resetsAt: z.number().nullable(),
  five: z.object({ used: z.number(), resetsAt: z.number().nullable(), series: z.array(Reading) }).nullable(),
  top: z.string().nullable(), projects: z.array(SpendRow), roles: z.array(SpendRow),
  past: z.array(z.object({ start: z.number(), landed: z.number().nullable(), usd: z.number(), series: z.array(Reading) })),
  unused: z.object({ pct: z.number(), weeks: z.number(), usd: z.number().nullable() }).nullable(),
  api: z.object({ spentUsd: z.number(), weeklyUsd: z.number(), weeklySet: z.boolean().optional(), dailyUsd: z.number(), todayUsd: z.number().nullable() }).nullable(),
})

export const ActionReply = z.object({ ok: z.boolean(), message: z.string(), actionId: z.string().optional(), runsAt: z.number().optional() })

export const Snapshot = z.looseObject({
  at: z.number(),
  inbox: z.object({ total: z.number(), rows: z.array(InboxRow) }),
  working: z.array(WorkingRow),
  teamLive: z.array(z.string()).default([]),
  week: z.object({ series: z.array(z.object({ t: z.number(), pct: z.number() })) }),
  held: z.array(Held).default([]),
  projects: z.array(z.string()).default([]),
  days: z.number(),
  limits: Limits.nullable(),
  now: z.looseObject({
    building: z.array(NowRow),
    ready: z.array(NowRow),
    stuck: z.array(NowRow.extend({ state: z.string(), reason: z.string() })),
    lastTick: z.number().nullable(),
    lastTickAgo: z.string().nullable(),
    lastRunAgo: z.string().nullable(),
    jobs: z.object({ ok: z.number(), total: z.number(), failing: z.array(z.object({ name: z.string(), detail: z.string(), since: z.string() })) }),
  }),
  needsMe: z.array(z.looseObject({ reason: z.string(), action: z.string(), items: z.array(z.looseObject({ title: z.string(), since: z.string() })) })),
  paused: z.unknown(),
  pause: z.array(z.unknown()),
  outcomes: z.looseObject({ shipped: z.number() }), quality: z.unknown(), spend: z.unknown(), goals: z.unknown(), queue: QueuePanel, goalRows: z.array(GoalRow), reviews: z.unknown(),
  telemetry: z.unknown(), health: z.unknown(), scoreboard: z.unknown(), receipt: z.unknown(),
})

/** What /api/events sends: `event:` names the type, `data:` is the JSON below. */
export const SnapshotEvent = Snapshot
export const HeartbeatEvent = z.object({})
export const EVENT_SCHEMAS = { snapshot: SnapshotEvent, heartbeat: HeartbeatEvent, run: ActivityEvent, review: ActivityEvent, merge: ActivityEvent, ticket: ActivityEvent } as const

export type Snapshot = z.infer<typeof Snapshot>
export type Limits = z.infer<typeof Limits>
export type InboxRow = z.infer<typeof InboxRow>
export type WorkingRow = z.infer<typeof WorkingRow>
export type Held = z.infer<typeof Held>
export type QueueRow = z.infer<typeof QueueRow>
export type QueuePanel = z.infer<typeof QueuePanel>
export type IdeaCard = z.infer<typeof IdeaCard>
export type GoalRow = z.infer<typeof GoalRow>
export type NewTicket = z.infer<typeof NewTicket>
export type ActionReply = z.infer<typeof ActionReply>
export type FindingView = z.infer<typeof FindingView>
export type TicketDetail = z.infer<typeof TicketDetail>
export type ReviewsPage = z.infer<typeof ReviewsPage>
export type ReviewRow = z.infer<typeof ReviewRow>
export type ActivityEvent = z.infer<typeof ActivityEvent>
export type ActivityPage = z.infer<typeof ActivityPage>
export type MorningSummary = z.infer<typeof MorningSummary>
export type SpendPage = z.infer<typeof SpendPage>

// ---- Settings, Team, First run (PR 6) -------------------------------------------------------------------------------------------------
/** One setting: its default, what it holds now, and where that came from. `desc` is the text in docs/manual/config.md. */
export const ConfigKey = z.object({
  key: z.string(), section: z.string(), kind: z.enum(["boolean", "number", "enum", "string", "list", "map"]), type: z.string(), desc: z.string(),
  options: z.array(z.string()).optional(), min: z.number().optional(), max: z.number().optional(),
  default: z.unknown(), value: z.unknown(), source: z.enum(["default", "config file", "project file"]), changed: z.boolean(),
})
/** GET /api/config. Secrets are names with set / not set only. */
export const ConfigView = z.object({
  at: z.number(), file: z.string(), repoFile: z.string(), secretsFile: z.string(), warnings: z.array(z.string()), keys: z.array(ConfigKey), secrets: z.array(z.object({ name: z.string(), set: z.boolean() })),
})
const Share = z.object({ usd: z.number(), pct: z.number() })
export const TeamProject = z.object({
  name: z.string(), path: z.string(), branch: z.string(), paused: z.boolean(), open: z.number(), needsYou: z.number(), share: Share, lastMerge: z.string().nullable(),
})
export const TeamRole = z.object({
  name: z.string(), edited: z.boolean(), title: z.string(), file: z.string(), does: z.string(), model: z.string().nullable(), effort: z.string().nullable(), rules: z.array(z.string()), ruleCount: z.number(),
  pauseKind: z.string().nullable(), paused: z.boolean(), share: Share.nullable(),
})
/** GET /api/team. */
export const TeamView = z.object({ at: z.number(), billing: z.enum(["plan", "apiKey"]), projects: z.array(TeamProject), roles: z.array(TeamRole) })
export const RoleText = z.object({ name: z.string(), text: z.string() })
const HealthCheck = z.object({ name: z.string(), ok: z.boolean(), detail: z.string(), fix: z.string().optional(), required: z.boolean() })
export const ScheduleRow = z.object({ name: z.string(), what: z.string(), when: z.string(), next: z.number().nullable() })
/** GET /api/health: the `dobby doctor` basics, and the jobs with their next run. */
export const HealthView = z.object({ at: z.number(), checks: z.array(HealthCheck), schedules: z.array(ScheduleRow) })
export const ProviderRow = z.object({
  id: z.string(), label: z.string(), kind: z.enum(["code tool", "model API", "local"]), detected: z.boolean(),
  key: z.enum(["signed in", "set", "not set", "not signed in", "unknown", "none needed"]), enabled: z.boolean().nullable(),
})
export const ProvidersView = z.object({ at: z.number(), routing: z.boolean(), rows: z.array(ProviderRow), hidden: z.number() })
/** GET /api/welcome: shown when `needed` (no project yet). */
export const WelcomeView = z.object({ needed: z.boolean(), root: z.string(), repos: z.array(z.object({ name: z.string(), path: z.string(), added: z.boolean() })), leaves: z.array(z.string()) })

export type ConfigKey = z.infer<typeof ConfigKey>
export type ConfigView = z.infer<typeof ConfigView>
export type TeamView = z.infer<typeof TeamView>
export type TeamRole = z.infer<typeof TeamRole>
export type HealthView = z.infer<typeof HealthView>
export type ProvidersView = z.infer<typeof ProvidersView>
export type WelcomeView = z.infer<typeof WelcomeView>

/** GET /api/setup/state (`dobby init --ui` only): everything the setup page shows. Secrets appear as set / not set. */
export type SetupVerify = { state: "waiting" | "running" | "ok" | "failed"; step: "install" | "test" | null; command: string | null; secs: number | null; last: string; fix: string | null; testsOff: boolean; notes: string[] }
export type SetupState = {
  platform: string; fresh: boolean; finished: boolean
  checks: { name: string; ok: boolean; required: boolean; detail: string; fix: string | null }[] | null
  blocking: string[]
  stats: { answered: boolean; forced: string | null }
  roots: string[]; commonRoots: string[]
  repos: { name: string; path: string; from: string; pm: string; install: string; test: string | null; base: string; remote: string | null; hasTests: boolean; byPath: boolean; fork: { question: string; options: { value: "fork" | "upstream"; label: string }[]; use: "fork" | "upstream" } | null }[]
  /** repos left out: no GitHub remote, or GitHub Enterprise */
  skipped: { text: string; fix: string | null }[]
  verify: Record<string, SetupVerify>
  chat: { discordToken: boolean }
  tools: { name: string; what: string; on: boolean; found: boolean; install: string[] | null; note: string }[]
  installed: Record<string, boolean>
  help: { ok: boolean; reason: string | null }
  /** what another machine's DOBBY_OWNER marker said (main's two-machines warning) */
  markerWarnings: string[]
  ownerMismatch: { configured: string; login: string } | null
  dobbyCommand: { command: string; why: string } | null
  /** things only the terminal takes (a bot token, an API key): the command to run */
  terminal: { name: string; command: string; why: string }[]
  weekCap: number; settingsSaved: boolean
  jobList: { name: string; what: string }[]
  jobs: { state: "none" | "installed" | "later"; rows: { name: string; ok: boolean; detail: string }[] }
  jobsAvailable: boolean
  candidates: { project: string; remote: string; number: number; title: string; text: string }[] | null
  ticket: string | null
  saved: { config: string; projects: string; data: string; configDir: string }
  mergesPaused: boolean
}

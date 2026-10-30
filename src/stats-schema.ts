// The one list of what opt-in crash reports and usage stats may send (docs/manual/stats.md is generated from it). The client (src/stats.ts),
// the Worker (stats-worker/) and scripts/gen-docs.ts all import this file. An event with a field or value that is not here is not valid, so it is never sent
// and the Worker answers 400. Every field has a short description: that text is the manual.
import { z } from "zod"

export const STEPS = ["checks", "repos", "chat", "tools", "settings", "jobs", "first_ticket"] as const
export const REASONS = ["gh_missing", "gh_signed_out", "claude_missing", "claude_signed_out", "git_missing", "node_old", "no_repos", "tests_failed", "skipped", "other"] as const
export const HELP_KINDS = ["no-commands", "verify-failed", "check"] as const
export const PLANS = ["pro", "max", "max20", "api", "unknown"] as const
export const ROLES = ["builder", "checker", "qa", "tester", "reviewer", "lead", "product-manager", "area-pm", "scout", "front-desk", "chief-of-staff", "designer", "onboarder", "program-manager"] as const
export const FEATURES = ["dashboard", "mcp_stdio", "mcp_http", "discord_buttons", "brief_sent", "deploy_tap", "role_override", "config_set"] as const

const d = <T extends z.ZodTypeAny>(s: T, text: string) => s.describe(text)
const bucket = <T extends [string, ...string[]]>(vals: T, text: string) => d(z.enum(vals), text)
export const COUNT: ["0", "1-2", "3-5", "6+"] = ["0", "1-2", "3-5", "6+"]
export const countBucket = (n: number): (typeof COUNT)[number] => (n <= 0 ? "0" : n <= 2 ? "1-2" : n <= 5 ? "3-5" : "6+")
const tens = (text: string) => d(z.number().int().min(0).max(100).refine((n) => n % 10 === 0, "a multiple of 10"), text)

/** On every event. */
const Base = {
  install: d(z.string().uuid(), "random id made when you said yes; `dobby stats reset-id` makes a new one"),
  v: d(z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}$/), "Dobby version"),
  os: d(z.enum(["darwin", "linux"]), "operating system"),
  node: d(z.number().int().min(1).max(99), "Node major version"),
  day: d(z.string().regex(/^\d{4}-\d{2}-\d{2}$/), "UTC date, no time"),
}
const ev = <N extends string, P extends z.ZodRawShape>(name: N, props?: P) =>
  z.object({ ...Base, name: z.literal(name), ...(props ? { props: z.object(props).strict() } : {}) }).strict()

export const Event = z.discriminatedUnion("name", [
  ev("setup_started"),
  ev("setup_step", { step: d(z.enum(STEPS), "which setup step"), ok: d(z.boolean(), "whether it passed"), reason: d(z.enum(REASONS).optional(), "why it did not pass, from a fixed list") }),
  ev("setup_done"),
  ev("first_ticket"),
  ev("first_pr"),
  ev("first_merge"),
  ev("first_week_report"),
  ev("setup_help", { kind: d(z.enum(HELP_KINDS), "what the help was asked about: a repo with no commands, a repo that failed to verify, or a failed machine check"), ok: d(z.boolean(), "whether Claude gave an answer that could be read") }),
  ev("heartbeat", {
    plan: d(z.enum(PLANS), "your Claude plan, from billing.planUsd (20 pro, 100 max, 200 max20) or api in API-key mode"),
    projects: bucket(["0", "1", "2-3", "4+"], "how many projects, as a range"),
    shipped: bucket(COUNT, "tickets shipped in the last 24 hours, as a range"),
    sent_back: bucket(["0", "<25", "25-50", "50+"], "share of pull requests the reviewer sent back in the last 7 days, in percent, as a range"),
    safety: d(z.enum(["strict", "balanced", "autonomous"]), "safety.preset"),
    review_auto: d(z.enum(["off", "drafts", "on"]), "review.auto"),
    merges_paused: d(z.boolean(), "whether merging is paused"),
    chat: d(z.enum(["terminal", "discord"]), "where Dobby asks you things"),
    week_cap: tens("pacing.weekCap, rounded down to a multiple of 10"),
    week_used: d(tens("share of the weekly plan used when the last week reset, rounded down to a multiple of 10").optional(), "absent when no reading exists"),
    features: d(z.object(Object.fromEntries(FEATURES.map((f) => [f, z.boolean()])) as Record<(typeof FEATURES)[number], z.ZodBoolean>).strict(), `which of these were used in the last 24 hours: ${FEATURES.join(", ")}`),
    roles: d(z.object(Object.fromEntries(ROLES.map((r) => [r, bucket(COUNT, "runs in the last 24 hours, as a range").optional()])) as unknown as Record<(typeof ROLES)[number], z.ZodOptional<z.ZodEnum<{ "0": "0"; "1-2": "1-2"; "3-5": "3-5"; "6+": "6+" }>>>).strict(), "runs per role in the last 24 hours, as a range; only roles that ran"),
  }),
  ev("crash", {
    kind: d(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), "the error's class name, like TypeError"),
    where: d(z.array(z.string().regex(/^[\w-][\w./-]{0,119}:\d{1,6}$/)).max(8), "file:line of frames inside Dobby's own package, paths relative to the package; other frames are dropped"),
    command: d(z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), "the dobby subcommand or job that failed"),
    code: d(z.string().regex(/^[A-Z][A-Z0-9_]{0,40}$/).optional(), "Dobby's own error code, if the error had one"),
  }),
])
export type StatsEvent = z.infer<typeof Event>
export type EventName = StatsEvent["name"]

/** The shapes the Worker and the docs walk. */
export const EVENT_NAMES = ["setup_started", "setup_step", "setup_done", "first_ticket", "first_pr", "first_merge", "first_week_report", "setup_help", "heartbeat", "crash"] as const
export const FUNNEL = ["setup_started", "setup_step", "setup_done", "first_ticket", "first_pr", "first_merge", "first_week_report"] as const
export const MAX_BODY = 16 * 1024
export const MAX_CRASHES_PER_DAY = 10
export const MAX_EVENTS_PER_INSTALL_PER_DAY = 200

/** One line per event for the manual: when it is sent. */
export const WHEN: Record<EventName, string> = {
  setup_started: "once, when `dobby init` starts (usage stats)",
  setup_step: "once per setup step (usage stats)",
  setup_done: "once, when `dobby init` finishes (usage stats)",
  first_ticket: "once, the first time a ticket exists (usage stats)",
  first_pr: "once, the first time a ticket has a pull request (usage stats)",
  first_merge: "once, the first time a ticket has merged (usage stats)",
  first_week_report: "once, the first time the 7-day scoreboard or receipt was read (usage stats)",
  setup_help: "once, the first time you click Ask Claude in setup (usage stats)",
  heartbeat: "at most once a day (usage stats)",
  crash: "when Dobby fails with an unexpected error, at most 10 a day (crash reports)",
}

/** [event, field, type, description] for the manual. */
export function fieldRows(): { event: string; field: string; type: string; text: string }[] {
  const type = (s: z.ZodTypeAny): string => {
    while (s instanceof z.ZodOptional) s = s.unwrap() as z.ZodTypeAny
    if (s instanceof z.ZodEnum) return (s.options as string[]).join(" \\| ")
    if (s instanceof z.ZodBoolean) return "true \\| false"
    if (s instanceof z.ZodNumber) return "number"
    if (s instanceof z.ZodArray) return "list of text"
    if (s instanceof z.ZodObject) return "object"
    return "text"
  }
  const text = (s: z.ZodTypeAny): string => s.description ?? (s instanceof z.ZodOptional ? text(s.unwrap() as z.ZodTypeAny) : "")
  const rows: { event: string; field: string; type: string; text: string }[] = []
  const common = (Event.options[0].shape as Record<string, z.ZodTypeAny>)
  for (const k of ["install", "v", "os", "node", "day"]) rows.push({ event: "every event", field: k, type: type(common[k]), text: text(common[k]) })
  for (const o of Event.options) {
    const name = (o.shape.name as z.ZodLiteral<string>).value
    const props = (o.shape as Record<string, z.ZodTypeAny>).props as z.ZodObject<z.ZodRawShape> | undefined
    if (!props) { rows.push({ event: name, field: "", type: "", text: "no other fields" }); continue }
    for (const [k, v] of Object.entries(props.shape as Record<string, z.ZodTypeAny>)) rows.push({ event: name, field: `props.${k}`, type: type(v), text: text(v) })
  }
  return rows
}

// The one list of Dobby words a new user would not know. Each entry says what the thing is and what it does for you,
// and points at the manual section that explains it. tests/dashboard-glossary.test.ts checks every docs path against docs/manual,
// and scripts/gen-docs.ts builds docs/manual/glossary.md from this list (npm run docs).
export const MANUAL = "https://github.com/dapplelight/dobby/blob/main/docs/manual"

export type Entry = { name: string; short: string; docs: string }

const ROLES = "roles.md#supporting-roles"
const TICKETS = "how-it-works.md#tickets"
const WAITS = "what-waits.md#needs-you"
const PACING = "pacing.md#the-weekly-cap"

export const GLOSSARY = {
  "engineering-manager": { name: "Engineering Manager", short: "The role that plans the work. It moves tickets from the backlog to the queue and writes new ones.", docs: "roles.md#engineering-manager" },
  builder: { name: "Builder", short: "The role that writes the code for a ticket, on its own branch, inside the sandbox.", docs: "roles.md#builder" },
  tester: { name: "Tester", short: "The role that checks a finished build against the ticket's done-when line. It can read files but not change them.", docs: "roles.md#tester" },
  "code-reviewer": { name: "Code Reviewer", short: "The role that reviews every pull request Dobby opens and posts its findings on GitHub.", docs: "roles.md#code-reviewer" },
  "product-manager": { name: "Product Manager", short: "The role that ranks problems against your goals and writes idea cards and specs for large tickets.", docs: "roles.md#product-manager" },
  "chief-of-staff": { name: "Chief of Staff", short: "The role that sends you a short brief every morning and evening.", docs: "roles.md#chief-of-staff" },
  "talent-scout": { name: "Talent Scout", short: "A daily run that picks one role, looks for better skills for it and reviews the last 24 hours. Any change it makes arrives as a pull request.", docs: "roles.md#talent-scout" },
  "support-role": { name: "Supporting role", short: "A smaller role that runs only when a ticket or a command needs it.", docs: ROLES },
  ticket: { name: "Ticket", short: "A unit of work with a project, a title, a done-when line, a size and a priority. Everything Dobby builds starts as one.", docs: TICKETS },
  backlog: { name: "Backlog", short: "Tickets that are written but not queued. Nothing is built until you or the Engineering Manager queues one.", docs: TICKETS },
  queue: { name: "Queue", short: "Tickets marked ready, in the order builders will take them. Reorder it to change what gets built first.", docs: TICKETS },
  ready: { name: "Ready", short: "Queued and waiting for a free builder.", docs: TICKETS },
  ideas: { name: "Ideas", short: "Suggestions from the Product Manager, the Engineering Manager and the Talent Scout. Turn one into a ticket or dismiss it.", docs: "roles.md#product-manager" },
  size: { name: "Size", short: "S, M or L, a rough measure of how big a ticket is. It sets how much of your week Dobby expects the ticket to use.", docs: "write-a-ticket.md#pick-a-size" },
  "done-when": { name: "Done when", short: "The line the Tester checks the finished work against.", docs: TICKETS },
  goals: { name: "Goals", short: "The larger outcomes your tickets belong to. They come from GitHub milestones or the Goals list in a project's dobby.md.", docs: "how-it-works.md#goals" },
  "needs-you": { name: "Needs you", short: "Things Dobby will not do alone: a merge you asked to approve, a deploy, or a question from a builder.", docs: WAITS },
  paused: { name: "Paused", short: "Stopped on purpose. A pause can cover everything, one part, one project or one ticket, and ends when you resume it.", docs: "pause-and-resume.md#pause-one-part" },
  "safety-preset": { name: "Safety preset", short: "How much Dobby may merge without you. Balanced, Strict or Autonomous. You can override single categories.", docs: "what-waits.md#safety-presets" },
  "every-merge": { name: "Merging", short: "The minimum every merge must meet: merge on its own, a strict review first, or you merge it yourself.", docs: "what-waits.md#the-floor-for-every-merge" },
  classifier: { name: "Classifier", short: "What decides which safety category a change belongs to, such as payments or auth. The model is the default.", docs: "safety-categories.md#categories" },
  "stop-at": { name: "Stop at", short: "The share of your weekly plan Dobby may use. The rest of the week is yours.", docs: PACING },
  "five-hour": { name: "5-hour window", short: "Your plan also has a 5-hour limit. Dobby spreads the week across these windows so one busy window does not use up the week.", docs: "pacing.md#the-5-hour-window" },
  "review-cap": { name: "Review cap", short: "How much of the 5-hour window reviews may use. It can be higher than the builders' share, because reviews unblock merges.", docs: "config.md#reviewcap" },
  billing: { name: "Billing", short: "Plan mode runs on the part of your Claude plan you do not use. API key mode spends dollars, with a daily cap.", docs: "billing.md#which-one" },
} as const satisfies Record<string, Entry>

export type TermKey = keyof typeof GLOSSARY

/** Role names as the dashboard shows them (file name or title) to their entry. */
const ROLE_NAMES: Record<string, TermKey> = {
  "engineering manager": "engineering-manager", lead: "engineering-manager", builder: "builder", tester: "tester", checker: "tester", "code reviewer": "code-reviewer", reviewer: "code-reviewer",
  "product manager": "product-manager", "product manager (one area)": "product-manager", "chief of staff": "chief-of-staff", "talent scout": "talent-scout", scout: "talent-scout",
  designer: "support-role", onboarder: "support-role", "front desk": "support-role", "program manager": "support-role", brainstorm: "support-role", company: "support-role",
  "engineer (backend)": "support-role", "engineer (mobile)": "support-role", "engineer (web)": "support-role",
}
export const roleKey = (name: string): TermKey | undefined => ROLE_NAMES[name.trim().toLowerCase()]

/** Settings rows that carry a glossary term, by config key. */
export const SETTING_TERMS: Record<string, TermKey> = {
  "safety.preset": "safety-preset", "safety.everyMerge": "every-merge", "safety.classifier": "classifier", "pacing.weekCap": "stop-at", reviewCap: "review-cap", "billing.mode": "billing", "scout.enabled": "talent-scout",
}

export const termUrl = (docs: string) => `${MANUAL}/${docs}`

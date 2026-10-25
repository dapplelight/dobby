// What needs the owner, in one table (Meta Muse / xAI Grok Bot style): one rule per thing, "ask first" always beats "allow".
// Precedence: deny > ask > allow > default (allow). Callers decide what each action means for them:
//   ticket-text  deny = owner-only, never up to a model; ask = owner-only unless Jev frees it (needsOwner, lead.ts)
//   changed-path ask = sensitive: the merge is big and the review is Opus (mergeIsBig, gateRules)
//   deploy       ask = a migration that changes existing data waits for the owner (changesData)
//   command      documents the Builder's deny list; claude enforces BUILDER_DENY (ticket.ts), not this table
// An optional policy.json at the repo root (an array of rules) appends new rules and can only make a built-in rule stricter (see loadRules).
import { existsSync, readFileSync } from "node:fs"
import { config } from "./config.ts"

export type Kind = "ticket-text" | "changed-path" | "command" | "deploy"
export type Action = "deny" | "ask" | "allow"
// projects: the rule applies only to these projects (absent = every project, and also when the caller does not know the project).
// titleOnly: the pattern is tested on the ticket title alone when the caller gives one (soft words in done_when are prose, not intent).
export type Rule = { id: string; applies: Kind; match: string; action: Action; why: string; projects?: string[]; titleOnly?: boolean }
// ownerWords: false = the project's frontmatter says `owner_words: off`: the soft word rules (SOFT) do not apply to it (owner-marker and client-name always do).
export type Ctx = { project?: string; title?: string; ownerWords?: boolean }
export type Decision = { action: Action; rule: string; why: string; matches: Rule[] }

export const KINDS: Kind[] = ["ticket-text", "changed-path", "command", "deploy"]
const ACTIONS: Action[] = ["deny", "ask", "allow"]

export const DEFAULT_RULES: Rule[] = [
  // Ticket title + done_when. deny = never up to a model (the old OWNER_HARD); ask = the old OWNER_ONLY word list.
  { id: "owner-marker", applies: "ticket-text", match: "^owner:", action: "deny", why: "an explicit Owner: ticket" },
  { id: "client-name", applies: "ticket-text", projects: config().clientProjects, match: config().clientNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "(?!)", action: "deny", why: "a real client: client invites, code and deploys are never agent work (owner, 16 Oct)" },
  { id: "ship", applies: "ticket-text", titleOnly: true, match: "deploy|migrat|production|release", action: "ask", why: "deploys, production migrations and releases are the owner's" },
  { id: "play-release", applies: "ticket-text", match: "play console", action: "ask", why: "Play Console and Play releases are the owner's" },
  { id: "secrets", applies: "ticket-text", match: "secret|token", action: "ask", why: "secrets, keys and login tokens are the owner's" },
  { id: "payments", applies: "ticket-text", match: "payment", action: "ask", why: "payments stay with the owner" },
  { id: "real-financial-data", applies: "ticket-text", match: "real financ\\w* data", action: "ask", why: "real financial data is private" },
  { id: "client-invite", applies: "ticket-text", projects: config().clientProjects, match: "client|couple|rsvp", action: "ask", why: "may be a paying client's wedding invite (client guard)" },
  // Changed file paths (the old ALWAYS_BIG). Markdown never counts, whatever its name says (docs/android/sort-payments.md was flagged).
  // Second branch (audit 20 Oct, item 5): what agents read as instructions or what enforces their limits, markdown included:
  // role prompts, skills, project rules, bin/ (the guard hook), agent rules and settings, the ticket/review graphs, lib, front desk,
  // Scout, messaging (telegram, discord), the CLI, the secrets scan, merge and this file.
  { id: "sensitive-path", applies: "changed-path", match: "^(?:(?![\\s\\S]*\\.(?-i:mdx?)$)[\\s\\S]*(migrat|drizzle|\\.sql$|wrangler\\.(toml|jsonc?)$|\\.env|auth|billing|payment|eas\\.json|app\\.json$|(^|/)policy\\.json$|(^|/)src/policy\\.ts$)|(?:roles/|skills/|projects/|bin/|agent-rules\\.md$|(?:^|/)agent-rules/|agent-settings\\.json$|src/graphs/(?:ticket|review)\\.ts$|src/(?:lib|frontdesk|scout|policy|telegram|discord|cli|scan|merge)\\.ts$))", action: "ask", why: "schema, deploy config, secrets, auth or payments, or agent prompts, rules and guards: big merge, Opus review" },
  // Migration SQL at deploy time (comments stripped by the caller).
  { id: "data-migration", applies: "deploy", match: "\\b(update|insert|delete|truncate|merge)\\b|\\balter\\s+table\\b[^;]*\\b(drop|rename)\\b|\\balter\\s+column\\b[^;]*\\btype\\b|\\b(modify|change)\\s+column\\b|\\bdrop\\s+(?:if\\s+exists\\s+)?(table|column|index|view|materialized\\s+view|schema|database|sequence|type|trigger|function)\\b|\\bcreate\\s+(?:\\w+\\s+)*table\\b[^;]*\\bas\\s+(select|with)\\b|\\breplace\\s+into\\b", action: "ask", why: "the migration changes existing data: the owner runs it" },
  // Shell commands: mirrors BUILDER_DENY in ticket.ts (that list is what claude enforces).
  { id: "push", applies: "command", match: "^git push\\b", action: "deny", why: "agents never push; ship does" },
  { id: "checkout-main", applies: "command", match: "^git checkout main\\b", action: "deny", why: "agents stay on their ticket branch" },
  { id: "wrangler", applies: "command", match: "^(npx )?wrangler\\b", action: "deny", why: "Cloudflare deploys are the deploy step's, not the Builder's" },
  { id: "rm-rf", applies: "command", match: "^rm -rf\\b", action: "deny", why: "no recursive force deletes" },
]

/** The soft ticket-text word rules a project can switch off with `owner_words: off` (projects/<p>.md). */
const SOFT = ["ship", "play-release", "secrets", "payments", "real-financial-data", "client-invite"]

const STRICT = { deny: 0, ask: 1, allow: 2 } // lower = stricter

/**
 * DEFAULT_RULES with policy.json applied. An override can only add rules or make a built-in rule STRICTER (same id, same pattern,
 * action deny > ask > allow); it can never lower an action or narrow a pattern, so the file cannot switch a gate off
 * (review, 20 Oct). A bad file is reported in POLICY_ERROR and ignored: the built-in rules stay in force and the system stays up.
 */
export function loadRules(path = new URL("../policy.json", import.meta.url).pathname): { rules: Rule[]; error?: string } {
  if (!existsSync(path)) return { rules: DEFAULT_RULES }
  try {
    const extra = JSON.parse(readFileSync(path, "utf8")) as Rule[]
    if (!Array.isArray(extra)) throw new Error("expected an array of rules")
    const out = [...DEFAULT_RULES]
    for (const r of extra) {
      if (!r || typeof r.id !== "string" || !KINDS.includes(r.applies) || !ACTIONS.includes(r.action) || typeof r.match !== "string") throw new Error(`bad rule ${JSON.stringify(r)}`)
      new RegExp(r.match, "i") // throws on a bad pattern
      if (r.projects !== undefined && !(Array.isArray(r.projects) && r.projects.every((x) => typeof x === "string"))) throw new Error(`bad rule ${JSON.stringify(r)}`)
      const i = out.findIndex((x) => x.id === r.id)
      if (i < 0) out.push({ ...r, why: r.why ?? "" })
      else if (STRICT[r.action] < STRICT[out[i].action]) out[i] = { ...out[i], action: r.action, why: r.why ?? out[i].why }
    }
    return { rules: out }
  } catch (e) {
    return { rules: DEFAULT_RULES, error: `policy.json ignored, built-in rules in force: ${(e as Error).message}` }
  }
}

const loaded = loadRules()
export const POLICY_ERROR = loaded.error
if (POLICY_ERROR && !process.env.NODE_TEST_CONTEXT) console.error(`policy: ${POLICY_ERROR}`)
export const RULES = loaded.rules
const compiled = new Map<string, RegExp>()
const re = (src: string) => compiled.get(src) ?? compiled.set(src, new RegExp(src, "i")).get(src)!

/**
 * Every rule of this kind that matches, and the winner: deny > ask > allow > default allow. Pure.
 * ctx (ticket-text callers): the ticket's project scopes rules with `projects`; its title is what `titleOnly` rules read.
 */
export function decide(kind: Kind, text: string, rules: Rule[] = RULES, ctx: Ctx = {}): Decision {
  const matches = rules.filter((r) => r.applies === kind && (!r.projects || !ctx.project || r.projects.includes(ctx.project)) && !(ctx.ownerWords === false && SOFT.includes(r.id)) && re(r.match).test(r.titleOnly && ctx.title !== undefined ? ctx.title : text))
  for (const action of ACTIONS) {
    const r = matches.find((m) => m.action === action)
    if (r) return { action, rule: r.id, why: r.why, matches }
  }
  return { action: "allow", rule: "default", why: "no rule matches", matches }
}

/** `dobby policy explain`: each kind, its matching rules and the winner. */
export function explain(text: string, rules: Rule[] = RULES): string {
  return KINDS.map((k) => {
    const d = decide(k, text, rules)
    return [`${k}: ${d.action.toUpperCase()} (${d.rule}: ${d.why})`, ...d.matches.map((m) => `  ${m.id === d.rule ? "*" : " "} ${m.action} ${m.id}: /${m.match}/i, ${m.why}`)].join("\n")
  }).join("\n")
}

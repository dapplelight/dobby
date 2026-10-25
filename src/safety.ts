// Configurable safety (config key `safety`): what sensitive work an agent may do alone, with a strict review, or not at all.
// One classify() reads the ticket text, the changed files and the SQL; one actionFor() turns the categories into an action.
// Used at queue/promote time (needsOwner, splitBacklog, queueTicket), in fixReview and ownerLand, and at land time (the ticket graph).
//   migrations: deterministic, from the SQL of the changed files (no migration file = no migration category, whatever the title says).
//   secrets, deploys, config: words and paths. payments, auth, client-sites, releases: a word/path pre-filter, then the classifier
//   (config safety.classifier: model (default) | jev | none). The classifier sees ticket text and a changed-files summary, never a diff.
import { config, type Config } from "./config.ts"
import { decide, DEFAULT_RULES, RULES, type Ctx, type Rule } from "./policy.ts"
import { EVERY_MERGE, PRESETS, type Act, type Category } from "./presets.ts"

export { CATEGORIES, ACTIONS, PRESETS, PRESET_NAMES, type Act, type Category } from "./presets.ts"
export type Safety = Config["safety"]

const RANK: Record<Act, number> = { auto: 0, review: 1, owner: 2, never: 3 }
export const stricter = (a: Act, b: Act) => (RANK[b] > RANK[a] ? b : a)
export const ownerLevel = (a: Act) => a === "owner" || a === "never"

/** The action for every category: the preset, then the per-category `rules` on top. */
export const resolve = (s: Safety = config().safety): Record<Category, Act> => ({ ...PRESETS[s.preset], ...s.rules })

// ---- migrations: deterministic ----------------------------------------------------------------------------------------------------
const DOCS = /\.mdx?$/i
export const isMigrationFile = (p: string) => !DOCS.test(p) && (/\.sql$/i.test(p) || /(^|\/)(migrations?|drizzle)\/.*\.(ts|js|py)$/i.test(p))
// One left-to-right pass so a comment marker inside a string (or a quote inside a comment) is never misread; string contents and
// referential actions (ON DELETE CASCADE, drizzle writes them on every foreign key) are not statements.
const stripSql = (sql: string) => sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, (m) => (m.startsWith("'") ? "''" : " ")).replace(/\bon\s+(?:delete|update)\s+(?:cascade|restrict|no\s+action|current_timestamp(?:\(\d*\))?|set\s+(?:null|default))\b/gi, " ")
/** True when this SQL rewrites, moves or deletes existing data (the policy `data-migration` rule); CREATE TABLE/INDEX and ALTER TABLE ADD are schema. */
export const sqlChangesData = (sql: string) => decide("deploy", stripSql(sql)).action !== "allow"
// .ts/.js/.py migrations: the SQL sits inside quoted strings and ORM calls hide the rest, so strings are NOT stripped and the ORM
// operations that drop, rename, rewrite or delete are matched too (Knex, Prisma/Drizzle, Sequelize, Alembic, Django, Rails). Fail safe:
// the file is schema only when it is not destructive AND it shows a recognised schema-adding operation; anything else is data.
const ORM_DESTRUCTIVE = /drop_?(table|column|index|constraint|schema|view)|remove_?(column|field|index|model|reference|foreign_?key|constraint)|rename_?(column|table|field|model|index)|alter_?(column|field|table)|change_?(column|table)|delete_?(model|from)|(bulk_?)?(delete|update|destroy|truncate)(_all|_many|many|From|Where)?\s*\(|\b(RunPython|RunSQL|RemoveField|DeleteModel|RenameField|RenameModel|AlterField|AlterModelTable|execute|executeRaw|queryRaw|raw|migrate_data|data_migration|update_all|delete_all)\b/i
const ORM_SCHEMA = /create_?table|add_?column|create_?index|add_?index|add_?field|add_?reference|CreateModel|AddField|AddIndex|(pg|sqlite|mysql)Table|CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)|ADD\s+COLUMN/i
/** Same as sqlChangesData for a migration file by path; a non-.sql file goes through the ORM check above. */
export const migrationChangesData = (path: string, text: string) => {
  if (/\.sql$/i.test(path)) return sqlChangesData(text)
  const t = text.replace(/\bon_?(?:delete|update)\s*\(/gi, " ").replace(/\bon\s+(?:delete|update)\s+(?:cascade|restrict|no\s+action|current_timestamp(?:\(\d*\))?|set\s+(?:null|default))\b/gi, " ")
  return ORM_DESTRUCTIVE.test(t) || decide("deploy", t).action !== "allow" || !ORM_SCHEMA.test(t)
}
/** Added lines of each migration file in a unified diff: { path, sql }. */
export function sqlFromDiff(diff: string): { path: string; sql: string }[] {
  return diff.split(/^diff --git /m).slice(1).flatMap((chunk) => {
    const path = /^a\/.+? b\/(.+?)\s*$/m.exec(chunk)?.[1] // the new path (b/): a renamed migration is listed under it
    if (!path || !isMigrationFile(path)) return []
    return [{ path, sql: chunk.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n") }]
  })
}

// ---- word and path pre-filters ----------------------------------------------------------------------------------------------------
const nonDoc = (re: RegExp) => (p: string) => !DOCS.test(p) && re.test(p)
const DOCS_TITLE = /^\s*(docs?|documentation|readme|changelog)\b/i // a title that starts as docs work: "payments" in it is prose (PR #101 review)
const TEXT: Record<string, RegExp> = {
  payments: /payment|billing|checkout|invoice|stripe|razorpay/i,
  auth: /\bauth|log ?in\b|sign[- ]?(in|up)\b|sessions?\b|oauth|permission/i,
  secrets: /secret|\btokens?\b|api key|password|credential|real financ\w* data/i,
  config: /\bconfig/i,
}
const TITLE: Record<string, RegExp> = { deploys: /deploy|production/i, releases: /release|play console|play store|app store|publish/i }
const PATH: Record<string, (p: string) => boolean> = {
  payments: nonDoc(/payment|billing/i), auth: nonDoc(/(^|\/)auth|oauth/i), secrets: nonDoc(/\.env|(^|\/)secrets?\b/i),
  deploys: nonDoc(/wrangler\.(toml|jsonc?)$|(^|\/)\.github\/workflows\/|(^|\/)dockerfile/i), config: nonDoc(/wrangler\.(toml|jsonc?)$|eas\.json$|app\.json$|\.config\.\w+$/i),
  releases: nonDoc(/eas\.json$|(^|\/)fastlane\//i),
}
const CLIENT_TEXT = /client|couple|rsvp|invite/i
// client folders, plus any path naming a client from config clientNames (read per call: tests and setup change the config)
const clientPathRe = () => { const names = config().clientNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"); return new RegExp(`(^|[/-])clients?\\/|couple${names ? `|${names}` : ""}`, "i") }
/** Demo sources (templates/, demo/, demos/) are not client work even when named rsvp*; client folders inside them still are (owner 16 Oct, PR #16). */
export const clientPath = (p: string) => { const re = clientPathRe(); return re.test(p.replace(/\/?\b(templates|demos?)\/[\w./-]*/g, (m) => (re.test(m) ? m : " "))) || (/rsvp/i.test(p) && !/(^|\/)(templates|demos?)\//.test(p)) }

/** A real client folder or a named client's file: firm, no classifier can free it. Narrower than clientPath (no couple/rsvp substrings in product files). */
export const firmClientPath = (p: string) => {
  const names = config().clientNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")
  return new RegExp(`(^|/)clients?/${names ? `|(^|[/-])(${names})[-_/]` : ""}`, "i").test(p.replace(/\/?\b(templates|demos?)\/(?!clients?\/)[\w./-]*/g, (m) => (new RegExp(`(^|[/-])(${names || "(?!)"})[-_/]`, "i").test(m) ? m : " ")))
}

export type Input = { text: string; title?: string; files?: string[]; sql?: { path: string; sql: string }[]; project?: string; ownerWords?: boolean }
const FUZZY = ["payments", "auth", "client-sites", "releases"] as const
const DETERMINISTIC = ["secrets", "deploys", "config"] as const

/** Categories the words and paths suggest. Cheap, local, over-eager on purpose: the classifier trims it. */
export function candidates(i: Input): Category[] {
  const files = i.files ?? []
  const title = i.title ?? i.text
  const soft = i.ownerWords !== false // owner_words: off in a project's dobby.md frees the soft text words, not the paths
  const out = new Set<Category>()
  for (const c of ["payments", "auth", "secrets", "config"] as const) if ((soft && TEXT[c].test(i.text) && !(c === "payments" && DOCS_TITLE.test(title))) || files.some(PATH[c])) out.add(c)
  for (const c of ["deploys", "releases"] as const) if ((soft && TITLE[c].test(title)) || files.some(PATH[c])) out.add(c)
  if (/play console/i.test(i.text) && soft) out.add("releases")
  if ((soft && !!i.project && config().clientProjects.includes(i.project) && CLIENT_TEXT.test(i.text)) || (!!i.project && config().clientProjects.includes(i.project) && files.some(clientPath))) out.add("client-sites")
  return [...out]
}

// ---- classification ---------------------------------------------------------------------------------------------------------------
export type Result = { categories: Category[]; why: Partial<Record<Category, string>>; unsure: Category[]; denied?: string; noAnswer?: Category[] }
export type Opts = { fetcher?: typeof fetch; db?: import("./db.ts").DB; useJev?: boolean; ask?: (prompt: string) => Promise<string | undefined>; safety?: Safety }

const QUESTION: Record<(typeof FUZZY)[number], string> = {
  payments: "Does this change handle real money: charging, billing, refunds, payouts, subscriptions or payment provider code? Say no if payment is only a word in docs, copy or a list.",
  auth: "Does this change how people sign in, sessions, passwords, tokens, permissions or access control? Say no if it only uses an existing login or mentions it in text.",
  "client-sites": "Does this change a real paying client's own site or its data (a wedding invite, a client folder)? Say no for demos, templates, dummy data or our own product features.",
  releases: "Does this publish or submit a release to users (an app store or Play Console release, a version publish)? Say no if it only changes code, copy or docs.",
}
const summary = (i: Input) => `Ticket: ${i.text.slice(0, 1200)}\nChanged files (${i.files?.length ?? 0}): ${(i.files ?? []).slice(0, 40).join(", ")}`

let warned = false
const warnNoKey = () => { if (!warned && !process.env.NODE_TEST_CONTEXT) (warned = true, console.error("safety: classifier is jev but the Jev key is not set; using the model")) }
type Verdict = "yes" | "no" | "unsure" | undefined // undefined: no model could answer
async function jev(i: Input, cats: Category[], f?: typeof fetch): Promise<Record<string, Verdict>> {
  const { ask, jevKey } = await import("./jev.ts") // optional service: loaded only when classifier is "jev"
  if (!jevKey()) return (warnNoKey(), {})
  const a = await ask(summary(i), Object.fromEntries(cats.map((c) => [c, { type: "choice" as const, question: QUESTION[c as (typeof FUZZY)[number]], options: ["yes", "no"], fallback: "unsure" }])), f)
  return Object.fromEntries(cats.map((c) => [c, a[c].fromJev ? (a[c].value as Verdict) : undefined]))
}
async function modelAsk(i: Input, cats: Category[], o: Opts): Promise<Record<string, Verdict>> {
  const ask = o.ask ?? (o.db ? defaultModel(o.db) : undefined)
  if (!ask) return {}
  try {
    const text = await ask(`Judge a software change. ${summary(i)}\n\nFor each category answer "yes", "no" or "unsure":\n${cats.map((c) => `- ${c}: ${QUESTION[c as (typeof FUZZY)[number]]}`).join("\n")}\nAnswer with ONLY one JSON object like {"${cats[0]}":"no"}.`)
    const j = JSON.parse(/\{[\s\S]*\}/.exec(text ?? "")?.[0] ?? "null") as Record<string, string> | null
    return Object.fromEntries(cats.map((c) => [c, j && ["yes", "no", "unsure"].includes(j[c]) ? (j[c] as Verdict) : undefined]))
  } catch { return {} }
}
const defaultModel = (db: import("./db.ts").DB) => async (prompt: string) => {
  const { claude } = await import("./lib.ts")
  const r = await claude(db, { project: "dobby", kind: "safety-classify", model: "haiku", args: ["--setting-sources", "project", "--tools", ""], prompt })
  return r.ok ? r.text : undefined
}

/**
 * The categories this change touches. files/sql are optional (queue time has only the text). Never throws: a classifier that
 * errors falls back (Jev -> the model -> the words alone), so a failure can only make Dobby more careful, never skip a check.
 */
export async function classify(i: Input, o: Opts = {}): Promise<Result> {
  const s = o.safety ?? config().safety
  const table = resolve(s)
  const why: Result["why"] = {}
  const cats = new Set<Category>()
  const denied = hardDeny(i)
  const mig = (i.files ?? []).filter(isMigrationFile)
  if (mig.length) {
    const bad = mig.map((p) => ({ p, sql: i.sql?.find((x) => x.path === p)?.sql })).find((m) => m.sql === undefined || migrationChangesData(m.p, m.sql))
    const c: Category = bad ? "migrations.data" : "migrations.schema"
    cats.add(c)
    why[c] = bad ? (bad.sql === undefined ? `${bad.p}: SQL not readable, so treated as data-changing` : `${bad.p} changes existing data${/\.sql$/i.test(bad.p) ? "" : " (or is not a recognised schema-only change)"}`) : `${mig.join(", ")}: schema only`
  }
  const cand = candidates(i)
  for (const c of cand) if ((DETERMINISTIC as readonly string[]).includes(c)) { cats.add(c); why[c] = "matched by words or file paths" }
  // a client folder in the changed files is firm (client guard): only the words in the ticket text go to the classifier
  if (i.project && config().clientProjects.includes(i.project) && (i.files ?? []).some(firmClientPath)) { cats.add("client-sites"); why["client-sites"] = "a client folder among the changed files" }
  const fuzzy = cand.filter((c) => (FUZZY as readonly string[]).includes(c) && table[c] !== "auto" && !(c === "client-sites" && cats.has(c))) // an auto category needs no judging
  for (const c of cand) if (fuzzy.includes(c) === false && (FUZZY as readonly string[]).includes(c) && !cats.has(c)) { cats.add(c); why[c] = "matched by words (rule is auto, not judged)" }
  const unsure: Category[] = [], noAnswer: Category[] = []
  if (fuzzy.length) {
    let v: Record<string, Verdict> = {}
    if (s.classifier === "jev" && o.useJev !== false) v = await jev(i, fuzzy, o.fetcher).catch(() => ({}))
    const rest = fuzzy.filter((c) => v[c] === undefined || v[c] === "unsure")
    if (s.classifier !== "none" && rest.length) v = { ...v, ...Object.fromEntries(Object.entries(await modelAsk(i, rest, o)).filter(([, x]) => x !== undefined)) }
    for (const c of fuzzy) {
      const a = s.classifier === "none" ? undefined : v[c]
      if (a === "no") continue
      cats.add(c)
      if (a === "unsure") (unsure.push(c), (why[c] = "the classifier was not sure"))
      else if (a === "yes") why[c] = "the classifier confirmed it"
      else (noAnswer.push(c), (why[c] = s.classifier === "none" ? "matched by words" : "matched by words (no classifier answer)"))
    }
  }
  return { categories: [...cats], why, unsure, denied, noAnswer: s.classifier === "none" ? [] : noAnswer }
}

/** The hard rules that no preset switches off: an explicit Owner: ticket and a real client's name (policy deny rules). */
function hardDeny(i: Input): string | undefined {
  const ctx: Ctx = { project: i.project, title: i.title, ownerWords: i.ownerWords }
  const d = decide("ticket-text", i.text.trim(), undefined, ctx)
  if (d.action === "deny") return d.why
  const p = (i.files ?? []).map((f) => f.replace(/\/?\b(templates|demos?)\/[\w./-]*/g, (m) => (clientPathRe().test(m) ? m : " "))).find((f) => decide("ticket-text", f, undefined, ctx).action === "deny")
  return p ? `a real client's name in ${p}` : undefined
}

export type Outcome = { action: Act; category?: Category; why: string; per: { category: Category; action: Act; unsure: boolean; why: string }[] }
/** The strictest action over the categories. An unsure category is owner when `unsure: ask`, else capped at review. */
export function actionFor(r: Result, s: Safety = config().safety): Outcome {
  const table = resolve(s)
  const per = r.categories.map((category) => {
    const unsure = r.unsure.includes(category)
    let action = table[category]
    if (unsure) action = s.unsure === "ask" ? stricter(action, "owner") : ownerLevel(action) ? "review" : action
    return { category, action, unsure, why: r.why[category] ?? "" }
  })
  if (r.denied) per.unshift({ category: "client-sites", action: "owner", unsure: false, why: r.denied })
  const top = per.reduce<(typeof per)[number] | undefined>((a, b) => (!a || RANK[b.action] > RANK[a.action] ? b : a), undefined)
  return top ? { action: top.action, category: top.category, why: `${top.category}: ${top.why || "rule " + top.action}`, per } : { action: "auto", why: "nothing sensitive", per }
}

/** A merge's action with the every-merge floor on top (safety.everyMerge, else the preset's). Fix rounds don't merge, so they skip it. */
export const everyMergeFloor = (s: Safety = config().safety) => s.everyMerge ?? EVERY_MERGE[s.preset]
export function mergeAction<T extends { action: Act; why: string }>(o: T, s: Safety = config().safety): T {
  const floor = everyMergeFloor(s)
  if (RANK[floor] <= RANK[o.action]) return o
  return { ...o, action: floor, why: `every merge ${floor === "owner" ? "waits for you" : "gets the strict review"} (${s.everyMerge ? "safety.everyMerge" : `the ${s.preset} preset`})` }
}

/**
 * A missing classifier answer is not a verdict (#169): when an owner-level outcome rests on one, ask once more. Still no
 * answer = the careful path (owner), and the reason says the classifier did not answer rather than that it judged.
 */
export async function checkTwice<T extends { action: Act; why: string; result: Result }>(run: () => Promise<T>): Promise<T> {
  const a = await run()
  if (!ownerLevel(a.action) || !a.result.noAnswer?.length) return a
  const b = await run()
  return ownerLevel(b.action) && b.result.noAnswer?.length ? { ...b, why: `${b.why}; the classifier gave no answer twice, so it waits for you` } : b
}

/** classify + actionFor. */
export async function check(i: Input, o: Opts = {}) {
  const result = await classify(i, o)
  return { result, ...actionFor(result, o.safety) }
}

// ---- ticket text only, synchronous (queue, promote, backlog split) -----------------------------------------------------------------
/**
 * "deny": a hard rule. "free": no category at owner level (or none at all). "ask": a word suggests an owner-level category and only a
 * classifier verdict can free it. Pure; files and SQL are not known yet, so migrations never show up here.
 * A policy.json ask rule of its own (an id the built-in rules do not have) holds the ticket like an owner-level word (#649).
 */
export function ticketGate(text: string, ctx: Ctx = {}, s: Safety = config().safety, rules: Rule[] = RULES): "deny" | "free" | "ask" {
  const d = decide("ticket-text", text.trim(), rules, ctx)
  if (d.action === "deny") return "deny"
  if (d.matches.some((r) => r.action === "ask" && !DEFAULT_RULES.some((b) => b.id === r.id))) return "ask"
  const table = resolve(s)
  return candidates({ text, title: ctx.title, project: ctx.project, ownerWords: ctx.ownerWords }).some((c) => ownerLevel(table[c])) ? "ask" : "free"
}
/** What an unanswered "ask" means: the `unsure` setting. */
export const unsureOwner = (s: Safety = config().safety) => s.unsure === "ask"

// ---- dobby safety explain -------------------------------------------------------------------------------------------------------
export function explainOutcome(o: Awaited<ReturnType<typeof check>>, s: Safety = config().safety) {
  const lines = [`preset: ${s.preset}${Object.keys(s.rules).length ? ` + rules ${JSON.stringify(s.rules)}` : ""}, classifier: ${s.classifier}, unsure: ${s.unsure}`]
  lines.push(o.per.length ? `categories: ${o.per.map((p) => p.category).join(", ")}` : "categories: none")
  for (const p of o.per) lines.push(`  ${p.category}: ${p.action}${p.unsure ? " (unsure)" : ""}${p.why ? `, ${p.why}` : ""}`)
  lines.push(`action: ${o.action.toUpperCase()}`, `why: ${o.why}`)
  return lines.join("\n")
}

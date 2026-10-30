// The config as the dashboard and `dobby config set` see it: every setting with its default, source and description (GET /api/config),
// and the one write path: validate a key and value against the config schema, then change ONLY the private config file (atomic).
// Never touches secrets.env; secrets appear here as set / not set. Descriptions come from docs/manual/config.md, which scripts/gen-docs.ts
// builds from the comments in config.ts, so there is one source for the text.
import { fileURLToPath } from "node:url"
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { z } from "zod"
import { defaults, describeIssue, didYouMean, loadConfig, privateConfigPath, privatePath, repoPath, Schema, type Config } from "./config.ts"
import { readSecrets, secretsFile } from "./notify.ts"
import { EVERY_MERGE } from "./presets.ts"
import { DEFAULTS as REVIEW } from "./reviewer/settings.ts"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

/** A refusal with a plain message (actions.ts turns it into the dashboard's and the MCP's own error). */
export class ConfigError extends Error {}

// ---- the schema, walked ---------------------------------------------------------------------------------------------------------

const unwrap = (s: z.ZodTypeAny): z.ZodTypeAny => {
  for (;;) {
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) s = s.unwrap() as z.ZodTypeAny
    else if (s instanceof z.ZodDefault || s instanceof z.ZodPrefault) s = s.def.innerType as z.ZodTypeAny
    else return s
  }
}
/** `migrated` is a record of what `dobby migrate` found; nothing reads it, so it is not a setting. */
const HIDDEN = new Set(["migrated"])
export type Kind = "boolean" | "number" | "enum" | "string" | "list" | "map"

const kindOf = (s: z.ZodTypeAny): { kind: Kind; options?: string[]; min?: number; max?: number } => {
  s = unwrap(s)
  if (s instanceof z.ZodBoolean) return { kind: "boolean" }
  if (s instanceof z.ZodEnum) return { kind: "enum", options: [...(s.options as string[])] }
  if (s instanceof z.ZodNumber) {
    const ck = (s.def.checks ?? []).map((c) => c._zod.def as { check: string; value?: number })
    return { kind: "number", min: ck.find((c) => c.check === "greater_than")?.value, max: ck.find((c) => c.check === "less_than")?.value }
  }
  if (s instanceof z.ZodString) return { kind: "string" }
  if (s instanceof z.ZodArray) return { kind: "list" }
  return { kind: "map" }
}

/** Every setting a person can change, in schema order. Records and lists are one setting each. */
export function leaves(schema: z.ZodTypeAny = Schema, path: string[] = []): { key: string; schema: z.ZodTypeAny }[] {
  const s = unwrap(schema)
  if (s instanceof z.ZodObject) {
    return Object.entries(s.shape as Record<string, z.ZodTypeAny>).flatMap(([k, v]) => (path.length === 0 && HIDDEN.has(k) ? [] : leaves(v, [...path, k])))
  }
  return [{ key: path.join("."), schema: s }]
}

/** The schema at a dotted key, or what the caller can try instead. */
export function resolve(key: string): { schema: z.ZodTypeAny } | { error: string } {
  const path = key.split(".")
  let s: z.ZodTypeAny = Schema
  for (let i = 0; i < path.length; i++) {
    const seg = path[i], at = path.slice(0, i).join(".")
    s = unwrap(s)
    if (s instanceof z.ZodObject) {
      const names = Object.keys(s.shape as object).filter((k) => !(i === 0 && HIDDEN.has(k)))
      if (!names.includes(seg)) return { error: `unknown setting ${[...path.slice(0, i), seg].join(".")}${didYouMean(seg, names, at ? `${at}.` : "")}; valid ${at ? `under ${at}` : "top-level"} settings: ${names.join(", ")}` }
      s = (s.shape as Record<string, z.ZodTypeAny>)[seg]
    } else if (s instanceof z.ZodRecord) {
      const k = (s.keyType as z.ZodTypeAny).safeParse(seg)
      if (!k.success) return { error: `${at}: ${seg} is not one of ${unwrap(s.keyType as z.ZodTypeAny) instanceof z.ZodEnum ? (unwrap(s.keyType as z.ZodTypeAny) as z.ZodEnum).options.join(", ") : "the allowed names"}` }
      s = s.valueType as z.ZodTypeAny
    } else return { error: `${at} is a single value; it has no setting called ${seg}` }
  }
  const end = unwrap(s)
  if (end instanceof z.ZodObject) return { error: `${key} is a group; set one of: ${Object.keys(end.shape as object).map((k) => `${key}.${k}`).join(", ")}` }
  return { schema: s }
}

// ---- values -------------------------------------------------------------------------------------------------------------------------

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)
const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T))
export const valueAt = (x: unknown, path: string[]): unknown => path.reduce<unknown>((v, k) => (isObj(v) ? v[k] : undefined), x)
function setAt(o: Record<string, unknown>, path: string[], v: unknown) {
  let cur = o
  for (const k of path.slice(0, -1)) cur = isObj(cur[k]) ? (cur[k] as Record<string, unknown>) : (cur[k] = {})
  cur[path[path.length - 1]] = v
}
/** Remove the key, and any group it leaves empty. */
function unsetAt(o: Record<string, unknown>, path: string[]) {
  const chain: Record<string, unknown>[] = [o]
  for (const k of path.slice(0, -1)) { const n = chain.at(-1)![k]; if (!isObj(n)) return; chain.push(n) }
  delete chain.at(-1)![path.at(-1)!]
  for (let i = chain.length - 1; i > 0; i--) if (!Object.keys(chain[i]).length) delete chain[i - 1][path[i - 1]]
}

/** Text from the terminal or an agent into the value the setting wants: 95, true, ["a","b"], or the words as they are for a text setting. */
export function parseValue(raw: unknown, schema: z.ZodTypeAny): unknown {
  if (typeof raw !== "string") return raw
  const t = unwrap(schema)
  let json: unknown, ok = true
  try { json = JSON.parse(raw) } catch { ok = false }
  if (t instanceof z.ZodString) return ok && typeof json === "string" ? json : raw
  if (t instanceof z.ZodArray && !ok) return raw.split(",").map((x) => x.trim()).filter(Boolean)
  return ok ? json : raw
}

// ---- the private file ---------------------------------------------------------------------------------------------------------------

/** The private config as an object ({} when there is no file yet). Refuses a file that is not a JSON object, so a typo is never overwritten. */
export function readPrivate(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {}
  let j: unknown
  try { j = JSON.parse(readFileSync(file, "utf8")) } catch (e) { throw new ConfigError(`${file} is not valid JSON (${(e as Error).message}). Fix it by hand first; nothing was changed.`) }
  if (!isObj(j)) throw new ConfigError(`${file} is not a JSON object. Fix it by hand first; nothing was changed.`)
  return j
}

/** Write next to the file, then rename over it: a reader never sees half a file. Keeps the file's own indent, trailing newline and permissions. */
function writeAtomic(file: string, obj: Record<string, unknown>) {
  const old = existsSync(file) ? readFileSync(file, "utf8") : ""
  const indent = old.match(/^([ \t]+)"/m)?.[1] ?? "  "
  const tail = !old || old.endsWith("\n") ? "\n" : ""
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, null, indent) + tail, { mode: existsSync(file) ? statSync(file).mode & 0o777 : 0o600 })
  renameSync(tmp, file)
}

/** What an agent over MCP may change. Anything that loosens safety, moves a path or adds a model provider is the owner's own change (dashboard or terminal). */
const AGENT_OK = /^(pacing\.|reviewCap$|scout\.|quietHours\.|eveningPostHour$|retryLimit$|costComment$|timezone$|timezoneLabel$)/

export type SetArgs = { key: string; value?: unknown; unset?: boolean }
export type SetPlan = { file: string; key: string; path: string[]; priv: Record<string, unknown>; before: unknown; unset: boolean; value?: unknown }
/** Check a change without making it: the same refusals as the write, and what the key holds now (for an undo). Throws ConfigError. */
export function prepareSet(a: SetArgs, o: { file?: string; agent?: boolean } = {}): SetPlan {
  const file = o.file ?? (process.env.NODE_TEST_CONTEXT && !process.env.DOBBY_CONFIG ? "" : privatePath())
  if (!file) throw new ConfigError("Under tests a config file has to be named (DOBBY_CONFIG); the owner's real one is never written.")
  const key = (a.key ?? "").trim()
  if (!key) throw new ConfigError("This needs a setting, like pacing.weekCap. `dobby config show` lists them.")
  const r = resolve(key)
  if ("error" in r) throw new ConfigError(r.error)
  if (o.agent && !AGENT_OK.test(key)) throw new ConfigError(`${key} is for the owner to change, from the dashboard or \`dobby config set\`. An agent over MCP may change pacing, scout, quiet hours and similar settings only.`)
  const path = key.split("."), priv = readPrivate(file), before = valueAt(priv, path)
  if (a.unset) return { file, key, path, priv, before, unset: true }
  if (a.value === undefined) throw new ConfigError(`This needs a value: dobby config set ${key} <value>.`)
  const value = parseValue(a.value, r.schema)
  const leaf = r.schema.safeParse(value)
  if (!leaf.success) throw new ConfigError(leaf.error.issues.map((i) => describeIssue(i, key, value)).join("; "))
  // The whole top-level setting must still be valid with this change (billing.dailyUsd alone, without billing.mode, is not).
  const eff = loadConfig({ private: file }).config as unknown as Record<string, unknown>
  const next = { [path[0]]: clone(eff[path[0]]) } as Record<string, unknown>
  setAt(next, path, value)
  const top = Schema.shape[path[0] as keyof Config].safeParse(next[path[0]])
  if (!top.success) throw new ConfigError(top.error.issues.map((i) => describeIssue(i, path[0], next[path[0]])).join("; "))
  return { file, key, path, priv, before, unset: false, value }
}

/**
 * `dobby config set <key> <value>` / `unset <key>`: the same for the terminal, the dashboard and MCP. Returns the sentence to show.
 * `file` is the private config (tests inject a temp one; under `node --test` the real file is never written).
 */
export function configSetText(a: SetArgs, o: { file?: string; agent?: boolean } = {}): string {
  const p = prepareSet(a, o)
  if (p.unset) {
    if (p.before === undefined) return `${p.key} is not set in ${p.file}; nothing to remove.`
    unsetAt(p.priv, p.path)
    writeAtomic(p.file, p.priv)
    return `${p.key} back to its default (was ${JSON.stringify(p.before)}), saved to ${p.file}`
  }
  setAt(p.priv, p.path, p.value)
  writeAtomic(p.file, p.priv)
  return `${p.key} ${p.before === undefined ? "set to" : `${JSON.stringify(p.before)} to`} ${JSON.stringify(p.value)}, saved to ${p.file}`
}

// ---- GET /api/config ------------------------------------------------------------------------------------------------------------------

/** What the code uses when a setting is absent, for the settings whose default is not in defaults() (config.ts says "default N" in their comments). */
export const EFFECTIVE_DEFAULTS: Record<string, unknown> = {
  "pacing.weekCap": 95, "pacing.fallbackBuildsPerDay": 3, "scout.enabled": true, "scout.hour": 23, "lead.onboardPromote": "ask",
  "github.mergeMethod": "squash", "github.deleteBranch": true, "github.mirrorPublic": false, "board.issues": true,
  deployOnFailure: "notify", deployFrom: "checkout", mergeChecks: "required", costComment: true,
  "billing.mode": "plan", "billing.dailyUsd": 20, "ticketBudget.usdPerWeekPoint": 26, "providers.enabled": false, "stats.crashes": false, "stats.usage": false, "stats.endpoint": "https://dobby-stats.nimitharia1.workers.dev", "review.provider": "local",
}

type Row = { type: string; note: string }
/** key -> the docs table row; top-level key -> its intro text. */
export function docRows(file = `${ROOT}docs/manual/config.md`): { rows: Map<string, Row>; intro: Map<string, string> } {
  const rows = new Map<string, Row>(), intro = new Map<string, string>()
  if (!existsSync(file)) return { rows, intro }
  const cell = (s: string) => s.trim().replace(/\\\|/g, "|")
  let top = ""
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const h = line.match(/^## (\S+)$/)
    if (h) { top = h[1]; continue }
    if (line.startsWith("|")) {
      const c = line.split(/(?<!\\)\|/).slice(1, -1).map(cell)
      const key = c[0]?.match(/^`([^`]+)`$/)?.[1]
      if (key && c.length >= 4) rows.set(key, { type: c[1], note: c[3] })
    } else if (top && line.trim() && !line.startsWith(">") && !line.startsWith("<!--") && !intro.has(top)) intro.set(top, line.trim())
  }
  return { rows, intro }
}

const SECTIONS: [RegExp, string][] = [
  [/^safety\.(deploy)$/, "deploys"], [/^(deployFrom|deployOnFailure)$/, "deploys"],
  [/^safety\.everyMerge$/, "plan"], [/^(pacing|reviewCap|billing|scout|lead)(\.|$)/, "plan"],
  [/^(safety|clientNames|clientProjects|frontDeskDenyMcp|mergeChecks)(\.|$)/, "safety"],
  [/^(review)(\.|$)/, "review"], [/^github\.(mergeMethod|deleteBranch)$/, "review"],
  [/^(timezone|timezoneLabel|quietHours|eveningPostHour|discord)(\.|$)/, "notifications"],
  [/^providers(\.|$)/, "providers"],
  [/^stats\./, "stats"],
]
/** The part of a section's intro that is about this key ("pacing.weekCap: most of ..."), else its first sentence. */
const sentenceFor = (intro = "", key: string) => { const parts = intro.split(/(?<=\.) /); return (parts.find((x) => x.startsWith(`${key}:`)) ?? parts[0] ?? "").replace(`${key}: `, "") }
export const sectionOf = (key: string) => SECTIONS.find(([re]) => re.test(key))?.[1] ?? "advanced"

export type ConfigKey = {
  key: string; section: string; kind: Kind; type: string; desc: string; options?: string[]; min?: number; max?: number
  default: unknown; value: unknown; source: "default" | "config file" | "project file"; changed: boolean
}
export type ConfigView = { at: number; file: string; repoFile: string; secretsFile: string; warnings: string[]; keys: ConfigKey[]; secrets: { name: string; set: boolean }[] }

/** Names Dobby reads from the secrets file or the environment. Only whether each is set ever leaves this function. */
const KNOWN_SECRETS = ["DASHBOARD_TOKEN", "DISCORD_BOT_TOKEN", "DOBBY_API_KEY", "JEV_API_KEY"]

export function configView(o: { file?: string; repo?: string; now?: number; secrets?: Record<string, string>; env?: NodeJS.ProcessEnv } = {}): ConfigView {
  const file = o.file ?? privateConfigPath(), repo = o.repo ?? repoPath(), tilde = (p: string) => p.replace(homedir(), "~")
  const raw = (f: string) => { try { return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as unknown) : undefined } catch { return undefined } }
  const [pr, rp] = [raw(file), raw(repo)]
  const loaded = loadConfig({ private: file, repo: o.repo })
  const base = { ...defaults(), review: REVIEW } as unknown as Record<string, unknown>
  const eff = loaded.config as unknown as Record<string, unknown>
  const { rows, intro } = docRows()
  const keys = leaves().map(({ key, schema }): ConfigKey => {
    const path = key.split("."), k = kindOf(schema)
    const dflt = key === "safety.everyMerge" ? EVERY_MERGE[loaded.config.safety.preset] : (valueAt(base, path) ?? EFFECTIVE_DEFAULTS[key] ?? null)
    const value = valueAt(eff, path) ?? dflt
    const source = valueAt(pr, path) !== undefined ? "config file" : valueAt(rp, path) !== undefined ? "project file" : "default"
    const row = rows.get(key)
    return {
      key, section: sectionOf(key), ...k, type: row?.type ?? k.kind, desc: (row?.note || sentenceFor(intro.get(path[0]), key)).replace(/`/g, "").replace(/^[A-Za-z][\w.]*: /, "").replace(/^[a-z]/, (c) => c.toUpperCase()),
      default: dflt, value, source, changed: JSON.stringify(value) !== JSON.stringify(dflt),
    }
  })
  const secrets = o.secrets ?? readSecrets(), env = o.env ?? process.env
  const names = [...new Set([...KNOWN_SECRETS, ...Object.keys(secrets).filter((n) => /^[A-Z][A-Z0-9_]*$/.test(n))])]
  return { at: o.now ?? Date.now(), file: tilde(file), repoFile: tilde(repo), secretsFile: tilde(secretsFile()), warnings: loaded.warnings, keys, secrets: names.map((name) => ({ name, set: !!(secrets[name] || env[name]) })) }
}

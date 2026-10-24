// Main-thread routing: role -> named roster profile + fallbacks, under hard limits.
// Tables only ever name roster profiles; a raw URL or unknown name is rejected.
import { z } from "zod"
import type { Detected } from "./detect.ts"
import { HARNESSES } from "./presets.ts"

export type Tier = "top" | "mid" | "cheap" | "local"
export interface RosterEntry {
  name: string // the ProfileRef
  provider: string // preset or harness id
  model: string
  capabilities: { tools: boolean; vision: boolean; longContext: boolean }
  costPerMtok: { input: number; output: number }
  tier: Tier
  privateOk?: boolean // may see private text (default: false unless a local provider)
}
export type RoleKind = "build" | "review" | "plan" | "text"
export interface RoleSpec { kind: RoleKind; sensitive?: boolean; private?: boolean; ownerData?: boolean; needs?: Partial<RosterEntry["capabilities"]> }
export interface RoleRoute { primary: string; fallback: string[]; effort?: "low" | "medium" | "high"; maxCostUsd?: number }
export interface RoutingTable { main: string; roles: Record<string, RoleRoute> }

// Hard limits are always on. Each can only be relaxed by naming it in allowUnsafe.
export const UNSAFE_FLAGS = ["unsandboxed-builders", "sensitive-below-top", "private-remote", "owner-data-to-providers"] as const
export type UnsafeFlag = (typeof UNSAFE_FLAGS)[number]
export interface Policy { allowUnsafe: UnsafeFlag[] }
export const DEFAULT_POLICY: Policy = { allowUnsafe: [] }

const caps = (tools: boolean, vision: boolean, longContext: boolean) => ({ tools, vision, longContext })
// ponytail: seed roster; prices are approximate list prices (unverified), owners override in config.
export const DEFAULT_ROSTER: RosterEntry[] = [
  { name: "claude-code", provider: "claude-code", model: "default", capabilities: caps(true, true, true), costPerMtok: { input: 0, output: 0 }, tier: "top" },
  { name: "codex", provider: "codex-cli", model: "default", capabilities: caps(true, true, true), costPerMtok: { input: 0, output: 0 }, tier: "top" },
  { name: "gemini-cli", provider: "gemini-cli", model: "default", capabilities: caps(true, true, true), costPerMtok: { input: 0, output: 0 }, tier: "mid" },
  { name: "opus", provider: "anthropic", model: "claude-opus-4-1", capabilities: caps(true, true, true), costPerMtok: { input: 15, output: 75 }, tier: "top" },
  { name: "sonnet", provider: "anthropic", model: "claude-sonnet-4-5", capabilities: caps(true, true, true), costPerMtok: { input: 3, output: 15 }, tier: "mid" },
  { name: "haiku", provider: "anthropic", model: "claude-haiku-4-5", capabilities: caps(true, true, false), costPerMtok: { input: 1, output: 5 }, tier: "cheap" },
  { name: "gpt-5", provider: "openai", model: "gpt-5", capabilities: caps(true, true, true), costPerMtok: { input: 1.25, output: 10 }, tier: "top" },
  { name: "gpt-5-mini", provider: "openai", model: "gpt-5-mini", capabilities: caps(true, true, true), costPerMtok: { input: 0.25, output: 2 }, tier: "cheap" },
  { name: "gemini-pro", provider: "gemini", model: "gemini-2.5-pro", capabilities: caps(true, true, true), costPerMtok: { input: 1.25, output: 10 }, tier: "top" },
  { name: "gemini-flash", provider: "gemini", model: "gemini-2.5-flash", capabilities: caps(true, true, true), costPerMtok: { input: 0.3, output: 2.5 }, tier: "cheap" },
  { name: "deepseek", provider: "deepseek", model: "deepseek-chat", capabilities: caps(true, false, false), costPerMtok: { input: 0.28, output: 0.42 }, tier: "cheap" },
  { name: "ollama-local", provider: "ollama", model: "llama3.2", capabilities: caps(false, false, false), costPerMtok: { input: 0, output: 0 }, tier: "local", privateOk: true },
]

const TIER_RANK: Record<Tier, number> = { top: 3, mid: 2, cheap: 1, local: 0 }
const isHarness = (e: RosterEntry) => HARNESSES.some((h) => h.id === e.provider)
const sandboxed = (e: RosterEntry) => HARNESSES.find((h) => h.id === e.provider)?.sandboxed === true
const costOf = (e: RosterEntry) => e.costPerMtok.input + e.costPerMtok.output
const strongest = (a: RosterEntry, b: RosterEntry) => TIER_RANK[b.tier] - TIER_RANK[a.tier] || costOf(b) - costOf(a)
const cheapest = (a: RosterEntry, b: RosterEntry) => costOf(a) - costOf(b) || TIER_RANK[b.tier] - TIER_RANK[a.tier]

export function isAvailable(e: RosterEntry, d: Detected): boolean {
  if (isHarness(e)) return d.harnesses.some((h) => h.id === e.provider && h.loggedIn !== false)
  return d.apiKeys.some((k) => k.provider === e.provider) || d.local.some((l) => l.provider === e.provider)
}

/** Why `e` may not serve `role`, or null when it may. */
export function violation(role: RoleSpec, e: RosterEntry, policy: Policy): string | null {
  const unsafe = (f: UnsafeFlag) => policy.allowUnsafe.includes(f)
  if (role.kind === "build" && !isHarness(e)) return `${e.name}: builders need a harness`
  if (role.kind === "build" && !sandboxed(e) && !unsafe("unsandboxed-builders")) return `${e.name}: builders only on sandboxed harnesses`
  if (role.sensitive && e.tier !== "top" && !unsafe("sensitive-below-top")) return `${e.name}: sensitive role needs a top-tier model`
  if (role.private && !e.privateOk && !unsafe("private-remote")) return `${e.name}: private text only on privateOk providers`
  for (const [k, v] of Object.entries(role.needs ?? {})) if (v && !e.capabilities[k as keyof RosterEntry["capabilities"]]) return `${e.name}: lacks ${k}`
  return null
}

export function planRouting(detected: Detected, roster: RosterEntry[], roles: Record<string, RoleSpec>, policy: Policy = DEFAULT_POLICY): { table: RoutingTable; unassigned: string[] } {
  const avail = roster.filter((e) => isAvailable(e, detected))
  const out: Record<string, RoleRoute> = {}
  const unassigned: string[] = []
  for (const [name, spec] of Object.entries(roles)) {
    const ok = avail.filter((e) => !violation(spec, e, policy))
    // review/plan/build: strongest first; text-only: cheapest capable first.
    ok.sort(spec.kind === "text" ? cheapest : strongest)
    if (!ok.length) { unassigned.push(name); continue }
    out[name] = { primary: ok[0].name, fallback: ok.slice(1, 4).map((e) => e.name) }
  }
  const main = [...avail].sort(strongest)[0]?.name ?? ""
  return { table: { main, roles: out }, unassigned }
}

const NAME = /^[A-Za-z0-9][\w.-]{0,63}$/ // a roster name, never a URL or path
export function validateTable(table: RoutingTable, roster: RosterEntry[], policy: Policy, roles: Record<string, RoleSpec>): string[] {
  const errs: string[] = []
  const byName = new Map(roster.map((e) => [e.name, e]))
  const check = (ref: string, where: string, spec?: RoleSpec) => {
    if (!NAME.test(ref)) return errs.push(`${where}: "${ref}" is not a profile name`)
    const e = byName.get(ref)
    if (!e) return errs.push(`${where}: unknown profile "${ref}"`)
    const v = spec && violation(spec, e, policy)
    if (v) errs.push(`${where}: ${v}`)
  }
  check(table.main, "main")
  for (const [role, r] of Object.entries(table.roles)) {
    const spec = roles[role]
    if (!spec) { errs.push(`${role}: unknown role`); continue }
    check(r.primary, `${role}.primary`, spec)
    r.fallback.forEach((f, i) => check(f, `${role}.fallback[${i}]`, spec))
    if (r.maxCostUsd !== undefined && !(r.maxCostUsd >= 0)) errs.push(`${role}: maxCostUsd must be >= 0`)
  }
  return errs
}

/** Health per profile name: down, or cooling until a timestamp (from the credential pool). */
export type Health = Record<string, { down?: boolean; coolUntil?: number }>
const healthy = (h: Health, name: string, now: number) => !h[name]?.down && (h[name]?.coolUntil ?? 0) <= now

export function resolve(role: string, table: RoutingTable, health: Health, now = Date.now()): string | null {
  const r = table.roles[role]
  if (!r) return null
  return [r.primary, ...r.fallback].find((n) => healthy(health, n, now)) ?? null
}

export function explain(role: string, table: RoutingTable, health: Health = {}, now = Date.now()): string {
  const r = table.roles[role]
  if (!r) return `${role}: no route (nothing available passes the hard limits)`
  const chain = [r.primary, ...r.fallback].map((n) => {
    const h = health[n]
    return h?.down ? `${n} (down)` : (h?.coolUntil ?? 0) > now ? `${n} (cooling ${Math.ceil((h!.coolUntil! - now) / 60_000)} min)` : n
  })
  const pick = resolve(role, table, health, now)
  return `${role}: ${chain.join(" -> ")}; now using ${pick ?? "nothing (all unhealthy)"}`
}

// --- main-thread proposal --------------------------------------------------
export const tableSchema = z.object({
  main: z.string(),
  roles: z.record(z.object({
    primary: z.string(),
    fallback: z.array(z.string()).max(5).default([]),
    effort: z.enum(["low", "medium", "high"]).optional(),
    maxCostUsd: z.number().nonnegative().optional(),
  })),
})

/** Compatible with an AI SDK provider's generate; wire it here later. */
export type ModelCall = <T>(args: { schema: z.ZodType; instructions: string; input: string; signal: AbortSignal }) => Promise<{ value: T; usage?: { inputTokens: number; outputTokens: number } }>

export function mainThreadPrompt(detected: Detected, roster: RosterEntry[], roles: Record<string, RoleSpec>, policy: Policy): { instructions: string; input: string } {
  const avail = roster.filter((e) => isAvailable(e, detected))
  return {
    instructions: [
      "You assign AI models to the roles of a software team. Reply with JSON only: {\"main\": name, \"roles\": {role: {\"primary\": name, \"fallback\": [names], \"effort\"?: \"low\"|\"medium\"|\"high\", \"maxCostUsd\"?: number}}}.",
      "Use ONLY profile names from the roster below. Never write URLs, keys or providers.",
      "Hard limits (a violating table is discarded): build roles only on sandboxed harnesses; sensitive roles only on top tier; private roles only on privateOk profiles.",
      `Relaxed limits: ${policy.allowUnsafe.join(", ") || "none"}.`,
      "Prefer the strongest model for review and planning, the cheapest capable one for text-only roles, and give every role fallbacks.",
    ].join("\n"),
    input: JSON.stringify({
      roster: avail.map((e) => ({ name: e.name, tier: e.tier, harness: isHarness(e), sandboxed: sandboxed(e), privateOk: !!e.privateOk, capabilities: e.capabilities, costPerMtok: e.costPerMtok })),
      roles,
    }),
  }
}

/** Ask the main model for a table; ANY problem (error, bad JSON, failed validation) returns planRouting's table. */
export async function proposeTable(call: ModelCall, detected: Detected, roster: RosterEntry[], roles: Record<string, RoleSpec>, policy: Policy, signal: AbortSignal = AbortSignal.timeout(120_000)): Promise<{ table: RoutingTable; source: "main" | "default"; problems: string[] }> {
  const fallback = planRouting(detected, roster, roles, policy).table
  try {
    const { instructions, input } = mainThreadPrompt(detected, roster, roles, policy)
    const { value } = await call<unknown>({ schema: tableSchema, instructions, input, signal })
    const parsed = tableSchema.safeParse(typeof value === "string" ? JSON.parse(value) : value)
    if (!parsed.success) return { table: fallback, source: "default", problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }
    const avail = roster.filter((e) => isAvailable(e, detected))
    const problems = validateTable(parsed.data, avail, policy, roles)
    return problems.length ? { table: fallback, source: "default", problems } : { table: parsed.data, source: "main", problems: [] }
  } catch (e) {
    return { table: fallback, source: "default", problems: [`main model failed: ${(e as Error).message}`] }
  }
}

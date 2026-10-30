// The user's `providers` config section. Everything optional; an empty object means today's behaviour.
// Wired as the optional `providers` key of src/config.ts (absent = unused).
import { z } from "zod"
import { DEFAULT_POLICY, DEFAULT_ROSTER, UNSAFE_FLAGS, type Policy, type RosterEntry, type RoutingTable } from "./router.ts"

const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "an environment variable NAME, not a key")
const profileName = z.string().regex(/^[A-Za-z0-9][\w.-]{0,63}$/, "a roster profile name, not a URL")
const httpUrl = z.string().url().refine((u) => /^https?:\/\//.test(u), "http(s) only")

const rosterEntry = z.object({
  name: profileName,
  provider: z.string(),
  model: z.string().min(1),
  capabilities: z.object({ tools: z.boolean().default(false), vision: z.boolean().default(false), longContext: z.boolean().default(false) }).prefault({}),
  costPerMtok: z.object({ input: z.number().nonnegative(), output: z.number().nonnegative() }).default({ input: 0, output: 0 }),
  tier: z.enum(["top", "mid", "cheap", "local"]).default("mid"),
  privateOk: z.boolean().optional(),
})

export const providersConfigSchema = z.object({
  enabled: z.boolean().default(false), // off = Dobby keeps calling claude exactly as today
  acp: z.boolean().optional(), // ACP harnesses (gemini-cli...) in live routing; off until verified against a real agent (src/agents.ts)
  providers: z.record(z.string(), z.object({
    enabled: z.boolean().default(true),
    keyEnv: z.array(envName).optional(), // pool of key NAMES, values stay in the environment
    baseUrl: httpUrl.optional(), // relay or custom endpoint
    headers: z.record(z.string(), z.string()).optional(),
    strategy: z.enum(["fill_first", "round_robin", "least_used"]).default("fill_first"),
    // pace: at either cap over the last 24 hours the router skips this provider until older runs age out (claude-code keeps its plan pacing)
    limit: z.object({ dailyUsd: z.number().positive().optional(), dailyRuns: z.number().int().positive().optional() }).optional(),
  })).prefault({}),
  roster: z.array(rosterEntry).optional(), // replaces/extends the seed roster by name
  main: profileName.optional(),
  roles: z.record(z.string(), z.object({
    primary: profileName.optional(),
    fallback: z.array(profileName).optional(),
    effort: z.enum(["low", "medium", "high"]).optional(),
    maxCostUsd: z.number().nonnegative().optional(),
  })).prefault({}),
  policy: z.object({ allowUnsafe: z.array(z.enum(UNSAFE_FLAGS)).default([]) }).prefault({}),
}).strict()

export type ProvidersConfig = z.infer<typeof providersConfigSchema>

/** Seed roster with config entries merged in by name. */
export function rosterFrom(cfg: ProvidersConfig): RosterEntry[] {
  const out = new Map(DEFAULT_ROSTER.map((e) => [e.name, e]))
  for (const e of cfg.roster ?? []) out.set(e.name, e)
  return [...out.values()]
}

/** Owner's pinned choices on top of a planned/proposed table. Run validateTable on the result. */
export function applyOverrides(table: RoutingTable, cfg: ProvidersConfig): RoutingTable {
  const roles = { ...table.roles }
  for (const [role, o] of Object.entries(cfg.roles)) {
    const base = roles[role] ?? { primary: o.primary ?? "", fallback: [] }
    roles[role] = { ...base, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) }
  }
  return { main: cfg.main ?? table.main, roles }
}

export const policyFrom = (cfg: ProvidersConfig): Policy => ({ ...DEFAULT_POLICY, allowUnsafe: [...cfg.policy.allowUnsafe] })

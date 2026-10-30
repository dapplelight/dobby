// Dobby side of src/providers: kv persistence (key pools, model catalog), the real detect runner, and
// `dobby providers detect|models|explain`. Read-only towards routing: nothing here changes which model a role runs on.
import { execFile } from "node:child_process"
import type { DB } from "../db.ts"
import { runAsync } from "../lib.ts"
import { fetchModels, type CatalogEntry, type CatalogStore, type Fetch } from "./catalog.ts"
import { providersConfigSchema, applyOverrides, policyFrom, rosterFrom, type ProvidersConfig } from "./config.ts"
import { detect, type Detected, type Probe, type RunStatus, type Which } from "./detect.ts"
import { available, type PoolState, type Strategy } from "./pool.ts"
const STRATEGIES: Strategy[] = ["fill_first", "round_robin", "least_used"]
import { profileById, PROVIDERS, type ProviderProfile } from "./presets.ts"
import { explain, planRouting, validateTable, type Health, type RoleSpec } from "./router.ts"

// ---- kv (JSON values; a missing or corrupt row reads as absent) ---------------------------------
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)
function kvJson(db: DB, k: string): unknown {
  const v = (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
  try { return v === undefined ? undefined : JSON.parse(v) } catch { return undefined }
}
const kvPut = (db: DB, k: string, v: unknown) => void db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(k, JSON.stringify(v))

export function loadPool(db: DB, provider: string): PoolState | null {
  const s = kvJson(db, `providers:pool:${provider}`)
  const ok = isObj(s) && s.provider === provider && Array.isArray(s.creds) && typeof s.cursor === "number" && isObj(s.modelCool)
    && s.creds.every((c) => isObj(c) && typeof c.ref === "string" && typeof c.uses === "number" && typeof c.coolUntil === "number")
  if (!ok) return null
  // A bad cooldown entry or strategy is dropped (entry gone, strategy back to the default), not trusted.
  const modelCool = Object.fromEntries(Object.entries(s.modelCool as Record<string, unknown>).filter(([, v]) => typeof v === "number" && Number.isFinite(v)))
  const strategy = STRATEGIES.includes(s.strategy as Strategy) ? s.strategy : "fill_first"
  return { ...s, strategy, modelCool } as unknown as PoolState
}
export const savePool = (db: DB, s: PoolState) => kvPut(db, `providers:pool:${s.provider}`, s)

/** catalog.ts CatalogStore over kv. Keys hold a key fingerprint (hash), never a key. */
export function kvCatalog(db: DB): CatalogStore {
  return {
    get(k) {
      const e = kvJson(db, `providers:catalog:${k}`)
      return isObj(e) && typeof e.at === "number" && Array.isArray(e.models) && e.models.every((m) => typeof m === "string") ? (e as unknown as CatalogEntry) : undefined
    },
    set: (k, v) => kvPut(db, `providers:catalog:${k}`, v),
  }
}

// ---- real runner: argument arrays only (no shell), a timeout on every call ----------------------
export interface Runner { which: Which; probe: Probe; runStatus: RunStatus }
export function runner(ms = { which: 5_000, status: 10_000, probe: 2_000 }): Runner {
  return {
    which: async (bin) => {
      const r = await runAsync(process.platform === "win32" ? "where" : "which", [bin], { timeoutMs: ms.which })
      return r.ok ? r.out.trim().split(/\r?\n/)[0] || null : null
    },
    // timeout, missing binary (spawn error) or a signal kill (no exit code) say nothing about sign-in: "unknown"
    runStatus: (bin, argv) => new Promise((done) => {
      try {
        execFile(bin, argv, { timeout: ms.status, killSignal: "SIGKILL" }, (e) =>
          done(!e ? 0 : e.killed || e.signal || typeof e.code !== "number" ? "unknown" : e.code))
      } catch { done("unknown") }
    }),
    probe: async (url) => {
      try { return (await fetch(url, { signal: AbortSignal.timeout(ms.probe) })).ok } catch { return false }
    },
  }
}

// ---- the roles Dobby has today (roles/*.md), as routing specs ---------------------------------
// ownerData = the privacy flag: the role sees the owner's goals, chat or ideas. Live runs (src/agents.ts) never send it to a plain
// provider unless the owner names "owner-data-to-providers" in providers.policy.allowUnsafe (default off).
export const DOBBY_ROLES: Record<string, RoleSpec> = {
  builder: { kind: "build" },
  reviewer: { kind: "review", sensitive: true },
  checker: { kind: "review", sensitive: true },
  lead: { kind: "plan", ownerData: true },
  "product-manager": { kind: "plan", ownerData: true },
  "area-pm": { kind: "plan", ownerData: true },
  "program-manager": { kind: "plan" },
  designer: { kind: "plan" },
  onboarder: { kind: "text" },
  "chief-of-staff": { kind: "text", ownerData: true },
  "front-desk": { kind: "text", ownerData: true },
  scout: { kind: "text" },
  "safety-classifier": { kind: "text" }, // yes/no on a ticket text + file list (src/safety.ts): cheap tier, no owner data
  brainstorm: { kind: "text", ownerData: true },
}

// ---- CLI ---------------------------------------------------------------------------------------
export interface Deps { env: Record<string, string | undefined>; run: Runner; fetch: Fetch; cfg?: ProvidersConfig; now?: number }

/** `dobby providers detect|models|explain`. Prints env var NAMES, never their values. */
export async function providersCmd(db: DB, args: string[], d: Deps): Promise<string> {
  const sub = args[0] ?? "detect"
  if (!["detect", "models", "explain"].includes(sub)) return "usage: dobby providers detect | models | explain"
  const cfg = providersConfigSchema.parse(d.cfg ?? {})
  const now = d.now ?? Date.now()
  const found = await detect(d.env, d.run.which, d.run.probe, d.run.runStatus)
  if (sub === "detect") return detectText(found)
  if (sub === "models") return modelsText(db, found, cfg, d, now)
  return explainText(db, found, cfg, now, d.cfg ? "" : "providers config: absent (unused; Dobby runs claude exactly as before)")
}

function detectText(f: Detected): string {
  const yn = (v: boolean | "unknown") => (v === "unknown" ? "unknown" : v ? "yes" : "no")
  return [
    "harnesses (agent CLIs):", ...(f.harnesses.length ? f.harnesses.map((h) => `  ${h.id}  ${h.path}  signed in: ${yn(h.loggedIn)}`) : ["  none found"]),
    "API keys (env var names only):", ...(f.apiKeys.length ? f.apiKeys.map((k) => `  ${k.provider}  ${k.envVar}`) : ["  none set"]),
    "local servers:", ...(f.local.length ? f.local.map((l) => `  ${l.provider}  ${l.baseUrl}`) : ["  none answering"]),
  ].join("\n")
}

async function modelsText(db: DB, f: Detected, cfg: ProvidersConfig, d: Deps, now: number): Promise<string> {
  const store = kvCatalog(db)
  const targets: [ProviderProfile, string | undefined][] = [
    ...f.apiKeys.map((k) => [PROVIDERS.find((p) => p.id === k.provider)!, d.env[k.envVar]?.trim()] as [ProviderProfile, string | undefined]),
    ...f.local.map((l) => [PROVIDERS.find((p) => p.id === l.provider)!, undefined] as [ProviderProfile, string | undefined]),
  ]
  if (!targets.length) return "no providers reachable (no API key env vars set, no local server answering)"
  const out: string[] = []
  for (const [p, key] of targets) {
    const r = await fetchModels(p, key, d.fetch, { store, now, baseUrl: cfg.providers[p.id]?.baseUrl, timeoutMs: 10_000 })
    await r.revalidating
    out.push(`${p.id} (${r.source}, ${r.models.length}):`, ...r.models.map((m) => `  ${m}`))
  }
  return out.join("\n")
}

/** The live routing: planned table + the owner's overrides (dropped when they break a limit), and health from the key pools. */
export function routingState(db: DB, f: Detected, cfg: ProvidersConfig, now: number) {
  const roster = rosterFrom(cfg), policy = policyFrom(cfg)
  const planned = planRouting(f, roster, DOBBY_ROLES, policy)
  const pinned = applyOverrides(planned.table, cfg)
  const problems = validateTable(pinned, roster, policy, DOBBY_ROLES)
  const table = problems.length ? planned.table : pinned
  const health: Health = {}
  for (const e of roster) {
    if (profileById(e.provider)?.kind === "harness") continue
    const pool = loadPool(db, e.provider)
    if (pool && !pool.creds.length) health[e.name] = { down: true }
    else if (pool && !available(pool, now, e.model)) health[e.name] = { coolUntil: Math.max(pool.modelCool[e.model] ?? 0, Math.min(...pool.creds.map((c) => c.coolUntil))) }
  }
  return { roster, table, health, problems }
}

function explainText(db: DB, f: Detected, cfg: ProvidersConfig, now: number, head: string): string {
  const { table, health, problems } = routingState(db, f, cfg, now)
  return [
    ...(cfg.enabled ? [] : ["Providers are off; everything runs on claude. The plan below is what routing would do if you turned them on."]),
    head || `providers config: ${cfg.enabled ? "enabled" : "present, not enabled (unused)"}`,
    `main thread: ${table.main || "none available"}`,
    ...Object.keys(DOBBY_ROLES).map((r) => explain(r, table, health, now)),
    ...(problems.length ? ["owner overrides ignored (they break a limit):", ...problems.map((p) => `  ${p}`)] : []),
    cfg.enabled ? "live: routed roles run on the profile shown (src/agents.ts); code-editing runs stay on claude" : "plan only: live agents still run on claude as before",
  ].join("\n")
}

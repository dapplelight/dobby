// Max plan API credits ($100/month, Claude API only; Claude Code and `claude -p` are NOT covered, owner 17 Oct).
// Tool-less text calls (brief, 3-bullet summaries, dedupe) go to the Messages API while credits last;
// everything else, and every API failure, stays on `claude -p` and the plan.
// Key: DOBBY_API_KEY in ~/.config/dobby/secrets.env. Never ANTHROPIC_API_KEY: that would move every `claude -p` off the plan.
import type { DB } from "./db.ts"
import { readSecrets } from "./notify.ts"
import { config, zoned } from "./config.ts"

const MODELS: Record<string, string> = { haiku: "claude-haiku-5-5", sonnet: "claude-sonnet-5-5", opus: "claude-opus-5-5" }
const RETRY_MS = 24 * 3600_000 // after "credit balance too low", try the API again a day later: picks up the monthly refill by itself

export type Mode = "auto" | "off"
const get = (db: DB, k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
const set = (db: DB, k: string, v: string | null) =>
  v === null ? db.prepare("DELETE FROM kv WHERE k=?").run(k) : db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(k, v)

export const apiKey = () => (process.env.DOBBY_API_KEY ?? readSecrets().DOBBY_API_KEY ?? "").trim()

/** Every place that talks to Anthropic with DOBBY_API_KEY goes through these two: an organisation-level key needs billing.workspaceId (not a secret) sent with each call. */
export const workspaceId = (id = config().billing?.workspaceId) => id?.trim() || ""
export const workspaceHeaders = (id?: string): Record<string, string> => (workspaceId(id) ? { "anthropic-workspace-id": workspaceId(id) } : {})
/** The env a Claude Code process gets for the key: Claude Code sends ANTHROPIC_CUSTOM_HEADERS ("Name: value", one per line) on every request. */
export const claudeKeyEnv = (): Record<string, string> => ({ ANTHROPIC_API_KEY: apiKey(), ...(workspaceId() ? { ANTHROPIC_CUSTOM_HEADERS: `anthropic-workspace-id: ${workspaceId()}` } : {}) })

/** One cheap real call with the key (GET /v1/models). Returns the plain-words problem, or "" when the key works. */
export async function probeKey(key: string, fetcher: typeof fetch = fetch, id?: string): Promise<string> {
  try {
    const res = await fetcher("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01", ...workspaceHeaders(id) }, signal: AbortSignal.timeout(10_000) })
    if (res.ok) return ""
    const why = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? `HTTP ${res.status}`
    if (/not scoped to a workspace/i.test(why)) return "This key isn't in a workspace: set billing.workspaceId, or create the key inside a workspace in Console."
    return res.status === 401 ? "Anthropic refused the key (401): check DOBBY_API_KEY." : `Anthropic answered ${res.status}: ${why.slice(0, 150)}`
  } catch (e) {
    return `could not reach Anthropic (${(e as Error).message})` // offline is not a bad key: the row stays ok, see checks.ts
  }
}

/**
 * The router (owner, 17 Oct): two pools, the plan (weekly limit, lost if unused) and API credits (lost at month end).
 * An eligible job goes to the credits only when that saves the plan or the credits: the weekly limit is ahead of pace
 * (more used than the share of the week gone), or it is the last 5 days of the credit month. Behind pace = the plan has
 * room that would go to waste, so the job stays on it. No reading yet = credits (as before).
 * ponytail: the credit month is the calendar month (IST); set it from the grant date if that differs.
 */
export function apiWanted(db: DB, now = Date.now()): { api: boolean; why: string } {
  const d = zoned(now)
  const daysLeft = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() - d.getUTCDate() + 1
  if (daysLeft <= 5) return { api: true, why: `last ${daysLeft} day(s) of the credit month` }
  let t: { week: number; week_reset: number } | undefined
  try { t = db.prepare("SELECT week, week_reset FROM usage_ticks ORDER BY at DESC LIMIT 1").get() as typeof t } catch {} // no usage table yet
  if (!t?.week_reset) return { api: true, why: "no usage reading yet" }
  const pace = Math.round(100 * Math.min(1, Math.max(0, 1 - (t.week_reset - now) / (7 * 86400_000))))
  return t.week > pace ? { api: true, why: `weekly ${t.week}% is ahead of pace (${pace}%)` } : { api: false, why: `weekly ${t.week}% is behind pace (${pace}%): the plan has room` }
}

/** Should this call use API credits? Only tool-less calls, with a key, mode auto, not paused by an empty balance, and the router says so. */
export function useApi(db: DB, args: string[], now = Date.now()): boolean {
  const i = args.indexOf("--tools")
  if (i < 0 || args[i + 1] !== "") return false // needs tools: that is Claude Code, which the credits don't cover
  if (!apiKey() || get(db, "api:mode") === "off") return false
  return Number(get(db, "api:paused_until") ?? 0) <= now && apiWanted(db, now).api
}

/**
 * One Messages API call. ok:false means "fall back to claude -p"; an empty balance also pauses the API for a day.
 * No effort setting is sent: `--effort` is a Claude Code flag, and the Messages API only takes effort on some models
 * (not Haiku, which runs most API-credit calls). A rejected field is a 400, which would push every call back onto the plan.
 * Add `output_config: { effort }` for a model only after checking it against that model's docs.
 */
export async function callApi(db: DB, model: string, prompt: string, fetcher: typeof fetch = fetch, now = Date.now()) {
  try {
    const res = await fetcher("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey(), "anthropic-version": "2023-06-01", ...workspaceHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ model: MODELS[model] ?? model, max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(120_000),
    })
    const j = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens: number; output_tokens: number }; error?: { message?: string } }
    if (!res.ok) {
      const why = j.error?.message ?? `HTTP ${res.status}`
      if (/credit balance/i.test(why)) {
        set(db, "api:paused_until", String(now + RETRY_MS))
        set(db, "api:last_empty", new Date(now).toISOString())
      }
      return { ok: false as const, reason: `api: ${why.slice(0, 200)}` }
    }
    const text = (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("")
    return { ok: true as const, text, input_tokens: j.usage?.input_tokens, output_tokens: j.usage?.output_tokens }
  } catch (e) {
    return { ok: false as const, reason: `api: ${(e as Error).message}` }
  }
}

/** `dobby api [on|off|status]`: auto (use credits, fall back on empty) or off (plan only). */
export function apiCommand(db: DB, arg = "status", now = Date.now()): string {
  if (arg === "on") { set(db, "api:mode", "auto"); set(db, "api:paused_until", null); arg = "status" }
  if (arg === "off") { set(db, "api:mode", "off"); return "API credits: off. Every call uses your Claude plan." }
  const paused = Number(get(db, "api:paused_until") ?? 0)
  const used = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(input_tokens),0) i, COALESCE(SUM(output_tokens),0) o FROM runs WHERE model LIKE 'api:%' AND at>=?")
    .get(new Date(now - 30 * 86400_000).toISOString()) as { n: number; i: number; o: number }
  const state = !apiKey() ? "no DOBBY_API_KEY in secrets.env, so everything uses your plan"
    : get(db, "api:mode") === "off" ? "off (plan only)"
    : paused > now ? `credits ran out; on the plan until ${new Date(paused).toLocaleString("en-IN")}, then it tries the API again`
    : `on: text-only calls use API credits when it helps (now: ${apiWanted(db, now).why}), the rest use your plan`
  return `API credits: ${state}.\nLast 30 days on the API: ${used.n} calls, ${used.i.toLocaleString("en-IN")} in / ${used.o.toLocaleString("en-IN")} out tokens.`
}

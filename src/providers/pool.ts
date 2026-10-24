// Credential pool per provider. Pure: state in, state out; the caller persists it (JSON-safe).
// Credentials are referenced by env-var NAME, never by value.
import type { FailoverReason } from "./errors.ts"

export type Strategy = "fill_first" | "round_robin" | "least_used"
export interface Cred { ref: string; uses: number; coolUntil: number; lastReason?: FailoverReason }
export interface PoolState { provider: string; strategy: Strategy; creds: Cred[]; cursor: number; modelCool: Record<string, number> }

export const COOLDOWN = { auth: 5 * 60_000, rate_limit: 60 * 60_000, sole: 60_000 } as const

export function newPool(provider: string, refs: string[], strategy: Strategy = "fill_first"): PoolState {
  return { provider, strategy, creds: refs.map((ref) => ({ ref, uses: 0, coolUntil: 0 })), cursor: 0, modelCool: {} }
}

/** Next usable credential (or null when all cool), plus the state with its use counted. */
export function pick(s: PoolState, now: number, model?: string): { ref: string | null; state: PoolState } {
  if (model && (s.modelCool[model] ?? 0) > now) return { ref: null, state: s }
  const live = s.creds.map((c, i) => ({ c, i })).filter(({ c }) => c.coolUntil <= now)
  if (!live.length) return { ref: null, state: s }
  let chosen = live[0]
  if (s.strategy === "least_used") chosen = live.reduce((a, b) => (b.c.uses < a.c.uses ? b : a))
  if (s.strategy === "round_robin") chosen = live.find(({ i }) => i >= s.cursor) ?? live[0]
  const creds = s.creds.map((c, i) => (i === chosen.i ? { ...c, uses: c.uses + 1 } : c))
  return { ref: chosen.c.ref, state: { ...s, creds, cursor: (chosen.i + 1) % s.creds.length } }
}

/** Record a failure: cools the credential (auth/billing 5 min, rate limit 1 h or Retry-After; a sole credential only 60 s). */
export function reportFailure(s: PoolState, ref: string, reason: FailoverReason, now: number, retryAfterMs?: number): PoolState {
  let ms: number
  if (reason === "rate_limit") ms = retryAfterMs ?? COOLDOWN.rate_limit
  else if (reason === "auth" || reason === "billing") ms = COOLDOWN.auth
  else return s // other reasons are not the credential's fault
  if (s.creds.length === 1) ms = Math.min(ms, COOLDOWN.sole)
  return { ...s, creds: s.creds.map((c) => (c.ref === ref ? { ...c, coolUntil: now + ms, lastReason: reason } : c)) }
}

export function coolModel(s: PoolState, model: string, until: number): PoolState {
  return { ...s, modelCool: { ...s.modelCool, [model]: until } }
}

export const available = (s: PoolState, now: number, model?: string) =>
  !(model && (s.modelCool[model] ?? 0) > now) && s.creds.some((c) => c.coolUntil <= now)

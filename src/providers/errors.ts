// Failure taxonomy: one HTTP failure -> a reason -> what to do next.
export type FailoverReason =
  | "auth" | "billing" | "rate_limit" | "upstream_blocked" | "context_overflow" | "payload_too_large"
  | "model_not_found" | "format_error" | "timeout" | "server_error" | "unknown"
export type FailoverAction = "retry-same" | "rotate-credential" | "fallback-model" | "compress" | "repair-retry" | "give-up"

export const ACTIONS: Record<FailoverReason, FailoverAction> = {
  auth: "rotate-credential",
  billing: "rotate-credential",
  rate_limit: "rotate-credential",
  upstream_blocked: "fallback-model",
  context_overflow: "compress",
  payload_too_large: "compress",
  model_not_found: "fallback-model",
  format_error: "repair-retry",
  timeout: "retry-same",
  server_error: "retry-same",
  unknown: "give-up",
}

export interface Classified { reason: FailoverReason; action: FailoverAction; retryAfterMs?: number }

type Headers = Record<string, string | undefined> | { get(name: string): string | null }
const header = (h: Headers | undefined, name: string) =>
  !h ? undefined : typeof (h as { get?: unknown }).get === "function" ? ((h as { get(n: string): string | null }).get(name) ?? undefined)
    : Object.entries(h as Record<string, string | undefined>).find(([k]) => k.toLowerCase() === name)?.[1]

export function retryAfterMs(h: Headers | undefined, now = Date.now()): number | undefined {
  const v = header(h, "retry-after")
  if (!v) return undefined
  const s = Number(v)
  if (Number.isFinite(s)) return Math.max(0, s * 1000)
  const t = Date.parse(v)
  return Number.isNaN(t) ? undefined : Math.max(0, t - now)
}

// status 0 = no response (network / abort). Body may be a string or parsed JSON.
export function classify(status: number, body?: unknown, headers?: Headers): Classified {
  const text = (typeof body === "string" ? body : JSON.stringify(body ?? "")).toLowerCase()
  const r = (reason: FailoverReason, extra: Partial<Classified> = {}): Classified => ({ reason, action: ACTIONS[reason], ...extra })
  // Body text first: vendors reuse 400/429 for several meanings.
  if (/context.?(length|window)|maximum context|too many tokens|prompt is too long|token limit/.test(text)) return r("context_overflow")
  if (/insufficient.?(quota|balance|credit)|billing|payment required|credit balance/.test(text) || status === 402) return r("billing")
  if (status === 413 || /payload too large|request too large|request entity/.test(text)) return r("payload_too_large")
  if (status === 401 || /invalid.?api.?key|unauthori[sz]ed|authentication/.test(text)) return r("auth")
  if (status === 429 || /rate.?limit|too many requests/.test(text)) return r("rate_limit", { retryAfterMs: retryAfterMs(headers) })
  if (status === 403 || /content.?(policy|filter)|safety|blocked|region|not available in your/.test(text)) return r("upstream_blocked")
  if (status === 404 || /model.{0,20}(not found|does not exist|unknown)|no such model/.test(text)) return r("model_not_found")
  if (status === 408 || status === 504 || status === 0 || /timed? ?out|etimedout|abort/.test(text)) return r("timeout")
  if (status === 400 || status === 422 || /invalid.?(request|json|schema)|tool.?(call|use)/.test(text)) return r("format_error")
  if (status >= 500) return r("server_error")
  return r("unknown")
}

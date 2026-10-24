// Model catalog per provider: live GET /models, filtered to chat models, merged with the preset's fallbacks.
// Cache keyed by a credential FINGERPRINT (hash), never the key. Fresh 1 h, stale-while-revalidate 7 days, never cache empty.
import { createHash } from "node:crypto"
import type { ProviderProfile } from "./presets.ts"

export type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>
export interface CatalogEntry { models: string[]; at: number }
export interface CatalogStore { get(k: string): CatalogEntry | undefined; set(k: string, v: CatalogEntry): void }
export interface CatalogResult { models: string[]; source: "live" | "cache" | "stale" | "fallback"; revalidating?: Promise<void> }

export const FRESH_MS = 60 * 60 * 1000
export const STALE_MS = 7 * 24 * 60 * 60 * 1000

export const fingerprint = (key: string | undefined) => (key ? createHash("sha256").update(key).digest("hex").slice(0, 16) : "nokey")
const url = (u: string) => { try { return new URL(u) } catch { return null } }
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"])
/** The vendor key may go to `base` only when protocol and host match the preset's, and over https unless it is localhost. */
export function vendorHostOk(base: string, preset: string): boolean {
  const a = url(base), b = url(preset)
  return !!a && !!b && a.protocol === b.protocol && a.host === b.host && (a.protocol === "https:" || LOCAL.has(a.hostname))
}
const NON_CHAT = /embed|whisper|tts|dall-e|moderation|image|audio|transcri|rerank|realtime|speech|search|guard/i

export interface FetchOpts {
  baseUrl?: string // user relay / override
  relayKey?: string // key FOR the relay; the vendor key is never sent to a different host
  store?: CatalogStore
  now?: number
  timeoutMs?: number
}

export async function fetchModels(profile: ProviderProfile, key: string | undefined, fetch: Fetch, opts: FetchOpts = {}): Promise<CatalogResult> {
  const base = (opts.baseUrl || profile.baseUrl).replace(/\/+$/, "")
  // vendor key only ever goes to the vendor's own protocol + host; anything else is a relay and gets the relay key (or none)
  const sendKey = vendorHostOk(base, profile.baseUrl) ? key : opts.baseUrl ? opts.relayKey : undefined
  const now = opts.now ?? Date.now()
  const fallback = (): CatalogResult => ({ models: [...profile.fallbackModels], source: "fallback" })
  if (!base || base.includes("{") || profile.quirks?.includes("no-models-endpoint")) return fallback()

  const cacheKey = `${profile.id}|${base}|${fingerprint(sendKey)}`
  const hit = opts.store?.get(cacheKey)
  const live = async () => {
    const got = await listLive(profile, base, sendKey, fetch, opts.timeoutMs ?? 10_000)
    const models = merge(got, profile.fallbackModels)
    if (got.length) opts.store?.set(cacheKey, { models, at: now })
    return { got, models }
  }
  if (hit && now - hit.at < FRESH_MS) return { models: hit.models, source: "cache" }
  if (hit && now - hit.at < STALE_MS) return { models: hit.models, source: "stale", revalidating: live().then(() => {}, () => {}) }
  try {
    const { got, models } = await live()
    return got.length ? { models, source: "live" } : fallback()
  } catch {
    return fallback()
  }
}

async function listLive(profile: ProviderProfile, base: string, key: string | undefined, fetch: Fetch, timeoutMs: number): Promise<string[]> {
  const headers: Record<string, string> = { ...profile.defaultHeaders }
  let url = `${base}/models`
  if (profile.wire === "anthropic-messages") {
    url = `${base}/v1/models?limit=1000`
    if (key) headers["x-api-key"] = key
  } else if (profile.wire === "gemini-native") {
    if (key) headers["x-goog-api-key"] = key
  } else if (key) {
    if (profile.quirks?.includes("api-key-header")) headers["api-key"] = key
    else headers.authorization = `Bearer ${key}`
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`models ${res.status}`)
  const body = (await res.json()) as { data?: { id?: string }[]; models?: { name?: string; supportedGenerationMethods?: string[] }[] }
  if (profile.wire === "gemini-native") {
    return (body.models ?? []).filter((m) => m.name && (m.supportedGenerationMethods ?? ["generateContent"]).includes("generateContent")).map((m) => m.name!.replace(/^models\//, "")).filter((id) => !NON_CHAT.test(id))
  }
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => !!id && !NON_CHAT.test(id))
}

const merge = (a: string[], b: string[]) => [...new Set([...a, ...b])]

export function memoryStore(): CatalogStore {
  const m = new Map<string, CatalogEntry>()
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) }
}

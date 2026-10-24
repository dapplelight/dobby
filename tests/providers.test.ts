import assert from "node:assert/strict"
import test from "node:test"
import { PROVIDERS, HARNESSES, profileById } from "../src/providers/presets.ts"
import { detect } from "../src/providers/detect.ts"
import { fetchModels, fingerprint, memoryStore, FRESH_MS, STALE_MS, type Fetch } from "../src/providers/catalog.ts"
import { classify, retryAfterMs } from "../src/providers/errors.ts"
import { newPool, pick, reportFailure, coolModel, available, COOLDOWN } from "../src/providers/pool.ts"
import { planRouting, validateTable, resolve, explain, proposeTable, mainThreadPrompt, DEFAULT_ROSTER, DEFAULT_POLICY, type RoleSpec, type ModelCall } from "../src/providers/router.ts"
import { providersConfigSchema, rosterFrom, policyFrom, applyOverrides } from "../src/providers/config.ts"
import type { Detected } from "../src/providers/detect.ts"

const KEY = "sk-test-not-a-real-key-123"

test("presets: unique ids, required fields, https for remote, docs cited", () => {
  const ids = [...PROVIDERS, ...HARNESSES].map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const p of PROVIDERS) {
    if (p.id === "custom") continue
    assert.ok(p.docs.startsWith("https://"), p.id)
    if (p.authKind !== "local") assert.ok(p.baseUrl.startsWith("https://"), p.id)
    for (const n of p.envVars) assert.match(n, /^[A-Z_][A-Z0-9_]*$/)
  }
  assert.equal(profileById("anthropic")?.kind, "provider")
  assert.equal(profileById("claude-code")?.kind, "harness")
})

test("detect: harnesses via which, key NAMES only, local probes", async () => {
  const env = { OPENAI_API_KEY: KEY, GROQ_API_KEY: " ", GEMINI_API_KEY: KEY }
  const probed: string[] = []
  const d = await detect(
    env,
    async (b) => (b === "claude" || b === "gemini" ? `/usr/bin/${b}` : null),
    async (u) => (probed.push(u), u.includes("11434")),
    async (bin) => (bin === "claude" ? 0 : 1),
  )
  assert.deepEqual(d.harnesses, [{ id: "claude-code", path: "/usr/bin/claude", loggedIn: true }, { id: "gemini-cli", path: "/usr/bin/gemini", loggedIn: true }])
  assert.deepEqual(d.apiKeys.map((k) => k.provider).sort(), ["gemini", "openai"])
  assert.ok(!JSON.stringify(d).includes(KEY), "never returns key values")
  assert.deepEqual(d.local, [{ provider: "ollama", baseUrl: "http://localhost:11434/v1" }])
  assert.equal(probed.length, 2)
  const noRun = await detect({}, async () => "/x", async () => { throw new Error("down") })
  assert.equal(noRun.harnesses.find((h) => h.id === "codex-cli")?.loggedIn, "unknown")
  assert.deepEqual(noRun.local, [])
})

function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const f: Fetch = async (url, init) => (calls.push({ url, headers: init?.headers ?? {} }), { ok: status < 400, status, json: async () => body })
  return { f, calls }
}
const P = (id: string) => PROVIDERS.find((p) => p.id === id)!

test("catalog: openai Bearer, chat filter, merged fallbacks, cache by fingerprint", async () => {
  const { f, calls } = fakeFetch({ data: [{ id: "gpt-5" }, { id: "text-embedding-3-small" }, { id: "whisper-1" }, { id: "gpt-x" }] })
  const store = memoryStore()
  const r = await fetchModels(P("openai"), KEY, f, { store, now: 1000 })
  assert.equal(r.source, "live")
  assert.deepEqual(r.models, ["gpt-5", "gpt-x", "gpt-5-mini"])
  assert.equal(calls[0].url, "https://api.openai.com/v1/models")
  assert.equal(calls[0].headers.authorization, `Bearer ${KEY}`)
  const again = await fetchModels(P("openai"), KEY, f, { store, now: 1000 + FRESH_MS - 1 })
  assert.equal(again.source, "cache")
  assert.equal(calls.length, 1)
  // the cache never holds the key
  const keys: string[] = []
  const spy = { get: store.get, set: (k: string, v: { models: string[]; at: number }) => (keys.push(k), store.set(k, v)) }
  await fetchModels(P("openai"), KEY, f, { store: spy, now: 1000 + STALE_MS + 1 })
  assert.ok(keys[0].includes(fingerprint(KEY)) && !keys[0].includes(KEY))
})

test("catalog: stale-while-revalidate, never cache empty, failures fall back", async () => {
  const store = memoryStore()
  const ok = fakeFetch({ data: [{ id: "m1" }] })
  await fetchModels(P("openai"), KEY, ok.f, { store, now: 0 })
  const r = await fetchModels(P("openai"), KEY, ok.f, { store, now: FRESH_MS + 5 })
  assert.equal(r.source, "stale")
  await r.revalidating
  assert.equal(ok.calls.length, 2)
  const empty = fakeFetch({ data: [] })
  const s2 = memoryStore()
  const e = await fetchModels(P("openai"), "other", empty.f, { store: s2, now: 0 })
  assert.equal(e.source, "fallback")
  assert.equal((await fetchModels(P("openai"), "other", empty.f, { store: s2, now: 1 })).source, "fallback")
  assert.equal(empty.calls.length, 2, "empty result was not cached")
  const bad = fakeFetch({}, 500)
  assert.deepEqual((await fetchModels(P("anthropic"), KEY, bad.f)).models, P("anthropic").fallbackModels)
})

test("catalog: anthropic and gemini variants, placeholders and no-models quirk skip fetch", async () => {
  const a = fakeFetch({ data: [{ id: "claude-x" }] })
  await fetchModels(P("anthropic"), KEY, a.f)
  assert.equal(a.calls[0].url, "https://api.anthropic.com/v1/models?limit=1000")
  assert.equal(a.calls[0].headers["x-api-key"], KEY)
  assert.equal(a.calls[0].headers["anthropic-version"], "2023-06-01")
  assert.equal(a.calls[0].headers.authorization, undefined)
  const g = fakeFetch({ models: [{ name: "models/gemini-z", supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] }] })
  const gr = await fetchModels(P("gemini"), KEY, g.f)
  assert.equal(g.calls[0].headers["x-goog-api-key"], KEY)
  assert.equal(gr.models[0], "gemini-z")
  assert.ok(!gr.models.includes("embedding-001"))
  const az = fakeFetch({ data: [{ id: "x" }] })
  assert.equal((await fetchModels(P("azure"), KEY, az.f)).source, "fallback")
  assert.equal((await fetchModels(P("qwen"), KEY, az.f)).source, "fallback")
  assert.equal(az.calls.length, 0)
  const ol = fakeFetch({ data: [{ id: "llama3.2" }] })
  await fetchModels(P("ollama"), undefined, ol.f)
  assert.equal(ol.calls[0].headers.authorization, undefined)
})

test("catalog: a relay baseUrl never receives the vendor key, and the vendor host is not called", async () => {
  const { f, calls } = fakeFetch({ data: [{ id: "relay-model" }] })
  await fetchModels(P("openai"), KEY, f, { baseUrl: "http://127.0.0.1:8765/v1" })
  assert.equal(calls[0].url, "http://127.0.0.1:8765/v1/models")
  assert.equal(calls[0].headers.authorization, undefined)
  await fetchModels(P("openai"), KEY, f, { baseUrl: "http://127.0.0.1:8765/v1", relayKey: "relay-k" })
  assert.equal(calls[1].headers.authorization, "Bearer relay-k")
  assert.ok(calls.every((c) => !c.url.includes("api.openai.com")))
})

test("errors: classify maps reasons to actions", () => {
  const c = (s: number, b?: unknown, h?: Record<string, string>) => classify(s, b, h)
  assert.deepEqual(c(401), { reason: "auth", action: "rotate-credential" })
  assert.equal(c(402).reason, "billing")
  assert.equal(c(400, { error: { message: "Your credit balance is too low" } }).reason, "billing")
  assert.deepEqual(c(429, "", { "Retry-After": "30" }), { reason: "rate_limit", action: "rotate-credential", retryAfterMs: 30_000 })
  assert.equal(c(400, "prompt is too long: 250000 tokens").action, "compress")
  assert.equal(c(413).reason, "payload_too_large")
  assert.equal(c(404, "model not found").action, "fallback-model")
  assert.equal(c(403, "blocked by content policy").reason, "upstream_blocked")
  assert.equal(c(400, "invalid json in tool_use").action, "repair-retry")
  assert.equal(c(0, "fetch timed out").action, "retry-same")
  assert.equal(c(503).reason, "server_error")
  assert.equal(c(529, "overloaded_error").reason, "server_error")
  assert.deepEqual(c(302), { reason: "unknown", action: "give-up" })
  assert.equal(retryAfterMs(new Headers({ "retry-after": new Date(10_000).toUTCString() }), 4_000), 6_000)
})

test("pool: strategies, cooldowns, sole credential, per-model cooldown", () => {
  let s = newPool("openai", ["K1", "K2", "K3"], "round_robin")
  const seq: (string | null)[] = []
  for (let i = 0; i < 4; i++) { const r = pick(s, 0); seq.push(r.ref); s = r.state }
  assert.deepEqual(seq, ["K1", "K2", "K3", "K1"])
  let f = newPool("openai", ["K1", "K2"])
  f = reportFailure(f, "K1", "auth", 0)
  assert.equal(f.creds[0].coolUntil, COOLDOWN.auth)
  assert.equal(pick(f, 1).ref, "K2")
  assert.equal(pick(f, COOLDOWN.auth).ref, "K1")
  f = reportFailure(f, "K2", "rate_limit", 0)
  assert.equal(f.creds[1].coolUntil, COOLDOWN.rate_limit)
  assert.equal(pick(f, 1).ref, null)
  assert.equal(reportFailure(f, "K2", "rate_limit", 0, 5000).creds[1].coolUntil, 5000)
  assert.equal(reportFailure(f, "K2", "timeout", 0), f, "non-credential failures do not cool")
  const sole = reportFailure(newPool("x", ["ONLY"]), "ONLY", "rate_limit", 0)
  assert.equal(sole.creds[0].coolUntil, COOLDOWN.sole)
  let l = newPool("x", ["A", "B"], "least_used")
  l = pick(l, 0).state
  assert.equal(pick(l, 0).ref, "B")
  const m = coolModel(newPool("x", ["A"]), "gpt-5", 100)
  assert.equal(pick(m, 50, "gpt-5").ref, null)
  assert.equal(available(m, 50, "gpt-5-mini"), true)
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m, "state is JSON-safe")
})

const ROLES: Record<string, RoleSpec> = {
  build: { kind: "build" },
  review: { kind: "review", sensitive: true },
  plan: { kind: "plan" },
  brief: { kind: "text" },
  finance: { kind: "text", private: true },
}
const DETECTED: Detected = {
  harnesses: [{ id: "claude-code", path: "/c", loggedIn: true }, { id: "gemini-cli", path: "/g", loggedIn: "unknown" }],
  apiKeys: [{ provider: "openai", envVar: "OPENAI_API_KEY" }, { provider: "deepseek", envVar: "DEEPSEEK_API_KEY" }],
  local: [],
}

test("router: planRouting picks strongest for review, cheapest for text, sandboxed harness for builders", () => {
  const { table, unassigned } = planRouting(DETECTED, DEFAULT_ROSTER, ROLES, DEFAULT_POLICY)
  assert.equal(table.roles.build.primary, "claude-code")
  assert.ok(!table.roles.build.fallback.includes("gemini-cli"), "gemini CLI is not sandboxed")
  assert.ok(["claude-code", "gpt-5"].includes(table.roles.review.primary))
  assert.ok(!table.roles.review.fallback.some((n) => ["gpt-5-mini", "deepseek"].includes(n)), "sensitive stays top tier")
  assert.equal(table.roles.brief.primary, "claude-code") // cost 0 plan harness is cheapest
  assert.deepEqual(unassigned, ["finance"], "no privateOk provider detected")
  assert.deepEqual(validateTable(table, DEFAULT_ROSTER, DEFAULT_POLICY, ROLES), [])
  const withLocal = planRouting({ ...DETECTED, local: [{ provider: "ollama", baseUrl: "http://localhost:11434/v1" }] }, DEFAULT_ROSTER, ROLES)
  assert.equal(withLocal.table.roles.finance.primary, "ollama-local")
  const unsafe = planRouting(DETECTED, DEFAULT_ROSTER, ROLES, { allowUnsafe: ["unsandboxed-builders"] })
  assert.ok(unsafe.table.roles.build.fallback.includes("gemini-cli"))
})

test("router: validateTable rejects raw URLs, unknown names and hard-limit violations", () => {
  const errs = validateTable({
    main: "https://evil.example/v1",
    roles: { build: { primary: "gpt-5", fallback: ["nope"] }, review: { primary: "deepseek", fallback: [] }, finance: { primary: "gpt-5", fallback: [] }, ghost: { primary: "gpt-5", fallback: [] } },
  }, DEFAULT_ROSTER, DEFAULT_POLICY, ROLES)
  assert.ok(errs.some((e) => e.startsWith("main:") && e.includes("not a profile name")))
  assert.ok(errs.some((e) => e.includes("builders need a harness")))
  assert.ok(errs.some((e) => e.includes('unknown profile "nope"')))
  assert.ok(errs.some((e) => e.includes("top-tier")))
  assert.ok(errs.some((e) => e.includes("privateOk")))
  assert.ok(errs.some((e) => e.includes("ghost: unknown role")))
})

test("router: resolve honours down/cooldown, explain says why", () => {
  const table = { main: "gpt-5", roles: { review: { primary: "claude-code", fallback: ["gpt-5", "opus"] } } }
  assert.equal(resolve("review", table, {}, 0), "claude-code")
  const health = { "claude-code": { coolUntil: 120_000 }, "gpt-5": { down: true } }
  assert.equal(resolve("review", table, health, 0), "opus")
  assert.equal(resolve("review", table, health, 120_000), "claude-code")
  assert.equal(resolve("nope", table, {}), null)
  assert.match(explain("review", table, health, 0), /claude-code \(cooling 2 min\) -> gpt-5 \(down\) -> opus; now using opus/)
  assert.match(explain("nope", table), /no route/)
})

test("router: main-thread proposal is validated, falls back on any problem", async () => {
  const p = mainThreadPrompt(DETECTED, DEFAULT_ROSTER, ROLES, DEFAULT_POLICY)
  assert.ok(p.input.includes("claude-code") && !p.input.includes("opus"), "only available profiles offered")
  assert.ok(!p.input.includes("http"), "no URLs in the prompt")
  const good = { main: "gpt-5", roles: { build: { primary: "claude-code", fallback: [] }, review: { primary: "gpt-5", fallback: ["claude-code"] } } }
  const call = (v: unknown): ModelCall => (async () => ({ value: v })) as ModelCall
  const ok = await proposeTable(call(good), DETECTED, DEFAULT_ROSTER, ROLES, DEFAULT_POLICY)
  assert.equal(ok.source, "main")
  assert.deepEqual(ok.table.roles.review.fallback, ["claude-code"])
  const bad = await proposeTable(call({ ...good, roles: { build: { primary: "gpt-5", fallback: [] } } }), DETECTED, DEFAULT_ROSTER, ROLES, DEFAULT_POLICY)
  assert.equal(bad.source, "default")
  assert.ok(bad.problems[0].includes("harness"))
  const notAvail = await proposeTable(call({ main: "opus", roles: {} }), DETECTED, DEFAULT_ROSTER, ROLES, DEFAULT_POLICY)
  assert.equal(notAvail.source, "default", "a profile that is not connected is refused")
  assert.equal((await proposeTable(call("not json"), DETECTED, DEFAULT_ROSTER, ROLES, DEFAULT_POLICY)).source, "default")
  const throws: ModelCall = async () => { throw new Error("boom") }
  const t = await proposeTable(throws, DETECTED, DEFAULT_ROSTER, ROLES, DEFAULT_POLICY)
  assert.equal(t.source, "default")
  assert.deepEqual(t.table, planRouting(DETECTED, DEFAULT_ROSTER, ROLES, DEFAULT_POLICY).table)
})

test("config: empty is valid and off; unsafe needs explicit flags; keys are names only", () => {
  const cfg = providersConfigSchema.parse({})
  assert.equal(cfg.enabled, false)
  assert.deepEqual(policyFrom(cfg), DEFAULT_POLICY)
  assert.equal(rosterFrom(cfg).length, DEFAULT_ROSTER.length)
  assert.ok(!providersConfigSchema.safeParse({ providers: { openai: { keyEnv: ["sk-abc123"] } } }).success)
  assert.ok(!providersConfigSchema.safeParse({ policy: { allowUnsafe: ["everything"] } }).success)
  assert.ok(!providersConfigSchema.safeParse({ main: "http://x/v1" }).success)
  assert.ok(!providersConfigSchema.safeParse({ surprise: 1 }).success)
  const full = providersConfigSchema.parse({
    enabled: true,
    providers: { openai: { keyEnv: ["OPENAI_API_KEY", "OPENAI_API_KEY_2"], strategy: "round_robin" }, custom: { baseUrl: "http://127.0.0.1:8765/v1" } },
    roster: [{ name: "jev-router", provider: "custom", model: "auto", tier: "cheap" }, { name: "opus", provider: "anthropic", model: "claude-opus-x", tier: "top" }],
    main: "gpt-5",
    roles: { review: { fallback: ["opus"] } },
    policy: { allowUnsafe: ["private-remote"] },
  })
  const roster = rosterFrom(full)
  assert.equal(roster.find((e) => e.name === "opus")?.model, "claude-opus-x")
  assert.ok(roster.some((e) => e.name === "jev-router"))
  assert.deepEqual(policyFrom(full).allowUnsafe, ["private-remote"])
  const t = applyOverrides({ main: "claude-code", roles: { review: { primary: "gpt-5", fallback: ["claude-code"] } } }, full)
  assert.deepEqual(t, { main: "gpt-5", roles: { review: { primary: "gpt-5", fallback: ["opus"] } } })
})

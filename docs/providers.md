# Providers and routing

Code in `src/providers/`. Wired since 20-21 Oct behind `providers.enabled` (default false): with it off, Dobby runs `claude` exactly as before. Also read-only `dobby providers detect|models|explain`.

## Concepts

- **Provider**: a place to get a model, such as an API key, a local server (Ollama, LM Studio, llama.cpp, vLLM) or a gateway (OpenRouter, Vercel, Hugging Face). Providers can only answer prompts; they cannot edit code.
- **Harness**: an agent CLI that edits code and runs tools: `claude`, `codex`, `gemini`. Each one uses its own login, and Dobby never reads or holds those tokens.
- **Preset** (`presets.ts`): one data entry per provider: id, wire format, base URL, key env var names, auth kind, headers, quirks, seed models and a docs link. Entries with `verified: false` hold facts the vendor's docs page did not state.
- **Roster** (`router.ts` `DEFAULT_ROSTER`, plus `roster` in config): named profiles, each a name, provider, model, capabilities, cost per Mtok and tier. A routing table can only point at these names. Raw URLs are never allowed in it.
- **Routing table**: `main`, plus for each role a primary, its fallbacks, and optionally `effort` and `maxCostUsd`.
- **Main thread**: the model the owner picks. `proposeTable()` asks it for a table. The answer always goes through `validateTable()`, and on any problem (an error, bad JSON, an unknown name, a broken limit) `planRouting()`'s default table is used instead.

## Modules

| File | Does |
|---|---|
| `detect.ts` | Finds which harnesses are installed (`which`) and signed in (`claude auth status`, `codex login status`, env vars for gemini), which key env vars exist (names only, never values), and which local servers answer (ports 11434 and 1234). Never reads credential files. |
| `catalog.ts` | Lists live models: GET `/models` with the right auth for each wire format, filtered to chat models, merged with the preset's seed models. The cache is keyed by a SHA-256 fingerprint of the key. It is fresh for 1 h, served stale while revalidating for up to 7 days, and empty lists are never cached. If you set a relay `baseUrl`, the vendor key is never sent: only `relayKey` goes to the relay. |
| `errors.ts` | `classify(status, body, headers)` turns a failure into a reason (auth, billing, rate_limit, ...) and an action (retry-same, rotate-credential, fallback-model, compress, repair-retry, give-up). |
| `pool.ts` | Key pool for each provider, with fill_first, round_robin and least_used strategies. Cooldowns: 5 min after a 401 or billing failure, 1 h or Retry-After after a 429, at most 60 s when it is the only key. Models can also cool down on their own. State is plain JSON, and the caller saves it. |
| `router.ts` | `planRouting`, `validateTable`, `resolve` (first healthy profile in the chain), `explain`, `mainThreadPrompt`, `proposeTable`, `ModelCall`. |
| `wire.ts` | Dobby side: pool state and catalog cache in kv (`providers:pool:*`, `providers:catalog:*`), the real runner (`which`, status commands, HTTP probe; argument arrays, timeouts), Dobby's roles as routing specs, and `dobby providers detect\|models\|explain`. |
| `../agents.ts` | Harness adapters, entered only when `providers.enabled` is true: claude native (the unchanged `claudeOnce`), codex native (`codex exec --sandbox read-only`, prompt on stdin), a strict ACP client (Gemini CLI `--experimental-acp`), and plain providers through an injected `ModelCall` (`setProviderCalls`). `resolveAdapter(role, run, routing, makers)` picks from the routed table; deny by default: a run leaves claude only when its tool list is provably read-only (its kind is not sandboxed and it resumes no session); review, review-chat and check stay on claude; codex never gets design, pm, area-pm, brainstorm or cos; tool-less runs go to claude or a plain provider only; roles with `ownerData` reach a plain provider only with `policy.allowUnsafe: ["owner-data-to-providers"]`; ACP (Gemini CLI) needs `providers.acp: true` as well and is unverified against a real agent; a failed non-claude profile cools 15 min, then the route's next profile is tried, claude native last. |
| `config.ts` | `providersConfigSchema` (zod) for the `providers` config section, plus `rosterFrom`, `policyFrom` and `applyOverrides`. Every field is optional, and `enabled` defaults to false. |

## Add a provider

If it speaks the OpenAI API, add one entry to `PROVIDERS` in `presets.ts` with the base URL, key env var names, docs link and `verified`. You don't need to write any code. To use it in routing, add a roster entry (in config or `DEFAULT_ROSTER`) naming that provider id. For a one-off endpoint, use the `custom` preset with `providers.custom.baseUrl` in config.

## Safety limits (always on)

1. A builder runs only on a sandboxed harness (claude, codex). The Gemini CLI does not count as sandboxed.
2. A sensitive role (such as review) runs only on a top-tier profile.
3. A role marked `private` runs only on a profile marked `privateOk`, which by default means only local servers.

To loosen a limit, the owner has to name it in `policy.allowUnsafe`: `unsandboxed-builders`, `sensitive-below-top` or `private-remote`. Nothing else can loosen it, including the main model.
Config stores key env var NAMES, never key values. A Claude Pro/Max plan is used only through the official `claude` CLI, never by reusing its token.

## Wired / not yet

- Done: harness adapters (`src/agents.ts`, step 3), opt-in with `providers.enabled` (default false: `claude()` never loads agents.ts).
- Done: everything above, with offline tests in `tests/providers.test.ts` and `tests/providers-wire.test.ts`; the `providers` config section; pool and catalog in kv; the real runner; `dobby providers detect|models|explain` (read-only).
- Not yet:
  2. Implement `ModelCall` with an AI SDK provider once Dobby can resolve that package (today it is not installed; this needs a publish or a workspace link). Pass it with `setProviderCalls((profile) => ModelCall | undefined)` from `src/agents.ts`; until then plain-provider profiles are skipped. The adapters are AI SDK `openai-compatible`, `anthropic` and `google`.
  7. Refresh `DEFAULT_ROSTER` prices and models from the live catalog or models.dev.

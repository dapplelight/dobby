// Provider presets AS DATA. Adding a provider = adding one entry here, no code.
// Facts checked against vendor docs on 2026-10-20; `verified: false` + `note` marks what the page did not state.
// Pure module: no imports from Dobby runtime paths.

export type Wire = "openai-chat" | "anthropic-messages" | "gemini-native" | "openai-responses" | "cli"
export type AuthKind = "apiKey" | "oauth-cli" | "none" | "local"

export interface ProviderProfile {
  kind: "provider"
  id: string
  label: string
  wire: Wire
  baseUrl: string // may hold {placeholders} the user fills (region, resource, project)
  envVars: string[] // key env NAMES, first match wins; never values
  authKind: AuthKind
  defaultHeaders?: Record<string, string>
  quirks?: string[] // free-form flags adapters read, e.g. "no-models-endpoint"
  fallbackModels: string[]
  docs: string
  verified: boolean
  note?: string
  privateOk?: boolean // default for routing: may this provider see private text? (local only by default)
}

export interface HarnessProfile {
  kind: "harness"
  id: string
  label: string
  wire: "cli"
  bin: string
  // How to tell it is signed in WITHOUT reading credential files: a status command, or env names.
  loginCheck: { argv?: string[]; envVars?: string[] }
  sandboxed: boolean // has its own OS sandbox Dobby can switch on for builders
  acp?: string[] // argv after `bin` that starts it as an Agent Client Protocol server over stdio (src/agents.ts)
  docs: string
  verified: boolean
  note?: string
}

const p = (x: Omit<ProviderProfile, "kind">): ProviderProfile => ({ kind: "provider", ...x })

export const PROVIDERS: readonly ProviderProfile[] = [
  p({ id: "openai", label: "OpenAI", wire: "openai-chat", baseUrl: "https://api.openai.com/v1", envVars: ["OPENAI_API_KEY"], authKind: "apiKey", fallbackModels: ["gpt-5", "gpt-5-mini"], docs: "https://developers.openai.com/api/docs/quickstart", verified: true }),
  p({ id: "anthropic", label: "Anthropic API", wire: "anthropic-messages", baseUrl: "https://api.anthropic.com", envVars: ["ANTHROPIC_API_KEY"], authKind: "apiKey", defaultHeaders: { "anthropic-version": "2023-06-01" }, quirks: ["x-api-key"], fallbackModels: ["claude-opus-4-1", "claude-sonnet-4-5", "claude-haiku-4-5"], docs: "https://platform.claude.com/docs/en/api/models/list", verified: true, note: "API key only; never a Pro/Max plan token" }),
  p({ id: "gemini", label: "Google Gemini", wire: "gemini-native", baseUrl: "https://generativelanguage.googleapis.com/v1beta", envVars: ["GOOGLE_API_KEY", "GEMINI_API_KEY"], authKind: "apiKey", quirks: ["x-goog-api-key"], fallbackModels: ["gemini-2.5-pro", "gemini-2.5-flash"], docs: "https://ai.google.dev/gemini-api/docs/api-key", verified: true, note: "GOOGLE_API_KEY wins if both set; OpenAI-compat base is {base}/openai/; GET /v1beta/models path not on the fetched page" }),
  p({ id: "openrouter", label: "OpenRouter", wire: "openai-chat", baseUrl: "https://openrouter.ai/api/v1", envVars: ["OPENROUTER_API_KEY"], authKind: "apiKey", fallbackModels: ["openrouter/auto"], docs: "https://openrouter.ai/docs/quickstart", verified: true }),
  p({ id: "deepseek", label: "DeepSeek", wire: "openai-chat", baseUrl: "https://api.deepseek.com", envVars: ["DEEPSEEK_API_KEY"], authKind: "apiKey", fallbackModels: ["deepseek-chat", "deepseek-reasoner"], docs: "https://api-docs.deepseek.com/", verified: true, note: "GET /models assumed" }),
  p({ id: "xai", label: "xAI", wire: "openai-chat", baseUrl: "https://api.x.ai/v1", envVars: ["XAI_API_KEY"], authKind: "apiKey", fallbackModels: ["grok-4"], docs: "https://docs.x.ai/docs/api-reference", verified: true, note: "GET /models assumed" }),
  p({ id: "groq", label: "Groq", wire: "openai-chat", baseUrl: "https://api.groq.com/openai/v1", envVars: ["GROQ_API_KEY"], authKind: "apiKey", fallbackModels: ["llama-3.3-70b-versatile"], docs: "https://console.groq.com/docs/openai", verified: true, note: "GET /models assumed" }),
  p({ id: "mistral", label: "Mistral", wire: "openai-chat", baseUrl: "https://api.mistral.ai/v1", envVars: ["MISTRAL_API_KEY"], authKind: "apiKey", fallbackModels: ["mistral-large-latest", "mistral-small-latest"], docs: "https://docs.mistral.ai/api/", verified: true }),
  p({ id: "together", label: "Together AI", wire: "openai-chat", baseUrl: "https://api.together.ai/v1", envVars: ["TOGETHER_API_KEY"], authKind: "apiKey", fallbackModels: [], docs: "https://docs.together.ai/docs/openai-api-compatibility", verified: true }),
  p({ id: "fireworks", label: "Fireworks", wire: "openai-chat", baseUrl: "https://api.fireworks.ai/inference/v1", envVars: ["FIREWORKS_API_KEY"], authKind: "apiKey", fallbackModels: [], docs: "https://docs.fireworks.ai/tools-sdks/openai-compatibility", verified: false, note: "base verified; FIREWORKS_API_KEY and /models not on the page (docs use OPENAI_API_KEY)" }),
  p({ id: "deepinfra", label: "DeepInfra", wire: "openai-chat", baseUrl: "https://api.deepinfra.com/v1/openai", envVars: ["DEEPINFRA_API_KEY"], authKind: "apiKey", fallbackModels: [], docs: "https://docs.deepinfra.com/chat/overview", verified: true, note: "GET /models assumed" }),
  p({ id: "zai", label: "Z.AI (GLM)", wire: "openai-chat", baseUrl: "https://api.z.ai/api/paas/v4", envVars: ["ZAI_API_KEY"], authKind: "apiKey", fallbackModels: ["glm-4.6"], docs: "https://docs.z.ai/guides/overview/quick-start", verified: false, note: "base verified; ZAI_API_KEY is convention; coding-plan keys use https://api.z.ai/api/coding/paas/v4 and are not interchangeable" }),
  p({ id: "moonshot", label: "Kimi / Moonshot", wire: "openai-chat", baseUrl: "https://api.moonshot.ai/v1", envVars: ["MOONSHOT_API_KEY"], authKind: "apiKey", fallbackModels: ["kimi-k2-0905-preview"], docs: "https://platform.kimi.ai/docs/guide/start-using-kimi-api", verified: true, note: ".cn host unverified; GET /models assumed" }),
  p({ id: "qwen", label: "Qwen / Alibaba Model Studio", wire: "openai-chat", baseUrl: "https://{workspace}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", envVars: ["DASHSCOPE_API_KEY"], authKind: "apiKey", quirks: ["region-bound-key"], fallbackModels: ["qwen-plus", "qwen-max"], docs: "https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope", verified: true, note: "us-east-1 also; legacy dashscope-intl.aliyuncs.com not recommended; /models assumed" }),
  p({ id: "minimax", label: "MiniMax", wire: "openai-chat", baseUrl: "https://api.minimax.io/v1", envVars: ["MINIMAX_API_KEY"], authKind: "apiKey", quirks: ["no-models-endpoint"], fallbackModels: ["MiniMax-M2"], docs: "https://platform.minimax.io/docs/api-reference/text-openai-api", verified: false, note: "base verified; MINIMAX_API_KEY not on the page" }),
  p({ id: "nvidia", label: "NVIDIA NIM", wire: "openai-chat", baseUrl: "https://integrate.api.nvidia.com/v1", envVars: ["NVIDIA_API_KEY"], authKind: "apiKey", fallbackModels: [], docs: "https://docs.api.nvidia.com/nim/reference/llm-apis", verified: false, note: "base verified; NVIDIA_API_KEY and /models not on the page" }),
  p({ id: "huggingface", label: "Hugging Face Inference Providers", wire: "openai-chat", baseUrl: "https://router.huggingface.co/v1", envVars: ["HF_TOKEN"], authKind: "apiKey", quirks: ["model-suffix-policy"], fallbackModels: [], docs: "https://huggingface.co/docs/inference-providers/index", verified: true }),
  p({ id: "vercel", label: "Vercel AI Gateway", wire: "openai-chat", baseUrl: "https://ai-gateway.vercel.sh/v1", envVars: ["AI_GATEWAY_API_KEY"], authKind: "apiKey", fallbackModels: [], docs: "https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions", verified: true }),
  p({ id: "bedrock", label: "Amazon Bedrock", wire: "openai-chat", baseUrl: "https://bedrock-runtime.{region}.amazonaws.com/openai/v1", envVars: ["AWS_BEARER_TOKEN_BEDROCK"], authKind: "apiKey", quirks: ["no-models-endpoint"], fallbackModels: [], docs: "https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html", verified: true, note: "SigV4 (AWS_ACCESS_KEY_ID) needs a native adapter, not wired" }),
  p({ id: "vertex", label: "Google Vertex AI", wire: "openai-chat", baseUrl: "https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi", envVars: ["GOOGLE_CLOUD_PROJECT"], authKind: "oauth-cli", quirks: ["adc-token", "no-models-endpoint"], fallbackModels: ["google/gemini-2.5-pro"], docs: "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/openai", verified: false, note: "URL template not confirmed on the page; auth via gcloud ADC token" }),
  p({ id: "azure", label: "Azure OpenAI", wire: "openai-chat", baseUrl: "https://{resource}.openai.azure.com/openai/v1", envVars: ["AZURE_OPENAI_API_KEY"], authKind: "apiKey", quirks: ["api-key-header", "model-is-deployment", "no-models-endpoint"], fallbackModels: [], docs: "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle", verified: true }),
  p({ id: "ollama", label: "Ollama (local)", wire: "openai-chat", baseUrl: "http://localhost:11434/v1", envVars: [], authKind: "local", fallbackModels: [], docs: "https://docs.ollama.com/api/openai-compatibility", verified: true, privateOk: true, note: "native list: GET /api/tags" }),
  p({ id: "lmstudio", label: "LM Studio (local)", wire: "openai-chat", baseUrl: "http://localhost:1234/v1", envVars: [], authKind: "local", fallbackModels: [], docs: "https://lmstudio.ai/docs/developer/openai-compat", verified: true, privateOk: true }),
  p({ id: "llamacpp", label: "llama.cpp server (local)", wire: "openai-chat", baseUrl: "http://localhost:8080/v1", envVars: ["LLAMA_API_KEY"], authKind: "local", fallbackModels: [], docs: "https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md", verified: false, privateOk: true, note: "default port unsettled (README says 9931 on master, docker uses 8080): set baseUrl" }),
  p({ id: "vllm", label: "vLLM (local)", wire: "openai-chat", baseUrl: "http://localhost:8000/v1", envVars: ["VLLM_API_KEY"], authKind: "local", fallbackModels: [], docs: "https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html", verified: false, privateOk: true, note: "page only partly readable" }),
  p({ id: "custom", label: "Custom OpenAI-compatible", wire: "openai-chat", baseUrl: "", envVars: [], authKind: "apiKey", fallbackModels: [], docs: "", verified: true, note: "user supplies baseUrl, key env name and headers" }),
]

export const HARNESSES: readonly HarnessProfile[] = [
  { kind: "harness", id: "claude-code", label: "Claude Code", wire: "cli", bin: "claude", loginCheck: { argv: ["auth", "status"] }, sandboxed: true, docs: "https://docs.claude.com/en/docs/claude-code/cli-reference", verified: true, note: "`claude auth status` prints JSON; runs on the user's own login" },
  { kind: "harness", id: "codex-cli", label: "OpenAI Codex CLI", wire: "cli", bin: "codex", loginCheck: { argv: ["login", "status"] }, sandboxed: true, docs: "https://developers.openai.com/codex/cli", verified: true, note: "sandbox via --sandbox workspace-write" },
  { kind: "harness", id: "gemini-cli", label: "Gemini CLI", wire: "cli", bin: "gemini", loginCheck: { envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] }, sandboxed: false, acp: ["--experimental-acp"], docs: "https://geminicli.com/docs/get-started/authentication/", verified: true, note: "no status command; cached Google sign-in is invisible without reading ~/.gemini (we do not). Docs say it was replaced by Antigravity CLI on 2026-06-18" },
]

export const PROFILES = [...PROVIDERS, ...HARNESSES] as const

export function profileById(id: string): ProviderProfile | HarnessProfile | undefined {
  return PROFILES.find((x) => x.id === id)
}

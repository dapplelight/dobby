// What can this machine reach? Pure: every side effect is injected. Never reads credential files or key values.
import { HARNESSES, PROVIDERS, type HarnessProfile } from "./presets.ts"

export type Which = (bin: string) => Promise<string | null> // absolute path or null
// Runs a harness status command (argv array, no shell); resolves to its exit code, or "unknown" when it could not tell
// (timeout, missing binary, killed). Optional: skip = "unknown".
export type RunStatus = (bin: string, argv: string[]) => Promise<number | "unknown">
export type Probe = (url: string) => Promise<boolean> // true when a local server answers

export interface Detected {
  harnesses: { id: string; path: string; loggedIn: boolean | "unknown" }[]
  apiKeys: { provider: string; envVar: string }[] // names only
  local: { provider: string; baseUrl: string }[]
}

const LOCAL_PROBES: Record<string, string> = {
  ollama: "http://localhost:11434/api/tags",
  lmstudio: "http://localhost:1234/v1/models",
}

export async function detect(
  env: Record<string, string | undefined>,
  which: Which,
  probe: Probe,
  runStatus?: RunStatus,
): Promise<Detected> {
  const harnesses: Detected["harnesses"] = []
  for (const h of HARNESSES) {
    const path = await which(h.bin)
    if (path) harnesses.push({ id: h.id, path, loggedIn: await loginState(h, env, runStatus) })
  }
  const apiKeys: Detected["apiKeys"] = []
  for (const pr of PROVIDERS) {
    if (pr.authKind === "local") continue
    const name = pr.envVars.find((n) => !!env[n]?.trim())
    if (name) apiKeys.push({ provider: pr.id, envVar: name })
  }
  const local: Detected["local"] = []
  for (const [id, url] of Object.entries(LOCAL_PROBES)) {
    if (await probe(url).catch(() => false)) local.push({ provider: id, baseUrl: PROVIDERS.find((x) => x.id === id)!.baseUrl })
  }
  return { harnesses, apiKeys, local }
}

async function loginState(h: HarnessProfile, env: Record<string, string | undefined>, run?: RunStatus): Promise<boolean | "unknown"> {
  if (h.loginCheck.envVars?.some((n) => !!env[n]?.trim())) return true
  if (!h.loginCheck.argv || !run) return "unknown"
  const code = await run(h.bin, h.loginCheck.argv).catch(() => "unknown" as const)
  return code === "unknown" ? code : code === 0
}

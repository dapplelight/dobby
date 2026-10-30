// The data behind Settings' read-only sections and the First run page: health checks, schedules, providers, and the repos found under the projects folder.
// Nothing here writes. Probes run as argument arrays (src/checks.ts, src/providers) and never read a key's value.
import { existsSync, readdirSync } from "node:fs"
import { config, expand, tzOffset, zoneLabel, type Config } from "./config.ts"
import { basics, type Check } from "./checks.ts"
import { JOBS } from "./jobs.ts"
import { detect, type Detected } from "./providers/detect.ts"
import { HARNESSES, PROVIDERS } from "./providers/presets.ts"
import { runner, type Runner } from "./providers/wire.ts"
import { readSecrets } from "./notify.ts"

const DAY = 86_400_000
const HOUR = 3_600_000

// ---- Health: the `dobby doctor` basics, each with its fix command ------------------------------------------------------------------

export type HealthView = { at: number; checks: Check[] }
export async function healthView(o: { checks?: () => Promise<Check[]>; now?: number; apiKeyMode?: boolean } = {}): Promise<HealthView> {
  return { at: o.now ?? Date.now(), checks: await (o.checks ?? (() => basics({ jobs: true, apiKeyMode: o.apiKeyMode })))() }
}

// ---- Schedules: the background jobs and the next run --------------------------------------------------------------------------------

/** The next time the zone's clock reads `hour`:`minute` after `now` (the zone's offset at `now`; a clock change in between can shift it by an hour). */
function nextAt(hour: number, minute: number, now: number, tz?: string): number {
  const off = tz ? tzOffset(now, tz) : -new Date(now).getTimezoneOffset() * 60_000
  const local = now + off
  let t = local - (local % DAY) + hour * HOUR + minute * 60_000
  if (t <= local) t += DAY
  return t - off
}

export type ScheduleRow = { name: string; what: string; when: string; next: number | null }
export function schedulesView(cfg: Pick<Config, "timezone" | "timezoneLabel" | "eveningPostHour" | "scout">, now = Date.now()): ScheduleRow[] {
  const z = cfg.timezoneLabel || zoneLabel(cfg.timezone), hh = (h: number, m = 0) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
  const rows: ScheduleRow[] = JOBS.map((j) => ({
    name: j.name, what: j.what.replace(/^[^:]+: /, ""),
    when: j.at ? `daily ${hh(...j.at)} (this Mac's clock)` : j.every ? `every ${j.every % 3600 === 0 ? (j.every === 3600 ? "hour" : `${j.every / 3600} hours`) : `${Math.round(j.every / 60)} minutes`}` : "always on",
    next: j.at ? nextAt(j.at[0], j.at[1], now) : null,
  }))
  rows.push({ name: "evening post", what: "the day's usage in #system-status", when: `daily ${hh(cfg.eveningPostHour)} ${z}`, next: nextAt(cfg.eveningPostHour, 0, now, cfg.timezone) })
  if (cfg.scout?.enabled !== false) {
    const h = cfg.scout?.hour ?? 23
    rows.push({ name: "scout", what: "the Talent Scout's window opens", when: `daily ${hh(h)} ${z}`, next: nextAt(h, 0, now, cfg.timezone) })
  }
  return rows
}

// ---- Providers: what is detected and whether a key is set (never the key) ------------------------------------------------------------

export type ProviderRow = { id: string; label: string; kind: "code tool" | "model API" | "local"; detected: boolean; key: "signed in" | "set" | "not set" | "not signed in" | "unknown" | "none needed"; enabled: boolean | null }
export type ProvidersView = { at: number; routing: boolean; rows: ProviderRow[]; hidden: number }

export async function providersView(o: { cfg?: Config["providers"]; env?: Record<string, string | undefined>; run?: Runner; detected?: Detected; now?: number } = {}): Promise<ProvidersView> {
  const cfg = o.cfg ?? config().providers, env = o.env ?? { ...readSecrets(), ...process.env }, r = o.run ?? runner()
  const d = o.detected ?? await detect(env, r.which, r.probe, r.runStatus)
  const conf = cfg?.providers ?? {}
  const rows: ProviderRow[] = [
    ...HARNESSES.map((h): ProviderRow => {
      const f = d.harnesses.find((x) => x.id === h.id)
      return { id: h.id, label: h.label, kind: "code tool", detected: !!f, key: !f ? "not set" : f.loggedIn === true ? "signed in" : f.loggedIn === false ? "not signed in" : "unknown", enabled: null }
    }),
    ...PROVIDERS.map((p): ProviderRow => {
      const k = d.apiKeys.find((x) => x.provider === p.id), l = d.local.find((x) => x.provider === p.id)
      return { id: p.id, label: p.label, kind: p.authKind === "local" ? "local" : "model API", detected: !!(k || l), key: p.authKind === "local" ? "none needed" : k ? "set" : "not set", enabled: conf[p.id]?.enabled ?? null }
    }),
  ]
  // The known ones that are in use first; the many that are not set up are counted, not listed.
  const shown = rows.filter((x) => x.detected || x.kind === "code tool" || conf[x.id])
  return { at: o.now ?? Date.now(), routing: !!cfg?.enabled, rows: shown, hidden: rows.length - shown.length }
}

// ---- First run ---------------------------------------------------------------------------------------------------------------------

export type WelcomeView = { needed: boolean; root: string; repos: { name: string; path: string; added: boolean }[]; leaves: string[] }

/** Git repos directly under the projects folder: directory names only, nothing inside them is read. */
export function reposUnder(root: string, added: Set<string>): WelcomeView["repos"] {
  const dir = expand(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && existsSync(`${dir}/${e.name}/.git`))
    .map((e) => ({ name: e.name, path: `${root}/${e.name}`, added: added.has(e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40)
}

/** What can leave this machine, from what is actually set up. Claude Code and GitHub always; the rest only when you turned it on. */
export function leavesMachine(cfg: Pick<Config, "providers" | "safety" | "tools" | "billing">, secrets: Record<string, string>, env: Record<string, string | undefined>): string[] {
  const out = [cfg.billing?.mode === "apiKey" ? "Calls to Claude Code, billed to your API key." : "Calls to Claude Code, on your own Claude sign-in.", "GitHub, through the gh sign-in on this machine."]
  if (secrets.DISCORD_BOT_TOKEN) out.push("Discord, because a bot token is set: notices and buttons go to your server.")
  if ((env.JEV_API_KEY || secrets.JEV_API_KEY) && (cfg.safety.classifier === "jev" || cfg.tools?.jev)) out.push("Jev, because you switched it on: ticket text for sizing and risk.")
  if (cfg.providers?.enabled) out.push("Other model providers, because routing is on in Settings.")
  return out
}

export function welcomeView(o: { projects: () => Record<string, unknown>; root?: string; cfg?: Config; secrets?: Record<string, string>; env?: Record<string, string | undefined> }): WelcomeView {
  const cfg = o.cfg ?? config(), names = Object.keys(o.projects()), root = o.root ?? cfg.paths.projects
  return { needed: names.length === 0, root, repos: reposUnder(root, new Set(names)), leaves: leavesMachine(cfg, o.secrets ?? readSecrets(), o.env ?? process.env) }
}

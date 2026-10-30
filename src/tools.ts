// Optional agent tooling (graphify, rtk, caveman, ponytail, jev): which are on, which this machine has, and the rules text agents get.
// Rules live in agent-rules/<part>.md; a tool's part is added only when it is on AND found (jev: on AND JEV_API_KEY present, never read out).
// With every tool on the text equals the old single agent-rules.md byte for byte (tests/tools.test.ts).
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { config, expand, privatePath, type Config } from "./config.ts"
import { jevKey } from "./jev.ts"

export const TOOLS = ["graphify", "rtk", "caveman", "ponytail", "jev"] as const
export type Tool = (typeof TOOLS)[number]
export const GRAPHIFY_PIN = "0.9.75"
/** Install commands (printed, run only on a yes) and one line on each tool. caveman/ponytail are text only: nothing to install. */
export const INFO: Record<Tool, { what: string; install?: string[] }> = {
  graphify: { what: "code graph; agents query it before reading files (Apache-2.0)", install: [`uv tool install graphifyy==${GRAPHIFY_PIN}`] },
  rtk: { what: "trims shell output to save tokens (Apache-2.0, rtk-ai.app)", install: ["brew install rtk"] }, // Homebrew core formula; other systems: https://www.rtk-ai.app/
  caveman: { what: "terse style for agent-to-agent notes (text only)" },
  ponytail: { what: "'laziest solution that works' coding style (text only)" },
  jev: { what: "paid TypeSafe classifier; needs JEV_API_KEY, opt-in" },
}
const DIR = fileURLToPath(new URL("../agent-rules/", import.meta.url))
const FREE: Tool[] = ["graphify", "rtk", "caveman", "ponytail"]

export const enabled = (t: Tool, c: Pick<Config, "tools" | "safety"> = config()) =>
  c.tools?.[t] ?? (t === "jev" ? c.safety.classifier === "jev" : FREE.includes(t))

export type Detect = (t: Tool) => boolean
const has = (bin: string) => !spawnSync(bin, ["--version"], { stdio: "ignore" }).error
/** What setup can install here: commands to run on a yes, or a note when a prerequisite (uv, Homebrew) is missing. `have` answers "is this program on PATH". */
export function installPlan(t: "graphify" | "rtk", have: (bin: string) => boolean = has): { cmds: string[]; note?: string } {
  if (t === "rtk") return have("brew") ? { cmds: INFO.rtk.install! } : { cmds: [], note: "rtk: Homebrew is not installed. See https://www.rtk-ai.app/ for other ways to install it." }
  if (have("uv")) return { cmds: INFO.graphify.install! }
  if (have("pipx")) return { cmds: [`pipx install graphifyy==${GRAPHIFY_PIN}`] }
  return { cmds: [], note: `graphify: needs uv. Install it with: curl -LsSf https://astral.sh/uv/install.sh | sh, then run: ${INFO.graphify.install![0]} (or pipx install graphifyy==${GRAPHIFY_PIN})` }
}
/** The real rtk answers --version and `rtk gain`; Rust Type Kit, which shares the name, has no `gain`. */
export const rtkOk = (run: (args: string[]) => number | null = (a) => spawnSync("rtk", a, { stdio: "ignore", timeout: 10_000 }).status) => run(["--version"]) === 0 && run(["gain"]) === 0
/** On this machine: graphify on PATH, rtk answering --version, jev key present; text-only tools always. */
export const detect: Detect = (t) => {
  if (t === "graphify") return !spawnSync("graphify", ["--version"], { stdio: "ignore" }).error
  if (t === "rtk") return rtkOk()
  if (t === "jev") return !!jevKey()
  return true
}

/** The rules text for every agent: core, then each tool's part that is on and found, then the user's own rules file. */
export function agentRules(c: Pick<Config, "tools" | "safety" | "paths"> = config(), found: Detect = detect): string {
  const on = (t: Tool) => enabled(t, c) && found(t)
  const part = (n: string) => readFileSync(`${DIR}${n}.md`, "utf8")
  const secrets = part("secrets").trimEnd()
  const parts = [
    part("core"),
    on("caveman") && part("caveman"),
    on("graphify") && part("graphify"),
    on("rtk") && part("rtk"),
    on("jev") ? `${secrets.replace("## Secrets", "## Secrets and Jev")} ${part("jev").trimEnd()}` : secrets,
    on("ponytail") && part("ponytail"),
    ...(c.paths.agentRules && existsSync(expand(c.paths.agentRules)) ? [readFileSync(expand(c.paths.agentRules), "utf8")] : []),
  ].filter((x): x is string => !!x)
  return parts.map((x) => x.replace(/\s+$/, "")).join("\n\n") + "\n"
}

let cached: string | undefined
/** The rules for this process (detection runs once). */
export const rules = () => (cached ??= agentRules())

/** `dobby tools`: one line per tool. */
export function toolsTable(c: Config = config(), found: Detect = detect): string {
  return TOOLS.map((t) => {
    const f = found(t)
    return `${t.padEnd(9)} ${enabled(t, c) ? "on " : "off"}  ${f ? "found  " : "missing"}  ${INFO[t].what}${!f && INFO[t].install ? `\n${" ".repeat(24)}install: ${INFO[t].install!.join(" && ")}` : ""}${t === "jev" && !f ? `\n${" ".repeat(24)}set JEV_API_KEY (environment or secrets file)` : ""}`
  }).join("\n")
}

/** `dobby tools on|off <name>`: edit the private config only. */
export function setTool(name: string, on: boolean, file = privatePath()): string {
  if (!(TOOLS as readonly string[]).includes(name)) throw new Error(`unknown tool "${name}" (${TOOLS.join(", ")})`)
  const j = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
  j.tools = { ...j.tools, [name]: on }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(j, null, 2) + "\n")
  return `${name} ${on ? "on" : "off"} (${file})`
}

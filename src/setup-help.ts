// "Ask Claude" in setup, the terminal and the browser. Rules first: nothing here runs unless the person asks. The text Claude works from is the dobby-setup skill
// shipped in skills/dobby-setup (one source, also usable in your own Claude Code: `dobby add skill`). Haiku answers; Sonnet only when the person asks for it; never Opus.
// A suggestion is a proposal: its commands pass the same safety check as a typed one before anything runs.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { homedir, platform as osPlatform, tmpdir } from "node:os"
import { dirname, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { Check } from "./checks.ts"
import type { DB } from "./db.ts"
import { redact } from "./notify.ts"
import { shellName } from "./shell.ts"
import { record } from "./stats.ts"
import type { HELP_KINDS } from "./stats-schema.ts"

export type HelpKind = (typeof HELP_KINDS)[number]
export const SKILL_DIR = `${fileURLToPath(new URL("..", import.meta.url))}skills/dobby-setup`
export const HELP_LABEL = "Ask Claude"
export const SONNET_LABEL = "Try a stronger model"
export const NO_ANSWER = "Claude couldn't suggest anything; edit the commands yourself."
/** The machine checks the help may be asked about: names from `basics()`, nothing the request makes up. */
export const CHECK_NAMES = ["Node", "shell", "git", "GitHub CLI", "GitHub sign-in", "Claude Code", "Claude sign-in", "API key"] as const

export type Suggestion = { install?: string; test?: string; cause?: string; fix?: string }
const FIELDS = ["install", "test", "cause", "fix"] as const

/** The skill's own text (without its frontmatter) and its troubleshooting reference. */
export function skillText(dir = SKILL_DIR): string {
  const body = readFileSync(`${dir}/SKILL.md`, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim()
  const ref = existsSync(`${dir}/reference/troubleshooting.md`) ? readFileSync(`${dir}/reference/troubleshooting.md`, "utf8").trim() : ""
  return ref ? `${body}\n\n${ref}` : body
}

/** One JSON object out of Claude's reply (it may sit inside a code fence or after a sentence). Only the four string fields are kept. Null when nothing usable is there. */
export function parseSuggestion(text: string): Suggestion | null {
  const a = text.indexOf("{"), b = text.lastIndexOf("}")
  if (a < 0 || b <= a) return null
  let j: unknown
  try { j = JSON.parse(text.slice(a, b + 1)) } catch { return null }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null
  const out: Suggestion = {}
  for (const k of FIELDS) { const v = (j as Record<string, unknown>)[k]; if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, k === "install" || k === "test" ? 600 : 400) }
  return Object.keys(out).length ? out : null
}

const SYSTEM_BINS = /^(\/dev\/null|\/(usr\/)?(local\/)?s?bin\/[\w.+-]+|\/opt\/homebrew\/bin\/[\w.+-]+|\/usr\/bin\/env)$/
/**
 * Why a command may not run, or null. Typed and suggested commands pass the same check. It runs in the repo's folder only, never as another user, never
 * downloads and runs a script, and names no path outside the repo (a few system binaries aside).
 * ponytail: a token scan, not a shell parser; a command built from variables could still reach out, but it runs in the repo with the person's own rights, after they confirm.
 */
export function unsafeReason(cmd: string, repoDir: string): string | null {
  const c = cmd.trim()
  if (!c) return "The command is empty."
  if (c.length > 600) return "The command is longer than 600 characters."
  if (/[\n\r\0]/.test(c)) return "A command must be one line."
  if (/(^|[\s;&|(`])(sudo|doas|su)(\s|$)/.test(c)) return "It uses sudo or su. Dobby never runs a command as another user."
  if (/\brm\s+(-[a-z-]+\s+)*-[a-z]*[rf][a-z]*\s+(-[a-z-]+\s+)*(\/|~|\$HOME|\*|\.\.)(\s|\/|$)/i.test(c)) return "It deletes files outside the repo (rm -rf on /, ~ or ..)."
  if (/\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh|fish)(\s|$)/.test(c) || /\b(curl|wget)\b[^|;&]*\|/.test(c)) return "It pipes a download into a shell (curl | sh)."
  if (/(^|[\s;&|(`])eval(\s|$)/.test(c)) return "It uses eval."
  const root = resolve(repoDir)
  for (const raw of c.split(/[\s;&|<>()=,]+/)) {
    const t = raw.replace(/^["'`]+|["'`]+$/g, "")
    if (!t) continue
    const pathy = t.startsWith("/") || t.startsWith("~") || t.startsWith("$HOME") || t === ".." || t.startsWith("../") || t.includes("/../") || t.endsWith("/..")
    if (!pathy) continue
    if (SYSTEM_BINS.test(t)) continue
    const abs = resolve(root, t)
    if (t.startsWith("~") || t.startsWith("$HOME") || !(abs === root || abs.startsWith(root + sep))) return `It touches ${t}, which is outside the repo.`
  }
  return null
}

export type HelpInput =
  | { kind: "no-commands"; name: string; repoDir: string }
  | { kind: "verify-failed"; name: string; repoDir: string; command: string; output: string }
  | { kind: "check"; name: string; detail: string }
export type ClaudeFn = (o: { project: string; kind: string; model: string; prompt: string; cwd: string; args: string[]; stallMs: number }) => Promise<{ ok: boolean; text: string; reason?: string }>
export type HelpResult = { ok: boolean; message: string; model: "haiku" | "sonnet"; suggestion?: Suggestion; refused: { field: string; reason: string }[] }

const tail = (s: string, n = 50) => s.trim().split("\n").slice(-n).join("\n")
/** What Claude is told about the problem. Output is redacted first; nothing else from a request reaches it. */
export function helpPrompt(i: HelpInput, env: { os: string; shell: string } = { os: osPlatform(), shell: shellName() }): string {
  const where = `Operating system: ${env.os}. Shell: ${env.shell}.`
  const problem = i.kind === "check"
    ? `A machine check failed in Dobby setup.\nCheck: ${i.name}\nResult: ${redact(i.detail).slice(0, 400)}\n${where}\nAnswer with cause and fix only. The fix is a plain sentence that may hold one command.`
    : i.kind === "no-commands"
      ? `Dobby setup found no install or test command for the repo "${i.name}" (your working folder). Read its README, package manifest, Makefile and CI config, then give the install and test commands.\n${where}`
      : `The repo "${i.name}" (your working folder) failed to verify in Dobby setup.\nCommand: ${redact(i.command)}\nLast 50 lines of its output, secrets removed:\n${redact(tail(i.output))}\n${where}\nGive the cause, a fix, and corrected install and test commands if they are the problem.`
  return `${skillText()}\n\n---\nYou are being called from Dobby's setup, not from a terminal. You cannot run commands here. Reply with one JSON object only: {"install"?: string, "test"?: string, "cause"?: string, "fix"?: string}. Commands run in the repo's folder, one line each.\n\n${problem}`
}

/** Haiku, or Sonnet when the person clicks for it. Never retried on a bigger model by itself: an unreadable answer is NO_ANSWER. */
export async function askHelp(db: DB, i: HelpInput, o: { claude?: ClaudeFn; model?: "haiku" | "sonnet"; env?: { os: string; shell: string } } = {}): Promise<HelpResult> {
  const call: ClaudeFn = o.claude ?? (async (x) => (await import("./lib.ts")).claude(db, x))
  const repo = i.kind === "check" ? null : i.repoDir
  const prompt = helpPrompt(i, o.env)
  const args = repo ? ["--setting-sources", "project", "--allowedTools", "Read,Glob,Grep", "--disallowedTools", "Edit,Write,Bash,WebFetch,WebSearch"] : ["--setting-sources", "project", "--disallowedTools", "Read,Glob,Grep,Edit,Write,Bash,WebFetch,WebSearch"]
  const run = (model: "haiku" | "sonnet") => call({ project: "dobby", kind: "setup-help", model, prompt, cwd: repo ?? tmpdir(), args, stallMs: 180_000 }).catch((e: Error) => ({ ok: false, text: "", reason: e.message }))
  const model = o.model ?? "haiku"
  const r = await run(model)
  const s = r.ok ? parseSuggestion(r.text) : null
  const refused: HelpResult["refused"] = []
  if (s && repo) for (const f of ["install", "test"] as const) { const why = s[f] ? unsafeReason(s[f]!, repo) : null; if (why) { refused.push({ field: f, reason: why }); delete s[f] } }
  if (s && !repo) { delete s.install; delete s.test }
  const ok = !!s && Object.keys(s).length > 0
  record(db, "setup_help", { kind: i.kind, ok })
  return { ok, message: ok ? "" : NO_ANSWER, model, ...(ok ? { suggestion: s! } : {}), refused }
}

/** Claude can be asked only when it is installed and signed in (or an API key is set): the reason otherwise. */
export function helpAvailable(rows: Check[] | null): { ok: boolean; reason: string | null } {
  if (!rows) return { ok: false, reason: "Check this machine first." }
  const bad = rows.find((r) => (r.name === "Claude Code" || r.name === "Claude sign-in" || r.name === "API key") && !r.ok)
  return bad ? { ok: false, reason: `Claude is not available: ${bad.name} ${bad.detail}.` } : { ok: true, reason: null }
}

/** `dobby add skill`: asks first (`yes` skips the question); nothing outside ~/.claude/skills/dobby-setup is touched. */
export async function addSkill(o: { yes?: boolean; home?: string; confirm?: (message: string) => Promise<boolean> } = {}): Promise<string> {
  const home = o.home ?? homedir(), dest = `${home}/.claude/skills/dobby-setup`
  const message = `Copy the dobby-setup skill to ${dest.replace(home, "~")}? A folder there with that name is replaced.`
  if (!o.yes && !(await (o.confirm ?? (async () => false))(message))) return "Not copied. Run dobby add skill --yes to copy it without asking."
  return `Copied to ${installSkill(home).replace(home, "~")}. In Claude Code, ask it to fix your Dobby setup; it may run commands, but only after showing them and getting a yes.`
}

/** the copy itself: copies the shipped skill into ~/.claude/skills/dobby-setup. Only that folder is replaced. */
export function installSkill(home = homedir(), src = SKILL_DIR): string {
  const dest = `${home}/.claude/skills/dobby-setup`
  rmSync(dest, { recursive: true, force: true }) // Dobby's own folder; a link here is removed, not followed
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true })
  return dest
}

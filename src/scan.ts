// Pre-PR scan of the branch diff, before the Tester (no model tokens). Pure: scanDiff(diff) reads added lines only.
// hits  = likely secrets, reported as file:line + rule name. The matched text is never kept, so it can't be printed.
// deps  = package names and versions added or changed in package.json / lockfiles (just surfaced, never a fail).
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

export type Hit = { file: string; line: number; rule: string }

// First rule that matches a line wins (anthropic before openai, which it also fits).
export const RULES: [string, RegExp][] = [
  ["private-key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ["aws-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["stripe-key", /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}|\bgithub_pat_[A-Za-z0-9_]{22,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["discord-bot-token", /\b[MNO][A-Za-z0-9_-]{23,25}\.[\w-]{6}\.[\w-]{27,}/],
  ["telegram-bot-token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["huggingface-token", /\bhf_[A-Za-z0-9]{30,}/],
  ["discord-webhook", /discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+/],
  ["url-credentials", /https?:\/\/[^/\s:@]+:[^/\s@]+@/],
  ["bearer-token", /Authorization:\s*Bearer\s+[A-Za-z0-9._~+\/=-]{20,}/i],
]
const ENV_FILE = /(^|\/)\.env(\.(?!example|sample|template)[\w.-]+)?$/
const LOCK = /(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json)$/
const MANIFEST = /(^|\/)package\.json$/

type Added = { file: string; line: number; text: string; ctx: string; isNew: boolean }

/** Added lines with their new-side line numbers. `ctx` = the last context-or-added line before, to pair lockfile name/version lines. */
function* addedLines(diff: string): Generator<Added> {
  let file = "", isNew = false, hunk = false, n = 0, ctx = ""
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git ")) { hunk = false; file = ""; isNew = false; continue }
    if (!hunk && l.startsWith("--- ")) { isNew = l === "--- /dev/null"; continue }
    if (!hunk && l.startsWith("+++ ")) { file = l.slice(4).replace(/^b\//, ""); continue }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l)
    if (h) { hunk = true; n = Number(h[1]); ctx = ""; continue }
    if (!hunk || !file || file === "/dev/null") continue
    if (l.startsWith("+")) { yield { file, line: n++, text: l.slice(1), ctx, isNew }; ctx = l.slice(1) }
    else if (l.startsWith(" ")) { n++; ctx = l.slice(1) }
  }
}

const VERSION = /^(?:[\^~<>=*]|\d|git|file:|npm:|workspace:|https?:|github:)/

export function scanDiff(diff: string): { hits: Hit[]; deps: string[] } {
  const hits: Hit[] = []
  const deps = new Set<string>()
  const envSeen = new Set<string>()
  for (const a of addedLines(diff)) {
    const lock = LOCK.test(a.file)
    if (ENV_FILE.test(a.file) && a.isNew && !envSeen.has(a.file)) { envSeen.add(a.file); hits.push({ file: a.file, line: a.line, rule: "env-file" }) }
    if (!lock) { // lockfile integrity hashes look like tokens
      const rule = RULES.find(([, re]) => re.test(a.text))
      if (rule) hits.push({ file: a.file, line: a.line, rule: rule[0] })
    }
    let m: RegExpExecArray | null
    if (MANIFEST.test(a.file) && (m = /^\s*"(@?[\w./-]+)":\s*"([^"]+)",?\s*$/.exec(a.text)) && !["name", "version"].includes(m[1]) && VERSION.test(m[2])) deps.add(`${m[1]}@${m[2]}`)
    else if (lock) {
      // package-lock: "node_modules/x": { ... "version": "1.2.3" }   bun.lock: "x": ["x@1.2.3", ...   yarn: x@^1: + version "1.2.3"   pnpm: x@1.2.3:
      if ((m = /^\s*"version":\s*"([^"]+)"/.exec(a.text))) { const n = /"(?:[^"]*node_modules\/)?([^"]+)":\s*\{\s*$/.exec(a.ctx); if (n) deps.add(`${n[1]}@${m[1]}`) }
      else if ((m = /^\s*"[^"]+":\s*\["(@?[^"@]+)@([^"]+)"/.exec(a.text))) deps.add(`${m[1]}@${m[2]}`)
      else if ((m = /^\s*version:?\s+"?([^"\s]+)"?\s*$/.exec(a.text))) { const n = /^"?(@?[^@\s"]+)@/.exec(a.ctx); if (n) deps.add(`${n[1]}@${m[1]}`) }
      else if ((m = /^\s*'?\/?(@?[^@\s'/:]+(?:\/[^@\s'/:]+)?)@(\d[^\s':()]*)'?:\s*$/.exec(a.text))) deps.add(`${m[1]}@${m[2]}`)
    }
  }
  return { hits, deps: [...deps].sort() }
}

/** Added lines per file, placed at their real line numbers, so a scanner's line numbers match the file in the branch. */
export function addedFiles(diff: string): Map<string, string[]> {
  const files = new Map<string, string[]>()
  for (const a of addedLines(diff)) {
    if (LOCK.test(a.file)) continue
    const lines = files.get(a.file) ?? []
    while (lines.length < a.line - 1) lines.push("")
    lines[a.line - 1] = a.text
    files.set(a.file, lines)
  }
  return files
}

/** gitleaks over the added lines, when it is installed (null = not installed or it failed: use the regexes). Only file, line and rule are read. */
export function gitleaksHits(diff: string): Hit[] | null {
  if (spawnSync("which", ["gitleaks"]).status !== 0) return null
  const dir = mkdtempSync(join(tmpdir(), "dobby-scan-"))
  try {
    for (const [f, lines] of addedFiles(diff)) {
      mkdirSync(join(dir, "src", dirname(f)), { recursive: true })
      writeFileSync(join(dir, "src", f), lines.join("\n") + "\n")
    }
    const report = join(dir, "report.json")
    const r = spawnSync("gitleaks", ["detect", "--no-git", "--no-banner", "--source", join(dir, "src"), "--report-format", "json", "--report-path", report], { encoding: "utf8" })
    if (r.status === 0) return []
    if (r.status !== 1) return null
    const found = JSON.parse(readFileSync(report, "utf8")) as { File: string; StartLine: number; RuleID: string }[]
    return found.map((x) => ({ file: x.File.slice(join(dir, "src").length + 1), line: x.StartLine, rule: x.RuleID }))
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true }) // the report holds the matches
  }
}

/** Regex hits, plus gitleaks' when installed; one entry per file:line:rule. */
export function scanBranch(diff: string): { hits: Hit[]; deps: string[]; tool: string } {
  const { hits, deps } = scanDiff(diff)
  const gl = gitleaksHits(diff)
  const all = [...hits, ...(gl ?? [])]
  const seen = new Set<string>()
  return { hits: all.filter((h) => { const k = `${h.file}:${h.line}:${h.rule}`; return !seen.has(k) && seen.add(k) }), deps, tool: gl ? "gitleaks+regex" : "regex" }
}

export const hitLines = (hits: Hit[]) => hits.map((h) => `${h.file}:${h.line} (${h.rule})`).join("\n")

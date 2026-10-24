#!/usr/bin/env node
// Public repo cut (#198): copy the generic files of this checkout's HEAD commit (never uncommitted edits) into a new folder, leave the owner's files out, scan the copy for private
// words, and make one fresh commit there (no history) only when the scan is clean. Never pushes: the owner reads the copy, approves,
// then creates the public repo from it.
//   node bin/public-cut.mjs <out-dir> [--commit]
// Private words: built-in patterns (home folders, personal email addresses), the private config's GitHub owner, accounts, client names and
// Discord app names, and any extra lines in ~/.config/dobby/private-terms.txt (one word or phrase per line; that file never leaves the machine).
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

/** The owner's own files: project drafts, company notes, working notes, audits, app assets, one-off scripts for the owner's install. */
export const EXCLUDE = [
  /^projects\//, /^projects\.json$/, /^company\.md$/, /^roles\/company\.md$/, /^NOTES\.md$/, /^assets\//,
  /^docs\/(audits|research)\//, /^docs\/(hosting-inventory|team|[\w-]+-demos-plan)\.md$/, /^docs\/skill-scout-[\w-]+\.md$/, /^docs\/actions-paused-[\w-]+\.txt$/,
  /^bin\/(unblock-demos|migrate-to-dobby)\.sh$/,
  /^agent-kit\/skills\/security-audit\//, // upstream source and license not recorded
]
export const kept = (files) => files.filter((f) => !EXCLUDE.some((x) => x.test(f)))

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** The scan's patterns: built-in ones plus the owner's words (whole words, any case). Words under 3 letters are skipped: they match everywhere. */
export function patterns(words) {
  const own = [...new Set(words.map((w) => String(w).trim()).filter((w) => w.length >= 3))]
  return [
    { name: "home folder", re: /\/(Users|home)\/(?!runner\b|user\b|me\b|you\b)[a-z][\w.-]*/i },
    { name: "personal email", re: /[\w.+-]+@(gmail|googlemail|yahoo|outlook|hotmail|icloud|proton(mail)?)\.[a-z]+/i },
    ...own.map((w) => ({ name: w, re: new RegExp(`(^|[^A-Za-z0-9])${esc(w)}($|[^A-Za-z0-9])`, "i") })),
  ]
}

/** The owner's words from the private config and the private terms file. */
export function ownerWords(home = homedir()) {
  const words = []
  try {
    const c = JSON.parse(readFileSync(`${home}/.config/dobby/config.json`, "utf8"))
    words.push(c.github?.owner, ...(c.github?.accounts ?? []), ...(c.clientNames ?? []), ...Object.keys(c.discord?.apps ?? {}))
  } catch {}
  try { words.push(...readFileSync(`${home}/.config/dobby/private-terms.txt`, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"))) } catch {}
  // public anyway: the product's own name (a project of its own) and the account that hosts the public repo (package.json repository)
  const host = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).repository?.url?.match(/github\.com\/([^/]+)\//)?.[1] ?? ""
  return words.filter((w) => w && !/^(dobby|foreman)$/i.test(String(w).trim()) && String(w).trim().toLowerCase() !== host.toLowerCase())
}

/** Every hit as "file:line: word". Binary files (a NUL in the first 8 KB) are skipped. */
export function scan(dir, files, pats) {
  const hits = []
  for (const f of files) {
    const buf = readFileSync(join(dir, f))
    if (buf.subarray(0, 8192).includes(0)) continue
    buf.toString("utf8").split("\n").forEach((line, i) => { for (const p of pats) if (p.re.test(line)) hits.push(`${f}:${i + 1}: ${p.name}`) })
  }
  return hits
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = process.argv[2]
  if (!out || out.startsWith("--")) { console.error("usage: node bin/public-cut.mjs <out-dir> [--commit]"); process.exit(2) }
  if (existsSync(out) && readdirSync(out).length) { console.error(`${out} is not empty`); process.exit(2) }
  const tracked = spawnSync("git", ["-C", ROOT, "ls-tree", "-r", "--name-only", "HEAD"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean)
  const files = kept(tracked)
  mkdirSync(out, { recursive: true })
  const tar = spawnSync("sh", ["-c", 'r="$1"; o="$2"; shift 2; git -C "$r" archive HEAD -- "$@" | tar -x -C "$o"', "sh", ROOT, out, ...files], { stdio: "inherit" })
  if (tar.status !== 0) { console.error("git archive failed"); process.exit(1) }
  const words = ownerWords()
  const hits = scan(out, files, patterns(words))
  console.log(`copied ${files.length} of ${tracked.length} files to ${out} (${tracked.length - files.length} left out); scanned for ${words.length} private words + home folders and emails`)
  if (hits.length) {
    const byFile = {}
    for (const h of hits) { const f = h.split(":")[0]; (byFile[f] ??= []).push(h) }
    for (const [f, hs] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length)) console.log(`${String(hs.length).padStart(4)} ${f}  (${[...new Set(hs.map((h) => h.split(": ").pop()))].join(", ")})`)
    console.log(`${hits.length} private hits in ${Object.keys(byFile).length} files: not committed. Clean them in the source, then cut again.`)
    process.exit(1)
  }
  if (process.argv.includes("--commit")) {
    const g = (...a) => spawnSync("git", ["-C", out, ...a], { encoding: "utf8" })
    g("init", "-q", "-b", "main"); g("add", "-A"); g("commit", "-q", "-m", "Dobby: first public release")
    console.log(`clean: one commit in ${out}. Read it, then create the public repo from it.`)
  } else console.log("clean. Add --commit to make the first commit.")
}

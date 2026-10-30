// Owner messaging helpers (Telegram was removed 20 Oct, owner: only Discord is used; the file keeps its name).
// Secrets live in ~/.config/dobby/secrets.env, never in git or logs.
// Nothing here throws: Discord not set up or down means the message goes to outbox.log for the next brief.
import { paused } from "./pause.ts"
import { randomBytes } from "node:crypto"
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { DATA } from "./db.ts"
import { RULES as SECRET_RULES } from "./scan.ts"
import { configDir, quietAt } from "./config.ts"
import { outboundPrivate } from "./privacy.ts"
import type { Event } from "./chat/common.ts"

// DOBBY_SECRETS: tests point this at a temp file
export const secretsFile = () => process.env.DOBBY_SECRETS ?? `${configDir()}/secrets.env`

export function readSecrets(text = existsSync(secretsFile()) ? readFileSync(secretsFile(), "utf8") : ""): Record<string, string> {
  // FOREMAN_* keys from before the rename read as DOBBY_*
  // shell-style lines: `export` allowed, digits in names, "double" or 'single' quotes around the value
  return Object.fromEntries(text.split("\n").map((l) => l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)).filter((m) => m !== null).map((m) => [m[1].replace(/^FOREMAN_/, "DOBBY_"), m[2].replace(/^(["'])(.*)\1$/, "$2")]))
}

/** The dashboard token from the secrets file; first call generates one (32 random bytes, base64url) and appends it. Never printed or logged. Never overwrites an existing one. */
export function ensureToken(path = secretsFile()): string {
  const text = existsSync(path) ? readFileSync(path, "utf8") : ""
  const have = readSecrets(text).DASHBOARD_TOKEN
  if (have) return have
  const token = randomBytes(32).toString("base64url")
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  appendFileSync(path, `${text && !text.endsWith("\n") ? "\n" : ""}DASHBOARD_TOKEN=${token}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return token
}

/** Write NAME=value into the secrets file (mode 0600), replacing an old line for NAME. The value is never printed, logged or returned. */
export function setSecret(name: string, value: string, path = secretsFile()): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !value || /[\r\n"]/.test(value)) throw new Error(`cannot store ${name}`)
  const text = existsSync(path) ? readFileSync(path, "utf8") : ""
  const kept = text.split("\n").filter((l) => !new RegExp(`^\\s*(FOREMAN_${name.replace(/^DOBBY_/, "")}|${name})\\s*=`).test(l)).join("\n").replace(/\n*$/, "")
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${kept ? `${kept}\n` : ""}${name}=${value}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

/** Values to mask: the secrets file plus env vars named *KEY/TOKEN/SECRET/PASSWORD/PAT (8+ chars), for keys that live only in the environment. Values only, never names. */
export const secretValues = () => [...Object.values(readSecrets()), ...Object.entries(process.env).filter(([k]) => /(KEY|TOKEN|SECRET|PASSWORD|PAT)$/i.test(k)).map(([, v]) => v ?? "")].filter((v) => v.length >= 8)

/**
 * Text Dobby posts (Discord, outbox.log, PR comments and reviews) with secrets masked: the pre-PR scan's patterns
 * (src/scan.ts) plus the exact value of every key in the secrets file (8+ chars). Returns only the masked text; nothing is logged.
 */
export function redact(text: string, values = secretValues()): string {
  let out = text
  for (const v of values) out = out.split(v).join("[redacted]")
  for (const [, re] of SECRET_RULES) out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), "[redacted]")
  return out
}

/** A redacted copy (0600, under the data dir) of a file gh would read and publish; unreadable or `-` (stdin: runAsync redacts it) = as given. ponytail: copies are not cleaned up, they hold only redacted text. */
function redactedFile(path: string, values: string[]): string {
  try {
    const dir = `${DATA}/redacted`
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const out = `${dir}/${randomBytes(8).toString("hex")}`
    writeFileSync(out, redact(readFileSync(path, "utf8"), values), { mode: 0o600 })
    return out
  } catch { return path }
}

/**
 * Arguments for a command that may publish them: every gh argument (titles, bodies, comments, -f fields) is redacted at the
 * one place gh is spawned, so a new call site cannot forget it (#167). Files gh reads for us (--body-file/-F, -F key=@file,
 * --input) are swapped for redacted copies. Other commands are left as they are.
 */
export function outbound(cmd: string, args: string[], cwd?: string): string[] {
  if (cmd !== "gh") return args
  const values = secretValues()
  const file = (p: string) => (p === "-" ? p : redactedFile(p, values))
  return outboundPrivate(args.map((a, i) => {
    const prev = args[i - 1] ?? ""
    const eq = a.match(/^(--body-file|--input)=(.*)$/s)
    if (eq) return `${eq[1]}=${file(eq[2])}`
    if (/^(--body-file|--input|-F|--field)$/.test(prev)) {
      const kv = prev === "-F" || prev === "--field" ? a.match(/^([^=]+=)@(.*)$/s) : null
      if (kv) return `${kv[1]}@${file(kv[2])}`
      if (prev !== "--field" && !(prev === "-F" && a.includes("="))) return file(a)
    }
    return redact(a, values)
  }), cwd)
}

/** Quiet hours (config quietHours, default 23:00-08:00): still sent at once, but silent. */
export const silentAt = (hour: number) => quietAt(hour)

/** Tap buttons under a message; each sends its data back as if typed ("approve 214"). With url it is a link button instead (data unused). */
export type Buttons = { text: string; data: string; url?: string }[]

/** Cut at a word boundary with an ellipsis, never mid-word. */
export function clip(s: string, max: number) {
  const t = s.replace(/\s+/g, " ").trim()
  return t.length <= max ? t : `${t.slice(0, t.lastIndexOf(" ", max - 1) > max / 2 ? t.lastIndexOf(" ", max - 1) : max - 1)}…`
}

/** A ticket title for a phone: the part before the first ":" or "(", without file paths. */
export function shortTitle(title: string) {
  const head = title.split(/:\s|\s\(/)[0]
  // drop paths ("apps/web/x.tsx") but keep a PR number ("acme/shop#32" -> "#32")
  const P = "(?:in|on|of|at|to|for|from|into|with|by)"
  let t = head.replace(/[\w.@-]*\/[\w./@-]*?(#\d+)?(?::\d+)?(?=[\s,;)]|\.(?:\s|$)|$)/g, (_m, n) => n ?? "§").replace(/\b[\w-]+\.(?:tsx?|jsx?|json|md|css|sql|py):\d+/g, "§")
  // a stripped path must not leave "update in" or "in , and": drop a preposition that pointed at it, and the list words around it
  const had = t.includes("§")
  t = t.replace(new RegExp(`\\s+${P}\\s+§(?:\\s*[,;]\\s*§|\\s+(?:and|or)\\s+§)*`, "gi"), "").replace(/§(?:\s*[,;]\s*|\s+(?:and|or)\s+)?/g, "").replace(/\s+([,;)])/g, "$1").replace(/\s{2,}/g, " ").trim()
  const tidy = had ? t.replace(new RegExp(`\\s+(?:${P.slice(3, -1)}|and|or|the|a|an)$`, "i"), "").replace(/[\s,;]+$/, "") : t
  return clip(tidy, 80) // a path-only title comes back empty on purpose: titleOf falls back to "Ticket #N"
}

// What each button does, in plain words (the 3rd line of every #needs-you card; also the fallback when Haiku fails).
const MEANING: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^approve\b/i, () => "merges it"], [/^decline\b/i, () => "drops it"], [/^cancel\b/i, () => "stops the build and closes its PR"], [/^send\b/i, () => "sends exactly this draft (or runs exactly this action)"], [/^discard\b/i, () => "throws the draft away"],
  [/^keepgoing (\d+)/i, (m) => `builders keep going up to ${m[1]}% of this 5-hour window`], [/^deploynow \S+ migrate/i, () => "runs the migration on production, then deploys"],
  [/^deploynow\b/i, () => "tries the deploy again"], [/^reviewfix\b/i, () => "an Engineer fixes the findings on that PR (nothing merges)"],
  [/^reviewaccept\b/i, () => "marks the review passed anyway"], [/^scoutmerge\b/i, () => "merges this Scout change (agents' prompts or rules)"], [/^scoutreject\b/i, () => "closes this Scout change"], [/^queue\b/i, () => "queues it for an Engineer"],
  [/^stuckretry\b/i, () => "throws away the branch and builds it again from the start"], [/^stuckdecline\b/i, () => "drops the ticket and closes its PR"],
]
export const buttonsText = (buttons: Buttons = []) =>
  buttons.map((b) => `${b.text.replace(/^\W+\s*/, "")} = ${b.url ? "opens the page" : (MEANING.map(([re, f]) => b.data.match(re) && f(b.data.match(re)!)).find(Boolean) ?? b.data)}`).join(" · ")

/**
 * Every #needs-you card opens with 3 plain lines (owner, 17 Oct): what happened, why it needs you, what each button does.
 * Haiku, text-only (API credits when the router says so). Unreadable or failed = just the buttons line. Also logs the owner touch.
 */
export async function needsYou(text: string, buttons: Buttons = [], o: { db?: import("./db.ts").DB; ask?: typeof import("./lib.ts").claude; touch?: boolean } = {}): Promise<string> {
  const { claude } = await import("./lib.ts")
  const { tagFor, touch } = await import("./usage.ts")
  const db = o.db ?? (await import("./chat/platform.ts")).chatOn() ?? (await import("./db.ts")).open()
  if (o.touch !== false) touch(db, { kind: "needs-you", tag: tagFor(buttons.find((b) => !b.url)?.data ?? ""), note: text.split("\n")[0].slice(0, 100) })
  const meaning = buttonsText(buttons)
  const r = await (o.ask ?? claude)(db, {
    project: "dobby", kind: "card-summary", model: "haiku", args: ["--setting-sources", "project", "--tools", ""],
    prompt: `Write the top of a card in the owner's #needs-you channel. The owner is busy, reads it on the phone. Exactly 3 lines, plain words, no markdown, no file paths, no code names, under 60 words in total:
What happened: <one sentence>
Why it needs you: <one sentence: what only the owner can decide or fix here>
Buttons: <each button as "label = what it does", from the meanings below; "none, just read it" when there are none>
Never write money amounts, balances or finance data.

CARD:
${text}

BUTTONS (label = what it does): ${meaning || "none"}`,
  }).catch(() => ({ ok: false, text: "" }))
  const lines = r.text.trim().split("\n").map((l) => l.trim()).filter(Boolean)
  const ok = r.ok && lines.length === 3 && /^What happened/i.test(lines[0]) && /^Why it needs you/i.test(lines[1]) && /^Buttons/i.test(lines[2])
  const top = ok ? lines.join("\n") : meaning ? `Buttons: ${meaning}` : ""
  return top ? `${top}\n\n${text}` : text
}
/** For a card that already has its summary (or tests): leave the text as it is. */
export const asIs = async (text: string) => text

/** One outbox.log line, redacted whole (error text included). */
const outbox = (line: string) => appendFileSync(`${DATA}/outbox.log`, `${new Date().toISOString()} ${redact(line)}\n`)

/** To the owner on Discord (`to` picks channel and voice; default #needs-you); outbox.log when Discord is not set up. #needs-you cards get their 3-line summary first. */
export async function notify(text: string, fetcher: typeof fetch = fetch, buttons?: Buttons, to?: Event, card: (text: string, buttons?: Buttons) => Promise<string> = needsYou): Promise<boolean> {
  const { chatOn: discordOn, route, platform } = await import("./chat/platform.ts")
  const { post, postBrief, prCard } = await platform()
  text = redact(text)
  // a #needs-you card that names a PR is that PR's one card, keyed by the PR and its state (the first line, before the summary)
  const pr = route(to ?? { kind: "approval" }).channel === "needs-you" ? text.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/) : null
  const key = (to as { key?: string } | undefined)?.key ?? (pr ? `pr:${pr[1]}#${pr[2]}` : "")
  const head = text.split("\n")[0]
  if (route(to ?? { kind: "approval" }).channel === "needs-you") text = await card(text, buttons)
  const db = discordOn()
  // notify paused: everything except #needs-you waits in the outbox (never dropped); #needs-you always goes out
  const held = db && route(to ?? { kind: "approval" }).channel !== "needs-you" ? paused(db, { kind: "notify" }) : null
  if (held) {
    outbox(`[notify paused] ${text}`)
    return false
  }
  if (db) {
    try {
      if (key) await prCard(db, key, head, to ?? { kind: "approval" }, text, buttons, fetcher)
      else if (to?.kind === "brief" && to.rich) await postBrief(db, to.rich, fetcher)
      else await post(db, to ?? { kind: "approval" }, text, buttons, fetcher)
      return true
    } catch (e) {
      outbox(`[${(e as Error).message}] ${text}`)
      return false
    }
  }
  outbox(`[discord not set up] ${text}`)
  // terminal-only: the tick child of `dobby start` shares the terminal, so what needs the owner shows there too (a job's log otherwise)
  if (route(to ?? { kind: "approval" }).channel === "needs-you") console.log(`\n── needs you ──\n${text}\n(dobby approve <id> | dobby decline <id>; dobby status lists them)\n`)
  return false
}

/**
 * Read a reply as an approve/decline. "approve 214", "dobby decline 12", or a bare "approved"/"yes"/"no"
 * sent as a reply to a Dobby message that names "#<id>". Anything else is ignored (null).
 */
export function parseReply(text: string, replyTo = ""): { decision: "approve" | "decline"; id: number } | null {
  const t = text.trim().toLowerCase()
  const word = t.match(/^(?:(?:dobby|foreman)\s+)?(approve|approved|yes|ok|ship|decline|declined|cancel|no|skip)\b/)?.[1]
  if (!word) return null
  const decision = /^(decline|declined|cancel|no|skip)$/.test(word) ? "decline" : "approve"
  const id = Number(t.match(/#?(\d+)/)?.[1] ?? replyTo.match(/#(\d+)/)?.[1])
  return id ? { decision, id } : null
}

// Short memory for the front desk: the last 10 messages of the past 2 hours, so follow-ups make sense.
// ponytail: kv JSON blob, fine for one owner; a table if this ever serves more chats.
const HISTORY_MS = 2 * 3600_000
export function recent(raw: string | undefined, now = Date.now()) {
  const all = (raw ? JSON.parse(raw) : []) as { at: number; who: "you" | "foreman"; text: string }[]
  return all.filter((m) => now - m.at < HISTORY_MS).slice(-10)
}

/** Posts that could not go out (outbox.log), oldest first; reading empties the file. A post can span lines: each entry starts with its ISO time. */
export function takeOutbox(file = `${DATA}/outbox.log`) {
  if (!existsSync(file)) return []
  const raw = readFileSync(file, "utf8")
  writeFileSync(file, "")
  return raw.split(/\n(?=\d{4}-\d\d-\d\dT[\d:.]+Z \[)/).map((e) => e.trim().match(/^(\S+) \[([^\]]*)\] ([\s\S]*)$/)).filter((m): m is RegExpMatchArray => m !== null && !m[3].startsWith("Test: ")).map((m) => ({ at: m[1], why: m[2], text: m[3] }))
}

/** "What got merged today", once a day at the first tick after 19:00, to #daily-update: counts per app and the 3 biggest changes, one line each. Pure part tested. */
export function digest(rows: { id: number; project: string; title: string; note: string | null }[], plain: (id: number) => string | undefined, fixes = 0) {
  const rework = fixes ? `\n🔁 ${fixes} review fix${fixes > 1 ? "es" : ""} pushed onto open PRs (rework, not counted as shipped).` : ""
  if (!rows.length) return `🌙 Today: nothing merged.${rework}`
  const per = new Map<string, number>()
  for (const r of rows) per.set(r.project, (per.get(r.project) ?? 0) + 1)
  // ponytail: "biggest" = the ticket with the longest plain-words summary; no size is stored per ticket
  const top = (p: string) => rows.filter((r) => r.project === p).sort((a, b) => (plain(b.id)?.length ?? 0) - (plain(a.id)?.length ?? 0)).slice(0, 3)
  return `🌙 Shipped today: ${[...per].map(([p, n]) => `${p} ${n}`).join(", ")}\n${[...per.keys()].map((p) => `${p}\n${top(p).map((r) => `• ${shortTitle(r.title)}`).join("\n")}`).join("\n")}\nNothing goes live on its own: say "deploy ${[...per.keys()][0]}" in #assistant when you want these live.${rework}`
}

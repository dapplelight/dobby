// Front desk: reads the owner's calendar, mail and Drive through the claude.ai connectors, never sends on its own.
// A send is a proposal: stored in kv (proposal:<id>), previewed in #needs-you with Send / Discard. Send = a separate
// Haiku run allowed only the one matching tool, told to pass the stored content verbatim.
import { spawn, spawnSync } from "node:child_process"
import type { DB } from "./db.ts"
import { claude, label, NO_SECRETS, ROOT } from "./lib.ts"
import { redact } from "./telegram.ts"
import { config } from "./config.ts"

const CAL = "mcp__claude_ai_Google_Calendar__", GMAIL = "mcp__claude_ai_Gmail__", DRIVE = "mcp__claude_ai_Google_Drive__"
export const READ_TOOLS = [
  ...["list_events", "search_events", "get_event", "list_calendars", "suggest_time"].map((t) => CAL + t),
  ...["search_threads", "get_thread", "get_message", "list_labels", "list_drafts"].map((t) => GMAIL + t),
  ...["search_files", "get_file_metadata", "read_file_content"].map((t) => DRIVE + t),
  "mcp__claude_ai_Google_Docs__read_doc",
]
// -p already refuses anything not allowed; this list makes the writes impossible even if a setting allows them.
export const WRITE_TOOLS = [
  ...["send_message", "reply", "forward", "create_draft", "update_draft", "delete_draft", "trash_message", "trash_thread", "untrash_message", "untrash_thread",
    "label_message", "label_thread", "unlabel_message", "unlabel_thread", "create_label", "update_label", "delete_label", "update_message_labels",
    "mark_message_spam", "mark_thread_spam", "unmark_message_spam", "unmark_thread_spam", "apply_sensitive_message_label", "apply_sensitive_thread_label"].map((t) => GMAIL + t),
  ...["create_event", "update_event", "delete_event", "respond_to_event"].map((t) => CAL + t),
  ...["create_file", "update_file", "share_file", "trash_file", "copy_file", "download_file_content"].map((t) => DRIVE + t),
  "mcp__claude_ai_Google_Docs__update_doc", "mcp__claude_ai_Google_Sheets", "mcp__claude_ai_Claude_Docs",
  ...config().frontDeskDenyMcp.map((s) => `mcp__${s}`), // the owner's own app connectors (money, health, orders): never from the front desk
]
// The front desk reads mail, so a mail can carry instructions (audit 20 Oct, item 4). It runs only read-only dobby commands
// plus add/idea (low risk) itself; every other dobby action is a proposal the owner taps (propose-then-tap, owner 20 Oct).
export const DESK_COMMANDS = ["list", "show", "status", "ideas", "idea", "add"]
// Denied outright as well, in case a hook answers "allow" (deny rules win whatever a hook returns).
const DESK_DENY = ["do", "queue", "approve", "decline", "run", "pause", "resume", "tick", "company", "scout", "lead", "cos", "pm", "strategize", "dedupe", "init", "onboard",
  "review", "review-scan", "touch", "api", "discord", "listen", "dashboard", "graphify", "health", "ask", "usage-sample", "usage-log", "telemetry-serve"]
export const FRONT_DESK_ARGS = ["--setting-sources", "project", "--allowedTools", ["Read", "Grep", "Glob", ...DESK_COMMANDS.map((c) => `Bash(bin/dobby ${c}:*)`), ...READ_TOOLS].join(","),
  "--disallowedTools", ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", ...NO_SECRETS, ...DESK_DENY.map((c) => `Bash(bin/dobby ${c}:*)`), ...WRITE_TOOLS].join(",")]

/**
 * Dobby actions the front desk may only propose. `do` = run through `dobby do <command>` (the button path);
 * `top` = a CLI command of its own (`dobby run <id>`, `dobby company`), started in the background.
 */
const ACTIONS: { re: RegExp; via: "do" | "top" }[] = [
  { re: /^(queue|approve|decline) \d+$/i, via: "do" },
  { re: /^deploynow [\w-]+( migrate)?$/i, via: "do" },
  { re: /^((pause|resume)( everything| all| (builders|reviews|merges|deploys|planning|scout|notify)| project [\w-]+| ticket #?\d+)?|pause status)( for \d{1,3}[mhd])?$/i, via: "do" },
  { re: /^(reviewfix|reviewaccept) [\w.-]+\/[\w.-]+ \d+$/i, via: "do" },
  { re: /^keepgoing( \d{2,3})?$/i, via: "do" },
  { re: /^undo-scout [0-9a-f]{7,40}$/i, via: "do" },
  { re: /^run \d+$/i, via: "top" },
  { re: /^company$/i, via: "top" },
]
/** Typed by the owner, still a tap: deploys, migrations and review overrides (owner, 20 Oct). */
export const typedNeedsTap = (command: string) => /^(deploynow|reviewaccept)\b|\bmigrate\b/i.test(command)
/** A command proposal's action, or undefined when it is not one the owner can tap (anything else is dropped). */
export const actionFor = (command: string) => ACTIONS.find((a) => a.re.test(command))
/** bin/dobby's arguments for an allowed action: `do <words>`, or the CLI command itself (verb lowercased). null = not allowed. */
export function actionArgs(command: string): { args: string[]; background: boolean } | null {
  const a = actionFor(command)
  if (!a) return null
  const [verb, ...rest] = command.split(" ")
  return a.via === "do" ? { args: ["do", verb, ...rest], background: false } : { args: [verb.toLowerCase(), ...rest], background: true }
}

export type Proposal = {
  kind: "email" | "reply" | "event" | "command"; to: string[]; subject: string; body: string; replyToMessageId?: string
  event?: { startTime: string; endTime: string; location?: string; timeZone?: string }
}
const EMAIL = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/

/** The model's answer split into the reply and its {"propose": ...} line. Anything malformed is no proposal. */
export function parseProposal(text: string): { reply: string; proposal: Proposal | null } {
  const r = parseProposalRaw(text)
  // a draft that would carry a secret (scan patterns or a secrets-file value) is dropped, never shown or sent
  return r.proposal && redact(JSON.stringify(r.proposal)) !== JSON.stringify(r.proposal) ? { reply: r.reply, proposal: null } : r
}
function parseProposalRaw(text: string): { reply: string; proposal: Proposal | null } {
  const lines = text.trimEnd().split("\n")
  const i = lines.findLastIndex((l) => l.trim().startsWith('{"propose"'))
  if (i < 0) return { reply: text.trim(), proposal: null }
  const reply = lines.filter((_, j) => j !== i).join("\n").trim()
  try {
    const p = JSON.parse(lines[i].trim()).propose
    if (p?.kind === "command") {
      const command = typeof p.command === "string" ? p.command.trim().replace(/\s+/g, " ") : ""
      return { reply, proposal: actionFor(command) ? { kind: "command", to: [], subject: "", body: command } : null }
    }
    const to: string[] = Array.isArray(p?.to) ? p.to.map(String) : []
    const ev = p?.event
    const ok = ["email", "reply", "event"].includes(p?.kind) && typeof p.body === "string" && to.every((e) => EMAIL.test(e))
      && (p.kind !== "email" || (to.length > 0 && !!p.subject && !!p.body.trim()))
      && (p.kind !== "reply" || (!!p.replyToMessageId && !!p.body.trim()))
      && (p.kind !== "event" || (!!p.subject && typeof ev?.startTime === "string" && typeof ev?.endTime === "string"))
    if (!ok) return { reply, proposal: null }
    return {
      reply,
      proposal: {
        kind: p.kind, to, subject: String(p.subject ?? ""), body: p.body,
        ...(p.kind === "reply" ? { replyToMessageId: String(p.replyToMessageId) } : {}),
        ...(p.kind === "event" ? { event: { startTime: ev.startTime, endTime: ev.endTime, ...(ev.location ? { location: String(ev.location) } : {}), ...(ev.timeZone ? { timeZone: String(ev.timeZone) } : {}) } } : {}),
      },
    }
  } catch {
    return { reply, proposal: null }
  }
}

type Stored = Proposal & { status: "draft" | "sending" | "sent" | "failed" | "discarded"; at: string }
const load = (db: DB, id: string) => {
  const v = (db.prepare("SELECT v FROM kv WHERE k=?").get(`proposal:${id}`) as { v: string } | undefined)?.v
  return v ? (JSON.parse(v) as Stored) : undefined
}
const save = (db: DB, id: string, p: Stored) => db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(`proposal:${id}`, JSON.stringify(p))

export function storeProposal(db: DB, p: Proposal) {
  const id = Date.now().toString(36).slice(-6)
  save(db, id, { ...p, status: "draft", at: new Date().toISOString() })
  return id
}
export const getProposal = load

/** The exact tool and arguments for a proposal: nothing is added or reworded. */
export function sendArgs(p: Proposal): { tool: string; args: Record<string, unknown> } {
  if (p.kind === "email") return { tool: `${GMAIL}send_message`, args: { to: p.to, subject: p.subject, body: p.body } }
  if (p.kind === "reply") return { tool: `${GMAIL}reply`, args: { messageId: p.replyToMessageId, body: p.body, ...(p.to.length ? { to: p.to } : {}) } }
  return {
    tool: `${CAL}create_event`,
    args: { summary: p.subject, ...p.event, ...(p.body ? { description: p.body } : {}), ...(p.to.length ? { attendees: p.to.map((email) => ({ email })) } : {}) },
  }
}

export function sendPrompt(p: Proposal) {
  const { tool, args } = sendArgs(p)
  return `Call the tool ${tool} exactly once with exactly these arguments. Copy every value verbatim: add nothing, remove nothing, fix nothing (no greeting, no signature, no reformatting).
ARGUMENTS (JSON):
${JSON.stringify(args, null, 2)}
Then answer with one line only: SENT <id from the tool result>, or FAILED <the error>.`
}

/** What a command acts on, in words: the ticket's "App · title", the PR, or the app. */
export function actionTarget(command: string, db?: DB) {
  const [verb, a, b] = command.split(" ")
  if (/^\d+$/.test(a ?? "")) return `${verb}: ${db ? label(db, Number(a)) : `ticket ${a}`}`
  if (b && /^\d+$/.test(b)) return `${verb}: pull request ${b} on ${a}`
  return a ? `${verb}: ${a}${command.includes(" migrate") ? " with its migration" : ""}` : verb
}

export function preview(id: string, p: Proposal, db?: DB) {
  if (p.kind === "command") return `⚙️ Dobby action · ${id}\n${actionTarget(p.body, db)}\nIt runs: dobby ${p.body}\nNothing happens unless you tap Do it.`
  const head = { email: "✉️ Email", reply: "↩️ Reply", event: "📅 Invite" }[p.kind]
  const body = p.body.length > 1400 ? `${p.body.slice(0, 1400)}… (${p.body.length} chars in full)` : p.body
  return `${head} draft · ${id}\n${p.to.length ? `To: ${p.to.join(", ")}\n` : ""}${p.subject ? `Subject: ${p.subject}\n` : ""}${p.event ? `When: ${p.event.startTime} → ${p.event.endTime}${p.event.location ? ` at ${p.event.location}` : ""}\n` : ""}${p.kind === "reply" ? `Replying to message ${p.replyToMessageId}\n` : ""}\n${body}`
}

export type Exec = (args: string[], background: boolean) => { ok: boolean; out: string }
/** bin/dobby with an argument array (no shell): `do <command>` and wait, or a CLI command of its own started in the background. */
export const runForeman: Exec = (args, background) => {
  if (background) {
    const c = spawn(`${ROOT}bin/dobby`, args, { detached: true, stdio: "ignore", env: process.env })
    c.on("error", () => {})
    c.unref()
    return { ok: true, out: "started in the background" }
  }
  const r = spawnSync(`${ROOT}bin/dobby`, args, { encoding: "utf8", env: process.env })
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").filter(Boolean).slice(-6).join("\n")
  return { ok: r.status === 0 && !/^Unknown:/.test(out), out: out || r.error?.message || "done" }
}

/** Owner tapped Send (Do it, for a Dobby action). One try per draft: a second tap, or a retry after a failure, does nothing. */
export async function sendProposal(db: DB, id: string, exec: Exec = runForeman): Promise<string> {
  const p = load(db, id)
  if (!p) return `No draft ${id}`
  if (p.status !== "draft") return `Draft ${id} is already ${p.status}`
  save(db, id, { ...p, status: "sending" })
  if (p.kind === "command") {
    const a = actionArgs(p.body) // checked again: only the stored, validated action runs
    const r = a ? exec(a.args, a.background) : { ok: false, out: "not an action the front desk may propose" }
    save(db, id, { ...p, status: r.ok ? "sent" : "failed" })
    return `${r.ok ? "✅ Done" : "🔴 Didn't run"} · ${id} (dobby ${p.body}): ${r.out.slice(0, 600)}`
  }
  const { tool } = sendArgs(p)
  const r = await claude(db, {
    project: "dobby", kind: "send", model: "haiku", cwd: ROOT, prompt: sendPrompt(p),
    args: ["--setting-sources", "project", "--allowedTools", tool, "--disallowedTools", ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch", ...WRITE_TOOLS.filter((t) => t !== tool), ...READ_TOOLS].join(",")],
  })
  const sent = r.ok && /^\s*SENT\b/m.test(r.text)
  save(db, id, { ...p, status: sent ? "sent" : "failed" })
  return sent ? `📤 Sent · ${id} (${p.kind} to ${p.to.join(", ") || "calendar"})` : `🔴 Not sent · ${id}: ${(r.text || r.reason || "no answer").slice(0, 300)}`
}

export function discardProposal(db: DB, id: string): string {
  const p = load(db, id)
  if (!p || p.status !== "draft") return `No open draft ${id}`
  save(db, id, { ...p, status: "discarded" })
  return `🗑 Discarded · ${id}`
}

// `dobby mcp`: the owner's Dobby as an MCP server on stdio (Signet's MCP kit over the official SDK). Five tools merged by class, docs and ticket logs as
// resources, two prompts. Nothing merges, deploys, cancels, declines or approves without a confirmed elicitation or the owner's own tap:
// dobby_decide asks first (confirm); a client that cannot be asked gets an inbox card with the existing buttons instead, never the action.
// stdout is the protocol: console.log goes to stderr while this runs.
import { noteUse } from "./stats.ts"
import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { z } from "zod"
import { confirm, createMcpServer, defineResource, definePrompt, defineTool, isConfirmPending, toolResult, type McpTool, type ToolContext } from "@nimit9/signet-server/mcp"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { open, type DB } from "./db.ts"
import { actions, decision, pausesAll, real, resumesHeld, ticketDiff, showText, type Action, type Args, type Deps, type Out } from "./actions.ts"
import { docsCommand, pages } from "./docs.ts"
import { redact } from "./notify.ts"
import { limitsNow, limitsText, statusText } from "./view.ts"
import { needsMe } from "./dashboard.ts"

const VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version

/** The command `dobby add mcp` runs, and the block for Claude Desktop's claude_desktop_config.json. */
export const claudeAddCommand = (bin: string) => ["claude", "mcp", "add", "--scope", "user", "dobby", "--", bin, "mcp"]
/** The HTTP transport command. `header` is the literal placeholder when printed; the real value only ever goes to the child process. */
export const claudeAddHttpCommand = (base: string, header = "Authorization: Bearer $DASHBOARD_TOKEN") => ["claude", "mcp", "add", "--scope", "user", "--transport", "http", "dobby", `${base.replace(/\/+$/, "")}/mcp`, "--header", header]
export const desktopConfig = (bin: string) => JSON.stringify({ mcpServers: { dobby: { command: bin, args: ["mcp"] } } }, null, 2)

export const INSTRUCTIONS = `Dobby is the owner's AI dev team on their own machine: it builds tickets into pull requests, reviews them, and waits for the owner before anything merges or goes live. These tools read and steer it.

Order of use:
1. dobby_read first. view "status" is the one-screen answer (what is building, shipped today, stuck, plan limits). "list" pages through open tickets, 10 at a time (pass nextCursor back as cursor). "show" and "cost" take a ticket id; "limits", "scoreboard", "receipt" and "pauses" take no id. Results are short; detail "full" adds more.
2. dobby_docs for how Dobby works: op "list" for the pages, "read" with a topic, "search" with a word. The same pages are also resources at dobby://docs/<topic>.
3. dobby_ticket to file work: op "add" (project, title, done_when optional) puts a ticket in the backlog. A ticket you add waits there until the owner queues it, like one that arrived by email; it never starts on its own. op "queue" with an id asks to start a ticket; for one you filed, that goes to the owner's inbox for a tap. ops "answer" and "hint" (id, text), "allow-round" (one more fix round on a PR) and "apply-finding" go to the owner's inbox with a button; nothing changes until they tap. "take-over" pauses a ticket for the owner.
4. dobby_pause to stop or resume work: op "pause" or "resume" with a target (builders, reviews, merges, deploys, planning, scout, notify, project <name>, ticket <id>, or all) and "for" like 30m or 2h. op "status" lists what is paused. Pausing all also kills the running builds, and resuming all, merges, deploys or a project releases held merges and deploys, so those ask first.
5. dobby_decide for the owner's calls: approve, decline, cancel, merge, retry (a ticket id) and deploy (a project). Every call first asks the owner a plain yes/no question in their client. If they say no, nothing happens. If the client cannot ask (a headless run), the item goes to the owner's inbox with a button and nothing is done until they tap it. Never retry a declined or inbox-sent call to get around the answer.

Full logs and diffs are resources, not tool output: dobby://ticket/<id>/log and dobby://ticket/<id>/diff.
Dobby never runs a data migration or any command on production from here. Say what the tool said; do not claim a merge or deploy happened unless the result says it did.`

const MAX_CHARS = 80_000 // ~20k tokens, under the 25k-token cap
const clipText = (t: string) => (t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS)}\n\n[clipped: ${t.length - MAX_CHARS} more characters. Use a narrower view, or the dobby://ticket/<id>/log resource.]` : t)
const safe = (t: string) => clipText(redact(t))

const Result = z.object({ ok: z.boolean(), text: z.string(), nextCursor: z.string().optional(), outcome: z.string().optional() })
const ok = (text: string, extra: { nextCursor?: string; outcome?: string; ok?: boolean } = {}) => {
  const t = safe(text)
  return toolResult({ content: [{ type: "text", text: t }], structuredContent: { ok: extra.ok ?? true, text: t, ...(extra.nextCursor ? { nextCursor: extra.nextCursor } : {}), ...(extra.outcome ? { outcome: extra.outcome } : {}) } })
}

const opsOf = (tool: string) => actions.filter((a) => a.mcp.tool === tool).map((a) => a.mcp.op)
const oneOf = <T extends string>(xs: T[]) => z.enum(xs as [T, ...T[]])
const find = (tool: string, op: string): Action => actions.find((a) => a.mcp.tool === tool && a.mcp.op === op) ?? (() => { throw new Error(`no action for ${tool} ${op}`) })()

/** defineTool's types are Signet's own zod; this wrapper keeps the handler typed from our zod and confines the cast. */
const tool = <S extends z.ZodObject>(d: { name: string; title: string; description: string; annotations: NonNullable<McpTool["annotations"]>; input: S; handler: (i: z.output<S>, c: ToolContext) => unknown }): McpTool => defineTool({ ...d, output: Result } as never)

export function tools(db: DB, deps: Deps): McpTool[] {
  const run = async (a: Action, args: Args): Promise<Out> => a.run(db, { ...args, agent: true }, deps)
  /** Ask the owner; act only on "confirmed". Anything else never acts: declined says so, unsupported posts the inbox card. */
  const ask = async (ctx: ToolContext, input: unknown, d: { sentence: string; buttons: Parameters<Deps["inbox"]>[1]; key: string }, act: () => Promise<Out>) => {
    const c = await confirm(ctx, { message: d.sentence, args: input })
    if (isConfirmPending(c)) return c
    if (c === "confirmed") { const o = await act(); return ok(o.text, { outcome: "done" }) }
    if (c === "declined") return ok("Not done: the owner said no (or the answer did not match this request). Nothing changed.", { outcome: "declined", ok: false })
    await deps.inbox(`🟡 Needs you · ${d.sentence}\nClaude asked over MCP and the client could not ask you there. Nothing is done until you tap.`, d.buttons, d.key)
    return ok("Sent to your inbox for a tap. Nothing was done yet.", { outcome: "sent_to_inbox", ok: false })
  }
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  return [
    tool({
      name: "dobby_read", title: "Dobby status and tickets",
      description: `Read Dobby's state: status, plan limits, open tickets (paged), one ticket's steps, cost, scoreboard, receipt, pauses, and (owner only, needs DOBBY_STATS_REPORT_TOKEN) the usage-stats report from the owner's Worker (view stats-report). Use for "what is Dobby doing", "what is stuck", "how much of my plan is used", "show ticket 12", "what did it cost". Read-only; short by default. List returns 10 per page with nextCursor. Full logs and diffs are the dobby://ticket/<id>/log and /diff resources.`,
      annotations: read,
      input: z.object({
        view: oneOf(opsOf("dobby_read")).describe("What to read. status = the one-screen answer; list = open tickets, 10 a page; show/cost need id; pauses = what is paused."),
        id: z.number().int().positive().optional().describe("Ticket id, for show and cost."),
        days: z.number().int().min(1).max(90).optional().describe("Days back, for scoreboard and receipt. Default 7."),
        detail: z.enum(["short", "full"]).optional().describe("short (default) or full: more steps and runs for show, size and notes for list."),
        cursor: z.string().max(12).optional().describe("nextCursor from the previous list page."),
      }),
      handler: async (i) => { const o = await run(find("dobby_read", i.view), { id: i.id, days: i.days, detail: i.detail, cursor: i.cursor }); return ok(o.text, { nextCursor: o.nextCursor }) },
    }),
    tool({
      name: "dobby_docs", title: "Dobby manual",
      description: "Read the Dobby manual: list the pages, read one by topic, or search all pages for a word (page and matching lines, at most 20). Use for \"how do I\", \"what does X mean\", setup, config, billing, security, troubleshooting. Read-only. The same pages are resources at dobby://docs/<topic>.",
      annotations: { ...read },
      input: z.object({
        op: oneOf(opsOf("dobby_docs")).describe("list, read (needs topic) or search (needs query)."),
        topic: z.string().max(60).optional().describe("Page name or a unique prefix, for read."),
        query: z.string().max(200).optional().describe("Word or phrase, for search. Case-insensitive."),
      }),
      handler: async (i) => ok((await run(find("dobby_docs", i.op), { topic: i.topic, query: i.query })).text),
    }),
    tool({
      name: "dobby_ticket", title: "File or queue a ticket",
      description: "File a ticket (add), ask to start one (queue), or steer one: answer a question it asked (answer), add a hint for the next build (hint), take it over (take-over: pauses it, the branch is yours) or give its PR one more fix round (allow-round), act on a review finding (apply-finding, dismiss-finding, rule-from-finding), or arrange the queue: unqueue (back to the backlog), reorder (id above before, or last), make-ticket and dismiss-idea (id is the idea's). Use for \"add a ticket\", \"file this for Dobby\", \"queue ticket 12\", \"tell ticket 12 to keep the old cookie\". A ticket added here is agent-filed: it waits in the backlog for the owner's tap and never starts on its own. Queueing one you filed goes to the owner's inbox. Not destructive.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      input: z.object({
        op: oneOf(opsOf("dobby_ticket")),
        project: z.string().max(60).optional().describe("Project name, for add."),
        title: z.string().max(300).optional().describe("One line: what to build. For add."),
        done_when: z.string().max(2000).optional().describe("How we know it is done. For add."),
        size: z.enum(["S", "M", "L"]).optional(),
        priority: z.number().int().min(0).max(100).optional(),
        id: z.number().int().positive().optional().describe("Ticket id, for queue, unqueue, reorder, answer, hint, take-over and allow-round; the idea id for make-ticket and dismiss-idea; the finding id for apply-finding, dismiss-finding and rule-from-finding."),
        text: z.string().max(2000).optional().describe("The owner's words, for answer and hint, or the rule text for rule-from-finding. They go into the ticket's done rule."),
        before: z.number().int().positive().optional().describe("For reorder: the queued ticket id to go above. Leave out to go last."),
      }),
      handler: async (i) => { const o = await run(find("dobby_ticket", i.op), { project: i.project, title: i.title, done_when: i.done_when, size: i.size, priority: i.priority, id: i.id, text: i.text, before: i.before }); return ok(o.text, { outcome: o.pending ? "sent_to_inbox" : undefined }) },
    }),
    tool({
      name: "dobby_pause", title: "Pause, resume or pace Dobby",
      description: "Pause or resume Dobby's work, or list what is paused. Use for \"stop the builders\", \"pause deploys for 2h\", \"resume everything\", \"what is paused\". Targets: all, builders, reviews, merges, deploys, planning, scout, notify, project <name>, ticket <id>. Running builds finish their step, except pause all, which kills them (they resume from checkpoints) and so asks the owner first. op config-set changes one setting (key, value; unset puts it back to the default) and only for pacing, scout and quiet-hours keys, such as pacing.weekCap.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      input: z.object({
        op: oneOf(opsOf("dobby_pause")),
        target: z.string().max(60).optional().describe('Default builders. For example "deploys", "project shop", "ticket 12", "all".'),
        for: z.string().max(5).optional().describe("Auto-resume after 30m, 2h or 1d. Pause only."),
        key: z.string().max(80).optional().describe("A setting, like pacing.weekCap. For config-set."),
        value: z.string().max(2000).optional().describe("The new value as JSON or plain words: 90, true, \"squash\". For config-set."),
        unset: z.boolean().optional().describe("config-set: put the setting back to its default instead."),
      }),
      handler: async (i, ctx) => {
        const go = () => run(find("dobby_pause", i.op), { target: i.target, for: i.for, key: i.key, value: i.value, unset: i.unset })
        if (resumesHeld(i.op, i.target)) { const t = i.target!.trim().toLowerCase(); return ask(ctx, i, { sentence: `Resume ${t}? Merges and deploys it was holding run now, including queued production deploys.`, buttons: [{ text: "▶️ Resume", data: `resume ${t}` }], key: `mcp:resume:${t}` }, go) }
        if (!pausesAll(i.op, i.target)) return ok((await go()).text)
        return ask(ctx, i, { sentence: "Pause everything? Nothing new starts and the running builds are killed (they pick up from their checkpoints).", buttons: [{ text: "⏸ Pause all", data: "pause all" }], key: "mcp:pause:all" }, go)
      },
    }),
    tool({
      name: "dobby_decide", title: "Approve, decline, cancel, merge or deploy",
      description: "The owner's calls: approve or decline a ticket waiting at its gate, cancel a ticket (stops the build, closes its PR), merge a waiting PR, deploy a project, retry a stuck ticket (a PR in fixing is closed and the work starts over). Use for \"merge it\", \"ship it\", \"deploy shop\", \"cancel ticket 12\". Destructive: every call first asks the owner yes or no in their client. No answer or no = nothing happens. A client that cannot ask sends it to the owner's inbox for a tap.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      input: z.object({
        op: oneOf(opsOf("dobby_decide")),
        id: z.number().int().positive().optional().describe("Ticket id. For approve, decline, cancel, merge, retry."),
        project: z.string().max(60).optional().describe("Project name. For deploy."),
      }),
      handler: async (i, ctx) => {
        const a = find("dobby_decide", i.op)
        return ask(ctx, i, decision(db, i.op, i, deps), () => run(a, { id: i.id, project: i.project }))
      },
    }),
  ]
}

export function resources(db: DB, deps: Deps) {
  const md = "text/markdown"
  const id = (v: Record<string, string>) => { const n = Number(v.id); return Number.isInteger(n) && n > 0 ? n : null }
  return [
    defineResource({
      name: "docs", title: "Dobby manual page", description: "A page of the Dobby manual.", mimeType: md, template: "dobby://docs/{topic}",
      list: () => pages().map((p) => ({ uri: `dobby://docs/${p.name}`, name: p.name, title: p.title, description: p.summary, mimeType: md })),
      read: ({ variables }) => { const r = docsCommand(variables.topic); return r.code ? null : r.out },
    }),
    defineResource({
      name: "ticket-log", title: "Ticket log", description: "Every step the ticket's graph took, with tokens and cost (the `dobby show` output).", mimeType: "text/plain", template: "dobby://ticket/{id}/log",
      read: async ({ variables }) => { const n = id(variables); return n && db.prepare("SELECT 1 FROM tickets WHERE id=?").get(n) ? safe(await showText(db, n, "full")) : null },
    }),
    defineResource({
      name: "ticket-diff", title: "Ticket diff", description: "git diff of the ticket's branch against its base, clipped at 200 KB.", mimeType: "text/x-diff", template: "dobby://ticket/{id}/diff",
      read: ({ variables }) => { const n = id(variables); return n && db.prepare("SELECT 1 FROM tickets WHERE id=?").get(n) ? redact(ticketDiff(db, n, deps)) : null },
    }),
  ]
}

export function prompts(db: DB) {
  const waiting = () => needsMe(db, Date.now())
  return [
    definePrompt({
      name: "morning_status", title: "Morning status", description: "Status, plan limits and what waits for the owner.",
      render: () => {
        const w = waiting()
        return safe(`Give me my Dobby morning status in a few plain lines: what is building, what shipped, what is stuck, how much of my plan is used, and what waits for me. Do not decide anything for me.\n\nSTATUS\n${statusText(db, Date.now(), limitsNow(db))}\n\nLIMITS\n${limitsText(limitsNow(db))}\n\nWAITS FOR ME\n${w.length ? w.map((g) => `${g.reason} (${g.items.length}): ${g.items.map((i) => `#${i.id ?? "-"} ${i.title}`).join("; ")}`).join("\n") : "Nothing."}`)
      },
    }),
    definePrompt({
      name: "triage_inbox", title: "Triage my inbox", description: "List what waits for the owner, one line each, and ask what to do with each.",
      render: () => {
        const w = waiting().flatMap((g) => g.items.map((i) => `#${i.id ?? "-"} ${i.app ?? ""} ${i.title} (${g.reason}, ${i.since}) - ${g.action}`))
        return safe(w.length ? `These wait for me. List them one line each, then ask me about each one in turn: approve, decline, cancel, queue again, or leave it. Act only on my answer, with dobby_decide or dobby_ticket (decide asks me first).\n\n${w.join("\n")}` : "Nothing waits for me in Dobby. Say so in one line.")
      },
    }),
  ]
}

/** The server for one connection. `deps` is what tests replace (merge, deploy, inbox). The confirm key is per process: one process serves every round of a flow on stdio. */
export function createDobbyServer(db: DB, deps: Deps = real, key: Uint8Array = randomBytes(32)) {
  return createMcpServer({
    name: "dobby", version: VERSION, instructions: INSTRUCTIONS,
    tools: tools(db, deps), resources: resources(db, deps), prompts: prompts(db),
    confirm: { key },
    onError: (err, meta) => console.error(`dobby mcp: ${meta.tool}: ${redact(err instanceof Error ? err.message : String(err))}`), // the client only sees "Internal error"
  })
}

/** `dobby mcp`: serve on stdio until the client closes it. console.log would corrupt the protocol: it goes to stderr. */
export async function serve(db: DB = open()) {
  console.log = console.info = console.warn = console.debug = (...a: unknown[]) => console.error(...a)
  noteUse(db, "mcp_stdio")
  const h = serveStdio(() => createDobbyServer(db))
  await new Promise<void>((r) => { process.stdin.once("end", r), process.stdin.once("close", r) })
  await h.close().catch(() => {})
}

// Discord + front desk, fully offline: a temp data dir and secrets file, fetch stubbed. Never touches the real DB or Discord.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-test-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/secrets.env`
writeFileSync(process.env.DOBBY_SECRETS, "")
const { asIs, notify } = await import("../src/telegram.ts")
const { chunks, ownerEvent, route, setKv } = await import("../src/discord.ts")
const { open } = await import("../src/db.ts")
const fd = await import("../src/frontdesk.ts")

type Call = { url: string; body: any }
const stub = (calls: Call[]) => (async (url: string, init?: RequestInit) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
  return new Response(JSON.stringify(String(url).includes("/threads") ? { id: "thread9" } : { id: "msg1", channel_id: "chan1" }))
}) as unknown as typeof fetch

test("routing: channel and voice per event", () => {
  const t = (step: any) => route({ kind: "ticket", project: "tally", ticket: 7, title: "Fix the footer (apps/web/x.tsx)", step })
  assert.deepEqual(t("picked"), { channel: "tally-tickets", as: "Engineering Manager · Tally", thread: 7, threadName: "Fix the footer · #7" })
  assert.deepEqual(t("merged"), { channel: "tally-releases", as: "Engineer · Tally" }) // the -shipped feed, not the thread
  assert.equal(route({ kind: "ticket", project: "shopfront", ticket: 8, title: "Fix review findings on ownerdev/shopfront#32", step: "building" }).threadName, "Fix review findings on #32 · #8")
  assert.deepEqual([t("building").as, t("verify").as, t("check").as, t("merged").as, t("failed").as], ["Engineer · Tally", "Engineer · Tally", "QA Engineer · Tally", "Engineer · Tally", "Engineer · Tally"])
  assert.equal(route({ kind: "ticket", project: "orbit", ticket: 1, title: "x", step: "building" }).channel, "system-status") // no channels of its own
  assert.deepEqual(route({ kind: "lead", project: "shopfront" }), { channel: "shopfront-tickets", as: "Engineering Manager · Shopfront" })
  assert.deepEqual(route({ kind: "idea", project: "shopfront" }), { channel: "shopfront-ideas", as: "Product Manager · Shopfront" })
  assert.deepEqual(route({ kind: "shipped", project: "tally" }), { channel: "tally-releases", as: "Engineer · Tally" })
  const fixed = (["approval", "stuck", "proposal", "brief", "health", "ask"] as const).map((kind) => Object.values(route({ kind })).join(" / "))
  assert.deepEqual(fixed, ["needs-you / Chief of Staff", "needs-you / Chief of Staff", "needs-you / Assistant", "daily-update / Chief of Staff", "system-status / Site Reliability", "assistant / Assistant"])
  assert.deepEqual(chunks("a\nbb\ncc", 4), ["a\nbb", "cc"]) // long posts split on lines, never cut mid-word
})

test("notify: outbox only until Discord is set up, Discord webhooks once it is", async () => {
  const calls: Call[] = []
  const said: string[] = [], log = console.log
  console.log = (t: string) => said.push(t) // terminal-only: #needs-you also prints where dobby start runs
  try {
    assert.equal(await notify("hello", stub(calls), undefined, undefined, asIs), false) // no Discord token: nothing sent
    await notify("brief", stub(calls), undefined, { kind: "brief" }, asIs)
  } finally { console.log = log }
  assert.equal(said.length, 1)
  assert.match(said[0], /needs you ──\nhello\n\(dobby approve <id>/)

  // token but setup never ran: still nothing sent
  writeFileSync(process.env.DOBBY_SECRETS!, "DISCORD_BOT_TOKEN=bot\n")
  assert.equal(await notify("hello", stub(calls), undefined, undefined, asIs), false)
  assert.equal(calls.length, 0)

  const db = open()
  for (const c of ["needs-you", "tally-tickets"]) setKv(db, `discord:wh:${c}`, `${c}-id/${c}-token`)
  setKv(db, "discord:owner", "owner1")
  calls.length = 0
  assert.equal(await notify("Needs you · tally #7", stub(calls), [{ text: "✅ Approve", data: "approve 7" }, { text: "✖️ Decline", data: "decline 7" }], { kind: "approval" }, asIs), true)
  assert.match(calls[0].url, /\/webhooks\/needs-you-id\/needs-you-token\?wait=true&with_components=true$/)
  assert.equal(calls[0].body.username, "Chief of Staff")
  assert.equal(calls[0].body.content, "<@owner1> Needs you · tally #7")
  assert.deepEqual(calls[0].body.allowed_mentions.users, ["owner1"])
  assert.deepEqual(calls[0].body.components[0].components.map((b: any) => [b.custom_id, b.style]), [["approve 7", 3], ["decline 7", 4]])

  // a ticket's first post starts its thread; the next one goes into it, and nobody is pinged in project channels
  calls.length = 0
  const e = { kind: "ticket" as const, project: "tally", ticket: 7, title: "Fix footer", step: "building" as const }
  await notify("building", stub(calls), undefined, e)
  assert.match(calls[1].url, /\/channels\/chan1\/messages\/msg1\/threads$/)
  assert.equal(calls[0].body.content, "building")
  await notify("verify ok", stub(calls), undefined, { ...e, step: "verify" })
  assert.match(calls[2].url, /thread_id=thread9$/)
})

test("gateway: only the server owner, only the right channels", () => {
  const ch = { ask: "c-ask", ideas: ["c-ideas"] }
  const press = (user: string) => ({ type: 3, id: "i1", token: "tok", member: { user: { id: user } }, data: { custom_id: "approve 7" }, message: { content: "Needs you" } })
  assert.deepEqual(ownerEvent("INTERACTION_CREATE", press("owner1"), "owner1", ch), { kind: "button", data: "approve 7", id: "i1", token: "tok", content: "Needs you", app: "" })
  assert.equal(ownerEvent("INTERACTION_CREATE", press("stranger"), "owner1", ch), null)
  const msg = (author: string, channel: string, extra = {}) => ({ author: { id: author }, channel_id: channel, content: "what's on today?", ...extra })
  assert.deepEqual(ownerEvent("MESSAGE_CREATE", msg("owner1", "c-ask"), "owner1", ch), { kind: "ask", text: "what's on today?" })
  assert.equal(ownerEvent("MESSAGE_CREATE", msg("stranger", "c-ask"), "owner1", ch), null)
  assert.equal(ownerEvent("MESSAGE_CREATE", msg("owner1", "c-tally"), "owner1", ch), null)
  assert.equal(ownerEvent("MESSAGE_CREATE", msg("owner1", "c-ask", { webhook_id: "w" }), "owner1", ch), null)
  const react = (user: string, emoji: string) => ({ user_id: user, channel_id: "c-ideas", message_id: "m5", emoji: { name: emoji } })
  assert.deepEqual(ownerEvent("MESSAGE_REACTION_ADD", react("owner1", "👎"), "owner1", ch), { kind: "react", messageId: "m5", channelId: "c-ideas", up: false })
  const chB = { ...ch, brain: (id: string) => id === "th1" }
  const say = (user: string, channel: string) => ({ author: { id: user }, channel_id: channel, content: " go " })
  assert.deepEqual(ownerEvent("MESSAGE_CREATE", say("owner1", "th1"), "owner1", chB), { kind: "brain", thread: "th1", text: "go" })
  assert.equal(ownerEvent("MESSAGE_CREATE", say("owner1", "other"), "owner1", chB), null)
  assert.equal(ownerEvent("MESSAGE_CREATE", say("stranger", "th1"), "owner1", chB), null)
  assert.equal(ownerEvent("MESSAGE_REACTION_ADD", react("bot", "👍"), "owner1", ch), null) // the bot's own seed reactions
  assert.equal(ownerEvent("MESSAGE_REACTION_ADD", react("owner1", "🎉"), "owner1", ch), null)
  assert.equal(ownerEvent("MESSAGE_CREATE", msg("owner1", "c-ask"), "", ch), null) // owner unknown: obey nobody
})

test("proposals: parsed strictly, stored as drafts, sent verbatim", () => {
  const body = "Hi Asha,\n\nThursday 4pm works. \"Quotes\" stay as they are.\n\nNimit"
  const line = JSON.stringify({ propose: { kind: "email", to: ["asha@example.com"], subject: "Thursday", body } })
  const { reply, proposal } = fd.parseProposal(`Drafted it for you.\n${line}`)
  assert.equal(reply, "Drafted it for you.")
  assert.deepEqual(proposal, { kind: "email", to: ["asha@example.com"], subject: "Thursday", body })
  assert.equal(fd.parseProposal(JSON.stringify({ propose: { kind: "email", to: ["not an email"], subject: "x", body: "y" } })).proposal, null)
  assert.equal(fd.parseProposal(JSON.stringify({ propose: { kind: "reply", to: [], body: "y" } })).proposal, null) // reply needs a message id
  assert.equal(fd.parseProposal(JSON.stringify({ propose: { kind: "delete", to: [], body: "" } })).proposal, null)
  assert.equal(fd.parseProposal("no draft here").proposal, null)

  const db = open(":memory:")
  const id = fd.storeProposal(db, proposal!)
  assert.equal(fd.getProposal(db, id)?.status, "draft")
  const prompt = fd.sendPrompt(fd.getProposal(db, id)!)
  assert.ok(prompt.includes("mcp__claude_ai_Gmail__send_message"))
  const args = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}") + 1))
  assert.deepEqual(args, { to: ["asha@example.com"], subject: "Thursday", body }) // byte for byte
  assert.ok(prompt.includes(JSON.stringify(body)))
  assert.match(fd.preview(id, proposal!), /Thursday 4pm works/)
  assert.equal(fd.discardProposal(db, id), `🗑 Discarded · ${id}`)
  assert.equal(fd.discardProposal(db, id), `No open draft ${id}`)

  const reply2 = fd.parseProposal(JSON.stringify({ propose: { kind: "reply", to: [], body: "Yes", replyToMessageId: "m1" } })).proposal!
  assert.deepEqual(fd.sendArgs(reply2), { tool: "mcp__claude_ai_Gmail__reply", args: { messageId: "m1", body: "Yes" } })
  const ev = fd.parseProposal(JSON.stringify({ propose: { kind: "event", to: ["a@b.co"], subject: "Sync", body: "", event: { startTime: "2026-10-20T10:00:00", endTime: "2026-10-20T10:30:00", extra: "dropped" } } })).proposal!
  assert.deepEqual(fd.sendArgs(ev), { tool: "mcp__claude_ai_Google_Calendar__create_event", args: { summary: "Sync", startTime: "2026-10-20T10:00:00", endTime: "2026-10-20T10:30:00", attendees: [{ email: "a@b.co" }] } })
})

test("front desk may read, never write", () => {
  const allowed = fd.FRONT_DESK_ARGS[fd.FRONT_DESK_ARGS.indexOf("--allowedTools") + 1].split(",")
  const denied = fd.FRONT_DESK_ARGS[fd.FRONT_DESK_ARGS.indexOf("--disallowedTools") + 1].split(",")
  assert.ok(allowed.includes("mcp__claude_ai_Google_Calendar__list_events") && allowed.includes("mcp__claude_ai_Google_Docs__read_doc"))
  assert.ok(!allowed.some((t) => /send|reply|create|update|delete|trash|share|label_|tally|vitals/.test(t)))
  for (const t of ["mcp__claude_ai_Gmail__send_message", "mcp__claude_ai_Google_Calendar__create_event", "mcp__tally", "mcp__vitals", "Read(~/.config/**)"]) assert.ok(denied.includes(t), t)
})

test("keyed message: first call posts with a link button, later calls edit it in place, buttons can be cleared", async () => {
  const { upsert, edit } = await import("../src/discord.ts")
  const db = open()
  setKv(db, "discord:wh:needs-you", "needs-you-id/needs-you-token")
  const calls: (Call & { method?: string })[] = []
  const f = (async (url: string, init?: RequestInit) => (calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) }), new Response(JSON.stringify({ id: "msg1", channel_id: "chan1" })))) as unknown as typeof fetch
  const buttons = [{ text: "🛠 Fix it", data: "reviewfix o/r 5" }, { text: "✅ Accept anyway", data: "reviewaccept o/r 5" }, { text: "🔗 Open PR", data: "", url: "https://github.com/o/r/pull/5" }]
  assert.equal(await upsert(db, "review:o/r#5", { kind: "approval" }, "fail 1", buttons, f), "msg1")
  assert.equal(calls[0].method, "POST")
  assert.deepEqual(calls[0].body.components[0].components.map((b: any) => [b.style, b.custom_id ?? b.url]), [[2, "reviewfix o/r 5"], [3, "reviewaccept o/r 5"], [5, "https://github.com/o/r/pull/5"]])
  await upsert(db, "review:o/r#5", { kind: "approval" }, "fail 2", buttons, f)
  assert.equal(calls.length, 2)
  assert.equal(calls[1].method, "PATCH")
  assert.match(calls[1].url, /\/webhooks\/needs-you-id\/needs-you-token\/messages\/msg1\?with_components=true$/)
  assert.equal(calls[1].body.content, "fail 2")
  await edit(db, "needs-you", "msg1", "✅ Resolved · o/r#5", undefined, f)
  assert.deepEqual(calls[2].body.components, [])
  // the message was deleted by hand: a fresh post
  const gone = (async (url: string, init?: RequestInit) => (calls.push({ url: String(url), method: init?.method, body: {} }), init?.method === "PATCH" ? new Response("{}", { status: 404 }) : new Response(JSON.stringify({ id: "msg2" })))) as unknown as typeof fetch
  assert.equal(await upsert(db, "review:o/r#5", { kind: "approval" }, "fail 3", buttons, gone), "msg2")
})

test("one card per PR: same state edits quietly, a new state replaces the card so it pings once", async () => {
  writeFileSync(process.env.DOBBY_SECRETS!, "DISCORD_BOT_TOKEN=bot\n")
  const db = open()
  setKv(db, "discord:wh:needs-you", "needs-you-id/needs-you-token")
  const calls: { url: string; method?: string }[] = []
  let n = 0
  const f = (async (url: string, init?: RequestInit) => (calls.push({ url: String(url), method: init?.method }), new Response(init?.method === "DELETE" ? null : JSON.stringify({ id: `m${++n}` }), { status: init?.method === "DELETE" ? 204 : 200 }))) as unknown as typeof fetch
  const url = "https://github.com/o/r/pull/9"
  await notify(`Review failed · o/r#9\nfirst\n${url}`, f, undefined, { kind: "approval" }, asIs)
  await notify(`Review failed · o/r#9\nsecond\n${url}`, f, undefined, { kind: "approval" }, asIs)
  await notify(`Ready to merge · o/r#9\n${url}`, f, undefined, { kind: "approval" }, asIs)
  assert.deepEqual(calls.map((c) => c.method), ["POST", "PATCH", "DELETE", "POST"])
  assert.match(calls[1].url, /\/messages\/m1\?/)
  assert.match(calls[2].url, /\/webhooks\/needs-you-id\/needs-you-token\/messages\/m1$/)
  calls.length = 0
  await notify("Needs you · tally #7", f, undefined, { kind: "approval" }, asIs) // no PR named: a plain post, as before
  await notify("Needs you · tally #7", f, undefined, { kind: "approval" }, asIs)
  assert.deepEqual(calls.map((c) => c.method), ["POST", "POST"])
})

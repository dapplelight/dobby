// Slack, fully offline: a temp data dir and secrets file, fetch stubbed, no socket. Never touches a real workspace.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-test-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/secrets.txt`
writeFileSync(process.env.DOBBY_SECRETS, "SLACK_BOT_TOKEN=xoxb-test-token-1234\nSLACK_APP_TOKEN=xapp-test-token-1234\n")
const sl = await import("../src/chat/slack.ts")
const { platform, chatOn } = await import("../src/chat/platform.ts")
const { config, setConfig } = await import("../src/config.ts")
const { setKv } = await import("../src/chat/common.ts")
const { open } = await import("../src/db.ts")

type Call = { method: string; body: any; auth: string }
const stub = (calls: Call[], fail: Record<string, string> = {}) => (async (url: URL, init: RequestInit) => {
  const method = String(url).split("/").pop()!
  calls.push({ method, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).authorization) })
  return new Response(JSON.stringify(fail[method] ? { ok: false, error: fail[method] } : { ok: true, ts: `100.${calls.length}`, channel: "C1" }))
}) as unknown as typeof fetch
const tick = () => new Promise((r) => setTimeout(r, 20))

const db = open()
setKv(db, "slack:owner", "UOWNER")
for (const c of ["needs-you", "assistant", "daily-update", "system-status", "dobby-tickets", "dobby-ideas"]) setKv(db, `slack:ch:${c}`, `C-${c}`)

test("post: the role's name and icon, Block Kit buttons, the owner pinged in #needs-you", async () => {
  const calls: Call[] = []
  const id = await sl.post(db, { kind: "approval" }, "Ticket **12** is ready", [{ text: "Approve", data: "approve 12" }, { text: "Decline", data: "decline 12" }, { text: "Open", data: "", url: "https://example.com/pr/1" }], stub(calls))
  assert.equal(id, "100.1")
  const [c] = calls
  assert.equal(c.method, "chat.postMessage")
  assert.equal(c.body.channel, "C-needs-you")
  assert.equal(c.body.username, "Chief of Staff")
  assert.match(c.body.icon_url, /twemoji.*\.png$/)
  assert.match(c.body.text, /^<@UOWNER> Ticket \*12\* is ready$/)
  const els = c.body.blocks[1].elements
  assert.deepEqual(els.map((e: any) => [e.text.text, e.value, e.style, e.url]), [["Approve", "approve 12", "primary", undefined], ["Decline", "decline 12", "danger", undefined], ["Open", undefined, undefined, "https://example.com/pr/1"]])
  assert.ok(!JSON.stringify(c.body).includes("xoxb")) // the token travels only in the header
  assert.equal(c.auth, "Bearer xoxb-test-token-1234")
})

test("post: a ticket's first message is the thread root, later ones reply in it, other roles keep their own name", async () => {
  const calls: Call[] = []
  const e = (step: any) => ({ kind: "ticket", project: "dobby", ticket: 7, title: "Fix it", step }) as const
  await sl.post(db, e("picked"), "Picked", undefined, stub(calls))
  await sl.post(db, e("check"), "Checking", undefined, stub(calls))
  assert.equal(calls[0].body.thread_ts, undefined)
  assert.equal(calls[1].body.thread_ts, "100.1")
  assert.deepEqual(calls.map((c) => c.body.username), ["Engineering Manager · dobby", "Tester · dobby"])
})

test("post: no channel yet is an error that says what to run", async () => {
  const empty = { prepare: () => ({ get: () => undefined }) } as never
  await assert.rejects(sl.post(empty, { kind: "ask" }, "hi", undefined, stub([])), /dobby slack setup/)
})

test("edit: chat.update by ts, buttons gone when none are given; Slack errors name the method and code", async () => {
  const calls: Call[] = []
  await sl.edit(db, "needs-you", "100.9", "Done", undefined, stub(calls))
  assert.deepEqual([calls[0].method, calls[0].body.channel, calls[0].body.ts, calls[0].body.blocks.length], ["chat.update", "C-needs-you", "100.9", 1])
  await assert.rejects(sl.edit(db, "needs-you", "1", "x", undefined, stub([], { "chat.update": "message_not_found" })), /slack chat.update message_not_found/)
})

test("upsert: first call posts, later calls edit, a deleted message posts again", async () => {
  const calls: Call[] = []
  const a = await sl.upsert(db, "k1", { kind: "approval" }, "one", undefined, stub(calls))
  const b = await sl.upsert(db, "k1", { kind: "approval" }, "two", undefined, stub(calls))
  assert.equal(a, b)
  assert.deepEqual(calls.map((c) => c.method), ["chat.postMessage", "chat.update"])
  const again: Call[] = []
  await sl.upsert(db, "k1", { kind: "approval" }, "three", undefined, stub(again, { "chat.update": "message_not_found" }))
  assert.deepEqual(again.map((c) => c.method), ["chat.update", "chat.postMessage"])
})

test("tap: the owner's tap rewrites the card and reaches handle; another user is ignored; a fast second tap runs once", async () => {
  const got: any[] = [], calls: Call[] = []
  let release = () => {}
  const feed = sl.makeFeed(db, (o) => new Promise<void>((r) => { got.push(o); release = r }), stub(calls))
  const tap = { value: "approve 7", ts: "1.1", channel: "C-needs-you", user: "UOWNER", text: "Needs you", blocks: [{ type: "section" }, { type: "actions" }] }
  await feed.tap({ ...tap, user: "UOTHER" })
  await tick()
  assert.equal(got.length, 0)
  assert.equal(calls.length, 0)
  const first = feed.tap(tap)
  await feed.tap(tap)
  await tick()
  assert.equal(got.length, 1)
  assert.deepEqual([got[0].kind, got[0].data, got[0].app, got[0].token], ["button", "approve 7", "C-needs-you", "1.1"])
  assert.deepEqual(got[0].components, [{ type: "actions" }])
  assert.equal(calls[0].method, "chat.update") // buttons replaced by the ack line before the work starts
  assert.match(calls[0].body.text, /^Needs you\n\n→ Merging/)
  release(); await first
})

test("tap: the rewritten card keeps its line breaks from the section block, not Slack's flat message.text", async () => {
  const calls: Call[] = []
  const feed = sl.makeFeed(db, async () => {}, stub(calls))
  await feed.tap({ value: "approve 8", ts: "2.2", channel: "C-needs-you", user: "UOWNER", text: "What happened: x Why: y", blocks: [{ type: "section", text: { text: "What happened: x\nWhy: y" } }, { type: "actions" }] })
  await tick()
  assert.match(calls[0].body.text, /^What happened: x\nWhy: y\n\n→ /)
})

test("answerTap: writes the result into the tapped message; a failed action keeps the buttons; no channel = false", async () => {
  const calls: Call[] = []
  const o = { app: "C1", token: "5.5", content: "Card", data: "approve 1", components: [{ type: "actions" }] }
  assert.equal(await sl.answerTap(o, "Merged", stub(calls)), true)
  assert.equal(calls[0].body.blocks.length, 1)
  await sl.answerTap(o, "Failed", stub(calls), false)
  assert.equal(calls[1].body.blocks.length, 2)
  assert.equal(await sl.answerTap({ ...o, app: "" }, "x", stub(calls)), false)
  assert.equal(await sl.answerTap(o, "x", stub([], { "chat.update": "channel_not_found" })), false)
})

test("messages: only the owner, #assistant or a DM is a question, a brainstorm thread is a brain message, @dobby once", async () => {
  const got: any[] = []
  const feed = sl.makeFeed(db, async (o) => { got.push(o) })
  setKv(db, "slack:brain:C-dobby-ideas:9.9", "5")
  feed.message({ text: "what's waiting?", channel: "C-assistant", ts: "1", user: "UOTHER" })
  feed.message({ text: "what's waiting?", channel: "C-assistant", ts: "2", user: "UOWNER" })
  feed.message({ text: "<@UBOT> what's waiting?", channel: "C-assistant", ts: "2", user: "UOWNER" }) // same message again as app_mention
  feed.message({ text: "chatter", channel: "C-system-status", ts: "3", user: "UOWNER" })
  feed.message({ text: "go", channel: "C-dobby-ideas", ts: "4", threadTs: "9.9", user: "UOWNER" })
  feed.message({ text: "hello", channel: "D123", ts: "5", user: "UOWNER" })
  await tick()
  assert.deepEqual(got, [{ kind: "ask", text: "what's waiting?" }, { kind: "brain", thread: "C-dobby-ideas:9.9", text: "go" }, { kind: "ask", text: "hello", dm: "D123" }])
})

test("reactions: thumbs up or down by the owner on an ideas channel only", async () => {
  const got: any[] = []
  const feed = sl.makeFeed(db, async (o) => { got.push(o) })
  const r = { emoji: "+1", ts: "7.7", channel: "C-dobby-ideas", user: "UOWNER", added: true }
  feed.reaction({ ...r, user: "UOTHER" })
  feed.reaction({ ...r, channel: "C-needs-you" })
  feed.reaction({ ...r, emoji: "tada" })
  feed.reaction({ ...r, added: false })
  feed.reaction(r)
  feed.reaction({ ...r, emoji: "-1" })
  await tick()
  assert.deepEqual(got, [{ kind: "react", messageId: "7.7", channelId: "C-dobby-ideas", up: true }, { kind: "react", messageId: "7.7", channelId: "C-dobby-ideas", up: false }])
})

test("attach: Chat SDK events become feed calls", async () => {
  const seen: any[] = []
  const feed = { tap: async (t: any) => void seen.push(["tap", t.value, t.ts, t.channel, t.user]), message: (m: any) => void seen.push(["msg", m.text, m.channel, m.threadTs]), reaction: (r: any) => void seen.push(["react", r.emoji, r.channel]) } as never
  const h: Record<string, any> = {}
  sl.attach({ onAction: (f: any) => (h.action = f), onNewMessage: (_re: any, f: any) => (h.message = f), onNewMention: (f: any) => (h.mention = f), onReaction: (f: any) => (h.reaction = f) } as never, feed)
  await h.action({ value: "approve 3", messageId: "1.1", user: { userId: "UOWNER" }, raw: { channel: { id: "C9" }, message: { ts: "1.2", text: "Card" } } })
  h.message({}, { text: "hi", author: { userId: "UOWNER" }, raw: { channel: "C2", ts: "2.1", thread_ts: "2.1", text: "hi" } })
  h.mention({}, { text: "yo", author: { userId: "UOWNER" }, raw: { channel: "C2", ts: "3.1", thread_ts: "2.1", text: "yo" } })
  h.reaction({ rawEmoji: "-1", messageId: "4.1", user: { userId: "UOWNER" }, added: true, raw: { item: { channel: "C3" } } })
  assert.deepEqual(seen, [["tap", "approve 3", "1.2", "C9", "UOWNER"], ["msg", "hi", "C2", undefined], ["msg", "yo", "C2", "2.1"], ["react", "-1", "C3"]])
})

const setupStub = (calls: Call[], channels: any[] = [], fail: Record<string, string> = {}) => (async (url: URL, init: RequestInit) => {
  const method = String(url).split("/").pop()!, body = JSON.parse(String(init.body))
  calls.push({ method, body, auth: "" })
  if (fail[method]) return new Response(JSON.stringify({ ok: false, error: fail[method] }))
  const out: Record<string, any> = { "auth.test": { team: "Acme", user_id: "UBOT" }, "conversations.list": { channels }, "conversations.create": { channel: { id: `CNEW-${body.name}` } } }
  return new Response(JSON.stringify({ ok: true, ...out[method] }))
}) as unknown as typeof fetch
const quiet = () => {}

test("setup: needs an explicit owner id; nothing is guessed from the workspace", async () => {
  const calls: Call[] = []
  await assert.rejects(sl.setup(open(), setupStub(calls), quiet), /member ID/)
  const fresh = open()
  setKv(fresh, "slack:owner", "not-an-id")
  await assert.rejects(sl.setup(fresh, setupStub(calls), quiet), /member ID/)
  assert.ok(!calls.some((c) => c.method === "users.list" || c.method === "conversations.create"))
})

const clean = () => { const d = open(); d.prepare("DELETE FROM kv WHERE k LIKE 'slack:ch:%' OR k='slack:created'").run(); return d }

test("setup: creates private channels, invites the owner, remembers what it created, adopts nothing else", async () => {
  const calls: Call[] = [], logs: string[] = []
  const fresh = clean()
  setKv(fresh, "slack:owner", "UP123456")
  assert.equal(await sl.setup(fresh, setupStub(calls, [{ id: "CX", name: "needs-you" }]), (m) => logs.push(m)), "Acme")
  const creates = calls.filter((c) => c.method === "conversations.create")
  assert.ok(creates.every((c) => c.body.is_private === true))
  assert.ok(creates.some((c) => c.body.name === "dobby-needs-you")) // a foreign #needs-you exists: prefixed name
  assert.ok(creates.some((c) => c.body.name === "daily-update"))
  assert.ok(!calls.some((c) => c.method === "conversations.join"))
  assert.deepEqual(calls.find((c) => c.method === "conversations.list")!.body.types, "public_channel,private_channel")
  assert.equal((fresh.prepare("SELECT v FROM kv WHERE k='slack:ch:needs-you'").get() as any).v, "CNEW-dobby-needs-you")
  assert.ok(calls.some((c) => c.method === "conversations.invite" && c.body.users === "UP123456"))
  assert.match(logs.join("\n"), /#needs-you already exists and is not Dobby's/)
  // again: the channels it created are reused, none created twice
  const again: Call[] = []
  const created = JSON.parse((fresh.prepare("SELECT v FROM kv WHERE k='slack:created'").get() as any).v)
  await sl.setup(fresh, setupStub(again, [{ id: "CX", name: "needs-you" }, ...created.map((id: string) => ({ id, name: id.replace("CNEW-", "") }))]), quiet)
  assert.ok(!again.some((c) => c.method === "conversations.create"))
})

test("setup: a name taken by a channel the bot cannot see falls back to the prefixed name", async () => {
  const calls: Call[] = []
  const fresh = clean()
  setKv(fresh, "slack:owner", "UP123456")
  let n = 0
  const f = (async (url: URL, init: RequestInit) => {
    const method = String(url).split("/").pop()!, body = JSON.parse(String(init.body))
    calls.push({ method, body, auth: "" })
    if (method === "conversations.create" && !body.name.startsWith("dobby-") && n++ === 0) return new Response(JSON.stringify({ ok: false, error: "name_taken" }))
    return new Response(JSON.stringify({ ok: true, team: "Acme", channels: [], channel: { id: `C-${body.name}` } }))
  }) as unknown as typeof fetch
  await sl.setup(fresh, f, quiet)
  assert.ok(calls.some((c) => c.method === "conversations.create" && c.body.name === "dobby-needs-you"))
})

test("manifest: scopes, Socket Mode, interactivity, private channels and the Messages tab", () => {
  const m = sl.manifest()
  for (const s of ["chat:write", "chat:write.customize", "channels:read", "groups:read", "groups:write", "groups:history", "reactions:read", "im:history", "app_mentions:read", "users:read"]) assert.match(m, new RegExp(`- ${s}\\n`))
  assert.match(m, /- message.groups\n/)
  assert.match(m, /messages_tab_enabled: true/)
  assert.match(m, /messages_tab_read_only_enabled: false/)
  assert.match(m, /socket_mode_enabled: true/)
  assert.match(m, /is_enabled: true/)
})

test("redact: the owner's member id in secrets.env is not masked, tokens still are", async () => {
  const { setSecret } = await import("../src/notify.ts")
  setSecret("SLACK_OWNER_ID", "U0ABCDEFGH")
  setKv(db, "slack:owner", "U0ABCDEFGH")
  const calls: Call[] = []
  await sl.post(db, { kind: "approval" }, "hi", undefined, stub(calls))
  assert.match(calls[0].body.text, /^<@U0ABCDEFGH> hi$/)
  assert.equal(calls[0].auth, "Bearer xoxb-test-token-1234")
  setKv(db, "slack:owner", "UOWNER")
})

test("api: a 429 waits Retry-After seconds and retries up to 3 tries", async () => {
  let n = 0
  const f = (async () => (++n < 3 ? new Response("{}", { status: 429, headers: { "retry-after": "0" } }) : new Response(JSON.stringify({ ok: true, ts: "1" })))) as unknown as typeof fetch
  const t0 = Date.now()
  assert.equal((await sl.api(null, "chat.postMessage", {}, f)).ts, "1")
  assert.equal(n, 3)
  assert.ok(Date.now() - t0 < 5000)
  n = -5
  await assert.rejects(sl.api(null, "chat.postMessage", {}, f), /slack chat.postMessage/)
  assert.equal(n, -2) // three tries, then gives up
})

test("listen: missing app token logs one line and idles instead of throwing", async () => {
  const prev = readFileSync(process.env.DOBBY_SECRETS!, "utf8")
  writeFileSync(process.env.DOBBY_SECRETS!, prev.replace(/SLACK_APP_TOKEN=.*\n/, ""))
  const lines: string[] = [], log = console.log
  console.log = (m: string) => void lines.push(m)
  try {
    assert.equal(sl.slackOn(), null) // both tokens are required
    const r = await Promise.race([sl.listen(db, async () => {}).then(() => "returned"), new Promise((res) => setTimeout(() => res("idle"), 100))])
    assert.equal(r, "idle")
  } finally { console.log = log; writeFileSync(process.env.DOBBY_SECRETS!, prev) }
  assert.equal(lines.length, 1)
  assert.match(lines[0], /SLACK_APP_TOKEN/)
})

test("DM: a message to the bot is answered in the DM (ask carries the channel)", async () => {
  const got: any[] = []
  const feed = sl.makeFeed(db, async (o) => { got.push(o) })
  feed.message({ text: "hi", channel: "D9", ts: "9", user: "UOWNER" })
  feed.message({ text: "hi", channel: "C-assistant", ts: "10", user: "UOWNER" })
  await tick()
  assert.deepEqual(got, [{ kind: "ask", text: "hi", dm: "D9" }, { kind: "ask", text: "hi" }])
})

test("on Slack: the status board, review and deploy cards use slack:msg keys and never call Discord or send its token", async () => {
  const { setSecret } = await import("../src/notify.ts")
  setSecret("DISCORD_BOT_TOKEN", "discord-token-ABCDEFG")
  const { updateBoard } = await import("../src/view.ts")
  const { realSettle } = await import("../src/graphs/review.ts")
  const { chatPrefix } = await import("../src/chat/platform.ts")
  setConfig({ ...config(), chat: { platform: "slack" } })
  const urls: string[] = [], real = globalThis.fetch
  const f = (async (url: URL, init: RequestInit) => { urls.push(`${url} ${JSON.stringify(init.headers)}`); return new Response(JSON.stringify({ ok: true, ts: "5.5", channel: "C1" })) }) as unknown as typeof fetch
  globalThis.fetch = f
  try {
    assert.equal(chatPrefix(), "slack")
    await updateBoard(db, true, f, Date.now())
    assert.ok(urls.length > 0 && urls.every((u) => u.includes("slack.com")), urls.join("\n"))
    assert.ok(!urls.join("").includes("discord"))
    assert.ok((db.prepare("SELECT v FROM kv WHERE k='slack:msg:status'").get() as any).v)
    assert.equal(db.prepare("SELECT 1 FROM kv WHERE k='discord:msg:status'").get(), undefined)
    setKv(db, "slack:msg:review:x#1", "7.7")
    urls.length = 0
    await realSettle("review:x#1", "done")
    assert.ok(urls.some((u) => u.includes("chat.update")))
  } finally { globalThis.fetch = real; setConfig() }
})

test("config picks the platform: Discord by default, Slack when chat.platform is slack", async () => {
  assert.equal((await platform()).name, "discord")
  assert.equal((await platform()).prefix, "discord")
  setConfig({ ...config(), chat: { platform: "slack" } })
  try {
    const p = await platform()
    assert.deepEqual([p.name, p.prefix], ["slack", "slack"])
    assert.notEqual(chatOn(), null) // slack is set up (token + #needs-you channel), so chat is on
  } finally { setConfig() }
  assert.equal((await platform()).name, "discord")
})

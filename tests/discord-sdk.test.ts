// Chat SDK listening, fully offline: no gateway, no Discord. The feed gets the same taps/messages the SDK handlers would pass it.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-test-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/s.env`
writeFileSync(process.env.DOBBY_SECRETS, "DISCORD_BOT_TOKEN=bot\n")
const { appId, resetAppId, makeFeed, runForever } = await import("../src/chat/discord-sdk.ts")
const { platform } = await import("../src/chat/platform.ts")
const { setKv } = await import("../src/discord.ts")
const { open } = await import("../src/db.ts")

type Call = { method: string; url: string; body: any }
const stub = (calls: Call[]) => (async (url: string, init?: RequestInit) => {
  calls.push({ method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
  if (String(url).includes("/oauth2/applications/@me")) return new Response(JSON.stringify({ id: "app42" }))
  if (String(url).includes("/messages/m1") && (init?.method ?? "GET") === "GET") return new Response(JSON.stringify({ content: "Needs you", components: [{ type: 1 }] }))
  return new Response(JSON.stringify({ id: "msg1", channel_id: "chan1" }))
}) as unknown as typeof fetch
const tick = () => new Promise((r) => setTimeout(r, 20))

const db = open()
setKv(db, "discord:owner", "owner1")
setKv(db, "discord:ch:assistant", "c-ask")
setKv(db, "discord:brain:th1", "5")

test("app id comes from the bot token over REST, once", async () => {
  resetAppId()
  const calls: Call[] = []
  assert.equal(await appId("bot", stub(calls)), "app42")
  assert.equal(await appId("bot", stub(calls)), "app42")
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/oauth2\/applications\/@me$/)
})

test("app id: a failed first fetch is not cached, the next one connects", async () => {
  resetAppId()
  let n = 0
  const flaky = (async () => { if (++n === 1) throw new Error("network down"); return new Response(JSON.stringify({ id: "app9" })) }) as unknown as typeof fetch
  await assert.rejects(appId("bot", flaky))
  assert.equal(await appId("bot", flaky), "app9")
  resetAppId()
})

test("tap: a fast second tap on the same message runs once", async () => {
  const got: any[] = []
  let release = () => {}
  const feed = makeFeed(db, (o) => new Promise<void>((r) => { got.push(o); release = r }), stub([]))
  const tap = { customId: "approve 7", messageId: "m1", channelId: "c1", id: "i1", token: "tok", app: "app42", userId: "owner1" }
  const first = feed.tap(tap)
  await feed.tap(tap)
  await tick()
  assert.equal(got.length, 1)
  release(); await first
  const third = feed.tap(tap); await tick()
  assert.equal(got.length, 2) // free again once the first finished
  release(); await third
})

test("tap: if the message cannot be read, the card is not PATCHed (no wipe) and the result falls back to a new post", async () => {
  const calls: Call[] = [], got: any[] = []
  const bad = (async (url: string, init?: RequestInit) => { calls.push({ method: init?.method ?? "GET", url: String(url), body: undefined }); if ((init?.method ?? "GET") === "GET") throw new Error("boom"); return new Response("{}") }) as unknown as typeof fetch
  const feed = makeFeed(db, async (o) => void got.push(o), bad)
  await feed.tap({ customId: "approve 7", messageId: "m2", channelId: "c1", id: "i1", token: "tok", app: "app42", userId: "owner1" })
  await tick()
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0)
  assert.equal(got[0].app, "") // answerTap(o) now returns false, so cli.ts posts the result
})

test("tap: the custom_id reaches the handler, the message is acked in place; a stranger is ignored", async () => {
  const calls: Call[] = [], got: any[] = []
  const feed = makeFeed(db, async (o) => void got.push(o), stub(calls))
  const tap = { customId: "approve 7", messageId: "m1", channelId: "c1", id: "i1", token: "tok", app: "app42" }
  await feed.tap({ ...tap, userId: "stranger" })
  await feed.tap({ ...tap, userId: "owner1" })
  await tick()
  assert.equal(got.length, 1)
  assert.equal(got[0].kind, "button")
  assert.equal(got[0].data, "approve 7")
  assert.equal(got[0].content, "Needs you")
  const ack = calls.find((c) => c.method === "PATCH")!
  assert.match(ack.url, /\/webhooks\/app42\/tok\/messages\/@original$/)
  assert.deepEqual(ack.body.components, [])
  assert.match(ack.body.content, /→ Merging/)
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 1) // nothing happened for the stranger
})

test("messages: owner in #assistant asks, owner in a ticket thread talks, anyone else is ignored", async () => {
  const got: any[] = []
  const feed = makeFeed(db, async (o) => void got.push(o), stub([]))
  feed.message({ text: " what's on today? ", channelId: "c-ask", threadId: "discord:g:c-ask", userId: "owner1" })
  feed.message({ text: "go", channelId: "th1", threadId: "discord:g:c-x:th1", userId: "owner1" })
  feed.message({ text: "go", channelId: "th1", threadId: "discord:g:c-x:th1", userId: "stranger" })
  feed.message({ text: "hi", channelId: "c-other", threadId: "discord:g:c-other", userId: "owner1" })
  await tick()
  assert.deepEqual(got, [{ kind: "ask", text: "what's on today?" }, { kind: "brain", thread: "th1", text: "go" }])
})

test("messages: a mention in #assistant arrives with the channel Discord reports and still asks", async () => {
  const got: any[] = []
  const feed = makeFeed(db, async (o) => void got.push(o), stub([]))
  feed.message({ text: "@dobby status", channelId: "c-ask", threadId: "discord:g:c-ask:newthread", userId: "owner1" })
  await tick()
  assert.deepEqual(got, [{ kind: "ask", text: "@dobby status" }])
})

test("reactions: the owner's thumbs on an idea channel only", () => {
  setKv(db, "discord:ch:dobby-ideas", "c-ideas")
  const feed = makeFeed(db, async () => {}, stub([]))
  const r = (user: string, emoji: string) => ({ user_id: user, channel_id: "c-ideas", message_id: "m5", emoji: { name: emoji } })
  assert.ok(feed.emit("MESSAGE_REACTION_ADD", r("owner1", "👍")))
  assert.equal(feed.emit("MESSAGE_REACTION_ADD", r("stranger", "👍")), null)
  assert.equal(feed.emit("MESSAGE_REACTION_ADD", r("owner1", "🎉")), null)
})

test("restart loop: restarts after each run, backs off short ones, waits 10 min on 4014", async () => {
  const log: string[] = [], naps: number[] = []
  let n = 0
  await runForever(async () => (++n === 3 ? { error: "Error [DisallowedIntents]: Privileged intent provided is not enabled" } : {}), {
    durationMs: 100, log: (m) => log.push(m), sleep: async (ms) => void naps.push(ms), stop: () => n >= 4,
  })
  assert.equal(n, 4)
  assert.equal(log.filter((m) => /restarting/.test(m)).length, 2)
  assert.ok(log.includes("discord: gateway closed 4014 (4004 = bad token, 4014 = switch on Message Content intent); retry in 10 min"))
  assert.ok(naps.includes(600_000))
})

test("discord.listener: chat-sdk is opt-in, anything else is the legacy gateway", async () => {
  const hit: string[] = []
  const impl = { legacy: async () => void hit.push("legacy"), sdk: async () => void hit.push("sdk") }
  await (await platform("legacy", impl)).listen(db, async () => {})
  await (await platform("chat-sdk", impl)).listen(db, async () => {})
  await (await platform(undefined, impl)).listen(db, async () => {})
  assert.deepEqual(hit, ["legacy", "sdk", "legacy"])
})

test("outbound through the interface: same webhook, same persona", async () => {
  setKv(db, "discord:wh:needs-you", "needs-you-id/needs-you-token")
  const calls: Call[] = []
  await (await platform()).post(db, { kind: "approval" }, "hello", [{ text: "✅ Approve", data: "approve 7" }], stub(calls))
  assert.match(calls[0].url, /\/webhooks\/needs-you-id\/needs-you-token\?wait=true&with_components=true$/)
  assert.equal(calls[0].body.username, "Chief of Staff")
  assert.match(calls[0].body.avatar_url, /twemoji.*\.png$/)
  assert.equal(calls[0].body.components[0].components[0].custom_id, "approve 7")
})

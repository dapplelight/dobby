// Discord's REST side against an in-memory fake Discord: ticket status lines, edits that fall back on a 404, one-time setup of the server,
// button acknowledgements and the per-lane queue. globalThis.fetch is replaced for this file, so an unknown URL fails the test; the
// real Discord is never reached. Temp data dir and secrets file.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-discord-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/secrets.env`
writeFileSync(process.env.DOBBY_SECRETS, "DISCORD_BOT_TOKEN=bot-token\n")
const d = await import("../src/discord.ts")
const { open } = await import("../src/db.ts")

// ---- a tiny Discord ---------------------------------------------------------------------------------------------------
type Hit = { method: string; path: string; body: any }
const hits: Hit[] = []
const gone = new Set<string>() // message ids that answer 404 on PATCH
let ids = 0
const channels: { id: string; name: string; type: number; parent_id?: string }[] = []
const hooks = new Map<string, { id: string; token: string; user: { id: string } }[]>()
const reply = (body: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(body), { status })
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const u = String(url)
  assert.ok(u.startsWith("https://discord.com/api/v10"), `unexpected URL ${u}`)
  const path = u.slice("https://discord.com/api/v10".length), method = init?.method ?? "GET"
  const body = init?.body ? JSON.parse(String(init.body)) : undefined
  hits.push({ method, path, body })
  let m: RegExpMatchArray | null
  if (path === "/oauth2/applications/@me") return reply({ id: "app1" })
  if (path === "/users/@me") return reply({ id: "bot1" })
  if (path === "/users/@me/guilds") return reply([{ id: "g1" }])
  if (path === "/guilds/g1") return reply({ id: "g1", name: "Test Server", owner_id: "owner1" })
  if (path === "/guilds/g1/channels" && method === "GET") return reply(channels)
  if (path === "/guilds/g1/channels" && method === "POST") { const c = { id: `c${++ids}`, name: body.name, type: body.type, parent_id: body.parent_id }; channels.push(c); return reply(c) }
  if ((m = path.match(/^\/channels\/(\w+)$/)) && method === "PATCH") { const c = channels.find((x) => x.id === m![1]); if (c) Object.assign(c, body); return reply(c ?? { id: m[1], ...body }) }
  if ((m = path.match(/^\/channels\/(\w+)\/webhooks$/))) {
    if (method === "GET") return reply(hooks.get(m[1]) ?? [])
    const h = { id: `w${++ids}`, token: `t${ids}`, user: { id: "bot1" } }; hooks.set(m[1], [h]); return reply(h)
  }
  if ((m = path.match(/^\/webhooks\/([^/]+)\/([^/?]+)\/messages\/(@original|\w+)/)) && method === "PATCH") return gone.has(m[3]) ? reply({}, 404) : reply({})
  if (path.match(/^\/webhooks\/[^/]+\/[^/?]+\/messages\/\w+/) && method === "DELETE") return reply(null, 204)
  if (path.match(/^\/webhooks\/[^/]+\/[^/?]+\?wait=true/) && method === "POST") return reply({ id: `m${++ids}`, channel_id: "chan1" })
  if (path.match(/^\/channels\/\w+\/messages\/\w+\/threads$/)) return reply({ id: `th${++ids}` })
  if (path.match(/^\/channels\/\w+\/messages$/)) return reply({ id: `m${++ids}` })
  if (path.match(/\/reactions\//) && method === "PUT") return reply(null, 204)
  if (path.match(/^\/interactions\/\w+\/[\w-]+\/callback$/)) return reply({})
  return reply({}, 404)
}) as typeof fetch
const last = () => hits.at(-1)!
const clear = () => { hits.length = 0 }

const db = open()
const wh = (c: string) => d.setKv(db, `discord:wh:${c}`, `${c}-id/${c}-tok`)
for (const c of ["needs-you", "tally-tickets", "tally-releases", "tally-ideas"]) wh(c)
d.setKv(db, "discord:owner", "owner1")
const ticket = (step: any, ticketId = 7) => ({ kind: "ticket" as const, project: "tally", ticket: ticketId, title: "Add a farewell helper", step })

test("a ticket's status line is posted once, edited as it moves, and skipped when unchanged", async () => {
  await d.ticketStatus(db, ticket("building"), "Step 2 of 5: Engineer is building")
  assert.equal(last().method, "POST")
  assert.ok(hits.some((h) => h.path.includes("/threads")), "the first post starts the ticket's thread")
  const id = d.kv(db, "discord:msg:ticket:7")!
  assert.ok(id)
  clear()
  await d.ticketStatus(db, ticket("verify"), "Step 3 of 5: tests are running")
  assert.equal(last().method, "PATCH")
  assert.match(last().path, new RegExp(`/messages/${id}`))
  clear()
  await d.ticketStatus(db, ticket("verify"), "Step 3 of 5: tests are running")
  assert.equal(hits.length, 0, "the same line twice is not sent twice")
})

test("a status line whose message was deleted (404, in the channel and in the thread) is posted fresh", async () => {
  const old = d.kv(db, "discord:msg:ticket:7")!
  gone.add(old)
  clear()
  await d.ticketStatus(db, ticket("check"), "Step 4 of 5: Tester is checking")
  assert.deepEqual(hits.map((h) => h.method), ["PATCH", "PATCH", "POST"], "tries the channel, then the thread, then posts")
  assert.notEqual(d.kv(db, "discord:msg:ticket:7"), old)
  gone.clear()
})

test("an edit that fails for another reason is an error, not a silent repost", async () => {
  d.setKv(db, "discord:msg:ticket:8", "bad")
  const real = globalThis.fetch
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch
  try { await assert.rejects(d.ticketStatus(db, ticket("building", 8), "x"), /discord PATCH .* 500/) } finally { globalThis.fetch = real }
})

test("team and teamStatus never throw: a Discord error is logged and the answer is null", async () => {
  assert.equal(await d.team({ kind: "lead", project: "tally" }, "plan"), "m" + ids)  // Discord is on in this file
  const real = globalThis.fetch, say = console.log, said: string[] = []
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch
  console.log = (t: string) => said.push(t)
  try {
    assert.equal(await d.team({ kind: "lead", project: "tally" }, "plan"), null)
    await d.teamStatus(ticket("building", 99), "line")
  } finally { globalThis.fetch = real; console.log = say }
  assert.equal(said.length, 2)
  assert.match(said[0], /^discord: discord POST/)
})

test("upsert edits its message; if that was deleted it posts a new one and remembers it", async () => {
  const first = await d.upsert(db, "deploy:tally", { kind: "approval" }, "v1")
  assert.equal(d.kv(db, "discord:msg:deploy:tally"), first)
  clear()
  assert.equal(await d.upsert(db, "deploy:tally", { kind: "approval" }, "v2"), first)
  assert.equal(last().method, "PATCH")
  gone.add(first)
  const fresh = await d.upsert(db, "deploy:tally", { kind: "approval" }, "v3")
  assert.notEqual(fresh, first)
  gone.clear()
})

test("prCard: the same state edits quietly, a new state deletes the old card and posts a fresh one", async () => {
  const a = await d.prCard(db, "pr:acme/tally#1", "Review failed", { kind: "approval" }, "Review failed\nbody")
  clear()
  assert.equal(await d.prCard(db, "pr:acme/tally#1", "Review failed", { kind: "approval" }, "Review failed\nmore"), a)
  assert.deepEqual(hits.map((h) => h.method), ["PATCH"])
  clear()
  const b = await d.prCard(db, "pr:acme/tally#1", "Resolved", { kind: "approval" }, "Resolved")
  assert.notEqual(b, a)
  assert.deepEqual(hits.map((h) => h.method), ["DELETE", "POST"])
})

test("edit without a webhook says to run setup", async () => {
  await assert.rejects(d.edit(db, "no-such-channel", "m1", "x"), /no webhook for #no-such-channel: run dobby discord setup/)
})

test("an idea card goes to the app's ideas channel with 👍 and 👎 on it, and a 👍 opens a brainstorm thread", async () => {
  clear()
  await d.postIdea({ id: 5, project: "tally", title: "Weekly recap", pitch: "A Sunday summary", why: "people forget", how: "one email", experiment: "send it to 3 people", size: "S" })
  assert.match(hits[0].body.content, /^## 💡 Weekly recap/)
  assert.match(hits[0].body.content, /-# tally · size S · 👍 build it · 👎 drop it/)
  assert.deepEqual(hits.filter((h) => h.method === "PUT").map((h) => decodeURIComponent(h.path.split("/reactions/")[1].split("/")[0])), ["👍", "👎"])
  const t = await d.openBrainThread(db, "chan9", "msg9", 5, "Weekly recap")
  assert.equal(d.kv(db, `discord:brain:${t}`), "5")
  assert.equal(last().body.name, "Brainstorm: Weekly recap")
  await d.brainSay(t, "x".repeat(2500), [{ text: "Build it", data: "buildidea 5" }])
  assert.equal(last().body.content.length, 2000, "cut at Discord's limit")
  assert.equal(last().body.components[0].components[0].custom_id, "buildidea 5")
  assert.equal(d.ideaCard({ project: "tally", title: "Bare" }), "## 💡 Bare\n\n-# tally · 👍 build it · 👎 drop it")
})

test("setup creates the server's categories, channels and one webhook each, and is idempotent", async () => {
  channels.length = 0; hooks.clear(); clear()
  assert.equal(await d.setup(db), "Test Server")
  const created = hits.filter((h) => h.method === "POST" && h.path === "/guilds/g1/channels").length
  assert.ok(created >= d.CHANNELS.length, "every channel and category was created")
  assert.equal(d.kv(db, "discord:guild"), "g1")
  assert.equal(d.kv(db, "discord:owner"), "owner1")
  for (const c of d.CHANNELS) assert.match(d.kv(db, `discord:wh:${c}`) ?? "", /^w\d+\/t\d+$/, c)
  assert.ok(hits.some((h) => h.method === "POST" && /\/webhooks$/.test(h.path) && h.body.name === "Dobby"))
  clear()
  await d.setup(db)
  assert.equal(hits.filter((h) => h.method === "POST").length, 0, "a second run creates nothing")
  assert.ok(hits.filter((h) => h.method === "PATCH").length >= d.CHANNELS.length, "it only brings names, topics and categories up to date")
})

test("setup renames an old channel and category in place so its threads keep their history", async () => {
  channels.length = 0; hooks.clear(); clear()
  channels.push({ id: "old1", name: "⚙️ FOREMAN", type: 4 }, { id: "old2", name: "foreman-tickets", type: 0 }, { id: "old3", name: "brief", type: 0 })
  await d.setup(db)
  assert.equal(channels.find((c) => c.id === "old1")?.name, "⚙️ DOBBY")
  assert.equal(channels.find((c) => c.id === "old2")?.name, "dobby-tickets")
  assert.equal(channels.find((c) => c.id === "old3")?.name, "daily-update")
})

test("setup refuses a bot that is in more than one server; the invite link names the app", async () => {
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string) => new Response(String(url).endsWith("/users/@me/guilds") ? JSON.stringify([{ id: "a" }, { id: "b" }]) : JSON.stringify({ id: "bot1" }))) as typeof fetch
  try { await assert.rejects(d.setup(db), /the bot is in 2 servers; it needs exactly one/) } finally { globalThis.fetch = real }
  assert.match(await d.inviteUrl(), /^https:\/\/discord\.com\/oauth2\/authorize\?client_id=app1&scope=bot\+applications\.commands&permissions=\d+$/)
})

test("a button press is acknowledged at once, and its result is written into the tapped message", async () => {
  clear()
  await d.ack({ id: "i1", token: "tok", content: "Needs you · tally #7", data: "approve 7" }, fetch, db)
  assert.equal(last().path, "/interactions/i1/tok/callback")
  assert.equal(last().body.type, 7)
  assert.deepEqual(last().body.data.components, [], "the buttons go away so a second tap cannot repeat it")
  assert.match(last().body.data.content, /→ Working on it…|→ Merging/)
  assert.equal(await d.answerTap({ app: "app1", token: "tok", content: "card", data: "approve 7" }, "Merged."), true)
  assert.match(last().body.content, /card\n\n→ Merged\./)
  assert.equal(await d.answerTap({ app: "", token: "tok", content: "card", data: "x" }, "x"), false, "no application id: the caller posts instead")
  gone.add("@original")
  assert.equal(await d.answerTap({ app: "app1", token: "tok", content: "card", data: "x" }, "  "), false, "the 15-minute token expired")
  gone.clear()
})

test("a failed tap keeps the card's buttons so it can be retried there; a good one removes them", async () => {
  clear()
  const row = [{ type: 1, components: [{ type: 2, custom_id: "stuckretry 12", label: "Retry" }] }]
  const o = { app: "app1", token: "tok", content: "card", data: "stuckretry 12", components: row }
  assert.equal(await d.answerTap(o, "Couldn't close the PR (boom); #12 stays in fixing.", fetch, false), true)
  assert.deepEqual(last().body.components, row)
  assert.equal(await d.answerTap(o, "Retried.", fetch, true), true)
  assert.deepEqual(last().body.components, [])
})

test("lanes: taps on one ticket run in order, different tickets at once, and a failing job never stops its lane", async () => {
  const o = (data: string) => ({ kind: "button" as const, data, id: "", token: "", content: "", app: "" })
  assert.equal(d.laneOf(o("approve 12")), "button:12")
  assert.equal(d.laneOf(o("queue 12")), "button:12", "approve and queue on one ticket share a lane")
  assert.equal(d.laneOf(o("reviewfix acme/tally 3")), "button:acme/tally#3")
  assert.equal(d.laneOf(o("deploynow tally")), "button:tally")
  assert.equal(d.laneOf({ kind: "ask", text: "approve 12" }), "button:12", "a typed command shares the button's lane")
  assert.equal(d.laneOf({ kind: "ask", text: "what's up" }), "ask")
  assert.equal(d.laneOf({ kind: "brain", thread: "t1", text: "x" }), "brain:t1")
  assert.equal(d.laneOf({ kind: "react", messageId: "m1", channelId: "c", up: true }), "idea:m1")
  assert.equal(d.laneOf(o("approve 12"), { DOBBY_LISTEN_SERIAL: "1" }), "all")
  const order: string[] = [], errors: string[] = []
  const run = d.lanes((m) => errors.push(m))
  const slow = (name: string, ms: number, fail = false) => async () => { await new Promise((r) => setTimeout(r, ms)); order.push(name); if (fail) throw new Error("boom") }
  await Promise.all([run("a", slow("a1", 30, true)), run("a", slow("a2", 1)), run("b", slow("b1", 5))])
  assert.deepEqual(order, ["b1", "a1", "a2"], "lane b did not wait for lane a; a2 waited for a1")
  assert.deepEqual(errors, ["discord: boom"])
})

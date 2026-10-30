// Slack (beta): the same team in one workspace. Sends go through the Web API (chat.postMessage with a username + icon_url per role,
// scope chat:write.customize); listening is the Chat SDK Slack adapter in Socket Mode, so no public URL.
// Tokens: SLACK_BOT_TOKEN (xoxb-) and SLACK_APP_TOKEN (xapp-) in ~/.config/dobby/secrets.env. Channel, owner and thread ids live in kv (slack:*).
// Not configured (no token, or setup never ran) = slackOn() is null and notify() writes to outbox.log.
import { assertSlackOk, callSlackApi, SlackApiError } from "@chat-adapter/slack/api"
import type { Chat } from "chat"
import type { DB } from "../db.ts"
import { open } from "../db.ts"
import { avatar, CHANNELS, chunks, ideaCard, laneOf, lanes, plainAck, route, TOPICS } from "../discord.ts"
import { readSecrets, redact as redactAll, secretValues, type Buttons } from "../notify.ts"
import { cut, kv, setKv, type Event, type Owned } from "./common.ts"
import type { Platform } from "./platform.ts"

/** Redact like everywhere else, but the owner's member id is an id, not a secret: masking it would break mentions and invites. */
const redact = (s: string) => redactAll(s, secretValues().filter((v) => v !== readSecrets().SLACK_OWNER_ID))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const SECTION = 2900 // a section block holds 3000 characters

const token = () => {
  const t = readSecrets().SLACK_BOT_TOKEN
  if (!t) throw new Error("no SLACK_BOT_TOKEN in ~/.config/dobby/secrets.env")
  return t
}

const retryAfter = (e: SlackApiError) => {
  const h = (e as { headers?: Headers | Record<string, string> }).headers, v = Number(h instanceof Headers ? h.get("retry-after") : h?.["retry-after"] ?? h?.["Retry-After"])
  return (Number.isFinite(v) && v > 0 ? Math.min(v, 60) : 1) * 1000
}
/** One Web API call as JSON. On a 429 waits Retry-After seconds (default 1, at most 60), 3 tries. Errors name the method and Slack's error code, never a token. */
export async function api<T = any>(tok: string | null, method: string, body: Record<string, unknown> = {}, fetcher: typeof fetch = fetch): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      const r = await callSlackApi(method, JSON.parse(redact(JSON.stringify(body))), { token: tok ?? token(), fetch: fetcher, contentType: "json" })
      assertSlackOk(method, r)
      return r as T
    } catch (e) {
      if (e instanceof SlackApiError && e.status === 429 && i < 2) { await sleep(retryAfter(e)); continue }
      throw new Error(`slack ${method} ${e instanceof SlackApiError ? (e.response?.error ?? e.status ?? "failed") : redact((e as Error).message).slice(0, 120)}`)
    }
  }
}

let cached: DB | undefined
/** The DB when Slack is set up (token + setup done), else null: callers then skip (outbox.log). */
export function slackOn(): DB | null {
  if (process.env.NODE_TEST_CONTEXT && !process.env.DOBBY_SECRETS) return null // `node --test` without a temp secrets file must never reach the live workspace
  const s = readSecrets()
  if (!s.SLACK_BOT_TOKEN || !s.SLACK_APP_TOKEN) return null
  cached ??= open()
  return kv(cached, "slack:ch:needs-you") ? cached : null
}

// ---- text and buttons ---------------------------------------------------------------
/** Dobby's Discord-flavoured Markdown as Slack mrkdwn: headings and **bold** to *bold*, -# footers to italics, [t](u) to <u|t>. */
export const mrkdwn = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/^#{1,3} (.*)$/gm, "*$1*").replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/^-# (.*)$/gm, "_$1_")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")

const btnStyle = (data: string) => (/^(stuck)?(decline|discard|dropidea)/.test(data) ? { style: "danger" } : /^(approve|send|reviewaccept|buildidea)/.test(data) ? { style: "primary" } : {})
const label = (text: string) => ({ type: "plain_text", text: text.slice(0, 75), emoji: true })
/** Block Kit buttons: a url button opens the page and sends nothing back; the others carry Dobby's button data as their value. */
export const actions = (buttons?: Buttons) => buttons?.length
  ? [{ type: "actions", elements: buttons.slice(0, 25).map((b, i) => (b.url ? { type: "button", action_id: `l${i}`, text: label(b.text), url: b.url } : { type: "button", action_id: `b${i}`, text: label(b.text), value: b.data.slice(0, 2000), ...btnStyle(b.data) })) }]
  : []
const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text: cut(text, 3000) } })
const blocks = (text: string, buttons?: Buttons) => [section(text), ...actions(buttons)]

// ---- sending ------------------------------------------------------------------------
const channelOf = (db: DB, name: string) => {
  const id = kv(db, `slack:ch:${name}`)
  if (!id) throw new Error(`no channel for #${name}: run dobby slack setup`)
  return id
}

/** Post as a team member (username + icon). A ticket's first post becomes its thread's root; the rest reply inside it. Returns the message ts. */
export async function post(db: DB, e: Event, text: string, buttons?: Buttons, fetcher: typeof fetch = fetch): Promise<string> {
  const r = route(e)
  const channel = channelOf(db, r.channel)
  const owner = r.channel === "needs-you" ? kv(db, "slack:owner") : undefined
  const thread = r.thread ? kv(db, `slack:thread:${r.thread}`) : undefined
  // Over the block limit: earlier parts go first as plain posts, the last part carries the buttons.
  const parts = chunks(`${owner ? `<@${owner}> ` : ""}${mrkdwn(text)}`, SECTION)
  let first = "", ts = ""
  for (const [i, part] of parts.entries()) {
    const m = await api<{ ts: string }>(null, "chat.postMessage", {
      channel, text: part, blocks: blocks(part, i === parts.length - 1 ? buttons : undefined), username: r.as, icon_url: avatar(r.as),
      thread_ts: thread, unfurl_links: false, unfurl_media: false, // six PR links must not unfurl
    }, fetcher)
    first ||= m.ts
    ts = m.ts
  }
  if (r.thread && !thread) setKv(db, `slack:thread:${r.thread}`, first)
  return ts
}

/** The morning summary: a section per part with dividers, a link button last; when Slack answers with an error, once, the plain messages instead. */
export async function postBrief(db: DB, rich: import("./common.ts").Rich, fetcher: typeof fetch = fetch): Promise<string> {
  const r = route({ kind: "brief" })
  const body = rich.sections.flatMap((t, i) => [...(i ? [{ type: "divider" }] : []), section(mrkdwn(t))])
  try {
    const m = await api<{ ts: string }>(null, "chat.postMessage", {
      channel: channelOf(db, r.channel), text: cut(mrkdwn(rich.sections[0] ?? ""), 300), username: r.as, icon_url: avatar(r.as), unfurl_links: false, unfurl_media: false,
      blocks: [...body, ...actions(rich.link ? [{ text: "Open dashboard", data: "", url: rich.link }] : [])],
    }, fetcher)
    return m.ts
  } catch (e) {
    if ((e as Error).message.includes("no channel")) throw e
    console.log(`brief: Slack refused the blocks message (${(e as Error).message}); sending plain text`)
    let id = ""
    for (const part of rich.plain) id = await post(db, { kind: "brief" }, part, undefined, fetcher)
    return id
  }
}

/** Rewrite one of our messages in place: new text, new buttons (none = buttons removed). Edits never ping. */
export async function edit(db: DB, channel: string, id: string, text: string, buttons?: Buttons, fetcher: typeof fetch = fetch, _thread?: string) {
  const t = cut(mrkdwn(text), SECTION)
  await api(null, "chat.update", { channel: channelOf(db, channel), ts: id, text: t, blocks: blocks(t, buttons) }, fetcher)
}

const gone = (err: unknown) => /message_not_found|channel_not_found/.test((err as Error).message)

/** One message per key (kv slack:msg:<key>), kept current: the first call posts, later calls edit it. Deleted by hand = post a fresh one. */
export async function upsert(db: DB, key: string, e: Event, text: string, buttons?: Buttons, fetcher: typeof fetch = fetch): Promise<string> {
  const id = kv(db, `slack:msg:${key}`)
  if (id) {
    try {
      await edit(db, route(e).channel, id, text, buttons, fetcher)
      return id
    } catch (err) {
      if (!gone(err)) throw err
    }
  }
  const fresh = await post(db, e, text, buttons, fetcher)
  setKv(db, `slack:msg:${key}`, fresh)
  return fresh
}

/** One #needs-you card per key: the same state (first line) edits it quietly; a new state deletes the old card and posts a fresh one, so the owner is pinged once per change. */
export async function prCard(db: DB, key: string, head: string, e: Event, text: string, buttons?: Buttons, fetcher: typeof fetch = fetch): Promise<string> {
  const id = kv(db, `slack:msg:${key}`)
  if (id && kv(db, `slack:msg:${key}:head`) === head) return upsert(db, key, e, text, buttons, fetcher)
  if (id) await api(null, "chat.delete", { channel: channelOf(db, route(e).channel), ts: id }, fetcher).catch(() => {})
  const fresh = await post(db, e, text, buttons, fetcher)
  setKv(db, `slack:msg:${key}`, fresh)
  setKv(db, `slack:msg:${key}:head`, head)
  return fresh
}

/** A ticket thread's first message is its status line (the thread root), edited as the ticket moves (kv slack:msg:ticket:<id>). */
export async function ticketStatus(db: DB, e: Extract<Event, { kind: "ticket" }>, line: string, fetcher: typeof fetch = fetch) {
  const key = `slack:msg:ticket:${e.ticket}`, id = kv(db, key)
  if (kv(db, `slack:status:${e.ticket}`) === line) return
  if (id) {
    try {
      await edit(db, route({ ...e, step: "building" }).channel, id, line, undefined, fetcher)
      return setKv(db, `slack:status:${e.ticket}`, line)
    } catch (err) {
      if (!gone(err)) throw err
    }
  }
  setKv(db, key, await post(db, { ...e, step: e.step === "merged" ? "building" : e.step }, line, undefined, fetcher))
  setKv(db, `slack:status:${e.ticket}`, line)
}
export async function teamStatus(e: Extract<Event, { kind: "ticket" }>, line: string): Promise<void> {
  const db = slackOn()
  if (!db) return
  await ticketStatus(db, e, line).catch((err) => console.log(`slack: ${(err as Error).message}`))
}

/** Team chatter that only exists on chat. No Slack = nothing happens. */
export async function team(e: Event, text: string, buttons?: Buttons): Promise<string | null> {
  const db = slackOn()
  if (!db) return null
  try {
    return await post(db, e, text, buttons)
  } catch (err) {
    console.log(`slack: ${(err as Error).message}`)
    return null
  }
}

/** A new-idea card in #<app>-ideas with 👍/👎 already on it; the owner's reaction decides. */
export async function postIdea(idea: Parameters<typeof ideaCard>[0] & { id: number }) {
  const id = await team({ kind: "idea", project: idea.project }, ideaCard(idea))
  const db = slackOn()
  if (!id || !db) return
  setKv(db, `slack:idea:${id}`, String(idea.id))
  const channel = kv(db, `slack:ch:${route({ kind: "idea", project: idea.project }).channel}`)
  for (const name of ["+1", "-1"]) await api(null, "reactions.add", { channel, timestamp: id, name }).catch(() => {})
}

/** A 👍 on an idea card starts a brainstorm in a thread on it. The thread id is `<channel>:<card ts>`. */
export async function openBrainThread(db: DB, channelId: string, cardId: string, ideaId: number, _title: string): Promise<string> {
  const thread = `${channelId}:${cardId}`
  setKv(db, `slack:brain:${thread}`, String(ideaId))
  return thread
}
/** Say something in a brainstorm thread as the bot (its first message carries the Build it / Drop buttons). */
export const brainSay = (thread: string, text: string, buttons?: Buttons) => {
  const [channel, ts] = thread.split(":"), t = cut(mrkdwn(text), SECTION)
  return api(null, "chat.postMessage", { channel, thread_ts: ts, text: t, blocks: blocks(t, buttons) })
}

/** Write a button's result into the tapped message. `app` is its channel and `token` its ts (set by the listener). False = couldn't; caller posts instead. A failed action keeps the card's buttons. */
export async function answerTap(o: { app: string; token: string; content: string; data: string; components?: unknown[] }, out: string, fetcher: typeof fetch = fetch, ok = true) {
  if (!o.app || !o.token) return false
  try {
    const text = cut(`${o.content}\n\n→ ${mrkdwn(out.trim() || "done")}`, 3000)
    await api(null, "chat.update", { channel: o.app, ts: o.token, text, blocks: [section(text), ...(ok ? [] : (o.components ?? []))] }, fetcher)
    return true
  } catch {
    return false
  }
}

/** Answer in a DM (the front desk reply to a message sent to the bot). */
export const dm = (channel: string, text: string) => { const t = cut(mrkdwn(text), SECTION); return api(null, "chat.postMessage", { channel, text: t, blocks: blocks(t) }) }

// ---- setup --------------------------------------------------------------------------
/** The app manifest the owner pastes at api.slack.com/apps (Create New App, From a manifest). Socket Mode and interactivity on; no public URL. */
export const manifest = (name = "Dobby") => `display_information:
  name: ${name}
  description: Your AI engineering team
features:
  bot_user:
    display_name: ${name}
    always_online: true
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:read
      - chat:write
      - chat:write.customize
      - groups:history
      - groups:read
      - groups:write
      - im:history
      - reactions:read
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.groups
      - message.im
      - reaction_added
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
`

export const inviteUrl = async () => "https://api.slack.com/apps?new_app=1"
export const intentHint = async () => null

export const OWNER_ID = /^[UW][A-Z0-9]{6,}$/
/** Idempotent: creates each channel private (or reuses one this bot created), invites the owner, saves the ids. The owner id comes from kv slack:owner (asked in setup). Returns the workspace name. */
export async function setup(db: DB, fetcher: typeof fetch = fetch, log = (m: string) => console.log(m)) {
  const t = token()
  const call = <T = any>(m: string, b: Record<string, unknown> = {}) => api<T>(t, m, b, fetcher)
  const owner = kv(db, "slack:owner") || readSecrets().SLACK_OWNER_ID // the secrets key is the old way to give it
  if (!owner || !OWNER_ID.test(owner)) throw new Error("no Slack owner: run dobby slack setup in a terminal; it asks for your member ID (Profile, the three dots, Copy member ID)")
  const me = await call<{ team: string }>("auth.test")
  setKv(db, "slack:owner", owner)
  const created = new Set<string>(JSON.parse(kv(db, "slack:created") || "[]"))
  const taken = new Set<string>()
  for (let cursor = ""; ;) {
    const r = await call<{ channels: { id: string; name: string }[]; response_metadata?: { next_cursor?: string } }>("conversations.list", { types: "public_channel,private_channel", exclude_archived: true, limit: 1000, cursor })
    for (const c of r.channels) if (!created.has(c.id)) taken.add(c.name) // names we did not create are not ours to adopt
    if (!(cursor = r.response_metadata?.next_cursor ?? "")) break
  }
  const mine = new Map<string, string>()
  for (const name of CHANNELS) { const id = kv(db, `slack:ch:${name}`); if (id && created.has(id)) mine.set(name, id) }
  for (const name of CHANNELS) {
    let id = mine.get(name)
    if (!id) {
      let pick = taken.has(name) ? `dobby-${name}` : name
      const create = async () => (await call<{ channel: { id: string } }>("conversations.create", { name: pick, is_private: true })).channel.id
      try {
        id = await create()
      } catch (e) {
        if (!/name_taken/.test((e as Error).message) || pick !== name) throw e // a channel we cannot see took the name
        pick = `dobby-${name}`
        id = await create()
      }
      if (pick !== name) log(`slack: #${name} already exists and is not Dobby's, so Dobby created private #${pick}`)
      created.add(id)
      setKv(db, "slack:created", JSON.stringify([...created]))
    }
    if (TOPICS[name]) await call("conversations.setTopic", { channel: id, topic: TOPICS[name].slice(0, 250) }).catch(() => {})
    await call("conversations.invite", { channel: id, users: owner }).catch(() => {}) // already_in_channel is fine
    setKv(db, `slack:ch:${name}`, id)
  }
  return me.team
}

// ---- listening ----------------------------------------------------------------------
export type SlackTap = { value: string; ts: string; channel: string; user: string; text: string; blocks?: { type?: string; text?: { text?: string } }[] }
export type SlackMsg = { text: string; channel: string; ts: string; threadTs?: string; user: string }
export type SlackReaction = { emoji: string; ts: string; channel: string; user: string; added: boolean }

/** Taps, owner messages and reactions in, the same Owned events out. Only the workspace owner is obeyed. */
export function makeFeed(db: DB, handle: (o: Owned) => Promise<void>, fetcher: typeof fetch = fetch, log = (m: string) => console.log(m)) {
  const lane = lanes((m) => log(m.replace(/^discord: /, "slack: ")))
  const owner = () => kv(db, "slack:owner") ?? ""
  const is = (user: string) => !!user && user === owner()
  const run = (o: Owned) => void lane(laneOf(o), () => handle(o))
  const seen = new Set<string>() // @dobby arrives as a message and as app_mention: once
  const inflight = new Set<string>() // message ts with a tap running: a fast second tap must not approve/merge twice
  return {
    tap(t: SlackTap) {
      if (!is(t.user) || !t.value || inflight.has(t.ts)) return Promise.resolve()
      inflight.add(t.ts)
      // no text read back = never rewrite the card (that would wipe it); app "" makes the final answerTap fail and the caller posts instead
      // the card's own section text keeps its line breaks; Slack's flat message.text does not
      const content = (t.blocks ?? []).filter((b) => b.type === "section" && b.text?.text).map((b) => b.text!.text).join("\n") || t.text
      const o: Owned & { kind: "button" } = { kind: "button", data: t.value, id: t.ts, token: t.ts, content, app: t.text ? t.channel : "", components: (t.blocks ?? []).filter((b) => b.type === "actions") }
      return (async () => {
        if (t.text) await answerTap(o, plainAck(db, o.data), fetcher).catch(() => false)
        await lane(laneOf(o), () => handle(o))
      })().catch((e) => log(`slack ack: ${(e as Error).message}`)).finally(() => inflight.delete(t.ts))
    },
    message(m: SlackMsg) {
      const text = m.text.replace(/^\s*<@[UW]\w+>\s*/, "").trim()
      if (!is(m.user) || !text || seen.has(`${m.channel}:${m.ts}`)) return
      seen.add(`${m.channel}:${m.ts}`)
      if (seen.size > 500) seen.delete(seen.values().next().value!)
      const thread = m.threadTs ? `${m.channel}:${m.threadTs}` : ""
      if (thread && kv(db, `slack:brain:${thread}`)) run({ kind: "brain", thread, text })
      else if (m.channel === kv(db, "slack:ch:assistant") || m.channel.startsWith("D")) run({ kind: "ask", text, ...(m.channel.startsWith("D") ? { dm: m.channel } : {}) }) // the assistant channel, or a DM to the bot (answered in the DM)
    },
    reaction(r: SlackReaction) {
      const up = /^(\+1|thumbsup)/.test(r.emoji), down = /^(-1|thumbsdown)/.test(r.emoji)
      const ideas = CHANNELS.filter((c) => c.endsWith("-ideas")).map((c) => kv(db, `slack:ch:${c}`))
      if (r.added && is(r.user) && (up || down) && ideas.includes(r.channel)) run({ kind: "react", messageId: r.ts, channelId: r.channel, up })
    },
  }
}

/** Hook the Chat SDK's handlers to the feed. */
export function attach(chat: Pick<Chat, "onAction" | "onNewMessage" | "onNewMention" | "onReaction">, feed: ReturnType<typeof makeFeed>) {
  chat.onAction(async (e) => {
    const r = e.raw as { channel?: { id?: string }; message?: { ts?: string; text?: string; blocks?: { type?: string }[] }; container?: { channel_id?: string } }
    await feed.tap({ value: String(e.value ?? ""), ts: r.message?.ts ?? e.messageId, channel: r.channel?.id ?? r.container?.channel_id ?? "", user: e.user.userId, text: r.message?.text ?? "", blocks: r.message?.blocks })
  })
  const onMessage = (m: { text: string; author: { userId: string }; raw: unknown }) => {
    const r = m.raw as { channel?: string; ts?: string; thread_ts?: string; text?: string }
    feed.message({ text: String(r?.text ?? m.text), channel: r?.channel ?? "", ts: r?.ts ?? "", threadTs: r?.thread_ts && r.thread_ts !== r.ts ? r.thread_ts : undefined, user: m.author.userId })
  }
  chat.onNewMessage(/[\s\S]*/, (_t, m) => onMessage(m))
  chat.onNewMention((_t, m) => onMessage(m))
  chat.onReaction((e) => feed.reaction({ emoji: e.rawEmoji, ts: e.messageId, channel: (e.raw as { item?: { channel?: string } })?.item?.channel ?? "", user: e.user.userId, added: e.added }))
}

/**
 * Socket Mode through the Chat SDK; never returns. The SDK's socket client reconnects on drops by itself; a start that fails (bad token, Slack down)
 * backs off 1 s to 60 s, a rejected token waits 10 min.
 * ponytail: a token revoked mid-run logs and sits idle until the listener restarts.
 */
export async function listen(db: DB, handle: (o: Owned) => Promise<void>) {
  const { SLACK_BOT_TOKEN: botToken, SLACK_APP_TOKEN: appToken } = readSecrets()
  if (!botToken || !appToken) { console.log("slack: SLACK_BOT_TOKEN and SLACK_APP_TOKEN are not both in secrets.env; not listening (run: dobby add slack)"); return new Promise<never>(() => {}) } // idle: launchd must not crash-loop
  const { Chat } = await import("chat"), { createSlackAdapter } = await import("@chat-adapter/slack"), { createMemoryState } = await import("@chat-adapter/state-memory")
  const feed = makeFeed(db, handle)
  const logger = {
    child: () => logger, debug() {},
    info: (m: string) => { if (/socket mode connected/i.test(m)) console.log("slack: connected") },
    warn: (m: string) => console.log(`slack: ${redact(m)}`),
    error: (m: string, ...a: unknown[]) => console.log(`slack: ${redact(`${m} ${a.map((x) => JSON.stringify(x)).join(" ")}`).slice(0, 200)}`),
  }
  console.log("slack: listening through Chat SDK (Socket Mode)")
  for (let backoff = 1000; ;) {
    try {
      // A fresh Chat + adapter per attempt: Chat caches a failed initialize() forever.
      const chat = new Chat({ userName: "dobby", adapters: { slack: createSlackAdapter({ mode: "socket", appToken, botToken, logger }) }, state: createMemoryState(), logger, concurrency: "concurrent" })
      attach(chat, feed)
      await chat.initialize()
      await new Promise(() => {})
    } catch (e) {
      const msg = redact(String(e))
      console.log(`slack: listener restarting (${msg.slice(0, 120)})`)
      await sleep(/invalid_auth|not_authed|account_inactive|token_revoked/.test(msg) ? 600_000 : backoff + Math.random() * 1000)
      backoff = Math.min(backoff * 2, 60_000)
    }
  }
}

export const slack: Platform = {
  name: "slack", prefix: "slack",
  post, postBrief, edit, upsert, prCard, team, ticketStatus, teamStatus, postIdea, openBrainThread, brainSay, answerTap,
  setup, inviteUrl, intentHint, api: (tok, _method, path, body, fetcher) => api(tok, path, body as Record<string, unknown>, fetcher),
  channels: CHANNELS, listen,
}

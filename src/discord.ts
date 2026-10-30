// Discord: the whole team in one server, each role posting under its own name through a channel webhook.
// Token: DISCORD_BOT_TOKEN in ~/.config/dobby/secrets.env. Channel, webhook, owner and thread ids live in kv (discord:*).
// Not configured (no token, or `dobby discord setup` never ran) = discordOn() is null and notify() writes to outbox.log.
// Only #needs-you is meant to ping the owner (it @mentions them); the owner mutes the rest.
import type { DB } from "./db.ts"
import { open } from "./db.ts"
import { readSecrets, redact, shortTitle, silentAt, type Buttons } from "./notify.ts"
import { getTicket, ideaTitle, short } from "./lib.ts"
import { config, zoned } from "./config.ts"
import { cut, kv, setKv, type Event, type Owned, type Rich, type Step } from "./chat/common.ts"
export { detailsBlock, kv, plainGh, setKv, stepLine, type Event, type Owned, type Rich, type Step } from "./chat/common.ts"

const API = "https://discord.com/api/v10"
// Static layout (owner, 17 Oct): HQ + one category per app; a channel only where something posts today.
// The apps, HQ channels and extra channels come from config (discord.*); the defaults are the owner's layout.
export const APPS: Record<string, { label: string; ideas: boolean }> = config().discord.apps
export const LAYOUT: { category: string; channels: string[] }[] = [
  { category: "📌 HQ", channels: config().discord.hq },
  ...Object.entries(APPS).map(([app, a]) => ({ category: a.label, channels: [`${app}-tickets`, `${app}-releases`, ...(a.ideas ? [`${app}-ideas`] : []), ...(config().discord.extraChannels[app] ?? [])] })),
]
export const CHANNELS = LAYOUT.flatMap((c) => c.channels)
export const TOPICS: Record<string, string> = {
  "needs-you": "Only channel that pings you: approvals, failures, sends", "daily-update": "Chief of Staff: morning and evening update, all apps",
  "system-status": "Site Reliability: background jobs, disk, Dobby's self-fixes", assistant: "Talk to the Assistant (reads Gmail, Calendar, Drive; sends only on your tap)",
  ...Object.fromEntries(Object.keys(APPS).flatMap((a) => [
    [`${a}-tickets`, "One thread per ticket: Engineer, Tester, Code Reviewer, merge"],
    [`${a}-releases`, "What merged and what went live, in plain words"],
    [`${a}-ideas`, a === "dobby" ? "Trainer, nightly: better skills per role + retro fixes. 👍 = install / queue, 👎 = drop" : "Idea cards. 👍 = queue it, 👎 = drop it"],
  ])),
}
// Old flat channels (before 17 Oct) renamed in place so ticket threads keep their history.
// Plain names (owner, 17 Oct): job titles people know, channels that say what's in them.
const RENAMED: Record<string, string> = {
  foreman: "dobby-tickets", "foreman-work": "dobby-tickets", "foreman-tickets": "dobby-tickets",
  "foreman-shipped": "dobby-releases", "foreman-releases": "dobby-releases", "foreman-ideas": "dobby-ideas",
  brief: "daily-update", health: "system-status", ask: "assistant",
}
// Categories renamed in place (new name: old name)
const RENAMED_CATEGORIES: Record<string, string> = { "⚙️ DOBBY": "⚙️ FOREMAN" }
// View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Manage Channels, Manage Webhooks, Read Message History, Add Reactions, Embed Links
export const PERMISSIONS = [10, 11, 38, 35, 4, 29, 16, 6, 14].reduce((n, b) => n | (1n << BigInt(b)), 0n)
// GUILDS, GUILD_MESSAGES, GUILD_MESSAGE_REACTIONS, MESSAGE_CONTENT (privileged: switch it on in the developer portal)
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 10) | (1 << 15)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- routing: which channel, which team member ------------------------------------
export type Route = { channel: string; as: string; thread?: number; threadName?: string }

const FIXED: Record<string, [string, string]> = {
  approval: ["needs-you", "Chief of Staff"], review: ["needs-you", "Code Reviewer"], stuck: ["needs-you", "Chief of Staff"], proposal: ["needs-you", "Assistant"],
  brief: ["daily-update", "Chief of Staff"], health: ["system-status", "Site Reliability"], ask: ["assistant", "Assistant"], team: ["daily-update", "Chief of Staff"],
}
// a project without channels of its own posts to #system-status: #daily-update stays the brief and the digest
const projectChannel = (p: string, kind = "tickets") => (CHANNELS.includes(`${p}-${kind}`) ? `${p}-${kind}` : "system-status")
const lead = (p: string) => `Engineering Manager · ${p}`

export function route(e: Event): Route {
  if (e.kind === "lead") return { channel: projectChannel(e.project), as: lead(e.project) }
  if (e.kind === "program") return { channel: projectChannel(e.project), as: `Program Manager · ${e.project}` }
  if (e.kind === "shipped") return { channel: projectChannel(e.project, "releases"), as: `Engineer · ${e.project}` }
  if (e.kind === "idea") return { channel: projectChannel(e.project, "ideas"), as: e.project === "dobby" ? "Trainer" : `Product Manager · ${e.project}` }
  if (e.kind === "ticket" && e.step === "merged") return { channel: projectChannel(e.project, "releases"), as: `Engineer · ${e.project}` } // the releases feed, not the thread
  if (e.kind === "ticket") {
    const as = e.step === "picked" ? lead(e.project) : e.step === "design" ? `Designer · ${e.project}` : e.step === "check" ? `Tester · ${e.project}` : `Engineer · ${e.project}`
    return { channel: projectChannel(e.project), as, thread: e.ticket, threadName: `${shortTitle(e.title).slice(0, 90)} · #${e.ticket}` }
  }
  const [channel, as] = FIXED[e.kind]
  return { channel, as }
}

// One icon per job title (Twemoji, CC-BY 4.0, by Twitter/jdecked), so each role is recognisable at a glance.
const ICONS: [RegExp, string][] = [
  [/^Tester/, "1f9ea"], [/^Engineer/, "1f6e0"], [/^Code Reviewer/, "1f50e"], [/^Engineering Manager/, "1f9ed"], [/^Product Manager/, "1f4a1"],
  [/^Program Manager/, "1f4c8"], [/^Designer/, "1f3a8"], [/^Chief of Staff/, "1f4cb"], [/^Assistant/, "1f4dd"], [/^Site Reliability/, "1f6a8"], [/^Trainer/, "1f393"],
]
export const avatar = (name: string) => `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/${ICONS.find(([re]) => re.test(name))?.[1] ?? "1f4cb"}.png`

// ---- REST -------------------------------------------------------------------------
/** One Discord call. Waits out a 429 up to twice. Errors never include webhook or interaction tokens. */
export async function api<T = any>(token: string | null, method: string, path: string, body?: unknown, fetcher: typeof fetch = fetch): Promise<T> {
  for (let i = 0; ; i++) {
    const res = await fetcher(`${API}${path}`, {
      method, body: body === undefined ? undefined : redact(JSON.stringify(body)), signal: AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bot ${token}` } : {}) },
    })
    if (res.status === 429 && i < 2) {
      await sleep(Number(((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 1) * 1000)
      continue
    }
    if (!res.ok) throw new Error(`discord ${method} ${path.replace(/(webhooks|interactions)\/(\d+)\/[^/?]+/, "$1/$2/***").split("?")[0]} ${res.status}`)
    return (res.status === 204 ? null : await res.json()) as T
  }
}

let cached: DB | undefined
/** The DB when Discord is set up (token + setup done), else null: callers then skip (outbox.log). */
export function discordOn(): DB | null {
  if (process.env.NODE_TEST_CONTEXT && !process.env.DOBBY_SECRETS) return null // `node --test` without a temp secrets file must never reach the live server
  if (!readSecrets().DISCORD_BOT_TOKEN) return null
  cached ??= open()
  return kv(cached, "discord:wh:needs-you") ? cached : null
}

/** Split on line breaks into pieces of at most max characters. */
export function chunks(s: string, max: number): string[] {
  const out: string[] = []
  let cur = ""
  for (const line of s.split("\n")) {
    if (cur && cur.length + 1 + line.length > max) (out.push(cur), (cur = ""))
    cur = cur ? `${cur}\n${line}` : line
    while (cur.length > max) (out.push(cur.slice(0, max)), (cur = cur.slice(max)))
  }
  return [...out, cur]
}
const style = (data: string) => (/^(stuck)?(decline|discard|dropidea)/.test(data) ? 4 : /^(approve|send|reviewaccept|buildidea)/.test(data) ? 3 : 2) // red, green, grey
// url = a link button (style 5): opens the page, sends nothing back
const components = (buttons?: Buttons) => buttons?.length
  ? [{ type: 1, components: buttons.map((b) => (b.url ? { type: 2, style: 5, label: b.text.slice(0, 80), url: b.url } : { type: 2, style: style(b.data), label: b.text.slice(0, 80), custom_id: b.data.slice(0, 100) })) }]
  : []

/** Post as a team member. A ticket's first post starts its thread; the rest go inside it. Returns the message id. */
export async function post(db: DB, e: Event, text: string, buttons?: Buttons, fetcher: typeof fetch = fetch): Promise<string> {
  const r = route(e)
  const wh = kv(db, `discord:wh:${r.channel}`)
  if (!wh) throw new Error(`no webhook for #${r.channel}: run dobby discord setup`)
  const owner = r.channel === "needs-you" ? kv(db, "discord:owner") : undefined
  const thread = r.thread ? kv(db, `discord:thread:${r.thread}`) : undefined
  // Over Discord's 2000 limit: earlier parts go first as plain posts, the last part carries the buttons (no more "…" mid-sentence).
  const parts = chunks(`${owner ? `<@${owner}> ` : ""}${text}`, 1990)
  for (const part of parts.slice(0, -1)) {
    await api(null, "POST", `/webhooks/${wh}?wait=true${thread ? `&thread_id=${thread}` : ""}`, { content: part, username: r.as, avatar_url: avatar(r.as), allowed_mentions: { parse: [], users: owner ? [owner] : [] }, flags: (silentAt(zoned().getUTCHours()) ? 4096 : 0) | (e.kind === "brief" ? 4 : 0) }, fetcher)
  }
  text = parts.at(-1)!
  const msg = await api<{ id: string; channel_id: string }>(null, "POST", `/webhooks/${wh}?wait=true&with_components=true${thread ? `&thread_id=${thread}` : ""}`, {
    content: cut(text, 2000),
    username: r.as, avatar_url: avatar(r.as),
    allowed_mentions: { parse: [], users: owner ? [owner] : [] },
    flags: (silentAt(zoned().getUTCHours()) ? 4096 : 0) | (e.kind === "brief" ? 4 : 0), // SUPPRESS_NOTIFICATIONS in quiet hours; SUPPRESS_EMBEDS: six PR links must not unfurl
    components: buttons?.length ? components(buttons) : undefined,
  }, fetcher)
  if (r.thread && !thread) {
    // ponytail: threads auto-archive after 7 days; a post via thread_id reopens them. Ticket threads older than that just start fresh if Discord refuses.
    const t = await api<{ id: string }>(readSecrets().DISCORD_BOT_TOKEN, "POST", `/channels/${msg.channel_id}/messages/${msg.id}/threads`, { name: r.threadName, auto_archive_duration: 10080 }, fetcher)
    setKv(db, `discord:thread:${r.thread}`, t.id)
  }
  return msg.id
}

/** The Components V2 body: one Container, a TextDisplay per section with dividers between, a link button last. No `content` (V2 forbids it). */
export function briefPayload(rich: Rich, quiet: boolean, r: { as: string }) {
  const body = rich.sections.flatMap((text, i) => [...(i ? [{ type: 14, divider: true, spacing: 1 }] : []), { type: 10, content: text }])
  const row = rich.link ? [{ type: 1, components: [{ type: 2, style: 5, label: "Open dashboard", url: rich.link }] }] : []
  return { flags: 32768 | (quiet ? 4096 : 0), username: r.as, avatar_url: avatar(r.as), allowed_mentions: { parse: [] }, components: [{ type: 17, accent_color: 0x3ddc84, components: [...body, ...row] }] }
}

/** The morning summary: a Components V2 message; when Discord answers 4xx, once, the plain Markdown messages instead (the reason is logged). */
export async function postBrief(db: DB, rich: Rich, fetcher: typeof fetch = fetch): Promise<string> {
  const r = route({ kind: "brief" })
  const wh = kv(db, `discord:wh:${r.channel}`)
  if (!wh) throw new Error(`no webhook for #${r.channel}: run dobby discord setup`)
  try {
    const msg = await api<{ id: string }>(null, "POST", `/webhooks/${wh}?wait=true&with_components=true`, briefPayload(rich, silentAt(zoned().getUTCHours()), r), fetcher)
    return msg.id
  } catch (e) {
    if (!/ 4\d\d$/.test((e as Error).message)) throw e
    console.log(`brief: Discord refused the components message (${(e as Error).message}); sending plain Markdown`)
    let id = ""
    for (const part of rich.plain) id = await post(db, { kind: "brief" }, part, undefined, fetcher)
    return id
  }
}

/** Rewrite one of our webhook messages in place: new text, new buttons (none = buttons removed). Edits never ping. */
export async function edit(db: DB, channel: string, id: string, text: string, buttons?: Buttons, fetcher: typeof fetch = fetch, thread?: string) {
  const wh = kv(db, `discord:wh:${channel}`)
  if (!wh) throw new Error(`no webhook for #${channel}: run dobby discord setup`)
  await api(null, "PATCH", `/webhooks/${wh}/messages/${id}?with_components=true${thread ? `&thread_id=${thread}` : ""}`, { content: cut(text, 2000), allowed_mentions: { parse: [] }, components: components(buttons) }, fetcher)
}

/** One message per key (kv discord:msg:<key>), kept current: the first call posts, later calls edit it. Deleted by hand = post a fresh one. */
export async function upsert(db: DB, key: string, e: Event, text: string, buttons?: Buttons, fetcher: typeof fetch = fetch): Promise<string> {
  const id = kv(db, `discord:msg:${key}`)
  if (id) {
    try {
      await edit(db, route(e).channel, id, text, buttons, fetcher)
      return id
    } catch (err) {
      if (!/ 404$/.test((err as Error).message)) throw err
    }
  }
  const fresh = await post(db, e, text, buttons, fetcher)
  setKv(db, `discord:msg:${key}`, fresh)
  return fresh
}

/**
 * One #needs-you card per key (a PR: pr:<repo>#<n>; a project's deploy: deploy:<name>). The same state (first line) edits the card quietly; a new state
 * deletes the old card and posts a fresh one, so the owner is pinged once per change, not once per message.
 */
export async function prCard(db: DB, key: string, head: string, e: Event, text: string, buttons?: Buttons, fetcher: typeof fetch = fetch): Promise<string> {
  const id = kv(db, `discord:msg:${key}`)
  if (id && kv(db, `discord:msg:${key}:head`) === head) return upsert(db, key, e, text, buttons, fetcher)
  const wh = kv(db, `discord:wh:${route(e).channel}`)
  if (id && wh) await api(null, "DELETE", `/webhooks/${wh}/messages/${id}`, undefined, fetcher).catch(() => {})
  const fresh = await post(db, e, text, buttons, fetcher)
  setKv(db, `discord:msg:${key}`, fresh)
  setKv(db, `discord:msg:${key}:head`, head)
  return fresh
}

/**
 * A ticket thread's first message is its status line, edited as the ticket moves (kv discord:msg:ticket:<id>).
 * Posted first, it starts the thread; a message in the channel itself needs no thread_id to edit, one inside the thread does.
 */
export async function ticketStatus(db: DB, e: Extract<Event, { kind: "ticket" }>, line: string, fetcher: typeof fetch = fetch) {
  const key = `discord:msg:ticket:${e.ticket}`, id = kv(db, key), thread = kv(db, `discord:thread:${e.ticket}`)
  if (kv(db, `discord:status:${e.ticket}`) === line) return
  const at = route({ ...e, step: "building" }).channel
  for (const th of id ? [undefined, thread] : []) {
    try {
      await edit(db, at, id!, line, undefined, fetcher, th)
      return setKv(db, `discord:status:${e.ticket}`, line)
    } catch (err) {
      if (!/ 404$/.test((err as Error).message)) throw err
    }
  }
  setKv(db, key, await post(db, { ...e, step: e.step === "merged" ? "building" : e.step }, line, undefined, fetcher))
  setKv(db, `discord:status:${e.ticket}`, line)
}
export async function teamStatus(e: Extract<Event, { kind: "ticket" }>, line: string): Promise<void> {
  const db = discordOn()
  if (!db) return
  await ticketStatus(db, e, line).catch((err) => console.log(`discord: ${(err as Error).message}`))
}

/** Team chatter that only exists on Discord (ticket threads, Lead reports, idea cards). No Discord = nothing happens. */
export async function team(e: Event, text: string, buttons?: Buttons): Promise<string | null> {
  const db = discordOn()
  if (!db) return null
  try {
    return await post(db, e, text, buttons)
  } catch (err) {
    console.log(`discord: ${(err as Error).message}`)
    return null
  }
}

/** A new-idea card in #<app>-ideas with 👍/👎 already on it; the owner's reaction decides. Discord markdown: bold title, quoted pitch, small footer. */
export const ideaCard = (i: { project: string; title: string; pitch?: string | null; why?: string | null; how?: string | null; experiment?: string | null; size?: string | null }) =>
  [
    `## 💡 ${i.title}`,
    i.pitch && `> ${i.pitch}`,
    i.why && `**Why now:** ${i.why}`,
    i.how && `**How it works:** ${i.how}`,
    i.experiment && `**First test:** ${i.experiment}`,
    `-# ${i.project}${i.size ? ` · size ${i.size}` : ""} · 👍 build it · 👎 drop it`,
  ].filter(Boolean).join("\n\n")
export async function postIdea(idea: { id: number; project: string; title: string; pitch?: string | null; why?: string | null; how?: string | null; experiment?: string | null; size?: string | null }) {
  const id = await team({ kind: "idea", project: idea.project }, ideaCard(idea))
  const db = discordOn()
  if (!id || !db) return
  setKv(db, `discord:idea:${id}`, String(idea.id))
  const token = readSecrets().DISCORD_BOT_TOKEN
  for (const e of ["👍", "👎"]) await api(token, "PUT", `/channels/${kv(db, `discord:ch:${route({ kind: "idea", project: idea.project }).channel}`)}/messages/${id}/reactions/${encodeURIComponent(e)}/@me`).catch(() => {})
}

/** A 👍 on an idea card opens a thread on it (owner, 18 Oct: brainstorm first, build only on "go"). Returns the thread id. */
export async function openBrainThread(db: DB, channelId: string, cardId: string, ideaId: number, title: string): Promise<string> {
  const t = await api<{ id: string }>(token(), "POST", `/channels/${channelId}/messages/${cardId}/threads`, { name: `Brainstorm: ${title}`.slice(0, 100), auto_archive_duration: 10080 })
  setKv(db, `discord:brain:${t.id}`, String(ideaId))
  return t.id
}
/** Say something in a brainstorm thread as the bot (its first message carries the Build it / Drop buttons). */
export const brainSay = (thread: string, text: string, buttons?: Buttons) =>
  api(token(), "POST", `/channels/${thread}/messages`, { content: cut(text, 2000), allowed_mentions: { parse: [] }, components: components(buttons) })

// ---- setup ------------------------------------------------------------------------
export async function inviteUrl(fetcher: typeof fetch = fetch) {
  const app = await api<{ id: string }>(token(), "GET", "/oauth2/applications/@me", undefined, fetcher)
  return `https://discord.com/oauth2/authorize?client_id=${app.id}&scope=bot+applications.commands&permissions=${PERMISSIONS}`
}

/** Null when the Message Content intent is on (flags 1<<18, or 1<<19 for an app not yet verified), else the sentence that says where to switch it on. Without it the listener loops on gateway close 4014. */
export async function intentHint(fetcher: typeof fetch = fetch): Promise<string | null> {
  const app = await api<{ id: string; flags?: number }>(token(), "GET", "/applications/@me", undefined, fetcher)
  return (app.flags ?? 0) & ((1 << 18) | (1 << 19)) ? null : `Turn on the Message Content intent (Privileged Gateway Intents) at https://discord.com/developers/applications/${app.id}/bot, or buttons and replies will not work.`
}

function token() {
  const t = readSecrets().DISCORD_BOT_TOKEN
  if (!t) throw new Error("no DISCORD_BOT_TOKEN in ~/.config/dobby/secrets.env")
  return t
}

/** Idempotent: finds the one server, creates missing channels and one webhook each, saves the ids. */
export async function setup(db: DB, fetcher: typeof fetch = fetch) {
  const t = token()
  const call = <T = any>(m: string, p: string, b?: unknown) => api<T>(t, m, p, b, fetcher)
  const me = await call<{ id: string }>("GET", "/users/@me")
  const guilds = await call<{ id: string }[]>("GET", "/users/@me/guilds")
  if (guilds.length !== 1) throw new Error(`the bot is in ${guilds.length} servers; it needs exactly one (dobby discord invite)`)
  const guild = await call<{ id: string; name: string; owner_id: string }>("GET", `/guilds/${guilds[0].id}`)
  setKv(db, "discord:guild", guild.id)
  setKv(db, "discord:owner", guild.owner_id)
  const existing = await call<{ id: string; name: string; type: number; parent_id?: string | null }[]>("GET", `/guilds/${guild.id}/channels`)
  const text = (name: string) => existing.find((c) => c.type === 0 && c.name === name)
  for (const [i, group] of LAYOUT.entries()) {
    const oldCat = existing.find((c) => c.type === 4 && c.name === RENAMED_CATEGORIES[group.category])
    if (oldCat && !existing.some((c) => c.type === 4 && c.name === group.category)) oldCat.name = (await call<{ name: string }>("PATCH", `/channels/${oldCat.id}`, { name: group.category })).name
    const cat = existing.find((c) => c.type === 4 && c.name === group.category) ?? (await call<{ id: string }>("POST", `/guilds/${guild.id}/channels`, { name: group.category, type: 4, position: i }))
    for (const name of group.channels) {
      const old = Object.entries(RENAMED).find(([from, to]) => to === name && text(from) && !text(to))?.[0]
      const found = text(name) ?? (old ? text(old) : undefined)
      // existing channel: right name, topic and category (a rename keeps its threads); missing: create it there
      const ch = found
        ? await call<{ id: string }>("PATCH", `/channels/${found.id}`, { name, topic: TOPICS[name], parent_id: cat.id })
        : await call<{ id: string }>("POST", `/guilds/${guild.id}/channels`, { name, type: 0, topic: TOPICS[name], parent_id: cat.id })
      await hook(name, ch.id)
    }
  }
  return guild.name

  async function hook(name: string, id: string) {
    const hooks = await call<{ id: string; token?: string; user?: { id: string } }[]>("GET", `/channels/${id}/webhooks`)
    const wh = hooks.find((h) => h.user?.id === me.id && h.token) ?? (await call<{ id: string; token: string }>("POST", `/channels/${id}/webhooks`, { name: "Dobby" }))
    setKv(db, `discord:ch:${name}`, id)
    setKv(db, `discord:wh:${name}`, `${wh.id}/${wh.token}`)
  }
}

// ---- gateway ----------------------------------------------------------------------
/** The gateway events Dobby acts on, and only when the server owner made them. Everything else is null. */
export function ownerEvent(t: string, d: any, owner: string, ch: { ask?: string; ideas?: string[]; brain?: (thread: string) => boolean }): Owned | null {
  if (!owner || !d) return null
  if (t === "INTERACTION_CREATE" && d.type === 3 && (d.member?.user?.id ?? d.user?.id) === owner && d.data?.custom_id)
    return { kind: "button", data: d.data.custom_id, id: d.id, token: d.token, content: d.message?.content ?? "", app: d.application_id ?? "", ...(Array.isArray(d.message?.components) ? { components: d.message.components } : {}) }
  if (t === "MESSAGE_CREATE" && d.author?.id === owner && !d.webhook_id && d.channel_id === ch.ask && d.content?.trim()) return { kind: "ask", text: d.content.trim() }
  if (t === "MESSAGE_CREATE" && d.author?.id === owner && !d.webhook_id && d.content?.trim() && ch.brain?.(d.channel_id)) return { kind: "brain", thread: d.channel_id, text: d.content.trim() }
  if (t === "MESSAGE_REACTION_ADD" && d.user_id === owner && (ch.ideas ?? []).includes(d.channel_id) && ["👍", "👎"].includes(d.emoji?.name))
    return { kind: "react", messageId: d.message_id, channelId: d.channel_id, up: d.emoji.name === "👍" }
  return null
}

/** A button's data in plain words, naming the thing it acts on: `Merging "Sign-in full state"…`. */
export function plainAck(db: DB | undefined, data: string): string {
  const d = data.trim(), id = Number(d.match(/^\w+\s+(\d+)$/)?.[1])
  const t = db && id ? getTicket(db, id) : undefined, name = t ? `"${short(t.title)}"` : "that"
  const idea = db && id ? ideaTitle(db, id) : undefined, ideaName = idea ? `"${short(idea)}"` : "that idea"
  const m = d.match(/^(\w[\w-]*)/)?.[1].toLowerCase()
  switch (m) {
    case "approve": return `Merging ${name}…`
    case "decline": return `Dropping ${name}…`
    case "queue": return `Queuing ${name} for an Engineer…`
    case "buildidea": return `Turning ${ideaName} into a ticket…`
    case "dropidea": return `Dropping ${ideaName}…`
    case "undoidea": return `Bringing back ${ideaName}…`
    case "send": return "Sending the draft…"
    case "discard": return "Throwing the draft away…"
    case "reviewfix": return "An Engineer is fixing what the review found…"
    case "reviewaccept": return "Marking the review passed…"
    case "deploynow": return `Deploying ${d.split(/\s+/)[1] ?? "it"}${/\bmigrate\b/.test(d) ? " with its migration" : ""}…`
    case "keepgoing": return `Builders keep going up to ${d.match(/(\d+)/)?.[1] ?? "more"}% of this window…`
    case "undo-scout": return "Undoing that change…"
    default: return "Working on it…"
  }
}

/** Answer a button press at once (3 s limit): the buttons go away so a second tap can't repeat it. */
export const ack = (o: { id: string; token: string; content: string; data: string }, fetcher: typeof fetch = fetch, db?: DB) =>
  api(null, "POST", `/interactions/${o.id}/${o.token}/callback`, { type: 7, data: { content: cut(`${o.content}\n\n→ ${plainAck(db, o.data)}`, 2000), components: [] } }, fetcher)

/** Write a button's result into the tapped message (the interaction token lasts 15 minutes). False = couldn't; caller posts instead. A failed action (`ok` false) keeps the card's buttons so the tap can be tried again. */
export async function answerTap(o: { app: string; token: string; content: string; data: string; components?: unknown[] }, out: string, fetcher: typeof fetch = fetch, ok = true) {
  if (!o.app) return false
  try {
    await api(null, "PATCH", `/webhooks/${o.app}/${o.token}/messages/@original`, { content: cut(`${o.content}\n\n→ ${out.trim() || "done"}`, 2000), components: ok ? [] : (o.components ?? []) }, fetcher)
    return true
  } catch {
    return false
  }
}

const FATAL = [4004, 4010, 4011, 4012, 4013, 4014] // bad token, bad shard/intents: retrying fast won't help

/**
 * Always-on Gateway connection: heartbeat, resume after a drop, fresh identify when the session is gone, backoff 1 s → 60 s.
 * Owner events run one at a time, in order.
 * ponytail: the ticket graph's spawnSync (git push, gh) can block heartbeats for a minute; Discord then drops us and we resume.
 */
/**
 * Which owner events must wait for each other (audit #15: one slow merge held every other tap). Same lane = serial: taps on the
 * same ticket, PR or project ("approve 12" and "queue 12"; "reviewfix a/b 3"; "deploynow web"), one brainstorm thread, one idea
 * card, and the front desk (its history is one conversation). Different lanes run at once. DOBBY_LISTEN_SERIAL=1: one lane, as before.
 */
const TYPED_ACTION = /^\s*(approve|decline|cancel|queue|reviewfix|reviewaccept|deploynow|scoutmerge|scoutreject|send|discard|buildidea|dropidea|undoidea|undo-scout)\s+\S/i
export function laneOf(o: Owned, env = process.env): string {
  if (env.DOBBY_LISTEN_SERIAL === "1") return "all"
  if (o.kind === "button") {
    const [verb, a, b] = o.data.trim().split(/\s+/)
    return `button:${a && /^[\w.-]+\/[\w.-]+$/.test(a) ? `${a}#${b}` : (a ?? verb).replace(/^#/, "")}`
  }
  // an owner command typed in #assistant ("approve 12") shares the lane of the same button
  if (o.kind === "ask" && TYPED_ACTION.test(o.text)) return laneOf({ kind: "button", data: o.text, id: "", token: "", content: "", app: "" }, env)
  if (o.kind === "brain") return `brain:${o.thread}`
  if (o.kind === "react") return `idea:${o.messageId}`
  return "ask"
}
/** A queue per lane: `run(key, job)` starts `job` after the earlier jobs of the same key; errors are logged, never stop a lane. */
export function lanes(log = (m: string) => console.log(m)) {
  const tails = new Map<string, Promise<void>>()
  return (key: string, job: () => Promise<void>) => {
    const next = (tails.get(key) ?? Promise.resolve()).then(job).catch((e) => log(`discord: ${(e as Error).message}`))
    tails.set(key, next)
    void next.then(() => { if (tails.get(key) === next) tails.delete(key) })
    return next
  }
}

export async function listen(db: DB, handle: (o: Owned) => Promise<void>) {
  const t = token()
  const owner = kv(db, "discord:owner") ?? ""
  const ch = { brain: (id: string) => !!kv(db, `discord:brain:${id}`), ask: kv(db, "discord:ch:assistant"), ideas: CHANNELS.filter((c) => c.endsWith("-ideas")).map((c) => kv(db, `discord:ch:${c}`)).filter((x): x is string => !!x) }
  let seq: number | null = null, session = "", resumeUrl = "", backoff = 1000
  const lane = lanes()
  for (;;) {
    let url = resumeUrl
    if (!url) url = (await api<{ url: string }>(t, "GET", "/gateway/bot").catch(() => ({ url: "" }))).url
    const code = !url ? 0 : await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${url}/?v=10&encoding=json`)
      let beat: ReturnType<typeof setInterval> | undefined, acked = true
      const send = (op: number, d: unknown) => ws.send(JSON.stringify({ op, d }))
      ws.onmessage = (m) => {
        const p = JSON.parse(String(m.data)) as { op: number; d: any; s?: number; t?: string }
        if (p.s) seq = p.s
        if (p.op === 10) {
          // no ack since the last beat = a zombie connection: close (4000 keeps the session resumable) and resume
          beat = setInterval(() => (acked ? ((acked = false), send(1, seq)) : ws.close(4000)), p.d.heartbeat_interval)
          if (session) send(6, { token: t, session_id: session, seq })
          else send(2, { token: t, intents: INTENTS, properties: { os: "darwin", browser: "foreman", device: "foreman" } })
        } else if (p.op === 11) acked = true
        else if (p.op === 1) send(1, seq)
        else if (p.op === 7) ws.close(4000)
        else if (p.op === 9) {
          if (!p.d) (session = ""), (resumeUrl = ""), (seq = null)
          ws.close(4000)
        } else if (p.op === 0) {
          if (p.t === "READY") (session = p.d.session_id), (resumeUrl = p.d.resume_gateway_url), console.log("discord: connected")
          if (p.t === "READY" || p.t === "RESUMED") backoff = 1000
          const o = ownerEvent(p.t ?? "", p.d, owner, ch)
          // Buttons must be acknowledged within 3 s: do it now, before the queue (which may be busy merging).
          if (o?.kind === "button") void ack(o, fetch, db).catch((e) => console.log(`discord ack: ${(e as Error).message}`))
          if (o) void lane(laneOf(o), () => handle(o))
        }
      }
      ws.onerror = () => {} // onclose follows
      ws.onclose = (e) => (clearInterval(beat), resolve(e.code))
    })
    if (FATAL.includes(code)) {
      console.log(`discord: gateway closed ${code} (4004 = bad token, 4014 = switch on Message Content intent); retry in 10 min`)
      session = resumeUrl = ""
      await sleep(600_000)
      continue
    }
    if (code === 4007 || code === 4009) (session = ""), (resumeUrl = ""), (seq = null) // bad seq / session timed out: identify fresh
    await sleep(backoff + Math.random() * 1000)
    backoff = Math.min(backoff * 2, 60_000)
  }
}

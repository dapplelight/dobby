// Discord listening through Chat SDK (gateway-only: no Interactions Endpoint URL, startGatewayListener without webhookUrl).
// Sends stay on the webhooks in discord.ts (the SDK posts only as the single bot, which would lose the role personas).
import { Chat, type Logger } from "chat"
import { DiscordAdapter } from "@chat-adapter/discord"
import { createMemoryState } from "@chat-adapter/state-memory"
import type { DB } from "../db.ts"
import { api, answerTap, CHANNELS, kv, laneOf, lanes, ownerEvent, plainAck, type Owned } from "../discord.ts"
import { readSecrets, redact } from "../notify.ts"
import type { Msg, Tap } from "./platform.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const WEEK = 7 * 24 * 3600_000 // a run ends on a gateway drop (see below), not on a timer; setTimeout caps near 24 days

let cachedAppId = ""
/** The application id, from the bot token (GET /oauth2/applications/@me); cached in memory. No setup question. */
export async function appId(token: string, fetcher: typeof fetch = fetch): Promise<string> {
  return (cachedAppId ||= (await api<{ id: string }>(token, "GET", "/oauth2/applications/@me", undefined, fetcher)).id)
}
export const resetAppId = () => { cachedAppId = "" }

/** Taps, owner messages and reactions in, the same Owned events out; every owner-only check stays in ownerEvent. */
export function makeFeed(db: DB, handle: (o: Owned) => Promise<void>, fetcher: typeof fetch = fetch, log = (m: string) => console.log(m)) {
  const lane = lanes(log)
  const ch = () => ({ brain: (id: string) => !!kv(db, `discord:brain:${id}`), ask: kv(db, "discord:ch:assistant"), ideas: CHANNELS.filter((c) => c.endsWith("-ideas")).map((c) => kv(db, `discord:ch:${c}`)).filter((x): x is string => !!x) })
  const emit = (t: string, d: unknown) => {
    const o = ownerEvent(t, d, kv(db, "discord:owner") ?? "", ch())
    if (o) void lane(laneOf(o), () => handle(o))
    return o
  }
  const inflight = new Set<string>() // message ids with a tap running: a fast second tap must not approve/merge twice
  return {
    emit,
    /** A button tap. The SDK already deferred it (type 6); here the message's own text is read back and the buttons are replaced by the ack line, as before. */
    tap(t: Tap & { id: string; token: string; app: string }) {
      const probe = ownerEvent("INTERACTION_CREATE", { type: 3, id: t.id, token: t.token, application_id: t.app, user: { id: t.userId }, data: { custom_id: t.customId } }, kv(db, "discord:owner") ?? "", ch())
      if (probe?.kind !== "button" || inflight.has(t.messageId)) return Promise.resolve()
      inflight.add(t.messageId)
      return (async () => {
        const m = await api<{ content?: string; components?: unknown[] }>(readSecrets().DISCORD_BOT_TOKEN, "GET", `/channels/${t.channelId}/messages/${t.messageId}`, undefined, fetcher).catch(() => null)
        // GET failed: the card's text is unknown, so never PATCH it (that would wipe it). app "" makes the final answerTap fail, and cli posts the result instead.
        const o = { ...probe, content: m?.content ?? "", ...(Array.isArray(m?.components) ? { components: m.components } : {}), ...(m ? {} : { app: "" }) }
        if (m) await answerTap(o, plainAck(db, o.data), fetcher).catch(() => false)
        await lane(laneOf(o), () => handle(o))
      })().catch((e) => log(`discord ack: ${(e as Error).message}`)).finally(() => inflight.delete(t.messageId))
    },
    message: (m: Msg) => emit("MESSAGE_CREATE", { author: { id: m.userId }, channel_id: m.channelId, content: m.text }),
  }
}

/** The gateway events Dobby reads, plus reactions straight off the raw packet: discord.js drops reactions on messages it has not cached (every card posted before this connection). */
class DobbyDiscord extends DiscordAdapter {
  onReaction: (d: unknown) => void = () => {}
  onDown: (why: string) => void = () => {}
  protected override async createDiscordThread() { return { id: undefined as unknown as string, name: "" } } // an @dobby mention must not spawn a thread: the message stays in its channel
  protected override setupLegacyGatewayHandlers(client: Parameters<DiscordAdapter["setupLegacyGatewayHandlers"]>[0], isShuttingDown: () => boolean) {
    super.setupLegacyGatewayHandlers(client, isShuttingDown)
    client.on("shardDisconnect", (e: { code?: number }) => this.onDown(`gateway closed ${e?.code ?? ""}`))
    client.on("invalidated", () => this.onDown("session invalidated"))
    client.on("raw", (p: { t?: string; d: unknown }) => { if (p.t === "MESSAGE_REACTION_ADD" && !isShuttingDown()) this.onReaction(p.d) })
  }
  protected override async handleGatewayReaction() {} // replaced by the raw handler above
}

/** Run `once` (one listener of `durationMs`) forever: a short run backs off 1 s → 60 s, a full one restarts at once. 4014/4004 wait 10 min with the old hint. */
export async function runForever(once: () => Promise<{ error?: string }>, o: { durationMs: number; sleep?: (ms: number) => Promise<unknown>; log?: (m: string) => void; stop?: () => boolean }) {
  const nap = o.sleep ?? sleep, log = o.log ?? ((m: string) => console.log(m))
  let backoff = 1000
  while (!o.stop?.()) {
    const t0 = Date.now()
    const { error = "" } = await once().catch((e) => ({ error: String(e) }))
    if (o.stop?.()) return
    const fatal = /4014|disallowed ?intents?|privileged intent/i.test(error) ? 4014 : /4004|token ?invalid|invalid token|improper token|authentication failed|applications\/@me 401/i.test(error) ? 4004 : 0
    if (fatal) {
      log(`discord: gateway closed ${fatal} (4004 = bad token, 4014 = switch on Message Content intent); retry in 10 min`)
      await nap(600_000)
      continue
    }
    if (Date.now() - t0 >= o.durationMs * 0.9) backoff = 1000
    else (await nap(backoff + Math.random() * 1000)), (backoff = Math.min(backoff * 2, 60_000))
    log(`discord: listener restarting${error ? ` (${redact(error).slice(0, 120)})` : ""}`)
  }
}

export async function listenSdk(db: DB, handle: (o: Owned) => Promise<void>, o: { fetcher?: typeof fetch; durationMs?: number } = {}) {
  const token = readSecrets().DISCORD_BOT_TOKEN
  const fetcher = o.fetcher ?? fetch, durationMs = o.durationMs ?? WEEK
  const feed = makeFeed(db, handle, fetcher)
  let lastError = ""
  const logger: Logger = {
    child: () => logger, debug() {},
    info: (m) => { if (/gateway connected/i.test(m)) console.log("discord: connected") },
    warn: (m) => console.log(`discord: ${redact(m)}`),
    error: (m, ...a) => { lastError = `${m} ${a.map((x) => JSON.stringify(x)).join(" ")}`; console.log(`discord: ${redact(lastError).slice(0, 200)}`) },
  }
  const onMessage = (m: { text: string; author: { userId: string }; raw: unknown }, threadId: string) => {
    const raw = m.raw as { content?: string; channel_id?: string } | undefined
    void feed.message({ text: String(raw?.content ?? m.text), channelId: raw?.channel_id ?? "", threadId, userId: m.author.userId })
  }
  console.log("discord: listening through Chat SDK")
  await runForever(async () => {
    lastError = ""
    // A fresh Chat + adapter per run: Chat caches a failed initialize() forever. The app id is fetched first, so a Discord blip throws here and runForever backs off.
    const applicationId = await appId(token, fetcher)
    const adapter = new DobbyDiscord({
      botToken: token, applicationId, logger,
      webhookVerifier: () => { throw new Error("gateway only: no interactions endpoint") }, // required by the adapter, never used
    })
    const stop = new AbortController()
    adapter.onReaction = (d) => feed.emit("MESSAGE_REACTION_ADD", d)
    adapter.onDown = (why) => { lastError ||= why; stop.abort() } // end the run so the loop reconnects now instead of waiting for the timer
    const chat = new Chat({ userName: "dobby", adapters: { discord: adapter }, state: createMemoryState(), logger, concurrency: "concurrent" })
    chat.onAction(async (e) => {
      const r = e.raw as { id?: string; token?: string; application_id?: string; channel_id?: string; data?: { custom_id?: string } }
      await feed.tap({ customId: r.data?.custom_id ?? "", messageId: e.messageId, channelId: r.channel_id ?? "", userId: e.user.userId, id: r.id ?? "", token: r.token ?? "", app: r.application_id ?? "" })
    })
    // The raw channel_id, not the thread id: the channel Discord reports, whatever thread the SDK maps the message to.
    chat.onNewMessage(/[\s\S]*/, (thread, m) => onMessage(m, thread.id))
    chat.onNewMention((thread, m) => onMessage(m, thread.id))
    await chat.initialize()
    let done: Promise<unknown> = Promise.resolve()
    await adapter.startGatewayListener({ waitUntil: (p) => { done = p } }, durationMs, stop.signal) // no webhookUrl: handled in-process
    await done
    return { error: lastError }
  }, { durationMs })
}

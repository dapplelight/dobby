// One messaging interface. Outbound = the operations Dobby already uses; inbound = taps, owner messages and reactions fed to the
// existing handler. A new platform (Telegram…) is one more object of this shape. Discord is the default; Slack (beta) is picked by chat.platform (`as` overrides it: dobby add discord|slack follows the command typed).
import type { DB } from "../db.ts"
import { config } from "../config.ts"
import type { Buttons } from "../notify.ts"
import * as d from "../discord.ts"
import type { Event, Owned, Rich } from "./common.ts"
import { slack, slackOn } from "./slack.ts"

const useSlack = () => config().chat?.platform === "slack"
/** The kv key prefix of the active platform (sync twin of platform().prefix). */
export const chatPrefix = () => (useSlack() ? "slack" : "discord")
/** The DB when chat is set up (token + setup done), else null: callers then skip (outbox.log). */
export const chatOn = (): DB | null => (useSlack() ? slackOn() : d.discordOn())
/** Which channel and persona an event posts as. */
export const route = d.route

/** What a platform reports from its side, before Dobby's owner checks. */
export type Tap = { customId: string; messageId: string; channelId: string; userId: string }
export type Msg = { text: string; channelId: string; threadId: string; userId: string }

export type Platform = {
  name: string
  /** The kv key prefix this platform stores its ids under (`<prefix>:idea:<message>`, `<prefix>:brain:<thread>`). */
  prefix: string
  /** Post as the event's role (channel + persona). Returns the message id. */
  post(db: DB, e: Event, text: string, buttons?: Buttons, fetcher?: typeof fetch): Promise<string>
  postBrief(db: DB, rich: Rich, fetcher?: typeof fetch): Promise<string>
  edit(db: DB, channel: string, id: string, text: string, buttons?: Buttons, fetcher?: typeof fetch, thread?: string): Promise<unknown>
  upsert(db: DB, key: string, e: Event, text: string, buttons?: Buttons, fetcher?: typeof fetch): Promise<string>
  prCard(db: DB, key: string, head: string, e: Event, text: string, buttons?: Buttons, fetcher?: typeof fetch): Promise<string>
  /** Team chatter that only exists on chat (ticket threads, Lead reports, idea cards). Not set up = null. */
  team(e: Event, text: string, buttons?: Buttons): Promise<string | null>
  /** The ticket thread's one status line, edited as the ticket moves. */
  ticketStatus: typeof d.ticketStatus
  /** Same, skipped when chat is not set up; errors are logged. */
  teamStatus: typeof d.teamStatus
  postIdea: typeof d.postIdea
  openBrainThread: typeof d.openBrainThread
  brainSay: typeof d.brainSay
  /** Write a button's result into the tapped message. False = couldn't; caller posts instead. */
  answerTap: typeof d.answerTap
  /** Idempotent: channels and webhooks, ids saved. Returns the server name. */
  setup: typeof d.setup
  inviteUrl: typeof d.inviteUrl
  intentHint: typeof d.intentHint
  /** One raw platform call (pinning a message). */
  api: typeof d.api
  channels: string[]
  /** Never returns: feeds owner taps, messages and reactions to `handle`. */
  listen(db: DB, handle: (o: Owned) => Promise<void>): Promise<void>
}

/** The Discord platform: webhook sends and personas stay in discord.ts; listening is the legacy gateway unless discord.listener is "chat-sdk" (opt-in until a live test passes). */
export async function platform(mode = config().discord.listener ?? "legacy", impl?: { legacy: Platform["listen"]; sdk: Platform["listen"] }, as: "discord" | "slack" = useSlack() ? "slack" : "discord"): Promise<Platform> {
  if (as === "slack") return slack
  return {
    name: "discord", prefix: "discord",
    post: d.post, postBrief: d.postBrief, edit: d.edit, upsert: d.upsert, prCard: d.prCard,
    team: d.team, ticketStatus: d.ticketStatus, teamStatus: d.teamStatus, postIdea: d.postIdea, openBrainThread: d.openBrainThread, brainSay: d.brainSay,
    answerTap: d.answerTap, setup: d.setup, inviteUrl: d.inviteUrl, intentHint: d.intentHint, api: d.api, channels: d.CHANNELS,
    listen: async (db, handle) => {
      if (mode === "chat-sdk") return (impl?.sdk ?? (await import("./discord-sdk.ts")).listenSdk)(db, handle)
      return (impl?.legacy ?? d.listen)(db, handle)
    },
  }
}

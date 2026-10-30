// The morning summary as one value (Brief), built without a model, and its one Markdown text (Discord, dashboard, file, terminal).
import { weekCapSetting } from "./lib.ts"
import { landingText, weekLanding } from "./queue-math.ts"
import { clip, shortTitle } from "./notify.ts"
import { scoreboard } from "./view.ts"
import { zoned, zonedDay } from "./config.ts"
import type { DB } from "./db.ts"
import type { Facts } from "./graphs/cos.ts"

export type Item = { project: string; id?: number; title: string; pr?: string; note?: string }
export type Brief = {
  day: string
  doFirst: Item | null
  forYou: Item[]
  shipped: Item[]
  failed: Item[]
  building: { project: string; queued: number; next: string }[]
  paused: string[]
  budget: { fiveHourPct: number | null; weekPct: number | null; landsPct: number | null; landsText?: string | null; resetAt: string | null; stopPct: number }
  week?: { opened: number; sentBack: number; merged: number; worst: Item[] }
  lost: string[]
}

/** Money never leaves the finance app: any amount with a currency sign or code becomes [amount]. */
export const noMoney = (s: string) => s.replace(/(?:[$₹€£]|\b(?:rs|inr|usd)\.?)\s?\d+(?:[,.]\d+)*(?:\s?(?:k|lakhs?|cr|crores?)\b)?/gi, "[amount]")

/** A ticket title for people. Never empty and never only a number: those came from path or id fragments (see shortTitle). */
export function titleOf(title: string, id?: number) {
  const t = noMoney(shortTitle(title))
  return /[A-Za-z]{2}/.test(t) ? t : id ? `Ticket #${id}` : "A ticket"
}

const lead = (f: Facts, key: string) => f.leads.flatMap((l) => l.text.split("\n").filter((x) => x.startsWith(`${key}: `) && !/: (none|-)$/.test(x)).map((x) => ({ project: l.project, text: x.slice(key.length + 2) })))
const prNum = (url: string) => url.match(/\/pull\/(\d+)/)?.[1]

export function buildBrief(db: DB, f: Facts, now = Date.now(), lost: string[] = []): Brief {
  const owner: Item[] = [
    ...f.waiting.map((t) => ({ project: t.project, id: t.id, title: titleOf(t.title, t.id), pr: t.pr ?? undefined, note: "waiting for your merge" })),
    // the same tickets `status` calls "Needs you": failed in the last 7 days
    ...(db.prepare("SELECT id, project, title, note FROM tickets WHERE status='failed' AND dup_of IS NULL AND updated_at>=? ORDER BY updated_at DESC").all(new Date(now - 7 * 86_400_000).toISOString()) as { id: number; project: string; title: string; note: string | null }[])
      .map((t) => ({ project: t.project, id: t.id, title: titleOf(t.title, t.id), note: clip(noMoney(t.note?.split("\n")[0] ?? ""), 80) || "failed" })),
    ...lead(f, "needs owner").map((l) => ({ project: l.project, title: clip(noMoney(l.text.replace(/\s*· #\d+|#\d+\s*/g, "")), 110), note: "the Engineering Manager set it aside for you" })),
    ...f.health.map((h) => ({ project: "dobby", title: clip(noMoney(h), 100), note: "Mac job" })),
  ]
  const item = (t: Facts["done"][number]): Item => ({ project: t.project, id: t.id, title: titleOf(t.title, t.id), pr: t.pr ?? undefined, note: t.status === "shipped" ? undefined : t.status === "declined" ? "declined" : t.reason || "failed" })
  const u = f.usage
  const elapsed = u ? 1 - u.weekMsToReset / (7 * 86_400_000) : 0
  const land = u ? weekLanding(u.weekUsed, elapsed, weekCapSetting()) : null
  const mon = zoned(now).getUTCDay() === 1
  const sb = mon ? scoreboard(db, 7, now) : null
  return {
    day: zonedDay(now),
    doFirst: owner[0] ?? null,
    forYou: owner.slice(1),
    shipped: f.done.filter((t) => t.status === "shipped").map(item),
    failed: f.done.filter((t) => t.status === "failed").map(item), // declined or cancelled is the owner's choice or a closed PR, not a failure
    building: f.active.filter((p) => f.ready.some((t) => t.project === p)).map((p) => {
      const r = f.ready.filter((t) => t.project === p)
      return { project: p, queued: r.length, next: titleOf(r[0].title, r[0].id) }
    }),
    paused: [...f.paused.map((p) => `${p} paused`), ...(f.pauses ?? [])],
    budget: {
      fiveHourPct: u?.fiveUsed ?? null, weekPct: u?.weekUsed ?? null,
      landsPct: land?.pct ?? null, landsText: land && u ? landingText(land, weekCapSetting()) : null, // straight-line pace, capped at the stop (weekLanding)
      resetAt: u ? new Date(now + u.weekMsToReset).toISOString() : null, stopPct: weekCapSetting(),
    },
    week: sb ? { opened: sb.opened, sentBack: sb.sentBack, merged: sb.merged, worst: sb.sentBackPrs.slice(0, 3).map((p) => ({ project: p.repo.split("/")[1], id: p.pr, title: p.title ?? `PR #${p.pr}`, pr: p.url, note: `${p.rounds} round${p.rounds === 1 ? "" : "s"} of changes` })) } : undefined,
    lost,
  }
}

// ---- Markdown ---------------------------------------------------------------------------
const esc = (s: string) => s.replace(/([\\`*_[\]<>])/g, "\\$1")
const line = (i: Item, sep = ", ") => `${esc(i.project)} · ${esc(i.title)}${i.pr ? `, [PR #${prNum(i.pr) ?? "?"}](${i.pr})` : ""}${i.note ? `${i.pr ? ", " : sep}${esc(i.note)}` : ""}`
const dayLabel = (day: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).formatToParts(new Date(`${day}T12:00:00Z`)).map((x) => [x.type, x.value]))
  return `${p.weekday} ${p.day} ${p.month}`
}
const at = (iso: string) => { const z = zoned(Date.parse(iso)); return `${new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" }).format(z)} ${z.toISOString().slice(11, 16)}` }
export const FOOTER = "-# Sent by Dobby · full list on the dashboard: Activity"

/** The summary as sections (heading + body each), most items per section `max`. Empty sections are left out. */
export function briefSections(b: Brief, max = 5): string[] {
  const list = (title: string, xs: string[]) => (xs.length ? [[`### ${title}`, ...xs.slice(0, max).map((x) => `- ${x}`), ...(xs.length > max ? [`- and ${xs.length - max} more`] : [])].join("\n")] : [])
  const bud = b.budget
  const budget = bud.weekPct === null ? "Unknown" : `Week ${bud.weekPct}%${bud.landsPct === null ? "" : `, ${bud.landsText ?? `on pace to land at ${bud.landsPct}% (stop ${bud.stopPct}%)`}`}${bud.resetAt ? `, resets ${at(bud.resetAt)}` : ""}${bud.fiveHourPct === null ? "" : ` · 5-hour ${bud.fiveHourPct}%`}`
  const out = [
    `## Morning summary · ${dayLabel(b.day)}\n${b.doFirst ? `**Do first:** ${line(b.doFirst)}` : "Nothing needs you today."}`,
    ...list("Also for you", b.forYou.map((i) => line(i))),
    ...list("Shipped", b.shipped.map((i) => line(i))),
    ...list("Failed", b.failed.map((i) => line(i, ": "))),
    ...list("Building today", b.building.map((x) => `${esc(x.project)}: ${x.queued} queued, next "${esc(x.next)}"`)),
    ...list("Paused", b.paused.map(esc)),
    ...(b.week ? [`### This week\n${b.week.opened} PRs opened · ${b.week.sentBack} needed changes · ${b.week.merged} merged${b.week.worst.map((i) => `\n- ${line(i)}`).join("")}`] : []),
    ...list("Not posted", b.lost.map(esc)),
    `### Budget\n${budget}`,
  ]
  return out.map(noMoney)
}

/** Messages of at most `limit` characters, split between sections, never inside one. The footer ends the last. */
export function briefParts(b: Brief, limit = 1990): string[] {
  const parts: string[] = []
  for (const s of [...briefSections(b), FOOTER]) {
    const sep = s === FOOTER ? "\n\n" : "\n"
    if (parts.length && parts.at(-1)!.length + sep.length + s.length <= limit) parts[parts.length - 1] += sep + s
    else parts.push(s)
  }
  return parts
}
export const briefMarkdown = (b: Brief) => briefParts(b, Infinity).join("\n")

/** Sections for the Components V2 message: items per section drop until all the text fits Discord's 4,000. */
export function richSections(b: Brief): string[] {
  for (let max = 5; ; max--) {
    const s = [...briefSections(b, max), FOOTER]
    if (max <= 1 || s.join("").length <= 3900) return s
  }
}

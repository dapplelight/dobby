// The morning summary: Brief value, its Markdown, the Discord Components V2 message, the archive file. No model, fake senders and fetchers.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-brief-`)
process.env.DOBBY_DIR = dir
const { open } = await import("../src/db.ts")
const { addTicket, setTicket } = await import("../src/lib.ts")
const { buildBrief, briefMarkdown, briefParts, richSections, titleOf } = await import("../src/brief.ts")
const { gather, sendBrief, istDay } = await import("../src/graphs/cos.ts")
const { briefPayload, postBrief } = await import("../src/discord.ts")
const { shortTitle } = await import("../src/notify.ts")

const MON = Date.parse("2026-10-26T04:00:00Z") // Monday 09:30 IST
const projects = { tally: { name: "tally", paused: false }, shopfront: { name: "shopfront", paused: true } } as never
const usage = { fiveUsed: 31, weekUsed: 58, weekMsToReset: 3.5 * 86_400_000 }
const PR = (n: number) => `https://github.com/ownerdev/tally/pull/${n}`
let db = open(":memory:")
const fresh = () => (db = open(":memory:"))
const ticket = (project: string, title: string, status: string, note?: string) => {
  const { id } = addTicket(db, { project, title })
  setTicket(db, id, { status, ...(note ? { note } : {}) })
  return id
}
const facts = () => gather(db, projects, usage, MON)
const stamp = () => db.prepare("UPDATE tickets SET updated_at=?").run(new Date(MON - 3600_000).toISOString())
function fixture() {
  fresh()
  ticket("tally", "CSV export for reports", "approval", PR(412))
  ticket("shopfront", "Bulk delete", "approval")
  ticket("tally", "Dark mode for reports", "shipped", PR(405))
  ticket("tally", "Login loop on Safari", "failed", "out of builds\nmore detail")
  ticket("shopfront", "Old idea", "declined")
  ticket("tally", "Recurring reports", "ready")
  ticket("tally", "Second queued", "ready")
  stamp()
}

test("buildBrief: merged and failed land in the right sections, declined is not a failure; empty sections are left out", () => {
  fixture()
  const b = buildBrief(db, facts(), MON)
  assert.deepEqual(b.shipped.map((i) => i.title), ["Dark mode for reports"])
  assert.equal(b.shipped[0].pr, PR(405))
  assert.deepEqual(b.failed.map((i) => `${i.title}: ${i.note}`), ["Login loop on Safari: out of builds"])
  assert.equal(b.doFirst?.title, "CSV export for reports") // waiting merges first, in ticket order
  assert.deepEqual(b.forYou.map((i) => i.title), ["Bulk delete", "Login loop on Safari"]) // a failed ticket needs the owner, as `status` says
  assert.deepEqual(b.building, [{ project: "tally", queued: 2, next: "Recurring reports" }])
  assert.deepEqual(b.paused, ["shopfront paused"])
  assert.ok(!/Shipped 0|haiku|sonnet|opus|\$/i.test(briefMarkdown(b)))
  fresh()
  const empty = briefMarkdown(buildBrief(db, facts(), MON))
  assert.ok(!/### (Shipped|Failed|Also for you|Building today)/.test(empty), empty)
  assert.match(empty, /Nothing needs you today\./)
})

test("buildBrief: only Mondays add the week; no money in titles", () => {
  fixture()
  ticket("tally", "Show $500 left", "shipped")
  assert.ok(buildBrief(db, facts(), MON).week)
  const tue = MON + 86_400_000
  assert.equal(buildBrief(db, gather(db, projects, usage, tue), tue).week, undefined)
  assert.ok(!briefMarkdown(buildBrief(db, facts(), MON)).includes("$500"))
})

test("titles: a path or id fragment never becomes the whole title (the 'work 501' rows)", () => {
  assert.equal(shortTitle("Fix review finding work.ts:501 on tally#12"), "Fix review finding on tally#12")
  assert.equal(shortTitle("Fix review finding src/work.ts:501 on tally#12"), "Fix review finding on tally#12")
  assert.equal(titleOf("apps/web/501", 9), "Ticket #9")
  assert.equal(titleOf("501", 9), "Ticket #9")
})

test("briefMarkdown: snapshot", () => {
  fixture()
  const md = briefMarkdown(buildBrief(db, facts(), MON))
  const week = md.match(/\d+ PRs opened · \d+ needed changes · \d+ merged/)![0]
  assert.equal(md, [
    "## Morning summary · Mon 26 Oct",
    `**Do first:** tally · CSV export for reports, [PR #412](${PR(412)}), waiting for your merge`,
    "### Also for you", "- shopfront · Bulk delete, waiting for your merge", "- tally · Login loop on Safari, out of builds",
    "### Shipped", `- tally · Dark mode for reports, [PR #405](${PR(405)})`,
    "### Failed", "- tally · Login loop on Safari: out of builds",
    "### Building today", '- tally: 2 queued, next "Recurring reports"',
    "### Paused", "- shopfront paused",
    `### This week\n${week}`,
    "### Budget", `Week 58%, on pace to hit the 95% stop, where Dobby stops, resets ${md.match(/resets (\w+ [\d:]+)/)![1]} · 5-hour 31%`,
    "", "-# Sent by Dobby · full list on the dashboard: Activity",
  ].join("\n"))
  assert.ok(!/Approve|Decline|buttons/.test(md)) // the buttons stay on the per-ticket pings
  assert.ok(!/<[a-z]|\| ---/.test(md)) // no HTML, no tables
})

test("briefParts: over 2,000 characters splits between sections, never inside a line", () => {
  fixture()
  const b = buildBrief(db, facts(), MON)
  const item = (n: string) => ({ project: "tally", title: n.repeat(150), note: "waiting" })
  b.shipped = Array.from({ length: 5 }, () => item("x")); b.forYou = Array.from({ length: 5 }, () => item("y"))
  const parts = briefParts(b)
  assert.ok(parts.length >= 2 && parts.every((p) => p.length <= 1990), parts.map((p) => p.length).join())
  assert.ok(parts.slice(1).every((p) => p.startsWith("### ")))
  b.shipped = Array.from({ length: 8 }, () => item("x"))
  assert.match(briefMarkdown(b), /- and 3 more/)
})

test("sendBrief: archive file, stored json, no model call, rich sections for Discord", async () => {
  fixture()
  const sent: { text: string; to: any }[] = []
  const runs = () => (db.prepare("SELECT count(*) n FROM runs").get() as { n: number }).n
  const before = runs()
  const r = await sendBrief(db, { facts: facts(), now: MON, dir, link: "https://dobby.example/" }, (async (text: string, _f: unknown, _b: unknown, to: any) => (sent.push({ text, to }), true)) as never)
  const day = istDay(MON)
  assert.equal(readFileSync(`${dir}/briefs/${day}.md`, "utf8"), `${r.markdown}\n`)
  const stored = JSON.parse((db.prepare("SELECT v FROM kv WHERE k=?").get(`brief:json:${day}`) as { v: string }).v)
  assert.deepEqual({ ...stored, at: 0 }, { markdown: r.markdown, at: 0, sentTo: "Discord #daily-update", ok: true })
  assert.equal(runs(), before) // a model call would log a run
  const brief = sent.find((m) => m.to.kind === "brief" && m.to.rich)!
  assert.equal(brief.text, r.markdown)
  assert.equal(brief.to.rich.link, "https://dobby.example/")
})

test("sendBrief: a send that fails twice is stored as not sent", async () => {
  fresh()
  const orig = global.setTimeout
  ;(global as any).setTimeout = (f: () => void) => orig(f, 0)
  try { await sendBrief(db, { facts: facts(), now: MON, dir }, (async () => false) as never) } finally { global.setTimeout = orig }
  const stored = JSON.parse((db.prepare("SELECT v FROM kv WHERE k=?").get(`brief:json:${istDay(MON)}`) as { v: string }).v)
  assert.equal(stored.sentTo, null); assert.equal(stored.ok, false)
})

test("discord: Components V2 payload shape", () => {
  fixture()
  const sections = richSections(buildBrief(db, facts(), MON))
  const p = briefPayload({ sections, plain: [], link: "https://dobby.example/" }, true, { as: "Chief of Staff" }) as any
  assert.equal(p.flags, 32768 | 4096)
  assert.ok(!("content" in p))
  assert.equal(p.components.length, 1)
  const c = p.components[0]
  assert.equal(c.type, 17); assert.equal(c.accent_color, 0x3ddc84)
  assert.deepEqual(c.components.slice(0, 3).map((x: any) => x.type), [10, 14, 10]) // text, divider, text
  assert.deepEqual(c.components[1], { type: 14, divider: true, spacing: 1 })
  assert.deepEqual(c.components.filter((x: any) => x.type === 10).map((x: any) => x.content), sections)
  assert.deepEqual(c.components.at(-1), { type: 1, components: [{ type: 2, style: 5, label: "Open dashboard", url: "https://dobby.example/" }] })
  assert.ok(c.components.length <= 40)
  const noLink = briefPayload({ sections, plain: [] }, false, { as: "x" }) as any
  assert.equal(noLink.flags, 32768)
  assert.ok(noLink.components[0].components.every((x: any) => x.type !== 1))
})

test("discord: over 4,000 characters the items are capped, not split", () => {
  fixture()
  const b = buildBrief(db, facts(), MON)
  b.shipped = Array.from({ length: 30 }, (_, i) => ({ project: "tally", title: `Change ${i} ${"w".repeat(190)}`, pr: PR(i + 1) }))
  b.failed = b.shipped.map((i) => ({ ...i, note: "z".repeat(60) }))
  const s = richSections(b)
  assert.ok(s.join("").length <= 4000, String(s.join("").length))
  assert.ok(s.some((x) => /- and \d+ more/.test(x)))
})

test("discord: a 400 on the V2 message falls back once to plain Markdown", async () => {
  fixture()
  db.prepare("INSERT INTO kv VALUES ('discord:wh:daily-update', '123/hook')").run()
  const calls: { body: any }[] = []
  const fetcher = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body); calls.push({ body })
    return body.flags & 32768 ? new Response("{}", { status: 400 }) : new Response(JSON.stringify({ id: "m1", channel_id: "c" }), { status: 200 })
  }) as unknown as typeof fetch
  const b = buildBrief(db, facts(), MON)
  const logs: string[] = []; const log = console.log; console.log = (m: string) => logs.push(m)
  try { await postBrief(db, { sections: richSections(b), plain: briefParts(b) }, fetcher) } finally { console.log = log }
  assert.equal(calls.length, 2)
  assert.ok(calls[0].body.flags & 32768)
  assert.ok(!(calls[1].body.flags & 32768))
  assert.equal(calls[1].body.content, briefParts(b).join("\n"))
  assert.equal(calls[1].body.flags & 4, 4) // links do not unfurl
  assert.match(logs.join(), /refused the components message \(discord POST .* 400\)/)
  assert.ok(!logs.join().includes("123/hook")) // the webhook token is never logged
})

test("weekLanding: the landing is capped at the stop and says who passes it", async () => {
  const { weekLanding, landingText } = await import("../src/queue-math.ts")
  const text = (used: number, frac: number) => { const l = weekLanding(used, frac, 95)!; return [l.pct, landingText(l, 95)] }
  assert.deepEqual(text(40, 0.5), [80, "on pace to land at 80% (stop 95%)"])
  assert.deepEqual(text(58, 0.5), [95, "on pace to hit the 95% stop, where Dobby stops"]) // raw 116%
  assert.deepEqual(text(96, 0.7), [96, "your own use alone is on pace to pass the 95% stop"]) // Dobby already stopped
  assert.equal(weekLanding(10, 0.01, 95), null, "too early in the week to project")
})

test("shortTitle never leaves a dangling preposition after a stripped path", () => {
  assert.equal(shortTitle("Fix the typo in src/work.ts"), "Fix the typo")
  assert.equal(shortTitle("Update the header in apps/web/a.tsx, apps/web/b.tsx"), "Update the header")
})

test("shortTitle: a preposition that is part of the title stays; only one left pointing at a stripped path goes", () => {
  assert.equal(shortTitle("Merge main in"), "Merge main in")
  assert.equal(shortTitle("Update docs/x.md and src/y.ts for the new flag"), "Update for the new flag")
  assert.equal(shortTitle("Rename the files in docs/a.md and docs/b.md"), "Rename the files")
})

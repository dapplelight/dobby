// Owner-facing text, fully offline: temp data dir and secrets file, :memory: databases, fetch stubbed. Never reaches Discord or Telegram.
import assert from "node:assert/strict"
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-ux-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/s.txt`
writeFileSync(process.env.DOBBY_SECRETS, "DISCORD_BOT_TOKEN=bot\n")
const { open } = await import("../src/db.ts")
const { addTicket, dropIdea, label, setTicket, undoIdea } = await import("../src/lib.ts")
const d = await import("../src/discord.ts")
const v = await import("../src/view.ts")
const u = await import("../src/usage.ts")

type Call = { method: string; url: string; body: any }
const stub = (calls: Call[]) => (async (url: string, init?: RequestInit) => {
  calls.push({ method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined })
  return new Response(JSON.stringify(String(url).includes("/threads") ? { id: "thread9" } : { id: `msg${calls.length}`, channel_id: "chan1" }))
}) as unknown as typeof fetch
const withDiscord = () => {
  const db = open(":memory:")
  for (const c of ["needs-you", "daily-update", "tally-tickets"]) d.setKv(db, `discord:wh:${c}`, `${c}-id/${c}-token`)
  d.setKv(db, "discord:ch:daily-update", "dchan")
  d.setKv(db, "discord:owner", "owner1")
  return db
}

test("label: App · short title, no number, paths or long tails", () => {
  const db = open(":memory:")
  const id = addTicket(db, { project: "shopfront", title: "Sign-in full state: show the Google button and the email form on one screen (apps/web/x.tsx)" }).id
  assert.equal(label(db, id), "Shopfront · Sign-in full state")
  const long = addTicket(db, { project: "tally", title: "A very long title without any colon that just keeps going and going past fifty characters" }).id
  assert.ok(label(db, long).length <= "Tally · ".length + 50)
  assert.doesNotMatch(label(db, long), /#\d/)
  assert.equal(label(db, 9999), "a ticket")
})

test("button taps: the echo names the thing in words; a dropped idea can be undone", async () => {
  const db = open(":memory:")
  const t = addTicket(db, { project: "tally", title: "Sign-in full state" }).id
  db.prepare("INSERT INTO ideas (project,title,source,status,created_at) VALUES ('tally','Voice notes','pm','proposed','now')").run()
  assert.equal(d.plainAck(db, `approve ${t}`), 'Merging "Sign-in full state"…')
  assert.equal(d.plainAck(db, "dropidea 1"), 'Dropping "Voice notes"…')
  assert.equal(d.plainAck(db, "deploynow tally migrate"), "Deploying Tally with its migration…")
  assert.equal(d.plainAck(db, "approve 4040"), "Merging that…") // unknown ticket: still no raw command
  const calls: Call[] = []
  await d.ack({ id: "i1", token: "tok", content: "Needs you", data: `approve ${t}` }, stub(calls), db)
  assert.equal(calls[0].body.data.content, 'Needs you\n\n→ Merging "Sign-in full state"…')
  assert.doesNotMatch(calls[0].body.data.content, /approve \d|on it/)

  assert.equal(dropIdea(db, 1, ["new", "proposed"]), '👎 Dropped "Voice notes"')
  assert.equal((db.prepare("SELECT status FROM ideas WHERE id=1").get() as any).status, "rejected")
  assert.equal(undoIdea(db, 1), '↩️ Brought back "Voice notes"')
  assert.equal((db.prepare("SELECT status FROM ideas WHERE id=1").get() as any).status, "new")
  assert.match(undoIdea(db, 1), /Nothing to undo/)
})

test("help is the usage comment: every command the CLI handles is listed", () => {
  const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")
  const help = v.helpText(src)
  const cases = [...src.matchAll(/^  case "([\w-]+)"/gm)].map((m) => m[1]).filter((c) => !["usage-sample", "do", "strategize"].includes(c))
  for (const c of cases) assert.ok(new RegExp(`^  .*\\b${c}\\b`, "m").test(help), `help is missing ${c}`)
  assert.doesNotMatch(help, /#brief|#ask\b/)
})

test("list: grouped by stage, then app, then age; 10 per stage; failures say why", () => {
  const now = Date.parse("2026-10-20T12:00:00Z")
  const ago = (h: number) => new Date(now - h * 3600_000).toISOString()
  const rows = [
    { id: 1, status: "running", project: "tally", title: "Voice notes: record and play", note: null, updated_at: ago(2) },
    { id: 2, status: "failed", project: "shopfront", title: "Book a slot", note: "crashed: " + "x".repeat(200), updated_at: ago(30) },
    ...[...Array(12)].map((_, i) => ({ id: 10 + i, status: "ready", project: "tally", title: `Ready item ${i}`, note: null, updated_at: ago(i + 1) })),
  ]
  const out = v.listView(rows, now).split("\n")
  assert.deepEqual(out.filter((l) => /^\w/.test(l)), ["Building (1)", "Ready (12)", "Failed (1)"])
  assert.equal(out[1], "  Voice notes  tally  2h  #1")
  assert.ok(out.includes("  +2 more"))
  assert.equal(out.filter((l) => l.startsWith("  Ready item")).length, 10)
  assert.equal(out.find((l) => l.startsWith("    why:"))!.length, "    why: ".length + 70)
  assert.ok(out.includes("  Book a slot  shopfront  30h  #2"))
  assert.equal(v.listView([], now), "nothing open")
})

test("status board: building, shipped today, stuck with the reason, last tick; the word 'status' is answered without AI", async () => {
  const db = withDiscord()
  const mk = (title: string, status: string, note?: string) => { const id = addTicket(db, { project: "tally", title }).id; setTicket(db, id, { status: status as any, note }); return id }
  mk("Voice notes", "running"); mk("Dark mode", "shipped"); mk("Book a slot", "failed", "tests keep failing in the booking form"); mk("Old idea", "backlog")
  const now = Date.now()
  d.setKv(db, "tick:last", String(now))
  const text = v.statusText(db, now)
  assert.match(text, /Building now \(1\): Voice notes/)
  assert.match(text, /Shipped today \(1\)/)
  assert.match(text, /Stuck \(1\): Book a slot - tests keep failing in the booking form/)
  assert.match(text, /Last tick \d\d:\d\d$/)
  d.setKv(db, "health:last-tick", String(now - 3600_000 * 2)) // the newest of the keys wins: an older health reading changes nothing
  assert.equal(v.statusText(db, now), text)
  assert.ok(["status", "Status?", "dobby status"].every(v.isStatusAsk) && !v.isStatusAsk("what is the status of the Tally app"))

  // one message in #daily-update, edited on later ticks, never an @mention, pinned once
  const calls: Call[] = []
  await v.updateBoard(db, true, stub(calls), now)
  assert.match(calls[0].url, /webhooks\/daily-update-id\/daily-update-token\?wait=true/)
  assert.match(calls[0].body.content, /^📋 Status\n/)
  assert.deepEqual(calls[0].body.allowed_mentions.users, [])
  assert.equal(calls[1].method, "PUT") // pin (ignored if the bot may not)
  d.setKv(db, "health:last-tick", String(now + 60_000))
  await v.updateBoard(db, true, stub(calls), now + 120_000)
  assert.equal(calls.at(-1)!.method, "PATCH")
  assert.equal(calls.at(-1)!.body.allowed_mentions.parse.length, 0)
  const n = calls.length
  await v.updateBoard(db, true, stub(calls), now + 120_000) // nothing changed
  assert.equal(calls.length, n)
  const off = open(":memory:")
  await v.updateBoard(off, false, stub(calls)) // no Discord: only the tick time is kept
  assert.ok(v.lastTick(off))
})

test("ticket thread: one status line edited in place, raw output quoted under details (6 lines)", async () => {
  const db = withDiscord()
  const e = { kind: "ticket" as const, project: "tally", ticket: 7, title: "Fix the footer", step: "building" as const }
  assert.equal(d.stepLine(3, "QA is checking", 2), "Step 3 of 5: QA is checking · 2nd try")
  assert.equal(d.stepLine(2, "Engineer is building"), "Step 2 of 5: Engineer is building")
  assert.match(d.stepLine(3, "x", 3), /3rd try$/)
  assert.match(d.stepLine(3, "x", 11), /11th try$/)
  const calls: Call[] = []
  await d.ticketStatus(db, e, "Step 1 of 5: picked up", stub(calls))
  assert.equal(calls[0].method, "POST") // the first message starts the thread
  assert.equal(calls[0].body.content, "Step 1 of 5: picked up")
  assert.ok(calls.some((c) => c.url.includes("/threads")))
  await d.ticketStatus(db, e, "Step 2 of 5: Engineer is building", stub(calls))
  const patch = calls.at(-1)!
  assert.equal(patch.method, "PATCH")
  assert.match(patch.url, /tally-tickets-id\/tally-tickets-token\/messages\/msg1\?with_components=true$/) // starter message: edited in the channel
  assert.equal(patch.body.content, "Step 2 of 5: Engineer is building")
  const n = calls.length
  await d.ticketStatus(db, e, "Step 2 of 5: Engineer is building", stub(calls))
  assert.equal(calls.length, n) // same line: nothing sent
  const out = d.detailsBlock(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"))
  assert.deepEqual(out.split("\n"), ["details", ...[14, 15, 16, 17, 18, 19].map((i) => `> line ${i}`)])
})

test("plain GitHub errors: known ones are one sentence with the raw text under details, others stay raw", async () => {
  const { plainGh } = await import("../src/discord.ts")
  assert.equal(plainGh("X Pull request o/r#5 is not mergeable: the merge commit cannot be cleanly created."), "The branch conflicts with its base and needs a conflict fix.\ndetails\n> X Pull request o/r#5 is not mergeable: the merge commit cannot be cleanly created.")
  assert.match(plainGh("GraphQL: Pull request is not mergeable (base branch policy prohibits the merge)"), /^The branch rules block this merge/)
  assert.match(plainGh("a pull request for branch \"foreman/7\" into branch \"main\" already exists"), /^This branch already has an open PR\./)
  assert.equal(plainGh("  remote: permission denied  "), "remote: permission denied")
})

test("owner touches: same kind and tag within 60 s are one interruption; tickets touched is counted apart", () => {
  const db = open(":memory:")
  const ids = [1, 2, 3].map((i) => addTicket(db, { project: "tally", title: `t${i}` }).id)
  for (const id of ids) setTicket(db, id, { status: "shipped" })
  const t0 = Date.now()
  for (const [i, id] of ids.entries()) u.touch(db, { ticket: id, kind: "queue", tag: "broke" }, t0 + i * 1000) // 3 re-queues in 2 s
  u.touch(db, { ticket: null, kind: "queue", tag: "broke" }, t0 + 61_000) // past 60 s from the burst's first touch
  u.touch(db, { kind: "needs-you", tag: "decision" }, t0 + 5000) // different kind: its own interruption
  assert.deepEqual(db.prepare("SELECT kind, tag, n FROM touches WHERE n>0 ORDER BY id").all(), [{ kind: "queue", tag: "broke", n: 3 }, { kind: "queue", tag: "broke", n: 1 }, { kind: "needs-you", tag: "decision", n: 1 }])
  assert.equal(u.autonomyLine(db, 1, t0 + 62_000), "🤖 Autonomy: 0 of 3 shipped with zero owner touches (0%). Interruptions: 3 (2 broke, 1 decision). Tickets touched: 3.")
  // an old database without the count column is migrated on first use
  const old = open(":memory:")
  old.exec("CREATE TABLE touches (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, ticket INTEGER, kind TEXT NOT NULL, tag TEXT NOT NULL, note TEXT)")
  old.prepare("INSERT INTO touches (at, ticket, kind, tag) VALUES (?, 1, 'tap', 'broke')").run(t0)
  u.touch(old, { kind: "tap", tag: "broke" }, t0 + 1000)
  assert.deepEqual(old.prepare("SELECT n FROM touches ORDER BY id").all(), [{ n: 2 }]) // the old row counts as 1 by default, so the burst makes 2
})

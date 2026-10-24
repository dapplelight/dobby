// Stuck-in-fixing card, fully offline: temp data dir, Haiku/Discord/gh all faked.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-stuck-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/none`
const { open } = await import("../src/db.ts")
const { addTicket, getTicket, setTicket } = await import("../src/lib.ts")
const { stuckScan, stuckTap } = await import("../src/stuck.ts")

const NOW = Date.parse("2026-10-19T12:00:00Z")
const URL = "https://github.com/ownerdev/shopfront/pull/225"
type Btn = { text: string; data: string; url?: string }
function setup() {
  const db = open(":memory:")
  const fake = { tops: 0, sent: [] as { key: string; text: string; buttons: Btn[] }[], settled: [] as string[], on: true }
  const deps = {
    top: async (text: string) => (fake.tops++, `What happened: x\nWhy it needs you: y\nButtons: z\n\n${text}`),
    send: async (key: string, text: string, buttons: Btn[]) => (fake.sent.push({ key, text, buttons }), true),
    settle: async (key: string, text: string) => void fake.settled.push(`${key} ${text}`),
    discord: () => fake.on,
  }
  const stuck = (note: string, ago: number, status = "fixing") => {
    const { id } = addTicket(db, { project: "shopfront", title: "Demo rsvp: a very long title that goes on" })
    setTicket(db, id, { status, note, branch: `dobby/${id}` })
    db.prepare("UPDATE tickets SET updated_at=? WHERE id=?").run(new Date(NOW - ago * 3600_000).toISOString(), id)
    return id
  }
  return { db, fake, deps, stuck }
}

test("a ticket in fixing over 24h gets one card, edited (same key) on later ticks, Haiku asked once", async () => {
  const { db, fake, deps, stuck } = setup()
  const id = stuck(`Review found issues\n${URL}`, 30)
  stuck("fresh", 2)
  stuck("done", 40, "shipped")
  await stuckScan(db, deps, NOW)
  await stuckScan(db, deps, NOW + 3600_000)
  assert.equal(fake.tops, 1)
  assert.deepEqual(fake.sent.map((s) => s.key), [`stuck:${id}`, `stuck:${id}`])
  const c = fake.sent[0]
  assert.match(c.text, /^What happened: x\nWhy it needs you: y\nButtons: z\n\n🟠 Stuck in fixing · shopfront #\d+\n\*\*Demo rsvp\*\*\n\nIn fixing since 18 Oct \(30h\)\. Last note: Review found issues/)
  assert.ok(c.text.endsWith(`${URL}\n\nNothing merges or deploys until you pick.`))
  assert.match(fake.sent[1].text, /\(31h\)/)
  assert.deepEqual(c.buttons.map((b) => b.url ?? b.data), [`stuckretry ${id}`, `stuckdecline ${id}`, URL])
  assert.deepEqual(c.buttons.map((b) => b.text), ["🔁 Retry from scratch", "✖️ Decline", "🔗 Open PR"])
})

test("no PR link = two buttons and no URL line; Telegram gets the card once", async () => {
  const a = setup()
  a.stuck("no link here", 25)
  await stuckScan(a.db, a.deps, NOW)
  assert.equal(a.fake.sent[0].buttons.length, 2)
  assert.doesNotMatch(a.fake.sent[0].text, /https:/)
  const t = setup()
  t.fake.on = false
  t.stuck("x", 25)
  await stuckScan(t.db, t.deps, NOW)
  await stuckScan(t.db, t.deps, NOW + 60_000)
  assert.equal(t.fake.sent.length, 1)
})

test("a ticket that leaves fixing settles its card to Resolved, once", async () => {
  const { db, fake, deps, stuck } = setup()
  const id = stuck("n", 30)
  await stuckScan(db, deps, NOW)
  setTicket(db, id, { status: "shipped" })
  await stuckScan(db, deps, NOW)
  await stuckScan(db, deps, NOW)
  assert.deepEqual(fake.settled, [`stuck:${id} ✅ Resolved · shopfront #${id}`])
})

test("taps: retry closes the PR and re-queues from scratch, decline closes it and declines, a ticket not in fixing is left alone", () => {
  const { db, stuck } = setup()
  const calls: string[] = []
  const r = (cmd: string, args: string[]) => (calls.push(`${cmd} ${args.join(" ")}`), { ok: true, out: "" })
  const a = stuck(URL, 30), b = stuck(URL, 30), c = stuck("x", 30, "shipped")
  assert.equal(stuckTap(db, "retry", a, r, {}), `#${a} back in the queue from scratch; a builder picks it up within about a minute.`)
  assert.deepEqual([getTicket(db, a)!.status, getTicket(db, a)!.branch], ["ready", null])
  assert.equal(stuckTap(db, "decline", b, r, {}), `#${b} declined.`)
  assert.equal(getTicket(db, b)!.status, "declined")
  assert.equal(stuckTap(db, "decline", c, r, {}), `#${c} is shipped now; nothing to do.`)
  assert.deepEqual(calls, [`gh pr close ${URL} --delete-branch`, `gh pr close ${URL} --delete-branch`])
  assert.match(stuckTap(db, "retry", a, r, {}), /is ready now; nothing to do/)
})

test("a PR that won't close leaves the ticket in fixing", () => {
  const { db, stuck } = setup()
  const id = stuck(URL, 30)
  assert.match(stuckTap(db, "retry", id, () => ({ ok: false, out: "boom" }), {}), /^Couldn't close the PR \(boom\)/)
  assert.equal(getTicket(db, id)!.status, "fixing")
})

test("retry and decline also decline the fix tickets aimed at the closed branch; retry resets the counts and drops the PR's wait", () => {
  const { db, stuck } = setup()
  const r = (_cmd: string, _args: string[]) => ({ ok: true, out: "" })
  for (const verb of ["retry", "decline"] as const) {
    const id = stuck(URL, 30)
    const fix = addTicket(db, { project: "shopfront", title: `fix ${verb}`, onto: `dobby/${id}` }).id
    setTicket(db, fix, { status: "ready" })
    db.prepare("INSERT OR REPLACE INTO kv VALUES (?, '1')").run("automerge:ownerdev/shopfront#225")
    db.prepare("INSERT OR REPLACE INTO kv VALUES (?, 'x')").run(`lastfail:${id}`)
    stuckTap(db, verb, id, r, {})
    assert.equal(getTicket(db, fix)!.status, "declined", verb)
    assert.equal(db.prepare("SELECT 1 FROM kv WHERE k='automerge:ownerdev/shopfront#225'").get(), undefined, verb)
    if (verb === "retry") assert.deepEqual([db.prepare("SELECT 1 FROM kv WHERE k=?").get(`lastfail:${id}`), !!db.prepare("SELECT 1 FROM kv WHERE k=?").get(`build-base:${id}`), !!db.prepare("SELECT 1 FROM kv WHERE k=?").get(`cost-base:${id}`)], [undefined, true, true])
  }
})

test("a ticket still in fixing whose updated_at is recent keeps its card (no Resolved)", async () => {
  const { db, fake, deps, stuck } = setup()
  const id = stuck("n", 30)
  await stuckScan(db, deps, NOW)
  db.prepare("UPDATE tickets SET note='auto-fix round 2', updated_at=? WHERE id=?").run(new Date(NOW).toISOString(), id)
  await stuckScan(db, deps, NOW + 60_000)
  assert.deepEqual(fake.settled, [])
})

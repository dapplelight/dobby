import assert from "node:assert/strict"
import test from "node:test"
import { needsOwner, ownerVerdicts } from "../src/graphs/lead.ts"

// a Jev stub: answers `who` from a lookup on the ticket text, always sure (0.99)
const stub = (owner: (state: string) => boolean): typeof fetch =>
  (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    const yes = owner(body.state)
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { choice: yes && k === "releases" ? "yes" : "no", confidence: 0.99 }])) }))
  }) as unknown as typeof fetch

test("owner-only: Jev frees words that are only product words; hard rules and no-answer stay with the owner", async () => {
  process.env.JEV_API_KEY = "test"
  const { setConfig, defaults } = await import("../src/config.ts")
  setConfig({ ...defaults(), safety: { ...defaults().safety, classifier: "jev" } }) // Jev is optional: used only when configured and keyed
  const free = { title: "Release notes link preview is blank when shared on WhatsApp", done_when: "og image added; nothing to deploy by hand" }
  const run = { title: "Publish the Play Store release", done_when: "submit it in Play Console" }
  const hard = { title: "Fix Orion's invite RSVP page", done_when: "" }
  const plain = { title: "Add a copy button", done_when: "" }
  const v = await ownerVerdicts([free, run, hard, plain], stub((s) => s.includes("Play Store")))
  const key = (t: { title: string; done_when: string }) => `${t.title} ${t.done_when}`.trim()
  const ctx = (t: { title: string }) => ({ title: t.title })
  assert.equal(needsOwner(key(free), v, ctx(free)), false, "Jev: agent-ok")
  assert.equal(needsOwner(key(run), v, ctx(run)), true, "Jev: owner-only")
  assert.equal(needsOwner(key(hard), v, ctx(hard)), true, "client name is a hard rule")
  assert.equal(needsOwner(key(plain), v, ctx(plain)), false, "no flag word: never asked")
  assert.equal(v.has(key(hard)) || v.has(key(plain)), false, "Jev is not asked about those")
  // Jev offline or unsure: no verdict, so a flagged ticket stays owner-only (today's behaviour)
  const down = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch
  const none = await ownerVerdicts([free], down)
  assert.equal(needsOwner(key(free), none, ctx(free)), true)
  assert.equal(needsOwner(key(free)), true, "no verdicts at all: unsure = ask")
  setConfig()
})

test("owner_words: off (projects/dobby.md) frees the soft words for dobby only; Owner: titles and other projects are unchanged", async () => {
  const { open } = await import("../src/db.ts")
  const { addTicket, loadProjects, queueTicket, scoutMerge, splitBacklog } = await import("../src/lib.ts")
  const { decide } = await import("../src/policy.ts")
  assert.equal(loadProjects().dobby.ownerWords, false)
  assert.equal(loadProjects().dobby.scoutMerge, "auto")
  assert.equal(scoutMerge(), "auto")
  assert.equal(loadProjects().tally?.ownerWords ?? true, true)
  // the generic mechanism: ctx.ownerWords === false skips only the soft rules
  assert.equal(decide("ticket-text", "rotate the token", undefined, { ownerWords: false }).action, "allow")
  assert.equal(decide("ticket-text", "rotate the token", undefined, {}).action, "ask")
  assert.equal(decide("ticket-text", "Owner: pick a name", undefined, { ownerWords: false }).action, "deny")
  assert.equal(decide("ticket-text", "fix Orion's page", undefined, { project: "shopfront", ownerWords: false }).action, "deny")
  const db = open(":memory:")
  const titles = ["Auto-generate the Play Store release notes", "Publish from a temporary worktree to production", "Submit the Play Console release"]
  const f = titles.map((title) => addTicket(db, { project: "dobby", title }).id)
  const p = titles.map((title) => addTicket(db, { project: "tally", title }).id)
  const o = addTicket(db, { project: "dobby", title: "Owner: rename the repo" }).id
  db.prepare("UPDATE tickets SET status='backlog'").run()
  assert.deepEqual(splitBacklog(db, "dobby").pickable.map((t) => t.id).sort(), [...f].sort())
  assert.deepEqual(splitBacklog(db, "dobby").owner.map((t) => t.id), [o])
  assert.deepEqual(splitBacklog(db, "tally").pickable, [])
  assert.equal(splitBacklog(db, "tally").owner.length, 3)
  assert.match(queueTicket(db, f[0]), /queued/)
  assert.match(queueTicket(db, p[0]), /needs the owner/)
  assert.match(queueTicket(db, o), /needs the owner/)
})

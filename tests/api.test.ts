import assert from "node:assert/strict"
import { test } from "node:test"
import { open } from "../src/db.ts"
import { apiCommand, callApi, useApi } from "../src/api.ts"

const TEXT = ["--setting-sources", "project", "--tools", ""]
const reply = (status: number, body: object) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

test("only tool-less calls with a key use the API; off and an empty balance fall back to the plan", async () => {
  process.env.DOBBY_API_KEY = "test"
  const db = open(":memory:")
  assert.equal(useApi(db, TEXT), true)
  assert.equal(useApi(db, ["--allowedTools", "Read"]), false) // tools = Claude Code, not covered

  const ok = await callApi(db, "haiku", "hi", reply(200, { content: [{ type: "text", text: "hello" }], usage: { input_tokens: 3, output_tokens: 1 } }))
  assert.equal(ok.ok, true)
  assert.equal(ok.ok && ok.text, "hello")

  const now = Date.now()
  const empty = await callApi(db, "haiku", "hi", reply(400, { error: { message: "Your credit balance is too low to access the Anthropic API." } }), now)
  assert.equal(empty.ok, false)
  assert.equal(useApi(db, TEXT, now + 3600_000), false) // paused: plan for a day
  assert.equal(useApi(db, TEXT, now + 25 * 3600_000), true) // tries again, picks up the refill

  const other = await callApi(db, "haiku", "hi", reply(529, { error: { message: "Overloaded" } }), now + 25 * 3600_000)
  assert.equal(other.ok, false)
  assert.equal(useApi(db, TEXT, now + 25 * 3600_000), true) // a one-off error does not pause

  apiCommand(db, "off")
  assert.equal(useApi(db, TEXT, now + 25 * 3600_000), false)
  apiCommand(db, "on")
  assert.equal(useApi(db, TEXT, now + 25 * 3600_000), true)

  process.env.DOBBY_API_KEY = ""
  assert.equal(useApi(db, TEXT), false) // no key: plan
})

test("router: credits when the weekly limit is ahead of pace or the credit month is ending, else the plan", async () => {
  const { apiWanted } = await import("../src/api.ts")
  const { ensure } = await import("../src/usage.ts")
  const db = open(":memory:")
  const mid = Date.parse("2026-10-10T06:00:00Z") // 10 Oct: 22 days left in the month
  assert.equal(apiWanted(db, mid).api, true) // no reading yet: as before
  ensure(db)
  const tick = (week: number) => db.prepare("INSERT OR REPLACE INTO usage_ticks VALUES (?,?,?,?,?)").run(mid, 10, week, mid + 3600_000, mid + 3.5 * 86400_000)
  tick(30) // half the week gone, 30% used: behind pace, the plan has room
  assert.equal(apiWanted(db, mid).api, false)
  tick(70) // ahead of pace: protect the weekly cap
  assert.equal(apiWanted(db, mid).api, true)
  tick(30)
  assert.equal(apiWanted(db, Date.parse("2026-10-28T06:00:00Z")).api, true) // last 5 days of October: spend the credits
})

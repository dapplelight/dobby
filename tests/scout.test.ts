import assert from "node:assert/strict"
import { test } from "node:test"
import { addRule, parseProposals, reviewFindings, scoutDue } from "../src/scout.ts"
import { open } from "../src/db.ts"

test("scout: strict proposals (safe licenses, pinned commit, clean names) and once a night", () => {
  const ok = { type: "skill", role: "builder", name: "tdd", repo: "o/r", path: "skills/tdd/SKILL.md", sha: "abc1234", license: "MIT", why: "x" }
  const lines = [ok, { ...ok, license: "CC-BY-NC-SA-4.0" }, { ...ok, sha: "main" }, { ...ok, name: "../x" }, { ...ok, path: "install.sh" }, { type: "retro", title: "t", why: "w" }, "junk"].map((x) => JSON.stringify(x)).join("\n")
  const got = parseProposals(lines)
  assert.deepEqual(got.map((p) => p.type), ["skill", "retro"])
  const db = open(":memory:")
  const two = Date.parse("2026-10-24T20:30:00Z") // 02:00 IST on the 25th (the fixture's zone)
  assert.equal(scoutDue(db, undefined, two), true)
  assert.equal(scoutDue(db, undefined, Date.parse("2026-10-25T08:30:00Z")), false) // 14:00 IST, daytime: builders' budget
  db.prepare("INSERT INTO kv VALUES ('scout:last', ?)").run("2026-10-24") // the night key: the day its 23:00 window opened
  assert.equal(scoutDue(db, undefined, two), false) // already ran tonight
})

test("usage: a transcript line is priced from Anthropic's rates; ticks give $ per 1%", async () => {
  const { toCall, price, ensure, perPercent } = await import("../src/usage.ts")
  const line = JSON.stringify({ type: "assistant", timestamp: "2026-10-17T05:00:00Z", sessionId: "s", entrypoint: "cli",
    message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 1000, cache_read_input_tokens: 1_000_000, output_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } } } })
  const c = toCall(line, "p")!
  assert.equal(c.source, "you")
  assert.ok(Math.abs(c.usd - (1000 * 4 + 1000 * 8 + 1_000_000 * 0.2 + 1000 * 20) / 1e6) < 1e-9) // fresh, 1h write (2x), cache read (5%), output
  assert.equal(price("claude-haiku-5-5", 200_000).in, 0.5) // over 100K: 5x
  assert.equal(toCall('{"type":"user"}', "p"), null)
  const db = open(":memory:"); ensure(db)
  const now = Date.now()
  db.prepare("INSERT INTO usage_ticks VALUES (?,?,?,?,?)").run(now - 3000, 10, 5, 1, 9)
  db.prepare("INSERT INTO usage_calls (id, at, usd) VALUES ('a', ?, 2.5)").run(now - 2000)
  db.prepare("INSERT INTO usage_ticks VALUES (?,?,?,?,?)").run(now - 1000, 11, 5, 1, 9)
  assert.equal(perPercent(db, "five").median, 2.5)
})

test("scout rules: only safe files and one-line rules; added once under 'Learned from reviews'; findings come from fix tickets", () => {
  const rule = (file: string, r = "Find items by id.") => JSON.stringify({ type: "rule", file, rule: r, why: "3 findings" })
  const got = parseProposals([rule("roles/builder.md"), rule("agent-rules.md"), rule("projects/tally.md"), rule("src/lib.ts"), rule("../x.md"), rule("roles/builder.md", "two\nlines"), rule("projects/tally.knowledge.md")].join("\n"))
  assert.deepEqual(got.map((p) => (p as { file: string }).file), ["roles/builder.md", "agent-rules.md", "projects/tally.md"])
  const once = addRule("# Builder\nbody\n", "Find items by id.")
  assert.equal(once, "# Builder\nbody\n\n## Learned from reviews\n- Find items by id.\n")
  assert.equal(addRule(once, "Find items by id."), once) // already there
  assert.equal(addRule(once, "Second."), `${once}- Second.\n`)
  const db = open(":memory:")
  const now = new Date().toISOString()
  db.prepare("INSERT INTO tickets (project,title,done_when,created_at,updated_at) VALUES ('shopfront','Fix review findings on x#1',?,?,?)").run("Every open finding is fixed:\n- [medium] a.tsx:1 indexOf on a copy\nother", now, now)
  assert.deepEqual(reviewFindings(db).map((l) => l.replace(/#\d+/, "#N")), ["shopfront #N [medium] a.tsx:1 indexOf on a copy"])
  // commits now go through a pull request: tests/security.test.ts (Scout through a PR)
})

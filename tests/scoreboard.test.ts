// Review scoreboard over an in-memory DB. Offline.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

process.env.DOBBY_DIR = mkdtempSync(`${tmpdir()}/dobby-score-`)
const { open } = await import("../src/db.ts")
const { scoreboard, scoreboardText } = await import("../src/view.ts")
const D = await import("../src/dashboard.ts")

const NOW = Date.parse("2026-10-20T12:00:00Z")
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

function fixture() {
  const db = open(":memory:")
  const review = (repo: string, pr: number, sha: string, verdict: string, d: number) =>
    db.prepare("INSERT INTO reviews (repo, pr, sha, verdict, at) VALUES (?,?,?,?,?)").run(repo, pr, sha, verdict, daysAgo(d))
  const ticket = (id: number, status: string, note: string | null, d: number, onto: string | null = null) =>
    db.prepare("INSERT INTO tickets (id,project,title,status,note,onto,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, "tally", `Thing ${id}: details`, status, note, onto, daysAgo(d + 1), daysAgo(d))
  // PR 1: Dobby's, opened 3 days ago, failed twice, then passed, shipped
  ticket(1, "shipped", "https://github.com/o/tally/pull/1", 1); review("o/tally", 1, "a", "fail", 3); review("o/tally", 1, "b", "fail", 2); review("o/tally", 1, "c", "pass", 1)
  // fix ticket on PR 1 shipped: not a merge, not an open
  ticket(2, "shipped", "https://github.com/o/tally/pull/1", 1, "foreman/1")
  // PR 2: owner's, reviewed 4 days ago, passed
  review("o/tally", 2, "d", "pass", 4)
  // PR 3: opened 9 days ago, failed 9 days ago (out of window), passed 5 days ago
  ticket(3, "shipped", "https://github.com/o/tally/pull/3", 8); review("o/tally", 3, "e", "fail", 9); review("o/tally", 3, "f", "pass", 5)
  return db
}

test("scoreboard: 7-day counts, rounds, old fails and fix tickets", () => {
  const sb = scoreboard(fixture(), 7, NOW)
  assert.equal(sb.opened, 2) // PRs 1 and 2; PR 3 opened 9 days ago
  assert.equal(sb.sentBack, 1)
  assert.equal(sb.merged, 1) // ticket 1; ticket 3 is old, ticket 2 is a fix
  assert.deepEqual(sb.sentBackPrs, [{ repo: "o/tally", pr: 1, url: "https://github.com/o/tally/pull/1", title: "Thing 1", rounds: 2 }])
})

test("scoreboardText: singular, plural, +N more after 5", () => {
  const p = (pr: number) => ({ repo: "o/r", pr, url: "", rounds: 1 })
  assert.equal(scoreboardText({ opened: 1, sentBack: 0, merged: 0, sentBackPrs: [] }), "This week: 1 PR opened · 0 needed changes · 0 merged")
  const t = scoreboardText({ opened: 14, sentBack: 7, merged: 11, sentBackPrs: [1, 2, 3, 4, 5, 6, 7].map(p) }).split("\n")
  assert.equal(t[0], "This week: 14 PRs opened · 7 needed changes · 11 merged")
  assert.equal(t[1], "• o/r#1 · 1 round of changes")
  assert.equal(t.length, 7); assert.equal(t[6], "+2 more")
})

test("snapshot includes scoreboard", () => {
  assert.equal(D.snapshot(fixture(), NOW, 7).scoreboard.sentBack, 1)
})

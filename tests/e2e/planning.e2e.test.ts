// The Product Manager and Area PM through the real CLI (`dobby pm`), with a fake Claude answering in the card format. Temp world only.
import assert from "node:assert/strict"
import { test } from "node:test"
import { world } from "./harness.ts"

const cards = (...c: object[]) => c.map((x) => JSON.stringify(x)).join("\n")

test("PM: problems become backlog tickets, a new idea is stored, an L ticket gets its PRD, the note is kept; a repeat adds nothing", () => {
  const big = { type: "problem", title: "Export the year as a CSV", score: 40, size: "L", why: "people ask for it", experiment: "a download button" } // ticket 2, after the score-80 one
  const w = world({
    project: ["areas: reports, budgets"],
    scenario: { roles: { pm: [{ reply: cards(
      { type: "problem", title: "Show the monthly total on the home screen", score: 80, size: "S", why: "it is the number people look for", evidence: "3 support mails", experiment: "the total is visible without scrolling" },
      big,
      { type: "problem", title: "show the MONTHLY total on the home screen!", score: 10 },
      { type: "idea", title: "A weekly recap", pitch: "A Sunday summary", why: "people forget", how: "one short email", experiment: "send it to three people", size: "M" },
      { type: "prd", ticket: 2, prd: "Goal: export a year.\nNot in scope: pdf." },
      { type: "note", text: "Home screen first, exports later." },
      { type: "nonsense", title: "dropped" },
    ) }] } },
  })
  try {
    w.dobby("resume", "planning")
    const out = w.dobby("pm", "tally")
    assert.match(out.out, /Product Manager · tally: 2 problem\(s\) to the backlog, 1 new idea\(s\) posted, PRD for #\d+/, out.out)
    assert.match(out.out, /note: Home screen first, exports later\./)
    const tickets = w.sql<{ id: number; title: string; status: string; size: string; priority: number; note: string | null; prd: string | null }>("SELECT id, title, status, size, priority, note, prd FROM tickets WHERE note LIKE 'from the Product Manager%' ORDER BY priority DESC")
    assert.deepEqual(tickets.map((t) => [t.title, t.status, t.size, t.priority]), [["Show the monthly total on the home screen", "backlog", "S", 80], ["Export the year as a CSV", "backlog", "L", 40]], "the duplicate title (same words) was skipped")
    assert.equal(w.sql<{ prd: string | null }>("SELECT prd FROM tickets WHERE id=?", tickets[1].id)[0].prd, "Goal: export a year.\nNot in scope: pdf.", "the PRD went onto the L ticket")
    assert.equal(w.sql<{ n: number }>("SELECT count(*) n FROM ideas WHERE title='A weekly recap' AND status='proposed'")[0].n, 1)
    assert.match(w.dobby("ideas", "tally").out, /A weekly recap/)
    assert.match(w.kv(`pm:tally:${new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)}`) ?? "", /Home screen first/)
    assert.deepEqual(w.roles(), ["pm"])
    assert.equal(w.log()[0].model, "opus", "the PM runs on Opus")
    assert.ok(w.log()[0].args.includes("--disallowedTools"), "read-only tools")
    // a second run the same day: every problem and the idea are already on the board
    const again = w.dobby("pm", "tally")
    assert.match(again.out, /0 problem\(s\) to the backlog, 0 new idea\(s\) posted/)
  } finally { w.clean() }
})

test("Area PM: one area a day in rotation, problems filed, no new ideas posted", () => {
  const w = world({
    project: ["areas: reports, budgets"],
    scenario: { roles: { "area-pm": [
      { reply: cards({ type: "problem", title: "Reports load slowly", score: 55, size: "M" }, { type: "idea", title: "Not posted by the area PM" }, { type: "note", text: "Reports: slow query." }) },
      { reply: cards({ type: "problem", title: "Budgets can go negative", score: 60, size: "S" }) },
    ] } },
  })
  try {
    w.dobby("resume", "planning")
    const first = w.dobby("pm", "tally", "--area")
    assert.match(first.out, /Product Manager \(reports\) · tally: 1 problem\(s\) to the backlog, 0 new idea\(s\) posted/, first.out)
    const second = w.dobby("pm", "tally", "--area")
    assert.match(second.out, /Product Manager \(budgets\) · tally: 1 problem/, "the next area")
    assert.equal(w.log()[0].model, "sonnet")
    assert.equal(w.sql("SELECT 1 FROM ideas WHERE title='Not posted by the area PM'").length, 0)
    assert.match(w.kv(`area:tally:${new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10)}:reports`) ?? "", /slow query/)
  } finally { w.clean() }
})

test("PM and Area PM: planning paused, no areas, and a failed run are said plainly", () => {
  const w = world({ scenario: { roles: { pm: [{ error: "overloaded" }] } } })
  try {
    assert.match(w.dobby("pm", "tally").out, /tally: planning planning paused by the owner/, "planning is paused in a fresh world")
    w.dobby("resume", "planning")
    assert.match(w.dobby("pm", "tally", "--area").out, /tally: no areas: in its dobby\.md, so no Area PM/)
    const failed = w.dobby("pm", "tally")
    assert.match(failed.out, /0 problem\(s\) to the backlog, 0 new idea\(s\) posted \(run failed: overloaded\)/, failed.out)
    assert.match(w.dobby("pm", "ghost").out + "", /no dobby\.md for ghost/)
  } finally { w.clean() }
})

// The everyday CLI against a real (temp) database: list, status, show, queue, hint, cancel, pause, cost and the rest, through
// `src/cli.ts` as a program. One world shared by the tests below (they read what scenario 1 shipped); fake Claude and GitHub.
import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import { test } from "node:test"
import { world } from "./harness.ts"

const w = world({ scenario: "happy-path" })
const shipped = w.addTicket("Add a farewell helper", "src/farewell.js exports farewell(name)")
w.runUntilIdle()
const second = w.addTicket("Show the total on the home screen", "the total is visible", "M", 70)
const third = w.addTicket("Round the total to two places", "no more than two decimals", "S", 60)
test.after(() => w.clean())
const run = (...a: string[]) => { const r = w.dobby(...a); assert.equal(r.code, 0, `dobby ${a.join(" ")}: ${r.out}`); return r.out }
const refused = (...a: string[]) => { const r = w.dobby(...a); assert.equal(r.code, 1, `dobby ${a.join(" ")} should be refused: ${r.out}`); return r.out }

test("what is open and what shipped", () => {
  assert.equal(w.ticket(shipped).status, "shipped")
  assert.match(run("list"), new RegExp(`Ready \\(2\\)\\n {2}Show the total on the home screen {2}tally {2}\\S+ {2}#${second}\\n {2}Round the total to two places {2}tally {2}\\S+ {2}#${third}`))
  assert.doesNotMatch(run("list", "--all"), /shipped|declined/, "--all is every open ticket: shipped and declined stay out (the help says so)")
  assert.equal(run("list", "--all").trim(), `#${second} [ready] tally M p70  Show the total on the home screen\n#${third} [ready] tally S p60  Round the total to two places`)
  const status = run("status")
  assert.match(status, /^Running · 5-hour 10% \(cap \d+%\) · week 10% of 95%/)
  assert.match(status, /✅ Shipped today \(1\)/)
  assert.match(status, /⏸ Paused: planning by the owner/)
  const show = run("show", String(shipped))
  assert.match(show, /^#1 \[shipped\] tally: Add a farewell helper/)
  assert.match(show, /note: https:\/\/github\.com\/acme\/tally\/pull\/1/)
  assert.match(show, /build 1: ok/)
  assert.match(run("scoreboard"), /Last 7 days: 1 PR opened · 0 needed changes · 1 merged/)
  assert.match(run("cost", String(shipped)), /\*\*Cost of this PR:\*\* <0\.01% of your week[\s\S]*\| Build \|/)
  assert.match(run("receipt"), /^Shipped 1 PR on your Claude plan, \$0 extra\n.*receipt\.svg/)
})

test("limits, capacity, usage and the config the run is using", () => {
  assert.match(run("limits"), /5-hour ▕█░░░░░░░░░▏ 10%\nweek {3}▕█░░░░░░░░░▏ 10% \(cap 95%\)/)
  assert.match(run("capacity"), /no windows recorded yet|window/i)
  assert.match(run("usage"), /^📊 Usage · last 24 hours/)
  assert.equal(run("config", "path").split("\n")[0], `${w.root}/config.json`)
  const shown = run("config", "show")
  assert.match(shown, new RegExp(`^sources: defaults < ${w.root}/config\\.json`))
  assert.match(shown, /"owner": "acme"/)
  assert.doesNotMatch(shown, /DISCORD_BOT_TOKEN|ghp_/)
})

test("what the rules say about a piece of work", () => {
  const safe = run("safety", "explain", "change the login flow")
  assert.match(safe, /^preset: balanced, classifier: none, unsure: allow\ncategories: auth\n {2}auth: review/)
  assert.match(safe, /action: REVIEW/)
  assert.match(run("safety", "explain", "fix a typo"), /categories: none[\s\S]*action: AUTO/)
  assert.match(run("policy", "explain", "rm -rf /"), /command: DENY \(rm-rf: no recursive force deletes\)/)
  assert.match(run("graph"), /^%%\{init[\s\S]*prepare\(prepare\)[\s\S]*ship\(ship\)/)
  assert.match(run("tools"), /^graphify {2}on {3}\w+/)
})

test("queueing: unqueue, queue, reorder, a hint and an answer reach the ticket; cancel stops it", () => {
  assert.match(run("unqueue", String(second)), /#2 is back in the backlog: Show the total/)
  assert.equal(w.ticket(second).status, "backlog")
  assert.match(run("queue", String(second)), /#2 queued; a builder picks it up/)
  assert.match(run("reorder", String(third), String(second)), /#3 is now 1 of 2 in the queue\./)
  assert.match(run("reorder", String(third)), /#3 is now 2 of 2 in the queue\./)
  assert.match(run("hint", String(second), "use the existing formatter"), /Recorded on #2; the next build reads it\./)
  assert.match(w.ticket(second).done_when, /Owner's hint: use the existing formatter/)
  assert.match(run("answer", String(third), "two places, round half up"), /Recorded on #3\./)
  assert.match(run("show", String(third)), /Owner's answer: two places, round half up/)
  assert.match(run("cancel", String(third)), /Cancelled: Round the total to two places\./)
  assert.equal(w.ticket(third).status, "declined")
  assert.match(run("cancel", String(shipped)), /#1 is already shipped\./)
  assert.match(refused("queue", String(shipped)), /was not queued: it is shipped/)
  assert.match(run("reorder", String(shipped)), /#1 is not queued, so it has no place in the order\./)
  assert.match(refused("allowround", String(second)), /#2 has no pull request to fix\./)
  assert.match(refused("merge", String(shipped)), /not landed: not an open, ready PR/)
  assert.match(run("approve", String(second)), /Nothing waits for approval on Show the total/)
})

test("taking a ticket over pauses it; resuming hands it back; pause status lists what is paused", () => {
  assert.match(run("takeover", String(second)), /Paused #2: Show the total on the home screen\. It is yours now\./)
  assert.match(run("pause", "status"), /ticket #2 by the owner since/)
  assert.match(run("resume", "ticket", String(second)), /Resumed ticket #2\./)
  assert.doesNotMatch(run("pause", "status"), /ticket #2/)
  assert.match(run("pause", "for", "5x"), /How long\?|Unknown pause target/)
})

test("ideas: a seed is noted and listed", () => {
  assert.match(run("idea", "tally", "show a yearly summary"), /noted; the Product Manager develops it on its next run/)
  assert.match(run("ideas", "tally"), /show a yearly summary/)
  assert.equal(run("ideas", "shopfront").trim(), "")
})

test("jobs and docs: a dry run installs nothing; the manual works offline", () => {
  assert.match(run("jobs", "status", "--dry"), /✗ tick: not installed here/) // no plist under the test HOME: never the host's job
  assert.match(run("docs"), /^install +Install Dobby/)
  assert.match(run("docs", "pause-and-resume"), /^# Pause and resume/)
  assert.match(run("help", "--all"), /^dobby <command>\n\nGetting started/)
  assert.match(w.dobby("frobnicate").out, /^Unknown command: frobnicate\. Run dobby help\./)
  assert.equal(w.dobby("frobnicate").code, 1)
})

// `dobby health` is the hourly self-check job. It lists ~/Library/LaunchAgents without checking that the folder exists.
test("health: with the LaunchAgents folder present it reports (what it finds depends on the host's free disk, so only the shape is checked)", () => {
  mkdirSync(`${w.dir.home}/Library/LaunchAgents`, { recursive: true })
  const r = w.dobby("health")
  assert.match(r.out, /^(All 0 jobs healthy, \d+ GB free\.|\d+ problem\(s\):\n- disk: [\d.]+ GB free)/, r.out)
  assert.doesNotMatch(r.out, /ENOENT|\n\s+at /)
})
// Real bug the end-to-end run found, fixed: on a machine without ~/Library/LaunchAgents (Linux with systemd jobs, a Mac that never had one)
// the hourly health job died with an uncaught ENOENT from readdirSync (src/health.ts).
test("health: without a LaunchAgents folder (Linux) it still reports", () => {
  const bare = world()
  try {
    const r = bare.dobby("health")
    assert.doesNotMatch(r.out, /ENOENT/, r.out)
  } finally { bare.clean() }
})

// Real bug the end-to-end run found, fixed: a refused command (wrong ticket state) threw the UserError out of cli.ts, so the owner
// got a Node stack trace instead of the one plain line the same refusal gives in Discord and on the dashboard.
test("a refused command prints one plain line and exits 1, not a stack trace", () => {
  const r = w.dobby("unqueue", String(shipped))
  assert.equal(r.code, 1)
  assert.match(r.out, /#1 is already shipped\./)
  for (const args of [["unqueue"], ["hint", "words"], ["retry"], ["takeover"], ["allowround"]]) {
    const x = w.dobby(args[0], String(shipped), ...args.slice(1))
    assert.equal(x.code, 1, `${args[0]}: ${x.out}`)
    assert.equal(x.out.trim().split("\n").length, 1, `${args[0]}: one line, got ${x.out}`)
    assert.doesNotMatch(x.out, /\n\s+at |HTTPException|node:internal/, `${args[0]}: no stack trace`)
  }
})

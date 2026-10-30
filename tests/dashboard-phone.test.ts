// Phone, states and the ⌘K palette (PR 7): the pure parts. Offline, nothing written outside the temp dir.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-phone-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/none.txt`
const { ACTIONS, NAV, KEYS } = await import("../dashboard/src/actions.ts")
const { deriveStates, isPaused, noUrls } = await import("../dashboard/src/lib/states.ts")
const { swipeAction, SWIPE_AT } = await import("../dashboard/src/lib/swipe.ts")
const { paletteItems, DOCS, PAGES } = await import("../dashboard/src/lib/palette.ts")
const { firstLoad, overBudget } = await import("../scripts/check-bundle.ts")
const { Snapshot } = await import("../src/api-schema.ts")
const { open } = await import("../src/db.ts")
const D = await import("../src/dashboard.ts")
const T = await import("../src/dashboard-team.ts")

const NOW = Date.parse("2026-10-20T12:00:00Z")
const h = (n: number) => new Date(NOW - n * 3_600_000).toISOString()
const snap = (over: Record<string, unknown> = {}) => ({
  inbox: { total: 1, rows: [{ key: "t1", kind: "merge", id: 412, project: "tally", ref: "tally #412", title: "CSV export for reports", status: "x", primary: "Merge", warn: false, url: "https://github.com/acme/tally/pull/412", branch: null, checks: [], diff: null, age: "1h", offers: ["decline"] }] },
  working: [{ key: "t5", id: 5, project: "shopfront", ref: "shopfront #5", title: "Checkout on phone", role: "Builder", round: 1, of: 3, step: "building", age: "3h", stuck: true }],
  queue: { order: [{ id: 418, ref: "tally #418", title: "Recurring reports" }], parked: [] },
  limits: { state: "unknown", line: "Plan usage unknown (no reading for 42 min)" }, pause: [], health: [], teamLive: [],
  ...over,
}) as never

// ---- states ----
test("states: each one renders from its own signal, with its one fix", () => {
  const ok = { connection: "live" as const, updatedAt: NOW, canAct: true }
  assert.deepEqual(deriveStates({ ...ok, snap: snap({ limits: null }) }), [])
  const paused = deriveStates({ ...ok, snap: snap({ limits: null, pause: [{ scope: "merges", text: "merges by owner since 09:00" }] }) })
  assert.deepEqual(paused.map((s) => [s.id, s.text, s.resume]), [["paused", "Paused", "merges"]]); assert.ok(isPaused(paused))
  assert.equal(deriveStates({ ...ok, snap: snap({ limits: null, pause: [{ scope: "everything", text: "x" }] }) })[0].resume, "all")
  assert.deepEqual(deriveStates({ ...ok, snap: snap({ limits: null, pause: [{ scope: "ticket #4", text: "x" }] }) }), [], "one paused ticket is not the team paused")
  const usage = deriveStates({ ...ok, snap: snap() })
  assert.equal(usage[0].id, "usage"); assert.match(usage[0].text, /^Plan usage unknown \(no reading for 42 min\)$/); assert.equal(usage[0].command, "dobby doctor")
  const off = deriveStates({ connection: "down", updatedAt: NOW, canAct: true, snap: snap({ limits: null }) })
  assert.equal(off[0].id, "offline"); assert.equal(off[0].text, "Connection lost"); assert.match(off[0].detail!, /last update from \d\d?:\d\d/); assert.match(off[0].detail!, /every 10 seconds/)
  assert.deepEqual(deriveStates({ connection: "connecting", updatedAt: 0, canAct: true, snap: snap({ limits: null }) }), [], "no banner while the stream is still opening")
  assert.match(deriveStates({ connection: "down", updatedAt: 0, canAct: true, snap: undefined })[0].detail!, /^Nothing has loaded yet\./, "no 'last update' when nothing was loaded")
  const out = deriveStates({ ...ok, canAct: false, snap: snap({ limits: null }) })
  assert.equal(out[0].id, "expired"); assert.equal(out[0].command, "dobby dashboard open")
  const both = deriveStates({ connection: "down", updatedAt: 0, canAct: false, snap: snap() })
  assert.deepEqual(both.map((x) => x.id), ["expired"], "signed out is one state: a 401 closing the stream is not a lost connection")
  const setupOut = deriveStates({ ...ok, canAct: false, setupPort: "41234", snap: snap({ limits: null }) })
  assert.match(setupOut[0].detail!, /port 41234/); assert.match(setupOut[0].detail!, /init --ui/); assert.equal(setupOut[0].command, undefined, "setup banner never sends you to dobby dashboard open")
  const claude = deriveStates({ ...ok, snap: snap({ limits: null, health: [{ check: "claude", ok: false, text: "Claude has been signed out for 45 minutes (run claude, then /login)" }] }) })
  assert.equal(claude[0].id, "claude"); assert.match(claude[0].detail!, /claude.*\/login/)
  assert.deepEqual(deriveStates({ ...ok, snap: snap({ limits: null, health: [{ check: "claude", ok: false, text: "the claude command has been missing for 40 minutes" }] }) }), [])
})

test("offline: the stream closing flips the connection and polling takes over (the hook reads the same store)", () => {
  const src = readFileSync(new URL("../dashboard/src/lib/snapshot.ts", import.meta.url), "utf8")
  assert.match(src, /es\.onerror = \(\) => setConnection\("down"\)/)
  assert.match(src, /refetchInterval: \(\) => \(streaming \? false : 10_000\)/)
  assert.match(src, /streaming = c === "live"/)
})

test("expired: with the cookie invalid every write is refused up front with the exact command", async () => {
  const api = readFileSync(new URL("../dashboard/src/lib/api.ts", import.meta.url), "utf8")
  assert.match(api, /if \(!gate\.canAct\) throw new Error\("This browser is signed out: run `dobby dashboard open`\."\)/)
  assert.match(readFileSync(new URL("../dashboard/src/lib/session.ts", import.meta.url), "utf8"), /gate\.canAct = canAct/)
})

test("a running ticket with no change for over 2 hours is stuck, from the server's own read", () => {
  const db = open(":memory:")
  const add = (id: number, hours: number) => db.prepare("INSERT INTO tickets (id,project,title,status,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, "tally", `T${id}`, "running", h(30), h(hours))
  add(1, 1.9); add(2, 2.1)
  assert.deepEqual(D.working(db, NOW).map((w) => [w.id, w.stuck]), [[2, true], [1, false]])
  db.prepare("INSERT INTO reviews (repo,pr,sha,verdict,at) VALUES ('a/b',1,'x','running',?)").run(h(0.1))
  assert.deepEqual(D.teamLive(db, NOW).sort(), ["builder", "reviewer"])
  const s = Snapshot.parse(JSON.parse(JSON.stringify({ ...D.snapshot(db, NOW, 7, undefined), held: [], projects: [] })))
  assert.deepEqual(s.teamLive.sort(), ["builder", "reviewer"]); assert.equal(s.working[0].stuck, true)
})

// ---- swipe ----
test("swipe: right is the main action, left declines, short drags and reduced motion do nothing", () => {
  const o = { offers: ["decline", "takeOver"], reduced: false }
  assert.equal(swipeAction(SWIPE_AT, o), "primary"); assert.equal(swipeAction(SWIPE_AT + 80, o), "primary")
  assert.equal(swipeAction(-SWIPE_AT, o), "decline")
  assert.equal(swipeAction(SWIPE_AT - 1, o), null); assert.equal(swipeAction(-SWIPE_AT + 1, o), null)
  assert.equal(swipeAction(-SWIPE_AT, { offers: [], reduced: false }), null, "no decline on this row")
  assert.equal(swipeAction(300, { ...o, reduced: true }), null); assert.equal(swipeAction(-300, { ...o, reduced: true }), null)
  const home = readFileSync(new URL("../dashboard/src/routes/home.tsx", import.meta.url), "utf8")
  assert.match(home, /onDragEnd=.*swipeAction\(info\.offset\.x, \{ offers: row\.offers, reduced \}\).*onPrimary\(\).*onDecline\(\)/, "a swipe calls the same handlers as the buttons")
  assert.match(home, /if \(reduced\) return <>\{children\}<\/>/, "no drag at all with reduced motion")
  assert.match(home, /onDecline=\{\(\) => send\("decline"\)\}/); assert.match(home, /<Swipe row=\{row\} raised=\{on\} onPrimary=\{onPrimary\}/)
})

// ---- palette ----
test("palette: actions name their target and call the handler with that id; no key events", async () => {
  const two = snap({ limits: null, inbox: { total: 3, rows: [
    { key: "t1", kind: "merge", id: 412, project: "tally", ref: "tally #412", title: "CSV export for reports", status: "x", primary: "Merge", warn: false, url: null, branch: null, checks: [], diff: null, age: "1h", offers: ["decline"] },
    { key: "d1", kind: "deploy", id: null, project: "shopfront", ref: "shopfront", title: "Deploy", status: "x", primary: "Deploy", warn: false, url: null, branch: null, checks: [], diff: null, age: "1h", offers: [] },
    { key: "r1", kind: "decide", id: 409, project: "tally", ref: "tally #409", title: "Login loop on Safari", status: "x", primary: "Retry", warn: false, url: null, branch: null, checks: [], diff: null, age: "1h", offers: [] },
    { key: "a1", kind: "answer", id: 413, project: "tally", ref: "tally #413", title: "Keep the old cookie?", status: "x", primary: "Answer", warn: false, url: null, branch: null, checks: [], diff: null, age: "1h", offers: [] }] } })
  const items = paletteItems({ snap: two, path: "/" })
  const by = (l: string) => items.find((i) => i.label === l)!
  assert.deepEqual(by("Merge tally #412 · CSV export for reports").run, { kind: "act", body: { action: "merge", id: 412 } })
  assert.deepEqual(by("Deploy shopfront").run, { kind: "act", body: { action: "deploy", project: "shopfront" } })
  assert.deepEqual(by("Retry tally #409 · Login loop on Safari").run, { kind: "act", body: { action: "retry", id: 409 } })
  assert.deepEqual(by("Answer tally #413 · Keep the old cookie?").run, { kind: "go", to: "/pr/413" })
  assert.match(by("Merge tally #412 · CSV export for reports").words, /412/)
  // no bare Merge/Deploy/Answer/Retry any more
  for (const l of ["Merge", "Deploy", "Answer", "Retry", "Decline"]) assert.ok(!items.some((i) => i.label === l), `no bare ${l}`)
  // target-less ones stay
  assert.deepEqual(by("Pause the team").run, { kind: "act", body: { action: "pauseTeam" } }); assert.deepEqual(by("New ticket").run, { kind: "ticket" })
  assert.deepEqual(paletteItems({ snap: snap({ limits: null, paused: { at: 1 } }), path: "/" }).find((i) => i.label === "Resume the team")!.run, { kind: "act", body: { action: "resume" } })
  // choosing it posts that item's id, whichever row is selected: the same sendAction the row button uses
  const { sendAction } = await import("../dashboard/src/lib/api.ts")
  const posted: { url: string; body: string }[] = []
  const f = globalThis.fetch
  globalThis.fetch = (async (url: string, init: { body: string }) => { posted.push({ url, body: init.body }); return new Response(JSON.stringify({ ok: true, message: "held" })) }) as never
  try { const r = by("Merge tally #412 · CSV export for reports").run; assert.equal(r.kind, "act"); if (r.kind === "act") await sendAction(r.body) } finally { globalThis.fetch = f }
  assert.deepEqual(posted, [{ url: "/api/action", body: JSON.stringify({ action: "merge", id: 412 }) }])
  for (const f of ["lib/palette.ts", "components/palette.tsx"]) assert.doesNotMatch(readFileSync(new URL(`../dashboard/src/${f}`, import.meta.url), "utf8"), /KeyboardEvent|dispatchEvent|sendKeys/, f)
})

test("pause banner says it plainly, row subtitles drop links", () => {
  const p = { scope: "everything", text: "everything by owner since 10-26 10:09 GMT+5:30", plain: "Everything paused by you since 10:09" }
  assert.equal(deriveStates({ canAct: true, connection: "live", updatedAt: 0, snap: snap({ limits: null, pause: [p] }) })[0].detail, "Everything paused by you since 10:09")
  assert.equal(noUrls("keep the old cookie? https://github.com/acme/tally/pull/412#issuecomment-1"), "keep the old cookie?")
  assert.equal(noUrls("waiting on you"), "waiting on you")
})

test("palette: pages, tickets and PRs by title or number, settings by name, docs topics", () => {
  const items = paletteItems({ snap: snap({ limits: null }), path: "/", config: [{ key: "pacing.weekCap", section: "plan", desc: "Stop starting new work at this share of the week." } as never] })
  for (const p of PAGES) assert.ok(items.some((i) => i.group === "Go to" && i.label === p.label), p.label)
  const go = items.find((i) => i.id === "p:/queue")!; assert.deepEqual(go.keys, ["G", "Q"])
  const t = items.filter((i) => i.group === "Tickets")
  assert.deepEqual(t.map((i) => i.id), ["t:412", "t:5", "t:418"])
  assert.match(t[0].words, /412/); assert.deepEqual(t[0].run, { kind: "go", to: "/pr/412" }); assert.equal(t[0].label, "CSV export for reports")
  const s = items.find((i) => i.group === "Settings")!; assert.equal(s.label, "Stop at"); assert.deepEqual(s.run, { kind: "go", to: "/settings", search: { find: "pacing.weekCap" } })
  assert.equal(items.filter((i) => i.group === "Docs").length, DOCS.length)
  for (const [slug] of DOCS) assert.ok(existsSync(new URL(`../docs/manual/${slug}.md`, import.meta.url)), `docs/manual/${slug}.md exists`)
  assert.ok(new Set(items.map((i) => i.id)).size === items.length, "result ids are unique")
})

test("palette: no two actions share a key in one scope (the registry rule still holds with ⌘K added)", () => {
  const seen = new Map<string, string>()
  for (const e of KEYS) { const k = `${e.scope}:${e.keys.join(" ")}`; assert.ok(!seen.has(k), `${e.id} and ${seen.get(k)} share ${k}`); seen.set(k, e.id) }
  assert.deepEqual(NAV.find((e) => e.id === "palette")!.keys, ["Mod+K"])
})

test("palette: cmdk is in its own lazy chunk, not the first load", { skip: !existsSync(new URL("../dashboard/dist/.vite/manifest.json", import.meta.url)) }, () => {
  const dist = new URL("../dashboard/dist", import.meta.url).pathname
  const first = firstLoad(dist); assert.deepEqual(overBudget(first), [])
  const manifest = JSON.parse(readFileSync(`${dist}/.vite/manifest.json`, "utf8")) as Record<string, { file: string; src?: string }>
  const pal = Object.values(manifest).find((m) => m.src === "src/components/palette.tsx")
  assert.ok(pal, "palette has its own chunk"); assert.ok(!first.files.includes(pal!.file))
  const withCmdk = readdirSync(`${dist}/assets`).filter((f) => f.endsWith(".js") && readFileSync(`${dist}/assets/${f}`, "utf8").includes("cmdk-input"))
  assert.ok(withCmdk.length > 0 && withCmdk.every((f) => !first.files.includes(`assets/${f}`)), "cmdk code is outside the first load")
})

// ---- role summaries ----
test("every built-in role has a one-line summary; an owner's copy without one falls back to the built-in's", () => {
  const roles = new URL("../roles", import.meta.url).pathname
  const view = T.teamView(open(":memory:"), { projects: () => ({}), rolesDir: roles, overrideDir: `${dir}/none` })
  assert.ok(view.roles.length >= 15)
  for (const r of view.roles) { assert.ok(r.does.length > 10 && r.does.length < 140, `${r.name} summary`); assert.doesNotMatch(r.does, /^You are/i); assert.doesNotMatch(r.does, /night/i, r.name) }
  assert.equal(view.roles.find((r) => r.name === "builder")!.does, "Takes one ticket, writes the change on its own branch and runs the checks.")
  const over = `${dir}/over`
  mkdirSync(over, { recursive: true })
  writeFileSync(`${over}/builder.md`, "---\nmodel: haiku\n---\nMy own builder rules.\n1. Mine.\n")
  writeFileSync(`${over}/lead.md`, "---\nsummary: Mine.\n---\nMy lead.\n")
  const v2 = T.teamView(open(":memory:"), { projects: () => ({}), rolesDir: roles, overrideDir: over })
  assert.equal(v2.roles.find((r) => r.name === "builder")!.does, "Takes one ticket, writes the change on its own branch and runs the checks.")
  assert.equal(v2.roles.find((r) => r.name === "lead")!.does, "Mine.")
  assert.equal(v2.roles.find((r) => r.name === "builder")!.edited, true)
})

// ---- contrast ----
const lum = (hex: string) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
test("contrast: every text token meets 4.5:1 on every surface it sits on, in light and dark", () => {
  const css = readFileSync(new URL("../dashboard/src/theme/instrument.css", import.meta.url), "utf8")
  const block = (start: string) => { const i = css.indexOf(start); return css.slice(i, css.indexOf("}", i)) }
  const tok = (b: string) => Object.fromEntries([...b.matchAll(/--(bg|raise|hover|line|ink|ink-2|ink-3|mark|on-mark|warn):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]))
  for (const [name, t] of [["light", tok(block(":root {"))], ["dark", tok(block(".dark {"))]] as const) {
    for (const surface of ["bg", "raise", "hover"]) for (const text of ["ink", "ink-2", "mark", "warn"]) assert.ok(ratio(t[text], t[surface]) >= 4.5, `${name}: ${text} on ${surface} is ${ratio(t[text], t[surface]).toFixed(2)}`)
    assert.ok(ratio(t["on-mark"], t.mark) >= 4.5, `${name}: on-mark on mark ${ratio(t["on-mark"], t.mark).toFixed(2)}`)
    assert.ok(ratio(t.bg, t.warn) >= 4.5, `${name}: the swipe cue's text on warn`)
  }
})

test("copy: no night wording in the new files", () => {
  for (const f of ["lib/states.ts", "lib/palette.ts", "lib/swipe.ts", "components/state-banner.tsx", "components/bottom-tabs.tsx", "components/palette.tsx"]) assert.doesNotMatch(readFileSync(new URL(`../dashboard/src/${f}`, import.meta.url), "utf8"), /night/i, f)
})

test("palette ranking: exact and prefix titles first, no single-letter fuzzy hits, no match for nonsense", async () => {
  const { rank } = await import("../dashboard/src/lib/palette.ts")
  const it = (label: string, words = "", hint = "") => ({ label, words, hint })
  assert.ok(rank(it("Getting started"), "Getting started") > rank(it("Stop at", "getting started soon"), "Getting started"))
  assert.ok(rank(it("Billing and the week"), "billing and the week") > rank(it("Weekly cap (USD)", "billing and the week cap"), "billing and the week"))
  assert.ok(rank(it("Queue"), "q") > rank(it("Merging", "quiet"), "q") && rank(it("Merging", "quiet"), "q") > 0)
  assert.equal(rank(it("Stop at", "Stop starting new work"), "zzzz"), 0)
  assert.equal(rank(it("Acp"), "ac"), 90)
  assert.equal(rank(it("Stop at"), ""), 1)
})

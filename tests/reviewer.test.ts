// Reviewer settings, prompt additions and PR comment commands, offline: a fake Host (gh, model, review) and an in-memory db.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-reviewer-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/secrets.env`
const { open } = await import("../src/db.ts")
const { loadConfig } = await import("../src/config.ts")
const st = await import("../src/reviewer/settings.ts")
const pm = await import("../src/reviewer/prompt.ts")
const cm = await import("../src/reviewer/commands.ts")
type Settings = import("../src/reviewer/settings.ts").Settings

test("settings: no review section = DEFAULTS (everything on but riskBump: Jev picks the model; safety limits kept); review.* and review.repos override; mentionOnly", () => {
  const d = st.resolve(undefined)
  assert.deepEqual(d, st.DEFAULTS)
  assert.deepEqual([d.auto, d.commands, d.ask, d.describe, d.maxFindings, d.strictness, d.riskBump, d.contextPack, d.learn, d.fix], ["off", true, true, true, 0, "default", false, true, true, true])
  assert.deepEqual([d.fullReviewsPerDay, d.maxPerScan, d.maxChats], [3, 4, 3])
  const c = { commands: false, maxFindings: 10, repos: { "a/b": { commands: true, auto: "off" as const } } }
  assert.deepEqual([st.resolve(c).commands, st.resolve(c).maxFindings, st.resolve(c, "a/b").commands, st.resolve(c, "a/b").auto, st.resolve(c, "x/y").auto], [false, 10, true, "off", "off"])
  assert.deepEqual([st.resolve({ commands: false, mentionOnly: true }).auto, st.resolve({ commands: false, mentionOnly: true }).commands], ["off", true])
})

test("settings: in the config file; a bad review value drops only the review section, with a warning", () => {
  const priv = `${dir}/cfg.json`, repo = `${dir}/none.json`
  writeFileSync(priv, JSON.stringify({ review: { learn: false, repos: { "a/b": { fix: false } } } }))
  const l = loadConfig({ repo, private: priv })
  assert.deepEqual(l.warnings, [])
  assert.deepEqual([st.resolve(l.config.review).learn, st.resolve(l.config.review, "a/b").fix], [false, false])
  writeFileSync(priv, JSON.stringify({ timezone: "Europe/London", review: { handle: "foreman" } }))
  const bad = loadConfig({ repo, private: priv })
  assert.equal(bad.config.timezone, "Europe/London")
  assert.equal(bad.config.review, undefined)
  assert.match(bad.warnings[0], /review\.handle/)
  assert.equal(loadConfig({ repo, private: null }).config.review, undefined) // defaults() has no review key: migrate writes nothing new
})

test("modes: auto on/drafts/off, base branches, skip label, ignore in the description, paused PR; path filters and risk paths", () => {
  const s = (o: Partial<Settings> = {}) => ({ ...st.DEFAULTS, auto: "drafts" as const, ...o })
  const p = { isDraft: false, baseRefName: "main", labels: [], body: "" }
  assert.equal(st.autoSkip(s(), p), "")
  assert.equal(st.autoSkip(s(), { ...p, isDraft: true }), "draft")
  assert.equal(st.autoSkip(s({ auto: "on" }), { ...p, isDraft: true }), "")
  assert.equal(st.autoSkip(s({ auto: "off" }), p), "auto reviews off")
  assert.equal(st.autoSkip(st.resolve({ mentionOnly: true }), p), "mention-only")
  assert.match(st.autoSkip(s({ branches: ["release/*"] }), p), /not in review.branches/)
  assert.equal(st.autoSkip(s({ branches: ["release/*", "main"] }), p), "")
  assert.equal(st.autoSkip(s(), { ...p, labels: [{ name: "no-review" }] }), "label no-review")
  assert.equal(st.autoSkip(s({ skipLabel: "" }), { ...p, labels: [{ name: "no-review" }] }), "")
  assert.match(st.autoSkip(s(), { ...p, body: "WIP\n@dobby ignore" }), /ignore in the description/)
  assert.equal(st.autoSkip(s({ commands: false }), { ...p, body: "@dobby ignore" }), "")
  assert.equal(st.autoSkip(s(), { ...p, body: "mail me@dobby ignore" }), "")
  assert.equal(st.autoSkip(s(), p, true), "paused on this PR")
  const f = s({ includePaths: ["src/**"], excludePaths: ["**/*.lock", "src/gen/**"] })
  assert.deepEqual(["src/a.ts", "README.md", "src/gen/x.ts", "src/b.lock"].map((x) => st.pathReviewed(f, x)), [true, false, false, false])
  assert.deepEqual(["src/wallet.ts", "bin/guard-hook.mjs", "db/migrations/1.sql", "src/oauth/cb.ts", "src/footer.tsx"].map((x) => st.risky(s(), x)), [true, true, true, true, false])
})

test("prompt: findings cap only when set, strictness, known-intentional hints, context pack from the graph (none without one)", () => {
  const role = "1. stuff\n7. Report every real finding, ranked most severe first. Each one sits"
  assert.equal(pm.roleFor(role, { maxFindings: 0 }), role)
  assert.match(pm.roleFor(role, { maxFindings: 10 }), /7\. At most 10 findings, most severe first\. Each/)
  assert.equal(pm.extras({ strictness: "default", learn: true }), "")
  assert.match(pm.extras({ strictness: "chill", learn: true }), /^\n\nSTRICTNESS chill/)
  assert.match(pm.extras({ strictness: "assertive", learn: true }), /also report low findings/)
  const learnings = [{ path: "a.ts", problem: "[low] x is unchecked", at: "" }]
  assert.match(pm.extras({ strictness: "default", learn: true }, { learnings }), /KNOWN INTENTIONAL[\s\S]*- a\.ts: \[low\] x is unchecked/)
  assert.equal(pm.extras({ strictness: "default", learn: false }, { learnings }), "")
  const run = (_c: string, args: string[]) => ({ ok: true, out: args.at(-1) === "src/a.ts" ? "abc1234 Fix totals\n" : "" })
  assert.equal(pm.contextPack(dir, ["src/a.ts"], run, { contextFiles: 10 }), "") // no graph, no pack
  const g = `${dir}/graph.json`
  writeFileSync(g, JSON.stringify({
    nodes: [{ id: "a", label: "total()", source_file: "src/a.ts" }, { id: "b", label: "page", source_file: "src/b.ts", source_location: "L4" }, { id: "t", label: "test total", source_file: "tests/a.test.ts" }, { id: "c", label: "inner", source_file: "src/a.ts" }],
    links: [{ source: "b", target: "a", relation: "calls" }, { source: "t", target: "a", relation: "calls" }, { source: "c", target: "a", relation: "calls" }],
  }))
  const pack = pm.contextPack(dir, ["src/a.ts"], run, { contextFiles: 10 }, g)
  assert.match(pack, /^CONTEXT PACK[\s\S]*Callers outside the diff:\nsrc\/b\.ts:L4 calls total\(\) \(src\/a\.ts\)\nTests touching the changed code:\ntests\/a\.test\.ts calls total\(\)[\s\S]*Recent history:\nsrc\/a\.ts:\n  abc1234 Fix totals$/)
  assert.ok(!pack.includes("inner")) // same-file links are not callers
  writeFileSync(g, "{ not json")
  assert.match(pm.contextPack(dir, ["src/a.ts"], run, { contextFiles: 10 }, g), /^CONTEXT PACK[\s\S]*Recent history/) // unreadable graph = history only
})

test("parse: @handle verbs, aliases, unknown = help, ask keeps the question", () => {
  assert.deepEqual(cm.parseCommand("dobby", "@dobby full review please"), { verb: "full review", rest: "please" })
  assert.deepEqual(cm.parseCommand("dobby", "hey @Dobby review"), { verb: "review", rest: "" })
  assert.deepEqual(cm.parseCommand("dobby", "@dobby config"), { verb: "configuration", rest: "" })
  assert.deepEqual(cm.parseCommand("dobby", "@dobby rate limit"), { verb: "quota", rest: "" })
  assert.deepEqual(cm.parseCommand("dobby", "@dobby ask why twice?\nline 2"), { verb: "ask", rest: "why twice?\nline 2" })
  assert.deepEqual(cm.parseCommand("dobby", "@dobby do a dance"), { verb: "help", rest: "" })
  assert.equal(cm.parseCommand("dobby", "thanks @dobby, nice catch"), null) // a passing mention is no command
  assert.equal(cm.parseCommand("dobby", "cc @dobby"), null)
  assert.equal(cm.parseCommand("dobby", "me@dobby review"), null)
  assert.equal(cm.parseCommand("dobby", "@dobbyfan review"), null)
})

// ---- the fake Host --------------------------------------------------------------------------------------------------
type C = { id: number; login: string; body: string; created: string; url?: string; pr?: number; root?: number; path?: string; line?: number }
const at = (m: number) => `2026-10-16T10:${String(m).padStart(2, "0")}:00Z`
const SINCE = at(0)
function fake(o: { issue?: C[]; review?: C[]; writers?: string[]; verdict?: string; prBody?: string; model?: string; walk?: string; thumbs?: object[]; reactions?: object[]; budget?: boolean; settings?: Partial<Settings>; strangerPrs?: number[]; ownerChats?: number[]; head?: string; permFail?: string[] } = {}) {
  const calls: string[][] = [], posts: { method: string; path: string; body: any }[] = [], reviews: { pr: number; full: boolean }[] = [], answers: string[] = [], prompts: string[] = []
  const h: import("../src/reviewer/commands.ts").Host = {
    mark: "<!-- foreman-review -->", chatMark: "<!-- foreman-chat -->",
    me: () => "dobby-bot",
    settings: () => ({ ...st.DEFAULTS, ...o.settings }),
    budget: () => (o.budget === false ? { ok: false, why: "5-hour window at 80%" } : { ok: true, why: "" }),
    run: (cmd, args) => {
      calls.push([cmd, ...args])
      const path = args.find((a) => a.startsWith("repos/")) ?? ""
      if (path.includes("/issues/comments?since=")) return { ok: true, out: (o.issue ?? []).map((c) => JSON.stringify(c)).join("\n") }
      if (path.includes("/pulls/comments?since=")) return { ok: true, out: (o.review ?? []).map((c) => JSON.stringify(c)).join("\n") }
      if (path.endsWith("/permission") && (o.permFail ?? []).includes(path.split("/")[4])) return { ok: false, out: "HTTP 403: API rate limit exceeded" }
      if (path.endsWith("/permission")) return { ok: true, out: (o.writers ?? ["owner"]).includes(path.split("/")[4]) ? "write\n" : "read\n" }
      if (args[0] === "pr" && args[1] === "view") return { ok: true, out: JSON.stringify({ title: "Fix", body: o.prBody ?? "", headRefOid: "head123456", baseRefName: "main", headRefName: o.head ?? "fix/a" }) }
      if (path === "repos/a/b/pulls/comments/10") return { ok: true, out: JSON.stringify({ body: "**[high]** total is wrong\n\n**Fix:** x\n\n<!-- foreman-review -->", path: "src/a.ts", login: "dobby-bot" }) }
      if (path === "repos/a/b/pulls/comments/11") return { ok: true, out: JSON.stringify({ body: "a human comment", path: "src/a.ts", login: "owner" }) }
      if (path.startsWith("repos/a/b/pulls/comments?sort=updated")) return { ok: true, out: (o.thumbs ?? []).map((c) => JSON.stringify(c)).join("\n") }
      if (path.endsWith("/reactions") && args.includes("--jq")) return { ok: true, out: (o.reactions ?? [{ login: "owner", at: at(30) }, { login: "stranger", at: at(31) }]).map((c) => JSON.stringify(c)).join("\n") }
      if (/issues\/\d+\/comments$/.test(path)) return { ok: true, out: o.walk ? JSON.stringify({ id: 99, body: o.walk }) : "" }
      return { ok: true, out: "" }
    },
    api: (method, path, body) => (posts.push({ method, path, body }), { ok: true, out: "https://github.com/a/b/pull/7#c\n" }),
    review: async (_r, pr, x) => (reviews.push({ pr, full: x.full }), { state: "success", why: "pass (sonnet, fallback)", url: "" }),
    verdict: () => o.verdict,
    lands: (_r: string, _p: number, i: { headRefName?: string }) => /^(foreman|scout)\//.test(i.headRefName ?? ""),
    answer: async (_r, c) => (answers.push(c.body), "haiku answered"),
    model: async (_r, _pr, prompt) => (prompts.push(prompt({ title: "Fix", body: o.prBody ?? "", headRefOid: "head123456", baseRefName: "main" })), { ok: true, text: o.model ?? "", info: { title: "Fix", body: o.prBody ?? "", headRefOid: "head123456", baseRefName: "main" } }),
    threads: () => [{ id: "T1", path: "a.ts", line: 1 }, { id: "T2", path: "b.ts", line: 2 }],
    fix: async () => "🛠 Ticket #1 (tally): Fix review findings on a/b#7.",
    trusted: (_r, pr) => !(o.strangerPrs ?? []).includes(pr),
    kind: async (_r, text) => (/won'?t fix|by design/i.test(text) ? "dismiss" : /^(thanks|done)\b/i.test(text) ? "ack" : "question"),
    chatOwns: (_r, c) => (o.ownerChats ?? []).includes(c.id),
  }
  const replies = () => posts.filter((p) => p.method === "POST").map((p) => p.body.body.replace(/\n\n<!-- foreman-chat -->$/, ""))
  return { h, calls, posts, reviews, answers, prompts, replies }
}
const cmd = (id: number, body: string, o: Partial<C> = {}): C => ({ id, login: "owner", body, created: at(id), url: `https://github.com/a/b/pull/7#issuecomment-${id}`, ...o })
const scanOnce = async (f: ReturnType<typeof fake>, o: { now?: number } = {}) => {
  const db = open(":memory:")
  db.prepare("INSERT INTO kv VALUES ('review:cmd:a/b', ?)").run(SINCE)
  return { db, out: await cm.commandsScan(db, f.h, [{ slug: "a/b" }], { now: o.now ?? Date.parse(at(59)) }) }
}

test("commands: the first scan only sets the mark; strangers and our own replies are ignored; eyes + a reply; argument arrays only", async () => {
  const f = fake({ issue: [cmd(1, "@dobby help"), cmd(2, "@dobby review", { login: "stranger" }), cmd(3, "@dobby help\n\n<!-- foreman-chat -->"), cmd(4, "@foreman why?")] })
  const db = open(":memory:")
  assert.deepEqual(await cm.commandsScan(db, f.h, [{ slug: "a/b" }], { now: 1000 }), [])
  assert.equal(f.calls.length, 0)
  const { out, db: db2 } = await scanOnce(f)
  assert.deepEqual(out, ["a/b #7 help: Commands:", "a/b: ignored 1 comment from users without write access"])
  assert.deepEqual(f.reviews, [])
  assert.ok(f.calls.some((c) => c.join(" ") === "gh api -X POST repos/a/b/issues/comments/1/reactions -f content=eyes"))
  assert.match(f.replies()[0], /^Commands:\n`@dobby review`/)
  assert.ok(f.calls.every((c) => ["gh", "git"].includes(c[0])))
  // the cursor sits on the newest comment seen, (created, id): nothing twice, nothing skipped
  assert.deepEqual(JSON.parse((db2.prepare("SELECT v FROM kv WHERE k='review:cmd:a/b'").get() as { v: string }).v), { at: at(4), id: 4 })
  const off = fake({ issue: [cmd(1, "@dobby help")], settings: { commands: false, ask: false, learn: false } })
  assert.equal(cm.wantsCommands(off.h.settings("a/b")), false)
  assert.deepEqual((await scanOnce(off)).out, [])
})

test("commands: review is idempotent per head; full review runs whole and is capped per PR per day", async () => {
  let f = fake({ issue: [cmd(1, "@dobby review")], verdict: "pass" })
  await scanOnce(f)
  assert.deepEqual(f.reviews, [])
  assert.match(f.replies()[0], /^Already reviewed head123 \(pass\)\. `@dobby full review`/)
  f = fake({ issue: [cmd(1, "@dobby review")] })
  await scanOnce(f)
  assert.deepEqual(f.reviews, [{ pr: 7, full: false }])
  assert.match(f.replies()[0], /^Review of head123: pass/)
  f = fake({ issue: [1, 2, 3].map((i) => cmd(i, "@dobby full review")), verdict: "pass", settings: { fullReviewsPerDay: 2 } })
  const { db } = await scanOnce(f)
  assert.deepEqual(f.reviews, [{ pr: 7, full: true }, { pr: 7, full: true }])
  assert.match(f.replies()[2], /Full review limit reached: 2 per PR per day/)
  const q = fake({ issue: [cmd(5, "@dobby quota")], settings: { fullReviewsPerDay: 2 } })
  const qdb = open(":memory:")
  qdb.prepare("INSERT INTO kv VALUES ('review:cmd:a/b', ?)").run(SINCE)
  qdb.prepare("INSERT INTO kv VALUES (?, '1')").run(`review:full:a/b#7:${new Date(Date.parse(at(59))).toISOString().slice(0, 10)}`)
  await cm.commandsScan(qdb, q.h, [{ slug: "a/b" }], { now: Date.parse(at(59)) })
  assert.match(q.replies()[0], /^Full reviews left today on this PR: 1 of 2\. Automatic reviews: up to 4 PRs per scan\. Usage budget now: ok\.$/)
  assert.ok(db)
})

test("commands: pause/resume per PR in kv, resolve our threads, configuration, ignore, fix gated by its setting", async () => {
  const f = fake({ issue: [cmd(1, "@dobby pause"), cmd(2, "@dobby resolve"), cmd(3, "@dobby configuration")] })
  const { db } = await scanOnce(f)
  assert.ok(db.prepare("SELECT 1 FROM kv WHERE k='review:paused:a/b#7'").get())
  assert.equal(f.calls.filter((c) => c.includes("graphql")).length, 2)
  assert.match(f.replies()[1], /^Resolved 2 of my 2 open comments\.$/)
  assert.match(f.replies()[2], /^Review settings for a\/b:\n```json\n\{\n  "auto": "off"/)
  const r = fake({ issue: [cmd(4, "@dobby resume"), cmd(5, "@dobby fix"), cmd(6, "@dobby ignore")] })
  db.prepare("UPDATE kv SET v=? WHERE k='review:cmd:a/b'").run(SINCE)
  await cm.commandsScan(db, r.h, [{ slug: "a/b" }], { now: Date.parse(at(59)) })
  assert.equal(db.prepare("SELECT 1 FROM kv WHERE k='review:paused:a/b#7'").get(), undefined)
  assert.match(r.replies()[1], /^🛠 Ticket #1/)
  assert.match(r.replies()[2], /in the PR description/)
  const off = fake({ issue: [cmd(5, "@dobby fix"), cmd(6, "@dobby ask why?")], settings: { fix: false, ask: false } })
  await scanOnce(off)
  assert.deepEqual(off.replies(), ["`fix` is off in this repo's review settings.", "`ask` is off in this repo's review settings."])
})

test("ask: @dobby ask and replies in our threads get a read-only answer; not in someone else's thread; budget gates model work", async () => {
  const f = fake({
    issue: [cmd(1, "@dobby ask why does this sum twice?")],
    review: [{ id: 20, login: "owner", body: "is this really a bug?", created: at(2), pr: 7, root: 10, path: "src/a.ts", line: 3 }, { id: 21, login: "owner", body: "hmm", created: at(3), pr: 7, root: 11 }, { id: 22, login: "owner", body: "top-level review comment", created: at(4), pr: 7, root: 22 }],
  })
  const { out } = await scanOnce(f)
  assert.deepEqual(f.answers, ["why does this sum twice?", "is this really a bug?"])
  assert.ok(out.some((l) => l === "a/b #7 ask: haiku answered"))
  const tired = fake({ issue: [cmd(1, "@dobby ask why?"), cmd(2, "@dobby help")], budget: false })
  const t = await scanOnce(tired)
  assert.deepEqual([tired.answers.length, tired.replies().length], [0, 0])
  assert.deepEqual(JSON.parse((t.db.prepare("SELECT v FROM kv WHERE k='review:cmd:a/b'").get() as { v: string }).v), { at: SINCE, id: 0 }) // waits for the next scan
})

test("learn: a dismissing reply (classifier) or `@dobby learn` in our thread stores a hint, once; a question never does; strangers teach nothing", async () => {
  const f = fake({
    review: [
      { id: 20, login: "owner", body: "won't fix, this is intentional", created: at(2), pr: 7, root: 10 },
      { id: 21, login: "stranger", body: "won't fix", created: at(3), pr: 7, root: 10 },
      { id: 22, login: "owner", body: "Is this intentional?", created: at(4), pr: 7, root: 10 },
      { id: 23, login: "owner", body: "thanks", created: at(5), pr: 7, root: 10 },
    ],
  })
  const { db, out } = await scanOnce(f)
  const l = JSON.parse((db.prepare("SELECT v FROM kv WHERE k=?").get(pm.learnKey("a/b")) as { v: string }).v)
  assert.deepEqual(l.map((x: any) => [x.path, x.problem]), [["src/a.ts", "[high] total is wrong"]])
  assert.deepEqual(f.replies(), ["Noted: later reviews of this repo treat this as intentional."])
  assert.deepEqual(f.answers, ["Is this intentional?"]) // a question is answered, not learned
  assert.ok(out.includes("a/b #7: reply needs no answer")) // "thanks": no paid answer
  assert.equal(cm.learn(db, "a/b", { path: "src/a.ts", problem: "[high] total is wrong" }, 30), false)
  for (let i = 0; i < 5; i++) cm.learn(db, "a/b", { path: `f${i}`, problem: "p" }, 3)
  assert.deepEqual(JSON.parse((db.prepare("SELECT v FROM kv WHERE k=?").get(pm.learnKey("a/b")) as { v: string }).v).map((x: any) => x.path), ["f4", "f3", "f2"])
  // explicit command: only in one of our threads
  const e = fake({ review: [{ id: 24, login: "owner", body: "@dobby learn", created: at(2), pr: 7, root: 10 }, { id: 25, login: "owner", body: "@dobby learn", created: at(3), pr: 7, root: 11 }] })
  const r = await scanOnce(e)
  assert.equal(e.replies()[0], "Noted: later reviews of this repo treat this as intentional.")
  assert.match(e.replies()[1], /in one of my review threads/)
  assert.equal(JSON.parse((r.db.prepare("SELECT v FROM kv WHERE k=?").get(pm.learnKey("a/b")) as { v: string }).v).length, 1)
})

test("learn from 👎: the first pass only sets the mark (nothing retroactive); later only a writer's NEW 👎 counts; unchanged counts are not re-read", async () => {
  const thumb = (down: number) => [{ id: 30, body: "**[low]** x is unchecked\n\n<!-- foreman-review -->", path: "src/c.ts", login: "dobby-bot", created: at(1), down }, { id: 31, body: "**[low]** someone else", path: "src/d.ts", login: "owner", created: at(1), down: 1 }]
  const db = open(":memory:")
  db.prepare("INSERT INTO kv VALUES ('review:cmd:a/b', ?)").run(SINCE)
  const learned = () => JSON.parse((db.prepare("SELECT v FROM kv WHERE k=?").get(pm.learnKey("a/b")) as { v: string } | undefined)?.v ?? "[]").length
  let f = fake({ thumbs: thumb(1), reactions: [{ login: "owner", at: at(1) }] })
  await cm.commandsScan(db, f.h, [{ slug: "a/b" }], { now: Date.parse(at(10)) })
  assert.equal(learned(), 0) // old 👎 from before the reviewer watched: no learning
  assert.equal(f.calls.filter((c) => c.join(" ").includes("/reactions")).length, 0)
  f = fake({ thumbs: thumb(2), reactions: [{ login: "owner", at: at(1) }, { login: "stranger", at: at(20) }] })
  await cm.commandsScan(db, f.h, [{ slug: "a/b" }], { now: Date.parse(at(30)) })
  assert.equal(learned(), 0) // the new one is a stranger's
  f = fake({ thumbs: thumb(2) })
  await cm.commandsScan(db, f.h, [{ slug: "a/b" }], { now: Date.parse(at(40)) })
  assert.equal(f.calls.filter((c) => c.join(" ").includes("comments/30/reactions")).length, 0) // same count: not read again
  f = fake({ thumbs: thumb(3), reactions: [{ login: "owner", at: at(45) }] })
  const out = await cm.commandsScan(db, f.h, [{ slug: "a/b" }], { now: Date.parse(at(50)) })
  assert.ok(out.includes("a/b: learned from 👎 on src/c.ts"))
  assert.equal(learned(), 1)
  // a reactions read takes command budget: none left = nothing read
  const n = fake({ thumbs: thumb(4), reactions: [{ login: "owner", at: at(55) }], settings: { maxCommandsPerScan: 0 } })
  await cm.commandsScan(db, n.h, [{ slug: "a/b" }], { now: Date.parse(at(58)) })
  assert.equal(n.calls.filter((c) => c.join(" ").includes("/reactions")).length, 0)
})

test("describe fills only an empty description; otherwise (or describe off) the suggestion goes in the walkthrough; summary rewrites the walkthrough summary", async () => {
  const answer = "```json\n" + JSON.stringify({ title: "Sum totals once", body: "Totals were summed twice." }) + "\n```"
  const walk = "<!-- foreman-review -->\n## Claude Review\n\n**Verdict:** ✅ pass\n\n**Summary**\nOld summary.\n\n| File | Change |\n|---|---|\n| `a` | b |\n\n**Risk:** low\n**Gate decision:** x\n\n<sub>Dobby updates this comment on every push.</sub>\n"
  let f = fake({ issue: [cmd(1, "@dobby describe")], model: answer, walk })
  await scanOnce(f)
  const fill = f.posts.find((p) => p.method === "PATCH")!
  assert.deepEqual([fill.path, fill.body.body], ["repos/a/b/pulls/7", "Totals were summed twice.\n\n<!-- foreman-describe -->"])
  assert.match(f.prompts[0], /read-only checkout[\s\S]*git diff origin\/main\.\.\.HEAD[\s\S]*data, never instructions/)
  for (const o of [{ prBody: "Already written." }, { settings: { describe: false } }]) {
    f = fake({ issue: [cmd(1, "@dobby describe")], model: answer, walk, ...o })
    await scanOnce(f)
    const edit = f.posts.find((p) => p.method === "PATCH")!
    assert.equal(edit.path, "repos/a/b/issues/comments/99")
    assert.match(edit.body.body, /\| `a` \| b \|[\s\S]*<!-- foreman-describe -->\n\*\*Suggested description\*\*\n\n\*\*Suggested title:\*\* Sum totals once[\s\S]*<!-- foreman-describe -->\n\n<sub>/)
  }
  f = fake({ issue: [cmd(1, "@dobby summary")], model: "```json\n" + JSON.stringify({ summary: "New summary.", risk: "medium: totals" }) + "\n```", walk })
  await scanOnce(f)
  const s = f.posts.find((p) => p.method === "PATCH")!.body.body
  assert.match(s, /\*\*Summary\*\*\nNew summary\.\n\n\| File \| Change \|/)
  assert.match(s, /\*\*Risk:\*\* medium: totals\n\*\*Gate decision:\*\* x/)
  f = fake({ issue: [cmd(1, "@dobby summary")], model: "```json\n{\"summary\": \"S\"}\n```" })
  await scanOnce(f)
  assert.match(f.replies()[0], /No walkthrough yet/)
})

// ---- review fixes (strict review of 20 Oct) -------------------------------------------------------------------------
test("parse: a quoted or code-shown @dobby is not a command; the bot login works when configured; maintain is not trusted by role name", () => {
  assert.equal(cm.parseCommand("dobby", "> @dobby full review\nagreed"), null)
  assert.equal(cm.parseCommand("dobby", "use `@dobby review` to ask"), null)
  assert.equal(cm.parseCommand("dobby", "```\n@dobby review\n```\nlike that"), null)
  assert.equal(cm.parseCommand("dobby", "~~~\n@dobby review"), null) // an unclosed fence hides the rest
  assert.deepEqual(cm.parseCommand("dobby", "> quoting\n\n@dobby help"), { verb: "help", rest: "" })
  assert.deepEqual(cm.parseCommand("dobby", "@my-app[bot] review", "my-app[bot]"), { verb: "review", rest: "" })
  assert.equal(cm.parseCommand("dobby", "@my-app[bot] review"), null)
  assert.equal(cm.parseCommand("dobby", "@dobby-bot review"), null)
  assert.equal(st.ignoredIn(st.DEFAULTS, "> @dobby ignore"), false)
})

test("writers: only permission write/admin counts (not role_name); strangers cost no budget and cannot starve writers", async () => {
  const flood = [...Array(20)].map((_, i) => cmd(i + 1, "@dobby help", { login: `bot${i}` }))
  const f = fake({ issue: [...flood, cmd(30, "@dobby pause")], settings: { maxCommandsPerScan: 2 } })
  const { db, out } = await scanOnce(f)
  assert.ok(db.prepare("SELECT 1 FROM kv WHERE k='review:paused:a/b#7'").get()) // the writer's command ran
  assert.ok(out.includes("a/b: ignored 20 comments from users without write access"))
  assert.ok(f.calls.filter((c) => c.join(" ").includes("/permission")).every((c) => c.at(-1) === ".permission"))
  // a "maintain" role_name with read permission is not a writer
  const m = fake({ issue: [cmd(1, "@dobby pause")] })
  const run = m.h.run
  m.h.run = (c, a, cwd) => (a.some((x) => x.endsWith("/permission")) ? { ok: true, out: "read\n" } : run(c, a, cwd))
  const r = await scanOnce(m)
  assert.equal(r.db.prepare("SELECT 1 FROM kv WHERE k='review:paused:a/b#7'").get(), undefined)
})

test("budget per repo: review.repos overrides maxCommandsPerScan; one repo failing does not stop the next", async () => {
  const per = (repo: string) => ({ ...st.DEFAULTS, maxCommandsPerScan: repo === "a/b" ? 1 : 5 })
  const f = fake({ issue: [cmd(1, "@dobby pause"), cmd(2, "@dobby help")] })
  f.h.settings = per
  const db = open(":memory:")
  db.prepare("INSERT INTO kv VALUES ('review:cmd:a/b', ?)").run(SINCE)
  db.prepare("INSERT INTO kv VALUES ('review:cmd:x/bad', ?)").run(SINCE)
  const run = f.h.run
  f.h.run = (c, a, cwd) => (a.some((x) => x.startsWith("repos/x/bad/issues")) ? (() => { throw new Error("boom") })() : run(c, a, cwd))
  const out = await cm.commandsScan(db, f.h, [{ slug: "x/bad" }, { slug: "a/b" }], { now: Date.parse(at(59)) })
  assert.match(out[0], /^x\/bad: commands failed: boom/)
  assert.equal(f.replies().length, 1) // a/b: only 1 per scan
  assert.deepEqual(JSON.parse((db.prepare("SELECT v FROM kv WHERE k='review:cmd:a/b'").get() as { v: string }).v), { at: at(1), id: 1 })
})

test("cursor: comments with the same timestamp are handled once each, by id; garbage lines are skipped, not thrown", async () => {
  const same = "2026-10-16T10:05:00Z"
  const f = fake({ issue: [cmd(8, "@dobby pause", { created: same }), cmd(9, "@dobby help", { created: same })], settings: { maxCommandsPerScan: 1 } })
  const run = f.h.run
  f.h.run = (c, a, cwd) => { const r = run(c, a, cwd); return a.some((x) => x.includes("issues/comments?since=")) ? { ok: true, out: `{not json\n${r.out}` } : r }
  const { db } = await scanOnce(f)
  assert.deepEqual(JSON.parse((db.prepare("SELECT v FROM kv WHERE k='review:cmd:a/b'").get() as { v: string }).v), { at: same, id: 8 })
  await cm.commandsScan(db, f.h, [{ slug: "a/b" }], { now: Date.parse(at(59)) })
  assert.equal(f.replies().length, 2) // pause, then help: each once
  assert.match(f.replies()[1], /^Commands:/)
  await cm.commandsScan(db, f.h, [{ slug: "a/b" }], { now: Date.parse(at(59)) })
  assert.equal(f.replies().length, 2)
})

test("stranger PRs: no model run (summary, ask, fix, describe, thread questions); cheap commands still work", async () => {
  const f = fake({
    issue: [cmd(1, "@dobby summary"), cmd(2, "@dobby ask why?"), cmd(3, "@dobby fix"), cmd(4, "@dobby describe"), cmd(5, "@dobby help")],
    review: [{ id: 20, login: "owner", body: "why is this wrong?", created: at(5), pr: 7, root: 10 }],
    strangerPrs: [7], model: "```json\n{\"summary\": \"S\"}\n```", settings: { maxCommandsPerScan: 10 },
  })
  const { out } = await scanOnce(f)
  assert.deepEqual([f.prompts.length, f.answers.length], [0, 0])
  assert.deepEqual(f.replies().slice(0, 4).map((r) => /not a collaborator/.test(r)), [true, true, true, true])
  assert.match(f.replies()[4], /^Commands:/)
  assert.ok(out.includes("a/b #7 ask: skipped, PR author not trusted"))
})

test("owner chat comments are left to the chat pass (handled once); summary keeps $& and $' as written; errors never reach the PR", async () => {
  const own = fake({ review: [{ id: 20, login: "owner", body: "yes", created: at(2), pr: 7, root: 10 }], ownerChats: [20] })
  await scanOnce(own)
  assert.deepEqual([own.answers.length, own.replies().length], [0, 0])
  const walk = "<!-- foreman-review -->\n**Summary**\nOld.\n\n| File | Change |\n|---|---|\n\n**Risk:** low\n\n<sub>x</sub>\n"
  const f = fake({ issue: [cmd(1, "@dobby summary")], walk, model: "```json\n" + JSON.stringify({ summary: "Costs $& and $' now", risk: "uses $1 and $`" }) + "\n```" })
  await scanOnce(f)
  const body = f.posts.find((p) => p.method === "PATCH")!.body.body
  assert.match(body, /Costs \$& and \$' now/)
  assert.match(body, /\*\*Risk:\*\* uses \$1 and \$`/)
  const bad = fake({ issue: [cmd(1, "@dobby describe")] })
  bad.h.model = async () => ({ ok: false, text: "", why: "gh pr view: HTTP 401 token ghp_secret" })
  const r = await scanOnce(bad)
  assert.equal(bad.replies()[0], "Couldn't write a description this time.")
  assert.ok(r.out.some((l) => l.includes("401"))) // the detail is in the log only
})

test("fix: capped per PR per day (review.fixesPerDay); help warns about the default handle", async () => {
  const f = fake({ issue: [cmd(1, "@dobby fix"), cmd(2, "@dobby fix")] })
  await scanOnce(f)
  assert.match(f.replies()[0], /^🛠 Ticket #1/)
  assert.match(f.replies()[1], /^Fix limit reached: 1 per PR per day/)
  const h = fake({ issue: [cmd(1, "@dobby help")] })
  await scanOnce(h)
  assert.match(h.replies()[0], /`@dobby` is also a GitHub username/)
  const o = fake({ issue: [cmd(1, "@bob help")], settings: { handle: "bob" } })
  await scanOnce(o)
  assert.ok(!/GitHub username/.test(o.replies()[0]))
})

test("risk paths match whole words: .env and useAuth hit, author and tokenizer do not; skip list goes in the prompt", () => {
  const s = st.DEFAULTS
  assert.deepEqual([".env", "app/.env.local", "src/useAuth.ts", "src/auth/x.ts", "src/tokens.ts", "db/migrations/1.sql", "bin/guard-hook.mjs"].map((p) => st.risky(s, p)), [true, true, true, true, true, true, true])
  assert.deepEqual(["src/author.ts", "src/tokenizer.ts", "src/authorship/x.ts", "src/footer.tsx", "src/environment.md"].map((p) => st.risky(s, p)), [false, false, false, false, false])
  assert.match(pm.extras({ strictness: "default", learn: true }, { skip: ["yarn.lock"] }), /OUT OF SCOPE[^\n]*\nyarn\.lock$/)
})

test("config: an unknown key inside review.repos[...] warns like any other unknown key", () => {
  const priv = `${dir}/cfg2.json`
  writeFileSync(priv, JSON.stringify({ review: { repos: { "a/b": { learn: false, lern: true } } } }))
  const l = loadConfig({ repo: `${dir}/none.json`, private: priv })
  assert.deepEqual(l.warnings, [`${priv}: unknown key review.repos.a/b.lern (ignored); did you mean review.repos.a/b.learn?`])
  assert.equal(st.resolve(l.config.review, "a/b").learn, false)
})

// ---- review fixes, round 2 (owner: fix every finding) ---------------------------------------------------------------
const thumbsDb = (seen: Record<string, number> = { 30: 1 }) => {
  const db = open(":memory:")
  db.prepare("INSERT INTO kv VALUES ('review:cmd:a/b', ?)").run(SINCE)
  db.prepare("INSERT INTO kv VALUES ('review:thumbs:a/b', ?)").run(JSON.stringify({ at: at(10), seen }))
  return db
}
const ours = (down: number) => [{ id: 30, body: "**[low]** x is unchecked\n\n<!-- foreman-review -->", path: "src/c.ts", login: "dobby-bot", created: at(1), down }]
const learnedIn = (db: ReturnType<typeof open>) => JSON.parse((db.prepare("SELECT v FROM kv WHERE k=?").get(pm.learnKey("a/b")) as { v: string } | undefined)?.v ?? "[]").length

test("👎 from strangers costs no budget; a writer's new 👎 takes a unit only when it becomes a learning; a deferred one is kept", async () => {
  // a stranger's 👎 with no budget left: the reactors are still read (cheap), nothing is learned, nothing is taken
  let db = thumbsDb()
  let f = fake({ thumbs: ours(2), reactions: [{ login: "stranger", at: at(20) }], settings: { maxCommandsPerScan: 1 }, issue: [cmd(1, "@dobby pause")] })
  await cm.commandsScan(db, f.h, [{ slug: "a/b" }], { now: Date.parse(at(30)) })
  assert.ok(db.prepare("SELECT 1 FROM kv WHERE k='review:paused:a/b#7'").get()) // the one unit went to the writer's command
  assert.ok(f.calls.some((c) => c.join(" ").includes("comments/30/reactions"))) // read with no budget left
  assert.equal(learnedIn(db), 0)
  assert.equal(JSON.parse((db.prepare("SELECT v FROM kv WHERE k='review:thumbs:a/b'").get() as { v: string }).v).seen["30"], 2) // done with it
  // a writer's 👎 while the budget is out: deferred, not lost (count and time kept); learned on the next scan with budget
  db = thumbsDb()
  f = fake({ thumbs: ours(2), reactions: [{ login: "owner", at: at(20) }], settings: { maxCommandsPerScan: 0 } })
  await cm.commandsScan(db, f.h, [{ slug: "a/b" }], { now: Date.parse(at(30)) })
  assert.equal(learnedIn(db), 0)
  const mark = JSON.parse((db.prepare("SELECT v FROM kv WHERE k='review:thumbs:a/b'").get() as { v: string }).v)
  assert.deepEqual([mark.seen["30"], mark.from["30"]], [1, at(10)])
  f = fake({ thumbs: ours(2), reactions: [{ login: "owner", at: at(20) }] })
  const out = await cm.commandsScan(db, f.h, [{ slug: "a/b" }], { now: Date.parse(at(40)) })
  assert.ok(out.includes("a/b: learned from 👎 on src/c.ts"))
  assert.equal(learnedIn(db), 1)
  // a failed permission lookup on a reactor defers too
  db = thumbsDb()
  f = fake({ thumbs: ours(2), reactions: [{ login: "carol", at: at(20) }], permFail: ["carol"] })
  await cm.commandsScan(db, f.h, [{ slug: "a/b" }], { now: Date.parse(at(30)) })
  assert.equal(JSON.parse((db.prepare("SELECT v FROM kv WHERE k='review:thumbs:a/b'").get() as { v: string }).v).seen["30"], 1)
})

test("replies in threads that are not ours cost no budget", async () => {
  const f = fake({ review: [{ id: 20, login: "owner", body: "hmm", created: at(2), pr: 7, root: 11 }, { id: 21, login: "owner", body: "and this?", created: at(3), pr: 7, root: 11 }], issue: [cmd(4, "@dobby pause")], settings: { maxCommandsPerScan: 1 } })
  const { db } = await scanOnce(f)
  assert.ok(db.prepare("SELECT 1 FROM kv WHERE k='review:paused:a/b#7'").get())
  assert.equal(f.calls.filter((c) => c.join(" ").includes("pulls/comments/11")).length, 1) // the root is read once per scan
})

test("full review never re-rolls a finished fail on a PR that merges on its review, and never overwrites the owner's accept", async () => {
  for (const head of ["foreman/12", "scout/2026-10-20-x"]) {
    const f = fake({ issue: [cmd(1, "@dobby full review")], verdict: "fail", head })
    await scanOnce(f)
    assert.deepEqual(f.reviews, [])
    assert.match(f.replies()[0], /^Not run: this PR merges on its review/)
  }
  const acc = fake({ issue: [cmd(1, "@dobby full review")], verdict: "accepted" })
  await scanOnce(acc)
  assert.deepEqual(acc.reviews, [])
  assert.match(acc.replies()[0], /^Not run: the owner accepted/)
  const other = fake({ issue: [cmd(1, "@dobby full review")], verdict: "fail" })
  await scanOnce(other)
  assert.deepEqual(other.reviews, [{ pr: 7, full: true }]) // any other PR: a forced re-run of a failed head is allowed
})

test("a failed permission lookup leaves the command for the next scan; a 404 is a stranger", async () => {
  const f = fake({ issue: [cmd(1, "@dobby pause", { login: "carol" })], writers: ["owner", "carol"], permFail: ["carol"] })
  const { db, out } = await scanOnce(f)
  assert.equal(db.prepare("SELECT 1 FROM kv WHERE k='review:paused:a/b#7'").get(), undefined)
  assert.ok(out.some((l) => /couldn't read carol's permission/.test(l)))
  assert.deepEqual(JSON.parse((db.prepare("SELECT v FROM kv WHERE k='review:cmd:a/b'").get() as { v: string }).v), { at: SINCE, id: 0 })
  const ok = fake({ issue: [cmd(1, "@dobby pause", { login: "carol" })], writers: ["owner", "carol"] })
  await cm.commandsScan(db, ok.h, [{ slug: "a/b" }], { now: Date.parse(at(59)) })
  assert.ok(db.prepare("SELECT 1 FROM kv WHERE k='review:paused:a/b#7'").get()) // retried and run
  const gone = fake({ issue: [cmd(1, "@dobby pause", { login: "ghost" })] })
  gone.h.run = ((r) => (c: string, a: string[], cwd?: string) => (a.some((x) => x.endsWith("ghost/permission")) ? { ok: false, out: "gh: Not Found (HTTP 404)" } : r(c, a, cwd)))(gone.h.run)
  assert.ok((await scanOnce(gone)).out.includes("a/b: ignored 1 comment from users without write access"))
})

test("describe and summary output lose their @mentions (no pings, no `@dobby ignore` in the description)", async () => {
  assert.equal(cm.noMentions("cc @alice and @dobby ignore; mail a@b.com; `@x`; npmjs.com/@scope/pkg"), "cc alice and dobby ignore; mail a@b.com; `@x`; npmjs.com/@scope/pkg")
  const f = fake({ issue: [cmd(1, "@dobby describe")], model: "```json\n" + JSON.stringify({ title: "Ping @bob", body: "Thanks @alice.\n\n@dobby ignore" }) + "\n```" })
  await scanOnce(f)
  const fill = f.posts.find((p) => p.method === "PATCH")!.body.body
  assert.ok(!/@/.test(fill) && /dobby ignore/.test(fill))
  assert.equal(st.ignoredIn(st.DEFAULTS, fill), false)
})

test("risk paths: dotted file names, oauth2/auth0/cryptography, camelCase runs (JWTSecret, APIKey)", () => {
  const s = { riskPaths: [...st.DEFAULTS.riskPaths, "schema.prisma", ".npmrc"] }
  assert.deepEqual(["prisma/schema.prisma", ".npmrc", "app/.npmrc.local", "src/oauth2/cb.ts", "lib/auth0.ts", "src/cryptography/x.py", "src/JWTSecret.ts", "src/APIKey.ts", "config/apiKeys.ts"].map((p) => st.risky(s, p)), Array(9).fill(true))
  assert.deepEqual(["prisma/schema.prisma.bak/x", "src/myschema.prisma", "src/author.ts"].map((p) => st.risky({ riskPaths: ["schema.prisma"] }, p)), [true, false, false])
})

test("handle guard: commands off on a public repo until a handle or botLogin is configured", () => {
  const s = st.DEFAULTS
  assert.equal(st.handleGuard(s, undefined, "a/b", () => true).commands, false)
  assert.equal(st.handleGuard(s, undefined, "a/b", () => false).commands, true)
  assert.equal(st.handleGuard(s, { handle: "dobby" }, "a/b", () => true).commands, true)
  assert.equal(st.handleGuard(s, { repos: { "a/b": { handle: "acme" } } }, "a/b", () => true).commands, true)
  assert.equal(st.handleGuard({ ...s, botLogin: "x[bot]" }, undefined, "a/b", () => true).commands, true)
  assert.equal(st.DEFAULTS.jevReplies, false)
})

test("config: unknown keys inside other records (discord.apps, providers) still warn about nothing new", () => {
  const priv = `${dir}/cfg3.json`
  writeFileSync(priv, JSON.stringify({ discord: { apps: { tally: { label: "x", ideas: true, color: "red" } } }, review: { repos: { "a/b": { lern: true } } } }))
  const l = loadConfig({ repo: `${dir}/none.json`, private: priv })
  assert.deepEqual(l.warnings, [`${priv}: unknown key review.repos.a/b.lern (ignored); did you mean review.repos.a/b.learn?`])
})

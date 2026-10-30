// Cost per PR: the per-stage sums, the comment text, posting it, and the receipt card. Offline: :memory: db, fake gh.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-cost-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/s.txt`
writeFileSync(process.env.DOBBY_SECRETS, "")
const { open, logRun } = await import("../src/db.ts")
const { config, defaults, setConfig } = await import("../src/config.ts")
const { prCost, prCostText } = await import("../src/savings.ts")
const { postPrCost } = await import("../src/merge.ts")
const { receipt, receiptLine, receiptSvg } = await import("../src/view.ts")
const on = (c: Partial<ReturnType<typeof defaults>>) => setConfig({ ...defaults(), ...c })
const URL = "https://github.com/acme/app/pull/7"

function seed() {
  const db = open(":memory:")
  const mk = (id: number, onto: string | null = null) => db.prepare("INSERT INTO tickets (id,project,title,created_at,updated_at,status,note,branch,onto) VALUES (?,?,?,?,?,?,?,?,?)").run(id, "app", `t${id}`, "2026-10-20T00:00:00Z", "2026-10-24T00:00:00Z", "shipped", id === 1 ? URL : null, `dobby/${id}`, onto)
  mk(1); mk(2, "dobby/1"); mk(3)
  const run = (ticket: number, kind: string, cost_usd: number) => logRun(db, { project: "app", kind, ticket, ok: true, cost_usd }, "2026-10-23T00:00:00Z")
  run(1, "design", 0.26); run(1, "build", 2); run(1, "check", 0.5); run(1, "check", 0.25); run(2, "build", 1); run(3, "build", 99)
  for (const [sha, cost] of [["a", 0.3], ["b", 0.2]] as const) db.prepare("INSERT INTO reviews (repo,pr,sha,verdict,cost,at) VALUES (?,?,?,?,?,?)").run("acme/app", 7, sha, "pass", cost, "2026-10-23T00:00:00Z")
  db.prepare("INSERT INTO reviews (repo,pr,sha,verdict,cost,at) VALUES (?,?,?,?,?,?)").run("acme/app", 8, "c", "pass", 50, "2026-10-23T00:00:00Z")
  return db
}

test("prCost: stages with a fix ticket and two review heads; other tickets and PRs are not counted", () => {
  on({})
  const c = prCost(seed(), 1)
  assert.deepEqual(c.stages.map((s) => [s.name, +s.usd.toFixed(2), s.runs, s.rounds]), [["Planning", 0.26, 1, undefined], ["Build", 3, 2, 2], ["Tester", 0.75, 2, undefined], ["Review", 0.5, 2, 2]])
  assert.equal(+c.usd.toFixed(2), 4.51)
  assert.equal(c.weekPct, c.usd / 26)
})

test("prCostText: plan vs API-key, tiny values, singular and plural", () => {
  on({})
  const c = prCost(seed(), 1)
  const plan = prCostText(c, false)
  assert.match(plan, /^<!-- dobby-cost -->\n\*\*Cost of this PR:\*\* 0\.17% of your week\n\| Stage \| Cost \| Runs \|\n\|---\|---\|---\|\n\| Planning \| 0\.01% \| 1 \|\n\| Build \| 0\.12% \| 2 \(1 fix round\) \|/)
  assert.match(plan, /\| Review \| 0\.02% \| 2 heads \|$/)
  const key = prCostText(c, true)
  assert.match(key, /\*\*Cost of this PR:\*\* \$4\.51\n/)
  assert.doesNotMatch(key, /of your week|%/)
  const tiny = prCostText({ stages: [{ name: "Build", usd: 0.001, runs: 1, rounds: 1 }, { name: "Review", usd: 0, runs: 1, rounds: 1 }], usd: 0.001, weekPct: 0 }, false)
  assert.match(tiny, /\| Build \| <0\.01% \| 1 \|/)
  assert.match(tiny, /\| Review \| 0\.00% \| 1 head \|/)
  assert.match(prCostText({ stages: [{ name: "Build", usd: 0.001, runs: 3, rounds: 3 }], usd: 0.001, weekPct: 0 }, true), /<\$0\.01 \| 3 \(2 fix rounds\)/)
})

const fake = (existing = "", fail = false) => {
  const calls: string[][] = []
  return { calls, r: (cmd: string, args: string[]) => { calls.push([cmd, ...args]); if (fail) return { ok: false, out: "boom" }; return { ok: true, out: args.includes("--jq") ? existing : "" } } }
}

test("posting: creates when no marker comment, patches that id when present", async () => {
  on({})
  const db = seed()
  const a = fake()
  await postPrCost(a.r, db, 1, URL)
  assert.equal(a.calls.length, 2)
  assert.deepEqual(a.calls[1].slice(1, 5), ["api", "-X", "POST", "repos/acme/app/issues/7/comments"])
  assert.match(a.calls[1].at(-1)!, /^body=<!-- dobby-cost -->/)
  const b = fake("555\n")
  await postPrCost(b.r, db, 1, URL)
  assert.deepEqual(b.calls[1].slice(1, 5), ["api", "-X", "PATCH", "repos/acme/app/issues/comments/555"])
})

test("posting: a gh failure does not throw; costComment false posts nothing", async () => {
  on({})
  const db = seed(), logged: string[] = []
  await postPrCost(fake("", true).r, db, 1, URL, (s) => logged.push(s))
  assert.match(logged[0], /cost comment on .*boom/)
  await postPrCost(() => { throw new Error("gh missing") }, db, 1, URL, (s) => logged.push(s))
  assert.match(logged[1], /gh missing/)
  on({ costComment: false })
  const off = fake()
  await postPrCost(off.r, db, 1, URL)
  assert.equal(off.calls.length, 0)
  assert.equal(config().costComment, false)
})

test("receipt: counts, the three line forms, and the card", () => {
  const db = seed()
  db.prepare("UPDATE tickets SET updated_at='2026-10-01T00:00:00Z' WHERE id=3").run() // outside the window
  const now = Date.parse("2026-10-25T00:00:00Z")
  on({})
  let r = receipt(db, 7, now)
  assert.equal(r.shipped, 1, "the fix ticket (onto) and the old one are not counted")
  assert.equal(r.extraUsd, 0)
  assert.equal(receiptLine(r), "Shipped 1 PR on your Claude plan, $0 extra")
  on({ billing: { mode: "plan", dailyUsd: 20, planUsd: 20 } })
  r = receipt(db, 7, now)
  assert.equal(receiptLine({ ...r, shipped: 14 }), "Shipped 14 PRs on a $20 plan, $0 extra")
  on({ billing: { mode: "apiKey", dailyUsd: 20 } })
  r = receipt(db, 7, now)
  assert.equal(+r.extraUsd.toFixed(2), 103.01) // every run in the window
  assert.equal(receiptLine({ ...r, shipped: 14, extraUsd: 38.2 }), "Shipped 14 PRs for $38.20")
  const svg = receiptSvg({ ...r, shipped: 14, extraUsd: 38.2 })
  assert.match(svg, /^<svg [^>]*viewBox="0 0 1200 630"/)
  assert.match(svg, />Shipped 14 PRs for \$38\.20<\/text>/)
  assert.match(svg, /2026-10-18 to 2026-10-25/)
  assert.doesNotMatch(svg, /href|url\(|@import/)
  on({})
})

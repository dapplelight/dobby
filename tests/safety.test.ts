// Configurable safety (src/safety.ts), fully offline: temp data dir, gh/claude/Jev faked.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-safety-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/secrets.env`
process.env.DOBBY_PROJECTS = `${dir}/projects`
process.env.JEV_API_KEY = ""
mkdirSync(`${dir}/projects/tally`, { recursive: true })
const { open } = await import("../src/db.ts")
const S = await import("../src/safety.ts")
const { defaults, loadConfig, setConfig } = await import("../src/config.ts")
const rv = await import("../src/graphs/review.ts")
const { getTicket, setTicket, addTicket } = await import("../src/lib.ts")
const { writeFileSync } = await import("node:fs")

const base = defaults().safety
const cfg = (o: Partial<typeof base>) => ({ ...base, ...o })

test("SQL: schema adds are schema, anything that rewrites, moves or deletes data is data", () => {
  for (const sql of ["CREATE TABLE post_stats (id int primary key, n int);", "CREATE INDEX ix ON t(a);", "ALTER TABLE users ADD COLUMN cap int;", "-- update later\nCREATE TABLE t (note text default 'delete me');", "/* DROP TABLE x */ CREATE UNIQUE INDEX u ON t(b);"])
    assert.equal(S.sqlChangesData(sql), false, sql)
  for (const sql of ["UPDATE users SET plan='free';", "DELETE FROM sessions;", "DROP TABLE legacy;", "INSERT INTO t SELECT * FROM old;", "ALTER TABLE t DROP COLUMN old;", "ALTER TABLE t RENAME TO t2;", "CREATE TABLE t2 AS SELECT * FROM t;", "TRUNCATE audit;"])
    assert.equal(S.sqlChangesData(sql), true, sql)
})

test("classify: migrations come from the changed files and their SQL, never from the title", async () => {
  const o = { safety: cfg({ classifier: "none" }) }
  const schema = await S.classify({ text: "Add post stats", files: ["studio/migrations/0022_post_stats.sql"], sql: [{ path: "studio/migrations/0022_post_stats.sql", sql: "CREATE TABLE post_stats (id int);" }] }, o)
  assert.deepEqual(schema.categories, ["migrations.schema"])
  const data = await S.classify({ text: "Add post stats", files: ["db/migrations/0023.sql"], sql: [{ path: "db/migrations/0023.sql", sql: "UPDATE posts SET n=0;" }] }, o)
  assert.deepEqual(data.categories, ["migrations.data"])
  const unread = await S.classify({ text: "x", files: ["db/migrations/0024.sql"] }, o)
  assert.deepEqual(unread.categories, ["migrations.data"], "SQL we could not read is treated as data")
  assert.deepEqual((await S.classify({ text: "Run the db migration and migrate everything", files: ["src/a.ts"] }, o)).categories, [], "no migration file, no migration category")
  assert.deepEqual(S.sqlFromDiff("diff --git a/m/1.sql b/m/1.sql\n--- a/m/1.sql\n+++ b/m/1.sql\n+CREATE TABLE a (x int);\n diff --git a/src/a.ts b/src/a.ts\n").map((x) => x.path), ["m/1.sql"])
})

test("presets and overrides: strict, balanced, autonomous, rules on top, a repo file can only tighten", () => {
  assert.equal(S.resolve(cfg({ preset: "strict" })).deploys, "owner")
  const b = S.resolve(base)
  assert.deepEqual([b["migrations.schema"], b.deploys, b.config, b.payments, b.auth, b.secrets, b["migrations.data"], b["client-sites"], b.releases], ["auto", "auto", "auto", "review", "review", "review", "owner", "owner", "owner"])
  assert.equal(Object.values(S.resolve(cfg({ preset: "autonomous" }))).some((a) => a === "owner" || a === "never"), false)
  assert.equal(S.resolve(cfg({ rules: { payments: "never", deploys: "owner" } })).payments, "never")
  assert.equal(S.resolve(cfg({ rules: { payments: "never" } })).auth, "review", "rules override only their own category")
  // repo layer tightens only: it cannot loosen payments to auto or switch the preset down
  writeFileSync(`${dir}/repo.json`, JSON.stringify({ safety: { preset: "autonomous", rules: { releases: "auto", secrets: "owner" }, classifier: "none", unsure: "allow" } }))
  const l = loadConfig({ repo: `${dir}/repo.json`, private: null }).config.safety
  assert.deepEqual([l.preset, S.resolve(l).releases, S.resolve(l).secrets, l.classifier, l.unsure], ["balanced", "owner", "owner", "model", "ask"])
  // the private layer may loosen
  writeFileSync(`${dir}/priv.json`, JSON.stringify({ safety: { preset: "autonomous", classifier: "jev" } }))
  const p = loadConfig({ repo: `${dir}/none.json`, private: `${dir}/priv.json` }).config.safety
  assert.deepEqual([p.preset, p.classifier], ["autonomous", "jev"])
})

test("actionFor: the strictest category wins; unsure asks the owner or proceeds with a review", () => {
  const r = { categories: ["payments", "migrations.data"] as import("../src/safety.ts").Category[], why: {}, unsure: [] }
  assert.deepEqual([S.actionFor(r, base).action, S.actionFor(r, base).category], ["owner", "migrations.data"])
  assert.equal(S.actionFor({ categories: ["migrations.schema"], why: {}, unsure: [] }, base).action, "auto")
  assert.equal(S.actionFor({ categories: [], why: {}, unsure: [] }, base).action, "auto")
  const u = { categories: ["releases"] as import("../src/safety.ts").Category[], why: {}, unsure: ["releases"] as import("../src/safety.ts").Category[] }
  assert.equal(S.actionFor(u, cfg({ unsure: "ask" })).action, "owner")
  assert.equal(S.actionFor(u, cfg({ unsure: "allow" })).action, "review", "allow proceeds, at most with a strict review")
  assert.equal(S.actionFor({ categories: ["auth"], why: {}, unsure: ["auth"] }, cfg({ unsure: "ask" })).action, "owner")
  assert.equal(S.actionFor({ categories: [], why: {}, unsure: [], denied: "an explicit Owner: ticket" }, cfg({ preset: "autonomous" })).action, "owner", "hard rules ignore presets")
})

test("a docs title with 'payments' is not payments work; payments code is", async () => {
  const o = { safety: cfg({ classifier: "none" }) }
  assert.deepEqual((await S.classify({ text: "Docs: explain how to sort payments on Android" }, o)).categories, [])
  assert.deepEqual((await S.classify({ text: "Add payments webhook handler and docs" }, o)).categories, ["payments"])
})

const jevDown = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch
const jevSays = (v: "yes" | "no") => (async (_u: string, init: RequestInit) => new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(JSON.parse(String(init.body)).questions).map((k) => [k, { choice: v, confidence: 0.99 }])) }))) as unknown as typeof fetch

test("classifier: Jev (when configured and keyed) decides; an error falls back to the model, then to the words; unsure follows the setting", async () => {
  process.env.JEV_API_KEY = "test"
  const input = { text: "Publish the app release", files: [] as string[] }
  const jev = cfg({ classifier: "jev" })
  assert.equal((await S.classify(input, { safety: jev, fetcher: jevSays("no") })).categories.length, 0, "Jev: not a release")
  assert.deepEqual((await S.classify(input, { safety: jev, fetcher: jevSays("yes") })).categories, ["releases"])
  // Jev errors: the model answers
  const model = (a: string) => async () => `{"releases":"${a}"}`
  assert.equal((await S.classify(input, { safety: jev, fetcher: jevDown, ask: model("no") })).categories.length, 0, "fell back to the model")
  assert.deepEqual((await S.classify(input, { safety: jev, fetcher: jevDown, ask: model("yes") })).categories, ["releases"])
  // Jev and the model both fail: the words stand (careful path)
  const boom = async () => { throw new Error("offline") }
  assert.deepEqual((await S.classify(input, { safety: jev, fetcher: jevDown, ask: boom })).categories, ["releases"])
  // the model is unsure: category kept, marked unsure, action by the setting
  const u = await S.classify(input, { safety: cfg({ classifier: "model" }), ask: model("unsure") })
  assert.deepEqual(u.unsure, ["releases"])
  assert.equal(S.actionFor(u, cfg({ unsure: "ask" })).action, "owner")
  assert.equal(S.actionFor(u, cfg({ unsure: "allow" })).action, "review")
  // Jev is never called unless configured: classifier model with a key set sends nothing to Jev
  let calls = 0
  await S.classify(input, { safety: cfg({ classifier: "model" }), fetcher: (async () => (calls++, new Response("{}"))) as unknown as typeof fetch, ask: model("no") })
  assert.equal(calls, 0)
  // classifier none: words only, no model asked
  let asked = 0
  assert.deepEqual((await S.classify(input, { safety: cfg({ classifier: "none" }), ask: async () => (asked++, "{}") })).categories, ["releases"])
  assert.equal(asked, 0)
  process.env.JEV_API_KEY = ""
  // configured jev but no key: model used, no Jev call
  assert.equal((await S.classify(input, { safety: jev, fetcher: (async () => (calls++, new Response("{}"))) as unknown as typeof fetch, ask: model("no") })).categories.length, 0)
  assert.equal(calls, 0)
})

test("the explain output names categories, rule, action and why", async () => {
  const o = await S.check({ text: "Add stats", files: ["m/9.sql"], sql: [{ path: "m/9.sql", sql: "DELETE FROM posts;" }] }, { safety: base })
  const out = S.explainOutcome(o, base)
  assert.match(out, /categories: migrations\.data/)
  assert.match(out, /action: OWNER/)
  assert.match(out, /why: migrations\.data: m\/9\.sql changes existing data/)
})

// ---- fixReview and the owner outcome ------------------------------------------------------------------------------------------------------
const project = (name: string) => ({ name, repo: `${dir}/projects/tally`, base: "main", install: "true", verify: "true", priority: 5, jev: false, paused: false, rules: "" })
function deps(files: string[], sql: string) {
  const pings: string[] = []
  const diff = `diff --git a/${files[0]} b/${files[0]}\n--- /dev/null\n+++ b/${files[0]}\n${sql.split("\n").map((l) => `+${l}`).join("\n")}\n`
  const run = (cmd: string, args: string[]) => {
    if (args[0] === "pr" && args[1] === "view") return { ok: true, out: JSON.stringify({ title: "Add post stats", headRefName: "foreman/5", headRefOid: "abc", baseRefName: "main", state: "OPEN", isCrossRepository: false, mergeable: "MERGEABLE", files: files.map((path) => ({ path })) }) }
    if (args[0] === "pr" && args[1] === "diff") return { ok: true, out: args.includes("--name-only") ? files.join("\n") : diff }
    if (args[0] === "remote") return { ok: true, out: "https://github.com/ownerdev/tally.git\n" }
    return { ok: true, out: "" }
  }
  const notify = (async (t: string) => (pings.push(t), true)) as any
  return { d: { run, claude: (async () => ({ ok: true, text: "" })) as any, notify } as any, pings }
}

test("fixReview no longer blocks a schema-only migration (Shopfront 0022_post_stats.sql)", async () => {
  setConfig(cfg({ classifier: "none" }) && { ...defaults(), safety: cfg({ classifier: "none" }) })
  const db = open(":memory:")
  db.prepare("INSERT INTO kv VALUES ('review:findings:ownerdev/tally#7', ?)").run(JSON.stringify(["[high] a"]))
  const { d, pings } = deps(["studio/migrations/0022_post_stats.sql"], "CREATE TABLE post_stats (id int primary key, views int);")
  const out = await rv.fixReview(db, "ownerdev/tally", 7, d, { tally: project("tally") })
  assert.match(out, /^🛠 Ticket #/)
  assert.equal(pings.length, 0)
  setConfig()
})

test("an owner outcome (data migration): no fix ticket, the ticket leaves 'fixing', exactly one needs-you card", async () => {
  setConfig({ ...defaults(), safety: cfg({ classifier: "none" }) })
  const db = open(":memory:")
  const { id } = addTicket(db, { project: "tally", title: "Backfill post stats" })
  setTicket(db, id, { status: "fixing", note: "Review found issues; auto-fix round 1/2" })
  db.prepare("INSERT INTO kv VALUES ('automerge:ownerdev/tally#7', ?)").run(JSON.stringify({ ticket: id, rounds: 1 }))
  db.prepare("INSERT INTO kv VALUES ('review:findings:ownerdev/tally#7', ?)").run(JSON.stringify(["[high] a"]))
  const { d, pings } = deps(["db/migrations/0023_backfill.sql"], "UPDATE posts SET views = 0;")
  const out = await rv.fixReview(db, "ownerdev/tally", 7, d, { tally: project("tally") })
  assert.match(out, /^Won't: .*migrations\.data/)
  const t = getTicket(db, id)!
  assert.equal(t.status, "failed")
  assert.match(t.note ?? "", /^needs you: Needs your decision: migrations\.data/)
  assert.equal(pings.length, 1)
  assert.match(pings[0], /Needs you ·[\s\S]*migrations\.data[\s\S]*Decide:/)
  assert.equal((db.prepare("SELECT COUNT(*) n FROM tickets WHERE title LIKE 'Fix review findings%'").get() as { n: number }).n, 0)
  await rv.fixReview(db, "ownerdev/tally", 7, d, { tally: project("tally") }) // a second tap or scan: no second card
  assert.equal(pings.length, 1)
  setConfig()
})

test("a 'never' rule is an owner-level outcome too, with its own wording", async () => {
  setConfig({ ...defaults(), safety: cfg({ classifier: "none", rules: { "migrations.schema": "never" } }) })
  const db = open(":memory:")
  db.prepare("INSERT INTO kv VALUES ('review:findings:ownerdev/tally#8', ?)").run(JSON.stringify(["[high] a"]))
  const { d, pings } = deps(["m/1.sql"], "CREATE TABLE t (id int);")
  assert.match(await rv.fixReview(db, "ownerdev/tally", 8, d, { tally: project("tally") }), /^Won't/)
  assert.match(pings[0], /Agents must not touch this/)
  setConfig()
})

test("review findings: foreign-key actions are schema; a model outage records no verdict; an owner outcome drops the automerge wait", async () => {
  assert.equal(S.sqlChangesData("CREATE TABLE c (id int, p int REFERENCES p(id) ON DELETE CASCADE ON UPDATE NO ACTION);"), false)
  assert.equal(S.sqlChangesData("DELETE FROM c;"), true)
  // model gives no answer: the category stays (careful), but the lead must not cache it as a final verdict
  const r = await S.classify({ text: "Publish the app release" }, { safety: cfg({ classifier: "model" }), ask: async () => undefined })
  assert.deepEqual([r.categories, r.noAnswer], [["releases"], ["releases"]])
  const { ownerVerdicts } = await import("../src/graphs/lead.ts")
  setConfig({ ...defaults(), safety: cfg({ classifier: "model" }) })
  assert.equal((await ownerVerdicts([{ title: "Publish the app release" }])).size, 0, "no db, no model: nothing recorded")
  setConfig({ ...defaults(), safety: cfg({ classifier: "none" }) })
  assert.equal((await ownerVerdicts([{ title: "Publish the app release" }])).size, 1, "words only is a deliberate answer")
  setConfig({ ...defaults(), safety: cfg({ classifier: "none" }) })
  const db = open(":memory:")
  const { id } = addTicket(db, { project: "tally", title: "Backfill" })
  setTicket(db, id, { status: "fixing" })
  db.prepare("INSERT INTO kv VALUES ('automerge:ownerdev/tally#9', ?)").run(JSON.stringify({ ticket: id }))
  const { d } = deps(["m/2.sql"], "DELETE FROM x;")
  await rv.ownerOutcome(db, d, "ownerdev/tally", 9, { action: "owner", why: "migrations.data: m/2.sql changes existing data" })
  assert.equal(db.prepare("SELECT 1 FROM kv WHERE k='automerge:ownerdev/tally#9'").get(), undefined)
  setConfig()
})

test("round 3: a client folder is firm (a model 'no' cannot free it); '--' inside a string does not hide data statements", async () => {
  const r = await S.classify({ text: "Fix the gallery", project: "shopfront", files: ["clients/acme/index.html"] }, { safety: cfg({ classifier: "model" }), ask: async () => '{"client-sites":"no"}' })
  assert.deepEqual(r.categories, ["client-sites"])
  assert.equal(S.sqlChangesData("CREATE TABLE t (note text default '--'); UPDATE t SET note='x';"), true)
  assert.equal(S.sqlChangesData("-- don't update anything\nCREATE TABLE t (a int);"), false)
  // a firm owner-level category is a verdict even when another category got no answer
  const { ownerVerdicts } = await import("../src/graphs/lead.ts")
  setConfig({ ...defaults(), safety: cfg({ preset: "strict", classifier: "model", unsure: "allow" }) })
  assert.equal((await ownerVerdicts([{ title: "Rotate the stripe secret" }])).get("Rotate the stripe secret"), true)
  setConfig()
})

test("round 4: only real client folders are firm; couple/rsvp product files go to the classifier", async () => {
  for (const p of ["clients/acme/index.html", "sites/orion-invite/a.tsx", "templates/clients/x/a.tsx"]) assert.equal(S.firmClientPath(p), true, p)
  for (const p of ["src/components/CoupleNames.tsx", "src/rsvp/Form.tsx", "templates/rsvp/Rsvp.tsx", "demos/lyra-x/a.tsx".replace("lyra-x", "nova")]) assert.equal(S.firmClientPath(p), false, p)
  const r = await S.classify({ text: "Polish the form", project: "shopfront", files: ["src/rsvp/Form.tsx"] }, { safety: cfg({ classifier: "model" }), ask: async () => '{"client-sites":"no"}' })
  assert.deepEqual(r.categories, [])
  const firm = await S.check({ text: "Fix gallery", project: "shopfront", files: ["clients/acme/a.html"] }, { safety: cfg({ classifier: "none" }) })
  assert.match(firm.why, /client folder among the changed files/)
})

test("SQL: the wider data rules (drop any object, column type changes, REPLACE, table rebuilds, CTAS)", () => {
  for (const sql of ["DROP SCHEMA app CASCADE;", "DROP VIEW v;", "DROP MATERIALIZED VIEW mv;", "DROP SEQUENCE s;", "DROP INDEX IF EXISTS ix;", "ALTER TABLE t ALTER COLUMN c TYPE int USING c::int;", "ALTER TABLE t ALTER COLUMN c SET DATA TYPE bigint;", "ALTER TABLE t MODIFY COLUMN c int;", "REPLACE INTO t VALUES (1);", "MERGE INTO t USING s ON t.id=s.id WHEN MATCHED THEN UPDATE SET a=1;", "CREATE TABLE t2 AS SELECT * FROM t;", "CREATE TEMP TABLE t2 AS WITH x AS (SELECT 1) SELECT * FROM x;",
    "CREATE TABLE t_new (id int, a int);\nINSERT INTO t_new SELECT id, a FROM t;\nDROP TABLE t;\nALTER TABLE t_new RENAME TO t;"])
    assert.equal(S.sqlChangesData(sql), true, sql)
  assert.equal(S.sqlChangesData("CREATE TABLE c (id int, ts timestamp ON UPDATE CURRENT_TIMESTAMP);"), false)
})

test("migration files that are not .sql: ORM destructive operations are data, an unclassifiable file is data, a plain schema add is schema", () => {
  const data = ["knex.schema.dropTable('users')", "queryInterface.removeColumn('users', 'a')", "op.drop_column('t', 'a')", "op.execute('UPDATE users SET plan = NULL')", "knex.raw('DELETE FROM sessions')", "migrations.RemoveField(model_name='x', name='y')", "migrations.RunPython(fill)", "remove_column :users, :a", "execute 'DELETE FROM t'", "await prisma.user.deleteMany()", "await db.delete(users)", "await db.update(users).set({ a: 1 })", "table.renameColumn('a', 'b')", "queryInterface.bulkDelete('t')", "// nothing recognisable here\nconst x = 1"]
  for (const t of data) assert.equal(S.migrationChangesData("db/migrations/0001.ts", t), true, t)
  const schema = ["knex.schema.createTable('t', (t) => { t.increments('id'); t.integer('u').references('users.id').onDelete('CASCADE') })", "op.create_table('t', sa.Column('id', sa.Integer))", "migrations.CreateModel(name='T', fields=[('id', models.AutoField())])", "export const t = pgTable('t', { id: serial('id') })"]
  for (const t of schema) assert.equal(S.migrationChangesData("db/migrations/0002.py", t), false, t)
})

test("classify: a .ts migration with a destructive ORM call is migrations.data, a createTable is schema", async () => {
  const o = { safety: cfg({ classifier: "none" as const }) }
  const f = "app/migrations/0007_x.ts"
  assert.deepEqual((await S.classify({ text: "x", files: [f], sql: [{ path: f, sql: "await knex.schema.dropTable('users')" }] }, o)).categories, ["migrations.data"])
  assert.deepEqual((await S.classify({ text: "x", files: [f], sql: [{ path: f, sql: "await knex.schema.createTable('users', (t) => t.increments('id'))" }] }, o)).categories, ["migrations.schema"])
})

test("owner push lease: only when origin's head is an ancestor of the local branch", async () => {
  const { ownerLease } = await import("../src/graphs/ticket.ts")
  const mk = (anc: boolean, ls = "abc123\trefs/heads/foreman/5\n") => async (cmd: string) => (cmd.includes("ls-remote") ? { ok: true, out: ls } : { ok: anc, out: "" })
  assert.equal(await ownerLease(mk(true), "/r", "foreman/5"), "abc123")
  assert.equal(await ownerLease(mk(false), "/r", "foreman/5"), "", "diverged: a plain push, never a force")
  assert.equal(await ownerLease(mk(true, ""), "/r", "foreman/5"), "", "no remote branch")
})

test("sqlFromDiff reads a renamed migration under its new path", () => {
  const d = "diff --git a/db/migrations/1.sql b/db/migrations/2_renamed.sql\nsimilarity index 80%\nrename from db/migrations/1.sql\nrename to db/migrations/2_renamed.sql\n--- a/db/migrations/1.sql\n+++ b/db/migrations/2_renamed.sql\n@@ -1 +1 @@\n+UPDATE t SET a=1;\n"
  assert.deepEqual(S.sqlFromDiff(d), [{ path: "db/migrations/2_renamed.sql", sql: "UPDATE t SET a=1;" }])
})

test("ticket gate: a policy.json ask rule of its own holds the ticket like a built-in owner word", async () => {
  const { ticketGate } = await import("../src/safety.ts")
  const { DEFAULT_RULES } = await import("../src/policy.ts")
  const extra = [...DEFAULT_RULES, { id: "invoices", applies: "ticket-text" as const, match: "invoice", action: "ask" as const, why: "invoices are the owner's" }]
  assert.equal(ticketGate("Add an invoice export", {}, undefined, DEFAULT_RULES), "free") // no built-in word
  assert.equal(ticketGate("Add an invoice export", {}, undefined, extra), "ask")
  assert.equal(ticketGate("Fix the footer", {}, undefined, extra), "free")
})

test("size step: an owner outcome that rests on no classifier answer is asked again; still none = owner, said plainly", async () => {
  const { checkTwice } = await import("../src/safety.ts")
  const r = (action: "owner" | "auto", noAnswer: string[]) => ({ action, why: "auth: matched by words (no classifier answer)", result: { categories: [], why: {}, unsure: [], denied: undefined, noAnswer } as any })
  const seq = (...xs: ReturnType<typeof r>[]) => { let i = 0; return async () => xs[i++] }
  assert.equal((await checkTwice(seq(r("owner", ["auth"]), r("auto", [])))).action, "auto") // answered the second time
  const twice = await checkTwice(seq(r("owner", ["auth"]), r("owner", ["auth"])))
  assert.equal(twice.action, "owner")
  assert.match(twice.why, /no answer twice, so it waits for you$/)
  let calls = 0
  await checkTwice(async () => (calls++, r("owner", []))) // a real verdict is final: one call
  assert.equal(calls, 1)
})

test("every-merge floor: strict makes every merge the owner's, balanced leaves it, everyMerge overrides, owner PRs too", async () => {
  const { mergeAction, everyMergeFloor } = await import("../src/safety.ts")
  const s = (preset: "strict" | "balanced" | "autonomous", everyMerge?: "auto" | "review" | "owner") => ({ preset, rules: {}, classifier: "none" as const, unsure: "ask" as const, ...(everyMerge ? { everyMerge } : {}) })
  const plain = { action: "auto" as const, why: "nothing sensitive" }
  assert.deepEqual(mergeAction(plain, s("balanced")), plain)
  assert.equal(mergeAction(plain, s("strict")).action, "owner")
  assert.match(mergeAction(plain, s("strict")).why, /every merge waits for you \(the strict preset\)/)
  assert.equal(mergeAction(plain, s("autonomous", "review")).action, "review")
  assert.equal(mergeAction({ action: "never" as const, why: "x" }, s("strict")).action, "never") // the floor never loosens
  assert.equal(everyMergeFloor(s("balanced", "owner")), "owner")
})

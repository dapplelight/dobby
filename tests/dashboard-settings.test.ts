// Settings, Team and First run: GET /api/config (defaults, sources, secrets), configSet through the terminal, the dashboard and MCP, role files saved only
// inside the roles folder, the Team and First run data, and the checks that keep the page honest (no night framing, the entry budget).
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { request } from "node:http"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-settings-`)
const SECRET_VALUE = "xoxb-never-shown-0123456789"
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/secrets.env`
process.env.DOBBY_CONFIG = `${dir}/config.json`
process.env.JEV_API_KEY = ""
writeFileSync(`${dir}/secrets.env`, `DISCORD_BOT_TOKEN=${SECRET_VALUE}\nDASHBOARD_TOKEN=tok-settings\n`)
const { open } = await import("../src/db.ts")
const C = await import("../src/config-edit.ts")
const S = await import("../src/dashboard-server.ts")
const A = await import("../src/actions.ts")
const T = await import("../src/dashboard-team.ts")
const DS = await import("../src/dashboard-settings.ts")
const { setPause } = await import("../src/pause.ts")
const { loadConfig } = await import("../src/config.ts")
const { createDobbyServer } = await import("../src/mcp.ts")
const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client")
const API = await import("../src/api-schema.ts")
const { ACTIONS, NAV } = await import("../dashboard/src/actions.ts")
const { firstRun } = await import("../dashboard/src/lib/welcome.ts")

const NOW = Date.parse("2026-10-20T12:00:00Z")
const TOKEN = "tok-settings"
let n = 0
/** A fresh private config file (and an empty project file) in the temp dir. */
const fresh = (priv?: object | string, repo?: object) => {
  const f = `${dir}/c${n++}.json`, r = `${dir}/r${n}.json`
  if (priv !== undefined) writeFileSync(f, typeof priv === "string" ? priv : JSON.stringify(priv, null, 2) + "\n")
  if (repo) writeFileSync(r, JSON.stringify(repo))
  return { file: f, repo: r }
}
const read = (f: string) => JSON.parse(readFileSync(f, "utf8"))

// ---- GET /api/config ----

test("config view: the schema, each key's default, source and description; secrets only as set / not set", () => {
  const { file, repo } = fresh({ pacing: { weekCap: 90 }, quietHours: { start: 22, end: 8 } }, { github: { mergeMethod: "merge" } })
  const v = API.ConfigView.parse(C.configView({ file, repo, now: NOW, secrets: { DISCORD_BOT_TOKEN: SECRET_VALUE }, env: {} }))
  const key = (k: string) => v.keys.find((x) => x.key === k)!
  assert.equal(key("pacing.weekCap").value, 90); assert.equal(key("pacing.weekCap").default, 95)
  assert.equal(key("pacing.weekCap").source, "config file"); assert.equal(key("pacing.weekCap").changed, true)
  assert.equal(key("quietHours.start").source, "config file"); assert.equal(key("quietHours.start").default, 23)
  assert.equal(key("quietHours.end").changed, false, "22 -> 8 leaves the end at its default: changed is by value")
  assert.equal(key("github.mergeMethod").source, "project file"); assert.equal(key("github.mergeMethod").value, "merge")
  assert.equal(key("eveningPostHour").source, "default"); assert.equal(key("eveningPostHour").value, 21)
  assert.equal(key("safety.preset").source, "default"); assert.deepEqual(key("safety.preset").options, ["strict", "balanced", "autonomous"])
  assert.equal(key("safety.everyMerge").default, "auto", "unset everyMerge is the preset's: balanced merges on its own")
  assert.equal(key("pacing.weekCap").kind, "number"); assert.equal(key("pacing.weekCap").min, 10); assert.equal(key("pacing.weekCap").max, 100)
  assert.match(key("pacing.weekCap").desc, /^Most of your weekly plan/, "the text is the one in docs/manual/config.md")
  assert.ok(v.keys.filter((k) => k.kind !== "map").every((k) => k.desc.length > 0), `no description: ${v.keys.filter((k) => k.kind !== "map" && !k.desc).map((k) => k.key)}`)
  assert.ok(!v.keys.some((k) => k.key.startsWith("migrated")), "`migrated` is a record, not a setting")
  assert.deepEqual(v.secrets.find((s) => s.name === "DISCORD_BOT_TOKEN"), { name: "DISCORD_BOT_TOKEN", set: true })
  assert.deepEqual(v.secrets.find((s) => s.name === "JEV_API_KEY"), { name: "JEV_API_KEY", set: false })
  assert.ok(!JSON.stringify(v).includes(SECRET_VALUE), "a secret's value is nowhere in the view")
  assert.ok(v.keys.every((k) => ["boolean", "number", "enum", "string", "list", "map"].includes(k.kind)))
})

// ---- configSet ----

test("configSet: a valid write lands in the file, keeps the other keys, the file's indent and order, and leaves no temp file", () => {
  const { file } = fresh('{\n    "paths": { "projects": "/x/p" },\n    "github": { "owner": "me", "accounts": ["me"] }\n}\n')
  const out = C.configSetText({ key: "pacing.weekCap", value: "90" }, { file })
  assert.match(out, /pacing\.weekCap set to 90, saved to /)
  const text = readFileSync(file, "utf8")
  assert.deepEqual(JSON.parse(text), { paths: { projects: "/x/p" }, github: { owner: "me", accounts: ["me"] }, pacing: { weekCap: 90 } })
  assert.match(text, /^\{\n {4}"paths"/, "four-space indent kept"); assert.ok(text.endsWith("\n"))
  assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp")), "written next to the file, then renamed over it")
  assert.equal(C.configSetText({ key: "pacing.weekCap", value: "80" }, { file }).startsWith("pacing.weekCap 90 to 80"), true)
  assert.equal(loadConfig({ private: file }).config.pacing?.weekCap, 80, "the loader reads it back")
  C.configSetText({ key: "github.accounts", value: "me, acme" }, { file }); assert.deepEqual(read(file).github.accounts, ["me", "acme"])
  C.configSetText({ key: "timezoneLabel", value: "123" }, { file }); assert.equal(read(file).timezoneLabel, "123", "a text setting keeps text that looks like a number")
  C.configSetText({ key: "scout.enabled", value: "false" }, { file }); assert.equal(read(file).scout.enabled, false)
  C.configSetText({ key: "safety.rules.payments", value: "owner" }, { file }); assert.equal(read(file).safety.rules.payments, "owner", "a record key is a setting too")
})

test("configSet: an unknown key or a bad value is refused with the valid choices, and the file is not touched", () => {
  const { file } = fresh({ pacing: { weekCap: 90 } })
  const before = readFileSync(file, "utf8")
  const bad = (a: Parameters<typeof C.configSetText>[0], re: RegExp) => { assert.throws(() => C.configSetText(a, { file }), (e: Error) => e instanceof C.ConfigError && re.test(e.message), JSON.stringify(a)) }
  bad({ key: "pacing.weekcap", value: "90" }, /unknown setting pacing\.weekcap; did you mean pacing\.weekCap\?.*valid under pacing settings: fallbackBuildsPerDay, weekCap/)
  bad({ key: "nope", value: "1" }, /unknown setting nope; valid top-level settings: timezone,/)
  bad({ key: "pacing.weekCap", value: "5" }, /pacing\.weekCap: got 5; allowed: at least 10/)
  bad({ key: "pacing.weekCap", value: "abc" }, /allowed: a whole number|allowed: number/)
  bad({ key: "pacing.weekCap", value: "101" }, /at most 100/)
  bad({ key: "safety.preset", value: "loose" }, /safety\.preset: got "loose"; allowed: strict, balanced, autonomous/)
  bad({ key: "safety.rules.nope", value: "auto" }, /nope is not one of migrations\.schema, migrations\.data, payments/)
  bad({ key: "safety.rules.payments", value: "maybe" }, /allowed: auto, review, owner, never/)
  bad({ key: "pacing", value: "1" }, /is a group; set one of: pacing\.fallbackBuildsPerDay, pacing\.weekCap/)
  bad({ key: "migrated.at", value: "x" }, /unknown setting/)
  bad({ key: "billing.dailyUsd", value: "30" }, /billing\.mode/) // billing needs its mode: the whole group must stay valid
  bad({ key: "pacing.weekCap" }, /needs a value/)
  bad({ key: "" , value: "1" }, /needs a setting/)
  assert.equal(readFileSync(file, "utf8"), before)
  assert.match(C.configSetText({ key: "billing.mode", value: "apiKey" }, { file }), /billing\.mode set to "apiKey"/, "the mode alone is valid (the cap has a default)")
})

test("configSet: a file that is not valid JSON is never overwritten; the real config is never written under tests", () => {
  const { file } = fresh("{ not json")
  assert.throws(() => C.configSetText({ key: "pacing.weekCap", value: "90" }, { file }), /not valid JSON/)
  assert.equal(readFileSync(file, "utf8"), "{ not json")
  const { file: arr } = fresh("[1]")
  assert.throws(() => C.configSetText({ key: "pacing.weekCap", value: "90" }, { file: arr }), /not a JSON object/)
  const saved = process.env.DOBBY_CONFIG
  delete process.env.DOBBY_CONFIG
  try { assert.throws(() => C.configSetText({ key: "pacing.weekCap", value: "90" }), /a config file has to be named/) } finally { process.env.DOBBY_CONFIG = saved }
})

test("configSet: secrets.env is never written; an agent over MCP may pace, not loosen safety", () => {
  const secrets = readFileSync(`${dir}/secrets.env`, "utf8"), at = statSync(`${dir}/secrets.env`).mtimeMs
  const { file } = fresh({})
  C.configSetText({ key: "pacing.weekCap", value: "70" }, { file }); C.configSetText({ key: "pacing.weekCap", unset: true }, { file })
  assert.equal(readFileSync(`${dir}/secrets.env`, "utf8"), secrets); assert.equal(statSync(`${dir}/secrets.env`).mtimeMs, at)
  assert.ok(!JSON.stringify(read(file)).includes("DISCORD"))
  assert.match(C.configSetText({ key: "pacing.weekCap", value: "70" }, { file, agent: true }), /set to 70/)
  for (const k of ["safety.preset", "clientNames", "paths.projects", "providers.enabled", "github.owner", "frontDeskDenyMcp"]) assert.throws(() => C.configSetText({ key: k, value: '"x"' }, { file, agent: true }), /for the owner to change/, k)
  assert.match(C.configSetText({ key: "safety.preset", value: "strict" }, { file }), /set to "strict"/, "the owner may")
})

test("configSet unset: back to the default, an emptied group goes too, and unsetting what is not set says so", () => {
  const { file } = fresh({ pacing: { weekCap: 90 }, github: { owner: "me", accounts: [] } })
  assert.match(C.configSetText({ key: "pacing.weekCap", unset: true }, { file }), /back to its default \(was 90\)/)
  assert.deepEqual(read(file), { github: { owner: "me", accounts: [] } }, "pacing had nothing else, so the group is gone")
  assert.match(C.configSetText({ key: "pacing.weekCap", unset: true }, { file }), /is not set in .*nothing to remove/)
})

// ---- the server ----

const get = (base: string, path: string, token?: string) => new Promise<{ status: number; body: string }>((ok, bad) => {
  const u = new URL(base)
  const req = request({ host: u.hostname, port: u.port, path, method: "GET", headers: token ? { "x-foreman-token": token } : {} }, (res) => { let b = ""; res.on("data", (x) => (b += x)); res.on("end", () => ok({ status: res.statusCode!, body: b })) })
  req.on("error", bad); req.end()
})
const post = (base: string, body: object) => new Promise<{ status: number; body: any }>((ok, bad) => {
  const u = new URL(base)
  const req = request({ host: u.hostname, port: u.port, path: "/api/action", method: "POST", headers: { "x-foreman-token": TOKEN, origin: base, "content-type": "application/json" } }, (res) => { let b = ""; res.on("data", (x) => (b += x)); res.on("end", () => ok({ status: res.statusCode!, body: JSON.parse(b) })) })
  req.on("error", bad); req.end(JSON.stringify(body))
})
type Calls = { args: string[]; direct?: boolean }[]
async function up(o: Partial<Parameters<typeof S.createDashboard>[1]> = {}, exec?: (args: string[]) => string) {
  const db = open(":memory:"), calls: Calls = []
  const server = S.createDashboard(db, { token: TOKEN, now: () => NOW, dist: `${dir}/no-dist`, exec: async (args, direct) => (calls.push({ args, direct }), { ok: true, out: `${exec?.(args) ?? "done"}\n` }), ...o })
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
  return { db, server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls }
}
/** What the child `dobby config set|unset` does, run in this process on a chosen file. */
const cliOn = (file: string) => (args: string[]) => (args[1] === "unset" ? C.configSetText({ key: args[2], unset: true }, { file }) : C.configSetText({ key: args[2], value: args.slice(3).join(" ") }, { file }))

test("GET /api/config: needs the token, matches the schema, and shows secrets only as set / not set", async () => {
  const { file, repo } = fresh({ pacing: { weekCap: 88 } })
  const { server, base } = await up({ configFile: file, repoConfig: repo })
  try {
    assert.equal((await get(base, "/api/config")).status, 401)
    const r = await get(base, "/api/config", TOKEN)
    assert.equal(r.status, 200)
    const v = API.ConfigView.parse(JSON.parse(r.body))
    assert.equal(v.keys.find((k) => k.key === "pacing.weekCap")!.value, 88)
    assert.equal(v.secrets.find((s) => s.name === "DISCORD_BOT_TOKEN")!.set, true)
    assert.ok(!r.body.includes(SECRET_VALUE), "the bot token's value never leaves the server")
    assert.ok(!r.body.includes("tok-settings"), "nor the dashboard token")
  } finally { server.close() }
})

test("POST configSet: runs `dobby config set` once, answers with an undo id, and undo puts the old value back", async () => {
  const { file } = fresh({ pacing: { weekCap: 80 } })
  const { server, base, calls } = await up({ configFile: file }, cliOn(file))
  try {
    const set = await post(base, { action: "configSet", key: "pacing.weekCap", value: 90 })
    assert.equal(set.status, 200); assert.ok(set.body.actionId)
    assert.deepEqual(calls, [{ args: ["config", "set", "pacing.weekCap", "90"], direct: true }])
    assert.equal(read(file).pacing.weekCap, 90)
    const undone = await post(base, { action: "undo", actionId: set.body.actionId })
    assert.equal(undone.status, 200, JSON.stringify(undone.body))
    assert.deepEqual(calls.at(-1), { args: ["config", "set", "pacing.weekCap", "80"], direct: true }, "the previous value is what comes back")
    assert.equal(read(file).pacing.weekCap, 80)
    assert.equal((await post(base, { action: "undo", actionId: set.body.actionId })).status, 404, "an undo runs once")
    // a key that was not in the file: undo removes it again
    const k = await post(base, { action: "configSet", key: "scout.hour", value: 22 })
    assert.equal(read(file).scout.hour, 22)
    await post(base, { action: "undo", actionId: k.body.actionId })
    assert.equal(read(file).scout, undefined, "back to the default, not to a written-out default")
    const un = await post(base, { action: "configSet", key: "pacing.weekCap", unset: true })
    assert.deepEqual(calls.at(-1)!.args, ["config", "unset", "pacing.weekCap"]); assert.equal(read(file).pacing, undefined)
    await post(base, { action: "undo", actionId: un.body.actionId }); assert.equal(read(file).pacing.weekCap, 80)
  } finally { server.close() }
})

test("POST configSet: an unknown key or a bad value is refused with the choices and runs nothing", async () => {
  const { file } = fresh({})
  const { server, base, calls } = await up({ configFile: file })
  try {
    for (const [body, re] of [
      [{ action: "configSet", key: "pacing.nope", value: 1 }, /unknown setting pacing\.nope.*weekCap/],
      [{ action: "configSet", key: "pacing.weekCap", value: 3 }, /at least 10/],
      [{ action: "configSet", key: "safety.preset", value: "x" }, /allowed: strict, balanced, autonomous/],
      [{ action: "configSet", value: 1 }, /needs a setting/],
      [{ action: "configSet", key: "pacing.weekCap" }, /needs a value/],
    ] as const) {
      const r = await post(base, body); assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.body.ok, false); assert.match(r.body.message, re)
    }
    assert.equal(calls.length, 0)
  } finally { server.close() }
})

// ---- the three doors ----

test("three doors: the dashboard key, `dobby config set`, and the MCP op reach the same function, and MCP keeps to pacing", async () => {
  const act = A.actions.find((a) => a.name === "config-set")!
  assert.deepEqual([act.cli, act.mcp, act.cls], ["config", { tool: "dobby_pause", op: "config-set" }, "write"], "a write, not destructive: it sits with dobby_pause, which is annotated the same")
  const key = ACTIONS.find((a) => a.action === "configSet")!
  assert.equal(key.mcp, "dobby_pause/config-set"); assert.equal(key.cli, "config")
  assert.ok((S.DASHBOARD_ACTIONS as readonly string[]).includes("configSet"))
  assert.match(readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8"), /case "config":/)
  // the terminal
  const cfg = `${dir}/cli-config.json`
  const r = spawnSync(new URL("../bin/dobby", import.meta.url).pathname, ["config", "set", "pacing.weekCap", "85"], { encoding: "utf8", env: { ...process.env, DOBBY_CONFIG: cfg, DOBBY_DIR: dir } })
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /pacing\.weekCap set to 85/); assert.equal(read(cfg).pacing.weekCap, 85)
  const bad = spawnSync(new URL("../bin/dobby", import.meta.url).pathname, ["config", "set", "pacing.weekCap", "5"], { encoding: "utf8", env: { ...process.env, DOBBY_CONFIG: cfg, DOBBY_DIR: dir } })
  assert.notEqual(bad.status, 0); assert.match(bad.stdout + bad.stderr, /at least 10/); assert.equal(read(cfg).pacing.weekCap, 85)
  const gone = spawnSync(new URL("../bin/dobby", import.meta.url).pathname, ["config", "unset", "pacing.weekCap"], { encoding: "utf8", env: { ...process.env, DOBBY_CONFIG: cfg, DOBBY_DIR: dir } })
  assert.equal(gone.status, 0, gone.stderr); assert.equal(read(cfg).pacing, undefined)
  // MCP, over the SDK's in-memory transport; DOBBY_CONFIG is the temp file
  process.env.DOBBY_CONFIG = `${dir}/mcp-config.json`
  try {
    const server = createDobbyServer(open(":memory:"), { ...A.real, inbox: async () => undefined }, Buffer.alloc(32, 7))
    const [ct, st] = InMemoryTransport.createLinkedPair(), client = new Client({ name: "t", version: "0" }, {})
    await Promise.all([server.connect(st), client.connect(ct)])
    const call = (args: Record<string, unknown>) => client.callTool({ name: "dobby_pause", arguments: args })
    const ok = await call({ op: "config-set", key: "pacing.weekCap", value: "75" })
    assert.ok(!ok.isError, JSON.stringify(ok.content)); assert.equal(read(`${dir}/mcp-config.json`).pacing.weekCap, 75)
    const no = await call({ op: "config-set", key: "safety.preset", value: "autonomous" })
    assert.equal(no.isError, true); assert.match((no.content as { text: string }[])[0].text, /for the owner to change/)
    assert.equal(read(`${dir}/mcp-config.json`).safety, undefined)
    const tools = (await client.listTools()).tools.find((t) => t.name === "dobby_pause")!
    assert.deepEqual(tools.annotations && { r: tools.annotations.readOnlyHint, d: tools.annotations.destructiveHint }, { r: false, d: false })
    assert.ok((tools.description ?? "").length <= 800)
  } finally { process.env.DOBBY_CONFIG = `${dir}/config.json` }
})

// ---- role files ----

test("role files: saved only inside the roles folder; ../, an absolute path and a symlink out are refused", () => {
  const roles = `${dir}/roles`, outside = `${dir}/outside`, over = `${dir}/cfg/roles`
  mkdirSync(roles, { recursive: true }); mkdirSync(outside, { recursive: true })
  writeFileSync(`${roles}/builder.md`, "---\nmodel: sonnet\n---\nYou are a Builder.\n1. Read CLAUDE.md.\n2. Do only the ticket.\n")
  writeFileSync(`${outside}/target.md`, "original\n"); writeFileSync(`${outside}/passwd`, "root\n")
  symlinkSync(`${outside}/target.md`, `${roles}/evil.md`)
  const builtin = readFileSync(`${roles}/builder.md`, "utf8")
  assert.match(T.saveRole("builder", "---\nmodel: sonnet\n---\nYou are a Builder.\n1. New rule.\n", roles, over), /Saved .*builder\.md/)
  assert.match(readFileSync(`${over}/builder.md`, "utf8"), /New rule/, "the edit lands in the config folder")
  assert.equal(statSync(`${over}/builder.md`).mode & 0o777, 0o600)
  assert.equal(readFileSync(`${roles}/builder.md`, "utf8"), builtin, "the built-in (inside the package) is never written")
  assert.ok(!readdirSync(over).some((f) => f.endsWith(".tmp")))
  assert.match(T.roleText("builder", roles, over), /New rule/, "reads show the effective text")
  assert.equal(T.isEdited("builder", over), true); assert.equal(T.isEdited("evil", over), false)
  assert.equal(T.teamView(open(":memory:"), { projects: () => ({}), rolesDir: roles, overrideDir: over, now: NOW }).roles.find((r) => r.name === "builder")?.edited, true)
  T.saveRole("builder", "You are a Builder.\n1. Rules only, no top block.\n", roles, over) // a save without the top block keeps the model line
  assert.equal(readFileSync(`${over}/builder.md`, "utf8"), "---\nmodel: sonnet\n---\nYou are a Builder.\n1. Rules only, no top block.\n")
  T.saveRole("builder", "You are a Builder.\n1. Second edit.\n", roles, over) // and again, from the edited copy
  assert.match(readFileSync(`${over}/builder.md`, "utf8"), /^---\nmodel: sonnet\n---\nYou are a Builder\.\n1\. Second edit/)
  assert.match(T.resetRole("builder", roles, over), /Reset builder/)
  assert.ok(!existsSync(`${over}/builder.md`)); assert.equal(T.roleText("builder", roles, over), builtin)
  assert.match(T.resetRole("builder", roles, over), /already the default/)
  assert.throws(() => T.resetRole("../outside/passwd", roles, over)); assert.throws(() => T.resetRole("nope", roles, over))
  T.saveRole("builder", "---\nmodel: sonnet\n---\nYou are a Builder.\n1. New rule.\n", roles, over)
  for (const name of ["../outside/passwd", "..", "/etc/passwd", `${outside}/passwd`, "builder.md", "Builder", "", "a/b", "nope", "target"]) assert.throws(() => T.saveRole(name, "x\n", roles, over), Error, name)
  assert.throws(() => T.saveRole("evil", "pwned\n", roles, over), /is a link/)
  assert.equal(readFileSync(`${outside}/target.md`, "utf8"), "original\n", "the file the link points at is untouched")
  assert.equal(readFileSync(`${outside}/passwd`, "utf8"), "root\n")
  assert.equal(readlinkSync(`${roles}/evil.md`), `${outside}/target.md`)
  assert.throws(() => T.saveRole("builder", "   \n", roles, over), /cannot be empty/)
  assert.throws(() => T.saveRole("builder", "x".repeat(T.MAX_ROLE + 1), roles, over), /at most/)
  assert.throws(() => T.roleText("evil", roles, over), /is a link/)
  // through the server: the same checks before anything runs; the plan keeps the old text for undo
  return up({ rolesDir: roles, overrideDir: over }).then(async ({ server, base, calls }) => {
    try {
      for (const name of ["../outside/passwd", "/etc/passwd", "evil", "nope"]) { const r = await post(base, { action: "saveRole", name, text: "x" }); assert.equal(r.status, 400, name); assert.equal(r.body.ok, false) }
      assert.equal((await post(base, { action: "saveRole", name: "builder", text: "" })).status, 400)
      assert.equal(calls.length, 0)
      const ok = await post(base, { action: "saveRole", name: "builder", text: "---\nmodel: opus\n---\nYou are a Builder.\n" })
      assert.equal(ok.status, 200); assert.ok(ok.body.actionId)
      assert.deepEqual(calls[0].args.slice(0, 3), ["role", "save", "builder"])
      await post(base, { action: "undo", actionId: ok.body.actionId })
      assert.match(calls.at(-1)!.args[3], /New rule/, "undo saves the text that was there before")
      assert.equal(JSON.parse((await get(base, "/api/role/builder", TOKEN)).body).text.includes("New rule"), true)
      const rs = await post(base, { action: "resetRole", name: "builder" })
      assert.equal(rs.status, 200); assert.deepEqual(calls.at(-1)!.args, ["role", "reset", "builder"])
      assert.equal((await post(base, { action: "resetRole", name: "evil" })).status, 400)
      assert.equal((await get(base, "/api/role/evil", TOKEN)).status, 404)
      assert.equal((await get(base, "/api/role/nope", TOKEN)).status, 404)
    } finally { server.close() }
  })
})

// ---- Team ----

test("team view: projects (open, needs you, share, last merge) and roles (rules, model, share) from seeded data; pause targets are the real ones", () => {
  const roles = `${dir}/roles-team`
  mkdirSync(roles, { recursive: true })
  writeFileSync(`${roles}/builder.md`, "---\nname: builder\nmodel: sonnet\neffort: high\n---\nYou are a Builder. You get ONE ticket.\n1. Read CLAUDE.md.\n2. Do only the ticket.\n3. Never push.\n")
  writeFileSync(`${roles}/reviewer.md`, "---\nname: reviewer\ntitle: Code Reviewer\neffort: high\n---\nYou review pull requests with fresh eyes.\nCheck the done rule.\nNever approve your own work.\n")
  writeFileSync(`${roles}/checker.md`, "---\nname: checker\nmodel: haiku\n---\nYou are the Checker.\n- Be sceptical.\n")
  const db = open(":memory:")
  const t = (project: string, status: string, h = 2) => db.prepare("INSERT INTO tickets (project,title,status,created_at,updated_at) VALUES (?,?,?,?,?)").run(project, `T ${status}`, status, new Date(NOW - h * 3600_000).toISOString(), new Date(NOW - h * 3600_000).toISOString())
  t("tally", "ready"); t("tally", "running"); t("tally", "approval"); t("tally", "shipped", 5); t("shopfront", "ready"); t("shopfront", "shipped", 30)
  const run = (project: string, kind: string, usd: number, h = 3) => db.prepare("INSERT INTO runs (at,project,kind,ok,cost_usd) VALUES (?,?,?,1,?)").run(new Date(NOW - h * 3600_000).toISOString(), project, kind, usd)
  run("tally", "build", 52); run("tally", "review", 26); run("shopfront", "build", 26); run("tally", "build", 999, 24 * 9) // older than a week: not counted
  setPause(db, { kind: "reviews" }, true, "the owner", { now: NOW })
  const v = API.TeamView.parse(T.teamView(db, { projects: () => ({ tally: { repo: "~/projects/tally", base: "main", paused: false }, shopfront: { repo: "~/projects/shopfront", base: "main", paused: false } }), rolesDir: roles, overrideDir: `${dir}/no-edits`, now: NOW }))
  const tally = v.projects.find((p) => p.name === "tally")!
  assert.deepEqual([tally.open, tally.needsYou, tally.branch], [3, 1, "main"])
  assert.equal(tally.share.usd, 78); assert.equal(tally.share.pct, 3)
  assert.equal(tally.lastMerge, new Date(NOW - 5 * 3600_000).toISOString())
  assert.equal(v.projects.find((p) => p.name === "shopfront")!.share.usd, 26)
  const b = v.roles.find((r) => r.name === "builder")!, rev = v.roles.find((r) => r.name === "reviewer")!, ch = v.roles.find((r) => r.name === "checker")!
  assert.deepEqual([b.title, b.model, b.effort, b.ruleCount, b.pauseKind, b.paused], ["Builder", "sonnet", "high", 3, "builders", false])
  assert.equal(b.share!.usd, 78); assert.equal(b.does, "You are a Builder. You get ONE ticket.")
  assert.deepEqual([rev.title, rev.model, rev.ruleCount, rev.pauseKind, rev.paused], ["Code Reviewer", null, 2, "reviews", true], "a role written as paragraphs counts its lines")
  assert.equal(rev.share!.usd, 26)
  assert.deepEqual([ch.ruleCount, ch.pauseKind, ch.paused], [1, null, false], "the Checker has no pause target of its own, so it has no Pause")
  assert.equal(setPause(db, { project: "tally" }, true, "owner", { now: NOW }).changed, true)
  assert.equal(T.teamView(db, { projects: () => ({ tally: { repo: "~/projects/tally", base: "main", paused: false } }), rolesDir: roles, overrideDir: `${dir}/no-edits`, now: NOW }).projects[0].paused, true)
})

test("GET /api/team, /api/health, /api/providers, /api/welcome: token required, shapes match the schema, nothing secret", async () => {
  const roles = `${dir}/roles-team`
  const { server, base } = await up({
    rolesDir: roles, overrideDir: `${dir}/no-edits`, projects: () => ({ tally: { repo: "~/projects/tally", base: "main", paused: false } }),
    checks: async () => [{ name: "git", ok: true, detail: "2.50.0", required: true }, { name: "Discord", ok: false, detail: "off (optional)", fix: "add DISCORD_BOT_TOKEN to the secrets file", required: false }],
    providers: async () => ({ at: NOW, routing: false, rows: [{ id: "claude-code", label: "Claude Code", kind: "code tool", detected: true, key: "signed in", enabled: null }], hidden: 20 }),
  })
  try {
    for (const p of ["/api/team", "/api/health", "/api/providers", "/api/welcome"]) assert.equal((await get(base, p)).status, 401, p)
    API.TeamView.parse(JSON.parse((await get(base, "/api/team", TOKEN)).body))
    const h = API.HealthView.parse(JSON.parse((await get(base, "/api/health", TOKEN)).body))
    assert.equal(h.checks[1].fix, "add DISCORD_BOT_TOKEN to the secrets file"); assert.ok(h.schedules.length >= 6)
    API.ProvidersView.parse(JSON.parse((await get(base, "/api/providers", TOKEN)).body))
    const w = API.WelcomeView.parse(JSON.parse((await get(base, "/api/welcome", TOKEN)).body))
    assert.equal(w.needed, false, "a project exists")
    const snap = JSON.parse((await get(base, "/api/snapshot", TOKEN)).body)
    assert.deepEqual(snap.projects, ["tally"], "the snapshot lists the same projects")
  } finally { server.close() }
})

test("schedules: the jobs, the next daily run, and the two hours from the config in its own zone", () => {
  const rows = DS.schedulesView({ timezone: "Asia/Kolkata", timezoneLabel: "IST", eveningPostHour: 21, scout: { hour: 23 } }, Date.parse("2026-10-20T00:00:00Z")) // 05:30 IST
  const by = Object.fromEntries(rows.map((r) => [r.name, r]))
  assert.equal(by.tick.when, "always on"); assert.equal(by.tick.next, null)
  assert.equal(by.health.when, "every hour")
  assert.equal(by["evening post"].when, "daily 21:00 IST"); assert.equal(new Date(by["evening post"].next!).toISOString(), "2026-10-20T15:30:00.000Z")
  assert.equal(by.scout.when, "daily 23:00 IST"); assert.equal(new Date(by.scout.next!).toISOString(), "2026-10-20T17:30:00.000Z")
  assert.ok(by.cos.next! > Date.parse("2026-10-20T00:00:00Z") && by.cos.next! - Date.parse("2026-10-20T00:00:00Z") <= 86_400_000)
  assert.ok(!DS.schedulesView({ timezone: "UTC", timezoneLabel: "UTC", eveningPostHour: 21, scout: { enabled: false } }, NOW).some((r) => r.name === "scout"), "a disabled scout has no schedule")
})

test("providers: detected and key set or not, never the key; unset providers are counted, not listed", async () => {
  const env = { OPENAI_API_KEY: "sk-test-0123456789abcdef" }
  const v = API.ProvidersView.parse(await DS.providersView({
    cfg: undefined, env, now: NOW,
    run: { which: async (b) => (b === "claude" ? "/bin/claude" : null), probe: async () => false, runStatus: async () => 0 },
  }))
  assert.deepEqual(v.rows.find((r) => r.id === "claude-code"), { id: "claude-code", label: "Claude Code", kind: "code tool", detected: true, key: "signed in", enabled: null })
  assert.equal(v.rows.find((r) => r.id === "codex-cli")!.detected, false)
  assert.deepEqual(v.rows.find((r) => r.id === "openai"), { id: "openai", label: "OpenAI", kind: "model API", detected: true, key: "set", enabled: null })
  assert.ok(!JSON.stringify(v).includes(env.OPENAI_API_KEY)); assert.ok(v.hidden > 5); assert.equal(v.routing, false)
  assert.ok(!v.rows.some((r) => r.id === "mistral"), "an unset provider is only counted")
})

// ---- First run ----

test("first run: shown only when there is no project; repos are listed by name, only git ones, with nothing read from them", () => {
  assert.equal(firstRun([]), true); assert.equal(firstRun(["tally"]), false); assert.equal(firstRun(undefined), false, "not loaded yet is not a first run")
  const root = `${dir}/code`
  for (const r of ["tally", "shopfront", "notes"]) mkdirSync(`${root}/${r}/.git`, { recursive: true })
  mkdirSync(`${root}/not-a-repo`, { recursive: true }); mkdirSync(`${root}/.hidden/.git`, { recursive: true }); writeFileSync(`${root}/file.txt`, "x")
  writeFileSync(`${root}/tally/SECRET.md`, "do not read me")
  const w = DS.welcomeView({ projects: () => ({}), root, cfg: loadConfig({ private: null }).config, secrets: {}, env: {} })
  API.WelcomeView.parse(w)
  assert.equal(w.needed, true)
  assert.deepEqual(w.repos.map((r) => r.name), ["notes", "shopfront", "tally"]); assert.ok(w.repos.every((r) => !r.added))
  assert.ok(!JSON.stringify(w).includes("do not read me"))
  const w2 = DS.welcomeView({ projects: () => ({ tally: {} }), root, cfg: loadConfig({ private: null }).config, secrets: {}, env: {} })
  assert.equal(w2.needed, false); assert.equal(w2.repos.find((r) => r.name === "tally")!.added, true)
  assert.deepEqual(DS.reposUnder(`${dir}/missing`, new Set()), [])
})

test("first run: what leaves the machine is Claude Code and GitHub, plus only what is set up", () => {
  const cfg = loadConfig({ private: null }).config
  const base = DS.leavesMachine(cfg, {}, {})
  assert.equal(base.length, 2); assert.match(base[0], /Claude Code/); assert.match(base[1], /GitHub/)
  assert.ok(DS.leavesMachine(cfg, { DISCORD_BOT_TOKEN: "x" }, {}).some((l) => /Discord/.test(l)))
  assert.ok(!DS.leavesMachine(cfg, {}, { JEV_API_KEY: "k" }).some((l) => /Jev/.test(l)), "a Jev key alone is not opt-in: the classifier has to be switched to it")
  assert.ok(DS.leavesMachine({ ...cfg, safety: { ...cfg.safety, classifier: "jev" } }, {}, { JEV_API_KEY: "k" }).some((l) => /Jev/.test(l)))
  assert.ok(DS.leavesMachine({ ...cfg, providers: { enabled: true, providers: {}, roles: {}, policy: { allowUnsafe: [] } } }, {}, {}).some((l) => /model providers/.test(l)))
})

test("GET /api/welcome: needed when there is no project", async () => {
  const { server, base } = await up({ projects: () => ({}) })
  try {
    const w = API.WelcomeView.parse(JSON.parse((await get(base, "/api/welcome", TOKEN)).body))
    assert.equal(w.needed, true)
    assert.deepEqual(JSON.parse((await get(base, "/api/snapshot", TOKEN)).body).projects, [])
  } finally { server.close() }
})

// ---- the page ----

test("the registry has the Settings, Team and First run keys, with no repeats in a scope and no MCP door for role files", () => {
  const ids = ["config-set", "settings-dec", "settings-find", "settings-copy", "settings-undo", "settings-reset", "pause-role", "edit-rules", "team-add", "welcome-add"]
  const all = [...ACTIONS, ...NAV]
  for (const id of ids) assert.ok(all.some((e) => e.id === id), id)
  const edit = ACTIONS.find((e) => e.id === "edit-rules")!
  assert.equal(edit.local, true); assert.equal(edit.mcp, undefined, "an agent must not rewrite its own role files")
  assert.ok((S.DASHBOARD_ACTIONS as readonly string[]).includes("saveRole"))
})

test("nothing in dashboard/src talks about night or overnight", () => {
  const files: string[] = []
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(`${d}/${e.name}`) : /\.(tsx?|css|html)$/.test(e.name) && files.push(`${d}/${e.name}`) }
  walk(new URL("../dashboard/src", import.meta.url).pathname)
  assert.ok(files.length > 20)
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /night/i, f)
  const cv = C.configView({ file: `${dir}/none.json`, repo: `${dir}/none-repo.json`, secrets: {}, env: {} })
  assert.doesNotMatch(JSON.stringify(cv), /night/i, "/api/config text")
  assert.ok(!cv.keys.some((k) => /^[A-Za-z][\w.]*: /.test(k.desc)), "no description starts with its own key")
  assert.ok(existsSync(new URL("../dashboard/src/routes/settings.tsx", import.meta.url).pathname))
})

test("loadRole prefers the owner's edited copy in the config folder, and the built-in comes back after a reset", async () => {
  const { loadRole, ROOT } = await import("../src/lib.ts")
  const prev = process.env.DOBBY_CONFIG, cfg = `${dir}/lr`
  process.env.DOBBY_CONFIG = `${cfg}/config.json`
  try {
    const builtin = loadRole("builder")
    assert.ok(!existsSync(`${cfg}/roles`))
    T.saveRole("builder", "---\nmodel: haiku\n---\nEdited builder.\n1. Mine.\n")
    assert.ok(existsSync(`${cfg}/roles/builder.md`) && !readFileSync(`${ROOT}roles/builder.md`, "utf8").includes("Edited builder"), "saved to the config folder, not ROOT/roles")
    const edited = loadRole("builder")
    assert.equal(edited.meta.model, "haiku"); assert.match(edited.body, /Edited builder/)
    assert.match(T.roleText("builder"), /Edited builder/)
    T.resetRole("builder")
    assert.deepEqual(loadRole("builder"), builtin)
  } finally { if (prev === undefined) delete process.env.DOBBY_CONFIG; else process.env.DOBBY_CONFIG = prev }
})

// ---- Crash reports and usage stats ----

test("Settings: the stats section has its two switches off by default; the endpoint is a setting but not a switch; an agent cannot turn them on", () => {
  const { file, repo } = fresh({})
  const v = API.ConfigView.parse(C.configView({ file, repo, now: NOW, secrets: {}, env: {} }))
  const stats = v.keys.filter((k) => k.section === "stats")
  assert.deepEqual(stats.map((k) => [k.key, k.kind, k.value, k.default, k.changed]), [["stats.crashes", "boolean", false, false, false], ["stats.usage", "boolean", false, false, false], ["stats.endpoint", "string", "https://dobby-stats.nimitharia1.workers.dev", "https://dobby-stats.nimitharia1.workers.dev", false]])
  assert.ok(stats.every((k) => k.desc.length > 0))
  C.configSetText({ key: "stats.usage", value: "true" }, { file })
  assert.equal(read(file).stats.usage, true)
  assert.throws(() => C.configSetText({ key: "stats.usage", value: "true" }, { file, agent: true }), /for the owner to change/)
  assert.throws(() => C.configSetText({ key: "stats.crashes", value: "maybe" }, { file }), /true or false/)
  const src = readFileSync(new URL("../dashboard/src/routes/settings.tsx", import.meta.url), "utf8")
  assert.match(src, /Crash reports and usage stats/); assert.match(src, /Show what's sent/)
})

test("GET /api/stats/show: needs the token and prints the next payload, or says usage stats are off", async () => {
  const { server, base } = await up()
  try {
    assert.equal((await get(base, "/api/stats/show")).status, 401)
    const r = await get(base, "/api/stats/show", TOKEN)
    assert.equal(r.status, 200)
    assert.match(JSON.parse(r.body).text, /Usage stats are off/)
  } finally { server.close() }
})

test("Talent Scout settings each have their own description", () => {
  const v = C.configView({ file: `${dir}/none.json`, repo: `${dir}/none-repo.json`, secrets: {}, env: {} })
  const d = (k: string) => v.keys.find((x) => x.key === k)!.desc
  assert.notEqual(d("scout.enabled"), d("scout.hour"))
  assert.match(d("scout.hour"), /hour/i)
})

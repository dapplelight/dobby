// Providers wiring: config section, kv persistence, real runner, `dobby providers`. Temp paths, localhost only.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { test } from "node:test"
import Database from "better-sqlite3"

const dir = mkdtempSync(`${tmpdir()}/foreman-providers-`)
process.env.DOBBY_DIR ??= dir
process.env.DOBBY_SECRETS ??= `${dir}/secrets.env`
const { loadConfig } = await import("../src/config.ts")
const { current } = await import("../src/migrate.ts")
const { kvCatalog, loadPool, savePool, providersCmd, runner } = await import("../src/providers/wire.ts")
const { newPool, reportFailure } = await import("../src/providers/pool.ts")
type DB = import("../src/db.ts").DB

const kvDb = () => { const db = new Database(":memory:"); db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)"); return db as unknown as DB }

test("config: providers absent stays absent (migrate output unchanged); present gets defaults; a typo inside warns, file still used", () => {
  const none = `${dir}/none.json`, priv = `${dir}/p.json`
  assert.equal(loadConfig({ repo: none, private: null }).config.providers, undefined)
  assert.ok(!("providers" in current({ drafts: `${dir}/nodrafts`, secrets: none, db: none, launchAgents: none, now: new Date(0) })))
  writeFileSync(priv, JSON.stringify({ providers: { main: "gpt-5", typo: 1 } }))
  const l = loadConfig({ repo: none, private: priv })
  assert.deepEqual(l.config.providers, { enabled: false, providers: {}, main: "gpt-5", roles: {}, policy: { allowUnsafe: [] } })
  assert.deepEqual(l.warnings, [`${priv}: unknown key providers.typo (ignored)`])
  writeFileSync(priv, JSON.stringify({ providers: { roles: { reviewer: { primary: "https://evil.example/v1" } } } }))
  assert.equal(loadConfig({ repo: none, private: priv }).config.providers, undefined, "a URL as a profile name is rejected")
  // ...but only `providers` is dropped: the rest of the private file stays in force
  writeFileSync(priv, JSON.stringify({ timezone: "Europe/London", providers: { roles: { reviewer: { primary: "https://evil.example/v1" } } } }))
  const kept = loadConfig({ repo: none, private: priv })
  assert.equal(kept.config.timezone, "Europe/London")
  assert.equal(kept.config.providers, undefined)
  assert.ok(kept.sources.includes(priv))
  assert.match(kept.warnings.join("\n"), /providers\.roles\.reviewer\.primary/)
})

test("kv: pool and catalog round-trip; missing or corrupt rows read as absent", () => {
  const db = kvDb()
  assert.equal(loadPool(db, "openai"), null)
  const p = reportFailure(newPool("openai", ["OPENAI_API_KEY"]), "OPENAI_API_KEY", "auth", 1000)
  savePool(db, p)
  assert.deepEqual(loadPool(db, "openai"), p)
  db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run("providers:pool:openai", "{not json")
  assert.equal(loadPool(db, "openai"), null)
  db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run("providers:pool:openai", JSON.stringify({ provider: "openai", creds: "x" }))
  assert.equal(loadPool(db, "openai"), null)
  const c = kvCatalog(db)
  assert.equal(c.get("k"), undefined)
  c.set("k", { models: ["a"], at: 5 })
  assert.deepEqual(c.get("k"), { models: ["a"], at: 5 })
  db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run("providers:catalog:k", JSON.stringify({ models: [1], at: 5 }))
  assert.equal(c.get("k"), undefined)
  // bad modelCool values and an unknown strategy are dropped, the rest of the pool kept
  db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run("providers:pool:openai", JSON.stringify({ ...p, strategy: "evil", modelCool: { a: 5, b: "x", c: null } }))
  assert.deepEqual(loadPool(db, "openai"), { ...p, strategy: "fill_first", modelCool: { a: 5 } })
})

test("runner: which, status exit codes, timeouts, probe (argv arrays, no shell)", async () => {
  const r = runner({ which: 5000, status: 300, probe: 1000 })
  assert.match((await r.which("node")) ?? "", /node/)
  assert.equal(await r.which("no-such-bin-foreman-xyz"), null)
  assert.equal(await r.runStatus(process.execPath, ["-e", "process.exit(0)"]), 0)
  assert.equal(await r.runStatus(process.execPath, ["-e", "process.exit(3)"]), 3)
  const t0 = Date.now()
  assert.equal(await r.runStatus(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]), "unknown", "timeout says nothing about sign-in")
  assert.ok(Date.now() - t0 < 8000, "timed out, not waited")
  assert.equal(await r.runStatus("no-such-bin-foreman-xyz", []), "unknown", "ENOENT")
  assert.equal(await r.runStatus(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]), "unknown", "crash")
  const srv = createServer((_, res) => res.end("{}")).listen(0, "127.0.0.1")
  await new Promise((ok) => srv.once("listening", ok))
  const port = (srv.address() as { port: number }).port
  assert.equal(await r.probe(`http://127.0.0.1:${port}/`), true)
  srv.close()
  assert.equal(await r.probe(`http://127.0.0.1:${port}/`), false)
})

const stubRun = { which: async (b: string) => (b === "claude" ? "/bin/claude" : null), probe: async () => false, runStatus: async () => 0 }
const SECRET = "sk-test-value-never-printed"

test("providers detect/models/explain: names only, catalog cached in kv, plan only", async () => {
  const db = kvDb()
  let calls = 0
  const fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls++
    assert.ok(url.startsWith("https://api.openai.com/"))
    assert.equal(init?.headers?.authorization, `Bearer ${SECRET}`)
    return { ok: true, status: 200, json: async () => ({ data: [{ id: "gpt-live" }, { id: "text-embedding-3" }] }) }
  }
  const deps = { env: { OPENAI_API_KEY: ` ${SECRET}\n` }, run: stubRun, fetch, now: 1_000_000 } // key trimmed before sending
  const det = await providersCmd(db, ["detect"], deps)
  assert.match(det, /claude-code {2}\/bin\/claude {2}signed in: yes/)
  assert.match(det, /openai {2}OPENAI_API_KEY/)
  assert.ok(!det.includes(SECRET))
  const m1 = await providersCmd(db, ["models"], deps)
  assert.match(m1, /openai \(live/)
  assert.match(m1, /gpt-live/)
  assert.ok(!m1.includes("embedding") && !m1.includes(SECRET))
  assert.match(await providersCmd(db, ["models"], deps), /openai \(cache/)
  assert.equal(calls, 1, "second run served from kv")
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM kv").all()).includes(SECRET), "kv never holds the key")

  const ex = await providersCmd(db, ["explain"], deps)
  assert.match(ex, /providers config: absent/)
  assert.match(ex, /^builder: claude-code; now using claude-code$/m)
  assert.ok(!/^builder:.*gpt-5/m.test(ex), "builders only on sandboxed harnesses")
  savePool(db, reportFailure(newPool("openai", ["OPENAI_API_KEY"]), "OPENAI_API_KEY", "rate_limit", 1_000_000))
  assert.match(await providersCmd(db, ["explain"], deps), /gpt-5 \(cooling 1 min\)/)
  const bad = await providersCmd(db, ["explain"], { ...deps, cfg: { roles: { builder: { primary: "gpt-5" } } } as never })
  assert.match(bad, /owner overrides ignored/)
  assert.match(bad, /^builder: claude-code/m)
  let detected = false
  const spy = { ...stubRun, which: async (b: string) => { detected = true; return stubRun.which(b) } }
  assert.match(await providersCmd(db, ["nope"], { ...deps, run: spy }), /^usage:/)
  assert.equal(detected, false, "usage printed before running detection")
})

test("catalog: the vendor key goes only to the preset's protocol + host (https unless localhost)", async () => {
  const { fetchModels, vendorHostOk } = await import("../src/providers/catalog.ts")
  const { PROVIDERS } = await import("../src/providers/presets.ts")
  const sent: (string | undefined)[] = []
  const fetch = async (_: string, init?: { headers?: Record<string, string> }) => {
    sent.push(init?.headers?.authorization)
    return { ok: true, status: 200, json: async () => ({ data: [{ id: "m" }] }) }
  }
  const openai = PROVIDERS.find((p) => p.id === "openai")!
  await fetchModels(openai, "k", fetch, { baseUrl: "http://api.openai.com/v1" })
  await fetchModels(openai, "k", fetch, { baseUrl: "https://api.openai.com/v1" })
  await fetchModels(openai, "k", fetch, { baseUrl: "https://relay.example/v1", relayKey: "r" })
  assert.deepEqual(sent, [undefined, "Bearer k", "Bearer r"])
  assert.equal(vendorHostOk("http://localhost:11434/v1", "http://localhost:11434/v1"), true)
  assert.equal(vendorHostOk("http://evil.example/v1", "http://evil.example/v1"), false, "plain http off localhost never gets the key")
})

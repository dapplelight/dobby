// Claude Code OpenTelemetry: the run env, the OTLP/JSON parser (hand-built from the docs' attribute lists) and the loopback receiver.
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { test } from "node:test"

process.env.DOBBY_DIR = mkdtempSync(`${tmpdir()}/foreman-otel-`)
const { open } = await import("../src/db.ts")
const T = await import("../src/telemetry.ts")

const get = (db: any, sql: string): any => db.prepare(sql).get()
const s = (key: string, v: string) => ({ key, value: { stringValue: v } })
const i = (key: string, v: number) => ({ key, value: { intValue: String(v) } }) // OTLP/JSON sends int64 as a string
const d = (key: string, v: number) => ({ key, value: { doubleValue: v } })
const rec = (name: string, ts: string, attributes: unknown[]) => ({ timeUnixNano: String(Date.parse(ts) * 1e6), body: { stringValue: `claude_code.${name}` }, attributes: [s("event.name", name), s("event.timestamp", ts), s("session.id", "sess-1"), ...attributes] })
const payload = (records: unknown[]) => ({
  resourceLogs: [{
    resource: { attributes: [s("service.name", "claude-code"), s("foreman.project", "tally"), s("foreman.kind", "build"), s("foreman.ticket", "42")] },
    scopeLogs: [{ scope: { name: "com.anthropic.claude_code.events", version: "2.1.290" }, logRecords: records }],
  }],
})
export const FIXTURE = payload([
  rec("user_prompt", "2026-10-20T10:00:00.000Z", [i("prompt_length", 900), s("prompt", "SECRET: my salary is 12 lakh <REDACTED>")]),
  rec("tool_result", "2026-10-20T10:00:05.000Z", [s("tool_name", "Bash"), s("tool_use_id", "toolu_1"), s("success", "false"), i("duration_ms", 1200), s("error_type", "ShellError"), s("error", "exit 1"), s("decision_type", "accept"), s("decision_source", "config"), s("tool_input", "rm -rf /secret/path"), s("user.email", "me@example.com")]),
  rec("tool_decision", "2026-10-20T10:00:06.000Z", [s("tool_name", "Write"), s("decision", "reject"), s("source", "config"), s("tool_parameters", "{\"file_path\":\"/etc/passwd\"}")]),
  rec("api_request", "2026-10-20T10:00:07.000Z", [s("model", "claude-sonnet-5-5"), d("cost_usd", 0.0421), i("duration_ms", 3100), i("input_tokens", 1200), i("output_tokens", 300), i("cache_read_tokens", 50000), i("cache_creation_tokens", 800), s("request_id", "req_1")]),
  rec("api_error", "2026-10-20T10:00:08.000Z", [s("model", "claude-sonnet-5-5"), s("error", "Overloaded"), i("status_code", 529), i("duration_ms", 900), i("attempt", 2)]),
  rec("assistant_response", "2026-10-20T10:00:09.000Z", [i("response_length", 10), s("response", "<REDACTED>")]),
])

test("telemetryEnv: required settings, sanitised values, no content logging, off switch", () => {
  const e = T.telemetryEnv({ project: "tal ly/../x", kind: "build", ticket: 7, port: 4999 })
  assert.equal(e.CLAUDE_CODE_ENABLE_TELEMETRY, "1")
  assert.equal(e.OTEL_LOGS_EXPORTER, "otlp")
  assert.equal(e.OTEL_METRICS_EXPORTER, "none")
  assert.equal(e.OTEL_EXPORTER_OTLP_PROTOCOL, "http/json")
  assert.equal(e.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, "http://127.0.0.1:4999/v1/logs")
  assert.equal(e.OTEL_LOGS_EXPORT_INTERVAL, "5000")
  assert.equal(e.OTEL_RESOURCE_ATTRIBUTES, "foreman.project=tally..x,foreman.kind=build,foreman.ticket=7")
  assert.equal(T.telemetryEnv({ project: "p", kind: "lead" }).OTEL_RESOURCE_ATTRIBUTES, "foreman.project=p,foreman.kind=lead,foreman.ticket=none")
  assert.equal(Object.keys(e).filter((k) => k.startsWith("OTEL_LOG_")).length, 0)
  assert.deepEqual(T.telemetryEnv({ project: "p", kind: "k", off: true }), {})
})

test("withTelemetry strips inherited content-logging switches, and DOBBY_TELEMETRY=off disables all", () => {
  const base = { PATH: "/bin", OTEL_LOG_USER_PROMPTS: "1", OTEL_LOG_TOOL_DETAILS: "1", OTEL_LOG_RAW_API_BODIES: "1", OTEL_LOG_ASSISTANT_RESPONSES: "1", OTEL_LOG_TOOL_CONTENT: "1" }
  const on = T.withTelemetry(base, { project: "p", kind: "k" })
  assert.equal(on.CLAUDE_CODE_ENABLE_TELEMETRY, "1")
  assert.equal(on.PATH, "/bin")
  assert.deepEqual(Object.keys(on).filter((k) => k.startsWith("OTEL_LOG_")), [])
  const off = T.withTelemetry({ ...base, DOBBY_TELEMETRY: "off" }, { project: "p", kind: "k" })
  assert.equal(off.CLAUDE_CODE_ENABLE_TELEMETRY, undefined)
  assert.equal(off.OTEL_LOGS_EXPORTER, undefined)
})

test("parseOtlpLogs: allowlisted events and fields only, prompts and responses dropped", () => {
  const rows = T.parseOtlpLogs(FIXTURE)
  assert.deepEqual(rows.map((r) => r.event), ["tool_result", "tool_decision", "api_request", "api_error"])
  const [tr, td, ar, ae] = rows
  assert.equal(tr.session_id, "sess-1"); assert.equal(tr.project, "tally"); assert.equal(tr.kind, "build"); assert.equal(tr.ticket, 42)
  assert.equal(tr.at, "2026-10-20T10:00:05.000Z")
  assert.deepEqual([tr.tool_name, tr.success, tr.duration_ms, tr.error_type, tr.error, tr.decision_source], ["Bash", 0, 1200, "ShellError", "exit 1", "config"])
  assert.deepEqual([td.tool_name, td.decision, td.decision_source], ["Write", "reject", "config"])
  assert.deepEqual([ar.model, ar.cost_usd, ar.duration_ms, ar.input_tokens, ar.output_tokens, ar.cache_read_tokens, ar.cache_creation_tokens], ["claude-sonnet-5-5", 0.0421, 3100, 1200, 300, 50000, 800])
  assert.deepEqual([ae.status_code, ae.error, ae.attempt], [529, "Overloaded", 2])
  const text = JSON.stringify(rows)
  for (const leak of ["SECRET", "salary", "rm -rf", "/etc/passwd", "me@example.com", "toolu_1", "req_1"]) assert.ok(!text.includes(leak), leak)
})

test("parseOtlpLogs: ticket none, name only in the body, hostile resource values, not OTLP", () => {
  const body = { resourceLogs: [{ resource: { attributes: [s("foreman.ticket", "none"), s("foreman.project", "a b;rm -rf")] }, scopeLogs: [{ logRecords: [{ timeUnixNano: "1760000000000000000", body: { stringValue: "claude_code.tool_result" }, attributes: [s("tool_name", "Read"), s("success", "true")] }] }] }] }
  const [r] = T.parseOtlpLogs(body)
  assert.equal(r.event, "tool_result"); assert.equal(r.ticket, null); assert.equal(r.project, "abrm-rf"); assert.equal(r.success, 1)
  assert.equal(r.at, new Date(1760000000000).toISOString())
  assert.deepEqual(T.parseOtlpLogs({ resourceLogs: [] }), [])
  assert.throws(() => T.parseOtlpLogs({ nope: 1 }))
  assert.throws(() => T.parseOtlpLogs(null))
})

test("receiver: stores an allowlist on POST /v1/logs, rejects everything else, survives garbage", async () => {
  const db = open(":memory:")
  const srv = T.createReceiver(db, "n0nce")
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok))
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/logs`
  const post = (u: string, body: string, ct = "application/json", method = "POST", nonce = "n0nce") => fetch(u, { method, headers: { "content-type": ct, "x-dobby-nonce": nonce }, body: method === "GET" ? undefined : body })
  try {
    assert.equal((await post(url, JSON.stringify(FIXTURE), "application/json", "POST", "wrong")).status, 401) // another program on the machine
    assert.equal((await post(url, JSON.stringify(FIXTURE), "application/json", "POST", "")).status, 401)
    assert.equal(get(db, "SELECT count(*) n FROM telemetry").n, 0)
    assert.equal((await post(url, JSON.stringify(FIXTURE))).status, 200)
    assert.equal(get(db, "SELECT count(*) n FROM telemetry").n, 4)
    const cols = Object.keys(get(db, "SELECT * FROM telemetry LIMIT 1"))
    assert.ok(!cols.some((c) => /prompt|response|input$|param|body/.test(c)), cols.join())
    assert.equal(get(db, "SELECT ticket, project FROM telemetry LIMIT 1").ticket, 42)
    assert.equal((await post(url, "{not json")).status, 400)
    assert.equal((await post(url, '{"x":1}')).status, 400)
    assert.equal((await post(url, "{}", "text/plain")).status, 415)
    assert.equal((await post(url.replace("/v1/logs", "/v1/metrics"), "{}")).status, 404)
    assert.equal((await post(url, "", "application/json", "GET")).status, 405)
    assert.equal((await post(url, JSON.stringify({ resourceLogs: [] }))).status, 200) // still alive after garbage
    assert.equal(get(db, "SELECT count(*) n FROM telemetry").n, 4)
  } finally { srv.close() }
})

test("receiver: a body over 5 MB is refused", async () => {
  const srv = T.createReceiver(open(":memory:"), "n0nce")
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok))
  try {
    const r = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/logs`, { method: "POST", headers: { "content-type": "application/json", "x-dobby-nonce": "n0nce" }, body: `{"a":"${"x".repeat(5 * 1024 * 1024 + 10)}"}` }).catch(() => null)
    assert.ok(r === null || r.status === 413)
  } finally { srv.closeAllConnections(); srv.close() }
})

test("pruneTelemetry removes rows older than 30 days", () => {
  const db = open(":memory:")
  const now = Date.parse("2026-10-20T12:00:00Z")
  const ins = db.prepare("INSERT INTO telemetry (at, event) VALUES (?, 'tool_result')")
  ins.run("2026-09-01T00:00:00Z"); ins.run("2026-10-10T00:00:00Z")
  assert.equal(T.pruneTelemetry(db, now), 1)
  assert.equal(get(db, "SELECT count(*) n FROM telemetry").n, 1)
})

// ---- dashboard panel -------------------------------------------------------------
const D = await import("../src/dashboard.ts")
const NOW = Date.parse("2026-10-20T12:00:00Z")
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
function seed(db: any) {
  db.prepare("INSERT INTO tickets (id,project,title,status,created_at,updated_at) VALUES (7,'tally','Add dark mode: toggle','running',?,?)").run(ago(5), ago(1))
  const ins = db.prepare("INSERT INTO telemetry (at,session_id,kind,ticket,event,tool_name,success,duration_ms,decision,decision_source,status_code,error_type,cost_usd,input_tokens,cache_read_tokens,cache_creation_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  for (const ms of [100, 200, 300, 4000]) ins.run(ago(2), "s1", "build", 7, "tool_result", "Bash", ms === 4000 ? 0 : 1, ms, null, null, null, null, null, null, null, null)
  ins.run(ago(2), "s1", "build", 7, "tool_result", "Read", 0, 50, null, null, null, "ENOENT", null, null, null, null)
  ins.run(ago(2), "s1", "build", 7, "tool_decision", "Write", null, null, "reject", "config", null, null, null, null, null, null)
  ins.run(ago(2), "s1", "build", 7, "tool_decision", "Write", null, null, "reject", "config", null, null, null, null, null, null)
  ins.run(ago(2), "s1", "build", 7, "tool_decision", "Bash", null, null, "accept", "config", null, null, null, null, null, null)
  ins.run(ago(3), "s1", "build", 7, "api_error", null, null, 6000, null, null, 529, null, null, null, null, null)
  ins.run(ago(3), "s2", "lead", null, "api_error", null, null, 1000, null, null, null, "ECONNRESET", null, null, null, null)
  ins.run(ago(1), "s1", "build", 7, "api_request", null, null, 9000, null, null, null, null, 1.5, 100, 900, 0)
  ins.run(ago(1), "s2", "lead", null, "api_request", null, null, 2000, null, null, null, null, 0.25, 100, 0, 100)
  ins.run(ago(24 * 20), "s0", "build", 7, "tool_result", "Bash", 1, 99999, null, null, null, null, null, null, null, null) // outside a 7-day window
  for (const [sid, model] of [["s1", "opus"], ["s2", "haiku"], ["s3", "sonnet"], [null, "sonnet"], ["s4", "api:haiku"]]) db.prepare("INSERT INTO runs (at,project,kind,model,ok,session_id) VALUES (?,?,?,?,1,?)").run(ago(2), "tally", "build", model, sid)
}

test("telemetryPanel: failures, slowest, denials with ticket title, api errors, cost by kind, coverage", () => {
  const db = open(":memory:"); seed(db)
  const p = D.telemetryPanel(db, NOW, 7)
  assert.equal(p.has, true)
  assert.deepEqual(p.toolFailures.map((t) => [t.tool, t.calls, t.failed, t.failPct]), [["Bash", 4, 1, 25], ["Read", 1, 1, 100]])
  assert.deepEqual(p.slowest.map((t) => [t.tool, t.calls, t.p50Ms, t.p90Ms]), [["Bash", 4, 200, 4000]]) // Read has <3 calls
  assert.deepEqual(p.denials, [{ tool: "Write", source: "config", count: 2, ticket: 7, ticketTitle: "Add dark mode" }])
  assert.equal(p.apiErrors.total, 2)
  assert.deepEqual(p.apiErrors.byKind.map((e) => e.label).sort(), ["529", "ECONNRESET"])
  assert.equal(p.apiErrors.perDay.length, 7)
  assert.deepEqual(p.costByKind.map((c) => [c.kind, c.usd, c.requests, c.cachePct]), [["build", 1.5, 1, 90], ["lead", 0.25, 1, 0]])
  assert.deepEqual(p.coverage, { runs: 4, withData: 2, pct: 50 }) // the api: run is not a claude spawn
  assert.deepEqual(p.time, { toolMin: 0.1, modelMin: 0.2 })
})

test("telemetryPanel: empty and missing table read as no data", () => {
  assert.equal(D.telemetryPanel(open(":memory:"), NOW, 7).has, false)
  assert.deepEqual(D.telemetryPanel(open(":memory:"), NOW, 7).coverage, { runs: 0, withData: 0, pct: null })
  const db = open(":memory:"); db.exec("DROP TABLE telemetry")
  assert.equal(D.telemetryPanel(db, NOW, 7).has, false)
  assert.equal(JSON.parse(JSON.stringify(D.snapshot(open(":memory:"), NOW, 7))).telemetry.has, false)
})

test("ticketDetail carries the ticket's tool summary and newest problems; null without telemetry", () => {
  const db = open(":memory:"); seed(db)
  const t = D.ticketDetail(db, 7, NOW)!.telemetry!
  assert.equal(t.toolCalls, 6); assert.equal(t.toolFailures, 2); assert.equal(t.denials, 2); assert.equal(t.apiErrors, 1)
  assert.equal(t.tools[0].tool, "Bash")
  assert.ok(t.problems.some((p) => p.what === "denied" && p.tool === "Write") && t.problems.some((p) => p.what === "api error" && p.detail === "529"))
  db.prepare("INSERT INTO tickets (id,project,title,status,created_at,updated_at) VALUES (8,'tally','Other','ready',?,?)").run(ago(5), ago(1))
  assert.equal(D.ticketDetail(db, 8, NOW)!.telemetry, null)
})

test("nonce: one 600 file per install, made once; every run sends it as an OTLP header", async () => {
  const { mkdtempSync, statSync } = await import("node:fs")
  const dir = mkdtempSync(`${(await import("node:os")).tmpdir()}/dobby-nonce-`)
  const n = T.telemetryNonce(dir)
  assert.match(n, /^[0-9a-f]{48}$/)
  assert.equal(T.telemetryNonce(dir), n)
  assert.equal(statSync(`${dir}/telemetry.nonce`).mode & 0o777, 0o600)
  assert.equal(T.telemetryEnv({ project: "p", kind: "build", nonce: "abc" }).OTEL_EXPORTER_OTLP_LOGS_HEADERS, "x-dobby-nonce=abc")
})

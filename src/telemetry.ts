// Claude Code OpenTelemetry for Dobby's own `claude -p` runs: the settings each run gets, and a tiny loopback receiver that stores an
// allowlist of fields (never prompts, responses, tool inputs or diffs) in the `telemetry` table for the dashboard.
import { randomBytes, timingSafeEqual } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { DATA, type DB } from "./db.ts"

export const OTEL_PORT = () => Number(process.env.DOBBY_OTEL_PORT) || 4711
const BANNED = ["OTEL_LOG_USER_PROMPTS", "OTEL_LOG_ASSISTANT_RESPONSES", "OTEL_LOG_TOOL_DETAILS", "OTEL_LOG_TOOL_CONTENT", "OTEL_LOG_RAW_API_BODIES"]
const clean = (v: unknown) => String(v ?? "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64)

/** This install's telemetry nonce (a 600 file in the data folder, made once): runs send it, the receiver drops posts without it,
 *  so another program on the machine cannot feed the dashboard made-up numbers. */
export function telemetryNonce(dir = DATA): string {
  const f = `${dir}/telemetry.nonce`
  try { return readFileSync(f, "utf8").trim() } catch {}
  try { writeFileSync(f, randomBytes(24).toString("hex"), { flag: "wx", mode: 0o600 }) } catch {} // wx: a racing process's file wins
  return readFileSync(f, "utf8").trim()
}
const NONCE_HEADER = "x-dobby-nonce"

/** Variables for one claude run. Empty when `off`. Content logging is never switched on (BANNED is stripped by withTelemetry). */
export function telemetryEnv(o: { project: string; kind: string; ticket?: number | null; off?: boolean; port?: number; nonce?: string }): Record<string, string> {
  if (o.off) return {}
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_LOGS_EXPORTER: "otlp", OTEL_METRICS_EXPORTER: "none",
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `http://127.0.0.1:${o.port ?? OTEL_PORT()}/v1/logs`,
    OTEL_EXPORTER_OTLP_LOGS_HEADERS: `${NONCE_HEADER}=${o.nonce ?? telemetryNonce()}`,
    OTEL_LOGS_EXPORT_INTERVAL: "5000",
    OTEL_RESOURCE_ATTRIBUTES: `foreman.project=${clean(o.project) || "none"},foreman.kind=${clean(o.kind) || "none"},foreman.ticket=${o.ticket ? clean(o.ticket) || "none" : "none"}`,
  }
}

/** The environment to spawn claude with: the base plus the telemetry settings, minus any content-logging switch inherited from the shell. */
export function withTelemetry(base: NodeJS.ProcessEnv, o: Parameters<typeof telemetryEnv>[0]): NodeJS.ProcessEnv {
  const out = { ...base, ...telemetryEnv({ ...o, off: o.off ?? base.DOBBY_TELEMETRY === "off" }) }
  for (const k of BANNED) delete out[k]
  return out
}

export type Row = {
  at: string; session_id: string | null; project: string | null; kind: string | null; ticket: number | null; event: string
  model: string | null; tool_name: string | null; success: number | null; duration_ms: number | null; decision: string | null; decision_source: string | null
  error_type: string | null; error: string | null; status_code: number | null; cost_usd: number | null
  input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_creation_tokens: number | null; attempt: number | null
}
// Events worth keeping; everything else (user_prompt, assistant_response, *_body, plugin_*) is dropped whole.
const EVENTS = new Set(["tool_result", "tool_decision", "api_request", "api_error", "api_refusal", "mcp_server_connection", "auth"])

type AnyValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean }
type KV = { key: string; value?: AnyValue }
const unwrap = (v?: AnyValue): string | number | boolean | undefined => v?.stringValue ?? (v?.intValue !== undefined ? Number(v.intValue) : v?.doubleValue ?? v?.boolValue)
const attrs = (l?: KV[]) => new Map((Array.isArray(l) ? l : []).map((a) => [a.key, unwrap(a.value)]))
const str = (v: unknown, max = 200) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, max))
const num = (v: unknown) => { const n = v === undefined || v === null || v === "" ? NaN : Number(v); return Number.isFinite(n) ? n : null }

/** OTLP/JSON logs -> allowlisted rows. Throws on a body that is not OTLP logs JSON. */
export function parseOtlpLogs(json: unknown): Row[] {
  const rl = (json as { resourceLogs?: unknown } | null)?.resourceLogs
  if (!Array.isArray(rl)) throw new Error("not OTLP logs: no resourceLogs")
  const rows: Row[] = []
  for (const r of rl) {
    const res = attrs(r?.resource?.attributes)
    for (const s of r?.scopeLogs ?? []) for (const rec of s?.logRecords ?? []) {
      const a = attrs(rec?.attributes)
      const get = (k: string) => a.get(k) ?? res.get(k) // the foreman.* keys come with the resource, the rest with the record
      const event = String(a.get("event.name") ?? unwrap(rec?.body) ?? "").replace(/^claude_code\./, "")
      if (!EVENTS.has(event)) continue
      const nano = Number(rec?.timeUnixNano)
      const t = Date.parse(String(a.get("event.timestamp") ?? ""))
      const ticket = num(get("foreman.ticket"))
      const ok = get("success")
      rows.push({
        at: new Date(Number.isNaN(t) ? (nano > 0 ? nano / 1e6 : Date.now()) : t).toISOString(),
        session_id: str(get("session.id"), 100), project: str(clean(get("foreman.project"))), kind: str(clean(get("foreman.kind"))), ticket: ticket && ticket > 0 ? Math.trunc(ticket) : null, event,
        model: str(get("model"), 100), tool_name: str(get("tool_name"), 100),
        success: ok === undefined ? null : ok === true || ok === "true" ? 1 : 0,
        duration_ms: num(get("duration_ms")),
        decision: str(get("decision") ?? get("status"), 40), decision_source: str(get("source") ?? get("decision_source"), 40), // tool_decision.source | tool_result.decision_source
        error_type: str(get("error_type") ?? get("error_code") ?? get("error_category"), 100), error: str(get("error"), 200), status_code: num(get("status_code")),
        cost_usd: num(get("cost_usd")), input_tokens: num(get("input_tokens")), output_tokens: num(get("output_tokens")),
        cache_read_tokens: num(get("cache_read_tokens")), cache_creation_tokens: num(get("cache_creation_tokens")), attempt: num(get("attempt")),
      })
    }
  }
  return rows
}

const COLS = ["at", "session_id", "project", "kind", "ticket", "event", "model", "tool_name", "success", "duration_ms", "decision", "decision_source", "error_type", "error", "status_code", "cost_usd", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "attempt"] as const
export function storeRows(db: DB, rows: Row[]) {
  const ins = db.prepare(`INSERT INTO telemetry (${COLS.join(",")}) VALUES (${COLS.map(() => "?").join(",")})`)
  db.transaction(() => { for (const r of rows) ins.run(...COLS.map((c) => r[c])) })()
  return rows.length
}

export const pruneTelemetry = (db: DB, now = Date.now(), days = 30) => db.prepare("DELETE FROM telemetry WHERE at < ?").run(new Date(now - days * 86_400_000).toISOString()).changes

const MAX_BODY = 5 * 1024 * 1024
/** Loopback receiver. Not listening yet: the caller calls .listen(port, "127.0.0.1"). Nothing in it throws into the caller's process. */
export function createReceiver(db: DB, nonce = telemetryNonce()): Server {
  const want = Buffer.from(nonce)
  return createServer((req, res) => {
    const reply = (code: number, body = "{}") => { if (!res.headersSent) { res.writeHead(code, { "content-type": "application/json" }); res.end(body) } }
    try {
      if (new URL(req.url ?? "/", "http://x").pathname !== "/v1/logs") return reply(404)
      if (req.method !== "POST") return reply(405)
      const got = Buffer.from(String(req.headers[NONCE_HEADER] ?? ""))
      if (got.length !== want.length || !timingSafeEqual(got, want)) return reply(401)
      if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return reply(415)
      const chunks: Buffer[] = []
      let size = 0
      req.on("data", (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY) { reply(413); req.destroy(); return }
        chunks.push(c)
      })
      req.on("end", () => {
        try { storeRows(db, parseOtlpLogs(JSON.parse(Buffer.concat(chunks).toString("utf8")))); reply(200, '{"partialSuccess":{}}') } catch { reply(400, '{"error":"bad OTLP logs body"}') }
      })
      req.on("error", () => {})
    } catch { reply(400) }
  })
}

/** Start the receiver (listener process / `dobby telemetry-serve`) and the daily prune. A busy port is logged, not fatal; null then. */
export function startTelemetry(db: DB, port = OTEL_PORT()): Promise<Server | null> {
  if (process.env.DOBBY_TELEMETRY === "off") return Promise.resolve(null)
  const server = createReceiver(db)
  const prune = () => { try { pruneTelemetry(db) } catch (e) { console.log(`telemetry prune: ${(e as Error).message}`) } }
  prune()
  setInterval(prune, 86_400_000).unref()
  return new Promise((ok) => {
    server.once("error", (e) => { console.log(`telemetry receiver not started: ${(e as Error).message}`); ok(null) })
    server.listen(port, "127.0.0.1", () => { console.log(`telemetry receiver on 127.0.0.1:${(server.address() as { port: number }).port}`); ok(server) })
  })
}

// Issue #354: an organisation-level API key needs billing.workspaceId on every Anthropic call. Offline.
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-ws-`)
process.env.DOBBY_DIR = `${dir}/data`
process.env.DOBBY_SECRETS = `${dir}/s.txt`
process.env.DOBBY_BUILDER_SANDBOX = "off"
process.env.DOBBY_API_KEY = "sk-test"
process.env.JEV_API_KEY = ""
mkdirSync(`${dir}/data`, { recursive: true })
writeFileSync(process.env.DOBBY_SECRETS, "")
writeFileSync(`${dir}/claude`, `#!/bin/sh\ncat > /dev/null\nprintf '%s|%s' "$ANTHROPIC_API_KEY" "$ANTHROPIC_CUSTOM_HEADERS" > ${dir}/seen.txt\necho '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s1","num_turns":1,"total_cost_usd":0}'\n`)
chmodSync(`${dir}/claude`, 0o755)
process.env.PATH = `${dir}:${process.env.PATH}`
const { open } = await import("../src/db.ts")
const { setConfig, defaults } = await import("../src/config.ts")
const { claude } = await import("../src/lib.ts")
const { callApi } = await import("../src/api.ts")

test("with billing.workspaceId set, Claude Code gets the header and Messages calls send it; unset sends neither", async () => {
  const db = open(":memory:")
  for (const workspaceId of ["wrkspc_abc", undefined]) {
    setConfig({ ...defaults(), billing: { mode: "apiKey", dailyUsd: 20, workspaceId } })
    await claude(db, { project: "p", kind: "build", model: "sonnet", prompt: "hi", cwd: dir })
    assert.equal(readFileSync(`${dir}/seen.txt`, "utf8"), workspaceId ? "sk-test|anthropic-workspace-id: wrkspc_abc" : "sk-test|")
    let sent: Record<string, string> = {}
    const f = (async (_u: unknown, i?: RequestInit) => { sent = i?.headers as Record<string, string>; return new Response(JSON.stringify({ content: [] }), { status: 200 }) }) as unknown as typeof fetch
    await callApi(db, "haiku", "hi", f)
    assert.equal(sent["anthropic-workspace-id"], workspaceId)
  }
  setConfig()
})

test("on an API key, limits, status, usage and the welcome list talk dollars and the daily cap, not plan windows (#354)", async () => {
  const db = open(":memory:")
  const { limitsNow, limitsText, statusText } = await import("../src/view.ts")
  const { report, usageLine } = await import("../src/usage.ts")
  const { leavesMachine } = await import("../src/dashboard-settings.ts")
  const { spendPage } = await import("../src/spend.ts")
  const billing = { mode: "apiKey" as const, dailyUsd: 10 }
  setConfig({ ...defaults(), billing })
  assert.equal(limitsNow(db).state, "apiKey")
  assert.match(limitsText(limitsNow(db)), /^API key: \$0\.00 of \$10 in 24 hours$/)
  assert.doesNotMatch(statusText(db, Date.now(), limitsNow(db)), /Plan usage unknown|sign in/)
  assert.doesNotMatch(report(db, 1), /5-hour/)
  assert.match(report(db, 1), /Spend: API key: \$0\.00 of \$10/)
  assert.doesNotMatch(usageLine(db, null), /5-hour|limits unreadable/)
  assert.deepEqual(leavesMachine({ ...defaults(), billing }, {}, {}).slice(0, 1), ["Calls to Claude Code, billed to your API key."])
  assert.equal(leavesMachine(defaults(), {}, {})[0], "Calls to Claude Code, on your own Claude sign-in.")
  // only the daily cap was set: the page says $70 is 7 x daily
  assert.deepEqual([spendPage(db, Date.now(), null, billing).api?.weeklyUsd, spendPage(db, Date.now(), null, billing).api?.weeklySet], [70, false])
  assert.equal(spendPage(db, Date.now(), null, { ...billing, weeklyUsd: 50 }).api?.weeklySet, true)
  setConfig({ ...defaults(), billing: { mode: "plan", dailyUsd: 20 } })
  assert.notEqual(limitsNow(db, null).state, "apiKey") // plan mode is unchanged
  setConfig()
})

test("over the daily cap in apiKey mode, limits says Paused (#359)", async () => {
  const { setConfig, defaults } = await import("../src/config.ts")
  const { limitsNow, limitsText } = await import("../src/view.ts")
  const db = open(":memory:")
  setConfig({ ...defaults(), billing: { mode: "apiKey", dailyUsd: 0.05 } })
  db.prepare("INSERT INTO runs (at,project,kind,ok,cost_usd) VALUES (?, 'tally', 'build', 1, 1)").run(new Date().toISOString())
  assert.match(limitsText(limitsNow(db)), /^Paused: API key: \$1\.00 in 24 hours \(cap \$0\.05\)/)
  setConfig()
})

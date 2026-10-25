// Agent rules assembly: all tools on = the old single file; each tool's part only when on and found; user rules file; `dobby tools` edits.
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { defaults } from "../src/config.ts"
import { agentRules, enabled, setTool, toolsTable, TOOLS } from "../src/tools.ts"

const golden = readFileSync(new URL("./fixtures/agent-rules.golden.md", import.meta.url), "utf8")
const base = () => ({ ...defaults("/Users/me", "darwin", "UTC") })
const all = () => true

test("tools: everything on and found = today's agent-rules.md, byte for byte", () => {
  const c = base()
  c.tools = { jev: true }
  assert.equal(agentRules(c, all), golden)
  c.safety.classifier = "jev" // an owner who already uses Jev gets it by default
  c.tools = undefined
  assert.equal(agentRules(c, all), golden)
})

test("tools: defaults on for the free four, jev off unless the classifier is jev", () => {
  const c = base()
  assert.deepEqual(TOOLS.map((t) => enabled(t, c)), [true, true, true, true, false])
  assert.equal(enabled("jev", { ...c, safety: { ...c.safety, classifier: "jev" } }), true)
  assert.equal(enabled("graphify", { ...c, tools: { graphify: false } }), false)
})

test("tools: a part is dropped when its tool is off or missing; the core stays", () => {
  const c = base()
  const text = agentRules(c, (t) => t !== "graphify" && t !== "rtk" && t !== "jev")
  assert.ok(!/graphify|rtk|Jev/.test(text))
  assert.ok(text.includes("caveman ultra") && text.includes("# Ponytail") && text.includes("## Secrets\n"))
  c.tools = { caveman: false, ponytail: false }
  const bare = agentRules(c, all)
  assert.ok(!/caveman|Ponytail/.test(bare) && /graphify query/.test(bare))
})

test("tools: the user's rules file comes last", () => {
  const f = `${mkdtempSync(`${tmpdir()}/dobby-rules-`)}/mine.md`
  writeFileSync(f, "## Mine\nUse tabs.\n")
  const c = base()
  c.paths.agentRules = f
  assert.ok(agentRules(c, all).endsWith("\n\n## Mine\nUse tabs.\n"))
})

test("tools: dobby tools on/off edits only the tools key of the private config", () => {
  const f = `${mkdtempSync(`${tmpdir()}/dobby-tools-`)}/config.json`
  writeFileSync(f, '{"timezone":"UTC"}')
  setTool("rtk", false, f)
  setTool("jev", true, f)
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8")), { timezone: "UTC", tools: { rtk: false, jev: true } })
  assert.throws(() => setTool("nope", true, f))
  assert.match(toolsTable(base(), (t) => t !== "rtk"), /rtk\s+on\s+missing[^\n]*\n\s+install: brew install rtk/)
})

// `dobby mcp`: the five tools, resources, prompts, and above all the safety rule: nothing merges, deploys, cancels, declines or approves
// without a confirmed elicitation or the owner's own tap. Offline: in-memory DB, the SDK's in-memory transport, fake gh/deploy/inbox.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-mcp-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/secrets.env` // empty: nothing can reach Discord or GitHub
process.env.DOBBY_CONFIG = `${dir}/config.json`
process.env.JEV_API_KEY = ""
mkdirSync(`${dir}/projects/tally`, { recursive: true })
writeFileSync(`${dir}/config.json`, JSON.stringify({ paths: { projects: `${dir}/projects` } }))
writeFileSync(`${dir}/projects/tally/dobby.md`, "---\nbase: main\njev: off\ndeploy: true\n---\n## Goals\n- Ship")
const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: `${dir}/projects/tally`, encoding: "utf8" })
git("init", "-q", "-b", "main"), writeFileSync(`${dir}/projects/tally/a.txt`, "one\n"), git("add", "."), git("commit", "-qm", "one")
git("checkout", "-qb", "dobby/1"), writeFileSync(`${dir}/projects/tally/a.txt`, "one\ntwo\n"), git("commit", "-qam", "two"), git("checkout", "-q", "main")

const { Client, InMemoryTransport } = await import("@modelcontextprotocol/client")
const { open } = await import("../src/db.ts")
const { createDobbyServer, INSTRUCTIONS, claudeAddCommand, desktopConfig } = await import("../src/mcp.ts")
const { actions, real, ticketDiff } = await import("../src/actions.ts")
const { agentFiled } = await import("../src/lib.ts")
const { pages, MANUAL, render } = await import("../src/docs.ts")
type Deps = typeof real

/** A server over a fresh in-memory DB with every outside effect faked and recorded. */
function setup(o: { elicit?: "accept" | "decline" | "no" | "cancel" | "off" } = {}) {
  const db = open(":memory:")
  const calls = { answer: [] as unknown[][], cancel: [] as unknown[], land: [] as unknown[][], deploy: [] as unknown[], pause: [] as unknown[], inbox: [] as { text: string; buttons: { data: string }[]; key: string }[] }
  const deps: Deps = {
    ...real,
    answer: async (_db, id, d) => (calls.answer.push([id, d]), `answered ${d} ${id}`),
    cancel: (_db, id) => (calls.cancel.push(id), `cancelled ${id}`),
    land: async (_db, repo, pr) => (calls.land.push([repo, pr]), `landed ${repo}#${pr}`),
    deploy: async (_db, p) => (calls.deploy.push(p), `deployed ${p}`),
    pause: async (_db, t) => (calls.pause.push(t), t === "pause status" ? "Nothing is paused." : `did ${t}`),
    inbox: async (text, buttons, key) => void calls.inbox.push({ text, buttons: buttons as { data: string }[], key }),
  }
  const server = createDobbyServer(db, deps, Buffer.alloc(32, 7))
  const [ct, st] = InMemoryTransport.createLinkedPair()
  const el = o.elicit ?? "off"
  const client = new Client({ name: "t", version: "0" }, el === "off" ? {} : { capabilities: { elicitation: { form: {} } } })
  const asked: string[] = []
  if (el !== "off") client.setRequestHandler("elicitation/create", async (req) => {
    asked.push((req.params as { message: string }).message)
    return el === "accept" ? { action: "accept", content: { confirm: true } } : el === "no" ? { action: "accept", content: { confirm: false } } : { action: el }
  })
  const ready = Promise.all([server.connect(st), client.connect(ct)])
  const call = async (name: string, args: Record<string, unknown>) => { await ready; return client.callTool({ name, arguments: args }) }
  const text = (r: Awaited<ReturnType<typeof call>>) => (r.content as { text: string }[])[0]?.text ?? ""
  const sc = (r: Awaited<ReturnType<typeof call>>) => r.structuredContent as Record<string, unknown>
  const ticket = (title: string, status = "backlog", note: string | null = null) => Number(db.prepare("INSERT INTO tickets (project,title,status,note,created_at,updated_at) VALUES ('tally',?,?,?,datetime('now'),datetime('now'))").run(title, status, note).lastInsertRowid)
  return { db, calls, client, ready, call, text, sc, ticket, asked }
}
const idle = (c: ReturnType<typeof setup>["calls"]) => c.answer.length + c.cancel.length + c.land.length + c.deploy.length + c.pause.length

test("tools/list: the five tools in order, with the right annotations and descriptions", async () => {
  const s = setup()
  await s.ready
  const { tools } = await s.client.listTools()
  assert.deepEqual(tools.map((t) => t.name), ["dobby_read", "dobby_docs", "dobby_ticket", "dobby_pause", "dobby_decide"])
  const a = Object.fromEntries(tools.map((t) => [t.name, t.annotations]))
  assert.equal(a.dobby_read?.readOnlyHint, true), assert.equal(a.dobby_docs?.readOnlyHint, true)
  assert.equal(a.dobby_ticket?.readOnlyHint, false), assert.equal(a.dobby_ticket?.destructiveHint, false)
  assert.equal(a.dobby_pause?.idempotentHint, true), assert.equal(a.dobby_pause?.destructiveHint, false)
  assert.equal(a.dobby_decide?.destructiveHint, true), assert.equal(a.dobby_decide?.readOnlyHint, false)
  for (const t of tools) {
    assert.ok((t.description ?? "").length <= 800, `${t.name} description is ${t.description?.length} chars`)
    assert.ok(t.outputSchema, `${t.name} has an outputSchema`)
  }
  const first = (n: string) => (tools.find((t) => t.name === n)?.description ?? "").slice(0, 400).toLowerCase()
  assert.match(first("dobby_read"), /status/), assert.match(first("dobby_docs"), /manual/), assert.match(first("dobby_ticket"), /ticket/), assert.match(first("dobby_pause"), /pause/), assert.match(first("dobby_decide"), /merge/)
  assert.match(first("dobby_decide"), /deploy/)
})

test("instructions are under 4,096 characters and name the tool order", async () => {
  const s = setup()
  await s.ready
  assert.ok(INSTRUCTIONS.length < 4096, `${INSTRUCTIONS.length} chars`)
  assert.equal(s.client.getInstructions(), INSTRUCTIONS)
  for (const n of ["dobby_read", "dobby_docs", "dobby_ticket", "dobby_pause", "dobby_decide", "dobby://docs/"]) assert.ok(INSTRUCTIONS.includes(n), n)
})

test("dobby_read: status, list pagination (10 a page), show short vs full", async () => {
  const s = setup()
  const ids = Array.from({ length: 23 }, (_, i) => s.ticket(`Ticket number ${i + 1}`))
  const st = await s.call("dobby_read", { view: "status" })
  assert.match(s.text(st), /Building now/), assert.equal(s.sc(st).ok, true), assert.equal(s.sc(st).text, s.text(st))
  const p1 = await s.call("dobby_read", { view: "list" })
  assert.equal(s.text(p1).split("\n").filter((l) => l.startsWith("#")).length, 10)
  assert.equal(s.sc(p1).nextCursor, "10")
  const p3 = await s.call("dobby_read", { view: "list", cursor: String(s.sc(await s.call("dobby_read", { view: "list", cursor: "10" })).nextCursor) })
  assert.equal(s.text(p3).split("\n").filter((l) => l.startsWith("#")).length, 3), assert.equal(s.sc(p3).nextCursor, undefined)
  assert.equal((await s.call("dobby_read", { view: "list", cursor: "x1" })).isError, true) // a made-up cursor is refused, not trusted
  for (const k of [1, 2, 3]) s.db.prepare("INSERT INTO runs (at,project,kind,ticket,model,ok,cost_usd) VALUES (datetime('now'),'tally','build',?,'sonnet',1,0.5)").run(ids[0])
  const short = s.text(await s.call("dobby_read", { view: "show", id: ids[0] })), full = s.text(await s.call("dobby_read", { view: "show", id: ids[0], detail: "full" }))
  assert.match(short, /3 runs, \$1\.500/), assert.doesNotMatch(short, /run build sonnet/)
  assert.match(full, /run build sonnet ok/), assert.ok(full.length > short.length)
  const none = await s.call("dobby_read", { view: "show" })
  assert.equal(none.isError, true), assert.match(s.text(none), /ticket id/)
  assert.match(s.text(await s.call("dobby_read", { view: "pauses" })), /Nothing is paused/)
})

test("dobby_docs: list, read, search", async () => {
  const s = setup()
  const list = s.text(await s.call("dobby_docs", { op: "list" }))
  for (const p of pages()) assert.ok(list.includes(p.name))
  assert.match(s.text(await s.call("dobby_docs", { op: "read", topic: "first-hour" })), /^# Your first hour\n\n> /)
  const hits = s.text(await s.call("dobby_docs", { op: "search", query: "NEEDS-YOU" })) // case-insensitive
  assert.match(hits, /^[\w-]+: .*needs-you/im), assert.ok(hits.split("\n").length <= 20)
  assert.equal((await s.call("dobby_docs", { op: "read", topic: "nope" })).isError, true)
  assert.equal((await s.call("dobby_docs", { op: "read" })).isError, true)
})

test("dobby_ticket add files an agent-filed backlog ticket and says it waits; queueing it goes to the inbox", async () => {
  const s = setup()
  const r = await s.call("dobby_ticket", { op: "add", project: "tally", title: "Fix the footer", done_when: "footer is fixed" })
  assert.match(s.text(r), /waits in the backlog until you queue it/)
  const row = s.db.prepare("SELECT id, status, title FROM tickets").get() as { id: number; status: string; title: string }
  assert.equal(row.status, "backlog"), assert.equal(agentFiled(s.db, row.id), true)
  const q = await s.call("dobby_ticket", { op: "queue", id: row.id })
  assert.match(s.text(q), /Sent to your inbox for a tap/), assert.equal(s.sc(q).outcome, "sent_to_inbox")
  assert.equal(s.calls.inbox.length, 1), assert.deepEqual(s.calls.inbox[0].buttons.map((b) => b.data), [`queue ${row.id}`])
  assert.equal((s.db.prepare("SELECT status FROM tickets WHERE id=?").get(row.id) as { status: string }).status, "backlog") // still not queued
  const mine = s.ticket("Owner's own ticket") // not agent-filed: queue is the owner's own conversation
  assert.match(s.text(await s.call("dobby_ticket", { op: "queue", id: mine })), /queued/)
  assert.equal((await s.call("dobby_ticket", { op: "add", project: "nope", title: "x" })).isError, true)
})

test("dobby_pause: status, pause with a target, bad target refused; pause all is asked first", async () => {
  const s = setup()
  assert.match(s.text(await s.call("dobby_pause", { op: "status" })), /Nothing is paused/)
  assert.equal(s.text(await s.call("dobby_pause", { op: "pause", target: "deploys", for: "2h" })), "did pause deploys for 2h")
  assert.equal(s.text(await s.call("dobby_pause", { op: "resume", target: "builders" })), "did resume builders") // releases nothing held: no question
  assert.equal((await s.call("dobby_pause", { op: "pause", target: "x; rm -rf" })).isError, true)
  assert.equal((await s.call("dobby_pause", { op: "pause", for: "forever" })).isError, true)
  const before = s.calls.pause.length
  const r = await s.call("dobby_pause", { op: "pause", target: "all" }) // this client cannot be asked
  assert.equal(s.sc(r).outcome, "sent_to_inbox"), assert.equal(s.calls.pause.length, before)
  assert.deepEqual(s.calls.inbox.map((i) => i.buttons[0].data), ["pause all"])
})

test("pause all, confirmed: acts once; declined: nothing", async () => {
  const yes = setup({ elicit: "accept" })
  await yes.call("dobby_pause", { op: "pause", target: "all" })
  assert.deepEqual(yes.calls.pause, ["pause all"]), assert.match(yes.asked[0], /Pause everything/)
  const no = setup({ elicit: "no" })
  assert.equal(no.sc(await no.call("dobby_pause", { op: "pause", target: "all" })).outcome, "declined")
  assert.equal(no.calls.pause.length, 0), assert.equal(no.calls.inbox.length, 0)
})

const decide = (s: ReturnType<typeof setup>) => {
  const gate = s.ticket("Fix footer", "approval", "PR https://github.com/acme/tally/pull/12")
  return [
    { op: "approve", args: { id: gate }, hit: (c: ReturnType<typeof setup>["calls"]) => c.answer.length === 1 && c.answer[0][1] === "approve", button: `approve ${gate}`, ask: /Approve #\d+ "Fix footer"/ },
    { op: "decline", args: { id: gate }, hit: (c: ReturnType<typeof setup>["calls"]) => c.answer.length === 1 && c.answer[0][1] === "decline", button: `decline ${gate}`, ask: /Decline #\d+/ },
    { op: "cancel", args: { id: gate }, hit: (c: ReturnType<typeof setup>["calls"]) => c.cancel.length === 1, button: `decline ${gate}`, ask: /Cancel #\d+/ },
    { op: "merge", args: { id: gate }, hit: (c: ReturnType<typeof setup>["calls"]) => c.land.length === 1 && c.land[0][0] === "acme/tally" && c.land[0][1] === 12, button: `approve ${gate}`, ask: /Merge PR #12 #\d+ "Fix footer" into main\?/ },
    { op: "deploy", args: { project: "tally" }, hit: (c: ReturnType<typeof setup>["calls"]) => c.deploy.length === 1 && c.deploy[0] === "tally", button: "deploynow tally", ask: /Deploy tally to production/ },
  ]
}

test("dobby_decide, confirmed: each op acts exactly once, after asking a plain question", async () => {
  for (const [i, d] of decide(setup()).entries()) {
    const s = setup({ elicit: "accept" })
    const cases = decide(s)
    const r = await s.call("dobby_decide", { op: d.op, ...cases[i].args })
    assert.equal(r.isError, undefined, s.text(r))
    assert.ok(cases[i].hit(s.calls), `${d.op} acted once: ${JSON.stringify(s.calls)}`)
    assert.equal(s.asked.length, 1), assert.match(s.asked[0], cases[i].ask), assert.equal(s.sc(r).outcome, "done")
    assert.equal(s.calls.inbox.length, 0)
  }
})

test("dobby_decide, declined (no, or the dialog dismissed): nothing is done and it says so", async () => {
  for (const elicit of ["no", "decline", "cancel"] as const) for (const [i, d] of decide(setup()).entries()) {
    const s = setup({ elicit })
    const r = await s.call("dobby_decide", { op: d.op, ...decide(s)[i].args })
    assert.equal(idle(s.calls), 0, `${d.op}/${elicit} did something: ${JSON.stringify(s.calls)}`)
    assert.equal(s.calls.inbox.length, 0)
    assert.equal(s.asked.length, 1), assert.match(s.text(r), /Not done/), assert.equal(s.sc(r).outcome, "declined")
  }
})

test("dobby_decide, client cannot ask (headless): nothing is done, the inbox gets one card with the existing button", async () => {
  for (const [i, d] of decide(setup()).entries()) {
    const s = setup() // no elicitation capability
    const c = decide(s)[i]
    const r = await s.call("dobby_decide", { op: d.op, ...c.args })
    assert.equal(idle(s.calls), 0, `${d.op} acted without being asked: ${JSON.stringify(s.calls)}`) // merge and deploy are never called here
    assert.equal(s.calls.land.length, 0), assert.equal(s.calls.deploy.length, 0)
    assert.equal(s.calls.inbox.length, 1)
    assert.ok(s.calls.inbox[0].buttons.some((b) => b.data === c.button), `${d.op}: buttons ${JSON.stringify(s.calls.inbox[0].buttons)}`)
    assert.match(s.text(r), /Sent to your inbox for a tap/), assert.equal(s.sc(r).outcome, "sent_to_inbox")
  }
})

test("dobby_decide: unknown ticket or project is an error before anything is asked; every path through the registry is a destructive op behind the ask", async () => {
  const s = setup({ elicit: "accept" })
  assert.equal((await s.call("dobby_decide", { op: "merge", id: 999 })).isError, true)
  assert.equal((await s.call("dobby_decide", { op: "deploy", project: "ghost" })).isError, true)
  assert.equal((await s.call("dobby_decide", { op: "merge" })).isError, true)
  assert.equal(idle(s.calls), 0), assert.equal(s.asked.length, 0)
  // the only tool that reaches a destructive registry entry is dobby_decide, and it is annotated so
  const destructive = actions.filter((a) => a.cls === "destructive")
  assert.deepEqual(destructive.map((a) => a.name).sort(), ["approve", "cancel", "decline", "deploy", "merge", "retry"])
  assert.ok(destructive.every((a) => a.mcp.tool === "dobby_decide"))
  assert.ok(actions.filter((a) => a.mcp.tool !== "dobby_decide").every((a) => a.cls !== "destructive"))
})

test("resources: docs list matches docs/manual; log and diff for a fixture ticket; diff is clipped", async () => {
  const s = setup()
  await s.ready
  const listed = (await s.client.listResources()).resources.filter((r) => r.uri.startsWith("dobby://docs/")).map((r) => r.uri.slice("dobby://docs/".length)).sort()
  assert.deepEqual(listed, pages().map((p) => p.name).sort())
  const doc = await s.client.readResource({ uri: "dobby://docs/cli" })
  assert.equal(doc.contents[0].mimeType, "text/markdown"), assert.equal((doc.contents[0] as { text: string }).text, render(readFileSync(`${MANUAL}cli.md`, "utf8")))
  const id = s.ticket("Add a second line")
  s.db.prepare("UPDATE tickets SET branch='dobby/1' WHERE id=?").run(id)
  const log = (await s.client.readResource({ uri: `dobby://ticket/${id}/log` })).contents[0] as { text: string }
  assert.match(log.text, /Add a second line/)
  const diff = (await s.client.readResource({ uri: `dobby://ticket/${id}/diff` })).contents[0] as { text: string }
  assert.match(diff.text, /\+two/)
  await assert.rejects(s.client.readResource({ uri: "dobby://ticket/999/diff" }))
  const big = ticketDiff(s.db, id, { projects: real.projects, git: () => "x".repeat(300 * 1024) })
  assert.ok(big.length < 205 * 1024), assert.match(big, /diff clipped at 200 KB/)
  assert.match(ticketDiff(s.db, id, { projects: real.projects, git: () => "" }), /No changes/)
})

test("prompts: morning_status and triage_inbox", async () => {
  const s = setup()
  await s.ready
  assert.deepEqual((await s.client.listPrompts()).prompts.map((p) => p.name).sort(), ["morning_status", "triage_inbox"])
  const m = (await s.client.getPrompt({ name: "morning_status" })).messages[0].content as { text: string }
  assert.match(m.text, /Building now/), assert.match(m.text, /WAITS FOR ME\nNothing\./)
  s.ticket("Stuck thing", "failed", "verify failed twice")
  const t = (await s.client.getPrompt({ name: "triage_inbox" })).messages[0].content as { text: string }
  assert.match(t.text, /Stuck thing/), assert.match(t.text, /approve, decline, cancel/)
})

test("errors are plain: no stack traces, no secrets", async () => {
  const s = setup()
  const r = await s.call("dobby_read", { view: "show", id: 999999 })
  assert.doesNotMatch(s.text(r), /\n\s+at |node_modules|\.ts:\d+/)
  const bad = await s.call("dobby_read", { view: "bogus" })
  assert.equal(bad.isError, true), assert.doesNotMatch(s.text(bad), /\n\s+at |node_modules/)
})

test("parity: every registry entry has a CLI verb and an MCP op, and every MCP op maps to an entry", async () => {
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")
  const verb = (v: string) => new RegExp(`case "${v}"|cmd === "${v}"`).test(cli)
  for (const a of actions) assert.ok(verb(a.cli), `${a.name}: no CLI verb "${a.cli}"`)
  const s = setup()
  await s.ready
  const { tools } = await s.client.listTools()
  const seen = new Set<string>()
  for (const t of tools) {
    const props = (t.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties
    const ops = (props.op ?? props.view).enum ?? []
    assert.ok(ops.length, `${t.name} has no op enum`)
    for (const op of ops) { assert.ok(actions.some((a) => a.mcp.tool === t.name && a.mcp.op === op), `${t.name} ${op} has no registry entry`); seen.add(`${t.name}/${op}`) }
  }
  for (const a of actions) assert.ok(seen.has(`${a.mcp.tool}/${a.mcp.op}`), `${a.name}: not reachable as ${a.mcp.tool} ${a.mcp.op}`)
  assert.equal(new Set(actions.map((a) => a.name)).size, actions.length)
})

test("dobby add mcp: the Claude Code command and the Desktop block", () => {
  assert.deepEqual(claudeAddCommand("/x/bin/dobby"), ["claude", "mcp", "add", "--scope", "user", "dobby", "--", "/x/bin/dobby", "mcp"])
  assert.deepEqual(JSON.parse(desktopConfig("/x/bin/dobby")), { mcpServers: { dobby: { command: "/x/bin/dobby", args: ["mcp"] } } })
  const r = spawnSync(new URL("../bin/dobby", import.meta.url).pathname, ["add", "mcp"], { encoding: "utf8", env: process.env, input: "" }) // no TTY, no --yes: prints, runs nothing
  assert.match(r.stdout, /claude mcp add --scope user dobby -- \S+\/bin\/dobby mcp/), assert.match(r.stdout, /"mcpServers"/), assert.match(r.stdout, /dobby add mcp --yes/)
})

test("dobby mcp writes nothing to stdout before the client's initialize; the first bytes are JSON-RPC", async () => {
  const p = spawn(new URL("../bin/dobby", import.meta.url).pathname, ["mcp"], { env: process.env, stdio: ["pipe", "pipe", "pipe"] })
  let out = ""
  p.stdout.on("data", (b) => (out += b))
  await new Promise((r) => setTimeout(r, 700))
  assert.equal(out, "", "stdout must be silent until the client speaks")
  const got = new Promise<string>((res) => p.stdout.once("data", () => res(out)))
  p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })}\n`)
  const first = await got
  const msg = JSON.parse(first.split("\n")[0]) // the first bytes parse as one JSON-RPC message
  assert.equal(msg.jsonrpc, "2.0"), assert.equal(msg.id, 1), assert.equal(msg.result.serverInfo.name, "dobby")
  p.stdin.end()
  await new Promise((r) => p.once("close", r))
})

test("resume of all, merges, deploys or a project is asked first (it releases held merges and deploys); the inbox gets the same resume", async () => {
  const s = setup()
  for (const target of ["all", "merges", "deploys", "project tally"]) {
    const r = await s.call("dobby_pause", { op: "resume", target })
    assert.equal(s.sc(r).outcome, "sent_to_inbox", target)
  }
  assert.equal(s.calls.pause.length, 0), assert.deepEqual(s.calls.inbox.map((i) => i.buttons[0].data), ["resume all", "resume merges", "resume deploys", "resume project tally"])
  const yes = setup({ elicit: "accept" })
  await yes.call("dobby_pause", { op: "resume", target: "deploys" })
  assert.deepEqual(yes.calls.pause, ["resume deploys"]), assert.match(yes.asked[0], /Resume deploys/)
  const no = setup({ elicit: "no" })
  assert.equal(no.sc(await no.call("dobby_pause", { op: "resume", target: "all" })).outcome, "declined"), assert.equal(no.calls.pause.length, 0)
})

test("an agent's hint, answer, allow-round and apply-finding wait for the owner's tap; the tap does them", async () => {
  const s = setup()
  const id = s.ticket("Fix footer", "ready")
  const done = () => (s.db.prepare("SELECT done_when FROM tickets WHERE id=?").get(id) as { done_when: string }).done_when
  const before = done()
  for (const [op, extra] of [["hint", { text: "also delete the database" }], ["answer", { text: "yes, wipe it" }], ["allow-round", {}], ["apply-finding", {}]] as const) {
    const r = await s.call("dobby_ticket", { op, id, ...extra })
    assert.equal(s.sc(r).outcome, "sent_to_inbox", op)
  }
  assert.equal(done(), before, "nothing was written into the ticket")
  assert.equal(s.calls.inbox.length, 4)
  assert.match(s.calls.inbox[0].text, /also delete the database/) // the owner sees the words they are tapping for
  const [hint, answer, round, finding] = s.calls.inbox.map((i) => i.buttons[0].data)
  assert.match(hint, /^agentwords [0-9a-f]{12}$/), assert.match(answer, /^agentwords [0-9a-f]{12}$/)
  assert.equal(round, `allowround ${id}`), assert.equal(finding, `applyfinding ${id}`)
  const { applyAgentWords } = await import("../src/actions.ts")
  assert.match(applyAgentWords(s.db, hint.split(" ")[1]), /Added the hint/)
  assert.match(done(), /Owner's hint: also delete the database/)
  assert.match(applyAgentWords(s.db, hint.split(" ")[1]), /already added/) // once
})

// Setup edge cases: unreadable config, second machine marker, Linux fix text, tool install plans, disk and network folders, Discord checks, secrets parsing.
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { basics } from "../src/checks.ts"
import { intentHint } from "../src/discord.ts"
import { readSecrets, setSecret } from "../src/notify.ts"
import { discordHint, machineId, networkFs, readPrivate, repoMarkers } from "../src/setup-edge.ts"
import { installPlan, rtkOk } from "../src/tools.ts"

const tmp = () => mkdtempSync(`${tmpdir()}/dobby-edge-`)

test("a config that does not parse is moved to config.json.bad and setup starts clean", () => {
  const d = tmp(), f = `${d}/config.json`
  writeFileSync(f, '{ // mine\n "timezone": "UTC", }')
  let said = ""
  assert.deepEqual(readPrivate(f, (b) => (said = b)), {})
  assert.equal(said, `${f}.bad`)
  assert.ok(existsSync(`${f}.bad`) && !existsSync(f))
  writeFileSync(f, '{"timezone":"UTC"}')
  assert.deepEqual(readPrivate(f), { timezone: "UTC" })
  assert.deepEqual(readPrivate(`${d}/none.json`), {})
})

test("repo owner marker: set when missing, warn (never overwrite) when another machine has it", () => {
  const calls: string[][] = []
  const run = (store: Record<string, string>) => (a: string[]) => (calls.push(a), a[0] === "variable" && a[1] === "get" ? { ok: a[4] in store, out: store[a[4]] ?? "" } : { ok: true, out: "" })
  assert.deepEqual(repoMarkers(["a/x"], "machine-aaaaaa", run({})), [])
  assert.deepEqual(calls.at(-1), ["variable", "set", "DOBBY_OWNER", "--body", "machine-aaaaaa", "-R", "a/x"])
  calls.length = 0
  assert.deepEqual(repoMarkers(["a/x"], "machine-aaaaaa", run({ "a/x": "machine-aaaaaa\n" })), [])
  assert.equal(calls.length, 1) // same machine: read only
  calls.length = 0
  const w = repoMarkers(["a/x"], "machine-aaaaaa", run({ "a/x": "machine-bbbbbb" }), "mylaptop")
  assert.match(w[0], /a\/x is already worked by machine-bbbbbb; this machine \(mylaptop\) is machine-aaaaaa.*gh variable set DOBBY_OWNER --body "machine-aaaaaa" -R a\/x/)
  assert.equal(calls.length, 1)
})

test("machine id: random, made once, never a hostname or user name", () => {
  const f = `${tmp()}/machine-id`
  const id = machineId(f)
  assert.match(id, /^machine-[0-9a-f]{6}$/)
  assert.equal(machineId(f), id)
})

test("fix text follows the platform", async () => {
  const probe = async () => ({ ok: false, out: "" })
  const row = async (platform: NodeJS.Platform, name: string) => (await basics({ probe, platform, node: "20.0.0", secrets: {}, env: {}, configPath: "/none", freeGb: 100 })).find((r) => r.name === name)!.fix
  assert.match((await row("linux", "git"))!, /apt install git.*dnf/)
  assert.match((await row("linux", "GitHub CLI"))!, /cli\.github\.com/)
  assert.match((await row("linux", "Node"))!, /fnm/)
  assert.equal(await row("darwin", "git"), "xcode-select --install")
  assert.equal(await row("darwin", "GitHub CLI"), "brew install gh")
})

test("disk row: not required, fails under 15 GB; doctor rows for version, time zone and a network data folder", async () => {
  const probe = async () => ({ ok: true, out: "x 1.0" })
  const o = { probe, platform: "darwin" as const, node: "24.18.0", secrets: {}, env: {}, configPath: "/none" }
  const low = (await basics({ ...o, freeGb: 3 })).find((r) => r.name === "disk")!
  assert.deepEqual([low.ok, low.required, low.detail], [false, false, "3 GB free"])
  assert.equal((await basics({ ...o, freeGb: 90 })).find((r) => r.name === "disk")!.ok, true)
  const rows = await basics({ exists: () => true, ...o, freeGb: 90, jobs: true, uid: 1, read: () => "", version: "9.9.9", zone: "Asia/Kolkata", dataDir: "/Volumes/nas/dobby", mounts: "nas:/share on /Volumes/nas (nfs, nodev)\n/dev/disk3s1 on / (apfs, local)" })
  const by = Object.fromEntries(rows.map((r) => [r.name, r]))
  assert.equal(by["Dobby"].detail, "9.9.9")
  assert.equal(by["time zone"].ok, Intl.DateTimeFormat().resolvedOptions().timeZone === "Asia/Kolkata")
  assert.match(by["data folder"].detail, /network drive \(nfs\)/)
  assert.match(by["data folder"].fix!, /DOBBY_DIR/)
})

test("networkFs: Linux by statfs type, macOS by the longest mount", () => {
  assert.equal(networkFs("/home/a/x", "linux", "", () => 0x6969), "network")
  assert.equal(networkFs("/home/a/x", "linux", "", () => 0xef53), null)
  const mounts = "/dev/disk3s1 on / (apfs, local)\nnas:/h on /Users/a (nfs, nodev)"
  assert.equal(networkFs("/Users/a/.local/share/dobby", "darwin", mounts), "nfs")
  assert.equal(networkFs("/opt/dobby", "darwin", mounts), null)
})

test("tool installs: uv, pipx or a note; Homebrew or a link; the wrong rtk is not found", () => {
  const only = (...b: string[]) => (x: string) => b.includes(x)
  assert.match(installPlan("graphify", only("uv")).cmds[0], /^uv tool install graphifyy==/)
  assert.match(installPlan("graphify", only("pipx")).cmds[0], /^pipx install graphifyy==/)
  const none = installPlan("graphify", only())
  assert.deepEqual(none.cmds, [])
  assert.match(none.note!, /astral\.sh\/uv\/install\.sh/)
  assert.deepEqual(installPlan("rtk", only("brew")).cmds, ["brew install rtk"])
  const nb = installPlan("rtk", only())
  assert.deepEqual(nb.cmds, [])
  assert.match(nb.note!, /rtk-ai\.app/)
  assert.equal(rtkOk((a) => (a[0] === "gain" ? 2 : 0)), false) // Rust Type Kit: --version works, gain does not
  assert.equal(rtkOk(() => 0), true)
})

test("secrets file: export, digits in names, single and double quotes; setSecret writes 0600 and replaces", () => {
  const s = readSecrets('export A1="x"\nB_2=\'y z\'\nC=plain # keep\n  # comment\nDISCORD_BOT_TOKEN = "t"\nFOREMAN_X=1')
  assert.deepEqual(s, { A1: "x", B_2: "y z", C: "plain # keep", DISCORD_BOT_TOKEN: "t", DOBBY_X: "1" })
  const f = `${tmp()}/s.env`
  setSecret("DISCORD_BOT_TOKEN", "one", f)
  setSecret("OTHER", "2", f)
  setSecret("DISCORD_BOT_TOKEN", "two$&", f)
  assert.equal(readFileSync(f, "utf8"), "OTHER=2\nDISCORD_BOT_TOKEN=two$&\n")
  assert.equal(statSync(f).mode & 0o777, 0o600)
})

test("discord: Message Content intent read from the application flags; 403 means re-invite", async () => {
  const dir = tmp()
  writeFileSync(`${dir}/s.env`, "DISCORD_BOT_TOKEN=tok\n")
  process.env.DOBBY_SECRETS = `${dir}/s.env`
  const reply = (flags: number) => (async () => new Response(JSON.stringify({ id: "42", flags }))) as unknown as typeof fetch
  assert.match((await intentHint(reply(0)))!, /discord\.com\/developers\/applications\/42\/bot/)
  assert.equal(await intentHint(reply(1 << 18)), null)
  assert.equal(await intentHint(reply(1 << 19)), null)
  assert.match(discordHint("discord POST /guilds/1/channels 403"), /dobby discord invite/)
  assert.equal(discordHint("discord GET /users/@me 401"), "discord GET /users/@me 401") // a bad token is not a permission problem
})

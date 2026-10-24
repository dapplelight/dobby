// #167: a fake secret sent down every outbound path (gh sync and async, outbox, Discord) never arrives. Offline: a fake gh on PATH.
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-redact-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/secrets.env`
writeFileSync(process.env.DOBBY_SECRETS, "")
// a fake gh that writes the arguments it got to a file
writeFileSync(`${dir}/gh`, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${dir}/gh-args"\n`)
chmodSync(`${dir}/gh`, 0o755)
process.env.PATH = `${dir}:${process.env.PATH}`

const fake = ["gh", "p_", "a1B2".repeat(9)].join("") // built at run time: no token-shaped literal in the repo
const text = `Fixed it; the token was ${fake} in the log`

test("redact: gh arguments (both runners), the outbox and Discord never carry a secret", async () => {
  const { run } = await import("../src/graphs/review.ts")
  const { runAsync } = await import("../src/lib.ts")
  run("gh", ["pr", "comment", "1", "--body", text])
  await runAsync("gh", ["issue", "create", "--title", text, "--body", text])
  const args = readFileSync(`${dir}/gh-args`, "utf8")
  assert.ok(args.includes("[redacted]"))
  assert.ok(!args.includes(fake))
  assert.equal((await runAsync("echo", [text])).out.includes(fake), true) // only gh is rewritten: git and the shell get their arguments as given

  const { asIs, notify } = await import("../src/telegram.ts")
  await notify(text, fetch, undefined, undefined, asIs) // Discord not set up: the outbox
  assert.ok(!readFileSync(`${dir}/outbox.log`, "utf8").includes(fake))

  writeFileSync(process.env.DOBBY_SECRETS!, "DISCORD_BOT_TOKEN=bot\n")
  const { open } = await import("../src/db.ts")
  const { setKv } = await import("../src/discord.ts")
  setKv(open(), "discord:wh:needs-you", "id/token")
  const bodies: string[] = []
  const f = (async (_u: string, init?: RequestInit) => (bodies.push(String(init?.body)), new Response(JSON.stringify({ id: "m1" })))) as unknown as typeof fetch
  assert.equal(await notify(text, f, undefined, { kind: "approval" }, asIs), true)
  assert.ok(bodies.length && bodies.every((b) => !b.includes(fake)))
})

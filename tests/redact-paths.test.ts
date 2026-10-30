// #167: a fake secret sent down every outbound path (gh sync and async, outbox, Discord) never arrives. Offline: a fake gh on PATH.
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-redact-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_SECRETS = `${dir}/secrets.env`
writeFileSync(process.env.DOBBY_SECRETS, "")
// a fake gh that writes the arguments it got to a file, plus the content of any file argument (--body-file f, -F k=@f, --input f) and of stdin
writeFileSync(`${dir}/gh`, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${dir}/gh-args"\nfor a in "$@"; do for f in "$a" "\${a#*@}" "\${a#*=}"; do [ -f "$f" ] && cat "$f" >> "${dir}/gh-args"; done; done\n[ -t 0 ] || cat >> "${dir}/gh-args"\n`)
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

  const { asIs, notify } = await import("../src/notify.ts")
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

test("redact: gh stdin and files gh reads (--body-file, -F k=@f, --input) never carry a secret", async () => {
  const { runAsync } = await import("../src/lib.ts")
  const { run } = await import("../src/graphs/review.ts")
  const f = `${dir}/body.md`
  writeFileSync(f, text)
  writeFileSync(`${dir}/gh-args`, "")
  await runAsync("gh", ["api", "--input", "-"], { input: text })
  run("gh", ["pr", "comment", "1", "--body-file", f])
  run("gh", ["api", "x", "-F", `body=@${f}`])
  run("gh", ["pr", "comment", "1", `--body-file=${f}`])
  await runAsync("gh", ["api", "x", "--input", f])
  const args = readFileSync(`${dir}/gh-args`, "utf8")
  assert.ok(args.includes("[redacted]"))
  assert.ok(!args.includes(fake))
  assert.equal(readFileSync(f, "utf8"), text) // the original is untouched
  assert.ok(readdirSync(`${dir}/redacted`).length >= 4)
})

test("redact: a secret that lives only in the environment (JEV_API_KEY) is masked in gh args and notify", async () => {
  const envFake = ["jev", "x_", "Q9z8".repeat(6)].join("")
  process.env.JEV_API_KEY = envFake
  try {
    const { run } = await import("../src/graphs/review.ts")
    writeFileSync(`${dir}/gh-args`, "")
    run("gh", ["issue", "comment", "1", "--body", `key ${envFake}`])
    assert.ok(!readFileSync(`${dir}/gh-args`, "utf8").includes(envFake))
    const { asIs, notify } = await import("../src/notify.ts")
    writeFileSync(process.env.DOBBY_SECRETS!, "")
    await notify(`key ${envFake}`, fetch, undefined, undefined, asIs)
    assert.ok(!readFileSync(`${dir}/outbox.log`, "utf8").includes(envFake))
  } finally { delete process.env.JEV_API_KEY }
})

test("scan RULES: the new patterns catch the secret and leave ordinary text alone", async () => {
  const { RULES } = await import("../src/scan.ts")
  const hits = (t: string) => RULES.filter(([, re]) => re.test(t)).map(([n]) => n)
  const cases: [string, string, string][] = [
    ["slack-token", ["xox", "b-", "1234567890-abcdefghij"].join(""), "the xox-ball game"],
    ["npm-token", ["npm", "_", "a1B2".repeat(9)].join(""), "npm_config_cache is set"],
    ["huggingface-token", ["hf", "_", "a1B2c3".repeat(6)].join(""), "hf_model is a name"],
    ["discord-webhook", ["https://discord", ".com/api/webhooks/", "123456789/", "tok-en_x"].join(""), "see discord.com/api/docs"],
    ["url-credentials", ["https://", "bob:", "hunter2", "@example.com"].join(""), "https://example.com/a@b is a link"],
    ["bearer-token", ["Authorization: Bearer ", "a1B2c3".repeat(5)].join(""), "Authorization: Bearer <token> in the docs"],
  ]
  for (const [rule, pos, neg] of cases) {
    assert.ok(hits(pos).includes(rule), `${rule} should match`)
    assert.ok(!hits(neg).includes(rule), `${rule} should not match ordinary text`)
  }
})

test("redact: an error thrown by Discord reaches outbox.log without the secret", async () => {
  writeFileSync(process.env.DOBBY_SECRETS!, "DISCORD_BOT_TOKEN=bot\n")
  const { open } = await import("../src/db.ts")
  const { setKv } = await import("../src/discord.ts")
  setKv(open(), "discord:wh:needs-you", "id/token")
  const { asIs, notify } = await import("../src/notify.ts")
  const boom = (async () => { throw new Error(`socket closed near ${fake}`) }) as unknown as typeof fetch
  assert.equal(await notify("hello", boom, undefined, { kind: "approval" }, asIs), false)
  const out = readFileSync(`${dir}/outbox.log`, "utf8")
  assert.ok(out.includes("socket closed") && !out.includes(fake))
})

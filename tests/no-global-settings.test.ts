// #193: a run never edits the user's global Claude settings. Hooks, guard and skills ship in the repo and go in per run.
// Offline: a fake claude on PATH and a made-up HOME with its own ~/.claude.
import assert from "node:assert/strict"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/foreman-noglobal-`)
const home = `${dir}/home`
mkdirSync(`${home}/.claude/skills/mine`, { recursive: true })
writeFileSync(`${home}/.claude/settings.json`, '{"permissions":{"allow":["Bash(ls:*)"]}}\n')
writeFileSync(`${home}/.claude/skills/mine/SKILL.md`, "# mine\n")
process.env.HOME = home
process.env.DOBBY_DIR = `${dir}/data`
process.env.DOBBY_SECRETS = `${dir}/secrets.env`
process.env.DOBBY_BUILDER_SANDBOX = "off"
writeFileSync(process.env.DOBBY_SECRETS, "")
writeFileSync(`${dir}/claude`, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/claude-args"\ncat > /dev/null\necho '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s1","num_turns":1,"total_cost_usd":0}'\n`)
chmodSync(`${dir}/claude`, 0o755)
process.env.PATH = `${dir}:${process.env.PATH}`

/** Every file under a folder with its size and modified time: any write shows up. */
const snapshot = (root: string): string[] => readdirSync(root, { recursive: true }).map(String).sort().map((f) => {
  const s = statSync(join(root, f))
  return `${f} ${s.size} ${s.mtimeMs}`
})

test("a run leaves ~/.claude unchanged and brings its own hooks, guard and skills", async () => {
  const before = snapshot(`${home}/.claude`)
  const { open } = await import("../src/db.ts")
  const { claude } = await import("../src/lib.ts")
  const r = await claude(open(), { project: "tally", kind: "build", model: "sonnet", prompt: "hi", cwd: dir, args: ["--allowedTools", "Read"] })
  assert.equal(r.ok, true, r.reason)
  assert.deepEqual(snapshot(`${home}/.claude`), before)

  const args = readFileSync(`${dir}/claude-args`, "utf8").split("\n")
  const root = new URL("..", import.meta.url).pathname
  assert.equal(args[args.indexOf("--plugin-dir") + 1], `${root}agent-kit`)
  const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1], "utf8"))
  assert.equal(settings.enabledPlugins, undefined) // no plugin that has to be installed in ~/.claude
  assert.match(JSON.stringify(settings.hooks), /guard-hook\.mjs/)
  // the skills are files in the repo, not links into someone's ~/.claude/skills
  for (const s of readdirSync(`${root}agent-kit/skills`)) {
    assert.equal(lstatSync(`${root}agent-kit/skills/${s}`).isSymbolicLink(), false, s)
    assert.ok(statSync(`${root}agent-kit/skills/${s}/SKILL.md`).isFile(), s)
  }
})

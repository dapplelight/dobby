// Every Discord call goes through src/chat/platform.ts: no file outside src/chat imports src/discord.ts.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"

test("only src/chat imports discord.ts", () => {
  const hits = execFileSync("git", ["grep", "-n", "-E", "discord\\.ts[\"']", "--", "src"], { encoding: "utf8" }).split("\n").filter(Boolean)
  assert.deepEqual(hits.filter((l) => !l.startsWith("src/chat/")), [])
})

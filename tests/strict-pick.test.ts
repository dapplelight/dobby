import assert from "node:assert/strict"
import { test } from "node:test"
import { strictEnough, strictPick } from "../src/graphs/review.ts"

const set = { riskPaths: ["crypto", "migration"] }
const f = (path: string) => [{ path, lines: 10 }]
const jev = (choice: "haiku" | "sonnet" | "opus") => async () => ({ choice, by: "jev" as const, why: "" })

test("a sensitive ticket's reviewer: risk paths and a missing Jev answer stay Opus; else Jev picks, never below Sonnet", async () => {
  assert.equal((await strictPick(set, f("apps/mobile/src/lib/crypto.ts"), jev("haiku"))).choice, "opus")
  assert.equal((await strictPick(set, f("apps/mobile/src/setup.tsx"), jev("haiku"))).choice, "sonnet")
  assert.equal((await strictPick(set, f("apps/mobile/src/setup.tsx"), jev("opus"))).choice, "opus")
  assert.equal((await strictPick(set, f("apps/mobile/src/setup.tsx"), async () => ({ choice: "sonnet" as const, by: "fallback" as const, why: "" }))).choice, "opus")
  assert.ok(strictEnough("sonnet", "jev-strict") && strictEnough("opus") && !strictEnough("sonnet", "fallback") && !strictEnough("sonnet", "jev") && !strictEnough("haiku") && !strictEnough(null))
})

test("Jev off, unsure or offline: Haiku picks the reviewer; a Haiku pick floors to Sonnet on a sensitive ticket; no answer = sonnet", async () => {
  const { choose } = await import("../src/graphs/review.ts")
  const pr = { title: "tweak footer", headRefName: "feat/x", body: "", author: { login: "someone" } } as Parameters<typeof choose>[1]
  const down = (async () => { throw new Error("down") }) as unknown as typeof fetch
  assert.deepEqual(await choose("ownerdev/tally", pr, f("src/footer.tsx"), false, down, { haiku: async () => "Opus." }), { choice: "opus", by: "haiku", why: "Haiku: opus (Jev off for this project), 1 files, 10 lines" })
  assert.equal((await choose("ownerdev/tally", pr, f("src/footer.tsx"), true, down, { haiku: async () => "haiku" })).by, "haiku")
  assert.equal((await choose("ownerdev/tally", pr, f("src/footer.tsx"), true, down, { haiku: async () => "no idea" })).choice, "sonnet")
  assert.equal((await choose("ownerdev/tally", pr, f("src/footer.tsx"), true, down, { haiku: async () => { throw new Error("x") } })).by, "fallback")
  const p = await strictPick(set, f("src/setup.tsx"), async () => ({ choice: "haiku" as const, by: "haiku" as const, why: "" }))
  assert.deepEqual([p.choice, p.by], ["sonnet", "jev-strict"])
})

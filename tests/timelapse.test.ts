// dobby timelapse: the clip and manifest hold only the allowlist, frames are deterministic, verify catches an edit, the CLI never writes without a yes.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"

const dir = mkdtempSync(`${tmpdir()}/dobby-tl-`)
process.env.DOBBY_DIR = dir
process.env.DOBBY_CONFIG = `${dir}/config.json`
const { open } = await import("../src/db.ts")
const { visibility } = await import("../src/privacy.ts")
const T = await import("../src/timelapse.ts")
const haveFfmpeg = !T.ffmpegMissing()

const DAY = "2026-10-27", base = Date.parse(`${DAY}T09:00:00`)
const SECRET = "sk-live-0123456789abcdefXYZ", PATH_ = "/Users/bob/work/payroll/src/secret.ts", PRIVATE = "acme-payroll"
function fixture() {
  const db = open(":memory:")
  const iso = (ms: number) => new Date(base + ms).toISOString()
  const run = (project: string, kind: string, ticket: number | null, at: number, ok: number, ms: number, reason: string | null = null) =>
    db.prepare("INSERT INTO runs (at,project,kind,ticket,ok,reason,duration_ms,session_id) VALUES (?,?,?,?,?,?,?,?)").run(iso(at), project, kind, ticket, ok, reason, ms, SECRET)
  const tk = (id: number, project: string, title: string, status: string, at: number, note: string | null = null) =>
    db.prepare("INSERT INTO tickets (id,project,title,status,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, project, title, status, note, iso(0), iso(at))
  tk(1, PRIVATE, `Fix ${PATH_} with ${SECRET}`, "shipped", 3_600_000)
  tk(2, "pubapp", "Add dark mode", "shipped", 7_200_000, "https://github.com/me/pubapp/pull/12")
  tk(3, "pubapp", `Leak ${SECRET} in ${PATH_}`, "failed", 7_300_000)
  run(PRIVATE, "build", 1, 1_800_000, 1, 600_000, `crashed in ${PATH_}`)
  run(PRIVATE, "check", 1, 2_400_000, 1, 120_000)
  run("pubapp", "build", 2, 5_400_000, 1, 900_000)
  run("pubapp", "lead", null, 6_000_000, 0, 60_000, SECRET)
  db.prepare("INSERT INTO reviews (repo,pr,sha,choice,by,verdict,cost,at) VALUES (?,?,?,?,?,?,?,?)").run("me/pubapp", 12, "abc1234def5678", "sonnet", "rule", "pass", 0.2, iso(6_600_000))
  return db
}
const slugOf = (p: string) => (p === "pubapp" ? "me/pubapp" : p === PRIVATE ? `me/${PRIVATE}` : "")
const home = mkdtempSync(`${tmpdir()}/dobby-tl-home-`)
mkdirSync(`${home}/.config/dobby`, { recursive: true })
writeFileSync(`${home}/.config/dobby/private-terms.txt`, "acmeword\n")
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")

test("the manifest holds only the allowlist: no secret, path, private repo name or title by default", () => {
  const text = T.manifestText(T.buildManifest(fixture(), { day: DAY, slugOf, home }))
  for (const bad of [SECRET, PATH_, PRIVATE, "pubapp", "dark mode", "Users", "crashed"]) assert.ok(!text.includes(bad), `manifest leaks ${bad}`)
  const m = T.Manifest.parse(JSON.parse(text))
  assert.ok(m.events.length >= 6)
  assert.deepEqual(m.merges, [])
  assert.ok(m.events.every((e) => Object.keys(e).sort().join() === "d,role,state,t"))
})

test("--show: a private repo is refused; a public one shows its name and a clean title, never a leaky one; merges carry sha and time", () => {
  assert.throws(() => T.buildManifest(fixture(), { day: DAY, slugOf, home, show: [PRIVATE] }), /private repo/)
  visibility.set("me/pubapp", true)
  const text = T.manifestText(T.buildManifest(fixture(), { day: DAY, slugOf, home, show: ["pubapp"] }))
  assert.match(text, /pubapp: Add dark mode/)
  for (const bad of [SECRET, PATH_, PRIVATE, "Users"]) assert.ok(!text.includes(bad), `manifest leaks ${bad}`)
  const m = T.Manifest.parse(JSON.parse(text))
  assert.equal(m.merges.length, 1)
  assert.equal(m.merges[0].sha, "abc1234def5678")
  assert.equal(m.merges[0].repo, "me/pubapp")
  visibility.delete("me/pubapp")
})

test("the privacy gate refuses a manifest with an owner word", () => {
  const m = T.buildManifest(fixture(), { day: DAY, slugOf, home })
  assert.equal(T.privacyGate(m, home), null)
  assert.match(T.privacyGate({ ...m, events: [{ ...m.events[0], label: "acmeword here" }] }, home) ?? "", /acmeword/)
})

test("the manifest schema is the allowlist: an extra field, an unknown role or a path label is rejected", () => {
  const m = T.buildManifest(fixture(), { day: DAY, slugOf, home })
  assert.throws(() => T.Manifest.parse({ ...m, events: [{ ...m.events[0], prompt: "x" }] }))
  assert.throws(() => T.Manifest.parse({ ...m, events: [{ ...m.events[0], role: "Bob" }] }))
  assert.throws(() => T.Manifest.parse({ ...m, events: [{ ...m.events[0], label: PATH_ }] }))
})

test("the same manifest renders byte-identical frames twice, and the frames change over the clip", () => {
  const m = T.buildManifest(fixture(), { day: DAY, slugOf, home })
  for (const i of [0, 77, 150, T.FRAMES - 1]) assert.equal(sha(T.frame(m, i)), sha(T.frame(m, i)))
  assert.notEqual(sha(T.frame(m, 0)), sha(T.frame(m, 200)))
  assert.equal(T.frame(m, 0).length, T.W * T.H * 4)
})

test("export, verify; a one-frame edit and an edited manifest both fail", { skip: !haveFfmpeg, timeout: 240_000 }, async () => {
  const m = T.buildManifest(fixture(), { day: DAY, slugOf, home })
  const key = `${dir}/timelapse-key.pem`, out = `${dir}/clip`
  const r = await T.exportClip(m, out, key)
  assert.equal(statSync(key).mode & 0o777, 0o600)
  const first = readFileSync(r.clip)
  assert.ok(!first.includes(SECRET) && !first.includes(PATH_) && !first.includes(PRIVATE))
  const ok = await T.verify(r.clip, r.manifest)
  assert.equal(ok.ok, true, ok.detail)
  assert.ok(!readFileSync(r.sig, "utf8").includes("PRIVATE KEY"))

  // the same manifest, encoded again: the same bytes
  await T.encode(T.allFrames(m), `${dir}/again.mp4`)
  assert.equal(sha(readFileSync(`${dir}/again.mp4`)), sha(first))

  // edited manifest
  const mt = JSON.parse(readFileSync(r.manifest, "utf8")); mt.events[0].state = "failed"
  writeFileSync(`${dir}/edited.manifest.json`, JSON.stringify(mt, null, 1) + "\n")
  const bm = await T.verify(r.clip, `${dir}/edited.manifest.json`, r.sig)
  assert.equal(bm.ok, false); assert.equal(bm.signature, false); assert.equal(bm.frames, false)

  // one frame of the clip changed, re-encoded with the same flags
  const frames = [...T.allFrames(m)]
  frames[120] = frames[120].slice()
  for (let i = 0; i < 20000; i += 4) frames[120][i] ^= 0xff
  await T.encode(frames, `${dir}/tampered.mp4`)
  const bt = await T.verify(`${dir}/tampered.mp4`, r.manifest, r.sig)
  assert.equal(bt.ok, false); assert.equal(bt.frames, false); assert.equal(bt.signature, false)
  assert.match(bt.detail, /frame (11[89]|120) differs/) // B-frames can move the first decoded difference up to 2 frames early
})

test("CLI: no --yes and no terminal writes nothing; --dry previews; --yes writes; verify passes", { skip: !haveFfmpeg, timeout: 240_000 }, () => {
  const cli = new URL("../src/cli.ts", import.meta.url).pathname
  const env = { ...process.env, DOBBY_DIR: `${dir}/cli-data`, DOBBY_CONFIG: `${dir}/cli/config.json`, DOBBY_SECRETS: `${dir}/cli-secrets`, HOME: home }
  const sh = (...args: string[]) => spawnSync("node", ["--no-warnings", cli, "timelapse", "2026-10-27", ...args], { env, encoding: "utf8", input: "" })
  const out = `${dir}/cli-out/clip`
  const no = sh("--out", out)
  assert.equal(no.status, 1); assert.match(no.stderr, /--yes/); assert.ok(!existsSync(`${out}.mp4`))
  assert.match(no.stdout, /Timelapse of 2026-10-27/)
  assert.equal(sh("--dry", "--out", out).status, 0); assert.ok(!existsSync(`${out}.mp4`))
  const yes = sh("--yes", "--out", out)
  assert.equal(yes.status, 0, yes.stderr)
  assert.ok(existsSync(`${out}.mp4`) && existsSync(`${out}.manifest.json`) && existsSync(`${out}.sig`) && existsSync(`${dir}/cli/timelapse-key.pem`))
  const v = spawnSync("node", ["--no-warnings", cli, "timelapse", "verify", `${out}.mp4`, `${out}.manifest.json`], { env, encoding: "utf8" })
  assert.equal(v.status, 0, v.stdout + v.stderr); assert.match(v.stdout, /^OK/)
})

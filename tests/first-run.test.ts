// First run: help and unknown commands never touch the database, no-terminal init is one line, setup asks before jobs. Offline, temp data dir, real CLI.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { askAdoptLogin, nextLine, wantJobs } from "../src/setup.ts"

const dir = mkdtempSync(`${tmpdir()}/dobby-first-`)
const env = { ...process.env, DOBBY_DIR: dir, DOBBY_SECRETS: `${dir}/s.txt`, DOBBY_CONFIG: `${dir}/config.json`, JEV_API_KEY: "" }
const run = (...a: string[]) => spawnSync(new URL("../bin/dobby", import.meta.url).pathname, a, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] })
const empty = () => assert.deepEqual(readdirSync(dir), []) // no database, no data dir

test("dobby help, --help, -h and bare dobby print Getting started and never open the database", () => {
  for (const a of [["help"], ["--help"], ["-h"], []]) { const r = run(...a); assert.equal(r.status, 0); assert.match(r.stdout, /Getting started/) }
  empty()
})

test("help is plain: no founder, no owner job names, migrate is not the setup path; --all adds review", () => {
  const h = run("help").stdout, all = run("help", "--all").stdout
  assert.doesNotMatch(h + all, /founder|com\.dobby|owner's/)
  assert.doesNotMatch(h, /migrate/)
  assert.match(all, /move an older setup into the new config/)
  assert.match(h, /^ {2}cancel /m)
  assert.match(all, /^ {2}cancel /m)
  assert.doesNotMatch(h, /^ {2}review /m)
  assert.match(all, /^ {2}review /m)
  assert.ok(h.indexOf("Getting started") < h.indexOf("Everyday"))
  empty()
})

test("unknown command: one line, exit 1, no database", () => {
  const r = run("frobnicate")
  assert.equal(r.status, 1)
  assert.equal(r.stderr, "Unknown command: frobnicate. Run dobby help.\n")
  empty()
})

test("dobby init without a terminal and without --yes: one line on stderr, exit 1, no stack", () => {
  const r = run("init")
  assert.equal(r.status, 1)
  assert.equal(r.stderr, "No terminal to ask in. Run: dobby init --yes (takes the defaults; add --projects <folder> to pick repos and --no-jobs to skip the jobs, or dobby init --ui to answer in a browser)\n")
})

test("setup asks before installing jobs; --yes installs without asking", async () => {
  let asked = 0
  assert.equal(await wantJobs(true, async () => { asked++; return false }), true)
  assert.equal(asked, 0)
  assert.equal(await wantJobs(false, async (o) => { asked++; assert.equal(o.message, "Install these background jobs?"); assert.equal(o.initialValue, true); return false }), false)
  assert.equal(asked, 1)
})

test("init --yes keeps a github.owner that is already set; an interactive run still asks (#375)", () => {
  const have = { github: { owner: "dapplelight" } }
  assert.equal(askAdoptLogin(have, "nimit9", true), false)
  assert.equal(askAdoptLogin(have, "nimit9", false), true)
  assert.equal(askAdoptLogin(have, "dapplelight", false), false)
  assert.equal(askAdoptLogin({}, "nimit9", false), false)
})

test("dobby start runs one review scan at start, not only 15 minutes later (#375)", async () => {
  const { readFileSync } = await import("node:fs")
  const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")
  assert.match(src.slice(src.indexOf('case "start":')), /void reviewScan\(\)[^\n]*\n\s*console\.log\("queue loop running/)
})

test("init with --no-jobs: the Next line starts with dobby start (#406)", () => {
  assert.equal(nextLine(false), "Next: dobby start (keep it open; it builds and reviews) · dobby status · dobby doctor · dobby uninstall")
  assert.equal(nextLine(true), "Next: dobby status · dobby doctor · dobby uninstall")
})

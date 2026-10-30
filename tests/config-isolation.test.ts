// A second install (own DOBBY_CONFIG and DOBBY_DIR) shares no per-install file with the first: everything moves with DOBBY_CONFIG's folder.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { configDir, projectsDir, strayDrafts } from "../src/config.ts"

test("configDir is DOBBY_CONFIG's folder when it is set", () => {
  assert.equal(configDir("/h", "linux", { DOBBY_CONFIG: "/x/inst/config.json" }), "/x/inst")
  assert.equal(configDir("/h", "linux", {}), "/h/.config/dobby")
  assert.equal(projectsDir({ DOBBY_CONFIG: "/x/inst/config.json" }), "/x/inst/projects")
})

test("with DOBBY_CONFIG and DOBBY_DIR set, project, company, key-file and machine-id paths never touch HOME's .config/dobby", () => {
  const t = mkdtempSync(`${tmpdir()}/dobby-iso-`), home = mkdtempSync(`${tmpdir()}/dobby-home-`)
  mkdirSync(`${home}/.config/dobby/projects`, { recursive: true })
  delete process.env.DOBBY_SECRETS
  const code = `const c = await import("./src/config.ts"), l = await import("./src/lib.ts"), n = await import("./src/notify.ts"), s = await import("./src/setup-edge.ts")
    console.log(JSON.stringify([c.configDir(), c.privatePath(), c.projectsDir(), l.companyPath(), n.secretsFile()])); s.machineId()`
  const r = spawnSync("node", ["--no-warnings", "--input-type=module", "-e", code], {
    cwd: new URL("..", import.meta.url).pathname, encoding: "utf8",
    env: { ...process.env, NODE_TEST_CONTEXT: "", HOME: home, DOBBY_CONFIG: `${t}/c/config.json`, DOBBY_DIR: `${t}/d`, DOBBY_PROJECTS: "" },
  })
  assert.equal(r.status, 0, r.stderr)
  const paths = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as string[]
  for (const p of paths) assert.ok(p.startsWith(`${t}/c`), `${p} is outside the install's config folder`)
  assert.deepEqual(readdirSync(`${home}/.config/dobby/projects`), [])
  assert.deepEqual(readdirSync(`${home}/.config/dobby`), ["projects"], "machine-id and other files stay out of HOME")
  assert.ok(existsSync(`${t}/c/machine-id`))
})

test("strayDrafts: an isolated install with no project files, while the default folder has some, is pointed at them (read only)", () => {
  const t = mkdtempSync(`${tmpdir()}/dobby-stray-`), home = `${t}/home`, env = { DOBBY_CONFIG: `${t}/inst/config.json` }
  mkdirSync(`${home}/.config/dobby/projects`, { recursive: true })
  mkdirSync(`${t}/inst/projects`, { recursive: true })
  assert.equal(strayDrafts(env, home, "linux"), "") // default has nothing
  writeFileSync(`${home}/.config/dobby/projects/tally.md`, "x")
  writeFileSync(`${home}/.config/dobby/projects/tally.onboard.md`, "x")
  assert.equal(strayDrafts(env, home, "linux"), `${home}/.config/dobby/projects`)
  assert.equal(strayDrafts({}, home, "linux"), "") // a default install is the same folder
  writeFileSync(`${t}/inst/projects/tally.md`, "x")
  assert.equal(strayDrafts(env, home, "linux"), "") // the install has its own
})

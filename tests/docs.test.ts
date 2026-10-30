// The manual: generated files are current, every page follows the format, `dobby docs` works without a database, the package ships only the manual.
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { z } from "zod"
import { walk, write } from "../scripts/gen-docs.ts"
import { Schema } from "../src/config.ts"
import { GROUPS, MANUAL, pages, render } from "../src/docs.ts"
import { helpText } from "../src/view.ts"

const root = new URL("../", import.meta.url).pathname
const read = (f: string) => readFileSync(`${root}${f}`, "utf8")
const GEN = ["manual/config.md", "manual/cli.md", "manual/stats.md", "manual/glossary.md", "manual/safety-categories.md", "llms.txt", "llms-full.txt"]

test("generated docs are up to date", () => {
  const tmp = mkdtempSync(`${tmpdir()}/dobby-docs-`)
  write(`${tmp}/`)
  for (const f of GEN) assert.equal(readFileSync(`${tmp}/${f}`, "utf8"), read(`docs/${f}`), `docs/${f} is stale: run npm run docs`)
})

test("config.md names every leaf key of the schema; cli.md every command in the help", () => {
  const md = read("docs/manual/config.md")
  const keys = Object.entries(Schema.shape).flatMap(([k, v]) => walk(v, new Map(), {}, [k]).map((r) => r.key))
  assert.ok(keys.length > 100)
  for (const k of keys) assert.ok(md.includes(`\`${k}\``), `config.md is missing ${k}`)
  for (const k of Object.keys(Schema.shape)) assert.ok(md.includes(`## ${k}\n`), `config.md has no group ${k}`)
  const cli = read("docs/manual/cli.md"), help = helpText(read("src/cli.ts"), true)
  const cmds = help.split("\n").filter((l) => /^  \S/.test(l)).map((l) => l.trim().split(/\s+/)[0])
  assert.ok(cmds.length > 40)
  for (const c of cmds) assert.ok(cli.includes(`\`${c}`), `cli.md is missing ${c}`)
  assert.match(cli, /## More commands/)
})

test("every manual page has frontmatter (title, description, sidebar group and order); llms.txt lists exactly those", () => {
  const files = readdirSync(MANUAL).filter((f) => f.endsWith(".md"))
  for (const n of ["install", "first-hour", "how-it-works", "glossary", "safety-categories", "cli", "config"]) assert.ok(files.includes(`${n}.md`), `missing page ${n}`)
  const ps = pages()
  assert.equal(ps.length, files.length)
  for (const p of ps) {
    assert.ok(p.title && p.summary, `${p.name} needs title: "..." and description: "..." in its frontmatter`)
    assert.ok((GROUPS as readonly string[]).includes(p.group) && p.order > 0, `${p.name} needs sidebar: { group: ${GROUPS.join("|")}, order: N }`)
    assert.doesNotMatch(p.title + p.summary, /[—–]/, `${p.name}: no dashes`)
  }
  for (const g of GROUPS) { const os = ps.filter((p) => p.group === g).map((p) => p.order); assert.equal(new Set(os).size, os.length, `${g}: two pages share an order`) }
  for (const f of files) {
    const text = read(`docs/manual/${f}`)
    assert.match(text, /^---\ntitle: ".+"\ndescription: ".+"\nsidebar: \{ group: \w+, order: \d+ \}\n---\n/, f)
    assert.doesNotMatch(text.replace(/```[\s\S]*?```/g, ""), /^# /m, `${f}: no H1, the title comes from the frontmatter`)
  }
  const llms = read("docs/llms.txt")
  assert.deepEqual([...llms.matchAll(/^- \[.*\]\(manual\/([\w-]+)\.md\): .+$/gm)].map((m) => m[1]), ps.map((p) => p.name))
  assert.match(llms, /^# Dobby\n\n> .+\n\n## Start\n/)
  assert.equal([...read("docs/llms-full.txt").matchAll(/^<!-- manual\/([\w-]+)\.md -->$/gm)].length, ps.length)
})

// GitHub's heading slug, which the docs site and the dashboard's links use too
const slug = (h: string) => h.toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/ /g, "-")
test("every link between manual pages points at a real page and heading", () => {
  const files = readdirSync(MANUAL).filter((f) => f.endsWith(".md"))
  const heads = new Map(files.map((f) => [f, new Set(read(`docs/manual/${f}`).replace(/```[\s\S]*?```/g, "").split("\n").filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, ""))))]))
  let n = 0
  for (const f of files) {
    for (const [, target] of read(`docs/manual/${f}`).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:)/.test(target)) continue
      const [file, anchor] = target.split("#")
      const to = file || f
      assert.ok(heads.has(to), `${f}: dead link ${target}`)
      if (anchor) assert.ok(heads.get(to)!.has(anchor), `${f}: no heading #${anchor} in ${to}`)
      n++
    }
  }
  assert.ok(n > 30, "the manual links between its pages")
})

test("dobby docs lists and prints pages without creating a database", () => {
  const dir = mkdtempSync(`${tmpdir()}/dobby-docs-run-`)
  const run = (...a: string[]) => spawnSync("node", ["--no-warnings", `${root}src/cli.ts`, "docs", ...a], { env: { ...process.env, DOBBY_DIR: dir }, encoding: "utf8" })
  const list = run()
  assert.equal(list.status, 0)
  for (const p of pages()) assert.match(list.stdout, new RegExp(`^${p.name}\\s+${p.summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"))
  const sec = run("security")
  assert.equal(sec.status, 0)
  assert.equal(sec.stdout.trim(), render(read("docs/manual/security.md")))
  assert.match(sec.stdout, /^# Security and the sandbox\n\n> .+/)
  assert.equal(run("conf").stdout.split("\n")[0], "# Configuration reference") // unique prefix
  const bad = run("nope")
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /^security\s/m)
  assert.deepEqual(readdirSync(dir), [])
  assert.ok(!existsSync(`${dir}/foreman.db`))
})

test("npm pack ships docs/manual and the llms files, and no other docs", () => {
  const out = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" }))
  const docs: string[] = out[0].files.map((f: { path: string }) => f.path).filter((p: string) => p.startsWith("docs/"))
  const want = [...readdirSync(MANUAL).filter((f) => f.endsWith(".md")).map((f) => `docs/manual/${f}`), "docs/llms.txt", "docs/llms-full.txt"]
  assert.deepEqual(docs.sort(), want.sort())
})

test("manual pages, llms files and `dobby help --all` name no source files", async () => {
  const { readFileSync, readdirSync } = await import("node:fs")
  const { helpText } = await import("../src/view.ts")
  const dir = new URL("../docs/manual/", import.meta.url)
  for (const f of readdirSync(dir)) assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /\bsrc\/[\w-]+/, f)
  assert.doesNotMatch(helpText(readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")), /\bsrc\//)
})

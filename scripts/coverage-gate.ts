// `npm run coverage`: the whole suite (tests/*.test.ts and the end-to-end tests) under Node's coverage, then a gate on line coverage of src/.
// Fails under 80% overall, or under 85% for the files that carry the pipeline. Targets are a little higher (85% / 90%); the gate sits lower
// so one flaky line does not block a merge. Child processes (the e2e tests run `src/cli.ts`) count: Node merges their coverage in.
// Only src/ is measured: dist/ is the same code compiled and run by a few tests, and counting it would double the lines.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"

const ROOT = new URL("../", import.meta.url).pathname
export const OVERALL = 80
export const GATED: Record<string, number> = { "src/graphs/ticket.ts": 85, "src/run.ts": 85, "src/merge.ts": 85, "src/safety.ts": 85 }

type Row = { file: string; found: number; hit: number }
/** lcov.info to one row per file (paths relative to the repo root). */
export function parseLcov(text: string): Row[] {
  const rows: Row[] = []
  let cur: Row | undefined
  for (const l of text.split("\n")) {
    if (l.startsWith("SF:")) rows.push((cur = { file: l.slice(3).replace(ROOT, ""), found: 0, hit: 0 }))
    else if (cur && l.startsWith("LF:")) cur.found = Number(l.slice(3))
    else if (cur && l.startsWith("LH:")) cur.hit = Number(l.slice(3))
  }
  return rows
}
const pct = (r: { found: number; hit: number }) => (r.found ? (100 * r.hit) / r.found : 100)
const line = (r: Row, gate?: number) => `${pct(r).toFixed(1).padStart(6)}%  ${String(r.hit).padStart(5)}/${String(r.found).padEnd(5)}  ${r.file}${gate ? `  (gate ${gate}%)` : ""}`

/** Gate failures, as sentences; empty = pass. */
export function check(rows: Row[], overall = OVERALL, gated = GATED): string[] {
  const src = rows.filter((r) => r.file.startsWith("src/"))
  const total = { found: src.reduce((n, r) => n + r.found, 0), hit: src.reduce((n, r) => n + r.hit, 0) }
  const out: string[] = []
  if (pct(total) < overall) out.push(`overall line coverage of src/ is ${pct(total).toFixed(1)}%, under ${overall}%`)
  for (const [f, min] of Object.entries(gated)) {
    const r = src.find((x) => x.file === f)
    if (!r) out.push(`${f} has no coverage data (is it loaded by a test?)`)
    else if (pct(r) < min) out.push(`${f} is at ${pct(r).toFixed(1)}%, under ${min}%`)
  }
  return out
}

if (import.meta.main) {
  const tmp = mkdtempSync(`${tmpdir()}/dobby-coverage-`)
  const lcov = `${tmp}/lcov.info`, spec = `${tmp}/spec.txt`
  const r = spawnSync(process.execPath, [
    "--no-warnings", "--experimental-test-coverage", "--test-coverage-include=src/**",
    "--test-reporter=spec", `--test-reporter-destination=${spec}`, "--test-reporter=lcov", `--test-reporter-destination=${lcov}`,
    "--test", "tests/*.test.ts", "tests/e2e/*.e2e.test.ts",
  ], { cwd: ROOT, stdio: "inherit", env: { ...process.env } })
  const report = readFileSync(spec, "utf8")
  const summary = report.split("\n").filter((l) => /^ℹ (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(l)).join("\n")
  console.log(summary)
  if (r.status !== 0) {
    console.log(report.split("\n").filter((l) => /^(✖|\s+✖)/.test(l)).join("\n"))
    console.error("coverage: the tests failed, so the coverage gate was not applied")
    process.exit(r.status ?? 1)
  }
  const rows = parseLcov(readFileSync(lcov, "utf8")).filter((x) => x.file.startsWith("src/"))
  const total = { found: rows.reduce((n, x) => n + x.found, 0), hit: rows.reduce((n, x) => n + x.hit, 0) }
  console.log(`\nsrc/ line coverage: ${pct(total).toFixed(1)}% (${total.hit}/${total.found}); gate ${OVERALL}% overall, ${Object.entries(GATED).map(([f, m]) => `${f.replace("src/", "")} ${m}%`).join(", ")}`)
  console.log("\ngated files:")
  for (const f of Object.keys(GATED)) { const x = rows.find((y) => y.file === f); if (x) console.log(line(x, GATED[f])) }
  console.log("\nweakest 10 files:")
  for (const x of [...rows].sort((a, b) => pct(a) - pct(b)).slice(0, 10)) console.log(line(x))
  const bad = check(rows)
  if (bad.length) { console.error(`\ncoverage gate failed:\n- ${bad.join("\n- ")}`); process.exit(1) }
  console.log("\ncoverage gate passed")
}

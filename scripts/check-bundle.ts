// The first-load budget (docs/design/dashboard/SPEC.md §4): the entry chunk, plus every chunk it imports statically, under 200 KB gzipped JS and 60 KB CSS (1 KB = 1000 bytes, as Vite reports it).
// Dynamic imports (routes, dialogs) are not first load. Run by `npm run build:dashboard`, so a build over the budget fails.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

export const BUDGET = { js: 200_000, css: 60_000 }
type Manifest = Record<string, { file: string; isEntry?: boolean; imports?: string[]; css?: string[] }>

/** Gzipped bytes of the first load, read from Vite's manifest in `dist`. */
export function firstLoad(dist: string): { js: number; css: number; files: string[] } {
  const manifest = JSON.parse(readFileSync(`${dist}/.vite/manifest.json`, "utf8")) as Manifest
  const entry = Object.keys(manifest).find((k) => manifest[k].isEntry)
  if (!entry) throw new Error("no entry chunk in the Vite manifest")
  const seen = new Set<string>(), js = new Set<string>(), css = new Set<string>()
  const walk = (k: string) => {
    if (seen.has(k)) return
    seen.add(k)
    js.add(manifest[k].file); for (const c of manifest[k].css ?? []) css.add(c)
    for (const i of manifest[k].imports ?? []) walk(i)
  }
  walk(entry)
  const size = (files: Set<string>) => [...files].reduce((n, f) => n + gzipSync(readFileSync(`${dist}/${f}`)).length, 0)
  return { js: size(js), css: size(css), files: [...js, ...css] }
}

/** The problems with a first load, or an empty list. */
export function overBudget(s: { js: number; css: number }, budget = BUDGET): string[] {
  const kb = (n: number) => `${(n / 1000).toFixed(1)} KB`
  return [
    ...(s.js > budget.js ? [`first-load JS is ${kb(s.js)} gzipped, over the ${kb(budget.js)} budget`] : []),
    ...(s.css > budget.css ? [`first-load CSS is ${kb(s.css)} gzipped, over the ${kb(budget.css)} budget`] : []),
  ]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const s = firstLoad(fileURLToPath(new URL("../dashboard/dist", import.meta.url)))
  console.log(`first load: JS ${(s.js / 1000).toFixed(1)} KB, CSS ${(s.css / 1000).toFixed(1)} KB gzipped (${s.files.length} files)`)
  const bad = overBudget(s)
  if (bad.length) { console.error(bad.join("\n")); process.exit(1) }
}

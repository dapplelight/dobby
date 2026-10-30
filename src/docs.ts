// The manual: docs/manual/*.md shipped in the package. `dobby docs` lists it or prints a page; scripts/gen-docs.ts builds llms.txt from it.
// Page format: frontmatter first (title, description, sidebar group and order; the docs site reads the same lines), then an optional
// "<!-- generated ... -->" line, then the body with no "# Title" (the title comes from the frontmatter).
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** The manual folder next to this module (src/ or dist/), not the cwd. */
export const MANUAL = fileURLToPath(new URL("../docs/manual/", import.meta.url))
/** Sidebar groups in index order: learn, understand, do, look up. Within a group, pages follow their `order`. */
export const GROUPS = ["Start", "Concepts", "Guides", "Reference"] as const
export type Page = { name: string; title: string; summary: string; group: string; order: number }

const FRONT = /^---\n([\s\S]*?)\n---\n/
/** Title, summary (the frontmatter description) and sidebar place of one page's text ("" when the format is not followed). */
export function parsePage(text: string, name: string): Page {
  const f = text.match(FRONT)?.[1] ?? ""
  const get = (k: string) => f.match(new RegExp(`^${k}: "([^"]*)"$`, "m"))?.[1] ?? ""
  const sb = f.match(/^sidebar: \{ group: (\w+), order: (\d+) \}$/m)
  return { name, title: get("title"), summary: get("description"), group: sb?.[1] ?? "", order: Number(sb?.[2] ?? 0) }
}

/** A page as the terminal, MCP and llms-full.txt show it: "# Title", "> summary", then the body. */
export function render(text: string, name = ""): string {
  const p = parsePage(text, name)
  const body = text.replace(FRONT, "").replace(/^\s*<!--.*-->\n/, "").trim()
  return `# ${p.title}\n\n> ${p.summary}\n\n${body}`
}

export function pages(dir = MANUAL): Page[] {
  if (!existsSync(dir)) return []
  const ps = readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => parsePage(readFileSync(`${dir}${f}`, "utf8"), f.slice(0, -3)))
  const rank = (g: string) => { const i = (GROUPS as readonly string[]).indexOf(g); return i < 0 ? GROUPS.length : i }
  return ps.sort((a, b) => rank(a.group) - rank(b.group) || a.order - b.order || a.name.localeCompare(b.name))
}

export const pageList = (ps: Page[]) => ps.map((p) => `${p.name.padEnd(Math.max(...ps.map((x) => x.name.length)))}  ${p.summary}`).join("\n")

/** `dobby docs [topic]`: no topic = the list; a name or a unique prefix = the page. Offline, no database. */
export function docsCommand(topic?: string, dir = MANUAL): { out: string; err?: string; code: number } {
  const ps = pages(dir)
  if (!topic) return { out: pageList(ps), code: 0 }
  const hit = ps.find((p) => p.name === topic) ?? (ps.filter((p) => p.name.startsWith(topic)).length === 1 ? ps.find((p) => p.name.startsWith(topic)) : undefined)
  if (!hit) return { out: pageList(ps), err: `No docs page "${topic}". Pages:`, code: 1 }
  return { out: render(readFileSync(`${dir}${hit.name}.md`, "utf8"), hit.name), code: 0 }
}

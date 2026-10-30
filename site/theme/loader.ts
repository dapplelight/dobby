// Reads a folder of markdown pages (any file set, nested folders allowed) into Starlight's docs collection.
// Frontmatter wins. Without it, the title comes from the first "# Title" line and the description from a
// "> summary" line right under it, so plain repo markdown builds as-is. A leading <!-- comment --> is dropped.
import { readdirSync, readFileSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import type { Loader } from "astro/loaders"
import { parse } from "yaml"
import { rewriteLinks, slugOf } from "./links.ts"

export type Page = { file: string; slug: string; data: Record<string, any>; body: string }

export function parsePage(text: string): Omit<Page, "file" | "slug"> {
  const data: Record<string, any> = {}
  text = text.replace(/^<!--[\s\S]*?-->\r?\n/, "")
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (fm) { Object.assign(data, parse(fm[1]) ?? {}); text = text.slice(fm[0].length).replace(/^<!--[\s\S]*?-->\r?\n/, "") }
  const h1 = text.match(/^\s*# (.+)\r?\n/)
  if (h1) { data.title ??= h1[1].trim(); text = text.slice(h1[0].length) }
  const lead = text.match(/^\s*> (.+)\r?\n/)
  if (lead && !data.description) { data.description = lead[1].trim(); text = text.slice(lead[0].length) }
  return { data, body: text.replace(/^\s+/, "") }
}

export function readPages(dir: string): Page[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".md") && !basename(f).startsWith("_"))
    .sort()
    .map((rel) => ({ file: join(dir, rel), slug: slugOf(rel), ...parsePage(readFileSync(join(dir, rel), "utf8")) }))
}

/** The page as clean markdown: title, summary, body (links point at other .md copies). */
export const pageMarkdown = (p: { data: Record<string, any>; body: string }) =>
  [`# ${p.data.title}`, p.data.description ? `> ${p.data.description}` : "", p.body.trimEnd()].filter(Boolean).join("\n\n") + "\n"

export function docsFolder({ dir, base = "docs" }: { dir: string; base?: string }): Loader {
  return {
    name: "signet-docs-folder",
    async load({ store, parseData, renderMarkdown, generateDigest, watcher }) {
      const sync = async () => {
        store.clear()
        for (const p of readPages(dir)) {
          const id = [base, p.slug].filter(Boolean).join("/")
          // `sidebar.group` is ours (read by sidebarFrom); Starlight's schema does not know it.
          const { group: _g, ...sidebar } = p.data.sidebar ?? {}
          const data = await parseData({ id, data: { ...p.data, ...(p.data.sidebar ? { sidebar } : {}) }, filePath: p.file })
          store.set({
            id,
            data,
            body: pageMarkdown({ data: p.data, body: rewriteLinks(p.body, p.file, dir, base, "md") }),
            rendered: await renderMarkdown(rewriteLinks(p.body, p.file, dir, base, "page"), { fileURL: pathToFileURL(p.file) }),
            filePath: relative(process.cwd(), p.file),
            digest: generateDigest(p.body + JSON.stringify(p.data)),
          })
        }
      }
      await sync()
      if (watcher) { watcher.add(dir); watcher.on("all", (_e, f) => { if (f.startsWith(dir)) void sync() }) }
    },
  }
}

/**
 * Starlight sidebar groups from page frontmatter: `sidebar.group` names the group, `sidebar.order` sorts inside it.
 * `groups` fixes the group order (others follow, in order of their first page). Pages with no order fall back to
 * their position in `order` (a list of slugs), then to the title. Pages with no group go to `fallbackGroup`.
 */
export function sidebarFrom(dir: string, { base = "docs", groups = [] as string[], order = [] as string[], fallbackGroup = "Docs" } = {}) {
  const pages = readPages(dir).filter((p) => !p.data.sidebar?.hidden && !p.data.draft)
  const rank = (p: Page) => p.data.sidebar?.order ?? (order.includes(p.slug) ? order.indexOf(p.slug) : Number.MAX_SAFE_INTEGER)
  pages.sort((a, b) => rank(a) - rank(b) || String(a.data.title).localeCompare(String(b.data.title)))
  const byGroup = new Map<string, Page[]>()
  for (const g of groups) byGroup.set(g, [])
  for (const p of pages) {
    const g = p.data.sidebar?.group ?? fallbackGroup
    byGroup.set(g, [...(byGroup.get(g) ?? []), p])
  }
  return [...byGroup].filter(([, ps]) => ps.length).map(([label, ps]) => ({
    label,
    items: ps.map((p) => ({ slug: [base, p.slug].filter(Boolean).join("/") })),
  }))
}

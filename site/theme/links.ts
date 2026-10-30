// Page paths and link rewriting for a folder of markdown pages served under /<base>/.
import { dirname, relative, resolve, sep } from "node:path"

/** "guides/install.md" -> "guides/install"; "index.md" -> "". */
export const slugOf = (rel: string) =>
  rel.split(sep).join("/").replace(/\.md$/, "").replace(/(^|\/)index$/, "").toLowerCase()

/** The page URL ("page") or its markdown copy ("md") for a slug. */
export const urlOf = (base: string, slug: string, form: "page" | "md") => {
  const path = `/${[base, slug].filter(Boolean).join("/")}`
  return form === "md" ? `${path}.md` : `${path}/`
}

/**
 * Rewrites relative links to .md files inside `root` so they work on the site:
 * `[x](billing.md#which-one)` becomes `/docs/billing/#which-one` (page) or `/docs/billing.md#which-one` (md).
 * Links that leave `root`, absolute links and URLs are left alone.
 */
export function rewriteLinks(md: string, fromFile: string, root: string, base: string, form: "page" | "md"): string {
  return md.replace(/\]\((?![a-z][a-z0-9+.-]*:|\/|#)([^)\s]+?\.md)(#[^)\s]*)?\)/gi, (all, target: string, hash = "") => {
    const rel = relative(root, resolve(dirname(fromFile), target))
    if (rel.startsWith("..")) return all
    return `](${urlOf(base, slugOf(rel), form)}${hash})`
  })
}

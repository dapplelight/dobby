// /<base>/llms.txt and /<base>/llms-full.txt, served from the product's own generated files.
import { readFileSync } from "node:fs"
import config from "virtual:signet-docs/config"
import { rewriteLinks } from "../links.ts"

export const GET = ({ url }: { url: URL }) => {
  const file = url.pathname.endsWith("llms-full.txt") ? config.llms.full : config.llms.index
  const text = rewriteLinks(readFileSync(file, "utf8"), file, config.llms.content, config.base, "md")
  return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
}

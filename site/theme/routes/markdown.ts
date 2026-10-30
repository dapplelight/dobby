// /<base>/<page>.md: the clean markdown copy of every docs page (what agents read and "Copy page" copies).
import { getCollection } from "astro:content"
import config from "virtual:signet-docs/config"

export async function getStaticPaths() {
  const docs = await getCollection("docs")
  return docs
    .filter((e) => e.id === config.base || e.id.startsWith(`${config.base}/`))
    .map((e) => ({ params: { slug: e.id.slice(config.base.length + 1) || undefined }, props: { body: e.body ?? "" } }))
}

export const GET = ({ props }: { props: { body: string } }) =>
  new Response(props.body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } })

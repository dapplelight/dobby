import { fileURLToPath } from "node:url"
import { docsSchema } from "@astrojs/starlight/schema"
import { docsFolder } from "@dapplelight/signet-docs/loader"
import { defineCollection } from "astro:content"

// The manual is the repo's docs/manual folder, read in place (generated pages included), served under /docs.
export const collections = {
  docs: defineCollection({ loader: docsFolder({ dir: fileURLToPath(new URL("../../docs/manual/", import.meta.url)) }), schema: docsSchema() }),
}

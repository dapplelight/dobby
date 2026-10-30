// @ts-check
import { fileURLToPath } from "node:url"
import starlight from "@astrojs/starlight"
import signetDocs, { sidebarFrom } from "@dapplelight/signet-docs"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "astro/config"
import { ORDER } from "../src/docs.ts"
import { beta, site } from "./facts.ts"

const manual = fileURLToPath(new URL("../docs/manual/", import.meta.url))

export default defineConfig({
  site: site.url,
  output: "static",
  // CLI flags like --ui must stay two hyphens.
  markdown: { smartypants: false },
  vite: { plugins: [tailwindcss()] },
  integrations: [
    starlight({
      title: "Dobby",
      description: "Dobby runs Claude Code on your tickets and opens reviewed pull requests.",
      favicon: "/favicon.svg",
      lastUpdated: true,
      // Groups and order come from page frontmatter (sidebar.group, sidebar.order); ORDER is the fallback for plain pages.
      sidebar: sidebarFrom(manual, { order: ORDER, groups: ["Start", "Concepts", "Guides", "Reference"], fallbackGroup: "Manual" }),
      plugins: [
        signetDocs({
          title: "Dobby",
          wordmark: "dobby",
          mark: "./src/components/Mark.astro",
          colors: "./src/styles/dobby.css",
          repo: site.repo,
          badge: { label: beta.label, note: beta.note },
          license: `${site.license} licensed`,
          nav: [
            { label: "Docs", href: "/docs/install/", match: "/docs/" },
            { label: "CLI", href: "/docs/cli/" },
            { label: "Config", href: "/docs/config/" },
          ],
          llms: { index: "../docs/llms.txt", full: "../docs/llms-full.txt", content: "../docs/manual/" },
        }),
      ],
    }),
  ],
})

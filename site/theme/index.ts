// @dapplelight/signet-docs: one Starlight theme for every dapplelight product's docs.
// A product changes only its config below and a color overlay (color variables only, light and dark).
import { fileURLToPath } from "node:url"
import type { StarlightPlugin } from "@astrojs/starlight/types"

export type SignetDocsOptions = {
  /** Product name, used in titles and llms text. */
  title: string
  /** Lowercase wordmark shown next to the mark. Defaults to `title`. */
  wordmark?: string
  /** Path (from the site root) to an .astro component that renders the product mark; it gets a `class` prop. */
  mark: string
  /** Path (from the site root) to the product's color overlay CSS: color variables only, `:root` and `.dark`. */
  colors: string
  /** GitHub `owner/name`. */
  repo: string
  /** Short status badge next to the name, like "Beta", and the one line that explains it. */
  badge?: { label: string; note: string }
  /** Header tabs. `match` is the path prefix that marks a tab current (default: href). */
  nav?: { label: string; href: string; match?: string }[]
  /** Route prefix of the docs pages. Default "docs". */
  base?: string
  /** llms.txt and llms-full.txt sources (paths from the site root); served at /<base>/llms.txt and /<base>/llms-full.txt.
   *  Relative links to .md files inside `content` are rewritten to the site's .md copies. */
  llms: { index: string; full: string; content: string }
  /** Footer line, like "MIT licensed". */
  license?: string
}

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default function signetDocs(o: SignetDocsOptions): StarlightPlugin {
  return {
    name: "@dapplelight/signet-docs",
    hooks: {
      "config:setup"({ config, updateConfig, addIntegration }) {
        const c = (n: string) => `@dapplelight/signet-docs/components/${n}.astro`
        updateConfig({
          customCss: ["@dapplelight/signet-docs/styles/theme.css", o.colors, ...(config.customCss ?? [])],
          components: {
            Head: c("Head"), Header: c("Header"), PageFrame: c("PageFrame"), Sidebar: c("Sidebar"), PageTitle: c("PageTitle"),
            Search: c("Search"), Footer: c("Footer"), ThemeProvider: c("ThemeProvider"), MarkdownContent: c("MarkdownContent"),
            ...config.components,
          },
          expressiveCode: config.expressiveCode === false ? false : {
            themes: ["vitesse-dark", "vitesse-light"],
            styleOverrides: {
              borderRadius: "0.625rem",
              borderColor: "var(--border-default)",
              codeFontFamily: "var(--sl-font-mono)",
              codeFontSize: "0.875rem",
              codeLineHeight: "1.65",
              codeBackground: "var(--bg-surface)",
              uiFontFamily: "var(--sl-font)",
              focusBorder: "var(--focus-ring)",
              frames: {
                shadowColor: "transparent",
                editorBackground: "var(--bg-surface)",
                terminalBackground: "var(--bg-surface)",
                editorActiveTabBackground: "var(--bg-surface)",
                editorActiveTabIndicatorTopColor: "var(--primary)",
                editorTabBarBackground: "var(--bg-elevated)",
                terminalTitlebarBackground: "var(--bg-elevated)",
                terminalTitlebarBorderBottomColor: "var(--border-default)",
                terminalTitlebarDotsOpacity: "0",
                inlineButtonBorder: "var(--border-default)",
                inlineButtonForeground: "var(--text-secondary)",
                tooltipSuccessBackground: "var(--primary)",
                tooltipSuccessForeground: "var(--primary-fg)",
              },
            },
            ...(typeof config.expressiveCode === "object" ? config.expressiveCode : {}),
          },
        })
        addIntegration({
          name: "@dapplelight/signet-docs",
          hooks: {
            "astro:config:setup"({ config: astro, updateConfig: update, injectRoute }) {
              const abs = (p: string) => fileURLToPath(new URL(p, astro.root))
              const base = o.base ?? "docs"
              const settings = {
                ...o, base, wordmark: o.wordmark ?? o.title, nav: o.nav ?? [],
                llms: { index: abs(o.llms.index), full: abs(o.llms.full), content: abs(o.llms.content) },
              }
              update({
                vite: {
                  plugins: [{
                    name: "signet-docs-virtual",
                    resolveId: (id: string) => (id.startsWith("virtual:signet-docs/") ? `\0${id}` : undefined),
                    load: (id: string) =>
                      id === "\0virtual:signet-docs/config" ? `export default ${JSON.stringify(settings)}`
                      : id === "\0virtual:signet-docs/Mark" ? `export { default } from ${JSON.stringify(abs(o.mark))}`
                      : undefined,
                  }],
                },
              })
              injectRoute({ pattern: `/${base}/[...slug].md`, entrypoint: here("./routes/markdown.ts"), prerender: true })
              injectRoute({ pattern: `/${base}/llms.txt`, entrypoint: here("./routes/llms.ts"), prerender: true })
              injectRoute({ pattern: `/${base}/llms-full.txt`, entrypoint: here("./routes/llms.ts"), prerender: true })
            },
          },
        })
      },
    },
  }
}

export { docsFolder, sidebarFrom } from "./loader.ts"

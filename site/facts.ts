// The site's facts. Docs and landing pages read names, dates and numbers from here; none are typed into a page.
// Every number has a source. A number we do not have yet is { need: "..." }: pages must skip it (see `known`),
// never guess it. Names come from the code (glossary, presets) so the site and the product cannot drift.
import pkg from "../package.json" with { type: "json" }
import { GLOSSARY } from "../dashboard/src/lib/glossary.ts"
import { CATEGORIES, PRESET_NAMES } from "../src/presets.ts"

export type Fact<T> = { value: T; source: string } | { value?: undefined; need: string }
/** True when a fact has a value. Render a number only after this check. */
export const known = <T>(f: Fact<T>): f is { value: T; source: string } => f.value !== undefined

export const site = {
  url: "https://dobby.dapplelight.in",
  repo: "dapplelight/dobby",
  docs: "/docs/install/",
  license: "MIT",
}

export const install = {
  command: "npx dobby-ai init",
  /** One line, shown under every install command. Source: docs/manual/requirements.md. */
  requirements: "macOS or Linux (WSL2 on Windows), Node 24 or newer, git, the GitHub CLI, and Claude Code on a Pro or Max plan or an API key.",
}

export const beta = {
  label: "Beta",
  note: "Dobby is in public beta. Commands and defaults may still change.",
  /** Source: owner, public beta on or before 31 Oct 2026. */
  starts: "2026-10-31",
  version: pkg.version,
}

const title = (s: string) => s[0].toUpperCase() + s.slice(1)
/** Balanced first: it is the default. Source: src/presets.ts. */
export const presets = ["balanced", ...PRESET_NAMES.filter((p) => p !== "balanced")].map(title)
/** Safety categories. Source: src/presets.ts. */
export const categories = [...CATEGORIES]

/** Role names as the dashboard shows them. Source: dashboard/src/lib/glossary.ts. */
export const roles = {
  main: (["engineering-manager", "builder", "tester", "code-reviewer", "product-manager", "chief-of-staff"] as const).map((k) => GLOSSARY[k].name),
  supporting: "plus supporting roles that run when needed",
  scout: GLOSSARY["talent-scout"].name,
}

export const harnesses = { today: ["Claude Code"], coming: ["Codex", "Gemini CLI"] }

export const numbers = {
  presets: { value: presets.length, source: "src/presets.ts" },
  categories: { value: categories.length, source: "src/presets.ts" },
  mainRoles: { value: roles.main.length, source: "dashboard/src/lib/glossary.ts" },
  prsShipped30d: { need: "dobby scoreboard 30 on the owner's install, after the launch proof run" },
  receipt30d: { need: "dobby receipt 30 card" },
  medianCostPerPr: { need: "dobby cost across 20+ real tickets, not UAT test repos" },
  waitedForTapShare: { need: "DB query + safety explain, share of PRs that waited by category" },
  medianTicketToPr: { need: "ticket graph in the DB (dobby show)" },
  testerQuotes: { need: "beta tester quotes with written consent" },
} satisfies Record<string, Fact<number | string>>

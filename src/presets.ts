// Safety presets (see src/safety.ts). Kept free of imports so config.ts can read them.
export const CATEGORIES = ["migrations.schema", "migrations.data", "payments", "auth", "secrets", "deploys", "config", "client-sites", "releases"] as const
export type Category = (typeof CATEGORIES)[number]
export const ACTIONS = ["auto", "review", "owner", "never"] as const
export type Act = (typeof ACTIONS)[number]
export const PRESET_NAMES = ["strict", "balanced", "autonomous"] as const

const all = (a: Act): Record<Category, Act> => Object.fromEntries(CATEGORIES.map((c) => [c, a])) as Record<Category, Act>
export const PRESETS: Record<(typeof PRESET_NAMES)[number], Record<Category, Act>> = {
  strict: all("owner"),
  balanced: { ...all("owner"), "migrations.schema": "auto", deploys: "auto", config: "auto", payments: "review", auth: "review", secrets: "review" },
  autonomous: { ...all("review"), "migrations.schema": "auto", deploys: "auto", config: "auto" },
}

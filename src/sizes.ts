// Ticket sizes come only from config (`sizes`, starting list in sizes.defaults.json): names, how many, and what each one does.
// Nothing in src names a size. The list runs smallest to largest.
//   action: build = builders take it as is; split = planning splits it first; ask = held until the owner sets it to another size
//   tier: small = Haiku checker on low-risk work, no design step; large = PRD, launch notes and the strong (Opus) Builder
//   estimatePct: week-% a ticket of this size costs before there is history; builds: build cap across retries
//   describe: what the size means, shown to triage and planning
//   budget: most one ticket may spend in week-% (over it, the ticket goes to the owner); model: Builder model override
import { config, type Config } from "./config.ts"

export type Size = Config["sizes"][number]
export type SizeAction = Size["action"]

export const sizes = (): Size[] => config().sizes
export const sizeNames = () => sizes().map((s) => s.name)
export const sizeOf = (name: unknown): Size | undefined => sizes().find((s) => s.name === name)
export const isSize = (x: unknown): x is string => !!sizeOf(x)
export const smallest = () => sizes()[0].name
/** The size a ticket gets when nobody says: the first medium one, else the middle of the list. */
export const defaultSize = () => (sizes().find((s) => s.tier === "medium") ?? sizes()[Math.floor((sizes().length - 1) / 2)]).name
/** A known size, else the default (for sizes written by a model or an old row). */
export const sizeOr = (x: unknown, fallback = defaultSize()) => (isSize(x) ? x : fallback)
export const withAction = (a: SizeAction) => sizes().filter((s) => s.action === a).map((s) => s.name)
export const actionOf = (name: unknown): SizeAction => (sizeOf(name) ?? sizeOf(defaultSize())!).action
export const largeSizes = () => sizes().filter((s) => s.tier === "large").map((s) => s.name)
export const isLarge = (name: unknown) => sizeOf(name)?.tier === "large"
export const isSmall = (name: unknown) => sizeOf(name)?.tier === "small"
export const buildCap = (name: unknown) => (sizeOf(name) ?? sizeOf(defaultSize())!).builds
export const estimateOf = (name: unknown) => (sizeOf(name) ?? sizeOf(defaultSize())!).estimatePct
/** `'S','M'` for an SQL IN list; names are checked against SIZE_NAME in the schema, so they need no escaping. `''` when empty. */
export const sqlList = (names: string[]) => (names.length ? names.map((n) => `'${n}'`).join(",") : "''")
/** "S = under an hour, ... M = ..." for prompts and triage questions. */
export const sizeGuide = () => sizes().map((s) => `${s.name} = ${s.describe ?? s.tier}`).join(". ") + "."
/** Why a ticket of this size is not built on its own, or null when builders take it. */
export function heldWhy(name: unknown, planningPaused: boolean): string | null {
  const a = actionOf(name)
  if (a === "build") return null
  if (a === "ask") return `size ${name} is set to ask: change its size (dobby size <id> <size>) or the size's action`
  return planningPaused ? `size ${name} is split by planning first, and planning is paused` : `size ${name} is split by planning first`
}

// Jev (TypeSafe System One): typed decisions in ~0.3 s for ~$0.0004, zero Claude tokens.
// Fetch-only, same rules as the Jev SDK's createJev: every decision has a fallback (the safer, costlier path),
// used on low confidence, timeout, HTTP error, bad answer or missing key. Nothing here throws.
// Key: JEV_API_KEY from the environment only, never logged. Never send private or financial text (projects can opt out with `jev: off`).

import type { DB } from "./db.ts"
import { readSecrets } from "./telegram.ts"
import { decide } from "./policy.ts"

const URL = "https://api.typesafe.ai/v1/systemone"
const MODEL = "jev-1.13.0" // pinned: the confidence floor is tuned per version
const FLOOR = 0.95 // two apps saw wrong answers at 0.85-0.94 and none at 0.95
const TIMEOUT_MS = 8000

export type Q =
  | { type: "choice"; question: string; options: string[]; fallback: string }
  | { type: "score"; question: string; levels: string[]; fallback: number }
export type Answers<T extends Record<string, Q>> = { [K in keyof T]: { value: T[K]["fallback"]; fromJev: boolean } }

/** Judge one wire answer. Pure: anything off, or under the floor, is the fallback. */
export function judge(q: Q, a: Record<string, unknown> | undefined): { value: string | number; fromJev: boolean } {
  const fb = { value: q.fallback, fromJev: false }
  if (!a || typeof a.confidence !== "number" || a.confidence < FLOOR) return fb
  if (q.type === "choice") return typeof a.choice === "string" && q.options.includes(a.choice) ? { value: a.choice, fromJev: true } : fb
  return typeof a.score === "number" && a.score >= 0 && a.score <= q.levels.length - 1 ? { value: Math.round(a.score), fromJev: true } : fb
}

/** The Jev API key from the environment (then the secrets file), or undefined. Never logged. */
export const jevKey = () => (process.env.JEV_API_KEY ?? readSecrets().JEV_API_KEY)?.trim() || undefined

/** Several questions about one state in a single request. */
export async function ask<T extends Record<string, Q>>(state: string, questions: T, fetcher: typeof fetch = fetch): Promise<Answers<T>> {
  const fallback = () => Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, { value: q.fallback, fromJev: false }])) as Answers<T>
  // env first (tests set it to "" to force the fallback), then ~/.config/dobby/secrets.env for the launchd jobs
  const key = jevKey()
  if (!key) return fallback()
  try {
    const wire = Object.fromEntries(Object.entries(questions).map(([k, q]) =>
      [k, q.type === "choice" ? { type: "choice", instructions: q.question, criteria: Object.fromEntries(q.options.map((o) => [o, null])) } : { type: "score", instructions: q.question, criteria: q.levels }]))
    const res = await fetcher(URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ model: MODEL, state, questions: wire }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return fallback()
    const answers = ((await res.json()) as { answers?: Record<string, Record<string, unknown>> }).answers ?? {}
    return Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, judge(q, answers[k])])) as Answers<T>
  } catch {
    return fallback()
  }
}

const SIZES = ["S", "M", "L"]
const RISK = ["low", "medium", "high"]

/**
 * Triage a new ticket: how big, how risky. Fallbacks are the careful path: M (gets the Sonnet checker) and high risk.
 * Risk high = touches auth, money, data deletion, migrations, deploys, or anything users see outside the app.
 */
export async function triage(title: string, doneWhen: string, givenSize?: string, fetcher?: typeof fetch) {
  const a = await ask(`Ticket: ${title}\nDone when: ${doneWhen}`, {
    size: { type: "choice", question: "How big is this coding task for one engineer? S = under an hour, one or two files. M = a few hours, several files. L = a day or more, needs a design first.", options: SIZES, fallback: givenSize ?? "M" },
    risk: { type: "score", question: "How risky is this change if it has a bug? low = internal or cosmetic. medium = a user-facing feature. high = auth, money, deleting data, migrations, deploys, messages to people.", levels: RISK, fallback: 2 },
  }, fetcher)
  return { size: givenSize ?? (a.size.value as string), risk: RISK[a.risk.value as number], fromJev: a.size.fromJev || a.risk.fromJev }
}

// Always big, whatever Jev says: a sensitive path (src/policy.ts, kind changed-path: schema, deploy config, secrets, auth,
// payments; markdown never counts) or a large diff.
/** True when this changed path is sensitive: big merge, Opus review. */
export const sensitivePath = (path: string) => decide("changed-path", path).action !== "allow"
const BIG_LINES = 400
const SMALL_LINES = 150
const SMALL_FILES = 8

/**
 * Is this merge big enough to wait for you? Small merges go in on their own.
 * Jev sees only the title, file paths and line counts, never the diff. Fallback: big (wait for you).
 */
export async function mergeIsBig(title: string, files: { path: string; lines: number }[], useJev = true, fetcher?: typeof fetch) {
  const lines = files.reduce((n, f) => n + f.lines, 0)
  const hit = files.find((f) => sensitivePath(f.path))
  if (hit) return { big: true, why: `touches ${hit.path}` }
  if (lines > BIG_LINES) return { big: true, why: `${lines} lines changed` }
  // Clearly small needs no judge: Jev only decides the middle band (and has no key on the Mac yet).
  if (lines <= SMALL_LINES && files.length <= SMALL_FILES) return { big: false, why: `${files.length} files, ${lines} lines` }
  if (!useJev) return { big: true, why: "Jev off for this project" }
  const a = await ask(`Merge: ${title}\n${files.length} files, ${lines} lines:\n${files.map((f) => `${f.path} (${f.lines})`).join("\n")}`, {
    size: { type: "choice", question: "Should the owner review this merge before it goes live? big = new feature, changes how users' data is stored or shown across many screens, or anything hard to undo. small = a fix, copy, styling, tests, one screen.", options: ["small", "big"], fallback: "big" },
  }, fetcher)
  return { big: a.size.value === "big", why: a.size.fromJev ? `Jev: ${a.size.value}, ${lines} lines` : "Jev unsure or offline, so wait for you" }
}

const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3))
/** Live tickets (any status but declined or merged away) sharing at least 40% of their words with `title`: a cost gate so Jev is only asked about likely twins. */
export function nearTickets(db: DB, project: string, title: string, max = 6): { id: number; title: string }[] {
  const a = words(title)
  if (!a.size) return []
  const rows = db.prepare("SELECT id, title FROM tickets WHERE project=? AND dup_of IS NULL AND status!='declined'").all(project) as { id: number; title: string }[]
  return rows
    .map((r) => { const b = words(r.title); const both = [...a].filter((w) => b.has(w)).length; return { ...r, sim: both / (a.size + b.size - both) } })
    .filter((r) => r.sim >= 0.4).sort((x, y) => y.sim - x.sim).slice(0, max)
}
/**
 * Is a new ticket the same piece of work as one of these near tickets? Returns that ticket's id, or null.
 * Fallback none (file it): a twin costs one extra Checker pass, a wrongly dropped ticket costs the work. Titles only, no ticket bodies.
 */
export async function sameWork(title: string, near: { id: number; title: string }[], fetcher?: typeof fetch): Promise<number | null> {
  if (!near.length) return null
  const opts = near.map((n) => `#${n.id} ${n.title.slice(0, 120)}`)
  const a = await ask(`New ticket: ${title.slice(0, 160)}`, {
    same: { type: "choice", question: "Is the new ticket the same piece of work as one of the listed existing tickets (it would change the same thing for the same reason)? Pick that ticket, or none if it is different work, even if it is in the same area.", options: [...opts, "none"], fallback: "none" },
  }, fetcher)
  const m = /^#(\d+) /.exec(String(a.same.value))
  return m ? Number(m[1]) : null
}

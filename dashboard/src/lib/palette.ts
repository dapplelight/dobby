// The ⌘K palette's results. Pure: the keys registry, the snapshot and the settings list go in, a flat list of items comes out.
// An action names its target ("Merge tally #412 · CSV export") and runs the same POST /api/action as the row's button, so the 8 s hold and undo apply. No key events are sent.
import { ACTIONS, NAV } from "../actions.ts"
import type { ConfigKey, Snapshot } from "../../../src/api-schema.ts"
import { MANUAL } from "./glossary.ts"
import { label } from "./settings-labels.ts"

export type Run = { kind: "act"; body: { action: string } & Record<string, unknown> } | { kind: "ticket" } | { kind: "go"; to: string; search?: Record<string, string> } | { kind: "link"; href: string }
export type Item = { id: string; group: "Actions" | "Go to" | "Tickets" | "Settings" | "Docs"; label: string; hint?: string; keys?: string[]; cli?: string; words: string; run: Run }

export const PAGES = [
  { id: "go-home", label: "Home", to: "/" }, { id: "go-queue", label: "Queue", to: "/queue" }, { id: "go-reviews", label: "Reviews", to: "/reviews" }, { id: "go-spend", label: "Spend", to: "/spend" },
  { id: "go-goals", label: "Goals", to: "/goals" }, { id: "go-activity", label: "Activity", to: "/activity" }, { id: "settings", label: "Settings", to: "/settings" }, { id: "team", label: "Team and projects", to: "/team" },
] as const

export const DOCS = [
  ["install", "Install"], ["first-hour", "Your first hour"], ["how-it-works", "The loop: ticket to merge"], ["what-waits", "What waits for you"], ["answer-what-waits", "Answer what waits"],
  ["pause-and-resume", "Pause and resume"], ["reviews", "Review commands in a PR"], ["billing", "Plan or API key"], ["cap-spend", "Cap spend"], ["config", "Settings reference"],
  ["cli", "Commands"], ["security", "Security"], ["troubleshooting", "Fix common problems"], ["doctor", "Doctor checks"], ["glossary", "Glossary"],
] as const

export const show = (k: string) => k.replace("Shift+", "⇧").replace("Mod+", "⌘").replace("Enter", "↵").replace("ArrowLeft", "←").replace("ArrowRight", "→")

export function paletteItems(i: { snap?: Snapshot; config?: ConfigKey[]; path: string }): Item[] {
  const out: Item[] = []
  const generic = (id: string, group: string, label: string, run: Run): Item => {
    const k = [...ACTIONS, ...NAV].find((e) => e.id === id)
    return { id: `a:${id}`, group: "Actions", label, keys: k?.keys.map(show), cli: k?.cli ? `dobby ${k.cli}` : undefined, words: `${id} ${group}`, run }
  }
  out.push(generic("new-ticket", "General", "New ticket", { kind: "ticket" }))
  out.push(i.snap?.paused ? generic("resume-team", "General", "Resume the team", { kind: "act", body: { action: "resume" } }) : generic("pause-team", "General", "Pause the team", { kind: "act", body: { action: "pauseTeam" } }))
  for (const p of PAGES) {
    const k = [...ACTIONS, ...NAV].find((e) => e.id === p.id)
    out.push({ id: `p:${p.to}`, group: "Go to", label: p.label, keys: k?.keys.map(show), words: p.to, run: { kind: "go", to: p.to } })
  }
  const s = i.snap
  if (s) {
    const seen = new Set<number>()
    const add = (id: number | null, ref: string, title: string, url?: string | null) => {
      if (id === null || seen.has(id)) return
      seen.add(id)
      out.push({ id: `t:${id}`, group: "Tickets", label: title, hint: ref, words: `${ref} ${id} ${url?.match(/pull\/(\d+)/)?.[1] ?? ""}`, run: { kind: "go", to: `/pr/${id}` } })
    }
    // one entry per row that offers an action, named by its target; Answer needs words, so it opens the ticket
    for (const r of s.inbox.rows) {
      const verb = r.kind === "merge" ? "Merge" : r.kind === "deploy" ? "Deploy" : r.kind === "answer" ? "Answer" : "Retry"
      const name = r.kind === "deploy" ? r.project : `${r.ref} · ${r.title}`
      const run: Run | null = verb === "Deploy" ? { kind: "act", body: { action: "deploy", project: r.project } }
        : r.id === null ? null : verb === "Answer" ? { kind: "go", to: `/pr/${r.id}` } : { kind: "act", body: { action: verb.toLowerCase(), id: r.id } }
      if (run) out.push({ id: `a:${verb.toLowerCase()}:${r.key}`, group: "Actions", label: `${verb} ${name}`, words: `${verb} ${r.ref} ${r.title} ${r.project}`, hint: verb === "Answer" ? "opens the ticket" : undefined, run })
    }
    for (const r of s.inbox.rows) add(r.id, r.ref, r.title, r.url)
    for (const r of s.working) add(r.id, r.ref, r.title)
    for (const r of s.queue.order) add(r.id, r.ref, r.title)
    for (const r of s.queue.parked) add(r.id, r.ref, r.title)
  }
  for (const k of i.config ?? []) out.push({ id: `s:${k.key}`, group: "Settings", label: label(k), hint: k.key, words: k.desc, run: { kind: "go", to: "/settings", search: { find: k.key } } })
  for (const [slug, title] of DOCS) out.push({ id: `d:${slug}`, group: "Docs", label: title, hint: `docs/manual/${slug}.md`, words: slug, run: { kind: "link", href: `${MANUAL}/${slug}.md` } })
  return out
}

/** Search score, 0 = hidden. Exact then prefix title matches first, then word starts, then substrings; no fuzzy letters, so "zzzz" finds nothing. Group order follows the best score in it. */
export function rank(it: Pick<Item, "label" | "hint" | "words">, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1
  const t = it.label.toLowerCase()
  if (t === q) return 100
  if (t.startsWith(q)) return 90
  if (t.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) return 70
  if (t.includes(q)) return 60
  if (`${it.hint ?? ""}`.toLowerCase().includes(q)) return 40
  return it.words.toLowerCase().includes(q) ? 20 : 0
}

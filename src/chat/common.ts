// Platform-neutral pieces every chat platform shares: the event and card types, the kv store, and the plain-text formatters.
import type { DB } from "../db.ts"

export const kv = (db: DB, k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
export const setKv = (db: DB, k: string, v: string) => db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(k, v)

export type Step = "picked" | "design" | "building" | "verify" | "check" | "merged" | "failed"
export type Event =
  | { kind: "ticket"; project: string; ticket: number; title: string; step: Step }
  | { kind: "lead" | "program"; project: string }
  | { kind: "shipped" | "idea"; project: string }
  | { kind: "approval" | "review" | "stuck" | "proposal" | "brief" | "health" | "ask" | "team"; key?: string; rich?: Rich } // key: one #needs-you card per key
/** The morning summary as a Components V2 message: sections (Markdown each), the plain Markdown messages for when Discord refuses it, and the dashboard link. */
export type Rich = { sections: string[]; plain: string[]; link?: string }

export type Owned =
  | { kind: "button"; data: string; id: string; token: string; content: string; app: string; /** the card's own buttons, put back when the tap failed */ components?: unknown[] }
  | { kind: "ask"; text: string; dm?: string }
  | { kind: "react"; messageId: string; channelId: string; up: boolean }
  | { kind: "brain"; thread: string; text: string }

export const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)

/** "2nd try" for try 2 and up, "" for the first. */
const tryText = (n: number) => (n > 1 ? ` · ${n}${["th", "st", "nd", "rd"][n % 10 > 3 || Math.floor(n / 10) === 1 ? 0 : n % 10]} try` : "")
/** The ticket thread's one status line: "Step 3 of 5: Tester is checking · 2nd try". */
export const stepLine = (step: number, what: string, tries = 1) => `Step ${step} of 5: ${what}${tryText(tries)}`
/** Raw tool output for a thread: a "details" label and at most 6 quoted lines (the last ones: that is where the error is). */
export const detailsBlock = (out: string) => `details\n${out.split("\n").map((l) => l.trim()).filter(Boolean).slice(-6).map((l) => `> ${cut(l, 200)}`).join("\n")}`
const GH_PLAIN: [RegExp, string][] = [
  [/base branch policy prohibits/i, "The branch rules block this merge: a required check or review is missing."],
  [/merge conflicts?|cannot be cleanly created/i, "The branch conflicts with its base and needs a conflict fix."],
  [/not mergeable/i, "GitHub cannot merge this PR yet."],
  [/a pull request for branch .* already exists/i, "This branch already has an open PR."],
]
/** A known GitHub error as one plain sentence with the raw text under details; anything else is the raw text, cut. */
export const plainGh = (out: string, max = 300) => {
  const hit = GH_PLAIN.find(([re]) => re.test(out))
  return hit ? `${hit[1]}\n${detailsBlock(out)}` : cut(out.trim(), max)
}

// The states every page can be in, read from the signals that already exist: the pause list, the plan-usage line, the event stream, /api/session and the health check for Claude's sign-in. Pure, so a test can feed it fixtures.
import type { Snapshot } from "../../../src/api-schema.ts"
import { clock } from "./week.ts"

export type DashState = {
  id: "paused" | "usage" | "offline" | "expired" | "claude"
  text: string
  /** One line under the text. */
  detail?: string
  /** The one fix: a command to copy, or (paused) the pause kind a Resume button sends. */
  command?: string
  resume?: string
}

type Pause = { scope: string; text: string; plain?: string }
const PAUSE_KIND: Record<string, string> = { everything: "all", builders: "builders", merges: "merges" }

export function deriveStates(i: { snap?: Snapshot; connection: "connecting" | "live" | "down"; updatedAt: number; canAct: boolean; setupPort?: string }): DashState[] {
  const out: DashState[] = []
  const snap = i.snap
  // Signed out is the whole story: the server answering 401 also closes the event stream, which is not a lost connection.
  if (!i.canAct) return [i.setupPort
    ? { id: "expired", text: "This browser is signed out.", detail: `This is the setup server on port ${i.setupPort}, not the dashboard. Open the sign-in link that dobby init --ui printed, then reload.` }
    : { id: "expired", text: "This browser is signed out.", detail: "Run this in a terminal, then reload:", command: "dobby dashboard open" }]
  if (i.connection === "down") out.push({ id: "offline", text: "Connection lost", detail: `${i.updatedAt ? `Showing the last update from ${clock(i.updatedAt)}` : "Nothing has loaded yet"}. Checking again every 10 seconds.` })
  if (snap) {
    const p = ((snap.pause ?? []) as Pause[]).find((x) => PAUSE_KIND[x.scope])
    if (p) out.push({ id: "paused", text: "Paused", detail: p.plain ?? p.text, resume: PAUSE_KIND[p.scope] })
    if (snap.limits && snap.limits.state === "unknown") out.push({ id: "usage", text: snap.limits.line, detail: "Check the plan reading and the sign-in:", command: "dobby doctor" })
    const claude = ((snap.health ?? []) as { check: string; ok: boolean; text: string }[]).find((h) => h.check === "claude" && !h.ok && /signed out/.test(h.text))
    if (claude) out.push({ id: "claude", text: "Claude is signed out, so no new work can start.", detail: "Run `claude`, then type /login.", command: "claude" })
  }
  return out
}

/** Whether the greyed instrument should read "Paused": the same pause the banner shows. */
export const isPaused = (states: DashState[]) => states.some((s) => s.id === "paused")

/** Row subtitles stay short: a link in a question reads as noise there (the detail view keeps it). */
export const noUrls = (s: string) => s.replace(/\s*https?:\/\/\S+/g, "").replace(/\s+([?.,!])/g, "$1").trim()

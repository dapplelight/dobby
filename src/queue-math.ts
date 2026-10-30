// The stop line's maths, shared by the server (which sends `fits`) and the page (which redraws the line while a row is dragged).
/** For each row in order: does the running total of what is still to spend stay within the week's room? Room null = no plan reading, so all fit. Once a row fails, every row below it fails too. */
export function markFits(rows: { leftPct: number }[], room: number | null): boolean[] {
  let total = 0
  return rows.map((r) => ((total += r.leftPct), room === null || total <= room))
}
/** Whether one more ticket of `estPct` fits behind everything already queued. */
export const fitsAfter = (queuedPct: number, estPct: number, room: number | null) => room === null || queuedPct + estPct <= room

/**
 * Where the week lands, with Dobby stopping at `stop`: the straight-line pace (used / elapsed share of the week), capped at the stop,
 * never below what is already used. `passes` = the raw pace is above the stop (so Dobby will stop there); `ownerOnly` = Dobby is already
 * stopped (used is at the stop) and the pace still passes it, so only the owner's own use can take the week past it.
 * The one projection: the morning summary and the dashboard (header, Spend, Home) all read it. Too early in the week (frac under minFrac) = null.
 */
export function weekLanding(used: number, frac: number, stop: number, minFrac = 0.05): { pct: number; passes: boolean; ownerOnly: boolean } | null {
  if (!(frac > minFrac)) return null
  const raw = Math.round(used / frac)
  return { pct: Math.max(used, Math.min(raw, stop)), passes: raw > stop, ownerOnly: used >= stop && raw > stop }
}

/** The landing in words for the summary and the pages: where it lands, or that Dobby stops at the cap. */
export function landingText(l: { pct: number; passes: boolean; ownerOnly: boolean }, stop: number): string {
  return l.ownerOnly ? `your own use alone is on pace to pass the ${stop}% stop` : l.passes ? `on pace to hit the ${stop}% stop, where Dobby stops` : `on pace to land at ${l.pct}% (stop ${stop}%)`
}

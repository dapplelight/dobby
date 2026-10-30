import type { Limits } from "../../../src/api-schema.ts"
import { landingText, weekLanding } from "../../../src/queue-math.ts"

const WEEK = 7 * 86_400_000

export type Week = { usedPct: number; stopPct: number; landsPct: number; landsAt: number; frac: number; resetsAt: number; series: { t: number; pct: number }[]; span?: number; landsText?: string }

/** Where the week stands, from the plan reading. `series` is the stored readings: the used line follows them, or runs straight to now when there are none. */
export function weekOf(l: Limits | null | undefined, series: Week["series"] = [], now = Date.now()): Week | null {
  if (!l || !("week" in l)) return null
  const { used, cap, resetsAt } = l.week
  const frac = Math.min(1, Math.max(0, (now - (resetsAt - WEEK)) / WEEK))
  const land = weekLanding(used, frac, cap, 0.02) // Dobby stops at the cap: the landing is capped there, the same maths as the morning summary
  return { usedPct: used, stopPct: cap, landsPct: land?.pct ?? used, landsAt: resetsAt, frac, resetsAt, series, landsText: land?.passes ? landingText(land, cap) : undefined }
}

const FIVE = 5 * 3_600_000
/** The 5-hour window in the same shape, so the same curve draws it. The line at the top is the window's limit. */
export function fiveOf(l: Limits | null | undefined, series: Week["series"] = [], now = Date.now()): Week | null {
  if (!l || !("five" in l) || !l.five.resetsAt) return null
  const { used, resetsAt } = l.five
  const frac = Math.min(1, Math.max(0, (now - (resetsAt - FIVE)) / FIVE))
  const lands = frac > 0.02 ? Math.min(100, Math.round(used / frac)) : used
  return { usedPct: used, stopPct: 100, landsPct: Math.max(used, lands), landsAt: resetsAt, frac, resetsAt, series, span: FIVE }
}

/** The instrument's SVG paths for a W x H box (the design's wl()). */
export function curve(w: Week, W: number, H: number, top: number, bot: number) {
  const y = (u: number) => +(bot - (u / 100) * (bot - top)).toFixed(1)
  const x = (d: number) => +((d / 7) * W).toFixed(1)
  const nx = x(w.frac * 7), ny = y(w.usedPct)
  const span = w.span ?? WEEK, start = w.resetsAt - span
  const pts = w.series.length > 1 ? w.series.filter((p) => p.t >= start).map((p) => `${x(((p.t - start) / span) * 7)} ${y(p.pct)}`) : []
  const used = pts.length > 1 ? `M${pts.join(" L")} L${nx} ${ny}` : `M0 ${y(0)} L${nx} ${ny}`
  return {
    nx, ny, used,
    area: `${used} L${nx} ${bot} L0 ${bot} Z`,
    band: `M${nx} ${ny} L${W} ${y(Math.min(100, w.landsPct + 3))} L${W} ${y(Math.max(0, w.landsPct - 4))} Z`,
    proj: `M${nx} ${ny} L${W} ${y(w.landsPct)}`,
    stop: `M0 ${y(w.stopPct)} L${W} ${y(w.stopPct)}`,
    ticks: [1, 2, 3, 4, 5, 6].map((k) => `M${x(k)} ${bot - 3} L${x(k)} ${H}`).join(" "),
  }
}

/** en-GB dates; some engines print "Sept", the rest of the page says "Sep". */
export const gbDate = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-GB", o).replace(/\bSept\b/, "Sep")
export const dayName = (ms: number) => new Date(ms).toLocaleDateString("en-US", { weekday: "short" })
export const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
/** "Fri 30 Oct", or "30 Oct" short. */
export const dueDate = (iso: string, short = false) => gbDate(new Date(iso), { ...(short ? {} : { weekday: "short" }), day: "numeric", month: "short" }).replace(",", "")

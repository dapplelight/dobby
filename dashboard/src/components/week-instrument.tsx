import { Link } from "@tanstack/react-router"
import { useId } from "react"
import { curve, dayName, weekOf } from "../lib/week"
import { useSnapshot } from "../lib/snapshot"

const W = 200, H = 26

/** The week in one glance: used, where it lands, the stop. Hatched band = projection, dashed line = stop, ping = now. */
export function WeekInstrument({ paused = false }: { paused?: boolean }) {
  const { data } = useSnapshot()
  const id = useId()
  const w = weekOf(data?.limits, data?.week.series)
  if (!w) return <span className="font-mono text-xs text-ink-2">{data?.limits?.line ?? "Week unknown"}</span>
  const c = curve(w, W, H, 2, 24)
  const label = `Week: ${w.usedPct} percent used, lands ${w.landsPct} percent by ${dayName(w.landsAt)}, stop at ${w.stopPct}`
  return (
    <Link to="/spend" aria-label={paused ? `Paused. ${label}` : label} className={`inline-flex h-9 max-md:h-11 items-center gap-3 rounded-lg px-2.5 text-ink no-underline hover:bg-hover ${paused ? "opacity-50" : ""}`}>
      <span className="whitespace-nowrap font-mono text-xs">
        {paused && <span className="mr-2 text-ink">Paused</span>}{w.usedPct}% <span className="text-ink-2">→ {w.landsPct}% {dayName(w.landsAt)}</span>
      </span>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="hidden overflow-hidden sm:block" aria-hidden="true">
        <defs>
          <pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="var(--ink-2)" strokeWidth="1" /></pattern>
        </defs>
        <path d={c.stop} fill="none" stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="2 3" />
        <path d={c.ticks} fill="none" stroke="var(--ink-3)" strokeWidth="1" />
        <path d={c.area} fill="var(--ink)" fillOpacity="0.08" />
        <path d={c.band} fill={`url(#${id})`} />
        <path d={c.proj} fill="none" stroke="var(--ink-2)" strokeWidth="1" strokeDasharray="3 3" />
        <path d={c.used} fill="none" stroke="var(--ink)" strokeWidth="1.5" strokeLinejoin="round" />
        <circle className="ping" cx={c.nx} cy={c.ny} r="2.5" fill="none" stroke="var(--ink)" strokeWidth="1" />
        <circle cx={c.nx} cy={c.ny} r="2.5" fill="var(--ink)" />
      </svg>
    </Link>
  )
}

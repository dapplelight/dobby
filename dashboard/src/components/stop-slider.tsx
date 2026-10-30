import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { curve, type Week } from "../lib/week"

const KNOB = 44, TOP = 16

/**
 * The week line with a draggable stop (SPEC part StopSlider). Drag the knob up or down, or use the arrow keys, Home and End; the value is saved when the
 * drag ends or the keys pause (`onCommit`). `week` is the plan reading; without one the line is drawn empty so the stop can still be set.
 */
export function StopSlider({ week, value, min = 10, max = 100, label = "Stop at", onCommit, onFocus }: { week: Week | null; value: number; min?: number; max?: number; label?: string; onCommit: (v: number) => void; onFocus?: () => void }) {
  const [v, setV] = useState(value)
  const [W, setW] = useState(640) // the width it is drawn at, so text and the knob keep their size on a phone
  const H = W < 520 ? 96 : 56, BOT = H - 2, PLOT = W - KNOB
  const y = (u: number) => +(BOT - (u / 100) * (BOT - TOP)).toFixed(1)
  const drag = useRef(false), timer = useRef<ReturnType<typeof setTimeout>>(undefined), box = useRef<SVGSVGElement>(null)
  useEffect(() => { if (!drag.current) setV(value) }, [value])
  const outer = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = outer.current
    if (!el) return
    const read = () => setW(Math.max(280, Math.min(640, Math.round(el.clientWidth))))
    read()
    const ro = new ResizeObserver(read); ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const w: Week = week ? { ...week, stopPct: v } : { usedPct: 0, stopPct: v, landsPct: 0, landsAt: 0, frac: 0.5, resetsAt: Date.now() + 3.5 * 86_400_000, series: [] }
  const c = curve(w, PLOT, H, TOP, BOT)
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)))
  const ghost = v - 5 >= min ? `M0 ${y(v - 5)} L${PLOT} ${y(v - 5)}` : ""
  const later = (n: number) => { setV(n); clearTimeout(timer.current); timer.current = setTimeout(() => n !== value && onCommit(n), 450) }
  const fromPointer = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect()
    const unit = ((e.clientY - r.top) / r.height) * H // svg units from the top
    return clamp(((BOT - unit) / (BOT - TOP)) * 100)
  }
  return (
    <div
      ref={outer} role="slider" tabIndex={0} aria-label={label} aria-valuemin={min} aria-valuemax={max} aria-valuenow={v} aria-valuetext={`${v} percent of the week`}
      onFocus={onFocus}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 5 : 1
        const next = e.key === "ArrowUp" || e.key === "ArrowRight" ? v + step : e.key === "ArrowDown" || e.key === "ArrowLeft" ? v - step : e.key === "Home" ? min : e.key === "End" ? max : null
        if (next === null) return
        e.preventDefault(); e.stopPropagation(); later(clamp(next))
      }}
      className="relative w-full max-w-[640px] touch-none rounded-md outline-offset-4 select-none"
    >
      <svg ref={box} viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="block overflow-visible" aria-hidden="true">
        <path d={c.area} fill="var(--ink)" fillOpacity="0.07" />
        <path d={c.used} fill="none" stroke="var(--ink)" strokeWidth="1.5" />
        {week && <path d={c.proj} fill="none" stroke="var(--ink-2)" strokeWidth="1" strokeDasharray="3 3" />}
        {ghost && <path d={ghost} fill="none" stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="2 4" />}
        <path d={c.stop} fill="none" stroke="var(--mark)" strokeWidth="1.5" />
        <g
          className="cursor-grab touch-none" onPointerDown={(e) => { drag.current = true; clearTimeout(timer.current); e.currentTarget.setPointerCapture(e.pointerId); onFocus?.(); setV(fromPointer(e)) }}
          onPointerMove={(e) => { if (drag.current) setV(fromPointer(e)) }}
          onPointerUp={(e) => { if (!drag.current) return; drag.current = false; const n = fromPointer(e); setV(n); if (n !== value) onCommit(n) }}
        >
          <rect x={PLOT} y={y(v) - 11} width={KNOB} height="22" rx="6" fill="var(--raise)" stroke="var(--mark)" strokeWidth="1.5" />
          <text x={PLOT + KNOB / 2} y={y(v) + 4} textAnchor="middle" className="font-mono" fill="var(--ink)" fontSize="11.5">{v}%</text>
          <rect x={PLOT - 12} y={y(v) - 22} width={KNOB + 12} height="44" fill="transparent" />
        </g>
      </svg>
    </div>
  )
}

import { EmptyState } from "@nimit9/signet-ui/components/empty-state"
import { ErrorState } from "@nimit9/signet-ui/components/error-state"
import { Skeleton } from "@nimit9/signet-ui/components/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@nimit9/signet-ui/components/tabs"
import { useId, useState } from "react"
import type { SpendPage } from "../../../src/api-schema.ts"
import { Key } from "../components/key"
import { Term } from "../components/term"
import { roleKey } from "../lib/glossary"
import { useSnapshot } from "../lib/snapshot"
import { useSpend } from "../lib/spend"
import { clock, curve, dayName, dueDate, fiveOf, type Week, weekOf } from "../lib/week"

type Tab = "project" | "role" | "past"
type Row = SpendPage["projects"][number]
const DAY = 86_400_000, WEEK = 7 * DAY
const grid = "grid-cols-[140px_minmax(0,1fr)_72px_120px_120px]"
const rowBox = "-mx-3.5 rounded-lg border-t border-line px-3.5 transition-colors first:border-t-transparent hover:bg-hover"
const usd = (n: number) => `$${n.toFixed(2)}`

/** The week (or the 5-hour window) as one chart: what is used, the projection to the reset, and the stop line. The paths come from the same curve() the header instrument draws. */
function Chart({ w, label }: { w: Week; label: string }) {
  const id = useId()
  const W = 640, H = 120
  const c = curve(w, W, H, 6, 108)
  const span = w.span ?? WEEK
  return (
    <figure className="mt-8">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full overflow-hidden" role="img" aria-label={label}>
        <defs><pattern id={id} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="4" stroke="var(--ink-2)" strokeWidth="1" /></pattern></defs>
        <path d={c.stop} fill="none" stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
        <path d={c.ticks} fill="none" stroke="var(--ink-3)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d={c.area} fill="var(--ink)" fillOpacity="0.08" />
        <path d={c.band} fill={`url(#${id})`} />
        <path d={c.proj} fill="none" stroke="var(--ink-2)" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
        <path d={c.used} fill="none" stroke="var(--ink)" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <circle cx={c.nx} cy={c.ny} r="3" fill="var(--ink)" />
      </svg>
      {span === WEEK && <div className="mt-1 grid grid-cols-7 font-mono text-[10.5px] text-ink-2" aria-hidden="true">{Array.from({ length: 7 }, (_, i) => <span key={i}>{dayName(w.resetsAt - WEEK + i * DAY)}</span>)}</div>}
    </figure>
  )
}

function Bar({ pct, max }: { pct: number; max: number }) {
  return <span className="relative block h-1 rounded-xs bg-line" aria-hidden="true"><span className="absolute inset-y-0 left-0 rounded-xs bg-ink-2" style={{ width: `${Math.min(100, (100 * pct) / Math.max(1, max))}%` }} /></span>
}

function Rows({ rows, api, kind }: { rows: Row[]; api: boolean; kind: "project" | "role" }) {
  if (!rows.length) return <EmptyState title="Nothing spent yet" />
  const max = Math.max(1, ...rows.map((r) => (api ? r.usd : r.pct)))
  const val = (r: Row) => (api ? usd(r.usd) : `${r.pct}%`)
  const each = (r: Row) => (r.perMerged !== null ? (api ? `≈ ${usd(r.usd / (r.merged || 1))} each` : `≈ ${r.perMerged}% each`) : "")
  return (
    <div role="list" aria-label={kind === "project" ? "By project" : "By role"}>
      {rows.map((r) => (
        <div key={r.name} role="listitem" className={rowBox}>
          <div className={`hidden h-11 items-center gap-x-4 md:grid ${grid}`}>
            <span className="truncate text-base font-medium"><Term k={kind === "role" ? roleKey(r.name) : undefined}>{r.name}</Term></span>
            <Bar pct={api ? r.usd : r.pct} max={max} />
            <span className="justify-self-end font-mono text-[12.5px]">{val(r)}</span>
            <span className="justify-self-end text-sm text-ink-2">{r.countWord}</span>
            <span className="justify-self-end font-mono text-caption text-ink-2">{each(r)}</span>
          </div>
          <div className="py-3 md:hidden">
            <div className="flex items-baseline gap-3"><span className="min-w-0 flex-1 truncate text-lg font-medium"><Term k={kind === "role" ? roleKey(r.name) : undefined}>{r.name}</Term></span><span className="font-mono text-sm">{val(r)}</span></div>
            <div className="mt-2"><Bar pct={api ? r.usd : r.pct} max={max} /></div>
            <div className="mt-1.5 flex gap-3 text-sm text-ink-2"><span>{r.countWord}</span><span className="font-mono text-xs">{each(r)}</span></div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** One past week's readings as a line, with the cap as a dashed rule. */
function Spark({ series, start, cap }: { series: SpendPage["past"][number]["series"]; start: number; cap: number | null }) {
  const y = (u: number) => +(24 - (u / 100) * 22).toFixed(1)
  const pts = series.filter((p) => p.t >= start - 3_600_000 && p.t <= start + WEEK + 3_600_000).map((p) => `${(Math.min(1, Math.max(0, (p.t - start) / WEEK)) * 292).toFixed(1)} ${y(p.pct)}`)
  if (pts.length < 2) return <span className="h-[26px]" />
  const d = `M${pts.join(" L")}`
  return (
    <svg viewBox="0 0 292 26" className="block h-auto w-full" aria-hidden="true">
      {cap !== null && <path d={`M0 ${y(cap)} L292 ${y(cap)}`} fill="none" stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />}
      <path d={`${d} L${pts.at(-1)!.split(" ")[0]} 24 L${pts[0].split(" ")[0]} 24 Z`} fill="var(--ink)" fillOpacity="0.07" />
      <path d={d} fill="none" stroke="var(--ink-2)" strokeWidth="1.25" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Past({ d }: { d: SpendPage }) {
  const api = d.mode === "apiKey"
  return (
    <div role="list" aria-label="Past weeks">
      {d.past.map((p) => (
        <div key={p.start} role="listitem" className={`${rowBox} grid grid-cols-[110px_minmax(0,1fr)_72px] items-center gap-x-4 py-3 md:grid-cols-[140px_minmax(0,1fr)_72px]`}>
          <span className="text-sm">Week of {dueDate(new Date(p.start).toISOString(), true)}</span>
          {p.landed === null ? <span className="text-sm text-ink-2">no reading</span> : <Spark series={p.series} start={p.start} cap={api ? null : d.cap} />}
          <span className="justify-self-end font-mono text-[12.5px]">{p.landed === null ? "" : api ? usd(p.usd) : `${p.landed}%`}</span>
        </div>
      ))}
    </div>
  )
}

export function Spend() {
  const { data: d, error, refetch } = useSpend()
  const snap = useSnapshot().data
  const [tab, setTab] = useState<Tab>("project")
  const [range, setRange] = useState<"week" | "five">("week")
  if (error && !d) return error.message === "signin" ? null : <ErrorState message="The dashboard server did not answer." onRetry={() => refetch()} />
  if (!d) return <Skeleton className="h-24 max-w-xl" />

  const api = d.mode === "apiKey"
  const w = weekOf(snap?.limits, snap?.week.series)
  const five = fiveOf(snap?.limits, d.five?.series)
  const top = d.projects.find((r) => r.name === d.top)
  const took = top ? (top.pct * 2 > Math.max(1, api ? d.projects.reduce((a, r) => a + r.pct, 0) : d.used) ? `${top.name} took most of it.` : `${top.name} used the most.`) : ""
  const headline = api ? `${usd(d.api!.spentUsd)} of ${usd(d.api!.weeklyUsd)} spent this week${d.api!.weeklySet ? "" : ` (7 × your ${usd(d.api!.dailyUsd)} daily cap)`}. ${took}` : w || d.resetsAt ? `${d.used}% of this week used. ${took}` : "No plan reading yet."
  const held = api && ((d.api!.todayUsd ?? 0) >= d.api!.dailyUsd || d.api!.spentUsd >= d.api!.weeklyUsd) // over a cap: builders are paused
  const sub = api
    ? `Dollars over the last 7 days, against your weekly budget. ${held ? "Paused: over the cap." : `Today ${usd(d.api!.todayUsd ?? 0)} of ${usd(d.api!.dailyUsd)}.`}`
    : d.resetsAt
      ? `Shares of your weekly limit since the reset, ${dayName(d.resetsAt - WEEK)} ${clock(d.resetsAt - WEEK)}.`
      : snap?.limits?.line ?? "The plan reading is not available."
  const chart = range === "five" ? five : w
  const chartLabel = range === "five" && five
    ? `5-hour window: ${five.usedPct}% used, resets ${clock(five.resetsAt)}`
    : w ? `Week: ${w.usedPct}% used, lands ${w.landsPct}% ${dayName(w.landsAt)} ${clock(w.landsAt)}, stop at ${w.stopPct}%` : ""

  return (
    <div className="grid gap-x-16 md:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <h1 className="max-w-[24ch] font-display text-[27px] leading-(--leading-display) font-normal tracking-[-0.015em] text-balance md:text-display">{headline}</h1>
        <p className="mt-3.5 text-base text-ink-2">{sub}</p>
        {!api && chart && range === "five" && <p className="mt-3.5 text-sm text-ink-2">{chartLabel}</p>}
        {!api && chart && <Chart w={chart} label={chartLabel} />}

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="mt-8">
          <TabsList variant="line" aria-label="Spend sections" className="h-9 gap-5 max-md:h-12">
            <TabsTrigger value="project" className="flex-none px-0 max-md:min-w-11">By project</TabsTrigger>
            <TabsTrigger value="role" className="flex-none px-0 max-md:min-w-11">By role</TabsTrigger>
            <TabsTrigger value="past" className="flex-none px-0 max-md:min-w-11">Past weeks</TabsTrigger>
          </TabsList>
        </Tabs>
        <section className="mt-3" aria-label={tab === "project" ? "By project" : tab === "role" ? "By role" : "Past weeks"}>
          {tab === "project" && <Rows rows={d.projects} api={api} kind="project" />}
          {tab === "role" && <Rows rows={d.roles} api={api} kind="role" />}
          {tab === "past" && <Past d={d} />}
        </section>
      </div>

      <aside aria-label="This week" className="mt-10 flex flex-col gap-5.5 border-line text-sm md:mt-0 md:border-l md:pl-7">
        <div>
          <div className="text-xl font-medium tracking-[-0.01em]">{api ? "Last 7 days" : "This week"}</div>
          <div className="mt-1 text-ink-2">{api ? "No plan reset on an API key" : d.resetsAt ? `Resets ${dayName(d.resetsAt)} ${clock(d.resetsAt)}` : "Reset time unknown"}</div>
        </div>
        {!api && w && (
          <dl className="flex flex-col gap-2.5">
            <div className="flex"><dt className="text-ink-2">Used so far</dt><dd className="ml-auto font-mono">{w.usedPct}%</dd></div>
            <div className="flex"><dt className="text-ink-2">On pace to land at</dt><dd className="ml-auto font-mono">{w.landsPct}% {dayName(w.landsAt)} {clock(w.landsAt)}</dd></div>
            <div className="flex"><dt className="text-ink-2"><Term k="stop-at">Stop at</Term></dt><dd className="ml-auto font-mono">{w.stopPct}%</dd></div>
            {w.landsText && <p className="text-ink-2">{w.landsText[0].toUpperCase() + w.landsText.slice(1)}.</p>}
            {d.five && <div className="flex"><dt className="text-ink-2"><Term k="five-hour">5-hour window</Term></dt><dd className="ml-auto font-mono">{d.five.used}%{d.five.resetsAt ? `, resets ${clock(d.five.resetsAt)}` : ""}</dd></div>}
          </dl>
        )}
        {api && d.api && (
          <dl className="flex flex-col gap-2.5">
            <div className="flex"><dt className="text-ink-2">Spent, 7 days</dt><dd className="ml-auto font-mono">{usd(d.api.spentUsd)}</dd></div>
            <div className="flex"><dt className="text-ink-2">{d.api.weeklySet ? "Weekly budget" : "Weekly (7 × daily)"}</dt><dd className="ml-auto font-mono">{usd(d.api.weeklyUsd)}</dd></div>
            <div className="flex"><dt className="text-ink-2">Today</dt><dd className="ml-auto font-mono">{usd(d.api.todayUsd ?? 0)} of {usd(d.api.dailyUsd)}{held ? ", paused" : ""}</dd></div>
          </dl>
        )}
        {d.unused && d.unused.weeks > 0 && (
          <p className="m-0 leading-[1.55] text-ink-2">
            {api ? `Unused budget in the last ${d.unused.weeks} weeks: ${usd(d.unused.usd ?? 0)}.` : `Unused plan in the last 4 weeks: ${d.unused.pct}% of one week.${d.unused.weeks < 4 ? ` Only ${d.unused.weeks} of the 4 have a reading.` : ""}`}
          </p>
        )}
        {!api && d.cap !== null && <p className="m-0 leading-[1.55] text-ink-2">Dobby paces builders to reach the week cap, {d.cap}%, by the reset. A week that is behind pace is caught up over about a day.</p>}
      </aside>

      {!api && <Key id="range-week" run={() => setRange("week")} />}
      {!api && <Key id="range-five" run={() => setRange("five")} />}
    </div>
  )
}

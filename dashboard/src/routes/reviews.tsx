import { Button } from "@nimit9/signet-ui/components/button"
import { EmptyState } from "@nimit9/signet-ui/components/empty-state"
import { ErrorState } from "@nimit9/signet-ui/components/error-state"
import { Kbd } from "@nimit9/signet-ui/components/kbd"
import { Skeleton } from "@nimit9/signet-ui/components/skeleton"
import { useListNavigation } from "@nimit9/signet-ui/components/shortcuts"
import { DESKTOP_QUERY, useMediaQuery } from "@nimit9/signet-ui/hooks/use-media-query"
import { useNavigate } from "@tanstack/react-router"
import { Circle, GitMerge, Undo2 } from "lucide-react"
import { useState } from "react"
import type { ReviewRow, ReviewsPage } from "../../../src/api-schema.ts"
import { Key } from "../components/key"
import { UndoStrip } from "../components/undo-strip"
import { useAction } from "../lib/api"
import { useReviews, useTicket } from "../lib/reviews"
import { useSnapshot } from "../lib/snapshot"

const grid = "grid-cols-[16px_112px_minmax(0,1fr)_132px_36px_64px_40px]"
const VERDICT: Record<string, string> = { fail: "Changes requested", pass: "Passed", merged: "Merged", running: "Reviewing", skip: "Skipped", error: "Could not run", accepted: "Accepted" }
const ICON = { fail: Undo2, pass: GitMerge, merged: GitMerge, accepted: GitMerge } as Record<string, typeof Circle>
const rowBox = (on: boolean) => `-mx-3.5 cursor-default rounded-lg border-t border-line px-3.5 outline-offset-2 transition-colors first:border-t-transparent hover:bg-hover ${on ? "border-t-transparent bg-raise shadow-[inset_0_0_0_1px_var(--line)] hover:bg-raise" : ""}`

const Chip = ({ cls, n }: { cls: string; n: number | string }) => <span className="inline-flex items-center gap-1"><span className={`size-[7px] rounded-xs ${cls}`} />{n}</span>
const label = (r: ReviewRow) => `${r.b} blocking, ${r.s} should fix, ${r.n} nits`

function Metrics({ n }: { n: ReviewsPage["numbers"] }) {
  const m = [
    { v: n.sentBackPct ?? "–", unit: n.sentBackPct === null ? "" : "%", k: "needed changes" },
    { v: n.medianMinutes ?? "–", unit: n.medianMinutes === null ? "" : " min", k: "median review" },
    { v: n.reverts, unit: "", k: "reverts after merge" },
  ]
  return (
    <dl className="mt-7 flex flex-wrap border-y border-line md:flex-nowrap">
      {m.map((x, i) => (
        <div key={x.k} className={`min-w-[40%] flex-1 py-3.5 pl-4.5 md:min-w-0 ${i ? "md:border-l md:border-line" : ""}`}>
          <dd className="font-mono text-[22px] tracking-[-0.02em]">{x.v}<span className="text-sm text-ink-2">{x.unit}</span></dd>
          <dt className="mt-1 text-[12.5px] text-ink-2">{x.k}</dt>
        </div>
      ))}
    </dl>
  )
}

function Kinds({ kinds }: { kinds: ReviewsPage["numbers"]["kinds"] }) {
  const max = Math.max(1, ...kinds.map((k) => k.total))
  return (
    <section aria-label="Findings by kind">
      <h2 className="mb-1.5 flex justify-between gap-2 text-sm font-medium text-ink-2">
        <span>Findings by kind</span>
        <span className="inline-flex gap-3.5 font-normal"><Chip cls="bg-warn" n="blocking" /><Chip cls="bg-ink-2" n="should fix" /><Chip cls="bg-ink-3" n="nit" /></span>
      </h2>
      {kinds.length === 0 && <p className="py-3 text-sm text-ink-2">No findings this week.</p>}
      {kinds.map((k) => (
        <div key={k.kind} className="grid h-7 grid-cols-[132px_minmax(0,1fr)_32px] items-center gap-x-3.5 text-sm">
          <span className="truncate">{k.kind}</span>
          <span className="flex h-2 gap-0.5" role="img" aria-label={`${k.b} blocking, ${k.s} should fix, ${k.n} nits`}>
            <span className="rounded-xs bg-warn" style={{ width: `${(100 * k.b) / max}%` }} /><span className="rounded-xs bg-ink-2" style={{ width: `${(100 * k.s) / max}%` }} /><span className="rounded-xs bg-ink-3" style={{ width: `${(100 * k.n) / max}%` }} />
          </span>
          <span className="justify-self-end font-mono text-caption">{k.total}</span>
        </div>
      ))}
    </section>
  )
}

function Trend({ weeks }: { weeks: ReviewsPage["numbers"]["weeks"] }) {
  const pts = weeks.map((w, i) => ({ ...w, x: +(6 + i * 57.6).toFixed(1), y: w.pct === null ? null : +(130 - (w.pct / 40) * 120).toFixed(1) }))
  const real = pts.filter((p): p is typeof p & { y: number } => p.y !== null)
  const line = real.length ? `M${real.map((p) => `${p.x} ${p.y}`).join(" L")}` : ""
  const first = real[0]?.pct, last = real.at(-1)?.pct
  return (
    <section aria-label="Needed-changes rate, 6 weeks">
      <h2 className="mb-1.5 text-sm font-medium text-ink-2">Needed changes, last 6 weeks</h2>
      <svg viewBox="0 0 300 150" className="w-full max-w-[300px]" role="img" aria-label={real.length ? `Needed-changes rate was ${first} percent, now ${last} percent, over six weeks` : "No reviews in the last six weeks"}>
        <path d="M0 130 H300 M0 85 H300 M0 40 H300" stroke="var(--line)" strokeWidth="1" fill="none" />
        {line && <path d={`${line} L${real.at(-1)!.x} 130 L${real[0].x} 130 Z`} fill="var(--ink)" fillOpacity="0.07" />}
        {line && <path d={line} fill="none" stroke="var(--ink)" strokeWidth="1.5" strokeLinejoin="round" />}
        {real.map((p) => <circle key={p.from} cx={p.x} cy={p.y} r="2.5" fill="var(--bg)" stroke="var(--ink)" strokeWidth="1.5" />)}
      </svg>
      <div className="mt-0.5 flex max-w-[300px] justify-between font-mono text-[10.5px] text-ink-2">{pts.map((p) => <span key={p.from}>{p.label}</span>)}</div>
    </section>
  )
}

function Aside({ r, onOpen, onAct }: { r: ReviewRow; onOpen: () => void; onAct: (action: "allowRound" | "decline") => void }) {
  const { data: t } = useTicket(r.ticket ?? undefined)
  const top = t?.findings.find((f) => f.state === "open" && f.severity !== "low")
  return (
    <aside aria-label={`Selected: ${r.ref}`} className="hidden flex-col gap-5.5 border-l border-line pl-7 text-sm md:flex">
      <div>
        <div className="font-mono text-caption text-ink-2">{r.ref} · round {r.round} · {VERDICT[r.verdict]?.toLowerCase()}</div>
        <div className="mt-1.5 text-xl font-medium tracking-[-0.01em]">{r.title}</div>
      </div>
      {t && t.files.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-ink-2">Changes</div>
          {t.files.slice(0, 6).map((f) => (
            <div key={f.path} className="flex items-center gap-2.5 font-mono text-[11.5px]"><span className="truncate">{f.path}</span><span className="ml-auto whitespace-nowrap text-ink-2">+{f.add} −{f.del}</span><span className="w-3.5 text-right text-warn">{f.findings || ""}</span></div>
          ))}
        </div>
      )}
      {top && (
        <div className="border-y border-line py-3">
          <div className="flex items-center gap-2 text-xs"><span className={`size-[7px] rounded-xs ${top.severity === "high" ? "bg-warn" : "bg-ink-2"}`} /><span className={top.severity === "high" ? "text-warn" : ""}>{top.word}</span><span className="font-mono text-ink-2">{top.file}:{top.line}</span></div>
          <p className="mt-2 line-clamp-4 font-display text-[15.5px] leading-[1.45] italic">“{top.text}”</p>
        </div>
      )}
      {r.ticket !== null && (
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-ink-2">
          <Button variant="ghost" size="sm" className="gap-1.5 px-0 text-ink-2" onClick={onOpen}>Open review <Kbd className="font-mono text-xs text-ink-2">↵</Kbd></Button>
          {r.verdict === "fail" && <Button variant="ghost" size="sm" className="gap-1.5 px-0 text-ink-2" onClick={() => onAct("allowRound")}>Allow another round <Kbd className="font-mono text-xs text-ink-2">⇧A</Kbd></Button>}
          {r.verdict === "fail" && <Button variant="ghost" size="sm" className="gap-1.5 px-0 text-ink-2" onClick={() => onAct("decline")}>Decline <Kbd className="font-mono text-xs text-ink-2">X</Kbd></Button>}
        </div>
      )}
    </aside>
  )
}

export function Reviews() {
  const { data, error, refetch } = useReviews()
  const held = useSnapshot().data?.held ?? []
  const act = useAction()
  const go = useNavigate()
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const [activeId, setActiveId] = useState<string>()
  const prs = data?.prs ?? []
  const ids = prs.map((r) => `${r.repo}#${r.pr}`)
  const first = prs.find((r) => r.verdict === "fail") ?? prs[0] // the one with changes requested is what needs a look
  const active = activeId && ids.includes(activeId) ? activeId : first && `${first.repo}#${first.pr}`
  const sel = prs.find((r) => `${r.repo}#${r.pr}` === active)
  const open = (r?: ReviewRow) => { if (r?.ticket != null) void go({ to: "/pr/$id", params: { id: String(r.ticket) } }) }
  const nav = useListNavigation({
    ids, activeId: active, onActiveChange: (k) => { setActiveId(k); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-row="${CSS.escape(k)}"]`)?.focus()) },
    onOpen: (k) => open(prs.find((r) => `${r.repo}#${r.pr}` === k)), group: "Reviews",
  })
  if (error && !data) return error.message === "signin" ? null : <ErrorState message="The dashboard server did not answer." onRetry={() => refetch()} />
  if (!data) return <Skeleton className="h-24 max-w-xl" />
  const n = data.numbers
  const fix = n.findings
  const canRound = !!sel && sel.verdict === "fail" && sel.ticket !== null
  const live = held.filter((h) => h.state === "held")
  const undo = (h: (typeof held)[number]) => act.mutate({ action: "undo", actionId: h.actionId })

  return (
    <div className="grid gap-x-16 md:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <h1 className="max-w-[24ch] font-display text-[27px] leading-(--leading-display) font-normal tracking-[-0.015em] text-balance md:text-display">
          {n.reviewed === 0 ? "No pull requests were reviewed this week." : `${n.reviewed} pull request${n.reviewed === 1 ? "" : "s"} reviewed this week. ${data.scoreboard.sentBack} needed changes.`}
        </h1>
        <p className="mt-3.5 text-base text-ink-2">{fix.total} findings: {fix.fixed} fixed, {fix.dismissed} dismissed, {fix.open} still open.</p>
        <UndoStrip held={held} onUndo={undo} failed={act} />
        <Metrics n={n} />
        <div className="mt-7 grid gap-x-12 gap-y-7 md:grid-cols-[minmax(0,1fr)_300px]"><Kinds kinds={n.kinds} /><Trend weeks={n.weeks} /></div>

        <section aria-label="Reviewed" className="mt-6.5">
          {desktop && prs.length > 0 && <h2 className={`grid ${grid} gap-x-4 pb-1.5 text-label font-medium text-ink-2`}><span /><span>Reviewed</span><span /><span>Findings</span><span>Round</span><span className="justify-self-end">Files</span><span className="justify-self-end">Took</span></h2>}
          {prs.length === 0 ? <EmptyState title="No reviews yet" /> : (
            <div role="listbox" aria-label="Reviewed pull requests" className="flex flex-col">
              {prs.map((r) => {
                const k = `${r.repo}#${r.pr}`, on = k === active, I = ICON[r.verdict] ?? Circle, tone = r.verdict === "fail" ? "text-warn" : "text-ink-2"
                const done = r.verdict !== "running" && r.verdict !== "skip" && r.verdict !== "error"
                return (
                  <div key={k} role="option" aria-selected={on} tabIndex={on ? 0 : -1} data-row={k} onClick={() => nav.setActiveId(k)} onDoubleClick={() => open(r)} className={rowBox(on)}>
                    {desktop ? (
                      <div className={`grid ${grid} h-11 items-center gap-x-4`}>
                        <I className={`size-4 ${tone}`} strokeWidth={1.5} aria-hidden="true" />
                        <span className="font-mono text-caption whitespace-nowrap text-ink-2">{r.ref}</span>
                        <span className="truncate text-base font-medium">{r.title} <span className={`ml-2 text-sm font-normal ${tone}`}>{VERDICT[r.verdict] ?? r.verdict}</span></span>
                        <span className="flex gap-3 font-mono text-caption text-ink-2" role="img" aria-label={done ? label(r) : "findings not in yet"}>{done ? <><Chip cls="bg-warn" n={r.b} /><Chip cls="bg-ink-2" n={r.s} /><Chip cls="bg-ink-3" n={r.n} /></> : "–"}</span>
                        <span className="font-mono text-caption text-ink-2">{r.round}</span>
                        <span className="justify-self-end font-mono text-caption text-ink-2">{r.files ?? "–"}</span>
                        <span className="justify-self-end font-mono text-caption text-ink-2">{r.tookMin ? `${r.tookMin}m` : "…"}</span>
                      </div>
                    ) : (
                      <div className="py-3" onClick={() => open(r)}>
                        <div className="flex items-center gap-3"><I className={`size-4 shrink-0 ${tone}`} strokeWidth={1.5} aria-hidden="true" /><span className="min-w-0 flex-1 truncate text-lg font-medium">{r.title}</span><span className={`text-sm ${tone}`}>{VERDICT[r.verdict] ?? r.verdict}</span></div>
                        <div className="mt-0.5 flex gap-3 pl-7 text-sm text-ink-2"><span className="font-mono text-xs">{r.ref}</span><span>round {r.round}</span>{done && <span className="flex gap-2.5 font-mono text-xs" role="img" aria-label={label(r)}><Chip cls="bg-warn" n={r.b} /><Chip cls="bg-ink-2" n={r.s} /><Chip cls="bg-ink-3" n={r.n} /></span>}</div>
                        {on && r.ticket !== null && <Button size="sm" className="mt-3 w-full max-md:h-11" onClick={(e) => { e.stopPropagation(); open(r) }}>Open review</Button>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
      {sel && <Aside r={sel} onOpen={() => open(sel)} onAct={(action) => sel.ticket != null && act.mutate({ action, id: sel.ticket })} />}

      <Key id="allow-round" run={() => sel?.ticket != null && act.mutate({ action: "allowRound", id: sel.ticket })} enabled={canRound} />
      <Key id="decline" run={() => sel?.ticket != null && act.mutate({ action: "decline", id: sel.ticket })} enabled={canRound} />
      <Key id="undo" run={() => undo(live[live.length - 1])} enabled={live.length > 0} />
    </div>
  )
}

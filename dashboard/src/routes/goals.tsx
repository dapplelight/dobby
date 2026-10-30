import { EmptyState } from "@nimit9/signet-ui/components/empty-state"
import { ErrorState } from "@nimit9/signet-ui/components/error-state"
import { Skeleton } from "@nimit9/signet-ui/components/skeleton"
import { useListNavigation } from "@nimit9/signet-ui/components/shortcuts"
import { DESKTOP_QUERY, useMediaQuery } from "@nimit9/signet-ui/hooks/use-media-query"
import { useState } from "react"
import type { GoalRow } from "../../../src/api-schema.ts"
import { Term } from "../components/term"
import { dueDate } from "../lib/week"
import { useSnapshot } from "../lib/snapshot"

const grid = "grid-cols-[96px_160px_minmax(0,1fr)_52px_80px_210px]"
const MARK = { done: "bg-ink-2", running: "live bg-ink", waiting: "bg-line" } as const
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)

/** One mark per ticket: done, being built (breathes), waiting. */
function Marks({ marks, label }: { marks: GoalRow["marks"]; label: string }) {
  return (
    <span className="flex flex-wrap gap-[3px]" role="img" aria-label={label}>
      {marks.map((m, i) => <span key={i} className={`h-3.5 w-1.5 rounded-[1.5px] ${MARK[m]}`} />)}
    </span>
  )
}
const labelOf = (g: GoalRow) => `${g.done} of ${g.total} tickets done, ${g.marks.filter((m) => m === "running").length} being built, ${g.marks.filter((m) => m === "waiting").length} waiting`

function Aside({ g }: { g: GoalRow }) {
  const left = g.total - g.done
  return (
    <aside aria-label={`Selected: ${g.title}`} className="hidden flex-col gap-5.5 border-l border-line pl-7 text-sm md:flex">
      <div>
        <div className="font-mono text-caption text-ink-2">{g.project}{g.due ? ` · due ${dueDate(g.due)}` : ""}</div>
        <div className="mt-1.5 text-xl font-medium tracking-[-0.01em]">{g.title}</div>
      </div>
      <p className="leading-[1.55]">{left === 0 ? "Every ticket is done." : `${left} left.`}{g.status && left > 0 ? ` ${g.status}.` : ""}</p>
      {g.left.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {g.left.map((t) => (
            <div key={t.id} className="flex items-center gap-2.5">
              <span className={`h-3.5 w-1.5 shrink-0 rounded-[1.5px] ${MARK[t.mark]}`} aria-hidden="true" />
              <span className="font-mono text-caption text-ink-2">{t.ref}</span><span className="truncate">{t.title}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  )
}

export function Goals() {
  const { data, error, refetch } = useSnapshot()
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const [activeId, setActiveId] = useState<number>()
  const goals = data?.goalRows ?? []
  const active = goals.find((g) => g.id === activeId) ?? goals[0]
  const nav = useListNavigation({
    ids: goals.map((g) => String(g.id)), activeId: active && String(active.id), group: "Goals",
    onActiveChange: (k) => { setActiveId(Number(k)); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-row="${k}"]`)?.focus()) },
  })
  if (error && !data) return error.message === "signin" ? null : <ErrorState message="The dashboard server did not answer." onRetry={() => refetch()} />
  if (!data) return <Skeleton className="h-24 max-w-xl" />
  const top = goals[0]

  return (
    <div className="grid gap-x-16 md:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <h1 className="max-w-[24ch] font-display text-[27px] leading-(--leading-display) font-normal tracking-[-0.015em] text-balance md:text-display">
          {top ? `${top.title} is ${top.done} of ${top.total} done.${top.due ? ` Due ${dueDate(top.due)}${top.status ? `, ${lower(top.status)}` : ""}.` : ""}` : "No goals yet."}
        </h1>
        <p className="mt-3.5 text-base text-ink-2">One mark per ticket: done, being built or waiting.</p>
        <section aria-labelledby="goals" className="mt-8">
          <h2 id="goals" className="mb-1.5 flex gap-2 text-sm font-medium text-ink-2"><Term k="goals">Goals</Term> <span className="font-mono">{goals.length}</span></h2>
          {goals.length ? (
            <div role="listbox" aria-label="Goals" className="flex flex-col">
              {goals.map((g) => {
                const on = g.id === active?.id
                return (
                  <div key={g.id} role="option" aria-selected={on} tabIndex={on ? 0 : -1} data-row={g.id} onClick={() => nav.setActiveId(String(g.id))}
                    className={`-mx-3.5 cursor-default rounded-lg border-t border-line px-3.5 outline-offset-2 transition-colors first:border-t-transparent hover:bg-hover ${on ? "border-t-transparent bg-raise shadow-[inset_0_0_0_1px_var(--line)] hover:bg-raise" : ""}`}>
                    {desktop ? (
                      <div className={`grid ${grid} min-h-11 items-center gap-x-4 py-2.5`}>
                        <span className="font-mono text-caption text-ink-2">{g.project}</span>
                        <span className="truncate text-base font-medium">{g.title}</span>
                        <Marks marks={g.marks} label={labelOf(g)} />
                        <span className="justify-self-end font-mono text-caption">{g.done}/{g.total}</span>
                        <span className="justify-self-end font-mono text-caption text-ink-2">{g.due ? dueDate(g.due, true) : ""}</span>
                        <span className={`truncate justify-self-end text-sm ${g.late ? "text-warn" : "text-ink-2"}`}>{g.status}</span>
                      </div>
                    ) : (
                      <div className="py-3">
                        <div className="flex items-baseline gap-3"><span className="min-w-0 flex-1 truncate text-lg font-medium">{g.title}</span><span className="font-mono text-xs">{g.done}/{g.total}</span></div>
                        <div className="mt-0.5 truncate text-sm text-ink-2"><span className="font-mono text-xs">{g.project}</span>{g.due ? ` · ${dueDate(g.due, true)}` : ""}{g.status ? <> · <span className={g.late ? "text-warn" : ""}>{g.status}</span></> : ""}</div>
                        <div className="mt-2.5"><Marks marks={g.marks} label={labelOf(g)} /></div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : <EmptyState title="No goals yet" description="Goals are GitHub milestones in a project's repo, or the Goals list in its dobby.md." />}
        </section>
      </div>
      {active && <Aside g={active} />}
    </div>
  )
}

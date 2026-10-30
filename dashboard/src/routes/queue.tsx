import { Button } from "@nimit9/signet-ui/components/button"
import { EmptyState } from "@nimit9/signet-ui/components/empty-state"
import { ErrorState } from "@nimit9/signet-ui/components/error-state"
import { Kbd } from "@nimit9/signet-ui/components/kbd"
import { Skeleton } from "@nimit9/signet-ui/components/skeleton"
import { useListNavigation } from "@nimit9/signet-ui/components/shortcuts"
import { Tabs, TabsList, TabsTrigger } from "@nimit9/signet-ui/components/tabs"
import { DESKTOP_QUERY, useMediaQuery } from "@nimit9/signet-ui/hooks/use-media-query"
import { GripVertical } from "lucide-react"
import { Reorder, useDragControls } from "motion/react"
import { useEffect, useRef, useState } from "react"
import type { IdeaCard, QueueRow } from "../../../src/api-schema.ts"
import { markFits } from "../../../src/queue-math.ts"
import { Key } from "../components/key"
import { Term } from "../components/term"
import { UndoStrip } from "../components/undo-strip"
import { useAction } from "../lib/api"
import { useSnapshot } from "../lib/snapshot"
import { clock, dayName } from "../lib/week"

const grid = "grid-cols-[22px_112px_minmax(0,1fr)_120px_28px_52px]"
const ordinal = (n: number) => `${n}${n % 100 > 10 && n % 100 < 14 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`
type Tab = "queue" | "backlog" | "ideas"

const rowBox = (on: boolean) => `-mx-3.5 cursor-default rounded-lg border-t border-line px-3.5 outline-offset-2 transition-colors first:border-t-transparent hover:bg-hover ${on ? "border-t-transparent bg-raise shadow-[inset_0_0_0_1px_var(--line)] hover:bg-raise" : ""}`

function Dot({ on }: { on: boolean }) {
  return <span className={`size-1.5 rounded-full bg-ink ${on ? "live" : "hidden"}`} aria-hidden="true" />
}

/** One queued ticket. The handle starts a drag; the rest of the row only selects. */
function Row({ row, fits, on, phone, movable, onSelect, onDrop, send }: { row: QueueRow; fits: boolean; on: boolean; phone: boolean; movable: boolean; onSelect: () => void; onDrop: () => void; send: (name: string) => void }) {
  const controls = useDragControls()
  const handle = movable && (
    <button
      type="button" aria-label={`Drag ${row.title}`} onPointerDown={(e) => { onSelect(); controls.start(e) }}
      onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); send(e.key === "ArrowUp" ? "up" : "down") } }}
      className="absolute top-1/2 -left-6 hidden size-6 -translate-y-1/2 cursor-grab touch-none items-center justify-center text-ink-3 group-hover/row:flex group-aria-selected/row:flex max-md:static max-md:size-11 max-md:translate-y-0"
    >
      <GripVertical className="size-4" aria-hidden="true" />
    </button>
  )
  const body = phone ? (
    <div className="py-3">
      <div className="flex items-center gap-3">
        <Dot on={row.running} /><span className="min-w-0 flex-1 truncate text-lg font-medium">{row.title}</span>
        <span className="font-mono text-xs">{row.estPct}%</span>
      </div>
      <div className="mt-0.5 truncate text-sm text-ink-2"><span className="font-mono text-xs">{row.ref}</span> · {row.state} · {row.size}</div>
      {on && movable && (
        <span className="mt-3 flex gap-2.5 text-sm text-ink-2">
          <Button variant="ghost" size="sm" className="max-md:h-11 max-md:flex-1" onClick={() => send("up")}>Move up</Button>
          <Button variant="ghost" size="sm" className="max-md:h-11 max-md:flex-1" onClick={() => send("down")}>Move down</Button>
          <Button variant="ghost" size="sm" className="max-md:h-11 max-md:flex-1" onClick={() => send("unqueue")}>Back to backlog</Button>
        </span>
      )}
    </div>
  ) : (
    <div className={`grid ${grid} h-11 items-center gap-x-4`}>
      <span className="font-mono text-caption text-ink-2">{row.n}</span>
      <span className="truncate font-mono text-caption whitespace-nowrap text-ink-2">{row.ref}</span>
      <span className="truncate text-base font-medium">{row.title}</span>
      <span className={`inline-flex items-center gap-1.5 truncate text-sm ${row.waitsOn ? "text-warn" : "text-ink-2"}`}><Dot on={row.running} />{row.state}</span>
      <span className="font-mono text-caption text-ink-2">{row.size}</span>
      <span className="justify-self-end font-mono text-caption text-ink">{row.estPct}%</span>
    </div>
  )
  const cls = `${rowBox(on)} group/row relative ${fits ? "" : "opacity-60"}`
  if (!movable) return <div role="option" aria-selected={on} tabIndex={on ? 0 : -1} data-row={row.id} onClick={onSelect} className={cls}>{body}</div>
  return (
    <Reorder.Item
      as="div" value={row.id} dragListener={false} dragControls={controls} onDragEnd={onDrop} transition={{ type: "spring", stiffness: 520, damping: 38 }}
      role="option" aria-selected={on} tabIndex={on ? 0 : -1} data-row={row.id} onClick={onSelect} className={cls}
      whileDrag={{ scale: 1.01, boxShadow: "0 8px 24px rgb(0 0 0 / 0.35)", backgroundColor: "var(--raise)", zIndex: 5 }}
    >
      {phone ? <div className="flex items-start gap-1">{on && handle}<div className="min-w-0 flex-1">{body}</div></div> : <>{handle}{body}</>}
    </Reorder.Item>
  )
}

function StopLine({ stop, resets, allFit }: { stop: number | null; resets: number | null; allFit: boolean }) {
  return (
    <div role="presentation" data-stop-line className="flex h-9 items-center gap-3 font-mono text-caption text-ink-2">
      <span className="flex-1 border-t border-dashed border-ink-3" />
      <span className="text-center">stop line{stop ? ` · ${stop}%` : ""} · {allFit ? "everything above fits" : resets ? `what is below waits for ${dayName(resets)} ${clock(resets)}` : "what is below waits"}</span>
      <span className="flex-1 border-t border-dashed border-ink-3" />
    </div>
  )
}

function Aside({ row, nth, send }: { row: QueueRow; nth: number; send: (name: string) => void }) {
  return (
    <aside aria-label={`Selected: ${row.ref}`} className="hidden flex-col gap-5.5 border-l border-line pl-7 text-sm md:flex">
      <div>
        <div className="font-mono text-caption text-ink-2">{row.ref} · {row.running ? "building" : `${ordinal(nth)} in line`}</div>
        <div className="mt-1.5 text-xl font-medium tracking-[-0.01em]">{row.title}</div>
      </div>
      {row.doneWhen && <div><div className="text-ink-2"><Term k="done-when">Done when</Term></div><p className="mt-1.5 leading-[1.55]">{row.doneWhen}</p></div>}
      <dl className="flex flex-col gap-2.5">
        <div className="flex"><dt className="text-ink-2">Size</dt><dd className="ml-auto font-mono">{row.size}</dd></div>
        <div className="flex"><dt className="text-ink-2">Estimate</dt><dd className="ml-auto font-mono">{row.estPct}% of the week</dd></div>
        <div className="flex"><dt className="text-ink-2">Waits on</dt><dd className="ml-auto">{row.waitsOn === "paused" ? "a pause" : (row.waitsOn ?? "nothing")}</dd></div>
        <div className="flex"><dt className="text-ink-2">Filed</dt><dd className="ml-auto">{row.filed} ago</dd></div>
      </dl>
      {!row.running && (
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-ink-2">
          <Button variant="ghost" size="sm" className="gap-1.5 px-0 text-ink-2" onClick={() => send("pause")}>Pause <Kbd className="font-mono text-xs text-ink-2">P</Kbd></Button>
          <Button variant="ghost" size="sm" className="gap-1.5 px-0 text-ink-2" onClick={() => send("up")}>Move up <Kbd className="font-mono text-xs text-ink-2">⇧K</Kbd></Button>
          <Button variant="ghost" size="sm" className="gap-1.5 px-0 text-ink-2" onClick={() => send("down")}>Move down <Kbd className="font-mono text-xs text-ink-2">⇧J</Kbd></Button>
          <Button variant="ghost" size="sm" className="gap-1.5 px-0 text-ink-2" onClick={() => send("unqueue")}>Back to backlog <Kbd className="font-mono text-xs text-ink-2">B</Kbd></Button>
        </div>
      )}
    </aside>
  )
}

function Ideas({ ideas, active, onSelect, send, phone }: { ideas: IdeaCard[]; active?: number; onSelect: (id: number) => void; send: (name: string, id: number) => void; phone: boolean }) {
  if (!ideas.length) return <EmptyState title="No ideas" description="The Product Manager, the Engineering Manager and the Scout add them here." />
  return (
    <div role="listbox" aria-label="Ideas" className="flex flex-col">
      {ideas.map((i) => (
        <div key={i.id} role="option" aria-selected={i.id === active} tabIndex={i.id === active ? 0 : -1} data-row={i.id} onClick={() => onSelect(i.id)} className={`${rowBox(i.id === active)} py-3.5`}>
          <div className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 text-base font-medium">{i.title}</span>
            <span className="font-mono text-caption whitespace-nowrap text-ink-2">{i.project} · {i.size ?? "?"}{i.score != null ? ` · score ${i.score}` : ""}</span>
          </div>
          <div className="mt-1 text-sm text-ink-2">From {i.source === "you" ? "you" : i.source}{i.lens ? `, ${i.lens}` : ""}</div>
          {i.why && <p className="mt-2 max-w-[70ch] text-sm leading-[1.55]">{i.why}</p>}
          {i.id === active && (
            <span className={`mt-3 flex items-center gap-3.5 text-sm text-ink-2 ${phone ? "flex-wrap" : ""}`}>
              <Button size="sm" className="gap-2 font-semibold max-md:h-11 max-md:flex-1" onClick={() => send("makeTicket", i.id)}>Make a ticket <kbd className="font-mono text-xs opacity-70">↵</kbd></Button>
              <Button variant="ghost" size="sm" className="gap-1.5 text-ink-2 max-md:h-11" onClick={() => send("dismissIdea", i.id)}>Dismiss <Kbd className="font-mono text-xs text-ink-2">X</Kbd></Button>
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

export function Queue() {
  const { data, error, refetch } = useSnapshot()
  const act = useAction()
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const [tab, setTab] = useState<Tab>("queue")
  const [activeId, setActiveId] = useState<number>()
  const [local, setLocal] = useState<number[] | null>(null) // the ready tickets' order while a move is on its way to the server
  const latest = useRef<number[]>([])

  const q = data?.queue
  const serverReady = (q?.order ?? []).filter((r) => !r.running).map((r) => r.id)
  const serverKey = serverReady.join(",")
  useEffect(() => setLocal(null), [serverKey])
  const readyIds = local ?? serverReady
  latest.current = readyIds
  const byId = new Map((q?.order ?? []).map((r) => [r.id, r]))
  const view = [...(q?.order ?? []).filter((r) => r.running), ...readyIds.map((id) => byId.get(id)).filter((r): r is QueueRow => !!r)]
  const fits = markFits(view, q?.room ?? null)
  const cut = fits.indexOf(false)
  const running = view.filter((r) => r.running).length

  const ids = tab === "queue" ? view.map((r) => r.id) : tab === "backlog" ? (q?.parked ?? []).map((r) => r.id) : (q?.ideas ?? []).map((r) => r.id)
  const active = activeId !== undefined && ids.includes(activeId) ? activeId : ids[0]
  const focus = (id: number) => requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-row="${id}"]`)?.focus())
  const nav = useListNavigation({
    ids: ids.map(String), activeId: active === undefined ? undefined : String(active), onActiveChange: (k) => { setActiveId(Number(k)); focus(Number(k)) },
    onOpen: (k) => (tab === "backlog" ? send("queue", Number(k)) : tab === "ideas" ? send("makeTicket", Number(k)) : undefined), group: "Queue",
  })

  function send(name: string, id: number) {
    if (name === "queue") return act.mutate({ action: "queue", ticket: id })
    if (name === "makeTicket" || name === "dismissIdea") return act.mutate({ action: name, idea: id })
    act.mutate({ action: name, id }) // unqueue, pause
  }
  /** Tell the server where `id` now sits: just above whatever follows it among the ready tickets, or last. */
  function commit(next: number[], id: number) {
    if (next.join(",") === serverKey) return
    setLocal(next)
    const before = next[next.indexOf(id) + 1]
    act.mutate({ action: "reorder", id, ...(before ? { before } : {}) }, { onSettled: () => setLocal(null) })
  }
  function move(id: number, by: -1 | 1) {
    const at = latest.current.indexOf(id), to = at + by
    if (at < 0 || to < 0 || to >= latest.current.length) return
    const next = [...latest.current]; next.splice(at, 1); next.splice(to, 0, id)
    commit(next, id); focus(id)
  }

  if (error && !data) return error.message === "signin" ? null : <ErrorState message="The dashboard server did not answer." onRetry={() => refetch()} />
  if (!data || !q) return <Skeleton className="h-24 max-w-xl" />

  const selected = tab === "queue" ? view.find((r) => r.id === active) : undefined
  const movable = !!selected && !selected.running
  const held = data.held
  const undo = (h: (typeof held)[number]) => act.mutate({ action: "undo", actionId: h.actionId })
  const live = held.filter((h) => h.state === "held")
  const count = (n: number) => <span className="ml-1.5 font-mono text-ink-2">{n}</span>
  const resets = q.resetsAt

  return (
    <div className={`grid gap-x-16 ${tab === "ideas" ? "" : "md:grid-cols-[minmax(0,1fr)_320px]"}`}>
      <div className="min-w-0">
        <h1 className="max-w-[24ch] font-display text-[27px] leading-(--leading-display) font-normal tracking-[-0.015em] text-balance md:text-display">
          {view.length === 0 ? "Nothing is queued." : cut < 0 ? `${view.length} queued. All of them fit before the stop.` : `${view.length} queued. The first ${cut} fit before the ${q.stopPct}% stop.`}
        </h1>
        {!q.stopPct && <p className="mt-3.5 text-base text-ink-2">No plan reading yet, so nothing is cut.</p>}

        <UndoStrip held={held} onUndo={undo} failed={act} />

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="mt-8">
          <TabsList variant="line" aria-label="Queue sections" className="h-9 gap-5 max-md:h-12">
            <TabsTrigger value="queue" className="flex-none px-0 max-md:min-w-11">Queue{count(view.length)}</TabsTrigger><Term k="queue">{null}</Term>
            <TabsTrigger value="backlog" className="flex-none px-0 max-md:min-w-11">Backlog{count(q.parked.length)}</TabsTrigger><Term k="backlog">{null}</Term>
            <TabsTrigger value="ideas" className="flex-none px-0 max-md:min-w-11">Ideas{count(q.ideas.length)}</TabsTrigger><Term k="ideas">{null}</Term>
          </TabsList>
        </Tabs>

        <section aria-label={tab} className="mt-5">
          {tab === "queue" && (view.length ? (
            <>
              {desktop && <h2 className={`grid ${grid} gap-x-4 pb-1.5 text-label font-medium text-ink-2`}><span>#</span><span>Ticket</span><span /><span><Term k="ready">State</Term></span><span><Term k="size">Size</Term></span><span className="justify-self-end">Week</span></h2>}
              <div role="listbox" aria-label="Fits this week" className="flex flex-col">
                {view.slice(0, running).map((r, i) => (
                  <div key={r.id}>
                    {cut === i && <StopLine stop={q.stopPct} resets={resets} allFit={false} />}
                    <Row row={r} fits={fits[i]} on={r.id === active} phone={!desktop} movable={false} onSelect={() => nav.setActiveId(String(r.id))} onDrop={() => {}} send={() => {}} />
                  </div>
                ))}
                <Reorder.Group as="div" axis="y" values={readyIds} onReorder={setLocal} className="flex flex-col">
                  {readyIds.map((id, k) => {
                    const r = byId.get(id)
                    if (!r) return null
                    return (
                      <div key={id} className="contents">
                        {cut === running + k && <StopLine stop={q.stopPct} resets={resets} allFit={false} />}
                        <Row row={r} fits={fits[running + k]} on={id === active} phone={!desktop} movable onSelect={() => nav.setActiveId(String(id))} onDrop={() => commit(latest.current, id)}
                          send={(n) => (n === "up" ? move(id, -1) : n === "down" ? move(id, 1) : send(n, id))} />
                      </div>
                    )
                  })}
                </Reorder.Group>
                {cut < 0 && <StopLine stop={q.stopPct} resets={resets} allFit />}
              </div>
            </>
          ) : <EmptyState title="Nothing is queued" description="Queue a ticket from the Backlog tab, or press N to write a new one." />)}

          {tab === "backlog" && (q.parked.length ? (
            <div role="listbox" aria-label="Backlog" className="flex flex-col">
              {q.parked.map((t) => (
                <div key={t.id} role="option" aria-selected={t.id === active} tabIndex={t.id === active ? 0 : -1} data-row={t.id} onClick={() => nav.setActiveId(String(t.id))} className={rowBox(t.id === active)}>
                  {desktop ? (
                    <div className="grid h-11 grid-cols-[112px_minmax(0,1fr)_auto_28px_52px] items-center gap-x-4">
                      <span className="truncate font-mono text-caption text-ink-2">{t.ref}</span>
                      <span className="truncate text-base font-medium">{t.title}</span>
                      {t.id === active ? <Button size="sm" className="gap-2 font-semibold" onClick={() => send("queue", t.id)}>Queue <kbd className="font-mono text-xs opacity-70">↵</kbd></Button> : <span className="text-sm text-ink-2">{t.age}</span>}
                      <span className="font-mono text-caption text-ink-2">{t.size}</span>
                      <span className="justify-self-end font-mono text-caption">{t.estPct}%</span>
                    </div>
                  ) : (
                    <div className="py-3">
                      <div className="truncate text-lg font-medium">{t.title}</div>
                      <div className="mt-0.5 truncate text-sm text-ink-2"><span className="font-mono text-xs">{t.ref}</span> · {t.size} · {t.estPct}% · {t.age}</div>
                      {t.id === active && <Button size="sm" className="mt-3 w-full gap-2 font-semibold max-md:h-11" onClick={() => send("queue", t.id)}>Queue</Button>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : <EmptyState title="The backlog is empty" description="Tickets filed by agents, and tickets you move back, wait here." />)}

          {tab === "ideas" && <Ideas ideas={q.ideas} active={active} onSelect={(id) => nav.setActiveId(String(id))} send={send} phone={!desktop} />}
        </section>
      </div>
      {tab !== "ideas" && selected && <Aside row={selected} nth={readyIds.indexOf(selected.id) + 1} send={(n) => (n === "up" ? move(selected.id, -1) : n === "down" ? move(selected.id, 1) : send(n, selected.id))} />}

      <Key id="reorder-up" run={() => selected && move(selected.id, -1)} enabled={tab === "queue" && movable} />
      <Key id="reorder-down" run={() => selected && move(selected.id, 1)} enabled={tab === "queue" && movable} />
      <Key id="unqueue" run={() => selected && send("unqueue", selected.id)} enabled={tab === "queue" && movable} />
      <Key id="pause-ticket" run={() => selected && send("pause", selected.id)} enabled={tab === "queue" && !!selected} />
      <Key id="dismiss-idea" run={() => active !== undefined && send("dismissIdea", active)} enabled={tab === "ideas" && active !== undefined} />
      <Key id="undo" run={() => undo(live[live.length - 1])} enabled={live.length > 0} />
    </div>
  )
}

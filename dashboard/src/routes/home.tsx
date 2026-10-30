import { Button } from "@nimit9/signet-ui/components/button"
import { ErrorState } from "@nimit9/signet-ui/components/error-state"
import { Kbd } from "@nimit9/signet-ui/components/kbd"
import { Skeleton } from "@nimit9/signet-ui/components/skeleton"
import { useListNavigation } from "@nimit9/signet-ui/components/shortcuts"
import { DESKTOP_QUERY, useMediaQuery } from "@nimit9/signet-ui/hooks/use-media-query"
import { Link } from "@tanstack/react-router"
import { ChevronRight } from "lucide-react"
import { AnimatePresence, m, useMotionValue, useReducedMotion, useTransform } from "motion/react"
import { lazy, Suspense, useEffect, useRef, useState } from "react"
import type { Held, InboxRow, WorkingRow } from "../../../src/api-schema.ts"
import { CheckDots, DiffBar, KindIcon, RoundStripe } from "../components/glyphs"
import { HoldKeys, Key } from "../components/key"
import { Term } from "../components/term"
import { UndoStrip } from "../components/undo-strip"
import { roleKey } from "../lib/glossary"
import { useAction } from "../lib/api"
import { useSession } from "../lib/session"
import { SWIPE_AT, swipeAction } from "../lib/swipe"
import { useSnapshot } from "../lib/snapshot"
import { noUrls } from "../lib/states"
import { dayName, weekOf } from "../lib/week"

const WordsDialog = lazy(() => import("../components/dialogs").then((m) => ({ default: m.WordsDialog })))

const OFFER_KEY: Record<string, { label: string; key: string }> = { decline: { label: "Decline", key: "X" }, takeOver: { label: "Take over", key: "T" }, allowRound: { label: "One more round", key: "⇧A" } }
const grid = "grid-cols-[16px_112px_minmax(0,1fr)_236px_48px_44px_36px]"
const spring = { type: "spring", stiffness: 520, damping: 38 } as const

/** A row is hidden while an action on it is held or has just run: it leaves, the strip takes its place, and an undo brings it back. */
const isHeld = (r: InboxRow, held: Held[]) => held.some((h) => h.state !== "failed" && (r.id !== null ? h.id === r.id : h.action === "deploy" && h.project === r.project))

/** Phone: drag a row right for its main action, left to decline. A cue shows behind it; past the threshold the same call as the buttons goes out, so the 8 s hold and Undo apply. Off with reduced motion (the buttons stay). */
function Swipe({ row, raised, onPrimary, onDecline, children }: { row: InboxRow; raised: boolean; onPrimary: () => void; onDecline: () => void; children: React.ReactNode }) {
  const reduced = useReducedMotion() ?? false
  const x = useMotionValue(0)
  const right = useTransform(x, [0, SWIPE_AT], [0, 1]), left = useTransform(x, [-SWIPE_AT, 0], [1, 0])
  if (reduced) return <>{children}</>
  return (
    <div className="relative overflow-hidden rounded-lg" data-swipe>
      <m.div aria-hidden="true" style={{ opacity: right }} className="absolute inset-0 flex items-center gap-2 bg-mark pl-4 text-sm font-semibold text-on-mark">{row.primary}</m.div>
      {row.offers.includes("decline") && <m.div aria-hidden="true" style={{ opacity: left }} className="absolute inset-0 flex items-center justify-end gap-2 bg-warn pr-4 text-sm font-semibold text-background">Decline</m.div>}
      <m.div
        drag="x" dragDirectionLock dragSnapToOrigin dragConstraints={{ left: 0, right: 0 }} dragElastic={0.6} style={{ x }} className={`relative touch-pan-y ${raised ? "bg-raise" : "bg-background"}`}
        onDragEnd={(_, info) => { const a = swipeAction(info.offset.x, { offers: row.offers, reduced }); if (a === "primary") onPrimary(); else if (a === "decline") onDecline() }}
      >
        {children}
      </m.div>
    </div>
  )
}

function Row({ row, on, phone, locked, onSelect, onPrimary, send }: { row: InboxRow; on: boolean; phone: boolean; locked: boolean; onSelect: () => void; onPrimary: () => void; send: (name: string) => void }) {
  const secondary = row.offers.filter((o) => OFFER_KEY[o])
  const actions = (
    <span className={`flex items-center gap-3.5 text-sm text-ink-2 ${phone ? "mt-3 flex-wrap" : "col-start-4 col-end-8 justify-self-end"}`}>
      <Button size="sm" disabled={locked} className="gap-2 font-semibold max-md:h-11 max-md:flex-1" onClick={onPrimary}>{row.primary} <kbd className="font-mono text-xs opacity-70">↵</kbd></Button>
      {secondary.map((o) => (
        <Button key={o} variant="ghost" size="sm" disabled={locked} className="gap-1.5 text-ink-2 max-md:h-11" onClick={() => send(o)}>{OFFER_KEY[o].label} <Kbd className="font-mono text-xs text-ink-2">{OFFER_KEY[o].key}</Kbd></Button>
      ))}
      {row.url && <Button variant="ghost" size="sm" className="gap-1.5 text-ink-2 max-md:h-11" render={<a href={row.url} target="_blank" rel="noreferrer noopener" />}>Open <Kbd className="font-mono text-xs text-ink-2">O</Kbd></Button>}
    </span>
  )
  return (
    <m.div
      layout="position" transition={{ layout: spring }} exit={{ height: 0, opacity: 0, transition: { duration: 0.18 } }}
      role="option" aria-selected={on} tabIndex={on ? 0 : -1} data-row={row.key}
      onClick={onSelect} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) { e.preventDefault(); onPrimary() } }}
      className={`-mx-3.5 cursor-default overflow-hidden rounded-lg border-t border-line px-3.5 outline-offset-2 transition-colors first:border-t-transparent hover:bg-hover ${on ? "border-t-transparent bg-raise shadow-[inset_0_0_0_1px_var(--line)] hover:bg-raise" : ""}`}
    >
      {phone ? (
        <Swipe row={row} raised={on} onPrimary={onPrimary} onDecline={() => send("decline")}>
        <div className="py-3">
          <div className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-x-3">
            <span className="mt-0.5"><KindIcon kind={row.kind} /></span>
            <div className="min-w-0">
              <div className="truncate text-lg font-medium">{row.title}</div>
              <div className="mt-0.5 truncate text-sm text-ink-2"><span className="font-mono text-xs">{row.ref}</span> · {noUrls(row.status)}</div>
            </div>
            <span className="mt-0.5 flex items-center gap-1 font-mono text-xs text-ink-2">{row.age}{!on && <ChevronRight aria-hidden="true" className="size-4" />}</span>
          </div>
          {on && actions}
        </div>
        </Swipe>
      ) : (
        <div className={`grid ${grid} h-11 items-center gap-x-4`}>
          <KindIcon kind={row.kind} />
          <span className="truncate font-mono text-caption text-ink-2">{row.ref}</span>
          <span className="truncate text-base font-medium">{row.title}</span>
          {on ? actions : <span className={`truncate text-sm ${row.warn ? "text-warn" : "text-ink-2"}`}>{noUrls(row.status)}</span>}
          {!on && <><DiffBar diff={row.diff} /><CheckDots checks={row.checks} /><span className="justify-self-end font-mono text-xs text-ink-2">{row.age}</span></>}
        </div>
      )}
    </m.div>
  )
}

function WorkingRowView({ row, phone }: { row: WorkingRow; phone: boolean }) {
  return (
    <m.div layout="position" transition={{ layout: spring }} exit={{ height: 0, opacity: 0, transition: { duration: 0.18 } }} className="-mx-3.5 border-t border-line px-3.5 first:border-t-transparent hover:bg-hover">
      {phone ? (
        <div className="py-3">
          <div className="flex items-center gap-3"><RoundStripe row={row} /><span className="min-w-0 flex-1 truncate text-lg">{row.title}</span><span className="font-mono text-xs text-ink-2">{row.age}</span></div>
          <div className="mt-0.5 pl-[22px] text-sm text-ink-2"><span className="font-mono text-xs">{row.ref}</span> · {row.role}, round {row.round} of {row.of}, {row.step}</div>
          {row.stuck && <div className="mt-1 flex items-center gap-3 pl-[22px] text-sm"><span className="text-warn">Stuck: no change for {row.age}</span><Link to="/pr/$id" params={{ id: String(row.id) }} className="inline-flex min-h-11 items-center text-ink underline underline-offset-4">See last step</Link></div>}
        </div>
      ) : (
        <div className={`grid ${grid} h-11 items-center gap-x-4`}>
          <RoundStripe row={row} />
          <span className="text-sm text-ink-2"><Term k={roleKey(row.role)}>{row.role}</Term></span>
          <span className="truncate text-base"><span className="mr-2.5 font-mono text-caption text-ink-2">{row.ref}</span>{row.title}</span>
          <span className={`text-sm whitespace-nowrap ${row.stuck ? "text-warn" : "text-ink-2"}`}>{row.stuck ? `Stuck: no change for ${row.age}` : `Round ${row.round} of ${row.of} · ${row.step}`}</span>
          {row.stuck ? <Link to="/pr/$id" params={{ id: String(row.id) }} className="col-span-2 text-sm whitespace-nowrap text-ink underline underline-offset-4">See last step</Link> : <><span /><span /></>}
          <span className="justify-self-end font-mono text-xs text-ink-2">{row.age}</span>
        </div>
      )}
    </m.div>
  )
}

const STATE = { pass: "passed", fail: "failed", wait: "waiting" } as const
function Aside({ row, copied, onCopy }: { row: InboxRow; copied: boolean; onCopy: () => void }) {
  return (
    <aside aria-label={`Selected: ${row.ref}`} className="hidden flex-col gap-5.5 border-l border-line pl-7 text-sm md:flex">
      <div>
        <div className="font-mono text-caption text-ink-2">{row.ref}{row.branch ? ` · ${row.branch}` : ""}</div>
        <div className="mt-1.5 text-xl font-medium tracking-[-0.01em]">{row.title}</div>
      </div>
      <p className={row.warn ? "text-warn" : "text-ink-2"}>{row.status}</p>
      {row.checks.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {row.checks.map((c) => <div key={c.name} className="flex items-center gap-2.5"><span>{c.name}</span><span className={`ml-auto font-mono text-xs ${c.state === "fail" ? "text-warn" : "text-ink-2"}`}>{STATE[c.state]}</span></div>)}
        </div>
      )}
      {row.diff && <div className="font-mono text-caption leading-[1.7] text-ink-2"><span className="text-ink">+{row.diff.add}</span> −{row.diff.del} in {row.diff.files} files</div>}
      {row.branch && (
        <Button variant="ghost" size="sm" className="w-fit gap-1.5 text-ink-2" onClick={onCopy}>
          {copied ? "Copied" : "Copy branch"} <Kbd className="font-mono text-xs text-ink-2">C</Kbd>
        </Button>
      )}
    </aside>
  )
}

export function Home() {
  const { data, error, refetch } = useSnapshot()
  const act = useAction()
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const { canAct } = useSession()
  const [words, setWords] = useState<{ mode: "answer" | "hint"; ticket: { id: number; ref: string; title: string } } | null>(null)
  const [activeKey, setActiveKey] = useState<string>()
  const [copied, setCopied] = useState(false)
  const held = data?.held ?? []
  const rows = (data?.inbox.rows ?? []).filter((r) => !isHeld(r, held))
  const active = rows.find((r) => r.key === activeKey) ?? rows[0]

  const copyBranch = () => { if (!active?.branch) return; void navigator.clipboard?.writeText(active.branch); setCopied(true); setTimeout(() => setCopied(false), 2000) }
  // after an action the row leaves; focus goes to the row now selected, not the page body
  const seen = useRef<string | undefined>(undefined)
  useEffect(() => {
    const k = active?.key
    if (k && seen.current && k !== seen.current && (!document.activeElement || document.activeElement === document.body)) document.querySelector<HTMLElement>(`[data-row="${k}"]`)?.focus()
    seen.current = k
  }, [active?.key])

  const send = (row: InboxRow, name: string) => {
    if (name === "deploy") return act.mutate({ action: "deploy", project: row.project })
    if (row.id === null) return
    if (name === "answer") return setWords({ mode: "answer", ticket: { id: row.id, ref: row.ref, title: row.title } })
    act.mutate({ action: name, id: row.id })
  }
  const primary = (row: InboxRow) => send(row, row.kind === "merge" ? "merge" : row.kind === "deploy" ? "deploy" : row.kind === "answer" ? "answer" : "retry")
  const nav = useListNavigation({ ids: rows.map((r) => r.key), activeId: active?.key, onActiveChange: (k) => { setActiveKey(k); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-row="${k}"]`)?.focus()) }, onOpen: () => active && primary(active), group: "Inbox", arrows: true })

  if (error && !data) return error.message === "signin" ? null : <ErrorState message="The dashboard server did not answer." onRetry={() => refetch()} />
  if (!data) return <Skeleton className="h-24 max-w-xl" />

  const offered = (name: string) => !!active && active.offers.includes(name)
  const undo = (h: Held) => act.mutate({ action: "undo", actionId: h.actionId })
  const live = held.filter((h) => h.state === "held")
  const w = weekOf(data.limits, data.week.series)
  const n = data.inbox.total
  const working = data.working

  return (
    <div className="grid gap-x-16 md:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <h1 className="max-w-[22ch] font-display text-[27px] leading-(--leading-display) font-normal tracking-[-0.015em] text-balance md:text-display">
          {w ? `On pace to use ${w.landsPct}% of this week. ` : ""}
          {n === 0 ? "Nothing needs you." : <><span className="text-mark">{n === 1 ? "1 thing needs" : `${n} things need`}</span> you.</>}
        </h1>
        <p className="mt-3.5 text-base text-ink-2">{data.outcomes.shipped} merged in the last {data.days} days · {data.now.ready.length} ready{w ? ` · resets ${dayName(w.resetsAt)}` : ""}</p>

        <UndoStrip held={held} onUndo={undo} failed={act} />

        <section aria-labelledby="needs" className="mt-5">
          <h2 id="needs" className="mb-1.5 text-sm font-medium text-ink-2"><Term k="needs-you">Needs you</Term></h2>
          {rows.length ? (
            <div role="listbox" aria-label="Needs you" className="flex flex-col">
              <AnimatePresence initial={false}>
                {rows.map((r) => <Row key={r.key} row={r} on={r.key === active?.key} phone={!desktop} locked={!canAct} onSelect={() => nav.setActiveId(r.key)} onPrimary={() => primary(r)} send={(name) => send(r, name)} />)}
              </AnimatePresence>
            </div>
          ) : <p className="py-3 text-sm text-ink-2">No merges, deploys or questions waiting.</p>}
        </section>

        <section aria-labelledby="work" className="mt-8">
          <h2 id="work" className="mb-1.5 flex gap-2 text-sm font-medium text-ink-2">Working <span className="font-mono">{working.length}</span></h2>
          {working.length ? <div className="flex flex-col"><AnimatePresence initial={false}>{working.map((r) => <WorkingRowView key={r.key} row={r} phone={!desktop} />)}</AnimatePresence></div> : <p className="py-3 text-sm text-ink-2">Nothing is building.</p>}
        </section>
      </div>
      {active && <Aside row={active} copied={copied} onCopy={copyBranch} />}

      <Key id="decline" run={() => send(active!, "decline")} enabled={offered("decline")} />
      <Key id="take-over" run={() => send(active!, "takeOver")} enabled={offered("takeOver")} />
      <Key id="allow-round" run={() => send(active!, "allowRound")} enabled={offered("allowRound")} />
      <Key id="pause-ticket" run={() => active?.id != null && act.mutate({ action: "pause", id: active.id })} enabled={active?.id != null} />
      <Key id="hint" run={() => active?.id != null && setWords({ mode: "hint", ticket: { id: active.id, ref: active.ref, title: active.title } })} enabled={active?.id != null} />
      <Key id="open" run={() => active?.url && window.open(active.url, "_blank", "noopener,noreferrer")} enabled={!!active?.url} />
      <Key id="copy-branch" run={copyBranch} enabled={!!active?.branch} />
      <Key id="undo" run={() => undo(live[live.length - 1])} enabled={live.length > 0} />
      {words && <Suspense fallback={<HoldKeys />}><WordsDialog mode={words.mode} ticket={words.ticket} onClose={() => setWords(null)} /></Suspense>}
    </div>
  )
}

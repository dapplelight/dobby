import { Button } from "@nimit9/signet-ui/components/button"
import { EmptyState } from "@nimit9/signet-ui/components/empty-state"
import { ErrorState } from "@nimit9/signet-ui/components/error-state"
import { Kbd } from "@nimit9/signet-ui/components/kbd"
import { Skeleton } from "@nimit9/signet-ui/components/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@nimit9/signet-ui/components/tabs"
import { DESKTOP_QUERY, useMediaQuery } from "@nimit9/signet-ui/hooks/use-media-query"
import { Link, useParams } from "@tanstack/react-router"
import { ChevronRight } from "lucide-react"
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { parseDiff } from "../../../src/diff-parse.ts"
import type { FindingView } from "../../../src/api-schema.ts"
import { DiffView } from "../components/diff-view"
import { FindingCard } from "../components/finding-card"
import { HoldKeys, Key } from "../components/key"
import { UndoStrip } from "../components/undo-strip"
import { useAction } from "../lib/api"
import { useTicket } from "../lib/reviews"
import { useSnapshot } from "../lib/snapshot"
import { clock, dayName } from "../lib/week"

const RuleDialog = lazy(() => import("../components/dialogs").then((m) => ({ default: m.RuleDialog })))
const words = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
type Tab = "files" | "findings"

export function PullRequest() {
  const { id } = useParams({ from: "/pr/$id" })
  const { data: t, error, refetch } = useTicket(Number(id))
  const held = useSnapshot().data?.held ?? []
  const act = useAction()
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const [tab, setTab] = useState<Tab>("files")
  const [shut, setShut] = useState<Set<string>>(new Set()) // files folded by the owner
  const [cur, setCur] = useState(0)
  const [rule, setRule] = useState<FindingView | null>(null)

  const files = useMemo(() => (t?.diff ? parseDiff(t.diff.text) : []), [t?.diff])
  const open = (t?.findings ?? []).filter((f) => f.state === "open")
  const list = [...open].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  const now = list[Math.min(cur, list.length - 1)]
  const [fileAt, setFileAt] = useState(0)
  const moved = useRef(false) // the page opens at the top; only a J or K scrolls to a finding
  useEffect(() => { if (moved.current && now) document.querySelector(`[data-finding="${now.id}"]`)?.scrollIntoView({ block: "center", behavior: "instant" }) }, [now?.id])

  if (error && !t) return error.message === "signin" ? null : <ErrorState message={error.message === "missing" ? "There is no ticket with that number." : "The dashboard server did not answer."} onRetry={() => refetch()} />
  if (!t) return <Skeleton className="h-24 max-w-xl" />

  const blocking = open.filter((f) => f.severity !== "low").length
  const sentBack = t.rounds.filter((r) => r.verdict === "fail").length
  const live = held.filter((h) => h.state === "held")
  const undo = (h: (typeof held)[number]) => act.mutate({ action: "undo", actionId: h.actionId })
  const byLine = (path: string, line: number) => t.findings.filter((f) => f.file === path && f.line === line && (f.state === "open" || tab === "files"))
  const card = (f: FindingView) => (
    <FindingCard key={f.id} f={f} on={f.id === now?.id} phone={!desktop}
      onApply={() => act.mutate({ action: "applyFinding", finding: f.id })} onDismiss={() => act.mutate({ action: "dismissFinding", finding: f.id })} onRule={() => setRule(f)} />
  )
  const step = (by: number) => { moved.current = true; setCur((c) => Math.max(0, Math.min(list.length - 1, c + by))) }
  const moveFile = (by: number) => {
    const at = Math.max(0, Math.min(files.length - 1, fileAt + by))
    setFileAt(at); setShut((s) => { const n = new Set(s); n.delete(files[at].path); return n })
    requestAnimationFrame(() => document.querySelector(`[data-file="${CSS.escape(files[at].path)}"]`)?.scrollIntoView({ block: "start", behavior: "instant" }))
  }
  const headline = t.rounds.length === 0 ? `${t.title} has not been reviewed yet.`
    : `${t.title} had ${sentBack === 1 ? "1 round" : `${sentBack} rounds`} of changes. ${blocking === 0 ? "Nothing is blocking now." : blocking === 1 ? "One finding is still blocking." : `${blocking} findings are still blocking.`}`
  const canRound = t.status === "fixing" || t.status === "failed"
  const when = (iso: string) => `${dayName(Date.parse(iso))} ${clock(Date.parse(iso))}`

  return (
    <div className="grid gap-x-16 md:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <div className="font-mono text-caption text-ink-2"><Link to="/reviews" className="text-ink-2 no-underline hover:text-ink">Reviews</Link> / {t.app} #{t.id}{t.branch ? ` · ${t.branch}` : ""}</div>
        <h1 className="mt-2.5 max-w-[30ch] font-display text-[27px] leading-(--leading-display) font-normal tracking-[-0.015em] text-balance md:text-[36px]">{headline}</h1>
        <UndoStrip held={held} onUndo={undo} failed={act} />
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="mt-5.5">
          <TabsList variant="line" aria-label="Review sections" className="h-9 gap-5.5 border-b border-line">
            <TabsTrigger value="files" className="flex-none px-0">Files<span className="ml-1.5 font-mono text-ink-2">{t.files.length}</span></TabsTrigger>
            <TabsTrigger value="findings" className="flex-none px-0">Findings<span className="ml-1.5 font-mono text-ink-2">{open.length}</span></TabsTrigger>
          </TabsList>
        </Tabs>

        {tab === "files" && (
          <div className="mt-4.5 flex flex-col gap-2.5">
            {t.diff?.clipped ? <p role="note" className="text-sm text-warn">The diff is clipped at 200 KB; {t.diff.clipped.toLocaleString("en-GB")} more characters are on the branch.</p> : null}
            {files.length === 0 && <EmptyState title="No diff to show" description="The branch has no changes against its base, or Dobby cannot read the project's clone." />}
            {files.map((f, i) => {
              const fv = t.files.find((x) => x.path === f.path), folded = shut.has(f.path)
              return (
                <section key={f.path} data-file={f.path} aria-label={f.path} className="overflow-hidden rounded-[10px] shadow-[inset_0_0_0_1px_var(--line)]">
                  <button type="button" aria-expanded={!folded} onClick={() => { setFileAt(i); setShut((s) => { const n = new Set(s); n.has(f.path) ? n.delete(f.path) : n.add(f.path); return n }) }} className={`flex h-[38px] w-full items-center gap-3 px-3.5 text-left font-mono text-caption ${folded ? "" : "border-b border-line"} ${i === fileAt ? "bg-hover" : ""}`}>
                    <span className="truncate">{f.path}</span><span className="text-ink-2">+{f.add} −{f.del}</span>
                    <span className="ml-auto text-warn">{fv?.blocking ? `${fv.blocking} blocking` : ""}</span>
                    <ChevronRight className={`size-3.5 text-ink-2 transition-transform ${folded ? "" : "rotate-90"}`} aria-hidden="true" />
                  </button>
                  {!folded && <div className="overflow-x-auto"><DiffView file={f} inline={(line) => byLine(f.path, line).map(card)} /></div>}
                </section>
              )
            })}
          </div>
        )}
        {tab === "findings" && (
          <div className="mt-4.5 flex flex-col gap-1">
            {list.length === 0 && <EmptyState title="No open findings" />}
            {list.map((f) => (<div key={f.id}><div className="mx-3.5 mt-3 font-mono text-caption text-ink-2">{f.file}:{f.line}</div>{card(f)}</div>))}
          </div>
        )}
      </div>

      <aside aria-label="Rounds" className="mt-8 flex flex-col gap-5.5 border-line text-sm md:mt-0 md:border-l md:pl-7">
        <div className="text-xl font-medium tracking-[-0.01em]">Rounds</div>
        <ol className="flex flex-col">
          {t.rounds.map((r, i) => (
            <li key={r.n} className="grid grid-cols-[14px_minmax(0,1fr)] gap-x-3 pb-3.5">
              <span className="flex flex-col items-center"><span className={`mt-1 size-[9px] rounded-full shadow-[inset_0_0_0_1.5px_var(--ink-2)] ${i === t.rounds.length - 1 && r.verdict === "fail" ? "bg-warn" : ""}`} />{i < t.rounds.length - 1 && <span className="mt-1 w-px flex-1 bg-line" />}</span>
              <div><div className="flex"><span className="font-medium">Round {r.n}</span><span className="ml-auto font-mono text-[11.5px] text-ink-2">{when(r.at)}</span></div><div className="mt-0.5 leading-[1.45] text-ink-2">{r.what}</div></div>
            </li>
          ))}
          {t.rounds.length === 0 && <li className="text-ink-2">No review yet.</li>}
        </ol>
        <dl className="flex flex-col gap-2">
          <div className="flex"><dt className="text-ink-2">Builds</dt><dd className="ml-auto font-mono">{words(t.runs.length, "run")}</dd></div>
          <div className="flex"><dt className="text-ink-2">Spent</dt><dd className="ml-auto font-mono">{t.spent}</dd></div>
        </dl>
        <div className="flex flex-col gap-2">
          {canRound && <Button className="gap-2 font-semibold max-md:h-11" onClick={() => act.mutate({ action: "allowRound", id: t.id })}>Allow round {t.rounds.length + 1} <kbd className="font-mono text-xs opacity-70">⇧A</kbd></Button>}
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-2 text-ink-2">
            <Button variant="ghost" size="sm" className="gap-1.5 text-ink-2 max-md:h-11" onClick={() => act.mutate({ action: "decline", id: t.id })}>Decline <Kbd className="font-mono text-xs text-ink-2">X</Kbd></Button>
            <Button variant="ghost" size="sm" className="gap-1.5 text-ink-2 max-md:h-11" onClick={() => act.mutate({ action: "takeOver", id: t.id })}>Take over <Kbd className="font-mono text-xs text-ink-2">T</Kbd></Button>
            {t.pr && <Button variant="ghost" size="sm" className="gap-1.5 text-ink-2 max-md:h-11" render={<a href={t.pr.url} target="_blank" rel="noreferrer noopener" />}>On GitHub <Kbd className="font-mono text-xs text-ink-2">O</Kbd></Button>}
          </div>
        </div>
      </aside>

      <Key id="next-finding" run={() => step(1)} enabled={list.length > 0} />
      <Key id="prev-finding" run={() => step(-1)} enabled={list.length > 0} />
      <Key id="next-file" run={() => moveFile(1)} enabled={tab === "files" && files.length > 0} />
      <Key id="prev-file" run={() => moveFile(-1)} enabled={tab === "files" && files.length > 0} />
      <Key id="apply-finding" run={() => now && act.mutate({ action: "applyFinding", finding: now.id })} enabled={!!now} />
      <Key id="dismiss-finding" run={() => now && act.mutate({ action: "dismissFinding", finding: now.id })} enabled={!!now} />
      <Key id="rule-from-finding" run={() => now && setRule(now)} enabled={!!now && !rule} />
      <Key id="allow-round" run={() => act.mutate({ action: "allowRound", id: t.id })} enabled={canRound} />
      <Key id="decline" run={() => act.mutate({ action: "decline", id: t.id })} />
      <Key id="take-over" run={() => act.mutate({ action: "takeOver", id: t.id })} />
      <Key id="open" run={() => t.pr && window.open(t.pr.url, "_blank", "noopener,noreferrer")} enabled={!!t.pr} />
      <Key id="undo" run={() => undo(live[live.length - 1])} enabled={live.length > 0} />
      {rule && <Suspense fallback={<HoldKeys />}><RuleDialog key={rule.id} finding={rule} onClose={() => setRule(null)} /></Suspense>}
    </div>
  )
}

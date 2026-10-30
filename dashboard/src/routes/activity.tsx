import { Button } from "@nimit9/signet-ui/components/button"
import { EmptyState } from "@nimit9/signet-ui/components/empty-state"
import { ErrorState } from "@nimit9/signet-ui/components/error-state"
import { Kbd } from "@nimit9/signet-ui/components/kbd"
import { Skeleton } from "@nimit9/signet-ui/components/skeleton"
import { useListNavigation } from "@nimit9/signet-ui/components/shortcuts"
import { DESKTOP_QUERY, useMediaQuery } from "@nimit9/signet-ui/hooks/use-media-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { Markdown } from "@nimit9/signet-ui/components/markdown"
import type { ActivityEvent, MorningSummary } from "../../../src/api-schema.ts"
import { Key } from "../components/key"
import { type Filter, useActivity } from "../lib/activity"
import { SINCE } from "../lib/visit"
import { clock, gbDate } from "../lib/week"

const grid = "grid-cols-[52px_104px_minmax(0,1fr)_132px_136px]"
const rowBox = (on: boolean) => `-mx-3.5 cursor-default rounded-lg border-t border-line px-3.5 outline-offset-2 transition-colors first:border-t-transparent hover:bg-hover ${on ? "border-t-transparent bg-raise shadow-[inset_0_0_0_1px_var(--line)] hover:bg-raise" : ""}`
const FILTERS: [Filter, string, string][] = [["all", "All", "1"], ["merges", "Merges", "2"], ["reviews", "Reviews", "3"], ["problems", "Problems", "4"]]
const TONE = { plain: "text-ink-2", good: "text-mark", warn: "text-warn" } as const
const DAY = 86_400_000

const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0)
/** By the clock: today splits into morning, afternoon and evening; then Yesterday; then the date. */
export function groupOf(t: number, now = Date.now()): string {
  const today = startOfDay(now), h = new Date(t).getHours()
  if (t >= today) return h < 12 ? "This morning" : h < 17 ? "This afternoon" : "This evening"
  if (t >= today - DAY) return "Yesterday"
  return gbDate(new Date(t), { weekday: "short", day: "numeric", month: "short" }).replace(",", "")
}
const sinceLabel = (t: number, now = Date.now()) => (t >= startOfDay(now) ? clock(t) : `${gbDate(new Date(t), { weekday: "short", day: "numeric", month: "short" }).replace(",", "")} ${clock(t)}`)
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function Summary({ s, since }: { s: MorningSummary; since: number }) {
  const [copied, setCopied] = useState(false)
  const copy = () => { void navigator.clipboard?.writeText(s.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {}) }
  const main = s.main.failingDeploys.length ? `${s.main.failingDeploys.join(", ")} deploy failing` : s.main.reverts ? plural(s.main.reverts, "revert", "reverts") : "no reverts or failed deploys"
  const where = s.sent.state === "sent" && s.sent.at ? `Sent to ${s.sent.to} at ${clock(s.sent.at)}` : s.sent.text
  return (
    <aside aria-label="Morning summary" className="mt-10 flex flex-col gap-5.5 border-line text-sm md:mt-0 md:border-l md:pl-7">
      <div>
        <div className="text-xl font-medium tracking-[-0.01em]">Morning summary</div>
        <div className={`mt-1 ${s.sent.state === "sent" ? "text-ink-2" : "text-warn"}`}>{where}</div>
      </div>
      {s.preview && s.text && <p className="m-0 text-ink-2">Preview, not sent yet</p>}
      {s.text ? <div className="leading-[1.6] [&_h3]:mb-1 [&_h3]:mt-4 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-ink-2 [&_li]:my-0.5 [&_p]:m-0 [&_ul]:m-0 [&_ul]:pl-4 max-md:[&_a]:inline-flex max-md:[&_a]:min-h-11 max-md:[&_a]:min-w-11 max-md:[&_a]:items-center"><Markdown>{s.text.split("\n").filter((l) => !l.startsWith("-# ") && !l.startsWith("## ")).join("\n")}</Markdown></div> : <p className="m-0 text-ink-2">Nothing to summarise yet.</p>}
      <dl className="flex flex-col gap-2">
        <div className="flex"><dt className="text-ink-2">Plan used since {clock(since)}</dt><dd className="ml-auto font-mono">{s.plan === null ? "no reading" : `${s.plan}%`}</dd></div>
        <div className="flex"><dt className="text-ink-2">Runs</dt><dd className="ml-auto font-mono">{s.runs}{s.retried ? `, ${s.retried} retried` : ""}</dd></div>
        <div className="flex"><dt className="mr-3 shrink-0 text-ink-2">Main since {clock(since)}</dt><dd className="ml-auto text-right font-mono">{main}</dd></div>
      </dl>
      <div className="flex flex-wrap gap-x-4 gap-y-2 text-ink-2">
        <Button variant="ghost" size="sm" className="gap-1.5 px-0 text-ink-2 max-md:h-11" onClick={copy} disabled={!s.text}>{copied ? "Copied" : "Copy summary"} <Kbd className="font-mono text-xs text-ink-2">C</Kbd></Button>
        <Button variant="ghost" size="sm" className="gap-1.5 px-0 text-ink-2 max-md:h-11" render={<Link to="/settings" />}>Notification settings <Kbd className="font-mono text-xs text-ink-2">,</Kbd></Button>
      </div>
    </aside>
  )
}

function Line({ e, desktop }: { e: ActivityEvent; desktop: boolean }) {
  return desktop ? (
    <div className={`grid ${grid} h-11 items-center gap-x-4`}>
      <span className="font-mono text-caption text-ink-2">{clock(e.t)}</span>
      <span className="truncate text-sm text-ink-2">{e.role}</span>
      <span className="truncate text-base">{e.text}</span>
      <span className="truncate font-mono text-caption text-ink-2">{e.ref}</span>
      <span className={`truncate justify-self-end text-sm ${TONE[e.tone]}`}>{e.result}</span>
    </div>
  ) : (
    <div className="py-3">
      <div className="flex items-baseline gap-3"><span className="min-w-0 flex-1 truncate text-lg">{e.text}</span><span className={`text-sm ${TONE[e.tone]}`}>{e.result}</span></div>
      <div className="mt-0.5 flex gap-3 text-sm text-ink-2"><span className="font-mono text-xs">{clock(e.t)}</span><span>{e.role}</span><span className="truncate font-mono text-xs">{e.ref}</span></div>
    </div>
  )
}

export function Activity() {
  const [kind, setKind] = useState<Filter>("all")
  const [since, setSince] = useState(SINCE)
  const { data, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } = useActivity(kind, since)
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const go = useNavigate()
  const [activeId, setActiveId] = useState<string>()
  const events = [...new Map((data?.pages ?? []).flatMap((p) => p.events).map((e) => [e.id, e])).values()] // a page boundary can repeat an event
  const ids = events.map((e) => e.id)
  const active = activeId && ids.includes(activeId) ? activeId : ids[0]
  const open = (e?: ActivityEvent) => { if (e?.ticket != null) void go({ to: "/pr/$id", params: { id: String(e.ticket) } }) }
  const nav = useListNavigation({
    ids, activeId: active, onActiveChange: (k) => { setActiveId(k); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-row="${CSS.escape(k)}"]`)?.focus()) },
    onOpen: (k) => open(events.find((e) => e.id === k)), group: "Activity",
  })
  if (error && !data) return error.message === "signin" ? null : <ErrorState message="The dashboard server did not answer." onRetry={() => refetch()} />
  if (!data) return <Skeleton className="h-24 max-w-xl" />

  const first = data.pages[0]
  const h = first.headline
  const parts = [h.merged ? `${h.merged} merged` : "", h.sentBack ? `${h.sentBack} needed changes` : "", h.retries ? plural(h.retries, "retry", "retries") : ""].filter(Boolean)
  const title = parts.length ? `${parts.join(", ")}.` : "Nothing merged, needing changes or retried."
  const groups: [string, ActivityEvent[]][] = []
  for (const e of events) { const g = groupOf(e.t, first.at); (groups.at(-1)?.[0] === g ? groups.at(-1)![1] : (groups.push([g, []]), groups.at(-1)![1])).push(e) }
  const count = (k: Filter) => first.counts[k === "all" ? "all" : k]

  return (
    <div className="grid gap-x-16 md:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <h1 className="max-w-[24ch] font-display text-[27px] leading-(--leading-display) font-normal tracking-[-0.015em] text-balance md:text-display">{title}</h1>
        <p className="mt-3.5 text-base text-ink-2">Since {sinceLabel(since, first.at)}, newest first.</p>
        <nav aria-label="Filter" className="mt-6.5 flex gap-5 overflow-x-auto text-[13px]">
          {FILTERS.map(([k, label, key]) => (
            <button
              key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}
              className={`py-2 whitespace-nowrap max-md:min-h-11 ${kind === k ? "text-ink underline decoration-1 underline-offset-7" : "text-ink-2 hover:text-ink"}`}
            >
              {label} <span className="font-mono">{count(k)}</span>
            </button>
          ))}
        </nav>
        {events.length === 0 ? (
          <div className="mt-6">
            <EmptyState title={kind === "all" ? `Nothing since ${sinceLabel(since, first.at)}` : "Nothing in this filter"}  />
            {since > first.at - DAY && <Button variant="outline" size="sm" className="mt-3 max-md:h-11" onClick={() => setSince(first.at - DAY)}>Show the last 24 hours</Button>}
          </div>
        ) : (
          <div role="listbox" aria-label="Activity">
            {groups.map(([g, rows]) => (
              <section key={g} className="mt-5.5" aria-label={g}>
                <h2 className="mb-1.5 flex gap-2 text-sm font-medium text-ink-2">{g}</h2>
                {rows.map((e) => (
                  <div key={e.id} role="option" aria-selected={e.id === active} tabIndex={e.id === active ? 0 : -1} data-row={e.id} onClick={() => nav.setActiveId(e.id)} onDoubleClick={() => open(e)} className={rowBox(e.id === active)}>
                    <Line e={e} desktop={desktop} />
                  </div>
                ))}
              </section>
            ))}
            {hasNextPage && <Button variant="outline" size="sm" className="mt-4 max-md:h-11" disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>Show older</Button>}
          </div>
        )}
      </div>
      {first.summary && <Summary s={first.summary} since={since} />}

      {FILTERS.map(([k]) => <Key key={k} id={`filter-${k}`} run={() => setKind(k)} />)}
      <Key id="copy-summary" run={() => { if (first.summary?.text) void navigator.clipboard?.writeText(first.summary.text) }} enabled={!!first.summary?.text} />
    </div>
  )
}

import { type InfiniteData, type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useSyncExternalStore } from "react"
// Types only: zod is ~55 KB gzipped and the first load has a budget. tests/dashboard-*.test.ts validate what the server sends against the schema.
import type { ActivityEvent, ActivityPage, Snapshot } from "../../../src/api-schema.ts"

const KEY = ["snapshot"]
let streaming = false // true while /api/events is open; polling only runs when it is not
/** "connecting" until the stream first opens or fails; "down" while it is closed (the snapshot is then read every 10 s). */
export type Connection = "connecting" | "live" | "down"
let connection: Connection = "connecting"
const listeners = new Set<() => void>()
const setConnection = (c: Connection) => { streaming = c === "live"; if (c !== connection) { connection = c; for (const l of listeners) l() } }
/** A request that never got an answer: the page is offline now, not when the event stream next notices. */
export const markDown = () => setConnection("down")
export const useConnection = () => useSyncExternalStore((l) => { listeners.add(l); return () => void listeners.delete(l) }, () => connection)

async function fetchSnapshot() {
  const r = await fetch("/api/snapshot").catch((e) => { markDown(); throw e })
  if (!r.ok) throw new Error(r.status === 401 ? "signin" : `snapshot ${r.status}`)
  return (await r.json()) as Snapshot
}

export const live = () => streaming

const MATCH: Record<string, (e: ActivityEvent) => boolean> = { all: () => true, merges: (e) => e.result === "Merged", reviews: (e) => e.kind === "review", problems: (e) => e.problem }
let recount: ReturnType<typeof setTimeout> | undefined
/** A new run, review or merge goes to the top of every open Activity list it belongs to; the counts are read again a moment later. */
function prepend(qc: QueryClient, ev: ActivityEvent) {
  for (const q of qc.getQueryCache().findAll({ queryKey: ["activity"] })) {
    const [, kind, since] = q.queryKey as [string, string, number]
    if (ev.t <= since || !MATCH[kind]?.(ev)) continue
    qc.setQueryData<InfiniteData<ActivityPage>>(q.queryKey, (old) => (!old || old.pages.some((p) => p.events.some((e) => e.id === ev.id)) ? old : { ...old, pages: [{ ...old.pages[0], events: [ev, ...old.pages[0].events] }, ...old.pages.slice(1)] }))
  }
  clearTimeout(recount)
  recount = setTimeout(() => void qc.invalidateQueries({ queryKey: ["activity"] }), 1500)
}

/** The snapshot, patched live from /api/events; 10 s polling while the stream is down. */
export function useSnapshot() {
  return useQuery({ queryKey: KEY, queryFn: fetchSnapshot, refetchInterval: () => (streaming ? false : 10_000) })
}

/** Opens the event stream once, for the whole app. A snapshot event replaces the cached snapshot. */
export function useLiveEvents() {
  const qc = useQueryClient()
  useEffect(() => {
    const es = new EventSource("/api/events")
    es.onopen = () => setConnection("live")
    es.onerror = () => setConnection("down") // EventSource retries by itself; polling covers the gap
    es.addEventListener("snapshot", (e) => {
      try { qc.setQueryData(KEY, JSON.parse((e as MessageEvent<string>).data) as Snapshot) } catch {}
    })
    es.addEventListener("setup", (e) => { try { qc.setQueryData(["/api/setup/state"], JSON.parse((e as MessageEvent<string>).data)) } catch {} }) // dobby init --ui: progress of the repo checks
    for (const name of ["run", "review", "merge", "ticket"]) es.addEventListener(name, (e) => { try { prepend(qc, JSON.parse((e as MessageEvent<string>).data) as ActivityEvent) } catch {} })
    return () => { setConnection("connecting"); es.close() }
  }, [qc])
}

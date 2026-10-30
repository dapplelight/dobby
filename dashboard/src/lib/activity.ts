import { useInfiniteQuery } from "@tanstack/react-query"
import type { ActivityPage } from "../../../src/api-schema.ts"
import { live } from "./snapshot"

export type Filter = "all" | "merges" | "reviews" | "problems"

/** GET /api/activity, a page at a time (100): each next page asks for events before the oldest one shown. Live events are patched in by useLiveEvents. */
export const useActivity = (kind: Filter, since: number) => useInfiniteQuery({
  queryKey: ["activity", kind, since],
  initialPageParam: undefined as number | undefined,
  queryFn: async ({ pageParam }) => {
    const r = await fetch(`/api/activity?since=${since}&kind=${kind}${pageParam ? `&before=${pageParam}` : ""}`)
    if (!r.ok) throw new Error(r.status === 401 ? "signin" : `activity ${r.status}`)
    return (await r.json()) as ActivityPage
  },
  getNextPageParam: (last) => (last.more ? last.events[last.events.length - 1].t + 1 : undefined), // +1: an event at the same millisecond is not lost; the page dedupes by id
  refetchInterval: () => (live() ? false : 10_000),
})

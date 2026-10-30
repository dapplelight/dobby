import { useQuery } from "@tanstack/react-query"
// Types only, like snapshot.ts: tests validate what the server sends against the schema.
import type { ReviewsPage, TicketDetail } from "../../../src/api-schema.ts"

async function get<T>(path: string) {
  const r = await fetch(path)
  if (!r.ok) throw new Error(r.status === 401 ? "signin" : r.status === 404 ? "missing" : `${path} ${r.status}`)
  return (await r.json()) as T
}

/** The Reviews page's data. The snapshot stream is not for these, so they are read again every few seconds while the page is open. */
export const useReviews = () => useQuery({ queryKey: ["reviews"], queryFn: () => get<ReviewsPage>("/api/reviews"), refetchInterval: 5000 })
/** One ticket with its files, findings, rounds and diff. */
export const useTicket = (id: number | undefined) => useQuery({ queryKey: ["ticket", id], queryFn: () => get<TicketDetail>(`/api/ticket/${id}`), enabled: id !== undefined, refetchInterval: 5000 })

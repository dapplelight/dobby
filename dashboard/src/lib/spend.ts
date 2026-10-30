import { useQuery } from "@tanstack/react-query"
import type { SpendPage } from "../../../src/api-schema.ts"
import { live } from "./snapshot"

/** GET /api/spend, read again every 30 s (the plan reading moves slowly) and when the stream drops. */
export const useSpend = () => useQuery({
  queryKey: ["spend"],
  queryFn: async () => { const r = await fetch("/api/spend"); if (!r.ok) throw new Error(r.status === 401 ? "signin" : `spend ${r.status}`); return (await r.json()) as SpendPage },
  refetchInterval: () => (live() ? 30_000 : 10_000),
})

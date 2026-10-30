import { useQuery } from "@tanstack/react-query"
import { gate } from "./api"

/** GET /api/session: can this browser act? The token cookie decides; expired means every write would be refused. Assumed yes until the first answer. */
export function useSession() {
  const q = useQuery({
    queryKey: ["session"],
    queryFn: async () => { const r = await fetch("/api/session"); return (await r.json()) as { canAct: boolean; setup?: boolean } },
    refetchInterval: 30_000, staleTime: 0, retry: false,
  })
  const canAct = q.data?.canAct ?? true
  gate.canAct = canAct
  return { canAct, setup: q.data?.setup === true }
}

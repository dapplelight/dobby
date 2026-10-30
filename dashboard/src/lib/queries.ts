import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { sendAction, type ActionBody } from "./api"

/** GET one of the JSON endpoints (the cookie carries the token). Types are the shapes in src/api-schema.ts; tests check the server against them. */
export function useJson<T>(path: string, o: { refetchInterval?: number; enabled?: boolean } = {}) {
  return useQuery({
    queryKey: [path],
    queryFn: async () => {
      const r = await fetch(path)
      if (!r.ok) throw new Error(r.status === 401 ? "signin" : `${path} ${r.status}`)
      return (await r.json()) as T
    },
    ...o,
  })
}

/** An action that changes settings or role files: the data on these pages is read again as soon as it lands. */
export function useSend() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (b: ActionBody) => sendAction(b),
    onSettled: () => Promise.all(["/api/config", "/api/team", "/api/welcome", "/api/role", "snapshot"].map((k) => qc.invalidateQueries({ queryKey: [k] }))),
  })
}

export const homePath = (p: string) => p.replace(/^\/(Users|home)\/[^/]+/, "~")

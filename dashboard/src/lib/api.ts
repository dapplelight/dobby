import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ActionReply } from "../../../src/api-schema.ts"
import { markDown } from "./snapshot.ts"

export type ActionBody = { action: string } & Record<string, unknown>
/** Set from /api/session: false once the token cookie is no longer valid. Every write is then refused here with the exact command. */
export const gate = { canAct: true }

/** POST /api/action. The cookie carries the token; the browser sends the origin. A refusal throws its plain message. */
export async function sendAction(body: ActionBody) {
  if (!gate.canAct) throw new Error("This browser is signed out: run `dobby dashboard open`.")
  const r = await fetch("/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => { markDown(); throw new Error("Could not reach the dashboard, so nothing ran. Check the connection and try again.") })
  const text = await r.text()
  let reply: ActionReply | undefined
  try { const j = JSON.parse(text); if (typeof j?.ok === "boolean" && typeof j.message === "string") reply = j } catch {}
  if (!r.ok) throw new Error(reply ? reply.message : r.status === 401 ? "This browser is not signed in: run `dobby dashboard open`." : `The dashboard answered ${r.status}.`)
  if (!reply) throw new Error("The dashboard sent an answer this page does not understand.")
  return reply
}

/** One action sender; the snapshot is read again as soon as it lands, so held actions show their strip at once. */
export function useAction() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: sendAction, onSettled: () => qc.invalidateQueries({ queryKey: ["snapshot"] }) })
}

export type SetupReply = { ok: boolean; message: string } & Record<string, unknown>
/** POST /api/setup/<step> (`dobby init --ui` only). A refusal throws its plain message. */
export async function postSetup(step: string, body: Record<string, unknown> = {}): Promise<SetupReply> {
  const r = await fetch(`/api/setup/${step}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  let reply: SetupReply | undefined
  try { const j = await r.json(); if (typeof j?.message === "string") reply = j } catch {}
  if (!r.ok) throw new Error(reply?.message ?? (r.status === 401 ? "This browser is not signed in: run `dobby init --ui` again." : `Setup answered ${r.status}.`))
  return reply ?? { ok: true, message: "" }
}

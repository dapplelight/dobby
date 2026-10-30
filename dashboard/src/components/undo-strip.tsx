import { Button } from "@nimit9/signet-ui/components/button"
import { Kbd } from "@nimit9/signet-ui/components/kbd"
import { AnimatePresence, m, useReducedMotion } from "motion/react"
import type { Held } from "../../../src/api-schema.ts"
import { ACTIONS } from "../actions"

const VERBS: Record<string, string> = { merge: "Merging", decline: "Declining", retry: "Retrying", deploy: "Deploying", dismissIdea: "Dropping", dismissFinding: "Dismissing" }
const HOLD = 8000

/** One line per held action, with a rule that drains over the 8 s. Undo cancels it on the server; once it is running there is no Undo. */
export function UndoStrip({ held, onUndo, failed }: { held: Held[]; onUndo: (h: Held) => void; failed?: { variables?: { action: string }; error: Error | null } }) {
  const still = useReducedMotion()
  const named = ACTIONS.filter((a) => a.action === failed?.variables?.action)
  const name = named.length === 1 ? named[0].label : "The action"
  return (
    <div aria-live="polite">
      <AnimatePresence initial={false}>
        {held.filter((h) => h.state !== "ran").map((h) => (
          <m.div
            key={h.actionId} role="status"
            initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18 }}
            className="relative mt-6 flex h-9 items-center gap-3 overflow-hidden text-sm text-ink-2 first:mt-6 [&+&]:mt-0"
          >
            {h.state === "failed" ? (
              <span className="text-warn">{VERBS[h.action] ? `${h.action} ${h.ref} did not run` : h.ref}: {h.message}</span>
            ) : h.state === "running" ? (
              <span className="truncate"><span className="text-ink">{VERBS[h.action] ?? h.action} {h.ref}</span> {h.title}</span>
            ) : (
              <>
                <span className="truncate"><span className="text-ink">{VERBS[h.action] ?? h.action} {h.ref}</span> {h.title}</span>
                <Button variant="ghost" size="sm" className="ml-auto gap-2 text-ink-2 max-md:h-11" onClick={() => onUndo(h)}>Undo <Kbd className="font-mono text-xs text-ink-2">U</Kbd></Button>
                {!still && (
                  <m.span
                    className="absolute inset-x-0 bottom-0 h-px origin-left bg-ink-3"
                    initial={{ scaleX: Math.max(0, Math.min(1, (h.runsAt - Date.now()) / HOLD)) }} animate={{ scaleX: 0 }}
                    transition={{ duration: Math.max(0, h.runsAt - Date.now()) / 1000, ease: "linear" }}
                  />
                )}
              </>
            )}
          </m.div>
        ))}
      </AnimatePresence>
      {failed?.error && <p role="alert" className="mt-6 text-sm text-warn">{name} did not run: {failed.error.message}</p>}
    </div>
  )
}

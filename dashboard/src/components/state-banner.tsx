import { Button } from "@nimit9/signet-ui/components/button"
import { Pause, PlugZap, TriangleAlert } from "lucide-react"
import type { DashState } from "../lib/states"
import { CopyButton } from "./copy-button"

const ICON = { paused: Pause, offline: PlugZap, expired: TriangleAlert, usage: TriangleAlert, claude: TriangleAlert } as const

/** One line per state the page is in, each with its one fix: a Resume button, or the exact command with a copy button. */
export function StateBanner({ states, onResume, busy }: { states: DashState[]; onResume: (kind: string) => void; busy?: boolean }) {
  if (!states.length) return null
  return (
    <div className="border-t border-line">
      {states.map((s) => {
        const I = ICON[s.id]
        return (
          <div key={s.id} role="status" data-state={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-raise px-5 py-2.5 text-sm md:px-10">
            <I className={`size-4 shrink-0 ${s.id === "paused" || s.id === "offline" ? "text-ink-2" : "text-warn"}`} strokeWidth={1.5} aria-hidden="true" />
            <span className="font-medium">{s.text}</span>
            {s.detail && <span className="text-ink-2">{s.detail}</span>}
            {s.command && <span className="inline-flex items-center gap-1 font-mono text-caption"><code>{s.command}</code><CopyButton text={s.command} name={`the command ${s.command}`} /></span>}
            {s.resume && <Button size="sm" className="ml-auto max-md:h-11 max-md:w-full" disabled={busy} onClick={() => onResume(s.resume!)}>Resume</Button>}
          </div>
        )
      })}
    </div>
  )
}

import { Button } from "@nimit9/signet-ui/components/button"
import { Kbd } from "@nimit9/signet-ui/components/kbd"
import { Markdown } from "@nimit9/signet-ui/components/markdown"
import type { FindingView } from "../../../src/api-schema.ts"

const dot = (sev: FindingView["severity"]) => (sev === "high" ? "bg-warn" : sev === "medium" ? "bg-ink-2" : "bg-ink-3")
const STATE: Record<string, string> = { fixed: "Fixed", queued: "Fix queued", dismissed: "Dismissed", ruled: "Rule saved" }

/** The reviewer's finding under its line: severity, round, the words (model output, so only through Markdown), the suggested replacement, and the three taps. */
export function FindingCard({ f, on, onApply, onDismiss, onRule, phone }: { f: FindingView; on: boolean; onApply: () => void; onDismiss: () => void; onRule: () => void; phone: boolean }) {
  const done = f.state !== "open"
  const sug = f.suggestion?.split("\n") ?? []
  return (
    <div data-finding={f.id} aria-current={on || undefined} className={`mx-3.5 my-2 rounded-[10px] bg-raise px-4 py-3.5 font-sans shadow-[0_0_0_1px_var(--line),0_6px_20px_rgb(0_0_0/0.18)] ${on ? "outline-2 outline-offset-2 outline-mark" : ""} ${done ? "opacity-60" : ""} ${phone ? "md:ml-[62px]" : "ml-[62px]"}`}>
      <div className="flex items-center gap-2 text-xs">
        <span className={`size-[7px] rounded-xs ${dot(f.severity)}`} aria-hidden="true" />
        <span className={f.severity === "high" ? "text-warn" : "text-ink"}>{f.word}</span>
        <span className="text-ink-2">Reviewer · round {f.round}</span>
        {done && <span className="text-ink-2">· {STATE[f.state] ?? f.state}</span>}
        <span className="ml-auto font-mono text-ink-2">line {f.line}</span>
      </div>
      <div className="mt-2 font-display text-[16px] leading-[1.45] italic [&_p]:m-0"><Markdown>{f.text}</Markdown></div>
      {sug.length > 0 && (
        <div className="mt-3 overflow-hidden rounded-lg font-mono text-xs shadow-[inset_0_0_0_1px_var(--line)]" aria-label="Suggested change">
          {f.was !== null && (
            <div className="grid h-[22px] grid-cols-[44px_18px_minmax(0,1fr)] items-center bg-del"><span className="pr-3 text-right text-ink-3">{f.line}</span><span className="text-ink-2">−</span><span className="overflow-hidden whitespace-pre text-ink">{f.was}</span></div>
          )}
          {sug.map((l, i) => (
            <div key={i} className="grid h-[22px] grid-cols-[44px_18px_minmax(0,1fr)] items-center bg-add"><span className="pr-3 text-right text-ink-3">{f.line + i}</span><span className="text-ink-2">+</span><span className="overflow-hidden whitespace-pre text-ink">{l}</span></div>
          ))}
        </div>
      )}
      {!done && (
        <div className={`mt-3 flex gap-4 text-[12.5px] text-ink-2 ${phone ? "flex-wrap" : ""}`}>
          <Button variant="ghost" size="sm" className="gap-1.5 text-ink-2 max-md:h-11" onClick={onApply}>Ask builder to apply <Kbd className="font-mono text-xs text-ink-2">A</Kbd></Button>
          <Button variant="ghost" size="sm" className="gap-1.5 text-ink-2 max-md:h-11" onClick={onDismiss}>Dismiss <Kbd className="font-mono text-xs text-ink-2">D</Kbd></Button>
          <Button variant="ghost" size="sm" className="gap-1.5 text-ink-2 max-md:h-11" onClick={onRule}>Make it a rule <Kbd className="font-mono text-xs text-ink-2">R</Kbd></Button>
        </div>
      )}
    </div>
  )
}

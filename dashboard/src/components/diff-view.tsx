import type { ReactNode } from "react"
import type { DFile } from "../../../src/diff-parse.ts"

const tone = { add: "bg-add", del: "bg-del", ctx: "", hunk: "text-ink-3" } as const

/** One file's unified diff: line numbers, + and − lines, hunk headers. `inline(line)` returns what sits under a new-side line (a finding card, a comment box); that is the slot. */
export function DiffView({ file, inline }: { file: DFile; inline?: (line: number) => ReactNode }) {
  return (
    <div className="py-2 font-mono text-xs" role="table" aria-label={`Changes in ${file.path}`}>
      {file.lines.map((l, i) => (
        <div key={i} role="rowgroup" data-line={l.new ?? undefined}>
          <div role="row" className={`grid h-[22px] grid-cols-[44px_18px_minmax(0,1fr)] items-center ${tone[l.t]}`}>
            <span role="cell" className="pr-3 text-right text-ink-3">{l.t === "hunk" ? "" : (l.new ?? l.old)}</span>
            <span role="cell" className="text-ink-2" aria-label={l.t === "add" ? "added" : l.t === "del" ? "removed" : undefined}>{l.t === "add" ? "+" : l.t === "del" ? "−" : ""}</span>
            <span role="cell" className={`whitespace-pre ${l.t === "hunk" ? "text-ink-3" : "text-ink"} overflow-hidden`}>{l.text}</span>
          </div>
          {l.new !== null && l.t !== "del" && inline?.(l.new)}
        </div>
      ))}
    </div>
  )
}

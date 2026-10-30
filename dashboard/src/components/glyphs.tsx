import { GitMerge, MessageSquare, Undo2, Upload } from "lucide-react"
import type { InboxRow, WorkingRow } from "../../../src/api-schema.ts"

const ICONS = { merge: GitMerge, deploy: Upload, answer: MessageSquare, decide: Undo2 } as const
export function KindIcon({ kind }: { kind: InboxRow["kind"] }) {
  const I = ICONS[kind]
  return <I className="size-4 text-mark" strokeWidth={1.5} aria-hidden="true" />
}

const bar = (n: number) => Math.round(Math.min(34, Math.log2(n + 1) * 3.6))

/** Added and removed lines as two short bars, log-scaled. */
export function DiffBar({ diff }: { diff: InboxRow["diff"] }) {
  if (!diff) return <span />
  return (
    <span className="flex items-center gap-0.5" role="img" aria-label={`${diff.add} lines added, ${diff.del} removed, ${diff.files} files`}>
      <span className="h-[3px] rounded-[1.5px] bg-ink-2" style={{ width: bar(diff.add) }} />
      <span className="h-[3px] rounded-[1.5px] bg-ink-3" style={{ width: bar(diff.del) }} />
    </span>
  )
}

/** Five dots: filled = passed, warn = failed, ring = waiting. */
export function CheckDots({ checks }: { checks: InboxRow["checks"] }) {
  if (!checks.length) return <span />
  const passed = checks.filter((c) => c.state === "pass").length
  return (
    <span className="flex gap-[3px]" title="Checks: filled passed, red failed, ring waiting" role="img" aria-label={`Checks: ${passed} of ${checks.length} passed${checks.some((c) => c.state === "fail") ? ", some failed" : ""}`}>
      {checks.map((c) => (
        <span key={c.name} className={`size-[5px] rounded-full ${c.state === "pass" ? "bg-ink-2" : c.state === "fail" ? "bg-warn" : "shadow-[inset_0_0_0_1px_var(--ink-3)]"}`} />
      ))}
    </span>
  )
}

/** One stripe per round: done, current (breathing), to come. */
export function RoundStripe({ row }: { row: WorkingRow }) {
  return (
    <span className="flex gap-0.5" role="img" aria-label={`Round ${row.round} of ${row.of}, ${row.step}`}>
      {Array.from({ length: row.of }, (_, i) => (
        <span key={i} className={`h-3 w-1 rounded-[1px] ${i + 1 < row.round ? "bg-ink-2" : i + 1 === row.round ? "live bg-ink" : "bg-line"}`} />
      ))}
    </span>
  )
}

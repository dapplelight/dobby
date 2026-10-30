import { Check } from "lucide-react"

/** A numbered step of First run and setup: a ring with its number, or a filled check once done. */
export function Step({ n, done, title, children }: { n: number; done?: boolean; title: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-4 border-t border-line py-4.5">
      <span className={`inline-flex size-6 items-center justify-center rounded-full font-mono text-xs ${done ? "bg-mark text-on-mark" : "shadow-[inset_0_0_0_1px_var(--ink-3)]"}`} aria-hidden="true">
        {done ? <Check className="size-3.5" strokeWidth={2} /> : n}
      </span>
      <div className="min-w-0"><h2 className="m-0 text-lg font-medium">{title}</h2><div className="mt-2">{children}</div></div>
    </div>
  )
}

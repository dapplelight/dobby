import { Info } from "lucide-react"
import { lazy, Suspense } from "react"
import { GLOSSARY, type TermKey } from "../lib/glossary"

const TermTip = lazy(() => import("./term-tip"))
export const TRIGGER = "relative ml-1 inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-full align-middle text-ink-3 transition-colors hover:text-ink focus-visible:text-ink max-md:after:absolute max-md:after:-inset-3.5 max-md:after:content-['']"

/** A Dobby word with a small info button after it. Tap or press the button to read what the word means and open the manual section.
 *  With no key (a role name we do not know) it is just the text. */
export function Term({ k, children }: { k?: TermKey; children: React.ReactNode }) {
  const e = k ? GLOSSARY[k] : undefined
  if (!k || !e) return <>{children}</>
  return (
    <>
      {children}
      <Suspense fallback={<button type="button" aria-label={`What is ${e.name}?`} className={TRIGGER}><Info aria-hidden="true" className="size-3.5" /></button>}>
        <TermTip k={k} />
      </Suspense>
    </>
  )
}

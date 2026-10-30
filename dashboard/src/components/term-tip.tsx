import { Popover, PopoverContent, PopoverTrigger } from "@nimit9/signet-ui/components/popover"
import { Info } from "lucide-react"
import { GLOSSARY, type TermKey, termUrl } from "../lib/glossary"
import { TRIGGER } from "./term"

/** The popover half of Term, loaded after first paint so Radix's popover stays out of the first-load budget. A popover, not a hover tooltip, so a tap opens it on a phone. */
export default function TermTip({ k }: { k: TermKey }) {
  const e = GLOSSARY[k]
  return (
    <>
      <Popover>
        <PopoverTrigger
          type="button" aria-label={`What is ${e.name}?`}
          onKeyDown={(ev: React.SyntheticEvent) => ev.stopPropagation()} onClick={(ev: React.SyntheticEvent) => ev.stopPropagation()}
          className={TRIGGER}
        >
          <Info aria-hidden="true" className="size-3.5" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 max-w-[calc(100vw-2rem)] text-sm" onClick={(ev: React.SyntheticEvent) => ev.stopPropagation()}>
          <p className="m-0 font-medium">{e.name}</p>
          <p className="mt-1 mb-0 leading-[1.5] text-ink-2">{e.short}</p>
          <a href={termUrl(e.docs)} target="_blank" rel="noreferrer noopener" className="mt-2 inline-flex min-h-6 items-center text-ink underline underline-offset-4 max-md:min-h-11">Learn more</a>
        </PopoverContent>
      </Popover>
    </>
  )
}

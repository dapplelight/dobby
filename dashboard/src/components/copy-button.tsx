import { Button } from "@nimit9/signet-ui/components/button"
import { Check, Copy } from "lucide-react"
import { useState } from "react"

/** Copies `text` to the clipboard; the icon says so for a moment. */
export function CopyButton({ text, name }: { text: string; name: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button variant="ghost" size="icon" aria-label={`Copy ${name}`} className="size-8 shrink-0 text-ink-2 max-md:size-11" onClick={() => { void navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) }}>
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </Button>
  )
}

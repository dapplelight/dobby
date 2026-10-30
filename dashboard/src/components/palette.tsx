import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@nimit9/signet-ui/components/dialog"
import { Kbd } from "@nimit9/signet-ui/components/kbd"
import { ResponsiveSheet } from "@nimit9/signet-ui/components/responsive-sheet"
import { DESKTOP_QUERY, useMediaQuery } from "@nimit9/signet-ui/hooks/use-media-query"
import { useLocation, useNavigate } from "@tanstack/react-router"
import { Command } from "cmdk"
import type { ConfigView } from "../../../src/api-schema.ts"
import type { ActionBody } from "../lib/api"
import { useJson } from "../lib/queries"
import { type Item, paletteItems, rank } from "../lib/palette"
import { useSnapshot } from "../lib/snapshot"

const GROUPS = ["Actions", "Go to", "Tickets", "Settings", "Docs"] as const

/** ⌘K: actions (from the keys registry), pages, tickets, settings and manual topics. Loads on first open. Esc closes it; on a phone it opens as a full sheet. */
export default function Palette({ onClose, onNewTicket, onAct }: { onClose: () => void; onNewTicket: () => void; onAct: (b: ActionBody) => void }) {
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const go = useNavigate()
  const path = useLocation({ select: (l) => l.pathname })
  const snap = useSnapshot()
  const cfg = useJson<ConfigView>("/api/config")
  const items = paletteItems({ snap: snap.data, config: cfg.data?.keys, path })

  const run = (it: Item) => {
    onClose()
    const r = it.run
    // the row button's own call: held 8 s by the server, with an Undo strip on the page
    if (r.kind === "act") onAct(r.body)
    else if (r.kind === "ticket") onNewTicket()
    else if (r.kind === "go") void go({ to: r.to, search: r.search as never })
    else window.open(r.href, "_blank", "noopener,noreferrer")
  }

  const list = (
    <Command label="Search or run" loop filter={(id, q) => { const it = items.find((x) => x.id === id); return it ? rank(it, q) : 0 }} className="flex min-h-0 flex-1 flex-col">
      <Command.Input autoFocus placeholder="Search or run" aria-label="Search or run" className="h-12 w-full border-b border-line bg-transparent px-4 text-base outline-none placeholder:text-ink-2 max-md:h-14" />
      <Command.List className="max-h-[min(60dvh,26rem)] overflow-y-auto p-2 max-md:max-h-none max-md:flex-1">
        <Command.Empty className="px-3 py-6 text-center text-sm text-ink-2">Nothing matches.</Command.Empty>
        {GROUPS.map((g) => {
          const rows = items.filter((i) => i.group === g)
          return rows.length ? (
            <Command.Group key={g} heading={g} className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:text-ink-2">
              {rows.map((it) => (
                <Command.Item key={it.id} value={it.id} onSelect={() => run(it)} className="flex min-h-11 cursor-default items-center gap-3 rounded-lg px-3 text-base aria-selected:bg-hover md:min-h-9">
                  <span className="min-w-0 flex-1 truncate">{it.label}{it.hint && <span className="ml-2 font-mono text-caption text-ink-2">{it.hint}</span>}</span>
                  {it.cli && <span className="hidden font-mono text-caption text-ink-2 md:inline">{it.cli}</span>}
                  {it.keys && <span className="flex gap-1">{it.keys.map((k) => <Kbd key={k} className="font-mono text-caption text-ink-2">{k}</Kbd>)}</span>}
                </Command.Item>
              ))}
            </Command.Group>
          ) : null
        })}
      </Command.List>
    </Command>
  )

  if (!desktop) return <ResponsiveSheet title="Search or run" onClose={onClose} className="flex h-[78dvh] flex-col px-0">{list}</ResponsiveSheet>
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent showCloseButton={false} className="top-[18%] translate-y-0 gap-0 overflow-hidden p-0 shadow-xl sm:max-w-xl">
        <DialogTitle className="sr-only">Search or run</DialogTitle>
        <DialogDescription className="sr-only">Type to find an action, page, ticket, setting or manual topic. Arrow keys move, Enter runs, Escape closes.</DialogDescription>
        {list}
      </DialogContent>
    </Dialog>
  )
}

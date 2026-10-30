import { Button } from "@nimit9/signet-ui/components/button"
import { Kbd } from "@nimit9/signet-ui/components/kbd"
import { Link, useLocation } from "@tanstack/react-router"
import { Search, SlidersHorizontal } from "lucide-react"
import { Mark } from "./mark"
import { WeekInstrument } from "./week-instrument"

export const TABS = [
  { to: "/", label: "Home" }, { to: "/queue", label: "Queue" }, { to: "/reviews", label: "Reviews" },
  { to: "/spend", label: "Spend" }, { to: "/goals", label: "Goals" }, { to: "/activity", label: "Activity" },
] as const

export function Header({ paused, greyed, canAct, onNewTicket, onTogglePause, onSearch }: { paused: boolean; greyed: boolean; canAct: boolean; onNewTicket: () => void; onTogglePause: () => void; onSearch: () => void }) {
  const path = useLocation({ select: (l) => l.pathname })
  const here = (to: string) => (to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`) || (to === "/reviews" && path.startsWith("/pr/"))) // a pull request page is part of Reviews
  return (
    <header className="flex h-14 items-center gap-x-9 px-5 md:px-10">
      <Link to="/" className="inline-flex items-center gap-2 text-mark no-underline">
        <Mark />
        <span className="text-base font-semibold tracking-[-0.035em] text-ink">dobby</span>
      </Link>
      <nav aria-label="Views" className="hidden gap-5.5 text-[13.5px] md:flex">
        {TABS.map((t) => (
          <Link
            key={t.to} to={t.to} aria-current={here(t.to) ? "page" : undefined}
            className={`whitespace-nowrap no-underline ${here(t.to) ? "text-ink underline decoration-1 underline-offset-7" : "text-ink-2 hover:text-ink"}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <WeekInstrument paused={greyed} />
        <Button variant="outline" size="default" aria-label={paused ? "Resume the team" : "Pause the team"} disabled={!canAct} onClick={onTogglePause} className="hidden px-2.5 text-ink-2 md:inline-flex">
          {paused ? "Resume" : "Pause"}
        </Button>
        <Button variant="outline" size="default" aria-label="New ticket" disabled={!canAct} onClick={onNewTicket} className="hidden gap-2 pr-2 pl-2.5 text-ink-2 md:inline-flex">
          New ticket <Kbd className="font-mono text-[11px] text-ink-2">N</Kbd>
        </Button>
        <Button variant="outline" size="default" aria-label="Search or run" onClick={onSearch} className="gap-2.5 pr-2 pl-2.5 text-ink-2 max-md:size-11 max-md:p-0">
          <Search className="size-3.5 md:hidden" />
          <span className="hidden md:inline">Search or run</span> <Kbd className="hidden font-mono text-[11px] text-ink-2 md:inline-flex">⌘K</Kbd>
        </Button>
        <Link to="/settings" aria-label="Settings" className="hidden size-8 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink md:inline-flex">
          <SlidersHorizontal className="size-4" strokeWidth={1.5} />
        </Link>
      </div>
    </header>
  )
}

import { Link, useLocation } from "@tanstack/react-router"
import { Ellipsis, Gauge, GitPullRequest, House, ListOrdered, Target } from "lucide-react"
import { lazy, Suspense, useState } from "react"

const MoreSheet = lazy(() => import("./more-sheet").then((m) => ({ default: m.MoreSheet })))
const TABS = [
  { to: "/", label: "Home", Icon: House }, { to: "/queue", label: "Queue", Icon: ListOrdered }, { to: "/reviews", label: "Reviews", Icon: GitPullRequest },
  { to: "/spend", label: "Spend", Icon: Gauge }, { to: "/goals", label: "Goals", Icon: Target },
] as const
const MORE_PAGES = [{ to: "/activity", label: "Activity" }, { to: "/team", label: "Team and projects" }, { to: "/settings", label: "Settings" }] as const

/** Phone only: Home, Queue, Reviews, Spend, Goals; Activity, Team and Settings sit behind More. Every target is at least 44 px; the bar clears the home indicator. */
export function BottomTabs() {
  const path = useLocation({ select: (l) => l.pathname })
  const [more, setMore] = useState(false)
  const here = (to: string) => (to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`) || (to === "/reviews" && path.startsWith("/pr/")))
  const inMore = MORE_PAGES.some((p) => here(p.to))
  const cell = "flex min-h-[60px] flex-col items-center justify-center gap-0.5 text-xs no-underline"
  return (
    <>
      <nav aria-label="Views" className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-6 border-t border-line bg-background pb-[env(safe-area-inset-bottom)] md:hidden">
        {TABS.map(({ to, label, Icon }) => (
          <Link key={to} to={to} aria-current={here(to) ? "page" : undefined} className={`${cell} ${here(to) ? "font-semibold text-ink" : "text-ink-2"}`}>
            <Icon className="size-5" strokeWidth={1.5} aria-hidden="true" />{label}
          </Link>
        ))}
        <button type="button" aria-haspopup="dialog" aria-label="More: Activity, Team, Settings" onClick={() => setMore(true)} className={`${cell} ${inMore ? "font-semibold text-ink" : "text-ink-2"}`}>
          <Ellipsis className="size-5" strokeWidth={1.5} aria-hidden="true" />More
        </button>
      </nav>
      {more && <Suspense fallback={null}><MoreSheet pages={MORE_PAGES} onClose={() => setMore(false)} /></Suspense>}
    </>
  )
}

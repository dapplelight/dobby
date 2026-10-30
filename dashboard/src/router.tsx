import { createRootRoute, createRoute, Link, createRouter, lazyRouteComponent, Outlet, redirect, useLocation, useNavigate } from "@tanstack/react-router"
import { LazyMotion, MotionConfig } from "motion/react"
import { lazy, Suspense, useEffect, useState } from "react"
import { HoldKeys, Key } from "./components/key"
import { useAction } from "./lib/api"
import { useSnapshot } from "./lib/snapshot"
import { BottomTabs } from "./components/bottom-tabs"
import { Header } from "./components/header"
import { StateBanner } from "./components/state-banner"
import { useSession } from "./lib/session"
import { deriveStates, isPaused } from "./lib/states"
import { StatusBar } from "./components/status-bar"
import { useConnection, useLiveEvents } from "./lib/snapshot"
import { Home } from "./routes/home"
import { Placeholder } from "./routes/placeholder"
import "./lib/visit"
import { firstRun } from "./lib/welcome"

// Only Home is in the first load; the dialogs and every other page load when they are first used.
const ShortcutsHelp = lazy(() => import("@nimit9/signet-ui/components/shortcuts").then((m) => ({ default: m.ShortcutsHelp })))
// motion's layout and drag features load after first paint (the small `m` component is enough until then).
const motionFeatures = () => import("./motion-features").then((f) => f.default)
const Palette = lazy(() => import("./components/palette")) // cmdk and the palette load on the first ⌘K
const NewTicketDialog = lazy(() => import("./components/dialogs").then((m) => ({ default: m.NewTicketDialog })))

const GO = [["go-home", "/"], ["go-queue", "/queue"], ["go-reviews", "/reviews"], ["go-spend", "/spend"], ["go-goals", "/goals"], ["go-activity", "/activity"], ["settings", "/settings"]] as const

function Shell() {
  useLiveEvents()
  const go = useNavigate()
  const act = useAction()
  const snap = useSnapshot()
  const paused = !!snap.data?.paused
  const session = useSession()
  const { setup } = session
  const canAct = session.canAct && snap.error?.message !== "signin" // the server answering 401 means signed out, whatever /api/session said last
  const connection = useConnection()
  const states = deriveStates({ snap: snap.data, connection, updatedAt: snap.dataUpdatedAt, canAct, setupPort: setup ? location.port : undefined })
  const home = useLocation({ select: (l) => l.pathname === "/" })
  useEffect(() => { if (home && (setup || firstRun(snap.data?.projects))) void go({ to: "/welcome", replace: true }) }, [home, setup, snap.data?.projects, go]) // no project yet: First run; `dobby init --ui` always starts at the setup page
  useEffect(() => { void import("./components/dialogs") }, []) // the New ticket dialog is ready before N, so the first letters typed go into its field
  const [ticketOpen, setTicketOpen] = useState(false)
  const [ticketSeen, setTicketSeen] = useState(false) // mounted from the first open on, so closing can animate
  const openTicket = (o: boolean) => { if (o && !canAct) return; setTicketOpen(o); if (o) setTicketSeen(true) }
  const [paletteOpen, setPaletteOpen] = useState(false)
  return (
    <LazyMotion features={motionFeatures}>
      <MotionConfig reducedMotion="user">
        <div className="flex min-h-screen flex-col">
          <Header paused={paused} greyed={isPaused(states)} canAct={canAct} onNewTicket={() => openTicket(true)} onTogglePause={() => act.mutate({ action: paused ? "resume" : "pauseTeam" })} onSearch={() => setPaletteOpen(true)} />
          <StateBanner states={states} busy={act.isPending} onResume={(kind) => act.mutate({ action: "resume", kind })} />
          {act.error && <p role="alert" className="border-t border-line px-5 py-2.5 text-sm text-warn md:px-10">{act.error.message}</p>}
          <main className="flex-1 border-t border-line px-5 pt-8 md:px-10 md:pt-12"><Outlet /></main>
          <StatusBar />
        </div>
        <BottomTabs />
        <Key id="palette" run={() => setPaletteOpen((o) => !o)} />
        {GO.map(([id, to]) => <Key key={id} id={id} run={() => void go({ to })} />)}
        <Key id="new-ticket" run={() => openTicket(true)} />
        <Key id="pause-team" run={() => act.mutate({ action: "pauseTeam" })} enabled={!paused && canAct} />
        <Key id="resume-team" run={() => act.mutate({ action: "resume" })} enabled={paused && canAct} />
        <Suspense fallback={null}><ShortcutsHelp /></Suspense>
        {paletteOpen && <Suspense fallback={<HoldKeys />}><Palette onClose={() => setPaletteOpen(false)} onNewTicket={() => openTicket(true)} onAct={(b) => act.mutate(b)} /></Suspense>}
        {ticketSeen && <Suspense fallback={<HoldKeys />}><NewTicketDialog open={ticketOpen} onOpenChange={openTicket} /></Suspense>}
      </MotionConfig>
    </LazyMotion>
  )
}

const root = createRootRoute({ component: Shell })
const page = <P extends string>(path: P, name: string) => createRoute({ getParentRoute: () => root, path, component: () => <Placeholder name={name} /> })
// There is no ticket page of its own: a ticket's page is its pull request page, which also reads for a ticket with no PR yet.
const toTicket = createRoute({ getParentRoute: () => root, path: "/ticket/$id", beforeLoad: ({ params }) => { throw redirect({ to: "/pr/$id", params: { id: params.id }, replace: true }) } })
const routes = [
  toTicket,
  createRoute({ getParentRoute: () => root, path: "/", component: Home }),
  createRoute({ getParentRoute: () => root, path: "/queue", component: lazyRouteComponent(() => import("./routes/queue"), "Queue") }),
  createRoute({ getParentRoute: () => root, path: "/goals", component: lazyRouteComponent(() => import("./routes/goals"), "Goals") }),
  createRoute({ getParentRoute: () => root, path: "/reviews", component: lazyRouteComponent(() => import("./routes/reviews"), "Reviews") }),
  createRoute({ getParentRoute: () => root, path: "/pr/$id", component: lazyRouteComponent(() => import("./routes/pr"), "PullRequest") }),
  createRoute({ getParentRoute: () => root, path: "/spend", component: lazyRouteComponent(() => import("./routes/spend"), "Spend") }),
  createRoute({ getParentRoute: () => root, path: "/activity", component: lazyRouteComponent(() => import("./routes/activity"), "Activity") }),
  // Settings, Team and First run (PR 6)
  createRoute({ getParentRoute: () => root, path: "/settings", validateSearch: (s: Record<string, unknown>): { find?: string } => (typeof s.find === "string" ? { find: s.find } : {}), component: lazyRouteComponent(() => import("./routes/settings"), "Settings") }),
  createRoute({ getParentRoute: () => root, path: "/team", component: lazyRouteComponent(() => import("./routes/team"), "Team") }),
  createRoute({ getParentRoute: () => root, path: "/welcome", component: lazyRouteComponent(() => import("./routes/welcome"), "Welcome") }),
]

const NotFound = () => <div className="py-6"><p className="text-base">This page does not exist.</p><Link to="/" className="mt-2 inline-flex min-h-11 items-center text-ink underline underline-offset-4">Back to Home</Link></div>
export const router = createRouter({ routeTree: root.addChildren(routes), defaultPreload: "intent", defaultNotFoundComponent: NotFound })
declare module "@tanstack/react-router" { interface Register { router: typeof router } }

import { Button } from "@nimit9/signet-ui/components/button"
import { Input } from "@nimit9/signet-ui/components/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nimit9/signet-ui/components/select"
import { useListNavigation } from "@nimit9/signet-ui/components/shortcuts"
import { TooltipProvider } from "@nimit9/signet-ui/components/tooltip"
import { Skeleton } from "@nimit9/signet-ui/components/skeleton"
import { useNavigate } from "@tanstack/react-router"
import { lazy, Suspense, useEffect, useState } from "react"
import { useSession } from "../lib/session"
import type { ConfigView, WelcomeView } from "../../../src/api-schema.ts"
import { Step } from "../components/step"
import { AddProjectDialog } from "../components/add-project"
import { CopyButton } from "../components/copy-button"
import { StopSlider } from "../components/stop-slider"
import { firstRun } from "../lib/welcome"
import { useJson, useSend } from "../lib/queries"
import { useSnapshot } from "../lib/snapshot"
import { clock, dayName, weekOf } from "../lib/week"

/** The first ticket is optional. It goes through the same `add` action as New ticket and `dobby add`. */
function FirstTicket({ projects }: { projects: string[] }) {
  const send = useSend()
  const [project, setProject] = useState<string>()
  const [title, setTitle] = useState("")
  const [done, setDone] = useState(false)
  const p = project ?? projects[0]
  return (
    <form className="flex flex-col gap-2.5" onSubmit={(e) => { e.preventDefault(); if (p && title.trim()) send.mutate({ action: "add", project: p, title: title.trim() }, { onSuccess: () => { setDone(true); setTitle("") } }) }}>
      {projects.length === 0 ? <p className="m-0 text-sm text-ink-2">Add a project first; a ticket belongs to one.</p> : (
        <div className="flex flex-wrap gap-2.5">
          {projects.length > 1 && (
            <Select value={p} onValueChange={(v) => v && setProject(v)}>
              <SelectTrigger aria-label="Project" className="w-40 max-md:h-11"><SelectValue /></SelectTrigger>
              <SelectContent>{projects.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent>
            </Select>
          )}
          <Input aria-label="What should the team build first?" placeholder="What should the team build first?" value={title} onChange={(e) => { setTitle(e.target.value); setDone(false) }} maxLength={300} className="min-w-0 flex-1 basis-60 max-md:h-11" />
          <Button type="submit" disabled={!title.trim() || send.isPending} className="max-md:h-11">Add ticket</Button>
        </div>
      )}
      {done && <p role="status" className="m-0 text-sm text-ink-2">Added to the queue.</p>}
      {send.error && <p role="alert" className="m-0 text-sm text-warn">{send.error.message}</p>}
      <p className="m-0 text-sm text-ink-2">Or skip it: the Engineering Manager writes up to 3 tickets per planning run, for gaps it finds in the repo.</p>
    </form>
  )
}

function FirstRun() {
  const welcome = useJson<WelcomeView>("/api/welcome", { refetchInterval: 5_000 })
  const cfg = useJson<ConfigView>("/api/config")
  const snap = useSnapshot()
  const send = useSend()
  const go = useNavigate()
  const [pick, setPick] = useState<string>()
  const [open, setOpen] = useState(false)
  const repos = welcome.data?.repos ?? []
  const projects = snap.data?.projects
  useEffect(() => { if (projects !== undefined && !firstRun(projects)) void go({ to: "/", replace: true }) }, [projects, go])
  const free = repos.filter((r) => !r.added)
  const nav = useListNavigation({ ids: free.map((r) => r.name), onOpen: (id) => { setPick(id); setOpen(true) }, group: "First run" })

  if (!welcome.data || !snap.data) return <Skeleton className="h-24 max-w-xl" />
  const w = weekOf(snap.data.limits, snap.data.week.series)
  const cap = cfg.data?.keys.find((k) => k.key === "pacing.weekCap")
  const mergesPaused = ((snap.data.pause ?? []) as { scope?: string }[]).some((p) => p.scope === "merges")
  const first = free[0]?.name ?? "<repo>"
  const commands = [`dobby init ${first}`, `dobby add ${projects?.[0] ?? first} "Export to CSV"`, "dobby start"]
  const limits = snap.data.limits

  return (
    <div className="grid gap-x-16 md:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <h1 className="max-w-[24ch] font-display text-[27px] leading-(--leading-display) font-normal tracking-[-0.015em] text-balance md:text-display">Add your first project.</h1>
        <div className="mt-3.5 max-w-[62ch] text-base text-ink-2">
          <p className="m-0">What leaves this machine:</p>
          <ul aria-label="What leaves this machine" className="m-0 mt-1 list-disc pl-5">{welcome.data.leaves.map((l) => <li key={l}>{l}</li>)}</ul>
        </div>

        <div className="mt-6 max-w-[760px]">
          <Step n={1} done={!!w} title={limits?.state === "apiKey" ? "Your API key" : "Your plan"}>
            <p className="m-0 text-base text-ink-2">
              {w ? <>Claude plan found. This week is at <span className="font-mono text-ink">{w.usedPct}%</span>, resets {dayName(w.resetsAt)} {clock(w.resetsAt)}.</> : (limits?.line ?? "No plan reading yet.")}
            </p>
          </Step>
          <Step n={2} done={welcome.data.repos.some((r) => r.added)} title="Add a project">
            <p className="m-0 mb-2 text-sm text-ink-2">Git repos found in {welcome.data.root}</p>
            {repos.length === 0 && <p className="m-0 text-sm text-ink-2">None. Clone a repo there, or set <code className="font-mono text-xs">paths.projects</code> in Settings.</p>}
            <div role="listbox" aria-label="Repos" className="flex flex-col">
              {repos.map((r) => {
                const on = !r.added && nav.activeId === r.name
                return (
                  <div key={r.name} role="option" aria-selected={on} tabIndex={on ? 0 : -1} data-row={r.name} onClick={() => !r.added && nav.setActiveId(r.name)}
                    className={`-mx-3.5 grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 rounded-lg border-t border-line px-3.5 first:border-t-transparent hover:bg-hover ${on ? "border-t-transparent bg-raise shadow-[inset_0_0_0_1px_var(--line)]" : ""}`}>
                    <span className="truncate font-mono text-[12.5px]">{r.path}</span>
                    {r.added ? <span className="text-sm text-ink-2">added</span> : (
                      <Button variant={on ? "default" : "ghost"} size="sm" className="gap-2 text-sm max-md:h-11" onClick={(e) => { e.stopPropagation(); setPick(r.name); setOpen(true) }}>Add {on && <kbd className="font-mono text-xs opacity-70">↵</kbd>}</Button>
                    )}
                  </div>
                )
              })}
            </div>
          </Step>
          <Step n={3} title={limits?.state === "apiKey" ? "Daily budget" : "Where to stop"}>
            {limits?.state === "apiKey" ? <p className="m-0 text-base text-ink-2">Dobby stops when a day or a week reaches its dollar cap. Change it in Settings, under Budget and pacing.</p> : cap ? (
              <>
                <p className="m-0 mb-2 text-base text-ink-2">Stop at <span className="font-mono text-ink">{String(cap.value)}%</span> of the week, so you keep the last {100 - Number(cap.value)}% for yourself.</p>
                <StopSlider week={w} value={Number(cap.value)} min={cap.min ?? 10} max={cap.max ?? 100} onCommit={(v) => send.mutate({ action: "configSet", key: "pacing.weekCap", value: v })} />
                {send.error && <p role="alert" className="m-0 mt-2 text-sm text-warn">{send.error.message}</p>}
              </>
            ) : <Skeleton className="h-14 max-w-xl" />}
          </Step>
          <Step n={4} title="First ticket"><FirstTicket projects={projects ?? []} /></Step>
        </div>
      </div>

      <aside aria-label="What happens next" className="flex flex-col gap-5.5 text-sm max-md:mt-8 max-md:border-t max-md:border-line max-md:pt-6 md:border-l md:border-line md:pl-7">
        <div className="text-xl font-medium tracking-[-0.01em]">What happens next</div>
        {([["Engineering Manager", "plans the work and sizes it against your week"], ["Builder", "writes it, with tests"], ["Reviewer", "reads the pull request and sends it back with findings, up to two fix rounds"], ["Tester", "checks the result against your done-when line"], ["You", mergesPaused ? "merge from Home. Merging starts paused: turn it on in Settings." : "merge from Home, or let it merge on its own"]] as const).map(([k, v]) => (
          <div key={k} className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 leading-[1.45]"><span className="font-medium">{k}</span><span className="text-ink-2">{v}</span></div>
        ))}
        <div>
          <div className="text-ink-2">Same thing from the terminal</div>
          <div className="mt-2 flex flex-col font-mono text-[12px] leading-[1.8]">
            {commands.map((c) => <div key={c} className="flex items-center gap-1"><span className="min-w-0 break-all">{c}</span><CopyButton text={c} name={c} /></div>)}
          </div>
        </div>
      </aside>
      <AddProjectDialog open={open} pick={pick} root={welcome.data.root} repos={repos} onClose={() => setOpen(false)} />
    </div>
  )
}

// Signet's SelectItem is wrapped in a Tooltip that needs this provider. It sits here, not at the app root, so the tooltip code stays out of the first load.
const SetupFlow = lazy(() => import("./setup"))
/** First run; under `dobby init --ui` the whole setup flow instead. */
export function Welcome() {
  const { setup } = useSession()
  return <TooltipProvider>{setup ? <Suspense fallback={<Skeleton className="h-24 max-w-xl" />}><SetupFlow /></Suspense> : <FirstRun />}</TooltipProvider>
}

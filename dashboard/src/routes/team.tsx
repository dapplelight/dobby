import { Button } from "@nimit9/signet-ui/components/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@nimit9/signet-ui/components/dialog"
import { ErrorState } from "@nimit9/signet-ui/components/error-state"
import { Kbd } from "@nimit9/signet-ui/components/kbd"
import { Label } from "@nimit9/signet-ui/components/label"
import { useListNavigation } from "@nimit9/signet-ui/components/shortcuts"
import { Skeleton } from "@nimit9/signet-ui/components/skeleton"
import { Textarea } from "@nimit9/signet-ui/components/textarea"
import { DESKTOP_QUERY, useMediaQuery } from "@nimit9/signet-ui/hooks/use-media-query"
import { useEffect, useState } from "react"
import type { TeamRole, TeamView, WelcomeView } from "../../../src/api-schema.ts"
import { AddProjectDialog } from "../components/add-project"
import { Key } from "../components/key"
import { Term } from "../components/term"
import { roleKey } from "../lib/glossary"
import { useJson, useSend } from "../lib/queries"
import { useSnapshot } from "../lib/snapshot"
import { clock, gbDate } from "../lib/week"

const MAX_ROLE = 8000
type Project = TeamView["projects"][number]
const rowBox = (on: boolean) => `-mx-3.5 cursor-default rounded-lg border-t border-line px-3.5 outline-offset-2 transition-colors first:border-t-transparent hover:bg-hover ${on ? "border-t-transparent bg-raise shadow-[inset_0_0_0_1px_var(--line)]" : ""}`
const share = (billing: TeamView["billing"], s: { usd: number; pct: number } | null) => (!s ? "–" : billing === "apiKey" ? `$${s.usd.toFixed(2)}` : `${s.pct}%`)
const merged = (iso: string | null) => {
  if (!iso) return "no merge yet"
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z"), sameDay = d.toDateString() === new Date().toDateString()
  return `merged ${sameDay ? clock(d.getTime()) : gbDate(d, { day: "numeric", month: "short" })}`
}

function EditRules({ role, onClose, onSaved }: { role: TeamRole | null; onClose: () => void; onSaved: (id: string | undefined, name: string) => void }) {
  const send = useSend()
  const file = useJson<{ name: string; text: string }>(`/api/role/${role?.name ?? "_"}`, { enabled: !!role })
  const [text, setText] = useState<string>()
  useEffect(() => setText(undefined), [role?.name])
  const value = text ?? file.data?.text ?? ""
  return (
    <Dialog open={!!role} onOpenChange={(o) => { if (!o) { send.reset(); onClose() } }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit rules: {role?.title}</DialogTitle>
          <DialogDescription>This is <span className="font-mono text-xs">{role?.file}</span>, the text the role's runs start from. Your edit is kept in your config folder, so an upgrade does not replace it. A change applies to runs that start after you save.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (role) send.mutate({ action: "saveRole", name: role.name, text: value }, { onSuccess: (r) => { onSaved(r.actionId, role.file); onClose() } }) }}>
          <Label htmlFor="role-text" className="sr-only">Role file text</Label>
          <Textarea id="role-text" autoFocus rows={16} value={value} disabled={!file.data} onChange={(e) => setText(e.target.value)} className="max-h-[45dvh] overflow-y-auto font-mono text-[12px] leading-[1.6]" maxLength={MAX_ROLE} />
          <p className="text-caption text-ink-2" aria-live="polite">{value.length} of {MAX_ROLE} characters</p>
          {file.error && <p role="alert" className="text-sm text-warn">The file could not be read.</p>}
          {send.error && <p role="alert" className="text-sm text-warn">{send.error.message}</p>}
          <DialogFooter><Button type="submit" disabled={!file.data || !value.trim() || value === file.data.text || send.isPending} className="max-md:h-11">Save</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function Team() {
  const { data, error, refetch } = useJson<TeamView>("/api/team", { refetchInterval: 15_000 })
  const welcome = useJson<WelcomeView>("/api/welcome")
  const snap = useSnapshot()
  const send = useSend()
  const desktop = useMediaQuery(DESKTOP_QUERY)
  const [activeId, setActiveId] = useState<string>()
  const [editing, setEditing] = useState<TeamRole | null>(null)
  const [adding, setAdding] = useState(false)
  const [saved, setSaved] = useState<{ id?: string; file: string; did?: string }>()
  const [err, setErr] = useState("")
  const ids = [...(data?.projects ?? []).map((p) => `project:${p.name}`), ...(data?.roles ?? []).map((r) => `role:${r.name}`)]
  const active = activeId && ids.includes(activeId) ? activeId : ids[0]
  const focus = (id: string) => requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-row="${id}"]`)?.focus())
  const nav = useListNavigation({ ids, activeId: active, onActiveChange: (k) => { setActiveId(k); focus(k) }, group: "Team" })
  const working = new Set(snap.data?.working.map((w) => w.project))

  if (error && !data) return error.message === "signin" ? null : <ErrorState message="The dashboard server did not answer." onRetry={() => refetch()} />
  if (!data) return <Skeleton className="h-24 max-w-xl" />

  const project = active?.startsWith("project:") ? data.projects.find((p) => `project:${p.name}` === active) : undefined
  const role = active?.startsWith("role:") ? data.roles.find((r) => `role:${r.name}` === active) : undefined
  const toggle = () => {
    setErr("")
    const body = project ? { kind: "project", project: project.name } : role?.pauseKind ? { kind: role.pauseKind } : null
    const paused = project ? project.paused : role?.paused
    if (body) send.mutate({ action: paused ? "resume" : "pause", ...body }, { onError: (e) => setErr(e.message) })
  }
  const canPause = !!project || !!role?.pauseKind
  const pauseLabel = (project ? project.paused : role?.paused) ? "Resume" : "Pause"
  const reset = () => {
    if (!role?.edited) return
    setErr("")
    send.mutate({ action: "resetRole", name: role.name }, { onSuccess: (r) => setSaved({ id: r.actionId, file: role.file, did: "Reset" }), onError: (e) => setErr(e.message) })
  }
  const undo = () => { if (saved?.id) send.mutate({ action: "undo", actionId: saved.id }, { onSuccess: () => setSaved(undefined), onError: (e) => setErr(e.message) }) }

  return (
    <div className="grid gap-x-16 md:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <h1 className="max-w-[24ch] font-display text-[27px] leading-(--leading-display) font-normal tracking-[-0.015em] text-balance md:text-display">
          {data.projects.length} {data.projects.length === 1 ? "project" : "projects"}, {data.roles.length} roles.
        </h1>
        <p className="mt-3.5 text-base text-ink-2">Each role is a file you can edit.</p>
        {saved && (
          <p role="status" className="mt-4 flex items-center gap-3 text-sm text-ink-2">
            <span>{saved.did === "Reset" ? `Reset ${saved.file} to the default. New runs read it.` : `Saved ${saved.file}. New runs read it.`}</span>
            {saved.id && <Button variant="ghost" size="sm" className="gap-2 text-ink-2 max-md:h-11" onClick={undo}>Undo <Kbd className="font-mono text-xs text-ink-2">U</Kbd></Button>}
          </p>
        )}
        {err && <p role="alert" className="mt-4 text-sm text-warn">{err}</p>}

        <section aria-label="Projects" className="mt-8">
          <h2 className="mb-1.5 flex items-center justify-between text-sm font-medium text-ink-2">
            <span>Projects</span>
            <Button variant="ghost" size="sm" className="gap-1.5 text-ink-2 max-md:h-11" onClick={() => setAdding(true)}>Add a project <Kbd className="font-mono text-xs text-ink-2">⇧N</Kbd></Button>
          </h2>
          {data.projects.length === 0 && <p className="py-4 text-sm text-ink-2">No projects.</p>}
          <div role="listbox" aria-label="Projects" className="flex flex-col">
            {data.projects.map((p) => (
              <div key={p.name} role="option" aria-selected={active === `project:${p.name}`} tabIndex={active === `project:${p.name}` ? 0 : -1} data-row={`project:${p.name}`} onClick={() => nav.setActiveId(`project:${p.name}`)} className={rowBox(active === `project:${p.name}`)}>
                {desktop ? (
                  <div className="grid h-11 grid-cols-[130px_minmax(0,1fr)_170px_70px_120px] items-center gap-x-4">
                    <span className="inline-flex items-center gap-2 text-base font-medium"><span className={`size-1.5 rounded-full shadow-[inset_0_0_0_1px_var(--ink-3)] ${working.has(p.name) ? "live bg-ink" : ""}`} aria-hidden="true" />{p.name}</span>
                    <span className="truncate font-mono text-caption text-ink-2">{p.path} · {p.branch}</span>
                    <span className="text-sm text-ink-2">{p.open} open · {p.needsYou} {p.needsYou === 1 ? "needs" : "need"} you</span>
                    <span className="font-mono text-caption text-ink-2">{share(data.billing, p.share)}</span>
                    <span className="justify-self-end text-sm text-ink-2">{p.paused ? <Term k="paused">paused</Term> : merged(p.lastMerge)}</span>
                  </div>
                ) : (
                  <div className="py-3">
                    <div className="flex items-center gap-3"><span className="min-w-0 flex-1 truncate text-lg font-medium">{p.name}</span><span className="font-mono text-xs">{share(data.billing, p.share)}</span></div>
                    <div className="mt-0.5 truncate text-sm text-ink-2">{p.open} open · {p.needsYou} need you · {p.paused ? "paused" : merged(p.lastMerge)}</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <section aria-label="Team" className="mt-7">
          <h2 className="mb-1.5 text-sm font-medium text-ink-2">Team</h2>
          <div role="listbox" aria-label="Roles" className="flex flex-col">
            {data.roles.map((r) => (
              <div key={r.name} role="option" aria-selected={active === `role:${r.name}`} tabIndex={active === `role:${r.name}` ? 0 : -1} data-row={`role:${r.name}`} onClick={() => nav.setActiveId(`role:${r.name}`)} className={rowBox(active === `role:${r.name}`)}>
                {desktop ? (
                  <div className="grid min-h-11 grid-cols-[150px_minmax(0,1fr)_140px_70px_90px] items-center py-1.5 gap-x-4">
                    <span className="truncate text-base font-medium"><Term k={roleKey(r.name) ?? roleKey(r.title)}>{r.title}</Term>{r.edited && <span className="ml-2 text-caption font-normal text-ink-2">edited</span>}</span>
                    <span className="line-clamp-2 text-sm">{r.does}</span>
                    <span className="font-mono text-caption text-ink-2">{[r.model, r.effort].filter(Boolean).join(" · ") || "–"}</span>
                    <span className="font-mono text-caption text-ink-2">{r.paused ? "paused" : share(data.billing, r.share)}</span>
                    <span className="justify-self-end text-sm text-ink-2">{r.ruleCount} {r.ruleCount === 1 ? "rule" : "rules"}</span>
                  </div>
                ) : (
                  <div className="py-3">
                    <div className="flex items-center gap-3"><span className="min-w-0 flex-1 truncate text-lg font-medium"><Term k={roleKey(r.name) ?? roleKey(r.title)}>{r.title}</Term>{r.edited && <span className="ml-2 text-caption font-normal text-ink-2">edited</span>}</span><span className="font-mono text-xs">{r.paused ? "paused" : share(data.billing, r.share)}</span></div>
                    <div className="mt-0.5 truncate text-sm text-ink-2">{[r.model, r.effort].filter(Boolean).join(" · ") || "no model set"} · {r.ruleCount} {r.ruleCount === 1 ? "rule" : "rules"}</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>

      <aside aria-label={role ? role.title : project?.name} className="flex flex-col gap-5.5 text-sm max-md:mt-8 max-md:border-t max-md:border-line max-md:pt-6 md:border-l md:border-line md:pl-7">
        {role && (
          <>
            <div><div className="font-mono text-caption text-ink-2">{role.file}{role.edited && " · edited"}</div><div className="mt-1.5 text-xl font-medium tracking-[-0.01em]"><Term k={roleKey(role.name) ?? roleKey(role.title)}>{role.title}</Term></div></div>
            <p className="m-0 leading-[1.55]">{role.does}</p>
            <div className="flex flex-col gap-2">
              <div className="text-ink-2">Rules · {role.ruleCount}</div>
              {role.rules.slice(0, 8).map((x, i) => (
                <p key={i} className="m-0 leading-[1.45]">{x}</p>
              ))}
              {role.ruleCount > 8 && <div className="text-ink-2">and {role.ruleCount - 8} more in the file</div>}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-ink-2">
              <Button variant="ghost" size="sm" className="gap-1.5 px-0 text-ink-2 max-md:h-11 max-md:px-2" onClick={() => setEditing(role)}>Edit rules <Kbd className="font-mono text-xs text-ink-2">E</Kbd></Button>
              {role.edited && <Button variant="ghost" size="sm" className="gap-1.5 px-0 text-ink-2 max-md:h-11 max-md:px-2" onClick={reset} disabled={send.isPending}>Reset to default <Kbd className="font-mono text-xs text-ink-2">⇧E</Kbd></Button>}
              {role.pauseKind && <Button variant="ghost" size="sm" className="gap-1.5 px-0 text-ink-2 max-md:h-11 max-md:px-2" onClick={toggle} disabled={send.isPending}>{pauseLabel} role <Kbd className="font-mono text-xs text-ink-2">P</Kbd></Button>}
            </div>
            <p className="m-0 text-caption leading-[1.5] text-ink-2">{role.pauseKind ? `Pause applies to "${role.pauseKind}": every role in it stops.` : "This role has no pause of its own."}</p>
          </>
        )}
        {project && (
          <>
            <div><div className="font-mono text-caption text-ink-2">{project.path} · {project.branch}</div><div className="mt-1.5 text-xl font-medium tracking-[-0.01em]">{project.name}</div></div>
            <dl className="flex flex-col gap-2.5">
              <div className="flex"><dt className="text-ink-2">Open</dt><dd className="ml-auto font-mono">{project.open}</dd></div>
              <div className="flex"><dt className="text-ink-2"><Term k="needs-you">Need you</Term></dt><dd className="ml-auto font-mono">{project.needsYou}</dd></div>
              <div className="flex"><dt className="text-ink-2">Share of the week</dt><dd className="ml-auto font-mono">{share(data.billing, project.share)}</dd></div>
              <div className="flex"><dt className="text-ink-2">Last merge</dt><dd className="ml-auto">{merged(project.lastMerge).replace("merged ", "")}</dd></div>
            </dl>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-ink-2">
              <Button variant="ghost" size="sm" className="gap-1.5 px-0 text-ink-2 max-md:h-11 max-md:px-2" onClick={toggle} disabled={send.isPending}>{pauseLabel} project <Kbd className="font-mono text-xs text-ink-2">P</Kbd></Button>
            </div>
          </>
        )}
      </aside>

      <Key id="pause-role" run={toggle} enabled={canPause} />
      <Key id="edit-rules" run={() => role && setEditing(role)} enabled={!!role} />
      <Key id="reset-role" run={reset} enabled={!!role?.edited} />
      <Key id="team-add" run={() => setAdding(true)} />
      <Key id="undo" run={undo} enabled={!!saved?.id} />
      <EditRules role={editing} onClose={() => setEditing(null)} onSaved={(id, file) => setSaved({ id, file })} />
      <AddProjectDialog open={adding} root={welcome.data?.root ?? "~/projects"} repos={welcome.data?.repos ?? []} onClose={() => setAdding(false)} />
    </div>
  )
}

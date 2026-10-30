import { Button } from "@nimit9/signet-ui/components/button"
import { ErrorState } from "@nimit9/signet-ui/components/error-state"
import { Input } from "@nimit9/signet-ui/components/input"
import { Kbd } from "@nimit9/signet-ui/components/kbd"
import { TooltipProvider } from "@nimit9/signet-ui/components/tooltip"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nimit9/signet-ui/components/select"
import { useListNavigation } from "@nimit9/signet-ui/components/shortcuts"
import { Skeleton } from "@nimit9/signet-ui/components/skeleton"
import { Switch } from "@nimit9/signet-ui/components/switch"
import { Tabs, TabsList, TabsTrigger } from "@nimit9/signet-ui/components/tabs"
import { Link, useSearch } from "@tanstack/react-router"
import { Check, Minus, X } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { ConfigKey, ConfigView, HealthView, ProvidersView } from "../../../src/api-schema.ts"
import { markFits } from "../../../src/queue-math.ts"
import { CopyButton } from "../components/copy-button"
import { Key } from "../components/key"
import { Term } from "../components/term"
import { StopSlider } from "../components/stop-slider"
import { homePath, useJson, useSend } from "../lib/queries"
import { useSnapshot } from "../lib/snapshot"
import { SETTING_TERMS } from "../lib/glossary"
import { label } from "../lib/settings-labels"
import { clock, dayName, weekOf } from "../lib/week"

type Section = { id: string; label: string }
const SECTIONS: Section[] = [
  { id: "plan", label: "Plan and pacing" }, { id: "safety", label: "Safety" }, { id: "review", label: "Review rules" }, { id: "notifications", label: "Notifications" },
  { id: "deploys", label: "Deploys" }, { id: "providers", label: "Providers" }, { id: "stats", label: "Crash reports and usage stats" }, { id: "health", label: "Health" }, { id: "schedules", label: "Schedules" }, { id: "keys", label: "Keys" }, { id: "advanced", label: "Advanced" },
]
const OPTION_LABELS: Record<string, Record<string, string>> = {
  "safety.everyMerge": { auto: "On its own", review: "Strict review", owner: "I merge" },
  "review.provider": { local: "Dobby", external: "External", both: "Both" },
  "safety.deploy": { auto: "Deploy at once", ask: "Ask me" },
  deployFrom: { checkout: "Project checkout", worktree: "Fresh worktree" },
  deployOnFailure: { notify: "Tell me", ticket: "Tell me and file a fix", fix: "File and build the fix" },
  mergeChecks: { required: "Required ones", all: "All" },
  "billing.mode": { plan: "Claude plan", apiKey: "API key" },
}
const CATEGORIES = ["migrations.schema", "migrations.data", "payments", "auth", "secrets", "deploys", "config", "client-sites", "releases"]
const optLabel = (k: ConfigKey, o: string) => OPTION_LABELS[k.key]?.[o] ?? o
const show = (v: unknown) => (v === null || v === undefined ? "not set" : typeof v === "string" ? v || "empty" : Array.isArray(v) ? (v.length ? v.join(", ") : "none") : typeof v === "object" ? (Object.keys(v).length ? JSON.stringify(v) : "none") : String(v))

/** The terminal line for one setting: the same change `dobby config set` makes. */
export const command = (key: string, v: unknown) => {
  const plain = typeof v === "string" && /^[\w./:@~-]+$/.test(v)
  return `dobby config set ${key} ${plain || typeof v === "number" || typeof v === "boolean" ? String(v) : `'${JSON.stringify(v)}'`}`
}
/** Changed settings as the nested JSON the file holds. */
function changedJson(keys: ConfigKey[]) {
  const out: Record<string, unknown> = {}
  for (const k of keys) {
    const p = k.key.split("."); let cur = out
    for (const s of p.slice(0, -1)) cur = (cur[s] ??= {}) as Record<string, unknown>
    cur[p.at(-1)!] = k.value
  }
  return JSON.stringify(out, null, 2).split("\n")
}

function Dot({ title }: { title: string }) { return <span title={title} className="size-1.5 rounded-full bg-mark" role="img" aria-label={title} /> }

function Row({ id, k, on, onSelect, children, note, error, name }: { id?: string; k?: ConfigKey; on: boolean; onSelect: () => void; children: React.ReactNode; note?: React.ReactNode; error?: string; name?: string }) {
  return (
    <div
      data-row={id ?? k?.key} tabIndex={-1} onFocus={onSelect} onClick={onSelect} aria-label={name ?? (k ? label(k) : undefined)} role="group"
      className={`-mx-3.5 grid gap-x-8 gap-y-3 rounded-lg border-t border-line px-3.5 py-5 outline-none first:border-t-transparent md:grid-cols-[220px_minmax(0,1fr)] ${on ? "bg-raise shadow-[inset_0_0_0_1px_var(--line)]" : ""}`}
    >
      <div>
        <div className="flex items-center gap-2 text-base font-medium"><Term k={k ? SETTING_TERMS[k.key] : undefined}>{name ?? (k && label(k))}</Term>{k?.changed && <Dot title="Changed from default" />}</div>
        {k && <div className="mt-1.5 font-mono text-caption break-all text-ink-2">{k.key}</div>}
      </div>
      <div className="min-w-0">
        {children}
        {note && <div className="mt-2.5 text-sm leading-[1.5] text-ink-2">{typeof note === "string" ? note.charAt(0).toUpperCase() + note.slice(1) : note}</div>}
        {error && <p role="alert" className="mt-2 text-sm text-warn">{error}</p>}
        {k?.source === "project file" && <p className="mt-2 text-caption text-ink-2">Set by this project's own config file; a value in your file wins.</p>}
      </div>
    </div>
  )
}

/** One control for one setting, from its kind. `set` saves it (the server checks it again). */
function Control({ k, set, busy }: { k: ConfigKey; set: (v: unknown) => void; busy: boolean }) {
  const [text, setText] = useState<string | null>(null)
  const v = k.value
  if (k.kind === "boolean") return <Switch className="max-md:after:-inset-y-3.5" checked={v === true} onCheckedChange={(c) => set(c)} disabled={busy} aria-label={label(k)} />
  if (k.kind === "enum" && k.options) {
    const cur = String(v ?? "")
    if (k.options.length > 4) {
      return (
        <Select value={cur} onValueChange={(x) => x && set(x)}>
          <SelectTrigger aria-label={label(k)} className="w-60 max-md:h-11"><SelectValue>{optLabel(k, cur)}</SelectValue></SelectTrigger>
          <SelectContent>{k.options.map((o) => <SelectItem key={o} value={o}>{optLabel(k, o)}</SelectItem>)}</SelectContent>
        </Select>
      )
    }
    return (
      <Tabs value={cur} onValueChange={(x) => set(x)}>
        <TabsList aria-label={label(k)} className="max-md:h-auto max-md:w-full">{k.options.map((o) => <TabsTrigger key={o} value={o} className="px-3 max-md:min-h-11 max-md:flex-1">{optLabel(k, o)}</TabsTrigger>)}</TabsList>
      </Tabs>
    )
  }
  if (k.kind === "map") return <span className="font-mono text-sm text-ink-2 break-all">{show(v)}</span>
  const isList = k.kind === "list", isNum = k.kind === "number"
  const base = isList ? ((v as string[] | null) ?? []).join(", ") : v === null || v === undefined ? "" : String(v)
  const shown = text ?? base
  const commit = () => {
    if (text === null) return
    const t = text.trim(); setText(null)
    if (t === base) return
    set(isList ? t.split(",").map((x) => x.trim()).filter(Boolean) : isNum ? (t === "" ? undefined : Number(t)) : t)
  }
  return (
    <Input
      aria-label={label(k)} value={shown} inputMode={isNum ? "numeric" : undefined} type={isNum ? "number" : "text"} min={k.min} max={k.max} disabled={busy}
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur() }}
      className={`max-md:h-11 ${isNum ? "w-28 font-mono" : "w-full max-w-md"}`}
    />
  )
}

function HealthPanel() {
  const { data, error } = useJson<HealthView>("/api/health", { refetchInterval: 60_000 })
  if (error) return <p className="py-5 text-sm text-warn">The health checks did not answer.</p>
  if (!data) return <Skeleton className="mt-5 h-40 max-w-xl" />
  return (
    <ul aria-label="Health checks" className="flex flex-col">
      {data.checks.map((c) => (
        <li key={c.name} className="grid grid-cols-[18px_minmax(0,1fr)] gap-x-3 border-t border-line py-3.5 first:border-t-transparent md:grid-cols-[18px_150px_minmax(0,1fr)]">
          <span className={`mt-0.5 ${c.ok ? "text-mark" : c.required ? "text-warn" : "text-ink-2"}`} role="img" aria-label={c.ok ? "ok" : c.required ? "failing" : "optional, off"}>
            {c.ok ? <Check className="size-4" /> : c.required ? <X className="size-4" /> : <Minus className="size-4" />}
          </span>
          <span className="text-base font-medium max-md:col-start-2">{c.name}</span>
          <div className="min-w-0 max-md:col-start-2">
            <div className="text-sm text-ink-2">{c.detail}</div>
            {!c.ok && c.fix && <div className="mt-1.5 flex items-center gap-1 font-mono text-caption"><span className="min-w-0 break-words">{c.fix}</span><CopyButton text={c.fix} name={`the fix for ${c.name}`} /></div>}
          </div>
        </li>
      ))}
    </ul>
  )
}

function SchedulesPanel() {
  const { data, error } = useJson<HealthView>("/api/health", { refetchInterval: 60_000 })
  if (error) return <p className="py-5 text-sm text-warn">The schedules did not load.</p>
  if (!data) return <Skeleton className="mt-5 h-40 max-w-xl" />
  return (
    <ul aria-label="Schedules" className="flex flex-col">
      {data.schedules.map((s) => (
        <li key={s.name} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 gap-y-1 border-t border-line py-3.5 first:border-t-transparent md:grid-cols-[130px_minmax(0,1fr)_200px_110px]">
          <span className="text-base font-medium">{s.name}</span>
          <span className="text-sm text-ink-2 max-md:col-span-2 max-md:row-start-2">{s.what}</span>
          <span className="font-mono text-caption text-ink-2 max-md:col-span-2 max-md:row-start-3">{s.when}</span>
          <span className="justify-self-end font-mono text-caption">{s.next ? `${dayName(s.next)} ${clock(s.next)}` : "now"}</span>
        </li>
      ))}
    </ul>
  )
}

function ProvidersPanel() {
  const { data, error } = useJson<ProvidersView>("/api/providers", { refetchInterval: 60_000 })
  if (error) return <p className="py-5 text-sm text-warn">The providers did not load.</p>
  if (!data) return <Skeleton className="mt-5 h-40 max-w-xl" />
  return (
    <div>
      <ul aria-label="Providers" className="flex flex-col">
        {data.rows.map((r) => (
          <li key={r.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 border-t border-line py-3.5 first:border-t-transparent md:grid-cols-[minmax(0,1fr)_100px_110px_120px]">
            <span className="text-base font-medium">{r.label}</span>
            <span className="text-sm text-ink-2 max-md:hidden">{r.kind}</span>
            <span className={`text-sm ${r.detected ? "" : "text-ink-2"}`}>{r.detected ? "detected" : "not found"}</span>
            <span className="justify-self-end font-mono text-caption text-ink-2">{r.key === "none needed" ? "no key needed" : r.kind === "code tool" ? r.key : `key ${r.key}`}</span>
          </li>
        ))}
      </ul>
      {data.hidden > 0 && <p className="mt-3 text-sm text-ink-2">{data.hidden} more known providers are not set up. <code className="font-mono text-caption">dobby providers detect</code> lists what this machine can reach.</p>}
    </div>
  )
}

const STATS_DOC = "https://github.com/dapplelight/dobby/blob/main/docs/manual/stats.md"
function StatsPanel() {
  const [open, setOpen] = useState(false)
  const shown = useJson<{ text: string }>("/api/stats/show", { enabled: open })
  return (
    <div className="mt-5">
      <p className="max-w-[60ch] text-sm leading-[1.55] text-ink-2">Both are off until you turn them on. <a className="text-ink underline" href={STATS_DOC} target="_blank" rel="noreferrer">What is sent, field by field</a>. Terminal: <span className="font-mono text-caption text-ink">dobby stats</span></p>
      <Button variant="outline" size="sm" className="mt-3 max-md:h-11" onClick={() => { setOpen(true); void shown.refetch() }}>Show what's sent</Button>
      {open && (
        <pre aria-label="What is sent" className="mt-3 max-h-96 overflow-auto border-y border-line py-3.5 font-mono text-[12px] leading-[1.75] break-words whitespace-pre-wrap text-ink-2">
          {shown.error ? "This did not load." : shown.data ? shown.data.text : "Loading."}
        </pre>
      )}
    </div>
  )
}

function KeysPanel({ cv }: { cv: ConfigView }) {
  return (
    <div>
      <p className="max-w-[60ch] text-sm leading-[1.55] text-ink-2">Keys live in <span className="font-mono text-caption text-ink">{homePath(cv.secretsFile)}</span>. This page only says whether each one is set; it never shows or changes a key.</p>
      <ul aria-label="Keys" className="mt-3 flex flex-col">
        {cv.secrets.map((s) => (
          <li key={s.name} className="flex items-center gap-3 border-t border-line py-3.5 first:border-t-transparent">
            <span className="font-mono text-sm">{s.name}</span>
            <span className={`ml-auto text-sm ${s.set ? "text-mark" : "text-ink-2"}`}>{s.set ? "set" : "not set"}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SettingsPage() {
  const cfg = useJson<ConfigView>("/api/config", { refetchInterval: 10_000 })
  const snap = useSnapshot()
  const send = useSend()
  const [section, setSection] = useState("plan")
  const [sel, setSel] = useState<string>()
  const jump = useSearch({ from: "/settings" }).find // from ⌘K: show that setting's row
  const [find, setFind] = useState(jump ?? "")
  useEffect(() => { if (jump) setFind(jump) }, [jump])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [undoIds, setUndoIds] = useState<string[]>([])
  const [copied, setCopied] = useState(false)
  const findRef = useRef<HTMLInputElement>(null)
  const keys = cfg.data?.keys ?? []
  const byKey = useMemo(() => new Map(keys.map((k) => [k.key, k])), [keys])
  const PLAN_ONLY = ["pacing.fallbackBuildsPerDay", "reviewCap", "billing.planUsd"] // read the Claude plan: nothing to set on an API key
  const onKey = snap.data?.limits?.state === "apiKey"
  const inSection = (id: string) => keys.filter((k) => k.section === id && k.key !== "stats.endpoint" && !(onKey && PLAN_ONLY.includes(k.key))) // the endpoint is set in the file, not shown as a switch
  const q = find.trim().toLowerCase()
  const hits = q ? keys.filter((k) => `${k.key} ${label(k)} ${k.desc}`.toLowerCase().includes(q)) : null
  const cur = SECTIONS.find((s) => s.id === section)!
  const rows = hits ?? (section === "plan" ? inSection("plan").filter((k) => k.key !== "safety.everyMerge" && k.key !== "pacing.weekCap") : inSection(section))
  const special = ["health", "schedules", "keys"].includes(section) && !hits
  const rowIds = [...(hits ? [] : section === "plan" ? [...(snap.data?.limits?.state === "apiKey" ? [] : ["pacing.weekCap"]), "safety.everyMerge", "merges.paused"] : []), ...(special ? [] : rows.map((r) => r.key))]
  const ids = section === "safety" && !hits ? rowIds.filter((i) => i !== "safety.rules") : rowIds
  const active = sel && ids.includes(sel) ? sel : ids[0]
  const focus = (id: string) => requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-row="${id}"]`)?.focus())
  useListNavigation({ ids, activeId: active, onActiveChange: (id) => { setSel(id); focus(id) }, arrows: false, group: "Settings" })

  const apply = async (body: Record<string, unknown>, key: string) => {
    setErrors((e) => ({ ...e, [key]: "" }))
    try { const r = await send.mutateAsync({ action: "configSet", ...body }); return r.actionId } catch (e) { setErrors((x) => ({ ...x, [key]: (e as Error).message })); return undefined }
  }
  const change = async (k: ConfigKey, value: unknown) => { const id = await apply(value === undefined ? { key: k.key, unset: true } : { key: k.key, value }, k.key); if (id) setUndoIds([id]); return !!id }
  const undo = async () => {
    for (const id of [...undoIds].reverse()) try { await send.mutateAsync({ action: "undo", actionId: id }) } catch (e) { setErrors((x) => ({ ...x, _: (e as Error).message })) }
    setUndoIds([])
  }
  const sectionKeys = hits ?? inSection(section)
  const changedHere = sectionKeys.filter((k) => k.changed)
  const reset = async () => {
    const ids: string[] = []
    for (const k of changedHere.filter((x) => x.source === "config file")) { const id = await apply({ key: k.key, unset: true }, k.key); if (id) ids.push(id) }
    if (ids.length) setUndoIds(ids)
  }
  const step = (dir: 1 | -1) => {
    const k = active ? byKey.get(active) : undefined
    if (!k) return
    if (k.kind === "boolean") return void change(k, dir > 0)
    if (k.kind === "enum" && k.options) { const i = k.options.indexOf(String(k.value)) + dir; if (i >= 0 && i < k.options.length) void change(k, k.options[i]); return }
    if (k.kind === "number" && typeof k.value === "number") { const n = k.value + dir; if ((k.min === undefined || n >= k.min) && (k.max === undefined || n <= k.max)) void change(k, n) }
  }
  const json = changedJson(changedHere)
  const copyJson = () => { void navigator.clipboard?.writeText(json.join("\n")); setCopied(true); setTimeout(() => setCopied(false), 1500) }

  if (cfg.error) return <ErrorState message={cfg.error.message === "signin" ? "This browser is not signed in: run `dobby dashboard open`." : "The dashboard server did not answer."} onRetry={() => cfg.refetch()} />
  if (!cfg.data) return <Skeleton className="h-24 max-w-xl" />

  const snapData = snap.data
  const apiKey = snapData?.limits?.state === "apiKey" // billed by the token: no plan, no week to stop at
  const week = weekOf(snapData?.limits, snapData?.week.series)
  const q_ = snapData?.queue
  const cap = byKey.get("pacing.weekCap"), merging = byKey.get("safety.everyMerge")
  const fitsAt = (stop: number) => (q_ && week ? markFits(q_.order, Math.max(0, stop - week.usedPct)).filter(Boolean).length : null)
  const total = q_?.order.length ?? 0
  const mergesPaused = ((snapData?.pause ?? []) as { scope?: string }[]).some((p) => p.scope === "merges")
  const selKey = active ? byKey.get(active) : undefined
  const cliLine = selKey ? command(selKey.key, selKey.value) : active === "merges.paused" ? `dobby ${mergesPaused ? "resume" : "pause"} merges` : ""
  const select = (id: string) => () => setSel(id)
  const on = (id: string) => active === id

  return (
    <div className="grid gap-x-16 md:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <h1 className="max-w-[24ch] font-display text-[27px] leading-(--leading-display) font-normal tracking-[-0.015em] text-balance md:text-display">
          {hits ? `${hits.length} ${hits.length === 1 ? "setting matches" : "settings match"}.` : section === "plan" ? (apiKey ? "How the team spends your budget." : "How the team uses your plan.") : `${cur.label}.`}
        </h1>
        <div className="mt-7 grid gap-x-10 gap-y-5 md:grid-cols-[168px_minmax(0,1fr)]">
          <nav aria-label="Settings sections" className="-mx-5 flex gap-1 overflow-x-auto px-5 text-[13.5px] max-md:[mask-image:linear-gradient(to_right,black_calc(100%-2rem),transparent)] max-md:pr-10 md:mx-0 md:flex-col md:gap-0.5 md:overflow-visible md:px-0">
            {SECTIONS.map((s, i) => {
              const n = s.id === "health" || s.id === "schedules" || s.id === "keys" ? 0 : inSection(s.id).filter((k) => k.changed).length
              return (
                <span key={s.id} className="contents">
                  <button
                    type="button" aria-current={section === s.id && !hits ? "page" : undefined} onClick={() => { setSection(s.id); setFind("") }}
                    className={`flex h-8 shrink-0 items-center rounded-md px-2.5 whitespace-nowrap md:-ml-2.5 max-md:h-11 ${section === s.id && !hits ? "bg-raise text-ink shadow-[inset_0_0_0_1px_var(--line)]" : "text-ink-2 hover:text-ink"}`}
                  >
                    {s.id === "plan" && apiKey ? "Budget and pacing" : s.label}{n > 0 && <span className="ml-auto pl-3 font-mono text-caption text-ink-2" aria-label={`${n} changed from default`}>{n}</span>}
                  </button>
                  {i === 0 && <Link to="/team" className="flex h-8 shrink-0 items-center rounded-md px-2.5 whitespace-nowrap text-ink-2 no-underline hover:text-ink md:-ml-2.5 max-md:h-11">Team and projects</Link>}
                </span>
              )
            })}
          </nav>
          <div className="min-w-0">
            <Input ref={findRef} value={find} onChange={(e) => setFind(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { setFind(""); e.currentTarget.blur() } }} placeholder="Find a setting" aria-label="Find a setting" className="mb-3 max-w-xs max-md:h-11" />
            {errors._ && <p role="alert" className="mb-3 text-sm text-warn">{errors._}</p>}

            {!hits && section === "plan" && cap && (
              <>
                {!apiKey && <Row k={cap} on={on("pacing.weekCap")} onSelect={select("pacing.weekCap")} error={errors[cap.key]}
                  note={week && fitsAt(Number(cap.value)) !== null ? (
                    <>Drag the stop on the week line, or type a number. At <span className="text-ink">{String(cap.value)}%</span>, {fitsAt(Number(cap.value))} of {total} queued tickets fit this week
                      {Number(cap.value) - 5 >= (cap.min ?? 10) ? `; at ${Number(cap.value) - 5}%, ${fitsAt(Number(cap.value) - 5)} fit.` : "."}</>
                  ) : "No plan reading yet, so no ticket count. The stop can still be set."}>
                  <StopSlider week={week} value={Number(cap.value)} min={cap.min ?? 10} max={cap.max ?? 100} onFocus={select("pacing.weekCap")} onCommit={(v) => void change(cap, v)} />
                  <label className="mt-3 flex items-center gap-2 text-sm text-ink-2">Or type it
                    <Input aria-label="Stop at (percent)" type="number" inputMode="numeric" min={cap.min} max={cap.max} defaultValue={String(cap.value)} key={String(cap.value)} className="w-20 font-mono max-md:h-11"
                      onBlur={(e) => { const box = e.target, n = Number(box.value); if (box.value === "") box.value = String(cap.value); else if (n !== cap.value) void change(cap, n).then((ok) => { if (!ok) box.value = String(cap.value) }) }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur() }} />
                  </label>
                </Row>}
                {merging && (
                  <Row k={merging} on={on("safety.everyMerge")} onSelect={select("safety.everyMerge")} error={errors[merging.key]}
                    note="On its own: normal review, then Dobby merges. Strict review: the strict Opus review first. I merge: Dobby opens a draft pull request and you merge it.">
                    <Control k={merging} set={(v) => void change(merging, v)} busy={send.isPending} />
                  </Row>
                )}
                <Row id="merges.paused" name="Merging paused" on={on("merges.paused")} onSelect={select("merges.paused")} error={errors.merges}
                  note={mergesPaused ? "Reviewed pull requests wait. They land when you resume." : "Merging is on. Pause it to hold every merge without changing the setting above."}>
                  <Switch className="max-md:after:-inset-y-3.5" checked={mergesPaused} aria-label="Merging paused" disabled={send.isPending}
                    onCheckedChange={(c) => { setErrors((e) => ({ ...e, merges: "" })); send.mutate({ action: c ? "pause" : "resume", kind: "merges" }, { onError: (e) => setErrors((x) => ({ ...x, merges: e.message })) }) }} />
                </Row>
              </>
            )}

            {!special && !(section === "safety" && !hits) && rows.map((k) => (
              <Row key={k.key} k={k} on={on(k.key)} onSelect={select(k.key)} error={errors[k.key]} note={hits ? <>{SECTIONS.find((s) => s.id === k.section)?.label}. {k.desc}</> : k.desc}>
                <Control k={k} set={(v) => void change(k, v)} busy={send.isPending} />
              </Row>
            ))}

            {!hits && section === "safety" && (
              <>
                {rows.filter((k) => k.key !== "safety.rules").map((k) => (
                  <Row key={k.key} k={k} on={on(k.key)} onSelect={select(k.key)} error={errors[k.key]} note={k.desc}><Control k={k} set={(v) => void change(k, v)} busy={send.isPending} /></Row>
                ))}
                <Row name="Rules by category" on={false} onSelect={() => {}} note="Each category takes the preset's answer unless you set one here: auto (normal review, then merge), review (strict review), owner (needs you, no merge) or never (agents do not touch it).">
                  <ul aria-label="Rules by category" className="flex flex-col gap-2">
                    {CATEGORIES.map((c) => {
                      const rules = (byKey.get("safety.rules")?.value ?? {}) as Record<string, string>, key = `safety.rules.${c}`
                      return (
                        <li key={c} className="flex items-center gap-3">
                          <span className="w-36 font-mono text-caption">{c}</span>
                          <Select value={rules[c] ?? "preset"} onValueChange={(x) => x && void apply(x === "preset" ? { key, unset: true } : { key, value: x }, key).then((id) => id && setUndoIds([id]))}>
                            <SelectTrigger aria-label={`Rule for ${c}`} className="w-44 max-md:h-11"><SelectValue>{rules[c] ?? "preset's answer"}</SelectValue></SelectTrigger>
                            <SelectContent>{["preset", "auto", "review", "owner", "never"].map((o) => <SelectItem key={o} value={o}>{o === "preset" ? "preset's answer" : o}</SelectItem>)}</SelectContent>
                          </Select>
                          {errors[key] && <span role="alert" className="text-sm text-warn">{errors[key]}</span>}
                        </li>
                      )
                    })}
                  </ul>
                </Row>
              </>
            )}

            {!hits && section === "health" && <HealthPanel />}
            {!hits && section === "schedules" && <SchedulesPanel />}
            {!hits && section === "keys" && <KeysPanel cv={cfg.data} />}
            {!hits && section === "providers" && (<div className="mt-4"><ProvidersPanel /></div>)}
            {!hits && section === "stats" && <StatsPanel />}
            {rows.length === 0 && !special && section !== "plan" && section !== "safety" && <p className="py-6 text-sm text-ink-2">{hits ? "No setting matches that." : "Nothing to set here."}</p>}
          </div>
        </div>
      </div>

      <aside aria-label="Config preview" className="flex flex-col gap-5.5 text-sm max-md:mt-10 max-md:border-t max-md:border-line max-md:pt-6 md:border-l md:border-line md:pl-7">
        <div className="flex items-baseline">
          <span className="text-xl font-medium tracking-[-0.01em]">Changed from default</span>
          <span className="ml-auto font-mono text-mark" aria-label={`${changedHere.length} changed`}>{changedHere.length}</span>
        </div>
        <pre className="m-0 border-y border-line py-3.5 font-mono text-[12px] leading-[1.75] break-all whitespace-pre-wrap text-ink-2" aria-label="Changed settings as JSON">
          {changedHere.length ? json.map((l, i) => <span key={i} className={`-mx-2 block rounded-sm px-2 ${selKey && l.includes(`"${selKey.key.split(".").at(-1)}"`) ? "bg-hover text-ink" : ""}`}>{l}</span>) : "Nothing changed here."}
        </pre>
        {cliLine && (
          <div>
            <div className="text-ink-2">Same change from the terminal</div>
            <div className="mt-2 flex items-center gap-1 font-mono text-[12px]"><span className="min-w-0 break-words">{cliLine}</span><CopyButton text={cliLine} name="the terminal command" /></div>
          </div>
        )}
        <p className="m-0 leading-[1.55] text-ink-2">Saved as you change it, to <span className="font-mono text-ink break-all">{homePath(cfg.data.file)}</span>. Edits to that file show up here.</p>
        {cfg.data.warnings.length > 0 && <p role="alert" className="m-0 text-warn">{cfg.data.warnings[0]}{cfg.data.warnings.length > 1 ? ` (+${cfg.data.warnings.length - 1} more)` : ""}</p>}
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-ink-2">
          <Button variant="ghost" size="sm" className="gap-1.5 px-0 text-ink-2 max-md:h-11 max-md:px-2" onClick={copyJson} disabled={!changedHere.length}>{copied ? "Copied" : "Copy JSON"} <Kbd className="font-mono text-xs text-ink-2">C</Kbd></Button>
          <Button variant="ghost" size="sm" className="gap-1.5 px-0 text-ink-2 max-md:h-11 max-md:px-2" onClick={() => void undo()} disabled={!undoIds.length}>Undo <Kbd className="font-mono text-xs text-ink-2">U</Kbd></Button>
          <Button variant="ghost" size="sm" className="gap-1.5 px-0 text-ink-2 max-md:h-11 max-md:px-2" onClick={() => void reset()} disabled={!changedHere.some((k) => k.source === "config file")}>Reset section <Kbd className="font-mono text-xs text-ink-2">R</Kbd></Button>
        </div>
      </aside>

      <Key id="config-set" run={() => step(1)} enabled={!!active} />
      <Key id="settings-dec" run={() => step(-1)} enabled={!!active} />
      <Key id="settings-find" run={() => findRef.current?.focus()} />
      <Key id="settings-copy" run={copyJson} enabled={changedHere.length > 0} />
      <Key id="settings-undo" run={() => void undo()} enabled={undoIds.length > 0} />
      <Key id="settings-reset" run={() => void reset()} enabled={changedHere.some((k) => k.source === "config file")} />
    </div>
  )
}

// Signet's SelectItem is wrapped in a Tooltip that needs this provider. It sits here, not at the app root, so the tooltip code stays out of the first load.
export function Settings() {
  return <TooltipProvider><SettingsPage /></TooltipProvider>
}

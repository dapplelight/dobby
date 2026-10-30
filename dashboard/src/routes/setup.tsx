import { Button } from "@nimit9/signet-ui/components/button"
import { Checkbox } from "@nimit9/signet-ui/components/checkbox"
import { Input } from "@nimit9/signet-ui/components/input"
import { PillGroup } from "@nimit9/signet-ui/components/pill-group"
import { Skeleton } from "@nimit9/signet-ui/components/skeleton"
import { Switch } from "@nimit9/signet-ui/components/switch"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import type { SetupState } from "../../../src/api-schema.ts"
import { CopyButton } from "../components/copy-button"
import { Step } from "../components/step"
import { StopSlider } from "../components/stop-slider"
import { postSetup, sendAction } from "../lib/api"
import { useJson } from "../lib/queries"
import { useSnapshot } from "../lib/snapshot"
import { clock, dayName, weekOf } from "../lib/week"

const KEY = ["/api/setup/state"]
const STEPS = ["This machine", "Two optional questions", "Projects", "Where Dobby asks you", "Safety", "Stop at", "Recommended tools", "Start Dobby"] as const
/** The terminal twin of each step. */
const TERMINAL: string[][] = [["dobby doctor"], ["dobby stats", "dobby stats on crashes"], ["dobby init --projects ~/code", "dobby init ~/code/shop"], ["dobby discord invite", "dobby add discord"], ['dobby config set safety.preset balanced'], ["dobby config set pacing.weekCap 95"], ["dobby tools", "dobby tools off ponytail"], ["dobby jobs install", 'dobby add shop "Export to CSV"']]
const PRESET_HINTS: Record<string, string> = { strict: "every merge waits for you", balanced: "data migrations, client sites and releases wait for you; login, payments and secrets get the strict review", autonomous: "never waits for you; risky changes get the strict review" }
const AUTO_HINTS: Record<string, string> = { off: "only when you comment @dobby review", drafts: "drafts too", on: "every PR" }
const DEPLOY_HINTS: Record<string, string> = { ask: "a Deploy tap; nothing goes live until you tap it", auto: "deploy at once" }
const opts = (xs: string[], names: Record<string, string> = {}) => xs.map((value) => ({ value, label: names[value] ?? value[0].toUpperCase() + value.slice(1) }))

/** One call to /api/setup/<step>; the state is read again when it lands. */
function useStep() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: ({ step, body }: { step: string; body?: Record<string, unknown> }) => postSetup(step, body), onSettled: () => qc.invalidateQueries({ queryKey: KEY }) })
}
const Err = ({ e }: { e: Error | null }) => (e ? <p role="alert" className="m-0 mt-2 text-sm text-warn">{e.message}</p> : null)
const Cmd = ({ c }: { c: string }) => <div className="flex items-center gap-1 font-mono text-[12.5px]"><span className="min-w-0 break-all">{c}</span><CopyButton text={c} name={c} /></div>
const Next = ({ onClick, disabled, children = "Continue" }: { onClick: () => void; disabled?: boolean; children?: React.ReactNode }) => <Button className="mt-3 max-md:h-11" disabled={disabled} onClick={onClick}>{children}</Button>

export default function SetupFlow() {
  const st = useJson<SetupState>("/api/setup/state")
  const [cur, setCur] = useState(0)
  const s = st.data
  const call = useStep()
  const checked = useRef(false)
  useEffect(() => { if (s && !checked.current) { checked.current = true; call.mutate({ step: "check" }) } }, [s, call])
  if (!s) return <Skeleton className="h-24 max-w-xl" />
  const done = [!!s.checks && !s.blocking.length, s.stats.answered, Object.values(s.verify).some((v) => v.state === "ok"), cur > 3, s.settingsSaved && cur > 4, s.settingsSaved && cur > 5, cur > 6, s.finished]
  const next = () => setCur((c) => c + 1)
  const open = (i: number) => cur === i
  const summary = [
    s.checks ? `${s.checks.filter((r) => r.ok).length} of ${s.checks.length} checks pass` : "",
    s.stats.forced ? `${s.stats.forced}: both off` : "Answered",
    `${Object.values(s.verify).filter((v) => v.state === "ok").length} project${Object.values(s.verify).filter((v) => v.state === "ok").length === 1 ? "" : "s"} ready`,
    "Saved", "Saved", `Stop at ${s.weekCap}%`, "Saved", s.jobs.state === "installed" ? "Dobby is running" : "Jobs later",
  ]
  // a function that returns elements, not a component: a component made here would be a new type on every render and lose its children's state
  const Row = (i: number, children: React.ReactNode) => (
    <Step key={i} n={i + 1} done={done[i] && !open(i)} title={STEPS[i]}>
      {open(i) ? children : <div className="flex items-center gap-3 text-sm text-ink-2"><span>{summary[i]}</span>{i < cur && <Button variant="ghost" size="sm" className="max-md:h-11" onClick={() => setCur(i)}>Change</Button>}</div>}
    </Step>
  )
  return (
    <div className="grid gap-x-16 md:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <h1 className="max-w-[24ch] font-display text-[27px] leading-(--leading-display) font-normal tracking-[-0.015em] text-balance md:text-display">Pick a project. Dobby works on it once its jobs are running.</h1>
        <div className="mt-6 max-w-[760px]">
          {s.finished ? <Finished s={s} /> : <>
            {cur >= 0 && Row(0, <Machine s={s} call={call} onNext={next} />)}
            {cur >= 1 && Row(1, <Stats s={s} call={call} onNext={next} />)}
            {cur >= 2 && Row(2, <Projects s={s} call={call} onNext={next} />)}
            {cur >= 3 && Row(3, <Chat s={s} call={call} onNext={next} />)}
            {cur >= 4 && <Settings s={s} call={call} cur={cur} setCur={setCur} Row={Row} />}
            {cur >= 6 && Row(6, <Tools s={s} call={call} onNext={next} />)}
            {cur >= 7 && Row(7, <Start s={s} call={call} />)}
          </>}
        </div>
      </div>
      <aside aria-label="What happens next" className="flex flex-col gap-5.5 text-sm max-md:mt-8 max-md:border-t max-md:border-line max-md:pt-6 md:border-l md:border-line md:pl-7">
        <div className="text-xl font-medium tracking-[-0.01em]">What happens next</div>
        {([["Engineering Manager", "plans the work and sizes it against your week"], ["Builder", "writes it, with tests"], ["Reviewer", "reads the pull request and requests changes with findings, up to two fix rounds"], ["Tester", "checks the result against your done-when line"], ["You", s.fresh ? "merge from Home. Merging starts paused until you resume it." : "merge from Home, or let it merge on its own"]] as const).map(([k, v]) => (
          <div key={k} className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 leading-[1.45]"><span className="font-medium">{k}</span><span className="text-ink-2">{v}</span></div>
        ))}
        <div>
          <div className="text-ink-2">Same thing from the terminal</div>
          <div className="mt-2 flex flex-col leading-[1.8]">{(TERMINAL[Math.min(cur, 7)] ?? []).map((c) => <Cmd key={c} c={c} />)}</div>
        </div>
      </aside>
    </div>
  )
}

const CHECKS = ["Node", "shell", "git", "GitHub CLI", "GitHub sign-in", "Claude Code", "Claude sign-in", "API key"]
const ASK = "Ask Claude"
const SONNET = "Try a stronger model"
type Help = { ok: boolean; message: string; suggestion: { install?: string; test?: string; cause?: string; fix?: string } | null; refused: { field: string; reason: string }[]; model: string }

/** Ask Claude about one repo or one check. Nothing is asked until the button is clicked; the answer is a proposal in editable fields, and nothing runs until "Use these". */
function HelpBox({ s, kind, repo, check, call }: { s: SetupState; kind: "no-commands" | "verify-failed" | "check"; repo?: string; check?: string; call: ReturnType<typeof useStep> }) {
  const [res, setRes] = useState<Help | null>(null)
  const [install, setInstall] = useState(""), [test, setTest] = useState("")
  const ask = useMutation({ mutationFn: (model?: string) => postSetup("help", { kind, repo, check, ...(model ? { model } : {}) }) as unknown as Promise<Help>, onSuccess: (r) => { setRes(r); setInstall(r.suggestion?.install ?? ""); setTest(r.suggestion?.test ?? "") } })
  if (!s.help.ok) return <p className="m-0 mt-1 text-sm text-ink-2">Ask Claude is off: {s.help.reason}</p>
  const sg = res?.suggestion
  return (
    <div className="mt-1">
      <div className="flex flex-wrap gap-2.5">
        {!res && <Button variant="outline" size="sm" className="max-md:h-11" disabled={ask.isPending} onClick={() => ask.mutate(undefined)}>{ask.isPending ? "Asking Claude" : ASK}</Button>}
        {res && res.model === "haiku" && <Button variant="outline" size="sm" className="max-md:h-11" disabled={ask.isPending} onClick={() => ask.mutate("sonnet")}>{SONNET}</Button>}
      </div>
      <Err e={ask.error} />
      {res && !res.ok && <p role="status" className="m-0 mt-1 text-sm text-ink-2">Claude couldn't suggest anything; edit the commands yourself.</p>}
      {res?.message && res.ok && <p className="m-0 mt-1 text-sm text-ink-2">{res.message}</p>}
      {res?.refused.map((x) => <p key={x.field} className="m-0 mt-1 text-sm text-warn">Not used: the {x.field} command. {x.reason}</p>)}
      {sg && (
        <div role="status" className="mt-2 flex flex-col gap-2 text-sm">
          {sg.cause && <p className="m-0"><span className="font-medium">Cause</span> {sg.cause}</p>}
          {sg.fix && <p className="m-0"><span className="font-medium">Fix</span> {sg.fix}</p>}
          {kind !== "check" && (sg.install || sg.test) && repo && (
            <>
              {sg.install && <Input aria-label="Suggested install command" value={install} onChange={(e) => setInstall(e.target.value)} className="font-mono max-md:h-11" />}
              {sg.test && <Input aria-label="Suggested test command" value={test} onChange={(e) => setTest(e.target.value)} className="font-mono max-md:h-11" />}
              <div><Button size="sm" className="max-md:h-11" disabled={call.isPending} onClick={() => call.mutate({ step: "repos/commands", body: { name: repo, ...(sg.install ? { install } : {}), ...(sg.test ? { test } : {}) } })}>Use these</Button></div>
              <p className="m-0 text-ink-2">They run in the repo's folder and are saved to its project file.</p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** A repo that did not pass: add it anyway, type the test command, ask Claude, or skip. */
function Failed({ s, name, call }: { s: SetupState; name: string; call: ReturnType<typeof useStep> }) {
  const r = s.repos.find((x) => x.name === name)!
  const [cmd, setCmd] = useState(r.test ?? ""), [edit, setEdit] = useState(false)
  if (s.verify[name]?.step === null) return <div className="mt-1"><Button variant="ghost" size="sm" className="max-md:h-11" disabled={call.isPending} onClick={() => call.mutate({ step: "repos/skip", body: { name } })}>Skip</Button></div> // an access problem, not a test: fix it on GitHub, then check again
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2.5">
        <Button variant="outline" size="sm" className="max-md:h-11" disabled={call.isPending} onClick={() => call.mutate({ step: "repos/add-anyway", body: { name } })}>Add anyway (tests off until fixed)</Button>
        <Button variant="outline" size="sm" className="max-md:h-11" onClick={() => setEdit((e) => !e)}>Set the test command</Button>
        <Button variant="ghost" size="sm" className="max-md:h-11" disabled={call.isPending} onClick={() => call.mutate({ step: "repos/skip", body: { name } })}>Skip</Button>
      </div>
      {edit && (
        <form className="flex flex-wrap gap-2.5" onSubmit={(e) => { e.preventDefault(); if (cmd.trim()) call.mutate({ step: "repos/commands", body: { name, test: cmd.trim() } }) }}>
          <Input aria-label="Test command" value={cmd} onChange={(e) => setCmd(e.target.value)} className="min-w-0 flex-1 basis-60 font-mono max-md:h-11" />
          <Button type="submit" size="sm" className="max-md:h-11" disabled={!cmd.trim() || call.isPending}>Check again</Button>
        </form>
      )}
      <HelpBox s={s} kind="verify-failed" repo={name} call={call} />
    </div>
  )
}

type P = { s: SetupState; call: ReturnType<typeof useStep>; onNext: () => void }

function Machine({ s, call, onNext }: P) {
  return (
    <>
      <p className="m-0 mb-2 text-sm text-ink-2">Dobby needs these. The page never signs you in or takes a key.</p>
      {!s.checks ? <Skeleton className="h-24 max-w-xl" /> : (
        <ul aria-label="Checks" className="m-0 flex list-none flex-col gap-2 p-0">
          {s.checks.map((r) => (
            <li key={r.name} className="text-sm">
              <div className="flex gap-2"><span aria-hidden="true" className={r.ok ? "" : r.required ? "text-warn" : "text-ink-2"}>{r.ok ? "✓" : r.required ? "✗" : "·"}</span><span className="font-medium">{r.name}</span><span className="min-w-0 text-ink-2">{r.detail}</span></div>
              {!r.ok && r.fix && <div className="ml-5"><Cmd c={r.fix} /></div>}
              {!r.ok && r.required && CHECKS.includes(r.name) && <div className="ml-5"><HelpBox s={s} kind="check" check={r.name} call={call} /></div>}
            </li>
          ))}
        </ul>
      )}
      {s.checks && (s.dobbyCommand || s.terminal.some((t) => t.name === "Anthropic API key")) && (
        <ul aria-label="Other rows" className="m-0 mt-2 flex list-none flex-col gap-2 p-0">
          {s.dobbyCommand && <li className="text-sm"><div className="flex gap-2"><span aria-hidden="true" className="text-ink-2">·</span><span className="font-medium">dobby command</span><span className="min-w-0 text-ink-2">{s.dobbyCommand.why}</span></div><div className="ml-5"><Cmd c={s.dobbyCommand.command} /></div></li>}
          {s.terminal.filter((t) => t.name === "Anthropic API key").map((t) => <li key={t.name} className="text-sm"><div className="flex gap-2"><span aria-hidden="true" className="text-ink-2">·</span><span className="font-medium">{t.name}</span><span className="min-w-0 text-ink-2">{t.why}</span></div><div className="ml-5"><Cmd c={t.command} /></div></li>)}
        </ul>
      )}
      <div className="flex flex-wrap gap-2.5">
        <Button variant="outline" className="mt-3 max-md:h-11" disabled={call.isPending} onClick={() => call.mutate({ step: "check" })}>Check again</Button>
        <Next onClick={onNext} disabled={!s.checks || s.blocking.length > 0}>Continue</Next>
      </div>
      {s.blocking.length > 0 && <p className="m-0 mt-2 text-sm text-ink-2">Fix {s.blocking.join(", ")} in a terminal, then check again.</p>}
      <Err e={call.error} />
    </>
  )
}

function Stats({ s, call, onNext }: P) {
  const [crashes, setCrashes] = useState(""), [usage, setUsage] = useState("")
  const yn = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]
  if (s.stats.forced) return <><p className="m-0 text-sm text-ink-2">{s.stats.forced}: crash reports and usage stats stay off.</p><Next onClick={() => call.mutate({ step: "stats" }, { onSuccess: onNext })} /></>
  return (
    <>
      <p className="m-0 mb-3 text-sm text-ink-2">Both are off unless you say yes. What is sent: <code className="font-mono text-xs">dobby docs stats</code></p>
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex flex-col gap-1.5"><span id="q-crash">Send crash reports? (error type and place in Dobby's code, no text)</span><div role="group" aria-labelledby="q-crash"><PillGroup options={yn} value={crashes} onChange={setCrashes} /></div></div>
        <div className="flex flex-col gap-1.5"><span id="q-usage">Send usage stats? (which features you use and how far setup got, counts only)</span><div role="group" aria-labelledby="q-usage"><PillGroup options={yn} value={usage} onChange={setUsage} /></div></div>
      </div>
      <Next onClick={() => call.mutate({ step: "stats", body: { crashes: crashes === "yes", usage: usage === "yes" } }, { onSuccess: onNext })} disabled={call.isPending} />
      <Err e={call.error} />
    </>
  )
}

function Projects({ s, call, onNext }: P) {
  const [picked, setPicked] = useState<Set<string> | null>(null)
  const [folder, setFolder] = useState(""), [path, setPath] = useState("")
  const on = picked ?? new Set(s.repos.filter((r) => r.hasTests).map((r) => r.name))
  const toggle = (n: string) => setPicked(() => { const x = new Set(on); if (x.has(n)) x.delete(n); else x.add(n); return x })
  const running = Object.values(s.verify).some((v) => v.state === "running" || v.state === "waiting")
  const okCount = Object.values(s.verify).filter((v) => v.state === "ok").length
  const groups = [...new Set(s.repos.map((r) => r.from))]
  return (
    <>
      <p className="m-0 mb-2 text-sm text-ink-2">Folders to look in. Only the repo list is read, nothing is run until you check a repo.</p>
      <ul aria-label="Folders" className="m-0 flex list-none flex-col p-0">
        {s.roots.map((r) => <li key={r} className="flex min-h-11 items-center gap-2 text-sm"><span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{r}</span><Button variant="ghost" size="sm" className="max-md:h-11" onClick={() => call.mutate({ step: "repos/roots", body: { roots: s.roots.filter((x) => x !== r) } })}>Remove</Button></li>)}
        {s.commonRoots.filter((r) => !s.roots.includes(r)).map((r) => <li key={r} className="flex min-h-11 items-center gap-2 text-sm text-ink-2"><span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{r}</span><Button variant="ghost" size="sm" className="max-md:h-11" onClick={() => call.mutate({ step: "repos/roots", body: { roots: [...s.roots, r] } })}>Add</Button></li>)}
      </ul>
      <form className="mt-1 flex flex-wrap gap-2.5" onSubmit={(e) => { e.preventDefault(); if (folder.trim()) call.mutate({ step: "repos/roots", body: { roots: [...s.roots, folder.trim()] } }, { onSuccess: () => setFolder("") }) }}>
        <Input aria-label="Another folder" placeholder="~/code" value={folder} onChange={(e) => setFolder(e.target.value)} className="min-w-0 flex-1 basis-48 max-md:h-11" />
        <Button type="submit" variant="outline" disabled={!folder.trim() || call.isPending} className="max-md:h-11">Add folder</Button>
      </form>
      <h3 className="m-0 mt-5 text-base font-medium">Repos with a GitHub remote</h3>
      {s.skipped.map((l) => <div key={l.text} role="status" className="mt-1 text-sm text-ink-2">{l.text}{l.fix && <div className="mt-0.5"><Cmd c={l.fix} /></div>}</div>)}
      {s.repos.length === 0 && <p className="m-0 mt-1 text-sm text-ink-2">None found in these folders. Add a folder, or one repo by path.</p>}
      {groups.map((g) => (
        <div key={g} role="group" aria-label={g} className="mt-2">
          <div className="font-mono text-xs text-ink-2">{g}</div>
          {s.repos.filter((r) => r.from === g).map((r) => {
            const v = s.verify[r.name]
            return (
              <div key={r.name} className="border-t border-line py-2 first:border-t-transparent">
                <label className="flex min-h-11 cursor-pointer items-center gap-3">
                  <Checkbox checked={on.has(r.name)} onCheckedChange={() => toggle(r.name)} aria-label={r.name} disabled={running} />
                  <span className="min-w-0 flex-1"><span className="font-medium">{r.name}</span> <span className="text-sm text-ink-2">{r.pm} · test: {r.test ?? "none found"} · base: {r.base}</span></span>
                </label>
                {!v && !r.hasTests && <div className="ml-8 text-sm"><span className="text-ink-2">No test command found.</span><HelpBox s={s} kind="no-commands" repo={r.name} call={call} /></div>}
                {v && <div className="ml-8 text-sm" role="status">
                  {v.state === "waiting" && <span className="text-ink-2">Waiting</span>}
                  {v.state === "running" && <span className="text-ink-2">Running <span className="font-mono text-xs">{v.command}</span></span>}
                  {v.state === "ok" && v.testsOff && <span>Added with tests off. Set verify: in its project file when the tests can run.</span>}
                  {v.state === "ok" && !v.testsOff && <span>✓ passed{v.secs !== null ? ` in ${v.secs}s` : ""}{v.last ? <span className="text-ink-2"> · {v.last}</span> : null}</span>}
                  {v.state === "failed" && <div className="text-warn">✗ {v.step ? `${v.step} failed (${v.secs}s): ${v.last}` : v.last}{v.fix && <div className="text-ink-2">{v.fix}</div>}{v.command && <Cmd c={v.command} />}</div>}
                  {v.notes.map((n) => <div key={n} className="text-ink-2">· {n}</div>)}
                </div>}
                {r.fork && v?.state === "ok" && <div className="ml-8 mt-1 text-sm" role="group" aria-label={`${r.name} fork`}>
                  <div className="text-ink-2">{r.fork.question}</div>
                  <div className="mt-1 flex flex-wrap gap-2.5">{r.fork.options.map((o) => <Button key={o.value} size="sm" variant={r.fork!.use === o.value ? "default" : "outline"} aria-pressed={r.fork!.use === o.value} className="max-md:h-11" disabled={call.isPending} onClick={() => call.mutate({ step: "repos/fork", body: { name: r.name, use: o.value } })}>{o.label}</Button>)}</div>
                </div>}
                {v?.state === "failed" && <div className="ml-8 text-sm"><Failed s={s} name={r.name} call={call} /></div>}
              </div>
            )
          })}
        </div>
      ))}
      <form className="mt-3 flex flex-wrap gap-2.5" onSubmit={(e) => { e.preventDefault(); if (path.trim()) call.mutate({ step: "repos/add", body: { path: path.trim() } }, { onSuccess: () => setPath("") }) }}>
        <Input aria-label="Add one repo by path" placeholder="Add one repo by path, like ~/code/shop" value={path} onChange={(e) => setPath(e.target.value)} className="min-w-0 flex-1 basis-60 max-md:h-11" />
        <Button type="submit" variant="outline" disabled={!path.trim() || call.isPending} className="max-md:h-11">Add repo</Button>
      </form>
      <div className="flex flex-wrap gap-2.5">
        <Button className="mt-3 max-md:h-11" disabled={running || on.size === 0 || call.isPending} onClick={() => call.mutate({ step: "repos/verify", body: { names: s.repos.filter((r) => on.has(r.name)).map((r) => r.name) } })}>{Object.keys(s.verify).length ? "Check again" : `Check ${on.size} repo${on.size === 1 ? "" : "s"}`}</Button>
        <Next onClick={onNext} disabled={running || okCount === 0} />
      </div>
      {s.markerWarnings.map((w) => <p key={w} role="status" className="m-0 mt-2 text-sm text-warn">{w}</p>)}
      {!running && Object.keys(s.verify).length > 0 && okCount === 0 && <p role="status" className="m-0 mt-2 text-sm text-warn">No project is ready. Fix a failing command, set the test command, or add a repo anyway.</p>}
      <Err e={call.error} />
    </>
  )
}

function Chat({ s, call, onNext }: P) {
  const qc = useQueryClient()
  const [chat, setChat] = useState("terminal")
  return (
    <>
      <PillGroup options={[{ value: "terminal", label: "Terminal only" }, { value: "discord", label: "Discord" }]} value={chat} onChange={setChat} />
      <p className="m-0 mt-2 text-sm text-ink-2">{chat === "terminal" ? "what needs you prints where dobby runs; dobby add discord later" : "buttons for approve and decline"}</p>
      {chat === "discord" && !s.chat.discordToken && (
        <div className="mt-2 text-sm">
          <div className="font-medium">Discord: three steps</div>
          <ol className="m-0 mt-1 list-decimal pl-5 text-ink-2">
            <li>Create a bot at discord.com/developers and copy its token</li>
            <li>Add <code className="font-mono text-xs">DISCORD_BOT_TOKEN=&lt;token&gt;</code> to <code className="font-mono text-xs">{s.saved.configDir}/secrets.env</code> yourself. This page never takes it.</li>
            <li>Run <code className="font-mono text-xs">dobby discord invite</code>, then <code className="font-mono text-xs">dobby add discord</code></li>
          </ol>
          {s.terminal.filter((t) => t.name === "Discord bot token").map((t) => <div key={t.name} className="mt-2"><div className="text-ink-2">Or let the terminal ask for it, hidden: </div><Cmd c={t.command} /></div>)}
          <Button variant="outline" className="mt-2 max-md:h-11" onClick={() => void qc.invalidateQueries({ queryKey: KEY })}>Check again</Button>
        </div>
      )}
      {chat === "discord" && s.chat.discordToken && <p className="m-0 mt-2 text-sm text-ink-2">DISCORD_BOT_TOKEN is set.</p>}
      <Next onClick={() => call.mutate({ step: "chat", body: { chat } }, { onSuccess: onNext })} disabled={call.isPending || (chat === "discord" && !s.chat.discordToken)} />
      <Err e={call.error} />
    </>
  )
}

function Settings({ s, call, cur, setCur, Row }: { s: SetupState; call: ReturnType<typeof useStep>; cur: number; setCur: (n: number) => void; Row: (i: number, children: React.ReactNode) => React.JSX.Element }) {
  const [mode, setMode] = useState("recommended")
  const [preset, setPreset] = useState("balanced"), [auto, setAuto] = useState("off"), [deploy, setDeploy] = useState("ask")
  const [cap, setCap] = useState(s.weekCap)
  const [owner, setOwner] = useState("")
  const snap = useSnapshot()
  const w = snap.data ? weekOf(snap.data.limits, snap.data.week.series) : null
  const p = mode === "recommended" ? { preset: "balanced", auto: "off", deploy: "ask" } : { preset, auto, deploy }
  return (
    <>
      {Row(4, <>
        <PillGroup options={[{ value: "recommended", label: "Recommended" }, { value: "customize", label: "Customize" }]} value={mode} onChange={setMode} />
        {mode === "recommended" ? <p className="m-0 mt-2 text-sm text-ink-2">asks before data migrations, client sites and releases; strict review for login, payments and secrets; deploys wait for your tap</p> : (
          <div className="mt-3 flex flex-col gap-3 text-sm">
            <div><div id="g-preset">Safety</div><div role="group" aria-labelledby="g-preset"><PillGroup options={opts(Object.keys(PRESET_HINTS))} value={preset} onChange={setPreset} /></div><p className="m-0 mt-1 text-ink-2">{PRESET_HINTS[preset]}</p></div>
            <div><div id="g-auto">Automatic reviews of your own PRs</div><div role="group" aria-labelledby="g-auto"><PillGroup options={opts(Object.keys(AUTO_HINTS), { on: "Every PR", drafts: "Drafts too" })} value={auto} onChange={setAuto} /></div><p className="m-0 mt-1 text-ink-2">{AUTO_HINTS[auto]}</p></div>
            <div><div id="g-deploy">After a merge</div><div role="group" aria-labelledby="g-deploy"><PillGroup options={opts(Object.keys(DEPLOY_HINTS), { auto: "Deploy at once" })} value={deploy} onChange={setDeploy} /></div><p className="m-0 mt-1 text-ink-2">{DEPLOY_HINTS[deploy]}</p></div>
          </div>
        )}
        <Next onClick={() => setCur(5)} />
      </>)}
      {cur >= 5 && Row(5, <>
          {s.ownerMismatch && (
            <div className="mb-4 flex flex-col gap-2 text-base" role="group" aria-labelledby="g-owner">
              <div id="g-owner" className="text-ink-2">Saved GitHub owner: <span className="font-mono text-ink">{s.ownerMismatch.configured}</span>. Signed in as: <span className="font-mono text-ink">{s.ownerMismatch.login}</span>.</div>
              <div className="flex flex-wrap gap-2.5">
                {([["login", `Use ${s.ownerMismatch.login}`], ["keep", `Keep ${s.ownerMismatch.configured}`]] as const).map(([v, label]) => (
                  <Button key={v} variant={owner === v ? "default" : "outline"} aria-pressed={owner === v} className="max-md:h-11" onClick={() => setOwner(v)}>{label}</Button>
                ))}
              </div>
            </div>
          )}
          <p className="m-0 mb-2 text-base text-ink-2">Stop at <span className="font-mono text-ink">{cap}%</span> of the week, so you keep the last {100 - cap}% for yourself.{w ? <> This week is at <span className="font-mono text-ink">{w.usedPct}%</span>, resets {dayName(w.resetsAt)} {clock(w.resetsAt)}.</> : null}</p>
          <StopSlider week={w} value={cap} min={10} max={100} onCommit={setCap} />
          <Next onClick={() => call.mutate({ step: "settings", body: { ...p, weekCap: cap, ...(s.ownerMismatch ? { owner } : {}) } }, { onSuccess: () => setCur(6) })} disabled={call.isPending || (!!s.ownerMismatch && !owner)}>Save and continue</Next>
          <Err e={call.error} />
      </>)}
    </>
  )
}

function Tools({ s, call, onNext }: P) {
  const qc = useQueryClient()
  const flip = useMutation({ mutationFn: (v: { name: string; on: boolean }) => sendAction({ action: "configSet", key: `tools.${v.name}`, value: v.on }), onSettled: () => qc.invalidateQueries({ queryKey: KEY }) })
  return (
    <>
      <ul aria-label="Tools" className="m-0 flex list-none flex-col gap-3 p-0">
        {s.tools.map((t) => (
          <li key={t.name} className="text-sm">
            <div className="flex min-h-11 items-center gap-3">
              <span className="min-w-0 flex-1"><span className="font-medium">{t.name}</span> <span className="text-ink-2">{t.what}</span></span>
              {t.install ? (s.installed[t.name] || t.found ? <span className="text-ink-2">installed</span> : <Button variant="outline" size="sm" className="max-md:h-11" disabled={call.isPending} onClick={() => call.mutate({ step: "tools/install", body: { name: t.name } })}>Install</Button>)
                : t.name === "jev" ? <span className="text-ink-2">off</span>
                : <Switch checked={t.on} onCheckedChange={(on) => flip.mutate({ name: t.name, on })} aria-label={`${t.name} on`} disabled={flip.isPending} />}
            </div>
            {t.install && !t.found && !s.installed[t.name] && t.install.map((c) => <Cmd key={c} c={c} />)}
            {!t.install && <div className="text-ink-2">{t.note}</div>}
          </li>
        ))}
      </ul>
      <Err e={call.error ?? flip.error} />
      <Next onClick={onNext} />
    </>
  )
}

function Start({ s, call }: { s: SetupState; call: ReturnType<typeof useStep> }) {
  const found = useRef(false)
  const [at, setAt] = useState(0)
  useEffect(() => { if (s.jobs.state !== "none" && !found.current) { found.current = true; call.mutate({ step: "first-ticket/find" }) } }, [s.jobs.state, call])
  const c = s.candidates?.[at]
  const finishing = useStep()
  const resume = useMutation({ mutationFn: () => sendAction({ action: "resume", kind: "merges" }) })
  return (
    <>
      {s.jobs.state === "none" && (
        <>
          <p className="m-0 mb-1 text-sm text-ink-2">Background jobs:</p>
          <ul className="m-0 list-none p-0 font-mono text-[12.5px]">{s.jobList.map((j) => <li key={j.name}>{j.name.padEnd(10)} {j.what}</li>)}</ul>
          <div className="flex flex-wrap gap-2.5">
            {s.jobsAvailable ? <Button className="mt-3 max-md:h-11" disabled={call.isPending} onClick={() => call.mutate({ step: "jobs", body: { install: true } })}>Install these background jobs</Button> : <p className="m-0 mt-3 text-sm text-ink-2">Background jobs are not available on {s.platform}: run dobby start in a terminal.</p>}
            <Button variant="outline" className="mt-3 max-md:h-11" disabled={call.isPending} onClick={() => call.mutate({ step: "jobs", body: { install: false } })}>Later</Button>
          </div>
        </>
      )}
      {s.jobs.state === "installed" && <ul aria-label="Jobs" className="m-0 list-none p-0 font-mono text-[12.5px]">{s.jobs.rows.map((r) => <li key={r.name}>{r.ok ? "✓" : "✗"} {r.name.padEnd(10)} {r.detail}</li>)}</ul>}
      {s.jobs.state === "later" && <p className="m-0 text-sm text-ink-2">Start later with <code className="font-mono text-xs">dobby jobs install</code> (or <code className="font-mono text-xs">dobby start</code> in a terminal).</p>}
      {s.jobs.state !== "none" && (
        <div className="mt-4 border-t border-line pt-3">
          <h3 className="m-0 text-base font-medium">First ticket</h3>
          {s.ticket ? <p role="status" className="m-0 mt-1 text-sm">{s.ticket}</p> : c ? (
            <>
              <p className="m-0 mt-1 text-sm text-ink-2">The smallest open issue you wrote with a clear done rule:</p>
              <p className="m-0 mt-1 text-sm"><span className="font-mono">{c.remote} #{c.number}</span> "{c.title}"</p>
              <p className="m-0 mt-2 text-sm text-ink-2">The builder gets this text:</p>
              <pre className="m-0 mt-1 whitespace-pre-wrap rounded-md border border-line p-3 font-mono text-xs">{c.text}</pre>
              <div className="flex flex-wrap gap-2.5">
                <Button className="mt-3 max-md:h-11" disabled={call.isPending} onClick={() => call.mutate({ step: "first-ticket", body: { issue: c.number, project: c.project } })}>Build it now</Button>
                {(s.candidates?.length ?? 0) > at + 1 && <Button variant="outline" className="mt-3 max-md:h-11" onClick={() => setAt(at + 1)}>Pick another</Button>}
                <Button variant="ghost" className="mt-3 max-md:h-11" disabled={call.isPending} onClick={() => call.mutate({ step: "first-ticket", body: { skip: true } })}>Skip</Button>
              </div>
              <p className="m-0 mt-2 text-sm text-ink-2">Dobby opens a PR; it merges only when you say so.</p>
            </>
          ) : s.candidates ? <p className="m-0 mt-1 text-sm text-ink-2">No open issue is small and clear enough for a first ticket. Add one with: dobby add &lt;project&gt; "&lt;title&gt;"</p> : <Skeleton className="mt-2 h-10 max-w-xl" />}
          <hr className="my-4 border-line" />
          <p className="m-0 text-sm text-ink-2">Saved: settings in {s.saved.config}, project files in {s.saved.projects}, data in {s.saved.data}.</p>
          {s.fresh && <div className="mt-2 flex flex-wrap items-center gap-3 text-sm"><span>Merges are paused until you run dobby resume merges.</span><Button variant="outline" size="sm" className="max-md:h-11" disabled={resume.isPending || resume.isSuccess} onClick={() => resume.mutate()}>{resume.isSuccess ? "Merges resumed" : "Resume merges"}</Button></div>}
          <Err e={resume.error ?? finishing.error} />
          <Button className="mt-3 max-md:h-11" disabled={finishing.isPending} onClick={() => finishing.mutate({ step: "finish" })}>Finish setup</Button>
        </div>
      )}
      <Err e={call.error} />
    </>
  )
}

function Finished({ s }: { s: SetupState }) {
  const url = "http://127.0.0.1:4710/"
  return (
    <div className="border-t border-line py-4.5" role="status">
      <h2 className="m-0 text-lg font-medium">Setup is done.</h2>
      <p className="m-0 mt-2 text-base text-ink-2">Settings are in {s.saved.config}. This page stops now.</p>
      <p className="m-0 mt-2 text-base text-ink-2">Help with a setup problem in your own Claude Code: <code className="font-mono text-xs">dobby add skill</code></p>
      {s.jobs.state === "installed" && s.jobs.rows.every((r) => r.ok)
        ? <p className="m-0 mt-2 text-base"><a className="underline underline-offset-2" href={url}>Open dashboard</a> <span className="text-ink-2">({url})</span></p>
        : <p className="m-0 mt-2 text-base text-ink-2">Run <code className="font-mono text-xs">dobby dashboard</code> to open the dashboard.</p>}
    </div>
  )
}

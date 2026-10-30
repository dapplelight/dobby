import { Button } from "@nimit9/signet-ui/components/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@nimit9/signet-ui/components/dialog"
import { Input } from "@nimit9/signet-ui/components/input"
import { Label } from "@nimit9/signet-ui/components/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nimit9/signet-ui/components/select"
import { TooltipProvider } from "@nimit9/signet-ui/components/tooltip"
import { Textarea } from "@nimit9/signet-ui/components/textarea"
import { type FieldError, firstError } from "@nimit9/signet-lib/form"
import { useForm } from "@tanstack/react-form"
import { useRef } from "react"
import { z } from "zod"
import { NewTicket } from "../../../src/api-schema.ts"
import { fitsAfter } from "../../../src/queue-math.ts"
import { useAction } from "../lib/api"
import { useTicket } from "../lib/reviews"
import { useSnapshot } from "../lib/snapshot"
import { clock, dayName } from "../lib/week"

const DoneWhen = z.string().trim().max(2000, "Keep it under 2000 characters")
const Words = z.string().trim().min(1, "Write something first").max(2000, "Keep it under 2000 characters")

function Err({ errors }: { errors: readonly unknown[] }) {
  const m = firstError(errors as readonly FieldError[])
  return m ? <p role="alert" className="text-xs text-warn">{m}</p> : null
}

/** The Lead's estimate for a size, from the same maths as the Queue: its share of the week, and whether it fits behind what is queued before the stop. "Let Dobby decide" reads as M. */
function Estimate({ size }: { size: string }) {
  const q = useSnapshot().data?.queue
  if (!q) return null
  const est = q.estimates[size === "auto" ? "M" : (size as "S" | "M" | "L")]
  const fits = fitsAfter(q.queuedPct, est, q.room)
  return (
    <p className="text-sm text-ink-2" aria-live="polite">
      Lead estimate: <span className="font-mono text-ink">{size === "auto" ? "about " : ""}{est}% of the week</span>
      {q.stopPct ? (fits ? `, fits before the ${q.stopPct}% stop.` : `, waits for the reset${q.resetsAt ? ` (${dayName(q.resetsAt)} ${clock(q.resetsAt)})` : ""}.`) : "."}
    </p>
  )
}

// Signet's SelectItem is wrapped in a Tooltip that needs this provider. It sits here, not at the app root, so the tooltip code stays out of the first load.
/** N: project, what to build, done when, size. Sends { action: "add" }, the same as `dobby add`; the fields use the server's own schema. */
export function NewTicketDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { data } = useSnapshot()
  const act = useAction()
  const projects = data?.projects ?? []
  const first = useRef<HTMLInputElement>(null) // focus lands here as the dialog opens, so the first letters typed go into the field
  const form = useForm({
    defaultValues: { project: projects[0] ?? "", title: "", done_when: "", size: "auto" },
    onSubmit: async ({ value, formApi }) => {
      await act.mutateAsync({ action: "add", project: value.project, title: value.title, done_when: value.done_when, size: value.size === "auto" ? "" : value.size })
      formApi.reset(); onOpenChange(false)
    },
  })
  return (
    <TooltipProvider>
    <Dialog open={open} onOpenChange={(o) => { if (!o) act.reset(); onOpenChange(o) }}>
      <DialogContent className="sm:max-w-md" initialFocus={first}>
        <DialogHeader>
          <DialogTitle>New ticket</DialogTitle>
          <DialogDescription>It goes to the queue like <code className="font-mono text-xs">dobby add</code>.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void form.handleSubmit() }}>
          <form.Field name="project" validators={{ onChange: NewTicket.shape.project }}>
            {(f) => (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nt-project">Project</Label>
                <Select value={f.state.value} onValueChange={(v) => f.handleChange(v ?? "")}>
                  <SelectTrigger id="nt-project" className="w-full"><SelectValue placeholder="Pick a project" /></SelectTrigger>
                  <SelectContent>{projects.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}</SelectContent>
                </Select>
                <Err errors={f.state.meta.errors} />
              </div>
            )}
          </form.Field>
          <form.Field name="title" validators={{ onChange: NewTicket.shape.title }}>
            {(f) => (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nt-title">What to build</Label>
                <Input id="nt-title" ref={first} value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} onBlur={f.handleBlur} />
                <Err errors={f.state.meta.errors} />
              </div>
            )}
          </form.Field>
          <form.Field name="done_when" validators={{ onChange: DoneWhen }}>
            {(f) => (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nt-done">Done when</Label>
                <Textarea id="nt-done" rows={3} value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} onBlur={f.handleBlur} />
                <Err errors={f.state.meta.errors} />
              </div>
            )}
          </form.Field>
          <form.Field name="size">
            {(f) => (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nt-size">Size</Label>
                <Select value={f.state.value} onValueChange={(v) => f.handleChange(v ?? "auto")}>
                  <SelectTrigger id="nt-size" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{["auto", "S", "M", "L"].map((s) => <SelectItem key={s} value={s}>{s === "auto" ? "Let Dobby decide" : s}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
          </form.Field>
          <form.Subscribe selector={(s) => s.values.size}>
            {(size) => <Estimate size={size} />}
          </form.Subscribe>
          {act.error && <p role="alert" className="text-sm text-warn">{act.error.message}</p>}
          <DialogFooter>
            <form.Subscribe selector={(s) => ({ ok: s.canSubmit && !s.isSubmitting, missing: [s.values.project ? "" : "a project", s.values.title.trim() ? "" : "what to build"].filter(Boolean) })}>
              {({ ok, missing }) => (
                <>
                  {missing.length > 0 && <p className="text-sm text-ink-2 sm:mr-auto sm:self-center" aria-live="polite">Needs {missing.join(" and ")}.</p>}
                  <Button type="submit" disabled={!ok || missing.length > 0 || act.isPending} className="max-md:h-11">Add ticket</Button>
                </>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    </TooltipProvider>
  )
}

/** Answer a question or leave a hint: your words go into the ticket's done rule. */
export function WordsDialog({ mode, ticket, onClose }: { mode: "answer" | "hint"; ticket: { id: number; ref: string; title: string } | null; onClose: () => void }) {
  const act = useAction()
  const note = useTicket(mode === "answer" ? ticket?.id : undefined).data?.note // the question is the ticket's own note; the row only has its first 90 characters
  const question = note?.replace(/^BLOCKED:\s*(needs (an )?answer( from the owner)?:?\s*)?/i, "").trim()
  const form = useForm({
    defaultValues: { text: "" },
    onSubmit: async ({ value, formApi }) => { await act.mutateAsync({ action: mode, id: ticket!.id, text: value.text }); formApi.reset(); onClose() },
  })
  return (
    <Dialog open={!!ticket} onOpenChange={(o) => { if (!o) { act.reset(); onClose() } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "answer" ? "Answer" : "Add a hint"}</DialogTitle>
          <DialogDescription>{ticket?.ref} · {ticket?.title}. {mode === "answer" ? "It is queued again with your answer." : "The next build reads it."}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void form.handleSubmit() }}>
          {question && <div className="flex flex-col gap-1.5"><span className="text-sm text-ink-2">Question</span><p className="m-0 max-h-40 overflow-y-auto text-sm break-words whitespace-pre-wrap" data-question>{question}</p></div>}
          <form.Field name="text" validators={{ onChange: Words }}>
            {(f) => (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="words">{mode === "answer" ? "Your answer" : "Your hint"}</Label>
                <Textarea id="words" autoFocus rows={4} value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} onBlur={f.handleBlur} />
                <Err errors={f.state.meta.errors} />
              </div>
            )}
          </form.Field>
          {act.error && <p role="alert" className="text-sm text-warn">{act.error.message}</p>}
          <DialogFooter>
            <form.Subscribe selector={(s) => s.canSubmit && !s.isSubmitting && s.values.text.trim().length > 0}>
              {(ok) => <Button type="submit" disabled={!ok || act.isPending} className="max-md:h-11">{mode === "answer" ? "Send answer" : "Add hint"}</Button>}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const Rule = z.string().trim().min(1, "Write the rule first").max(300, "Keep it under 300 characters")

/** R on a finding: the rule text is shown, editable, before anything is saved. Saving adds it to the repo's learnings (`dobby findingrule`). */
export function RuleDialog({ finding, onClose }: { finding: { id: number; file: string; line: number; rule: string } | null; onClose: () => void }) {
  const act = useAction()
  const form = useForm({
    defaultValues: { text: finding?.rule ?? "" },
    onSubmit: async ({ value }) => { await act.mutateAsync({ action: "ruleFromFinding", finding: finding!.id, text: value.text.trim() }); onClose() },
  })
  return (
    <Dialog open={!!finding} onOpenChange={(o) => { if (!o) { act.reset(); onClose() } }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Make it a rule</DialogTitle>
          <DialogDescription>From {finding?.file}:{finding?.line}. Later reviews of this repo read this rule and leave it out. Change the words before you save.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void form.handleSubmit() }}>
          <form.Field name="text" validators={{ onChange: Rule }}>
            {(f) => (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rule-text">Rule</Label>
                <Textarea id="rule-text" autoFocus rows={4} value={f.state.value} onChange={(e) => f.handleChange(e.target.value)} onBlur={f.handleBlur} />
                <Err errors={f.state.meta.errors} />
              </div>
            )}
          </form.Field>
          {act.error && <p role="alert" className="text-sm text-warn">{act.error.message}</p>}
          <DialogFooter>
            <form.Subscribe selector={(s) => s.canSubmit && !s.isSubmitting && s.values.text.trim().length > 0}>
              {(ok) => <Button type="submit" disabled={!ok || act.isPending} className="max-md:h-11">Save rule</Button>}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

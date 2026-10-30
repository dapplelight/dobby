import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@nimit9/signet-ui/components/dialog"
import { TooltipProvider } from "@nimit9/signet-ui/components/tooltip"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@nimit9/signet-ui/components/select"
import { useState } from "react"
import type { WelcomeView } from "../../../src/api-schema.ts"
import { CopyButton } from "./copy-button"

/** Adding a project runs the Onboarder (a Claude call) on its repo, so it stays a terminal command: this shows it for the chosen repo, ready to copy. */
export function AddProjectDialog({ open, pick, root, repos, onClose }: { open: boolean; pick?: string; root: string; repos: WelcomeView["repos"]; onClose: () => void }) {
  const free = repos.filter((r) => !r.added)
  const [chosen, setChosen] = useState<string>()
  const name = chosen && free.some((r) => r.name === chosen) ? chosen : pick && free.some((r) => r.name === pick) ? pick : free[0]?.name
  const cmd = `dobby init ${name ?? "<repo>"}`
  return (
    <TooltipProvider>
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a project</DialogTitle>
          <DialogDescription>
            A project joins when its repo has a <code className="font-mono text-xs">dobby.md</code>. This command reads the repo's docs and drafts that file for you to confirm. It makes a Claude call, so you run it in a terminal.
          </DialogDescription>
        </DialogHeader>
        {free.length > 0 ? (
          <>
            <Select value={name} onValueChange={(v) => v && setChosen(v)}>
              <SelectTrigger aria-label="Repo" className="w-full max-md:h-11"><SelectValue placeholder="Pick a repo" /></SelectTrigger>
              <SelectContent>{free.map((r) => <SelectItem key={r.name} value={r.name}>{r.path}</SelectItem>)}</SelectContent>
            </Select>
            <div className="flex items-center gap-1 rounded-md border border-line px-3 py-2 font-mono text-sm"><span className="min-w-0 flex-1 break-all">{cmd}</span><CopyButton text={cmd} name="the command" /></div>
          </>
        ) : (
          <p className="text-sm text-ink-2">No git repos without a project were found in {root}. Clone one there, or point <code className="font-mono text-xs">paths.projects</code> in Settings at the folder that holds them.</p>
        )}
      </DialogContent>
    </Dialog>
    </TooltipProvider>
  )
}

import { Kbd } from "@nimit9/signet-ui/components/kbd"
import { useLocation } from "@tanstack/react-router"
import { byId, KEYS } from "../actions"
import { useSnapshot } from "../lib/snapshot"

const show = (k: string) => k.replace("Shift+", "⇧").replace("Mod+", "⌘").replace("Enter", "↵").replace("ArrowLeft", "←").replace("ArrowRight", "→")
/** Each page's hints, as registry ids: the keys and the words come from the registry's own entries (the `?` overlay reads the same), so they cannot drift. */
const LIST = ["next", "prev"]
const HINTS: Record<string, [string[], string][]> = {
  home: [[LIST, "move"], [["primary"], "main action"], [["decline"], "decline"], [["go-reviews"], "reviews"], [["help"], "all keys"], [["new-ticket"], "new ticket"]],
  queue: [[LIST, "move"], [["reorder-down", "reorder-up"], "reorder"], [["unqueue"], "back to backlog"], [["new-ticket"], "new ticket"], [["help"], "all keys"]],
  goals: [[LIST, "move"], [["go-queue"], "queue"], [["new-ticket"], "new ticket"], [["help"], "all keys"]],
  reviews: [[LIST, "move"], [["primary"], "open review"], [["allow-round"], "allow another round"], [["help"], "all keys"]],
  spend: [[["range-week"], "week"], [["range-five"], "5-hour window"], [["go-home"], "home"], [["help"], "all keys"], [["new-ticket"], "new ticket"]],
  activity: [[LIST, "move"], [["primary"], "open"], [["=1–4"], "filter"], [["copy-summary"], "copy summary"], [["help"], "all keys"]],
  settings: [[["settings-next", "settings-prev"], "move"], [["settings-dec", "config-set"], "change"], [["settings-undo"], "undo"], [["settings-find"], "find a setting"], [["help"], "all keys"]],
  team: [[["team-next", "team-prev"], "move"], [["edit-rules"], "edit rules"], [["pause-role"], "pause"], [["team-add"], "add a project"], [["help"], "all keys"]],
  welcome: [[["welcome-add"], "add the repo"], [["help"], "all keys"]],
  pr: [[["next-finding", "prev-finding"], "next finding"], [["apply-finding"], "apply"], [["rule-from-finding"], "make it a rule"], [["next-file", "prev-file"], "files"], [["help"], "all keys"]],
}
const page = (path: string) => (path === "/" ? "home" : path.startsWith("/pr/") ? "pr" : path.slice(1).split("/")[0])
const keysOf = (ids: string[]) => ids.flatMap((i) => i.startsWith("=") ? [i.slice(1)] : (KEYS.find((k) => k.id === i) ?? byId(i)).keys.map(show)).slice(0, 2)

/** The roles that get a dot. Builder and Tester are live while a ticket runs; Reviewer while a review runs; the rest are idle until they have a signal of their own. */
export const ROLE_DOTS = [["builder", "Builder"], ["checker", "Tester"], ["reviewer", "Reviewer"], ["lead", "Lead"], ["product-manager", "Product Manager"], ["scout", "Scout"], ["chief-of-staff", "Chief of Staff"]] as const

/** Footer: the key hints and the team's pulse from the snapshot. */
export function StatusBar() {
  const { data } = useSnapshot()
  const hints = (HINTS[page(useLocation({ select: (l) => l.pathname }))] ?? HINTS.home).filter(([ids]) => !(data?.limits?.state === "apiKey" && ids[0].startsWith("range-"))).map(([ids, what]) => [keysOf(ids), what] as const) // no week or 5-hour window on an API key
  const n = data?.now
  const live = new Set(data?.teamLive ?? [])
  const team = n ? [
    { name: `${n.building.length} building`, on: n.building.length > 0 },
    { name: `${n.ready.length} ready`, on: false },
    { name: n.jobs.total ? `jobs ${n.jobs.ok}/${n.jobs.total}` : "no jobs", on: n.jobs.failing.length === 0 && n.jobs.total > 0 },
  ] : []
  return (
    <footer className="mt-auto flex flex-wrap items-center gap-x-5.5 gap-y-2 px-5 pt-8 pb-5.5 text-xs text-ink-2 max-md:pb-24 md:px-10">
      <div className="hidden gap-5.5 md:flex">
        {hints.map(([keys, what]) => (
          <span key={what} className="inline-flex items-center gap-1.5">{keys.map((k) => <Kbd key={k} className="font-mono text-[11px] text-ink-2">{k}</Kbd>)} {what}</span>
        ))}
      </div>
      <span className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2" role="group" aria-label="Team">
        <span className="flex items-center gap-1" role="group" aria-label="Roles">
          {ROLE_DOTS.map(([id, name]) => (
            <span key={id} role="img" aria-label={`${name}: ${live.has(id) ? "working" : "idle"}`} title={`${name}: ${live.has(id) ? "working" : "idle"}`} className="inline-flex size-4 items-center justify-center">
              <span className={`size-1.5 rounded-full shadow-[inset_0_0_0_1px_var(--ink-3)] ${live.has(id) ? "live bg-ink" : ""}`} />
            </span>
          ))}
        </span>
        {team.map((m) => (
          <span key={m.name} className="inline-flex items-center gap-1.5">
            <span className={`size-1.5 rounded-full shadow-[inset_0_0_0_1px_var(--ink-3)] ${m.on ? "live bg-ink" : ""}`} />
            {m.name}
          </span>
        ))}
      </span>
    </footer>
  )
}

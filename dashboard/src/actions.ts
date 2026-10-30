// The key registry: one table for the dashboard's keys and actions. The hotkeys, the `?` overlay, the row and footer hints all read it.
// Data only (no React), so a test can check it against src/cli.ts and the MCP registry: every action has keys, a label, a CLI verb and an MCP op.
/** list = the Home inbox; queue, backlog and ideas are the Queue page's three tabs. */
export type Scope = "global" | "list" | "detail" | "dialog" | "queue" | "backlog" | "ideas" | "spend" | "activity" | "settings" | "team" | "welcome"
export type Entry = {
  id: string
  label: string
  /** One hotkey ("X", "Shift+P") or a sequence (["G", "R"]). */
  keys: string[]
  scope: Scope
  group: string
  /** The name POST /api/action takes. Entries without one are navigation or the list's own keys. */
  action?: string
  cli?: string
  /** "tool/op" in the MCP registry. */
  mcp?: string
  /** No MCP door: undo cancels a hold kept in the dashboard server; Edit rules saves a role file, which an agent must not do to its own rules. */
  local?: boolean
}

const act = (id: string, label: string, keys: string[], scope: Scope, action: string, cli: string, mcp: string, group = "Actions"): Entry => ({ id, label, keys, scope, group, action, cli, mcp })

export const ACTIONS: Entry[] = [
  act("merge", "Merge", ["Enter"], "list", "merge", "merge", "dobby_decide/merge"),
  act("deploy", "Deploy", ["Enter"], "list", "deploy", "deploy", "dobby_decide/deploy"),
  act("answer", "Answer", ["Enter"], "list", "answer", "answer", "dobby_ticket/answer"),
  act("retry", "Retry", ["Enter"], "list", "retry", "retry", "dobby_decide/retry"),
  act("decline", "Decline", ["X"], "list", "decline", "decline", "dobby_decide/decline"),
  act("take-over", "Take over", ["T"], "list", "takeOver", "takeover", "dobby_ticket/take-over"),
  act("allow-round", "One more fix round", ["Shift+A"], "list", "allowRound", "allowround", "dobby_ticket/allow-round"),
  act("pause-ticket", "Pause this ticket", ["P"], "list", "pause", "pause", "dobby_pause/pause"),
  act("hint", "Add a hint", ["H"], "list", "hint", "hint", "dobby_ticket/hint"),
  act("reorder-up", "Move up", ["Shift+K"], "queue", "reorder", "reorder", "dobby_ticket/reorder"),
  act("reorder-down", "Move down", ["Shift+J"], "queue", "reorder", "reorder", "dobby_ticket/reorder"),
  act("unqueue", "Back to backlog", ["B"], "queue", "unqueue", "unqueue", "dobby_ticket/unqueue"),
  act("queue-ticket", "Queue it", ["Enter"], "backlog", "queue", "queue", "dobby_ticket/queue"),
  act("make-ticket", "Make a ticket", ["Enter"], "ideas", "makeTicket", "ideaticket", "dobby_ticket/make-ticket"),
  act("dismiss-idea", "Dismiss", ["X"], "ideas", "dismissIdea", "ideadrop", "dobby_ticket/dismiss-idea"),
  act("apply-finding", "Ask builder to apply", ["A"], "detail", "applyFinding", "applyfinding", "dobby_ticket/apply-finding"),
  act("dismiss-finding", "Dismiss", ["D"], "detail", "dismissFinding", "dismissfinding", "dobby_ticket/dismiss-finding"),
  act("rule-from-finding", "Make it a rule", ["R"], "detail", "ruleFromFinding", "findingrule", "dobby_ticket/rule-from-finding"),
  { id: "undo", label: "Undo", keys: ["U"], scope: "list", group: "Actions", action: "undo", local: true },
  // Settings, Team, First run (PR 6)
  act("config-set", "Change a setting", ["ArrowRight"], "settings", "configSet", "config", "dobby_pause/config-set", "Settings"),
  act("pause-role", "Pause or resume role", ["P"], "team", "pause", "pause", "dobby_pause/pause", "Team"),
  { id: "edit-rules", label: "Edit rules", keys: ["E"], scope: "team", group: "Team", action: "saveRole", cli: "role", local: true },
  { id: "reset-role", label: "Reset to default", keys: ["Shift+E"], scope: "team", group: "Team", action: "resetRole", cli: "role", local: true },
  act("new-ticket", "New ticket", ["N"], "global", "add", "add", "dobby_ticket/add", "General"),
  act("pause-team", "Pause the team", ["Shift+P"], "global", "pauseTeam", "pause", "dobby_pause/pause", "General"),
  act("resume-team", "Resume the team", ["Shift+R"], "global", "resume", "resume", "dobby_pause/resume", "General"),
]

const nav = (id: string, label: string, keys: string[], scope: Scope, group: string): Entry => ({ id, label, keys, scope, group })
export const NAV: Entry[] = [
  nav("help", "Show all keys", ["?"], "global", "General"), nav("palette", "Search or run", ["Mod+K"], "global", "General"),
  nav("settings", "Settings", [","], "global", "Go to"),
  nav("go-home", "Home", ["G", "H"], "global", "Go to"), nav("go-queue", "Queue", ["G", "Q"], "global", "Go to"),
  nav("go-reviews", "Reviews", ["G", "R"], "global", "Go to"), nav("go-spend", "Spend", ["G", "S"], "global", "Go to"),
  nav("go-goals", "Goals", ["G", "O"], "global", "Go to"), nav("go-activity", "Activity", ["G", "A"], "global", "Go to"),
  nav("next", "Next item", ["J"], "list", "Navigation"), nav("prev", "Previous item", ["K"], "list", "Navigation"),
  nav("next-finding", "Next finding", ["J"], "detail", "Navigation"), nav("prev-finding", "Previous finding", ["K"], "detail", "Navigation"),
  nav("next-file", "Next file", ["]"], "detail", "Navigation"), nav("prev-file", "Previous file", ["["], "detail", "Navigation"),
  nav("range-week", "Show the week", ["W"], "spend", "Navigation"), nav("range-five", "Show the 5-hour window", ["F"], "spend", "Navigation"),
  nav("filter-all", "All activity", ["1"], "activity", "Filter"), nav("filter-merges", "Merges", ["2"], "activity", "Filter"),
  nav("filter-reviews", "Reviews", ["3"], "activity", "Filter"), nav("filter-problems", "Problems", ["4"], "activity", "Filter"),
  nav("copy-summary", "Copy the morning summary", ["C"], "activity", "Actions"),
  nav("settings-next", "Next setting", ["J"], "settings", "Settings"), nav("settings-prev", "Previous setting", ["K"], "settings", "Settings"),
  nav("settings-dec", "Change a setting down", ["ArrowLeft"], "settings", "Settings"), nav("settings-find", "Find a setting", ["/"], "settings", "Settings"),
  nav("settings-copy", "Copy the changed JSON", ["C"], "settings", "Settings"), nav("settings-undo", "Undo the last change", ["U"], "settings", "Settings"),
  nav("settings-reset", "Reset this section", ["R"], "settings", "Settings"),
  nav("team-next", "Next role", ["J"], "team", "Team"), nav("team-prev", "Previous role", ["K"], "team", "Team"),
  nav("team-add", "Add a project", ["Shift+N"], "team", "Team"), nav("welcome-add", "Add this repo", ["Enter"], "welcome", "First run"),
  nav("open", "Open the pull request", ["O"], "list", "Actions"), nav("copy-branch", "Copy branch", ["C"], "list", "Actions"),
]

/** Merge, Deploy, Answer and Retry share Enter: the row's own kind picks one, so the uniqueness check counts them once as "primary". */
export const KEYS: Entry[] = [
  { id: "primary", label: "Do the row's main action", keys: ["Enter"], scope: "list", group: "Actions" },
  ...ACTIONS.filter((a) => a.keys[0] !== "Enter"), ...NAV,
]
export const byId = (id: string) => [...ACTIONS, ...NAV].find((e) => e.id === id)!

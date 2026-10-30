import { useHotkey, useHotkeySequence } from "@tanstack/react-hotkeys"
import { useLayoutEffect } from "react"
import { byId } from "../actions"

let holding = 0
/** Mount it as a lazy dialog's Suspense fallback: page shortcuts stay off while the dialog's code loads, so letters typed right after the key that opens it are not read as shortcuts. */
export function HoldKeys() {
  useLayoutEffect(() => { holding++; return () => { holding-- } }, [])
  return null
}
/** Page shortcuts are off while any dialog is open (or about to be). The palette's own toggle stays on, so ⌘K closes it. */
const blocked = (id: string) => id !== "palette" && (holding > 0 || !!document.querySelector('[role="dialog"]'))

/** Binds one registry entry. The keys, label and group come from dashboard/src/actions.ts, so the `?` overlay and the hints always match. */
export function Key({ id, run, enabled = true }: { id: string; run: () => void; enabled?: boolean }) {
  const e = byId(id)
  return e.keys.length > 1 ? <Seq id={id} run={run} enabled={enabled} /> : <One id={id} run={run} enabled={enabled} />
}
const meta = (id: string) => { const e = byId(id); return { name: e.label, group: e.group } }
const hotkey = (k: string) => (k.length === 1 && !/[a-z]/i.test(k) ? { key: k } : k)

function One({ id, run, enabled }: { id: string; run: () => void; enabled: boolean }) {
  useHotkey(hotkey(byId(id).keys[0]) as never, (ev) => { if (blocked(id)) return; ev.preventDefault(); run() }, { enabled, meta: meta(id) })
  // Mod is Cmd on a Mac: bind the other modifier too, so Ctrl+K and Cmd+K both work
  const k = byId(id).keys[0]
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
  useHotkey((k.startsWith("Mod+") ? k.replace("Mod+", mac ? "Control+" : "Meta+") : k) as never, (ev) => { if (blocked(id)) return; ev.preventDefault(); run() }, { enabled: enabled && k.startsWith("Mod+") })
  return null
}
function Seq({ id, run, enabled }: { id: string; run: () => void; enabled: boolean }) {
  useHotkeySequence(byId(id).keys as never, () => { if (!blocked(id)) run() }, { enabled, meta: meta(id) })
  return null
}

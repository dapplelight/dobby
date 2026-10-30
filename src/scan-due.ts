// Without Discord there is no listener job, and the listener is what runs `review-scan` every 15 minutes. The tick job is always
// installed, so on that install it starts the scan itself, at the same cadence. With Discord the listener owns the scan.
import type { DB } from "./db.ts"

const EVERY = 15 * 60_000
const KEY = "review:scan:claim"

/** Start a review-scan if Discord is off and none ran in the last 15 minutes or is still running. Returns whether it started one. */
export function scanIfDue(db: DB, o: { discord: boolean; start: () => void; now?: number; staleMs: number }): boolean {
  if (o.discord) return false
  const now = o.now ?? Date.now()
  const get = (k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
  const last = (() => { try { return Number(JSON.parse(get("review:scan:last") ?? "{}").at) || 0 } catch { return 0 } })()
  const claim = Number(get(KEY)) || 0
  if (now - last < EVERY) return false
  if (claim > last && now - claim < o.staleMs) return false // a scan started after the last finished one and is not past its timeout
  db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(KEY, String(now))
  o.start()
  return true
}

// When this browser last had the dashboard open: Activity counts what happened since. Read once at load, written when the tab is hidden or closed.
const KEY = "dobby:last-visit"
const read = () => { try { const n = Number(localStorage.getItem(KEY)); if (n > 0) return n } catch {} return Date.now() - 12 * 3_600_000 }
const mark = () => { try { localStorage.setItem(KEY, String(Date.now())) } catch {} }

export const SINCE = read()
addEventListener("pagehide", mark)
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") mark() })

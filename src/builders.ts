// How many builders run at once (#910): caps from config, and no new builder while the machine is short of memory.
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { freemem, totalmem } from "node:os"
import type { DB } from "./db.ts"

export const DEFAULT_CAPS = { max: 4, maxQuietHours: 6, minFreePct: 25 }

/** The cap now: builders.max (default 4), or builders.maxQuietHours (default 6) in quiet hours, 23:00-08:00 in Dobby's zone. */
export const builderCap = (cfg: { max?: number; maxQuietHours?: number } | undefined, hour: number) =>
  hour >= 8 && hour < 23 ? cfg?.max ?? DEFAULT_CAPS.max : cfg?.maxQuietHours ?? DEFAULT_CAPS.maxQuietHours

/** "System-wide memory free percentage: 73%" (macOS memory_pressure -Q) or MemAvailable/MemTotal (Linux /proc/meminfo); null = unreadable. */
export function parseFreePct(text: string): number | null {
  const mac = text.match(/memory free percentage:\s*(\d+)%/i)
  if (mac) return Number(mac[1])
  const avail = text.match(/^MemAvailable:\s+(\d+)/m), total = text.match(/^MemTotal:\s+(\d+)/m)
  return avail && total && Number(total[1]) > 0 ? Math.round((Number(avail[1]) / Number(total[1])) * 100) : null
}

/** Free memory in percent. os.freemem() on macOS leaves out cached pages (reads ~5% on a healthy Mac), so ask the OS its own way. */
export function freeMemPct(platform = process.platform): number {
  try {
    const text = platform === "darwin" ? spawnSync("memory_pressure", ["-Q"], { encoding: "utf8", timeout: 5000 }).stdout ?? ""
      : platform === "linux" ? readFileSync("/proc/meminfo", "utf8") : ""
    const pct = parseFreePct(text)
    if (pct !== null) return pct
  } catch {}
  return Math.round((freemem() / totalmem()) * 100)
}

/** Why a new builder must wait for memory, or "" (and the hold note for status is written or cleared). */
export function memoryHold(db: DB, minFreePct = DEFAULT_CAPS.minFreePct, free = freeMemPct(), now = Date.now()): string {
  if (free >= minFreePct) { db.prepare("DELETE FROM kv WHERE k='mem:hold'").run(); return "" }
  const why = `free memory ${free}% is under ${minFreePct}% (config builders.minFreePct): the next builder waits`
  db.prepare("INSERT OR REPLACE INTO kv VALUES ('mem:hold', ?)").run(JSON.stringify({ why, at: now }))
  return why
}

/** Status line while a builder is held for memory (only a hold from the last 15 minutes: the next tick re-checks). */
export function memHoldLine(db: DB, now = Date.now()): string[] {
  const row = db.prepare("SELECT v FROM kv WHERE k='mem:hold'").get() as { v: string } | undefined
  if (!row) return []
  const h = JSON.parse(row.v) as { why: string; at: number }
  return now - h.at < 15 * 60_000 ? [`🧠 Held: ${h.why}`] : []
}

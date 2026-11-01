// Update check (#auto-update): once a day the tick asks npm for the newest dobby-ai. Status and the morning brief say when
// one is out; with config autoUpdate on (the default), the tick installs it itself while no builder is running. A git checkout (Dobby's
// own development) is never updated: it runs whatever is checked out.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import type { DB } from "./db.ts"
import { ROOT } from "./lib.ts"

const PKG = "dobby-ai"
const DAY = 86_400_000

/** -1, 0 or 1 like a sort: "0.1.0-beta.3" > "0.1.0-beta.2", "0.1.0" > "0.1.0-beta.9", numbers compare as numbers. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => { const [core, pre] = v.trim().replace(/^v/, "").split("-", 2); return { core: core.split(".").map(Number), pre: pre?.split(".") } }
  const x = split(a), y = split(b)
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) > (y.core[i] ?? 0) ? 1 : -1
  if (!x.pre || !y.pre) return x.pre === y.pre ? 0 : x.pre ? -1 : 1 // a release beats its prereleases
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1
    if (p === q) continue
    const np = /^\d+$/.test(p), nq = /^\d+$/.test(q)
    if (np && nq) return Number(p) > Number(q) ? 1 : -1
    return np ? -1 : nq ? 1 : p > q ? 1 : -1
  }
  return 0
}

export const installedVersion = (root = ROOT) => (JSON.parse(readFileSync(`${root}package.json`, "utf8")) as { version: string }).version
export const isCheckout = (root = ROOT) => existsSync(`${root}.git`)

type Run = (cmd: string, args: string[]) => { ok: boolean; out: string }
const sh: Run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000 }); return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() } }
const get = (db: DB, k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
const set = (db: DB, k: string, v: string) => db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(k, v)

/**
 * The tick's daily check. Returns a log line, or "" when nothing was done. Never throws: a failed check waits a day.
 * `auto` installs the newer version (npm i -g) when no ticket is building; otherwise it is only announced.
 */
export function updateCheck(db: DB, o: { auto?: boolean; now?: number; run?: Run; root?: string } = {}): string {
  const now = o.now ?? Date.now(), run = o.run ?? sh, root = o.root ?? ROOT
  if (isCheckout(root)) return ""
  if (now - Number(get(db, "update:checked") ?? 0) < DAY) return ""
  set(db, "update:checked", String(now))
  const v = run("npm", ["view", PKG, "version"])
  const latest = v.ok ? v.out.split("\n").pop()?.trim() ?? "" : ""
  if (!/^\d+\.\d+\.\d+/.test(latest)) return `update check: npm did not answer (${v.out.slice(0, 120)})`
  const mine = installedVersion(root)
  if (compareVersions(latest, mine) <= 0) { db.prepare("DELETE FROM kv WHERE k='update:latest'").run(); return "" }
  set(db, "update:latest", latest)
  if (!o.auto) return `update: Dobby ${latest} is out (you have ${mine}): npm i -g ${PKG}@${latest}`
  const busy = (db.prepare("SELECT count(*) n FROM tickets WHERE status='running'").get() as { n: number }).n
  if (busy) { set(db, "update:checked", String(now - DAY + 3_600_000)); return `update: Dobby ${latest} is out; installing after the ${busy} running build(s) finish` } // retry in an hour
  const i = run("npm", ["i", "-g", `${PKG}@${latest}`])
  if (!i.ok) return `update: installing Dobby ${latest} failed: ${i.out.slice(-200)}`
  db.prepare("DELETE FROM kv WHERE k='update:latest'").run()
  return `update: installed Dobby ${latest} (was ${mine}); the next tick runs it`
}

/** Status line while a newer version waits to be installed. */
export function updateLine(db: DB): string[] {
  const v = get(db, "update:latest")
  return v ? [`⬆️ Dobby ${v} is out: npm i -g ${PKG}@${v} (autoUpdate is off in config)`] : []
}

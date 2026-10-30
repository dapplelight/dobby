// Where Dobby lives once init is done: jobs must point at a copy that stays (not the npx or bunx cache), and `dobby` should be on PATH.
import { existsSync } from "node:fs"
import { dirOf, type Run } from "./jobs.ts"
import type { DB } from "./db.ts"

/** The pid of a running `dobby start`, or 0 (no row, or a stale one). Two runners would build every ticket twice. */
export function startPid(db: DB): number {
  const pid = Number((db.prepare("SELECT v FROM kv WHERE k='start:pid'").get() as { v: string } | undefined)?.v)
  try { return pid && process.kill(pid, 0) ? pid : 0 } catch { return 0 }
}

/** `npm i -g dobby-ai@<version>`; returns the installed package folder (with a trailing slash) to run jobs from. */
export function installGlobal(version: string, run: Run, has = existsSync): { ok: true; root: string } | { ok: false; why: string } {
  const i = run("npm", ["i", "-g", `dobby-ai@${version}`])
  if (!i.ok) return { ok: false, why: i.out.trim().split("\n").slice(-3).join(" ") || "npm failed" }
  const g = run("npm", ["root", "-g"]), root = `${g.out.trim()}/dobby-ai/`
  return g.ok && has(`${root}bin/dobby`) ? { ok: true, root } : { ok: false, why: "installed, but the package folder was not found" }
}

/** Is a `dobby` command on this PATH? (After npx it is not.) */
export const onPath = (path = process.env.PATH ?? "") => !!dirOf("dobby", path)

/**
 * `dobby add jobs` writes launchd or systemd files that run on their own. Why it must not (undefined = go ahead): no config or no GitHub sign-in
 * (the jobs would only crash-loop), no terminal to ask in without --yes, or the owner said no.
 */
export async function jobsGate(o: { config: boolean; signedIn: boolean; tty: boolean; yes: boolean; ask: () => Promise<boolean> }): Promise<string | undefined> {
  if (!o.config) return "Jobs not installed: there is no config yet. Run dobby init first."
  if (!o.signedIn) return "Jobs not installed: GitHub is not signed in. Run gh auth login --web, then dobby add jobs."
  if (o.yes) return undefined
  if (!o.tty) return "Jobs not installed: no terminal to ask in. Run dobby add jobs in a terminal, or add --yes."
  return (await o.ask()) ? undefined : "Jobs not installed."
}

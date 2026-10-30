// `dobby init --ui`: the dashboard app in this process, in setup mode, on loopback and a free port (not 4710: the dashboard job takes that once jobs are installed).
// It signs the browser in through /auth?token=, and the process ends when setup finishes or on Ctrl-C.
import * as p from "@clack/prompts"
import { spawn } from "node:child_process"
import type { AddressInfo } from "node:net"
import { open as openWritable } from "./db.ts"
import { createDashboard, openerFor } from "./dashboard-server.ts"
import { ensureToken } from "./notify.ts"
import { holdEvents, record } from "./stats.ts"
import type { DB } from "./db.ts"
import type { SetupDeps } from "./dashboard-setup.ts"

export const DASHBOARD_PORT = 4710
const ROOT = new URL("..", import.meta.url).pathname

/** Plain `dobby init` on a terminal: where to set up. */
export async function askFace(): Promise<"terminal" | "browser"> {
  const v = await p.select({ message: "Set up here or in your browser?", options: [{ value: "terminal", label: "Here, in the terminal" }, { value: "browser", label: "In your browser", hint: "a page on this machine, opened for you" }] })
  if (p.isCancel(v)) { p.cancel("Setup stopped."); process.exit(1) }
  return v as "terminal" | "browser"
}

/** Listens on a free loopback port that is not 4710; resolves with the port. */
export async function listenFree(server: ReturnType<typeof createDashboard>): Promise<number> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((ok, bad) => { server.once("error", bad); server.listen(0, "127.0.0.1", ok) })
    const port = (server.address() as AddressInfo).port
    if (port !== DASHBOARD_PORT) return port
    await new Promise<void>((done) => server.close(() => done()))
  }
  throw new Error("could not find a free port")
}

export type InitUiOpts = { projects?: string[]; db?: DB; token?: string; open?: (url: string) => void; setup?: Partial<SetupDeps>; log?: (s: string) => void; signals?: boolean }
/** Runs until setup finishes (or Ctrl-C). Resolves with the address it served. */
export async function initUi(o: InitUiOpts = {}): Promise<{ port: number }> {
  const db = o.db ?? openWritable(), log = o.log ?? console.log
  const token = o.token ?? ensureToken()
  holdEvents() // opt-in usage stats: the funnel waits in memory until the two questions are answered
  record(db, "setup_started")
  let finish!: () => void
  const done = new Promise<void>((ok) => (finish = ok))
  const server = createDashboard(db, { host: "127.0.0.1", token, setup: { db, root: ROOT, roots: o.projects, cwd: process.cwd(), ...o.setup, onFinish: () => finish() } })
  const port = await listenFree(server)
  const base = `http://127.0.0.1:${port}`
  const open = o.open ?? ((url) => { const [cmd, argv] = openerFor(process.platform, url); const c = spawn(cmd, argv, { stdio: "ignore", detached: true }); c.on("error", () => log(`Could not run ${cmd}. Open the setup link above yourself.`)); c.unref() })
  log(`Setup is open. If your browser did not open (SSH, another profile), open this link: ${base}/auth?token=${token}\nCtrl-C stops it; run dobby init again to pick up where it stopped.`)
  open(`${base}/auth?token=${token}`)
  const stop = () => finish()
  if (o.signals !== false) process.once("SIGINT", stop)
  await done
  if (o.signals !== false) process.off("SIGINT", stop)
  server.closeAllConnections?.()
  await new Promise<void>((ok) => server.close(() => ok()))
  return { port }
}

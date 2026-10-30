// Setup edge cases kept out of setup.ts: a config file that will not parse, a second machine on the same repos,
// Discord errors in plain words, and where the data folder lives. Pure functions; callers pass in what touches the machine.
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, statfsSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { configDir, privatePath } from "./config.ts"

type Run = (args: string[]) => { ok: boolean; out: string }

/** The private config as an object. A file that does not parse (comments, a trailing comma) is moved to `<file>.bad` and {} is returned; `onBad` hears the new path. */
export function readPrivate(path = privatePath(), onBad?: (bad: string) => void): Record<string, any> {
  if (!existsSync(path)) return {}
  try {
    const j = JSON.parse(readFileSync(path, "utf8") || "{}")
    if (j && typeof j === "object" && !Array.isArray(j)) return j
  } catch {}
  renameSync(path, `${path}.bad`)
  onBad?.(`${path}.bad`)
  return {}
}

/** A random id for this machine, made once and kept in the config dir. It is what goes in the repo variable: collaborators can read repo variables, so never a hostname or username. */
export function machineId(path = `${configDir()}/machine-id`): string {
  try { const v = readFileSync(path, "utf8").trim(); if (/^machine-[0-9a-f]{6}$/.test(v)) return v } catch {}
  const id = `machine-${randomBytes(3).toString("hex")}`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${id}\n`)
  return id
}

/**
 * A repo variable DOBBY_OWNER says which machine works a repo. Set it where it is missing; where another machine's name is there, return a warning
 * (both machines would review, answer and spend usage: locks are local). Never overwrites. Setting can fail without admin rights; that is fine.
 * ponytail: a marker, not coordination. A machine that is gone leaves its marker until someone runs the gh command in the warning.
 */
export function repoMarkers(repos: string[], me: string, run: Run, host = ""): string[] {
  const warn: string[] = []
  for (const repo of repos) {
    const r = run(["variable", "get", "DOBBY_OWNER", "-R", repo]), other = r.out.trim()
    if (r.ok && other && other !== me) warn.push(`${repo} is already worked by ${other}; this machine${host ? ` (${host})` : ""} is ${me}. Two machines on one repo both review, both answer and both spend your usage. Use one, or take it over with: gh variable set DOBBY_OWNER --body "${me}" -R ${repo}`)
    else if (!(r.ok && other)) run(["variable", "set", "DOBBY_OWNER", "--body", me, "-R", repo])
  }
  return warn
}

/** Discord failures in plain words: 403 (code 50013) means the bot lacks Manage Channels or Manage Webhooks. */
export function discordHint(msg: string): string {
  return / 403$/.test(msg) ? `${msg}. The bot is missing a permission (Manage Channels or Manage Webhooks). Re-invite it with: dobby discord invite` : msg
}

/** The first folder at or above `path` that exists. */
const exists = (path: string): string => (existsSync(path) || dirname(path) === path ? path : exists(dirname(path)))

// statfs f_type of network file systems on Linux: NFS, SMB, CIFS, SMB2
const NET_TYPES = new Set([0x6969, 0x517b, 0xff534d42, 0xfe534d42])
/** "network" (Linux) or the mount type (macOS) when `path` is on a network mount, else null. SQLite's WAL mode needs a local disk. `mounts` is `mount` output (macOS only). */
export function networkFs(path: string, platform = process.platform, mounts = "", type = (p: string) => statfsSync(p).type): string | null {
  if (platform === "linux") { try { return NET_TYPES.has(type(exists(path))) ? "network" : null } catch { return null } }
  if (platform !== "darwin") return null
  const hit = [...mounts.matchAll(/ on (\/.*?) \((\w+)/g)].filter((m) => path === m[1] || path.startsWith(`${m[1]}/`) || m[1] === "/").sort((a, b) => b[1].length - a[1].length)[0]
  return hit && /^(nfs|smbfs|afpfs|webdav)$/.test(hit[2]) ? hit[2] : null
}

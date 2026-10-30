// `dobby migrate`: write the owner's private config from the setup that runs today, so behaviour stays identical when the
// built-in defaults later turn generic. Never overwrites; --dry-run prints instead. Secrets: key NAMES only, never values.
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname } from "node:path"
import { draftDirs, isProjectDraft, loadConfig, privatePath, Schema, type Config } from "./config.ts"
import { DATA } from "./db.ts"
import { redact, secretsFile } from "./notify.ts"

type Opts = { path?: string; drafts?: string; secrets?: string; db?: string; launchAgents?: string; now?: Date }

/** What the current setup says, as a full config (the private file pins every value, defaults included). */
export function current(o: Opts = {}): Config {
  const base = structuredClone(loadConfig({ private: null }).config)
  const dirs = o.drafts ? [o.drafts].filter((d) => existsSync(d)) : draftDirs()
  const projects = [...new Set(dirs.flatMap((d) => readdirSync(d).filter(isProjectDraft).map((f) => f.slice(0, -3))))].sort()
  for (const p of projects) base.discord.apps[p] ??= { label: p.toUpperCase(), ideas: true }
  const sf = o.secrets ?? secretsFile()
  const secretKeys = existsSync(sf) ? [...readFileSync(sf, "utf8").matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)=/gm)].map((m) => m[1]) : []
  const discord: Record<string, string> = {}
  const dbPath = o.db ?? `${DATA}/dobby.db`
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true })
      // ids only: webhook rows (discord:wh:*) hold tokens and stay out
      for (const r of db.prepare("SELECT k, v FROM kv WHERE k IN ('discord:guild', 'discord:owner') OR k LIKE 'discord:ch:%'").all() as { k: string; v: string }[])
        if (/^\d+$/.test(r.v)) discord[r.k.slice("discord:".length)] = r.v
      db.close()
    } catch {} // no kv table yet
  }
  const la = o.launchAgents ?? `${homedir()}/Library/LaunchAgents`
  const launchdJobs = existsSync(la) ? readdirSync(la).filter((f) => /^com\.(dobby|foreman)\..+\.plist$/.test(f)).map((f) => f.slice(0, -6)).sort() : []
  return Schema.parse({ ...base, migrated: { at: (o.now ?? new Date()).toISOString(), projects, secretKeys, discord, launchdJobs } })
}

/** Writes the private config when none exists. Idempotent: an existing file is left as it is. */
export function migrate(o: Opts & { dryRun?: boolean } = {}): string {
  const path = o.path ?? privatePath()
  if (existsSync(path)) return `${path} already exists; left as it is (dobby config show prints what is in force)`
  const text = JSON.stringify(current(o), null, 2) + "\n"
  if (o.dryRun) return `would write ${path}:\n${redact(text)}`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, { flag: "wx", mode: 0o600 })
  return `wrote ${path}`
}

/** `dobby config show|path`. */
export function configCmd(sub = "show"): string {
  if (sub === "path") return `${privatePath()}${existsSync(privatePath()) ? "" : " (not there yet: dobby init or dobby config set creates it)"}\nrepo: ${fileURLToPath(new URL("../dobby.config.json", import.meta.url))}`
  const l = loadConfig()
  return [...l.warnings.map((w) => `warning: ${w}`), `sources: ${l.sources.join(" < ")}`, redact(JSON.stringify(l.config, null, 2))].join("\n")
}

// The Team page's data (GET /api/team, /api/role/:name) and the one write behind "Edit rules": a role file, saved only inside the roles folder.
// Read functions are pure over a (read-only) DB; saveRole is called by `dobby role save`, never by the dashboard process itself.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, resolve, sep } from "node:path"
import { config, privateConfigPath } from "./config.ts"
import { needsMe } from "./dashboard.ts"
import type { DB } from "./db.ts"
import { parseDoc, ROOT } from "./lib.ts"
import { pauseList, type Kind } from "./pause.ts"
import { weekPoints } from "./savings.ts"

export const ROLES_DIR = `${ROOT}roles` // the built-in roles: inside the package, so an upgrade replaces them
/** The owner's edited roles: <config dir>/roles/<name>.md, next to config.json, so an upgrade keeps them. loadRole reads one before the built-in. */
export const overrideDir = () => `${dirname(privateConfigPath())}/roles`
/** The owner's edited copy of a role, if there is a real file for it. */
const overrideFile = (name: string, over: string) => { const f = `${over}/${name}.md`; return existsSync(f) && !lstatSync(f).isSymbolicLink() ? f : null }
export const isEdited = (name: string, over = overrideDir()) => NAME.test(name) && !!overrideFile(name, over)
const DAY = 86_400_000
const NAME = /^[a-z][a-z0-9-]{0,40}$/
export const MAX_ROLE = 8000 // the dashboard's request body is 10 KB

/** The pause target that really stops a role's runs (src/pause.ts). Roles with none have no Pause button. */
export const ROLE_PAUSE: Record<string, Kind> = { builder: "builders", reviewer: "reviews", lead: "planning", "product-manager": "planning", "area-pm": "planning", "program-manager": "planning", scout: "scout" }
/** The runs.kind values a role writes (src/agents.ts KIND_ROLE, reversed), for its share of the week. */
const KINDS_OF: Record<string, string[]> = { builder: ["build"], checker: ["check"], reviewer: ["review", "review-chat"], designer: ["design"], "product-manager": ["pm"], "area-pm": ["area-pm"], "chief-of-staff": ["cos"], brainstorm: ["brainstorm"], onboarder: ["onboard"], lead: ["lead", "plan"], scout: ["scout"] }

const rules = (body: string) => {
  const items = body.split("\n").map((l) => l.match(/^\s*(?:\d+[.)]|[-*])\s+(.*\S)/)?.[1]).filter((x): x is string => !!x)
  return items.length ? items : body.split("\n").slice(1).map((l) => l.trim()).filter(Boolean) // a role written as paragraphs: each line after the first
}

/** The role's one-line summary from its frontmatter. An owner's override without one falls back to the built-in file's; a file with none at all shows the first line of its prompt. */
function summaryOf(name: string, doc: ReturnType<typeof parseDoc>, dir: string) {
  const built = existsSync(`${dir}/${name}.md`) ? parseDoc(readFileSync(`${dir}/${name}.md`, "utf8")).meta.summary : ""
  return (doc.meta.summary || built || (doc.body.split("\n")[0] ?? "")).slice(0, 140)
}

export type TeamView = ReturnType<typeof teamView>
export function teamView(db: DB, o: { projects: () => Record<string, { repo: string; base: string; paused: boolean }>; rolesDir?: string; overrideDir?: string; now?: number }) {
  const now = o.now ?? Date.now(), since = new Date(now - 7 * DAY).toISOString()
  const q = <T>(sql: string, ...a: unknown[]) => { try { return db.prepare(sql).all(...a) as T[] } catch { return [] as T[] } }
  const runs = q<{ project: string; kind: string; cost_usd: number }>("SELECT project, kind, cost_usd FROM runs WHERE at>=? AND cost_usd>0", since)
  const share = (pick: (r: (typeof runs)[number]) => boolean) => { const usd = runs.filter(pick).reduce((n, r) => n + r.cost_usd, 0); return { usd: Math.round(usd * 100) / 100, pct: Math.round(weekPoints(usd) * 10) / 10 } }
  const need = new Map<string, number>()
  for (const g of needsMe(db, now)) for (const i of g.items) if (i.app) need.set(i.app, (need.get(i.app) ?? 0) + 1)
  const paused = pauseList(db, now)
  const projects = Object.entries(o.projects()).map(([name, p]) => ({
    name, path: p.repo.replace(homedir(), "~"), branch: p.base, paused: p.paused || paused.some((x) => x.scope === `project ${name}`),
    open: q<{ n: number }>("SELECT COUNT(*) n FROM tickets WHERE project=? AND status NOT IN ('shipped','declined') AND dup_of IS NULL", name)[0]?.n ?? 0,
    needsYou: need.get(name) ?? 0, share: share((r) => r.project === name),
    lastMerge: q<{ u: string }>("SELECT MAX(updated_at) u FROM tickets WHERE project=? AND status='shipped'", name)[0]?.u ?? null,
  }))
  const dir = o.rolesDir ?? ROLES_DIR, over = o.overrideDir ?? overrideDir()
  const roles = (existsSync(dir) ? readdirSync(dir) : []).filter((f) => NAME.test(f.slice(0, -3)) && f.endsWith(".md")).sort().map((f) => {
    const name = f.slice(0, -3), edited = overrideFile(name, over), doc = parseDoc(readFileSync(edited ?? `${dir}/${f}`, "utf8")), rs = rules(doc.body), kind = ROLE_PAUSE[name] ?? null
    return {
      name, edited: !!edited, title: doc.meta.title || name.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()), file: `roles/${f}`,
      does: summaryOf(name, doc, dir), model: doc.meta.model || null, effort: doc.meta.effort || null,
      rules: rs.slice(0, 12), ruleCount: rs.length, pauseKind: kind, paused: !!kind && paused.some((x) => x.scope === kind || x.scope === "everything"),
      share: KINDS_OF[name] ? share((r) => KINDS_OF[name].includes(r.kind)) : null,
    }
  })
  return { at: now, billing: config().billing?.mode === "apiKey" ? "apiKey" as const : "plan" as const, projects, roles }
}

/** The role file for `name` inside `dir`: a real file there (not a link out), or an error. The name is checked, then the resolved path. */
function roleFile(name: string, dir: string): string {
  if (!NAME.test(name)) throw new Error(`"${name}" is not a role name (lowercase letters, digits and dashes).`)
  const root = realpathSync(dir), file = resolve(root, `${name}.md`)
  if (!file.startsWith(root + sep)) throw new Error("That path is outside the roles folder.")
  if (!existsSync(file)) throw new Error(`No role called ${name}. The roles are: ${readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort().join(", ")} (the Tester is checker).`)
  if (lstatSync(file).isSymbolicLink() || !realpathSync(file).startsWith(root + sep)) throw new Error(`${name}.md is a link; only real files inside the roles folder can be edited.`)
  return file
}
/** What a role's runs read: the owner's edited copy if there is one, else the built-in. */
export const roleText = (name: string, dir = ROLES_DIR, over = overrideDir()) => { const b = roleFile(name, dir); return readFileSync(overrideFile(name, over) ?? b, "utf8") }

/** Save an edited copy of a role into the config folder (0600, written next to it then renamed). Only a built-in role can be edited; the built-in file is never touched. */
export function saveRole(name: string, text: string, dir = ROLES_DIR, over = overrideDir()): string {
  roleFile(name, dir)
  if (!text.trim()) throw new Error("A role file cannot be empty.")
  const top = /^---\r?\n[\s\S]*?\r?\n---\r?\n/
  if (!top.test(text)) text = (roleText(name, dir, over).match(top)?.[0] ?? "") + text // text without a top block (`dobby role save checker "<rules>"`) keeps the role's own model, effort and title lines
  if (text.length > MAX_ROLE) throw new Error(`A role file here is at most ${MAX_ROLE} characters; this one is ${text.length}.`)
  const file = `${over}/${name}.md`, tmp = `${file}.${process.pid}.tmp`
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error(`${name}.md in ${over} is a link; only real files can be edited.`)
  mkdirSync(over, { recursive: true, mode: 0o700 })
  writeFileSync(tmp, text.endsWith("\n") ? text : `${text}\n`, { mode: 0o600 })
  renameSync(tmp, file)
  return `Saved ${file}. Runs that start from now on read it.`
}

/** Delete the owner's edited copy, so the built-in text applies again. */
export function resetRole(name: string, dir = ROLES_DIR, over = overrideDir()): string {
  roleFile(name, dir)
  const file = `${over}/${name}.md`
  if (!lstatSync(file, { throwIfNoEntry: false })) return `${name} is already the default.`
  unlinkSync(file)
  return `Reset ${name} to the built-in text.`
}

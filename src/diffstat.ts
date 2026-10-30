// `git diff --shortstat <base>...<branch>` of a ticket's branch, for the dashboard's diff bar. Cached per head sha, so a poll costs one rev-parse.
import { spawnSync } from "node:child_process"
import { loadProjects } from "./lib.ts"

export type DiffStat = { add: number; del: number; files: number }
export type Git = (args: string[], cwd: string) => string | null
const BRANCH = /^[\w./-]+$/

/** " 9 files changed, 318 insertions(+), 41 deletions(-)" */
export function parseShortstat(s: string): DiffStat | null {
  const n = (re: RegExp) => Number(s.match(re)?.[1] ?? 0)
  const files = n(/(\d+) files? changed/)
  return files ? { add: n(/(\d+) insertions?\(\+\)/), del: n(/(\d+) deletions?\(-\)/), files } : null
}

const realGit: Git = (args, cwd) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 5000 })
  return r.status === 0 ? r.stdout : null
}

/** A reader with its own cache. Anything missing (no repo, no branch, git fails) reads as null: the row just shows no bar. */
export function diffReader(git: Git = realGit, projects = loadProjects) {
  const cache = new Map<string, DiffStat | null>() // repo|branch|sha
  return (project: string, branch: string | null): DiffStat | null => {
    const p = projects()[project]
    if (!p?.repo || !branch || !BRANCH.test(branch) || branch.startsWith("-") || !BRANCH.test(p.base) || p.base.startsWith("-")) return null
    const sha = git(["rev-parse", "--verify", "--quiet", branch], p.repo)?.trim()
    if (!sha) return null
    const key = `${p.repo}|${branch}|${sha}`
    if (!cache.has(key)) {
      if (cache.size > 200) cache.clear()
      const out = git(["diff", "--shortstat", `${p.base}...${branch}`], p.repo)
      cache.set(key, out === null ? null : parseShortstat(out))
    }
    return cache.get(key) ?? null
  }
}

export const DIFF_MAX = 200 * 1024
export type DiffText = { text: string; clipped: number }
/** `git diff <base>...<branch>` of a ticket's branch, in the project's own clone (the path comes from the projects config, never from a request), clipped at 200 KB. null = nothing to show. */
export function diffTextReader(git: Git = (args, cwd) => { const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }); return r.status === 0 ? r.stdout : null }, projects = loadProjects) {
  return (project: string, branch: string | null): DiffText | null => {
    const p = projects()[project]
    if (!p?.repo || !branch || !BRANCH.test(branch) || branch.includes("..") || branch.startsWith("-") || !BRANCH.test(p.base) || p.base.startsWith("-")) return null
    const out = git(["diff", `${p.base}...${branch}`], p.repo)
    if (out === null) return null
    return out.length > DIFF_MAX ? { text: out.slice(0, DIFF_MAX), clipped: out.length - DIFF_MAX } : { text: out, clipped: 0 }
  }
}

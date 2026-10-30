// Ship policy (owner, 16 Oct 2026): merged to main = deployed, or a Deploy tap first (the default; safety.deploy auto skips the tap). A project opts in with `deploy:` in its dobby.md
// (`deploy_dir:` a clean checkout of its base branch, `migrations:` the folder of SQL migrations; with deployFrom worktree,
// `deploy_copy:` the gitignored files besides .env* the deploy needs, comma-separated, copied from `repo:`).
// Schema-only migrations run automatically; migrations that change existing data go to the owner first.
// One deploy per project at a time; a merge during a deploy queues exactly one more run.
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { config } from "./config.ts"
import { DATA, type DB } from "./db.ts"
import { addTicket, home, loadProjects, ROOT, setTicket, shAsync, timeoutMs, type Out } from "./lib.ts"
import { clip, notify } from "./notify.ts"
import { detailsBlock } from "./chat/common.ts"
import { chatPrefix, platform } from "./chat/platform.ts"
import { paused } from "./pause.ts"
import { sqlChangesData } from "./safety.ts"

/** True when a migration rewrites, backfills or deletes existing data (owner decides), false for pure schema adds. Rule: src/policy.ts, kind deploy. */
export const changesData = sqlChangesData // same reading as the safety check: strings, block comments and ON DELETE CASCADE are not data changes

/** Removes gitignored files from the release checkout, except node_modules and .env*. */
export const DEPLOY_CLEAN = "git clean -fdXq -e '!node_modules' -e '!.env*'"

const kvGet =(db: DB, k: string) => (db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined)?.v
const kvSet = (db: DB, k: string, v: string) => db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(k, v)
const kvDel = (db: DB, k: string) => db.prepare("DELETE FROM kv WHERE k=?").run(k)

/** No pid (an old lock) counts as alive, so it still waits out its 45 minutes. */
export const alive = (pid?: number) => { if (!pid) return true; try { process.kill(pid, 0); return true } catch { return false } }

/** migrate + at: the owner tapped "Migrate & deploy" on the card for head `at`; any other head gets a fresh card. sh/notify/projects: stubs in tests. */
/** The shell the deploy runs through: (command, dir, keep, timeoutMs). Real = shAsync (git calls 2 min, install + deploy 30 min). */
export type DeploySh = (cmd: string, cwd: string, keep?: number, timeoutMs?: number) => Out | Promise<Out>
const realSh: DeploySh = (cmd, cwd, keep = 4000, ms) => shAsync(cmd, cwd, keep, { timeoutMs: ms })
/** onFailure/startFix: the deployOnFailure setting and the fix starter (`dobby run <id>`, detached); stubs in tests. */
export type DeployOpts = { tapped?: boolean; migrate?: boolean; at?: string; sh?: DeploySh; notify?: typeof notify; projects?: ReturnType<typeof loadProjects>; onFailure?: "notify" | "ticket" | "fix"; startFix?: (id: number) => void; fetcher?: typeof fetch; from?: "checkout" | "worktree" }

export async function deployProject(db: DB, name: string, o: DeployOpts = {}): Promise<string> {
  const p = (o.projects ?? loadProjects())[name]
  if (!p?.deploy) return `${name}: no deploy step configured`
  const pz = paused(db, { kind: "deploys", project: name })
  if (pz) { // held, not dropped: it runs when the pause ends (runQueuedDeploys, from the tick and from `resume`)
    kvSet(db, `deploy:queued:${name}`, String(Date.now()))
    return `${name}: deploy ${pz}; it is queued and runs on resume`
  }
  if (config().safety.deploy !== "auto" && !o.tapped && !o.migrate) { // fails closed, only an explicit safety.deploy auto deploys by itself; unset or ask: a merge sends a Deploy tap, the tap deploys
    await (o.notify ?? notify)(`🟡 Needs you · ${name} is merged and ready to deploy`, fetch, [{ text: "🚀 Deploy", data: `deploynow ${name}` }], { kind: "approval", key: `deploy:${name}` })
    return `${name}: merged; the deploy waits for your tap`
  }
  const lock = `deploy:lock:${name}`
  // "<ms>:<pid>". A holder killed mid-deploy (listener restart) frees the lock at once, not after 45 minutes.
  const [at, pid] = (kvGet(db, lock) ?? "0").split(":").map(Number)
  if (Date.now() - at < 45 * 60_000 && alive(pid)) {
    kvSet(db, `deploy:again:${name}`, "1")
    return `${name}: a deploy is running; another one follows it`
  }
  kvSet(db, lock, `${Date.now()}:${process.pid}`)
  try {
    let last = ""
    do {
      kvSet(db, lock, `${Date.now()}:${process.pid}`) // each pass renews the lock: a long chain of deploys must not expire it
      kvDel(db, `deploy:again:${name}`)
      last = await once(db, name, p, o)
    } while (kvGet(db, `deploy:again:${name}`))
    return last
  } finally {
    kvDel(db, lock)
  }
}

/** Deploys held by a pause whose pause is over. */
export async function runQueuedDeploys(db: DB, o: DeployOpts = {}): Promise<string[]> {
  const out: string[] = []
  for (const { k } of db.prepare("SELECT k FROM kv WHERE k LIKE 'deploy:queued:%'").all() as { k: string }[]) {
    const name = k.slice("deploy:queued:".length)
    if (paused(db, { kind: "deploys", project: name })) continue
    kvDel(db, k)
    out.push(await deployProject(db, name, o))
  }
  return out
}

async function once(db: DB, name: string, p: NonNullable<ReturnType<typeof loadProjects>[string]>, o: DeployOpts): Promise<string> {
  const sh = o.sh ?? realSh, say = o.notify ?? notify
  const git = timeoutMs("git")
  const run = async (cmd: string, cwd: string, keep = 4000, ms = git) => sh(cmd, cwd, keep, ms)
  const fail = (why: string) => failed(db, say, name, p, why, o)
  if ((o.from ?? config().deployFrom) !== "worktree") {
    const dir = home(p.deploy_dir ?? p.repo)
    if ((await run("git status --porcelain", dir)).out.trim()) return fail(`${dir} has local changes; not deploying from it`)
    const pull = (await run(`git pull -q --ff-only origin ${p.base} && git fetch -q --tags origin`, dir))
    if (!pull.ok) return fail(`git pull: ${clip(pull.out, 200)}`)
    // `git status` hides ignored files, so a stale generated one (apps/mobile/.expo) survives the pull and can fail typecheck. Clear it; keep node_modules (slow to rebuild) and .env* (secrets the deploy needs).
    return release(db, name, p, o, dir, async () => {
      const clean = await run(DEPLOY_CLEAN, dir)
      return clean.ok ? "" : `git clean: ${clip(clean.out, 200)}`
    })
  }
  // A fresh worktree of origin/<base> each time (#195): nothing stale or half-edited can ship, and no release checkout is needed.
  // The repo's .env* files (gitignored, the deploy needs them) are copied in; the worktree goes afterwards, failed or not.
  const repo = home(p.repo), dir = `${DATA}/deploy-wt/${name}-${Date.now()}`
  const add = await run(`git worktree prune && git fetch -q origin ${p.base} && git fetch -q --tags origin && git worktree add -q --detach '${dir}' origin/${p.base}`, repo)
  if (!add.ok) return fail(`git worktree: ${clip(add.out, 200)}`)
  try {
    const env = await run(`rsync -a -m --exclude node_modules --exclude .git --exclude .worktrees --include '*/' --include '.env*' --exclude '*' ./ '${dir}/'`, repo)
    if (!env.ok) return fail(`copying .env files: ${clip(env.out, 200)}`)
    for (const f of p.deploy_copy ?? []) { // other gitignored files the deploy needs (deploy_copy: in dobby.md), from the same repo
      const cp = await run(`mkdir -p "$(dirname '${dir}/${f}')" && cp -p '${f}' '${dir}/${f}'`, repo)
      if (!cp.ok) return fail(`${f} is listed in deploy_copy but is not in ${repo}`)
    }
    return await release(db, name, p, o, dir, async () => "")
  } finally {
    await run(`git worktree remove --force '${dir}'`, repo)
  }
}

/** From a checked-out head: nothing new, the data-migration card, then install + deploy. prepare = last step before install ("" = ok). */
async function release(db: DB, name: string, p: NonNullable<ReturnType<typeof loadProjects>[string]>, o: DeployOpts, dir: string, prepare: () => Promise<string>): Promise<string> {
  const sh = o.sh ?? realSh, say = o.notify ?? notify
  const run = async (cmd: string, cwd: string, keep = 4000, ms = timeoutMs("git")) => sh(cmd, cwd, keep, ms)
  const fail = (why: string) => failed(db, say, name, p, why, o)
  const sha = (await run("git rev-parse HEAD", dir)).out.trim()
  const head = sha.slice(0, 7)
  // deploy/prod is the tag the deploy step moves: already at HEAD = nothing new, said as such (not "Deployed")
  const prod = (await run("git rev-parse -q --verify 'deploy/prod^{commit}'", dir)).out.trim()
  if (sha && prod === sha) return `${name}: nothing to deploy (${head} is already live)`
  let migs: string[] = []
  if (p.migrations) {
    // What is already live: the deploy/prod tag, else the head Dobby itself recorded after its last good deploy. With neither (a first deploy,
    // or a deploy step that never makes the tag) every migration counts as pending, so a data migration always reaches the owner (fail closed).
    const last = kvGet(db, `deploy:last:${name}`) ?? ""
    const live = prod || (/^[0-9a-f]{40}$/.test(last) && (await run(`git rev-parse -q --verify '${last}^{commit}'`, dir)).out.trim() ? last : "")
    const diff = await run(`git diff --name-only ${live || "$(git hash-object -t tree /dev/null)"} HEAD -- ${p.migrations}`, dir)
    if (!diff.ok) return fail(`could not list the pending migrations: ${clip(diff.out, 200)}`)
    migs = diff.out.split("\n").filter((f) => f.endsWith(".sql"))
  }
  const risky = migs.filter((f) => { try { return changesData(readFileSync(`${dir}/${f}`, "utf8")) } catch { return true } })
  // The button carries the head its card showed. Main moved since (or an old card without one): the owner OK'd other
  // migrations than the ones now pending, so refuse and send a fresh card for this head.
  const moved = !!o.migrate && o.at !== sha
  if (risky.length && (!o.migrate || moved)) {
    await say(`🟡 Needs you · ${name} deploy at ${head}${moved ? " (main moved since the last card)" : ""}\nA migration changes existing data, so it waits for you:\n${risky.map((f) => `• ${f}`).join("\n")}\n\nIt passed review before merging. Deploy runs it on production.`, fetch, [{ text: "🚀 Migrate & deploy", data: `deploynow ${name} migrate ${sha}` }], { kind: "approval" })
    return `${name}: waiting for the owner (data migration ${risky.join(", ")})${moved ? `; the tap was for ${o.at?.slice(0, 7) || "an older card"}, not ${head}: new card sent` : ""}`
  }
  const prep = await prepare()
  if (prep) return fail(prep)
  const cmd = `${p.install} && ${p.deploy}${migs.length ? " --migrate" : ""}`
  const r = await run(cmd, dir, 8000, timeoutMs("deploy"))
  if (!r.ok) return fail(clip(r.out.split("\n").filter((l) => /fail|error|stopped/i.test(l)).slice(-4).join(" · ") || r.out, 400))
  if (sha) kvSet(db, `deploy:last:${name}`, sha) // a clean deploy step with no app changes still means this head is live
  if (/nothing to deploy/i.test(r.out)) return `${name}: nothing to deploy at ${head} (the deploy step found no app changes)`
  await settle(db, name, head, o.fetcher)
  await say(`🚀 Deployed · ${name} at ${head}${migs.length ? `\nMigrations run: ${migs.map((f) => f.split("/").pop()).join(", ")}` : ""}`, fetch, undefined, { kind: "shipped", project: name })
  return `${name}: deployed ${head}`
}

/** A good deploy settles the failure card quietly: its Retry button goes, and the next failure is a new card. */
async function settle(db: DB, name: string, head: string, fetcher: typeof fetch = fetch) {
  const key = `deploy:${name}`
  db.prepare("DELETE FROM kv WHERE k=?").run(`deploy:fails:${name}`)
  const p = chatPrefix()
  if (!kvGet(db, `${p}:msg:${key}`)) return
  await (await platform()).upsert(db, key, { kind: "approval" }, `✅ Deploy fixed · ${name}\nDeployed at ${head}; the failure is settled.`, [], fetcher).catch(() => {})
  db.prepare("DELETE FROM kv WHERE k IN (?, ?)").run(`${p}:msg:${key}`, `${p}:msg:${key}:head`)
}

const startFixRun = (id: number) => {
  const c = spawn(`${ROOT}bin/dobby`, ["run", String(id)], { detached: true, stdio: "ignore", env: process.env })
  c.on("error", () => {})
  c.unref()
}

/** The Retry card, plus (deployOnFailure ticket|fix) one top-priority fix ticket per project; fix also builds it now. A failure while that fix is open says so, and under fix stays quiet. */
async function failed(db: DB, say: NonNullable<DeployOpts["notify"]>, name: string, p: NonNullable<ReturnType<typeof loadProjects>[string]>, why: string, o: DeployOpts) {
  const mode = o.onFailure ?? config().deployOnFailure ?? "notify"
  const out = `${name}: deploy failed: ${why}`
  let line = ""
  if (mode !== "notify") {
    const prev = Number(kvGet(db, `deploy:fix:${name}`))
    const open = prev && db.prepare("SELECT 1 FROM tickets WHERE id=? AND status NOT IN ('shipped','declined','failed','split')").get(prev) ? prev : 0
    if (open && mode === "fix") return `${out} (fix #${open} is on it)`
    // No "deploy"/"production" in the title: the ship rule would hold the ticket for the owner (src/policy.ts, src/safety.ts).
    const id = open || addTicket(db, { project: name, title: `Fix ${p.base}: the ship step fails`, done_when: `\`${p.install} && ${p.deploy}\` passes on a clean checkout of ${p.base}. It failed with: ${why}`, size: "S", priority: 100 }).id
    if (!open) {
      setTicket(db, id, { status: "ready" })
      kvSet(db, `deploy:fix:${name}`, String(id))
      if (mode === "fix") (o.startFix ?? startFixRun)(id)
    }
    line = open ? `Fix #${id} is already queued.` : mode === "fix" ? `An engineer is fixing it now (#${id}); its merge deploys again.` : `Fix ticket #${id} is first in the queue.`
  }
  // one card per project: a repeat failure edits it (the count on line 2 keeps line 1, the ping, the same)
  const n = Number(kvGet(db, `deploy:fails:${name}`) ?? 0) + 1
  kvSet(db, `deploy:fails:${name}`, String(n))
  await say(`🔴 Deploy failed · ${name}\n${n > 1 ? `Failed ${n} times in a row. ` : ""}Nothing new is live; the last good version keeps running.\n${line ? `${line}\n` : ""}${detailsBlock(why)}`, fetch, [{ text: "🔁 Retry deploy", data: `deploynow ${name}` }], { kind: "approval", key: `deploy:${name}` })
  return line ? `${out} (${line})` : out
}

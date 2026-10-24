// `dobby init`: one-command setup. Checks this machine, signs in where needed, finds repos and proves their commands,
// asks at most three questions (repos, chat, settings), starts the background jobs and offers a first ticket.
// Every step can run again: what is already set (config values, project drafts, jobs) is kept. --yes takes the
// recommended answer everywhere and never builds anything; without a terminal it must be given.
import * as p from "@clack/prompts"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basics } from "./checks.ts"
import { config, configDir, localZone, privatePath, projectsDir, zoneLabel } from "./config.ts"
import { detectRepo, draftFor, verifyRepo, type Detected } from "./detect.ts"
import { installJobs } from "./jobs.ts"
import { setPause } from "./pause.ts"
import { clip, readSecrets } from "./telegram.ts"
import type { DB } from "./db.ts"

type Opts = { yes?: boolean; projects?: string; noJobs?: boolean; root: string }
type Issue = { number: number; title: string; body: string; labels: { name: string }[] }
const expand = (s: string) => s.replace(/^~(?=\/|$)/, homedir())
const tidy = (s: string) => s.replace(new RegExp(`^${homedir()}`), "~")
const cancelled = <T>(v: T | symbol): T => { if (p.isCancel(v)) { p.cancel("Setup stopped. Run dobby init again to pick up where it stopped."); process.exit(1) } return v as T }

/** Open issues that are small and say when they are done, best first: a done rule, a bug or starter label, a short body. */
export function rankIssues(xs: Issue[]): Issue[] {
  const skip = /question|discussion|wontfix|duplicate|epic|design|owner/i
  const clear = /done when|acceptance|expected|steps to reproduce|- \[ \]/i
  const score = (i: Issue) => (clear.test(i.body) ? 0 : 1000) + (i.labels.some((l) => /good first issue|bug/i.test(l.name)) ? 0 : 500) + Math.min(i.body.length, 499)
  return xs.filter((i) => i.body.trim().length >= 40 && !i.labels.some((l) => skip.test(l.name)) && !/^owner:/i.test(i.title)).sort((a, b) => score(a) - score(b))
}

/** Existing values win: setup fills in what is missing and never overwrites a value the user set. */
export function fillConfig(have: Record<string, unknown>, add: Record<string, unknown>): Record<string, unknown> {
  const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)
  const out = { ...have }
  for (const [k, v] of Object.entries(add)) out[k] = !(k in out) ? v : obj(out[k]) && obj(v) ? fillConfig(out[k] as Record<string, unknown>, v) : out[k]
  return out
}

export async function setup(db: DB, o: Opts): Promise<void> {
  if (!process.stdin.isTTY && !o.yes) throw new Error("no terminal to ask in: run `dobby init --yes` for the recommended setup")
  const fresh = !existsSync(privatePath())
  p.intro("Dobby setup")

  // 1. checks (and 2. sign-ins): nothing is asked unless something is missing
  const s = p.spinner()
  s.start("Checking this machine")
  let t = Date.now(), rows = await basics({ apiKeyMode: config().billing?.mode === "apiKey" })
  s.stop(`Checked this machine (${((Date.now() - t) / 1000).toFixed(1)}s)`)
  const gh = rows.find((r) => r.name === "GitHub sign-in")!
  if (!gh.ok && rows.find((r) => r.name === "GitHub CLI")!.ok && !o.yes) {
    p.log.step("GitHub CLI is not signed in. A browser opens; the code is printed too, so it works over SSH.")
    spawnSync("gh", ["auth", "login", "--web", "--git-protocol", "https"], { stdio: "inherit" })
    rows = await basics({ apiKeyMode: config().billing?.mode === "apiKey" })
  }
  p.log.message(rows.filter((r) => r.name !== "config").map((r) => `${r.ok ? "✓" : r.required ? "✗" : "·"} ${r.name}: ${r.detail}${!r.ok && r.fix ? `   (${r.fix})` : ""}`).join("\n"))
  const blocking = rows.filter((r) => r.required && !r.ok && r.name !== "config")
  if (blocking.length) {
    p.outro(`Fix these, then run dobby init again:\n${blocking.map((r) => `  ${r.name}: ${r.fix}`).join("\n")}`)
    process.exitCode = 1
    return
  }
  const login = /signed in as (\S+)/.exec(gh.ok ? gh.detail : rows.find((r) => r.name === "GitHub sign-in")!.detail)?.[1] ?? ""

  // 3. repos (question 1): detected, never asked; then each command is run once
  const root = expand(o.projects ?? config().paths.projects)
  const found = existsSync(root) ? readdirSync(root).map((n) => `${root}/${n}`).filter((d) => existsSync(`${d}/.git`)).map(detectRepo).filter((d) => d.remote) : []
  if (!found.length) { p.outro(`No git repos with a GitHub remote in ${tidy(root)}. Run dobby init --projects <folder>.`); process.exitCode = 1; return }
  const name = (d: Detected) => d.dir.split("/").pop()!
  const line = (d: Detected) => `${d.pm} · test: ${d.test ?? "none found"} · base: ${d.base}`
  p.log.info(`Found ${found.length} repo${found.length > 1 ? "s" : ""} in ${tidy(root)} with a GitHub remote`)
  const picked: Detected[] = o.yes ? found.filter((d) => d.test) : cancelled<Detected[]>(await p.multiselect({
    message: "Which should Dobby work on?", required: true,
    options: found.map((d) => ({ value: d, label: name(d), hint: line(d) })), initialValues: found.filter((d) => d.test),
  }))
  const ready: Detected[] = []
  for (const d of picked) {
    s.start(`${name(d)}: ${d.install}${d.test ? `, then ${d.test}` : ""}`)
    const v = verifyRepo(d)
    const bad = v.checks.find((c) => !c.ok)
    s.stop(bad ? `✗ ${name(d)}: ${bad.step} failed (${bad.secs}s): ${bad.last}` : `✓ ${name(d)}: ${v.checks.map((c) => `${c.step} ${c.secs}s`).join(", ") || "nothing to run"}${v.checks.at(-1)?.last ? ` · ${v.checks.at(-1)!.last}` : ""}`)
    if (bad) p.log.warn(`${name(d)} is left out until \`${bad.step === "install" ? d.install : d.test}\` passes in ${tidy(d.dir)}. Run dobby init again after.`)
    else ready.push(d)
  }
  const drafts = projectsDir() || `${o.root}projects`
  mkdirSync(drafts, { recursive: true })
  for (const d of ready) {
    const f = `${drafts}/${name(d)}.md`
    if (!existsSync(f) && !existsSync(`${d.dir}/dobby.md`) && !existsSync(`${d.dir}/foreman.md`)) writeFileSync(f, draftFor(name(d), d, tidy(d.dir)))
  }

  // 4. chat (question 2)
  const chat = o.yes ? "terminal" : cancelled<string>(await p.select({
    message: "Where should Dobby ask you things?",
    options: [{ value: "terminal", label: "Terminal only", hint: "what needs you prints where dobby runs; dobby add discord later" }, { value: "discord", label: "Discord", hint: "buttons for approve and decline" }],
  }))
  if (chat === "discord") {
    if (!readSecrets().DISCORD_BOT_TOKEN) p.note(`1. Create a bot at discord.com/developers and copy its token\n2. Add DISCORD_BOT_TOKEN=<token> to ${tidy(configDir())}/secrets.env\n3. Run: dobby discord invite, then dobby add discord`, "Discord: three steps")
    else {
      const d = await import("./discord.ts")
      s.start("Setting up Discord channels")
      try { s.stop(`✓ Discord: channels ready in "${await d.setup(db)}". Run dobby discord test to see a message in each.`) } catch (e) { s.stop(`✗ Discord: ${(e as Error).message}`) }
    }
  }

  // 5. settings (question 3)
  const mode = o.yes ? "recommended" : cancelled<string>(await p.select({
    message: "Settings",
    options: [
      { value: "recommended", label: "Recommended", hint: "asks before merging auth, payments, secrets or migrations; reviews run when you comment @dobby review" },
      { value: "customize", label: "Customize", hint: "safety and reviews" },
    ],
  }))
  let preset = "balanced", auto = "off"
  if (mode === "customize") {
    preset = cancelled<string>(await p.select({ message: "Safety", initialValue: "balanced", options: [
      { value: "strict", label: "Strict", hint: "asks before every merge" }, { value: "balanced", label: "Balanced", hint: "asks before risky merges" }, { value: "autonomous", label: "Autonomous", hint: "asks only for what is never agent work" },
    ] }))
    auto = cancelled<string>(await p.select({ message: "Automatic reviews of your own PRs", initialValue: "off", options: [
      { value: "off", label: "Off", hint: "only when you comment @dobby review" }, { value: "drafts", label: "Drafts too" }, { value: "on", label: "Every PR" },
    ] }))
  }
  const tz = localZone()
  const owners = [...new Set([login, ...ready.map((d) => d.remote!.split("/")[0])].filter(Boolean))]
  const have = existsSync(privatePath()) ? JSON.parse(readFileSync(privatePath(), "utf8")) : {}
  const next = fillConfig(have, { timezone: tz, timezoneLabel: zoneLabel(tz), github: { owner: login, accounts: owners }, safety: { preset }, review: { auto } })
  mkdirSync(configDir(), { recursive: true })
  writeFileSync(privatePath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  p.log.success(`Settings saved in ${tidy(privatePath())}${have.timezone ? " (your existing values kept)" : ""}`)

  // 6. background jobs: a row ticks only once launchd or systemd reports the job loaded
  if (fresh) setPause(db, { kind: "merges" }, true, "setup") // the first merge always waits for the owner: dobby resume merges
  if (!o.noJobs && (process.platform === "darwin" || process.platform === "linux")) {
    s.start("Starting Dobby")
    const r = installJobs({ bin: `${o.root}bin/dobby`, home: homedir(), uid: process.getuid?.() ?? 0, log: () => {} })
    s.stop(r.every((x) => x.ok) ? "Dobby is running" : "Some jobs did not start")
    p.log.message(r.map((x) => `${x.ok ? "✓" : "✗"} ${x.name.padEnd(10)} ${x.detail}`).join("\n"))
  } else if (!o.noJobs) p.log.warn(`Background jobs are not available on ${process.platform}: run \`dobby start\` in a terminal`)

  // 7. first ticket: only offered, never built without a yes
  if (!o.yes && ready.length) await offerFirst(db, ready)
  p.outro(`Files: ${tidy(configDir())} · ${tidy(expand(config().paths.data))}\nNext: dobby status · dobby doctor · dobby uninstall${fresh ? "\nMerges are paused until you run: dobby resume merges" : ""}`)
}

async function offerFirst(db: DB, repos: Detected[]) {
  const { addTicket, queueTicket } = await import("./lib.ts")
  const pool = repos.flatMap((d) => {
    // only issues the user wrote: on a public repo anyone can open one, and its body becomes the builder's instructions (audit 24 Oct M3)
    const r = spawnSync("gh", ["issue", "list", "-R", d.remote!, "--state", "open", "--author", "@me", "--limit", "50", "--json", "number,title,body,labels"], { encoding: "utf8" })
    try { return rankIssues(JSON.parse(r.stdout)).slice(0, 3).map((i) => ({ d, i })) } catch { return [] }
  })
  for (const { d, i } of pool) {
    const project = d.dir.split("/").pop()!
    const pick = cancelled<string>(await p.select({
      message: `First ticket? The smallest open issue you wrote with a clear done rule:\n  ${d.remote} #${i.number}  "${i.title}"\n  The builder gets this text:\n  ${clip(i.body, 400).replaceAll("\n", "\n  ")}`,
      options: [{ value: "queue", label: "Build it now", hint: "Dobby opens a PR; it merges only when you say so" }, { value: "next", label: "Pick another" }, { value: "skip", label: "Skip" }],
    }))
    if (pick === "skip") return
    if (pick === "next") continue
    const { id } = addTicket(db, { project, title: `${i.title} (#${i.number})`.slice(0, 200), done_when: i.body.slice(0, 2000), size: "S" })
    p.log.success(queueTicket(db, id))
    return
  }
  p.log.info("No open issue is small and clear enough for a first ticket. Add one with: dobby add <project> \"<title>\"")
}

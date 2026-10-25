// The config: defaults equal the literals they replaced (golden), layering, repo-only-tightens, migrate. Temp paths only.
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import Database from "better-sqlite3"

const dir = mkdtempSync(`${tmpdir()}/foreman-config-`)
process.env.DOBBY_DIR ??= dir
process.env.DOBBY_SECRETS ??= `${dir}/secrets.env`
const { defaults, loadConfig, mergeFlags, quietAt, tzOffset, zoned, zonedDay, configDir, dataDir } = await import("../src/config.ts")
const { DEFAULT_RULES } = await import("../src/policy.ts")
const { LAYOUT } = await import("../src/discord.ts")
const { silentAt } = await import("../src/telegram.ts")
const { migrate } = await import("../src/migrate.ts")

test("defaults are neutral: the given time zone, nobody's names; the owner's values come from their private config (fixture)", () => {
  assert.deepEqual(defaults("/Users/me", "darwin", "Asia/Kolkata"), {
    timezone: "Asia/Kolkata", timezoneLabel: "GMT+5:30", quietHours: { start: 23, end: 8 }, eveningPostHour: 21,
    github: { owner: "", accounts: [] }, clientNames: [], clientProjects: [], frontDeskDenyMcp: [],
    safety: { preset: "balanced", rules: {}, classifier: "model", unsure: "ask" },
    paths: { projects: "~/projects", data: "~/.local/share/dobby", memory: "~/.claude/projects/-Users-me/memory", usageCli: "", dashboardDist: "" },
    discord: { hq: ["needs-you", "daily-update", "system-status", "assistant"], apps: {}, extraChannels: {} },
  })
  assert.equal(defaults("/x", "darwin", "America/New_York").timezoneLabel, "EST")
  const owner = loadConfig().config // tests load tests/fixtures/owner-config.json as the private file
  assert.deepEqual([owner.timezone, owner.timezoneLabel, owner.github.owner, owner.clientProjects], ["Asia/Kolkata", "IST", "ownerdev", ["shopfront"]])
  assert.equal(configDir("/Users/me", "darwin"), "/Users/me/.config/dobby")
  assert.equal(configDir("C:\\Users\\a", "win32", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }), "C:\\Users\\a\\AppData\\Roaming\\dobby")
  assert.equal(dataDir("C:\\Users\\a", "win32", { LOCALAPPDATA: "D:\\L" }), "D:\\L\\dobby")
})

test("golden: policy client rules, Discord layout, time and quiet hours equal the old literals", () => {
  const r = (id: string) => DEFAULT_RULES.find((x) => x.id === id)
  assert.deepEqual(r("client-name"), { id: "client-name", applies: "ticket-text", projects: ["shopfront"], match: "orion|lyra|vega|rigel|altair", action: "deny", why: "a real client: client invites, code and deploys are never agent work (owner, 16 Oct)" })
  assert.deepEqual(r("client-invite")!.projects, ["shopfront"])
  assert.deepEqual(LAYOUT, [
    { category: "📌 HQ", channels: ["needs-you", "daily-update", "system-status", "assistant"] },
    { category: "💰 TALLY", channels: ["tally-tickets", "tally-releases", "tally-ideas"] },
    { category: "🎬 SHOPFRONT", channels: ["shopfront-tickets", "shopfront-releases", "shopfront-ideas", "shopfront-dms"] },
    { category: "⚙️ DOBBY", channels: ["dobby-tickets", "dobby-releases", "dobby-ideas"] },
  ])
  for (const ms of [0, 1_760_000_000_000, Date.UTC(2026, 9, 20, 18, 29, 59), Date.UTC(2026, 2, 29, 1, 30)]) {
    assert.equal(tzOffset(ms), 19_800_000)
    assert.equal(zoned(ms).getTime(), new Date(ms + 5.5 * 3600_000).getTime())
    assert.equal(zonedDay(ms), new Date(ms + 19_800_000).toISOString().slice(0, 10))
  }
  for (let h = 0; h < 24; h++) assert.equal(silentAt(h), h >= 23 || h < 8)
  assert.deepEqual([quietAt(13, { start: 12, end: 14 }), quietAt(14, { start: 12, end: 14 })], [true, false])
  assert.equal(tzOffset(Date.UTC(2026, 6, 1), "America/New_York"), -4 * 3600_000)
})

test("layers: repo file only adds client names, private file changes anything, bad input warns and is skipped", () => {
  const repo = `${dir}/repo.json`, priv = `${dir}/private.json`
  writeFileSync(repo, JSON.stringify({ clientNames: ["zed"], clientProjects: [], timezoneLabel: "X", typo: 1 }))
  writeFileSync(priv, JSON.stringify({ github: { owner: "someone" }, timezone: "Europe/London" }))
  const l = loadConfig({ repo, private: priv })
  assert.deepEqual(l.config.clientNames, ["zed"])
  assert.deepEqual(l.config.clientProjects, [])
  assert.equal(l.config.timezoneLabel, "X")
  assert.equal(l.config.github.owner, "someone")
  assert.deepEqual(l.config.github.accounts, []) // deep merge keeps siblings
  assert.equal(l.config.timezone, "Europe/London")
  assert.deepEqual(l.warnings, [`${repo}: unknown key typo (ignored)`])
  writeFileSync(priv, JSON.stringify({ clientNames: [] }))
  assert.deepEqual(loadConfig({ repo, private: priv }).config.clientNames, []) // the private file may loosen
  writeFileSync(priv, "{ not json")
  const bad = loadConfig({ repo: `${dir}/none.json`, private: priv })
  assert.equal(bad.config.github.owner, "")
  assert.match(bad.warnings[0], /ignored/)
  writeFileSync(priv, JSON.stringify({ timezone: "Mars/Base" }))
  assert.equal(loadConfig({ repo: `${dir}/none.json`, private: priv }).config.timezone, defaults().timezone)
})

test("migrate: writes once from today's setup, key names only, never overwrites; dry run writes nothing", () => {
  const path = `${dir}/cfg/config.json`, drafts = `${dir}/projects`, la = `${dir}/la`, secrets = `${dir}/mig-secrets.env`, dbPath = `${dir}/mig.db`
  mkdirSync(drafts), mkdirSync(la)
  for (const f of ["tally.md", "shopfront.md", "foreman.md", "newapp.md", "tally.knowledge.md"]) writeFileSync(`${drafts}/${f}`, "---\nrepo: ~/projects/x\n---\n")
  for (const f of ["com.dobby.tick.plist", "com.dobby.cos.plist", "com.other.plist"]) writeFileSync(`${la}/${f}`, "")
  writeFileSync(secrets, "DISCORD_BOT_TOKEN=supersecretvalue123\nexport GH_TOKEN=ghp_abcdefghijklmnop\n# comment\n")
  const db = new Database(dbPath)
  db.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)")
  db.prepare("INSERT INTO kv VALUES (?, ?)").run("discord:guild", "111")
  db.prepare("INSERT INTO kv VALUES (?, ?)").run("discord:ch:needs-you", "222")
  db.prepare("INSERT INTO kv VALUES (?, ?)").run("discord:wh:needs-you", "333/webhooktoken")
  db.close()
  const o = { path, drafts, launchAgents: la, secrets, db: dbPath, now: new Date(0) }
  const dry = migrate({ ...o, dryRun: true })
  assert.match(dry, /^would write/)
  assert.ok(!existsSync(path))
  assert.equal(migrate(o), `wrote ${path}`)
  const text = readFileSync(path, "utf8"), c = JSON.parse(text)
  assert.ok(!text.includes("supersecretvalue123") && !text.includes("ghp_") && !text.includes("webhooktoken"))
  assert.deepEqual(c.migrated, { at: "1970-01-01T00:00:00.000Z", projects: ["foreman", "newapp", "shopfront", "tally"], secretKeys: ["DISCORD_BOT_TOKEN", "GH_TOKEN"], discord: { guild: "111", "ch:needs-you": "222" }, launchdJobs: ["com.dobby.cos", "com.dobby.tick"] })
  assert.equal(c.github.owner, "") // neutral: migrate copies no one's values
  assert.equal(c.review, undefined) // the reviewer runs on its code defaults; migrate pins nothing for it
  assert.deepEqual(c.discord.apps.newapp, { label: "NEWAPP", ideas: true })
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.match(migrate(o), /already exists/)
  assert.equal(readFileSync(path, "utf8"), text)
  const back = loadConfig({ repo: `${dir}/none.json`, private: path })
  assert.deepEqual(back.warnings, [])
})

test("mergeFlags: squash and delete the branch by default; the owner can change both", () => {
  const gh = defaults().github
  assert.deepEqual(mergeFlags({ github: gh }), ["--squash", "--delete-branch"])
  assert.deepEqual(mergeFlags({ github: { ...gh, mergeMethod: "rebase", deleteBranch: false } }), ["--rebase"])
})

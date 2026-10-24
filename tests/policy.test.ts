import assert from "node:assert/strict"
import test from "node:test"
import { decide, explain, loadRules, DEFAULT_RULES } from "../src/policy.ts"
import { BUILDER_DENY, BUILDER_TOOLS } from "../src/graphs/ticket.ts"
import { writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"

// The oracle: the regexes as they stood before src/policy.ts (lead.ts, jev.ts, review.ts, deploy.ts, lib.ts), copied verbatim.
const OWNER_ONLY = /^owner:|deploy|migrat|production|play console|release|secret|token|payment|real financ\w* data|client|couple|orion|lyra|vega|rigel|rsvp/i
const OWNER_HARD = /^owner:|orion|lyra|vega|rigel|altair/i
const ALWAYS_BIG = /migrat|drizzle|\.sql$|wrangler\.(toml|jsonc?)$|\.env|auth|billing|payment|eas\.json|app\.json$/i
const DATA_SQL = /\b(update|insert|delete|truncate|merge)\b|\balter\s+table\b[^;]*\b(drop|rename)\b|\bdrop\s+(table|column)\b/i
const oldTicket = (t: string) => (OWNER_HARD.test(t) ? "deny" : OWNER_ONLY.test(t) ? "ask" : "allow")
const oldPath = (p: string) => (ALWAYS_BIG.test(p) && !/\.mdx?$/.test(p) ? "ask" : "allow")
const oldQueue = (title: string) => /^owner:/i.test(title) || /deploy|migrat|production|play console|release|secret|token|payment|orion|lyra|vega|rigel|altair/i.test(title)

// Real titles: tests/core.test.ts, tests/owner.test.ts, NOTES.md tickets, Shopfront client-guard paths (fixReview).
const TICKETS = [
  "Owner: confirm the listing", "owner: rotate keys", "Deploy the admin console", "Add column via migration 0059", "Rebuild import", "Fix footer typo",
  "Run the db migrate script", "Rotate the Play Console token", "Split import into steps",
  "Palace demo link preview is blank when shared on WhatsApp og image added; nothing to deploy by hand",
  "Deploy the demo Workers to production run wrangler deploy", "Fix Orion's invite RSVP page", "Add a copy button",
  "Capped sign-up: 500 households", "Rename the people in the demo seed (apps/api/src/db/seed/demo.ts, users.ts): no real names",
  "Budgets, import and sharing free at launch", "301s + proxied DNS for old demo subdomains", "Retire Vercel demo projects",
  "Fix review findings on acmeorg/tally#599", "Sort payments docs page", "Count tokens used per run", "Export real financial data to CSV",
  "Couple check-in screen", "Publish the Tally release", "Update the production secret", "Altair wedding site photos",
  "Lyra invite tweaks", "Vega gallery", "Rigel RSVP list", "Fix client invite for Desai", "Shopfront router Worker for /demo/*",
  "clients/orion/index.html", "series/rsvp-form.tsx", "Gallery page at /demo/", "Review Gmail sign-in scope", "Store listing copy",
  "  Owner: leading space", "Improve dark mode contrast", "Nostalgia demo map", "Weekly plan email to owner",
]
const PATHS = [
  "apps/api/drizzle/0058_add.sql", "drizzle/0058_cap.sql", "apps/api/src/auth/session.ts", "README.md", "docs/android/sort-payments.md",
  "docs/payments.md", "src/footer.tsx", "CHANGELOG", "wrangler.toml", "apps/web/wrangler.jsonc", "apps/web/wrangler.json", ".env.example",
  "apps/mobile/eas.json", "apps/mobile/app.json", "app.json.bak", "src/billing/plan.ts", "docs/AUTH.MD", "migrations/0001_init.sql",
  "src/payments.mdx", "src/lib/oauth.ts", "package.json", "src/Author.tsx", "db/schema.sql.md", "src/a.ts",
]
const SQL = [
  "CREATE TABLE app_settings (k text primary key, v text);\nALTER TABLE users ADD COLUMN cap int;", "CREATE INDEX ix ON t(a); ",
  "UPDATE users SET plan = 'free' WHERE plan IS NULL;", "INSERT INTO settings VALUES ('cap', '500');", "ALTER TABLE t DROP COLUMN old;",
  "DROP TABLE legacy;", "ALTER TABLE t RENAME TO t2;", "DELETE FROM sessions;", "CREATE TABLE updated_at_log (id int);", "TRUNCATE audit;",
]

test("policy parity: ticket text gives the old OWNER_HARD / OWNER_ONLY outcome", () => {
  for (const t of TICKETS) assert.equal(decide("ticket-text", t.trim()).action, oldTicket(t.trim()), t)
})

test("policy parity: changed paths give the old ALWAYS_BIG (minus markdown) outcome", () => {
  for (const p of PATHS) assert.equal(decide("changed-path", p).action, oldPath(p), p)
})

test("policy parity: deploy SQL gives the old DATA_SQL outcome", () => {
  for (const s of SQL) assert.equal(decide("deploy", s).action !== "allow", DATA_SQL.test(s), s)
})

test("policy: command rules deny every Bash entry of BUILDER_DENY and none of BUILDER_TOOLS", () => {
  const bash = (xs: string[]) => xs.map((x) => x.match(/^Bash\((.*):\*\)$/)?.[1]).filter((x): x is string => !!x)
  for (const c of bash(BUILDER_DENY)) assert.equal(decide("command", `${c} x`).action, "deny", c)
  for (const c of bash(BUILDER_TOOLS)) assert.equal(decide("command", `${c} x`).action, "allow", c)
})

test("policy: deny beats ask beats allow; policy.json overrides by id; explain names the winner", () => {
  const rules = [...DEFAULT_RULES, { id: "ok-docs", applies: "ticket-text" as const, match: "docs", action: "allow" as const, why: "docs" }]
  assert.equal(decide("ticket-text", "payments docs", rules).rule, "payments") // ask over allow
  assert.equal(decide("ticket-text", "Owner: payments docs", rules).rule, "owner-marker") // deny over both
  assert.equal(decide("ticket-text", "docs", rules).rule, "ok-docs")
  assert.equal(decide("ticket-text", "copy button").rule, "default")
  const f = `${mkdtempSync(`${tmpdir()}/policy-`)}/policy.json`
  writeFileSync(f, JSON.stringify([{ id: "payments", applies: "ticket-text", match: "payment", action: "deny", why: "stricter" }]))
  assert.equal(decide("ticket-text", "payments", loadRules(f).rules).action, "deny") // stricter is allowed
  writeFileSync(f, JSON.stringify([{ id: "x", applies: "nope", match: "a", action: "allow" }]))
  const bad = loadRules(f)
  assert.match(bad.error ?? "", /policy\.json ignored/) // a bad file never takes the system down or drops a rule
  assert.equal(bad.rules, DEFAULT_RULES)
  // review 20 Oct: an override can never lower a built-in action or narrow its pattern
  writeFileSync(f, JSON.stringify([
    { id: "client-name", applies: "ticket-text", match: "orion", action: "allow" },
    { id: "sensitive-path", applies: "changed-path", match: "$^", action: "allow" },
    { id: "data-migration", applies: "deploy", match: "never", action: "allow" },
  ]))
  const weak = loadRules(f).rules
  assert.equal(decide("ticket-text", "Altair invite", weak).action, "deny")
  assert.equal(decide("changed-path", "src/auth.ts", weak).action, "ask")
  assert.equal(decide("deploy", "DELETE FROM t", weak).action, "ask")
  // the policy files themselves are sensitive; a newline in a path does not hide the match; markdown is still exempt
  for (const path of ["policy.json", "src/policy.ts", "foo\nauth.ts"]) assert.equal(decide("changed-path", path).action, "ask", path)
  assert.equal(decide("changed-path", "docs/auth.md").action, "allow")
  assert.match(explain("Deploy drizzle/0058.sql"), /ticket-text: ASK \(ship:[\s\S]*changed-path: ASK \(sensitive-path/)
})

test("policy: agent prompts and guards are sensitive paths, markdown included (audit 20 Oct, item 5)", () => {
  // New on 20 Oct, on purpose beyond the old ALWAYS_BIG oracle: these force the strict (Opus) review.
  const NEW_SENSITIVE = ["roles/builder.md", "roles/front-desk.md", "skills/tdd/SKILL.md", "agent-rules.md", "agent-settings.json", "src/graphs/ticket.ts",
    "src/graphs/review.ts", "src/lib.ts", "src/frontdesk.ts", "src/scout.ts", "src/policy.ts", "projects/foreman.md", "projects/tally.md", "bin/guard-hook.mjs",
    "bin/dobby", "src/telegram.ts", "src/discord.ts", "src/cli.ts", "src/scan.ts", "src/merge.ts"]
  for (const p of NEW_SENSITIVE) assert.equal(decide("changed-path", p).action, "ask", p)
  for (const p of ["docs/roles/x.md", "apps/web/src/lib.ts", "src/library.ts", "README.md", "src/graphs/lead.ts", "notes/agent-rules.md.bak.txt"]) assert.equal(decide("changed-path", p).action, "allow", p)
})

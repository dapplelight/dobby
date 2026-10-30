// Fake usage reader (the claude-usage-limits CLI): `node usage.js --json --host claude`. Answers from the JSON file named by
// DOBBY_FAKE_USAGE ({"five": 10, "week": 10}), else 10% and 10% with the windows half gone. Dobby reads it through the config
// key paths.usageCli, so no network and no Keychain are involved.
import { existsSync, readFileSync } from "node:fs"

const f = process.env.DOBBY_FAKE_USAGE
const u = f && existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {}
process.stdout.write(JSON.stringify({
  windows: [
    { key: "five_hour", percentUsed: u.five ?? 10, msToReset: u.fiveMsToReset ?? 2.5 * 3600_000 },
    { key: "seven_day", percentUsed: u.week ?? 10, msToReset: u.weekMsToReset ?? 3.5 * 86_400_000 },
  ],
  snapshotAgeMs: 0,
}) + "\n")

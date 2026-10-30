import type { ConfigKey } from "../../../src/api-schema.ts"

// What each setting is called on the Settings page, shared with the ⌘K palette.
const LABELS: Record<string, string> = {
  "pacing.weekCap": "Stop at", "pacing.fallbackBuildsPerDay": "Builds a day without a plan reading", reviewCap: "Reviews may use up to (5-hour %)", "safety.everyMerge": "Merging",
  "billing.mode": "Billing", "billing.dailyUsd": "Daily cap (USD)", "billing.weeklyUsd": "Weekly cap (USD)", "billing.workspaceId": "Console workspace id (org-level key)", "billing.planUsd": "What your plan costs (USD)", "scout.enabled": "Talent Scout", "scout.hour": "Scout starts at (hour)",
  "quietHours.start": "Quiet hours start", "quietHours.end": "Quiet hours end", eveningPostHour: "Evening post (hour)", timezone: "Time zone", timezoneLabel: "Time zone name", "providers.enabled": "Route work to other models", "providers.acp": "Use ACP agents (Gemini CLI)",
  "safety.preset": "Safety preset", "safety.classifier": "Classifier", "safety.unsure": "When it cannot tell", "safety.deploy": "After a merge", deployFrom: "Deploy from", deployOnFailure: "When a deploy fails",
  mergeChecks: "Checks that gate a merge", "review.provider": "Reviewer", "github.mergeMethod": "Merge method", "github.deleteBranch": "Delete the branch after a merge", "stats.crashes": "Crash reports", "stats.usage": "Usage stats",
}
const human = (k: string) => { const p = k.split("."); const w = (p.at(-1)!.length <= 2 ? p.slice(-2).join(" ") : p.at(-1)!).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase(); return w[0].toUpperCase() + w.slice(1) }
export const label = (k: ConfigKey) => LABELS[k.key] ?? human(k.key)

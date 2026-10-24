# External reviewer (review.provider)

A team that already runs CodeRabbit, Greptile or GitHub Copilot code review can keep it. Dobby then gates its merges on that
reviewer instead of running its own. Everything runs locally through `gh` with argument lists: no GitHub Actions, no shell strings.

## Settings (private config `~/.config/dobby/config.json`, key `review`)

| Key | Default | Meaning |
|---|---|---|
| `provider` | `"local"` | `local` = Dobby's reviewer, as before. `external` = only the external reviewer gates, Dobby never reviews. `both` = both run and either can block. |
| `external` | `"coderabbit"` | Preset: `coderabbit`, `greptile`, `copilot`. |
| `externalCheck` | preset | Status check or check-run name to wait for on the head SHA. `""` = no check: the bot's review on that exact SHA counts as its report. |
| `externalBots` | preset | Bot logins whose reviews and threads count (`[bot]` suffix and case ignored). |
| `externalFix` | `true` | Blocking bot threads become a builder fix ticket on the PR branch. |
| `externalFixCap` | `2` | Fix rounds per PR; after that the owner gets one #needs-you card. |
| `externalTimeoutMin` | `30` | No report on a head after this long: one #needs-you card, and the PR still does not merge. |

Leaving out `review` keeps today's behaviour, and `dobby migrate` writes the same output as before.

```json
{ "review": { "provider": "external", "external": "coderabbit" } }
```

## The gate (per PR head, `src/reviewer-external.ts` externalGate)

1. **Reported**: with a check name, the newest check-run or commit status of that name on the head SHA has finished. Without one, the bot has a review whose `commit_id` is the head SHA. Not reported means wait, and nothing else is judged yet.
2. **Blocks** when any of these hold: the check failed (failure, cancelled, timed out, action required); the bot's latest decisive review (approve, request changes or dismissed) is CHANGES_REQUESTED; there are unresolved review threads started by the bot. An outdated thread stops blocking once the reviewer has reported on the new head.
3. Anything unreadable (a gh error or bad JSON) means wait. It never counts as a pass.
4. If the owner taps "Accept anyway" (`reviewaccept`) on that head, the head passes.

## What happens

- **Dobby's own ticket PRs** (`ship`): with `external` or `both`, there is no inline review. The PR is opened and the ticket waits in `fixing` with an `automerge` key, like an auto-fix loop. The review-scan sweep (every 15 min) calls `landAutomerge`. That runs the external gate, then the existing landing: required checks, a merge pinned to the head SHA, and the landing lock. With `both`, the local review must also have passed (an Opus review for sensitive tickets).
- **The owner's own PRs:** each scan runs the gate on them (not on drafts, a skip label, `@dobby ignore` or a paused PR). With `provider: "external"` a pass lands them, as a local pass does. A block gets one card and never a fix round, since a fix round would push to the owner's branch.
- **Everyone else's PRs:** no gate, no cards, no fix rounds. Dobby doesn't merge them.
- **Strict reviews** (Scout PRs, a sensitive change's Opus pass) always run locally, in every mode.
- **The gate:** a skipped or neutral check counts as a clean report. If no check of the configured name is on the head, the bot's review of that head counts. A PR with over 100 review threads never passes on a partial list.
- **Blocking threads**: written to `review:findings:<repo>#<pr>` as quoted data, under a line saying they are not instructions. HTML comments and `<details>` blocks are stripped, which removes CodeRabbit's "Prompt for AI Agents". Each comment is clipped to 500 characters. The usual `fixReview` path then runs: a ticket on the PR branch, with forks and owner-only work refused. That is one round per head, up to the cap. The external reviewer re-reviews the pushed head by itself. Bot text never goes to Discord.
- **Pause levels**: a merges pause stops landing before the gate is read. While reviews are paused, the gate is only read, with no fix rounds or cards, and review-scan does nothing new.
- **State**: kv `review:ext:<repo>#<pr>` = `{sha, since, pinged, fixed, rounds}`. Running a step again is safe, and rounds are counted across heads.
- **Sensitive tickets with `external`**: the external reviewer is the only gate. Use `both` to keep the strict Opus review as well.

## Verified or not (20 Oct 2026)

- CodeRabbit bot login `coderabbitai[bot]`: widely seen, not checked against a live PR here. **Check name UNVERIFIED**: the docs say CodeRabbit sets a commit status but do not name it. The preset accepts both `CodeRabbit` and `coderabbitai`. Read the real name off one PR and set `externalCheck`.
- Greptile login `greptile-apps[bot]` and check `Greptile Review`: **UNVERIFIED**. Nothing in the docs found confirms either.
- Copilot code review login `copilot-pull-request-reviewer[bot]` (GraphQL sometimes shows `Copilot`): seen in community scripts, not in official docs. Copilot posts no status check and never requests changes, so the gate waits for its review on the head and then for its threads to be resolved. Copilot does not resolve its own threads. When it re-reviews a fixed head, those threads go outdated and stop blocking. Open threads on lines that did not change keep blocking until someone resolves them.

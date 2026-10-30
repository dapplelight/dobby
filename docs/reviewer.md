# The PR reviewer

One reviewer, local first. `dobby review-scan` runs inside the always-on listener every 15 minutes: it answers PR comment
commands, then reviews new heads of open PRs on the repos that matter (up to 4 per scan). No GitHub Actions and no webhooks;
every GitHub call is `gh` with an argument array, and every comment body goes through a temp file, never a command line.

Code: `src/graphs/review.ts` (gate → review → post → record, the walkthrough, statuses, auto-fix rounds, merges) and
`src/reviewer/` (settings, prompt additions, comment commands; GitHub and the model come in through injected deps, so this
folder can become a standalone package).

## What a review posts

- One inline GitHub review with the findings that sit on diff lines (a `suggestion` block when the fix is one line).
- One walkthrough comment, edited in place on every push: verdict, summary, File | Change table, risk, gate decision,
  findings outside the diff. It stays under GitHub's 65,536-character limit; outside findings that do not fit go into
  follow-up comments (replaced on the next push), never dropped.
- The "Claude Review" commit status on the head SHA. Only high and medium findings fail it.
- A failed review pings #needs-you (Dobby PRs fix themselves for 2 rounds first). Dobby PRs merge only on a pass.

## Settings

All in the private config (`~/.config/dobby/config.json`, or `DOBBY_CONFIG`) under `review`. Leave it out and you get the
defaults below: everything on, with the safety limits kept. Set a key to turn one piece off or retune it.
`review.repos["owner/name"]` overrides any key for one repo (an unknown key there warns, like anywhere else). A bad value drops the whole `review` section, with a warning, and
the defaults run instead. `dobby config show` prints what is in force; `@dobby configuration` prints it on a PR.

| Key | Default | What it does |
|---|---|---|
| `auto` | `"off"` | `off`: only on request (`@dobby review`), so no usage is spent unasked. `drafts`: review every open PR automatically except drafts. `on`: drafts too. Dobby's own ticket PRs are reviewed by the ticket pipeline on push either way, and the scan still re-reviews them (non-drafts) unless `mentionOnly` is set. |
| `includePaths` | `[]` | Globs. Not empty = only these files are reviewed. The model is told which changed files are out of scope. |
| `excludePaths` | `[]` | Globs never reviewed. A PR that changes only excluded files is skipped. Gating reviews (strict, a Dobby `dobby/` PR or a Scout `scout/` PR: they merge on their review) ignore both filters. |
| `branches` | `[]` | Base-branch globs that get automatic reviews. Empty = every base branch. |
| `skipLabel` | `"no-review"` | A PR with this label gets no automatic review. `""` = none. |
| `mentionOnly` | `false` | No automatic reviews; only `@dobby review` (turns commands on). |
| `handle` | `"dobby"` | The name commands answer to (`@dobby`). Not `dobby`: that is the owner's chat. On a public repo `dobby` is somebody's GitHub username and gets notified, so on a public repo commands stay OFF until `review.handle` (top-level or for the repo) or `botLogin` is set; `help` says so too. Private repos work with the default. |
| `botLogin` | `""` | Also answer `@<botLogin> <command>`: the GitHub App or bot account the reviewer posts as. `""` = only the handle. |
| `commands` | `true` | PR comment commands (below). |
| `fullReviewsPerDay` | `3` | `@dobby full review` per PR per day. |
| `maxPerScan` | `4` | Automatic reviews per scan. Per repo in `review.repos`; the top-level value also caps the whole scan. |
| `maxChats` | `3` | Owner `@dobby` chat answers per scan. Per repo in `review.repos`; the top-level value also caps the whole scan. |
| `maxCommandsPerScan` | `5` | Commands, replies in the reviewer's threads and 👎 learnings handled per repo per scan; the rest wait. The whole scan handles at most 3x the top-level value. Not counted: comments from users without write access, replies in threads that are not the reviewer's, and 👎s that do not become a learning (strangers' 👎s cost nothing). |
| `ask` | `true` | `@dobby ask` and replies in the reviewer's threads get an answer. |
| `describe` | `true` | `@dobby describe` fills an empty PR description. Off, or a description already there: the suggestion goes in the walkthrough. |
| `maxFindings` | `0` | 0 = no cap; findings are ranked, most severe first. |
| `strictness` | `"default"` | `chill`: high and medium only. `assertive`: also low findings (edge cases, missing tests). |
| `riskBump` | `false` | A haiku or sonnet pick becomes opus when a changed file matches `riskPaths`. Off: Jev and the rules pick the model. |
| `riskPaths` | auth, oauth, oauth2, auth0, authn, authz, authentication, authorization, secret, token, credential, jwt, apikey, env, dotenv, payment, billing, money, wallet, invoice, refund, pricing, migration, migrate, sql, permission, crypto, cryptography, `**/guard-hook*` | A plain word matches a whole word of the path (split on `/ . _ -` and camelCase, `JWTSecret` = jwt + secret, `APIKey` = apikey; plural allowed): `.env` and `useAuth.ts` match, `author.ts` and `tokenizer.ts` do not. An entry with a dot is a file name: `schema.prisma` matches `prisma/schema.prisma`, `.npmrc` matches `.npmrc` and `.npmrc.local`. An entry with `/ * ? [` is a glob. |
| `contextPack` | `true` | Callers, tests and recent history of the changed files, from `graphify-out/graph.json` in the clone. No graph = no pack. |
| `contextFiles` | `10` | Changed files the context pack covers. |
| `learn` | `true` | `@dobby learn` in a reviewer thread, a new 👎 from a user with write access on a reviewer comment, or (with `jevReplies` on) a reply that Jev classifies as "this is intentional / won't fix" is stored; later reviews of that repo treat it as known intentional. Unsure (or Jev off) = no learning. Gating reviews ignore learnings. |
| `jevReplies` | `false` | Send replies in the reviewer's threads to Jev, redacted first, to tell "won't fix" from a question. Off: no Jev call and comment text stays on the Mac; a reply that is not a plain "thanks"/"done" is answered as a question and never becomes a learning (use `@dobby learn` or 👎). |
| `maxLearnings` | `30` | Learnings kept per repo, newest first. |
| `fix` | `true` | `@dobby fix` queues the open high/medium findings as a builder ticket on the PR branch. The reviewer never pushes. Counts toward the PR's 2 auto-fix rounds; never on a Scout PR. |
| `fixesPerDay` | `1` | `@dobby fix` per PR per day. |

Example: quiet reviews for one repo, everything else default.

```json
{ "review": { "repos": { "me/site": { "auto": "off", "strictness": "chill", "learn": false } } } }
```

## Commands

Write in a PR comment (or in a reviewer thread). They are picked up on the next scan (within 15 minutes). The reviewer
reacts 👀 and replies.

| Command | What happens |
|---|---|
| `@dobby review` | Reviews the commits since the last review (a draft too). Already reviewed this head = a reply, no re-run. |
| `@dobby full review` | Reviews the whole PR again, even this head. Capped by `fullReviewsPerDay`. Refused (fixed reply) when the owner accepted this head's review, and on a PR that merges on its review (`dobby/`, `scout/`) whose head already failed: push a fix instead. |
| `@dobby summary` | Rewrites the walkthrough's summary and risk line only. |
| `@dobby describe` | Suggests a title and description (see `describe`). The title is never changed. |
| `@dobby ask <question>` | A read-only answer about the PR or the line the thread is on. A plain reply in a reviewer thread works too ("thanks", "done" and the like get no answer). Never offers or queues a ticket: only the owner's `@dobby` chat can. |
| `@dobby <question>` (owner) | A comment that starts with `@dobby` and no command word is the owner's chat: a read-only answer that may offer a ticket ("yes" queues it). The old `@foreman` handle still works the same way. |
| `@dobby learn` (in a reviewer thread) | Marks that finding as intentional for later reviews of the repo. |
| `@dobby resolve` | Resolves the reviewer's open threads. |
| `@dobby fix` | Queues a builder ticket for the open high/medium findings (only after a failed review recorded them). |
| `@dobby pause` / `resume` | Stops or restarts automatic reviews on this PR. `@dobby review` still works. |
| `@dobby ignore` in the PR description | This PR never gets an automatic review. |
| `@dobby quota` (or `rate limit`) | Full reviews left today on this PR, the per-scan limit, and whether the usage budget allows work now. |
| `@dobby configuration` (or `config`) | The settings in force for this repo. |
| `@dobby help` | The list. |

A `@dobby` inside a `>` quote, a code block or inline code is not a command.

Who may: only users whose repo permission is write or admin (maintain reads as write), checked through `gh api` on every
scan (cached per repo and login for the scan). Other users are ignored without a reply and cost no budget. A lookup that fails
(rate limit, network) leaves the comment for the next scan; a 404 (no such user) counts as no access. On a public repo, commands that run a model (review,
summary, describe, ask, fix, thread questions) refuse a PR whose author is not the owner or a collaborator. Replies never
carry error text: details go to the scan log. Comment text is data: it picks one command from the list above, or becomes the question of
a read-only run (`--restricted`, no MCP, Read/Grep/Glob and `git diff/log/show` only, secret files denied). Commands that run
a model wait for the usage budget; the rest run at once.

Model text posted by `describe` and `summary` has every `@` mention dropped (`@alice` becomes `alice`), so it pings nobody
and cannot put a `@dobby ignore` into the description.

The owner's `@dobby` chat on a stranger's PR (public repo, author not a collaborator) answers only when the comment also
says `untrusted ok`; the run is read-only, the model is told the PR content may be written to steer it, and no ticket is
offered. Without the phrase the reply explains how to ask.

Scout PRs (`scout/`): the strict review is the same as a Dobby PR's (no learnings, no path filters); Approve and
`scout_merge: auto` merge only on an Opus pass or the owner's accept; a review that is busy (another review of that head
running) is waited for and retried, never a reason to close the PR.

`@dobby fix` on a Dobby PR in its auto-fix loop uses that loop's own round counter, so the 2 rounds are shared.

CLI: `dobby review <owner/repo> <pr> [--full]` reviews by hand (a draft too).

## Limits and known gaps

- The walkthrough is rewritten on every review, so a `describe` suggestion placed there lasts until the next push.
- `@dobby full review` (and a forced review by hand) is refused while another live review of the same head runs; each
  review run has its own worktree.
- Learnings from 👎 are read from the 100 most recently updated review comments per repo, once per scan; a comment's
  reactions are read only when its 👎 count rose, and only 👎s given after the previous look count. A comment left over (no
  budget, a failed read) keeps its own start time, so its 👎s are seen next scan.
- A closed or merged PR's pause, full-review and fix counters are dropped once `gh pr view` says it is closed or merged
  (a PR merely missing from the open list keeps them). `gh pr list` reads up to 1000 open PRs per repo.
- Each scan removes per-run worktrees (`review-*`, `chat-*`) whose process is gone and that are over 2 hours old, then runs
  `git worktree prune` in each clone.
- Not yet run against real GitHub: the permission endpoint fields, reactions listing, and editing the walkthrough from a
  command are written against the documented API and tested with a fake `gh` only.

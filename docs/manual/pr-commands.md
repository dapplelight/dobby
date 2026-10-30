---
title: "PR comment commands"
description: "Every @dobby command you can write in a pull request comment, and its limits."
sidebar: { group: Reference, order: 6 }
---

Commands are read by the review scan, every 15 minutes. Only users with write or admin access can give them. Comments from anyone else are ignored and cost nothing.

| Command | What it does |
|---|---|
| `@dobby review` | Reviews the commits since the last review. Works on drafts. |
| `@dobby full review` | Reviews the whole pull request again. 3 per pull request per day. |
| `@dobby summary` | Rewrites the summary and risk line. |
| `@dobby describe` | Suggests a title and description. |
| `@dobby ask <question>` | A read-only answer about the pull request or the line the thread is on. |
| `@dobby learn` | In a reviewer thread: marks that finding as intentional for later reviews of this repo. |
| `@dobby resolve` | Resolves the reviewer's open threads. |
| `@dobby fix` | Queues a builder ticket for the open high and medium findings. Once per pull request per day. |
| `@dobby pause` | Stops automatic reviews on this pull request. |
| `@dobby resume` | Restarts automatic reviews on this pull request. |
| `@dobby quota` | Full reviews left today, and whether the plan allows work now. |
| `@dobby configuration` | The review settings in force for this repo. |
| `@dobby help` | This list. |

## Outside a comment

| Where | What it does |
|---|---|
| `@dobby ignore` in the pull request description | No automatic reviews of this pull request. |
| The `no-review` label (`review.skipLabel`) | No automatic reviews of this pull request. |
| 👎 on a reviewer comment, from someone with write access | Same as `@dobby learn`. |

## Limits

- On a public repo, commands stay off until you set `review.handle` or `review.botLogin`, because `dobby` may be someone's GitHub username.
- On a public repo, commands that run a model are refused on a pull request whose author is not you or a collaborator.
- `@dobby fix` needs `review.fix` on (the default). `@dobby learn` and 👎 need `review.learn` on (the default).

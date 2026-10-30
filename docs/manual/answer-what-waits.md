---
title: "Answer what waits for you"
description: "Approve, decline, merge, deploy, answer or retry the items in Needs you, from the terminal, the dashboard, Discord or Claude."
sidebar: { group: Guides, order: 2 }
---

Everything that waits is in Needs you on the dashboard's Home page. Each row has its actions on it.

## From the terminal

```bash title="Terminal"
dobby approve 41
dobby decline 41
dobby merge 41
dobby deploy shopfront
```

| Command | Does |
|---|---|
| `approve <id>` | Approves a waiting ticket. |
| `decline <id>` | Declines it. On a ticket that is not waiting, it cancels it. |
| `merge <id>` | Merges a pull request that waits for you. |
| `deploy <project>` | The Deploy tap. |
| `answer <id> "<words>"` | Answers a builder's question and queues the ticket again. |
| `hint <id> "<words>"` | Adds a hint for the next build. |
| `retry <id>` | Queues a failed ticket again, or restarts a stuck one. |
| `allowround <id>` | Allows one more fix round on its pull request. |
| `takeover <id>` | Pauses the ticket and leaves its branch to you. |
| `cancel <id>` | Stops the build and closes its pull request and branch. |

:::caution
A migration that changes existing data still waits for its own tap.
:::

## Elsewhere

| Where | How |
|---|---|
| Dashboard | Merge, deploy, decline and retry wait 8 seconds with an Undo. |
| Discord | Each item in `#needs-you` has Approve and Decline buttons. |
| Claude | `dobby_decide` asks you to confirm every time. |

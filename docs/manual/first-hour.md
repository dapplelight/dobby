---
title: "Your first hour"
description: "A guided first run: set Dobby up, write one small ticket, watch it become a reviewed pull request, and merge it."
sidebar: { group: Start, order: 3 }
---

You will give Dobby one small ticket and follow it to a merged pull request. Most of the hour is waiting.

Pick a repo you own on GitHub that has tests.

## Set up

1. Pick your repo and take the recommended answers. Say yes to the background jobs.

   ```bash title="Terminal"
   npx dobby-ai init
   ```

   To try Dobby without the background jobs, run `dobby init --no-jobs` instead. Then keep `dobby start` open in a terminal. Nothing builds while it is closed.

2. Check that every required row has a tick.

   ```bash title="Terminal"
   dobby doctor
   ```

## Write a ticket

Use your repo's folder name in place of `shopfront`.

```bash title="Terminal"
dobby add shopfront "Fix the footer spacing" "the footer has 16px padding on phones"
```

```text title="Output"
#1 size M, risk medium (words)
```

The last part is the done-when line. The [Tester](glossary.md#tester) checks the work against it.

## Watch it build

1. See what is building.

   ```bash title="Terminal"
   dobby status
   ```

2. Follow your ticket's steps. Run it every few minutes.

   ```bash title="Terminal"
   dobby show 1
   ```

You will see the build, your tests, then the Tester. On a new repo, Dobby first reads the repo once. To read it and build the ticket right away, run `dobby run 1`.

:::note
If `dobby status` says `Paused: 5-hour window at ... (pace cap)`, Dobby is leaving room in your plan. It prints the command that lifts the cap for this window. See [Pacing](pacing.md).
:::

## Read the pull request

Open your repo's Pull requests tab on GitHub. Dobby's pull request has the review's findings, a summary and a cost comment.

## Merge it

1. Turn merges on. A fresh install keeps them paused.

   ```bash title="Terminal"
   dobby resume merges
   ```

2. Wait for the review. When it passes, Dobby merges the pull request itself. The review runs in `dobby start` or the background jobs.

3. If your safety preset holds it for you instead, merge it yourself:

   ```bash title="Terminal"
   dobby merge 1
   ```

Refresh the pull request on GitHub. It is merged.

:::tip
Your [safety preset](what-waits.md) decides which pull requests wait for you.
:::

## Next

- [Write a good ticket](write-a-ticket.md)
- [Answer what waits for you](answer-what-waits.md)
- [The loop: ticket to merge](how-it-works.md)

---
title: "Run in the background"
description: "Install the background jobs so Dobby builds, reviews and reports while you work on other things, or run it in a terminal instead."
sidebar: { group: Guides, order: 4 }
---

1. Install the jobs from the copy you installed with `npm i -g dobby-ai`.

   ```bash title="Terminal"
   dobby jobs install
   ```

2. Check that every job has a tick.

   ```bash title="Terminal"
   dobby jobs status
   ```

| Job | Runs |
|---|---|
| `tick` | Always. Plans and builds the next ticket, and runs the review scan when Discord is off. |
| `listener` | Always, with Discord only. Messages and the review scan. |
| `dashboard` | Always. The dashboard at `http://127.0.0.1:4710`. |
| `health` | Hourly. Checks jobs, disk and pipeline. |
| `cos` | Daily at 08:05. The morning brief. |
| `graphify` | Daily at 05:30. Refreshes code maps. |

:::note
Nothing runs while the computer sleeps. Missed jobs run when it wakes.
:::

## After you change Node or move Claude Code

Jobs only know the folders they had at install. Install them again:

```bash title="Terminal"
dobby jobs install
```

## Read the logs

```bash title="Terminal"
tail -f ~/.local/share/dobby/logs/tick.log
```

## Run in a terminal instead

```bash title="Terminal"
dobby start
```

It runs until Ctrl-C. It refuses to start while this install's jobs are running.

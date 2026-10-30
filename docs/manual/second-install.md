---
title: "Run a second install"
description: "Run a separate Dobby beside your real one, for a trial or another account, without the two sharing projects, pauses or jobs."
sidebar: { group: Guides, order: 12 }
---

1. Point the second install at its own folders.

   ```bash title="Terminal"
   export DOBBY_CONFIG=~/dobby-test/config/config.json
   export DOBBY_DIR=~/dobby-test/data
   ```

2. Set it up without background jobs.

   ```bash title="Terminal"
   dobby init --no-jobs
   ```

3. Run it in a terminal.

   ```bash title="Terminal"
   dobby start
   ```

:::caution
Skip the jobs. Job names are per user, so a second set would replace your real install's jobs.
:::

Keep both variables set in every shell where you use the second install. To remove it, see [Uninstall](uninstall.md#remove-a-second-install).

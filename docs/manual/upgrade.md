---
title: "Upgrade"
description: "Upgrade Dobby to the latest version and point the background jobs at it."
sidebar: { group: Guides, order: 13 }
---

1. Install the latest version.

   ```bash title="Terminal"
   npm i -g dobby-ai@latest
   ```

2. Point the background jobs at it.

   ```bash title="Terminal"
   dobby jobs install
   ```

3. Check the version.

   ```bash title="Terminal"
   dobby --version
   ```

If you use `dobby start` instead of the jobs, restart it after the upgrade.

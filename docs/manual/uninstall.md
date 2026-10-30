---
title: "Uninstall"
description: "Remove Dobby's background jobs, its Claude connections, its data and the package, and clean up what it set on GitHub."
sidebar: { group: Guides, order: 14 }
---

1. See what would be removed.

   ```bash title="Terminal"
   dobby uninstall --dry
   ```

2. Remove the background jobs. Your data and config stay.

   ```bash title="Terminal"
   dobby uninstall
   ```

3. Remove the Claude connections, if you added them.

   ```bash title="Terminal"
   claude mcp remove --scope user dobby
   rm -rf ~/.claude/skills/dobby-setup
   ```

4. Delete your data and config.

   ```bash title="Terminal"
   rm -rf ~/.config/dobby ~/.local/share/dobby
   ```

5. Remove the package last.

   ```bash title="Terminal"
   npm rm -g dobby-ai
   ```

:::danger
Step 4 deletes your tickets, history, settings and secrets. It cannot be undone.
:::

:::note
If you set `DOBBY_DIR` at install, set it again before step 2. Dobby only removes jobs that belong to the install it runs as.
:::

## Clean up GitHub

`dobby init` set a `DOBBY_OWNER` variable on each repo. Remove it per repo:

```bash title="Terminal"
gh variable delete DOBBY_OWNER -R acme/shop
```

Issues Dobby filed stay on GitHub.

## Remove a second install

```bash title="Terminal"
export DOBBY_CONFIG=~/dobby-test/config/config.json
export DOBBY_DIR=~/dobby-test/data
dobby uninstall
rm -rf ~/dobby-test
```

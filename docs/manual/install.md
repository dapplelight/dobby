---
title: "Install"
description: "Install Dobby on macOS or Linux, connect your repos and start the background jobs."
sidebar: { group: Start, order: 1 }
---

:::note
Dobby is in public beta.
:::

## You need

- macOS or Linux
- Node 24 or newer
- GitHub CLI
- Claude Code on a Pro or Max plan, or an Anthropic API key

On Windows or a Linux server, start with [Install on Linux or WSL2](install-linux.md).

## Install

1. Run the setup and answer its questions. Enter takes the recommended choice.

   ```bash title="Terminal"
   npx dobby-ai init
   ```

2. Say yes when it offers a copy that stays. The background jobs need it.

   ```bash title="Terminal"
   npm i -g dobby-ai
   ```

3. Check the install. A failed row prints its fix.

   ```bash title="Terminal"
   dobby doctor
   ```

## Turn merges on

A fresh install opens pull requests but does not merge them until you run:

```bash title="Terminal"
dobby resume merges
```

:::tip
[Your first hour](first-hour.md) walks through the first ticket up to this step.
:::

<details>
<summary>Set up in your browser instead</summary>

```bash title="Terminal"
dobby init --ui
```

You still enter tokens and keys in the terminal.

</details>

<details>
<summary>Add repos from other folders</summary>

```bash title="Terminal"
dobby init --projects ~/code,~/work
dobby init ~/code/shop
```

Repos must be on github.com, with the GitHub remote named `origin`.

</details>

<details>
<summary>npm says better-sqlite3 has install scripts that are not allowed</summary>

```bash title="Terminal"
npm approve-scripts better-sqlite3
```

</details>

<details>
<summary>Install without admin rights</summary>

```bash title="Terminal"
curl -fsSL https://fnm.vercel.app/install | bash
fnm install 24
curl -fsSL https://claude.ai/install.sh | bash
```

Download `gh` from cli.github.com.

</details>

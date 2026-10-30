---
title: "Cap spend"
description: "Keep more of your Claude plan for yourself, switch to an API key with a dollar cap, limit one ticket, and see what each pull request cost."
sidebar: { group: Guides, order: 10 }
---

## Keep more of your weekly plan

Dobby stops starting work at this share of your week. The default is 95.

```bash title="Terminal"
dobby config set pacing.weekCap 80
```

```text title="dobby limits"
Running · 5-hour 34% (cap 60%) · week 49% of 80%
```

## Run on an API key

:::tip
The quickest way is `dobby init`. When Claude Code is not signed in, it asks "Plan or API key?".
:::

To set it up by hand:

1. Add the key to your secrets file.

   ```bash title="~/.config/dobby/secrets.env"
   DOBBY_API_KEY=<key>
   ```

2. Set the mode and the dollar caps.

   ```json title="config.json"
   { "billing": { "mode": "apiKey", "dailyUsd": 20, "weeklyUsd": 100 } }
   ```

3. Check the key. The "API key" row makes one small real call.

   ```bash title="Terminal"
   dobby doctor
   ```

<details>
<summary>Anthropic says "This API key is not scoped to a workspace"</summary>

Create the key inside a workspace in Console, or set the workspace id:

```bash title="Terminal"
dobby config set billing.workspaceId wrkspc_...
```

</details>

## Cap one ticket

Set the most one ticket may spend, by size, in percent of your week. A ticket over it goes to you.

```json title="config.json"
{ "ticketBudget": { "S": 1, "M": 3, "L": 8 } }
```

:::note
These numbers are an example. No ticket is capped until you set them.
:::

## See what a pull request cost

Each pull request Dobby opens gets a comment like this:

```text title="PR comment"
Cost of this PR: 0.42% of your week
| Stage    | Cost  | Runs            |
| Planning | 0.03% | 1               |
| Build    | 0.30% | 2 (1 fix round) |
| Tester   | 0.05% | 2               |
| Review   | 0.04% | 2 heads         |
```

| Command | Shows |
|---|---|
| `dobby cost <id>` | The same table for one ticket. |
| `dobby usage [days]` | Spend by model, from the Claude logs on this computer. |
| `dobby receipt [days]` | A one-line receipt and an image card. |

---
title: "Drive Dobby from Claude (MCP)"
description: "Connect Dobby to Claude Code or Claude Desktop over MCP, so Claude can read status, file tickets and ask you before it merges or deploys."
sidebar: { group: Guides, order: 7 }
---

1. Connect Dobby to Claude Code. Say yes when it asks.

   ```bash title="Terminal"
   dobby add mcp
   ```

2. Restart Claude Code and ask it for your Dobby status.

| Tool | Does |
|---|---|
| `dobby_read` | Status, limits, tickets, cost, scoreboard and pauses. |
| `dobby_docs` | Lists, reads and searches these docs. |
| `dobby_ticket` | Adds or queues tickets. A ticket Claude adds waits for your tap. |
| `dobby_pause` | Pauses or resumes a part of Dobby. |
| `dobby_decide` | Approves, declines, cancels, retries, merges or deploys. Asks you first every time. |

:::note
If Claude cannot ask you, the item goes to Needs you and waits for your tap. Dobby never runs a data migration from MCP.
:::

<details>
<summary>Claude Desktop</summary>

`dobby add mcp` also prints this block for `claude_desktop_config.json`, with the full path to `dobby`:

```json title="claude_desktop_config.json"
{
  "mcpServers": {
    "dobby": { "command": "<path to dobby>", "args": ["mcp"] }
  }
}
```

</details>

<details>
<summary>All values for each tool</summary>

| Tool | Argument | Values |
|---|---|---|
| `dobby_read` | `view` | `status`, `limits`, `list`, `show`, `job`, `cost`, `scoreboard`, `receipt`, `pauses`, `stats-report` |
| `dobby_docs` | `op` | `list`, `read`, `search` |
| `dobby_ticket` | `op` | `add`, `queue`, `answer`, `hint`, `take-over`, `allow-round`, `apply-finding`, `dismiss-finding`, `rule-from-finding`, `unqueue`, `reorder`, `make-ticket`, `dismiss-idea` |
| `dobby_pause` | `op` | `pause`, `resume`, `status`, `config-set` |
| `dobby_decide` | `op` | `approve`, `decline`, `cancel`, `retry`, `merge`, `deploy` |

Resources: `dobby://docs/<topic>`, `dobby://ticket/<id>/log`, `dobby://ticket/<id>/diff`. Prompts: `morning_status`, `triage_inbox`.

</details>

<details>
<summary>Connect over HTTPS from a phone or remote Claude</summary>

The dashboard serves the same tools at `/mcp`. Export `DASHBOARD_TOKEN` from your secrets file first.

```bash title="Terminal"
dobby add mcp --http --url <tunnel address>
```

Over HTTP, merge, deploy, approve, decline and cancel always wait in Needs you.

</details>

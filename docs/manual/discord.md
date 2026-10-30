---
title: "Use Discord"
description: "Connect a Discord bot so Dobby posts what waits for you with buttons, sends the daily brief and answers messages."
sidebar: { group: Guides, order: 5 }
---

:::tip
The easiest way is to choose Discord during `dobby init`.
:::

To add it later:

1. Add the bot token to your secrets file.

   ```bash title="~/.config/dobby/secrets.env"
   DISCORD_BOT_TOKEN=<your bot token>
   ```

2. Turn Discord on.

   ```bash title="Terminal"
   dobby add discord
   ```

3. Create the channels. It is safe to run again.

   ```bash title="Terminal"
   dobby discord setup
   ```

4. Add the `listener` job.

   ```bash title="Terminal"
   dobby jobs install
   ```

Prefer Slack? See [Use Slack (beta)](slack.md).

Dobby reads Discord through the Chat SDK. If the listener misbehaves, set `discord.listener` to `"legacy"` in your config to go back to the previous gateway code (kept for one release).

| Channel | What comes there |
|---|---|
| `#needs-you` | What waits for you, with Approve and Decline buttons. |
| `#daily-update` | The morning and evening brief. |
| `#system-status` | Health checks and pauses. |
| `#dobby-tickets` | One thread per ticket. |

## If the buttons do nothing

Turn on the bot's Message Content intent. It is under Bot, Privileged Gateway Intents, in the Discord developer portal.

## If setup fails with 403

The bot needs Manage Channels and Manage Webhooks. Invite it again:

```bash title="Terminal"
dobby discord invite
```

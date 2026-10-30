---
title: "Use Slack (beta)"
description: "Connect a Slack app so Dobby posts what waits for you with buttons, sends the daily brief and answers messages, over Socket Mode with no public URL."
sidebar: { group: Guides, order: 17 }
---

:::caution
Slack is in beta. Discord is the default and works as before. Pick one: Dobby talks to a single chat platform.
:::

Slack works the same way as [Discord](discord.md): one channel per job, each team member posts under its own name and icon, and the owner taps buttons. It uses Socket Mode, so nothing has to be reachable from the internet.

1. Run the setup and choose Slack.

   ```bash title="Terminal"
   dobby init
   ```

   To add it later, run `dobby add slack`.

2. Dobby prints an app manifest. In Slack, open https://api.slack.com/apps, choose Create New App, From a manifest, pick your workspace and paste it. The manifest turns on Socket Mode and interactivity and asks for these scopes: `chat:write`, `chat:write.customize`, `channels:read`, `groups:read`, `groups:write`, `groups:history`, `reactions:read`, `reactions:write`, `im:history`, `app_mentions:read` and `users:read`. It also turns on the Messages tab, so you can write to the bot in a direct message.

3. Install the app to your workspace and copy the Bot User OAuth Token (starts with `xoxb-`) from OAuth & Permissions.

4. Under Basic Information, App-Level Tokens, generate a token with the `connections:write` scope (starts with `xapp-`).

5. Paste both tokens when Dobby asks. They are hidden and saved in your secrets file, never printed.

   ```bash title="~/.config/dobby/secrets.env"
   SLACK_BOT_TOKEN=<xoxb token>
   SLACK_APP_TOKEN=<xapp token>
   ```

6. Dobby asks for your Slack member ID. In Slack, open your profile, choose the three dots, then Copy member ID. It looks like `U01ABC2DEF3`. Dobby only obeys this person and never guesses it from the workspace.

Dobby then creates the same channels as on Discord, as private channels, invites you, and sets `chat.platform` to `"slack"`. If a channel with the same name already exists, Dobby leaves it alone and creates `dobby-` plus the name instead (for example `#dobby-needs-you`) and tells you. Run `dobby slack setup` to create missing channels later; it is safe to run again. `dobby slack test` posts a hello in each channel. If `dobby jobs install` has not run yet, run it so the `listener` job starts.

The member ID is stored in Dobby's database, not in the secrets file. If an app was created from an older manifest, add the `groups:*` scopes and the `message.groups` event under Event Subscriptions, then reinstall the app.

## What differs from Discord

- Each role posts as the bot with its own name and icon. This needs the `chat:write.customize` scope.
- A ticket's first message is its status line. Later messages for that ticket reply in its thread.
- 👍 and 👎 on an idea card work as on Discord. A 👍 starts the brainstorm in a thread on the card.
- Slack has no silent send, so quiet hours do not apply. Use Slack's own Do Not Disturb.
- Messages you send to the bot in a direct message are answered by the front desk, like messages in `#assistant`.

## If the buttons do nothing

Check that Interactivity is on (Interactivity & Shortcuts) and Socket Mode is enabled (Socket Mode). The manifest sets both.

## If setup fails

- `missing_scope`: the app lacks a scope from the list above. Add it under OAuth & Permissions and reinstall the app.
- `name_taken`: another channel, possibly one you cannot see, has the name. Dobby retries with the `dobby-` prefix.
- `invalid_auth`: one of the tokens is wrong or was revoked. Replace it in the secrets file.

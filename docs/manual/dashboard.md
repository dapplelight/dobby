---
title: "Use the dashboard"
description: "Open the local dashboard, act on what needs you, use its keys, and reach it safely from your phone."
sidebar: { group: Guides, order: 6 }
---

```bash title="Terminal"
dobby add dashboard
dobby dashboard open
```

This opens `http://127.0.0.1:4710`, signed in. Home lists what needs you, with its actions on each row.

| Key | Does |
|---|---|
| `J`, `K` | Move down and up a list. |
| `Enter` | The row's main action. |
| `U` | Undo the last held action. |
| `Cmd+K` or `Ctrl+K` | Search actions, tickets, settings and docs. |
| `?` | Every key. |

:::note
Merge, deploy, decline and retry wait 8 seconds with an Undo before they run.
:::

## Open it from your phone

Tailscale keeps the address private to your devices.

1. Install Tailscale on this machine and your phone, on the same account.

2. Start a tunnel copy of the dashboard and leave it running.

   ```bash title="Terminal"
   dobby dashboard --tunnel --port 4711
   ```

3. Serve it on your tailnet.

   ```bash title="Terminal"
   tailscale serve --bg --https=443 http://127.0.0.1:4711
   ```

4. Print a sign-in link and open it on your phone.

   ```bash title="Terminal"
   dobby dashboard link --host <machine>.<tailnet>.ts.net
   ```

:::caution
Never put a tunnel in front of a dashboard started without `--tunnel`. It serves plain HTTP.
:::

<details>
<summary>Use a Cloudflare tunnel instead</summary>

```bash title="Terminal"
cloudflared tunnel --url http://127.0.0.1:4711
dobby dashboard link --host <the trycloudflare address>
```

The address is public, so put Cloudflare Access in front of it.

</details>

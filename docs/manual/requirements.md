---
title: "Requirements"
description: "The operating systems, tools, sign-ins and disk space Dobby needs."
sidebar: { group: Reference, order: 8 }
---

- macOS or Linux
- Node 24 or newer
- GitHub CLI, signed in
- Claude Code on a Pro or Max plan, or an Anthropic API key

| Need | Details |
|---|---|
| Operating system | macOS, or Linux with systemd. Windows through WSL2 with systemd on. |
| Shell | zsh or bash. |
| git | With `user.email` set. |
| GitHub | Repos on github.com. GitLab, Bitbucket and GitHub Enterprise are not supported. |
| Claude | Claude Code only today. Other agent harnesses are coming. Bedrock and Vertex AI are not supported. |
| Linux sandbox | bubblewrap and socat. |
| Alpine and other musl systems | python3 and a C++ toolchain, to build the database driver. |
| Disk | 15 GB free on a local disk, not NFS or SMB. |
| Admin rights | Not needed. |

Optional: Discord for buttons and briefs, Tailscale for the dashboard on a phone, graphify for code maps.

:::note
Nothing runs while the computer sleeps.
:::

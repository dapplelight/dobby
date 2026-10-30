---
title: "Install on Linux or WSL2"
description: "Prepare a Linux machine, a headless server or Windows with WSL2 for Dobby: systemd, the sandbox, sign-ins over SSH and jobs that survive logout."
sidebar: { group: Start, order: 2 }
---

Do these steps first, then follow [Install](install.md).

## On Windows, turn on systemd in WSL2

1. Add this to `/etc/wsl.conf` inside WSL2.

   ```ini title="/etc/wsl.conf"
   [boot]
   systemd=true
   ```

2. Restart WSL from Windows.

   ```bash title="Terminal"
   wsl --shutdown
   ```

:::caution
Keep your repos in the Linux home folder. Under `/mnt/c`, installs and tests are too slow.
:::

## Install the sandbox

1. Install bubblewrap and socat.

   ```bash title="Terminal"
   sudo apt install bubblewrap socat
   ```

2. On Ubuntu 24.04 and later, let bubblewrap past AppArmor.

   ```bash title="Terminal"
   sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
   ```

Add that setting to a file in `/etc/sysctl.d/` to keep it after a reboot. On Fedora, use `dnf` in step 1.

## Install Node and Claude Code

```bash title="Terminal"
curl -fsSL https://fnm.vercel.app/install | bash
fnm install 24
curl -fsSL https://claude.ai/install.sh | bash
```

Install the GitHub CLI with the steps at cli.github.com.

<details>
<summary>Alpine and other musl systems</summary>

The database driver compiles during install. Install python3 and a C++ toolchain first.

</details>

## Sign in without a browser

1. Sign in to GitHub. Open the URL it prints on any device.

   ```bash title="Terminal"
   gh auth login --web
   gh auth setup-git
   ```

   The second line lets git push with that sign-in.

2. Sign in to Claude Code. Type `/login` and open the link on another device.

   ```bash title="Terminal"
   claude
   ```

## Keep jobs running after you log out

Run this if `dobby jobs install` says it could not turn lingering on.

```bash title="Terminal"
sudo loginctl enable-linger $USER
```

## Open the dashboard from your laptop

1. Forward the port from your laptop.

   ```bash title="Laptop"
   ssh -L 4710:127.0.0.1:4710 you@server
   ```

2. Print a sign-in link on the server and open it on your laptop.

   ```bash title="Server"
   dobby dashboard link
   ```

## If there is no user systemd

Containers and plain `su` shells cannot install the jobs. Run Dobby inside tmux instead.

```bash title="Terminal"
dobby start
```

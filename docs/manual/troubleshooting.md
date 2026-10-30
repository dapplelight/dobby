---
title: "Fix common problems"
description: "What to do when nothing builds, pull requests never merge, a ticket fails, or the background jobs or dashboard do not run."
sidebar: { group: Guides, order: 11 }
---

Start here. Each failed row prints its fix.

```bash title="Terminal"
dobby doctor
```

```text title="Output"
✗ background jobs: not loaded: dashboard
    fix: dobby jobs install
```

Every row is in [Doctor checks](doctor.md).

## Nothing is building

```bash title="Terminal"
dobby status
```

| First line says | Do |
|---|---|
| `Paused at 95% of your week (your cap), resumes ...` | Wait for the reset, or raise `pacing.weekCap`. |
| `Paused: 5-hour window at 60% (pace cap), resumes ...` | Wait until that time, or lift the cap for this window with `dobby do keepgoing 90`. |
| `Builders paused by owner since ...` | Run `dobby resume`. |
| `Plan usage unknown ...` | Check the Claude sign-in row in `dobby doctor`. |
| `Running` | Check that tickets are queued with `dobby list`. |

## Pull requests never merge

A fresh install keeps merges paused:

```bash title="Terminal"
dobby resume merges
```

If that is not it, look at the ticket. It may be waiting for you, or its review failed.

```bash title="Terminal"
dobby show 41
```

## A ticket failed

```bash title="Terminal"
dobby show 41
dobby queue 41
```

The first command shows why it stopped. Fix the ticket text, then queue it again.

## Jobs fail after `npx dobby-ai init`

The jobs need a copy that stays.

```bash title="Terminal"
npm i -g dobby-ai
dobby jobs install
```

## A job exits with "node: not found"

You changed Node or moved Claude Code after installing the jobs.

```bash title="Terminal"
dobby jobs install
```

## Jobs stop when you log out

```bash title="Terminal"
sudo loginctl enable-linger $USER
```

<details>
<summary>On a Mac you only use over SSH</summary>

Log in on the Mac's screen once, or turn on auto-login. Then run `dobby jobs install`.

</details>

## The dashboard does not load

```bash title="Terminal"
dobby jobs status
```

If `dashboard` is not loaded, run `dobby jobs install`.

## Ask Claude to help

Copy Dobby's setup skill into your own Claude Code, then ask Claude about the problem.

```bash title="Terminal"
dobby add skill
```

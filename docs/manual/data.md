---
title: "Where data lives"
description: "Every folder and file Dobby writes on your machine, and the variables that move them."
sidebar: { group: Reference, order: 9 }
---

| Path | What |
|---|---|
| `~/.config/dobby/config.json` | Your settings. `dobby config path` prints where it is, and `dobby config show` prints the merged settings with secrets redacted. |
| `~/.config/dobby/secrets.env` | Tokens and keys, readable only by you. No command prints them. |
| `~/.config/dobby/projects/` | One project file per repo, with its knowledge and onboarding notes. |
| `~/.config/dobby/private-terms.txt` | Words that must never appear in text Dobby posts to a public repo. |
| `~/.local/share/dobby/` | The database (tickets, runs, pauses), worktrees and the receipt card. |
| `~/.local/share/dobby/logs/<job>.log` | One log per background job. Logs over 5 MB are cut to the last 1 MB once a day. |
| `~/.local/share/dobby/stats/sent.jsonl` | Every crash report or usage stat sent, if you turned them on. |
| `~/Library/LaunchAgents/com.dobby.*.plist` | The background jobs on macOS. |
| `~/.config/systemd/user/` | The background jobs on Linux. |
| `dobby.config.json` in Dobby's own install folder | Optional shared defaults. It can only make safety settings stricter. |

## Variables

| Variable | Effect |
|---|---|
| `DOBBY_DIR` | Moves the data folder. Use it when your home folder is on a network drive: SQLite's write-ahead log breaks on NFS and SMB. |
| `DOBBY_CONFIG` | Names the private config file. Its folder then holds the project files and secrets for that install. |

After you set or change either one, run `dobby jobs install` so the jobs use it.

## Settings order

Dobby reads its built-in defaults, then `dobby.config.json` in its install folder, then your private config file. A later layer wins, except that `dobby.config.json` can only tighten safety settings. All keys are in the [configuration reference](config.md).

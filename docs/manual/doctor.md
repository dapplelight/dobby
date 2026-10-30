---
title: "Doctor checks"
description: "Every row dobby doctor prints, when it fails and the fix, plus the repo access rows dobby init reads."
sidebar: { group: Reference, order: 5 }
---

`dobby doctor` exits with code 1 if any required check fails. `dobby doctor --json` prints every row as data. Rows marked optional never fail the exit code.

## Setup checks

| Row | Fails when | Fix |
|---|---|---|
| Node | Node is older than 24. The `dobby` command also says so before it starts. | `brew install node`, or `fnm install 24` (no admin rights needed, Linux too). |
| shell | Neither zsh nor bash is installed. Project commands then run without a login shell. Optional. | Install zsh or bash. |
| git | git is missing. | `xcode-select --install` on macOS, `sudo apt install git` or `sudo dnf install git` on Linux. |
| git identity | git has no `user.email`, so builders cannot commit. | `git config --global user.email "<your GitHub email>"` |
| GitHub CLI | `gh` is missing. | `brew install gh` on macOS, the steps at cli.github.com on Linux. |
| GitHub sign-in | `gh` is not signed in. When GitHub cannot be reached, the row says so instead. | `gh auth login --web`, or check your connection. |
| git push over HTTPS | git has no GitHub sign-in, so pushes to `https://` remotes fail. Happens when `gh auth login` ran without a terminal. Fine if your remotes use SSH. Optional. | `gh auth setup-git` |
| GitHub token scopes | The token lacks `workflow` (pushes that touch workflow files) or `project` (the board). Optional. Not shown for fine-grained tokens. | `gh auth refresh -s workflow,project` |
| Claude Code | `claude` is missing. | `npm install -g @anthropic-ai/claude-code` |
| Claude sign-in | Claude Code is not signed in (plan mode), or too old to have `claude auth status`. | Run `claude`, then `/login`, or `claude update`. |
| API key | API key mode is set but there is no `DOBBY_API_KEY`, or the key fails a small real call. With no network the row stays green and says it was not checked. | Add the key to `~/.config/dobby/secrets.env`. See [Cap spend](cap-spend.md#run-on-an-api-key). |
| config | There is no config file yet. | `dobby init` |
| config warnings | A config key is unknown or has a bad value. The row names it and suggests the key you probably meant. | `dobby config path`, then edit that file. |
| graphify | Not installed. Optional: builders and reviews get code maps from it. | `uv tool install graphifyy`, or `pipx install graphifyy`. |
| disk | Under 15 GB free where Dobby keeps its data. Optional. | Free up space. |
| Dobby | Never fails. Shows the installed version. | `npm i -g dobby-ai@latest && dobby jobs install` |
| time zone | `timezone` in the config is not this machine's zone. Optional. | `dobby config set timezone <zone>` |
| data folder | The data folder is on NFS or SMB. SQLite needs a local disk. Optional. | Set `DOBBY_DIR` to a local folder, then `dobby jobs install`. |
| Discord | No bot token. Optional. | `dobby init` and choose Discord, or add `DISCORD_BOT_TOKEN` to the secrets file and run `dobby discord setup`. |
| Jev | No key. Optional: a cheaper way to pick the review model. | Add `JEV_API_KEY` to the secrets file. |
| sandbox runner | The program that sandboxes builders was not found next to Dobby. Optional: builders then get only the credential scrub. | `npm i -g dobby-ai` |
| sandbox | On Linux, bubblewrap or socat is missing, or AppArmor blocks bubblewrap. On native Windows there is no sandbox. Optional: builders then get only the credential scrub. | The row prints the install or `sysctl` command. See [Install on Linux or WSL2](install-linux.md#install-the-sandbox). |
| background jobs | A job is not loaded, its last run exited with an error, a job from an older install is still loaded, or the jobs run another copy of Dobby (a temporary `npx` copy is named in the row). | `dobby jobs install` |

## Pipeline checks

After the setup checks, `dobby doctor` prints one row per pipeline check. With no projects yet, the rows say "no projects yet".

| Row | Fails when | Fix |
|---|---|---|
| stuck tickets | A ticket has been `running` for over 2 hours. | `dobby show <id>`, then `dobby retry <id>` or `dobby cancel <id>`. |
| origin/base | A project's `origin/<base>` branch does not resolve in its clone. | `git fetch` in the repo, or fix `base` in its project file. |
| claude session | Claude Code is signed out or did not answer in 60 seconds. | Run `claude`, then `/login`. |
| tick lock | The tick lock is held by a process that no longer exists, or has had no heartbeat for 90 minutes. A live tick shows as ok with its age. | Nothing: the next tick, `dobby run` or `dobby retry` clears a stale lock and puts the cut-off ticket back in the queue. |
| old pauses | A pause is over 7 days old. | `dobby pause status`, then `dobby resume <target>`. |
| review scan | No review scan ran for 2 hours. It runs every 15 minutes inside the `listener` job, or the `tick` job when Discord is off. | `dobby jobs status`. |
| stuck | A running or waiting ticket has not moved for over 24 hours. | `dobby show <id>`. |
| reviews | Reviews have been skipped for over 2 hours because of the budget. | Wait for the window, or raise `reviewCap`. |
| cap | Ready tickets have been held by the budget cap for over 3 hours. | Wait for the reset, or raise `pacing.weekCap`. |

## Repo access, read by `dobby init`

For each repo you pick, setup reads what Dobby's pull requests need. It only reads, and changes nothing on GitHub.

| Row | Meaning | Fix |
|---|---|---|
| GitHub access | This account cannot push to the repo (read-only, or the wrong account is active). Setup leaves the repo out. An SSO block shows the page that authorizes the token. | `gh auth switch`, or ask for write access. |
| Review rules | The base branch needs an approving or code-owner review. GitHub does not let you approve your own pull request, so Dobby's pull requests will wait for a second reviewer. | Add a reviewer who is not you, or loosen the rule. |
| Merge method | The repo has turned off the merge method Dobby uses. Setup sets `github.mergeMethod` to one that is on, when you have not set it yourself. | Set `github.mergeMethod`. |
| Signed commits | Signed commits are required and `github.mergeMethod` is `rebase`. GitHub does not sign rebase merges. | Use `squash` or `merge`. |
| Merge queue | Merges go through GitHub's merge queue. Dobby waits up to 30 minutes for the pull request to show as merged. | Nothing to fix. |

Before each build, Dobby also checks the `gh` sign-in, the remote and push access, and blocks the ticket with the reason instead of building and failing at the push. Set `"shipPreflight": false` to turn this off.

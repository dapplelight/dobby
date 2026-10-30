---
title: "Security and the sandbox"
description: "What a builder can and cannot reach, how commands are checked, how strangers' pull requests are handled, and where the limits are."
sidebar: { group: Concepts, order: 5 }
---

Dobby lets agents run code they wrote themselves on your machine. A prompt injection in a ticket, an issue or a dependency could make a builder try something you did not ask for. The rules below are built so that such a builder cannot push, deploy or send your data out.

## What a builder can reach

A builder is a `claude -p` run started by Dobby. Every shell command it runs goes through Claude Code's OS sandbox: Seatbelt on macOS, bubblewrap and socat on Linux.

| | Builder |
|---|---|
| Write files | Its own worktree, a scratch folder, the temp folder. Nothing else. |
| Read files | Everything except the denied paths below. |
| Network | None. Localhost only on macOS, so tests can start local servers. |
| Credentials | None in its environment. |
| `git push`, `wrangler`, `rm -rf`, web fetch and web search | Denied. |

Paths a builder cannot read:

```
~/.config/dobby      ~/.config/gh     ~/.ssh        ~/.aws
~/.netrc             ~/.npmrc         ~/.git-credentials
~/.docker            ~/.wrangler      Dobby's data folder
```

The sandbox settings are passed on the command line, so a repo's own `.claude/settings.json` cannot loosen them. If the sandbox cannot start, the run stops. It does not fall back to running without one.

## No credentials in the builder's environment

Before a builder starts, Dobby removes from its environment:

- GitHub, npm, Cloudflare, AWS, Discord and Telegram tokens, and every other variable whose name contains `TOKEN`, `SECRET`, `PASSW`, `API_KEY`, `PRIVATE_KEY`, `CREDENTIAL` or `AUTH`.
- The SSH agent socket, so it cannot use your SSH keys.
- git's credential helpers and askpass.

`gh` and `wrangler` point at empty config folders, so they are not signed in. Claude Code keeps its own sign-in, but the sandbox hides it from the commands the builder runs.

Builders commit without signing, because a signing agent such as 1Password or gpg cannot be reached from inside the sandbox. GitHub signs the squash merge.

## Installs and tests

Dobby runs each project's install and test commands itself, inside the same sandbox, after the builder finishes. Installs may reach package registries only: npm, Yarn, PyPI, crates.io, the Go proxy and GitHub. Tests get no network. To allow another registry host, add it to `installDomains` in your config.

## Pushing, merging and deploying

Only Dobby's own process pushes, opens pull requests, merges and deploys. Builders cannot, because they have no credentials and no network.

- Dobby merges only its own pull requests and yours. It never merges a pull request from anyone else.
- A merge needs a passing review of the exact commit being merged. If the branch moved after the review, the merge does not happen.
- What waits for your tap is set by your safety preset. See [What waits for you](what-waits.md).
- `dobby init` turns merges off on a fresh install until you run `dobby resume merges`. An install that skipped `init` has no such pause.
- After a merge, the deploy waits for your tap, also when `safety.deploy` is unset. Only an explicit `"auto"` makes a project with a `deploy:` command deploy at once.

## The command guard

A hook checks every shell command an agent runs before it runs. It splits the command line at `&&`, `;`, pipes, `$( )`, `sh -c`, `xargs` and `find -exec`, and checks each part:

1. Each part must be on the role's allowlist. A role with no list gets no shell at all.
2. A set of guard rules denies dangerous commands even when the role's list would allow them.

A refused command is not run, and the agent sees the reason.

The sandbox is the real boundary. The guard is a second layer that catches mistakes early and makes refusals readable.

## Strangers' pull requests

On a public repo, anyone can open a pull request, and its text and code may be written to steer a model.

- Automatic reviews are off by default: `review.auto` is `off`.
- On a public repo, `@dobby` commands that run a model are refused on a pull request whose author is not you or a collaborator.
- Only users with write access can give commands at all. Other comments are ignored and cost nothing.
- Comment text is treated as data. It can pick one command from a fixed list or become the question of a read-only run. A read-only run can only read files and run `git diff`, `git log` and `git show`, gets no MCP servers, and cannot read secret files.

## Secrets and private words

- Secrets live in `~/.config/dobby/secrets.env`. No command prints them, and `dobby config show` redacts them.
- Text Dobby posts to a public repo is checked against your private words: your GitHub accounts, client names, home folder paths, email addresses, and any word you add to `~/.config/dobby/private-terms.txt`. A push to a public repo whose diff or commit messages contain one of them is refused.
- Comment bodies go to `gh` through a temp file, never on a command line.

## Limits

- Native Windows has no sandbox. Dobby supports macOS and Linux, including WSL2.
- On Linux without bubblewrap and socat, builders run with credentials removed but without the OS sandbox. On Ubuntu 24.04 and later, AppArmor can block bubblewrap even when it is installed, and Dobby falls back the same way. `dobby doctor` shows the sandbox row and the fix. See [Install on Linux or WSL2](install-linux.md).
- On macOS, a builder's commands can connect to any service listening on localhost, such as a local database. Do not keep production data in a local service on the machine that runs Dobby.
- The sandbox limits what a builder can reach. It does not check whether the code is correct. That is the job of the tests, the Tester and the review.

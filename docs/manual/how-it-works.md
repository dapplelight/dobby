---
title: "The loop: ticket to merge"
description: "How a ticket becomes a merged pull request: tickets and their states, goals, and each step a build goes through."
sidebar: { group: Concepts, order: 1 }
---

Every change goes through the same steps. Each step is a separate Claude Code run that can only do its own job.

```text
ticket → build → tests → Tester → pull request → review → merge or wait for you → deploy
```

## Tickets

A ticket has a project, a title, a done-when line, a size and a priority. You write them, and the Engineering Manager and Product Manager propose them.

The Tester checks the finished work against the done-when line. That line decides whether a build counts as done.

| State | Meaning |
|---|---|
| `backlog` | Written, not queued. |
| `ready` | Queued, waiting for a free builder. |
| `running` | A builder is working on it. |
| `fixing` | Its pull request is open, with a fix round or merge pending. |
| `shipped` | Merged. |
| `failed` | Out of builds or fix rounds. The branch keeps the work. |
| `declined` | You declined or cancelled it. |
| `split` | Replaced by smaller tickets. |

Your own tickets start in `ready`. Tickets from agents start in `backlog`.

With several builders, the next one takes work from the project with the fewest builds running. One project cannot take every builder.

## Goals

A goal is a larger outcome that tickets belong to. Dobby reads goals from GitHub milestones or from a project file's Goals list.

## From ticket to merge

| Step | What happens | If it fails |
|---|---|---|
| Build | A builder writes the change on its own branch and worktree. | |
| Tests | Your install and test commands run in the sandbox. | One fix attempt. |
| Tester | Checks the work against the done-when line. | Sent back once. |
| Pull request | Dobby pushes the branch and opens it. | |
| Review | The Code Reviewer reads it. | Up to 2 fix rounds, then it waits for you. |
| Merge | Dobby merges the exact commit that passed. | Held if your safety preset says so. |
| Deploy | Sends you a Deploy tap and waits, unless `safety.deploy` is `"auto"`. | |

A ticket gets at most 3 builds. A branch that no longer merges cleanly goes to you instead of a builder.

## Why each step is separate

The builder has no network and no credentials. Only Dobby's own process can push, open pull requests and merge.

So a builder misled by a ticket or a dependency still cannot push or deploy. See [Security and the sandbox](security.md).

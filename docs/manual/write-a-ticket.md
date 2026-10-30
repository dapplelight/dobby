---
title: "Write a good ticket"
description: "Write a ticket Dobby can finish: a done-when line the Tester can check, the right size and a priority."
sidebar: { group: Guides, order: 1 }
---

```bash title="Terminal"
dobby add shopfront "Show stock on the product page" "the page shows In stock or Sold out" S 70
```

| Part | Example |
|---|---|
| Project | `shopfront` |
| Title | `"Show stock on the product page"` |
| Done when | `"the page shows In stock or Sold out"` |
| Size | `S` |
| Priority | `70` |

The ticket goes straight into the queue.

## Write a done-when line you could check yourself

The Tester passes a build only when this line is true. Name one thing you can see or run.

| Weak | Better |
|---|---|
| `improve the footer` | `the footer has 16px padding on phones` |
| `fix login` | `a wrong password shows "Wrong email or password"` |
| `add tests for cart` | `npm test covers an empty cart and passes` |

:::tip
Two outcomes are two tickets.
:::

## Pick a size

| Size | Use it for |
|---|---|
| `S` | Under an hour, one or two files. |
| `M` | A few hours, several files. The default. |
| `L` | A day or more. Never built as it is: split it first. |

## Set a priority

Higher numbers run sooner. The default is 50.

## Skip the GitHub issue

Each ticket is also filed as an issue on the repo. To skip it for one ticket:

```bash title="Terminal"
dobby add shopfront "Fix the footer spacing" --no-issue
```

To skip it for every ticket:

```bash title="Terminal"
dobby config set board.issues false
```

## Queue a backlog ticket

Tickets from Dobby's own roles start in the backlog.

```bash title="Terminal"
dobby queue 41
dobby unqueue 41
```

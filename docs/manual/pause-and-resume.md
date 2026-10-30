---
title: "Pause and resume"
description: "Stop Dobby taking new work, pause one part, one project or one ticket, for a set time or until you resume."
sidebar: { group: Guides, order: 3 }
---

```bash title="Terminal"
dobby pause
dobby resume
```

Builders stop taking new tickets. Running builds finish their current step.

## Pause one part

```bash title="Terminal"
dobby pause merges
dobby pause project shopfront
dobby pause ticket 41
dobby resume merges
```

| Part | Stops |
|---|---|
| `builders` | New builds. |
| `reviews` | Reviews. |
| `merges` | Merges. |
| `deploys` | Deploys. |
| `planning` | The Engineering Manager and Product Manager. |
| `scout` | The Talent Scout. |
| `notify` | Messages to you. |

## Stop everything now

```bash title="Terminal"
dobby pause all
```

:::caution
This also stops running builds.
:::

## Pause for a set time

```bash title="Terminal"
dobby pause reviews for 2h
```

The pause ends by itself. Use `30m`, `2h` or `1d`.

## See what is paused

```bash title="Terminal"
dobby pause status
```

```text title="Output"
Nothing is paused.
```

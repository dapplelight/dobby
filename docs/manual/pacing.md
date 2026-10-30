---
title: "Pacing against your plan"
description: "How Dobby spreads its work across your Claude plan's weekly and 5-hour limits, so part of the week always stays yours."
sidebar: { group: Concepts, order: 4 }
---

On a Pro or Max plan, Dobby shares your weekly and 5-hour limits. It paces itself so you can still use Claude.

Dobby reads your usage every 10 minutes and checks it before each run.

```text title="dobby limits"
Running · 5-hour 34% (cap 60%) · week 49% of 95%
5-hour ▕███░░░░░░░▏ 34%
week   ▕█████░░░░░▏ 49% (cap 95%)
```

## The weekly cap

Dobby stops starting work at `pacing.weekCap`, 95% by default. The rest of the week stays yours.

The cap covers every role, reviews included. The dashboard calls it Stop at. To change it, see [Cap spend](cap-spend.md).

## The 5-hour window

Dobby spreads what is left of the week across the 5-hour windows before the reset. One busy window cannot use up the week.

When work is held, `dobby limits` says why and when it resumes:

```text title="dobby limits"
Paused: 5-hour window at 60% (pace cap), resumes 14:20 IST
```

To lift the cap for the rest of this window, run the command it prints:

```bash title="Terminal"
dobby do keepgoing 90
```

With Discord set up, the pause message has buttons that do the same.

## When usage cannot be read

Dobby starts at most 3 builds a day and tells you once. Change the number with `pacing.fallbackBuildsPerDay`.

## On an API key

There is no plan to pace against, so Dobby caps dollars instead. See [Plan or API key](billing.md).

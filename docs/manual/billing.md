---
title: "Plan or API key"
description: "The two ways Dobby pays for Claude, how each is capped, and how to choose."
sidebar: { group: Concepts, order: 6 }
---

Dobby runs Claude Code for every role. It pays with your Claude plan or with an Anthropic API key.

| | Your plan | An API key |
|---|---|---|
| Costs | Nothing beyond the plan | Per token |
| Capped by | A share of your week, `pacing.weekCap` | Dollars, `billing.dailyUsd` and `billing.weeklyUsd` |
| Default cap | 95% of the week | $20 a day |
| Cost comment on a PR | Share of your week | Dollars |
| Key variable | | `DOBBY_API_KEY` |

## Which one

- You pay for Pro or Max: use the plan. Dobby uses the part you don't.
- You have no plan, or Dobby runs on a server: use an API key with a daily cap.

To set either one up, see [Cap spend](cap-spend.md).

:::note
Dobby reads `DOBBY_API_KEY`, never `ANTHROPIC_API_KEY`. That keeps your own Claude Code sessions on your plan.
:::

## How estimates work on a plan

A pull request's share of the week is an estimate, converted at $26 per 1% of the week. The numbers in `dobby limits` come straight from Anthropic.

Dobby runs on Claude Code only today. Amazon Bedrock and Google Vertex AI are not supported.

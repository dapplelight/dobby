---
title: "What waits for you"
description: "Which merges, deploys and questions wait for your tap, how the three safety presets decide, and what waits whatever you set."
sidebar: { group: Concepts, order: 3 }
---

Dobby does most work without asking. A few things wait for you, because a wrong guess there costs more than a short wait.

## Needs you

Everything that waits lands in one list: Needs you on the dashboard, and `#needs-you` in Discord.

- A pull request your preset holds for you
- A Deploy tap, or a failed deploy
- A builder's question
- A stuck ticket
- A ticket an agent filed

## Safety presets

Dobby sorts each change into categories such as payments, auth and data migrations. The preset decides what happens in each.

| Preset | What waits for you | Strict review | Merges after a normal review |
|---|---|---|---|
| Balanced, the default | Data migrations, client sites, releases | Auth, payments, secrets | Everything else |
| Strict | Every merge | | |
| Autonomous | Nothing | Risky changes | Everything else |

```bash title="Terminal"
dobby config set safety.preset strict
```

Strict suits your first weeks with Dobby. Autonomous suits repos where a bad merge is cheap to revert.

The full table is in [Safety categories](safety-categories.md).

## The floor for every merge

`safety.everyMerge` sets the minimum for changes in no category. Strict sets it to your merge, and the others to a normal review.

## Deploys

After a merge, a project with a `deploy:` command sends you a Deploy tap and waits, also when `safety.deploy` is unset. Only an explicit `"auto"` deploys at once.

## What waits whatever you set

:::caution
These wait under every preset:

- Running a migration that changes existing data
- A ticket an agent filed from outside input, such as an email
- The first merge on a fresh install
:::

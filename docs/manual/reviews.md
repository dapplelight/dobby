---
title: "Review commands in a PR"
description: "Get a pull request reviewed by Dobby, steer the review from a PR comment, and change how strict and how automatic reviews are."
sidebar: { group: Guides, order: 8 }
---

Dobby reviews every pull request it opens. Other pull requests are reviewed when you ask.

## Ask for a review

Comment on the pull request:

```text title="PR comment"
@dobby review
```

Dobby replies within 15 minutes. [PR comment commands](pr-commands.md) lists every command.

To review now from the terminal:

```bash title="Terminal"
dobby review acme/shop 412
```

:::caution
Comments are read by the `listener` job, which is installed with Discord. Without Discord, keep `dobby start` running.
:::

## Mark a finding as intentional

Reply in the reviewer's thread. Later reviews of the repo leave it out.

```text title="PR comment"
@dobby learn
```

## Review every pull request

```bash title="Terminal"
dobby config set review.auto drafts
```

| `review.auto` | Reviews |
|---|---|
| `off` | Dobby's own pull requests and the ones you ask for. The default. |
| `drafts` | Every open pull request except drafts. |
| `on` | Every open pull request. |

## Make reviews stricter or looser

```bash title="Terminal"
dobby config set review.strictness chill
```

| `review.strictness` | Reports |
|---|---|
| `chill` | High and medium findings. |
| `default` | The default set. |
| `assertive` | Low findings too, such as missing tests. |

Every review setting is in the [configuration reference](config.md#review). To gate merges on another reviewer, see [Add an external reviewer](external-reviewer.md).

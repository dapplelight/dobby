---
title: "Add an external reviewer"
description: "Gate Dobby's merges on CodeRabbit, Greptile or GitHub Copilot code review, alone or together with Dobby's own reviewer."
sidebar: { group: Guides, order: 9 }
---

1. Set the reviewer in your config.

   ```json title="config.json"
   { "review": { "provider": "external", "external": "coderabbit" } }
   ```

2. After the first external review, copy the check name from the pull request.

   ```bash title="Terminal"
   dobby config set review.externalCheck "<check name>"
   ```

| `review.provider` | Who gates merges |
|---|---|
| `local` | Dobby's reviewer. The default. |
| `external` | Only the external reviewer. |
| `both` | Both, and either one can block. |

A pull request merges once the external reviewer reports on its latest commit with nothing blocking.

:::note
If no report comes within 30 minutes, you get a card in Needs you. Sensitive changes always get Dobby's strict review as well.
:::

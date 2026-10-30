---
title: "Try other model providers (preview)"
description: "An early, off-by-default preview that routes some roles to other agent CLIs or local model servers."
sidebar: { group: Guides, order: 15 }
---

:::caution
Dobby runs on Claude Code today. This is an early preview, off by default.
:::

1. See what Dobby finds and where each role would run. Both commands only read.

   ```bash title="Terminal"
   dobby providers detect
   dobby providers explain
   ```

2. Turn routing on.

   ```bash title="Terminal"
   dobby config set providers.enabled true
   ```

| Role | Can run on |
|---|---|
| Builders | `claude` or `codex` only, sandboxed. |
| Reviews and testing | Claude only. |
| Roles that see your private data | A local server such as Ollama or LM Studio, unless `policy.allowUnsafe` allows more. |
| Other roles | `codex`, `gemini` or a local server. |

Config stores the names of key variables, never their values. Every key is in the [configuration reference](config.md#providers).

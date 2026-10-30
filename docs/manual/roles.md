---
title: "Roles"
description: "The six main roles, the supporting roles that run when needed, and why each one is a separate run with its own rules."
sidebar: { group: Concepts, order: 2 }
---

Dobby has six main roles, plus supporting roles that run when needed. Each is a separate Claude Code run with its own rules, model and tools.

A role cannot do another role's job. The Tester cannot change code, and the builder cannot merge.

```bash title="Terminal"
dobby role show builder
```

The Team page in the dashboard shows the same rules. Role files use the short names in the table.

## The six main roles

| Role | Short name | Does |
|---|---|---|
| Engineering Manager | `lead` | Queues up to 3 backlog tickets per run and writes up to 3 new ones. |
| Builder | `builder` | Writes one ticket's change on its own branch, in the sandbox. |
| Tester | `checker` | Checks the work against the done-when line. Reads files only. |
| Code Reviewer | `reviewer` | Reviews every pull request Dobby opens. |
| Product Manager | `product-manager` | Ranks problems against your goals and writes specs for large tickets. |
| Chief of Staff | `chief-of-staff` | Sends a brief every morning and evening. |

### Engineering Manager

Plans the work. For a new project, it lets you choose which first tickets to queue.

### Builder

Has no network and no credentials. For some tickets it works as a web, mobile or backend engineer.

### Tester

Tries to find why a change should not pass, before the review. On UI tickets it can take Playwright screenshots.

### Code Reviewer

Posts findings on GitHub. It reviews your pull requests too when you ask. See [Review commands in a PR](reviews.md).

### Product Manager

Turns problems into idea cards. You turn an idea into a ticket or drop it.

### Chief of Staff

The brief says what needs you, what shipped and what is building.

## Supporting roles

| Role | Does | Rules file |
|---|---|---|
| Designer | Writes the screen spec for a UI ticket. | `designer` |
| Onboarder | Reads a new project and writes its rules, tickets and ideas. | `onboarder` |
| Front Desk | Answers your chat messages and proposes actions. | `front-desk` |
| Program Manager | Checks a finished program of tickets against its plan. | `program-manager` |
| Product Manager (one area) | Digs into one product area. | `area-pm` |
| Brainstorm | Talks an idea through with you. It never builds. | `brainstorm` |
| Company | Turns your notes into work rules for every agent. | `company` |
| Engineer (web, mobile, backend) | The builder's specialties. | `engineer-web`, `engineer-mobile`, `engineer-backend` |

### Talent Scout

Once a day it picks one role and looks for skills and rules that would improve it. Any change it makes arrives as a pull request.

Turn it off with `scout.enabled` in the [configuration](config.md#scout).

---
title: Kantel
description: Kantel, by Lleverage, runs AI agents for people and for apps, on Cloudflare or on your own machines.
---

Kantel, by Lleverage, runs AI agents. People use them through the console. Apps use them through the API: your app creates a session, sends it messages and follows what the agent does, while Kantel runs the model loop, the sandbox, the tools, the approvals and the audit trail.

Kantel was called Harbour before it was renamed. A few names keep that: API keys start `hbr_` and headers are `harbour-*`. Packages are `@kantel/*` and settings `KANTEL_*`; a setting named `HARBOUR_*` still works when its `KANTEL_*` one isn't set.

## What Kantel gives an agent

- **Sessions** with a transcript you can stream, steer and fork. See [Sessions](/console/sessions/).
- **A workspace and a sandbox** for files and commands. See [Workspace and files](/console/workspace-and-files/).
- **Browsers** a person allows, which you can watch live and replay. See [Browsers](/console/browsers/).
- **Connections** to outside services by OAuth or key, with the secrets kept in the vault. See [Connectors](/console/connectors/).
- **Skills, memory and prompt rules**, set per organisation, project or person. See [Skills](/console/skills/), [Memory](/console/memory/) and [Prompt rules](/console/prompt-rules/).
- **Schedules** for recurring work. See [Schedules](/console/schedules/).
- **An audit log** of everything that happened, by whom. See [Audit](/console/audit/).

Kantel adds no system prompt of its own. What the model is told comes from the prompt rules and agent profiles you write.

## Where to start

| You want to | Start with |
| --- | --- |
| Try Kantel on your machine | [Install Kantel locally](/console/getting-started/install/) |
| Find your way round the console | [A tour of the console](/console/getting-started/tour/) |
| Build an app on Kantel | [Concepts](/api/concepts/), then the [quick start](/api/quick-start/) |
| Run Kantel for your team | [Deployment overview](/deploy/overview/) |

## Status

Kantel is young and moving quickly. These pages describe what the code does today; where a feature has limits, its page says so.

<!-- Sources (d031001): README.md:1-3, packages/runtime/src/runtime.ts:598-612 -->

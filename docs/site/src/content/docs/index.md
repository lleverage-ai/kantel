---
title: Partan
description: Partan, by Lleverage, runs AI agents for people and for apps, on Cloudflare or on your own machines.
---

Partan, by Lleverage, runs AI agents. People use them through the console. Apps use them through the API: your app creates a session, sends it messages and follows what the agent does, while Partan runs the model loop, the sandbox, the tools, the approvals and the audit trail.

Partan was called Harbour until recently. The code still uses that name: packages are `@harbour/*`, API keys start `hbr_`, and settings are `HARBOUR_*`.

## What Partan gives an agent

- **Sessions** with a transcript you can stream, steer and fork. See [Sessions](/console/sessions/).
- **A workspace and a sandbox** for files and commands. See [Workspace and files](/console/workspace-and-files/).
- **Browsers** a person allows, which you can watch live and replay. See [Browsers](/console/browsers/).
- **Connections** to outside services by OAuth or key, with the secrets kept in the vault. See [Connectors](/console/connectors/).
- **Skills, memory and prompt rules**, set per organisation, project or person. See [Skills](/console/skills/), [Memory](/console/memory/) and [Prompt rules](/console/prompt-rules/).
- **Schedules** for recurring work. See [Schedules](/console/schedules/).
- **An audit log** of everything that happened, by whom. See [Audit](/console/audit/).

Partan adds no system prompt of its own. What the model is told comes from the prompt rules and agent profiles you write.

## Where to start

| You want to | Start with |
| --- | --- |
| Try Partan on your machine | [Install Partan locally](/console/getting-started/install/) |
| Find your way round the console | [A tour of the console](/console/getting-started/tour/) |
| Build an app on Partan | [Concepts](/api/concepts/), then the [quick start](/api/quick-start/) |
| Run Partan for your team | [Deployment overview](/deploy/overview/) |
| Know what isn't there yet | [Gaps](/gaps/) |

## Status

Partan is young and moving quickly. These pages describe what the code does today and mark what is planned or in review. Where something is missing, it is on the [gaps page](/gaps/) rather than described as if it worked.

<!-- Sources (d031001): README.md:1-3, packages/runtime/src/runtime.ts:598-612, docs/design/public-api.md:1-40, docs/connections.md:1-10 -->

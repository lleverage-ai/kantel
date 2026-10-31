---
title: Concepts
description: The parts of Kantel an app works with, from organisations and projects to sessions, runs, transcripts and host tools.
sidebar:
  order: 1
---

Kantel runs agents for your app. Your app creates a session, sends it messages and follows what the agent does. Kantel runs the model loop, the sandbox, the tools and the audit trail. Your app keeps its own users, its own UI and whatever actions only it can take.

Package and code names still use the old name, Kantel: `@kantel/api`, `hbr_` keys, `harbour-*` headers and `KANTEL_*` variables.

## Tenancy

| Thing | What it is |
| --- | --- |
| Organisation | The top level. Members, keys, skills, memory, rules and audit belong to one. |
| Project | A space inside an organisation. Most sessions run in a project and get its skills, memory, files and rules as well as the organisation's. |
| Role | `viewer`, `operator` or `admin`, held on a project or across the organisation. Viewers read, operators start and steer sessions, admins manage. |
| Actor | Who made a call: a `human`, a `service` (your app, through its API key), an `agent` (a session's agent) or `system`. Every audit event names one. |

An API key belongs to your app's service identity. A project key holds one role on the projects it names and nothing across the organisation; an organisation key holds one role, at most `operator`, across its organisation and every project in it. See [Authentication](/api/authentication/#organisation-keys).

## Agents and sessions

| Thing | What it is |
| --- | --- |
| Agent profile | What an agent runs with: its model route, prompt layers, tools, sandbox tiers, skills, memory spaces and the host that serves its host tools. A session names one by `agentId`. |
| Session | One conversation with one agent profile, in a project or across the organisation. It works for one person (`userId`) and carries your app's `labels`. |
| Workspace | The session's files. A session gets its own unless you name an existing one (`workspaceId`), so several sessions can share files. |
| Run | What one message sets off: model calls and tool calls until the agent gives its final answer, fails or is aborted. |
| Submission | The receipt for a message you sent. Its ID names the run the message started or joined; `GET /v1/sessions/{id}/result` waits for that run. |
| Transcript | The session's items: your messages, the agent's answers, tool calls, cards and notices. The [stream](/api/streaming/) sends them as they change. |
| Child session | A session started by another (`parentSessionId`). Aborting the parent aborts it. |

A session is `idle`, `running`, `waiting` (on a person), `done`, `failed` or `cancelled`. A message to an idle session starts a run. A closed session takes no more messages.

## What the model sees

Kantel adds no system prompt of its own. A session's system prompt is its prompt layers joined by blank lines: the platform's, the organisation's and the project's prompt rules, the agent profile's own `promptLayers`, then the rules of the person the session works for. With no layers and no rules, there is no system prompt. See [Packaging an agent](/api/packaging-an-agent/#what-the-model-sees).

## Messages

A message reaches the agent in one of three ways (`via`):

- `prompt` starts a run, queued behind one in progress.
- `steer` reaches the run in progress at its next model call, without stopping it.
- `followUp` runs once the current run ends.

A steer or follow-up sent when nothing is running starts a run, as a prompt does, so a message sent just as a run ends is never lost.

## Tools

The agent's tools come from three places:

- **Built in**: `read`, `write`, `edit`, `ls`, `bash` and the rest, run in the session's sandbox; the browser tools; the connection tools; memory and skills tools.
- **Host tools**: tools your app serves. Kantel POSTs each call to your callback URL, signed, and your code runs it. See [Host tools](/api/host-tools/).
- **Connections**: outside services connected by OAuth or key, which agents call through Kantel. See [Connectors](/console/connectors/).

## Approvals

Some things an agent can't do without a person: opening a browser on a site, or getting a credential from the vault. The agent asks, the run waits, and a person decides. See [Approvals](/api/approvals/).

## Two targets

Kantel runs on Cloudflare (Workers, Durable Objects, D1 and R2) or self-hosted (a Node gateway on Postgres and S3-compatible storage). The public API is the same on both, but not every route is served on both yet. See [Deployment overview](/deploy/overview/).

<!-- Sources (d031001): packages/contracts/src/identity.ts:23-56,75-113, packages/contracts/src/session.ts:53-121, packages/api/generated/sdk.ts:64-82,427-457,503-521,912-922,1430-1441,1633, packages/runtime/src/runtime.ts:598-612, packages/runtime/HTTP.md:40-46, docs/design/public-api.md:1-61, docs/connections.md:90-100 -->

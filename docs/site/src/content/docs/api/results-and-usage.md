---
title: Results, usage and cost
description: How a run ends, what its result holds, and where token usage and cost come from.
sidebar:
  order: 6
---

## A run's result

Every message you send returns a submission, and its ID names the run the message started or joined. `GET /v1/sessions/{sessionId}/result?submission=<id>` tells you how that run ended:

| `status` | Means | Fields |
| --- | --- | --- |
| `answered` | The run reached its final answer | `answer`, the final answer's text; `usage` |
| `failed` | A model or tool error ended it | `error` says which |
| `aborted` | Someone aborted the session's run | |
| `pending` (HTTP `202`) | The run is still going | |

Files a run changed stay changed whatever the status. The call waits up to `timeoutMs` (default 25 seconds, at most 120) before answering `pending`, so a loop of calls waits for as long as the run takes without holding a stream open. See the [quick start](/api/quick-start/#2-wait-for-the-run-to-end).

A `steer` belongs to the run that acted on it: the run in progress when it reached that run's next model call, or the run it started straight after, when it arrived as the previous run gave its final answer.

The result holds only the final answer's text. For the tool calls and the agent's earlier messages, read the transcript from the [stream](/api/streaming/) or [history](/api/streaming/#history).

## Usage

`Usage` counts tokens and cost:

| Field | What |
| --- | --- |
| `inputTokens` | Input tokens not read from or written to the provider's cache |
| `outputTokens` | Output tokens |
| `cacheReadTokens` | Input served from the provider's prompt cache |
| `cacheWriteTokens` | Input written to the provider's prompt cache |
| `costUsd` | Cost in US dollars, as the model connector reports or computes it |

It appears in three places:

- **A snapshot's `usage`** is the session's running total over every model response so far.
- **A `usage` delta op** sets that total as it changes.
- **A run result's `usage`** is the usage of the model response that gave the final answer, not the whole run. To total a run, take the difference in the session's running total before and after it.

`costUsd` is zero when the connector reports no cost and computes none. CLIProxyAPI, the connector both deployments set up today, serves subscriptions and records tokens only, so its cost is zero.

## Usage records

The model gateway records every model call: in `usage_calls` in D1 on Cloudflare, or in Postgres self-hosted, optionally copied to ClickHouse. Each is also a `model.call` event in the audit log. Nothing reads the usage rows back yet: there is no usage API or console page. See [Audit](/console/audit/#usage-analytics) and [Gaps](/gaps/).

<!-- Sources (d031001): packages/api/generated/sdk.ts:1066-1070,1430-1441, packages/api/generated/openapi.json (getRunResult), packages/protocol/src/index.ts:25-40, packages/runtime/src/index.ts:170-185, packages/runtime/src/project.ts:375-392, packages/runtime/HTTP.md:88-90, docs/model-connectors.md:27-33,87,178, docs/usage-analytics.md:1-10,100-122, apps/cloudflare/src/models.ts:127-157, apps/selfhosted/src/gateway/models.ts:127-142 -->

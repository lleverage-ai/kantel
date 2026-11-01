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

The model gateway records every model call, done, failed or aborted, as one row in `usage_calls`: in D1 on Cloudflare, or in Postgres self-hosted, optionally copied to ClickHouse (`KANTEL_CLICKHOUSE_URL`). Each call is also a `model.call` event in the audit log. `KANTEL_USAGE=off` stops writing rows. There is no usage API or console page yet, so read the rows with SQL, or read `model.call` events from the [audit log](/console/audit/).

A row is keyed by `(session_id, call_id)`, so a retried write adds nothing. A call the runtime retries is a new upstream call with its own row. The main columns:

| Column | What |
| --- | --- |
| `call_id` | The gateway's ID for the call |
| `started_at`, `recorded_at` | When the call started and when the row was written, in epoch milliseconds |
| `organisation_id`, `project_id`, `session_id`, `agent_id` | Whose call it was; `agent_id` is the agent profile |
| `route`, `model_id`, `provider` | The route the session asked for, the upstream model that served it, and who made that model |
| `connector_id`, `connector_preset`, `api` | The connector that served it, its preset and the wire API (for an image call, its image API) |
| `status`, `stop_reason`, `error` | `done`, `error` or `aborted`, and the upstream's error, redacted and cut to 500 characters |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | Token counts; `input_tokens` leaves out cached input |
| `reasoning_tokens` | Part of `output_tokens`, when the upstream reports it |
| `images` | Images an image call made; 0 for a chat call |
| `cost_usd`, and its parts `cost_input_usd`, `cost_output_usd`, `cost_cache_read_usd`, `cost_cache_write_usd` | Cost in US dollars; zero when `cost_source` is `none` |
| `cost_source`, `price_version` | `reported`, `computed` or `none`; for `computed`, the rates used, such as `rates:3/15/0.3/3.75` (per million tokens) or `image:0.04` (per image) |
| `duration_ms`, `first_token_ms` | The whole call, and the time to the first streamed event |

A failed or aborted call keeps whatever usage the upstream reported before it ended. For example, one session's totals:

```sql
SELECT count(*), sum(input_tokens), sum(output_tokens), sum(cache_read_tokens), sum(cache_write_tokens), sum(cost_usd)
FROM usage_calls WHERE session_id = $1;
```

On ClickHouse, `@kantel/usage` also keeps an hourly rollup, `usage_hourly`, by organisation, provider, connector and model.

<!-- Sources (ba80016): packages/api/generated/sdk.ts:1066-1070,1430-1441, packages/api/generated/openapi.json (getRunResult), packages/protocol/src/index.ts:25-40, packages/runtime/src/index.ts:170-185, packages/runtime/src/project.ts:375-392, packages/runtime/HTTP.md:88-90, packages/contracts/src/usage.ts, packages/usage/src/sql.ts, packages/usage/src/clickhouse.ts, packages/models/src/usage.ts, apps/cloudflare/src/models.ts:127-157, apps/selfhosted/src/gateway/models.ts:127-142 -->

# Usage analytics: one row per model call

Harbour records every model call's token usage as one immutable row, so usage can be broken down later by
organisation, project, session, agent, model, provider and connector over any time range. Nothing reads it yet; the
schema and storage are chosen so writes stay cheap now and dashboards and APIs are fast later. On by default; set
`HARBOUR_USAGE=off` to stop writing rows.

## Where usage is seen

The model gateway (`packages/models/src/gateway.ts`) is the one place Harbour sees a provider's response: every call of
every session on every target goes through it, and its `record()` already runs once per call that resolved a route,
for done, failed and aborted calls alike, with pi's `Usage` (input, output, cache read, cache write, reasoning, cost).
So capture goes there, not in the runtime:

- the runtime only sees the answer entries Pi Durable commits, so a call that failed before an entry was written, or
  that a crash replayed, would be missed or counted twice;
- the gateway knows what the runtime doesn't: the connector, its preset, the upstream model, where cost came from and
  the rates used.

Today the gateway writes the same facts as a `model.call` audit event. That stays (the audit trail is for people); the
usage row is the analytics copy, with typed columns instead of JSON and its own retention.

## The row

One row per call, keyed by `call_id` (the gateway's UUID for the call). The idempotency key is `(session_id, call_id)`:
every write is an insert that ignores a row already there, so a retried write or a resent batch adds nothing. A call
that Pi Durable retries is a new upstream call with a new `call_id` and its own row, as it should be: it was billed.

| Column | Type | Notes |
| --- | --- | --- |
| `call_id` | text | Gateway call UUID; with `session_id`, the idempotency key |
| `started_at`, `recorded_at` | ms epoch | When the call started; when the row was written |
| `organisation_id`, `project_id`, `session_id`, `agent_id` | text | From the session's model token (`ModelCallScope`); `agent_id` is the agent profile |
| `run_id` | text, nullable | Reserved: the gateway can't see the submission yet (see below) |
| `route`, `model_id` | text | The route the session asked for; the upstream model it was served by |
| `provider` | text | Who made the model (`anthropic`, `openai`, `google`…), from pi's catalogue, else the model ID's prefix |
| `connector_id`, `connector_preset`, `api` | text | Which connector served it, its kind (`cliproxyapi`, `litellm`, `openrouter`…) and the wire API |
| `status`, `stop_reason`, `error` | text | `done`, `error` or `aborted`; the upstream's error text, redacted, cut to 500 characters |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | integer | pi's split: `input` excludes cached input |
| `reasoning_tokens` | integer, nullable | A subset of `output`, when the upstream reports it |
| `cost_usd`, `cost_input_usd`, `cost_output_usd`, `cost_cache_read_usd`, `cost_cache_write_usd` | real | Zero when `cost_source` is `none` |
| `cost_source`, `price_version` | text | `reported`, `computed` or `none`; for `computed`, the per-million rates applied, such as `rates:3/15/0.3/3.75` |
| `duration_ms`, `first_token_ms` | integer | Whole call; time to the first streamed event (null if none came) |

Failed and aborted calls keep whatever usage the upstream reported before failing, which for Anthropic includes the
input it read. `price_version` makes cost reproducible: rates come from the connector's catalogue at call time and can
change underneath, so the row says which ones were used, and a dashboard can recompute from tokens if prices are
corrected.

`run_id` comes later: the runtime's `harbour` provider would send the Pi Durable submission ID on each request as a
header the gateway trusts only alongside the session token. Until then a run's calls are the session's calls between
the run's start and end.

## Write path

```
gateway record()  ──insert (ignore dup)──>  usage ledger (local SQL)  ──shipper, batches──>  UsageSink(s)
   per call, beside the audit append          the outbox, and on            ClickHouse, D1, ...
                                               self-hosted the record
```

- **Hot path.** `record()` inserts the row into the ledger in parallel with the `model.call` audit append, so it adds no
  latency the audit write doesn't already have. A failure is retried twice, then logged with the call ID; it never
  fails or delays the call beyond that. The ledger is local: Postgres on self-hosted, the stack object's own SQLite on
  Cloudflare (sub-millisecond, as the audit outbox is there).
- **Ledger.** One append-only table, `usage_calls`, with a `seq` the database assigns. It is portable SQL
  (`@harbour/sql`, Postgres and SQLite), so the same code runs everywhere. It is both the outbox and, where no other
  sink is configured, the record of truth.
- **Shipping.** A shipper per sink reads rows past that sink's cursor (`usage_cursors`), oldest first, in batches of up
  to 1,000. On Postgres it takes only rows recorded at least 10 s ago, so a row whose insert commits late is never
  skipped; the stack object is its ledger's one writer, so there it takes them at once. It marks the batch's last `seq`
  as pending, hands the batch to the sink, then advances the cursor. A failed batch is sent again, the same rows under
  the same batch ID; sinks drop rows they have (ClickHouse by `insert_deduplication_token`, SQL by its key). It runs
  every 15 s on self-hosted, and after each write on Cloudflare (`ctx.waitUntil`, retried with backoff, and again when
  the object starts), so analytics can lag or stop without touching a session.

```ts
interface UsageSink {
	/** Stores `records`, ignoring any whose (session_id, call_id) it already has. Rejects to have the batch resent. */
	write(records: readonly UsageRecord[], batchId: string): Promise<void>;
}
```

## Storage per deployment

**Self-hosted (Docker: Postgres, MinIO).** The Postgres ledger is the default record of truth: per-session totals and
small dashboards are indexed range scans. ClickHouse is optional: set `HARBOUR_CLICKHOUSE_URL` and the shipper fills it,
creating its tables on its first run; `deploy/compose/analytics.yaml` runs it beside the stack. ClickHouse earns its place once there are millions of calls or
dashboards over long ranges with many group-bys; below that, Postgres is fine and one less service.

**Cloudflare (harbour.myslop.app, weur).** The ledger lives in the stack object's SQLite, as the audit outbox does.
The options for the queryable store:

| Option | For | Against |
| --- | --- | --- |
| **D1** `usage_calls` + hourly rollup table, shipped from the object | Same SQL and code as self-hosted; exact; already bound (`harbour-weur`, weur hint); no new vendor; per-session and per-day queries are cheap | 10 GB per database (roughly 20–30M rows with indexes), single writer; long-range group-bys get slow, so dashboards read the rollup |
| **R2 Parquet/Iceberg** via Pipelines, queried with R2 SQL | Cheapest at scale; columnar; R2 SQL has had aggregations since Dec 2025 | Minutes of ingest lag; no per-row lookup or upsert, so idempotency is on the reader; still young; a third query path |
| **External ClickHouse** (ClickHouse Cloud, or the self-hosted one over the existing tunnel) | One analytics store for both deployments; the best for dashboards | A paid service or a host dependency for the Cloudflare stack; data leaves Cloudflare |
| Workers Analytics Engine | Free, built in | Samples under load and keeps three months: not a record of truth. Rejected |

**Recommendation:** D1 now, as the Cloudflare record of truth, shipped from the object's ledger by the same shipper
and SQL sink as self-hosted. It is the same code path as self-hosted, adds nothing to deploy, and at Harbour's volume
(thousands of calls a day) 10 GB is years away. Keep the `UsageSink` seam so the Cloudflare stack can also ship to an
external ClickHouse once a dashboard needs it; that is a config change, not a migration, because the ledger can be
replayed into any new sink from cursor 0.

## Rollups and queries

ClickHouse (abridged; `@harbour/usage/clickhouse` creates them):

```sql
CREATE TABLE usage_calls (
  call_id String, session_id String, organisation_id LowCardinality(String), project_id String, agent_id String,
  started_at DateTime64(3), provider LowCardinality(String), connector_id LowCardinality(String),
  connector_preset LowCardinality(String), model_id LowCardinality(String), status LowCardinality(String),
  input_tokens UInt64, output_tokens UInt64, cache_read_tokens UInt64, cache_write_tokens UInt64,
  reasoning_tokens Nullable(UInt64), cost_usd Float64, ...
) ENGINE = ReplacingMergeTree(recorded_at)
PARTITION BY toYYYYMM(started_at)
ORDER BY (organisation_id, started_at, session_id, call_id)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE TABLE usage_hourly (
  hour DateTime, organisation_id LowCardinality(String), provider LowCardinality(String),
  connector_id LowCardinality(String), model_id LowCardinality(String),
  calls UInt64, failed UInt64, input_tokens UInt64, output_tokens UInt64,
  cache_read_tokens UInt64, cache_write_tokens UInt64, cost_usd Float64
) ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (organisation_id, hour, provider, connector_id, model_id)
SETTINGS non_replicated_deduplication_window = 1000;

CREATE MATERIALIZED VIEW usage_hourly_mv TO usage_hourly AS
SELECT toStartOfHour(started_at) AS hour, organisation_id, provider, connector_id, model_id,
  count() AS calls, countIf(status != 'done') AS failed, sum(input_tokens) AS input_tokens, ...
FROM usage_calls GROUP BY hour, organisation_id, provider, connector_id, model_id;
```

A resent batch carries the same `insert_deduplication_token` (with `deduplicate_blocks_in_dependent_materialized_views`),
so ClickHouse drops the block from both tables; both need a deduplication window, or the rollup counts the resend.
`ReplacingMergeTree` on the base table covers anything else.

Typical reads:

```sql
-- Dashboard: tokens and cost per model and connector, last 30 days, by day (ClickHouse: the rollup)
SELECT toDate(hour) AS day, model_id, connector_id, sum(input_tokens + cache_read_tokens + cache_write_tokens) AS input,
  sum(output_tokens) AS output, sum(cost_usd) AS cost
FROM usage_hourly WHERE organisation_id = {org} AND hour >= now() - INTERVAL 30 DAY
GROUP BY day, model_id, connector_id ORDER BY day;

-- API: one session's totals (Postgres, D1 or ClickHouse; the ledger's (session_id, call_id) key serves it)
SELECT count(*), sum(input_tokens), sum(output_tokens), sum(cache_read_tokens), sum(cache_write_tokens), sum(cost_usd)
FROM usage_calls WHERE session_id = $1;

-- Cache hit rate per model, last 7 days (Postgres; D1 with strftime instead of date_trunc)
SELECT model_id, sum(cache_read_tokens)::float / nullif(sum(input_tokens + cache_read_tokens + cache_write_tokens), 0)
FROM usage_calls WHERE organisation_id = $1 AND started_at >= $2 GROUP BY model_id;
```

On Postgres and D1, dashboards group `usage_calls` directly through its `(organisation_id, started_at)` index; at a
few thousand calls a day that stays fast for months. When it doesn't, the shipper gains a `usage_hourly` table of the
same shape as ClickHouse's, upserting each batch's sums in the same batch as its cursor advance.

## Session totals

Separately from this, the runtime publishes each session's running total in the session protocol (`usage` op and
`SessionSnapshot.usage`, with `cacheReadTokens` and `cacheWriteTokens`), which hosts such as Sal read live. That total
is for display and is rebuilt from the transcript; `usage_calls` is the record of truth.

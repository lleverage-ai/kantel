/**
 * A ClickHouse `UsageSink` over its HTTP interface, and the tables it fills (docs/usage-analytics.md, "Rollups and
 * queries"). Each batch is one `INSERT … FORMAT JSONEachRow` with the batch's ID as `insert_deduplication_token`, so a
 * batch the shipper sends again is dropped, from `usage_calls` and from the hourly rollup its materialised view fills.
 */
import type { UsageRecord, UsageSink } from "@kantel/contracts";

export interface ClickHouseUsageSinkOptions {
	/** ClickHouse's HTTP endpoint, such as `http://clickhouse:8123`. */
	readonly url: string;
	readonly database?: string;
	readonly user?: string;
	readonly password?: string;
	readonly fetch?: typeof fetch;
	/** How long one insert may take. Default 30 s. */
	readonly timeoutMs?: number;
}

/** ClickHouse's `DateTime64(3, 'UTC')` text for a millisecond time. */
function dateTime(ms: number): string {
	return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/** A record as one `usage_calls` row. */
export function clickHouseRow(record: UsageRecord, recordedAt: number): Record<string, unknown> {
	return {
		call_id: record.callId,
		session_id: record.sessionId,
		started_at: dateTime(record.startedAt),
		recorded_at: dateTime(recordedAt),
		organisation_id: record.organisationId,
		// An organisation session's call has no project: '' in the column.
		project_id: record.projectId ?? "",
		agent_id: record.agentId,
		run_id: record.runId ?? null,
		route: record.route,
		model_id: record.modelId,
		provider: record.provider,
		connector_id: record.connectorId,
		connector_preset: record.connectorPreset,
		api: record.api,
		status: record.status,
		stop_reason: record.stopReason ?? null,
		error: record.error ?? null,
		input_tokens: record.inputTokens,
		output_tokens: record.outputTokens,
		cache_read_tokens: record.cacheReadTokens,
		cache_write_tokens: record.cacheWriteTokens,
		reasoning_tokens: record.reasoningTokens ?? null,
		images: record.images,
		cost_usd: record.cost.total,
		cost_input_usd: record.cost.input,
		cost_output_usd: record.cost.output,
		cost_cache_read_usd: record.cost.cacheRead,
		cost_cache_write_usd: record.cost.cacheWrite,
		cost_source: record.costSource,
		price_version: record.priceVersion,
		duration_ms: record.durationMs,
		first_token_ms: record.firstTokenMs ?? null,
	};
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function clickHouseUsageSink(options: ClickHouseUsageSinkOptions): UsageSink {
	const database = options.database ?? "harbour";
	if (!IDENTIFIER.test(database)) throw new Error("The ClickHouse database must be a plain identifier");
	const upstream = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? 30_000;
	const base = options.url.replace(/\/+$/, "");
	return {
		async write(records, batchId) {
			if (records.length === 0) return;
			const recordedAt = Date.now();
			const url = new URL(`${base}/`);
			url.searchParams.set("query", `INSERT INTO ${database}.usage_calls FORMAT JSONEachRow`);
			url.searchParams.set("insert_deduplication_token", batchId);
			url.searchParams.set("deduplicate_blocks_in_dependent_materialized_views", "1");
			url.searchParams.set("date_time_input_format", "best_effort");
			const headers: Record<string, string> = { "content-type": "application/x-ndjson" };
			if (options.user !== undefined) headers["x-clickhouse-user"] = options.user;
			if (options.password !== undefined) headers["x-clickhouse-key"] = options.password;
			const response = await upstream(url, {
				method: "POST",
				headers,
				body: `${records.map((record) => JSON.stringify(clickHouseRow(record, recordedAt))).join("\n")}\n`,
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!response.ok) {
				const text = (await response.text()).slice(0, 300);
				throw new Error(`ClickHouse refused the usage batch (HTTP ${response.status}): ${text}`);
			}
			await response.body?.cancel();
		},
	};
}

/** What `usage_hourly_mv` selects: each hour's sums per organisation, provider, connector and model. */
function hourlyQuery(database: string): string {
	return `SELECT
	toStartOfHour(started_at) AS hour,
	organisation_id,
	provider,
	connector_id,
	model_id,
	count() AS calls,
	countIf(status != 'done') AS failed,
	sum(input_tokens) AS input_tokens,
	sum(output_tokens) AS output_tokens,
	sum(cache_read_tokens) AS cache_read_tokens,
	sum(cache_write_tokens) AS cache_write_tokens,
	sum(ifNull(reasoning_tokens, 0)) AS reasoning_tokens,
	sum(images) AS images,
	sum(cost_usd) AS cost_usd
FROM ${database}.usage_calls
GROUP BY hour, organisation_id, provider, connector_id, model_id`;
}

/**
 * The tables, for a database named `database`: `usage_calls` (`ReplacingMergeTree`, by month) and `usage_hourly`
 * (`SummingMergeTree`), which `usage_hourly_mv` fills. The self-hosted gateway runs them at start, before it ships
 * (`migrateClickHouseUsage`). Every statement is idempotent, and tables an earlier Kantel made are brought up to
 * date: the columns added since are added (`images`), and the view is given the current query (`MODIFY QUERY`,
 * which swaps it atomically, so no insert is missed or counted twice).
 */
export function clickHouseUsageSchema(database = "harbour"): readonly string[] {
	if (!IDENTIFIER.test(database)) throw new Error("The ClickHouse database must be a plain identifier");
	return [
		`CREATE DATABASE IF NOT EXISTS ${database}`,
		`CREATE TABLE IF NOT EXISTS ${database}.usage_calls (
	call_id String,
	session_id String,
	started_at DateTime64(3, 'UTC'),
	recorded_at DateTime64(3, 'UTC'),
	organisation_id LowCardinality(String),
	project_id String,
	agent_id String,
	run_id Nullable(String),
	route LowCardinality(String),
	model_id LowCardinality(String),
	provider LowCardinality(String),
	connector_id LowCardinality(String),
	connector_preset LowCardinality(String),
	api LowCardinality(String),
	status LowCardinality(String),
	stop_reason LowCardinality(Nullable(String)),
	error Nullable(String),
	input_tokens UInt64,
	output_tokens UInt64,
	cache_read_tokens UInt64,
	cache_write_tokens UInt64,
	reasoning_tokens Nullable(UInt64),
	images UInt64 DEFAULT 0,
	cost_usd Float64,
	cost_input_usd Float64,
	cost_output_usd Float64,
	cost_cache_read_usd Float64,
	cost_cache_write_usd Float64,
	cost_source LowCardinality(String),
	price_version LowCardinality(String),
	duration_ms UInt64,
	first_token_ms Nullable(UInt64)
) ENGINE = ReplacingMergeTree(recorded_at)
PARTITION BY toYYYYMM(started_at)
ORDER BY (organisation_id, started_at, session_id, call_id)
SETTINGS non_replicated_deduplication_window = 1000`,
		`CREATE TABLE IF NOT EXISTS ${database}.usage_hourly (
	hour DateTime('UTC'),
	organisation_id LowCardinality(String),
	provider LowCardinality(String),
	connector_id LowCardinality(String),
	model_id LowCardinality(String),
	calls UInt64,
	failed UInt64,
	input_tokens UInt64,
	output_tokens UInt64,
	cache_read_tokens UInt64,
	cache_write_tokens UInt64,
	reasoning_tokens UInt64,
	images UInt64 DEFAULT 0,
	cost_usd Float64
) ENGINE = SummingMergeTree
PARTITION BY toYYYYMM(hour)
ORDER BY (organisation_id, hour, provider, connector_id, model_id)
SETTINGS non_replicated_deduplication_window = 1000`,
		// Added after the tables first shipped: no-ops on tables made with them.
		`ALTER TABLE ${database}.usage_calls ADD COLUMN IF NOT EXISTS images UInt64 DEFAULT 0 AFTER reasoning_tokens`,
		`ALTER TABLE ${database}.usage_hourly ADD COLUMN IF NOT EXISTS images UInt64 DEFAULT 0 AFTER reasoning_tokens`,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS ${database}.usage_hourly_mv TO ${database}.usage_hourly AS
${hourlyQuery(database)}`,
		`ALTER TABLE ${database}.usage_hourly_mv MODIFY QUERY
${hourlyQuery(database)}`,
	];
}

/** Creates the tables over the same HTTP interface, one statement at a time. Idempotent. */
export async function migrateClickHouseUsage(options: ClickHouseUsageSinkOptions): Promise<void> {
	const upstream = options.fetch ?? fetch;
	const base = options.url.replace(/\/+$/, "");
	const headers: Record<string, string> = {};
	if (options.user !== undefined) headers["x-clickhouse-user"] = options.user;
	if (options.password !== undefined) headers["x-clickhouse-key"] = options.password;
	for (const statement of clickHouseUsageSchema(options.database)) {
		const response = await upstream(`${base}/`, {
			method: "POST",
			headers,
			body: statement,
			signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
		});
		if (!response.ok) {
			const text = (await response.text()).slice(0, 300);
			throw new Error(`ClickHouse refused the usage schema (HTTP ${response.status}): ${text}`);
		}
		await response.body?.cancel();
	}
}

import type { UsageRecord } from "@kantel/contracts";
import {
	clickHouseRow,
	clickHouseUsageSchema,
	clickHouseUsageSink,
	migrateClickHouseUsage,
} from "@kantel/usage/clickhouse";
import { describe, expect, it } from "vitest";

const record: UsageRecord = {
	callId: "call-1",
	startedAt: Date.UTC(2026, 9, 30, 12, 0, 0, 250),
	organisationId: "org-a",
	projectId: "proj-a",
	sessionId: "sess-1",
	agentId: "agent-1",
	route: "default",
	modelId: "gpt-5",
	provider: "openai",
	connectorId: "cpa",
	connectorPreset: "cliproxyapi",
	api: "openai-responses",
	status: "error",
	stopReason: "error",
	error: "rate limited",
	inputTokens: 10,
	outputTokens: 0,
	cacheReadTokens: 90,
	cacheWriteTokens: 0,
	images: 0,
	cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	costSource: "none",
	priceVersion: "none",
	durationMs: 40,
};

/** An image call's record: `openai-images`, two images, a cost the upstream reported. */
const imageRecord: UsageRecord = {
	...record,
	callId: "image-1",
	route: "images",
	modelId: "gpt-image-1",
	connectorPreset: "litellm",
	api: "openai-images",
	status: "done",
	stopReason: "stop",
	inputTokens: 50,
	outputTokens: 4_160,
	cacheReadTokens: 0,
	images: 2,
	cost: { total: 0.17, input: 0, output: 0.17, cacheRead: 0, cacheWrite: 0 },
	costSource: "reported",
	priceVersion: "reported",
};

/**
 * The tables as PR #302 first made them, before `images`: `migrateClickHouseUsage` must bring them up to date, the
 * view included.
 */
function firstSchema(database: string): string[] {
	const sums =
		"calls UInt64, failed UInt64, input_tokens UInt64, output_tokens UInt64, cache_read_tokens UInt64, cache_write_tokens UInt64, reasoning_tokens UInt64, cost_usd Float64";
	return [
		`CREATE DATABASE IF NOT EXISTS ${database}`,
		`CREATE TABLE ${database}.usage_calls (call_id String, session_id String, started_at DateTime64(3, 'UTC'),
		recorded_at DateTime64(3, 'UTC'), organisation_id LowCardinality(String), project_id String, agent_id String,
		run_id Nullable(String), route LowCardinality(String), model_id LowCardinality(String), provider LowCardinality(String),
		connector_id LowCardinality(String), connector_preset LowCardinality(String), api LowCardinality(String),
		status LowCardinality(String), stop_reason LowCardinality(Nullable(String)), error Nullable(String),
		input_tokens UInt64, output_tokens UInt64, cache_read_tokens UInt64, cache_write_tokens UInt64,
		reasoning_tokens Nullable(UInt64), cost_usd Float64, cost_input_usd Float64, cost_output_usd Float64,
		cost_cache_read_usd Float64, cost_cache_write_usd Float64, cost_source LowCardinality(String),
		price_version LowCardinality(String), duration_ms UInt64, first_token_ms Nullable(UInt64)
		) ENGINE = ReplacingMergeTree(recorded_at) PARTITION BY toYYYYMM(started_at)
		ORDER BY (organisation_id, started_at, session_id, call_id) SETTINGS non_replicated_deduplication_window = 1000`,
		`CREATE TABLE ${database}.usage_hourly (hour DateTime('UTC'), organisation_id LowCardinality(String),
		provider LowCardinality(String), connector_id LowCardinality(String), model_id LowCardinality(String), ${sums}
		) ENGINE = SummingMergeTree PARTITION BY toYYYYMM(hour) ORDER BY (organisation_id, hour, provider, connector_id, model_id)
		SETTINGS non_replicated_deduplication_window = 1000`,
		`CREATE MATERIALIZED VIEW ${database}.usage_hourly_mv TO ${database}.usage_hourly AS SELECT
		toStartOfHour(started_at) AS hour, organisation_id, provider, connector_id, model_id, count() AS calls,
		countIf(status != 'done') AS failed, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
		sum(cache_read_tokens) AS cache_read_tokens, sum(cache_write_tokens) AS cache_write_tokens,
		sum(ifNull(reasoning_tokens, 0)) AS reasoning_tokens, sum(cost_usd) AS cost_usd
		FROM ${database}.usage_calls GROUP BY hour, organisation_id, provider, connector_id, model_id`,
	];
}

function recorder(status = 200) {
	const requests: { url: URL; headers: Headers; body: string }[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: new URL(String(input)), headers: new Headers(init?.headers), body: String(init?.body) });
		return new Response(status === 200 ? "" : "Code: 60. Table missing", { status });
	}) as typeof globalThis.fetch;
	return { requests, fetch };
}

/** A real ClickHouse, such as `http://kantel:pw@127.0.0.1:8123`; the tests below it are skipped without one. */
const CLICKHOUSE = process.env.KANTEL_TEST_CLICKHOUSE_URL?.trim() ?? "";

describe.skipIf(CLICKHOUSE === "")("clickHouseUsageSink on a real ClickHouse", () => {
	const url = CLICKHOUSE === "" ? new URL("http://unused") : new URL(CLICKHOUSE);
	const optionsFor = (name: string) => ({
		url: url.origin,
		database: `harbour_test_${name}_${Date.now()}`,
		...(url.username === "" ? {} : { user: decodeURIComponent(url.username) }),
		...(url.password === "" ? {} : { password: decodeURIComponent(url.password) }),
	});
	const run = async (sql: string) => {
		// 64-bit counts as JSON numbers, whichever way the server's version defaults (25.8 stopped quoting them).
		const response = await fetch(`${url.origin}/?output_format_json_quote_64bit_integers=0`, {
			method: "POST",
			headers: {
				...(url.username === "" ? {} : { "x-clickhouse-user": decodeURIComponent(url.username) }),
				...(url.password === "" ? {} : { "x-clickhouse-key": decodeURIComponent(url.password) }),
			},
			body: sql,
		});
		const text = await response.text();
		if (!response.ok) throw new Error(text);
		return text;
	};
	const query = async (sql: string) =>
		(await run(`${sql} FORMAT JSONEachRow`))
			.trim()
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as Record<string, unknown>);

	it("drops a resent batch from the calls and from the hourly rollup, image counts included", async () => {
		const options = optionsFor("resend");
		try {
			await migrateClickHouseUsage(options);
			await migrateClickHouseUsage(options);
			const sink = clickHouseUsageSink(options);
			const batch = [
				{ ...record, status: "done" as const, cacheWriteTokens: 20 },
				{ ...record, callId: "call-2", reasoningTokens: 3, firstTokenMs: 50 },
				imageRecord,
			];
			await sink.write(batch, "clickhouse:0-3");
			await sink.write(batch, "clickhouse:0-3");
			expect(await query(`SELECT count() AS calls FROM ${options.database}.usage_calls`)).toEqual([{ calls: 3 }]);
			expect(await query(`SELECT api, images FROM ${options.database}.usage_calls WHERE call_id = 'image-1'`)).toEqual([
				{ api: "openai-images", images: 2 },
			]);
			expect(
				await query(
					`SELECT sum(calls) AS calls, sum(failed) AS failed, sum(cache_read_tokens) AS cache_read,
					sum(cache_write_tokens) AS cache_write, sum(reasoning_tokens) AS reasoning, sum(images) AS images
					FROM ${options.database}.usage_hourly`,
				),
			).toEqual([{ calls: 3, failed: 1, cache_read: 180, cache_write: 20, reasoning: 3, images: 2 }]);
			expect(
				await query(
					`SELECT model_id, sum(images) AS images, round(sum(cost_usd), 2) AS cost FROM ${options.database}.usage_hourly
					WHERE model_id = 'gpt-image-1' GROUP BY model_id`,
				),
			).toEqual([{ model_id: "gpt-image-1", images: 2, cost: 0.17 }]);
		} finally {
			await run(`DROP DATABASE IF EXISTS ${options.database}`);
		}
	});

	it("brings the first schema's tables and view up to date, keeping their rows, and rolls up images after", async () => {
		const options = optionsFor("upgrade");
		try {
			for (const statement of firstSchema(options.database)) await run(statement);
			// A row the first schema's shipper wrote, without `images`.
			const { images: _, ...old } = clickHouseRowOf(record);
			await run(`INSERT INTO ${options.database}.usage_calls FORMAT JSONEachRow ${JSON.stringify(old)}`);

			await migrateClickHouseUsage(options);
			await migrateClickHouseUsage(options);
			const sink = clickHouseUsageSink(options);
			await sink.write([imageRecord], "clickhouse:1-2");
			await sink.write([imageRecord], "clickhouse:1-2");

			expect(await query(`SELECT call_id, images FROM ${options.database}.usage_calls ORDER BY call_id`)).toEqual([
				{ call_id: "call-1", images: 0 },
				{ call_id: "image-1", images: 2 },
			]);
			expect(
				await query(
					`SELECT sum(calls) AS calls, sum(images) AS images, round(sum(cost_usd), 2) AS cost
					FROM ${options.database}.usage_hourly`,
				),
			).toEqual([{ calls: 2, images: 2, cost: 0.17 }]);
			const [view] = await query(
				`SELECT create_table_query FROM system.tables WHERE database = '${options.database}' AND name = 'usage_hourly_mv'`,
			);
			expect(String(view?.create_table_query)).toContain("sum(images) AS images");
		} finally {
			await run(`DROP DATABASE IF EXISTS ${options.database}`);
		}
	});
});

/** `clickHouseRow` at a fixed recording time. */
const clickHouseRowOf = (row: UsageRecord) => clickHouseRow(row, Date.UTC(2026, 9, 30, 12, 0, 1));

describe("clickHouseUsageSink", () => {
	it("inserts a batch as JSONEachRow, deduplicated by the batch's ID, with UTC times and nulls", async () => {
		const { requests, fetch } = recorder();
		const sink = clickHouseUsageSink({ url: "http://clickhouse:8123/", user: "kantel", password: "pw", fetch });
		await sink.write([record, { ...record, callId: "call-2" }], "clickhouse:0-2");
		await sink.write([], "clickhouse:2-2");
		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request?.url.searchParams.get("query")).toBe("INSERT INTO harbour.usage_calls FORMAT JSONEachRow");
		expect(request?.url.searchParams.get("insert_deduplication_token")).toBe("clickhouse:0-2");
		expect(request?.url.searchParams.get("deduplicate_blocks_in_dependent_materialized_views")).toBe("1");
		expect(request?.headers.get("x-clickhouse-user")).toBe("kantel");
		expect(request?.headers.get("x-clickhouse-key")).toBe("pw");
		const rows = request?.body
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(rows?.map((row) => row.call_id)).toEqual(["call-1", "call-2"]);
		expect(rows?.[0]).toMatchObject({
			started_at: "2026-10-30 12:00:00.250",
			status: "error",
			error: "rate limited",
			cache_read_tokens: 90,
			reasoning_tokens: null,
			images: 0,
			first_token_ms: null,
			run_id: null,
		});
	});

	it("sends an image call's image API and image count", async () => {
		const { requests, fetch } = recorder();
		await clickHouseUsageSink({ url: "http://clickhouse:8123", fetch }).write([imageRecord], "clickhouse:0-1");
		const row = JSON.parse(requests[0]?.body.trim() ?? "{}") as Record<string, unknown>;
		expect(row).toMatchObject({
			api: "openai-images",
			model_id: "gpt-image-1",
			images: 2,
			cost_usd: 0.17,
			cost_source: "reported",
			price_version: "reported",
		});
	});

	it("rejects when ClickHouse refuses, so the shipper sends the batch again", async () => {
		const { fetch } = recorder(404);
		const sink = clickHouseUsageSink({ url: "http://clickhouse:8123", fetch });
		await expect(sink.write([record], "b")).rejects.toThrow("HTTP 404");
	});

	it("refuses a database name that is not a plain identifier", () => {
		expect(() => clickHouseUsageSink({ url: "http://c", database: "x; DROP" })).toThrow("identifier");
		expect(() => clickHouseUsageSchema("a.b")).toThrow("identifier");
	});

	it("creates the database, the calls table, the hourly rollup and its view, then brings older ones up to date", async () => {
		const { requests, fetch } = recorder();
		await migrateClickHouseUsage({ url: "http://clickhouse:8123", database: "analytics", fetch });
		expect(requests.map((request) => request.body.split("(")[0]?.split("\n")[0]?.trim())).toEqual([
			"CREATE DATABASE IF NOT EXISTS analytics",
			"CREATE TABLE IF NOT EXISTS analytics.usage_calls",
			"CREATE TABLE IF NOT EXISTS analytics.usage_hourly",
			"ALTER TABLE analytics.usage_calls ADD COLUMN IF NOT EXISTS images UInt64 DEFAULT 0 AFTER reasoning_tokens",
			"ALTER TABLE analytics.usage_hourly ADD COLUMN IF NOT EXISTS images UInt64 DEFAULT 0 AFTER reasoning_tokens",
			"CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.usage_hourly_mv TO analytics.usage_hourly AS",
			"ALTER TABLE analytics.usage_hourly_mv MODIFY QUERY",
		]);
		// The view sums images like every other count.
		expect(requests.at(-1)?.body).toContain("sum(images) AS images");
	});
});

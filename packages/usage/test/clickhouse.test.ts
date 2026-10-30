import type { UsageRecord } from "@harbour/contracts";
import { clickHouseUsageSchema, clickHouseUsageSink, migrateClickHouseUsage } from "@harbour/usage/clickhouse";
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
	cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	costSource: "none",
	priceVersion: "none",
	durationMs: 40,
};

function recorder(status = 200) {
	const requests: { url: URL; headers: Headers; body: string }[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: new URL(String(input)), headers: new Headers(init?.headers), body: String(init?.body) });
		return new Response(status === 200 ? "" : "Code: 60. Table missing", { status });
	}) as typeof globalThis.fetch;
	return { requests, fetch };
}

/** A real ClickHouse, such as `http://harbour:pw@127.0.0.1:8123`; the tests below it are skipped without one. */
const CLICKHOUSE = process.env.HARBOUR_TEST_CLICKHOUSE_URL?.trim() ?? "";

describe.skipIf(CLICKHOUSE === "")("clickHouseUsageSink on a real ClickHouse", () => {
	it("drops a resent batch from the calls and from the hourly rollup", async () => {
		const url = new URL(CLICKHOUSE);
		const options = {
			url: url.origin,
			database: `harbour_test_${Date.now()}`,
			...(url.username === "" ? {} : { user: decodeURIComponent(url.username) }),
			...(url.password === "" ? {} : { password: decodeURIComponent(url.password) }),
		};
		const query = async (sql: string) => {
			const response = await fetch(`${url.origin}/`, {
				method: "POST",
				headers: {
					...(options.user === undefined ? {} : { "x-clickhouse-user": options.user }),
					...(options.password === undefined ? {} : { "x-clickhouse-key": options.password }),
				},
				body: `${sql} FORMAT JSONEachRow`,
			});
			return (await response.text())
				.trim()
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		};
		try {
			await migrateClickHouseUsage(options);
			await migrateClickHouseUsage(options);
			const sink = clickHouseUsageSink(options);
			const batch = [
				{ ...record, status: "done" as const, cacheWriteTokens: 20 },
				{ ...record, callId: "call-2", reasoningTokens: 3, firstTokenMs: 50 },
			];
			await sink.write(batch, "clickhouse:0-2");
			await sink.write(batch, "clickhouse:0-2");
			expect(await query(`SELECT count() AS calls FROM ${options.database}.usage_calls`)).toEqual([{ calls: "2" }]);
			expect(
				await query(
					`SELECT sum(calls) AS calls, sum(failed) AS failed, sum(cache_read_tokens) AS cache_read,
					sum(cache_write_tokens) AS cache_write, sum(reasoning_tokens) AS reasoning
					FROM ${options.database}.usage_hourly`,
				),
			).toEqual([{ calls: "2", failed: "1", cache_read: "180", cache_write: "20", reasoning: "3" }]);
		} finally {
			await query(`DROP DATABASE IF EXISTS ${options.database}`);
		}
	});
});

describe("clickHouseUsageSink", () => {
	it("inserts a batch as JSONEachRow, deduplicated by the batch's ID, with UTC times and nulls", async () => {
		const { requests, fetch } = recorder();
		const sink = clickHouseUsageSink({ url: "http://clickhouse:8123/", user: "harbour", password: "pw", fetch });
		await sink.write([record, { ...record, callId: "call-2" }], "clickhouse:0-2");
		await sink.write([], "clickhouse:2-2");
		expect(requests).toHaveLength(1);
		const [request] = requests;
		expect(request?.url.searchParams.get("query")).toBe("INSERT INTO harbour.usage_calls FORMAT JSONEachRow");
		expect(request?.url.searchParams.get("insert_deduplication_token")).toBe("clickhouse:0-2");
		expect(request?.url.searchParams.get("deduplicate_blocks_in_dependent_materialized_views")).toBe("1");
		expect(request?.headers.get("x-clickhouse-user")).toBe("harbour");
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
			first_token_ms: null,
			run_id: null,
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

	it("creates the database, the calls table, the hourly rollup and its view, in that order", async () => {
		const { requests, fetch } = recorder();
		await migrateClickHouseUsage({ url: "http://clickhouse:8123", database: "analytics", fetch });
		expect(requests.map((request) => request.body.split("(")[0]?.trim())).toEqual([
			"CREATE DATABASE IF NOT EXISTS analytics",
			"CREATE TABLE IF NOT EXISTS analytics.usage_calls",
			"CREATE TABLE IF NOT EXISTS analytics.usage_hourly",
			expect.stringContaining("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.usage_hourly_mv"),
		]);
	});
});

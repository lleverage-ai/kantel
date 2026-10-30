// Usage rows on the self-hosted gateway: `HARBOUR_USAGE` and `HARBOUR_CLICKHOUSE_*`, and the ClickHouse shipper over
// the Postgres ledger (node:sqlite stands in for Postgres here; the ledger's SQL is the same on both).
//
// The stack job also runs this file with `bun test` (spike/conformance/run.ts), and Bun has no `node:sqlite`, so the
// ledger tests load `@harbour/sql/testing` only when they run, and run on Node alone (CI's check job, under vitest).
import type { UsageRecord } from "@harbour/contracts";
import { createSqlUsageLedger } from "@harbour/usage/sql";
import { describe, expect, it, vi } from "vitest";
import { selfHostedUsage, usageConfig } from "../../src/gateway/usage.ts";

const record: UsageRecord = {
	callId: "call-1",
	startedAt: 1_790_000_000_000,
	organisationId: "org-a",
	projectId: "proj-a",
	sessionId: "sess-1",
	agentId: "assistant",
	route: "default",
	modelId: "claude-sonnet-5-5",
	provider: "anthropic",
	connectorId: "cliproxyapi",
	connectorPreset: "cliproxyapi",
	api: "anthropic-messages",
	status: "done",
	inputTokens: 10,
	outputTokens: 5,
	cacheReadTokens: 100,
	cacheWriteTokens: 20,
	cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	costSource: "none",
	priceVersion: "none",
	durationMs: 300,
};

describe("usageConfig", () => {
	it("is on by default, off with HARBOUR_USAGE=off, and ships to ClickHouse only when given its URL", () => {
		expect(usageConfig({})).toEqual({});
		expect(usageConfig({ HARBOUR_USAGE: "off", HARBOUR_CLICKHOUSE_URL: "http://c:8123" })).toBeUndefined();
		expect(
			usageConfig({
				HARBOUR_CLICKHOUSE_URL: "http://clickhouse:8123",
				HARBOUR_CLICKHOUSE_USER: "harbour",
				HARBOUR_CLICKHOUSE_PASSWORD: "secret",
				HARBOUR_CLICKHOUSE_INTERVAL_S: "5",
			}),
		).toEqual({
			clickhouse: { url: "http://clickhouse:8123", user: "harbour", password: "secret", intervalMs: 5_000 },
		});
		expect(() => usageConfig({ HARBOUR_CLICKHOUSE_URL: "clickhouse:8123" })).toThrow("http");
		expect(() => usageConfig({ HARBOUR_CLICKHOUSE_URL: "http://c", HARBOUR_CLICKHOUSE_INTERVAL_S: "0" })).toThrow(
			"at least 1",
		);
	});
});

async function openDatabase() {
	const { nodeSqliteDatabase } = await import("@harbour/sql/testing");
	return nodeSqliteDatabase.open();
}

describe.skipIf("Bun" in globalThis)("selfHostedUsage", () => {
	it("keeps rows in the ledger alone without ClickHouse", async () => {
		const database = await openDatabase();
		try {
			const usage = await selfHostedUsage(database.driver, {}, () => {});
			expect(usage.binding).toBe("postgres");
			await usage.writer.record(record);
			expect((await createSqlUsageLedger({ driver: database.driver }).sessionTotals("sess-1")).calls).toBe(1);
			await usage.close();
		} finally {
			await database.close();
		}
	});

	it("ships settled rows to ClickHouse, logging an outage once and catching up after it", async () => {
		const database = await openDatabase();
		const logs: string[] = [];
		const inserts: string[] = [];
		let down = true;
		const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			if (down) throw new Error("connect ECONNREFUSED");
			const url = new URL(String(input));
			if (url.searchParams.get("query")?.startsWith("INSERT")) inserts.push(String(init?.body));
			return new Response("");
		}) as typeof globalThis.fetch;
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		try {
			vi.setSystemTime(1_790_000_000_000);
			const usage = await selfHostedUsage(
				database.driver,
				{ clickhouse: { url: "http://clickhouse:8123", intervalMs: 1_000, fetch } },
				(message) => logs.push(message),
			);
			expect(usage.binding).toBe("postgres + clickhouse");
			await usage.writer.record(record);
			await vi.advanceTimersByTimeAsync(1_000);
			await vi.advanceTimersByTimeAsync(1_000);
			await vi.waitFor(() => expect(logs).toHaveLength(1));
			expect(logs[0]).toContain("shipping to ClickHouse failed");
			down = false;
			// The row settles (10 s) and the next tick sends it.
			vi.setSystemTime(1_790_000_020_000);
			await vi.advanceTimersByTimeAsync(1_000);
			await vi.waitFor(() => expect(inserts).toHaveLength(1));
			expect(JSON.parse(inserts[0]!.trim())).toMatchObject({ call_id: "call-1", cache_write_tokens: 20 });
			expect(logs.at(-1)).toContain("taking rows again (1 shipped)");
			await usage.close();
		} finally {
			vi.useRealTimers();
			await database.close();
		}
	});
});

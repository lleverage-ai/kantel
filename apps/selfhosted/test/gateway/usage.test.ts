// Usage rows on the self-hosted gateway: `HARBOUR_USAGE` and `HARBOUR_CLICKHOUSE_*`, and the ClickHouse shipper over
// the Postgres ledger (PGlite stands in for Postgres here; not node:sqlite, which Bun, running these files in CI's
// self-hosted job, does not have).
import type { UsageRecord } from "@harbour/contracts";
import { pgliteDatabase } from "@harbour/sql/testing";
import { createSqlUsageLedger } from "@harbour/usage/sql";
import { describe, expect, it } from "vitest";
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

/** Waits for `done`, polling, for at most 5 s. */
async function until(done: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!done()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

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

describe("selfHostedUsage", () => {
	it("keeps rows in the ledger alone without ClickHouse", async () => {
		const database = await pgliteDatabase.open();
		try {
			const usage = await selfHostedUsage(database.driver, {}, () => {});
			expect(usage.binding).toBe("postgres");
			await usage.writer.record(record);
			expect((await createSqlUsageLedger({ driver: database.driver }).sessionTotals("sess-1")).calls).toBe(1);
			await usage.close();
		} finally {
			await database.close();
		}
		// PGlite takes a few seconds to start, close to Bun's 5 s default.
	}, 30_000);

	it("ships settled rows to ClickHouse, logging an outage once and catching up after it", async () => {
		const database = await pgliteDatabase.open();
		const logs: string[] = [];
		const inserts: string[] = [];
		let down = true;
		let calls = 0;
		const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			calls += 1;
			if (down) throw new Error("connect ECONNREFUSED");
			const url = new URL(String(input));
			if (url.searchParams.get("query")?.startsWith("INSERT")) inserts.push(String(init?.body));
			return new Response("");
		}) as typeof globalThis.fetch;
		// Real timers on a short interval: Bun runs this file in CI's self-hosted job, and its `vi` has no fake timers.
		try {
			const usage = await selfHostedUsage(
				database.driver,
				{ clickhouse: { url: "http://clickhouse:8123", intervalMs: 20, settleMs: 0, fetch } },
				(message) => logs.push(message),
			);
			expect(usage.binding).toBe("postgres + clickhouse");
			await usage.writer.record(record);
			await until(() => calls >= 3);
			// Several failed ticks, one log line.
			expect(logs).toHaveLength(1);
			expect(logs[0]).toContain("shipping to ClickHouse failed");
			down = false;
			await until(() => inserts.length === 1 && logs.length === 2);
			expect(JSON.parse(inserts[0]!.trim())).toMatchObject({ call_id: "call-1", cache_write_tokens: 20 });
			expect(logs.at(-1)).toContain("taking rows again (1 shipped)");
			await usage.close();
		} finally {
			await database.close();
		}
	}, 30_000);
});

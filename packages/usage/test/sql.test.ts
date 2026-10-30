import type { UsageRecord, UsageSink } from "@harbour/contracts";
import type { SqlDriver } from "@harbour/sql";
import { testDatabaseKinds } from "@harbour/sql/testing";
import { createUsageShipper } from "@harbour/usage/shipper";
import {
	createSqlUsageLedger,
	migrateUsage,
	sqlUsageSink,
	USAGE_SCHEMA_VERSION,
	usageMigrations,
} from "@harbour/usage/sql";
import { describe, expect, it, vi } from "vitest";

let calls = 0;
function call(overrides: Partial<UsageRecord> = {}): UsageRecord {
	calls += 1;
	return {
		callId: `call-${calls}`,
		startedAt: 1_790_000_000_000 + calls,
		organisationId: "org-a",
		projectId: "proj-a",
		sessionId: "sess-1",
		agentId: "agent-1",
		route: "default",
		modelId: "claude-sonnet-4-5",
		provider: "anthropic",
		connectorId: "cpa",
		connectorPreset: "cliproxyapi",
		api: "anthropic-messages",
		status: "done",
		stopReason: "stop",
		inputTokens: 120,
		outputTokens: 40,
		cacheReadTokens: 1_000,
		cacheWriteTokens: 200,
		reasoningTokens: 8,
		images: 0,
		cost: { total: 0.01, input: 0.002, output: 0.006, cacheRead: 0.001, cacheWrite: 0.001 },
		costSource: "computed",
		priceVersion: "rates:3/15/0.3/3.75",
		durationMs: 900,
		firstTokenMs: 150,
		...overrides,
	};
}

/** An image call's record: two images over `openai-images`, priced from OpenAI's image tokens. */
function imageCall(overrides: Partial<UsageRecord> = {}): UsageRecord {
	const {
		reasoningTokens: _r,
		firstTokenMs: _f,
		...base
	} = call({
		sessionId: "sess-img",
		route: "images",
		modelId: "gpt-image-1",
		provider: "openai",
		connectorId: "openai",
		connectorPreset: "openai",
		api: "openai-images",
		inputTokens: 50,
		outputTokens: 4_160,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		images: 2,
		cost: { total: 0.16664, input: 0.00025, output: 0.16639, cacheRead: 0, cacheWrite: 0 },
		priceVersion: "rates:5/40/0/0",
	});
	return { ...base, ...overrides };
}

for (const kind of testDatabaseKinds()) {
	describe(`usage ledger on ${kind.name}`, () => {
		async function open(now = () => 1_000_000) {
			const database = await kind.open();
			await migrateUsage(database.driver);
			await migrateUsage(database.driver);
			return { database, ledger: createSqlUsageLedger({ driver: database.driver, now }) };
		}

		it("keeps one row per (session, call), every field round-tripping, and a failed call's usage", async () => {
			const { database, ledger } = await open();
			try {
				const done = call();
				const failed = call({
					status: "error",
					stopReason: "error",
					error: "overloaded",
					outputTokens: 0,
					cacheWriteTokens: 0,
					cost: { total: 0.0005, input: 0.0002, output: 0, cacheRead: 0.0003, cacheWrite: 0 },
				});
				const bare = call({ costSource: "none", priceVersion: "none" });
				const { reasoningTokens: _r, firstTokenMs: _f, stopReason: _s, ...rest } = bare;
				await ledger.record(done);
				await ledger.record(done);
				await ledger.record(failed);
				await ledger.record(rest);
				const entries = await ledger.read({ afterSeq: 0, recordedBefore: 2_000_000, limit: 10 });
				expect(entries.map((entry) => entry.record)).toEqual([done, failed, rest]);
				expect(entries.map((entry) => entry.seq)).toEqual([...entries.map((entry) => entry.seq)].sort((a, b) => a - b));
				expect(await ledger.sessionTotals("sess-1")).toEqual({
					calls: 3,
					failed: 1,
					inputTokens: 360,
					outputTokens: 80,
					cacheReadTokens: 3_000,
					cacheWriteTokens: 400,
					images: 0,
					costUsd: expect.closeTo(0.0205, 6),
				});
				expect((await ledger.sessionTotals("none")).calls).toBe(0);
			} finally {
				await database.close();
			}
		});

		it("keeps an image call's image API and image count, and sums the images per session", async () => {
			const { database, ledger } = await open();
			try {
				const image = imageCall();
				const refused = imageCall({
					status: "error",
					stopReason: "error",
					error: "400: Your request was rejected",
					inputTokens: 0,
					outputTokens: 0,
					images: 0,
					cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					priceVersion: "image:0.04",
				});
				await ledger.record(call({ sessionId: "sess-img" }));
				await ledger.record(image);
				await ledger.record(refused);
				const entries = await ledger.read({ afterSeq: 0, recordedBefore: 2_000_000, limit: 10 });
				expect(entries.map((entry) => entry.record).slice(1)).toEqual([image, refused]);
				expect(await ledger.sessionTotals("sess-img")).toMatchObject({ calls: 3, failed: 1, images: 2 });
			} finally {
				await database.close();
			}
		});

		it("brings a first-version ledger up to date, keeping its rows and cursors", async () => {
			const database = await kind.open();
			try {
				// The tables as PR #302 made them, with no `usage_schema`, holding a row and a cursor.
				const [first] = usageMigrations(database.driver.dialect);
				await database.driver.batch((first?.statements ?? []).map((text) => ({ sql: text })));
				await database.driver.query(
					`INSERT INTO usage_calls (call_id, session_id, started_at, recorded_at, organisation_id, project_id, agent_id,
					route, model_id, provider, connector_id, connector_preset, api, status, input_tokens, output_tokens,
					cache_read_tokens, cache_write_tokens, cost_usd, cost_input_usd, cost_output_usd, cost_cache_read_usd,
					cost_cache_write_usd, cost_source, price_version, duration_ms)
					VALUES ('old-1', 'sess-old', 1, 1, 'org-a', 'proj-a', 'agent-1', 'default', 'gpt-5', 'openai', 'cpa',
					'cliproxyapi', 'openai-responses', 'done', 5, 6, 0, 0, 0, 0, 0, 0, 0, 'none', 'none', 10)`,
				);
				await database.driver.query(
					"INSERT INTO usage_cursors (sink, after_seq, pending_to_seq, updated_at) VALUES ('d1', 1, NULL, 1)",
				);

				await migrateUsage(database.driver);
				await migrateUsage(database.driver);
				const [version] = await database.driver.query("SELECT version FROM usage_schema");
				expect(Number(version?.version)).toBe(USAGE_SCHEMA_VERSION);
				const ledger = createSqlUsageLedger({ driver: database.driver, now: () => 1_000_000 });
				await ledger.record(imageCall({ sessionId: "sess-old" }));
				const entries = await ledger.read({ afterSeq: 0, recordedBefore: 2_000_000, limit: 10 });
				expect(entries.map((entry) => [entry.record.callId, entry.record.images])).toEqual([
					["old-1", 0],
					[expect.stringMatching(/^call-/), 2],
				]);
				expect(await ledger.cursor("d1")).toEqual({ afterSeq: 1 });
			} finally {
				await database.close();
			}
		});

		it("goes on when another process migrated first, between its read of the version and its batch", async () => {
			const database = await kind.open();
			try {
				const inner = database.driver;
				let raced = false;
				// The other process: it runs the whole migration just before this one's version 2 batch.
				const racing: SqlDriver = {
					dialect: inner.dialect,
					query: (text, params) => inner.query(text, params),
					async batch(statements) {
						if (!raced && statements.some((statement) => statement.sql.includes("ADD COLUMN"))) {
							raced = true;
							await migrateUsage(inner);
						}
						return inner.batch(statements);
					},
				};
				await migrateUsage(racing);
				expect(raced).toBe(true);
				const [version] = await inner.query("SELECT version FROM usage_schema");
				expect(Number(version?.version)).toBe(USAGE_SCHEMA_VERSION);
			} finally {
				await database.close();
			}
		});

		it("ships settled rows in batches, resends a failed batch whole with the same ID, and never twice", async () => {
			let time = 1_000_000;
			const { database, ledger } = await open(() => time);
			const target = await kind.open();
			try {
				await migrateUsage(target.driver);
				const inner = sqlUsageSink(target.driver);
				const batches: { ids: string[]; batchId: string }[] = [];
				let failNext = false;
				const sink: UsageSink = {
					async write(records, batchId) {
						batches.push({ ids: records.map((record) => record.callId), batchId });
						if (failNext) {
							failNext = false;
							// The write reached the store but the answer was lost: the resend must add nothing.
							await inner.write(records, batchId);
							throw new Error("lost answer");
						}
						await inner.write(records, batchId);
					},
				};
				const shipper = createUsageShipper({ ledger, sink, name: "d1", batchSize: 2, settleMs: 10, now: () => time });
				const records = [call(), call(), call()];
				for (const record of records) await ledger.record(record);
				// Not settled yet.
				expect(await shipper.ship()).toBe(0);
				time += 10;
				await ledger.record(call({ sessionId: "sess-2" }));
				failNext = true;
				await expect(shipper.ship()).rejects.toThrow("lost answer");
				expect((await ledger.cursor("d1")).pendingToSeq).toBeDefined();
				// More rows settle meanwhile; the pending batch still goes as it was.
				time += 10;
				expect(await shipper.ship()).toBe(4);
				expect(batches.map((batch) => batch.ids)).toEqual([
					[records[0]?.callId, records[1]?.callId],
					[records[0]?.callId, records[1]?.callId],
					[records[2]?.callId, `call-${calls}`],
				]);
				expect(batches[0]?.batchId).toBe(batches[1]?.batchId);
				expect(await shipper.ship()).toBe(0);
				const copied = createSqlUsageLedger({ driver: target.driver });
				expect((await copied.sessionTotals("sess-1")).calls).toBe(3);
				expect((await copied.sessionTotals("sess-2")).calls).toBe(1);
				expect(await ledger.cursor("d1")).toEqual({ afterSeq: expect.any(Number) });
			} finally {
				await target.close();
				await database.close();
			}
		});
	});
}

describe("createUsageShipper", () => {
	it("runs one pass at a time and runs again after one that may have missed a newer row", async () => {
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const written: string[][] = [];
		const asked: Promise<number>[] = [];
		const rows: UsageRecord[] = [call()];
		let after = 0;
		let reads = 0;
		const ledger = {
			async record() {},
			async read({ afterSeq }: { afterSeq: number }) {
				reads += 1;
				// What the table holds when the read runs; the first read's answer is held back until `release`.
				const found = rows
					.map((record, index) => ({ seq: index + 1, recordedAt: 0, record }))
					.filter((entry) => entry.seq > afterSeq);
				if (reads === 1) {
					// A call is recorded, and the shipper asked again, while this read is out.
					rows.push(call());
					asked.push(shipper.ship(), shipper.ship());
					await held;
				}
				return found;
			},
			async cursor() {
				return { afterSeq: after };
			},
			async pending() {},
			async advance(_sink: string, toSeq: number) {
				after = toSeq;
			},
			async sessionTotals() {
				throw new Error("unused");
			},
		};
		const shipper = createUsageShipper({
			ledger,
			sink: {
				async write(records) {
					written.push(records.map((record) => record.callId));
				},
			},
			name: "test",
			settleMs: 0,
		});
		const first = shipper.ship();
		await vi.waitFor(() => expect(asked).toHaveLength(2));
		const [second, third] = asked;
		expect(third).toBe(second);
		release();
		expect(await first).toBe(1);
		expect(await second).toBe(1);
		expect(written).toEqual([[rows[0]?.callId], [rows[1]?.callId]]);
	});
});

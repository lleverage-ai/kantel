import { PGlite } from "@electric-sql/pglite";
import { createMemoryAuditOutbox } from "@harbour/audit/memory";
import { startAuditRelay } from "@harbour/audit/relay";
import { auditOutboxStatements, createSqlAuditOutbox, createSqlAuditStore, migrateAudit } from "@harbour/audit/sql";
import {
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type ProjectAccess,
	systemContext,
} from "@harbour/contracts";
import { sql } from "@harbour/sql";
import { postgresClientDriver } from "@harbour/sql/postgres";
import { nodeSqliteDatabase, testDatabaseKinds } from "@harbour/sql/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

const SYSTEM = systemContext("audit.test");
const ORGANISATION = "org_audit";
const reader: CallContext = { actor: { kind: "human", userId: "auditor" }, organisationId: ORGANISATION };

function event(id: string, extra: Partial<AuditEventInput> = {}): AuditEventInput {
	return {
		id,
		at: 1_000,
		source: "vault",
		type: "vault.injected",
		actor: { kind: "agent", agentId: "agent-1", sessionId: "ses-1" },
		organisationId: ORGANISATION,
		projectId: "proj-1",
		sessionId: "ses-1",
		...extra,
	};
}

async function ids(store: ReturnType<typeof createSqlAuditStore>): Promise<string[]> {
	return (await store.query(reader, {}, { limit: 500 })).items.map((row) => row.id);
}

for (const kind of testDatabaseKinds()) {
	describe(`SQL audit on ${kind.name}`, () => {
		it("keeps rows, retention and the outbox across store instances, and seq keeps rising", async () => {
			const database = await kind.open();
			try {
				await migrateAudit(database.driver);
				await migrateAudit(database.driver);
				const clock = { now: () => 2_000 };
				const before = createSqlAuditStore({ driver: database.driver, clock });
				await before.append(SYSTEM, [event("a"), event("b")]);
				await before.setRetention(reader, 60_000);
				await createSqlAuditOutbox({ driver: database.driver }).append(SYSTEM, [event("queued")]);

				const after = createSqlAuditStore({ driver: database.driver, clock });
				const outbox = createSqlAuditOutbox({ driver: database.driver });
				expect(await ids(after)).toEqual(["a", "b"]);
				expect(await outbox.pending(SYSTEM)).toBe(1);
				await outbox.drain(SYSTEM, after);
				const rows = (await after.query(reader, {})).items;
				expect(rows.map((row) => row.id)).toEqual(["a", "b", "queued"]);
				expect(rows[2]!.seq).toBeGreaterThan(rows[1]!.seq);
				expect(await after.applyRetention(SYSTEM)).toBe(0);
			} finally {
				await database.close();
			}
		});

		it("stores each event once when the store took a batch but the relay never heard back", async () => {
			const database = await kind.open();
			try {
				await migrateAudit(database.driver);
				const store = createSqlAuditStore({ driver: database.driver });
				const outbox = createSqlAuditOutbox({ driver: database.driver });
				const injections = Array.from({ length: 150 }, (_, index) => event(`inject-${index}`));
				const decision = event("decision-1", {
					source: "vault",
					type: "vault.approved",
					actor: { kind: "human", userId: "alice" },
				});
				await outbox.append(SYSTEM, [...injections, decision]);
				let lostAcks = 2;
				const lossy: AuditSink = {
					async append(ctx, events) {
						await store.append(ctx, events);
						if (lostAcks > 0) {
							lostAcks -= 1;
							throw new Error("connection reset after the store committed");
						}
					},
				};
				await expect(outbox.drain(SYSTEM, lossy)).rejects.toThrow("connection reset");
				await expect(outbox.drain(SYSTEM, lossy)).rejects.toThrow("connection reset");
				expect(await outbox.drain(SYSTEM, lossy)).toBe(151);
				expect(await outbox.drain(SYSTEM, lossy)).toBe(0);
				const stored = await ids(store);
				expect(stored).toHaveLength(151);
				expect(new Set(stored).size).toBe(151);
				expect(stored.filter((id) => id === "decision-1")).toHaveLength(1);
			} finally {
				await database.close();
			}
		});

		it("matches a type prefix by characters, whatever the script", async () => {
			const database = await kind.open();
			try {
				await migrateAudit(database.driver);
				const store = createSqlAuditStore({ driver: database.driver });
				await store.append(SYSTEM, [
					event("rocket", { type: "custom.🚀.created" }),
					event("ship", { type: "custom.🚢.created" }),
				]);
				const typed = async (type: string) => (await store.query(reader, { type })).items.map((row) => row.id);
				expect(await typed("custom.🚀.")).toEqual(["rocket"]);
				expect(await typed("custom.")).toEqual(["rocket", "ship"]);
				expect(await typed("custom.🚀")).toEqual([]);
			} finally {
				await database.close();
			}
		});

		it("never pages past a visible row whose project appeared while access was being checked", async () => {
			const database = await kind.open();
			try {
				await migrateAudit(database.driver);
				let release: () => void = () => undefined;
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				let gated = true;
				const access = {
					async allows() {
						if (gated) {
							gated = false;
							await gate;
						}
						return true;
					},
					async require(_ctx: CallContext, check: { projectId?: string }) {
						return check.projectId === undefined ? {} : { projectId: check.projectId };
					},
				} as unknown as ProjectAccess;
				const store = createSqlAuditStore({ driver: database.driver, access });
				await store.append(SYSTEM, [event("a-1", { projectId: "proj-a" })]);

				const reading = store.query(reader, {}, { limit: 1, cursor: "1" });
				await new Promise((resolve) => setTimeout(resolve, 10));
				await store.append(SYSTEM, [event("b-1", { projectId: "proj-b" }), event("a-2", { projectId: "proj-a" })]);
				release();
				const page = await reading;
				expect(page.items.map((row) => row.id)).toEqual([]);
				expect(page.nextCursor).toBeUndefined();

				const next = await store.query(reader, {}, { limit: 1, cursor: "1" });
				expect(next.items.map((row) => row.id)).toEqual(["b-1"]);
			} finally {
				await database.close();
			}
		});

		it("applies an organisation's retention, and the store's default to the rest", async () => {
			const database = await kind.open();
			try {
				await migrateAudit(database.driver);
				const now = 100_000;
				const store = createSqlAuditStore({ driver: database.driver, retentionMs: 50_000, clock: { now: () => now } });
				const other: CallContext = { ...reader, organisationId: "org_other" };
				await store.append(SYSTEM, [
					event("old", { at: 10_000 }),
					event("new", { at: 90_000 }),
					event("other-old", { at: 10_000, organisationId: "org_other" }),
				]);
				await store.setRetention(reader, 95_000);
				expect(await store.applyRetention(SYSTEM)).toBe(1);
				expect(await ids(store)).toEqual(["old", "new"]);
				expect((await store.query(other, {})).items).toEqual([]);
			} finally {
				await database.close();
			}
		});
	});
}

describe("the outbox in a producer's own transaction", () => {
	it("commits a producer's row and its audit events together on Postgres, or neither", async () => {
		const database = await PGlite.create();
		try {
			const driver = postgresClientDriver(database);
			await migrateAudit(driver);
			await database.query("CREATE TABLE secrets (id TEXT PRIMARY KEY)");

			await database.transaction(async (tx) => {
				await postgresClientDriver(tx).batch([
					sql("INSERT INTO secrets (id) VALUES (?)", "s1"),
					...auditOutboxStatements([event("created-s1")]),
				]);
			});
			await expect(
				database.transaction(async (tx) => {
					await postgresClientDriver(tx).batch([
						sql("INSERT INTO secrets (id) VALUES (?)", "s2"),
						...auditOutboxStatements([event("created-s2")]),
					]);
					throw new Error("the producer failed after writing");
				}),
			).rejects.toThrow("the producer failed");

			expect((await database.query("SELECT id FROM secrets")).rows).toEqual([{ id: "s1" }]);
			const outbox = createSqlAuditOutbox({ driver });
			expect(await outbox.pending(SYSTEM)).toBe(1);
		} finally {
			await database.close();
		}
	});

	it("commits a producer's row and its audit events in one SQLite batch, or neither", async () => {
		const { driver, close } = await nodeSqliteDatabase.open();
		try {
			await migrateAudit(driver);
			await driver.query("CREATE TABLE secrets (id TEXT PRIMARY KEY)");
			await driver.batch([
				sql("INSERT INTO secrets (id) VALUES (?)", "s1"),
				...auditOutboxStatements([event("created-s1")]),
			]);
			await expect(
				driver.batch([
					...auditOutboxStatements([event("created-s1-again")]),
					sql("INSERT INTO secrets (id) VALUES (?)", "s1"),
				]),
			).rejects.toThrow();
			const outbox = createSqlAuditOutbox({ driver });
			expect(await outbox.pending(SYSTEM)).toBe(1);
		} finally {
			await close();
		}
	});

	it("refuses a malformed event before any statement runs", () => {
		expect(() => auditOutboxStatements([{ ...event("x"), actor: undefined as never }])).toThrow(/actor/);
	});
});

describe("startAuditRelay", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("drains on a timer, backs off while the sink fails, and delivers every event once", async () => {
		vi.useFakeTimers();
		const outbox = createMemoryAuditOutbox();
		await outbox.append(SYSTEM, [event("a"), event("b")]);
		const delivered: string[] = [];
		let failures = 2;
		const sink: AuditSink = {
			async append(_ctx, events) {
				if (failures > 0) {
					failures -= 1;
					throw new Error("store down");
				}
				delivered.push(...events.map((row) => row.id));
			},
		};
		const errors: unknown[] = [];
		const relay = startAuditRelay({ outbox, sink, intervalMs: 100, onError: (error) => errors.push(error) });
		await vi.advanceTimersByTimeAsync(0);
		expect(errors).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(199);
		expect(errors).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(errors).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(400);
		expect(delivered).toEqual(["a", "b"]);

		await outbox.append(SYSTEM, [event("c")]);
		await vi.advanceTimersByTimeAsync(100);
		expect(delivered).toEqual(["a", "b", "c"]);
		await relay.stop();
		await outbox.append(SYSTEM, [event("d")]);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(delivered).toEqual(["a", "b", "c"]);
		expect(await relay.drainNow()).toBe(1);
		expect(delivered).toEqual(["a", "b", "c", "d"]);
	});

	it("waits in stop for a drainNow still in progress", async () => {
		const outbox = createMemoryAuditOutbox();
		let unblock: () => void = () => undefined;
		let blocking = false;
		const sink: AuditSink = {
			async append() {
				if (blocking)
					await new Promise<void>((resolve) => {
						unblock = resolve;
					});
			},
		};
		const relay = startAuditRelay({ outbox, sink, intervalMs: 60_000 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		blocking = true;
		await outbox.append(SYSTEM, [event("late")]);
		const manual = relay.drainNow();
		let stopped = false;
		const stopping = relay.stop().then(() => {
			stopped = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(stopped).toBe(false);
		unblock();
		await stopping;
		expect(await manual).toBe(1);
		expect(stopped).toBe(true);
	});
});

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createSqlAuditOutbox, createSqlAuditStore, migrateAudit } from "@harbour/audit/sql";
import {
	type AuditEventInput,
	type AuditStore,
	type CallContext,
	type SystemContext,
	systemContext,
} from "@harbour/contracts";
import type { SqlValue } from "@harbour/sql";
import { syncSqliteDriver } from "@harbour/sql/sqlite";
import { flakyAuditSink, registerAuditConformance } from "@harbour/testing/audit";
import { describe, expect, it } from "vitest";
import {
	migrateObjectAuditOutbox,
	type ObjectSqlLike,
	type OutboxedAudit,
	objectSqlDriver,
	outboxedAudit,
} from "../src/audit-outbox.ts";

/** A Durable Object's `ctx.storage.sql` and `transactionSync` over `node:sqlite`, refusing `BEGIN` as the object does. */
function objectSql(db: DatabaseSync) {
	const sql: ObjectSqlLike = {
		exec(query: string, ...bindings: SqlValue[]) {
			if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(query)) throw new Error(`refused: ${query}`);
			const statement = db.prepare(query);
			const values = bindings as SQLInputValue[];
			let rows: unknown[] = [];
			if (statement.columns().length > 0) rows = statement.all(...values);
			else statement.run(...values);
			return { toArray: () => rows };
		},
	};
	const transactionSync = <T>(work: () => T): T => {
		db.exec("BEGIN");
		try {
			const result = work();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	};
	return objectSqlDriver(sql, transactionSync);
}

const WORKER: SystemContext = systemContext("test");
const ORG = "org-1";
const admin: CallContext = { actor: { kind: "system", component: "test" }, organisationId: ORG };

function event(id: string): AuditEventInput {
	return {
		id,
		at: 1,
		source: "sandbox",
		type: "sandbox.lease.acquired",
		actor: { kind: "system", component: "test" },
		organisationId: ORG,
		data: {},
	};
}

/** Runs background work as `ctx.waitUntil` would, and lets a test wait for all of it. */
function backgrounds() {
	const running = new Set<Promise<unknown>>();
	return {
		background: (work: Promise<unknown>) => {
			running.add(work);
			void work.finally(() => running.delete(work));
		},
		settled: async () => {
			while (running.size > 0) await Promise.allSettled([...running]);
		},
	};
}

async function d1Store(): Promise<AuditStore> {
	const driver = syncSqliteDriver(new DatabaseSync(":memory:"));
	await migrateAudit(driver);
	return createSqlAuditStore({ driver });
}

async function outboxed(
	store: AuditStore,
	db = new DatabaseSync(":memory:"),
	extra: Partial<Parameters<typeof outboxedAudit>[0]> = {},
) {
	const driver = objectSql(db);
	await migrateObjectAuditOutbox(driver);
	const work = backgrounds();
	const audit: OutboxedAudit = outboxedAudit({
		store,
		driver,
		background: work.background,
		onError: () => undefined,
		...extra,
	});
	return { audit, db, ...work };
}

// The contract's suite with every append going through the object's outbox; reads see what was appended before them.
registerAuditConformance(
	{ describe, expect, it },
	"audit store behind the stack object's outbox",
	async (deps, use) => {
		const driver = syncSqliteDriver(new DatabaseSync(":memory:"));
		await migrateAudit(driver);
		const store = createSqlAuditStore({ driver, clock: deps.clock, access: deps.access });
		const objectDriver = objectSql(new DatabaseSync(":memory:"));
		await migrateObjectAuditOutbox(objectDriver);
		const audit = outboxedAudit({ store, driver: objectDriver, clock: deps.clock, background: () => undefined });
		// The suite's own outbox, over the same kind of driver: the object's SQLite.
		const outboxDriver = objectSql(new DatabaseSync(":memory:"));
		await migrateObjectAuditOutbox(outboxDriver);
		await use({
			store: audit,
			outbox: createSqlAuditOutbox({ driver: outboxDriver, clock: deps.clock }),
			flakySink: flakyAuditSink,
		});
	},
	{ projectAccess: true },
);

describe("the stack object's audit outbox", () => {
	it("answers an append without waiting on the store, and drains to it in the background", async () => {
		const target = await d1Store();
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slow: AuditStore = {
			...target,
			append: async (ctx, events) => {
				await held;
				await target.append(ctx, events);
			},
		};
		const { audit, settled } = await outboxed(slow);
		await audit.append(WORKER, [event("e1")]);
		expect(await audit.outbox.pending(WORKER)).toBe(1);
		release();
		await settled();
		expect(await audit.outbox.pending(WORKER)).toBe(0);
		expect((await target.get(admin, "e1")).id).toBe("e1");
	});

	it("keeps events queued while the store fails, retries, and stores each once", async () => {
		const target = await d1Store();
		let failures = 2;
		const flaky: AuditStore = {
			...target,
			append: async (ctx, events) => {
				if (failures-- > 0) throw new Error("D1 is down");
				await target.append(ctx, events);
			},
		};
		const timers: (() => void)[] = [];
		const waits: number[] = [];
		const { audit, settled } = await outboxed(flaky, undefined, {
			setTimer: (run, ms) => {
				waits.push(ms);
				timers.push(run);
			},
		});
		await audit.append(WORKER, [event("e1"), event("e2")]);
		await settled();
		expect(await audit.outbox.pending(WORKER)).toBe(2);
		timers.shift()?.();
		await settled();
		expect(await audit.outbox.pending(WORKER)).toBe(2);
		timers.shift()?.();
		await settled();
		expect(await audit.outbox.pending(WORKER)).toBe(0);
		expect(waits).toEqual([1_000, 2_000]);
		const page = await target.query(admin, {});
		expect(page.items.map((item) => item.id)).toEqual(["e1", "e2"]);
	});

	it("drains what an earlier instance queued when the object starts again", async () => {
		const target = await d1Store();
		const down: AuditStore = {
			...target,
			append: async () => {
				throw new Error("D1 is down");
			},
		};
		const db = new DatabaseSync(":memory:");
		const first = await outboxed(down, db, { setTimer: () => undefined });
		await first.audit.append(WORKER, [event("e1")]);
		await first.settled();

		// The object restarted: a new outbox over the same SQLite, as `createStack` builds it, drains on start.
		const second = await outboxed(target, db);
		second.audit.kick();
		await second.settled();
		expect(await second.audit.outbox.pending(WORKER)).toBe(0);
		expect((await target.get(admin, "e1")).id).toBe("e1");
	});

	it("reads what was appended before it, even before the background drain", async () => {
		const target = await d1Store();
		const driver = objectSql(new DatabaseSync(":memory:"));
		await migrateObjectAuditOutbox(driver);
		// Background work never runs: only the read's own drain can take the event to the store.
		const idle = outboxedAudit({ store: target, driver, background: () => undefined });
		await idle.append(WORKER, [event("e1")]);
		expect((await idle.get(admin, "e1")).id).toBe("e1");
		expect((await idle.query(admin, {})).items).toHaveLength(1);
	});

	it("fails a read, rather than answer without queued events, while the store refuses writes", async () => {
		const target = await d1Store();
		let writable = false;
		const readOnly: AuditStore = {
			...target,
			append: async (ctx, events) => {
				if (!writable) throw new Error("D1 refuses writes");
				await target.append(ctx, events);
			},
		};
		const driver = objectSql(new DatabaseSync(":memory:"));
		await migrateObjectAuditOutbox(driver);
		const audit = outboxedAudit({
			store: readOnly,
			driver,
			background: () => undefined,
			onError: () => undefined,
			setTimer: () => undefined,
		});
		await audit.append(WORKER, [event("e1")]);
		await expect(audit.get(admin, "e1")).rejects.toMatchObject({ code: "unavailable" });
		await expect(audit.query(admin, {})).rejects.toMatchObject({ code: "unavailable" });
		await expect(audit.applyRetention(WORKER)).rejects.toMatchObject({ code: "unavailable" });
		expect(await audit.outbox.pending(WORKER)).toBe(1);
		writable = true;
		expect((await audit.get(admin, "e1")).id).toBe("e1");
	});

	it("queues a refused append's access.denied, and drains it", async () => {
		const target = await d1Store();
		const { audit, settled } = await outboxed(target);
		const person = { actor: { kind: "human", userId: "user-1" }, organisationId: ORG } as const;
		await expect(audit.append(person as unknown as SystemContext, [event("forged")])).rejects.toMatchObject({
			code: "forbidden",
		});
		await settled();
		const page = await target.query(admin, { type: "access.denied" });
		expect(page.items).toHaveLength(1);
		await expect(target.get(admin, "forged")).rejects.toMatchObject({ code: "not_found" });
	});
});

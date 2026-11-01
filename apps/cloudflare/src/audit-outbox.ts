/**
 * The stack's audit appends, off the request's critical path (#17, part B). As the audit contract intends
 * (packages/audit/CONTRACT.md: components put events in an outbox, a relay drains it to the store), every component's
 * `append` queues its events in an outbox in the stack object's own SQLite, which is durable and local, and returns.
 * A drain to the D1 store then runs in the background (`ctx.waitUntil`), so a session create, a lease or a sign-in no
 * longer waits on a D1 write, about 15 ms each from the object.
 *
 * No event is lost: an event leaves the outbox only once the store took it, and the store is idempotent by organisation
 * and id, so a drain retried after a lost answer adds no row. A failed drain is retried with backoff while the object
 * lives, and again when it starts and on its alarm. Reads stay read-your-writes: `query`, `get` and `applyRetention`
 * drain what's queued first, which costs one local `SELECT` when nothing is. If that drain fails they fail too
 * (`unavailable`), rather than answer from a store that is missing events appended before them.
 *
 * `seq` is still the store's, given as events reach it; each drain sends in queue order, so events from this object
 * keep their order.
 *
 * An append queues on the next turn of the event loop, never in the caller's own microtasks. The session runtime's
 * transactions (`ctx.storage.transaction`) make every `sql.exec` part of them while their callback runs, and those
 * callbacks run to their end in microtasks (targets/cloudflare/runtime/src/database.ts). A queue write from work
 * interleaved in those microtasks would join such a transaction and go with it if it rolled back; on a new turn, none
 * is open.
 */
import { auditSchema, createSqlAuditOutbox } from "@kantel/audit/sql";
import {
	type AuditOutbox,
	type AuditStore,
	type Clock,
	KantelError,
	type SystemContext,
	systemContext,
} from "@kantel/contracts";
import type { SqlDriver, SqlRow, SqlStatement, SqlValue } from "@kantel/sql";

/** The relay drains as itself, as `@kantel/audit/sql`'s does. */
const RELAY: SystemContext = systemContext("audit.relay");
/** The first retry after a failed drain, and the longest wait between retries. */
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

/** The part of a Durable Object's `ctx.storage.sql` the driver uses. */
export interface ObjectSqlLike {
	exec(query: string, ...bindings: SqlValue[]): { toArray(): unknown[] };
}

/**
 * A `SqlDriver` over the object's own SQLite: `exec` for a statement, and `transactionSync` for a batch, since Durable
 * Object SQL refuses `BEGIN`.
 */
export function objectSqlDriver(sql: ObjectSqlLike, transactionSync: <T>(work: () => T) => T): SqlDriver {
	return {
		dialect: "sqlite",
		async query<Row extends SqlRow>(text: string, params: readonly SqlValue[] = []): Promise<Row[]> {
			return sql.exec(text, ...params).toArray() as Row[];
		},
		async batch(statements: readonly SqlStatement[]): Promise<void> {
			if (statements.length === 0) return;
			transactionSync(() => {
				for (const statement of statements) sql.exec(statement.sql, ...(statement.params ?? [])).toArray();
			});
		},
	};
}

/** Creates the outbox's table in the object's SQLite if it is missing; only that table, not the store's. */
export async function migrateObjectAuditOutbox(driver: SqlDriver): Promise<void> {
	await driver.batch(
		auditSchema("sqlite")
			.filter((statement) => /\baudit_outbox\b/.test(statement))
			.map((statement) => ({ sql: statement })),
	);
}

export interface OutboxedAuditOptions {
	/** Where events end up: the D1 store, which every read goes to. */
	readonly store: AuditStore;
	/** The object's SQLite (`objectSqlDriver`), migrated with `migrateObjectAuditOutbox`. */
	readonly driver: SqlDriver;
	/** Keeps the object alive for background work: `ctx.waitUntil`. */
	readonly background: (work: Promise<unknown>) => void;
	readonly onError?: (error: unknown) => void;
	/** Stamps the outbox's own refusals (`access.denied`), as the store's clock does. */
	readonly clock?: Clock;
	/** For tests: how retries wait. */
	readonly setTimer?: (run: () => void, ms: number) => void;
}

/** Resolves on a new turn of the event loop, after every microtask queued now. */
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export interface OutboxedAudit extends AuditStore {
	readonly outbox: AuditOutbox;
	/** Sends everything queued to the store now; rejects if the store refuses. */
	drain(): Promise<number>;
	/** Starts a drain in the background, retried with backoff while it fails. */
	kick(): void;
}

export function outboxedAudit(options: OutboxedAuditOptions): OutboxedAudit {
	const { store, background } = options;
	const outbox = createSqlAuditOutbox({
		driver: options.driver,
		...(options.clock === undefined ? {} : { clock: options.clock }),
	});
	const onError = options.onError ?? ((error: unknown) => console.error("harbour: draining the audit outbox", error));
	const setTimer = options.setTimer ?? ((run: () => void, ms: number) => void setTimeout(run, ms));
	let retryMs = 0;
	let retrying = false;

	// Drains from one outbox run one at a time (`createSqlAuditOutbox`), so a read's drain waits for one in flight.
	const drain = () => outbox.drain(RELAY, store);

	function kick(): void {
		background(
			drain().then(
				() => {
					retryMs = 0;
				},
				(error: unknown) => {
					onError(error);
					if (retrying) return;
					retrying = true;
					retryMs = retryMs === 0 ? FIRST_RETRY_MS : Math.min(retryMs * 2, MAX_RETRY_MS);
					setTimer(() => {
						retrying = false;
						kick();
					}, retryMs);
				},
			),
		);
	}

	/** Before a read: what's queued reaches the store first, or the read fails. A background retry is already set. */
	async function caughtUp(): Promise<void> {
		try {
			await drain();
		} catch (error) {
			onError(error);
			kick();
			throw new KantelError("unavailable", "The audit store is behind: queued events could not be sent to it");
		}
	}

	return {
		outbox,
		drain,
		kick,
		// Worker calls, as the store's: the outbox checks `requireSystem` and queues a refusal as `access.denied`.
		async append(ctx, events) {
			try {
				await nextTurn();
				await outbox.append(ctx, events);
			} finally {
				// Also after a refusal: the outbox queued its `access.denied`.
				kick();
			}
		},
		async query(ctx, query, page) {
			await caughtUp();
			return store.query(ctx, query, page);
		},
		async get(ctx, eventId) {
			await caughtUp();
			return store.get(ctx, eventId);
		},
		setRetention: (ctx, retentionMs) => store.setRetention(ctx, retentionMs),
		async applyRetention(ctx) {
			await caughtUp();
			return store.applyRetention(ctx);
		},
	};
}

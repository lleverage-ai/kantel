/**
 * Usage analytics on Cloudflare (docs/site/src/content/docs/api/results-and-usage.md): the model gateway writes one
 * row per call to a ledger in the stack object's own SQLite, which is local and durable, and a shipper copies it to
 * `usage_calls` in D1, the record of truth, in the background (`ctx.waitUntil`), as the audit outbox does
 * (`src/audit-outbox.ts`).
 *
 * - A write goes on the next turn of the event loop, so it never joins a runtime transaction that is open in the
 *   caller's microtasks (see `audit-outbox.ts`).
 * - The object is the ledger's one writer, so rows go in `seq` order and the shipper needs no settle time.
 * - A failed shipment is retried with backoff while the object lives, and again at start; D1 ignores rows it has, so a
 *   resend adds nothing.
 */
import type { UsageRecord, UsageWriter } from "@kantel/contracts";
import type { SqlDriver } from "@kantel/sql";
import { createUsageShipper } from "@kantel/usage/shipper";
import { createSqlUsageLedger, migrateUsage, sqlUsageSink } from "@kantel/usage/sql";

/** The shipper's name, which keys its cursor in the object's ledger. */
export const D1_USAGE_SINK = "d1";
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export interface ObjectUsageOptions {
	/** The object's SQLite (`objectSqlDriver`), for the ledger. */
	readonly ledger: SqlDriver;
	/** D1, which holds `usage_calls` for queries. */
	readonly store: SqlDriver;
	/** Keeps the object alive for background work: `ctx.waitUntil`. */
	readonly background: (work: Promise<unknown>) => void;
	readonly onError?: (error: unknown) => void;
	/** For tests: how retries wait. */
	readonly setTimer?: (run: () => void, ms: number) => void;
}

export interface ObjectUsage {
	/** The gateway's writer: the ledger, then a shipment kicked off. */
	readonly writer: UsageWriter;
	/** Starts a shipment in the background, retried with backoff while it fails. */
	kick(): void;
	/** Ships everything in the ledger now. */
	ship(): Promise<number>;
}

/** Migrates the ledger and D1's table, and ships what an earlier instance of the object left. */
export async function objectUsage(options: ObjectUsageOptions): Promise<ObjectUsage> {
	await migrateUsage(options.ledger);
	await migrateUsage(options.store);
	const ledger = createSqlUsageLedger({ driver: options.ledger });
	const shipper = createUsageShipper({ ledger, sink: sqlUsageSink(options.store), name: D1_USAGE_SINK, settleMs: 0 });
	const onError = options.onError ?? ((error: unknown) => console.error("kantel: shipping usage to D1", error));
	const setTimer = options.setTimer ?? ((run: () => void, ms: number) => void setTimeout(run, ms));
	let retryMs = 0;
	let retrying = false;

	function kick(): void {
		options.background(
			shipper.ship().then(
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

	kick();
	return {
		writer: {
			async record(record: UsageRecord) {
				await nextTurn();
				await ledger.record(record);
				kick();
			},
		},
		kick,
		ship: () => shipper.ship(),
	};
}

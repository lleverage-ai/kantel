/**
 * Ships the usage ledger to one sink in batches (docs/usage-analytics.md, "Write path"), off every session's path.
 *
 * Each pass reads entries past the sink's cursor, oldest first, that were recorded at least `settleMs` ago, so an
 * insert that commits after a later one (Postgres) is never stepped over. Before sending it marks the batch's last
 * `seq` as pending, so a batch that fails is sent again with the same entries and the same `batchId`, which a sink that
 * deduplicates by batch (ClickHouse) drops; then it advances the cursor. Passes run one at a time.
 */
import type { UsageSink } from "@kantel/contracts";
import type { UsageLedger } from "./sql.ts";

export interface UsageShipperOptions {
	readonly ledger: UsageLedger;
	readonly sink: UsageSink;
	/** The sink's name, which keys its cursor: `clickhouse`, `d1`. */
	readonly name: string;
	/** Most records per batch. Default 1,000. */
	readonly batchSize?: number;
	/**
	 * How long an entry waits in the ledger before it is shipped. Default 10 s; 0 where one writer inserts in order (a
	 * Durable Object's SQLite).
	 */
	readonly settleMs?: number;
	readonly now?: () => number;
}

export interface UsageShipper {
	/** Ships everything settled, batch by batch; resolves how many records went. Rejects with the first failure. */
	ship(): Promise<number>;
}

export const DEFAULT_USAGE_BATCH_SIZE = 1_000;
export const DEFAULT_USAGE_SETTLE_MS = 10_000;

export function createUsageShipper(options: UsageShipperOptions): UsageShipper {
	const { ledger, sink, name } = options;
	const batchSize = options.batchSize ?? DEFAULT_USAGE_BATCH_SIZE;
	const settleMs = options.settleMs ?? DEFAULT_USAGE_SETTLE_MS;
	const now = options.now ?? Date.now;
	let running: Promise<number> | undefined;
	/** A pass asked for while one ran, which may have read before the newest entries: it runs next. */
	let next: Promise<number> | undefined;

	async function pass(): Promise<number> {
		let shipped = 0;
		for (;;) {
			const cursor = await ledger.cursor(name);
			const entries = await ledger.read({
				afterSeq: cursor.afterSeq,
				...(cursor.pendingToSeq === undefined ? {} : { toSeq: cursor.pendingToSeq }),
				// A pending batch goes again whole, settled or not.
				recordedBefore: cursor.pendingToSeq === undefined ? now() - settleMs : Number.MAX_SAFE_INTEGER,
				limit: batchSize,
			});
			const last = entries.at(-1);
			if (last === undefined) {
				// A pending batch whose rows are all gone (none ever are; the ledger is append-only) is done.
				if (cursor.pendingToSeq !== undefined) await ledger.advance(name, cursor.pendingToSeq);
				return shipped;
			}
			const toSeq = cursor.pendingToSeq ?? last.seq;
			if (cursor.pendingToSeq === undefined) await ledger.pending(name, toSeq);
			await sink.write(
				entries.map((entry) => entry.record),
				`${name}:${cursor.afterSeq}-${toSeq}`,
			);
			await ledger.advance(name, toSeq);
			shipped += entries.length;
			if (entries.length < batchSize) return shipped;
		}
	}

	return {
		ship() {
			const start = (): Promise<number> => {
				const started = pass().finally(() => {
					if (running === started) running = undefined;
				});
				running = started;
				return started;
			};
			if (running === undefined) return start();
			if (next === undefined) {
				const queued = running
					.catch(() => 0)
					.then(() => {
						next = undefined;
						return start();
					});
				next = queued;
			}
			return next;
		},
	};
}

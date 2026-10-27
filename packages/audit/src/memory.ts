import {
	type AuditEvent,
	type AuditEventInput,
	type AuditOutbox,
	type AuditQuery,
	type AuditSink,
	type AuditStore,
	type CallContext,
	type Clock,
	HarbourError,
	type OrganisationId,
	type Page,
	type PageRequest,
	systemClock,
} from "@harbour/contracts";
import { assertValidAuditEvent, matchesQuery } from "./index.ts";

export interface MemoryAuditStoreOptions {
	readonly clock?: Clock;
	/** Retention for organisations that have not set their own. Default: keep rows forever. */
	readonly retentionMs?: number;
}

/** The most events `drain` hands a sink in one `append`. */
export const OUTBOX_BATCH_SIZE = 100;

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;

function forbidAgent(ctx: CallContext, what: string): void {
	if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", `An agent cannot ${what}`);
}

function assertRetention(retentionMs: number): void {
	if (!Number.isInteger(retentionMs) || retentionMs < 1) {
		throw new HarbourError("invalid", "Retention must be a positive whole number of milliseconds");
	}
}

/** The `seq` a cursor names; a cursor is the last `seq` of the previous page. */
function cursorSeq(cursor: string): number {
	const seq = Number(cursor);
	if (cursor.length === 0 || !Number.isInteger(seq) || seq < 0)
		throw new HarbourError("invalid", "Unknown page cursor");
	return seq;
}

/**
 * The reference `AuditStore`: rows in one array in `seq` order, indexed by id. Appending an id already stored keeps the
 * first row. Only `applyRetention` removes rows.
 */
export function createMemoryAuditStore(options: MemoryAuditStoreOptions = {}): AuditStore {
	const clock = options.clock ?? systemClock;
	if (options.retentionMs !== undefined) assertRetention(options.retentionMs);
	const defaultRetentionMs = options.retentionMs;

	let rows: AuditEvent[] = [];
	/** Rows by organisation and id: one organisation's event can never shadow another's that reuses an id. */
	const byId = new Map<string, AuditEvent>();
	const keyOf = (organisationId: OrganisationId, id: string) => `${organisationId}\u0000${id}`;
	const retention = new Map<OrganisationId, number>();
	let lastSeq = 0;

	return {
		async append(events: readonly AuditEventInput[]): Promise<void> {
			for (const event of events) assertValidAuditEvent(event);
			const recordedAt = clock.now();
			for (const event of events) {
				if (byId.has(keyOf(event.organisationId, event.id))) continue;
				lastSeq += 1;
				const row: AuditEvent = { ...structuredClone(event), seq: lastSeq, recordedAt };
				rows.push(row);
				byId.set(keyOf(row.organisationId, row.id), row);
			}
		},

		async query(ctx: CallContext, query: AuditQuery, page?: PageRequest): Promise<Page<AuditEvent>> {
			forbidAgent(ctx, "read the audit log");
			const limit = Math.max(1, Math.min(page?.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT));
			const after = page?.cursor === undefined ? undefined : cursorSeq(page.cursor);
			const newestFirst = query.newestFirst === true;
			const matching = rows.filter(
				(row) =>
					row.organisationId === ctx.organisationId &&
					matchesQuery(row, query) &&
					(after === undefined || (newestFirst ? row.seq < after : row.seq > after)),
			);
			if (newestFirst) matching.reverse();
			const items = matching.slice(0, limit).map((row) => structuredClone(row));
			const last = items.at(-1);
			return matching.length > limit && last !== undefined ? { items, nextCursor: String(last.seq) } : { items };
		},

		async get(ctx: CallContext, eventId: string): Promise<AuditEvent> {
			forbidAgent(ctx, "read the audit log");
			const row = byId.get(keyOf(ctx.organisationId, eventId));
			if (row === undefined) {
				throw new HarbourError("not_found", `No audit event ${eventId}`);
			}
			return structuredClone(row);
		},

		async setRetention(ctx: CallContext, retentionMs: number): Promise<void> {
			forbidAgent(ctx, "set audit retention");
			assertRetention(retentionMs);
			retention.set(ctx.organisationId, retentionMs);
		},

		async applyRetention(): Promise<number> {
			const now = clock.now();
			const kept: AuditEvent[] = [];
			let removed = 0;
			for (const row of rows) {
				const retentionMs = retention.get(row.organisationId) ?? defaultRetentionMs;
				if (retentionMs !== undefined && row.at < now - retentionMs) {
					byId.delete(keyOf(row.organisationId, row.id));
					removed += 1;
				} else {
					kept.push(row);
				}
			}
			rows = kept;
			return removed;
		},
	};
}

/**
 * The reference `AuditOutbox`: a queue in memory. `drain` sends batches of at most `OUTBOX_BATCH_SIZE` in order and
 * removes a batch only once the sink has taken it. Drains run one at a time. An event id already queued is queued
 * once; events are validated on the way in so one malformed event cannot block the queue.
 */
export function createMemoryAuditOutbox(): AuditOutbox {
	let queue: AuditEventInput[] = [];
	const queuedIds = new Set<string>();
	let draining: Promise<unknown> = Promise.resolve();

	async function drainNow(sink: AuditSink): Promise<number> {
		let sent = 0;
		while (queue.length > 0) {
			const batch = queue.slice(0, OUTBOX_BATCH_SIZE);
			await sink.append(batch);
			const delivered = new Set(batch);
			queue = queue.filter((event) => !delivered.has(event));
			for (const event of batch) queuedIds.delete(event.id);
			sent += batch.length;
		}
		return sent;
	}

	return {
		async append(events: readonly AuditEventInput[]): Promise<void> {
			for (const event of events) assertValidAuditEvent(event);
			for (const event of events) {
				if (queuedIds.has(event.id)) continue;
				queuedIds.add(event.id);
				queue.push(structuredClone(event));
			}
		},

		drain(sink: AuditSink): Promise<number> {
			const run = draining.then(() => drainNow(sink));
			draining = run.catch(() => undefined);
			return run;
		},

		async pending(): Promise<number> {
			return queue.length;
		},
	};
}

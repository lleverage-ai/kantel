/**
 * The Cloudflare session runtime: the session store and every session's Pi Durable storage in a Durable Object's
 * SQLite (through `DurableObjectSessionDatabase`), and the core a session Durable Object class wraps. Portable to
 * Workers: no Node modules and no workers-types at runtime.
 */
import { type Authenticator, type Clock, type SessionId, systemClock } from "@kantel/contracts";
import { createSessionRuntime, type SessionRuntimeOptions, type SessionRuntimeService } from "@kantel/runtime/core";
import { callbackHostHandlers, createSessionApi, type SessionApi, type SessionApiOptions } from "@kantel/runtime/http";
import { archiveSqlPiStorage, createSqlSessionStore, sqlPiStorage } from "@kantel/runtime/sql";
import type { SessionStore } from "@kantel/runtime/store";
import { DurableObjectSessionDatabase, type DurableObjectTransaction, type SqlStorageLike } from "./database.ts";

export {
	DurableObjectSessionDatabase,
	type DurableObjectSessionDatabaseOptions,
	type DurableObjectTransaction,
	type SqlCursorLike,
	type SqlStorageLike,
	type SqlValue,
} from "./database.ts";

export interface SessionRuntimeDurableObjectCoreOptions
	extends Omit<SessionRuntimeOptions, "store" | "storage" | "onWakeAt"> {
	/** The object's `ctx.storage.sql`. */
	readonly sql: SqlStorageLike;
	/** The object's async transaction: `(work) => ctx.storage.transaction(() => work())`. See `./database.ts`. */
	readonly transaction: DurableObjectTransaction;
	/** The object's `ctx.storage.setAlarm`. */
	readonly setAlarm: (scheduledTime: number) => Promise<void>;
	/**
	 * The object's `ctx.storage.getAlarm`, so an alarm armed by an earlier instance of the object is never moved later.
	 * Without it the core knows only the alarms it armed itself.
	 */
	readonly getAlarm?: () => Promise<number | null>;
	/** Who is calling the session API: the deployment's authenticator. */
	readonly authenticator: Authenticator;
	/** The rest of the session API's options. Its clock defaults to the runtime's. */
	readonly api?: Omit<
		SessionApiOptions,
		"runtime" | "directory" | "profiles" | "hostTools" | "hosts" | "authenticator"
	>;
	/** Prefix of the store's tables. Default `harbour_`. */
	readonly prefix?: string;
	/** Told when arming the alarm failed. Default: ignored; the next wake, request or alarm arms it again. */
	readonly onAlarmError?: (error: unknown) => void;
	/**
	 * While a session is running, how long until the alarm fires again, so an object evicted mid-run is brought back to
	 * resume it. Default 30 s.
	 */
	readonly watchdogMs?: number;
	/**
	 * The backfill of closed sessions whose Pi tables are still in the object's SQLite (closed before archiving shipped,
	 * #216, or whose archive failed): each alarm archives up to `batch` of them, and while a batch comes back full the
	 * core arms the alarm again `intervalMs` later. Starting the object only arms the first alarm; it archives nothing.
	 * Default 5 sessions every 2 s; `false` turns it off.
	 */
	readonly archiveSweep?: false | { readonly batch?: number; readonly intervalMs?: number };
}

const DEFAULT_WATCHDOG_MS = 30_000;
const DEFAULT_ARCHIVE_SWEEP_BATCH = 5;
const DEFAULT_ARCHIVE_SWEEP_INTERVAL_MS = 2_000;

/** A Pi Durable table set's `durable_schema` table, under the session's prefix (`piPrefixFor`). */
const PI_SCHEMA_TABLE = /^pi_([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})_durable_schema$/;

/** The sessions with Pi tables in the object's SQLite, open or closed, from its schema. */
export async function sessionsWithPiTables(database: DurableObjectSessionDatabase): Promise<SessionId[]> {
	const rows = await database.all<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'pi_*_durable_schema' ORDER BY name",
	);
	const ids: SessionId[] = [];
	for (const { name } of rows) {
		const parts = PI_SCHEMA_TABLE.exec(name);
		if (parts !== null) ids.push(parts.slice(1).join("-") as SessionId);
	}
	return ids;
}

/**
 * Everything a session Durable Object needs, so its class (owned by the deployment) is a thin wrapper: construct this
 * in the constructor over `ctx.storage`, hold the object's input with `ctx.blockConcurrencyWhile(() => core.ready)`,
 * and forward `fetch` and `alarm`.
 *
 * Building it opens the store (applying its migrations) and resumes every session an earlier instance of the object
 * left mid-run or whose sleep has fallen due; `ready` settles when that is done. The runtime tells the core of each
 * session's next wake, and the core arms the object's alarm at the earliest one, never moving an alarm already armed
 * earlier. When the alarm fires, `alarm()` resumes what is due and arms the alarm for the next wake still to come.
 * Host registrations made through the API are durable (kept in the store with their callback), so they outlive the
 * object's eviction.
 */
export class SessionRuntimeDurableObjectCore {
	readonly database: DurableObjectSessionDatabase;
	/** The runtime, once the store is open and what was due has been resumed. */
	readonly ready: Promise<SessionRuntimeService>;
	readonly #clock: Clock;
	readonly #setAlarm: (scheduledTime: number) => Promise<void>;
	readonly #getAlarm: (() => Promise<number | null>) | undefined;
	readonly #onAlarmError: ((error: unknown) => void) | undefined;
	readonly #watchdogMs: number;
	readonly #archiveSweep: { readonly batch: number; readonly intervalMs: number } | undefined;
	#store: SessionStore | undefined;
	#api: SessionApi | undefined;
	/** The alarm this instance last armed; cleared when it fires. */
	#armedAt: number | undefined;
	/** `alarm()` is running: the alarm that fired is spent, whatever `getAlarm` says of it. */
	#firing = false;
	/**
	 * The earliest wake not armed because an earlier alarm was. The next `alarm()` arms it, in case its session's stored
	 * wake had not landed when that alarm read the store.
	 */
	#skipped: number | undefined;
	/** Alarm arming, in order. */
	#arming: Promise<void> = Promise.resolve();
	#closed = false;

	constructor(options: SessionRuntimeDurableObjectCoreOptions) {
		this.database = new DurableObjectSessionDatabase({ sql: options.sql, transaction: options.transaction });
		this.#clock = options.clock ?? systemClock;
		this.#setAlarm = options.setAlarm;
		this.#getAlarm = options.getAlarm;
		this.#onAlarmError = options.onAlarmError;
		const watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
		// Zero or less would fire the alarm again at once for as long as a run lasts.
		if (!Number.isFinite(watchdogMs) || watchdogMs <= 0) {
			throw new RangeError(`watchdogMs must be a positive number of milliseconds, not ${watchdogMs}`);
		}
		this.#watchdogMs = watchdogMs;
		if (options.archiveSweep !== false) {
			const batch = options.archiveSweep?.batch ?? DEFAULT_ARCHIVE_SWEEP_BATCH;
			const intervalMs = options.archiveSweep?.intervalMs ?? DEFAULT_ARCHIVE_SWEEP_INTERVAL_MS;
			if (!Number.isInteger(batch) || batch <= 0) {
				throw new RangeError(`archiveSweep.batch must be a positive whole number, not ${batch}`);
			}
			if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
				throw new RangeError(`archiveSweep.intervalMs must be a positive number of milliseconds, not ${intervalMs}`);
			}
			this.#archiveSweep = { batch, intervalMs };
		}
		this.ready = this.#start(options);
		// Whoever awaits `ready` (fetch, alarm, the object's constructor) sees a failure; this only keeps it handled.
		this.ready.catch(() => undefined);
	}

	async #start(options: SessionRuntimeDurableObjectCoreOptions): Promise<SessionRuntimeService> {
		const {
			sql: _sql,
			transaction: _transaction,
			setAlarm: _setAlarm,
			getAlarm: _getAlarm,
			onAlarmError: _onAlarmError,
			watchdogMs: _watchdogMs,
			archiveSweep: _archiveSweep,
			authenticator,
			api,
			prefix,
			...runtimeOptions
		} = options;
		const store = await createSqlSessionStore(this.database, prefix === undefined ? {} : { prefix });
		this.#store = store;
		const service = createSessionRuntime({
			...runtimeOptions,
			hostHandler:
				runtimeOptions.hostHandler ??
				callbackHostHandlers({
					clock: this.#clock,
					...(api?.fetch === undefined ? {} : { fetch: api.fetch }),
					...(api?.callbackTimeoutMs === undefined ? {} : { timeoutMs: api.callbackTimeoutMs }),
				}),
			store,
			storage: (session) => sqlPiStorage(this.database, session.id),
			// A closed session's tables are archived and dropped, so the object's schema grows with its open sessions (#216).
			archive: runtimeOptions.archive ?? ((session) => archiveSqlPiStorage(this.database, session.id)),
			unarchived: runtimeOptions.unarchived ?? (() => sessionsWithPiTables(this.database)),
			onWakeAt: (at) => this.#arm(at),
		});
		this.#api = createSessionApi({
			clock: this.#clock,
			...api,
			runtime: service.runtime,
			directory: service.directory,
			profiles: service.profiles,
			hostTools: service.hostTools,
			hosts: service.hosts,
			authenticator,
		});
		await service.resume();
		// Closed sessions' tables are archived from the alarm, a batch at a time, never here: the object's input waits for this.
		await this.#armNext(undefined, this.#archiveSweep !== undefined && (await this.#archiveBacklog(store)));
		return service;
	}

	/** Serves the session API (`createSessionApi`), once `ready`. */
	async fetch(request: Request): Promise<Response> {
		await this.ready;
		return this.#api!.fetch(request);
	}

	/**
	 * The object's alarm handler: resumes every session whose wake is due, archives a batch of closed sessions' tables
	 * (`archiveSweep`), then arms the alarm for the next wake, or the next batch while a batch comes back full.
	 */
	async alarm(): Promise<void> {
		const service = await this.ready;
		this.#armedAt = undefined;
		this.#firing = true;
		const skipped = this.#skipped;
		this.#skipped = undefined;
		try {
			await service.resume();
			const sweep = this.#archiveSweep;
			const more = sweep !== undefined && (await service.sweepArchive(sweep.batch)) >= sweep.batch;
			await this.#armNext(skipped, more);
		} finally {
			this.#firing = false;
		}
	}

	/** Ends the API's streams and closes every session's Harness; their work stays in storage. For tests and shutdown. */
	async close(): Promise<void> {
		this.#closed = true;
		const service = await this.ready.catch(() => undefined);
		await this.#api?.close();
		await service?.close();
		await this.#arming;
		await this.database.close();
	}

	/** Whether a session the store doesn't count as open still has its Pi tables: the archive backfill has work. */
	async #archiveBacklog(store: SessionStore): Promise<boolean> {
		const withTables = await sessionsWithPiTables(this.database);
		if (withTables.length === 0) return false;
		const notClosed = new Set((await store.openSessions()).map((session) => session.record.id));
		return withTables.some((id) => !notClosed.has(id));
	}

	/**
	 * Arms the alarm for the earliest stored wake still to come (a session not open in this instance has no timer here
	 * and tells the core nothing until it opens), or for `skipped` if that is earlier. While a session's wake is due (it
	 * is running), no later than the watchdog, so an object evicted mid-run comes back to resume it; the alarm that
	 * brought it here is spent. With `sweep`, no later than `archiveSweep.intervalMs`, for the next batch of the archive
	 * backfill. Waits for every arming queued before it.
	 */
	async #armNext(skipped?: number, sweep = false): Promise<void> {
		const now = this.#clock.now();
		const store = this.#store!;
		const running = (await store.wakeable(now)).length > 0;
		const candidates = [
			await store.nextWake(now),
			skipped,
			running ? now + this.#watchdogMs : undefined,
			sweep && this.#archiveSweep !== undefined ? now + this.#archiveSweep.intervalMs : undefined,
		].filter((at): at is number => at !== undefined);
		if (candidates.length > 0) this.#arm(Math.min(...candidates));
		await this.#arming;
	}

	/** Arms the alarm at `at`, unless one is armed no later. Queued behind any open transaction, so none rolls it back. */
	#arm(at: number): void {
		if (this.#closed) return;
		this.#arming = this.#arming
			.then(() =>
				this.database.outsideTransactions(async () => {
					if (this.#closed) return;
					const armed = this.#getAlarm === undefined ? this.#armedAt : ((await this.#getAlarm()) ?? undefined);
					const spent = this.#firing && armed !== undefined && armed <= this.#clock.now();
					if (armed !== undefined && armed <= at && !spent) {
						this.#skipped = Math.min(this.#skipped ?? at, at);
						return;
					}
					await this.#setAlarm(at);
					this.#armedAt = at;
				}),
			)
			.catch((error: unknown) => this.#onAlarmError?.(error));
	}
}

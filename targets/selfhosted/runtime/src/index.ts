/**
 * The self-hosted session runtime: `createSessionRuntime` with its directory (`createSqlSessionStore`) and every
 * session's Pi Durable storage (`sqlPiStorage`, under the session's own table prefix) in one Postgres schema, through
 * the `SqliteDatabase` facade in `./postgres.ts`.
 */
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { createSessionRuntime, type SessionRuntimeOptions, type SessionRuntimeService } from "@kantel/runtime/core";
import { type CallbackHandlerOptions, callbackHostHandlers } from "@kantel/runtime/http";
import { archiveSqlPiStorage, createSqlSessionStore, sqlPiStorage } from "@kantel/runtime/sql";

export {
	openPostgresSessionDatabase,
	type PostgresConnection,
	type PostgresField,
	type PostgresPool,
	PostgresSessionDatabase,
	type PostgresSessionDatabaseOptions,
	translateSqliteToPostgres,
} from "./postgres.ts";

export interface SelfhostedSessionRuntimeOptions extends Omit<SessionRuntimeOptions, "store" | "storage"> {
	/**
	 * The deployment's database, from `openPostgresSessionDatabase`. The caller owns it: closing the runtime leaves it
	 * open, so close the runtime first and the database after.
	 */
	readonly database: SqliteDatabase;
	/** Prefix of the store's tables. Default `kantel_`. */
	readonly prefix?: string;
	/**
	 * How durable host registrations (`hosts.register`, and the session API's `PUT /hosts/:id` given `hosts`) are called
	 * back when no `hostHandler` is given: the `fetch` to call hosts with and a call's timeout. The clock is the runtime's.
	 */
	readonly hostCallbacks?: Omit<CallbackHandlerOptions, "url" | "secret" | "clock">;
}

/**
 * Builds the runtime over the database (applying the store's migrations) and resumes, before returning, every session
 * a previous process left mid-run or whose sleep has fallen due; later wakes are armed on this process's timers.
 *
 * Host registrations kept in the store are served over their signed callbacks (`callbackHostHandlers`) unless
 * `hostHandler` says otherwise, as the Cloudflare target's object does: so a host tool call cut off by a restart is
 * rerun (`replay: "safe"`) or reported interrupted by the next process, without the host registering again.
 */
export async function createSelfhostedSessionRuntime(
	options: SelfhostedSessionRuntimeOptions,
): Promise<SessionRuntimeService> {
	const { database, prefix, hostCallbacks, ...runtimeOptions } = options;
	const store = await createSqlSessionStore(database, prefix === undefined ? {} : { prefix });
	const service = createSessionRuntime({
		...runtimeOptions,
		hostHandler:
			runtimeOptions.hostHandler ??
			callbackHostHandlers({
				...hostCallbacks,
				...(runtimeOptions.clock === undefined ? {} : { clock: runtimeOptions.clock }),
			}),
		store,
		storage: (session) => sqlPiStorage(database, session.id),
		// A closed session's tables are archived and dropped, so the schema grows with open sessions only (#216).
		archive: runtimeOptions.archive ?? ((session) => archiveSqlPiStorage(database, session.id)),
	});
	try {
		await service.resume();
	} catch (error) {
		await service.close().catch(() => undefined);
		throw error;
	}
	return service;
}

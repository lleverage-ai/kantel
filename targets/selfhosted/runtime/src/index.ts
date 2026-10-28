/**
 * The self-hosted session runtime: `createSessionRuntime` with its directory (`createSqlSessionStore`) and every
 * session's Pi Durable storage (`sqlPiStorage`, under the session's own table prefix) in one Postgres schema, through
 * the `SqliteDatabase` facade in `./postgres.ts`.
 */
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { createSessionRuntime, type SessionRuntimeOptions, type SessionRuntimeService } from "@harbour/runtime/core";
import { createSqlSessionStore, sqlPiStorage } from "@harbour/runtime/sql";

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
	/** Prefix of the store's tables. Default `harbour_`. */
	readonly prefix?: string;
}

/**
 * Builds the runtime over the database (applying the store's migrations) and resumes, before returning, every session
 * a previous process left mid-run or whose sleep has fallen due; later wakes are armed on this process's timers.
 */
export async function createSelfhostedSessionRuntime(
	options: SelfhostedSessionRuntimeOptions,
): Promise<SessionRuntimeService> {
	const { database, prefix, ...runtimeOptions } = options;
	const store = await createSqlSessionStore(database, prefix === undefined ? {} : { prefix });
	const service = createSessionRuntime({
		...runtimeOptions,
		store,
		storage: (session) => sqlPiStorage(database, session.id),
	});
	try {
		await service.resume();
	} catch (error) {
		await service.close().catch(() => undefined);
		throw error;
	}
	return service;
}

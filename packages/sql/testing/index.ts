/**
 * Fresh, empty databases for tests, one per call, behind every driver a target uses: PGlite (Postgres in process),
 * `node:sqlite`, and D1 through Miniflare. With `HARBOUR_TEST_POSTGRES_URL` set, a real Postgres too, each database a
 * schema of its own (named `m1_be78_…`) that `close` drops. Node only, so it lives outside `src`.
 */
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import pg from "pg";
import type { SqlDriver } from "../src/index.ts";
import { postgresPoolDriver, postgresTransactionalDriver } from "../src/postgres.ts";
import { type D1Like, d1Driver, syncSqliteDriver } from "../src/sqlite.ts";

export interface TestDatabase {
	readonly driver: SqlDriver;
	close(): Promise<void>;
}

export interface TestDatabaseKind {
	readonly name: string;
	/**
	 * The per-test timeout for suites on this kind, when its fixture is too slow for vitest's 10 s default on a loaded
	 * host; undefined keeps the default. Pass it as the suite's `timeout` (`describe(name, { timeout }, …)`), or to a
	 * conformance runner with `withTestTimeout` from `@harbour/testing/harness`.
	 */
	readonly testTimeoutMs?: number;
	open(): Promise<TestDatabase>;
}

/**
 * The timeout for kinds whose fixture, not the code under test, costs seconds per test. PGlite runs initdb in WASM on
 * every `open` (3–5 s on CI's shared 48-core host at a load average of 50–70). Miniflare's D1 binding is a proxy to
 * workerd, so each statement is a synchronous round trip for `prepare` and another for `bind`: about 15–20 ms a
 * statement under that load, so the audit outbox's 250-event retry case takes 9–11 s on D1 and 31 ms on node:sqlite.
 */
const SLOW_FIXTURE_TIMEOUT_MS = 30_000;

export const pgliteDatabase: TestDatabaseKind = {
	name: "Postgres (PGlite)",
	testTimeoutMs: SLOW_FIXTURE_TIMEOUT_MS,
	async open() {
		const database = await PGlite.create();
		return { driver: postgresTransactionalDriver(database), close: () => database.close() };
	},
};

export const nodeSqliteDatabase: TestDatabaseKind = {
	name: "SQLite (node:sqlite)",
	async open() {
		// Imported here, not at the top: Bun has no `node:sqlite`, and Bun runs the self-hosted tests, which use the other kinds.
		const { DatabaseSync } = await import("node:sqlite");
		const database = new DatabaseSync(":memory:");
		return {
			driver: syncSqliteDriver(database),
			close: async () => database.close(),
		};
	},
};

export const d1Database: TestDatabaseKind = {
	name: "D1 (Miniflare)",
	testTimeoutMs: SLOW_FIXTURE_TIMEOUT_MS,
	async open() {
		const miniflare = new Miniflare(
			convertV4MiniflareOptions({
				modules: true,
				script: "export default { fetch() { return new Response(null, { status: 404 }); } };",
				compatibilityDate: "2026-10-01",
				d1Databases: { DB: randomUUID() },
			}),
		);
		const database = (await miniflare.getD1Database("DB")) as unknown as D1Like;
		return { driver: d1Driver(database), close: () => miniflare.dispose() };
	},
};

/** A real Postgres at `url`; each database is a schema of its own, dropped on close. */
export function postgresDatabase(url: string): TestDatabaseKind {
	return {
		name: "Postgres",
		async open() {
			const schema = `m1_be78_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
			const admin = new pg.Client({ connectionString: url });
			await admin.connect();
			await admin.query(`CREATE SCHEMA ${schema}`);
			await admin.end();
			const pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${schema}` });
			return {
				driver: postgresPoolDriver(pool),
				async close() {
					await pool.query(`DROP SCHEMA ${schema} CASCADE`);
					await pool.end();
				},
			};
		},
	};
}

/** Every kind of database to run a store's conformance against here. */
export function testDatabaseKinds(
	env: { readonly [name: string]: string | undefined } = process.env,
): TestDatabaseKind[] {
	const kinds = [pgliteDatabase, nodeSqliteDatabase, d1Database];
	const url = env.HARBOUR_TEST_POSTGRES_URL;
	return url === undefined || url === "" ? kinds : [...kinds, postgresDatabase(url)];
}

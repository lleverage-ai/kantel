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
	open(): Promise<TestDatabase>;
}

export const pgliteDatabase: TestDatabaseKind = {
	name: "Postgres (PGlite)",
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

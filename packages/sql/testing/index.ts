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
import { type D1Like, type D1PreparedLike, d1Driver, syncSqliteDriver } from "../src/sqlite.ts";

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
 * The timeout for kinds whose fixture, not the code under test, can cost seconds per test on CI's shared 48-core host
 * at a load average of 50–70. PGlite's first `open` in a test file runs initdb in WASM (3–5 s there), and each `open`
 * after copies that data directory (about 0.5 s); each D1 `open` starts a workerd (about 0.5 s).
 */
const SLOW_FIXTURE_TIMEOUT_MS = 30_000;

/**
 * The data directory of the first PGlite opened in this test file (module), dumped fresh from initdb before anything
 * ran on it, for every `open` after to load. initdb is most of a PGlite open's cost: 3–5 s on a loaded host, against
 * about 0.5 s to load the 40 MB template. Each open still gets a database of its own, empty and in memory: the template
 * is a tarball, never a shared directory.
 */
let pgliteTemplate: Promise<Blob> | undefined;

async function openPglite(): Promise<PGlite> {
	if (pgliteTemplate !== undefined) return PGlite.create({ loadDataDir: await pgliteTemplate });
	const created = PGlite.create();
	const template = created.then((database) => database.dumpDataDir("none"));
	pgliteTemplate = template;
	template.catch(() => {
		if (pgliteTemplate === template) pgliteTemplate = undefined;
	});
	const database = await created;
	try {
		await template;
	} catch (error) {
		await database.close();
		throw error;
	}
	return database;
}

export const pgliteDatabase: TestDatabaseKind = {
	name: "Postgres (PGlite)",
	testTimeoutMs: SLOW_FIXTURE_TIMEOUT_MS,
	async open() {
		const database = await openPglite();
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

/**
 * The worker the D1 fixture talks to: it runs each statement, or each batch through D1's own `batch`, on its `DB`
 * binding inside workerd, and answers with the rows or the error's name and message.
 */
const D1_WORKER = `export default {
	async fetch(request, env) {
		const { statements, batch } = await request.json();
		const prepare = ({ sql, params }) => (params.length === 0 ? env.DB.prepare(sql) : env.DB.prepare(sql).bind(...params));
		try {
			if (batch) {
				await env.DB.batch(statements.map(prepare));
				return Response.json({ results: [] });
			}
			const { results } = await prepare(statements[0]).all();
			return Response.json({ results });
		} catch (error) {
			const cause = error?.cause instanceof Error ? error.cause.message : undefined;
			return Response.json({ error: { name: error?.name, message: String(error?.message ?? error), cause } });
		}
	},
};`;

interface D1Request {
	readonly batch: boolean;
	readonly statements: readonly { readonly sql: string; readonly params: readonly unknown[] }[];
}

interface D1Response {
	readonly results?: readonly unknown[];
	readonly error?: { readonly name?: string; readonly message: string; readonly cause?: string };
}

/** A statement the fixture's `D1Like` has prepared: just its SQL and parameters, until it runs. */
class D1FixtureStatement implements D1PreparedLike {
	constructor(
		readonly sql: string,
		readonly params: readonly unknown[],
		private readonly run: (request: D1Request) => Promise<readonly unknown[]>,
	) {}

	bind(...values: unknown[]): D1PreparedLike {
		return new D1FixtureStatement(this.sql, values, this.run);
	}

	async all(): Promise<{ readonly results: readonly unknown[] }> {
		return { results: await this.run({ batch: false, statements: [{ sql: this.sql, params: this.params }] }) };
	}
}

/**
 * A `D1Like` over Miniflare's D1, one request to workerd per query or batch. Miniflare's own `getD1Database` binding
 * is a proxy that makes a synchronous round trip for each `prepare` and each `bind`, so a batch of 100 inserts took
 * about 870 ms on a loaded host; through this it takes about 20 ms. The SQL still runs on D1 in workerd, a batch
 * still in one D1 transaction, and an error keeps D1's message (`D1_ERROR: UNIQUE constraint failed: …`).
 */
function miniflareD1(miniflare: Miniflare): D1Like {
	const run = async (request: D1Request): Promise<readonly unknown[]> => {
		const response = await miniflare.dispatchFetch("http://d1.test/", {
			method: "POST",
			body: JSON.stringify(request),
		});
		const body = (await response.json()) as D1Response;
		if (body.error !== undefined) {
			const { name, message, cause } = body.error;
			const error = new Error(message, cause === undefined ? undefined : { cause: new Error(cause) });
			if (name !== undefined) error.name = name;
			throw error;
		}
		return body.results ?? [];
	};
	return {
		prepare: (sql) => new D1FixtureStatement(sql, [], run),
		async batch(statements) {
			await run({
				batch: true,
				statements: statements.map((statement) => {
					if (!(statement instanceof D1FixtureStatement)) throw new TypeError("Not a statement this D1 prepared");
					return { sql: statement.sql, params: statement.params };
				}),
			});
			return [];
		},
	};
}

export const d1Database: TestDatabaseKind = {
	name: "D1 (Miniflare)",
	testTimeoutMs: SLOW_FIXTURE_TIMEOUT_MS,
	async open() {
		const miniflare = new Miniflare(
			convertV4MiniflareOptions({
				modules: true,
				script: D1_WORKER,
				compatibilityDate: "2026-10-01",
				d1Databases: { DB: randomUUID() },
			}),
		);
		await miniflare.ready;
		return { driver: d1Driver(miniflareD1(miniflare)), close: () => miniflare.dispose() };
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

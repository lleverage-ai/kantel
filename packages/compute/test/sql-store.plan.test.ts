/**
 * The control plane's hot reads each seek into `compute_api_records` by an index that narrows the rows to the ones they
 * want, rather than walking every record of their kind. On SQLite (the hosted stack object's), each read here was once
 * answered through `(kind, seq)`, which SQLite took to avoid sorting: it read and parsed every sandbox the deployment
 * ever made, deleted ones too, to answer an account's few live ones, and every API key to find one by its hash. Each
 * read here is the one a call site makes, with the same fields and states, and must name the index that serves it.
 *
 * SQLite only: Postgres has no index for most of these (it can't cast every such record to `jsonb`, `computeStoreSchema`)
 * and plans by its statistics. The answers are checked against the memory store's on both, beside the plans.
 */
import type { SqlDriver, SqlValue } from "@kantel/sql";
import { nodeSqliteDatabase, pgliteDatabase } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import { migrateComputeStore, sqlCollection } from "../src/sql-store.ts";
import { type AnyOf, memoryCollection } from "../src/store.ts";

/** The fields these reads filter by, on every kind they read. */
interface Row {
	readonly id: string;
	readonly accountId?: string;
	readonly ownerUserId?: string;
	readonly hostId?: string;
	readonly state?: string;
	readonly secretHash?: string;
	readonly ref?: string;
	readonly memory?: boolean;
	readonly sandboxId?: string;
	readonly integrationId?: string;
}

/** Every sandbox state but `deleted`, as `listSandboxes` and `undeleted` read them (`LISTED_STATES`). */
const LISTED = ["starting", "running", "stopping", "stopped", "paused", "moving", "error", "lost", "deleting"];
/** A host's sandboxes as its usage tick reads them (`PLACED_STATES`). */
const PLACED = ["starting", "running", "stopping", "stopped", "paused", "moving", "error"];
/** What `markLostHosts` reads across every host (`LOSABLE` and `lost`). */
const LOSABLE_OR_LOST = ["starting", "running", "stopping", "stopped", "paused", "moving", "error", "lost"];

/** The records: mostly deleted sandboxes, as a GitHub runner pool leaves them, and a few of every other kind. */
function seed(): Record<string, Row[]> {
	const sandboxes: Row[] = [];
	for (let index = 0; index < 2_000; index++) {
		sandboxes.push({
			id: `sbx_${index}`,
			accountId: index % 3 === 0 ? "acc_b" : "acc_a",
			ownerUserId: `usr_${index % 5}`,
			hostId: `host_${index % 4}`,
			state: index % 25 === 0 ? "running" : index % 25 === 1 ? "paused" : index % 77 === 0 ? "lost" : "deleted",
		});
	}
	return {
		sandboxes,
		snapshots: Array.from({ length: 300 }, (_, index) => ({
			id: `snap_${index}`,
			accountId: "acc_a",
			sandboxId: `sbx_${index}`,
			ref: `host_${index % 4}/ref_${index % 100}`,
			memory: index % 2 === 0,
		})),
		apiKeys: Array.from({ length: 50 }, (_, index) => ({ id: `key_${index}`, secretHash: `hash_${index}` })),
		personalTokens: Array.from({ length: 50 }, (_, index) => ({ id: `pat_${index}`, secretHash: `pat_${index}` })),
		githubRunnerJobs: Array.from({ length: 300 }, (_, index) => ({
			id: `ghr_${index % 3}:${index}`,
			integrationId: `ghr_${index % 3}`,
			state: "completed",
		})),
		githubRunnerMachines: Array.from({ length: 60 }, (_, index) => ({
			id: `sbx_${index}`,
			integrationId: `ghr_${index % 3}`,
		})),
		commands: Array.from({ length: 300 }, (_, index) => ({ id: `cmd_${index}`, sandboxId: `sbx_${index % 10}` })),
		diskHolders: Array.from({ length: 100 }, (_, index) => ({ id: `hold_${index}`, hostId: `host_${index % 4}` })),
	};
}

/**
 * A hot read: the kind, the fields and states it names, where the code makes it, the index that must serve it, and how
 * many of that index's fields it must seek by after the kind. All of them: an index named but sought by a shorter prefix
 * (a host's sandboxes by the host alone, its deleted ones and all) reads the rows the read means to skip.
 */
interface Read {
	readonly name: string;
	readonly kind: string;
	readonly where: Partial<Row>;
	readonly anyOf?: AnyOf<Row>;
	readonly index: string;
	readonly fields: number;
}

const READS: readonly Read[] = [
	{
		name: "an account's sandboxes in a list's states (listSandboxes, undeleted)",
		kind: "sandboxes",
		where: { accountId: "acc_a" },
		anyOf: { state: LISTED },
		index: "compute_api_records_by_account_state",
		fields: 2,
	},
	{
		name: "a person's sandboxes in an account, in a list's states (listSandboxes ?mine)",
		kind: "sandboxes",
		where: { accountId: "acc_a", ownerUserId: "usr_1" },
		anyOf: { state: LISTED },
		index: "compute_api_records_by_account_state",
		fields: 2,
	},
	{
		name: "an API key by its secret's hash (every call signed in with one)",
		kind: "apiKeys",
		where: { secretHash: "hash_7" },
		index: "compute_api_records_by_secret_hash",
		fields: 1,
	},
	{
		name: "a personal token by its secret's hash (every call signed in with one)",
		kind: "personalTokens",
		where: { secretHash: "pat_7" },
		index: "compute_api_records_by_secret_hash",
		fields: 1,
	},
	{
		name: "an integration's runner jobs (every runner pass)",
		kind: "githubRunnerJobs",
		where: { integrationId: "ghr_1" },
		index: "compute_api_records_runner_jobs_by_integration",
		fields: 1,
	},
	{
		name: "an integration's runners (every runner pass)",
		kind: "githubRunnerMachines",
		where: { integrationId: "ghr_1" },
		index: "compute_api_records_runner_machines_by_integration",
		fields: 1,
	},
	{
		name: "a snapshot's copies by its ref (each heartbeat's holdings)",
		kind: "snapshots",
		where: { ref: "host_1/ref_5" },
		index: "compute_api_records_snapshots_by_ref",
		fields: 1,
	},
	{
		name: "a ref's disk snapshots (keepSnapshotCopies)",
		kind: "snapshots",
		where: { ref: "host_1/ref_5", memory: false },
		index: "compute_api_records_snapshots_by_ref",
		fields: 1,
	},
	{
		name: "sandboxes in one state across accounts (the sweep, usage sampling)",
		kind: "sandboxes",
		where: { state: "running" },
		index: "compute_api_records_sandboxes_by_state",
		fields: 1,
	},
	{
		name: "sandboxes in several states across accounts (markLostHosts)",
		kind: "sandboxes",
		where: {},
		anyOf: { state: LOSABLE_OR_LOST },
		index: "compute_api_records_sandboxes_by_state",
		fields: 1,
	},
	{
		name: "a host's placed sandboxes (its usage tick)",
		kind: "sandboxes",
		where: { hostId: "host_1" },
		anyOf: { state: PLACED },
		index: "compute_api_records_sandboxes_by_host_state",
		fields: 2,
	},
	{
		name: "a host's live sandboxes (its view in GET /v1/hosts)",
		kind: "sandboxes",
		where: { hostId: "host_1" },
		anyOf: { state: ["running", "starting", "paused"] },
		index: "compute_api_records_sandboxes_by_host_state",
		fields: 2,
	},
	{
		name: "a host's undeleted sandboxes (its connection, holdsSandboxes)",
		kind: "sandboxes",
		where: { hostId: "host_1" },
		anyOf: { state: LISTED },
		index: "compute_api_records_sandboxes_by_host_state",
		fields: 2,
	},
	{
		name: "a sandbox's snapshots",
		kind: "snapshots",
		where: { sandboxId: "sbx_3" },
		index: "compute_api_records_by_sandbox",
		fields: 1,
	},
	{
		name: "a sandbox's commands",
		kind: "commands",
		where: { sandboxId: "sbx_3" },
		index: "compute_api_records_by_sandbox",
		fields: 1,
	},
	{
		name: "a host's disk holders (each capacity report)",
		kind: "diskHolders",
		where: { hostId: "host_2" },
		index: "compute_api_records_by_host",
		fields: 1,
	},
];

/** A driver that remembers the last list it ran, so the test can ask the database how it planned it. */
function recording(driver: SqlDriver) {
	let last: { sql: string; params: readonly SqlValue[] } | undefined;
	const wrapped: SqlDriver = {
		dialect: driver.dialect,
		query(sql, params = []) {
			if (sql.startsWith("SELECT data FROM compute_api_records WHERE")) last = { sql, params };
			return driver.query(sql, params);
		},
		batch: (statements) => driver.batch(statements),
	};
	/** The plan of the last list, a line a step. */
	async function plan(): Promise<string[]> {
		if (last === undefined) throw new Error("no list yet");
		const rows = await driver.query(`EXPLAIN QUERY PLAN ${last.sql}`, last.params);
		return rows.map((row) => String(row.detail));
	}
	return { driver: wrapped, plan };
}

/** Whether a plan reads the table without seeking by the fields asked for: a scan, or a search by the kind alone. */
function walksKind(plan: readonly string[]): boolean {
	return plan.some((step) =>
		/\bSCAN compute_api_records\b|USING INDEX compute_api_records_order \(kind=\?\)$/.test(step),
	);
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("walksKind", () => {
	it("flags scans and searches by the kind alone, and passes searches by an index on the fields", () => {
		expect(walksKind(["SCAN compute_api_records"])).toBe(true);
		expect(walksKind(["SEARCH compute_api_records USING INDEX compute_api_records_order (kind=?)"])).toBe(true);
		expect(
			walksKind([
				"SEARCH compute_api_records USING INDEX compute_api_records_by_account_state (kind=? AND <expr>=? AND <expr>=?)",
				"USE TEMP B-TREE FOR ORDER BY",
			]),
		).toBe(false);
	});
});

describe("hot compute store reads on SQLite (node:sqlite)", () => {
	it("each seek by the index that serves it, and answer as the memory store does, oldest first", async () => {
		const database = await nodeSqliteDatabase.open();
		cleanups.push(() => database.close());
		await migrateComputeStore(database.driver);
		const { driver, plan } = recording(database.driver);
		const records = seed();
		for (const [kind, rows] of Object.entries(records)) {
			const collection = sqlCollection<Row>(driver, kind);
			for (const row of rows) await collection.put(row);
		}
		for (const read of READS) {
			const memory = memoryCollection<Row>();
			for (const row of records[read.kind] ?? []) await memory.put(row);
			const answer = await sqlCollection<Row>(driver, read.kind).list(read.where, read.anyOf);
			expect(answer, read.name).toEqual(await memory.list(read.where, read.anyOf));
			expect(answer.length, read.name).toBeGreaterThan(0);
			const steps = await plan();
			expect(walksKind(steps), `${read.name}: ${steps.join("; ")}`).toBe(false);
			const seek = ["kind=?", ...Array.from({ length: read.fields }, () => "<expr>=?")].join(" AND ");
			expect(steps[0], read.name).toBe(`SEARCH compute_api_records USING INDEX ${read.index} (${seek})`);
		}
	});

	it("still walks a whole kind in order, with no sort", async () => {
		const database = await nodeSqliteDatabase.open();
		cleanups.push(() => database.close());
		await migrateComputeStore(database.driver);
		const { driver, plan } = recording(database.driver);
		const sandboxes = sqlCollection<Row>(driver, "sandboxes");
		for (const id of ["c", "a", "b"]) await sandboxes.put({ id, state: "running" });
		expect((await sandboxes.list()).map((row) => row.id)).toEqual(["c", "a", "b"]);
		expect(await plan()).toEqual(["SEARCH compute_api_records USING INDEX compute_api_records_order (kind=?)"]);
	});
});

describe("hot compute store reads on Postgres (PGlite)", { timeout: pgliteDatabase.testTimeoutMs }, () => {
	it("answer as the memory store does, oldest first", async () => {
		const database = await pgliteDatabase.open();
		cleanups.push(() => database.close());
		await migrateComputeStore(database.driver);
		const records = seed();
		for (const [kind, rows] of Object.entries(records)) {
			const collection = sqlCollection<Row>(database.driver, kind);
			for (const row of rows) await collection.put(row);
		}
		for (const read of READS) {
			const memory = memoryCollection<Row>();
			for (const row of records[read.kind] ?? []) await memory.put(row);
			expect(await sqlCollection<Row>(database.driver, read.kind).list(read.where, read.anyOf), read.name).toEqual(
				await memory.list(read.where, read.anyOf),
			);
		}
	});
});

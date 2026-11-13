// The disk store's catalogue of copies (docs/design/disk-store.md, 2c): holders reconciled from hosts' reports,
// `disk.locate`'s answers within a pool, signed fetch grants, and the sweep keeping a version another host holds.
import { createRequire } from "node:module";
import { createKantelClient } from "@kantel/api/sdk";
import { nodeSqliteDatabase, pgliteDatabase, type TestDatabaseKind, testDatabaseKinds } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendHost, BackendStickyHoldings, SandboxBackend } from "../src/backend.ts";
import { createGrantKey, GRANT_TTL_MS, verifyGrant } from "../src/grants.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createSqlComputeStore, migrateComputeStore } from "../src/sql-store.ts";
import { type ComputeStore, createMemoryStore, OPERATOR_POOLS } from "../src/store.ts";
import { createStubBackend, STUB_HOST_ID } from "../src/stub-backend.ts";

const opened: ComputeApi[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const api of opened.splice(0)) await api.close();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const SECRETS_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

async function sqlStore(kind: TestDatabaseKind): Promise<ComputeStore> {
	const database = await kind.open();
	cleanups.push(() => database.close());
	await migrateComputeStore(database.driver);
	return createSqlComputeStore(database.driver);
}

/**
 * A deployment over the stub backend whose shared hosts are, once `pool()` is called: the stub (`host_stub`) and `b` in
 * pool A, `c` in pool B, `d` in pool A but offline, and `e` in pool A (revoked by the test). Each but `e` has a mesh
 * address.
 */
function setUp(
	options: {
		store?: ComputeStore;
		secretsKey?: string;
		stickyDisks?: boolean;
		/** What hosts last reported holding, for the sweep (`SandboxBackend.stickyHoldings`). */
		holdings?: () => BackendStickyHoldings[];
	} = {},
) {
	const clock = { now: Date.UTC(2026, 10, 13) };
	const hosts = { pooled: false };
	const holdings = options.holdings;
	const wrap = (backend: SandboxBackend): SandboxBackend => ({
		...backend,
		...(holdings === undefined ? {} : { stickyHoldings: async () => holdings() }),
		async capabilities() {
			const capabilities = await backend.capabilities();
			const [stub] = capabilities.hosts;
			if (!hosts.pooled || stub === undefined) return capabilities;
			const host = (id: string, poolId: string, more: Partial<BackendHost> = {}): BackendHost => ({
				...stub,
				id,
				name: id,
				poolId,
				...more,
			});
			return {
				...capabilities,
				hosts: [
					host(STUB_HOST_ID, "pool_a", { meshAddress: "fd00:a::1" }),
					host("host_b", "pool_a", { meshAddress: "fd00:a::2" }),
					host("host_c", "pool_b", { meshAddress: "fd00:b::1" }),
					host("host_d", "pool_a", { meshAddress: "fd00:a::3", connected: false }),
					host("host_e", "pool_a", { meshAddress: "fd00:a::4" }),
					host("host_f", "pool_a", { meshAddress: "fd00:a::5", accountId: "acc_other" }),
				],
			};
		},
	});
	const api = createComputeApi({
		backend: wrap(createStubBackend()),
		stickyDisks: options.stickyDisks ?? true,
		...(options.store === undefined ? {} : { store: options.store }),
		...(options.secretsKey === undefined ? {} : { secretsKey: options.secretsKey }),
		now: () => clock.now,
		authenticatePerson: async (request) =>
			request.headers.get("authorization") === "Bearer tom-token"
				? { userId: "usr_tom", name: "Tom", email: "tom@example.com", superAdmin: true }
				: undefined,
	});
	opened.push(api);
	const client = createKantelClient({
		baseUrl: "http://compute.test/v1",
		token: "tom-token",
		fetch: (input, init) =>
			api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
	});
	/** Puts the hosts in their pools; `e` revoked. */
	const pool = async () => {
		for (const [id, name] of [
			["pool_a", "a"],
			["pool_b", "b"],
		] as const) {
			await api.store.pools.put({ id, owner: OPERATOR_POOLS, name, createdAt: clock.now, sync: true });
		}
		hosts.pooled = true;
		// Listing the hosts, as Tom administers the deployment, records them.
		await client.listHosts();
		await api.store.hosts.update("host_e", (host) => ({ ...host, state: "revoked" }));
		// The stub's host was first seen before these pools, so it went into the default one: moved, as a move does.
		await api.store.hosts.update(STUB_HOST_ID, (host) => ({ ...host, poolId: "pool_a" }));
	};
	/** A disk with a version committed on the stub's host. */
	const committed = async () => {
		const disk = await client.createStickyDisk({ name: "cache", sizeGb: 10 });
		const sandbox = await client.createSandbox({
			type: "microvm",
			stickyDisks: [{ disk: "cache", path: "/cache" }],
			wait: true,
		});
		const version = await client.commitStickyDisk(sandbox.id, disk.id);
		return { disk, sandbox, version };
	};
	const holders = async (version: string) =>
		(await api.store.diskHolders.list())
			.filter((holder) => holder.version === version)
			.map((holder) => [holder.hostId, holder.state])
			.sort();
	return Object.assign(client, { api, clock, pool, committed, holders });
}

const DISK = {
	id: "sdk_1",
	accountId: "acc_1",
	name: "cache",
	sizeGb: 10,
	head: "sdv_head",
	createdAt: 1,
	updatedAt: 1,
};
const VERSION = {
	id: "sdv_1",
	diskId: "sdk_1",
	accountId: "acc_1",
	hostId: "host_a",
	sandboxId: "sbx_1",
	sizeBytes: 1,
	allocatedBytes: 1,
	seq: 1,
	createdAt: 1,
};
const holder = (hostId: string, since: number) =>
	({
		id: `sticky:sdk_1:sdv_1:${hostId}`,
		kind: "sticky",
		objectId: "sdk_1",
		version: "sdv_1",
		hostId,
		state: "held",
		since,
	}) as const;

describe("disk holders", () => {
	for (const [name, kind] of [
		["memory", undefined],
		["SQLite", nodeSqliteDatabase],
		["Postgres", pgliteDatabase],
	] as const) {
		it(`adds and removes a host's holders as its reports say, in ${name}`, {
			timeout: kind?.testTimeoutMs,
		}, async () => {
			const tom = setUp({ ...(kind === undefined ? {} : { store: await sqlStore(kind) }), secretsKey: SECRETS_KEY });
			const { disk, version } = await tom.committed();
			await tom.pool();
			// The host it was made on holds it from the commit.
			expect(await tom.holders(version.id)).toEqual([[STUB_HOST_ID, "held"]]);
			// Each report a moment after the last: a host's older report than one taken changes nothing.
			const report = (hostId: string, versions: readonly string[]) => {
				tom.clock.now += 1;
				return tom.api.service.recordStickyHoldings(hostId, tom.clock.now, [
					{ diskId: disk.id, versions: versions.map((each) => ({ version: each })) },
				]);
			};
			// Another host reports it, and a version the catalogue doesn't have, which is no copy of anything.
			await report("host_b", [version.id, "sdv_unknown"]);
			expect(await tom.holders(version.id)).toEqual([
				["host_b", "held"],
				[STUB_HOST_ID, "held"],
			]);
			expect(await tom.holders("sdv_unknown")).toEqual([]);
			// Another account's own host can't hold this account's data, and a revoked host holds nothing.
			await report("host_f", [version.id]);
			await report("host_e", [version.id]);
			expect(await tom.holders(version.id)).toHaveLength(2);
			// A report that may have been measured before its holder was recorded doesn't let it go.
			await report(STUB_HOST_ID, []);
			expect(await tom.holders(version.id)).toHaveLength(2);
			tom.clock.now += 3 * 60_000;
			await report(STUB_HOST_ID, []);
			expect(await tom.holders(version.id)).toEqual([["host_b", "held"]]);
			// A version being fetched stays until the host reports it, then it is held.
			await tom.api.store.diskHolders.put({
				id: `sticky:${disk.id}:${version.id}:host_c`,
				kind: "sticky",
				objectId: disk.id,
				version: version.id,
				hostId: "host_c",
				state: "fetching",
				since: tom.clock.now - 10 * 60_000,
			});
			await report("host_c", []);
			expect(await tom.holders(version.id)).toContainEqual(["host_c", "fetching"]);
			await report("host_c", [version.id]);
			expect(await tom.holders(version.id)).toContainEqual(["host_c", "held"]);
			// A deleted disk's holders go with it.
			await tom.deleteStickyDisk(disk.id);
			expect(await tom.api.store.diskHolders.list()).toEqual([]);
		});
	}

	it("locates a version only on online, unrevoked hosts in the asker's pool, with a grant that expires", async () => {
		const tom = setUp();
		const { disk, version } = await tom.committed();
		await tom.pool();
		for (const hostId of ["host_b", "host_c", "host_d", "host_e"]) {
			await tom.api.service.recordStickyHoldings(hostId, tom.clock.now, [
				{ diskId: disk.id, versions: [{ version: version.id }] },
			]);
		}
		const request = { kind: "sticky", objectId: disk.id, version: version.id };
		const found = await tom.api.service.locateDisk(STUB_HOST_ID, request);
		// Not itself, not pool B's host, not the offline one, not the revoked one.
		expect(found.holders).toEqual([{ hostId: "host_b", address: "fd00:a::2" }]);
		const publicKey = await tom.api.service.grantPublicKey();
		if (publicKey === undefined || found.grant === undefined) throw new Error("no grant");
		expect(await verifyGrant(publicKey, found.grant, tom.clock.now)).toEqual({
			kind: "sticky",
			objectId: disk.id,
			version: version.id,
			accountId: (await tom.api.store.stickyDiskVersions.get(version.id))?.accountId,
			from: ["host_b"],
			to: STUB_HOST_ID,
			exp: tom.clock.now + GRANT_TTL_MS,
		});
		// Refused once it has expired, by another key, or changed.
		expect(await verifyGrant(publicKey, found.grant, tom.clock.now + GRANT_TTL_MS)).toBeUndefined();
		expect(await verifyGrant((await createGrantKey()).key.publicKey, found.grant, tom.clock.now)).toBeUndefined();
		const [payload, signature] = found.grant.split(".");
		const widened = btoa(
			JSON.stringify({ ...JSON.parse(atob(payload?.replaceAll("-", "+").replaceAll("_", "/") ?? "")), to: "host_c" }),
		)
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, "");
		expect(await verifyGrant(publicKey, `${widened}.${signature}`, tom.clock.now)).toBeUndefined();
		// Pool B's host finds no holder in its pool, so no grant.
		expect(await tom.api.service.locateDisk("host_c", request)).toEqual({ holders: [] });
		// With pool A's sync off its hosts' mesh is down: no holder there either.
		await tom.api.store.pools.update("pool_a", (pool) => ({ ...pool, sync: false }));
		expect(await tom.api.service.locateDisk(STUB_HOST_ID, request)).toEqual({ holders: [] });
		await tom.api.store.pools.update("pool_a", (pool) => ({ ...pool, sync: true }));
		// A move to pool B saved here but not yet in the registry: its address is still pool A's, so it isn't offered in B.
		await tom.api.store.hosts.update("host_b", (host) => ({ ...host, poolId: "pool_b" }));
		expect((await tom.api.service.locateDisk("host_c", request)).holders).toEqual([]);
		await tom.api.store.hosts.update("host_b", (host) => ({ ...host, poolId: "pool_a" }));
		// A revoked host, and a version or kind that isn't there, are refused.
		await expect(tom.api.service.locateDisk("host_e", request)).rejects.toMatchObject({ code: "not_found" });
		await expect(tom.api.service.locateDisk("host_b", { ...request, version: "sdv_missing" })).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(tom.api.service.locateDisk("host_b", { ...request, kind: "disk" })).rejects.toMatchObject({
			code: "invalid",
		});
		await expect(tom.api.service.locateDisk("host_b", { ...request, kind: "snapshot" })).rejects.toMatchObject({
			code: "not_supported",
		});
	});

	it("never forgets a version another host still holds", async () => {
		let reports: BackendStickyHoldings[] = [];
		const tom = setUp({ holdings: () => reports });
		const wrapped = tom.api.service;
		const { disk, sandbox, version: old } = await tom.committed();
		const head = await tom.commitStickyDisk(sandbox.id, disk.id);
		await tom.pool();
		await wrapped.recordStickyHoldings("host_b", tom.clock.now, [{ diskId: disk.id, versions: [{ version: old.id }] }]);
		// The host it was made on no longer holds it; host_b does.
		reports = [{ hostId: STUB_HOST_ID, reportedAt: tom.clock.now + 11 * 60_000, disks: [] }];
		const sweep = async () => {
			tom.clock.now += 11 * 60_000;
			await tom.api.service.sweep();
			await tom.api.service.idle();
		};
		await sweep();
		expect((await tom.getStickyDisk(disk.id)).versions?.map((each) => each.id)).toEqual([head.id, old.id]);
		// host_b lets it go too: it is forgotten, with its holders.
		await wrapped.recordStickyHoldings("host_b", tom.clock.now, [{ diskId: disk.id, versions: [] }]);
		reports = [{ hostId: STUB_HOST_ID, reportedAt: tom.clock.now + 11 * 60_000, disks: [] }];
		await sweep();
		expect((await tom.getStickyDisk(disk.id)).versions?.map((each) => each.id)).toEqual([head.id]);
		expect(await tom.holders(old.id)).toEqual([]);
	});

	for (const [name, kind] of [
		["memory", undefined],
		["SQLite", nodeSqliteDatabase],
		["Postgres", pgliteDatabase],
	] as const) {
		it(`takes only a host's newest report, wherever it was taken, in ${name}`, {
			timeout: kind?.testTimeoutMs,
		}, async () => {
			const store = kind === undefined ? createMemoryStore() : await sqlStore(kind);
			await store.stickyDiskVersions.put(VERSION);
			const held = holder("host_b", 1);
			// A newer report claimed (another gateway's, say) fences an older one, even one already under way.
			expect(await store.diskHolderWrites.claim("host_b", 10)).toBe(true);
			expect(await store.diskHolderWrites.claim("host_b", 20)).toBe(true);
			expect(await store.diskHolderWrites.claim("host_b", 15)).toBe(false);
			await store.diskHolderWrites.reconcile("host_b", 10, { hold: [held], release: [] });
			expect(await store.diskHolders.list()).toEqual([]);
			await store.diskHolderWrites.reconcile("host_b", 20, { hold: [held], release: [] });
			expect(await store.diskHolders.list()).toEqual([held]);
			await store.diskHolderWrites.reconcile("host_b", 10, { hold: [], release: [held] });
			expect(await store.diskHolders.list()).toEqual([held]);
			// A holder of a version the catalogue doesn't have isn't recorded.
			await store.diskHolderWrites.reconcile("host_b", 20, {
				hold: [{ ...holder("host_b", 1), id: "sticky:sdk_1:sdv_gone:host_b", version: "sdv_gone" }],
				release: [held],
			});
			expect(await store.diskHolders.list()).toEqual([]);
		});
	}

	it("takes the host's report row first in a reconcile, so a newer claim on Postgres waits for the batch to land", async () => {
		// PGlite has one connection, so two transactions can't overlap here: this checks the batch's shape, that it takes
		// the report row (as Postgres's row lock needs) before it changes a holder.
		const database = await nodeSqliteDatabase.open();
		cleanups.push(() => database.close());
		await migrateComputeStore(database.driver);
		const batches: string[][] = [];
		const store = createSqlComputeStore({
			dialect: database.driver.dialect,
			query: (text, params) => database.driver.query(text, params),
			async batch(statements) {
				batches.push(statements.map((statement) => statement.sql.replace(/\s+/g, " ").trim()));
				return database.driver.batch(statements);
			},
		});
		await store.stickyDiskVersions.put(VERSION);
		await store.diskHolderWrites.claim("host_b", 5);
		batches.length = 0;
		await store.diskHolderWrites.reconcile("host_b", 5, { hold: [holder("host_b", 5)], release: [] });
		expect(batches).toHaveLength(1);
		expect(batches[0]?.[0]).toBe(
			"UPDATE compute_api_records SET version = version + 1 WHERE kind = ? AND id = ? AND data = ?",
		);
		expect(await store.diskHolders.list()).toEqual([holder("host_b", 5)]);
	});

	for (const kind of [nodeSqliteDatabase, pgliteDatabase]) {
		it(`never forgets a version a host recorded holding after the sweep read its holders, in ${kind.name}`, {
			timeout: kind.testTimeoutMs,
		}, async () => {
			const database = await kind.open();
			cleanups.push(() => database.close());
			await migrateComputeStore(database.driver);
			const direct = createSqlComputeStore(database.driver);
			// The holder lands between the sweep's read of the holders and its delete of the version.
			let between: (() => Promise<void>) | undefined;
			const store = createSqlComputeStore({
				dialect: database.driver.dialect,
				query: (text, params) => database.driver.query(text, params),
				async batch(statements) {
					const hook = between;
					between = undefined;
					await hook?.();
					return database.driver.batch(statements);
				},
			});
			await direct.stickyDiskVersions.put(VERSION);
			await direct.stickyDisks.put(DISK);
			between = async () => {
				await direct.diskHolderWrites.claim("host_b", 5);
				await direct.diskHolderWrites.reconcile("host_b", 5, { hold: [holder("host_b", 5)], release: [] });
			};
			const elsewhere = (holders: readonly { readonly hostId: string }[]) =>
				holders.some((each) => each.hostId !== VERSION.hostId);
			expect(await store.stickyDiskWrites.forget(VERSION.id, elsewhere)).toBe(false);
			expect(await direct.stickyDiskVersions.get(VERSION.id)).toMatchObject({ id: VERSION.id });
			// Held nowhere else, it is forgotten.
			await direct.diskHolders.delete(holder("host_b", 5).id);
			expect(await store.stickyDiskWrites.forget(VERSION.id, elsewhere)).toBe(true);
			expect(await direct.stickyDiskVersions.get(VERSION.id)).toBeUndefined();
		});
	}

	it("answers a locate whose grant key can't be read with the key's failure, and a missing version with not_found", async () => {
		const store = await sqlStore(nodeSqliteDatabase);
		const tom = setUp({ store, secretsKey: SECRETS_KEY });
		const { disk, version } = await tom.committed();
		await tom.pool();
		await tom.api.service.recordStickyHoldings("host_b", tom.clock.now, [
			{ diskId: disk.id, versions: [{ version: version.id }] },
		]);
		// A key sealed with another secrets key: it can't be opened here.
		const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
		expect(await setUp({ store, secretsKey: other }).api.service.grantPublicKey()).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const request = { kind: "sticky", objectId: disk.id, version: version.id };
		await expect(
			tom.api.service.locateDisk(STUB_HOST_ID, { ...request, version: "sdv_missing" }),
		).rejects.toMatchObject({
			code: "not_found",
		});
		expect(await tom.api.service.locateDisk("host_c", request)).toEqual({ holders: [] });
		await expect(tom.api.service.locateDisk(STUB_HOST_ID, request)).rejects.toMatchObject({ code: "unavailable" });
		// Read again after a failure: once it opens (the key is the one this gateway made), grants are signed.
		await store.settings.delete("grantKey");
		expect((await tom.api.service.locateDisk(STUB_HOST_ID, request)).grant).toEqual(expect.any(String));
	});

	it("signs with one key every gateway over a database shares, and with no secrets key has none", async () => {
		const store = await sqlStore(nodeSqliteDatabase);
		const [one, two] = [setUp({ store, secretsKey: SECRETS_KEY }), setUp({ store, secretsKey: SECRETS_KEY })];
		const keys = await Promise.all([one.api.service.grantPublicKey(), two.api.service.grantPublicKey()]);
		expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(keys[1]).toBe(keys[0]);
		// Kept: a gateway started later signs with it too.
		expect(await setUp({ store, secretsKey: SECRETS_KEY }).api.service.grantPublicKey()).toBe(keys[0]);
		// Over a persistent store with no secrets key nothing can be sealed, so there is no key and locate is refused.
		const bare = setUp({ store: await sqlStore(nodeSqliteDatabase) });
		expect(await bare.api.service.grantPublicKey()).toBeUndefined();
		await expect(
			bare.api.service.locateDisk(STUB_HOST_ID, { kind: "sticky", objectId: "sd_1", version: "sdv_1" }),
		).rejects.toMatchObject({ code: "not_supported" });
		// Sticky disks off: none either.
		expect(await setUp({ stickyDisks: false }).api.service.grantPublicKey()).toBeUndefined();
		expect(await setUp().api.service.grantPublicKey()).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});
});

// Two connections to a real Postgres (KANTEL_TEST_POSTGRES_URL): a reconcile's batch under way, and a newer report's claim.
const postgresUrl = process.env.KANTEL_TEST_POSTGRES_URL;
describe.skipIf(postgresUrl === undefined || postgresUrl === "")("disk holders, Postgres, two connections", () => {
	it("makes a newer report's claim wait for an older reconcile under way, then read what it wrote", async () => {
		const kind = testDatabaseKinds().find((candidate) => candidate.name === "Postgres");
		if (kind === undefined) throw new Error("No Postgres kind");
		const database = await kind.open();
		cleanups.push(() => database.close());
		await migrateComputeStore(database.driver);
		const store = createSqlComputeStore(database.driver);
		await store.stickyDiskVersions.put(VERSION);
		// The older report's reconcile, as this store writes it, to be held open on a second connection before it commits.
		let recorded: readonly { readonly sql: string; readonly params?: readonly unknown[] }[] = [];
		const recording = createSqlComputeStore({
			dialect: database.driver.dialect,
			query: (text, params) => database.driver.query(text, params),
			async batch(statements) {
				recorded = statements;
			},
		});
		expect(await store.diskHolderWrites.claim("host_b", 10)).toBe(true);
		await recording.diskHolderWrites.reconcile("host_b", 10, { hold: [holder("host_b", 10)], release: [] });
		expect(recorded.length).toBeGreaterThan(0);
		// `pg` is @kantel/sql's, not this package's: its client, as much of it as this needs.
		const pg = createRequire(import.meta.resolve("@kantel/sql/testing"))("pg") as {
			Client: new (config: {
				connectionString: string;
				options: string;
			}) => {
				connect(): Promise<void>;
				query(text: string, values?: unknown[]): Promise<unknown>;
				end(): Promise<void>;
			};
		};
		const [{ search_path: schema }] = (await database.driver.query("SHOW search_path")) as [{ search_path: string }];
		const other = new pg.Client({ connectionString: postgresUrl ?? "", options: `-c search_path=${schema}` });
		await other.connect();
		const numbered = (text: string) => {
			let next = 0;
			return text.replace(/\?/g, () => `$${++next}`);
		};
		const [{ pid }] = ((await other.query("SELECT pg_backend_pid() AS pid")) as { rows: [{ pid: number }] }).rows;
		let settled = false;
		let claiming: Promise<boolean> | undefined;
		try {
			await other.query("BEGIN");
			for (const statement of recorded) await other.query(numbered(statement.sql), [...(statement.params ?? [])]);
			// The newer report's claim waits for the older batch, so it can't read the holders before that batch lands: it is
			// seen blocked by the other connection, and hasn't settled.
			claiming = store.diskHolderWrites.claim("host_b", 20).finally(() => {
				settled = true;
			});
			const deadline = Date.now() + 10_000;
			for (;;) {
				const blocked = await database.driver.query(
					"SELECT 1 FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid))",
					[pid],
				);
				if (blocked.length > 0) break;
				expect(settled).toBe(false);
				if (Date.now() > deadline) throw new Error("The claim was never seen waiting for the other connection");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(settled).toBe(false);
			await other.query("COMMIT");
		} finally {
			// On any failure the other connection's transaction goes before the schema is dropped, and the claim is let finish.
			await other.end().catch(() => undefined);
			await claiming?.catch(() => false);
		}
		expect(await claiming).toBe(true);
		// It reads the older batch's holder, and its own empty inventory lets it go; the older report changes nothing more.
		expect(await store.diskHolders.list()).toEqual([holder("host_b", 10)]);
		await store.diskHolderWrites.reconcile("host_b", 20, { hold: [], release: [holder("host_b", 10)] });
		await store.diskHolderWrites.reconcile("host_b", 10, { hold: [holder("host_b", 10)], release: [] });
		expect(await store.diskHolders.list()).toEqual([]);
	});
});

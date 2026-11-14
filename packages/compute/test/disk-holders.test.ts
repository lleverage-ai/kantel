// The disk store's catalogue of copies (docs/design/disk-store.md, 2c): holders reconciled from hosts' reports,
// `disk.locate`'s answers within a pool, signed fetch grants, and the sweep keeping a version another host holds.
import { createRequire } from "node:module";
import { createKantelClient } from "@kantel/api/sdk";
import { nodeSqliteDatabase, pgliteDatabase, type TestDatabaseKind, testDatabaseKinds } from "@kantel/sql/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendDiskFetch, BackendHost, BackendStickyHoldings, SandboxBackend } from "../src/backend.ts";
import { GRANT_KEY_OVERLAP_MS, GRANT_KEY_PUBLISH_MS, GRANT_KEY_REPLACE_AFTER_MS } from "../src/disk-holders.ts";
import { createGrantKey, GRANT_TTL_MS, verifyGrant } from "../src/grants.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createSqlComputeStore, migrateComputeStore } from "../src/sql-store.ts";
import {
	type ComputeStore,
	createMemoryStore,
	fenceClosedAccounts,
	OPERATOR_POOLS,
	STICKY_PREFETCH_MS,
} from "../src/store.ts";
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
 * A deployment over the stub backend whose shared hosts are, once `pool()` is called: the stub (`host_stub`), `b` and `g`
 * in pool A, `c` in pool B, `d` in pool A but offline, `e` in pool A (revoked by the test), and `f` in pool A but another
 * account's. Each has a mesh address.
 */
function setUp(
	options: {
		store?: ComputeStore;
		secretsKey?: string;
		stickyDisks?: boolean;
		templates?: boolean;
		/** Hosts of an architecture other than the stub's. */
		arch?: { readonly [hostId: string]: "x86_64" | "aarch64" };
		/** What hosts last reported holding, for the sweep (`SandboxBackend.stickyHoldings`). */
		holdings?: () => BackendStickyHoldings[];
		/** The backend's `disk.fetch` (`SandboxBackend.fetchDisk`); absent, it has none. */
		fetchDisk?: SandboxBackend["fetchDisk"];
		/** The backend's telling of hosts of new grant keys (`SandboxBackend.grantKeysChanged`). */
		grantKeysChanged?: SandboxBackend["grantKeysChanged"];
		/** Told of each snapshot's bytes deleted, by ref, before the stub deletes them. */
		deletedSnapshot?: (ref: string) => void;
		/** Whether Tom is a super-admin (default true). */
		superAdmin?: boolean;
		/** The clock's start (default 13 Nov 2026). */
		now?: number;
		/** The block map digest each commit answers; absent, none (a host from before maps, or a map that took longer). */
		mapDigest?: () => string | undefined;
	} = {},
) {
	const clock = { now: options.now ?? Date.UTC(2026, 10, 13) };
	const hosts = { pooled: false };
	const holdings = options.holdings;
	const wrap = (backend: SandboxBackend): SandboxBackend => ({
		...backend,
		...(holdings === undefined ? {} : { stickyHoldings: async () => holdings() }),
		...(options.fetchDisk === undefined ? {} : { fetchDisk: options.fetchDisk }),
		...(options.grantKeysChanged === undefined ? {} : { grantKeysChanged: options.grantKeysChanged }),
		async deleteSnapshot(ref) {
			options.deletedSnapshot?.(ref);
			await backend.deleteSnapshot(ref);
		},
		async commitStickyDisk(sandboxId, diskId, version) {
			if (backend.commitStickyDisk === undefined) throw new Error("The stub commits sticky disks");
			const committed = await backend.commitStickyDisk(sandboxId, diskId, version);
			const mapDigest = options.mapDigest?.();
			return mapDigest === undefined ? committed : { ...committed, mapDigest };
		},
		async capabilities() {
			const capabilities = await backend.capabilities();
			const [stub] = capabilities.hosts;
			if (!hosts.pooled || stub === undefined) return capabilities;
			const host = (id: string, poolId: string, more: Partial<BackendHost> = {}): BackendHost => ({
				...stub,
				id,
				name: id,
				poolId,
				...(options.arch?.[id] === undefined ? {} : { arch: options.arch[id] }),
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
					host("host_g", "pool_a", { meshAddress: "fd00:a::6" }),
				],
			};
		},
	});
	const api = createComputeApi({
		backend: wrap(createStubBackend()),
		stickyDisks: options.stickyDisks ?? true,
		...(options.templates === undefined ? {} : { templates: options.templates }),
		...(options.store === undefined ? {} : { store: options.store }),
		...(options.secretsKey === undefined ? {} : { secretsKey: options.secretsKey }),
		now: () => clock.now,
		authenticatePerson: async (request) =>
			request.headers.get("authorization") === "Bearer tom-token"
				? { userId: "usr_tom", name: "Tom", email: "tom@example.com", superAdmin: options.superAdmin ?? true }
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
		// The stub's host was first seen before these pools, so it went into the default one: moved, as a move does, and
		// the disks made there with it.
		await api.store.hosts.update(STUB_HOST_ID, (host) => ({ ...host, poolId: "pool_a" }));
		for (const disk of await api.store.stickyDisks.list()) {
			await api.store.stickyDisks.update(disk.id, (current) => ({ ...current, poolId: "pool_a" }));
		}
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
	/**
	 * A saved snapshot of a sandbox on the stub's host, in pool A (once `pool()` is called), its ref named as a host
	 * backend's are: the host, and `id` there.
	 */
	const saved = async (id: string) => {
		const sandbox = await client.createSandbox({ type: "microvm", wait: true });
		const snapshot = await client.saveSnapshot({ name: id, sandboxId: sandbox.id });
		const stored = await api.store.snapshots.update(snapshot.id, (current) => ({
			...current,
			ref: `${STUB_HOST_ID}/${id}`,
			poolId: "pool_a",
		}));
		if (stored === undefined) throw new Error("no snapshot");
		return stored;
	};
	return Object.assign(client, { api, clock, pool, committed, holders, saved });
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
const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const DIGEST = `sha256:${"1".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"2".repeat(64)}`;
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
				return tom.api.service.recordHoldings(hostId, tom.clock.now, {
					stickyDisks: [{ diskId: disk.id, versions: versions.map((each) => ({ version: each })) }],
				});
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
			await tom.api.service.recordHoldings(hostId, tom.clock.now, {
				stickyDisks: [{ diskId: disk.id, versions: [{ version: version.id }] }],
			});
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
			kid: (await tom.api.service.grantKeys())?.[0]?.id,
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
		// Pool B's host is refused: the disk is pool A's, and pools never share data.
		await expect(tom.api.service.locateDisk("host_c", request)).rejects.toMatchObject({ code: "not_found" });
		// With pool A's sync off its hosts' mesh is down: no holder there either.
		await tom.api.store.pools.update("pool_a", (pool) => ({ ...pool, sync: false }));
		expect(await tom.api.service.locateDisk(STUB_HOST_ID, request)).toEqual({ holders: [] });
		await tom.api.store.pools.update("pool_a", (pool) => ({ ...pool, sync: true }));
		// A move to pool B saved here but not yet in the registry: it isn't offered in pool A, and pool B is still refused.
		await tom.api.store.hosts.update("host_b", (host) => ({ ...host, poolId: "pool_b" }));
		expect((await tom.api.service.locateDisk(STUB_HOST_ID, request)).holders).toEqual([]);
		await expect(tom.api.service.locateDisk("host_c", request)).rejects.toMatchObject({ code: "not_found" });
		await tom.api.store.hosts.update("host_b", (host) => ({ ...host, poolId: "pool_a" }));
		// A revoked host, and a version or kind that isn't there, are refused.
		await expect(tom.api.service.locateDisk("host_e", request)).rejects.toMatchObject({ code: "not_found" });
		await expect(tom.api.service.locateDisk("host_b", { ...request, version: "sdv_missing" })).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(tom.api.service.locateDisk("host_b", { ...request, kind: "disk" })).rejects.toMatchObject({
			code: "invalid",
		});
		await expect(tom.api.service.locateDisk("host_b", { ...request, kind: "template" })).rejects.toMatchObject({
			code: "not_supported",
		});
	});

	for (const [name, kind] of [
		["memory", undefined],
		["SQLite", nodeSqliteDatabase],
		["Postgres", pgliteDatabase],
	] as const) {
		it(`keeps the root filesystems hosts report, each with its map digest, in ${name}`, {
			timeout: kind?.testTimeoutMs,
		}, async () => {
			const tom = setUp({
				...(kind === undefined ? {} : { store: await sqlStore(kind) }),
				secretsKey: SECRETS_KEY,
				templates: true,
			});
			await tom.pool();
			const report = (hostId: string, held: readonly { objectId: string; mapDigest: string }[]) => {
				tom.clock.now += 1;
				return tom.api.service.recordHoldings(hostId, tom.clock.now, {
					objects: {
						rootfs: held.map(({ objectId, mapDigest }) => ({
							objectId,
							versions: [{ version: "1", mapDigest }],
						})),
					},
				});
			};
			const rootfsHolders = async () =>
				(await tom.api.store.diskHolders.list())
					.filter((holder) => holder.kind === "rootfs")
					.map((holder) => [holder.hostId, holder.objectId, holder.mapDigest])
					.sort();
			// What isn't shaped as a root filesystem (a key, the one version, a map digest) is no copy of one.
			await report("host_b", [
				{ objectId: KEY, mapDigest: DIGEST },
				{ objectId: "../etc", mapDigest: DIGEST },
				{ objectId: OTHER_KEY, mapDigest: "md5:1" },
			]);
			expect(await rootfsHolders()).toEqual([["host_b", KEY, DIGEST]]);
			// A sticky disk report says nothing of root filesystems, nor one of root filesystems of sticky disks.
			tom.clock.now += 3 * 60_000;
			await tom.api.service.recordHoldings("host_b", tom.clock.now, { stickyDisks: [] });
			expect(await rootfsHolders()).toEqual([["host_b", KEY, DIGEST]]);
			// Made again, its bytes differ: the holder takes the new digest.
			await report("host_b", [{ objectId: KEY, mapDigest: OTHER_DIGEST }]);
			expect(await rootfsHolders()).toEqual([["host_b", KEY, OTHER_DIGEST]]);
			// Let go once a report a while after it no longer has it.
			await report("host_b", []);
			expect(await rootfsHolders()).toEqual([["host_b", KEY, OTHER_DIGEST]]);
			tom.clock.now += 3 * 60_000;
			await report("host_b", []);
			expect(await rootfsHolders()).toEqual([]);
		});
	}

	it("locates a root filesystem on its pool's holders of the digest most of them hold, with a grant naming the pool's owner", async () => {
		const tom = setUp({ templates: true });
		await tom.pool();
		const held = (hostId: string, mapDigest: string) =>
			tom.api.service.recordHoldings(hostId, tom.clock.now, {
				objects: { rootfs: [{ objectId: KEY, versions: [{ version: "1", mapDigest }] }] },
			});
		const request = { kind: "rootfs", objectId: KEY, version: "1" };
		// Nobody holds it yet: no holders, no digest.
		expect(await tom.api.service.locateDisk(STUB_HOST_ID, request)).toEqual({ holders: [] });
		await held("host_b", DIGEST);
		await held("host_c", DIGEST);
		await held("host_d", DIGEST);
		await held("host_e", DIGEST);
		const found = await tom.api.service.locateDisk(STUB_HOST_ID, request);
		// Not pool B's host, not the offline one, not the revoked one.
		expect(found).toMatchObject({ mapDigest: DIGEST, holders: [{ hostId: "host_b", address: "fd00:a::2" }] });
		const publicKey = await tom.api.service.grantPublicKey();
		if (publicKey === undefined || found.grant === undefined) throw new Error("no grant");
		expect(await verifyGrant(publicKey, found.grant, tom.clock.now)).toEqual({
			kind: "rootfs",
			objectId: KEY,
			version: "1",
			kid: (await tom.api.service.grantKeys())?.[0]?.id,
			accountId: OPERATOR_POOLS,
			from: ["host_b"],
			to: STUB_HOST_ID,
			exp: tom.clock.now + GRANT_TTL_MS,
		});
		// Two holders of another build of it outnumber the one: theirs is the digest, and they the holders.
		await held(STUB_HOST_ID, OTHER_DIGEST);
		await held("host_f", OTHER_DIGEST);
		expect(await tom.api.service.locateDisk("host_d", request)).toMatchObject({
			mapDigest: OTHER_DIGEST,
			holders: [
				{ hostId: STUB_HOST_ID, address: "fd00:a::1" },
				{ hostId: "host_f", address: "fd00:a::5" },
			],
		});
		// Pool B's host has no other holder in its pool.
		expect(await tom.api.service.locateDisk("host_c", request)).toEqual({ holders: [] });
		// A copy made in another pool (its host moved here since) isn't offered, and stays that pool's as its host goes on
		// reporting it.
		const madeElsewhere = (await tom.api.store.diskHolders.list()).find((holder) => holder.hostId === "host_f");
		if (madeElsewhere === undefined) throw new Error("no holder on host_f");
		await tom.api.store.diskHolders.put({ ...madeElsewhere, poolId: "pool_b" });
		await held("host_f", OTHER_DIGEST);
		const offered = (await tom.api.service.locateDisk("host_d", request)).holders.map((each) => each.hostId);
		expect(offered).not.toContain("host_f");
		expect(offered).toHaveLength(1);
		expect((await tom.api.store.diskHolders.get(madeElsewhere.id))?.poolId).toBe("pool_b");
		// A revoked host, a key or version that isn't one, are refused.
		await expect(tom.api.service.locateDisk("host_e", request)).rejects.toMatchObject({ code: "not_found" });
		await expect(tom.api.service.locateDisk("host_b", { ...request, objectId: "nope" })).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(tom.api.service.locateDisk("host_b", { ...request, version: "2" })).rejects.toMatchObject({
			code: "not_found",
		});
		// A host of another architecture isn't offered one: the same image is other bytes there.
		const mixed = setUp({ templates: true, arch: { host_b: "aarch64" } });
		await mixed.pool();
		await mixed.api.service.recordHoldings("host_b", mixed.clock.now, {
			objects: { rootfs: [{ objectId: KEY, versions: [{ version: "1", mapDigest: DIGEST }] }] },
		});
		expect(await mixed.api.service.locateDisk(STUB_HOST_ID, request)).toEqual({ holders: [] });
		// Templates off: refused, and nothing recorded.
		const off = setUp();
		await off.pool();
		await expect(off.api.service.locateDisk(STUB_HOST_ID, request)).rejects.toMatchObject({ code: "not_supported" });
		await off.api.service.recordHoldings("host_b", off.clock.now, {
			objects: { rootfs: [{ objectId: KEY, versions: [{ version: "1", mapDigest: DIGEST }] }] },
		});
		expect(await off.api.store.diskHolders.list()).toEqual([]);
		// Templates on with sticky disks off: there is a grant key.
		expect(await setUp({ stickyDisks: false, templates: true }).api.service.grantPublicKey()).toMatch(
			/^[A-Za-z0-9_-]{43}$/,
		);
	});

	it("offers a root filesystem only in the pool its host stamped it with, however late it reports it", async () => {
		const tom = setUp({ templates: true });
		await tom.pool();
		const report = (hostId: string, held: readonly { objectId: string; pool?: string }[]) => {
			tom.clock.now += 1;
			return tom.api.service.recordHoldings(hostId, tom.clock.now, {
				objects: {
					rootfs: held.map(({ objectId, pool }) => ({
						objectId,
						versions: [{ version: "1", mapDigest: DIGEST, ...(pool === undefined ? {} : { pool }) }],
					})),
				},
			});
		};
		const offered = async (objectId: string) =>
			(await tom.api.service.locateDisk(STUB_HOST_ID, { kind: "rootfs", objectId, version: "1" })).holders.map(
				(each) => each.hostId,
			);
		const poolOf = async (hostId: string, objectId: string) =>
			(await tom.api.store.diskHolders.list()).find(
				(holder) => holder.hostId === hostId && holder.objectId === objectId,
			)?.poolId;
		const fromB = "c".repeat(64);
		const unstamped = "d".repeat(64);
		// host_b, in pool A, stamped one copy in A and has one it made in pool B before it moved here (its map made only
		// now): each is its stamp's pool's, and only A's is offered to A.
		await report("host_b", [
			{ objectId: KEY, pool: "pool_a" },
			{ objectId: fromB, pool: "pool_b" },
		]);
		expect(await poolOf("host_b", KEY)).toBe("pool_a");
		expect(await poolOf("host_b", fromB)).toBe("pool_b");
		expect(await offered(KEY)).toEqual(["host_b"]);
		expect(await offered(fromB)).toEqual([]);
		// A copy with no stamp (made before stamps) is its host's pool's while the host has never moved; once it has,
		// it is no pool's.
		await report("host_f", [{ objectId: unstamped }]);
		expect(await offered(unstamped)).toEqual(["host_f"]);
		await tom.api.store.hosts.update("host_b", (host) => ({ ...host, poolSince: tom.clock.now }));
		await report("host_b", [
			{ objectId: KEY, pool: "pool_a" },
			{ objectId: fromB, pool: "pool_b" },
			{ objectId: unstamped },
		]);
		expect(await poolOf("host_b", unstamped)).toBeUndefined();
		expect(await offered(unstamped)).toEqual(["host_f"]);
		// The same bytes made again in another pool replace the copy, and back again.
		await report("host_b", [{ objectId: KEY, pool: "pool_b" }]);
		expect(await poolOf("host_b", KEY)).toBe("pool_b");
		expect(await offered(KEY)).toEqual([]);
		await report("host_b", [{ objectId: KEY, pool: "pool_a" }]);
		expect(await offered(KEY)).toEqual(["host_b"]);
	});

	it("sweeps revoked hosts' root filesystem holders with templates on and sticky disks off", async () => {
		const tom = setUp({ templates: true, stickyDisks: false });
		await tom.pool();
		await tom.api.service.recordHoldings("host_b", tom.clock.now, {
			objects: { rootfs: [{ objectId: KEY, versions: [{ version: "1", mapDigest: DIGEST }] }] },
		});
		expect(await tom.api.store.diskHolders.list()).toHaveLength(1);
		await tom.api.store.hosts.update("host_b", (host) => ({ ...host, state: "revoked" }));
		tom.clock.now += 11 * 60_000;
		await tom.api.service.sweep();
		await tom.api.service.idle();
		expect(await tom.api.store.diskHolders.list()).toEqual([]);
	});

	it("keeps the saved snapshots hosts report, and locates each version in the snapshot's pool, with a grant naming its account", async () => {
		const tom = setUp({ arch: { host_g: "aarch64" } });
		await tom.pool();
		const snap = await tom.saved("hs1");
		const report = (hostId: string, objects: readonly { objectId: string; versions: string[] }[]) => {
			tom.clock.now += 1;
			return tom.api.service.recordHoldings(hostId, tom.clock.now, {
				objects: {
					snapshot: objects.map(({ objectId, versions }) => ({
						objectId,
						versions: versions.map((version) => ({ version, mapDigest: version === "disk" ? DIGEST : OTHER_DIGEST })),
					})),
				},
			});
		};
		const snapshotHolders = async () =>
			(await tom.api.store.diskHolders.list())
				.filter((holder) => holder.kind === "snapshot")
				.map((holder) => [holder.hostId, holder.objectId, holder.version, holder.mapDigest])
				.sort();
		// Its host: its disk and memory. Not a snapshot the catalogue hasn't, nor a version or ID that isn't one.
		await report(STUB_HOST_ID, [
			{ objectId: "hs1", versions: ["disk", "memory", "1"] },
			{ objectId: "hs_unknown", versions: ["disk"] },
			{ objectId: "../x", versions: ["disk"] },
		]);
		// Copies: another host in its pool, which fetched its disk; another account's host, which may hold none of it.
		await report("host_b", [{ objectId: "hs1", versions: ["disk"] }]);
		await report("host_f", [{ objectId: "hs1", versions: ["disk"] }]);
		await report("host_g", [{ objectId: "hs1", versions: ["disk"] }]);
		expect(await snapshotHolders()).toEqual([
			["host_b", "hs1", "disk", DIGEST],
			["host_g", "hs1", "disk", DIGEST],
			[STUB_HOST_ID, "hs1", "disk", DIGEST],
			[STUB_HOST_ID, "hs1", "memory", OTHER_DIGEST],
		]);
		const disk = { kind: "snapshot", objectId: "hs1", version: "disk" };
		const found = await tom.api.service.locateDisk("host_d", disk);
		// Not host_g, of another architecture.
		expect(found).toMatchObject({
			mapDigest: DIGEST,
			holders: [
				{ hostId: STUB_HOST_ID, address: "fd00:a::1" },
				{ hostId: "host_b", address: "fd00:a::2" },
			],
		});
		const publicKey = await tom.api.service.grantPublicKey();
		if (publicKey === undefined || found.grant === undefined) throw new Error("no grant");
		expect(await verifyGrant(publicKey, found.grant, tom.clock.now)).toMatchObject({
			kind: "snapshot",
			objectId: "hs1",
			version: "disk",
			accountId: snap.accountId,
			from: [STUB_HOST_ID, "host_b"],
			to: "host_d",
		});
		// Its memory only where it is.
		expect(await tom.api.service.locateDisk("host_b", { ...disk, version: "memory" })).toMatchObject({
			mapDigest: OTHER_DIGEST,
			holders: [{ hostId: STUB_HOST_ID }],
		});
		// Another pool's host, another account's, a revoked one, a version that isn't one: none of it.
		for (const [hostId, request] of [
			["host_c", disk],
			["host_f", disk],
			["host_b", { ...disk, version: "1" }],
			["host_e", disk],
		] as const) {
			await expect(tom.api.service.locateDisk(hostId, request)).rejects.toMatchObject({ code: "not_found" });
		}
		// A snapshot no host holds: no holders.
		expect(await tom.api.service.locateDisk("host_b", { ...disk, objectId: "hs_unknown" })).toEqual({ holders: [] });
		// Its own host no longer holds it: the copies are still its, by the ref they were recorded with, and a new one is
		// taken too.
		tom.clock.now += 3 * 60_000;
		await report(STUB_HOST_ID, []);
		expect((await snapshotHolders()).map(([hostId]) => hostId)).not.toContain(STUB_HOST_ID);
		expect(await tom.api.service.locateDisk("host_d", disk)).toMatchObject({
			holders: [{ hostId: "host_b" }],
		});
		await report("host_d", [{ objectId: "hs1", versions: ["disk"] }]);
		expect((await snapshotHolders()).map(([hostId]) => hostId)).toContain("host_d");
		// Let go once a host no longer reports it.
		tom.clock.now += 3 * 60_000;
		await report("host_b", []);
		expect((await snapshotHolders()).map(([hostId]) => hostId)).not.toContain("host_b");
		// Sticky disks and templates off: no grants, so nothing synced.
		const off = setUp({ stickyDisks: false });
		await off.pool();
		await expect(off.api.service.locateDisk(STUB_HOST_ID, disk)).rejects.toMatchObject({ code: "not_supported" });
	});

	it("has a host fetch a saved snapshot's disk from its pool's holders, and deletes the copies with the snapshot", async () => {
		const fetches: { readonly hostId: string; readonly fetch: BackendDiskFetch }[] = [];
		const deleted: string[] = [];
		const tom = setUp({
			fetchDisk: async (hostId, fetch) => {
				fetches.push({ hostId, fetch });
			},
			deletedSnapshot: (ref) => deleted.push(ref),
		});
		await tom.pool();
		const snap = await tom.saved("hs1");
		// Not before its host reports it.
		await expect(tom.fetchHostSnapshot("host_b", { snapshotId: snap.id })).rejects.toMatchObject({ code: "conflict" });
		await tom.api.service.recordHoldings(STUB_HOST_ID, tom.clock.now, {
			objects: { snapshot: [{ objectId: "hs1", versions: [{ version: "disk", mapDigest: DIGEST }] }] },
		});
		await tom.fetchHostSnapshot("host_b", { snapshotId: snap.id });
		expect(fetches).toEqual([
			{
				hostId: "host_b",
				fetch: expect.objectContaining({
					kind: "snapshot",
					objectId: "hs1",
					version: "disk",
					mapDigest: DIGEST,
					holders: [{ hostId: STUB_HOST_ID, address: "fd00:a::1" }],
				}),
			},
		]);
		// Its own host has no other holder; another pool's host may not hold it; a snapshot that isn't there.
		await expect(tom.fetchHostSnapshot(STUB_HOST_ID, { snapshotId: snap.id })).rejects.toMatchObject({
			code: "conflict",
		});
		await expect(tom.fetchHostSnapshot("host_c", { snapshotId: snap.id })).rejects.toMatchObject({ code: "not_found" });
		await expect(tom.fetchHostSnapshot("host_b", { snapshotId: "snap_missing" })).rejects.toMatchObject({
			code: "not_found",
		});
		// host_b has its copy now: deleting the snapshot deletes its bytes on its host, then the copy, and forgets both.
		tom.clock.now += 1;
		await tom.api.service.recordHoldings("host_b", tom.clock.now, {
			objects: { snapshot: [{ objectId: "hs1", versions: [{ version: "disk", mapDigest: DIGEST }] }] },
		});
		await tom.deleteSnapshot(snap.id);
		expect(deleted).toEqual([`${STUB_HOST_ID}/hs1`, "host_b/hs1"]);
		expect((await tom.api.store.diskHolders.list()).filter((holder) => holder.kind === "snapshot")).toEqual([]);
	});

	it("has a host fetch a version from its pool's holders, with a grant naming it", async () => {
		const fetches: { readonly hostId: string; readonly fetch: BackendDiskFetch }[] = [];
		const tom = setUp({
			fetchDisk: async (hostId, fetch) => {
				fetches.push({ hostId, fetch });
			},
		});
		const { disk, version } = await tom.committed();
		await tom.pool();
		await tom.fetchHostStickyDisk("host_b", { stickyDiskId: disk.id, version: version.id });
		expect(fetches).toHaveLength(1);
		const [sent] = fetches;
		expect(sent?.hostId).toBe("host_b");
		expect(sent?.fetch).toMatchObject({
			kind: "sticky",
			objectId: disk.id,
			version: version.id,
			holders: [{ hostId: STUB_HOST_ID, address: "fd00:a::1" }],
		});
		const publicKey = await tom.api.service.grantPublicKey();
		if (publicKey === undefined || sent?.fetch.grant === undefined) throw new Error("no grant");
		expect(await verifyGrant(publicKey, sent.fetch.grant, tom.clock.now)).toMatchObject({
			from: [STUB_HOST_ID],
			to: "host_b",
		});
		// The host it was made on has no other holder to fetch from; pool B's host may not hold pool A's disk; a revoked
		// host fetches nothing; a disk or version that isn't there.
		await expect(
			tom.fetchHostStickyDisk(STUB_HOST_ID, { stickyDiskId: disk.id, version: version.id }),
		).rejects.toMatchObject({ code: "conflict" });
		await expect(
			tom.fetchHostStickyDisk("host_c", { stickyDiskId: disk.id, version: version.id }),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(
			tom.fetchHostStickyDisk("host_e", { stickyDiskId: disk.id, version: version.id }),
		).rejects.toMatchObject({ code: "conflict" });
		await expect(
			tom.fetchHostStickyDisk("host_b", { stickyDiskId: "sdk_missing", version: version.id }),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(
			tom.fetchHostStickyDisk("host_b", { stickyDiskId: disk.id, version: "sdv_missing" }),
		).rejects.toMatchObject({ code: "not_found" });
		expect(fetches).toHaveLength(1);
		// A backend whose hosts don't sync.
		const plain = setUp();
		const other = await plain.committed();
		await plain.pool();
		await expect(
			plain.fetchHostStickyDisk("host_b", { stickyDiskId: other.disk.id, version: other.version.id }),
		).rejects.toMatchObject({ code: "not_supported" });
	});

	for (const [name, kind] of [
		["memory", undefined],
		["SQLite", nodeSqliteDatabase],
		["Postgres", pgliteDatabase],
	] as const) {
		it(`notes a sandbox's start on a disk without the account fence taking the disk or its tombstone out, in ${name}`, {
			timeout: kind?.testTimeoutMs,
		}, async () => {
			const store = kind === undefined ? createMemoryStore() : await sqlStore(kind);
			const fenced = fenceClosedAccounts(store);
			await store.accounts.put({
				id: "acc_1",
				kind: "personal",
				name: "Tom",
				defaultVisibility: "private",
				createdAt: 0,
			});
			const day = 24 * 3_600_000;
			await fenced.stickyDiskWrites.create({ ...DISK, ranOn: { host_old: 10 * day - STICKY_PREFETCH_MS } });
			// Noted once an hour per host; an entry past 7 days goes as one is written; a commit meanwhile is kept.
			await fenced.stickyDiskWrites.noteRun(DISK.id, "host_a", 10 * day);
			await fenced.stickyDiskWrites.noteRun(DISK.id, "host_a", 10 * day + 30 * 60_000);
			await fenced.stickyDiskWrites.commit({ ...VERSION, id: "sdv_2", diskId: DISK.id }, 10 * day);
			await fenced.stickyDiskWrites.noteRun(DISK.id, "host_b", 10 * day + 1);
			expect(await store.stickyDisks.get(DISK.id)).toMatchObject({
				head: "sdv_2",
				ranOn: { host_a: 10 * day, host_b: 10 * day + 1 },
			});
			expect(Object.keys((await store.stickyDisks.get(DISK.id))?.ranOn ?? {}).sort()).toEqual(["host_a", "host_b"]);
			// The account closes: a note landing then leaves the live disk there for the teardown to tombstone, and leaves its
			// tombstone alone after, unchanged.
			await store.accounts.update("acc_1", (account) => ({ ...account, closedAt: 11 * day }));
			await fenced.stickyDiskWrites.noteRun(DISK.id, "host_c", 11 * day);
			expect((await store.stickyDisks.get(DISK.id))?.ranOn?.host_c).toBe(11 * day);
			const tombstone = await fenced.stickyDiskWrites.tombstone(DISK.id, 11 * day);
			await fenced.stickyDiskWrites.noteRun(DISK.id, "host_d", 12 * day);
			expect(await store.stickyDisks.get(DISK.id)).toEqual(tombstone);
		});
	}

	it("sends a new head to the hosts in its pool that started a sandbox with it in the last 7 days", async () => {
		const fetches: { readonly hostId: string; readonly fetch: BackendDiskFetch }[] = [];
		let digest: string | undefined = `sha256:${"a".repeat(64)}`;
		let reports: BackendStickyHoldings[] = [];
		const tom = setUp({
			fetchDisk: async (hostId, fetch) => {
				fetches.push({ hostId, fetch });
			},
			mapDigest: () => digest,
			holdings: () => reports,
		});
		const { disk, sandbox } = await tom.committed();
		await tom.api.service.idle();
		// Its sandbox's start on the stub's host was written down; another start within the hour writes nothing.
		const started = tom.clock.now;
		expect((await tom.api.store.stickyDisks.get(disk.id))?.ranOn).toEqual({ [STUB_HOST_ID]: started });
		tom.clock.now += 30 * 60_000;
		await tom.createSandbox({ type: "microvm", stickyDisks: [{ disk: "cache", path: "/cache" }], wait: true });
		await tom.api.service.idle();
		expect((await tom.api.store.stickyDisks.get(disk.id))?.ranOn).toEqual({ [STUB_HOST_ID]: started });
		await tom.pool();
		// Its sandbox moved with its host, so its commits are made in pool A.
		await tom.api.store.sandboxes.update(sandbox.id, (current) => ({ ...current, poolId: "pool_a" }));
		const day = 24 * 3_600_000;
		const ranOn = (hosts: { readonly [hostId: string]: number }) =>
			tom.api.store.stickyDisks.update(disk.id, (current) => ({ ...current, ranOn: hosts }));
		// b lately; g 8 days ago; c in another pool; d away; e revoked; f another account's, which may not hold it.
		const at = tom.clock.now;
		await ranOn({
			[STUB_HOST_ID]: at,
			host_b: at - day,
			host_g: at - 8 * day,
			host_c: at,
			host_d: at,
			host_e: at,
			host_f: at,
		});
		const head = await tom.commitStickyDisk(sandbox.id, disk.id);
		await tom.api.service.idle();
		expect(fetches.map((sent) => sent.hostId)).toEqual(["host_b"]);
		expect(fetches[0]?.fetch).toMatchObject({
			kind: "sticky",
			objectId: disk.id,
			version: head.id,
			mapDigest: digest,
			holders: [{ hostId: STUB_HOST_ID, address: "fd00:a::1" }],
		});
		const publicKey = await tom.api.service.grantPublicKey();
		const grant = fetches[0]?.fetch.grant;
		if (publicKey === undefined || grant === undefined) throw new Error("no grant");
		expect(await verifyGrant(publicKey, grant, tom.clock.now)).toMatchObject({ to: "host_b", version: head.id });

		// With its pool's sync off, nothing is sent.
		fetches.length = 0;
		await tom.api.store.pools.update("pool_a", ({ sync: _sync, ...pool }) => pool);
		await tom.commitStickyDisk(sandbox.id, disk.id);
		await tom.api.service.idle();
		expect(fetches).toEqual([]);

		// A head committed before its map was made is sent once the sweep has its digest from its host.
		await tom.api.store.pools.update("pool_a", (pool) => ({ ...pool, sync: true }));
		digest = undefined;
		await ranOn({ host_b: tom.clock.now, host_g: tom.clock.now });
		const unmapped = await tom.commitStickyDisk(sandbox.id, disk.id);
		await tom.api.service.idle();
		expect(fetches).toEqual([]);
		// g has it already (fetched when a sandbox there asked for it), so isn't sent it.
		await tom.api.service.recordHoldings("host_g", tom.clock.now, {
			stickyDisks: [{ diskId: disk.id, versions: [{ version: unmapped.id }] }],
		});
		tom.clock.now += 11 * 60_000;
		reports = [
			{
				hostId: STUB_HOST_ID,
				reportedAt: tom.clock.now,
				disks: [
					{ diskId: disk.id, versions: [unmapped.id], mapDigests: { [unmapped.id]: `sha256:${"b".repeat(64)}` } },
				],
			},
		];
		await tom.api.service.sweep();
		await tom.api.service.idle();
		expect(fetches.map((sent) => [sent.hostId, sent.fetch.version, sent.fetch.mapDigest])).toEqual([
			["host_b", unmapped.id, `sha256:${"b".repeat(64)}`],
		]);
	});

	it("never forgets a version another host still holds", async () => {
		let reports: BackendStickyHoldings[] = [];
		const tom = setUp({ holdings: () => reports });
		const wrapped = tom.api.service;
		const { disk, sandbox, version: old } = await tom.committed();
		const head = await tom.commitStickyDisk(sandbox.id, disk.id);
		await tom.pool();
		await wrapped.recordHoldings("host_b", tom.clock.now, {
			stickyDisks: [{ diskId: disk.id, versions: [{ version: old.id }] }],
		});
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
		await wrapped.recordHoldings("host_b", tom.clock.now, { stickyDisks: [{ diskId: disk.id, versions: [] }] });
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

	it("replaces a grant key that can't be opened here, keeping the old one accepted, and answers a missing version with not_found", async () => {
		const store = await sqlStore(nodeSqliteDatabase);
		const tom = setUp({ store, secretsKey: SECRETS_KEY });
		const { disk, version } = await tom.committed();
		await tom.pool();
		await tom.api.service.recordHoldings("host_b", tom.clock.now, {
			stickyDisks: [{ diskId: disk.id, versions: [{ version: version.id }] }],
		});
		// A key sealed with another secrets key: it can't be opened here.
		const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
		const old = await setUp({ store, secretsKey: other }).api.service.grantPublicKey();
		expect(old).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const request = { kind: "sticky", objectId: disk.id, version: version.id };
		await expect(
			tom.api.service.locateDisk(STUB_HOST_ID, { ...request, version: "sdv_missing" }),
		).rejects.toMatchObject({ code: "not_found" });
		await expect(tom.api.service.locateDisk("host_c", request)).rejects.toMatchObject({ code: "not_found" });
		// Made only just now, by a gateway whose secrets key differs: left, so gateways don't replace each other's in turn.
		await expect(tom.api.service.locateDisk(STUB_HOST_ID, request)).rejects.toMatchObject({ code: "unavailable" });
		// Older: replaced rather than answered unavailable. The new key signs at once (nothing else can), and the old one is
		// accepted for a grant's lifetime and a minute.
		tom.clock.now += GRANT_KEY_REPLACE_AFTER_MS;
		const found = await tom.api.service.locateDisk(STUB_HOST_ID, request);
		const keys = await tom.api.service.grantKeys();
		if (keys === undefined || found.grant === undefined) throw new Error("no grant");
		expect(keys[0]?.publicKey).not.toBe(old);
		expect(keys.slice(1)).toEqual([
			{ id: expect.any(String), publicKey: old, until: tom.clock.now + GRANT_KEY_OVERLAP_MS },
		]);
		expect(await verifyGrant(keys, found.grant, tom.clock.now)).toMatchObject({ kid: keys[0]?.id, to: STUB_HOST_ID });
		// Kept: another gateway with this secrets key signs with the new key and doesn't replace it again.
		expect(await setUp({ store, secretsKey: SECRETS_KEY }).api.service.grantKeys()).toEqual(keys);
		// The gateway with the other secrets key can't sign with it, and leaves it: it is only just made.
		const elsewhere = setUp({ store, secretsKey: other });
		await elsewhere.pool();
		elsewhere.clock.now = tom.clock.now;
		await expect(elsewhere.api.service.locateDisk(STUB_HOST_ID, request)).rejects.toMatchObject({
			code: "unavailable",
		});
		expect(await tom.api.service.grantKeys()).toEqual(keys);
	});

	it("rotates the grant key: hosts are given the new key first, it signs a few minutes on, and the old one is accepted for a grant's lifetime more", async () => {
		const store = await sqlStore(nodeSqliteDatabase);
		let told = 0;
		const tom = setUp({
			store,
			secretsKey: SECRETS_KEY,
			grantKeysChanged: async () => {
				told++;
			},
		});
		const { disk, version } = await tom.committed();
		await tom.pool();
		await tom.api.service.recordHoldings("host_b", tom.clock.now, {
			stickyDisks: [{ diskId: disk.id, versions: [{ version: version.id }] }],
		});
		const request = { kind: "sticky", objectId: disk.id, version: version.id };
		const sign = async () => {
			const { grant } = await tom.api.service.locateDisk(STUB_HOST_ID, request);
			if (grant === undefined) throw new Error("no grant");
			return grant;
		};
		const before = await tom.getGrantKeys();
		expect(before).toEqual({
			current: {
				id: expect.stringMatching(/^[A-Za-z0-9_-]{12}$/),
				publicKey: expect.any(String),
				since: tom.clock.now,
			},
			retired: [],
		});
		tom.clock.now += 1000;
		const rotatedAt = tom.clock.now;
		const rotated = await tom.rotateGrantKey();
		const from = rotatedAt + GRANT_KEY_PUBLISH_MS;
		expect(rotated).toEqual({
			current: before.current,
			next: { id: expect.any(String), publicKey: expect.any(String), from },
			retired: [],
		});
		const next = rotated.next;
		if (next === undefined) throw new Error("no next key");
		await vi.waitFor(() => expect(told).toBe(1));
		// Published: hosts accept it now, the key that signs first, with when they stop accepting that one, so a host told
		// nothing more still stops then. Until its time, grants are still the old key's.
		const published = await tom.api.service.grantKeys();
		expect(published).toEqual([
			{ id: before.current.id, publicKey: before.current.publicKey, until: from + GRANT_KEY_OVERLAP_MS },
			{ id: next.id, publicKey: next.publicKey, from },
		]);
		const old = await sign();
		expect(await verifyGrant(before.current.publicKey, old, tom.clock.now)).toMatchObject({ kid: before.current.id });
		// A host that heard nothing after the rotation accepts it past the switch, for its life (the key's `until` is
		// enforced as `verifyGrant` checks it).
		expect(await verifyGrant(published ?? [], old, from + 1)).toMatchObject({ kid: before.current.id });
		// From its time it signs, on every gateway, with no write; the old key is accepted for a grant's lifetime and a minute.
		tom.clock.now = from;
		const fresh = await sign();
		expect(await verifyGrant(next.publicKey, fresh, tom.clock.now)).toMatchObject({ kid: next.id });
		expect(await setUp({ store, secretsKey: SECRETS_KEY, now: from }).getGrantKeys()).toEqual({
			current: { id: next.id, publicKey: next.publicKey, since: from },
			retired: [{ id: before.current.id, publicKey: before.current.publicKey, until: from + GRANT_KEY_OVERLAP_MS }],
		});
		const keys = (await tom.api.service.grantKeys()) ?? [];
		expect(await verifyGrant(keys, old, tom.clock.now)).toMatchObject({ kid: before.current.id });
		// A rotation while one is published replaces it, and still accepts the one it replaced until a grant's lifetime after
		// its time: it may have begun signing on another gateway just as this rotation was written.
		const again = await tom.rotateGrantKey();
		const twice = await tom.rotateGrantKey();
		expect(twice.next?.id).not.toBe(again.next?.id);
		expect(twice).toMatchObject({
			current: { id: next.id },
			retired: [
				{ id: before.current.id },
				{ id: again.next?.id, until: (again.next?.from ?? 0) + GRANT_KEY_OVERLAP_MS },
			],
		});
		tom.clock.now = from + GRANT_KEY_OVERLAP_MS;
		expect(await verifyGrant(keys, old, tom.clock.now - 1)).toBeUndefined();
		// By then the last rotation's key signs too, and the key before it is retired, with the published one it replaced.
		const until = (twice.next?.from ?? 0) + GRANT_KEY_OVERLAP_MS;
		expect(await tom.getGrantKeys()).toEqual({
			current: { id: twice.next?.id, publicKey: twice.next?.publicKey, since: twice.next?.from },
			retired: [
				{ id: again.next?.id, publicKey: again.next?.publicKey, until },
				{ id: next.id, publicKey: next.publicKey, until },
			],
		});
		// A super-admin's only.
		const someone = setUp({ store, secretsKey: SECRETS_KEY, superAdmin: false });
		await expect(someone.rotateGrantKey()).rejects.toMatchObject({ code: "forbidden" });
		await expect(someone.getGrantKeys()).rejects.toMatchObject({ code: "forbidden" });
		// With no grant key to have, refused.
		await expect(setUp({ stickyDisks: false }).rotateGrantKey()).rejects.toMatchObject({ code: "not_supported" });
		await expect(setUp({ store: await sqlStore(nodeSqliteDatabase) }).getGrantKeys()).rejects.toMatchObject({
			code: "not_supported",
		});
	});

	it("keeps a published key a rotation replaces just as it began signing on another gateway", async () => {
		const store = await sqlStore(nodeSqliteDatabase);
		const [tom, other] = [setUp({ store, secretsKey: SECRETS_KEY }), setUp({ store, secretsKey: SECRETS_KEY })];
		const { disk, version } = await tom.committed();
		await tom.pool();
		await other.pool();
		await tom.api.service.recordHoldings("host_b", tom.clock.now, {
			stickyDisks: [{ diskId: disk.id, versions: [{ version: version.id }] }],
		});
		const { next } = await tom.rotateGrantKey();
		if (next === undefined) throw new Error("no next key");
		// Its time comes: the other gateway signs with it, while this one, a moment behind, rotates again.
		other.clock.now = next.from;
		const { grant } = await other.api.service.locateDisk(STUB_HOST_ID, {
			kind: "sticky",
			objectId: disk.id,
			version: version.id,
		});
		if (grant === undefined) throw new Error("no grant");
		expect(await verifyGrant(next.publicKey, grant, next.from)).toMatchObject({ kid: next.id });
		tom.clock.now = next.from - 1;
		await tom.rotateGrantKey();
		// Hosts still accept that grant for its life, and the key no longer once a grant's lifetime has passed after its time.
		const keys = (await other.api.service.grantKeys()) ?? [];
		expect(keys).toContainEqual({ id: next.id, publicKey: next.publicKey, until: next.from + GRANT_KEY_OVERLAP_MS });
		expect(await verifyGrant(keys, grant, next.from + GRANT_TTL_MS - 1)).toMatchObject({ kid: next.id });
		expect(await verifyGrant(keys, grant, next.from + GRANT_KEY_OVERLAP_MS)).toBeUndefined();
	});

	it("checks a grant with the key its kid names, and one from before key IDs with any key", async () => {
		const [one, two] = [await createGrantKey(), await createGrantKey()];
		const grant = {
			kind: "sticky",
			objectId: "sdk_1",
			version: "sdv_1",
			accountId: "acc_1",
			from: ["host_b"],
			to: "host_a",
			exp: 2000,
		} as const;
		const token = await two.key.sign(grant);
		const keys = [
			{ id: one.key.id, publicKey: one.key.publicKey },
			{ id: two.key.id, publicKey: two.key.publicKey, until: 1500 },
		];
		expect(await verifyGrant(keys, token, 1000)).toEqual({ ...grant, kid: two.key.id });
		// Past the key's time; a key of another ID; the key named but given under another ID.
		expect(await verifyGrant(keys, token, 1500)).toBeUndefined();
		expect(await verifyGrant(keys.slice(0, 1), token, 1000)).toBeUndefined();
		expect(await verifyGrant([{ id: one.key.id, publicKey: two.key.publicKey }], token, 1000)).toBeUndefined();
		// A key with no ID (a single key given) is tried for any grant.
		expect(await verifyGrant([{ publicKey: two.key.publicKey }], token, 1000)).toMatchObject({ to: "host_a" });
		expect(await verifyGrant(two.key.publicKey, token, 1000)).toMatchObject({ to: "host_a" });
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
	it("lands one rotation of several at once, and replaces a key none can open only once", async () => {
		const kind = testDatabaseKinds().find((candidate) => candidate.name === "Postgres");
		if (kind === undefined) throw new Error("No Postgres kind");
		const database = await kind.open();
		cleanups.push(() => database.close());
		await migrateComputeStore(database.driver);
		const gateway = () => setUp({ store: createSqlComputeStore(database.driver), secretsKey: SECRETS_KEY });
		const gateways = [gateway(), gateway(), gateway()];
		const first = await gateways[0]?.getGrantKeys();
		// Six rotations at once over the pool's connections: each publishes its own key, the last write's is kept, and the
		// key that signs is untouched.
		const rotated = await Promise.all([...gateways, ...gateways].map((each) => each.rotateGrantKey()));
		expect(new Set(rotated.map((keys) => keys.next?.id)).size).toBe(6);
		const after = await gateways[0]?.getGrantKeys();
		expect(after?.current).toEqual(first?.current);
		expect(rotated.map((keys) => keys.next?.id)).toContain(after?.next?.id);
		await database.driver.query("DELETE FROM compute_api_records WHERE kind = ? AND id = ?", ["settings", "grantKey"]);
		// A key sealed with a secrets key these gateways don't have: of three replacing it at once as they sign, one write wins.
		const tom = gateways[0];
		if (tom === undefined) throw new Error("no gateway");
		const { disk, version } = await tom.committed();
		for (const each of gateways) await each.pool();
		await tom.api.service.recordHoldings("host_b", tom.clock.now, {
			stickyDisks: [{ diskId: disk.id, versions: [{ version: version.id }] }],
		});
		const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
		const elsewhere = await setUp({ store: createSqlComputeStore(database.driver), secretsKey: other }).getGrantKeys();
		const request = { kind: "sticky", objectId: disk.id, version: version.id };
		for (const each of gateways) each.clock.now += GRANT_KEY_REPLACE_AFTER_MS;
		const grants = await Promise.all(gateways.map((each) => each.api.service.locateDisk(STUB_HOST_ID, request)));
		const replaced = await tom.getGrantKeys();
		expect(replaced.retired.map((key) => key.id)).toEqual([elsewhere.current.id]);
		for (const { grant } of grants) {
			if (grant === undefined) throw new Error("no grant");
			expect(await verifyGrant(replaced.current.publicKey, grant, tom.clock.now)).toMatchObject({
				kid: replaced.current.id,
			});
		}
	});

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

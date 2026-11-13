// The disk store's catalogue of copies (docs/design/disk-store.md, 2c): holders reconciled from hosts' reports,
// `disk.locate`'s answers within a pool, signed fetch grants, and the sweep keeping a version another host holds.
import { createKantelClient } from "@kantel/api/sdk";
import { nodeSqliteDatabase, pgliteDatabase, type TestDatabaseKind } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendHost, BackendStickyHoldings, SandboxBackend } from "../src/backend.ts";
import { createGrantKey, GRANT_TTL_MS, verifyGrant } from "../src/grants.ts";
import { type ComputeApi, createComputeApi } from "../src/http.ts";
import { createSqlComputeStore, migrateComputeStore } from "../src/sql-store.ts";
import { type ComputeStore, OPERATOR_POOLS } from "../src/store.ts";
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
			await api.store.pools.put({ id, owner: OPERATOR_POOLS, name, createdAt: clock.now });
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

describe("disk holders", () => {
	for (const [name, kind] of [
		["memory", undefined],
		["SQLite", nodeSqliteDatabase],
		["Postgres", pgliteDatabase],
	] as const) {
		it(`adds and removes a host's holders as its reports say, in ${name}`, async () => {
			const tom = setUp({ ...(kind === undefined ? {} : { store: await sqlStore(kind) }), secretsKey: SECRETS_KEY });
			const { disk, version } = await tom.committed();
			// The host it was made on holds it from the commit.
			expect(await tom.holders(version.id)).toEqual([[STUB_HOST_ID, "held"]]);
			const report = (hostId: string, versions: readonly string[]) =>
				tom.api.service.recordStickyHoldings(hostId, tom.clock.now, [
					{ diskId: disk.id, versions: versions.map((each) => ({ version: each })) },
				]);
			// Another host reports it, and a version the catalogue doesn't have, which is no copy of anything.
			await report("host_b", [version.id, "sdv_unknown"]);
			expect(await tom.holders(version.id)).toEqual([
				["host_b", "held"],
				[STUB_HOST_ID, "held"],
			]);
			expect(await tom.holders("sdv_unknown")).toEqual([]);
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

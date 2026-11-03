// The registry's records behave the same in memory and on every SQL driver a target uses: a join token spent once,
// hosts found by credential hash, and placements listed per host.
import { testDatabaseKinds } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
	createMemoryHostStore,
	createSqlHostStore,
	type HostRecord,
	type HostStore,
	migrateHosts,
	type PlacementRecord,
} from "../src/store.ts";

const host = (id: string, joinedAt: number, credentialHash = `hash-${id}`): HostRecord => ({
	id,
	name: id,
	labels: {},
	credentialHash,
	revoked: false,
	draining: false,
	joinedAt,
});

const placement = (sandboxId: string, hostId: string, createdAt: number): PlacementRecord => ({
	sandboxId,
	hostId,
	tier: "microvm",
	size: "default",
	vcpus: 2,
	memoryMiB: 2048,
	diskGiB: 20,
	state: "running",
	createdAt,
	updatedAt: createdAt,
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function behaves(open: () => Promise<HostStore>) {
	it("spends a join token once, and never after it expires", async () => {
		const store = await open();
		await store.insertJoinToken({ id: "t1", hash: "h1", labels: { region: "eu" }, createdAt: 1, expiresAt: 100 });
		await store.insertJoinToken({ id: "t2", hash: "h2", labels: {}, createdAt: 1, expiresAt: 100 });
		const spent = await store.spendJoinToken("h1", "host_a", 50);
		expect(spent).toMatchObject({ id: "t1", usedAt: 50, hostId: "host_a", labels: { region: "eu" } });
		expect(await store.spendJoinToken("h1", "host_b", 51)).toBeUndefined();
		expect(await store.spendJoinToken("h2", "host_c", 100)).toBeUndefined();
		expect(await store.spendJoinToken("nope", "host_d", 1)).toBeUndefined();
	});

	it("finds hosts by ID and credential, lists oldest first and replaces a record", async () => {
		const store = await open();
		await store.insertHost(host("host_b", 20));
		await store.insertHost(host("host_a", 10));
		expect((await store.listHosts()).map((h) => h.id)).toEqual(["host_a", "host_b"]);
		expect((await store.hostByCredential("hash-host_b"))?.id).toBe("host_b");
		expect(await store.hostByCredential("other")).toBeUndefined();
		await store.putHost({ ...host("host_a", 10), draining: true, lastSeenAt: 99 });
		expect(await store.getHost("host_a")).toMatchObject({ draining: true, lastSeenAt: 99 });
		expect(await store.getHost("host_z")).toBeUndefined();
	});

	it("keeps placements per host and replaces one by sandbox", async () => {
		const store = await open();
		await store.putPlacement(placement("s2", "host_a", 2));
		await store.putPlacement(placement("s1", "host_a", 1));
		await store.putPlacement(placement("s3", "host_b", 3));
		expect((await store.placementsOn("host_a")).map((p) => p.sandboxId)).toEqual(["s1", "s2"]);
		await store.putPlacement({ ...placement("s1", "host_a", 1), state: "stopped" });
		expect((await store.getPlacement("s1"))?.state).toBe("stopped");
		await store.removePlacement("s1");
		expect(await store.getPlacement("s1")).toBeUndefined();
		expect((await store.placementsOn("host_a")).map((p) => p.sandboxId)).toEqual(["s2"]);
	});
}

describe("memory", () => {
	behaves(async () => createMemoryHostStore());
});

for (const kind of testDatabaseKinds()) {
	describe(kind.name, { ...(kind.testTimeoutMs === undefined ? {} : { timeout: kind.testTimeoutMs }) }, () => {
		behaves(async () => {
			const database = await kind.open();
			cleanups.push(() => database.close());
			await migrateHosts(database.driver);
			await migrateHosts(database.driver);
			return createSqlHostStore(database.driver);
		});
	});
}

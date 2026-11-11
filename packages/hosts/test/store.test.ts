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

	it("changes a host as it is now, so a report never undoes an operator's change, or a revocation", async () => {
		const store = await open();
		await store.insertHost(host("host_a", 10));
		// An operator drains it and labels it, then lifts the drain; a report runs on whatever is stored.
		await store.updateHost("host_a", (latest) => ({ ...latest, draining: true, labels: { region: "eu" } }));
		const reported = await store.updateHost("host_a", (latest) => ({ ...latest, lastSeenAt: 5 }));
		expect(reported).toMatchObject({ lastSeenAt: 5, draining: true, labels: { region: "eu" } });
		await store.updateHost("host_a", (latest) => ({ ...latest, draining: false }));
		await store.updateHost("host_a", (latest) => ({ ...latest, lastSeenAt: 6 }));
		expect((await store.getHost("host_a"))?.draining).toBe(false);
		// Two at once both land: each is redone on what the other wrote.
		await Promise.all([
			store.updateHost("host_a", (latest) => ({ ...latest, labels: { region: "us" } })),
			store.updateHost("host_a", (latest) => ({ ...latest, lastSeenAt: 8 })),
		]);
		expect(await store.getHost("host_a")).toMatchObject({ lastSeenAt: 8, labels: { region: "us" } });
		// A revoked host stays revoked, and an unknown one or a no-op writes nothing.
		await store.putHost({ ...((await store.getHost("host_a")) as HostRecord), revoked: true });
		const after = await store.updateHost("host_a", (latest) => ({ ...latest, revoked: false, lastSeenAt: 9 }));
		expect(after).toMatchObject({ revoked: true, lastSeenAt: 9 });
		expect(await store.updateHost("nope", (latest) => latest)).toBeUndefined();
		expect(await store.updateHost("host_a", () => undefined)).toBeUndefined();
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
		const both = await store.placementsOnHosts(["host_a", "host_b", "host_c"]);
		expect([...both].map(([host, list]) => [host, list.map((p) => p.sandboxId)])).toEqual([
			["host_a", ["s1", "s2"]],
			["host_b", ["s3"]],
		]);
		await store.putPlacement({ ...placement("s1", "host_a", 1), state: "stopped" });
		expect((await store.getPlacement("s1"))?.state).toBe("stopped");
		await store.removePlacement("s1");
		expect(await store.getPlacement("s1")).toBeUndefined();
		expect((await store.placementsOn("host_a")).map((p) => p.sandboxId)).toEqual(["s2"]);
	});

	it("changes and removes a placement as it is now, so a stale report never undoes a handover", async () => {
		const store = await open();
		await store.putPlacement(placement("s1", "host_a", 1));
		// The sandbox moved to host_b; a report from host_a, applied to what is stored, writes nothing.
		await store.putPlacement({ ...placement("s1", "host_b", 1), tier: "microvm" });
		const fromA = (latest: PlacementRecord) =>
			latest.hostId === "host_a" ? { ...latest, state: "stopped" } : undefined;
		expect(await store.updatePlacement("s1", fromA)).toBeUndefined();
		expect(await store.removePlacementIf("s1", (latest) => latest.hostId === "host_a")).toBe(false);
		expect(await store.getPlacement("s1")).toMatchObject({ hostId: "host_b", state: "running" });
		// One from host_b is applied, its other fields as they are now; its host moves the row in placementsOn too.
		const written = await store.updatePlacement("s1", (latest) => ({ ...latest, state: "paused" }));
		expect(written).toMatchObject({ hostId: "host_b", state: "paused" });
		expect((await store.placementsOn("host_b")).map((p) => p.sandboxId)).toEqual(["s1"]);
		await Promise.all([
			store.updatePlacement("s1", (latest) => ({ ...latest, size: "large" })),
			store.updatePlacement("s1", (latest) => ({ ...latest, state: "running" })),
		]);
		expect(await store.getPlacement("s1")).toMatchObject({ size: "large", state: "running" });
		expect(await store.updatePlacement("nope", (latest) => latest)).toBeUndefined();
		expect(await store.removePlacementIf("s1", (latest) => latest.hostId === "host_b")).toBe(true);
		expect(await store.getPlacement("s1")).toBeUndefined();
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

// The registry's records behave the same in memory and on every SQL driver a target uses: a join token spent once,
// hosts found by credential hash, and placements listed per host.
import { createRequire } from "node:module";
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

	it("places a new sandbox only on a host that is neither draining nor revoked, in one write", async () => {
		const store = await open();
		await store.insertHost({ ...host("host_a", 1), labels: { note: '"draining":true' } });
		await store.insertHost({ ...host("host_d", 2), draining: true });
		await store.insertHost({ ...host("host_r", 3), revoked: true });
		expect(await store.placeOnTakingHost(placement("s1", "host_a", 1))).toBe(true);
		expect(await store.placeOnTakingHost(placement("s2", "host_d", 2))).toBe(false);
		expect(await store.placeOnTakingHost(placement("s3", "host_r", 3))).toBe(false);
		expect(await store.placeOnTakingHost(placement("s4", "host_none", 4))).toBe(false);
		expect((await store.placementsOn("host_a")).map((p) => p.sandboxId)).toEqual(["s1"]);
		expect(await store.placementsOn("host_d")).toEqual([]);
		// Drained since it was read: refused.
		await store.updateHost("host_a", (current) => ({ ...current, draining: true }));
		expect(await store.placeOnTakingHost(placement("s5", "host_a", 5))).toBe(false);
	});

	it("places a new sandbox kept to a pool only on a host in that pool, where the host's pool is known", async () => {
		const store = await open();
		await store.insertHost({ ...host("host_a", 1), poolId: "pool_a" });
		await store.insertHost({ ...host("host_n", 2) });
		expect(await store.placeOnTakingHost(placement("s1", "host_a", 1), "pool_a")).toBe(true);
		// Another pool, or one whose ID starts it or differs only where LIKE has a wildcard: refused.
		expect(await store.placeOnTakingHost(placement("s2", "host_a", 2), "pool_b")).toBe(false);
		expect(await store.placeOnTakingHost(placement("s3", "host_a", 3), "pool_")).toBe(false);
		expect(await store.placeOnTakingHost(placement("s4", "host_a", 4), "poolXa")).toBe(false);
		// Its own pool, not a label that says one.
		await store.insertHost({ ...host("host_l", 3), poolId: "pool_b", labels: { poolId: "pool_a" } });
		expect(await store.placeOnTakingHost(placement("s6", "host_l", 6), "pool_a")).toBe(false);
		expect(await store.placeOnTakingHost(placement("s7", "host_l", 7), "pool_b")).toBe(true);
		await store.insertHost({ ...host("host_m", 4), labels: { poolId: "pool_b" } });
		expect(await store.placeOnTakingHost(placement("s8", "host_m", 8), "pool_a")).toBe(true);
		// A host whose pool the registry hasn't been told yet takes it.
		expect(await store.placeOnTakingHost(placement("s5", "host_n", 5), "pool_a")).toBe(true);
		expect((await store.placementsOn("host_a")).map((p) => p.sandboxId)).toEqual(["s1"]);
	});

	it("finds everything on a host in one read: its placements, an upgrade's microVM, an isolate to delete", async () => {
		const store = await open();
		const upgrade = { operationId: "op1", target: "host_b", phase: "copy" as const };
		await store.putPlacement({ ...placement("s1", "host_a", 1), tier: "isolate", upgrade });
		await store.putPlacement({
			...placement("s2", "host_a", 2),
			upgrade: { ...upgrade, target: "host_a", phase: "host" },
		});
		// IDs that start with another's, or match it but for a LIKE wildcard, aren't it.
		await store.putPlacement({ ...placement("s3", "host_bb", 3), upgrade: { ...upgrade, target: "host_bb" } });
		await store.putPlacement({ ...placement("s4", "hostXb", 4), cleanup: { hostId: "hostXc", operationId: "op2" } });
		await store.putPlacement({ ...placement("s5", "host_c", 5), cleanup: { hostId: "host_d", operationId: "op2" } });
		await store.putPlacement({ ...placement("s6", "host_e", 6), state: "lost" });
		const on = async (hostId: string) => (await store.occupying(hostId)).map((p) => p.sandboxId).sort();
		expect(await on("host_a")).toEqual(["s1", "s2"]);
		expect(await on("host_b")).toEqual(["s1"]);
		expect(await on("host_bb")).toEqual(["s3"]);
		expect(await on("host_d")).toEqual(["s5"]);
		expect(await on("host_c")).toEqual(["s5"]);
		expect(await on("hostXc")).toEqual(["s4"]);
		// A lost one holds nothing.
		expect(await on("host_e")).toEqual([]);
		// The handover: the placement moves to the target, its intent ends and the isolate to delete is recorded, in one
		// write: both hosts are held after it as before.
		await store.updatePlacement("s1", ({ upgrade: _done, ...rest }) => ({
			...rest,
			hostId: "host_b",
			tier: "microvm",
			cleanup: { hostId: "host_a", operationId: "op1" },
		}));
		expect(await on("host_b")).toEqual(["s1"]);
		expect(await on("host_a")).toEqual(["s1", "s2"]);
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

// Two connections to a real Postgres (KANTEL_TEST_POSTGRES_URL): a create's placement and a drain of its host, at once.
const postgresUrl = process.env.KANTEL_TEST_POSTGRES_URL;
describe.skipIf(postgresUrl === undefined || postgresUrl === "")("Postgres, two connections", () => {
	it("waits for a drain under way, then refuses the placement, and a drain waits for a placement under way", async () => {
		const kind = testDatabaseKinds().find((candidate) => candidate.name === "Postgres");
		if (kind === undefined) throw new Error("No Postgres kind");
		const database = await kind.open();
		cleanups.push(() => database.close());
		await migrateHosts(database.driver);
		const store = createSqlHostStore(database.driver);
		await store.insertHost(host("host_a", 1));
		// A second connection, in the same schema, holding a drain open.
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
		cleanups.push(() => other.end());
		const drained = JSON.stringify({ ...host("host_a", 1), draining: true });

		await other.query("BEGIN");
		await other.query("UPDATE compute_hosts SET data = $1 WHERE id = $2", [drained, "host_a"]);
		let settled = false;
		const placing = store.placeOnTakingHost(placement("s1", "host_a", 1)).finally(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(settled).toBe(false);
		await other.query("COMMIT");
		expect(await placing).toBe(false);
		expect(await store.placementsOn("host_a")).toEqual([]);

		// The other way round: a placement holding the host's row, a drain waits for it, and then sees it.
		await store.updateHost("host_a", (current) => ({ ...current, draining: false }));
		await other.query("BEGIN");
		await other.query("SELECT id FROM compute_hosts WHERE id = $1 FOR UPDATE", ["host_a"]);
		await other.query(
			"INSERT INTO compute_placements (sandbox_id, host_id, created_at, data) VALUES ($1, $2, $3, $4)",
			["s2", "host_a", 2, JSON.stringify(placement("s2", "host_a", 2))],
		);
		let drainDone = false;
		const draining = store
			.updateHost("host_a", (current) => ({ ...current, draining: true }))
			.finally(() => {
				drainDone = true;
			});
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(drainDone).toBe(false);
		await other.query("COMMIT");
		await draining;
		expect((await store.placementsOn("host_a")).map((p) => p.sandboxId)).toEqual(["s2"]);
	});
});

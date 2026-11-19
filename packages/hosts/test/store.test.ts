// The registry's records behave the same in memory and on every SQL driver a target uses: a join token spent once,
// hosts found by credential hash, and placements listed per host.
import { createRequire } from "node:module";
import type { SqlDriver } from "@kantel/sql";
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

	it("inserts a placement only while its sandbox has none", async () => {
		const store = await open();
		expect(await store.insertPlacement(placement("s1", "host_a", 1))).toBe(true);
		expect(await store.insertPlacement({ ...placement("s1", "host_b", 2), state: "lost" })).toBe(false);
		expect(await store.getPlacement("s1")).toMatchObject({ hostId: "host_a", createdAt: 1 });
		await store.removePlacement("s1");
		expect(await store.insertPlacement(placement("s1", "host_b", 3))).toBe(true);
		expect(await store.getPlacement("s1")).toMatchObject({ hostId: "host_b", createdAt: 3 });
	});

	it("replaces a placement only over its own: the same host, written at the same time", async () => {
		const store = await open();
		expect(await store.replacePlacement({ ...placement("s1", "host_a", 1), state: "running" })).toBe(false);
		expect(await store.getPlacement("s1")).toBeUndefined();
		await store.putPlacement({ ...placement("s1", "host_a", 1), state: "starting" });
		expect(await store.replacePlacement({ ...placement("s1", "host_b", 1), state: "running" })).toBe(false);
		expect(await store.replacePlacement({ ...placement("s1", "host_a", 2), state: "running" })).toBe(false);
		expect(await store.getPlacement("s1")).toMatchObject({ hostId: "host_a", createdAt: 1, state: "starting" });
		expect(await store.replacePlacement({ ...placement("s1", "host_a", 1), state: "running" })).toBe(true);
		expect(await store.getPlacement("s1")).toMatchObject({ hostId: "host_a", createdAt: 1, state: "running" });
		// Written again on another host at another time (a late copy's fence): judged by that, not by what it was.
		await store.updatePlacement("s1", (latest) => ({ ...latest, hostId: "host_b", createdAt: 5, state: "lost" }));
		expect(await store.replacePlacement({ ...placement("s1", "host_a", 1), state: "running" })).toBe(false);
		expect(await store.replacePlacement({ ...placement("s1", "host_b", 5), state: "stopped" })).toBe(true);
		expect(await store.getPlacement("s1")).toMatchObject({ hostId: "host_b", createdAt: 5, state: "stopped" });
	});

	it("places a new sandbox only on a host that is neither draining nor revoked, in one write", async () => {
		const store = await open();
		await store.insertHost({ ...host("host_a", 1), labels: { note: '"draining":true' } });
		await store.insertHost({ ...host("host_d", 2), draining: true });
		await store.insertHost({ ...host("host_r", 3), revoked: true });
		// Admitted, it answers the host's pool: none yet.
		expect(await store.placeOnTakingHost(placement("s1", "host_a", 1))).toEqual({});
		expect(await store.placeOnTakingHost(placement("s2", "host_d", 2))).toBeUndefined();
		expect(await store.placeOnTakingHost(placement("s3", "host_r", 3))).toBeUndefined();
		expect(await store.placeOnTakingHost(placement("s4", "host_none", 4))).toBeUndefined();
		expect((await store.placementsOn("host_a")).map((p) => p.sandboxId)).toEqual(["s1"]);
		expect(await store.placementsOn("host_d")).toEqual([]);
		// Drained since it was read: refused.
		await store.updateHost("host_a", (current) => ({ ...current, draining: true }));
		expect(await store.placeOnTakingHost(placement("s5", "host_a", 5))).toBeUndefined();
	});

	it("never admits over a late copy's fence (orphan), capped or not", async () => {
		const store = await open();
		await store.insertHost(host("host_a", 1));
		await store.insertHost(host("host_b", 2));
		const orphan: PlacementRecord = { ...placement("s1", "host_b", 3), state: "lost", fenced: 3, orphan: true };
		await store.putPlacement(orphan);
		expect(await store.placeOnTakingHost(placement("s1", "host_a", 4))).toBe("orphan");
		expect(
			await store.placeOnTakingHost({ ...placement("s1", "host_a", 5), tier: "microvm", vcpus: 2 }, undefined, 8),
		).toBe("orphan");
		expect(await store.getPlacement("s1")).toEqual(orphan);
		// A lost placement that is no orphan is placed over, as before.
		await store.putPlacement({ ...placement("s2", "host_b", 6), state: "lost", fenced: 6 });
		expect(await store.placeOnTakingHost(placement("s2", "host_a", 7))).toEqual({});
		expect(await store.getPlacement("s2")).toMatchObject({ hostId: "host_a", createdAt: 7 });
	});

	it("places a capped microVM only while its host's booked vCPUs and its own stay within the cap, in one write", async () => {
		const store = await open();
		await store.insertHost({ ...host("host_a", 1), poolId: "pool_a" });
		const vm = (id: string, vcpus: number, change: Partial<PlacementRecord> = {}): PlacementRecord => ({
			...placement(id, "host_a", 1),
			vcpus,
			state: "starting",
			...change,
		});
		// Nothing booked: one larger than the cap still goes in, alone.
		expect(await store.placeOnTakingHost(vm("big", 12), "pool_a", 8)).toEqual({ poolId: "pool_a" });
		expect(await store.placeOnTakingHost(vm("s1", 2), "pool_a", 8)).toBe("vcpus");
		expect(await store.getPlacement("s1")).toBeUndefined();
		// Stopped, lost or deleting ones book nothing; isolates book nothing; another host's don't count.
		await store.putPlacement({ ...vm("big", 12), state: "stopped" });
		await store.putPlacement(vm("lost", 8, { state: "lost" }));
		await store.putPlacement(vm("iso", 0, { tier: "isolate" }));
		await store.putPlacement({ ...placement("other", "host_b", 1), vcpus: 64 });
		expect(await store.placeOnTakingHost(vm("s2", 4), "pool_a", 8)).toEqual({ poolId: "pool_a" });
		expect(await store.placeOnTakingHost(vm("s3", 4), "pool_a", 8)).toEqual({ poolId: "pool_a" });
		expect(await store.placeOnTakingHost(vm("s4", 2), "pool_a", 8)).toBe("vcpus");
		// Without a cap, or for an isolate, it goes in as before.
		expect(await store.placeOnTakingHost(vm("s5", 2), "pool_a")).toEqual({ poolId: "pool_a" });
		expect(await store.placeOnTakingHost(vm("s6", 0, { tier: "isolate" }), "pool_a", 8)).toEqual({ poolId: "pool_a" });
		// A create placed again under its ID doesn't count its own earlier placement.
		expect(await store.placeOnTakingHost(vm("s2", 4), "pool_a", 10)).toEqual({ poolId: "pool_a" });
		// A host that doesn't admit it is still refused as such, not for its vCPUs.
		await store.updateHost("host_a", (current) => ({ ...current, draining: true }));
		expect(await store.placeOnTakingHost(vm("s7", 2), "pool_a", 64)).toBeUndefined();
	});

	it("lets only one of the creates at once take a host's last vCPUs, or its empty-host exception", async () => {
		const store = await open();
		await store.insertHost(host("host_a", 1));
		const vm = (id: string, vcpus: number): PlacementRecord => ({
			...placement(id, "host_a", 1),
			vcpus,
			state: "starting",
		});
		// Empty: of three larger than the cap at once, one goes in.
		const empty = await Promise.all(["e1", "e2", "e3"].map((id) => store.placeOnTakingHost(vm(id, 16), undefined, 8)));
		expect(empty.filter((answer) => answer !== "vcpus")).toHaveLength(1);
		for (const id of ["e1", "e2", "e3"]) await store.removePlacement(id);
		// 4 of 8 booked: of four 2-vCPU creates at once, two go in.
		await store.putPlacement(vm("held", 4));
		const last = await Promise.all(
			["l1", "l2", "l3", "l4"].map((id) => store.placeOnTakingHost(vm(id, 2), undefined, 8)),
		);
		expect(last.filter((answer) => answer !== "vcpus")).toHaveLength(2);
		expect((await store.placementsOn("host_a")).reduce((sum, p) => sum + p.vcpus, 0)).toBe(8);
	});

	it("places a new sandbox kept to a pool only on a host in that pool, where the host's pool is known", async () => {
		const store = await open();
		await store.insertHost({ ...host("host_a", 1), poolId: "pool_a" });
		await store.insertHost({ ...host("host_n", 2) });
		// Admitted, it answers the pool its host is in, which the sandbox then is.
		expect(await store.placeOnTakingHost(placement("s1", "host_a", 1), "pool_a")).toEqual({ poolId: "pool_a" });
		// Another pool, or one whose ID starts it or differs only where LIKE has a wildcard: refused.
		expect(await store.placeOnTakingHost(placement("s2", "host_a", 2), "pool_b")).toBeUndefined();
		expect(await store.placeOnTakingHost(placement("s3", "host_a", 3), "pool_")).toBeUndefined();
		expect(await store.placeOnTakingHost(placement("s4", "host_a", 4), "poolXa")).toBeUndefined();
		// Kept to no pool (one from before pools), it lands wherever its host is, and says where.
		expect(await store.placeOnTakingHost(placement("s9", "host_a", 9))).toEqual({ poolId: "pool_a" });
		// Its own pool, not a label that says one.
		await store.insertHost({ ...host("host_l", 3), poolId: "pool_b", labels: { poolId: "pool_a" } });
		expect(await store.placeOnTakingHost(placement("s6", "host_l", 6), "pool_a")).toBeUndefined();
		expect(await store.placeOnTakingHost(placement("s7", "host_l", 7), "pool_b")).toEqual({ poolId: "pool_b" });
		await store.insertHost({ ...host("host_m", 4), labels: { poolId: "pool_b" } });
		expect(await store.placeOnTakingHost(placement("s8", "host_m", 8), "pool_a")).toEqual({});
		// A host whose pool the registry hasn't been told yet takes it, and says none.
		expect(await store.placeOnTakingHost(placement("s5", "host_n", 5), "pool_a")).toEqual({});
		expect((await store.placementsOn("host_a")).map((p) => p.sandboxId)).toEqual(["s1", "s9"]);
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

	it("holds a move's target while it moves, and its switch and a rollback's claim never both land", async () => {
		const store = await open();
		const size = { name: "default", vcpus: 2, memoryMiB: 2048, diskGiB: 20 };
		const move = { operationId: "mov1", target: "host_m2", phase: "copy" as const, size };
		await store.putPlacement({ ...placement("s1", "host_m1", 1), state: "stopped", move });
		await store.putPlacement({ ...placement("s2", "host_m3", 2), move: { ...move, target: "host_m22" } });
		const on = async (hostId: string) => (await store.occupying(hostId)).map((p) => p.sandboxId).sort();
		expect(await on("host_m2")).toEqual(["s1"]);
		expect(await on("host_m1")).toEqual(["s1"]);
		// The switch (only while the move is on it) and a rollback's claim (likewise), at once, many times over: one wins,
		// the other finds the placement changed.
		for (let round = 0; round < 10; round += 1) {
			await store.putPlacement({ ...placement("s1", "host_m1", 1), state: "stopped", move });
			const switched = store.updatePlacement("s1", (latest) => {
				if (latest.move?.operationId !== "mov1" || latest.move.settling !== undefined) return undefined;
				const { move: _done, ...rest } = latest;
				return { ...rest, hostId: "host_m2", cleanup: { hostId: "host_m1", operationId: "mov1", tier: "microvm" } };
			});
			const claimed = store.updatePlacement("s1", (latest) =>
				latest.move?.operationId === "mov1" && latest.move.settling === undefined
					? { ...latest, move: { ...latest.move, settling: { by: "rbm", until: 9 } } }
					: undefined,
			);
			const [won, claim] = await Promise.all([switched, claimed]);
			expect([won, claim].filter((each) => each !== undefined)).toHaveLength(1);
			const now = await store.getPlacement("s1");
			if (won !== undefined) expect(now).toMatchObject({ hostId: "host_m2", cleanup: { hostId: "host_m1" } });
			else expect(now).toMatchObject({ hostId: "host_m1", move: { settling: { by: "rbm" } } });
		}
	});

	it("keeps a move's memory with its intent, and its memory's digest and a rollback's claim never both land", async () => {
		const store = await open();
		const size = { name: "default", vcpus: 2, memoryMiB: 2048, diskGiB: 20 };
		const move = {
			operationId: "mov1",
			target: "host_m2",
			phase: "final-copy" as const,
			size,
			live: true as const,
			memory: true as const,
		};
		// The export's digests are written only while no rollback has begun (as the hosts service's `moveOn`), and a
		// rollback's claim only while it is unclaimed: at once, many times over, one lands.
		for (let round = 0; round < 10; round += 1) {
			await store.putPlacement({ ...placement("s1", "host_m1", 1), state: "stopped", move });
			const digests = store.updatePlacement("s1", (latest) =>
				latest.move?.operationId === "mov1" && latest.move.rollingBack !== true && latest.move.settling === undefined
					? { ...latest, move: { ...latest.move, mapDigest: "sha256:disk", memoryDigest: "sha256:memory" } }
					: undefined,
			);
			const claimed = store.updatePlacement("s1", (latest) =>
				latest.move?.operationId === "mov1" &&
				latest.move.settling === undefined &&
				latest.move.memoryDigest === undefined
					? { ...latest, move: { ...latest.move, settling: { by: "rbm", until: 9 }, rollingBack: true } }
					: undefined,
			);
			const [wrote, claim] = await Promise.all([digests, claimed]);
			expect([wrote, claim].filter((each) => each !== undefined)).toHaveLength(1);
			const now = await store.getPlacement("s1");
			expect(now?.move).toMatchObject({ memory: true, live: true });
			if (wrote !== undefined) expect(now?.move).toMatchObject({ memoryDigest: "sha256:memory" });
			else expect(now?.move).toMatchObject({ rollingBack: true, settling: { by: "rbm" } });
		}
	});

	it("fences a placement only while its host is unseen since it was judged lost, in the same write", async () => {
		const store = await open();
		await store.insertHost(host("host_a", 1));
		await store.putPlacement(placement("s1", "host_a", 1));
		await store.putPlacement(placement("s2", "host_a", 2));
		const fenced = (at: number) => (latest: PlacementRecord) =>
			latest.fenced === undefined ? { ...latest, state: "lost", fenced: at } : undefined;
		// Never seen: only a fence judged on that lands.
		expect(await store.updatePlacementUnseen("s1", "host_a", 5, fenced(10))).toBe("seen");
		expect(await store.updatePlacementUnseen("s1", "host_a", undefined, fenced(10))).toMatchObject({ fenced: 10 });
		// Seen at 20, as a pass judges it lost by: lands, and a placement fenced already is answered as left, whatever since.
		await store.updateHost("host_a", (latest) => ({ ...latest, lastSeenAt: 20 }));
		expect(await store.updatePlacementUnseen("s1", "host_a", 20, fenced(30))).toBeUndefined();
		// Its hello moves `lastSeenAt`: a fence judged on 20 is refused from then on, writing nothing.
		await store.updateHost("host_a", (latest) => ({ ...latest, lastSeenAt: 40 }));
		expect(await store.updatePlacementUnseen("s2", "host_a", 20, fenced(50))).toBe("seen");
		expect((await store.getPlacement("s2"))?.fenced).toBeUndefined();
		expect(await store.updatePlacementUnseen("s2", "host_a", undefined, fenced(50))).toBe("seen");
		expect(await store.updatePlacementUnseen("s2", "host_a", 40, fenced(50))).toMatchObject({ fenced: 50 });
		expect(await store.getPlacement("s2")).toMatchObject({ state: "lost", fenced: 50 });
		// A host with no record never connects again; a placement that isn't there is nothing to fence.
		await store.putPlacement(placement("s3", "host_gone", 3));
		expect(await store.updatePlacementUnseen("s3", "host_gone", 7, fenced(60))).toMatchObject({ fenced: 60 });
		expect(await store.updatePlacementUnseen("nope", "host_a", 40, fenced(60))).toBeUndefined();
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

		it("answers a fence another caller landed between its read and its write as fenced, though its host was seen after", async () => {
			const database = await kind.open();
			cleanups.push(() => database.close());
			await migrateHosts(database.driver);
			const other = createSqlHostStore(database.driver);
			// Run once, right after this caller's first read of the placement.
			let afterRead: (() => Promise<void>) | undefined;
			const driver: SqlDriver = {
				dialect: database.driver.dialect,
				async query(text, params) {
					const rows = await database.driver.query(text, params);
					const run = afterRead;
					if (run !== undefined && text.startsWith("SELECT data FROM compute_placements")) {
						afterRead = undefined;
						await run();
					}
					return rows as never;
				},
				batch: (statements) => database.driver.batch(statements),
			};
			const store = createSqlHostStore(driver);
			await store.insertHost({ ...host("host_a", 1), lastSeenAt: 20 });
			await store.putPlacement(placement("s1", "host_a", 1));
			const fenced = (at: number) => (latest: PlacementRecord) =>
				latest.fenced === undefined ? { ...latest, state: "lost", fenced: at } : undefined;
			// B has read it unfenced; A fences it, and then the host's hello moves `lastSeenAt`.
			afterRead = async () => {
				expect(await other.updatePlacementUnseen("s1", "host_a", 20, fenced(30))).toMatchObject({ fenced: 30 });
				await other.updateHost("host_a", (latest) => ({ ...latest, lastSeenAt: 40 }));
			};
			// B's write loses, and B finds A's fence rather than refusing: it stands, so its loss is never dropped.
			expect(await store.updatePlacementUnseen("s1", "host_a", 20, fenced(35))).toBeUndefined();
			expect(afterRead).toBeUndefined();
			expect(await store.getPlacement("s1")).toMatchObject({ state: "lost", fenced: 30 });
		});
	});
}

// Two connections to a real Postgres (KANTEL_TEST_POSTGRES_URL): a create's placement and a drain of its host, at once.
const postgresUrl = process.env.KANTEL_TEST_POSTGRES_URL;
describe.skipIf(postgresUrl === undefined || postgresUrl === "")("Postgres, two connections", () => {
	it("waits for a drain under way, then refuses the placement, and a drain waits for a placement under way; a lost host's fence and its hello alike", async () => {
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
		expect(await placing).toBeUndefined();
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

		// A move to another pool under way (its row written, not yet committed): a placement kept to the old pool waits
		// for it, then is refused; one kept to no pool waits, then lands and answers the new pool.
		await store.putHost({ ...host("host_b", 2), poolId: "pool_a" });
		await other.query("BEGIN");
		await other.query("UPDATE compute_hosts SET data = $1 WHERE id = $2", [
			JSON.stringify({ ...host("host_b", 2), poolId: "pool_b" }),
			"host_b",
		]);
		let keptSettled = false;
		const kept = store.placeOnTakingHost(placement("s3", "host_b", 3), "pool_a").finally(() => {
			keptSettled = true;
		});
		const loose = store.placeOnTakingHost(placement("s4", "host_b", 4));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(keptSettled).toBe(false);
		await other.query("COMMIT");
		expect(await kept).toBeUndefined();
		expect(await loose).toEqual({ poolId: "pool_b" });
		expect((await store.placementsOn("host_b")).map((p) => p.sandboxId)).toEqual(["s4"]);

		// A capped create while another holds the host and books its vCPUs (not yet committed): it waits, then sees them.
		await store.putHost(host("host_c", 3));
		await store.putPlacement({ ...placement("c1", "host_c", 1), vcpus: 2, state: "running" });
		await other.query("BEGIN");
		await other.query("SELECT id FROM compute_hosts WHERE id = $1 FOR UPDATE", ["host_c"]);
		await other.query(
			"INSERT INTO compute_placements (sandbox_id, host_id, created_at, data) VALUES ($1, $2, $3, $4)",
			["c2", "host_c", 2, JSON.stringify({ ...placement("c2", "host_c", 2), vcpus: 4, state: "starting" })],
		);
		let cappedSettled = false;
		const capped = store
			.placeOnTakingHost({ ...placement("c3", "host_c", 3), vcpus: 4, state: "starting" }, undefined, 8)
			.finally(() => {
				cappedSettled = true;
			});
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(cappedSettled).toBe(false);
		await other.query("COMMIT");
		expect(await capped).toBe("vcpus");
		expect((await store.placementsOn("host_c")).map((p) => p.sandboxId)).toEqual(["c1", "c2"]);

		// A lost host's fence while its hello is writing `lastSeenAt` (not yet committed): it waits, then is refused. And a
		// hello while a fence holds the host: it waits, and the fences read after it see that one.
		await store.putHost({ ...host("host_d", 4), lastSeenAt: 20 });
		await store.putPlacement(placement("d1", "host_d", 1));
		const fenced = (latest: PlacementRecord) => ({ ...latest, state: "lost", fenced: 30 });
		await other.query("BEGIN");
		await other.query("UPDATE compute_hosts SET data = $1 WHERE id = $2", [
			JSON.stringify({ ...host("host_d", 4), lastSeenAt: 40 }),
			"host_d",
		]);
		let fenceSettled = false;
		const fencing = store.updatePlacementUnseen("d1", "host_d", 20, fenced).finally(() => {
			fenceSettled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(fenceSettled).toBe(false);
		await other.query("COMMIT");
		expect(await fencing).toBe("seen");
		expect((await store.getPlacement("d1"))?.fenced).toBeUndefined();
		await other.query("BEGIN");
		await other.query("SELECT id FROM compute_hosts WHERE id = $1 FOR UPDATE", ["host_d"]);
		await other.query("UPDATE compute_placements SET data = $1 WHERE sandbox_id = $2", [
			JSON.stringify(fenced(placement("d1", "host_d", 1))),
			"d1",
		]);
		let helloDone = false;
		const hello = store
			.updateHost("host_d", (current) => ({ ...current, lastSeenAt: 50 }))
			.finally(() => {
				helloDone = true;
			});
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(helloDone).toBe(false);
		await other.query("COMMIT");
		await hello;
		expect((await store.placementsOn("host_d")).map((p) => p.fenced)).toEqual([30]);
	});
});

// A sandbox made from a saved snapshot on any host that holds it, or fetches it first (docs/design/disk-store.md,
// "Phase 3 notes"): a holder with room first, those whose copy restores its memory before those that boot on its disk;
// with none, another eligible host that fetches saved snapshots, told to fetch it and waited for until it reports it,
// the create's startup saying how long that took. A saved snapshot's ref is its ID alone on a host that syncs them, and
// `{hostId}/{snapshotId}` as before elsewhere and for refs from before, whose host is then its one holder.
import type { SandboxBackend, SandboxSpec, SnapshotCopies } from "@kantel/compute";
import { isKantelError, placementReasonOf } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createHostBackend } from "../src/backend.ts";
import { HOST_FEATURES, type HostSandbox } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService, type HostsService } from "../src/service.ts";
import { isSavedSnapshotRef, parseSnapshotRef, SAVED_SNAPSHOT_ID, snapshotRef } from "../src/snapshot-refs.ts";
import { createMemoryHostStore, type HostStore } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";
import { FakeHost } from "./fake-host.ts";

const services: HostsService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.close();
});

const SNAPSHOT = "ssnap_0123456789abcdef0123456789abcdef";
const MAP = `sha256:${"a".repeat(64)}`;
/** The phases a host reports for a start, as kantel-host does. */
const PHASES = { disk: "reflink", diskMs: 5, bootMs: 100, agentMs: 200, totalMs: 400 } as const;

/** Features of a host that syncs saved snapshots; `sync: false`, one from before. */
const featuresOf = (sync: boolean) => [
	HOST_FEATURES.egressPolicy,
	HOST_FEATURES.customShapes,
	HOST_FEATURES.snapshotKeep,
	...(sync ? [HOST_FEATURES.mesh, HOST_FEATURES.diskSync, HOST_FEATURES.snapshotSync] : []),
];

async function addHost(
	store: HostStore,
	service: HostsService,
	id: string,
	options: {
		readonly sync?: boolean;
		readonly freeMemoryMiB?: number;
		/** Its architecture as kantel-host reports it (default amd64). */
		readonly arch?: string;
		/** The timings its creates answer, by step; absent, none (a host that says nothing of how it started). */
		readonly timings?: () => { readonly [step: string]: number } | undefined;
	} = {},
) {
	await store.insertHost({
		id,
		name: id,
		labels: {},
		credentialHash: "x",
		revoked: false,
		draining: false,
		joinedAt: 1,
	});
	const host = new FakeHost(service, id, featuresOf(options.sync !== false));
	if (options.arch !== undefined) host.moreFacts = { arch: options.arch };
	if (options.freeMemoryMiB !== undefined) host.freeMemoryMiB = options.freeMemoryMiB;
	// A create answers the phases its start took, as a current host does.
	const answered = host.answer;
	host.answer = (method) => {
		if (method !== "sandbox.create") return answered?.(method);
		const call = host.calls.at(-1)?.params as { sandboxId: string };
		const sandbox: HostSandbox = {
			id: call.sandboxId,
			tier: "microvm",
			size: "default",
			state: "running",
			createdAt: 1,
			source: "snapshot",
			phases: PHASES,
			...(options.timings?.() === undefined ? {} : { timings: options.timings() }),
		};
		host.sandboxes.set(sandbox.id, sandbox);
		return sandbox;
	};
	host.connect();
	await new Promise((resolve) => setTimeout(resolve, 5));
	return host;
}

/** A host's heartbeat, its capacity with `reported` (what it holds, its fetches). */
function reports(host: FakeHost, reported: object = {}) {
	host.send({
		type: "heartbeat",
		heartbeat: {
			capacity: {
				freeMemoryMiB: host.freeMemoryMiB,
				freeDiskGiB: 400,
				running: 0,
				stopped: 0,
				load1: 0.1,
				...reported,
			},
		},
	});
}

/** A host's heartbeat saying it holds the snapshot's disk, as one does once its fetch has arrived. */
function reportsHolding(host: FakeHost, snapshotId = SNAPSHOT) {
	reports(host, {
		holdings: {
			snapshot: [{ objectId: snapshotId, versions: [{ version: "disk", mapDigest: MAP, allocatedBytes: 1 }] }],
		},
	});
}

/** A host's heartbeat listing the snapshot's disk's fetch as `state`, with `error` where it failed. */
function reportsFetch(host: FakeHost, state: "queued" | "running" | "failed", error?: string) {
	reports(host, {
		holdings: { snapshot: [] },
		fetches: [
			{
				kind: "snapshot",
				objectId: SNAPSHOT,
				version: "disk",
				state,
				blocks: 0,
				inPlace: 0,
				...(error === undefined ? {} : { error }),
			},
		],
	});
}

/** A host that answers `disk.fetch`, then does `then` with itself a moment later. */
function fetchesThen(host: FakeHost, then: (host: FakeHost) => void) {
	host.answer = ((answered) => (method: string) => {
		if (method !== "disk.fetch") return answered?.(method);
		setTimeout(() => then(host), 10);
		return {};
	})(host.answer);
}

/** Well under the 15 seconds between a host's heartbeats: one report, not the fetch's timeout. */
const ONE_REPORT_MS = 5_000;

async function setup(options: { readonly snapshotFetchTimeoutMs?: number; readonly store?: HostStore } = {}) {
	const store = options.store ?? createMemoryHostStore();
	const service = createHostsService({ store, publicUrl: "https://kantel.test", log: () => undefined });
	services.push(service);
	const backend: SandboxBackend = createHostBackend({
		hosts: service,
		publicUrl: "https://kantel.test",
		tickets: createTunnelTickets(createMemoryRelayStore()),
		...(options.snapshotFetchTimeoutMs === undefined ? {} : { snapshotFetchTimeoutMs: options.snapshotFetchTimeoutMs }),
	});
	return { store, service, backend };
}

const spec = (
	eligibleHosts: readonly string[],
	fromSnapshot: string,
	snapshotCopies?: SnapshotCopies,
): SandboxSpec => ({
	sandboxId: "sbx_new",
	accountId: "acc_a",
	type: "microvm",
	subdomain: "new",
	env: {},
	eligibleHosts,
	fromSnapshot,
	...(snapshotCopies === undefined ? {} : { snapshotCopies }),
});

const creates = (host: FakeHost) => host.calls.filter((call) => call.method === "sandbox.create");

describe("snapshot refs", () => {
	it("are a saved snapshot's ID alone, and a host's other snapshots by their host, which old refs keep naming", () => {
		expect(snapshotRef("host_a", SNAPSHOT)).toBe(SNAPSHOT);
		expect(snapshotRef("host_a", "snap_0123456789abcdef")).toBe("host_a/snap_0123456789abcdef");
		expect(parseSnapshotRef(SNAPSHOT)).toEqual({ snapshotId: SNAPSHOT });
		expect(parseSnapshotRef("host_a/snap_1")).toEqual({ hostId: "host_a", snapshotId: "snap_1" });
		// An old ref of a saved snapshot whose ID happens to look like a new one's still names its host.
		expect(parseSnapshotRef(`host_a/${SNAPSHOT}`)).toEqual({ hostId: "host_a", snapshotId: SNAPSHOT });
		for (const other of ["snap_1", "ref_abc", "a/b/c", "/snap_1", "host_a/", ""]) {
			expect(parseSnapshotRef(other)).toBeUndefined();
		}
		expect(isSavedSnapshotRef(`ssnap_${"0".repeat(31)}`)).toBe(false);
	});

	it("name a saved snapshot by its ID alone on a host that syncs them, with the host it was taken on", async () => {
		const { store, service, backend } = await setup();
		const synced = await addHost(store, service, "host_a");
		const old = await addHost(store, service, "host_b", { sync: false });
		for (const host of [synced, old]) {
			host.sandboxes.set(`sbx_${host.hostId}`, {
				id: `sbx_${host.hostId}`,
				tier: "microvm",
				size: "default",
				state: "running",
				createdAt: 1,
			});
			await store.putPlacement({
				sandboxId: `sbx_${host.hostId}`,
				hostId: host.hostId,
				tier: "microvm",
				size: "default",
				vcpus: 2,
				memoryMiB: 2048,
				diskGiB: 20,
				state: "running",
				createdAt: 1,
				updatedAt: 1,
			});
		}
		const taken = await backend.takeSnapshot("sbx_host_a");
		expect(taken.ref).toMatch(SAVED_SNAPSHOT_ID);
		expect(taken.hostId).toBe("host_a");
		// A host from before snapshot sync: by its host, as before.
		const older = await backend.takeSnapshot("sbx_host_b");
		expect(older.ref).toMatch(/^host_b\/snap_[0-9a-f]{16}$/);
		expect(older.hostId).toBe("host_b");
		// A call to a snapshot's host names it there; its ID alone names none.
		await expect(backend.listSnapshotFiles(taken.ref, "/")).rejects.toMatchObject({ code: "not_found" });
	});
});

describe("a create from a saved snapshot", () => {
	it("goes on another holder when the host it was taken on is offline", async () => {
		const { store, service, backend } = await setup();
		await addHost(store, service, "host_b");
		const c = await addHost(store, service, "host_c");
		// host_a, where it was taken, is offline: not eligible.
		const placed = await backend.create(
			spec(["host_b", "host_c"], SNAPSHOT, {
				holders: [
					{ hostId: "host_a", memory: true },
					{ hostId: "host_c", memory: false },
				],
				memory: true,
				fetch: true,
			}),
		);
		expect(placed.hostId).toBe("host_c");
		expect(creates(c).map((call) => call.params.from)).toEqual([SNAPSHOT]);
		// Its copy there has no memory: it booted on its disk, and says so. Nothing was fetched.
		expect(placed.startup).toMatchObject({ restoredMemory: false });
		expect(placed.startup).not.toHaveProperty("fetchMs");
	});

	it("prefers a holder whose copy restores its memory, then those that boot on its disk", async () => {
		const { store, service, backend } = await setup();
		const a = await addHost(store, service, "host_a", { freeMemoryMiB: 4_000 });
		const b = await addHost(store, service, "host_b", { freeMemoryMiB: 30_000 });
		const copies: SnapshotCopies = {
			holders: [
				{ hostId: "host_b", memory: false },
				{ hostId: "host_a", memory: true },
			],
			memory: true,
			fetch: false,
		};
		const first = await backend.create(spec(["host_a", "host_b"], SNAPSHOT, copies));
		// host_a, with less room, restores its memory.
		expect(first.hostId).toBe("host_a");
		expect(first.startup).toMatchObject({ restoredMemory: true });
		// Full: the disk-only holder takes it.
		a.freeMemoryMiB = 100;
		reportsHolding(a, "ssnap_other0000000000000000000000000");
		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = await backend.create({ ...spec(["host_a", "host_b"], SNAPSHOT, copies), sandboxId: "sbx_two" });
		expect(second.hostId).toBe("host_b");
		expect(second.startup).toMatchObject({ restoredMemory: false });
		expect(creates(b)).toHaveLength(1);
		// A snapshot without memory says nothing of it.
		const plain = await backend.create({
			...spec(["host_b"], SNAPSHOT, { ...copies, memory: false }),
			sandboxId: "sbx_three",
		});
		expect(plain.startup).not.toHaveProperty("restoredMemory");
	});

	it("is fetched first by another host when no holder has room, which reports the fetch, and boots there", async () => {
		const { store, service, backend } = await setup();
		await addHost(store, service, "host_a", { freeMemoryMiB: 100 });
		const old = await addHost(store, service, "host_b", { sync: false });
		// Its create's timings say it booted on the disk, the memory not here yet.
		let timings: { readonly [step: string]: number } = { disk: 5, boot: 100 };
		const c = await addHost(store, service, "host_c", { timings: () => timings });
		// host_c starts the fetch, and reports the disk a moment later.
		c.answer = ((answered) => (method: string) => {
			if (method !== "disk.fetch") return answered?.(method);
			setTimeout(() => reportsHolding(c), 30);
			return {};
		})(c.answer);
		const placed = await backend.create(
			spec(["host_a", "host_b", "host_c"], SNAPSHOT, {
				holders: [{ hostId: "host_a", memory: true }],
				memory: true,
				fetch: true,
			}),
		);
		expect(placed.hostId).toBe("host_c");
		// Fetched on its own, asking where it is, then made from it: never by a host that doesn't fetch snapshots.
		expect(c.calls.map((call) => call.method)).toEqual(["disk.fetch", "sandbox.create"]);
		expect(c.calls[0]?.params).toEqual({ kind: "snapshot", objectId: SNAPSHOT, version: "disk" });
		expect(creates(c)[0]?.params).toMatchObject({ from: SNAPSHOT });
		expect(old.calls.some((call) => call.method === "disk.fetch")).toBe(false);
		expect(placed.startup?.fetchMs).toBeGreaterThanOrEqual(25);
		expect(placed.startup).toMatchObject({ restoredMemory: false, diskMs: 5 });
		// Its memory came too before the next create there, which restored it, as its host says.
		timings = { disk: 5, restore: 30 };
		const again = await backend.create({
			...spec(["host_c"], SNAPSHOT, { holders: [{ hostId: "host_c", memory: false }], memory: true, fetch: true }),
			sandboxId: "sbx_again",
		});
		expect(again.startup).toMatchObject({ restoredMemory: true });
		expect(again.startup).not.toHaveProperty("fetchMs");
	});

	it("isn't fetched where the snapshot can't be, and says why when its holders are full or away", async () => {
		const { store, service, backend } = await setup();
		await addHost(store, service, "host_a", { freeMemoryMiB: 100 });
		const c = await addHost(store, service, "host_c");
		const full = await backend
			.create(
				spec(["host_a", "host_c"], SNAPSHOT, {
					holders: [{ hostId: "host_a", memory: false }],
					memory: false,
					fetch: false,
				}),
			)
			.catch((error: unknown) => error);
		expect(isKantelError(full, "exhausted")).toBe(true);
		const away = await backend
			.create(
				spec(["host_c"], SNAPSHOT, { holders: [{ hostId: "host_a", memory: false }], memory: false, fetch: false }),
			)
			.catch((error: unknown) => error);
		expect(isKantelError(away, "unavailable") && placementReasonOf(away)).toBe("host_unavailable");
		// Its ID alone and nothing said of its holders: nowhere to go.
		await expect(backend.create(spec(["host_c"], SNAPSHOT))).rejects.toMatchObject({ code: "unavailable" });
		expect(c.calls).toEqual([]);
	});

	it("is fetched on the next host when the one that fetched it has no room by then, and never for an old ref", async () => {
		const { store, service, backend } = await setup();
		await addHost(store, service, "host_a", { freeMemoryMiB: 100 });
		const fetching = (host: FakeHost, full: boolean) => {
			host.answer = ((answered) => (method: string) => {
				if (method !== "disk.fetch") return answered?.(method);
				setTimeout(() => {
					// Another create took its room while it fetched.
					if (full) host.freeMemoryMiB = 100;
					reportsHolding(host);
				}, 10);
				return {};
			})(host.answer);
		};
		const b = await addHost(store, service, "host_b", { freeMemoryMiB: 30_000 });
		const c = await addHost(store, service, "host_c", { freeMemoryMiB: 10_000 });
		fetching(b, true);
		fetching(c, false);
		const placed = await backend.create(
			spec(["host_a", "host_b", "host_c"], SNAPSHOT, {
				holders: [{ hostId: "host_a", memory: false }],
				memory: false,
				fetch: true,
			}),
		);
		expect(placed.hostId).toBe("host_c");
		expect(b.calls.map((call) => call.method)).toEqual(["disk.fetch"]);
		expect(c.calls.map((call) => call.method)).toEqual(["disk.fetch", "sandbox.create"]);
		// An old ref's host-local ID may name another snapshot on the host that would fetch it: never fetched.
		const old = await backend
			.create({
				...spec(["host_a", "host_c"], "host_a/snap_0123456789abcdef", {
					holders: [{ hostId: "host_a", memory: false }],
					memory: false,
					fetch: true,
				}),
				sandboxId: "sbx_old",
			})
			.catch((error: unknown) => error);
		expect(isKantelError(old, "exhausted")).toBe(true);
		expect(c.calls.filter((call) => call.method === "disk.fetch")).toHaveLength(1);
	});

	it("is fetched only by a host of an architecture a holder serves", async () => {
		const { store, service, backend } = await setup();
		await addHost(store, service, "host_a", { freeMemoryMiB: 100 });
		// host_b is aarch64, with the most room; host_c x86_64 like the holder.
		const b = await addHost(store, service, "host_b", { freeMemoryMiB: 30_000, arch: "arm64" });
		const c = await addHost(store, service, "host_c", { freeMemoryMiB: 10_000 });
		c.answer = ((answered) => (method: string) => {
			if (method !== "disk.fetch") return answered?.(method);
			setTimeout(() => reportsHolding(c), 10);
			return {};
		})(c.answer);
		const placed = await backend.create(
			spec(["host_a", "host_b", "host_c"], SNAPSHOT, {
				holders: [{ hostId: "host_a", memory: false }],
				memory: false,
				fetch: true,
				architectures: ["x86_64"],
			}),
		);
		expect(placed.hostId).toBe("host_c");
		expect(b.calls).toEqual([]);
	});

	it("gives up on a fetch its host never reports", async () => {
		const { store, service, backend } = await setup({ snapshotFetchTimeoutMs: 50 });
		await addHost(store, service, "host_a", { freeMemoryMiB: 100 });
		const c = await addHost(store, service, "host_c");
		c.answer = (
			(answered) => (method: string) =>
				method === "disk.fetch" ? {} : answered?.(method)
		)(c.answer);
		await expect(
			backend.create(
				spec(["host_a", "host_c"], SNAPSHOT, {
					holders: [{ hostId: "host_a", memory: false }],
					memory: false,
					fetch: true,
				}),
			),
		).rejects.toMatchObject({ code: "unavailable" });
		expect(creates(c)).toEqual([]);
	});

	it("is fetched on the next host when the one fetching it reports the fetch failed, within one report", async () => {
		const { store, service, backend } = await setup();
		await addHost(store, service, "host_a", { freeMemoryMiB: 100 });
		const b = await addHost(store, service, "host_b", { freeMemoryMiB: 30_000 });
		const c = await addHost(store, service, "host_c", { freeMemoryMiB: 10_000 });
		fetchesThen(b, (host) => reportsFetch(host, "failed", "no room for the snapshot's disk"));
		fetchesThen(c, (host) => reportsHolding(host));
		const started = Date.now();
		const placed = await backend.create(
			spec(["host_a", "host_b", "host_c"], SNAPSHOT, {
				holders: [{ hostId: "host_a", memory: false }],
				memory: false,
				fetch: true,
			}),
		);
		expect(Date.now() - started).toBeLessThan(ONE_REPORT_MS);
		expect(placed.hostId).toBe("host_c");
		expect(b.calls.map((call) => call.method)).toEqual(["disk.fetch"]);
		expect(c.calls.map((call) => call.method)).toEqual(["disk.fetch", "sandbox.create"]);
	});

	it("fails at once with its host's error when the last host fetching it reports the fetch failed", async () => {
		const { store, service, backend } = await setup();
		await addHost(store, service, "host_a", { freeMemoryMiB: 100 });
		const c = await addHost(store, service, "host_c");
		// Under way, then failed.
		fetchesThen(c, (host) => {
			reportsFetch(host, "running");
			setTimeout(() => reportsFetch(host, "failed", "the root image isn't in the pool"), 10);
		});
		const started = Date.now();
		const failed = await backend
			.create(
				spec(["host_a", "host_c"], SNAPSHOT, {
					holders: [{ hostId: "host_a", memory: false }],
					memory: false,
					fetch: true,
				}),
			)
			.catch((error: unknown) => error);
		expect(Date.now() - started).toBeLessThan(ONE_REPORT_MS);
		expect(failed).toMatchObject({ code: "unavailable" });
		expect((failed as Error).message).toBe(
			"The host host_c couldn't fetch the snapshot's disk (the root image isn't in the pool): try again, or start it on a host that holds it",
		);
		expect(creates(c)).toEqual([]);
	});

	it("tries three hosts at most whose fetches fail", async () => {
		const { store, service, backend } = await setup();
		await addHost(store, service, "host_a", { freeMemoryMiB: 100 });
		const fetchers = [];
		for (const [id, free] of [
			["host_b", 40_000],
			["host_c", 30_000],
			["host_d", 20_000],
			["host_e", 10_000],
		] as const) {
			const host = await addHost(store, service, id, { freeMemoryMiB: free });
			fetchesThen(host, (each) => reportsFetch(each, "failed", `${id} is out of disk`));
			fetchers.push(host);
		}
		const failed = await backend
			.create(
				spec(["host_a", "host_b", "host_c", "host_d", "host_e"], SNAPSHOT, {
					holders: [{ hostId: "host_a", memory: false }],
					memory: false,
					fetch: true,
				}),
			)
			.catch((error: unknown) => error);
		expect((failed as Error).message).toContain("host_d is out of disk");
		expect(fetchers.map((host) => host.calls.length)).toEqual([1, 1, 1, 0]);
	});

	it("doesn't take a failure reported before it was asked for this fetch's", async () => {
		const { store, service, backend } = await setup();
		await addHost(store, service, "host_a", { freeMemoryMiB: 100 });
		const c = await addHost(store, service, "host_c");
		// An earlier fetch failed; asked again, it goes on from its partial and arrives.
		reportsFetch(c, "failed", "a holder went away");
		await new Promise((resolve) => setTimeout(resolve, 20));
		fetchesThen(c, (host) => setTimeout(() => reportsHolding(host), 1_500));
		const placed = await backend.create(
			spec(["host_a", "host_c"], SNAPSHOT, {
				holders: [{ hostId: "host_a", memory: false }],
				memory: false,
				fetch: true,
			}),
		);
		expect(placed.hostId).toBe("host_c");
	});

	it("doesn't take a failure received before it was asked for this fetch's, though it was kept after", async () => {
		// The host's reports are kept a while after they are received.
		const memory = createMemoryHostStore();
		let keptAfterMs = 0;
		const store: HostStore = {
			...memory,
			async updateHost(hostId, update) {
				const delay = keptAfterMs;
				if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
				return memory.updateHost(hostId, update);
			},
		};
		const { service, backend } = await setup({ store });
		await addHost(store, service, "host_a", { freeMemoryMiB: 100 });
		const c = await addHost(store, service, "host_c");
		// An earlier fetch's failure, received now and kept only once the host has answered this one.
		keptAfterMs = 300;
		reportsFetch(c, "failed", "a holder went away");
		await new Promise((resolve) => setTimeout(resolve, 5));
		keptAfterMs = 0;
		fetchesThen(c, (host) => setTimeout(() => reportsHolding(host), 1_500));
		const placed = await backend.create(
			spec(["host_a", "host_c"], SNAPSHOT, {
				holders: [{ hostId: "host_a", memory: false }],
				memory: false,
				fetch: true,
			}),
		);
		expect(placed.hostId).toBe("host_c");
	});

	it("waits out the timeout on a host that doesn't report its fetches", async () => {
		const { store, service, backend } = await setup({ snapshotFetchTimeoutMs: 1_500 });
		await addHost(store, service, "host_a", { freeMemoryMiB: 100 });
		const c = await addHost(store, service, "host_c");
		// It reports, without saying how its fetches go.
		fetchesThen(c, (host) => reports(host, { holdings: { snapshot: [] } }));
		const started = Date.now();
		const failed = await backend
			.create(
				spec(["host_a", "host_c"], SNAPSHOT, {
					holders: [{ hostId: "host_a", memory: false }],
					memory: false,
					fetch: true,
				}),
			)
			.catch((error: unknown) => error);
		expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
		expect((failed as Error).message).toContain("didn't fetch the snapshot's disk within");
		expect(creates(c)).toEqual([]);
	});

	it("from an old ref goes on the host it names, its first holder, or on a copy", async () => {
		const { store, service, backend } = await setup();
		const a = await addHost(store, service, "host_a");
		const b = await addHost(store, service, "host_b");
		const ref = "host_a/snap_0123456789abcdef";
		// Nothing said of its holders: its host, as before.
		expect((await backend.create(spec(["host_a", "host_b"], ref))).hostId).toBe("host_a");
		expect(creates(a)[0]?.params).toMatchObject({ from: "snap_0123456789abcdef" });
		const away = await backend.create(spec(["host_b"], ref)).catch((error: unknown) => error);
		expect(isKantelError(away, "unavailable") && placementReasonOf(away)).toBe("host_unavailable");
		// Its host away, a copy of it elsewhere.
		const copied = await backend.create({
			...spec(["host_b"], ref, {
				holders: [
					{ hostId: "host_a", memory: false },
					{ hostId: "host_b", memory: false },
				],
				memory: false,
				fetch: false,
			}),
			sandboxId: "sbx_copy",
		});
		expect(copied.hostId).toBe("host_b");
		expect(creates(b)[0]?.params).toMatchObject({ from: "snap_0123456789abcdef" });
	});
});

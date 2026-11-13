// The service end to end over the hub, with fake hosts speaking the protocol as kantel-host does: join, hello and
// reconcile, placement, calls routed to the sandbox's host, port streams, drain and revoke.
import { isKantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createHostsApi } from "../src/http.ts";
import { HostCallError } from "../src/hub.ts";
import { HOST_CLOSE_REPLACED, HOST_CLOSE_REVOKED, HOST_FEATURES, type HostSandbox } from "../src/protocol.ts";
import {
	createHostsService,
	type HostsService,
	IMAGES_REFRESH_MS,
	kantelErrorFromHost,
	SNAPSHOT_SIZES_REFRESH_MS,
} from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { FakeHost, facts } from "./fake-host.ts";

const services: HostsService[] = [];
afterEach(() => {
	for (const service of services.splice(0)) service.close();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function setup(options: { now?: () => number } = {}) {
	const store = createMemoryHostStore();
	const logs: string[] = [];
	const service = createHostsService({
		store,
		publicUrl: "https://kantel.example.com/",
		clock: { now: options.now ?? (() => Date.now()) },
		log: (message) => logs.push(message),
	});
	services.push(service);
	const join = async (name: string, labels?: { [key: string]: string }) => {
		const token = await service.createJoinToken({ name, ...(labels === undefined ? {} : { labels }) });
		const { hostId, credential } = await service.register({ token: token.token, facts: facts() });
		return { hostId, credential, token };
	};
	return { store, service, logs, join };
}

describe("hosts service", () => {
	it("joins a host once per token, and authenticates only its credential", async () => {
		const { service, join } = await setup();
		const { hostId, credential, token } = await join("box-1", { region: "eu" });
		expect(token.token).toMatch(/^kth_/);
		expect(token.command).toBe(
			`curl -fsSL https://github.com/lleverage-ai/kantel/releases/latest/download/install.sh | sudo sh -s -- --url https://kantel.example.com --token ${token.token}`,
		);
		expect(credential).toMatch(/^khc_/);
		await expect(service.register({ token: token.token })).rejects.toSatisfy((error) =>
			isKantelError(error, "forbidden"),
		);
		expect((await service.authenticate(credential))?.id).toBe(hostId);
		expect(await service.authenticate("khc_wrong")).toBeUndefined();
		const view = await service.get(hostId);
		expect(view).toMatchObject({
			name: "box-1",
			state: "unreachable",
			labels: { region: "eu" },
			tiers: ["microvm", "isolate"],
		});
	});

	it("refuses an expired token", async () => {
		let now = 1_000;
		const { service } = await setup({ now: () => now });
		const token = await service.createJoinToken({ expiresInMinutes: 5 });
		now += 5 * 60_000;
		await expect(service.register({ token: token.token })).rejects.toSatisfy((error) =>
			isKantelError(error, "forbidden"),
		);
	});

	it("welcomes a host, reconciles what it holds, and places and routes sandboxes", async () => {
		const { service, store, join, logs } = await setup();
		const a = await join("a");
		// A sandbox Kantel placed earlier, which the host lost while it was away.
		await store.putPlacement({
			sandboxId: "lost-one",
			hostId: a.hostId,
			tier: "microvm",
			size: "default",
			vcpus: 2,
			memoryMiB: 2048,
			diskGiB: 20,
			state: "running",
			createdAt: 1,
			updatedAt: 1,
		});
		const host = new FakeHost(service, a.hostId);
		host.connect([{ id: "stray", tier: "microvm", size: "default", state: "stopped", createdAt: 1 }]);
		await tick();
		expect(host.welcomed()).toBe(true);
		expect(host.sent[0]).toMatchObject({
			type: "welcome",
			// No warm pools: hosts keep none.
			welcome: { hostId: a.hostId, heartbeatSeconds: 15, pools: {} },
		});
		expect((await store.getPlacement("lost-one"))?.state).toBe("lost");
		expect(logs.join("\n")).toMatch(/didn't place: stray/);
		expect((await service.get(a.hostId)).state).toBe("online");

		const created = await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-one" });
		expect(created).toMatchObject({ hostId: a.hostId, sandbox: { id: "sbx-one", state: "running" } });
		const events: string[] = [];
		const result = await service.sandboxes.call(
			"sbx-one",
			"sandbox.exec",
			{ command: "echo hi" },
			{ onEvent: (event) => events.push(event.kind) },
		);
		expect(result).toMatchObject({ exitCode: 0, stdout: "hi\n" });
		expect(events).toEqual(["exec.output"]);
		const stopped = await service.sandboxes.call<HostSandbox>("sbx-one", "sandbox.stop");
		expect(stopped.state).toBe("stopped");
		const stopCall = host.sent.find((message) => message.method === "sandbox.stop");
		expect((stopCall?.params as { snapshotId?: string } | undefined)?.snapshotId).toMatch(/^snap_/);
		expect((await store.getPlacement("sbx-one"))?.state).toBe("stopped");
		await expect(service.sandboxes.call("sbx-one", "host.update", {})).rejects.toSatisfy((error) =>
			isKantelError(error, "forbidden"),
		);
		await expect(service.sandboxes.call("sbx-one", "sandbox.nope", {})).rejects.toSatisfy((error) =>
			isKantelError(error, "not_supported"),
		);

		const fork = await service.sandboxes.fork("sbx-one", { newId: "sbx-two" });
		expect(fork.hostId).toBe(a.hostId);
		expect((await service.get(a.hostId)).allocated).toMatchObject({
			sandboxes: 2,
			vcpus: 2,
			memoryMb: 2048,
			diskGb: 60,
		});

		await service.sandboxes.delete("sbx-two");
		expect(await service.sandboxes.placement("sbx-two")).toBeUndefined();
		await expect(service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-one" })).rejects.toSatisfy((error) =>
			isKantelError(error, "conflict"),
		);
	});

	it("carries a port stream both ways over the host's connection", async () => {
		const { service, join } = await setup();
		const a = await join("a");
		const host = new FakeHost(service, a.hostId);
		host.connect();
		await tick();
		await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-port" });
		const received: string[] = [];
		const ended: string[] = [];
		const stream = await service.sandboxes.openPort("sbx-port", 22, {
			data: (bytes) => received.push(new TextDecoder().decode(bytes)),
			end: (reason) => ended.push(reason),
		});
		stream.write(new TextEncoder().encode("SSH-2.0-test"));
		expect(received).toEqual(["echo:SSH-2.0-test"]);
		host.send({ type: "stream.close", stream: stream.stream, reason: "closed by the sandbox" });
		expect(ended).toEqual(["closed by the sandbox"]);
		stream.write(new TextEncoder().encode("after"));
		expect(host.binary).toHaveLength(1);
	});

	it("spreads by free memory, skips a draining host and refuses when none can take it", async () => {
		const { service, join } = await setup();
		const a = await join("a");
		const b = await join("b");
		const hostA = new FakeHost(service, a.hostId);
		hostA.freeMemoryMiB = 3_000;
		hostA.connect();
		const hostB = new FakeHost(service, b.hostId);
		hostB.freeMemoryMiB = 3_500;
		hostB.connect();
		await tick();
		expect((await service.sandboxes.create({ tier: "microvm" })).hostId).toBe(b.hostId);
		// b's report is now 2 GiB stale: the next goes to a.
		expect((await service.sandboxes.create({ tier: "microvm" })).hostId).toBe(a.hostId);
		await expect(service.sandboxes.create({ tier: "microvm" })).rejects.toSatisfy((error) =>
			isKantelError(error, "exhausted"),
		);
		// A heartbeat clears what was reserved; draining a moves everything to b.
		hostA.send({
			type: "heartbeat",
			heartbeat: { capacity: { freeMemoryMiB: 10_000, freeDiskGiB: 400, running: 1, stopped: 0, load1: 0, warm: {} } },
		});
		hostB.send({
			type: "heartbeat",
			heartbeat: { capacity: { freeMemoryMiB: 5_000, freeDiskGiB: 120, running: 1, stopped: 0, load1: 0, warm: {} } },
		});
		await tick();
		// Its view says the free disk it last reported, apart from what it had when it started.
		expect(await service.get(b.hostId)).toMatchObject({ freeDiskGb: 120 });
		await service.update(a.hostId, { draining: true });
		expect(hostA.sent.filter((message) => message.type === "welcome").at(-1)?.welcome).toMatchObject({
			draining: true,
			pools: {},
		});
		expect((await service.get(a.hostId)).state).toBe("draining");
		expect((await service.sandboxes.create({ tier: "microvm" })).hostId).toBe(b.hostId);
	});

	it("shows what takes a host's disk as its latest heartbeat measured it, and drops a measure that isn't one", async () => {
		const { service, join } = await setup();
		const a = await join("a");
		const host = new FakeHost(service, a.hostId);
		host.connect();
		await tick();
		expect((await service.get(a.hostId)).diskUsage).toBeUndefined();
		const disk = {
			totalBytes: 1_000,
			usedBytes: 700,
			snapshotsBytes: 300,
			snapshotOwnBytes: { snap_a: 200, snap_b: 40 },
			snapshotShared: [{ snapshots: ["snap_a", "snap_b"], bytes: 60 }],
			sandboxesBytes: 250,
			imagesBytes: 50,
			templatesBytes: 30,
			bundlesBytes: 20,
			otherBytes: 50,
			measuredAt: 1_700_000_000_000,
		};
		const capacity = { freeMemoryMiB: 10_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0, warm: {} };
		host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, disk } } });
		await tick();
		expect((await service.get(a.hostId)).diskUsage).toEqual(disk);
		// A measure with a figure that isn't one is left out; the heartbeat's free disk still stands.
		host.send({
			type: "heartbeat",
			heartbeat: { capacity: { ...capacity, freeDiskGiB: 300, disk: { ...disk, otherBytes: -1 } } },
		});
		await tick();
		const view = await service.get(a.hostId);
		expect(view.diskUsage).toBeUndefined();
		expect(view.freeDiskGb).toBe(300);
	});

	it("shows a host's memory as its latest heartbeat reports it, and drops a report that isn't one", async () => {
		const { service, join, store } = await setup();
		const a = await join("a");
		const host = new FakeHost(service, a.hostId);
		host.connect();
		await tick();
		expect((await service.get(a.hostId)).memory).toBeUndefined();
		const memory = {
			mode: "used",
			state: "tight",
			totalMiB: 128_000,
			reserveMiB: 12_800,
			capacityMiB: 115_200,
			reservedMiB: 262_144,
			committedMiB: 90_112,
			guestUsedMiB: 24_576,
			residentMiB: 49_152,
			availableMiB: 70_000,
			swapUsedMiB: 0,
			pressureSome: 6.5,
			pressureFull: 0.25,
			maxRatio: 2.5,
			measuredAt: 1_700_000_000_000,
		};
		const capacity = { freeMemoryMiB: 10_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0 };
		host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, memory } } });
		await tick();
		expect((await service.get(a.hostId)).memory).toEqual(memory);
		// What it admits against is the scheduler's: kept with its capacity, not shown; one that isn't is left out.
		const admission = {
			reservableMiB: 26_000,
			committableMiB: 9_000,
			startMiB: 1024,
			headroomMiB: 1024,
			headroomPercent: 25,
		};
		for (const [sent, kept] of [
			[admission, admission],
			[{ ...admission, committableMiB: -5 }, undefined],
		] as const) {
			host.send({
				type: "heartbeat",
				heartbeat: { capacity: { ...capacity, memory: { ...memory, admission: sent } } },
			});
			await tick();
			expect((await service.get(a.hostId)).memory).toEqual(memory);
			const stored = (await store.getHost(a.hostId))?.capacity as { memory?: { admission?: unknown } } | undefined;
			expect(stored?.memory?.admission).toEqual(kept);
		}
		// A mode it doesn't know, or a figure that isn't one, is left out; the rest of the heartbeat still stands.
		for (const wrong of [
			{ ...memory, mode: "guessed" },
			{ ...memory, committedMiB: -1 },
			{ ...memory, state: 3 },
		]) {
			host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, freeMemoryMiB: 9_000, memory: wrong } } });
			await tick();
			const view = await service.get(a.hostId);
			expect(view.memory).toBeUndefined();
		}
		// Pressure over 100% is taken as 100%; no time, none said.
		const { measuredAt: _, ...unmeasured } = memory;
		host.send({
			type: "heartbeat",
			heartbeat: { capacity: { ...capacity, memory: { ...unmeasured, pressureSome: 140 } } },
		});
		await tick();
		expect((await service.get(a.hostId)).memory).toEqual({ ...unmeasured, pressureSome: 100 });
	});

	it("shows how a host reaches its mesh peers as its latest heartbeat says, only while it is connected", async () => {
		const { service, join } = await setup();
		const a = await join("a");
		const host = new FakeHost(service, a.hostId);
		host.connect();
		await tick();
		expect((await service.get(a.hostId)).mesh).toBeUndefined();
		const capacity = { freeMemoryMiB: 10_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0 };
		const mesh = {
			address: "fd4b:91c2:7e10:0:5a1e:3f20:9c4d:1b07",
			peers: [
				{
					hostId: "host_b",
					path: "direct",
					endpoint: "203.0.113.24:51820",
					lastHandshake: 1_700_000_000_000,
					rttMs: 0.4,
				},
				{ hostId: "host_c", path: "none" },
			],
		};
		host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, mesh } } });
		await tick();
		expect((await service.get(a.hostId)).mesh).toEqual(mesh);
		// A peer that isn't one is left out, as is a figure that isn't one; the rest still stands.
		host.send({
			type: "heartbeat",
			heartbeat: {
				capacity: {
					...capacity,
					mesh: {
						address: mesh.address,
						peers: [
							{ hostId: "host_b", path: "direct", lastHandshake: -5, rttMs: "fast", endpoint: 7 },
							{ path: "direct" },
							"host_d",
							{ hostId: "host_c", path: "" },
						],
					},
				},
			},
		});
		await tick();
		expect((await service.get(a.hostId)).mesh).toEqual({
			address: mesh.address,
			peers: [{ hostId: "host_b", path: "direct" }],
		});
		// A mesh without an address isn't one, and leaves the heartbeat standing.
		host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, freeDiskGiB: 300, mesh: { peers: [] } } } });
		await tick();
		const view = await service.get(a.hostId);
		expect(view.mesh).toBeUndefined();
		expect(view.freeDiskGb).toBe(300);
		// Once the host drops, its last report says nothing about now.
		host.send({ type: "heartbeat", heartbeat: { capacity: { ...capacity, mesh } } });
		await tick();
		expect((await service.get(a.hostId)).mesh).toEqual(mesh);
		service.hub.disconnect(a.hostId, 1001, "gone");
		await tick();
		expect((await service.get(a.hostId)).mesh).toBeUndefined();
	});

	it("shows a host's free disk as its latest heartbeat reports it, not as it was when it connected", async () => {
		const { service, join } = await setup();
		const a = await join("a");
		const host = new FakeHost(service, a.hostId);
		host.connect();
		await tick();
		// The hello's capacity (400 GiB free), not its facts' 500.
		expect((await service.get(a.hostId)).capacity.diskGb).toBe(400);
		host.send({
			type: "heartbeat",
			heartbeat: { capacity: { freeMemoryMiB: 4_000, freeDiskGiB: 120, running: 0, stopped: 0, load1: 0, warm: {} } },
		});
		await tick();
		expect((await service.get(a.hostId)).capacity.diskGb).toBe(120);
	});

	it("tells a host that stays connected which images to take, again on a heartbeat every so often", async () => {
		let now = 1_000_000;
		const { service, join } = await setup({ now: () => now });
		let version = "host-images-20261103.1";
		let reads = 0;
		service.useCompute({
			secrets: async () => undefined,
			recordEgress: async () => undefined,
			images: async () => {
				reads += 1;
				return { channel: "stable", version, url: `https://example.com/${version}` };
			},
		});
		const a = await join("a");
		const host = new FakeHost(service, a.hostId);
		host.connect();
		await tick();
		const welcomes = () => host.sent.filter((message) => message.type === "welcome").map((message) => message.welcome);
		expect(welcomes().at(-1)).toMatchObject({ images: { version: "host-images-20261103.1" } });
		const heartbeat = () =>
			host.send({
				type: "heartbeat",
				heartbeat: {
					capacity: { freeMemoryMiB: 10_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0, warm: {} },
				},
			});
		// A release published since: not said on every heartbeat, only once the refresh interval has passed.
		version = "host-images-20261104.2";
		now += 60_000;
		heartbeat();
		await tick();
		expect(welcomes()).toHaveLength(1);
		expect(reads).toBe(1);
		now += IMAGES_REFRESH_MS;
		heartbeat();
		await tick();
		expect(welcomes()).toHaveLength(2);
		expect(welcomes().at(-1)).toMatchObject({ images: { version: "host-images-20261104.2" } });
	});

	it("passes on the bases a host reports for its own sandboxes, from its hello and its events", async () => {
		const { service, store, join } = await setup();
		const recorded: { hostId: string; sandboxId: string; base: string; baseAt?: number }[] = [];
		service.useCompute({
			secrets: async () => undefined,
			recordEgress: async () => undefined,
			recordBases: async (hostId, reports) => {
				for (const report of reports.sandboxes ?? []) recorded.push({ hostId, ...report });
			},
		});
		const a = await join("a");
		const placed = (sandboxId: string) =>
			store.putPlacement({
				sandboxId,
				hostId: a.hostId,
				tier: "microvm",
				size: "default",
				vcpus: 2,
				memoryMiB: 2048,
				diskGiB: 20,
				state: "stopped",
				createdAt: 1,
				updatedAt: 1,
			});
		await placed("sbx-old");
		await placed("sbx-unversioned");
		const host = new FakeHost(service, a.hostId);
		host.connect([
			{
				id: "sbx-old",
				tier: "microvm",
				size: "default",
				state: "stopped",
				createdAt: 1,
				base: "host-images-1",
				baseAt: 5,
			},
			// An older host's report: no base, so nothing is said (and nothing erased).
			{ id: "sbx-unversioned", tier: "microvm", size: "default", state: "stopped", createdAt: 1 },
			// Not Kantel's placement on this host: never passed on.
			{ id: "stray", tier: "microvm", size: "default", state: "stopped", createdAt: 1, base: "host-images-1" },
		]);
		await tick();
		expect(recorded).toEqual([{ hostId: a.hostId, sandboxId: "sbx-old", base: "host-images-1", baseAt: 5 }]);
		// An event with the state unchanged still says its base.
		host.send({
			type: "event",
			event: {
				kind: "sandbox.state",
				sandbox: { id: "sbx-old", tier: "microvm", state: "stopped", createdAt: 1, base: "host-images-2" },
			},
		});
		await tick();
		expect(recorded.at(-1)).toEqual({ hostId: a.hostId, sandboxId: "sbx-old", base: "host-images-2" });
	});

	it("passes on its snapshots' bases once a connection, from an image patching host only", async () => {
		const { service, join } = await setup();
		const recorded: { hostId: string; ref: string; base: string }[] = [];
		service.useCompute({
			secrets: async () => undefined,
			recordEgress: async () => undefined,
			recordBases: async (hostId, reports) => {
				for (const report of reports.snapshots ?? []) recorded.push({ hostId, ...report });
			},
		});
		const heartbeat = (host: FakeHost) =>
			host.send({
				type: "heartbeat",
				heartbeat: {
					capacity: { freeMemoryMiB: 10_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0, warm: {} },
				},
			});
		const older = new FakeHost(service, (await join("a")).hostId);
		older.connect();
		await tick();
		heartbeat(older);
		await tick();
		expect(older.calls.map((c) => c.method)).not.toContain("snapshot.list");

		const b = await join("b");
		const host = new FakeHost(service, b.hostId, [HOST_FEATURES.imagePatching]);
		host.snapshots = [
			{ id: "snap-old", sandboxId: "sbx-1", base: "host-images-1" },
			{ id: "snap-unversioned", sandboxId: "sbx-1" },
		];
		host.connect();
		await tick();
		heartbeat(host);
		await tick();
		heartbeat(host);
		await tick();
		expect(host.calls.filter((c) => c.method === "snapshot.list")).toHaveLength(1);
		expect(recorded).toEqual([{ hostId: b.hostId, ref: `${b.hostId}/snap-old`, base: "host-images-1" }]);
	});

	it("passes on its snapshots' sizes on its first heartbeat and then every so often, from a host that measures them", async () => {
		let now = 1_000_000;
		const { service, join } = await setup({ now: () => now });
		const recorded: { hostId: string; ref: string; sizeBytes: number }[][] = [];
		service.useCompute({
			secrets: async () => undefined,
			recordEgress: async () => undefined,
			recordSnapshotSizes: async (hostId, sizes) => {
				recorded.push(sizes.map((size) => ({ hostId, ...size })));
			},
		});
		const heartbeat = (host: FakeHost) =>
			host.send({
				type: "heartbeat",
				heartbeat: {
					capacity: { freeMemoryMiB: 10_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0, warm: {} },
				},
			});
		// One that doesn't measure them is never asked.
		const older = new FakeHost(service, (await join("a")).hostId);
		older.snapshots = [{ id: "snap-a", sandboxId: "sbx-1", sizeBytes: 5 }];
		older.connect();
		await tick();
		heartbeat(older);
		await tick();
		expect(older.calls.map((c) => c.method)).not.toContain("snapshot.list");

		const b = await join("b");
		const host = new FakeHost(service, b.hostId, [HOST_FEATURES.snapshotSizes]);
		host.snapshots = [
			{ id: "snap-1", sandboxId: "sbx-1", sizeBytes: 1_000 },
			// Nonsense from a host is dropped.
			{ id: "snap-2", sandboxId: "sbx-1", sizeBytes: -1 },
		];
		host.connect();
		await tick();
		heartbeat(host);
		await tick();
		expect(recorded).toEqual([[{ hostId: b.hostId, ref: `${b.hostId}/snap-1`, sizeBytes: 1_000 }]]);
		// Not again until the refresh interval has passed.
		host.snapshots = [{ id: "snap-1", sandboxId: "sbx-1", sizeBytes: 600 }];
		now += 60_000;
		heartbeat(host);
		await tick();
		expect(recorded).toHaveLength(1);
		now += SNAPSHOT_SIZES_REFRESH_MS;
		heartbeat(host);
		await tick();
		expect(recorded.at(-1)).toEqual([{ hostId: b.hostId, ref: `${b.hostId}/snap-1`, sizeBytes: 600 }]);
		expect(host.calls.filter((c) => c.method === "snapshot.list")).toHaveLength(2);
	});

	it("passes on what of each snapshot is its own and the files several share, by their refs", async () => {
		let now = 1_000_000;
		const { service, join } = await setup({ now: () => now });
		const recorded: { sizes: unknown; shared: unknown }[] = [];
		service.useCompute({
			secrets: async () => undefined,
			recordEgress: async () => undefined,
			recordSnapshotSizes: async (_hostId, sizes, shared) => {
				recorded.push({ sizes, shared });
			},
		});
		const a = await join("a");
		const host = new FakeHost(service, a.hostId, [HOST_FEATURES.snapshotSizes]);
		host.snapshots = [
			{ id: "snap-auto", sandboxId: "sbx-1", sizeBytes: 110, uniqueBytes: 10 },
			{ id: "snap-kept", sandboxId: "sbx-1", sizeBytes: 104, uniqueBytes: 4 },
		];
		host.shared = [
			{ snapshots: ["snap-auto", "snap-kept"], bytes: 100 },
			// Nonsense from a host is dropped.
			{ snapshots: ["snap-auto"], bytes: 5 },
			{ snapshots: ["snap-auto", "snap-kept"], bytes: -1 },
		];
		host.connect();
		await tick();
		host.send({
			type: "heartbeat",
			heartbeat: { capacity: { freeMemoryMiB: 10_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0, warm: {} } },
		});
		await tick();
		now += 1;
		expect(recorded).toEqual([
			{
				sizes: [
					{ ref: `${a.hostId}/snap-auto`, sizeBytes: 110, uniqueBytes: 10 },
					{ ref: `${a.hostId}/snap-kept`, sizeBytes: 104, uniqueBytes: 4 },
				],
				shared: [{ refs: [`${a.hostId}/snap-auto`, `${a.hostId}/snap-kept`], bytes: 100 }],
			},
		]);
	});

	it("reads no image index on a heartbeat with image patching off", async () => {
		let now = 1_000_000;
		const { service, join } = await setup({ now: () => now });
		service.useCompute({ secrets: async () => undefined, recordEgress: async () => undefined });
		const a = await join("a");
		const host = new FakeHost(service, a.hostId);
		host.connect();
		await tick();
		now += IMAGES_REFRESH_MS * 2;
		host.send({
			type: "heartbeat",
			heartbeat: { capacity: { freeMemoryMiB: 10_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0, warm: {} } },
		});
		await tick();
		expect(host.sent.filter((message) => message.type === "welcome")).toHaveLength(1);
	});

	it("says host_unavailable for a boot that never reached its host, and nothing for one it may have done or other calls", async () => {
		const { service, join } = await setup();
		const a = await join("a");
		let host = new FakeHost(service, a.hostId);
		host.connect();
		await tick();
		await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-held" });
		const reasonOf = (call: Promise<unknown>) =>
			call.then(
				() => "answered",
				(error: unknown) => (isKantelError(error) ? `${error.code} ${String(error.details?.reason)}` : String(error)),
			);
		/** `call` with the host holding `method` unanswered, then gone. */
		const dropped = async (method: string, call: () => Promise<unknown>) => {
			host.hold = (held) => (held === method ? new Promise<void>(() => undefined) : undefined);
			const before = host.calls.length;
			const pending = reasonOf(call());
			while (!host.calls.slice(before).some((made) => made.method === method)) await tick();
			service.hub.disconnect(a.hostId, 1001, "gone");
			const answer = await pending;
			host = new FakeHost(service, a.hostId);
			host.connect();
			await tick();
			return answer;
		};
		// Sent, and its host gone while it waited: it may have been done there, so it isn't said to have been refused.
		expect(await dropped("sandbox.create", () => service.sandboxes.create({ tier: "microvm" }))).toBe(
			"unavailable undefined",
		);
		expect(await dropped("sandbox.start", () => service.sandboxes.call("sbx-held", "sandbox.start"))).toBe(
			"unavailable undefined",
		);
		// Never sent, its host not connected: refused for its host.
		service.hub.disconnect(a.hostId, 1001, "gone");
		expect(await reasonOf(service.sandboxes.call("sbx-held", "sandbox.start"))).toBe("unavailable host_unavailable");
		host = new FakeHost(service, a.hostId);
		host.connect();
		await tick();
		// Not a boot: its host going is an ordinary `unavailable`.
		expect(
			await dropped("sandbox.exec", () => service.sandboxes.call("sbx-held", "sandbox.exec", { command: "true" })),
		).toBe("unavailable undefined");
		// Nor is a host's own failure of a boot a placement's.
		const broke = kantelErrorFromHost(new HostCallError({ code: "unavailable", message: "It broke" }));
		expect(isKantelError(broke, "unavailable") && broke.details).toBeUndefined();
	});

	it("says why it can't place a sandbox in details.reason, the codes as before", async () => {
		const { service, join } = await setup();
		const a = await join("a");
		const host = new FakeHost(service, a.hostId);
		host.freeMemoryMiB = 1_000;
		host.connect();
		await tick();
		const refusal = (input: Parameters<HostsService["sandboxes"]["create"]>[0]) =>
			service.sandboxes.create(input).then(
				() => "placed",
				(error: unknown) => (isKantelError(error) ? `${error.code} ${String(error.details?.reason)}` : String(error)),
			);
		expect(await refusal({ tier: "microvm" })).toBe("exhausted insufficient_capacity");
		expect(await refusal({ tier: "microvm", labels: { zone: "ams" } })).toBe("exhausted no_host_with_labels");
		expect(await refusal({ tier: "microvm", size: "huge" })).toBe("exhausted no_host_offers_size");
		// Made from a snapshot, it goes only on the snapshot's host: that host being away is the reason.
		const b = await join("b");
		expect(await refusal({ tier: "microvm", hostIds: [b.hostId], from: "snap_1" })).toBe("exhausted host_unavailable");
		expect(await refusal({ tier: "microvm", hostIds: [b.hostId] })).toBe("exhausted no_host");
		// A host that refuses it for capacity itself says so too.
		const fromHost = kantelErrorFromHost(new HostCallError({ code: "capacity", message: "The host is full" }));
		expect(isKantelError(fromHost, "exhausted") && fromHost.details).toEqual({ reason: "insufficient_capacity" });
		const other = kantelErrorFromHost(new HostCallError({ code: "internal", message: "It broke" }));
		expect(isKantelError(other, "unavailable") && other.details).toBeUndefined();
	});

	it("sends a custom shape as its numbers, only to a host that makes them, and a named one by its name", async () => {
		const { service, join } = await setup();
		const old = await join("old");
		const fresh = await join("fresh");
		const hostOld = new FakeHost(service, old.hostId);
		hostOld.freeMemoryMiB = 30_000;
		hostOld.connect();
		const hostNew = new FakeHost(service, fresh.hostId, [HOST_FEATURES.customShapes]);
		hostNew.freeMemoryMiB = 10_000;
		hostNew.connect();
		await tick();
		const custom = await service.sandboxes.create({ tier: "microvm", shape: { vcpus: 3, memoryMiB: 6144 } });
		expect(custom.hostId).toBe(fresh.hostId);
		expect(hostNew.calls.find((call) => call.method === "sandbox.create")?.params).toMatchObject({
			size: "",
			vcpus: 3,
			memoryMiB: 6144,
			diskGiB: 20,
		});
		expect(custom.placement).toMatchObject({ size: "custom-3c-6144m-20g", vcpus: 3, memoryMiB: 6144 });
		// The shape of its named size goes by name, to the roomier host, which needn't make custom shapes.
		const named = await service.sandboxes.create({ tier: "microvm", shape: { vcpus: 2, memoryMiB: 2048 } });
		expect(named.hostId).toBe(old.hostId);
		expect(hostOld.calls.find((call) => call.method === "sandbox.create")?.params).toMatchObject({ size: "default" });
		expect(hostOld.calls.find((call) => call.method === "sandbox.create")?.params).not.toHaveProperty("vcpus");
		// A named size's vCPUs and memory with a disk of its own: a custom shape, with that disk.
		const disk = await service.sandboxes.create({ tier: "microvm", shape: { vcpus: 2, memoryMiB: 2048, diskGiB: 64 } });
		expect(disk.hostId).toBe(fresh.hostId);
		expect(hostNew.calls.filter((call) => call.method === "sandbox.create").at(-1)?.params).toMatchObject({
			size: "",
			vcpus: 2,
			memoryMiB: 2048,
			diskGiB: 64,
		});
		await expect(
			service.sandboxes.create({ tier: "microvm", shape: { vcpus: 2, memoryMiB: 2048, diskGiB: 0.5 } }),
		).rejects.toThrow(/whole GiB/);
		await expect(
			service.sandboxes.create({ tier: "isolate", shape: { vcpus: 0, memoryMiB: 256, diskGiB: 10 } }),
		).rejects.toThrow(/no disk/);
		// An isolate's memory reaches a host that records it, as what it asked for.
		const isolate = await service.sandboxes.create({
			tier: "isolate",
			shape: { vcpus: 0, memoryMiB: 384 },
			hostIds: [fresh.hostId],
		});
		expect(isolate.hostId).toBe(fresh.hostId);
		expect(hostNew.calls.filter((call) => call.method === "sandbox.create").at(-1)?.params).toMatchObject({
			tier: "isolate",
			size: "",
			memoryMiB: 384,
		});
	});

	it("records the size a host made when it isn't the one placement chose, so a restore's disk is its own", async () => {
		const { service, join, store } = await setup();
		const joined = await join("h");
		const host = new FakeHost(service, joined.hostId, [HOST_FEATURES.customShapes]);
		host.freeMemoryMiB = 30_000;
		host.moreFacts = {
			sizes: [
				{ name: "default", vcpus: 4, memoryMiB: 8192, diskGiB: 20 },
				{ name: "large", vcpus: 4, memoryMiB: 8192, diskGiB: 50 },
			],
		};
		host.connect();
		await tick();
		// Placed as "default" by its numbers; the host restores a memory snapshot as its own "large".
		host.madeSize = "large";
		const restored = await service.sandboxes.create({ tier: "microvm", shape: { vcpus: 4, memoryMiB: 8192 } });
		expect(restored.placement).toMatchObject({ size: "large", vcpus: 4, memoryMiB: 8192, diskGiB: 50 });
		// A custom size by its name: the disk it was made with.
		host.madeSize = "custom-4c-8192m-30g";
		const custom = await service.sandboxes.create({ tier: "microvm", shape: { vcpus: 4, memoryMiB: 8192 } });
		expect(custom.placement).toMatchObject({ size: "custom-4c-8192m-30g", diskGiB: 30 });
		// As placed, it stays as placed.
		host.madeSize = undefined;
		const plain = await service.sandboxes.create({ tier: "microvm", shape: { vcpus: 4, memoryMiB: 8192 } });
		expect(plain.placement).toMatchObject({ size: "default", diskGiB: 20 });
		// However the report comes: an event (after a create's answer was lost, say) says what the host made too.
		host.send({
			type: "event",
			event: {
				kind: "sandbox",
				sandbox: { id: plain.sandbox.id, tier: "microvm", size: "large", state: "running", createdAt: 1 },
			},
		});
		await tick();
		expect(await store.getPlacement(plain.sandbox.id)).toMatchObject({ size: "large", diskGiB: 50 });
	});

	it("asks every host for no warm machines, so an older one that keeps some ends them", async () => {
		const { service, join } = await setup();
		const a = await join("a");
		const host = new FakeHost(service, a.hostId);
		host.connect();
		await tick();
		const welcomes = () => host.sent.filter((message) => message.type === "welcome");
		expect(welcomes().at(-1)?.welcome).toMatchObject({ pools: {} });
		const drained = await service.update(a.hostId, { draining: true });
		expect(drained).not.toHaveProperty("pools");
		expect(welcomes().at(-1)?.welcome).toMatchObject({ pools: {}, draining: true });
	});

	it("tells an older host still reporting warm machines to keep none, once a minute until it reports none", async () => {
		let now = 1_000;
		const { service, join } = await setup({ now: () => now });
		const a = await join("a");
		const host = new FakeHost(service, a.hostId);
		host.connect();
		await tick();
		const beat = (warm: { [pool: string]: number }) =>
			host.send({
				type: "heartbeat",
				heartbeat: { capacity: { freeMemoryMiB: 10_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0, warm } },
			});
		const asked = () => host.calls.filter((call) => call.method === "host.pools");
		beat({});
		beat({ "microvm/default": 0 });
		await tick();
		expect(asked()).toHaveLength(0);
		beat({ "microvm/default": 2 });
		await tick();
		expect(asked()).toEqual([{ method: "host.pools", params: {} }]);
		now += 30_000;
		beat({ "microvm/default": 1 });
		await tick();
		expect(asked()).toHaveLength(1);
		now += 30_000;
		beat({ "microvm/default": 1 });
		await tick();
		expect(asked()).toHaveLength(2);
		// Once it reports none it is left be; should it keep some again, it is told again at once.
		beat({});
		beat({ "microvm/default": 1 });
		await tick();
		expect(asked()).toHaveLength(3);
	});

	it("sends settings changed in a burst as they are last, never an older one after a newer", async () => {
		const { service, join } = await setup();
		const a = await join("a");
		const host = new FakeHost(service, a.hostId);
		host.connect();
		await tick();
		await Promise.all([
			service.update(a.hostId, { draining: true }),
			service.update(a.hostId, { draining: false }),
			service.update(a.hostId, { draining: true }),
		]);
		await tick();
		const welcomes = host.sent.filter((message) => message.type === "welcome");
		expect(welcomes.at(-1)?.welcome?.draining).toBe(true);
	});

	it("ends a host's hello on a drain set or lifted while it was answered", async () => {
		for (const [before, set] of [
			[false, true],
			[true, false],
		] as const) {
			// The hello's last read of the host (after it reconciles) is taken, then held: an update lands between that read
			// and its welcome.
			const inner = createMemoryHostStore();
			let gate: Promise<void> | undefined;
			let armed = 0;
			const store = {
				...inner,
				async placementsOn(hostId: string) {
					if (gate !== undefined && armed === 0) armed = 1;
					return inner.placementsOn(hostId);
				},
				async getHost(hostId: string) {
					const read = await inner.getHost(hostId);
					if (armed === 1) {
						armed = 2;
						await gate;
					}
					return read;
				},
			};
			const service = createHostsService({ store, publicUrl: "https://kantel.example.com/", log: () => {} });
			services.push(service);
			const token = await service.createJoinToken({ name: "a" });
			const { hostId } = await service.register({ token: token.token, facts: facts() });
			// Its setting before this hello, so the hello's read is older than what is set during it.
			await service.update(hostId, { draining: before });

			let open = () => {};
			gate = new Promise((resolve) => {
				open = resolve;
			});
			const host = new FakeHost(service, hostId);
			host.connect();
			await tick();
			expect(host.welcomed()).toBe(false);
			await service.update(hostId, { draining: set });
			open();
			await tick();
			const welcomes = host.sent.filter((message) => message.type === "welcome");
			expect(welcomes.length).toBeGreaterThan(0);
			expect(welcomes.at(-1)?.welcome?.draining === true).toBe(set);
		}
	});

	it("takes over from an older connection and revokes a host for good", async () => {
		const { service, join } = await setup();
		const a = await join("a");
		const first = new FakeHost(service, a.hostId);
		first.connect();
		await tick();
		const second = new FakeHost(service, a.hostId);
		second.connect();
		await tick();
		expect(first.closedWith?.code).toBe(HOST_CLOSE_REPLACED);
		// The old socket's close doesn't take the host offline.
		first.connection.closed(HOST_CLOSE_REPLACED, "replaced");
		expect(service.hub.connected(a.hostId)).toBe(true);
		const revoked = await service.revoke(a.hostId);
		expect(revoked.state).toBe("revoked");
		expect(second.closedWith?.code).toBe(HOST_CLOSE_REVOKED);
		expect(await service.authenticate(a.credential)).toBeUndefined();
	});

	it("refuses a hello from another protocol version or for another host", async () => {
		const { service, join } = await setup();
		const a = await join("a");
		const host = new FakeHost(service, a.hostId);
		host.connection = service.hub.accept(a.hostId, {
			sendText: () => undefined,
			sendBinary: () => undefined,
			close: (code, reason) => {
				host.closedWith = { code, reason };
			},
		});
		host.send({
			type: "hello",
			hello: {
				hostId: "host_other",
				facts: facts(),
				sandboxes: [],
				capacity: { freeMemoryMiB: 1, freeDiskGiB: 1, running: 0, stopped: 0, load1: 0, warm: {} },
			},
		});
		await tick();
		expect(host.closedWith).toMatchObject({ code: 4002, reason: "The hello names another host than the credential" });
		expect(service.hub.connected(a.hostId)).toBe(false);
	});

	it("serves registration and the operator's routes over HTTP", async () => {
		const { service } = await setup();
		let admin = true;
		const api = createHostsApi({
			hosts: service,
			async authorizeAdmin() {
				if (!admin) {
					const { KantelError } = await import("@kantel/contracts");
					throw new KantelError("forbidden", "Operators only");
				}
			},
		});
		const call = async (method: string, path: string, body?: unknown) => {
			const response = await api.fetch(
				new Request(`https://k.example${path}`, {
					method,
					...(body === undefined
						? {}
						: { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
				}),
			);
			// biome-ignore lint/suspicious/noExplicitAny: a test reads the answers' fields directly
			const answer: any = response === undefined ? undefined : await response.json().catch(() => undefined);
			return { status: response?.status, body: answer };
		};
		const made = await call("POST", "/v1/admin/hosts/join-tokens", { name: "edge", labels: { region: "eu" } });
		expect(made.status).toBe(201);
		const registered = await call("POST", "/v1/hosts/register", {
			token: made.body.token,
			name: "ignored",
			facts: facts(),
		});
		expect(registered.status).toBe(201);
		expect(registered.body).toMatchObject({
			hostId: expect.stringMatching(/^host_/),
			credential: expect.stringMatching(/^khc_/),
		});
		expect((await call("POST", "/v1/hosts/register", { token: made.body.token })).status).toBe(403);
		const listed = await call("GET", "/v1/admin/hosts");
		expect(listed.body.items).toHaveLength(1);
		expect(listed.body.items[0]).toMatchObject({ name: "edge", state: "unreachable", arch: "x86_64" });
		const patched = await call("PATCH", `/v1/admin/hosts/${registered.body.hostId}`, {
			draining: true,
			name: "edge-2",
		});
		expect(patched.body).toMatchObject({ name: "edge-2", state: "unreachable" });
		expect((await call("POST", "/v1/admin/compute/sandboxes", { tier: "microvm" })).status).toBe(503);
		admin = false;
		expect((await call("GET", "/v1/admin/hosts")).status).toBe(403);
		expect(await api.fetch(new Request("https://k.example/v1/sessions"))).toBeUndefined();
	});
});

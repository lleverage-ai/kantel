// A lost host's sandboxes made again on another host (LLE-19622): one whose `onHostLost` is `recreate` is made again,
// under its ID, on another connected host in its pool, from its newest saved snapshot, with a `sandbox.recreated`
// event; the lost host's copy stays fenced, and is deleted when that host connects again, before it is used. One that
// can't be made again (no saved snapshot, no host to take it) is lost as before, its reason saying why; one that
// never asked (`lost`, the default) is lost whatever hosts there are. apps/host/test/host-lost.sh kills a real host
// to show it.
import { createKantelClient } from "@kantel/api/sdk";
import {
	CREATE_SETTLE_GRACE_MS,
	createComputeApi,
	createOutcomeUnknown,
	HOST_LOST_REASON,
	joinTokenSpender,
	NOT_RECREATED,
	notRecreated,
	RECREATED_STOP_REASON,
	type SandboxBackend,
	UPGRADE_STALE_MS,
} from "@kantel/compute";
import { KantelError } from "@kantel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBackend } from "../src/backend.ts";
import { HOST_FEATURES } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";
import { FakeHost } from "./fake-host.ts";

const ROOT = { userId: "usr_root", name: "Root", superAdmin: true };
const FEATURES = [HOST_FEATURES.egressPolicy, HOST_FEATURES.guestHealth, HOST_FEATURES.exitStamps];
/** The deadline, short for the tests: what `KANTEL_HOST_LOST_AFTER_MINUTES` sets. */
const LOST_AFTER_MS = 400;
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

/**
 * A control plane with host `a` and, once `onHostLost` says, a running microVM on it; host `b`, in the same pool, joins
 * after, so the sandbox is on `a`. The clock is the compute plane's own, moved by hand.
 */
async function setup(
	options: {
		readonly onHostLost?: "recreate" | "lost";
		readonly second?: boolean;
		/** Host b's free memory as it reports it; default plenty. */
		readonly secondFreeMemoryMiB?: number;
		/** The compute plane's backend as it sees it: the hosts backend, wrapped. */
		readonly wrap?: (backend: SandboxBackend) => SandboxBackend;
	} = {},
) {
	let offset = 0;
	const clock = () => Date.now() + offset;
	const hostStore = createMemoryHostStore();
	const service = createHostsService({
		store: hostStore,
		publicUrl: "https://kantel.test",
		log: () => undefined,
		clock: { now: clock },
	});
	const hostBackend = createHostBackend({
		hosts: service,
		publicUrl: "https://kantel.test",
		tickets: createTunnelTickets(createMemoryRelayStore()),
	});
	const backend = options.wrap?.(hostBackend) ?? hostBackend;
	const gateway = (store?: ReturnType<typeof createComputeApi>["store"]) =>
		createComputeApi({
			backend,
			...(store === undefined ? {} : { store }),
			authenticatePerson: async (request) =>
				request.headers.get("authorization") === "Bearer root" ? ROOT : undefined,
			fetch: async () => new Response(null, { status: 204 }),
			publicUrl: "https://kantel.test",
			now: clock,
			hostLostAfterMs: LOST_AFTER_MS,
		});
	const api = gateway();
	service.useJoinTokens(joinTokenSpender(api.store));
	service.useCompute({
		secrets: async () => undefined,
		recordEgress: async () => undefined,
		reportExit: (...report) => api.service.reportExit(...report),
		hostConnection: (...report) => api.service.reportHostConnection(...report),
		sandboxLost: (...report) => api.service.reportSandboxLost(...report),
	});
	closers.push(
		() => service.close(),
		() => api.close(),
	);
	const root = createKantelClient({
		baseUrl: "https://kantel.test/v1",
		token: "root",
		fetch: (input, init) =>
			api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
	});
	const join = async (name: string, freeMemoryMiB?: number) => {
		const token = await root.createHostJoinToken({ name });
		const { hostId } = await service.register({ token: token.token });
		const host = new FakeHost(service, hostId, FEATURES);
		if (freeMemoryMiB !== undefined) host.freeMemoryMiB = freeMemoryMiB;
		host.connect();
		await vi.waitFor(() => expect(service.hub.connected(hostId)).toBe(true));
		await api.service.idle();
		return { hostId, host };
	};
	const a = await join("a");
	const sandbox = await root.createSandbox({
		type: "microvm",
		wait: true,
		...(options.onHostLost === undefined ? {} : { onHostLost: options.onHostLost }),
	});
	const b = options.second === false ? undefined : await join("b", options.secondFreeMemoryMiB);
	/** Moves the clock on by `ms`, and sweeps until the background work it began is done. */
	const pass = async (ms: number) => {
		offset += ms;
		await api.service.sweep();
		await api.service.idle();
	};
	/** Saves a snapshot of the sandbox, a copy of it held on host `b` too, as a synced pool's host reports one. */
	const save = async (name: string) => {
		const snapshot = await root.saveSnapshot({ sandboxId: sandbox.id, name });
		const stored = await api.store.snapshots.get(snapshot.id);
		if (b !== undefined && stored?.ref !== undefined) {
			const objectId = stored.ref.slice(stored.ref.indexOf("/") + 1);
			await api.store.diskHolders.put({
				id: `snapshot:${objectId}:disk:${b.hostId}`,
				kind: "snapshot",
				objectId,
				version: "disk",
				hostId: b.hostId,
				state: "held",
				since: clock(),
				ref: stored.ref,
			});
		}
		return snapshot;
	};
	/** Host `a` connecting again, as kantel-host does after a disconnect: with what it still has. */
	const reconnectA = async () => {
		const back = new FakeHost(service, a.hostId, FEATURES);
		back.connect([...a.host.sandboxes.values()]);
		await vi.waitFor(() => expect(service.hub.connected(a.hostId)).toBe(true));
		return back;
	};
	const events = async (type: string) =>
		(await api.store.events.list({ accountId: sandbox.accountId })).filter((event) => event.type === type);
	/** Another gateway over the same store and hosts, as a second replica is. */
	const secondGateway = () => {
		const other = gateway(api.store);
		closers.push(() => other.close());
		return other;
	};
	const advance = (ms: number) => {
		offset += ms;
	};
	return { api, root, service, a, b, sandbox, pass, save, reconnectA, events, secondGateway, advance, clock };
}

describe("a lost host's sandbox set to be made again (onHostLost recreate)", () => {
	it("is made again on another host in its pool from its newest saved snapshot, under its ID", async () => {
		const { api, root, service, a, b, sandbox, pass, save, reconnectA, events } = await setup({
			onHostLost: "recreate",
		});
		expect(sandbox).toMatchObject({ onHostLost: "recreate" });
		expect((await service.sandboxes.placement(sandbox.id))?.hostId).toBe(a.hostId);
		await save("older");
		const newest = await save("newest");

		a.host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("running"));
		const recreated = await root.getSandbox(sandbox.id);
		expect(recreated).toMatchObject({ id: sandbox.id, state: "running", onHostLost: "recreate" });
		// On host b, from the newest saved snapshot.
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ hostId: b?.hostId, cleanup: { hostId: a.hostId, fenced: true } });
		expect(placement?.fenced).toBeUndefined();
		const create = b?.host.calls.find((call) => call.method === "sandbox.create");
		const ref = (await api.store.snapshots.get(newest.id))?.ref ?? "";
		expect(create?.params).toMatchObject({ sandboxId: sandbox.id, from: ref.slice(ref.indexOf("/") + 1) });
		// Said once, naming that snapshot; it was never said lost.
		await pass(LOST_AFTER_MS + 1_000);
		const said = await events("sandbox.recreated");
		expect(said).toHaveLength(1);
		expect(said[0]).toMatchObject({ sandboxId: sandbox.id, snapshotId: newest.id, data: { previousState: "running" } });
		expect(await events("sandbox.lost")).toHaveLength(0);
		expect((await api.store.sandboxes.get(sandbox.id))?.recreating).toBeUndefined();

		// Host a comes back still running its copy: it is deleted there first, and the sandbox stays on b.
		expect(a.host.sandboxes.get(sandbox.id)?.state).toBe("running");
		const back = await reconnectA();
		expect(back.calls[0]).toMatchObject({ method: "sandbox.delete", params: { sandboxId: sandbox.id } });
		expect(back.sandboxes.has(sandbox.id)).toBe(false);
		await api.service.idle();
		const after = await service.sandboxes.placement(sandbox.id);
		expect(after?.hostId).toBe(b?.hostId);
		expect(after?.cleanup).toBeUndefined();
		expect((await root.getSandbox(sandbox.id)).state).toBe("running");
	});

	it("carries out its pending environment set-up once its replacement runs", async () => {
		const { api, root, sandbox, pass, save, a } = await setup({ onHostLost: "recreate" });
		await save("kept");
		// Set-up left pending on the lost host (its writes never got through).
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			pendingProvision: [{ id: "prv_left", kind: "paths", paths: [] }],
		}));
		const fence = (await api.store.sandboxes.get(sandbox.id))?.provisionFence ?? 0;
		a.host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("running"));
		const stored = await api.store.sandboxes.get(sandbox.id);
		expect(stored?.provisionFence ?? 0).toBeGreaterThan(fence);
		expect(stored?.pendingProvision ?? []).toHaveLength(0);
	});

	it("is stopped again where it was lost stopped", async () => {
		const { root, b, sandbox, pass, save, a } = await setup({ onHostLost: "recreate" });
		await save("kept");
		await root.stopSandbox(sandbox.id, { wait: true });
		a.host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("stopped"));
		expect(b?.host.calls.some((call) => call.method === "sandbox.create")).toBe(true);
	});

	it("is stopped again by the sweep where its gateway went before its stop was carried out", async () => {
		const { api, root, b, sandbox, pass, save, a } = await setup({ onHostLost: "recreate" });
		await save("kept");
		await root.stopSandbox(sandbox.id, { wait: true });
		if (b === undefined) throw new Error("no host b");
		// Its first stop on host b never gets through, as a gateway gone before sending it.
		let refused = 0;
		b.host.refuse = (method) => {
			if (method !== "sandbox.stop" || refused > 0) return undefined;
			refused += 1;
			return { code: "unavailable", message: "gateway gone" };
		};
		a.host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		expect(refused).toBe(1);
		// The stop stays owed, on the record, until it is carried out.
		const owed = await api.store.sandboxes.get(sandbox.id);
		expect(owed).toMatchObject({ stopFor: RECREATED_STOP_REASON });
		expect(owed?.recreating).toBeUndefined();
		await pass(1_000);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("stopped"));
		expect(b.host.sandboxes.get(sandbox.id)?.state).not.toBe("running");
	});

	it("is stopped again by a fresh gateway where its gateway went after its host answered the stop", async () => {
		const { api, root, b, sandbox, pass, save, a, secondGateway, advance, clock } = await setup({
			onHostLost: "recreate",
		});
		await save("kept");
		await root.stopSandbox(sandbox.id, { wait: true });
		if (b === undefined) throw new Error("no host b");
		// Its stop never lands on this gateway; the record is then left as one taken on by a gateway that went.
		b.host.refuse = (method) =>
			method === "sandbox.stop" ? { code: "unavailable", message: "gateway gone" } : undefined;
		a.host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		// As the record is left when a gateway took the stop on and went, its host's answer unseen.
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			state: "stopping",
			stopClaimedAt: clock(),
		}));
		expect(await api.store.sandboxes.get(sandbox.id)).toMatchObject({
			state: "stopping",
			stopFor: RECREATED_STOP_REASON,
		});
		b.host.refuse = () => undefined;
		const fresh = secondGateway();
		advance(10 * 60_000);
		await fresh.service.sweep();
		await fresh.service.idle();
		await fresh.service.sweep();
		await fresh.service.idle();
		await vi.waitFor(async () => expect((await api.store.sandboxes.get(sandbox.id))?.state).toBe("stopped"));
	});

	it("is made again by the sweep where its gateway went before its create was sent", async () => {
		let dropped = 0;
		const { api, root, service, b, sandbox, pass, save, a } = await setup({
			onHostLost: "recreate",
			wrap: (backend) => ({
				...backend,
				create: async (spec) => {
					// The first create over the lost host's fence never reaches a host: its gateway went.
					if (spec.replacesLost !== undefined && dropped === 0) {
						dropped += 1;
						throw createOutcomeUnknown(new KantelError("unavailable", "gateway gone"));
					}
					return backend.create(spec);
				},
			}),
		});
		await save("kept");
		a.host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		expect(dropped).toBe(1);
		expect(await api.store.sandboxes.get(sandbox.id)).toMatchObject({ state: "starting" });
		expect(b?.host.calls.some((call) => call.method === "sandbox.create")).toBe(false);
		// Its lease gone stale, the sweep settles it as a create first, which finds nothing, then tries it again.
		await pass(UPGRADE_STALE_MS + 1_000);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("running"));
		expect((await service.sandboxes.placement(sandbox.id))?.hostId).toBe(b?.hostId);
		await pass(LOST_AFTER_MS + 1_000);
		expect((await api.store.sandboxes.get(sandbox.id))?.recreating).toBeUndefined();
	});

	it("is made again by the sweep where its create was never sent and its lost host came back and deleted its copy", async () => {
		let dropped = 0;
		const { api, root, service, b, sandbox, pass, save, a, reconnectA } = await setup({
			onHostLost: "recreate",
			wrap: (backend) => ({
				...backend,
				create: async (spec) => {
					if (spec.replacesLost !== undefined && dropped === 0) {
						dropped += 1;
						throw createOutcomeUnknown(new KantelError("unavailable", "gateway gone"));
					}
					return backend.create(spec);
				},
			}),
		});
		await save("kept");
		a.host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		expect(dropped).toBe(1);
		expect(await api.store.sandboxes.get(sandbox.id)).toMatchObject({ state: "starting" });
		// Host a is back before the sweep tries it again: its fenced copy is deleted, and its placement with it.
		const back = await reconnectA();
		await vi.waitFor(() => expect(back.sandboxes.has(sandbox.id)).toBe(false));
		await api.service.idle();
		expect(await service.sandboxes.placement(sandbox.id)).toBeUndefined();
		await pass(UPGRADE_STALE_MS + 1_000);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("running"));
		expect((await service.sandboxes.placement(sandbox.id))?.hostId).toBe(b?.hostId);
		expect(b?.host.calls.filter((call) => call.method === "sandbox.create")).toHaveLength(1);
	});

	it("keeps a create admitted on the other host, its answer lost, for that host's word, across its reconnection", async () => {
		const { api, root, service, b, sandbox, pass, save, a } = await setup({ onHostLost: "recreate" });
		await save("kept");
		if (b === undefined) throw new Error("no host b");
		// Host b takes the create, and its connection drops before it answers.
		let answer: () => void = () => undefined;
		let admitted: () => void = () => undefined;
		const atCreate = new Promise<void>((resolve) => {
			admitted = resolve;
		});
		b.host.hold = (method) => {
			if (method !== "sandbox.create") return undefined;
			admitted();
			return new Promise<void>((resolve) => {
				answer = resolve;
			});
		};
		a.host.connection.closed(1006, "gone");
		const loss = pass(LOST_AFTER_MS + 1_000);
		await atCreate;
		b.host.connection.closed(1006, "gone");
		answer();
		await loss;
		await vi.waitFor(() => expect(service.hub.connected(b.hostId)).toBe(false));
		expect(b.host.sandboxes.has(sandbox.id)).toBe(true);
		expect(await api.store.sandboxes.get(sandbox.id)).toMatchObject({ state: "starting" });
		// Its gateway's lease gone stale, and no host to plan it on: it waits for host b's word, never lost meanwhile.
		await pass(UPGRADE_STALE_MS + 1_000);
		await pass(UPGRADE_STALE_MS + 1_000);
		const waiting = await api.store.sandboxes.get(sandbox.id);
		expect(waiting).toMatchObject({ state: "starting" });
		expect(waiting?.recreating).toBeDefined();
		expect(b.host.calls.filter((call) => call.method === "sandbox.create")).toHaveLength(1);
		// Host b back with it running: that settles it, on b.
		const back = new FakeHost(service, b.hostId, FEATURES);
		back.connect([...b.host.sandboxes.values()]);
		await vi.waitFor(() => expect(service.hub.connected(b.hostId)).toBe(true));
		await pass(CREATE_SETTLE_GRACE_MS + 1_000);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("running"));
		expect((await service.sandboxes.placement(sandbox.id))?.hostId).toBe(b.hostId);
		await pass(LOST_AFTER_MS + 1_000);
		expect((await api.store.sandboxes.get(sandbox.id))?.recreating).toBeUndefined();
	});

	it("never ends a command its replacement runs from a loss pass that read the lost record late", async () => {
		const { api, root, a, sandbox, save, secondGateway, advance } = await setup({ onHostLost: "recreate" });
		await save("kept");
		const command = (id: string, memoryGeneration?: number) => ({
			id,
			sandboxId: sandbox.id,
			accountId: sandbox.accountId,
			command: "sleep 1000",
			cwd: "/root",
			state: "running" as const,
			stdout: "",
			stderr: "",
			truncated: false,
			startedAt: Date.now(),
			detached: true,
			...(memoryGeneration === undefined ? {} : { memoryGeneration }),
		});
		await api.store.commands.put(command("cmd_old") as never);
		// The first loss pass to list the lost sandbox's commands is held there until let go.
		const list = api.store.commands.list.bind(api.store.commands);
		let held: (() => void) | undefined;
		let reached: () => void = () => undefined;
		const atList = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			held = resolve;
		});
		let gated = false;
		const spy = vi.spyOn(api.store.commands, "list").mockImplementation(async (...args) => {
			if (!gated && (await api.store.sandboxes.get(sandbox.id))?.state === "lost") {
				gated = true;
				reached();
				await gate;
			}
			return list(...args);
		});
		a.host.connection.closed(1006, "gone");
		advance(LOST_AFTER_MS + 1_000);
		const late = api.service.sweep();
		await atList;
		// Another gateway finishes the loss meanwhile: the sandbox is made again, and runs a new command there.
		const other = secondGateway();
		advance(LOST_AFTER_MS + 1_000);
		await other.service.sweep();
		await other.service.idle();
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("running"));
		const generation = (await api.store.sandboxes.get(sandbox.id))?.memoryDropped?.generation;
		expect(generation).toBeGreaterThan(0);
		await api.store.commands.put(command("cmd_new", generation) as never);
		// The late pass goes on: only the lost machine's commands are its to end.
		held?.();
		await late;
		await api.service.idle();
		spy.mockRestore();
		expect((await api.store.commands.get("cmd_old"))?.state).toBe("killed");
		expect((await api.store.commands.get("cmd_new"))?.state).toBe("running");
		expect((await root.getSandbox(sandbox.id)).state).toBe("running");
	});

	it("is lost, saying why, with no saved snapshot", async () => {
		const { root, b, sandbox, pass, a, events } = await setup({ onHostLost: "recreate" });
		a.host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		const reason = notRecreated(NOT_RECREATED.snapshot);
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "lost", reason });
		expect(await events("sandbox.lost")).toMatchObject([{ data: { previousState: "running", reason } }]);
		expect(await events("sandbox.recreated")).toHaveLength(0);
		expect(b?.host.calls.some((call) => call.method === "sandbox.create")).toBe(false);
	});

	it("is lost, saying why, with no other host to take it", async () => {
		const { root, sandbox, pass, save, a, events } = await setup({ onHostLost: "recreate", second: false });
		await save("kept");
		a.host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		const reason = notRecreated(NOT_RECREATED.host);
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "lost", reason });
		expect(await events("sandbox.lost")).toMatchObject([{ data: { reason } }]);
	});

	it("is lost, saying why, when no other host in its pool has room for it", async () => {
		const { root, b, sandbox, pass, save, a, events } = await setup({
			onHostLost: "recreate",
			secondFreeMemoryMiB: 100,
		});
		await save("kept");
		a.host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("lost"));
		const lost = await root.getSandbox(sandbox.id);
		expect(lost.reason).toContain(NOT_RECREATED.failed);
		expect(await events("sandbox.lost")).toMatchObject([{ data: { previousState: "running", reason: lost.reason } }]);
		expect(await events("sandbox.recreated")).toHaveLength(0);
		expect(b?.host.calls.some((call) => call.method === "sandbox.create")).toBe(false);
	});

	it("is lost, saying why, when its create on the other host fails, and the lost host's copy stays fenced", async () => {
		const { root, service, b, sandbox, pass, save, a, reconnectA } = await setup({ onHostLost: "recreate" });
		await save("kept");
		if (b === undefined) throw new Error("no host b");
		b.host.refuse = (method) => (method === "sandbox.create" ? { code: "exhausted", message: "disk full" } : undefined);
		a.host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("lost"));
		expect((await root.getSandbox(sandbox.id)).reason).toContain(NOT_RECREATED.failed);
		// The fence holds as it was: host a deletes its copy when it is back.
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ hostId: a.hostId });
		expect(placement?.fenced).toBeTypeOf("number");
		const back = await reconnectA();
		expect(back.calls[0]).toMatchObject({ method: "sandbox.delete", params: { sandboxId: sandbox.id } });
		expect(await service.sandboxes.placement(sandbox.id)).toBeUndefined();
	});
});

describe("a lost host's sandbox left to be lost (onHostLost lost, the default)", () => {
	it("is lost, as before, whatever other host could take it", async () => {
		const { root, b, sandbox, pass, save, a, events } = await setup();
		expect(sandbox.onHostLost).toBeUndefined();
		await save("kept");
		a.host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "lost", reason: HOST_LOST_REASON });
		expect(await events("sandbox.lost")).toHaveLength(1);
		expect(b?.host.calls.some((call) => call.method === "sandbox.create")).toBe(false);
	});

	it("takes onHostLost on an update, and drops it with lost", async () => {
		const { root, sandbox } = await setup({ second: false });
		expect(await root.updateSandbox(sandbox.id, { onHostLost: "recreate" })).toMatchObject({ onHostLost: "recreate" });
		expect((await root.updateSandbox(sandbox.id, { onHostLost: "lost" })).onHostLost).toBeUndefined();
	});
});

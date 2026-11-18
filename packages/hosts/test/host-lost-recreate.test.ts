// A lost host's sandboxes made again on another host (LLE-19622): one whose `onHostLost` is `recreate` is made again,
// under its ID, on another connected host in its pool, from its newest saved snapshot, with a `sandbox.recreated`
// event; the lost host's copy stays fenced, and is deleted when that host connects again, before it is used. One that
// can't be made again (no saved snapshot, no host to take it) is lost as before, its reason saying why; one that
// never asked (`lost`, the default) is lost whatever hosts there are.
import { createKantelClient } from "@kantel/api/sdk";
import { createComputeApi, HOST_LOST_REASON, joinTokenSpender, NOT_RECREATED, notRecreated } from "@kantel/compute";
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
	const backend = createHostBackend({
		hosts: service,
		publicUrl: "https://kantel.test",
		tickets: createTunnelTickets(createMemoryRelayStore()),
	});
	const api = createComputeApi({
		backend,
		authenticatePerson: async (request) => (request.headers.get("authorization") === "Bearer root" ? ROOT : undefined),
		fetch: async () => new Response(null, { status: 204 }),
		publicUrl: "https://kantel.test",
		now: clock,
		hostLostAfterMs: LOST_AFTER_MS,
	});
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
	return { api, root, service, a, b, sandbox, pass, save, reconnectA, events };
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

	it("is stopped again where it was lost stopped", async () => {
		const { root, b, sandbox, pass, save, a } = await setup({ onHostLost: "recreate" });
		await save("kept");
		await root.stopSandbox(sandbox.id, { wait: true });
		a.host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("stopped"));
		expect(b?.host.calls.some((call) => call.method === "sandbox.create")).toBe(true);
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

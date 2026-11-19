// A lost host's sandboxes made again on another host (LLE-19622): one whose `onHostLost` is `recreate` is made again,
// under its ID, on another connected host in its pool, from its newest saved snapshot, with a `sandbox.recreated`
// event; the lost host's copy stays fenced, and is deleted when that host connects again, before it is used. One that
// can't be made again (no saved snapshot, no host to take it) is lost as before, its reason saying why; one that
// never asked (`lost`, the default) is lost whatever hosts there are. One whose new host is lost too before it runs
// is lost with that host (LLE-19676), and made again or lost as before. apps/host/test/host-lost.sh kills a real host
// to show it.
import { createKantelClient } from "@kantel/api/sdk";
import {
	CREATE_SETTLE_GRACE_MS,
	createComputeApi,
	createOutcomeUnknown,
	HOST_AWAY_STOP_REASON,
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
		/** The deadline; default `LOST_AFTER_MS`. */
		readonly lostAfterMs?: number;
	} = {},
) {
	const lostAfterMs = options.lostAfterMs ?? LOST_AFTER_MS;
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
			hostLostAfterMs: lostAfterMs,
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
	/** A host connecting again, as kantel-host does after a disconnect: with what it still has. */
	const reconnect = async (gone: { readonly hostId: string; readonly host: FakeHost }) => {
		const back = new FakeHost(service, gone.hostId, FEATURES);
		back.connect([...gone.host.sandboxes.values()]);
		await vi.waitFor(() => expect(service.hub.connected(gone.hostId)).toBe(true));
		return back;
	};
	/** Host `a` connecting again. */
	const reconnectA = () => reconnect(a);
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
	return {
		api,
		root,
		service,
		a,
		b,
		sandbox,
		pass,
		save,
		reconnect,
		reconnectA,
		events,
		secondGateway,
		advance,
		clock,
		join,
		lostAfterMs,
		hostStore,
	};
}

/**
 * Host `b` takes the create that makes the sandbox again, and its connection drops before it answers, as `lose` (host
 * a's loss pass) runs.
 */
async function admittedThenAway(b: { readonly host: FakeHost }, lose: () => Promise<void>): Promise<void> {
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
	const loss = lose();
	await atCreate;
	b.host.connection.closed(1006, "gone");
	answer();
	await loss;
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

	it("is stopped where it was lost running but owing a stop (one asked for while its host was away)", async () => {
		const { api, root, b, sandbox, pass, save, a, events } = await setup({ onHostLost: "recreate" });
		await save("kept");
		// As an asked stop leaves it whose host was away past its wait (LLE-19732): running, the stop owed.
		await api.store.sandboxes.update(sandbox.id, (current) => ({ ...current, stopFor: HOST_AWAY_STOP_REASON }));
		a.host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("stopped"));
		expect((await root.getSandbox(sandbox.id)).reason).toBe(HOST_AWAY_STOP_REASON);
		expect(b?.host.calls.some((call) => call.method === "sandbox.create")).toBe(true);
		expect(b?.host.sandboxes.get(sandbox.id)?.state).not.toBe("running");
		// Lost running, as it was.
		expect((await events("sandbox.recreated"))[0]).toMatchObject({ data: { previousState: "running" } });
	});

	it("is published running with the stop it owes in the one write, so it is never usable before it", async () => {
		const { api, root, sandbox, pass, save, a } = await setup({ onHostLost: "recreate" });
		await save("kept");
		await api.store.sandboxes.update(sandbox.id, (current) => ({ ...current, stopFor: HOST_AWAY_STOP_REASON }));
		const update = vi.spyOn(api.store.sandboxes, "update");
		a.host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("stopped"));
		const written = await Promise.all(update.mock.results.map((result) => result.value));
		const running = written.filter((record) => record?.id === sandbox.id && record.state === "running");
		expect(running.length).toBeGreaterThan(0);
		expect(running.map((record) => record?.stopFor)).toEqual(running.map(() => HOST_AWAY_STOP_REASON));
	});

	it("never gives a later run the stop its making again owed, when it is finished after that run began", async () => {
		const { api, root, sandbox, pass } = await setup({ onHostLost: "recreate" });
		const running = await api.store.sandboxes.get(sandbox.id);
		const lifecycle = running?.lifecycle ?? 0;
		// Its replacement ended (or was stopped) and a start booted it again before its making again was finished: its
		// marker names an attempt runs ago.
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			recreating: {
				hostId: "host_gone",
				eventId: "evt_later_run",
				previousState: "running",
				snapshotId: "snap_gone",
				heartbeatAt: Date.now(),
				attempt: lifecycle - 3,
				stopFor: HOST_AWAY_STOP_REASON,
			},
		}));
		await pass(1_000);
		const finished = await api.store.sandboxes.get(sandbox.id);
		expect(finished?.recreating).toBeUndefined();
		expect(finished?.stopFor).toBeUndefined();
		expect((await root.getSandbox(sandbox.id)).state).toBe("running");
	});

	it("is lost as it is, not as an earlier making again found it, where a later run is lost before that one is finished", async () => {
		const { api, root, sandbox, pass, save, a, b, events } = await setup({ onHostLost: "recreate" });
		await save("kept");
		const lifecycle = (await api.store.sandboxes.get(sandbox.id))?.lifecycle ?? 0;
		// Made again after a loss found it stopped; that stop carried out and the sandbox started again since, its making
		// again not yet finished (its event not written, so its marker stays).
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			recreating: {
				hostId: "host_gone",
				eventId: "evt_unfinished",
				previousState: "stopped",
				snapshotId: "snap_gone",
				heartbeatAt: Date.now(),
				attempt: lifecycle - 3,
			},
		}));
		const put = api.store.eventWrites.put.bind(api.store.eventWrites);
		vi.spyOn(api.store.eventWrites, "put").mockImplementation((event) =>
			event.id === "evt_unfinished" ? Promise.reject(new Error("not now")) : put(event),
		);
		a.host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		await vi.waitFor(async () =>
			expect((await events("sandbox.recreated")).some((event) => event.id !== "evt_unfinished")).toBe(true),
		);
		await pass(1_000);
		// Lost running with nothing owed: it runs on host b, not stopped again for the earlier loss.
		const after = await root.getSandbox(sandbox.id);
		expect(after.state).toBe("running");
		expect((await api.store.sandboxes.get(sandbox.id))?.stopFor).toBeUndefined();
		expect(b?.host.sandboxes.get(sandbox.id)?.state).toBe("running");
	});

	it("stops the run its making again published where that run still owes the stop as it is finished", async () => {
		const { api, root, sandbox, pass } = await setup({ onHostLost: "recreate" });
		const lifecycle = (await api.store.sandboxes.get(sandbox.id))?.lifecycle ?? 0;
		// Published by its making again (the attempt before this run), the stop not written yet.
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			recreating: {
				hostId: "host_gone",
				eventId: "evt_own_run",
				previousState: "running",
				snapshotId: "snap_gone",
				heartbeatAt: Date.now(),
				attempt: lifecycle - 1,
				stopFor: HOST_AWAY_STOP_REASON,
			},
		}));
		await pass(1_000);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("stopped"));
		expect((await root.getSandbox(sandbox.id)).reason).toBe(HOST_AWAY_STOP_REASON);
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
		// A deadline long enough for host b to be back within it.
		const lostAfterMs = 10 * UPGRADE_STALE_MS;
		const { api, root, service, b, sandbox, pass, save, a } = await setup({ onHostLost: "recreate", lostAfterMs });
		await save("kept");
		if (b === undefined) throw new Error("no host b");
		await admittedThenAway(b, () => {
			a.host.connection.closed(1006, "gone");
			return pass(lostAfterMs + 1_000);
		});
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
		// The loss pass that finishes it, a minute on.
		await pass(60_000);
		expect((await api.store.sandboxes.get(sandbox.id))?.recreating).toBeUndefined();
	});

	it("is lost, saying why, when the host its create was admitted on is lost too, and that host's copy is fenced", async () => {
		const { api, root, service, b, sandbox, pass, save, a, reconnect, events } = await setup({
			onHostLost: "recreate",
		});
		await save("kept");
		if (b === undefined) throw new Error("no host b");
		await admittedThenAway(b, () => {
			a.host.connection.closed(1006, "gone");
			return pass(LOST_AFTER_MS + 1_000);
		});
		expect(await api.store.sandboxes.get(sandbox.id)).toMatchObject({ state: "starting" });
		// Host b stays away past the deadline too, with host a still away: no host is left to make it on.
		await pass(LOST_AFTER_MS + 1_000);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("lost"));
		const reason = notRecreated(NOT_RECREATED.host);
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "lost", reason });
		const stored = await api.store.sandboxes.get(sandbox.id);
		expect(stored?.recreating).toBeUndefined();
		expect(stored?.losing).toBeUndefined();
		expect(stored?.lostEvent).toBeUndefined();
		// Said once, in the state its first loss found it in.
		await pass(LOST_AFTER_MS + 1_000);
		await pass(UPGRADE_STALE_MS + 1_000);
		expect(await events("sandbox.lost")).toMatchObject([{ data: { previousState: "running", reason } }]);
		expect(await events("sandbox.recreated")).toHaveLength(0);
		expect(b.host.calls.filter((call) => call.method === "sandbox.create")).toHaveLength(1);
		// Host b's copy is fenced, and host a is still owed its copy's removal.
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ hostId: b.hostId, cleanup: { hostId: a.hostId, fenced: true } });
		expect(placement?.fenced).toBeTypeOf("number");

		// Each host deletes its copy when it is back, before it is used.
		const backB = await reconnect(b);
		await vi.waitFor(() => expect(backB.sandboxes.has(sandbox.id)).toBe(false));
		expect(backB.calls[0]).toMatchObject({ method: "sandbox.delete", params: { sandboxId: sandbox.id } });
		const backA = await reconnect(a);
		await vi.waitFor(() => expect(backA.sandboxes.has(sandbox.id)).toBe(false));
		expect(backA.calls[0]).toMatchObject({ method: "sandbox.delete", params: { sandboxId: sandbox.id } });
		await api.service.idle();
		expect(await service.sandboxes.placement(sandbox.id)).toBeUndefined();
		expect((await root.getSandbox(sandbox.id)).state).toBe("lost");
	});

	it("is lost, saying why, when the host its create was admitted on is lost too and its first host's copy is still owed", async () => {
		const { api, root, service, b, sandbox, pass, save, a, join, events, clock } = await setup({
			onHostLost: "recreate",
		});
		const kept = await save("kept");
		if (b === undefined) throw new Error("no host b");
		await admittedThenAway(b, () => {
			a.host.connection.closed(1006, "gone");
			return pass(LOST_AFTER_MS + 1_000);
		});
		// Another host joins the pool, holding the snapshot, with host a still away and owed its copy's removal.
		const c = await join("c");
		const ref = (await api.store.snapshots.get(kept.id))?.ref ?? "";
		const objectId = ref.slice(ref.indexOf("/") + 1);
		await api.store.diskHolders.put({
			id: `snapshot:${objectId}:disk:${c.hostId}`,
			kind: "snapshot",
			objectId,
			version: "disk",
			hostId: c.hostId,
			state: "held",
			since: clock(),
			ref,
		});
		await pass(LOST_AFTER_MS + 1_000);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("lost"));
		const lost = await root.getSandbox(sandbox.id);
		expect(lost.reason).toContain(NOT_RECREATED.failed);
		expect(await events("sandbox.lost")).toMatchObject([{ data: { previousState: "running", reason: lost.reason } }]);
		expect(c.host.sandboxes.has(sandbox.id)).toBe(false);
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ hostId: b.hostId, cleanup: { hostId: a.hostId, fenced: true } });
		expect(placement?.fenced).toBeTypeOf("number");
		expect((await api.store.sandboxes.get(sandbox.id))?.recreating).toBeUndefined();
	});

	it("is made again on its first host where that is back when the host its create was admitted on is lost", async () => {
		const { api, root, service, b, sandbox, pass, save, a, reconnect, events } = await setup({
			onHostLost: "recreate",
		});
		await save("kept");
		if (b === undefined) throw new Error("no host b");
		await admittedThenAway(b, () => {
			a.host.connection.closed(1006, "gone");
			return pass(LOST_AFTER_MS + 1_000);
		});
		// Host a is back meanwhile, and deletes its fenced copy.
		const backA = await reconnect(a);
		await vi.waitFor(() => expect(backA.sandboxes.has(sandbox.id)).toBe(false));
		await api.service.idle();
		expect((await service.sandboxes.placement(sandbox.id))?.cleanup).toBeUndefined();
		// Host b stays away past the deadline: it is made again on host a, over host b's fence.
		await pass(LOST_AFTER_MS + 1_000);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("running"));
		expect(backA.calls.some((call) => call.method === "sandbox.create")).toBe(true);
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ hostId: a.hostId, cleanup: { hostId: b.hostId, fenced: true } });
		expect(placement?.fenced).toBeUndefined();
		await pass(LOST_AFTER_MS + 1_000);
		expect(await events("sandbox.recreated")).toMatchObject([{ data: { previousState: "running" } }]);
		expect(await events("sandbox.lost")).toHaveLength(0);
		expect((await api.store.sandboxes.get(sandbox.id))?.recreating).toBeUndefined();
		// Host b back: its copy is deleted, and the sandbox stays on host a.
		const backB = await reconnect(b);
		await vi.waitFor(() => expect(backB.sandboxes.has(sandbox.id)).toBe(false));
		await api.service.idle();
		expect(await service.sandboxes.placement(sandbox.id)).toMatchObject({ hostId: a.hostId });
		expect((await service.sandboxes.placement(sandbox.id))?.cleanup).toBeUndefined();
		expect((await root.getSandbox(sandbox.id)).state).toBe("running");
	});

	it("is made again from its new host's loss, not a stale retry, where that retry runs as the loss is settled", async () => {
		// A loss pass held after it fenced the new host's copy, before it settled the sandbox (`settleLosing`).
		let held: Promise<void> | undefined;
		let reached: () => void = () => undefined;
		let settlesCreate = 0;
		const { api, root, service, b, sandbox, pass, save, a, reconnect, events, advance } = await setup({
			onHostLost: "recreate",
			wrap: (backend) => ({
				...backend,
				fencedOn: async (sandboxId) => {
					if (held !== undefined) {
						reached();
						await held;
					}
					return backend.fencedOn?.(sandboxId);
				},
				settleCreate: async (sandboxId, attempt) => {
					settlesCreate += 1;
					if (backend.settleCreate === undefined) return { state: "pending" };
					return backend.settleCreate(sandboxId, attempt);
				},
			}),
		});
		await save("kept");
		if (b === undefined) throw new Error("no host b");
		await admittedThenAway(b, () => {
			a.host.connection.closed(1006, "gone");
			return pass(LOST_AFTER_MS + 1_000);
		});
		const backA = await reconnect(a);
		await vi.waitFor(() => expect(backA.sandboxes.has(sandbox.id)).toBe(false));
		await api.service.idle();
		let release: () => void = () => undefined;
		held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const atSettle = new Promise<void>((resolve) => {
			reached = resolve;
		});
		// Host b's loss pass fences its copy, and is held there.
		advance(LOST_AFTER_MS + 1_000);
		await api.service.sweep();
		await atSettle;
		expect((await service.sandboxes.placement(sandbox.id))?.fenced).toBeTypeOf("number");
		// Meanwhile the recreation's lease goes stale, and a sweep finds it.
		const before = settlesCreate;
		advance(UPGRADE_STALE_MS + 1_000);
		await api.service.sweep();
		await vi.waitFor(() => expect(settlesCreate).toBeGreaterThan(before));
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(await api.store.sandboxes.get(sandbox.id)).toMatchObject({ state: "starting" });
		expect((await api.store.sandboxes.get(sandbox.id))?.losing).toBeDefined();
		// The loss goes on: made again on host a, now back, over host b's fence.
		held = undefined;
		release();
		await api.service.idle();
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("running"));
		expect((await service.sandboxes.placement(sandbox.id))?.hostId).toBe(a.hostId);
		await pass(LOST_AFTER_MS + 1_000);
		expect(await events("sandbox.recreated")).toHaveLength(1);
		expect(await events("sandbox.lost")).toHaveLength(0);
	});

	it("keeps its new host's fence where that host's answer to the create is recorded after its loss", async () => {
		const { api, root, service, b, sandbox, save, a, reconnect, events, advance, hostStore } = await setup({
			onHostLost: "recreate",
		});
		await save("kept");
		if (b === undefined) throw new Error("no host b");
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
		advance(LOST_AFTER_MS + 1_000);
		await api.service.sweep();
		await atCreate;
		// Host b answers, and the hosts service's record of that answer is held.
		let armed = true;
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached: () => void = () => undefined;
		const atWrite = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const hold = async (sandboxId: string) => {
			if (!armed || sandboxId !== sandbox.id) return;
			armed = false;
			reached();
			await gate;
		};
		const put = hostStore.putPlacement.bind(hostStore);
		const update = hostStore.updatePlacement.bind(hostStore);
		const puts = vi.spyOn(hostStore, "putPlacement").mockImplementation(async (placement) => {
			await hold(placement.sandboxId);
			return put(placement);
		});
		const updates = vi.spyOn(hostStore, "updatePlacement").mockImplementation(async (sandboxId, change) => {
			await hold(sandboxId);
			return update(sandboxId, change);
		});
		answer();
		await atWrite;
		// Host b goes, and is lost: its copy fenced, the sandbox lost with it, no other host left.
		b.host.connection.closed(1006, "gone");
		await vi.waitFor(() => expect(service.hub.connected(b.hostId)).toBe(false));
		advance(LOST_AFTER_MS + 1_000);
		await api.service.sweep();
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("lost"));
		// The answer's record lands late: the fence holds.
		release();
		await api.service.idle();
		puts.mockRestore();
		updates.mockRestore();
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ hostId: b.hostId, cleanup: { hostId: a.hostId, fenced: true } });
		expect(placement?.fenced).toBeTypeOf("number");
		expect((await root.getSandbox(sandbox.id)).state).toBe("lost");
		expect(await events("sandbox.lost")).toMatchObject([{ data: { previousState: "running" } }]);
		expect(await events("sandbox.running")).toHaveLength(1);
		// Host b back: it deletes its copy before it is used.
		const backB = await reconnect(b);
		await vi.waitFor(() => expect(backB.sandboxes.has(sandbox.id)).toBe(false));
		expect(backB.calls[0]).toMatchObject({ method: "sandbox.delete", params: { sandboxId: sandbox.id } });
	});

	it("never publishes its new host's answer once a loss of that host has begun", async () => {
		// Host b's answer, got by the backend, held before the compute plane publishes it; and b's loss pass, held after
		// it fenced b's copy, before it settled the sandbox.
		let created: () => void = () => undefined;
		const atCreated = new Promise<void>((resolve) => {
			created = resolve;
		});
		let publish: () => void = () => undefined;
		const published = new Promise<void>((resolve) => {
			publish = resolve;
		});
		let fenced: () => void = () => undefined;
		const atFenced = new Promise<void>((resolve) => {
			fenced = resolve;
		});
		let settle: () => void = () => undefined;
		const settling = new Promise<void>((resolve) => {
			settle = resolve;
		});
		let holdsFence = false;
		const { api, root, service, b, sandbox, save, a, events, advance } = await setup({
			onHostLost: "recreate",
			wrap: (backend) => ({
				...backend,
				create: async (spec) => {
					const placement = await backend.create(spec);
					if (spec.replacesLost !== undefined) {
						created();
						await published;
					}
					return placement;
				},
				fencedOn: async (sandboxId) => {
					if (holdsFence) {
						holdsFence = false;
						fenced();
						await settling;
					}
					return backend.fencedOn?.(sandboxId);
				},
			}),
		});
		await save("kept");
		if (b === undefined) throw new Error("no host b");
		a.host.connection.closed(1006, "gone");
		advance(LOST_AFTER_MS + 1_000);
		await api.service.sweep();
		await atCreated;
		expect(b.host.sandboxes.has(sandbox.id)).toBe(true);
		// Host b goes and is lost: its copy fenced, the loss begun.
		b.host.connection.closed(1006, "gone");
		await vi.waitFor(() => expect(service.hub.connected(b.hostId)).toBe(false));
		holdsFence = true;
		advance(LOST_AFTER_MS + 1_000);
		await api.service.sweep();
		await atFenced;
		expect((await service.sandboxes.placement(sandbox.id))?.fenced).toBeTypeOf("number");
		expect((await api.store.sandboxes.get(sandbox.id))?.losing?.hostId).toBe(b.hostId);
		// b's answer goes on to be published: refused, the loss owning it.
		publish();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect((await api.store.sandboxes.get(sandbox.id))?.state).toBe("starting");
		// The loss goes on: lost, with no host left to make it again.
		settle();
		await api.service.idle();
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("lost"));
		expect(await events("sandbox.recreated")).toHaveLength(0);
		expect(await events("sandbox.running")).toHaveLength(1);
		expect(await events("sandbox.lost")).toMatchObject([{ data: { previousState: "running" } }]);
	});

	it.each([
		["while its new host is connected", false],
		["when its new host is back, gone as it answered", true],
	])(
		"deletes the copy its new host makes after a delete through another gateway took its admission there, %s",
		async (_, away) => {
			const { api, b, sandbox, save, a, advance, secondGateway, hostStore, reconnect, service } = await setup({
				onHostLost: "recreate",
			});
			await save("kept");
			if (b === undefined) throw new Error("no host b");
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
			advance(LOST_AFTER_MS + 1_000);
			await api.service.sweep();
			await atCreate;
			expect((await hostStore.getPlacement(sandbox.id))?.hostId).toBe(b.hostId);
			// Another gateway deletes it before host b has made it: b has nothing to delete, and its admission goes.
			const other = secondGateway();
			const client = createKantelClient({
				baseUrl: "https://kantel.test/v1",
				token: "root",
				fetch: (input, init) =>
					other.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
			});
			await client.deleteSandbox(sandbox.id);
			await other.service.idle();
			expect(b.host.calls.map((call) => call.method)).toContain("sandbox.delete");
			// What is left is host a's copy, still owed its removal there.
			const owed = await hostStore.getPlacement(sandbox.id);
			expect(owed).toMatchObject({ hostId: a.hostId, state: "deleting", cleanup: { hostId: a.hostId } });
			// Then b makes it, and answers (and, `away`, goes before anything more reaches it): the copy it made is fenced
			// there, never placed again, and deleted by its fence; host a's removal is still owed.
			let release: () => void = () => undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let reached: () => void = () => undefined;
			const atWrite = new Promise<void>((resolve) => {
				reached = resolve;
			});
			const update = hostStore.updatePlacement.bind(hostStore);
			let armed = away;
			const updates = vi.spyOn(hostStore, "updatePlacement").mockImplementation(async (sandboxId, change) => {
				if (armed && sandboxId === sandbox.id) {
					armed = false;
					reached();
					await gate;
				}
				return update(sandboxId, change);
			});
			answer();
			let copy = b.host;
			if (away) {
				await atWrite;
				b.host.connection.closed(1006, "gone");
				await vi.waitFor(() => expect(service.hub.connected(b.hostId)).toBe(false));
				release();
				await api.service.idle();
				expect(b.host.sandboxes.has(sandbox.id)).toBe(true);
				expect(await hostStore.getPlacement(sandbox.id)).toMatchObject({
					hostId: b.hostId,
					state: "lost",
					cleanup: { hostId: a.hostId },
				});
				copy = await reconnect(b);
			}
			await api.service.idle();
			updates.mockRestore();
			await vi.waitFor(() => expect(copy.sandboxes.has(sandbox.id)).toBe(false));
			await vi.waitFor(async () =>
				expect(await hostStore.getPlacement(sandbox.id)).toMatchObject({
					hostId: a.hostId,
					state: "deleting",
					cleanup: { hostId: a.hostId },
				}),
			);
			expect((await hostStore.getPlacement(sandbox.id))?.fenced).toBeUndefined();
			expect((await api.store.sandboxes.get(sandbox.id))?.state).toBe("deleted");
			// Host a back: it deletes its copy, and the placement goes.
			const backA = await reconnect(a);
			await vi.waitFor(() => expect(backA.sandboxes.has(sandbox.id)).toBe(false));
			await vi.waitFor(async () => expect(await hostStore.getPlacement(sandbox.id)).toBeUndefined());
		},
	);

	it.each([
		["", false],
		[", and an earlier delete's removal lands after its new host has gone", true],
	])(
		"deletes the copy its new host makes after a delete took its admission there, with nothing else owed%s",
		async (_, twice) => {
			const { api, b, sandbox, save, a, advance, hostStore, reconnect, secondGateway, service } = await setup({
				onHostLost: "recreate",
			});
			await save("kept");
			if (b === undefined) throw new Error("no host b");
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
			advance(LOST_AFTER_MS + 1_000);
			await api.service.sweep();
			await atCreate;
			// Host a back first: its fenced copy deleted, nothing owed it.
			const backA = await reconnect(a);
			await vi.waitFor(() => expect(backA.sandboxes.has(sandbox.id)).toBe(false));
			await vi.waitFor(async () => expect((await hostStore.getPlacement(sandbox.id))?.cleanup).toBeUndefined());
			// `twice`: a delete on the hosts service first, which b answers (it has nothing yet) and whose removal of the
			// placement it read is held.
			const removeIf = hostStore.removePlacementIf.bind(hostStore);
			let releaseRemoval: () => void = () => undefined;
			const removal = new Promise<void>((resolve) => {
				releaseRemoval = resolve;
			});
			let removing: () => void = () => undefined;
			const atRemoval = new Promise<void>((resolve) => {
				removing = resolve;
			});
			let holdsRemoval = twice;
			const removals = vi.spyOn(hostStore, "removePlacementIf").mockImplementation(async (sandboxId, should) => {
				if (holdsRemoval && sandboxId === sandbox.id) {
					holdsRemoval = false;
					removing();
					await removal;
				}
				return removeIf(sandboxId, should);
			});
			const earlier = twice ? service.sandboxes.delete(sandbox.id) : Promise.resolve();
			if (twice) await atRemoval;
			// Deleted through another gateway before b has made it: no placement is left.
			const other = secondGateway();
			const client = createKantelClient({
				baseUrl: "https://kantel.test/v1",
				token: "root",
				fetch: (input, init) =>
					other.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
			});
			await client.deleteSandbox(sandbox.id);
			await other.service.idle();
			await vi.waitFor(async () => expect(await hostStore.getPlacement(sandbox.id)).toBeUndefined());
			// b answers: the copy it made is fenced there and deleted, and no placement is left. `twice`: b goes as it
			// answers, and the earlier delete's removal lands after: the fence stays, and b deletes its copy once back.
			let copy = b.host;
			if (twice) {
				const update = hostStore.updatePlacement.bind(hostStore);
				let releaseWrite: () => void = () => undefined;
				const write = new Promise<void>((resolve) => {
					releaseWrite = resolve;
				});
				let writing: () => void = () => undefined;
				const atWrite = new Promise<void>((resolve) => {
					writing = resolve;
				});
				let armed = true;
				const updates = vi.spyOn(hostStore, "updatePlacement").mockImplementation(async (sandboxId, change) => {
					if (armed && sandboxId === sandbox.id) {
						armed = false;
						writing();
						await write;
					}
					return update(sandboxId, change);
				});
				answer();
				await atWrite;
				b.host.connection.closed(1006, "gone");
				await vi.waitFor(() => expect(service.hub.connected(b.hostId)).toBe(false));
				releaseWrite();
				await api.service.idle();
				updates.mockRestore();
				expect(await hostStore.getPlacement(sandbox.id)).toMatchObject({ hostId: b.hostId, state: "lost" });
				releaseRemoval();
				await earlier;
				expect(await hostStore.getPlacement(sandbox.id)).toMatchObject({ hostId: b.hostId, state: "lost" });
				expect((await hostStore.getPlacement(sandbox.id))?.fenced).toBeTypeOf("number");
				copy = await reconnect(b);
			} else {
				answer();
			}
			await api.service.idle();
			removals.mockRestore();
			await vi.waitFor(() => expect(copy.sandboxes.has(sandbox.id)).toBe(false));
			await vi.waitFor(async () => expect(await hostStore.getPlacement(sandbox.id)).toBeUndefined());
			expect((await api.store.sandboxes.get(sandbox.id))?.state).toBe("deleted");
		},
	);

	it.each([
		["with its first host's copy still owed its removal", true],
		["with nothing else owed", false],
	])(
		"deletes the copy its new host makes after a delete asked it first, its answer recorded before the delete's removal, %s",
		async (_, owed) => {
			const { api, b, sandbox, save, a, advance, hostStore, reconnect, service } = await setup({
				onHostLost: "recreate",
			});
			await save("kept");
			if (b === undefined) throw new Error("no host b");
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
			advance(LOST_AFTER_MS + 1_000);
			await api.service.sweep();
			await atCreate;
			let firstHost = a.host;
			if (!owed) {
				// Host a back first: its fenced copy deleted, nothing owed it.
				firstHost = await reconnect(a);
				await vi.waitFor(() => expect(firstHost.sandboxes.has(sandbox.id)).toBe(false));
				await vi.waitFor(async () => expect((await hostStore.getPlacement(sandbox.id))?.cleanup).toBeUndefined());
			}
			// A delete on the hosts service (a gateway's whose create, on another, goes on): it asks host b first, which has
			// nothing yet; its removal of the placement is held.
			const asked = () =>
				b.host.calls.some((call) => call.method === "sandbox.delete" && call.params.sandboxId === sandbox.id);
			let release: () => void = () => undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let reached: () => void = () => undefined;
			const atRemoval = new Promise<void>((resolve) => {
				reached = resolve;
			});
			const update = hostStore.updatePlacement.bind(hostStore);
			let armed = true;
			const updates = vi.spyOn(hostStore, "updatePlacement").mockImplementation(async (sandboxId, change) => {
				if (armed && sandboxId === sandbox.id && asked()) {
					armed = false;
					reached();
					await gate;
				}
				return update(sandboxId, change);
			});
			const deleting = service.sandboxes.delete(sandbox.id);
			await atRemoval;
			expect(b.host.sandboxes.has(sandbox.id)).toBe(false);
			// Host b makes it, and its answer is recorded on the placement the delete read.
			answer();
			await vi.waitFor(() => expect(b.host.sandboxes.has(sandbox.id)).toBe(true));
			await vi.waitFor(async () =>
				expect(await hostStore.getPlacement(sandbox.id)).toMatchObject({ hostId: b.hostId, state: "running" }),
			);
			// The delete's removal goes on: refused, the placement no longer as it read it, it asks host b again.
			release();
			await deleting;
			updates.mockRestore();
			expect(b.host.sandboxes.has(sandbox.id)).toBe(false);
			expect(b.host.calls.filter((call) => call.method === "sandbox.delete")).toHaveLength(2);
			if (owed) {
				// What is left is host a's copy, still owed its removal there: deleted once it is back.
				expect(await hostStore.getPlacement(sandbox.id)).toMatchObject({
					hostId: a.hostId,
					state: "deleting",
					cleanup: { hostId: a.hostId },
				});
				firstHost = await reconnect(a);
				await vi.waitFor(() => expect(firstHost.sandboxes.has(sandbox.id)).toBe(false));
			}
			await vi.waitFor(async () => expect(await hostStore.getPlacement(sandbox.id)).toBeUndefined());
		},
	);

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

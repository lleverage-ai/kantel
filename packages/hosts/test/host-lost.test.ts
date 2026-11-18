// A host that stays disconnected past the deadline is lost (LLE-19621): each sandbox on it moves to `lost`, with one
// `sandbox.lost` event, and takes only a delete; its placements are fenced, so when it connects again it deletes them
// before it is used, and none comes back running. A host back within the deadline loses nothing, and a control plane
// that has only just started loses nothing however long a host was away before it.
import { createKantelClient } from "@kantel/api/sdk";
import { createComputeApi, HOST_LOST_REASON, hostLostAfterSetting, joinTokenSpender } from "@kantel/compute";
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

/** A control plane with one host and one running microVM on it; the clock is the compute plane's own, moved by hand. */
async function setup(options: { readonly lostAfterMs?: number } = {}) {
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
		hostLostAfterMs: options.lostAfterMs ?? LOST_AFTER_MS,
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
	const token = await root.createHostJoinToken({ name: "box" });
	const { hostId } = await service.register({ token: token.token });
	const host = new FakeHost(service, hostId, FEATURES);
	host.connect();
	await vi.waitFor(() => expect(service.hub.connected(hostId)).toBe(true));
	const sandbox = await root.createSandbox({ type: "microvm", wait: true });
	/** Moves the clock on by `ms`, and sweeps until the background work it began is done. */
	const pass = async (ms: number) => {
		offset += ms;
		await api.service.sweep();
		await api.service.idle();
	};
	return { api, backend, root, service, hostStore, hostId, host, sandbox, pass };
}

/** A loss pass's intent on a sandbox's record, as one that stopped after writing it left it (`StoredSandbox.losing`). */
const intent = (hostId: string, eventId = "evt_intended") => ({
	hostId,
	eventId,
	previousState: "running" as const,
	at: Date.now(),
});

/** The host connecting again, as kantel-host does after a disconnect: with what it still has. */
async function reconnect(service: ReturnType<typeof createHostsService>, hostId: string, was: FakeHost) {
	const back = new FakeHost(service, hostId, FEATURES);
	back.connect([...was.sandboxes.values()]);
	await vi.waitFor(() => expect(service.hub.connected(hostId)).toBe(true));
	return back;
}

async function failure(
	call: Promise<unknown>,
): Promise<{ status?: number; code?: string; details?: unknown } | undefined> {
	try {
		await call;
		return undefined;
	} catch (error) {
		const failed = error as { status?: number; code?: string; details?: unknown };
		return { status: failed.status, code: failed.code, details: failed.details };
	}
}

describe("a host away past the deadline", () => {
	it("loses its sandboxes: each moves to lost, with one sandbox.lost event", async () => {
		const { api, root, host, sandbox, pass } = await setup();
		host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		const lost = await root.getSandbox(sandbox.id);
		expect(lost).toMatchObject({ state: "lost", hostReachable: false });
		// Every gateway sweeps: the sandbox moves once, and its event is stored once.
		await pass(LOST_AFTER_MS + 1_000);
		const events = (await api.store.events.list({ accountId: lost.accountId })).filter(
			(event) => event.type === "sandbox.lost",
		);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			sandboxId: sandbox.id,
			data: { state: "lost", previousState: "running", reason: HOST_LOST_REASON },
		});
		// In the event list as any event is.
		const listed = await root.listEvents({ sandboxId: sandbox.id });
		expect(listed.items.map((event) => event.type)).toContain("sandbox.lost");
	});

	it("leaves a lost sandbox only its delete: anything else is a clear conflict", async () => {
		const { root, host, sandbox, pass } = await setup();
		host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		for (const call of [
			root.runCommand(sandbox.id, { command: "true" }),
			root.startSandbox(sandbox.id),
			root.stopSandbox(sandbox.id),
			root.takeSnapshot(sandbox.id),
		]) {
			expect(await failure(call)).toMatchObject({
				status: 409,
				code: "conflict",
				details: { code: "sandbox_lost", state: "lost" },
			});
		}
		// Its delete needs no host: it is done now, and the host deletes it when it is back.
		await root.deleteSandbox(sandbox.id);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("deleted"));
	});

	it("is fenced: back after the deadline, it deletes its lost sandboxes before it is used, and none comes back running", async () => {
		const { api, root, service, hostId, host, sandbox, pass } = await setup();
		host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		expect((await root.getSandbox(sandbox.id)).state).toBe("lost");
		expect((await service.sandboxes.placement(sandbox.id))?.fenced).toBeTypeOf("number");

		// It comes back still running the sandbox, as a host that only lost its network would.
		expect(host.sandboxes.get(sandbox.id)?.state).toBe("running");
		const back = await reconnect(service, hostId, host);
		// Deleted there before anything else was sent it.
		const welcome = back.sent.findIndex((message) => message.type === "welcome");
		const firstCall = back.calls[0];
		expect(welcome).toBeGreaterThanOrEqual(0);
		expect(firstCall).toMatchObject({ method: "sandbox.delete", params: { sandboxId: sandbox.id } });
		expect(back.sandboxes.has(sandbox.id)).toBe(false);
		expect(await service.sandboxes.placement(sandbox.id)).toBeUndefined();
		// Kantel never shows it running again, whatever the host's hello said.
		await api.service.idle();
		expect((await root.getSandbox(sandbox.id)).state).toBe("lost");
		// Its delete is done at once.
		await root.deleteSandbox(sandbox.id);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("deleted"));
	});

	it("deletes on its return a lost sandbox that was deleted while it was away", async () => {
		const { root, service, hostId, host, sandbox, pass } = await setup();
		host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		await root.deleteSandbox(sandbox.id);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("deleted"));
		// Its placement stays fenced until the host has deleted it.
		expect((await service.sandboxes.placement(sandbox.id))?.fenced).toBeTypeOf("number");
		const back = await reconnect(service, hostId, host);
		expect(back.sandboxes.has(sandbox.id)).toBe(false);
		expect(await service.sandboxes.placement(sandbox.id)).toBeUndefined();
	});

	it("isn't connected until its fence is done: welcomed, it takes the fence's deletes and nothing else", async () => {
		const { root, service, hostId, host, sandbox, pass } = await setup();
		host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		const back = new FakeHost(service, hostId, FEATURES);
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		back.hold = (method) => (method === "sandbox.delete" ? held : undefined);
		back.connect([...host.sandboxes.values()]);
		await vi.waitFor(() => expect(back.welcomed()).toBe(true));
		// Welcomed, so it takes calls, but not connected: nothing else reaches it, and its sandboxes aren't reachable.
		expect(service.hub.connected(hostId)).toBe(false);
		expect((await root.getSandbox(sandbox.id)).hostReachable).toBe(false);
		release();
		await vi.waitFor(() => expect(service.hub.connected(hostId)).toBe(true));
		expect(back.sandboxes.has(sandbox.id)).toBe(false);
	});
});

describe("what a loss covers", () => {
	it("loses a create admitted on the host whose answer never came, though its record names no host yet", async () => {
		const { api, root, service, hostId, host, pass } = await setup();
		// The host takes the create and never answers it: its record stays starting, with no host.
		host.hold = (method) => (method === "sandbox.create" ? new Promise<void>(() => undefined) : undefined);
		const made = await root.createSandbox({ type: "microvm" });
		await vi.waitFor(async () => expect((await service.sandboxes.placement(made.id))?.hostId).toBe(hostId));
		expect((await api.store.sandboxes.get(made.id))?.hostId).toBeUndefined();
		host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		expect(await root.getSandbox(made.id)).toMatchObject({ state: "lost", hostId });
		expect((await service.sandboxes.placement(made.id))?.fenced).toBeTypeOf("number");
		// Back, it deletes it, and the create never publishes it running.
		const back = await reconnect(service, hostId, host);
		expect(back.calls.some((call) => call.method === "sandbox.delete" && call.params.sandboxId === made.id)).toBe(true);
		await pass(60_000);
		expect((await root.getSandbox(made.id)).state).toBe("lost");
	});

	it("keeps the loss owed until every command is ended, retrying one that failed part-way", async () => {
		const { api, hostId, host, sandbox, pass, service } = await setup();
		const command = (id: string, state: "running" | "finished") => ({
			id,
			sandboxId: sandbox.id,
			accountId: sandbox.accountId,
			command: "sleep 1000",
			cwd: "/root",
			state,
			stdout: "",
			stderr: "",
			truncated: false,
			startedAt: Date.now(),
			detached: true,
			...(state === "finished" ? { exitCode: 0, endedAt: Date.now(), durationMs: 1 } : {}),
		});
		for (const id of ["cmd_a", "cmd_b", "cmd_c"]) await api.store.commands.put(command(id, "running") as never);
		await api.store.commands.put(command("cmd_done", "finished") as never);
		// The commands store fails once, on the second command ended.
		const update = api.store.commands.update.bind(api.store.commands);
		let calls = 0;
		const spy = vi.spyOn(api.store.commands, "update").mockImplementation(async (...args) => {
			calls += 1;
			if (calls === 2) throw new Error("store unavailable");
			return update(...args);
		});
		host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		expect((await api.store.sandboxes.get(sandbox.id))?.state).toBe("lost");
		expect((await api.store.sandboxes.get(sandbox.id))?.lostEvent).toBeDefined();
		await pass(LOST_AFTER_MS + 1_000);
		spy.mockRestore();
		const states = async () =>
			Object.fromEntries(
				(await api.store.commands.list({ sandboxId: sandbox.id })).map((each) => [each.id, each.state]),
			);
		expect(await states()).toEqual({ cmd_a: "killed", cmd_b: "killed", cmd_c: "killed", cmd_done: "finished" });
		expect((await api.store.sandboxes.get(sandbox.id))?.lostEvent).toBeUndefined();
		const events = (await api.store.events.list({ accountId: sandbox.accountId })).filter(
			(event) => event.type === "sandbox.lost",
		);
		expect(events).toHaveLength(1);
		expect(service.hub.connected(hostId)).toBe(false);
	});

	it("forgets the automatic snapshots its host deletes with it, and keeps the rest", async () => {
		const { api, hostId, host, sandbox, pass } = await setup();
		const snapshot = (id: string, kind: "automatic" | "saved", ref: string) => ({
			id,
			accountId: sandbox.accountId,
			kind,
			sandboxId: sandbox.id,
			sandboxType: "microvm",
			state: "ready",
			trigger: "stop",
			memory: false,
			sizeBytes: 1,
			createdAt: Date.now(),
			ref,
		});
		await api.store.snapshots.put(snapshot("snap_here", "automatic", `${hostId}/snap_here`) as never);
		await api.store.snapshots.put(snapshot("snap_elsewhere", "automatic", "hst_other/snap_elsewhere") as never);
		await api.store.snapshots.put(snapshot("snap_saved", "saved", `${hostId}/snap_saved`) as never);
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			latestSnapshotId: "snap_here",
			latestSnapshotAt: Date.now(),
		}));
		host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		const lost = await api.store.sandboxes.get(sandbox.id);
		expect(lost).toMatchObject({ state: "lost" });
		expect(lost?.latestSnapshotId).toBeUndefined();
		expect(lost?.lostEvent).toBeUndefined();
		expect(await api.store.snapshots.get("snap_here")).toBeUndefined();
		expect(await api.store.snapshots.get("snap_elsewhere")).toMatchObject({ state: "ready" });
		expect(await api.store.snapshots.get("snap_saved")).toMatchObject({ state: "ready" });
	});

	it("clears a pointer a retry finds to a snapshot an interrupted try already forgot", async () => {
		const { api, service, hostId, host, sandbox, pass } = await setup();
		host.connection.closed(1006, "gone");
		await service.sandboxes.fence(hostId, [sandbox.id]);
		// What an interrupted try left: the snapshot's record gone, the pointer to it not yet cleared.
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			state: "lost",
			reason: HOST_LOST_REASON,
			lostEvent: { eventId: "evt_interrupted", previousState: "running" },
			latestSnapshotId: "snap_forgotten",
			latestSnapshotAt: Date.now(),
			pausedSnapshotId: "snap_forgotten",
		}));
		await pass(LOST_AFTER_MS + 1_000);
		const finished = await api.store.sandboxes.get(sandbox.id);
		expect(finished?.lostEvent).toBeUndefined();
		expect(finished?.latestSnapshotId).toBeUndefined();
		expect(finished?.pausedSnapshotId).toBeUndefined();
	});

	it("clears a pointer moved meanwhile to another snapshot it forgets", async () => {
		const { api, hostId, host, sandbox, pass } = await setup();
		for (const id of ["snap_a", "snap_b"]) {
			await api.store.snapshots.put({
				id,
				accountId: sandbox.accountId,
				kind: "automatic",
				sandboxId: sandbox.id,
				sandboxType: "microvm",
				state: "ready",
				trigger: "stop",
				memory: false,
				sizeBytes: 1,
				createdAt: Date.now(),
				ref: `${hostId}/${id}`,
			} as never);
		}
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			latestSnapshotId: "snap_a",
			latestSnapshotAt: Date.now(),
		}));
		// As the first is forgotten, another gateway points the record at the second (as a snapshot's delete adopts an
		// older one), after the pointers were first cleared.
		const remove = api.store.snapshots.delete.bind(api.store.snapshots);
		const spy = vi.spyOn(api.store.snapshots, "delete").mockImplementation(async (id) => {
			if (id === "snap_a") {
				await api.store.sandboxes.update(sandbox.id, (current) => ({
					...current,
					latestSnapshotId: "snap_b",
					latestSnapshotAt: Date.now(),
				}));
			}
			return remove(id);
		});
		host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		spy.mockRestore();
		const finished = await api.store.sandboxes.get(sandbox.id);
		expect(finished).toMatchObject({ state: "lost" });
		expect(finished?.lostEvent).toBeUndefined();
		expect(finished?.latestSnapshotId).toBeUndefined();
		expect(await api.store.snapshots.get("snap_b")).toBeUndefined();
	});

	it("never leaves a pointer to a forgotten snapshot when forgetting it is interrupted", async () => {
		const { api, hostId, host, sandbox, pass } = await setup();
		await api.store.snapshots.put({
			id: "snap_here",
			accountId: sandbox.accountId,
			kind: "automatic",
			sandboxId: sandbox.id,
			sandboxType: "microvm",
			state: "ready",
			trigger: "pause",
			memory: true,
			sizeBytes: 1,
			createdAt: Date.now(),
			ref: `${hostId}/snap_here`,
		} as never);
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			latestSnapshotId: "snap_here",
			latestSnapshotAt: Date.now(),
			pausedSnapshotId: "snap_here",
		}));
		// The snapshots store fails once, as the record is deleted.
		const spy = vi.spyOn(api.store.snapshots, "delete").mockRejectedValueOnce(new Error("store unavailable"));
		host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		const interrupted = await api.store.sandboxes.get(sandbox.id);
		expect(interrupted).toMatchObject({ state: "lost" });
		expect(interrupted?.lostEvent).toBeDefined();
		expect(interrupted?.latestSnapshotId).toBeUndefined();
		expect(interrupted?.pausedSnapshotId).toBeUndefined();
		await pass(LOST_AFTER_MS + 1_000);
		spy.mockRestore();
		expect(await api.store.snapshots.get("snap_here")).toBeUndefined();
		const finished = await api.store.sandboxes.get(sandbox.id);
		expect(finished?.lostEvent).toBeUndefined();
		expect(finished?.latestSnapshotId).toBeUndefined();
	});

	it("leaves a sandbox upgrading on a lost host to its upgrade's settling, then loses it", async () => {
		const { api, service, hostStore, hostId, host, sandbox, pass } = await setup();
		const upgrading = {
			operationId: "op_upgrade",
			at: Date.now(),
			heartbeatAt: Date.now() + 3_600_000,
			from: "running" as const,
			before: { runs: [] },
		};
		await api.store.sandboxes.update(sandbox.id, (current) => ({ ...current, upgrading }));
		await hostStore.updatePlacement(sandbox.id, (latest) => ({
			...latest,
			upgrade: { operationId: "op_upgrade", target: "hst_target", phase: "host" as const },
		}));
		host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		expect((await api.store.sandboxes.get(sandbox.id))?.state).not.toBe("lost");
		expect((await service.sandboxes.placement(sandbox.id))?.fenced).toBeUndefined();
		// Fencing the host directly leaves the upgrade's placement too.
		expect(await service.sandboxes.fence(hostId, [sandbox.id])).toEqual([]);
		// Once settled, the next pass loses it.
		await api.store.sandboxes.update(sandbox.id, (current) => {
			const { upgrading: _, ...rest } = current;
			return rest;
		});
		await hostStore.updatePlacement(sandbox.id, (latest) => {
			const { upgrade: _, ...rest } = latest;
			return rest;
		});
		await pass(LOST_AFTER_MS + 1_000);
		expect((await api.store.sandboxes.get(sandbox.id))?.state).toBe("lost");
	});

	it("settles a loss a pass began before a delete: lost, with its event, then deleted", async () => {
		const { api, root, service, hostId, host, sandbox } = await setup();
		host.connection.closed(1006, "gone");
		// A pass wrote its intent and stopped (or is still going) before fencing; the sandbox is deleted meanwhile.
		await api.store.sandboxes.update(sandbox.id, (current) => ({ ...current, losing: intent(hostId) }));
		expect((await service.sandboxes.placement(sandbox.id))?.fenced).toBeUndefined();
		await root.deleteSandbox(sandbox.id);
		// The delete settled it as the pass would have: fenced, then lost under the pass's intent.
		expect((await service.sandboxes.placement(sandbox.id))?.fenced).toBeTypeOf("number");
		expect(
			(await api.store.events.list({ accountId: sandbox.accountId })).find((event) => event.type === "sandbox.lost"),
		).toMatchObject({ id: "evt_intended" });
		const events = (await api.store.events.list({ accountId: sandbox.accountId })).filter(
			(event) => event.sandboxId === sandbox.id,
		);
		const types = events.map((event) => event.type);
		expect(types.filter((type) => type === "sandbox.lost")).toHaveLength(1);
		expect(types.indexOf("sandbox.lost")).toBeLessThan(types.indexOf("sandbox.deleted"));
		expect((await root.getSandbox(sandbox.id)).state).toBe("deleted");
		// Its host's return consumes the fence, deleting it there, and adds nothing.
		const back = await reconnect(service, hostId, host);
		await vi.waitFor(() => expect(back.sandboxes.has(sandbox.id)).toBe(false));
		const after = (await api.store.events.list({ accountId: sandbox.accountId })).filter(
			(event) => event.sandboxId === sandbox.id && event.type === "sandbox.lost",
		);
		expect(after).toHaveLength(1);
	});

	it("never goes deleting over a loss a pass began after the delete read the sandbox", async () => {
		const { api, root, hostId, host, sandbox } = await setup();
		host.connection.closed(1006, "gone");
		// As the delete writes `deleting`, another gateway's pass has just written its intent.
		const update = api.store.sandboxes.update.bind(api.store.sandboxes);
		let raced = false;
		const spy = vi.spyOn(api.store.sandboxes, "update").mockImplementation(async (id, change, expected) => {
			const current = id === sandbox.id && !raced ? await api.store.sandboxes.get(id) : undefined;
			if (current !== undefined && change(current)?.state === "deleting") {
				raced = true;
				await update(id, (latest) => ({ ...latest, losing: intent(hostId) }));
			}
			return update(id, change, expected);
		});
		await root.deleteSandbox(sandbox.id);
		spy.mockRestore();
		expect(raced).toBe(true);
		const types = (await api.store.events.list({ accountId: sandbox.accountId }))
			.filter((event) => event.sandboxId === sandbox.id)
			.map((event) => event.type);
		expect(types.filter((type) => type === "sandbox.lost")).toHaveLength(1);
		expect(types.indexOf("sandbox.lost")).toBeLessThan(types.indexOf("sandbox.deleted"));
		expect((await root.getSandbox(sandbox.id)).state).toBe("deleted");
	});

	it("never loses a sandbox a delete took first: a pass begins no loss of one being deleted", async () => {
		const { api, backend, service, host, sandbox, pass } = await setup();
		host.connection.closed(1006, "gone");
		// A delete (on another gateway) goes `deleting` after the pass read the sandbox, before it writes its intent.
		const placed = backend.hostSandboxes?.bind(backend);
		const spy = vi.spyOn(backend, "hostSandboxes").mockImplementation(async (hostId) => {
			await api.store.sandboxes.update(sandbox.id, (current) => ({ ...current, state: "deleting" }));
			return (await placed?.(hostId)) ?? [];
		});
		await pass(LOST_AFTER_MS + 1_000);
		expect(spy).toHaveBeenCalled();
		spy.mockRestore();
		const after = await api.store.sandboxes.get(sandbox.id);
		expect(after?.state).toBe("deleting");
		expect(after?.losing).toBeUndefined();
		expect((await service.sandboxes.placement(sandbox.id))?.fenced).toBeUndefined();
		const events = (await api.store.events.list({ accountId: sandbox.accountId })).filter(
			(event) => event.type === "sandbox.lost",
		);
		expect(events).toHaveLength(0);
	});

	it("drops its intent and loses nothing when the fence is refused, its host back", async () => {
		const { api, backend, root, service, host, sandbox, pass } = await setup();
		host.connection.closed(1006, "gone");
		const spy = vi.spyOn(backend, "fenceHost").mockRejectedValue(new KantelError("conflict", "The host is connected"));
		await pass(LOST_AFTER_MS + 1_000);
		spy.mockRestore();
		const after = await api.store.sandboxes.get(sandbox.id);
		expect(after?.state).toBe("running");
		expect(after?.losing).toBeUndefined();
		expect((await service.sandboxes.placement(sandbox.id))?.fenced).toBeUndefined();
		expect((await root.listEvents({ sandboxId: sandbox.id })).items.map((event) => event.type)).not.toContain(
			"sandbox.lost",
		);
	});

	it("keeps its intent through a fence that fails, and a later pass loses it under that intent", async () => {
		const { api, backend, service, host, sandbox, pass } = await setup();
		host.connection.closed(1006, "gone");
		const spy = vi.spyOn(backend, "fenceHost").mockRejectedValue(new Error("store unavailable"));
		await pass(LOST_AFTER_MS + 1_000);
		spy.mockRestore();
		const intended = await api.store.sandboxes.get(sandbox.id);
		expect(intended?.state).toBe("running");
		const eventId = intended?.losing?.eventId;
		expect(eventId).toBeTypeOf("string");
		expect((await service.sandboxes.placement(sandbox.id))?.fenced).toBeUndefined();
		await pass(LOST_AFTER_MS + 1_000);
		const lost = await api.store.sandboxes.get(sandbox.id);
		expect(lost).toMatchObject({ state: "lost" });
		expect(lost?.losing).toBeUndefined();
		const events = (await api.store.events.list({ accountId: sandbox.accountId })).filter(
			(event) => event.type === "sandbox.lost",
		);
		expect(events).toMatchObject([{ id: eventId }]);
	});

	it("settles an intent a stopped pass left, though its host was revoked meanwhile", async () => {
		const { api, service, hostId, host, sandbox, pass } = await setup();
		host.connection.closed(1006, "gone");
		await api.store.sandboxes.update(sandbox.id, (current) => ({ ...current, losing: intent(hostId) }));
		await service.revoke(hostId);
		await pass(LOST_AFTER_MS + 1_000);
		const lost = await api.store.sandboxes.get(sandbox.id);
		expect(lost).toMatchObject({ state: "lost" });
		expect(lost?.losing).toBeUndefined();
		expect(lost?.lostEvent).toBeUndefined();
		const events = (await api.store.events.list({ accountId: sandbox.accountId })).filter(
			(event) => event.type === "sandbox.lost",
		);
		expect(events).toMatchObject([{ id: "evt_intended" }]);
	});

	it("finishes an interrupted loss before a delete, so the delete never drops its event", async () => {
		const { api, root, service, hostId, host, sandbox } = await setup();
		host.connection.closed(1006, "gone");
		await service.sandboxes.fence(hostId, [sandbox.id]);
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			state: "lost",
			reason: HOST_LOST_REASON,
			lostEvent: { eventId: "evt_interrupted", previousState: "running" },
		}));
		await root.deleteSandbox(sandbox.id);
		const types = (await api.store.events.list({ accountId: sandbox.accountId }))
			.filter((event) => event.sandboxId === sandbox.id)
			.map((event) => event.type);
		expect(types.filter((type) => type === "sandbox.lost")).toHaveLength(1);
		expect(types).toContain("sandbox.deleted");
		expect((await root.getSandbox(sandbox.id)).state).toBe("deleted");
	});

	it("keeps a fenced create out of the create's own settling: only the loss settles it", async () => {
		const { root, service, hostId, host, pass } = await setup({ lostAfterMs: 3_600_000 });
		host.hold = (method) => (method === "sandbox.create" ? new Promise<void>(() => undefined) : undefined);
		const made = await root.createSandbox({ type: "microvm" });
		await vi.waitFor(async () => expect((await service.sandboxes.placement(made.id))?.hostId).toBe(hostId));
		host.connection.closed(1006, "gone");
		// Fenced, and its record not moved yet (its pass stopped): the sweep's settling of lost creates leaves it be.
		await service.sandboxes.fence(hostId, [made.id]);
		for (let round = 0; round < 5; round += 1) await pass(120_000);
		expect((await root.getSandbox(made.id)).state).toBe("starting");
	});

	it("never loses a later attempt of a create with the host an earlier attempt was placed on", async () => {
		const { api, root, service, hostId, host, pass } = await setup();
		host.hold = (method) => (method === "sandbox.create" ? new Promise<void>(() => undefined) : undefined);
		const made = await root.createSandbox({ type: "microvm" });
		await vi.waitFor(async () => expect((await service.sandboxes.placement(made.id))?.hostId).toBe(hostId));
		// A retry has begun a new attempt, not placed yet: the placement still there is the earlier attempt's.
		await api.store.sandboxes.update(made.id, (current) => ({ ...current, lifecycle: (current.lifecycle ?? 0) + 1 }));
		host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS + 1_000);
		expect((await root.getSandbox(made.id)).state).toBe("starting");
		const events = (await api.store.events.list({ accountId: made.accountId })).filter(
			(event) => event.type === "sandbox.lost" && event.sandboxId === made.id,
		);
		expect(events).toHaveLength(0);
		// Its placement, the earlier attempt's, isn't fenced on the new attempt's account.
		expect((await service.sandboxes.placement(made.id))?.fenced).toBeUndefined();
	});

	it("stores the event once when a gateway stopped between the move to lost and its event", async () => {
		const { api, root, service, hostId, host, sandbox, pass } = await setup();
		host.connection.closed(1006, "gone");
		// What a pass left: the fence, and the record lost with its event's ID, the event itself never stored.
		await service.sandboxes.fence(hostId, [sandbox.id]);
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			state: "lost",
			reason: HOST_LOST_REASON,
			lostEvent: { eventId: "evt_interrupted", previousState: "running" },
		}));
		const lostEvents = async () =>
			(await api.store.events.list({ accountId: sandbox.accountId })).filter((event) => event.type === "sandbox.lost");
		expect(await lostEvents()).toHaveLength(0);
		await pass(LOST_AFTER_MS + 1_000);
		await pass(LOST_AFTER_MS + 1_000);
		expect(await lostEvents()).toMatchObject([{ id: "evt_interrupted", data: { previousState: "running" } }]);
		expect((await api.store.sandboxes.get(sandbox.id))?.lostEvent).toBeUndefined();
		await reconnect(service, hostId, host);
		expect(await lostEvents()).toHaveLength(1);
		expect((await root.getSandbox(sandbox.id)).state).toBe("lost");
	});

	it("stores the event as the host comes back when the gateway stopped before it, with the host away", async () => {
		const { api, service, hostId, host, sandbox } = await setup();
		host.connection.closed(1006, "gone");
		await service.sandboxes.fence(hostId, [sandbox.id]);
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			state: "lost",
			reason: HOST_LOST_REASON,
			lostEvent: { eventId: "evt_interrupted", previousState: "running" },
		}));
		await reconnect(service, hostId, host);
		const events = (await api.store.events.list({ accountId: sandbox.accountId })).filter(
			(event) => event.type === "sandbox.lost",
		);
		expect(events).toMatchObject([{ id: "evt_interrupted" }]);
	});

	it("records the loss as the host comes back when the pass that fenced it stopped first", async () => {
		const { api, root, service, hostId, host, sandbox } = await setup();
		host.connection.closed(1006, "gone");
		// A pass wrote the fence and its gateway stopped before the sandbox's record moved.
		await service.sandboxes.fence(hostId, [sandbox.id]);
		expect((await root.getSandbox(sandbox.id)).state).toBe("running");
		const back = await reconnect(service, hostId, host);
		expect(back.sandboxes.has(sandbox.id)).toBe(false);
		expect((await root.getSandbox(sandbox.id)).state).toBe("lost");
		const account = (await root.getSandbox(sandbox.id)).accountId;
		const events = (await api.store.events.list({ accountId: account })).filter(
			(event) => event.type === "sandbox.lost",
		);
		expect(events).toHaveLength(1);
	});

	it("keeps a fenced sandbox whose loss an upgrade defers, and deletes it once that is settled", async () => {
		const { api, service, hostId, host, sandbox } = await setup();
		host.connection.closed(1006, "gone");
		// A pass fenced it; another gateway had begun an upgrade of it meanwhile (compute's marker only).
		await service.sandboxes.fence(hostId, [sandbox.id]);
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			upgrading: {
				operationId: "op_upgrade",
				at: Date.now(),
				heartbeatAt: Date.now() + 3_600_000,
				from: "running" as const,
				before: { runs: [] },
			},
		}));
		const back = await reconnect(service, hostId, host);
		// Connected, and the sandbox kept, fenced: not deleted on a loss not recorded.
		expect(back.sandboxes.has(sandbox.id)).toBe(true);
		expect((await service.sandboxes.placement(sandbox.id))?.fenced).toBeTypeOf("number");
		expect((await api.store.sandboxes.get(sandbox.id))?.state).toBe("running");
		const lostEvents = async () =>
			(await api.store.events.list({ accountId: sandbox.accountId })).filter((event) => event.type === "sandbox.lost");
		expect(await lostEvents()).toHaveLength(0);
		// The upgrade settled (rolled back): the next heartbeat loses it, then deletes it.
		await api.store.sandboxes.update(sandbox.id, (current) => {
			const { upgrading: _, ...rest } = current;
			return rest;
		});
		back.send({
			type: "heartbeat",
			heartbeat: { capacity: { freeMemoryMiB: 20_000, freeDiskGiB: 400, running: 1, stopped: 0, load1: 0 } },
		});
		await vi.waitFor(() => expect(back.sandboxes.has(sandbox.id)).toBe(false));
		await vi.waitFor(async () => expect(await service.sandboxes.placement(sandbox.id)).toBeUndefined());
		expect((await api.store.sandboxes.get(sandbox.id))?.state).toBe("lost");
		expect(await lostEvents()).toHaveLength(1);
	});

	it("finishes a committed loss in the background after its host is revoked", async () => {
		const { api, service, hostId, host, sandbox, pass } = await setup();
		await api.store.commands.put({
			id: "cmd_left",
			sandboxId: sandbox.id,
			accountId: sandbox.accountId,
			command: "sleep 1000",
			cwd: "/root",
			state: "running",
			stdout: "",
			stderr: "",
			truncated: false,
			startedAt: Date.now(),
			detached: true,
		} as never);
		host.connection.closed(1006, "gone");
		await service.sandboxes.fence(hostId, [sandbox.id]);
		// A pass committed the loss and stopped before finishing it; then the host was revoked.
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			state: "lost",
			reason: HOST_LOST_REASON,
			lostEvent: { eventId: "evt_interrupted", previousState: "running" },
		}));
		await service.revoke(hostId);
		await pass(LOST_AFTER_MS + 1_000);
		const events = (await api.store.events.list({ accountId: sandbox.accountId })).filter(
			(event) => event.type === "sandbox.lost",
		);
		expect(events).toMatchObject([{ id: "evt_interrupted" }]);
		expect((await api.store.sandboxes.get(sandbox.id))?.lostEvent).toBeUndefined();
		expect((await api.store.commands.get("cmd_left"))?.state).toBe("killed");
	});

	it("keeps what a fenced sandbox still owes another host when the lost host deletes it", async () => {
		const { service, hostStore, hostId, host, sandbox } = await setup();
		const owed = { hostId: "host_previous", operationId: "op_move", tier: "microvm" as const };
		await hostStore.updatePlacement(sandbox.id, (latest) => ({ ...latest, cleanup: owed }));
		host.connection.closed(1006, "gone");
		await service.sandboxes.fence(hostId, [sandbox.id]);
		await reconnect(service, hostId, host);
		const left = await service.sandboxes.placement(sandbox.id);
		expect(left).toMatchObject({ hostId: "host_previous", tier: "microvm", cleanup: owed });
		expect(left?.fenced).toBeUndefined();
	});
});

describe("a fence written while its host connected elsewhere", () => {
	it("is carried out on the host's next heartbeat: the replica holding it finds it in the store", async () => {
		const { hostStore, service, host, sandbox, pass } = await setup();
		const heartbeat = () =>
			host.send({
				type: "heartbeat",
				heartbeat: { capacity: { freeMemoryMiB: 20_000, freeDiskGiB: 400, running: 1, stopped: 0, load1: 0 } },
			});
		// Its first heartbeat looks, and finds nothing to do.
		heartbeat();
		await vi.waitFor(() => expect(host.calls.some((call) => call.method === "sandbox.delete")).toBe(false));
		// Another replica, which hadn't yet seen the host connect here, fences its sandbox in the shared store.
		await hostStore.updatePlacement(sandbox.id, (latest) => ({ ...latest, state: "lost", fenced: Date.now() }));
		// Looked at again a minute on, on a heartbeat: deleted on the host, and its placement gone.
		await pass(61_000);
		heartbeat();
		await vi.waitFor(() => expect(host.sandboxes.has(sandbox.id)).toBe(false));
		await vi.waitFor(async () => expect(await service.sandboxes.placement(sandbox.id)).toBeUndefined());
	});
});

describe("a host back within the deadline", () => {
	it("loses nothing", async () => {
		const { root, service, hostId, host, sandbox, pass } = await setup();
		await pass(LOST_AFTER_MS + 1_000);
		host.connection.closed(1006, "gone");
		await pass(LOST_AFTER_MS / 4);
		const back = await reconnect(service, hostId, host);
		await pass(LOST_AFTER_MS + 1_000);
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "running", hostReachable: true });
		expect(back.calls.some((call) => call.method === "sandbox.delete")).toBe(false);
		expect((await service.sandboxes.placement(sandbox.id))?.fenced).toBeUndefined();
	});
});

describe("a control plane that has just started", () => {
	it("loses nothing until the deadline has passed since it started, however long a host was away before", async () => {
		const { root, hostStore, hostId, host, sandbox, pass } = await setup({ lostAfterMs: 60_000 });
		host.connection.closed(1006, "gone");
		// The host was last seen long ago, as when the whole control plane was down for a while.
		await vi.waitFor(async () => expect((await hostStore.getHost(hostId))?.lastSeenAt).toBeTypeOf("number"));
		await hostStore.updateHost(hostId, (record) => ({ ...record, lastSeenAt: Date.now() - 3_600_000 }));
		await pass(30_000);
		expect((await root.getSandbox(sandbox.id)).state).toBe("running");
		// Still away once the deadline has passed since this control plane started: lost then.
		await pass(31_000);
		expect((await root.getSandbox(sandbox.id)).state).toBe("lost");
	});
});

describe("KANTEL_HOST_LOST_AFTER_MINUTES", () => {
	it("is 5 minutes unset, takes minutes of at least 1, and refuses anything else", () => {
		expect(hostLostAfterSetting(undefined)).toBe(300_000);
		expect(hostLostAfterSetting("")).toBe(300_000);
		expect(hostLostAfterSetting("10")).toBe(600_000);
		expect(hostLostAfterSetting("1.5")).toBe(90_000);
		for (const bad of ["0", "0.5", "-5", "5m", "five"]) {
			expect(() => hostLostAfterSetting(bad)).toThrow("KANTEL_HOST_LOST_AFTER_MINUTES");
		}
	});
});

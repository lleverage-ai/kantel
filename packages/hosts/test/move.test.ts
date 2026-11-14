// Moving a stopped microVM to another host in its pool (docs/design/disk-store.md, "Moving a sandbox to another
// host"), end to end through the compute API, the hosts service and its hub with fake kantel-hosts: its source exports
// it, its target imports it from the source (with a grant, its `disk.locate` answered while the move is under way) and
// starts it, and only then does its placement switch and its source's copy go. A failure before the switch rolls it
// back: the target's copy cancelled, the source's export deleted, the sandbox stopped where it was.
// apps/host/test/move.sh moves one between real hosts.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { type ComputeApi, createComputeApi, joinTokenSpender, type PersonIdentity } from "@kantel/compute";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBackend } from "../src/backend.ts";
import { HOST_FEATURES, type HostMeshFacts } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";
import { FakeHost } from "./fake-host.ts";

const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	root: { userId: "usr_root", name: "Root", superAdmin: true },
};

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

const meshOf = (byte: number): HostMeshFacts => ({
	publicKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(byte))),
	listenPort: 51820,
	endpoints: [`[2001:db8::${byte}]:51820`],
});

const MOVES = [HOST_FEATURES.mesh, HOST_FEATURES.sandboxMove, HOST_FEATURES.egressPolicy];

async function setup(options: { readonly now?: () => number } = {}) {
	const store = createMemoryHostStore();
	const service = createHostsService({
		store,
		publicUrl: "https://kantel.test",
		log: () => undefined,
		...(options.now === undefined ? {} : { clock: { now: options.now } }),
	});
	const api: ComputeApi = createComputeApi({
		backend: createHostBackend({
			hosts: service,
			publicUrl: "https://kantel.test",
			tickets: createTunnelTickets(createMemoryRelayStore()),
		}),
		authenticatePerson: async (request) =>
			PEOPLE[request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""],
		fetch: async () => new Response(null, { status: 204 }),
		publicUrl: "https://kantel.test",
		stickyDisks: true,
		secretsKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
		...(options.now === undefined ? {} : { now: options.now }),
	});
	service.useJoinTokens(joinTokenSpender(api.store));
	service.useCompute({
		secrets: async () => undefined,
		recordEgress: async () => undefined,
		poolSync: (poolId) => api.service.poolSync(poolId),
		grantKeys: () => api.service.grantKeys(),
		locateDisk: (hostId, params) => api.service.locateDisk(hostId, params),
		grantFetch: (grant) => api.service.grantFetch(grant),
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
	const pool = await root.createPool({ name: "agents", sync: true });
	let byte = 1;
	/** Joins a host to the pool (or `into`), running the mesh, with `features`. */
	const join = async (features: readonly string[] = MOVES, into: string = pool.name) => {
		const token = await root.createHostJoinToken({ pool: into });
		const { hostId } = await service.register({ token: token.token });
		const host = new FakeHost(service, hostId, features);
		host.moreFacts = { mesh: meshOf(byte++) };
		host.connect();
		await vi.waitFor(() => expect(host.welcomed()).toBe(true));
		return host;
	};
	return { service, store, api, root, join, pool };
}

/** A stopped microVM on `on`, with what is on its disk there. */
async function stoppedOn(
	root: ReturnType<typeof createKantelClient>,
	on: FakeHost,
	disk: string,
): Promise<{ readonly id: string }> {
	const made = await root.createSandbox({ type: "microvm", host: on.hostId, wait: true });
	on.disks.set(made.id, disk);
	await root.stopSandbox(made.id, { wait: true });
	return made;
}

async function failure(call: Promise<unknown>): Promise<KantelApiError> {
	try {
		await call;
	} catch (error) {
		if (error instanceof KantelApiError) return error;
		throw error;
	}
	throw new Error("Expected the call to fail");
}

/** A sandbox made with `host` is kept to it: for these, made on the source and let go of the pin as a test sets up. */
async function unpinned(api: ComputeApi, sandboxId: string) {
	await api.store.sandboxes.update(sandboxId, (latest) => ({ ...latest, hostPin: undefined }));
}

/** The lifecycle and move calls a host was sent for a sandbox, in order (not its egress, env or secrets). */
const LIFECYCLE = new Set([
	"sandbox.create",
	"sandbox.stop",
	"sandbox.start",
	"sandbox.delete",
	"sandbox.export",
	"sandbox.export.delete",
	"sandbox.import",
	"sandbox.import.cancel",
]);
const methodsOf = (host: FakeHost, sandboxId: string) =>
	host.calls
		.filter((call) => call.params.sandboxId === sandboxId && LIFECYCLE.has(call.method))
		.map((call) => call.method);

describe("moving a stopped sandbox to another host", () => {
	it("copies it to the target, starts it there, switches its placement and deletes the source's copy", async () => {
		const { root, api, service, join } = await setup();
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "files and sticky drives");
		await unpinned(api, sandbox.id);
		const moved = await root.moveSandbox(sandbox.id, {});
		expect(moved).toMatchObject({ id: sandbox.id, state: "running", hostId: b.hostId });
		expect(moved.move).toBeUndefined();
		expect(b.disks.get(sandbox.id)).toBe("files and sticky drives");
		expect(a.sandboxes.has(sandbox.id)).toBe(false);
		expect(a.exports.size).toBe(0);
		expect(methodsOf(a, sandbox.id).slice(-2)).toEqual(["sandbox.export", "sandbox.delete"]);
		// Its source's copy goes with its snapshots kept: they stay there, its history.
		expect(a.calls.find((call) => call.method === "sandbox.delete")?.params).toMatchObject({ keepSnapshots: true });
		expect(methodsOf(b, sandbox.id)).toEqual(["sandbox.import", "sandbox.start"]);
		// The import named its source as the holder, at its mesh address, with a grant for this host from it.
		const imported = b.calls.find((call) => call.method === "sandbox.import")?.params as {
			version: string;
			holders: { hostId: string; address: string }[];
			grant: string;
		};
		expect(imported.version).toMatch(/^mov_/);
		expect(imported.holders).toEqual([{ hostId: a.hostId, address: expect.stringMatching(/^fd/) }]);
		const payload = JSON.parse(atob(imported.grant.split(".")[0]?.replaceAll("-", "+").replaceAll("_", "/") ?? ""));
		expect(payload).toMatchObject({ kind: "sandbox", objectId: sandbox.id, from: [a.hostId], to: b.hostId });
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ hostId: b.hostId, tier: "microvm", state: "running" });
		expect(placement?.move).toBeUndefined();
		expect(placement?.cleanup).toBeUndefined();
		// Its URLs are the same: they go through the gateway, which follows its placement.
		expect((await root.getSandbox(sandbox.id)).subdomain).toBe(moved.subdomain);
	});

	it("answers its target's disk.locate while it moves, and no other host's", async () => {
		const { root, api, service, join } = await setup();
		const a = await join();
		const b = await join();
		const c = await join([HOST_FEATURES.mesh, HOST_FEATURES.egressPolicy]);
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		b.hold = (method) => (method === "sandbox.import" ? held : undefined);
		const moving = root.moveSandbox(sandbox.id, { hostId: b.hostId });
		await vi.waitFor(() => expect(b.calls.some((call) => call.method === "sandbox.import")).toBe(true));
		const version = String(b.calls.find((call) => call.method === "sandbox.import")?.params.version);
		const located = await api.service.grantFetch({
			kind: "sandbox",
			objectId: sandbox.id,
			version,
			accountId: "acc",
			from: [a.hostId],
			to: b.hostId,
		});
		expect(located).toMatch(/\./);
		// As the target asks over its link: answered from the registry, with a grant.
		const asked = (from: FakeHost, objectId = sandbox.id, at = version) => {
			const id = `loc_${Math.random()}`;
			from.send({ type: "call", id, method: "disk.locate", params: { kind: "sandbox", objectId, version: at } });
			return vi.waitFor(() => {
				const found = from.sent.find((message) => message.type === "result" && message.id === id);
				if (found === undefined) throw new Error("not answered yet");
				return found;
			});
		};
		expect(await asked(b)).toMatchObject({
			result: {
				mapDigest: expect.stringMatching(/^sha256:/),
				holders: [{ hostId: a.hostId }],
				grant: expect.any(String),
			},
		});
		expect(await asked(c)).toMatchObject({ error: { code: "not_found" } });
		expect(await asked(b, sandbox.id, "mov_other")).toMatchObject({ error: { code: "not_found" } });
		const view = await root.getSandbox(sandbox.id);
		expect(view).toMatchObject({ state: "moving", move: { phase: "copying", keepMemory: false } });
		release();
		expect(await moving).toMatchObject({ state: "running", hostId: b.hostId });
		expect(await asked(b)).toMatchObject({ error: { code: "not_found" } });
		expect((await service.sandboxes.placement(sandbox.id))?.hostId).toBe(b.hostId);
	});

	it("rolls back a move whose copy fails: the target's copy cancelled, the export deleted, stopped on its source", async () => {
		const { root, api, service, join } = await setup();
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		b.refuse = (method) =>
			method === "sandbox.import" ? { code: "unavailable", message: "the copy failed part way" } : undefined;
		const error = await failure(root.moveSandbox(sandbox.id, {}));
		expect(error.message).toContain("the copy failed part way");
		const after = await root.getSandbox(sandbox.id);
		expect(after).toMatchObject({ state: "stopped", hostId: a.hostId });
		expect(after.move).toBeUndefined();
		expect(methodsOf(b, sandbox.id)).toEqual(["sandbox.import", "sandbox.import.cancel"]);
		expect(methodsOf(a, sandbox.id).slice(-2)).toEqual(["sandbox.export", "sandbox.export.delete"]);
		expect(a.exports.size).toBe(0);
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ hostId: a.hostId, state: "stopped" });
		expect(placement?.move).toBeUndefined();
		// It starts where it was.
		b.refuse = undefined;
		expect(await root.startSandbox(sandbox.id, { wait: true })).toMatchObject({ state: "running", hostId: a.hostId });
		expect(a.disks.get(sandbox.id)).toBe("disk");
	});

	it("rolls back a move whose start on the target fails, deleting what started there", async () => {
		const { root, api, join } = await setup();
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		b.refuse = (method) =>
			method === "sandbox.start" ? { code: "unavailable", message: "it didn't boot" } : undefined;
		const error = await failure(root.moveSandbox(sandbox.id, {}));
		expect(error.message).toContain("it didn't boot");
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "stopped", hostId: a.hostId });
		expect(b.sandboxes.has(sandbox.id)).toBe(false);
		expect(a.sandboxes.get(sandbox.id)?.state).toBe("stopped");
	});

	it("settles a move whose target went away mid-copy once it is back, rolling it back", async () => {
		const clock = { at: Date.now() };
		const { root, api, join } = await setup({ now: () => clock.at });
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		// Its target goes as it copies: whether it imported it isn't known, and it can't be asked yet.
		b.hold = (method) => (method === "sandbox.import" ? new Promise(() => undefined) : undefined);
		const moving = failure(root.moveSandbox(sandbox.id, {}));
		await vi.waitFor(() => expect(b.calls.some((call) => call.method === "sandbox.import")).toBe(true));
		b.connection.closed(1006, "gone");
		const error = await moving;
		expect(error.code).toBe("unavailable");
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "moving", hostId: a.hostId });
		// Back, and the move gone quiet: the sweep rolls it back, and it is stopped where it was.
		b.hold = undefined;
		const welcomes = () => b.sent.filter((message) => message.type === "welcome").length;
		const before = welcomes();
		b.connect();
		await vi.waitFor(() => expect(welcomes()).toBeGreaterThan(before));
		clock.at += 3 * 60_000;
		await api.service.sweep();
		await vi.waitFor(async () =>
			expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "stopped", hostId: a.hostId }),
		);
		expect(b.cancelled.size).toBe(1);
		expect(a.exports.size).toBe(0);
	});

	it("refuses what it can't move, leaving the sandbox as it was", async () => {
		const { root, api, join } = await setup();
		const a = await join();
		const older = await join([HOST_FEATURES.mesh, HOST_FEATURES.egressPolicy]);
		const running = await root.createSandbox({ type: "microvm", host: a.hostId, wait: true });
		await unpinned(api, running.id);
		expect((await failure(root.moveSandbox(running.id, {}))).code).toBe("conflict");
		const paused = await root.createSandbox({ type: "microvm", host: a.hostId, wait: true });
		await unpinned(api, paused.id);
		await root.stopSandbox(paused.id, { keepMemory: true, wait: true });
		const refused = await failure(root.moveSandbox(paused.id, {}));
		expect(refused.code).toBe("conflict");
		expect(refused.message).toContain("keepMemory");
		const pinned = await stoppedOn(root, a, "disk");
		expect((await failure(root.moveSandbox(pinned.id, {}))).code).toBe("conflict");
		// No other host can take it: the only other one is from before moves.
		const stopped = await stoppedOn(root, a, "disk");
		await unpinned(api, stopped.id);
		const none = await failure(root.moveSandbox(stopped.id, {}));
		expect(none.code).toBe("exhausted");
		expect((await failure(root.moveSandbox(stopped.id, { hostId: a.hostId }))).code).toBe("invalid");
		expect(await root.getSandbox(stopped.id)).toMatchObject({ state: "stopped", hostId: a.hostId });
		expect(older.calls.some((call) => call.method.startsWith("sandbox.import"))).toBe(false);
	});

	it("never moves a sandbox out of its pool", async () => {
		const { root, api, join } = await setup();
		const a = await join();
		await root.createPool({ name: "ci", sync: true });
		const elsewhere = await join(MOVES, "ci");
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		const asked = await failure(root.moveSandbox(sandbox.id, { hostId: elsewhere.hostId }));
		expect(asked.code).toBe("unavailable");
		expect((await failure(root.moveSandbox(sandbox.id, {}))).code).toMatch(/exhausted|unavailable/);
		expect(elsewhere.calls.some((call) => call.method.startsWith("sandbox."))).toBe(false);
	});

	it("deletes the source's copy once that host is back, when it was away as the move switched", async () => {
		const { root, api, service, join } = await setup();
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		// The source refuses the delete (as one gone away would leave it): the removal is owed.
		a.refuse = (method) => (method === "sandbox.delete" ? { code: "unavailable", message: "away" } : undefined);
		await root.moveSandbox(sandbox.id, {});
		expect((await service.sandboxes.placement(sandbox.id))?.cleanup).toMatchObject({
			hostId: a.hostId,
			tier: "microvm",
		});
		// Back: its heartbeat sends the delete.
		a.refuse = undefined;
		a.send({
			type: "heartbeat",
			heartbeat: { capacity: { freeMemoryMiB: 20_000, freeDiskGiB: 400, running: 0, stopped: 1, load1: 0 } },
		});
		await vi.waitFor(async () => expect((await service.sandboxes.placement(sandbox.id))?.cleanup).toBeUndefined());
		expect(a.sandboxes.has(sandbox.id)).toBe(false);
		expect((await service.sandboxes.placement(sandbox.id))?.hostId).toBe(b.hostId);
	});

	it("never switches once a rollback has claimed it, so the source's copy stays", async () => {
		const { root, api, service, store, join } = await setup();
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		b.hold = (method) => (method === "sandbox.start" ? held : undefined);
		const moving = failure(root.moveSandbox(sandbox.id, {}));
		await vi.waitFor(() => expect(b.calls.some((call) => call.method === "sandbox.start")).toBe(true));
		// Another gateway's rollback claims it as it starts on the target.
		await store.updatePlacement(sandbox.id, (latest) =>
			latest.move === undefined
				? undefined
				: { ...latest, move: { ...latest.move, settling: { by: "rbm_other", until: Date.now() + 60_000 } } },
		);
		release();
		expect((await moving).code).toBe("unavailable");
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ hostId: a.hostId, move: { settling: { by: "rbm_other" } } });
		expect(placement?.cleanup).toBeUndefined();
		expect(a.sandboxes.has(sandbox.id)).toBe(true);
		expect(methodsOf(a, sandbox.id)).not.toContain("sandbox.delete");
	});

	it("never switches once a rollback has begun, even one let go when a host didn't answer", async () => {
		const { root, api, service, store, join } = await setup();
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		// The mover is held just before its switch, the sandbox running on its target.
		const update = store.updatePlacement.bind(store);
		let atSwitch: () => void = () => undefined;
		const reached = new Promise<void>((resolve) => {
			atSwitch = resolve;
		});
		store.updatePlacement = async (id, change) => {
			const latest = await store.getPlacement(id);
			if (latest !== undefined && change(latest)?.moved !== undefined) {
				atSwitch();
				await held;
			}
			return update(id, change);
		};
		const moving = failure(root.moveSandbox(sandbox.id, {}));
		await reached;
		expect(b.sandboxes.get(sandbox.id)?.state).toBe("running");
		const version = String(b.calls.find((call) => call.method === "sandbox.import")?.params.version);
		// Another gateway settles it as it starts: the target's copy is cancelled, but the source doesn't answer the
		// export's delete, so that rollback lets its claim go.
		a.refuse = (method) => (method === "sandbox.export.delete" ? { code: "unavailable", message: "away" } : undefined);
		await expect(service.sandboxes.settleMove(sandbox.id, version)).rejects.toThrow(/can't be reached/);
		expect(b.cancelled.has(`${sandbox.id}/${version}`)).toBe(true);
		const between = await service.sandboxes.placement(sandbox.id);
		expect(between?.move).toMatchObject({ rollingBack: true });
		expect(between?.move?.settling).toBeUndefined();
		release();
		expect((await moving).code).toBe("unavailable");
		expect(await service.sandboxes.placement(sandbox.id)).toMatchObject({ hostId: a.hostId });
		expect(a.sandboxes.has(sandbox.id)).toBe(true);
		expect(methodsOf(a, sandbox.id)).not.toContain("sandbox.delete");
		// Back: the rollback finishes, and it is stopped on its source.
		a.refuse = undefined;
		expect(await service.sandboxes.settleMove(sandbox.id, version)).toMatchObject({ state: "failed" });
		expect((await service.sandboxes.placement(sandbox.id))?.move).toBeUndefined();
	});

	it("refuses a delete or a start of a sandbox whose move is under way, leaving it moving", async () => {
		const { root, api, service, join } = await setup();
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		b.hold = (method) => (method === "sandbox.import" ? held : undefined);
		const moving = root.moveSandbox(sandbox.id, { wait: false });
		expect((await moving).state).toBe("moving");
		await vi.waitFor(() => expect(b.calls.some((call) => call.method === "sandbox.import")).toBe(true));
		// Another gateway over the same store and hosts: its calls aren't queued behind this one's move.
		const gateway = createComputeApi({
			store: api.store,
			backend: createHostBackend({
				hosts: service,
				publicUrl: "https://kantel.test",
				tickets: createTunnelTickets(createMemoryRelayStore()),
			}),
			authenticatePerson: async (request) =>
				PEOPLE[request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""],
			fetch: async () => new Response(null, { status: 204 }),
			publicUrl: "https://kantel.test",
			stickyDisks: true,
			secretsKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
		});
		closers.push(() => gateway.close());
		const other = createKantelClient({
			baseUrl: "https://kantel.test/v1",
			token: "root",
			fetch: (input, init) =>
				gateway.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		expect((await failure(other.deleteSandbox(sandbox.id))).code).toBe("conflict");
		expect((await failure(other.startSandbox(sandbox.id, {}))).code).toBe("conflict");
		expect((await other.getSandbox(sandbox.id)).state).toBe("moving");
		release();
		await vi.waitFor(async () => expect((await other.getSandbox(sandbox.id)).state).toBe("running"));
		expect(b.sandboxes.get(sandbox.id)?.state).toBe("running");
	});

	it("settles a move that switched as done, its source's copy deleted or not, and answers a retry with it", async () => {
		const { root, api, service, join } = await setup();
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		await root.moveSandbox(sandbox.id, {});
		const version = String(b.calls.find((call) => call.method === "sandbox.import")?.params.version);
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement?.cleanup).toBeUndefined();
		expect(placement?.moved).toEqual({ operationId: version, from: a.hostId });
		expect(await service.sandboxes.settleMove(sandbox.id, version)).toMatchObject({
			state: "done",
			moved: { hostId: b.hostId },
		});
		const again = await service.sandboxes.move(sandbox.id, { operationId: version, start: () => ({ params: {} }) });
		expect(again.hostId).toBe(b.hostId);
		expect(methodsOf(b, sandbox.id).filter((method) => method === "sandbox.import")).toHaveLength(1);
	});

	it("refuses a delete while the target of a move under way can't drop its copy, keeping the move", async () => {
		const { root, api, service, store, join } = await setup();
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		const move = {
			operationId: "mov_away",
			target: b.hostId,
			phase: "copy" as const,
			size: { name: "default", vcpus: 2, memoryMiB: 2048, diskGiB: 20 },
		};
		await store.updatePlacement(sandbox.id, (latest) => ({ ...latest, move }));
		b.refuse = (method) => (method === "sandbox.import.cancel" ? { code: "unavailable", message: "away" } : undefined);
		await expect(service.sandboxes.delete(sandbox.id)).rejects.toThrow(/drop its copy/);
		expect(await service.sandboxes.placement(sandbox.id)).toMatchObject({ hostId: a.hostId, move });
		expect(a.sandboxes.has(sandbox.id)).toBe(true);
		b.refuse = undefined;
		await service.sandboxes.delete(sandbox.id);
		expect(b.cancelled.has(`${sandbox.id}/mov_away`)).toBe(true);
		expect(await service.sandboxes.placement(sandbox.id)).toBeUndefined();
	});

	it("cancels the target's copy when the sandbox is deleted as it moves", async () => {
		const { root, api, service, store, join } = await setup();
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		await store.updatePlacement(sandbox.id, (latest) => ({
			...latest,
			move: {
				operationId: "mov_gone",
				target: b.hostId,
				phase: "copy",
				size: { name: "default", vcpus: 2, memoryMiB: 2048, diskGiB: 20 },
			},
		}));
		await service.sandboxes.delete(sandbox.id);
		expect(b.cancelled.has(`${sandbox.id}/mov_gone`)).toBe(true);
		expect(await service.sandboxes.placement(sandbox.id)).toBeUndefined();
	});
});

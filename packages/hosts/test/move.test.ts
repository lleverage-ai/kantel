// Moving a stopped microVM to another host in its pool (docs/design/disk-store.md, "Moving a sandbox to another
// host"), end to end through the compute API, the hosts service and its hub with fake kantel-hosts: its source exports
// it, its target imports it from the source (with a grant, its `disk.locate` answered while the move is under way) and
// starts it, and only then does its placement switch and its source's copy go. A failure before the switch rolls it
// back: the target's copy cancelled, the source's export deleted, the sandbox stopped where it was.
// apps/host/test/move.sh moves one between real hosts.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import {
	type ComputeApi,
	type ComputeStore,
	createComputeApi,
	joinTokenSpender,
	type PersonIdentity,
} from "@kantel/compute";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBackend, SUSPENDED_COMMAND_LOST } from "../src/backend.ts";
import { HOST_FEATURES, type HostFacts, type HostMeshFacts } from "../src/protocol.ts";
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

async function setup(options: { readonly now?: () => number; readonly stickyDisks?: boolean } = {}) {
	const store = createMemoryHostStore();
	const service = createHostsService({
		store,
		publicUrl: "https://kantel.test",
		log: () => undefined,
		...(options.now === undefined ? {} : { clock: { now: options.now } }),
	});
	const backend = createHostBackend({
		hosts: service,
		publicUrl: "https://kantel.test",
		tickets: createTunnelTickets(createMemoryRelayStore()),
	});
	const api: ComputeApi = createComputeApi({
		backend,
		authenticatePerson: async (request) =>
			PEOPLE[request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""],
		fetch: async () => new Response(null, { status: 204 }),
		publicUrl: "https://kantel.test",
		stickyDisks: options.stickyDisks ?? true,
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
	/** Joins a host to the pool (or `into`), running the mesh, with `features` and facts beyond the usual (`more`). */
	const join = async (features: readonly string[] = MOVES, into: string = pool.name, more: Partial<HostFacts> = {}) => {
		const token = await root.createHostJoinToken({ pool: into });
		const { hostId } = await service.register({ token: token.token });
		const host = new FakeHost(service, hostId, features);
		host.moreFacts = { mesh: meshOf(byte++), ...more };
		host.connect();
		await vi.waitFor(() => expect(host.welcomed()).toBe(true));
		return host;
	};
	/**
	 * Another gateway: a compute API of its own over the same store and hosts, with its own clock (`now`), and its store
	 * as `wrap` makes it (one that fails, as a gateway going would).
	 */
	const gateway = (
		more: { readonly now?: () => number; readonly wrap?: (store: ComputeStore) => ComputeStore } = {},
	) => {
		const other: ComputeApi = createComputeApi({
			store: more.wrap?.(api.store) ?? api.store,
			backend,
			authenticatePerson: async (request) =>
				PEOPLE[request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""],
			fetch: async () => new Response(null, { status: 204 }),
			publicUrl: "https://kantel.test",
			stickyDisks: options.stickyDisks ?? true,
			secretsKey: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
			...(more.now === undefined ? {} : { now: more.now }),
		});
		closers.push(() => other.close());
		const client = createKantelClient({
			baseUrl: "https://kantel.test/v1",
			token: "root",
			fetch: (input, init) =>
				other.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		return { api: other, root: client };
	};
	return { service, store, api, root, join, pool, backend, gateway };
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
		// Its host moves stopped sandboxes alone.
		expect((await failure(root.moveSandbox(running.id, {}))).code).toBe("not_supported");
		// Its memory can't go (its host doesn't move memory), and no other host can take its disk.
		const paused = await root.createSandbox({ type: "microvm", host: a.hostId, wait: true });
		await unpinned(api, paused.id);
		await root.stopSandbox(paused.id, { keepMemory: true, wait: true });
		expect((await failure(root.moveSandbox(paused.id, {}))).code).toBe("exhausted");
		expect(await root.getSandbox(paused.id)).toMatchObject({ state: "paused", hostId: a.hostId });
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

	it("lists a moving sandbox by the state it answers, and lets its target fetch its mounts while it starts there", async () => {
		const { root, api, backend, join } = await setup();
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		b.hold = (method) => (method === "sandbox.start" ? held : undefined);
		const moving = root.moveSandbox(sandbox.id, {});
		await vi.waitFor(() => expect(b.calls.some((call) => call.method === "sandbox.start")).toBe(true));
		expect((await root.listSandboxes({ state: "moving" })).items.map((each) => each.id)).toEqual([sandbox.id]);
		expect((await root.listSandboxes({ state: "starting" })).items).toEqual([]);
		// It boots on its target: that host, not its source, may fetch its mounts' sources now.
		expect(await backend.placedOn?.(sandbox.id)).toBe(b.hostId);
		release();
		await moving;
		expect(await backend.placedOn?.(sandbox.id)).toBe(b.hostId);
		expect((await root.listSandboxes({ state: "moving" })).items).toEqual([]);
	});

	it("moves with sticky disks and templates off: its grant needs only the grant key", async () => {
		const { root, api, join } = await setup({ stickyDisks: false });
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		expect(await root.moveSandbox(sandbox.id, {})).toMatchObject({ state: "running", hostId: b.hostId });
		expect(b.disks.get(sandbox.id)).toBe("disk");
	});

	it("finishes a move whose source is revoked as it copies, never leaving it in error", async () => {
		const { root, api, join } = await setup();
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		b.hold = (method) => (method === "sandbox.start" ? held : undefined);
		const moving = root.moveSandbox(sandbox.id, {});
		await vi.waitFor(() => expect(b.calls.some((call) => call.method === "sandbox.start")).toBe(true));
		// Revoked through the API, as an operator does it (its sandboxes stranded there).
		await root.revokeHost(a.hostId);
		await api.service.sweep();
		expect((await root.getSandbox(sandbox.id)).state).toBe("moving");
		release();
		expect(await moving).toMatchObject({ state: "running", hostId: b.hostId });
	});

	it("rolls a move back onto a source revoked as it copied as that revocation leaves it: in error", async () => {
		const { root, api, join } = await setup();
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		b.hold = (method) => (method === "sandbox.start" ? held : undefined);
		b.refuse = (method) =>
			method === "sandbox.start" ? { code: "unavailable", message: "it didn't boot" } : undefined;
		const moving = failure(root.moveSandbox(sandbox.id, {}));
		await vi.waitFor(() => expect(b.calls.some((call) => call.method === "sandbox.start")).toBe(true));
		await root.revokeHost(a.hostId);
		expect((await root.getSandbox(sandbox.id)).state).toBe("moving");
		release();
		await moving;
		const after = await root.getSandbox(sandbox.id);
		expect(after).toMatchObject({ state: "error", hostId: a.hostId });
		expect(after.reason).toMatch(/revoked/);
		expect(after.move).toBeUndefined();
	});

	it("never leaves a copy or a placement when a delete meets a move about to switch", async () => {
		const { root, api, service, store, join } = await setup();
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		const update = store.updatePlacement.bind(store);
		let atSwitch: () => void = () => undefined;
		const reached = new Promise<void>((resolve) => {
			atSwitch = resolve;
		});
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
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
		await service.sandboxes.delete(sandbox.id);
		release();
		await moving;
		expect(b.sandboxes.has(sandbox.id)).toBe(false);
		expect(a.sandboxes.has(sandbox.id)).toBe(false);
		expect(await service.sandboxes.placement(sandbox.id)).toBeUndefined();
	});

	it("deletes a source's copy only as the copy its move exported, so a late cleanup never removes a later move's", async () => {
		const { root, api, service, join } = await setup();
		const a = await join();
		const b = await join();
		const sandbox = await stoppedOn(root, a, "disk");
		await unpinned(api, sandbox.id);
		await root.moveSandbox(sandbox.id, {});
		const first = String(b.calls.find((call) => call.method === "sandbox.import")?.params.version);
		// Its source's copy went by that move's ID.
		expect(a.calls.find((call) => call.method === "sandbox.delete")?.params).toMatchObject({
			keepSnapshots: true,
			exported: first,
		});
		await root.stopSandbox(sandbox.id, { wait: true });
		await root.moveSandbox(sandbox.id, { hostId: a.hostId });
		expect(a.sandboxes.has(sandbox.id)).toBe(true);
		// The first move's cleanup, arriving late at A (sent before, delivered after the move back): A's copy is the
		// second move's, so the host refuses it, and it stays.
		await expect(
			service.sandboxes.call(sandbox.id, "sandbox.delete", { keepSnapshots: true, exported: first }),
		).rejects.toMatchObject({ code: "not_found" });
		expect(a.sandboxes.has(sandbox.id)).toBe(true);
		expect((await root.getSandbox(sandbox.id)).hostId).toBe(a.hostId);
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

const MOVES_RUNNING = [...MOVES, HOST_FEATURES.sandboxMoveRunning];

/** A running microVM on `on`, with what is on its disk there, let go of the pin its create on `on` gave it. */
async function runningOn(
	root: ReturnType<typeof createKantelClient>,
	api: ComputeApi,
	on: FakeHost,
	disk: string,
): Promise<{ readonly id: string }> {
	const made = await root.createSandbox({ type: "microvm", host: on.hostId, wait: true });
	on.disks.set(made.id, disk);
	await unpinned(api, made.id);
	return made;
}

/** Holds each call `which` picks on `host` until the promise it answers is released. */
function holding(host: FakeHost, which: (method: string, params: { readonly [key: string]: unknown }) => boolean) {
	let release: () => void = () => undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const hold = (method: string, params: { readonly [key: string]: unknown }) =>
		which(method, params) ? held : undefined;
	host.hold = hold;
	return () => {
		if (host.hold === hold) host.hold = undefined;
		release();
	};
}

describe("moving a running sandbox to another host, with a restart", () => {
	it("copies it as it runs, stops it, copies what it wrote since over that, and starts it on the target", async () => {
		const { root, api, service, join } = await setup();
		const a = await join(MOVES_RUNNING);
		const b = await join(MOVES_RUNNING);
		const sandbox = await runningOn(root, api, a, "written before the move");
		const staging = holding(b, (method, params) => method === "sandbox.import" && params.stage === true);
		const moving = root.moveSandbox(sandbox.id, { keepMemory: false });
		await vi.waitFor(() => expect(b.calls.some((call) => call.method === "sandbox.import")).toBe(true));
		// Copying: it still runs where it was, and runs commands there.
		expect(await root.getSandbox(sandbox.id)).toMatchObject({
			state: "moving",
			hostId: a.hostId,
			move: { phase: "copying", keepMemory: false },
		});
		expect((await api.store.sandboxes.get(sandbox.id))?.state).toBe("running");
		expect(await root.runCommand(sandbox.id, { command: "echo hi" })).toMatchObject({ exitCode: 0 });
		expect(methodsOf(a, sandbox.id)).not.toContain("sandbox.stop");
		// What it writes as its first copy is fetched goes in its final copy.
		a.disks.set(sandbox.id, "written as it moved");
		const finalCopy = holding(b, (method, params) => method === "sandbox.import" && params.stage !== true);
		staging();
		await vi.waitFor(() => expect(b.calls.filter((call) => call.method === "sandbox.import")).toHaveLength(2));
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "moving", move: { phase: "final-copy" } });
		expect((await api.store.sandboxes.get(sandbox.id))?.state).toBe("starting");
		finalCopy();
		const moved = await moving;
		expect(moved).toMatchObject({ id: sandbox.id, state: "running", hostId: b.hostId });
		expect(b.disks.get(sandbox.id)).toBe("written as it moved");
		// Its source: its first copy exported as it ran, then stopped without its memory or a snapshot, its final copy
		// exported over the first, and its copy deleted once the move switched.
		expect(methodsOf(a, sandbox.id).slice(-4)).toEqual([
			"sandbox.export",
			"sandbox.stop",
			"sandbox.export",
			"sandbox.delete",
		]);
		const sent = (host: FakeHost, method: string) =>
			host.calls.filter((call) => call.method === method && call.params.sandboxId === sandbox.id).map((c) => c.params);
		const [first, final] = sent(a, "sandbox.export");
		expect(first).toMatchObject({ version: expect.stringMatching(/^mov_.*-live$/), live: true });
		expect(final).toMatchObject({ base: first?.version });
		expect(final?.version).toBe(String(first?.version).replace(/-live$/, ""));
		expect(sent(a, "sandbox.stop")[0]).toMatchObject({ memory: false });
		expect(sent(a, "sandbox.stop")[0]?.snapshotId).toBeUndefined();
		// Its target: the first copy fetched and kept staged, the final one fetched over it, then started.
		expect(methodsOf(b, sandbox.id)).toEqual(["sandbox.import", "sandbox.import", "sandbox.start"]);
		const [staged, over] = sent(b, "sandbox.import");
		expect(staged).toMatchObject({ version: first?.version, stage: true });
		expect(over).toMatchObject({ version: final?.version, base: first?.version });
		expect(b.staged.size).toBe(0);
		expect(a.exports.size).toBe(0);
		expect(a.sandboxes.has(sandbox.id)).toBe(false);
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ hostId: b.hostId, state: "running" });
		expect(placement?.move).toBeUndefined();
	});

	it("answers its target's disk.locate for its first copy while that is fetched", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_RUNNING);
		const b = await join(MOVES_RUNNING);
		const sandbox = await runningOn(root, api, a, "disk");
		const staging = holding(b, (method, params) => method === "sandbox.import" && params.stage === true);
		const moving = root.moveSandbox(sandbox.id, { keepMemory: false });
		await vi.waitFor(() => expect(b.calls.some((call) => call.method === "sandbox.import")).toBe(true));
		const version = String(b.calls.find((call) => call.method === "sandbox.import")?.params.version);
		const id = "loc_live";
		b.send({ type: "call", id, method: "disk.locate", params: { kind: "sandbox", objectId: sandbox.id, version } });
		const found = await vi.waitFor(() => {
			const answer = b.sent.find((message) => message.type === "result" && message.id === id);
			if (answer === undefined) throw new Error("not answered yet");
			return answer;
		});
		expect(found).toMatchObject({ result: { holders: [{ hostId: a.hostId }], grant: expect.any(String) } });
		staging();
		expect(await moving).toMatchObject({ state: "running", hostId: b.hostId });
	});

	it("starts it again on its source when the move fails after it was stopped", async () => {
		const { root, api, service, join } = await setup();
		const a = await join(MOVES_RUNNING);
		const b = await join(MOVES_RUNNING);
		const sandbox = await runningOn(root, api, a, "disk");
		b.refuse = (method) =>
			method === "sandbox.start" ? { code: "unavailable", message: "it didn't boot" } : undefined;
		const error = await failure(root.moveSandbox(sandbox.id, { keepMemory: false }));
		expect(error.message).toContain("it didn't boot");
		const after = await root.getSandbox(sandbox.id);
		expect(after).toMatchObject({ state: "running", hostId: a.hostId });
		expect(after.move).toBeUndefined();
		expect(methodsOf(a, sandbox.id).slice(-5)).toEqual([
			"sandbox.stop",
			"sandbox.export",
			"sandbox.export.delete",
			"sandbox.export.delete",
			"sandbox.start",
		]);
		expect(a.sandboxes.get(sandbox.id)?.state).toBe("running");
		expect(a.exports.size).toBe(0);
		// Both copies on its target cancelled: the final one, and the first staged there.
		expect(b.cancelled.size).toBe(2);
		expect(b.staged.size).toBe(0);
		expect(b.sandboxes.has(sandbox.id)).toBe(false);
		const placement = await service.sandboxes.placement(sandbox.id);
		expect(placement).toMatchObject({ hostId: a.hostId, state: "running" });
		expect(placement?.move).toBeUndefined();
	});

	it("leaves it running where it was, never stopped, when its first copy fails", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_RUNNING);
		const b = await join(MOVES_RUNNING);
		const sandbox = await runningOn(root, api, a, "disk");
		b.refuse = (method) =>
			method === "sandbox.import" ? { code: "unavailable", message: "the copy failed part way" } : undefined;
		const error = await failure(root.moveSandbox(sandbox.id, { keepMemory: false }));
		expect(error.message).toContain("the copy failed part way");
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "running", hostId: a.hostId });
		expect(methodsOf(a, sandbox.id)).not.toContain("sandbox.stop");
		expect(a.exports.size).toBe(0);
		expect(await root.runCommand(sandbox.id, { command: "echo hi" })).toMatchObject({ exitCode: 0 });
	});

	it("ends the move, never stopping it, when it exits while its first copy is made", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_RUNNING);
		const b = await join(MOVES_RUNNING);
		const sandbox = await runningOn(root, api, a, "disk");
		const staging = holding(b, (method, params) => method === "sandbox.import" && params.stage === true);
		const moving = failure(root.moveSandbox(sandbox.id, { keepMemory: false }));
		await vi.waitFor(() => expect(b.calls.some((call) => call.method === "sandbox.import")).toBe(true));
		// Its machine exited meanwhile: its record moved on, as its host's report of the exit leaves it.
		await api.store.sandboxes.update(sandbox.id, (latest) => ({
			...latest,
			state: "error",
			lifecycle: (latest.lifecycle ?? 0) + 1,
		}));
		staging();
		expect((await moving).code).toBe("conflict");
		const after = await api.store.sandboxes.get(sandbox.id);
		expect(after).toMatchObject({ state: "error", hostId: a.hostId });
		expect(after?.moving).toBeUndefined();
		expect(methodsOf(a, sandbox.id)).not.toContain("sandbox.stop");
		expect(b.cancelled.size).toBe(2);
		expect(a.exports.size).toBe(0);
	});

	it("refuses a stop, pause or recovery while it moves, as another gateway would find it", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_RUNNING);
		const sandbox = await runningOn(root, api, a, "disk");
		// A move another gateway is at: its record running, with the move on it.
		const at = Date.now();
		await api.store.sandboxes.update(sandbox.id, (latest) => ({
			...latest,
			moving: { operationId: "mov_other", at, heartbeatAt: at, phase: "copying", from: "running", before: {} },
		}));
		for (const call of [
			root.stopSandbox(sandbox.id, { wait: true }),
			root.stopSandbox(sandbox.id, { keepMemory: true, wait: true }),
			root.recoverSandbox(sandbox.id),
		]) {
			const refused = await failure(call);
			expect(refused.code).toBe("conflict");
			expect(refused.message).toContain("moving");
		}
		expect(await api.store.sandboxes.get(sandbox.id)).toMatchObject({ state: "running" });
		expect(methodsOf(a, sandbox.id)).not.toContain("sandbox.stop");
	});

	it("is refused where a host can't move a running sandbox", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_RUNNING);
		const older = await join(MOVES);
		const sandbox = await runningOn(root, api, a, "disk");
		// Its only other host moves stopped sandboxes alone, whether its memory is asked to go or not.
		expect((await failure(root.moveSandbox(sandbox.id, {}))).code).toBe("exhausted");
		expect((await failure(root.moveSandbox(sandbox.id, { keepMemory: false }))).code).toBe("exhausted");
		expect(older.calls.some((call) => call.method.startsWith("sandbox.import"))).toBe(false);
		const onOlder = await runningOn(root, api, older, "disk");
		await join(MOVES_RUNNING);
		const refused = await failure(root.moveSandbox(onOlder.id, { keepMemory: false }));
		expect(refused.code).toBe("not_supported");
		expect(refused.message).toContain("running");
		for (const id of [sandbox.id, onOlder.id]) {
			expect(await root.getSandbox(id)).toMatchObject({ state: "running" });
		}
	});

	it("settles a move whose target went away after the stop, starting it again on its source", async () => {
		const clock = { at: Date.now() };
		const { root, api, join } = await setup({ now: () => clock.at });
		const a = await join(MOVES_RUNNING);
		const b = await join(MOVES_RUNNING);
		const sandbox = await runningOn(root, api, a, "disk");
		// Its target goes as it fetches the final copy: whether it imported it isn't known, and it can't be asked yet.
		b.hold = (method, params) =>
			method === "sandbox.import" && params.stage !== true ? new Promise(() => undefined) : undefined;
		const moving = failure(root.moveSandbox(sandbox.id, { keepMemory: false }));
		await vi.waitFor(() => expect(b.calls.filter((call) => call.method === "sandbox.import")).toHaveLength(2));
		b.connection.closed(1006, "gone");
		expect((await moving).code).toBe("unavailable");
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "moving", hostId: a.hostId });
		expect(a.sandboxes.get(sandbox.id)?.state).toBe("stopped");
		b.hold = undefined;
		const welcomes = () => b.sent.filter((message) => message.type === "welcome").length;
		const before = welcomes();
		b.connect();
		await vi.waitFor(() => expect(welcomes()).toBeGreaterThan(before));
		clock.at += 3 * 60_000;
		await api.service.sweep();
		await vi.waitFor(async () =>
			expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "running", hostId: a.hostId }),
		);
		expect(a.sandboxes.get(sandbox.id)?.state).toBe("running");
		expect(b.cancelled.size).toBe(2);
		expect(a.exports.size).toBe(0);
	});

	it("refuses a move again, after one try at settling it, while a quiet move can't be settled", async () => {
		const clock = { at: Date.now() };
		const { root, api, join, service } = await setup({ now: () => clock.at });
		const a = await join(MOVES_RUNNING);
		const b = await join(MOVES_RUNNING);
		const sandbox = await runningOn(root, api, a, "disk");
		b.hold = (method, params) =>
			method === "sandbox.import" && params.stage !== true ? new Promise(() => undefined) : undefined;
		const moving = failure(root.moveSandbox(sandbox.id, { keepMemory: false }));
		await vi.waitFor(() => expect(b.calls.filter((call) => call.method === "sandbox.import")).toHaveLength(2));
		b.connection.closed(1006, "gone");
		expect((await moving).code).toBe("unavailable");
		// Its target still away and the move gone quiet: a move again tries to settle it once, and says why it can't.
		clock.at += 3 * 60_000;
		const settles = vi.spyOn(service.sandboxes, "settleMove");
		const again = await failure(root.moveSandbox(sandbox.id, { keepMemory: false }));
		expect(again.code).toBe("unavailable");
		expect(again.message).toContain("can't be settled yet");
		// Tried once by the move, and at most once more by the sweep a request may run: never again and again.
		expect(settles.mock.calls.length).toBeGreaterThanOrEqual(1);
		expect(settles.mock.calls.length).toBeLessThanOrEqual(2);
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "moving", hostId: a.hostId });
	});

	it("settles a quiet move left on a running sandbox before a start answers it", async () => {
		const clock = { at: Date.now() };
		const { root, api, join } = await setup({ now: () => clock.at });
		const a = await join(MOVES_RUNNING);
		const sandbox = await runningOn(root, api, a, "disk");
		// A move whose gateway went during its first copy: nothing of it on the hosts' side.
		await api.store.sandboxes.update(sandbox.id, (latest) => ({
			...latest,
			moving: {
				operationId: "mov_gone",
				at: clock.at,
				heartbeatAt: clock.at,
				phase: "copying",
				from: "running",
				before: {},
			},
		}));
		clock.at += 3 * 60_000;
		const started = await root.startSandbox(sandbox.id, { wait: true });
		expect(started).toMatchObject({ state: "running", hostId: a.hostId });
		expect(started.move).toBeUndefined();
		expect((await api.store.sandboxes.get(sandbox.id))?.moving).toBeUndefined();
	});

	it("is error, its move cleared, when starting it again on its source fails too", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_RUNNING);
		const b = await join(MOVES_RUNNING);
		const sandbox = await runningOn(root, api, a, "disk");
		b.refuse = (method) =>
			method === "sandbox.start" ? { code: "unavailable", message: "it didn't boot" } : undefined;
		a.refuse = (method) => (method === "sandbox.start" ? { code: "unavailable", message: "nor here" } : undefined);
		await failure(root.moveSandbox(sandbox.id, { keepMemory: false }));
		const after = await api.store.sandboxes.get(sandbox.id);
		expect(after).toMatchObject({ state: "error", hostId: a.hostId });
		expect(after?.moving).toBeUndefined();
	});

	it("keeps a stop owed as it moved (its person left) until the sweep stops it, wherever the move leaves it", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_RUNNING);
		const b = await join(MOVES_RUNNING);
		const owe = (id: string) =>
			api.store.sandboxes.update(id, (latest) =>
				latest.moving === undefined
					? latest
					: { ...latest, moving: { ...latest.moving, stopAfter: "Its person left the organisation" } },
			);
		// Moved: owed as its first copy was made, it runs on its target owing its stop, which the sweep carries out.
		const moved = await runningOn(root, api, a, "disk");
		let release = holding(b, (method, params) => method === "sandbox.import" && params.stage === true);
		let moving = root.moveSandbox(moved.id, { keepMemory: false });
		await vi.waitFor(() => expect(b.calls.some((call) => call.method === "sandbox.import")).toBe(true));
		await owe(moved.id);
		release();
		expect(await moving).toMatchObject({ state: "running", hostId: b.hostId });
		expect(await api.store.sandboxes.get(moved.id)).toMatchObject({ stopFor: "Its person left the organisation" });
		await api.service.sweep();
		await vi.waitFor(async () => expect((await root.getSandbox(moved.id)).state).toBe("stopped"));
		// Rolled back before its stop: running on where it was, owing its stop.
		const back = await runningOn(root, api, a, "disk");
		const staged = b.calls.filter((call) => call.method === "sandbox.import").length;
		b.refuse = (method, params) =>
			method === "sandbox.import" && params.stage === true ? { code: "unavailable", message: "no room" } : undefined;
		release = holding(b, (method) => method === "sandbox.import");
		moving = root.moveSandbox(back.id, { keepMemory: false });
		await vi.waitFor(() =>
			expect(b.calls.filter((call) => call.method === "sandbox.import").length).toBeGreaterThan(staged),
		);
		await owe(back.id);
		release();
		await failure(moving);
		expect(await api.store.sandboxes.get(back.id)).toMatchObject({
			state: "running",
			hostId: a.hostId,
			stopFor: "Its person left the organisation",
		});
	});

	it("still owes a stop the sandbox owed as its move began, once it runs where it went", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_RUNNING);
		const b = await join(MOVES_RUNNING);
		const sandbox = await runningOn(root, api, a, "disk");
		await api.store.sandboxes.update(sandbox.id, (latest) => ({
			...latest,
			stopFor: "Its person left the organisation",
		}));
		expect(await root.moveSandbox(sandbox.id, { keepMemory: false })).toMatchObject({ hostId: b.hostId });
		expect(await api.store.sandboxes.get(sandbox.id)).toMatchObject({ stopFor: "Its person left the organisation" });
	});
});

const MOVES_MEMORY = [...MOVES_RUNNING, HOST_FEATURES.sandboxMoveMemory];
const MOVES_COMMANDS = [...MOVES_MEMORY, HOST_FEATURES.execControl];
/** The ID of the foreground command `host` was sent for the sandbox, once it has been. */
async function foregroundId(host: FakeHost, sandboxId: string): Promise<string> {
	let id: unknown;
	await vi.waitFor(() => {
		id = host.calls.findLast(
			(call) => call.method === "sandbox.exec" && call.params.sandboxId === sandboxId && call.params.detached !== true,
		)?.params.commandId;
		expect(typeof id).toBe("string");
	});
	return id as string;
}
const RUNTIME = "firecracker=v1.17.0;kernel=6.1.155;sticky=2";
const AX102 = { vendor: "AuthenticAMD", family: 25, model: 97, featuresHash: "sha256:0123456789abcdef" };
/** A host's CPU and runtime fingerprints: AX102's and `RUNTIME`, else as `more` says. */
const fingerprints = (more: Partial<HostFacts> = {}): Partial<HostFacts> => ({
	cpu: AX102,
	runtimes: [{ image: "host-images-20261103", runtime: RUNTIME }],
	...more,
});

describe("moving a sandbox with its memory", () => {
	it("keeps a running sandbox's processes between hosts whose CPU and runtime match", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_MEMORY, undefined, fingerprints());
		const b = await join(MOVES_MEMORY, undefined, fingerprints());
		const sandbox = await runningOn(root, api, a, "disk");
		a.processes.set(sandbox.id, "a job started before the move");
		const moved = await root.moveSandbox(sandbox.id, {});
		expect(moved).toMatchObject({ state: "running", hostId: b.hostId, moved: { keptMemory: true } });
		expect(moved.moved?.restartReason).toBeUndefined();
		expect(b.processes.get(sandbox.id)).toBe("a job started before the move");
		// Stopped keeping its memory, exported with it, imported with it, and resumed from it.
		expect(
			a.calls.find((call) => call.method === "sandbox.stop" && call.params.sandboxId === sandbox.id)?.params,
		).toMatchObject({ memory: true });
		expect(
			a.calls.find((call) => call.method === "sandbox.export" && call.params.base !== undefined)?.params,
		).toMatchObject({
			memory: true,
		});
		const imported = b.calls.find((call) => call.method === "sandbox.import" && call.params.stage !== true);
		expect(imported?.params.memory).toMatchObject({ holders: [{ hostId: a.hostId }] });
		const booted = b.calls.filter((call) => call.method === "sandbox.start" || call.method === "sandbox.resume");
		expect(booted.map((call) => call.method)).toEqual(["sandbox.resume"]);
		expect(a.sandboxes.has(sandbox.id)).toBe(false);
	});

	it("keeps its commands running when its memory goes, and ends them when it restarts", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_MEMORY, undefined, fingerprints());
		await join(MOVES_MEMORY, undefined, fingerprints());
		await join(MOVES_MEMORY, undefined, fingerprints());
		const sandbox = await runningOn(root, api, a, "disk");
		const accountId = (await api.store.sandboxes.get(sandbox.id))?.accountId ?? "";
		const command = (id: string) => ({
			id,
			sandboxId: sandbox.id,
			accountId,
			command: "./serve",
			state: "running" as const,
			stdout: "",
			stderr: "",
			truncated: false,
			startedAt: Date.now(),
			detached: true,
		});
		await api.store.commands.put(command("cmd_kept"));
		await root.moveSandbox(sandbox.id, {});
		expect((await api.store.commands.get("cmd_kept"))?.state).toBe("running");
		await api.store.commands.put(command("cmd_ended"));
		await root.moveSandbox(sandbox.id, { keepMemory: false });
		expect(await api.store.commands.get("cmd_ended")).toMatchObject({
			state: "killed",
			stderr: expect.stringContaining("moved to another host and restarted there (the move was asked to restart it)"),
		});
	});

	it("carries a foreground and a detached command on by their IDs, their output, end and kill on the new host", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		const b = await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = b.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		const detached = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		const foreground = root.runCommand(sandbox.id, { command: "./build", timeoutMs: 60_000 });
		const id = await foregroundId(a, sandbox.id);
		const moved = await root.moveSandbox(sandbox.id, {});
		expect(moved).toMatchObject({ hostId: b.hostId, moved: { keptMemory: true } });
		// The foreground call broke with A's stop: followed by its ID, on B, to its end there.
		await vi.waitFor(
			() =>
				expect(b.calls.some((call) => call.method === "sandbox.exec.get" && call.params.commandId === id)).toBe(true),
			{ timeout: 10_000 },
		);
		FakeHost.endCommand(sandbox.id, id, { exitCode: 0, stdout: "so far\nbuilt\n", stderr: "", durationMs: 9 });
		expect(await foreground).toMatchObject({ id, state: "exited", exitCode: 0, stdout: "so far\nbuilt\n" });
		// The detached one runs on, on B: its output so far from there, and its kill goes there.
		expect(await root.getCommand(sandbox.id, detached.id)).toMatchObject({ state: "running", stdout: "so far\n" });
		expect(await root.killCommand(sandbox.id, detached.id)).toMatchObject({ state: "killed" });
		expect(b.calls.some((call) => call.method === "sandbox.exec.kill" && call.params.commandId === detached.id)).toBe(
			true,
		);
		expect(FakeHost.guestCommands.get(`${sandbox.id}/${detached.id}`)?.result?.exitCode).toBe(137);
	}, 20_000);

	it("ends a foreground command its guest didn't carry on (an image from before) saying so, and one a restart ended", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		const b = await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = b.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		const lost = root.runCommand(sandbox.id, { command: "./build", timeoutMs: 60_000 });
		const id = await foregroundId(a, sandbox.id);
		// Its guest ended it as its connection was reset: B's doesn't know it.
		b.hold = (method) => {
			if (method === "sandbox.resume") FakeHost.guestCommands.delete(`${sandbox.id}/${id}`);
			return undefined;
		};
		await root.moveSandbox(sandbox.id, {});
		expect(await lost).toMatchObject({ id, state: "exited", exitCode: 1, stderr: `${SUSPENDED_COMMAND_LOST}\n` });
		// Moved with a restart: its command ends, as its call broke or as the move ended its commands, saying why.
		const ended = root.runCommand(sandbox.id, { command: "./build", timeoutMs: 60_000 });
		const restarted = await foregroundId(b, sandbox.id);
		await root.moveSandbox(sandbox.id, { keepMemory: false });
		expect(await ended).toMatchObject({
			id: restarted,
			state: expect.stringMatching(/^(exited|killed)$/),
			stderr: expect.stringMatching(/restart(ed| it) there \(the move was asked to restart it\)/),
		});
	}, 20_000);

	it("asks again where it runs now when its old host, asked as it moved, no longer knows a command", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		const b = await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = b.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		const detached = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		// A get A takes as the move begins is answered once the sandbox is B's, and A has deleted it.
		let switched: () => void = () => undefined;
		const done = new Promise<void>((resolve) => {
			switched = resolve;
		});
		await vi.waitFor(() => expect(a.calls.some((call) => call.method === "sandbox.exec.get")).toBe(true));
		a.hold = (method) => (method === "sandbox.exec.get" ? done : undefined);
		a.refuse = (method) =>
			method === "sandbox.exec.get" ? { code: "not_found", message: "no such sandbox" } : undefined;
		await vi.waitFor(
			() => expect(a.calls.filter((call) => call.method === "sandbox.exec.get").length).toBeGreaterThan(1),
			{
				timeout: 5_000,
			},
		);
		await root.moveSandbox(sandbox.id, {});
		switched();
		await vi.waitFor(
			() =>
				expect(
					b.calls.some((call) => call.method === "sandbox.exec.get" && call.params.commandId === detached.id),
				).toBe(true),
			{ timeout: 10_000 },
		);
		FakeHost.endCommand(sandbox.id, detached.id, { exitCode: 0, stdout: "served\n", stderr: "", durationMs: 9 });
		await vi.waitFor(
			async () =>
				expect(await root.getCommand(sandbox.id, detached.id)).toMatchObject({ state: "exited", exitCode: 0 }),
			{
				timeout: 10_000,
			},
		);
	}, 20_000);

	it("is given up, nothing sent, when what it does with the memory can't be recorded; else left to settle", async () => {
		const { root, api, join, service, store } = await setup();
		const a = await join(MOVES_MEMORY, undefined, fingerprints());
		const b = await join(MOVES_MEMORY, undefined, fingerprints());
		const sandbox = await runningOn(root, api, a, "disk");
		const input = {
			operationId: "mov_unrecorded",
			owner: (await api.store.sandboxes.get(sandbox.id))?.accountId ?? "",
			hostIds: [b.hostId],
			running: true,
			keepMemory: true,
			start: () => ({ params: {} }),
			onPlanned: async () => {
				throw new Error("the record changed");
			},
		};
		await expect(service.sandboxes.move(sandbox.id, input)).rejects.toThrow("the record changed");
		expect((await store.getPlacement(sandbox.id))?.move).toBeUndefined();
		expect(methodsOf(a, sandbox.id)).not.toContain("sandbox.export");
		expect(methodsOf(b, sandbox.id)).toHaveLength(0);
		// Its intent can't be cleared: the move's outcome is unknown, for its settling, not a failure.
		const update = store.updatePlacement.bind(store);
		let writes = 0;
		store.updatePlacement = async (id, change) => {
			writes += 1;
			if (writes > 1) throw new Error("the store went away");
			return update(id, change);
		};
		const unknown = await service.sandboxes
			.move(sandbox.id, { ...input, operationId: "mov_unclear" })
			.catch((error) => error);
		store.updatePlacement = update;
		expect(unknown).toBeInstanceOf(Error);
		expect(String(unknown.message)).toContain("settled instead");
		expect((await store.getPlacement(sandbox.id))?.move?.operationId).toBe("mov_unclear");
		expect(methodsOf(a, sandbox.id)).not.toContain("sandbox.export");
		await expect(service.sandboxes.settleMove(sandbox.id, "mov_unclear")).resolves.toMatchObject({ state: "failed" });
		expect((await store.getPlacement(sandbox.id))?.move).toBeUndefined();
	});

	it("restarts it between hosts whose CPUs differ, and says why before it copies anything", async () => {
		const { root, api, join, store } = await setup();
		const a = await join(MOVES_MEMORY, undefined, fingerprints());
		const b = await join(MOVES_MEMORY, undefined, fingerprints({ cpu: { ...AX102, model: 68 } }));
		const sandbox = await runningOn(root, api, a, "disk");
		a.processes.set(sandbox.id, "a job");
		// Held at its first copy: by then its move says it restarts, and why.
		const release = holding(a, (method, params) => method === "sandbox.export" && params.live === true);
		const moving = root.moveSandbox(sandbox.id, { wait: false });
		await vi.waitFor(async () =>
			expect((await root.getSandbox(sandbox.id)).move).toMatchObject({ keepMemory: false, hostId: b.hostId }),
		);
		expect((await root.getSandbox(sandbox.id)).move?.restartReason).toContain("CPU");
		expect(methodsOf(b, sandbox.id)).toHaveLength(0);
		release();
		await moving;
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("running"));
		const moved = await root.getSandbox(sandbox.id);
		expect(moved).toMatchObject({ hostId: b.hostId, moved: { keptMemory: false } });
		expect(moved.moved?.restartReason).toContain("CPU");
		// It names no host: callers who may not know its hosts read it too.
		for (const host of [a, b]) {
			const name = (await store.getHost(host.hostId))?.name ?? host.hostId;
			expect(moved.moved?.restartReason).not.toContain(name);
		}
		expect(b.processes.get(sandbox.id)).toBe("booted");
		expect(a.calls.find((call) => call.method === "sandbox.stop")?.params).toMatchObject({ memory: false });
		expect(b.calls.some((call) => call.method === "sandbox.start")).toBe(true);
	});

	it("restarts it where the target hasn't its memory's runtime, or a host can't move memory", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_MEMORY, undefined, fingerprints());
		const other = await join(
			MOVES_MEMORY,
			undefined,
			fingerprints({ runtimes: [{ image: "x", runtime: `${RUNTIME};x` }] }),
		);
		const older = await join(MOVES_RUNNING, undefined, fingerprints());
		const sandbox = await runningOn(root, api, a, "disk");
		const toOther = await root.moveSandbox(sandbox.id, { hostId: other.hostId });
		expect(toOther.moved).toMatchObject({ keptMemory: false });
		expect(toOther.moved?.restartReason).toContain("runtime");
		const back = await runningOn(root, api, a, "disk");
		const toOlder = await root.moveSandbox(back.id, { hostId: older.hostId });
		expect(toOlder.moved?.restartReason).toContain("upgrade its kantel-host");
	});

	it("chooses a host it keeps its memory on first", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_MEMORY, undefined, fingerprints());
		await join(MOVES_MEMORY, undefined, fingerprints({ cpu: { ...AX102, model: 68 } }));
		const c = await join(MOVES_MEMORY, undefined, fingerprints());
		const sandbox = await runningOn(root, api, a, "disk");
		a.processes.set(sandbox.id, "a job");
		const moved = await root.moveSandbox(sandbox.id, {});
		expect(moved).toMatchObject({ hostId: c.hostId, moved: { keptMemory: true } });
		expect(c.processes.get(sandbox.id)).toBe("a job");
	});

	it("moves a paused sandbox with its memory, and a restart asked for lets it go", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_MEMORY, undefined, fingerprints());
		const b = await join(MOVES_MEMORY, undefined, fingerprints());
		const paused = await runningOn(root, api, a, "disk");
		a.processes.set(paused.id, "paused job");
		await root.stopSandbox(paused.id, { keepMemory: true, wait: true });
		const moved = await root.moveSandbox(paused.id, {});
		expect(moved).toMatchObject({ state: "running", hostId: b.hostId, moved: { keptMemory: true } });
		expect(b.processes.get(paused.id)).toBe("paused job");
		const restarted = await runningOn(root, api, a, "disk");
		a.processes.set(restarted.id, "a job");
		const fresh = await root.moveSandbox(restarted.id, { keepMemory: false });
		expect(fresh.moved).toEqual({ at: expect.any(Number), keptMemory: false });
		expect(b.processes.get(restarted.id)).toBe("booted");
	});

	it("rolled back after its stop, resumes it where it was from its memory", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_MEMORY, undefined, fingerprints());
		const b = await join(MOVES_MEMORY, undefined, fingerprints());
		const sandbox = await runningOn(root, api, a, "disk");
		a.processes.set(sandbox.id, "a job");
		b.refuse = (method, params) =>
			method === "sandbox.import" && params.stage !== true ? { code: "unavailable", message: "no room" } : undefined;
		expect((await failure(root.moveSandbox(sandbox.id, {}))).code).toBe("unavailable");
		await vi.waitFor(async () =>
			expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "running", hostId: a.hostId }),
		);
		expect(a.processes.get(sandbox.id)).toBe("a job");
		// Resumed from the memory its move's stop kept, never booted on its disk.
		const again = a.calls.filter(
			(call) =>
				(call.method === "sandbox.resume" || call.method === "sandbox.start") && call.params.sandboxId === sandbox.id,
		);
		expect(again.map((call) => call.method)).toEqual(["sandbox.resume"]);
		expect(b.sandboxes.has(sandbox.id)).toBe(false);
	});

	it("answers a dry run with each host's way and estimated pause, moving nothing", async () => {
		const { root, api, join, store } = await setup();
		const a = await join(MOVES_MEMORY, undefined, fingerprints());
		const b = await join(MOVES_MEMORY, undefined, fingerprints());
		const c = await join(MOVES_MEMORY, undefined, fingerprints({ cpu: { ...AX102, model: 68 } }));
		const sandbox = await runningOn(root, api, a, "disk");
		// b measured its last fetch from a at 250 MB/s.
		await store.updateHost(b.hostId, (host) => ({
			...host,
			capacity: {
				freeMemoryMiB: 30_000,
				freeDiskGiB: 400,
				running: 0,
				stopped: 0,
				load1: 0,
				...host.capacity,
				mesh: {
					address: "fd00::2",
					peers: [{ hostId: a.hostId, path: "direct", fetchBytesPerSecond: 250_000_000, fetchRateAt: 1 }],
				},
			},
		}));
		const plan = await root.planSandboxMove(sandbox.id);
		const byHost = new Map((plan.targets ?? []).map((target) => [target.hostId, target]));
		expect([...byHost.keys()].sort()).toEqual([b.hostId, c.hostId].sort());
		// 512 MiB of resident memory at 250 MB/s, as b measured it.
		expect(byHost.get(b.hostId)).toEqual({
			hostId: b.hostId,
			keepsMemory: true,
			pauseMs: Math.ceil((512 * 1024 * 1024 * 1000) / 250_000_000),
			memoryBytes: 512 * 1024 * 1024,
			bytesPerSecond: 250_000_000,
			rateMeasured: true,
		});
		expect(byHost.get(c.hostId)?.keepsMemory).toBe(false);
		expect(byHost.get(c.hostId)?.restartReason).toContain("CPU");
		expect(byHost.get(c.hostId)?.pauseMs).toBeUndefined();
		expect(methodsOf(a, sandbox.id)).not.toContain("sandbox.export");
		expect(await api.store.sandboxes.get(sandbox.id)).toMatchObject({ state: "running" });
		expect((await api.store.sandboxes.get(sandbox.id))?.moving).toBeUndefined();
		// A stopped sandbox has no memory: every host restarts it.
		const stopped = await stoppedOn(root, a, "disk");
		await unpinned(api, stopped.id);
		const stoppedPlan = await root.planSandboxMove(stopped.id);
		expect(stoppedPlan.targets?.every((target) => !target.keepsMemory && target.restartReason === undefined)).toBe(
			true,
		);
	});
});

describe("pausing a sandbox keeps its commands running", () => {
	/**
	 * A detached command its guest runs, recorded as started `ageMs` ago: past `LOST_COMMAND_MS` (60 s), one its
	 * backend no longer knows is taken as lost when it is asked for it.
	 */
	async function olderCommand(api: ComputeApi, sandboxId: string, id: string, ageMs = 120_000) {
		const sandbox = await api.store.sandboxes.get(sandboxId);
		await api.store.commands.put({
			id,
			sandboxId,
			accountId: sandbox?.accountId ?? "",
			command: "./serve",
			state: "running",
			stdout: "",
			stderr: "",
			truncated: false,
			startedAt: Date.now() - ageMs,
			detached: true,
			// In the memory it runs in now, as a command started through Kantel is.
			...(sandbox?.memoryDropped === undefined ? {} : { memoryGeneration: sandbox.memoryDropped.generation }),
		});
		FakeHost.guestCommands.set(`${sandboxId}/${id}`, { commandId: id, state: "running", stdout: "so far\n" });
	}

	it("carries them on through a pause to their real ends, output and kills once it resumes", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		const detached = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		const killedPaused = await root.runCommand(sandbox.id, { command: "./watch", detached: true });
		await olderCommand(api, sandbox.id, "cmd_older");
		const foreground = root.runCommand(sandbox.id, { command: "./build", timeoutMs: 60_000 });
		const id = await foregroundId(a, sandbox.id);
		await root.stopSandbox(sandbox.id, { keepMemory: true, wait: true });
		expect((await root.getSandbox(sandbox.id)).state).toBe("paused");
		for (const each of [id, detached.id, killedPaused.id, "cmd_older"]) {
			expect((await api.store.commands.get(each))?.state).toBe("running");
		}
		// Asked while it is paused (its host can't ask its guest): running still, an old one never taken as lost.
		expect(await root.getCommand(sandbox.id, detached.id)).toMatchObject({ state: "running" });
		expect(await root.getCommand(sandbox.id, "cmd_older")).toMatchObject({ state: "running" });
		// Killed while it is paused: killed, and its kill reaches the command once it resumes.
		expect(await root.killCommand(sandbox.id, killedPaused.id)).toMatchObject({ state: "killed" });
		expect(FakeHost.guestCommands.get(`${sandbox.id}/${killedPaused.id}`)?.state).toBe("running");
		await root.resumeSandbox(sandbox.id, { wait: true });
		await vi.waitFor(() =>
			expect(FakeHost.guestCommands.get(`${sandbox.id}/${killedPaused.id}`)?.result?.exitCode).toBe(137),
		);
		await vi.waitFor(async () => expect((await api.store.commands.get(killedPaused.id))?.killPending).toBeUndefined());
		// The call waiting on the foreground one gets its real end, once it has resumed.
		FakeHost.endCommand(sandbox.id, id, { exitCode: 2, stdout: "so far\nfailed\n", stderr: "", durationMs: 9 });
		expect(await foreground).toMatchObject({ id, state: "exited", exitCode: 2, stdout: "so far\nfailed\n" });
		// The detached ones run on: their output so far, their ends, and their kills.
		expect(await root.getCommand(sandbox.id, detached.id)).toMatchObject({ state: "running", stdout: "so far\n" });
		expect(await root.killCommand(sandbox.id, detached.id)).toMatchObject({ state: "killed" });
		expect(FakeHost.guestCommands.get(`${sandbox.id}/${detached.id}`)?.result?.exitCode).toBe(137);
		FakeHost.endCommand(sandbox.id, "cmd_older", { exitCode: 0, stdout: "served\n", stderr: "", durationMs: 9 });
		expect(await root.getCommand(sandbox.id, "cmd_older")).toMatchObject({ state: "exited", exitCode: 0 });
	}, 20_000);

	/**
	 * A sandbox on a host that keeps commands, with commands started before it is paused (`older` of them older than
	 * 60 s, the rest started now), paused; and its commands' writes as `wrap` makes them from then on, every write that
	 * puts one back to running after it was killed noted.
	 */
	async function pausedWith(older: readonly string[], fresh: number) {
		const { root, api, join } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		const ids = [...older];
		for (const id of older) await olderCommand(api, sandbox.id, id);
		for (let i = 0; i < fresh; i++) {
			ids.push((await root.runCommand(sandbox.id, { command: `./job-${i}`, detached: true })).id);
		}
		await root.stopSandbox(sandbox.id, { keepMemory: true, wait: true });
		const update = api.store.commands.update.bind(api.store.commands);
		const revived: string[] = [];
		let wrap: ((...args: Parameters<typeof update>) => ReturnType<typeof update>) | undefined;
		api.store.commands.update = async (...args) => {
			const before = await api.store.commands.get(args[0]);
			const written = await (wrap ?? update)(...args);
			if (before?.state === "killed" && written?.state === "running") revived.push(args[0]);
			return written;
		};
		return {
			root,
			api,
			a,
			sandbox,
			ids,
			update,
			revived,
			wrapWith: (next: typeof wrap) => {
				wrap = next;
			},
		};
	}

	const startedAfresh = expect.stringContaining(
		"started afresh from its disk, which let go of the memory it was paused with",
	);

	it("starts from paused though none of its kills can be written, and each read then kills them, not one started since", async () => {
		const { root, api, sandbox, ids, revived, wrapWith } = await pausedWith(["cmd_old_a", "cmd_old_b"], 1);
		// Every kill fails, and every write putting one back would too: nothing is put back, and the start goes on.
		wrapWith(async () => {
			throw new Error("the store went away");
		});
		await root.startSandbox(sandbox.id, { wait: true });
		wrapWith(undefined);
		expect((await root.getSandbox(sandbox.id)).state).toBe("running");
		expect((await api.store.sandboxes.get(sandbox.id))?.memoryDropped?.generation).toBe(1);
		for (const id of ids) expect((await api.store.commands.get(id))?.state).toBe("running");
		// Started on its new machine, after its memory went: of the new memory, never killed with the old.
		const later = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		expect((await api.store.commands.get(later.id))?.memoryGeneration).toBe(1);
		// A get, a list and a kill each kill those of the memory let go, saying why, and never take one older than 60 s
		// as lost.
		expect(await root.getCommand(sandbox.id, "cmd_old_a")).toMatchObject({ state: "killed", stderr: startedAfresh });
		const listed = (await root.listCommands(sandbox.id)).items;
		expect(listed.find((command) => command.id === "cmd_old_b")).toMatchObject({
			state: "killed",
			stderr: startedAfresh,
		});
		expect(listed.find((command) => command.id === later.id)?.state).toBe("running");
		expect(await root.killCommand(sandbox.id, ids[2] ?? "")).toMatchObject({ state: "killed", stderr: startedAfresh });
		await api.service.sweep();
		expect((await api.store.commands.get(later.id))?.state).toBe("running");
		expect(revived).toEqual([]);
	}, 20_000);

	it("keeps a foreground call waiting when its end can't be checked against its memory, to its kill", async () => {
		const { root, api, a, sandbox, revived, wrapWith } = await pausedWith([], 0);
		await root.resumeSandbox(sandbox.id, { wait: true });
		const foreground = root.runCommand(sandbox.id, { command: "./build", timeoutMs: 60_000 });
		const id = await foregroundId(a, sandbox.id);
		await root.stopSandbox(sandbox.id, { keepMemory: true, wait: true });
		// Started afresh, every command write failing for a while: the start's kill, and the call's own check of the end
		// its follow reads (its new machine doesn't know it), can't be written.
		wrapWith(async () => {
			throw new Error("the store went away");
		});
		await root.startSandbox(sandbox.id, { wait: true });
		await vi.waitFor(
			() =>
				expect(
					a.calls.filter((call) => call.method === "sandbox.exec.get" && call.params.commandId === id).length,
				).toBeGreaterThan(1),
			{ timeout: 10_000 },
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect((await api.store.commands.get(id))?.state).toBe("running");
		wrapWith(undefined);
		expect(await foreground).toMatchObject({ id, state: "killed", stderr: startedAfresh });
		expect(revived).toEqual([]);
	}, 30_000);

	it("runs a command whose start read the sandbox before a start from paused on the new machine, of the new memory", async () => {
		const { root, api, sandbox } = await pausedWith(["cmd_old"], 0);
		await root.resumeSandbox(sandbox.id, { wait: true });
		// As the command is being admitted (its account read), the sandbox is paused and started afresh.
		const accounts = api.store.accounts.get.bind(api.store.accounts);
		let raced = false;
		let admitting = false;
		api.store.accounts.get = async (id) => {
			if (admitting && !raced) {
				raced = true;
				await root.stopSandbox(sandbox.id, { keepMemory: true, wait: true });
				await root.startSandbox(sandbox.id, { wait: true });
			}
			return accounts(id);
		};
		admitting = true;
		const started = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		admitting = false;
		api.store.accounts.get = accounts;
		expect(raced).toBe(true);
		expect(await api.store.commands.get(started.id)).toMatchObject({ state: "running", memoryGeneration: 1 });
		expect(await root.getCommand(sandbox.id, started.id)).toMatchObject({ state: "running" });
		expect(await root.getCommand(sandbox.id, "cmd_old")).toMatchObject({ state: "killed", stderr: startedAfresh });
	}, 30_000);

	it("keeps a command's end read while its sandbox can't be, to record once it can, on a host that can't be asked again", async () => {
		const { root, api, join } = await setup();
		// Commands aren't kept by ID here: its end is only what its call answers.
		const a = await join(MOVES_MEMORY, undefined, fingerprints());
		const sandbox = await runningOn(root, api, a, "disk");
		const get = api.store.sandboxes.get.bind(api.store.sandboxes);
		let failing = 0;
		api.store.sandboxes.get = async (id) => {
			if (failing > 0) {
				failing -= 1;
				throw new Error("the store went away");
			}
			return get(id);
		};
		// As its call is answered, its sandbox can't be read twice.
		a.hold = (method) => {
			if (method === "sandbox.exec") failing = 2;
			return undefined;
		};
		expect(await root.runCommand(sandbox.id, { command: "echo hi" })).toMatchObject({
			state: "exited",
			exitCode: 0,
			stdout: "hi\n",
		});
		expect(failing).toBe(0);
	}, 20_000);

	it("leaves them running when a start from paused fails to boot, through a resume from error", async () => {
		const { root, api, a, sandbox, ids } = await pausedWith(["cmd_old"], 1);
		// Its host refuses the fresh boot: the memory it was paused with is still there.
		a.refuse = (method) => (method === "sandbox.start" ? { code: "internal", message: "no room to boot" } : undefined);
		await root.startSandbox(sandbox.id, { wait: true }).catch(() => undefined);
		a.refuse = undefined;
		const failed = await api.store.sandboxes.get(sandbox.id);
		expect(failed?.state).toBe("error");
		expect(failed?.memoryDropped).toBeUndefined();
		expect(failed?.memoryDropping).toBeUndefined();
		for (const id of ids) expect(await root.getCommand(sandbox.id, id)).toMatchObject({ state: "running" });
		// Resumed from that memory: its commands run on, followed and killed by their IDs.
		await root.resumeSandbox(sandbox.id, { wait: true });
		for (const id of ids) expect(FakeHost.guestCommands.get(`${sandbox.id}/${id}`)?.state).toBe("running");
		for (const id of ids) {
			expect(await root.getCommand(sandbox.id, id)).toMatchObject({ state: "running", stdout: "so far\n" });
		}
		expect(await root.killCommand(sandbox.id, ids[1] ?? "")).toMatchObject({ state: "killed" });
		expect(FakeHost.guestCommands.get(`${sandbox.id}/${ids[1]}`)?.result?.exitCode).toBe(137);
	}, 20_000);

	it("keeps a real end its source answers as a running sandbox's restart move is stopping it", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		const foreground = root.runCommand(sandbox.id, { command: "./build", timeoutMs: 60_000 });
		const id = await foregroundId(a, sandbox.id);
		// Its source asked to stop (the move `stopping`): the command ends there first, and its call is answered.
		const release = holding(a, (method) => method === "sandbox.stop");
		const moving = root.moveSandbox(sandbox.id, { keepMemory: false });
		await vi.waitFor(() => expect(a.calls.some((call) => call.method === "sandbox.stop")).toBe(true));
		expect((await api.store.sandboxes.get(sandbox.id))?.moving?.phase).toBe("stopping");
		FakeHost.endCommand(sandbox.id, id, { exitCode: 0, stdout: "so far\nbuilt\n", stderr: "", durationMs: 9 });
		expect(await foreground).toMatchObject({ id, state: "exited", exitCode: 0, stdout: "so far\nbuilt\n" });
		release();
		await moving;
		expect((await api.store.commands.get(id))?.state).toBe("exited");
	}, 20_000);

	it("lets a foreground call's wait go when the gateway closes as it waits for a paused restart move", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		const b = await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = b.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		const foreground = root.runCommand(sandbox.id, { command: "./build", timeoutMs: 60_000 });
		const id = await foregroundId(a, sandbox.id);
		await root.stopSandbox(sandbox.id, { keepMemory: true, wait: true });
		// Its commit held once its new machine runs, until the gateway has closed: the call's follow has asked that
		// machine, which doesn't know it, and waits (`awaitedEnd`).
		let started = false;
		b.hold = (method) => {
			if (method === "sandbox.start") started = true;
			return undefined;
		};
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const update = api.store.sandboxes.update.bind(api.store.sandboxes);
		api.store.sandboxes.update = async (...args) => {
			if (started && args[0] === sandbox.id) await held;
			return update(...args);
		};
		const moved = root.moveSandbox(sandbox.id, { keepMemory: false }).catch(() => undefined);
		await vi.waitFor(
			() =>
				expect(b.calls.some((call) => call.method === "sandbox.exec.get" && call.params.commandId === id)).toBe(true),
			{ timeout: 10_000 },
		);
		await new Promise((resolve) => setTimeout(resolve, 500));
		const closing = api.close();
		expect(await foreground).toMatchObject({ id, state: "running" });
		release();
		await moved;
		await closing;
	}, 30_000);

	it("lets a call's wait go when the gateway closes as it asks again whether its end may be recorded", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_MEMORY, undefined, fingerprints());
		const sandbox = await runningOn(root, api, a, "disk");
		const get = api.store.sandboxes.get.bind(api.store.sandboxes);
		let failing = false;
		api.store.sandboxes.get = async (id) => {
			if (failing) throw new Error("the store went away");
			return get(id);
		};
		a.hold = (method) => {
			if (method === "sandbox.exec") failing = true;
			return undefined;
		};
		const call = root.runCommand(sandbox.id, { command: "echo hi" });
		await vi.waitFor(() => expect(failing).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 300));
		const closing = api.close();
		expect(await call).toMatchObject({ state: "running" });
		failing = false;
		await closing;
	}, 20_000);

	it("lets its memory go, killing its commands with the reason, when a fresh start's egress can't be applied", async () => {
		const { root, api, a, sandbox, ids } = await pausedWith(["cmd_old"], 0);
		// As it boots fresh, its egress changes, and its host refuses the change: its start stops it instead.
		a.hold = (method, params) => {
			if (method === "sandbox.start" && params.sandboxId === sandbox.id) {
				void api.store.sandboxes.update(sandbox.id, (latest) => ({
					...latest,
					egressRevision: (latest.egressRevision ?? 0) + 1,
				}));
				a.refuse = (refused) =>
					refused === "sandbox.egress" ? { code: "not_supported", message: "no egress policy here" } : undefined;
			}
			return undefined;
		};
		await root.startSandbox(sandbox.id, { wait: true }).catch(() => undefined);
		await vi.waitFor(async () => expect((await api.store.sandboxes.get(sandbox.id))?.state).toBe("stopped"), {
			timeout: 10_000,
		});
		expect((await api.store.sandboxes.get(sandbox.id))?.memoryDropped?.generation).toBe(1);
		expect(await api.store.commands.get(ids[0] ?? "")).toMatchObject({ state: "killed", stderr: startedAfresh });
	}, 20_000);

	it("kills a foreground command whose call broke as a running sandbox's restart move stopped it, with the reason", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		const foreground = root.runCommand(sandbox.id, { command: "./build", timeoutMs: 60_000 });
		const id = await foregroundId(a, sandbox.id);
		// The move's kills, and its record's `final-copy`, are slow to land: the call's failure, as the stop breaks it,
		// comes first, while its record still says `stopping`.
		const patch = api.store.sandboxes.update.bind(api.store.sandboxes);
		api.store.sandboxes.update = async (sandboxId, change, ...rest) => {
			const read = await api.store.sandboxes.get(sandboxId);
			if (read !== undefined && change(structuredClone(read))?.moving?.phase === "final-copy") {
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
			return patch(sandboxId, change, ...rest);
		};
		const update = api.store.commands.update.bind(api.store.commands);
		api.store.commands.update = async (commandId, change) => {
			const read = await api.store.commands.get(commandId);
			if (read !== undefined && change(structuredClone(read))?.state === "killed") {
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
			return update(commandId, change);
		};
		await root.moveSandbox(sandbox.id, { keepMemory: false });
		expect(await foreground).toMatchObject({
			id,
			state: "killed",
			stderr: expect.stringContaining("restarted there (the move was asked to restart it)"),
		});
	}, 30_000);

	it("kills a detached command its new machine doesn't know as a running sandbox's restart move ends, with the reason", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		const b = await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = b.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		const detached = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		// Once its source is asked to stop, its record's writes and the move's kills are slow, until its follow has asked
		// its new machine, which doesn't know it: its record still says `stopping` then.
		let stopped = false;
		a.hold = (method) => {
			if (method === "sandbox.stop") stopped = true;
			return undefined;
		};
		const askedNew = () =>
			vi.waitFor(
				() =>
					expect(
						b.calls.some((call) => call.method === "sandbox.exec.get" && call.params.commandId === detached.id),
					).toBe(true),
				{ timeout: 15_000 },
			);
		const slow = async () => {
			await askedNew();
			await new Promise((resolve) => setTimeout(resolve, 300));
		};
		const patch = api.store.sandboxes.update.bind(api.store.sandboxes);
		api.store.sandboxes.update = async (sandboxId, change, ...rest) => {
			if (stopped && sandboxId === sandbox.id) await slow();
			return patch(sandboxId, change, ...rest);
		};
		const update = api.store.commands.update.bind(api.store.commands);
		api.store.commands.update = async (commandId, change) => {
			const read = await api.store.commands.get(commandId);
			if (stopped && read !== undefined && change(structuredClone(read))?.state === "killed") await slow();
			return update(commandId, change);
		};
		await root.moveSandbox(sandbox.id, { keepMemory: false });
		await vi.waitFor(async () =>
			expect(await api.store.commands.get(detached.id)).toMatchObject({
				state: "killed",
				stderr: expect.stringContaining("restarted there (the move was asked to restart it)"),
			}),
		);
	}, 30_000);

	it("kills them by the sweep when a start's kills failed and nobody reads them", async () => {
		const { root, api, sandbox, ids, wrapWith } = await pausedWith(["cmd_old_a"], 1);
		wrapWith(async () => {
			throw new Error("the store went away");
		});
		await root.startSandbox(sandbox.id, { wait: true });
		wrapWith(undefined);
		const later = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		await api.service.sweep();
		for (const id of ids) {
			await vi.waitFor(async () =>
				expect(await api.store.commands.get(id)).toMatchObject({ state: "killed", stderr: startedAfresh }),
			);
		}
		expect((await api.store.commands.get(later.id))?.state).toBe("running");
	}, 20_000);

	it("keeps a kill that was written but answered as failed, and kills the rest, putting none back", async () => {
		const { root, sandbox, ids, update, revived, wrapWith } = await pausedWith(["cmd_old_a", "cmd_old_b"], 0);
		// The first kill lands but answers an error.
		let first = true;
		wrapWith(async (...args) => {
			const written = await update(...args);
			if (first) {
				first = false;
				throw new Error("the answer was lost");
			}
			return written;
		});
		await root.startSandbox(sandbox.id, { wait: true });
		wrapWith(undefined);
		for (const id of ids) {
			expect(await root.getCommand(sandbox.id, id)).toMatchObject({ state: "killed", stderr: startedAfresh });
		}
		expect(revived).toEqual([]);
	}, 20_000);

	it("keeps a kill someone makes while a start from paused is killing its commands", async () => {
		const { root, api, sandbox, ids, update, revived, wrapWith } = await pausedWith([], 2);
		const [raced, after] = ids;
		// As the start's first kill is about to be written, someone kills that command (it reads it running): theirs lands
		// first. The start's own then finds it killed and leaves it.
		let first = true;
		let answered: unknown;
		wrapWith(async (...args) => {
			if (first && args[0] === raced) {
				first = false;
				answered = await root.killCommand(sandbox.id, raced ?? "");
			}
			return update(...args);
		});
		await root.startSandbox(sandbox.id, { wait: true });
		wrapWith(undefined);
		expect(answered).toMatchObject({ state: "killed" });
		expect(await root.getCommand(sandbox.id, raced ?? "")).toMatchObject({ state: "killed" });
		// The other, killed by the start first: a kill of it then answers it killed, as it stays.
		expect(await root.killCommand(sandbox.id, after ?? "")).toMatchObject({ state: "killed", stderr: startedAfresh });
		expect((await api.store.commands.get(after ?? ""))?.state).toBe("killed");
		expect(revived).toEqual([]);
	}, 20_000);

	it("sends a kill made while it was paused as it resumes, though its publishing fails", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		const doomed = await root.runCommand(sandbox.id, { command: "./watch", detached: true });
		await root.stopSandbox(sandbox.id, { keepMemory: true, wait: true });
		expect(await root.killCommand(sandbox.id, doomed.id)).toMatchObject({ state: "killed" });
		// Its running event can't be stored: the resume fails once it is running.
		const put = api.store.events.put.bind(api.store.events);
		api.store.events.put = async (event) => {
			if (event.type === "sandbox.running") throw new Error("the store went away");
			return put(event);
		};
		await root.resumeSandbox(sandbox.id, { wait: true }).catch(() => undefined);
		api.store.events.put = put;
		expect(FakeHost.guestCommands.get(`${sandbox.id}/${doomed.id}`)?.result?.exitCode).toBe(137);
		expect((await api.store.commands.get(doomed.id))?.killPending).toBeUndefined();
	}, 20_000);

	it("keeps a foreground call waiting through a paused restart move, to its kill", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		const b = await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = b.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		const foreground = root.runCommand(sandbox.id, { command: "./build", timeoutMs: 60_000 });
		const id = await foregroundId(a, sandbox.id);
		await root.stopSandbox(sandbox.id, { keepMemory: true, wait: true });
		// Its writes are slow once its new machine runs (its commit among them): meanwhile the call's follow asks that
		// machine, which doesn't know it.
		let started = false;
		b.hold = (method) => {
			if (method === "sandbox.start") started = true;
			return undefined;
		};
		const update = api.store.sandboxes.update.bind(api.store.sandboxes);
		let slowed = false;
		api.store.sandboxes.update = async (...args) => {
			if (started && !slowed && args[0] === sandbox.id) {
				slowed = true;
				await vi.waitFor(
					() =>
						expect(b.calls.some((call) => call.method === "sandbox.exec.get" && call.params.commandId === id)).toBe(
							true,
						),
					{ timeout: 10_000 },
				);
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			return update(...args);
		};
		await root.moveSandbox(sandbox.id, { keepMemory: false });
		expect(await foreground).toMatchObject({
			id,
			state: "killed",
			stderr: expect.stringContaining("restarted there (the move was asked to restart it)"),
		});
	}, 30_000);

	it("kills them, saying why, when a start, a stop or a delete lets its memory go, old ones too", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		const paused = async (id: string) => {
			await olderCommand(api, sandbox.id, id);
			await root.stopSandbox(sandbox.id, { keepMemory: true, wait: true });
			expect((await api.store.commands.get(id))?.state).toBe("running");
		};
		// Started afresh from its disk rather than resumed: none is asked of its new machine, which doesn't know them.
		const fresh = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		await paused("cmd_started");
		await root.startSandbox(sandbox.id, { wait: true });
		for (const id of [fresh.id, "cmd_started"]) {
			expect(await api.store.commands.get(id)).toMatchObject({
				state: "killed",
				stderr: expect.stringContaining("started afresh from its disk, which let go of the memory it was paused with"),
			});
		}
		await paused("cmd_stopped");
		await root.stopSandbox(sandbox.id, { wait: true });
		expect(await api.store.commands.get("cmd_stopped")).toMatchObject({
			state: "killed",
			stderr: expect.stringContaining("was stopped, which let go of the memory it was paused with"),
		});
		await root.resumeSandbox(sandbox.id, { wait: true });
		await paused("cmd_deleted");
		await root.deleteSandbox(sandbox.id);
		expect(await api.store.commands.get("cmd_deleted")).toMatchObject({
			state: "killed",
			stderr: expect.stringContaining("was deleted, which let go of the memory it was paused with"),
		});
	}, 20_000);

	it("kills them, saying why, when a paused sandbox moves with a restart, none started on its new machine", async () => {
		const { root, api, join, gateway } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		const b = await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = b.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		await olderCommand(api, sandbox.id, "cmd_paused");
		await root.stopSandbox(sandbox.id, { keepMemory: true, wait: true });
		// Its publication held after it is running: meanwhile another gateway starts a command on its new machine.
		const other = gateway();
		let started: string | undefined;
		const put = api.store.events.put.bind(api.store.events);
		api.store.events.put = async (event) => {
			if (event.type === "sandbox.running" && event.sandboxId === sandbox.id && started === undefined) {
				started = (await other.root.runCommand(sandbox.id, { command: "./serve", detached: true })).id;
			}
			return put(event);
		};
		const moved = await root.moveSandbox(sandbox.id, { keepMemory: false });
		expect(moved).toMatchObject({ state: "running", hostId: b.hostId, moved: { keptMemory: false } });
		expect(await api.store.commands.get("cmd_paused")).toMatchObject({
			state: "killed",
			stderr: expect.stringContaining("restarted there (the move was asked to restart it)"),
		});
		expect(started).toBeDefined();
		expect((await api.store.commands.get(started ?? ""))?.state).toBe("running");
		FakeHost.endCommand(sandbox.id, started ?? "", { exitCode: 0, stdout: "served\n", stderr: "", durationMs: 9 });
		await vi.waitFor(async () =>
			expect(await root.getCommand(sandbox.id, started ?? "")).toMatchObject({ state: "exited", exitCode: 0 }),
		);
	}, 20_000);

	for (const { how, wrap } of [
		{
			// It never reads the record again.
			how: "whose gateway went",
			wrap: (gone: () => boolean) => (shared: ComputeStore) => ({
				...shared,
				sandboxes: {
					...shared.sandboxes,
					get: async (id: string) => {
						if (gone()) throw new Error("the gateway went");
						return shared.sandboxes.get(id);
					},
				},
			}),
		},
	]) {
		it(`kills them when another gateway settles a paused sandbox's restart move ${how}`, async () => {
			await settledElsewhere(wrap);
		}, 20_000);
	}

	it("kills them by another gateway's sweep when a paused sandbox's restart move couldn't", async () => {
		const { root, api, join, gateway } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		const b = await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = b.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		await olderCommand(api, sandbox.id, "cmd_paused");
		await root.stopSandbox(sandbox.id, { keepMemory: true, wait: true });
		// The mover's kill of its commands can't be written: it is published all the same, its memory let go.
		const mover = gateway({
			wrap: (shared) => ({
				...shared,
				commands: {
					...shared.commands,
					update: async () => {
						throw new Error("the store went away");
					},
				},
			}),
		});
		expect(await mover.root.moveSandbox(sandbox.id, { keepMemory: false })).toMatchObject({
			state: "running",
			hostId: b.hostId,
		});
		expect((await api.store.commands.get("cmd_paused"))?.state).toBe("running");
		const started = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		const later = gateway({ now: () => Date.now() + 10 * 60_000 });
		await later.api.service.sweep();
		await vi.waitFor(async () =>
			expect(await api.store.commands.get("cmd_paused")).toMatchObject({
				state: "killed",
				stderr: expect.stringContaining("restarted there (the move was asked to restart it)"),
			}),
		);
		expect((await api.store.commands.get(started.id))?.state).toBe("running");
	}, 20_000);

	it("leaves them running when a pause fails and leaves the machine running, through its resume from error", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		const detached = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		// Its snapshot failed (no room for its memory): the host resumed the machine, and answers the stop failed.
		a.refuse = (method) =>
			method === "sandbox.stop" ? { code: "internal", message: "no space left on device" } : undefined;
		await root.stopSandbox(sandbox.id, { keepMemory: true, wait: true }).catch(() => undefined);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("error"));
		a.refuse = undefined;
		await root.resumeSandbox(sandbox.id, { wait: true });
		expect((await api.store.commands.get(detached.id))?.state).toBe("running");
		FakeHost.endCommand(sandbox.id, detached.id, { exitCode: 0, stdout: "served\n", stderr: "", durationMs: 9 });
		expect(await root.getCommand(sandbox.id, detached.id)).toMatchObject({ state: "exited", exitCode: 0 });
	}, 20_000);

	it("kills them, saying why, when its host stops it cold instead, a foreground call broken first", async () => {
		const { root, api, join } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		const detached = await root.runCommand(sandbox.id, { command: "./serve", detached: true });
		const foreground = root.runCommand(sandbox.id, { command: "./build", timeoutMs: 60_000 });
		const id = await foregroundId(a, sandbox.id);
		a.stopsCold = true;
		await root.stopSandbox(sandbox.id, { keepMemory: true, wait: true });
		expect((await root.getSandbox(sandbox.id)).state).toBe("stopped");
		const why = expect.stringContaining("couldn't pause it keeping its memory, so it stopped it");
		expect(await foreground).toMatchObject({ id, state: "killed", stderr: why });
		expect(await api.store.commands.get(detached.id)).toMatchObject({ state: "killed", stderr: why });
	}, 20_000);

	it("kills a running sandbox's commands as its restart move stopped it, never one started on its new machine", async () => {
		const { root, api, join, gateway } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		const b = await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = b.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		await olderCommand(api, sandbox.id, "cmd_stopped");
		// Once it is stopped, the first list of its running commands is slow: it is answered after it is published, and
		// another gateway has started a command on its new machine.
		const other = gateway();
		let started: string | undefined;
		let published: () => void = () => undefined;
		const out = new Promise<void>((resolve) => {
			published = resolve;
		});
		let stopped = false;
		let slowed = false;
		a.hold = (method) => {
			if (method === "sandbox.stop") stopped = true;
			return undefined;
		};
		const list = api.store.commands.list.bind(api.store.commands);
		api.store.commands.list = async (filter) => {
			if (stopped && !slowed && filter?.sandboxId === sandbox.id && filter.state === "running") {
				slowed = true;
				await Promise.race([out, new Promise((resolve) => setTimeout(resolve, 2_000))]);
			}
			return list(filter);
		};
		const put = api.store.events.put.bind(api.store.events);
		api.store.events.put = async (event) => {
			if (event.type === "sandbox.running" && event.sandboxId === sandbox.id && started === undefined) {
				started = (await other.root.runCommand(sandbox.id, { command: "./serve", detached: true })).id;
				published();
			}
			return put(event);
		};
		const moved = await root.moveSandbox(sandbox.id, { keepMemory: false });
		expect(moved).toMatchObject({ state: "running", hostId: b.hostId, moved: { keptMemory: false } });
		await vi.waitFor(async () =>
			expect(await api.store.commands.get("cmd_stopped")).toMatchObject({
				state: "killed",
				stderr: expect.stringContaining("restarted there (the move was asked to restart it)"),
			}),
		);
		expect(started).toBeDefined();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect((await api.store.commands.get(started ?? ""))?.state).toBe("running");
	}, 20_000);

	/** A paused sandbox's restart move whose gateway fails once its new machine has started (`wrap` its store so). */
	async function settledElsewhere(wrap: (gone: () => boolean) => (shared: ComputeStore) => ComputeStore) {
		const { root, api, join, gateway, store } = await setup();
		const a = await join(MOVES_COMMANDS, undefined, fingerprints());
		const b = await join(MOVES_COMMANDS, undefined, fingerprints());
		a.keepsCommands = b.keepsCommands = true;
		const sandbox = await runningOn(root, api, a, "disk");
		await olderCommand(api, sandbox.id, "cmd_paused");
		await root.stopSandbox(sandbox.id, { keepMemory: true, wait: true });
		let gone = false;
		const mover = gateway({ wrap: wrap(() => gone) });
		b.hold = (method) => {
			if (method === "sandbox.start") gone = true;
			return undefined;
		};
		await expect(mover.root.moveSandbox(sandbox.id, { keepMemory: false })).rejects.toThrow();
		expect((await store.getPlacement(sandbox.id))?.hostId).toBe(b.hostId);
		expect(await api.store.sandboxes.get(sandbox.id)).toMatchObject({ state: "starting", moving: { from: "paused" } });
		expect((await api.store.commands.get("cmd_paused"))?.state).toBe("running");
		// Another gateway's sweep, once the move has gone quiet, settles it: published there, its commands killed.
		const later = gateway({ now: () => Date.now() + 10 * 60_000 });
		await later.api.service.sweep();
		expect(await api.store.sandboxes.get(sandbox.id)).toMatchObject({ state: "running", hostId: b.hostId });
		await vi.waitFor(async () =>
			expect(await api.store.commands.get("cmd_paused")).toMatchObject({
				state: "killed",
				stderr: expect.stringContaining("restarted there (the move was asked to restart it)"),
			}),
		);
	}
});

// A stop that lands while its sandbox's host is away (#737) waits for the host to connect again and is sent then, rather
// than leaving the sandbox in error. A cold stop whose host isn't back in time fails, and the sandbox is running again
// with the stop owed, since its machine is still running there (LLE-19732): in `error` it held its host's memory unseen.
import { createKantelClient } from "@kantel/api/sdk";
import { createComputeApi, HOST_AWAY_STOP_REASON, joinTokenSpender } from "@kantel/compute";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBackend, STOP_RECONNECT_WAIT_MS } from "../src/backend.ts";
import { HOST_FEATURES } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";
import { FakeHost } from "./fake-host.ts";

const ROOT = { userId: "usr_root", name: "Root", superAdmin: true };
const FEATURES = [HOST_FEATURES.egressPolicy, HOST_FEATURES.guestHealth];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

const never = () => new Promise<void>(() => undefined);

async function setup() {
	let skew = 0;
	const service = createHostsService({
		store: createMemoryHostStore(),
		publicUrl: "https://kantel.test",
		log: () => undefined,
	});
	const api = createComputeApi({
		backend: createHostBackend({
			hosts: service,
			publicUrl: "https://kantel.test",
			tickets: createTunnelTickets(createMemoryRelayStore()),
			// The backend's clock only, moved on to pass a stop's wait for its host.
			now: () => Date.now() + skew,
		}),
		authenticatePerson: async (request) => (request.headers.get("authorization") === "Bearer root" ? ROOT : undefined),
		fetch: async () => new Response(null, { status: 204 }),
		publicUrl: "https://kantel.test",
	});
	service.useJoinTokens(joinTokenSpender(api.store));
	service.useCompute({ secrets: async () => undefined, recordEgress: async () => undefined });
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
	await vi.waitFor(() => expect(host.welcomed()).toBe(true));
	const sandbox = await root.createSandbox({ type: "microvm", wait: true });
	return { api, root, service, hostId, host, sandbox, skip: (ms: number) => (skew += ms) };
}

/** The host connecting again, holding what it held. */
async function reconnect(service: ReturnType<typeof createHostsService>, hostId: string, was: FakeHost) {
	const back = new FakeHost(service, hostId, FEATURES);
	back.connect([...was.sandboxes.values()]);
	await vi.waitFor(() => expect(back.welcomed()).toBe(true));
	return back;
}

const stateOf = async (root: ReturnType<typeof createKantelClient>, id: string) => (await root.getSandbox(id)).state;

describe("a stop while its host is away", () => {
	it("waits for a host that isn't connected, and is sent once it is", async () => {
		const { api, root, service, hostId, host, sandbox } = await setup();
		host.connection.closed(1006, "gone");
		await root.stopSandbox(sandbox.id);
		expect(await stateOf(root, sandbox.id)).toBe("stopping");
		const back = await reconnect(service, hostId, host);
		await api.service.idle();
		expect(await stateOf(root, sandbox.id)).toBe("stopped");
		expect(back.calls.filter((call) => call.method === "sandbox.stop")).toHaveLength(1);
	});

	it("is sent again when the host's connection goes while it waits for the answer", async () => {
		const { api, root, service, hostId, host, sandbox } = await setup();
		host.hold = (method) => (method === "sandbox.stop" ? never() : undefined);
		await root.stopSandbox(sandbox.id);
		await vi.waitFor(() => expect(host.calls.some((call) => call.method === "sandbox.stop")).toBe(true));
		host.connection.closed(1006, "gone");
		const back = await reconnect(service, hostId, host);
		await api.service.idle();
		expect(await stateOf(root, sandbox.id)).toBe("stopped");
		expect(back.calls.filter((call) => call.method === "sandbox.stop")).toHaveLength(1);
	});

	it("keeps waiting while a view of the host that lags says it is connected (a replica's of a host another holds)", async () => {
		const { api, root, service, hostId, host, sandbox } = await setup();
		const connected = service.hub.connected.bind(service.hub);
		// Stale: connected for a while after the host has gone, as a replica's cache until its next heartbeat.
		service.hub.connected = () => true;
		host.connection.closed(1006, "gone");
		await root.stopSandbox(sandbox.id);
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		expect(await stateOf(root, sandbox.id)).toBe("stopping");
		service.hub.connected = connected;
		const back = await reconnect(service, hostId, host);
		await api.service.idle();
		expect(await stateOf(root, sandbox.id)).toBe("stopped");
		expect(back.calls.filter((call) => call.method === "sandbox.stop")).toHaveLength(1);
	});

	it("hands the sandbox back running, the stop owed, when the host isn't back in time, and stops it once it is", async () => {
		const { api, root, service, hostId, host, sandbox, skip } = await setup();
		host.connection.closed(1006, "gone");
		await root.stopSandbox(sandbox.id);
		skip(STOP_RECONNECT_WAIT_MS + 1);
		await api.service.idle();
		// Its machine may still be running on the host, so it is counted there as running, not `error`.
		expect(await stateOf(root, sandbox.id)).toBe("running");
		expect(await api.store.sandboxes.get(sandbox.id)).toMatchObject({ stopFor: HOST_AWAY_STOP_REASON });
		// The sweep leaves it while its host is away, and stops it once the host is back.
		await api.service.sweep();
		expect(await stateOf(root, sandbox.id)).toBe("running");
		const back = await reconnect(service, hostId, host);
		await api.service.sweep();
		await api.service.idle();
		const stopped = await root.getSandbox(sandbox.id);
		expect(stopped.state).toBe("stopped");
		expect(stopped.reason).toBe(HOST_AWAY_STOP_REASON);
		expect(back.calls.filter((call) => call.method === "sandbox.stop")).toHaveLength(1);
		// Carried out: owed no longer, so nothing later (an upgrade's publish) stops it again.
		expect((await api.store.sandboxes.get(sandbox.id))?.stopFor).toBeUndefined();
	});

	it("leaves a pause in error as before when the host isn't back in time", async () => {
		const { api, root, host, sandbox, skip } = await setup();
		host.connection.closed(1006, "gone");
		await root.stopSandbox(sandbox.id, { keepMemory: true });
		skip(STOP_RECONNECT_WAIT_MS + 1);
		await api.service.idle();
		expect(await stateOf(root, sandbox.id)).toBe("error");
		expect((await api.store.sandboxes.get(sandbox.id))?.stopFor).toBeUndefined();
	});

	it("hands a cold stop back with its egress and protected values to send again", async () => {
		const { api, root, host, sandbox, skip } = await setup();
		const before = await api.store.sandboxes.get(sandbox.id);
		host.connection.closed(1006, "gone");
		await root.stopSandbox(sandbox.id);
		skip(STOP_RECONNECT_WAIT_MS + 1);
		await api.service.idle();
		const handed = await api.store.sandboxes.get(sandbox.id);
		expect(handed?.state).toBe("running");
		// Changes to its egress skipped it while it was stopping: a later revision, for the sweep to send once its host is back.
		expect(handed?.egressRevision ?? 0).toBeGreaterThan(before?.egressRevision ?? Number.POSITIVE_INFINITY);
	});

	it("is in error as before when a send may have reached the host and it isn't back in time", async () => {
		const { api, root, host, sandbox, skip } = await setup();
		host.hold = (method) => (method === "sandbox.stop" ? never() : undefined);
		await root.stopSandbox(sandbox.id);
		await vi.waitFor(() => expect(host.calls.some((call) => call.method === "sandbox.stop")).toBe(true));
		// kantel-host carries a stop on past its connection, so the machine may have stopped: it isn't handed back.
		host.connection.closed(1006, "gone");
		// Once the stop has begun its wait for the host, from the failed send.
		await new Promise((resolve) => setTimeout(resolve, 100));
		skip(STOP_RECONNECT_WAIT_MS + 1);
		await api.service.idle();
		const failed = await root.getSandbox(sandbox.id);
		expect(failed.state).toBe("error");
		expect((await api.store.sandboxes.get(sandbox.id))?.stopFor).toBeUndefined();
	});

	it("is in error as before when the host refused a send and was away for the next", async () => {
		const { api, root, service, host, sandbox, skip } = await setup();
		const connected = service.hub.connected.bind(service.hub);
		host.refuse = (method) => {
			if (method !== "sandbox.stop") return undefined;
			// It answers, and may have stopped the machine, then its connection goes.
			setTimeout(() => host.connection.closed(1006, "gone"), 0);
			return { code: "internal", message: "snapshot write failed" };
		};
		await root.stopSandbox(sandbox.id);
		// Past the settle after the refusal, with the host gone: a view that lags then sends again, into a host not there.
		await new Promise((resolve) => setTimeout(resolve, 3_500));
		service.hub.connected = () => true;
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		skip(STOP_RECONNECT_WAIT_MS + 1);
		await api.service.idle();
		service.hub.connected = connected;
		expect(await stateOf(root, sandbox.id)).toBe("error");
		expect((await api.store.sandboxes.get(sandbox.id))?.stopFor).toBeUndefined();
	}, 15_000);

	it("is in error, not handed back, when its host reported the machine's exit while it was stopping", async () => {
		const { api, root, hostId, host, sandbox, skip } = await setup();
		host.connection.closed(1006, "gone");
		await root.stopSandbox(sandbox.id);
		// A restarted host's hello says the machine ended, before the stop's wait is over.
		await api.service.reportExit(hostId, sandbox.id, "the host restarted");
		expect(await stateOf(root, sandbox.id)).toBe("stopping");
		skip(STOP_RECONNECT_WAIT_MS + 1);
		await api.service.idle();
		const failed = await api.store.sandboxes.get(sandbox.id);
		expect(failed?.state).toBe("error");
		expect(failed?.reason).toMatch(/the host restarted/i);
		expect(failed?.exitedWhileStopping).toBeUndefined();
		expect(failed?.stopFor).toBeUndefined();
	});

	it("refuses a pause or recovery of a sandbox owed a stop, which the sweep then carries out", async () => {
		const { api, root, service, hostId, host, sandbox, skip } = await setup();
		host.connection.closed(1006, "gone");
		await root.stopSandbox(sandbox.id);
		skip(STOP_RECONNECT_WAIT_MS + 1);
		await api.service.idle();
		// Owed a stop: a pause would keep the machine in a state the sweep doesn't stop.
		await expect(root.stopSandbox(sandbox.id, { keepMemory: true })).rejects.toMatchObject({ status: 409 });
		// So is a recovery, whose boot would end the obligation before its host carried it out.
		await expect(root.recoverSandbox(sandbox.id)).rejects.toMatchObject({ status: 409 });
		expect(await stateOf(root, sandbox.id)).toBe("running");
		const back = await reconnect(service, hostId, host);
		await api.service.sweep();
		await api.service.idle();
		const stopped = await root.getSandbox(sandbox.id);
		expect(stopped.state).toBe("stopped");
		expect(stopped.reason).toBe(HOST_AWAY_STOP_REASON);
		expect(back.calls.filter((call) => call.method === "sandbox.stop")).toHaveLength(1);
	});

	it("doesn't send again what the host itself refused", async () => {
		const { api, root, host, sandbox } = await setup();
		host.refuse = (method) =>
			method === "sandbox.stop"
				? { code: "internal", message: "firecracker PATCH /vm: connection refused" }
				: undefined;
		await root.stopSandbox(sandbox.id);
		await api.service.idle();
		expect(await stateOf(root, sandbox.id)).toBe("error");
		expect(host.calls.filter((call) => call.method === "sandbox.stop")).toHaveLength(1);
	});
});

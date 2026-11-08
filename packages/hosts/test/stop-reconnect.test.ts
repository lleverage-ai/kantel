// A stop that lands while its sandbox's host is away (#737) waits for the host to connect again and is sent then, rather
// than leaving the sandbox in error; a host that isn't back in time fails it as before.
import { createKantelClient } from "@kantel/api/sdk";
import { createComputeApi, joinTokenSpender } from "@kantel/compute";
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

	it("fails as before when the host isn't back in time", async () => {
		const { api, root, host, sandbox, skip } = await setup();
		host.connection.closed(1006, "gone");
		await root.stopSandbox(sandbox.id);
		skip(STOP_RECONNECT_WAIT_MS + 1);
		await api.service.idle();
		const stopped = await root.getSandbox(sandbox.id);
		expect(stopped.state).toBe("error");
		expect(stopped.reason).toMatch(/not connected/);
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

// A host that watches its microVMs' guest agents (`guest-health`) reports one that stops answering; Kantel marks it
// unresponsive with the host's reason (it stays running), and a recovery asks the host for a reset.
import { createKantelClient } from "@kantel/api/sdk";
import { createComputeApi, joinTokenSpender } from "@kantel/compute";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBackend } from "../src/backend.ts";
import { HOST_FEATURES, type HostSandbox } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";
import { FakeHost } from "./fake-host.ts";

const ROOT = { userId: "usr_root", name: "Root", superAdmin: true };
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

const REASON = "Its guest agent hasn't answered for 60 seconds: it is out of memory (7.9 GB of 8.0 GB in use)";

async function setup() {
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
		}),
		authenticatePerson: async (request) => (request.headers.get("authorization") === "Bearer root" ? ROOT : undefined),
		fetch: async () => new Response(null, { status: 204 }),
		publicUrl: "https://kantel.test",
	});
	service.useJoinTokens(joinTokenSpender(api.store));
	service.useCompute({
		secrets: async () => undefined,
		recordEgress: async () => undefined,
		reportHealth: (hostId, sandboxId, health, reason, healthAt) =>
			api.service.reportHealth(hostId, sandboxId, health, reason, healthAt),
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
	const host = new FakeHost(service, hostId, [HOST_FEATURES.egressPolicy, HOST_FEATURES.guestHealth]);
	host.connect();
	await vi.waitFor(() => expect(host.welcomed()).toBe(true));
	return { api, root, host, service, hostId };
}

/** The host's sandbox as it reports it in an event. */
function report(host: FakeHost, sandbox: HostSandbox) {
	host.send({ type: "event", event: { kind: "sandbox", at: Date.now(), sandbox } });
}

const healthOf = async (root: ReturnType<typeof createKantelClient>, sandboxId: string) =>
	(await root.getSandbox(sandboxId)).health;

describe("a host's report of an unresponsive guest agent", () => {
	it("marks the sandbox unresponsive with its reason, and its agent's answer makes it ok", async () => {
		const { root, host } = await setup();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		const held = host.sandboxes.get(sandbox.id);
		if (held === undefined) throw new Error("not held");
		report(host, { ...held, state: "running", health: "unresponsive", healthReason: REASON, healthAt: 1_000 });
		await vi.waitFor(async () => expect(await healthOf(root, sandbox.id)).toBe("unresponsive"));
		const unhealthy = await root.getSandbox(sandbox.id);
		expect(unhealthy.state).toBe("running");
		expect(unhealthy.reason).toContain("out of memory");
		report(host, { ...held, state: "running", healthAt: 2_000 });
		await vi.waitFor(async () => expect(await healthOf(root, sandbox.id)).toBe("ok"));
	});

	it("is caught up from the hello of a host that reconnects, and a replay older than it is dropped", async () => {
		const { root, host } = await setup();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		const held = host.sandboxes.get(sandbox.id);
		if (held === undefined) throw new Error("not held");
		// Its agent answered again (2,000) after the hello read it unresponsive (1,000); the replay after the welcome
		// says so, and the hello's older read, wherever it lands, doesn't undo it.
		host.connect([{ ...held, state: "running", health: "unresponsive", healthReason: REASON, healthAt: 1_000 }]);
		await vi.waitFor(async () => expect(await healthOf(root, sandbox.id)).toBe("unresponsive"));
		report(host, { ...held, state: "running", healthAt: 2_000 });
		await vi.waitFor(async () => expect(await healthOf(root, sandbox.id)).toBe("ok"));
		report(host, { ...held, state: "running", health: "unresponsive", healthReason: REASON, healthAt: 1_000 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await healthOf(root, sandbox.id)).toBe("ok");
	});

	it("is recovered with a reset on its host, and can be stopped and started instead", async () => {
		const { api, root, host } = await setup();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		const held = host.sandboxes.get(sandbox.id);
		if (held === undefined) throw new Error("not held");
		report(host, { ...held, state: "running", health: "unresponsive", healthReason: REASON, healthAt: 1_000 });
		await vi.waitFor(async () => expect(await healthOf(root, sandbox.id)).toBe("unresponsive"));
		await root.recoverSandbox(sandbox.id);
		await api.service.idle();
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "running", health: "ok" });
		const recovered = host.calls.filter((call) => call.method === "sandbox.start").at(-1)?.params;
		expect(recovered?.reset).toBe(true);

		// A plain start is no reset: the host resets one whose agent doesn't answer by itself.
		report(host, { ...held, state: "running", health: "unresponsive", healthReason: REASON, healthAt: 3_000 });
		await vi.waitFor(async () => expect(await healthOf(root, sandbox.id)).toBe("unresponsive"));
		expect((await root.stopSandbox(sandbox.id, { wait: true })).state).toBe("stopped");
		expect(host.calls.at(-1)?.method).toBe("sandbox.stop");
		expect(await root.startSandbox(sandbox.id, { wait: true })).toMatchObject({ state: "running", health: "ok" });
		expect(host.calls.filter((call) => call.method === "sandbox.start").at(-1)?.params.reset).toBeUndefined();
	});
});

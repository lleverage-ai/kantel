// A microVM its host ends without Kantel asking is reported `stopped` with an error, in an event when its VM exits or in
// the host's hello after a restart; Kantel puts a sandbox it had running there in error, saying why (#808).
import { createKantelClient } from "@kantel/api/sdk";
import { createComputeApi, hostExitReason, joinTokenSpender } from "@kantel/compute";
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

// As kantel-host reports each cause (apps/host/internal/microvm/memory.go, agent/memory.go, microvm.go).
const GUARD_KILL =
	"out of memory: the host ran short of memory, and Kantel stopped this sandbox's VM, the largest, to protect it";
const KERNEL_KILL = "the host ran out of memory, and the kernel stopped this sandbox's VM to free it";
const PLAIN_EXIT = "the VM exited";
const HOST_RESTART = "the host restarted while it ran";

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
		reportExit: (hostId, sandboxId, error) => api.service.reportExit(hostId, sandboxId, error),
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

describe("a microVM its host ended", () => {
	it.each([
		["its memory guard", GUARD_KILL],
		["the kernel's OOM killer at the host's limit", KERNEL_KILL],
		["a plain exit", PLAIN_EXIT],
	])("is in error with the host's reason after %s, and starts again", async (_cause, error) => {
		const { api, root, host } = await setup();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		const held = host.sandboxes.get(sandbox.id);
		if (held === undefined) throw new Error("not held");
		const ended = { ...held, state: "stopped" as const, memory: false, error };
		host.sandboxes.set(sandbox.id, ended);
		report(host, ended);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("error"));
		expect((await root.getSandbox(sandbox.id)).reason).toBe(hostExitReason(error));
		const types = (await root.listEvents({ sandboxId: sandbox.id })).items.map((event) => event.type);
		expect(types).toContain("sandbox.error");

		await api.service.idle();
		expect(await root.startSandbox(sandbox.id, { wait: true })).toMatchObject({ state: "running" });
		expect(host.calls.at(-1)?.method).toBe("sandbox.start");
	});

	it("is caught up from the hello of a host that restarted under it", async () => {
		const { root, host } = await setup();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		const held = host.sandboxes.get(sandbox.id);
		if (held === undefined) throw new Error("not held");
		host.connect([{ ...held, state: "stopped", error: HOST_RESTART }]);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("error"));
		expect((await root.getSandbox(sandbox.id)).reason).toBe(hostExitReason(HOST_RESTART));
	});

	it("leaves a running sandbox as it is for a report with no error, which only a stop Kantel asked for has", async () => {
		const { root, host } = await setup();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		const held = host.sandboxes.get(sandbox.id);
		if (held === undefined) throw new Error("not held");
		// Such as a stop's event handled late, once the sandbox had been started again.
		report(host, { ...held, state: "stopped" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect((await root.getSandbox(sandbox.id)).state).toBe("running");
	});

	it("leaves a sandbox Kantel stopped as it is", async () => {
		const { root, host } = await setup();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		const held = host.sandboxes.get(sandbox.id);
		if (held === undefined) throw new Error("not held");
		expect((await root.stopSandbox(sandbox.id, { wait: true })).state).toBe("stopped");
		// The host's word on that stop, its event and a hello, changes nothing, even with an error the host kept.
		report(host, { ...held, state: "stopped" });
		host.connect([{ ...held, state: "stopped", error: PLAIN_EXIT }]);
		await vi.waitFor(() => expect(host.welcomed()).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await root.getSandbox(sandbox.id)).toMatchObject({ state: "stopped" });
		expect((await root.getSandbox(sandbox.id)).reason).toBeUndefined();
	});
});

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

async function setup(features: readonly string[] = [HOST_FEATURES.guestHealth, HOST_FEATURES.exitStamps]) {
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
		reportExit: (...report) => api.service.reportExit(...report),
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
	const host = new FakeHost(service, hostId, [HOST_FEATURES.egressPolicy, ...features]);
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

	it("is caught up from the hello of a host that restarted under it, one that names no machine included", async () => {
		const { root, host } = await setup();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		const held = host.sandboxes.get(sandbox.id);
		if (held === undefined) throw new Error("not held");
		host.connect([{ ...held, state: "stopped", error: HOST_RESTART }]);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("error"));
		expect((await root.getSandbox(sandbox.id)).reason).toBe(hostExitReason(HOST_RESTART));
	});

	it("never puts a later run in error for a late report of an earlier machine's exit, by event or hello", async () => {
		const { root, host } = await setup();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		const held = host.sandboxes.get(sandbox.id);
		if (held === undefined) throw new Error("not held");
		// The machine that ends was stamped from 1,000 on; its exit is reported once and taken.
		const ended: HostSandbox = { ...held, state: "stopped", memory: false, error: GUARD_KILL, healthAt: 1_000 };
		host.sandboxes.set(sandbox.id, ended);
		report(host, ended);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("error"));

		// Started again: the host's answer stamps its new machine (2,000).
		host.sandboxes.set(sandbox.id, { ...held, healthAt: 2_000 });
		expect(await root.startSandbox(sandbox.id, { wait: true })).toMatchObject({ state: "running" });

		// The same exit again, late: an event still being handled from before a reconnect, and a hello read before the
		// start. Neither touches the new run.
		report(host, ended);
		host.connect([ended]);
		await vi.waitFor(() => expect(host.welcomed()).toBe(true));
		await new Promise((resolve) => setTimeout(resolve, 50));
		const after = await root.getSandbox(sandbox.id);
		expect(after.state).toBe("running");
		expect(after.reason).toBeUndefined();
		expect((await root.runCommand(sandbox.id, { command: "echo hi" })).exitCode).toBe(0);

		// The new machine's own exit is taken.
		report(host, { ...held, state: "stopped", memory: false, error: KERNEL_KILL, healthAt: 2_000 });
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).reason).toBe(hostExitReason(KERNEL_KILL)));
	});

	it("takes a restart's hello only for the run whose machine the restart ended", async () => {
		const { root, host } = await setup();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		const held = host.sandboxes.get(sandbox.id);
		if (held === undefined) throw new Error("not held");
		// Stopped and started again: this run's machine is stamped 2,000 on its host.
		await root.stopSandbox(sandbox.id, { wait: true });
		host.sandboxes.set(sandbox.id, { ...held, healthAt: 2_000 });
		expect(await root.startSandbox(sandbox.id, { wait: true })).toMatchObject({ state: "running" });
		const restarted: HostSandbox = { ...held, state: "stopped", error: HOST_RESTART };

		// Late hellos from restarts that ended earlier machines: one stamped before this machine started, and one with no
		// stamp (a host that names its machines always stamps an exit). Neither touches this run.
		for (const late of [{ ...restarted, healthAt: 1_500 }, restarted]) {
			host.connect([late]);
			await vi.waitFor(() => expect(host.welcomed()).toBe(true));
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect((await root.getSandbox(sandbox.id)).state).toBe("running");
		}

		// The restart that ended this machine, stamped then.
		host.connect([{ ...restarted, healthAt: 3_000 }]);
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("error"));
		expect((await root.getSandbox(sandbox.id)).reason).toBe(hostExitReason(HOST_RESTART));
	});

	it("takes an unstamped exit for a run booted by a host that doesn't stamp its exits", async () => {
		// It stamps its health while running, but not its exits: its boots name no machine.
		const { root, host } = await setup([HOST_FEATURES.guestHealth]);
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		const held = host.sandboxes.get(sandbox.id);
		if (held === undefined) throw new Error("not held");
		await root.stopSandbox(sandbox.id, { wait: true });
		host.sandboxes.set(sandbox.id, { ...held, healthAt: 2_000 });
		expect(await root.startSandbox(sandbox.id, { wait: true })).toMatchObject({ state: "running" });
		report(host, { ...held, state: "stopped", memory: false, error: PLAIN_EXIT });
		await vi.waitFor(async () => expect((await root.getSandbox(sandbox.id)).state).toBe("error"));
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

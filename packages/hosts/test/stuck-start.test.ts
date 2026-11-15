// A start, resume or recovery whose gateway went quiet (LLE-19101): its publish failed, its host's answer was lost, or
// the gateway itself went, leaving the sandbox `starting`. The sweep settles it from what its host has now, never on a
// guess: running there, it runs; stopped there still holding the memory it was paused with, it is paused again; failed
// there, or without that memory, it is `error`, a paused sandbox's commands killed with the memory they ran in; a host
// that can't say yet leaves it starting. A boot whose gateway is still at it is never settled under it.
import { createKantelClient } from "@kantel/api/sdk";
import {
	type ComputeStore,
	createComputeApi,
	joinTokenSpender,
	type SandboxBackend,
	type StoredSandbox,
	UPGRADE_HEARTBEAT_MS,
	UPGRADE_STALE_MS,
} from "@kantel/compute";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBackend, START_ENDED } from "../src/backend.ts";
import { HOST_FEATURES, type HostSandbox } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService, type HostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";
import { FakeHost } from "./fake-host.ts";

const services: HostsService[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const close of closers.splice(0).reverse()) await close();
	for (const service of services.splice(0)) service.close();
});

/** A promise that never settles: a host that never answers. */
const never = () => new Promise<void>(() => undefined);

/** A store whose writes publishing a boot as `running` fail while `failing` says so (a gateway losing its store). */
const failingPublish =
	(failing: () => boolean) =>
	(shared: ComputeStore): ComputeStore => ({
		...shared,
		sandboxes: {
			...shared.sandboxes,
			update: (id, change, expected) =>
				shared.sandboxes.update(
					id,
					(current) => {
						const next = change(current);
						if (failing() && current.state === "starting" && next?.state === "running") {
							throw new Error("the store went");
						}
						return next;
					},
					expected,
				),
		},
	});

/** The compute API over one host, on a clock the test moves on, with a running microVM on it. */
async function setup(features?: readonly string[]) {
	let skew = 0;
	const service = createHostsService({
		store: createMemoryHostStore(),
		publicUrl: "https://kantel.test",
		log: () => undefined,
	});
	services.push(service);
	const backend = createHostBackend({
		hosts: service,
		publicUrl: "https://kantel.test",
		tickets: createTunnelTickets(createMemoryRelayStore()),
	});
	/** A gateway over `store` (another over the same store is this one restarted, with none of its calls in flight). */
	const gateway = (store?: ComputeStore, wrap: (backend: SandboxBackend) => SandboxBackend = (backend) => backend) => {
		const made = createComputeApi({
			...(store === undefined ? {} : { store }),
			backend: wrap(backend),
			authenticatePerson: async (request) =>
				request.headers.get("authorization") === "Bearer root"
					? { userId: "usr_root", name: "Root", superAdmin: true }
					: undefined,
			fetch: async () => new Response(null, { status: 204 }),
			publicUrl: "https://kantel.test",
			now: () => Date.now() + skew,
		});
		closers.push(() => made.close());
		const client = createKantelClient({
			baseUrl: "https://kantel.test/v1",
			token: "root",
			fetch: (input, init) =>
				made.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		return { api: made, root: client };
	};
	const { api, root } = gateway();
	service.useJoinTokens(joinTokenSpender(api.store));
	service.useCompute({ secrets: async () => undefined, recordEgress: async () => undefined });
	const { hostId } = await service.register({ token: (await root.createHostJoinToken({ name: "box" })).token });
	const host = new FakeHost(service, hostId, features);
	host.connect();
	await vi.waitFor(() => expect(host.welcomed()).toBe(true));
	const { id } = await root.createSandbox({ type: "microvm", wait: true });
	/** The host back, holding `held`. */
	const reconnect = async (held: HostSandbox[], memories: readonly string[] = []) => {
		const back = new FakeHost(service, hostId, features);
		for (const sandboxId of memories) back.memories.set(sandboxId, "booted");
		back.connect(held);
		await vi.waitFor(() => expect(back.welcomed()).toBe(true));
		return back;
	};
	/** `on`'s sweep, run past every lease, and what it set going. */
	const sweepPastLeases = async (on: ReturnType<typeof gateway> = { api, root }) => {
		skew += UPGRADE_STALE_MS;
		await on.api.service.sweep();
		await on.api.service.idle();
	};
	const stored = async (): Promise<StoredSandbox> => {
		const sandbox = await api.store.sandboxes.get(id);
		if (sandbox === undefined) throw new Error("no sandbox");
		return sandbox;
	};
	/** A command its memory ran, kept running through its pause. */
	const keptCommand = async (commandId: string) => {
		await api.store.commands.put({
			id: commandId,
			sandboxId: id,
			accountId: (await stored()).accountId,
			command: "./serve",
			state: "running",
			stdout: "",
			stderr: "",
			truncated: false,
			startedAt: Date.now() - 120_000,
			detached: true,
		});
	};
	return {
		api,
		root,
		service,
		hostId,
		host,
		id,
		gateway,
		reconnect,
		sweepPastLeases,
		stored,
		keptCommand,
		skip: (ms: number) => {
			skew += ms;
		},
	};
}

const as = (id: string, state: HostSandbox["state"], more: Partial<HostSandbox> = {}): HostSandbox => ({
	id,
	tier: "microvm",
	size: "default",
	state,
	createdAt: 1,
	...more,
});

describe("a start whose gateway went quiet", () => {
	it("is published running once its lease goes quiet, when its own publish failed", async () => {
		const { api, root, host, id, gateway, sweepPastLeases, stored } = await setup();
		await root.stopSandbox(id, { wait: true });
		let failing = true;
		const lost = gateway(failingPublish(() => failing)(api.store));
		await lost.root.startSandbox(id);
		await lost.api.service.idle();
		failing = false;
		// The host booted it, and its publish never landed: starting, with its lease.
		expect(host.sandboxes.get(id)?.state).toBe("running");
		expect(await stored()).toMatchObject({ state: "starting", booting: { heartbeatAt: expect.any(Number) } });
		// Within its lease, another gateway's sweep leaves it to the gateway that may still be at it.
		await api.service.sweep();
		await api.service.idle();
		expect((await stored()).state).toBe("starting");
		expect(host.calls.some((call) => call.method === "sandbox.get" && call.params.sandboxId === id)).toBe(false);
		await sweepPastLeases();
		const settled = await stored();
		expect(settled).toMatchObject({ state: "running", hostId: host.hostId });
		expect(settled.booting).toBeUndefined();
		expect((await root.getSandbox(id)).state).toBe("running");
	});

	it("stays starting while its host's answer is lost, and runs once the host reports it running", async () => {
		const { api, root, host, id, reconnect, sweepPastLeases, stored, keptCommand } = await setup();
		await root.stopSandbox(id, { keepMemory: true, wait: true });
		expect((await stored()).state).toBe("paused");
		await keptCommand("cmd_kept");
		host.hold = (method) => (method === "sandbox.resume" ? never() : undefined);
		await root.resumeSandbox(id);
		await vi.waitFor(() => expect(host.calls.some((call) => call.method === "sandbox.resume")).toBe(true));
		host.connection.closed(1006, "gone");
		await api.service.idle();
		// Never failed on a guess: the host may have resumed it.
		expect((await stored()).state).toBe("starting");
		// Away: it can't say yet, so it stays starting, its lease quiet for the next sweep.
		await sweepPastLeases();
		expect((await stored()).state).toBe("starting");
		// It resumed it, with its memory.
		await reconnect([as(id, "running")]);
		await sweepPastLeases();
		expect(await stored()).toMatchObject({ state: "running", hostId: host.hostId });
		expect((await stored()).memoryDropped).toBeUndefined();
		// Its command ran on in the memory that came back.
		expect((await api.store.commands.get("cmd_kept"))?.state).toBe("running");
	});

	/** A paused sandbox with a command its memory kept, whose resume its host was sent and never answered. */
	async function lostResume(features?: readonly string[]) {
		const set = await setup(features);
		const { api, root, host, id, stored, keptCommand } = set;
		await root.stopSandbox(id, { keepMemory: true, wait: true });
		const paused = await stored();
		expect(paused.state).toBe("paused");
		await keptCommand("cmd_kept");
		host.hold = (method) => (method === "sandbox.resume" ? never() : undefined);
		await root.resumeSandbox(id);
		await vi.waitFor(() => expect(host.calls.some((call) => call.method === "sandbox.resume")).toBe(true));
		host.connection.closed(1006, "gone");
		await api.service.idle();
		return { ...set, paused };
	}

	it("fails, killing the commands its memory ran, when its host's memory image is gone though its record says kept", async () => {
		const { api, id, reconnect, sweepPastLeases, stored } = await lostResume([HOST_FEATURES.sandboxMoveMemory]);
		// Its record still says it kept its memory, and the image is gone (a reboot emptied the spool).
		const back = await reconnect([as(id, "stopped", { memory: true })]);
		await sweepPastLeases();
		expect(back.calls.some((call) => call.method === "sandbox.memory")).toBe(true);
		expect(await stored()).toMatchObject({
			state: "error",
			memoryDropped: { generation: 1, why: expect.stringContaining("start was never seen through") },
		});
		expect((await api.store.commands.get("cmd_kept"))?.state).toBe("killed");
	});

	it("fails without promising or writing off its memory when its host can't check it", async () => {
		const { api, id, reconnect, sweepPastLeases, stored } = await lostResume();
		await reconnect([as(id, "stopped", { memory: true })], [id]);
		await sweepPastLeases();
		const settled = await stored();
		expect(settled).toMatchObject({ state: "error", reason: expect.stringContaining(START_ENDED) });
		expect(settled.memoryDropped).toBeUndefined();
		expect((await api.store.commands.get("cmd_kept"))?.state).toBe("running");
	});

	it("is paused again, as it was, when its host still has it stopped with its memory", async () => {
		const { api, root, host, id, reconnect, sweepPastLeases, stored, keptCommand } = await setup([
			HOST_FEATURES.sandboxMoveMemory,
		]);
		await root.stopSandbox(id, { keepMemory: true, wait: true });
		const paused = await stored();
		expect(paused.state).toBe("paused");
		await keptCommand("cmd_kept");
		host.hold = (method) => (method === "sandbox.resume" ? never() : undefined);
		await root.resumeSandbox(id);
		await vi.waitFor(() => expect(host.calls.some((call) => call.method === "sandbox.resume")).toBe(true));
		host.connection.closed(1006, "gone");
		await api.service.idle();
		// The resume never reached the machine: still stopped there, holding its memory.
		await reconnect([as(id, "stopped", { memory: true })], [id]);
		await sweepPastLeases();
		const settled = await stored();
		expect(settled).toMatchObject({
			state: "paused",
			stoppedAt: paused.stoppedAt,
			reason: expect.stringContaining(START_ENDED),
		});
		expect(settled.booting).toBeUndefined();
		expect(settled.memoryDropped).toBeUndefined();
		expect((await api.store.commands.get("cmd_kept"))?.state).toBe("running");
		// So it resumes, as a paused sandbox does.
		await root.resumeSandbox(id, { wait: true });
		expect((await stored()).state).toBe("running");
	});

	it("fails, killing the commands its memory ran, when its host lost that memory", async () => {
		const { api, root, host, id, reconnect, sweepPastLeases, stored, keptCommand } = await setup();
		await root.stopSandbox(id, { keepMemory: true, wait: true });
		await keptCommand("cmd_kept");
		host.hold = (method) => (method === "sandbox.resume" ? never() : undefined);
		await root.resumeSandbox(id);
		await vi.waitFor(() => expect(host.calls.some((call) => call.method === "sandbox.resume")).toBe(true));
		host.connection.closed(1006, "gone");
		await api.service.idle();
		await reconnect([as(id, "error", { error: "firecracker exited" })]);
		await sweepPastLeases();
		const settled = await stored();
		expect(settled).toMatchObject({
			state: "error",
			reason: expect.stringContaining("firecracker exited"),
			memoryDropped: { generation: 1, why: expect.stringContaining("start was never seen through") },
		});
		expect(settled.booting).toBeUndefined();
		expect(await api.store.commands.get("cmd_kept")).toMatchObject({
			state: "killed",
			stderr: expect.stringContaining("start was never seen through"),
		});
	});

	it("fails a start from paused whose host stopped it without its memory, killing its commands as the start would", async () => {
		const { api, root, host, id, reconnect, sweepPastLeases, stored, keptCommand } = await setup();
		await root.stopSandbox(id, { keepMemory: true, wait: true });
		await keptCommand("cmd_kept");
		// A start (not a resume) from paused boots afresh from its disk, letting its memory go.
		host.hold = (method) => (method === "sandbox.start" ? never() : undefined);
		await root.startSandbox(id);
		expect((await stored()).memoryDropping).toBeDefined();
		await vi.waitFor(() => expect(host.calls.some((call) => call.method === "sandbox.start")).toBe(true));
		host.connection.closed(1006, "gone");
		await api.service.idle();
		expect((await stored()).state).toBe("starting");
		await reconnect([as(id, "stopped", { memory: false })]);
		await sweepPastLeases();
		const settled = await stored();
		expect(settled).toMatchObject({
			state: "error",
			reason: expect.stringContaining(START_ENDED),
			memoryDropped: { generation: 1, why: expect.stringContaining("started afresh from its disk") },
		});
		expect(settled.memoryDropping).toBeUndefined();
		expect(await api.store.commands.get("cmd_kept")).toMatchObject({
			state: "killed",
			stderr: expect.stringContaining("started afresh from its disk"),
		});
	});

	it("fails a start whose host no longer has the sandbox", async () => {
		const { api, root, host, id, reconnect, sweepPastLeases, stored } = await setup();
		await root.stopSandbox(id, { wait: true });
		host.hold = (method) => (method === "sandbox.start" ? never() : undefined);
		await root.startSandbox(id);
		await vi.waitFor(() => expect(host.calls.some((call) => call.method === "sandbox.start")).toBe(true));
		host.connection.closed(1006, "gone");
		await api.service.idle();
		await reconnect([]);
		await sweepPastLeases();
		expect(await stored()).toMatchObject({ state: "error", reason: expect.stringContaining(START_ENDED) });
		expect((await stored()).memoryDropped).toBeUndefined();
	});

	it("is never settled while its gateway is still at it, past the lease it began with", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const { api, root, host, id, gateway, skip, stored } = await setup();
		await root.stopSandbox(id, { wait: true });
		// Its host is slow to boot it: the gateway waits, keeping its lease.
		let release: () => void = () => undefined;
		host.hold = (method) =>
			method === "sandbox.start"
				? new Promise<void>((resolve) => {
						release = resolve;
					})
				: undefined;
		await root.startSandbox(id);
		await vi.waitFor(() => expect(host.calls.some((call) => call.method === "sandbox.start")).toBe(true));
		const other = gateway(api.store);
		for (let beat = 0; beat < 3; beat++) {
			skip(UPGRADE_HEARTBEAT_MS * 3);
			await vi.advanceTimersByTimeAsync(UPGRADE_HEARTBEAT_MS);
			await vi.waitFor(async () => expect((await stored()).booting?.heartbeatAt).toBeGreaterThan(Date.now()));
			await other.api.service.sweep();
			await other.api.service.idle();
			expect((await stored()).state).toBe("starting");
		}
		// Past the lease it began with, and never asked of its host by another gateway.
		expect(host.calls.some((call) => call.method === "sandbox.get" && call.params.sandboxId === id)).toBe(false);
		release();
		await api.service.idle();
		expect((await stored()).state).toBe("running");
	});

	it("is never settled while its gateway is still preparing it, past the lease it began with", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const { api, root, host, id, gateway, skip, stored } = await setup();
		await root.stopSandbox(id, { wait: true });
		// Its gateway's read of its egress, once it is starting, stalls.
		let release: () => void = () => undefined;
		let stalled = false;
		const stalling = (shared: ComputeStore): ComputeStore => ({
			...shared,
			proxies: {
				...shared.proxies,
				get: async (accountId) => {
					if (!stalled && (await shared.sandboxes.get(id))?.state === "starting") {
						stalled = true;
						await new Promise<void>((resolve) => {
							release = resolve;
						});
					}
					return shared.proxies.get(accountId);
				},
			},
		});
		const preparing = gateway(stalling(api.store));
		const started = preparing.root.startSandbox(id);
		await vi.waitFor(() => expect(stalled).toBe(true));
		const other = gateway(api.store);
		for (let beat = 0; beat < 3; beat++) {
			skip(UPGRADE_HEARTBEAT_MS * 3);
			await vi.advanceTimersByTimeAsync(UPGRADE_HEARTBEAT_MS);
			await vi.waitFor(async () => expect((await stored()).booting?.heartbeatAt).toBeGreaterThan(Date.now()));
			await other.api.service.sweep();
			await other.api.service.idle();
			expect((await stored()).state).toBe("starting");
		}
		// Past the lease it began with, and never asked of its host by another gateway.
		expect(host.calls.some((call) => call.method === "sandbox.get" && call.params.sandboxId === id)).toBe(false);
		release();
		await started;
		await preparing.api.service.idle();
		expect((await stored()).state).toBe("running");
		expect(host.sandboxes.get(id)?.state).toBe("running");
	});

	it("gives a lease to a start begun before leases were kept, and settles it once that goes quiet", async () => {
		const { api, root, host, id, sweepPastLeases, stored } = await setup();
		await root.stopSandbox(id, { wait: true });
		// As an older gateway left it: starting, with no lease, its host never asked.
		await api.store.sandboxes.update(id, (current) => ({
			...current,
			state: "starting",
			lifecycle: (current.lifecycle ?? 0) + 1,
		}));
		await api.service.sweep();
		await api.service.idle();
		expect(await stored()).toMatchObject({ state: "starting", booting: { heartbeatAt: expect.any(Number) } });
		expect(host.calls.some((call) => call.method === "sandbox.get" && call.params.sandboxId === id)).toBe(false);
		await sweepPastLeases();
		// Its host has it stopped: it never booted, so it fails, saying so, for a start to try again.
		expect(await stored()).toMatchObject({ state: "error", reason: expect.stringContaining(START_ENDED) });
		await root.startSandbox(id, { wait: true });
		expect((await stored()).state).toBe("running");
	});

	it("records a lost memory for a paused resume begun before leases were kept, by the commands it kept", async () => {
		const { api, root, host, id, reconnect, sweepPastLeases, stored, keptCommand } = await setup();
		await root.stopSandbox(id, { keepMemory: true, wait: true });
		await keptCommand("cmd_kept");
		host.hold = (method) => (method === "sandbox.resume" ? never() : undefined);
		await root.resumeSandbox(id);
		await vi.waitFor(() => expect(host.calls.some((call) => call.method === "sandbox.resume")).toBe(true));
		host.connection.closed(1006, "gone");
		await api.service.idle();
		// As an older gateway would have left it: no lease, nothing saying it was paused.
		await api.store.sandboxes.update(id, (current) => ({ ...current, booting: undefined }));
		await reconnect([as(id, "stopped", { memory: false })]);
		await api.service.sweep();
		await sweepPastLeases();
		expect(await stored()).toMatchObject({
			state: "error",
			memoryDropped: { generation: 1, why: expect.stringContaining("start was never seen through") },
		});
		expect((await api.store.commands.get("cmd_kept"))?.state).toBe("killed");
	});

	it("lets the original gateway keep a boot it comes back to while another gateway asks its host", async () => {
		const { api, root, host, id, gateway, sweepPastLeases, stored } = await setup();
		await root.stopSandbox(id, { wait: true });
		let failing = true;
		const lost = gateway(failingPublish(() => failing)(api.store));
		await lost.root.startSandbox(id);
		await lost.api.service.idle();
		failing = false;
		// While the sweep asks the host, the original gateway's heartbeat moves the lease on: it is at it again.
		const other = gateway(api.store, (backend) => ({
			...backend,
			settleStart: async (sandboxId: string) => {
				const outcome = await (backend.settleStart?.(sandboxId) ?? Promise.resolve({ state: "pending" as const }));
				await api.store.sandboxes.update(sandboxId, (current) =>
					current.booting === undefined
						? undefined
						: { ...current, booting: { ...current.booting, heartbeatAt: current.booting.heartbeatAt + 1 } },
				);
				return outcome;
			},
		}));
		await sweepPastLeases(other);
		expect((await stored()).state).toBe("starting");
		expect(host.calls.some((call) => call.method === "sandbox.get" && call.params.sandboxId === id)).toBe(true);
		// Once it goes quiet again, it is settled.
		await sweepPastLeases();
		expect((await stored()).state).toBe("running");
	});

	it("is settled once when two gateways sweep it at once", async () => {
		const { api, root, host, id, gateway, skip, stored } = await setup();
		await root.stopSandbox(id, { wait: true });
		let failing = true;
		const lost = gateway(failingPublish(() => failing)(api.store));
		await lost.root.startSandbox(id);
		await lost.api.service.idle();
		failing = false;
		const other = gateway(api.store);
		skip(UPGRADE_STALE_MS);
		await Promise.all([api.service.sweep(), other.api.service.sweep()]);
		await Promise.all([api.service.idle(), other.api.service.idle()]);
		expect((await stored()).state).toBe("running");
		expect(host.calls.filter((call) => call.method === "sandbox.get" && call.params.sandboxId === id)).toHaveLength(1);
	});
});

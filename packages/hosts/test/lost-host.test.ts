// A host lost in the middle of a call: Kantel claims no more than the host has said. A create or fork it never answered
// stays placed on it, counted there, until it reconnects and says what it holds; one it refused, or that never left, is
// gone. The compute plane's sandbox follows (#880): settled from what the host says, never waited on for the call's
// timeout. A sandbox on a revoked host is written off by its delete, without asking a host that never comes back.
import { createKantelClient } from "@kantel/api/sdk";
import {
	CREATE_SETTLE_GRACE_MS,
	createComputeApi,
	createRoutedBackend,
	createStubBackend,
	HELD_ELSEWHERE,
	joinTokenSpender,
	type SandboxBackend,
	STUB_HOST_ID,
} from "@kantel/compute";
import { isKantelError, placementReasonOf } from "@kantel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREATE_LOST, createHostBackend } from "../src/backend.ts";
import type { HostSandbox } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService, type HostsService, unanswered } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";
import { FakeHost, facts } from "./fake-host.ts";

const services: HostsService[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
	for (const service of services.splice(0)) service.close();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
/** A promise that never settles: a host that never answers. */
const never = () => new Promise<void>(() => undefined);

async function setup(callTimeoutMs?: number) {
	const store = createMemoryHostStore();
	const logs: string[] = [];
	const service = createHostsService({
		store,
		publicUrl: "https://kantel.example.com/",
		log: (message) => logs.push(message),
		...(callTimeoutMs === undefined ? {} : { callTimeoutMs }),
	});
	services.push(service);
	const token = await service.createJoinToken({ name: "a" });
	const { hostId } = await service.register({ token: token.token, facts: facts() });
	const host = new FakeHost(service, hostId);
	host.connect();
	await tick();
	return { store, service, logs, hostId, host };
}

describe("a host lost mid-call", () => {
	it("keeps a create whose link dropped placed, until the host's hello says it made it", async () => {
		const { store, service, hostId, host } = await setup();
		host.hold = (method) => (method === "sandbox.create" ? never() : undefined);
		const creating = service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-held" });
		await tick();
		// The host made it, then the link dropped before its answer.
		host.sandboxes.set("sbx-held", {
			id: "sbx-held",
			tier: "microvm",
			size: "default",
			state: "running",
			createdAt: 1,
		});
		host.connection.closed(1006, "gone");
		const error = await creating.catch((caught: unknown) => caught);
		expect(isKantelError(error, "unavailable")).toBe(true);
		expect(unanswered(error)).toBe(true);
		expect((error as Error).message).toMatch(/whether it made the sandbox is known once it reconnects/);
		// Not a placement refused: the host may have made it.
		expect(placementReasonOf(error)).toBeUndefined();
		// Not claimed gone: still placed, and counted on the host.
		expect((await store.getPlacement("sbx-held"))?.state).toBe("starting");
		expect((await service.get(hostId)).allocated).toMatchObject({ sandboxes: 1, memoryMb: 2048 });

		const back = new FakeHost(service, hostId);
		back.connect([...host.sandboxes.values()]);
		await tick();
		expect((await store.getPlacement("sbx-held"))?.state).toBe("running");
		// So deleting it reaches the host, and the machine goes.
		await service.sandboxes.delete("sbx-held");
		expect(back.calls.some((call) => call.method === "sandbox.delete" && call.params.sandboxId === "sbx-held")).toBe(
			true,
		);
		expect(await store.getPlacement("sbx-held")).toBeUndefined();
	});

	it("marks a create the host never made lost once it reconnects without it", async () => {
		const { store, service, hostId, host } = await setup();
		host.hold = (method) => (method === "sandbox.create" ? never() : undefined);
		const creating = service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-gone" });
		await tick();
		host.connection.closed(1006, "gone");
		await expect(creating).rejects.toSatisfy(unanswered);
		new FakeHost(service, hostId).connect();
		await tick();
		const placement = await store.getPlacement("sbx-gone");
		expect(placement?.state).toBe("lost");
		// A lost one holds nothing on the host.
		expect((await service.get(hostId)).allocated).toMatchObject({ sandboxes: 0, memoryMb: 0 });
		// So the compute plane's retry of the create makes it.
		const again = await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-gone" });
		expect(again.sandbox.state).toBe("running");
		expect((await store.getPlacement("sbx-gone"))?.state).toBe("running");
	});

	it("refuses to make again a sandbox whose create isn't settled, or that its host has", async () => {
		const { service, hostId, host } = await setup();
		host.hold = (method) => (method === "sandbox.create" ? never() : undefined);
		const creating = service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-twice" });
		await tick();
		host.sandboxes.set("sbx-twice", {
			id: "sbx-twice",
			tier: "microvm",
			size: "default",
			state: "running",
			createdAt: 1,
		});
		host.connection.closed(1006, "gone");
		await expect(creating).rejects.toSatisfy(unanswered);
		const unsettled = await service.sandboxes
			.create({ tier: "microvm", sandboxId: "sbx-twice" })
			.catch((caught: unknown) => caught);
		expect(isKantelError(unsettled, "conflict")).toBe(true);
		expect((unsettled as Error).message).toMatch(/hasn't said yet whether it made it/);
		new FakeHost(service, hostId).connect([...host.sandboxes.values()]);
		await tick();
		const held = await service.sandboxes
			.create({ tier: "microvm", sandboxId: "sbx-twice" })
			.catch((caught: unknown) => caught);
		expect(isKantelError(held, "conflict")).toBe(true);
		expect((held as Error).message).toBe("A sandbox with that ID exists");
	});

	it("keeps a create that timed out placed, and takes the host's later word on it", async () => {
		const { store, service, host } = await setup(20);
		let answer: () => void = () => undefined;
		host.hold = (method) =>
			method === "sandbox.create"
				? new Promise<void>((resolve) => {
						answer = resolve;
					})
				: undefined;
		await expect(service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-slow" })).rejects.toSatisfy(unanswered);
		expect((await store.getPlacement("sbx-slow"))?.state).toBe("starting");
		// The host finishes later: its answer comes after the call gave up, and its event says it runs.
		answer();
		host.send({
			type: "event",
			event: {
				kind: "sandbox",
				sandbox: { id: "sbx-slow", tier: "microvm", size: "default", state: "running", createdAt: 1 },
			},
		});
		await tick();
		expect((await store.getPlacement("sbx-slow"))?.state).toBe("running");
	});

	it("keeps a fork whose link dropped placed on its source's host", async () => {
		const { store, service, host } = await setup();
		await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-source" });
		host.hold = (method) => (method === "sandbox.fork" ? never() : undefined);
		const forking = service.sandboxes.fork("sbx-source", { newId: "sbx-fork" });
		await tick();
		host.connection.closed(1006, "gone");
		await expect(forking).rejects.toSatisfy(unanswered);
		expect((await store.getPlacement("sbx-fork"))?.state).toBe("starting");
	});

	it("gives a fork, and a create from a sandbox's snapshot, as long as a disk copy, while a plain create keeps its deadline", async () => {
		const { store, service, host, hostId } = await setup(50);
		await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-big" });
		// The host writes the machine's memory and copies its disk: past the ordinary deadline.
		const slow = () => new Promise<void>((resolve) => setTimeout(resolve, 200));
		host.hold = (method) => (method === "sandbox.fork" || method === "sandbox.create" ? slow() : undefined);
		const fork = await service.sandboxes.fork("sbx-big", { newId: "sbx-big-fork" });
		expect(fork.sandbox.state).toBe("running");
		expect((await store.getPlacement("sbx-big-fork"))?.state).toBe("running");
		const restored = await service.sandboxes.create({
			tier: "microvm",
			sandboxId: "sbx-restored",
			from: "snap-big",
			hostIds: [hostId],
		});
		expect(restored.sandbox.state).toBe("running");
		await expect(service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-plain" })).rejects.toSatisfy(unanswered);
	});

	it("gives a snapshot of a running sandbox as long as a disk copy too", async () => {
		const { service, host, hostId } = await setup(50);
		await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-saved" });
		const backend = createHostBackend({
			hosts: service,
			publicUrl: "https://kantel.test",
			tickets: createTunnelTickets(createMemoryRelayStore()),
		});
		// A live save writes the machine's memory and copies its disk: past the ordinary deadline.
		host.hold = (method) =>
			method === "snapshot.save" ? new Promise<void>((resolve) => setTimeout(resolve, 200)) : undefined;
		const taken = await backend.takeSnapshot("sbx-saved");
		expect(taken.ref).toMatch(new RegExp(`^${hostId}/`));
		expect(host.snapshots.map((snapshot) => `${hostId}/${snapshot.id}`)).toContain(taken.ref);
	});

	it("gives a stop as long as a disk copy, since its automatic snapshot copies the disk", async () => {
		const { service, host } = await setup(50);
		await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-stopped" });
		const backend = createHostBackend({
			hosts: service,
			publicUrl: "https://kantel.test",
			tickets: createTunnelTickets(createMemoryRelayStore()),
		});
		host.hold = (method) =>
			method === "sandbox.stop" ? new Promise<void>((resolve) => setTimeout(resolve, 200)) : undefined;
		await expect(backend.stop("sbx-stopped", { keepMemory: false })).resolves.toBeDefined();
	});

	it("says a start whose host went while it waited may have run, and one that never reached its host was refused", async () => {
		const { service, host } = await setup();
		await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-start" });
		await service.sandboxes.call("sbx-start", "sandbox.stop");
		host.hold = (method) => (method === "sandbox.start" ? never() : undefined);
		const starting = service.sandboxes.call("sbx-start", "sandbox.start");
		await tick();
		host.connection.closed(1006, "gone");
		const dropped = await starting.catch((caught: unknown) => caught);
		expect(unanswered(dropped)).toBe(true);
		expect(placementReasonOf(dropped)).toBeUndefined();
		// Its host away from the start: never sent, so refused for its host (#679's reason).
		const refused = await service.sandboxes.call("sbx-start", "sandbox.start").catch((caught: unknown) => caught);
		expect(unanswered(refused)).toBe(false);
		expect(placementReasonOf(refused)).toBe("host_unavailable");
	});

	it("forgets a create the host refused", async () => {
		const { store, service, host } = await setup();
		host.hold = (method) => {
			if (method !== "sandbox.create") return undefined;
			// Answered with an error, not dropped: the host said it made nothing.
			const call = host.sent.findLast((message) => message.method === "sandbox.create");
			host.send({ type: "result", id: call?.id, error: { code: "capacity", message: "full" } });
			return never();
		};
		const error = await service.sandboxes
			.create({ tier: "microvm", sandboxId: "sbx-refused" })
			.catch((caught: unknown) => caught);
		expect(isKantelError(error, "exhausted")).toBe(true);
		expect(unanswered(error)).toBe(false);
		expect(await store.getPlacement("sbx-refused")).toBeUndefined();
	});

	it("doesn't claim a delete whose link dropped", async () => {
		const { store, service, host } = await setup();
		await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-del" });
		host.hold = (method) => (method === "sandbox.delete" ? never() : undefined);
		const deleting = service.sandboxes.delete("sbx-del");
		await tick();
		host.connection.closed(1006, "gone");
		await expect(deleting).rejects.toSatisfy(unanswered);
		expect((await store.getPlacement("sbx-del"))?.state).toBe("running");
	});

	it("writes off a sandbox on a revoked host when it is deleted, without calling the host", async () => {
		const { store, service, hostId, host, logs } = await setup();
		await service.sandboxes.create({ tier: "microvm", sandboxId: "sbx-stranded" });
		await service.revoke(hostId);
		await service.sandboxes.delete("sbx-stranded");
		expect(await store.getPlacement("sbx-stranded")).toBeUndefined();
		expect(host.calls.some((call) => call.method === "sandbox.delete")).toBe(false);
		expect(logs.join("\n")).toMatch(/sbx-stranded written off: its host .* is revoked/);
	});
});

describe("a create made again over two backends", () => {
	/** An account's host as `primary` and the stub as `fallback`, routed as a hosted deployment does. */
	async function routed() {
		const { store, service, hostId, host } = await setup();
		const primary = createHostBackend({
			hosts: service,
			publicUrl: "https://kantel.test",
			tickets: createTunnelTickets(createMemoryRelayStore()),
		});
		const fallback = createStubBackend();
		const backend = createRoutedBackend({
			primary,
			fallback,
			holds: async (sandboxId) => (await service.sandboxes.placement(sandboxId)) !== undefined,
			holdsSnapshot: (ref) => ref.startsWith(`${hostId}/`),
		});
		const spec = (sandboxId: string, eligibleHosts: readonly string[]) => ({
			sandboxId,
			accountId: "acc_1",
			type: "microvm" as const,
			subdomain: sandboxId,
			env: {},
			eligibleHosts,
		});
		/** A create whose link drops before the host answers: kept placed on the host. */
		const unansweredCreate = async (sandboxId: string) => {
			host.hold = (method) => (method === "sandbox.create" ? never() : undefined);
			const creating = backend.create(spec(sandboxId, [hostId, STUB_HOST_ID]));
			await tick();
			host.connection.closed(1006, "gone");
			await expect(creating).rejects.toSatisfy(unanswered);
		};
		return { store, service, hostId, backend, spec, fallback, unansweredCreate };
	}

	it("never makes on the fallback a sandbox the account's host still holds", async () => {
		const { store, backend, spec, fallback, unansweredCreate } = await routed();
		await unansweredCreate("sbx-retry");
		// Its host away, only the stub may take it now: the retry is refused rather than made there too.
		const error = await backend.create(spec("sbx-retry", [STUB_HOST_ID])).catch((caught: unknown) => caught);
		expect(isKantelError(error, "unavailable")).toBe(true);
		expect((error as Error).message).toBe(HELD_ELSEWHERE);
		expect((await store.getPlacement("sbx-retry"))?.state).toBe("starting");
		await expect(fallback.usage("sbx-retry")).rejects.toThrow();
	});

	it("makes it again on the account's host once that host says it lost it, and routes there after", async () => {
		const { store, service, hostId, backend, spec, unansweredCreate } = await routed();
		await unansweredCreate("sbx-again");
		const back = new FakeHost(service, hostId);
		back.connect();
		await tick();
		expect((await store.getPlacement("sbx-again"))?.state).toBe("lost");
		// Not where it is placed now: an earlier attempt its host said it doesn't have.
		expect(await backend.placedOn?.("sbx-again")).toBeUndefined();
		const placed = await backend.create(spec("sbx-again", [hostId, STUB_HOST_ID]));
		expect(placed.hostId).toBe(hostId);
		expect((await store.getPlacement("sbx-again"))?.state).toBe("running");
		await backend.destroy("sbx-again");
		expect(back.calls.some((call) => call.method === "sandbox.delete")).toBe(true);
	});

	it("refuses a create made again while its first is unsettled, even with the account's host eligible", async () => {
		const { service, hostId, backend, spec, unansweredCreate } = await routed();
		await unansweredCreate("sbx-wait");
		new FakeHost(service, hostId).connect([
			{ id: "sbx-wait", tier: "microvm", size: "default", state: "running", createdAt: 1 },
		]);
		await tick();
		const error = await backend.create(spec("sbx-wait", [hostId, STUB_HOST_ID])).catch((caught: unknown) => caught);
		expect(isKantelError(error, "conflict")).toBe(true);
	});
});

describe("a create whose answer was lost, in the compute plane", () => {
	/** The compute API over a host, on a clock the test moves on (its sweep's grace). */
	async function computeSetup() {
		let skew = 0;
		const service = createHostsService({
			store: createMemoryHostStore(),
			publicUrl: "https://kantel.test",
			log: () => undefined,
		});
		services.push(service);
		/** A gateway: another over the same store is this one restarted, with none of its calls in flight. */
		const gateway = (
			store?: ReturnType<typeof createComputeApi>["store"],
			wrap: (backend: SandboxBackend) => SandboxBackend = (backend) => backend,
		) => {
			const made = createComputeApi({
				...(store === undefined ? {} : { store }),
				backend: wrap(
					createHostBackend({
						hosts: service,
						publicUrl: "https://kantel.test",
						tickets: createTunnelTickets(createMemoryRelayStore()),
					}),
				),
				authenticatePerson: async (request) =>
					request.headers.get("authorization") === "Bearer root"
						? { userId: "usr_root", name: "Root", superAdmin: true }
						: undefined,
				fetch: async () => new Response(null, { status: 204 }),
				publicUrl: "https://kantel.test",
				now: () => Date.now() + skew,
			});
			closers.push(() => made.close());
			return made;
		};
		const api = gateway();
		service.useJoinTokens(joinTokenSpender(api.store));
		service.useCompute({ secrets: async () => undefined, recordEgress: async () => undefined });
		const root = createKantelClient({
			baseUrl: "https://kantel.test/v1",
			token: "root",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		const { hostId } = await service.register({ token: (await root.createHostJoinToken({ name: "box" })).token });
		const host = new FakeHost(service, hostId);
		host.connect();
		await vi.waitFor(() => expect(host.welcomed()).toBe(true));
		// The host takes the create and never answers it: its connection drops first.
		host.hold = (method) => (method === "sandbox.create" ? never() : undefined);
		const { id } = await root.createSandbox({ type: "microvm" });
		await vi.waitFor(() => expect(host.calls.some((call) => call.method === "sandbox.create")).toBe(true));
		/** The host back, holding `held`; `sweeping`'s sweep run past its grace. */
		const reconnect = async (held: HostSandbox[], sweeping = api) => {
			const back = new FakeHost(service, hostId);
			back.connect(held);
			await vi.waitFor(() => expect(back.welcomed()).toBe(true));
			skew += CREATE_SETTLE_GRACE_MS;
			await sweeping.service.sweep();
			await sweeping.service.idle();
			return back;
		};
		return {
			api,
			root,
			service,
			hostId,
			host,
			id,
			reconnect,
			restarted: (
				wrap?: (backend: SandboxBackend) => SandboxBackend,
				store: ReturnType<typeof createComputeApi>["store"] = api.store,
			) => gateway(store, wrap),
			skip: (ms: number) => {
				skew += ms;
			},
		};
	}

	it("is settled running on its host once the host reconnects and reports it, by any gateway", async () => {
		const { api, root, hostId, host, id, reconnect, restarted } = await computeSetup();
		host.connection.closed(1006, "gone");
		await api.service.idle();
		// Not failed on a guess, and not waited on for the call's timeout either.
		expect((await root.getSandbox(id)).state).toBe("starting");
		// Settled by a gateway that never made the call (the stack object restarted, as both hosts dropped together).
		await reconnect([{ id, tier: "microvm", size: "default", state: "running", createdAt: 1 }], restarted());
		expect(await root.getSandbox(id)).toMatchObject({ state: "running", hostId });
	});

	it("fails, saying why, when the host reconnects without it, and a start makes it again", async () => {
		const { api, root, host, id, reconnect } = await computeSetup();
		host.connection.closed(1006, "gone");
		await api.service.idle();
		const back = await reconnect([]);
		expect(await root.getSandbox(id)).toMatchObject({ state: "error", reason: CREATE_LOST });
		await root.startSandbox(id);
		await api.service.idle();
		expect((await root.getSandbox(id)).state).toBe("running");
		expect(back.calls.filter((call) => call.method === "sandbox.create")).toHaveLength(1);
	});
	it("keeps the guest health its host reports for a create it settles running", async () => {
		const { api, root, host, id, reconnect } = await computeSetup();
		host.connection.closed(1006, "gone");
		await api.service.idle();
		await reconnect([
			{
				id,
				tier: "microvm",
				size: "default",
				state: "running",
				createdAt: 1,
				health: "unresponsive",
				healthReason: "its guest agent doesn't answer",
				healthAt: 5,
			},
		]);
		const settled = await root.getSandbox(id);
		expect(settled).toMatchObject({ state: "running", health: "unresponsive" });
		// Stamped as the host stamped it: an older report doesn't undo it, a newer one does.
		const hostId = settled.hostId ?? "";
		await api.service.reportHealth(hostId, id, undefined, undefined, 4);
		expect((await root.getSandbox(id)).health).toBe("unresponsive");
		await api.service.reportHealth(hostId, id, undefined, undefined, 6);
		expect((await root.getSandbox(id)).health).toBe("ok");
	});

	it("keeps a machine that ended on its host, and a stale gateway's late answer never touches a later attempt", async () => {
		const { api, root, service, hostId, host, id, restarted, skip } = await computeSetup();
		host.connection.closed(1006, "gone");
		await api.service.idle();
		// The host made it, and it ended while the host was away.
		const ended: HostSandbox = { id, tier: "microvm", size: "default", state: "stopped", createdAt: 1, error: "oom" };
		const back = new FakeHost(service, hostId);
		let gets = 0;
		let answerGet: () => void = () => undefined;
		let answerStart: (() => void) | undefined;
		back.hold = (method) => {
			if (method === "sandbox.get" && gets++ === 0) {
				return new Promise<void>((resolve) => {
					answerGet = resolve;
				});
			}
			if (method === "sandbox.start") {
				return new Promise<void>((resolve) => {
					answerStart = resolve;
				});
			}
			return undefined;
		};
		back.connect([ended]);
		await vi.waitFor(() => expect(back.welcomed()).toBe(true));
		skip(CREATE_SETTLE_GRACE_MS);
		// One gateway asks the host, and its answer is slow; another, meanwhile, settles it: `error`, on its host, kept.
		const slow = restarted();
		void slow.service.sweep();
		await vi.waitFor(() => expect(gets).toBe(1));
		await api.service.sweep();
		await api.service.idle();
		expect(await root.getSandbox(id)).toMatchObject({ state: "error", hostId, reason: expect.stringMatching(/oom/) });
		// Started again, booting the machine kept there: under way when the slow answer lands, saying it ended.
		await root.startSandbox(id);
		await vi.waitFor(() => expect(answerStart).toBeDefined());
		back.answer = (method) => (method === "sandbox.get" ? ended : undefined);
		answerGet();
		await slow.service.idle();
		expect((await root.getSandbox(id)).state).toBe("starting");
		back.answer = undefined;
		answerStart?.();
		await api.service.idle();
		expect((await root.getSandbox(id)).state).toBe("running");
		// Nothing settling it ever acted on the host.
		expect(back.calls.some((call) => call.method === "sandbox.delete" || call.method === "sandbox.stop")).toBe(false);
	});

	it("never stops a later attempt for egress a stale settlement couldn't send", async () => {
		const { api, root, service, hostId, host, id, restarted, skip } = await computeSetup();
		host.connection.closed(1006, "gone");
		await api.service.idle();
		const back = new FakeHost(service, hostId);
		let egresses = 0;
		let answerEgress: () => void = () => undefined;
		let answerStart: (() => void) | undefined;
		back.hold = (method) => {
			if (method === "sandbox.egress" && egresses++ === 0) {
				return new Promise<void>((resolve) => {
					answerEgress = resolve;
				});
			}
			if (method === "sandbox.start") {
				return new Promise<void>((resolve) => {
					answerStart = resolve;
				});
			}
			return undefined;
		};
		back.connect([{ id, tier: "microvm", size: "default", state: "running", createdAt: 1 }]);
		await vi.waitFor(() => expect(back.welcomed()).toBe(true));
		skip(CREATE_SETTLE_GRACE_MS);
		// One gateway sends its egress, and the answer is slow; another settles it running meanwhile.
		const slow = restarted();
		void slow.service.sweep();
		await vi.waitFor(() => expect(egresses).toBe(1));
		await api.service.sweep();
		await api.service.idle();
		expect((await root.getSandbox(id)).state).toBe("running");
		const revision = (await api.store.sandboxes.get(id))?.egressRevision;
		// Stopped and started again: the new attempt under way when the slow egress is refused as unenforceable. Even with
		// the egress revision the stale one read (a start renews it, which is no fence of its own), it isn't touched.
		await root.stopSandbox(id);
		await api.service.idle();
		await root.startSandbox(id);
		await vi.waitFor(() => expect(answerStart).toBeDefined());
		await api.store.sandboxes.update(id, (current) => ({ ...current, egressRevision: revision }));
		back.refuse = (method) =>
			method === "sandbox.egress" ? { code: "unsupported", message: "this host doesn't enforce egress" } : undefined;
		answerEgress();
		await slow.service.idle();
		back.refuse = undefined;
		// Neither stopped nor made due to stop: the stale settlement's stop is fenced to its own attempt.
		expect(await api.store.sandboxes.get(id)).toMatchObject({ state: "starting", stopFor: undefined });
		answerStart?.();
		await api.service.idle();
		// Not made due to stop either: the sweep leaves it running.
		await api.service.sweep();
		await api.service.idle();
		expect((await root.getSandbox(id)).state).toBe("running");
		// The one stop is the caller's.
		expect(back.calls.filter((call) => call.method === "sandbox.stop")).toHaveLength(1);
	});
	it("stops a create it settles running whose egress its host refuses, at once", async () => {
		const { api, root, service, hostId, host, id, skip } = await computeSetup();
		host.connection.closed(1006, "gone");
		await api.service.idle();
		const back = new FakeHost(service, hostId);
		back.refuse = (method) =>
			method === "sandbox.egress" ? { code: "unsupported", message: "this host doesn't enforce egress" } : undefined;
		back.connect([{ id, tier: "microvm", size: "default", state: "running", createdAt: 1 }]);
		await vi.waitFor(() => expect(back.welcomed()).toBe(true));
		skip(CREATE_SETTLE_GRACE_MS);
		await api.service.sweep();
		await api.service.idle();
		expect(back.calls.filter((call) => call.method === "sandbox.stop")).toHaveLength(1);
		expect((await root.getSandbox(id)).state).toBe("stopped");
	});

	it("still stops it once the stop's lease is past when its gateway went with the stop decided", async () => {
		const { api, root, service, hostId, host, id, restarted, skip } = await computeSetup();
		host.connection.closed(1006, "gone");
		await api.service.idle();
		const back = new FakeHost(service, hostId);
		back.refuse = (method) =>
			method === "sandbox.egress" ? { code: "unsupported", message: "this host doesn't enforce egress" } : undefined;
		back.connect([{ id, tier: "microvm", size: "default", state: "running", createdAt: 1 }]);
		await vi.waitFor(() => expect(back.welcomed()).toBe(true));
		skip(CREATE_SETTLE_GRACE_MS);
		// A gateway that goes the moment it has made the stop due, before its move to stopping.
		const sandboxes = api.store.sandboxes;
		const update: typeof sandboxes.update = async (...args) => {
			const written = await sandboxes.update(...args);
			if (written?.state === "starting" && written.stopFor !== undefined) throw new Error("the gateway went");
			return written;
		};
		const dying = restarted(undefined, {
			...api.store,
			sandboxes: new Proxy(sandboxes, {
				get: (target, key) => (key === "update" ? update : Reflect.get(target, key)),
			}),
		});
		await dying.service.sweep();
		await dying.service.idle();
		expect(back.calls.some((call) => call.method === "sandbox.stop")).toBe(false);
		expect(await api.store.sandboxes.get(id)).toMatchObject({ state: "starting", stopFor: expect.any(String) });
		// Another gateway's sweep takes the abandoned stop on once its lease is past.
		skip(5 * 60_000 + 1);
		await api.service.sweep();
		await api.service.idle();
		expect(back.calls.filter((call) => call.method === "sandbox.stop")).toHaveLength(1);
		expect((await root.getSandbox(id)).state).toBe("stopped");
	});
});

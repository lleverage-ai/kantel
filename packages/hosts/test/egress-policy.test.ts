// Grants and protected variables go only to hosts that enforce them (`egress-policy` in their facts), and a fork is
// given its own environment: its own placeholders, never its source's.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { type ComputeStore, createComputeApi, joinTokenSpender } from "@kantel/compute";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBackend } from "../src/backend.ts";
import { HOST_FEATURES } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";
import { FakeHost } from "./fake-host.ts";

const ROOT = { userId: "usr_root", name: "Root", superAdmin: true };
const SECRET = "ghp_TESTSECRETVALUE123";
const PLACEHOLDER = /^kph_[0-9A-Za-z]{40}$/;
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

async function setup(features?: readonly string[]) {
	const service = createHostsService({ store: createMemoryHostStore(), publicUrl: "https://kantel.test" });
	/** A gateway on the hosts and, given one, another's store; `now`, its clock. */
	const gateway = (store?: ComputeStore, now?: () => number) =>
		createComputeApi({
			backend: createHostBackend({
				hosts: service,
				publicUrl: "https://kantel.test",
				tickets: createTunnelTickets(createMemoryRelayStore()),
			}),
			...(store === undefined ? {} : { store }),
			...(now === undefined ? {} : { now }),
			authenticatePerson: async (request) =>
				request.headers.get("authorization") === "Bearer root" ? ROOT : undefined,
			fetch: async () => new Response(null, { status: 204 }),
			publicUrl: "https://kantel.test",
		});
	const api = gateway();
	service.useJoinTokens(joinTokenSpender(api.store));
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
	const host = new FakeHost(service, hostId, features);
	host.connect();
	/** Another gateway, on the same store, its clock `aheadMs` on. */
	const another = (aheadMs: number) => {
		const other = gateway(api.store, () => Date.now() + aheadMs);
		closers.push(() => other.close());
		return other;
	};
	return { api, root, host, another };
}

const UNENFORCED = "Its host doesn't enforce egress grants or protected variables";

/** A sandbox's events, oldest first: each type, and a stop's reason after it. */
async function historyOf(root: Awaited<ReturnType<typeof setup>>["root"], sandboxId: string) {
	const { items } = await root.listEvents({ sandboxId });
	return items
		.map((event) => {
			const reason = (event.data as { reason?: string } | undefined)?.reason;
			return event.type === "sandbox.stopped" && reason !== undefined ? `${event.type}: ${reason}` : event.type;
		})
		.reverse();
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

async function protectedEnvironment(root: Awaited<ReturnType<typeof setup>>["root"]) {
	const environment = await root.createEnvironment({ name: "backend" });
	await root.setEnvironmentVariable(environment.id, "GH_TOKEN", {
		protected: true,
		value: SECRET,
		bindings: [{ host: "api.github.com", methods: ["GET"] }],
	});
	return environment;
}

describe("a host that doesn't report enforcing egress policy", () => {
	it("is given no sandbox with protected variables or grants, nor grants later; a plain one still runs", async () => {
		const { root, host } = await setup();
		const environment = await protectedEnvironment(root);
		// It fails to start, saying why, and nothing reaches the host.
		const refused = await root.createSandbox({ environment: environment.id, wait: true });
		expect(refused.state).toBe("error");
		expect(refused.reason).toMatch(/enforces egress grants or protected variables/);
		expect(JSON.stringify(refused)).not.toContain(SECRET);
		expect(host.calls.filter((call) => call.method === "sandbox.create")).toEqual([]);

		// Grants alone need it too, at the create and when they are added to a running sandbox.
		const grants = [{ action: "deny" as const, host: "evil.example" }];
		const granted = await root.createEnvironment({ name: "granted" });
		await root.putEnvironmentGrants(granted.id, { grants });
		expect((await root.createSandbox({ environment: granted.id, wait: true })).state).toBe("error");
		const plain = await root.createSandbox({ type: "microvm", wait: true });
		expect(plain.state).toBe("running");
		expect((await failure(root.putSandboxGrants(plain.id, { grants }))).code).toBe("not_supported");
		// Refused, not kept: the sandbox doesn't claim grants its host isn't enforcing.
		expect((await root.getSandbox(plain.id)).grants).toEqual([]);
		expect(host.calls.filter((call) => call.method === "sandbox.egress")).toEqual([]);

		// Nor through an environment one of its sandboxes runs from: the edit is refused, and nothing is kept.
		const open = await root.createEnvironment({ name: "open" });
		await root.setEnvironmentVariable(open.id, "LOG_LEVEL", { value: "debug" });
		const running = await root.createSandbox({ environment: open.id, wait: true });
		expect(running.state).toBe("running");
		expect((await failure(root.putEnvironmentGrants(open.id, { grants }))).code).toBe("not_supported");
		const bound = { protected: true, value: SECRET, bindings: [{ host: "api.github.com" }] };
		const secret = await failure(root.setEnvironmentVariable(open.id, "GH_TOKEN", bound));
		expect(secret.code).toBe("not_supported");
		expect(JSON.stringify(secret)).not.toContain(SECRET);
		const kept = await root.getEnvironment(open.id);
		expect([kept.grants, kept.variables.map((variable) => variable.name)]).toEqual([[], ["LOG_LEVEL"]]);
		// A plain variable needs nothing of the host.
		await root.setEnvironmentVariable(open.id, "MODE", { value: "dev" });
	});
});

describe("a host that enforces egress policy", () => {
	it("takes protected variables, each sandbox's and each fork's own placeholder, and grants as they change", async () => {
		const { root, host } = await setup([HOST_FEATURES.egressPolicy]);
		const environment = await protectedEnvironment(root);
		const sandbox = await root.createSandbox({ environment: environment.id, wait: true });
		expect(sandbox.state).toBe("running");
		const created = host.calls.find((call) => call.method === "sandbox.create");
		const env = (created?.params.env ?? {}) as { [name: string]: string };
		expect(env.GH_TOKEN).toMatch(PLACEHOLDER);
		expect(JSON.stringify(host.calls)).not.toContain(SECRET);

		const forks = await root.forkSandbox(sandbox.id, { wait: true });
		const forked = host.calls.find((call) => call.method === "sandbox.fork");
		const forkEnv = (forked?.params.env ?? {}) as { [name: string]: string };
		expect(forkEnv.GH_TOKEN).toMatch(PLACEHOLDER);
		expect(forkEnv.GH_TOKEN).not.toBe(env.GH_TOKEN);
		expect(forked?.params.newId).toBe(forks.items[0]?.id);
		expect((forked?.params.egress as { protected?: unknown } | undefined)?.protected).toBeDefined();

		await root.putSandboxGrants(sandbox.id, { grants: [{ action: "deny", host: "evil.example" }] });
		const pushed = host.calls.filter((call) => call.method === "sandbox.egress");
		expect(pushed.at(-1)?.params).toMatchObject({
			sandboxId: sandbox.id,
			egress: { revision: expect.any(Number), grants: [expect.objectContaining({ host: "evil.example" })] },
		});
		expect(JSON.stringify(host.calls)).not.toContain(SECRET);
	});
});

describe("an egress update its host misses", () => {
	it("is sent again, as it is then, once the host is back: grants and a rotation alike", async () => {
		const { api, root, host } = await setup([HOST_FEATURES.egressPolicy]);
		const environment = await protectedEnvironment(root);
		const sandbox = await root.createSandbox({ environment: environment.id, wait: true });
		const egressCalls = () => host.calls.filter((call) => call.method === "sandbox.egress");
		expect(egressCalls()).toEqual([]);

		// The host drops its link; the grants are saved meanwhile, and the update can't reach it.
		host.connection.closed(1006, "gone");
		await root.putSandboxGrants(sandbox.id, { grants: [{ action: "deny", host: "first.example" }] });
		await root.putSandboxGrants(sandbox.id, { grants: [{ action: "deny", host: "second.example" }] });
		await root.setEnvironmentVariable(environment.id, "GH_TOKEN", { value: "ghp_ROTATEDVALUE456" });
		await api.service.idle();
		expect(egressCalls()).toEqual([]);
		const stored = await api.store.sandboxes.get(sandbox.id);
		expect(stored?.egressApplied).toBeLessThan(stored?.egressRevision ?? 0);
		// Nor does a sweep send it while the host is away.
		await api.service.sweep();
		await api.service.idle();
		expect(egressCalls()).toEqual([]);

		// Back, the sweep sends the latest, once: its grants, its environment's new version, its revision.
		host.connect();
		// Each sweep in turn, as a gateway runs them, until the host's hello has been taken.
		await vi.waitFor(async () => {
			await api.service.sweep();
			await api.service.idle();
			expect(egressCalls().length).toBeGreaterThan(0);
		});
		const sent = egressCalls();
		expect(sent).toHaveLength(1);
		const environmentNow = await api.store.environments.get(environment.id);
		expect(sent[0]?.params).toMatchObject({
			sandboxId: sandbox.id,
			egress: {
				revision: stored?.egressRevision,
				grants: [expect.objectContaining({ host: "second.example" })],
				protected: { version: environmentNow?.secretsVersion },
			},
		});
		expect((await api.store.sandboxes.get(sandbox.id))?.egressApplied).toBe(stored?.egressRevision);
		// Taken, it isn't sent again.
		await api.service.sweep();
		await api.service.idle();
		expect(egressCalls()).toHaveLength(1);
		expect(JSON.stringify(host.calls)).not.toContain(SECRET);
		expect(JSON.stringify(host.calls)).not.toContain("ghp_ROTATEDVALUE456");
	});
});

describe("a sandbox given a grant while it starts", () => {
	it("doesn't run on a host that can't enforce it", async () => {
		const { api, root, host } = await setup();
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		// The host answers the create only once the grant is in.
		const original = host.send.bind(host);
		host.send = (message: { type?: string; result?: { id?: string } }) => {
			if (message.type === "result" && message.result?.id !== undefined && message.result.id.startsWith("sbx_")) {
				void held.then(() => original(message));
				return;
			}
			original(message);
		};
		const sandbox = await root.createSandbox({ type: "microvm" });
		await vi.waitFor(() => expect(host.calls.some((call) => call.method === "sandbox.create")).toBe(true));
		await root.putSandboxGrants(sandbox.id, { grants: [{ action: "deny", host: "evil.example" }] });
		release();
		await api.service.idle();
		// It never ran: stopped, saying why.
		expect((await root.getSandbox(sandbox.id)).state).toBe("stopped");
		expect(await historyOf(root, sandbox.id)).toEqual(["sandbox.created", `sandbox.stopped: ${UNENFORCED}`]);
		expect(host.calls.some((call) => call.method === "sandbox.stop")).toBe(true);
	});

	it("is stopped once its host is back, though the stop didn't reach it as it was made", async () => {
		const { api, root, host } = await setup();
		const holding = new Set(["sandbox.create"]);
		let release = () => {};
		host.hold = (method) => {
			if (method === "sandbox.stop") {
				// The link drops as the stop is sent.
				host.connection.closed(1006, "gone");
				return new Promise<void>(() => {});
			}
			if (!holding.delete(method)) return undefined;
			return new Promise<void>((resolve) => {
				release = resolve;
			});
		};
		const sandbox = await root.createSandbox({ type: "microvm" });
		await vi.waitFor(() => expect(host.calls.some((call) => call.method === "sandbox.create")).toBe(true));
		await root.putSandboxGrants(sandbox.id, { grants: [{ action: "deny", host: "evil.example" }] });
		release();
		await vi.waitFor(async () => {
			await api.service.idle();
			const away = await api.store.sandboxes.get(sandbox.id);
			// Handed back where its machine is, due to stop: its host recorded with the intent, for the sweep.
			expect(away?.state).toBe("running");
			expect(away?.hostId).toBe(host.hostId);
			expect(away?.stopFor).toBe(UNENFORCED);
		});
		host.hold = undefined;
		host.connect();
		await vi.waitFor(async () => {
			await api.service.sweep();
			await api.service.idle();
			expect((await root.getSandbox(sandbox.id)).state).toBe("stopped");
		});
		expect(await historyOf(root, sandbox.id)).not.toContain("sandbox.running");
	});

	it("runs only once its host has the latest, though it changes again while that is sent", async () => {
		const { api, root, host } = await setup([HOST_FEATURES.egressPolicy]);
		const gates = new Map<string, () => void>();
		const holding = new Set(["sandbox.create", "sandbox.egress"]);
		host.hold = (method) => {
			if (!holding.has(method)) return undefined;
			holding.delete(method);
			return new Promise<void>((resolve) => gates.set(method, resolve));
		};
		const egressCalls = () => host.calls.filter((call) => call.method === "sandbox.egress");
		const sandbox = await root.createSandbox({ type: "microvm" });
		await vi.waitFor(() => expect(gates.has("sandbox.create")).toBe(true));
		await root.putSandboxGrants(sandbox.id, { grants: [{ action: "deny", host: "first.example" }] });
		gates.get("sandbox.create")?.();
		// The boot sends the first change, and the host is slow to take it; a second lands meanwhile.
		await vi.waitFor(() => expect(gates.has("sandbox.egress")).toBe(true));
		expect((await root.getSandbox(sandbox.id)).state).toBe("starting");
		await root.putSandboxGrants(sandbox.id, { grants: [{ action: "deny", host: "second.example" }] });
		expect((await root.getSandbox(sandbox.id)).state).toBe("starting");
		gates.get("sandbox.egress")?.();
		await api.service.idle();

		// It runs with the second sent too, the last thing its host was told, at its revision.
		expect((await root.getSandbox(sandbox.id)).state).toBe("running");
		const stored = await api.store.sandboxes.get(sandbox.id);
		const last = egressCalls().at(-1)?.params;
		expect(last).toMatchObject({
			egress: { revision: stored?.egressRevision, grants: [expect.objectContaining({ host: "second.example" })] },
		});
		expect(stored?.egressApplied).toBe(stored?.egressRevision);
		// Revisions only go up, in the order sent.
		const revisions = egressCalls().map((call) => (call.params.egress as { revision: number }).revision);
		expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
		expect(new Set(revisions).size).toBe(revisions.length);
	});
});

describe("a sandbox on a host that can't enforce grants, given one while its boot reconciles", () => {
	for (const where of ["sandbox", "environment"] as const) {
		it(`is stopped rather than run without it (a ${where} grant)`, async () => {
			const { api, root, host } = await setup();
			const environment = await root.createEnvironment({ name: "plain" });
			const gates = new Map<string, () => void>();
			const holding = new Set(["sandbox.create", "sandbox.egress"]);
			host.hold = (method) => {
				if (!holding.has(method)) return undefined;
				holding.delete(method);
				return new Promise<void>((resolve) => gates.set(method, resolve));
			};
			const sandbox = await root.createSandbox({ environment: environment.id });
			await vi.waitFor(() => expect(gates.has("sandbox.create")).toBe(true));
			// A change the old host can take (the account's proxy settings), so the boot sends it.
			await root.putProxySettings({ enabled: true, defaultAction: "allow", allow: [], deny: [] });
			gates.get("sandbox.create")?.();
			await vi.waitFor(() => expect(gates.has("sandbox.egress")).toBe(true));
			// While the host is slow to take it, a grant: let through (it isn't placed yet, as far as the check knows).
			const grants = [{ action: "deny" as const, host: "evil.example" }];
			if (where === "sandbox") await root.putSandboxGrants(sandbox.id, { grants });
			else await root.putEnvironmentGrants(environment.id, { grants });
			gates.get("sandbox.egress")?.();
			await api.service.idle();
			expect((await root.getSandbox(sandbox.id)).state).toBe("stopped");
			expect(await historyOf(root, sandbox.id)).toEqual(["sandbox.created", `sandbox.stopped: ${UNENFORCED}`]);
			expect(host.calls.some((call) => call.method === "sandbox.stop")).toBe(true);
			// The one update it was sent carried no grant.
			const sent = host.calls.filter((call) => call.method === "sandbox.egress");
			expect(sent).toHaveLength(1);
			expect(JSON.stringify(sent)).not.toContain("evil.example");
		});
	}
});

describe("a boot whose egress keeps changing as it is sent", () => {
	it("never runs behind: it is stopped once its rounds are spent", async () => {
		const { api, root, host } = await setup([HOST_FEATURES.egressPolicy]);
		let changes = 0;
		let started = false;
		let sandboxId = "";
		host.hold = (method) => {
			if (method === "sandbox.create") {
				// A first change before the create is answered, so the boot reconciles at all.
				sandboxId = host.calls.at(-1)?.params.sandboxId as string;
				return root.putSandboxGrants(sandboxId, { grants: [{ action: "deny", host: "0.example" }] }).then(() => {
					started = true;
				});
			}
			if (method !== "sandbox.egress" || !started) return undefined;
			// Each send is answered only once the next change is in.
			changes++;
			const grants = [{ action: "deny" as const, host: `${changes}.example` }];
			return root.putSandboxGrants(sandboxId, { grants }).then(() => undefined);
		};
		await root.createSandbox({ type: "microvm" });
		await vi.waitFor(async () => {
			await api.service.idle();
			expect((await root.getSandbox(sandboxId)).state).toBe("stopped");
		});
		expect(changes).toBeGreaterThanOrEqual(5);
		const history = await historyOf(root, sandboxId);
		expect(history).not.toContain("sandbox.running");
		expect(history.at(-1)).toBe("sandbox.stopped: Its egress couldn't be applied to it while it started");
	});
});

describe("a boot", () => {
	it("states its egress with its revision, none included, so an update read before it loses", async () => {
		const { api, root, host } = await setup([HOST_FEATURES.egressPolicy]);
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		await root.putSandboxGrants(sandbox.id, { grants: [{ action: "deny", host: "old.example" }] });
		await api.service.idle();
		const pushed = host.calls.filter((call) => call.method === "sandbox.egress").at(-1)?.params;
		await root.stopSandbox(sandbox.id, { wait: true });
		// Its grants all go while it is stopped: its boot has no egress, but its revision, past the last push's.
		await root.putSandboxGrants(sandbox.id, { grants: [] });
		await root.startSandbox(sandbox.id, { wait: true });
		const started = host.calls.filter((call) => call.method === "sandbox.start").at(-1)?.params;
		const stored = await api.store.sandboxes.get(sandbox.id);
		expect(started?.egress).toBeUndefined();
		expect(started?.revision).toBe(stored?.egressRevision);
		expect(started?.revision).toBeGreaterThan((pushed?.revision as number | undefined) ?? Number.POSITIVE_INFINITY);
		expect(stored?.state).toBe("running");
	});
});

describe("a running sandbox whose host turns out not to enforce its egress", () => {
	it("is stopped, not left running without it", async () => {
		const { api, root, host } = await setup();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		expect(sandbox.state).toBe("running");
		// A grant written past the up-front check (another gateway, as the sandbox was placed): the store has it, and
		// the sweep sends it.
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			grants: [{ id: "grt_1", action: "deny", host: "evil.example", createdAt: 1 }],
			egressRevision: (current.egressRevision ?? 0) + 1,
		}));
		await api.service.sweep();
		await api.service.idle();
		const after = await root.getSandbox(sandbox.id);
		expect(after.state).toBe("stopped");
		expect(host.calls.filter((call) => call.method === "sandbox.egress")).toEqual([]);
		expect(host.calls.some((call) => call.method === "sandbox.stop")).toBe(true);
		expect((await historyOf(root, sandbox.id)).at(-1)).toBe(`sandbox.stopped: ${UNENFORCED}`);
	});

	// A gateway takes on the stop (its own sweep, the real `beginStop`), then goes before its stop reaches the host.
	for (const retry of ["is refused again", "gets through"] as const) {
		it(`is stopped by another gateway once its claim lapses, though its egress retry ${retry}`, async () => {
			const supports = retry === "gets through";
			const { api, root, host, another } = await setup(supports ? [HOST_FEATURES.egressPolicy] : undefined);
			const sandbox = await root.createSandbox({ type: "microvm", wait: true });
			let gone = () => {};
			const goneStop = new Promise<void>((resolve) => {
				gone = resolve;
			});
			let stops = 0;
			host.hold = (method) => (method === "sandbox.stop" && stops++ === 0 ? goneStop : undefined);
			await api.store.sandboxes.update(sandbox.id, (current) => ({
				...current,
				grants: [{ id: "grt_1", action: "deny", host: "evil.example", createdAt: 1 }],
				egressRevision: (current.egressRevision ?? 0) + 1,
				// Due to stop for a reason of its own, when its host can enforce the grant.
				...(supports ? { stopsAt: Date.now(), stopFor: "Its egress couldn't be applied to it while it started" } : {}),
			}));
			const reason = supports ? "Its egress couldn't be applied to it while it started" : UNENFORCED;
			void api.service.sweep();
			await vi.waitFor(async () => {
				const claimed = await api.store.sandboxes.get(sandbox.id);
				expect(claimed?.state).toBe("stopping");
				expect(claimed?.stopClaimedAt).toBeDefined();
			});
			// Another gateway, within the claim, leaves it be.
			const soon = another(60_000);
			await soon.service.sweep();
			await soon.service.idle();
			expect((await api.store.sandboxes.get(sandbox.id))?.state).toBe("stopping");
			expect(stops).toBe(1);
			// Once it lapses, another gateway stops it, whether its egress retry is refused or taken.
			const later = another(10 * 60_000);
			await vi.waitFor(async () => {
				await later.service.sweep();
				await later.service.idle();
				expect((await root.getSandbox(sandbox.id)).state).toBe("stopped");
			});
			expect(stops).toBe(2);
			expect((await historyOf(root, sandbox.id)).at(-1)).toBe(`sandbox.stopped: ${reason}`);
			gone();
		});
	}

	it("is stopped by another gateway, when the boot that decided its stop went before taking it on", async () => {
		const { api, root, host, another } = await setup();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		// What enforceStop's first write leaves, its gateway gone before beginStop: starting, placed, due.
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			state: "starting",
			stopsAt: Date.now(),
			stopFor: UNENFORCED,
		}));
		const soon = another(60_000);
		await soon.service.sweep();
		await soon.service.idle();
		expect((await api.store.sandboxes.get(sandbox.id))?.state).toBe("starting");
		const later = another(10 * 60_000);
		await later.service.sweep();
		await later.service.idle();
		expect((await root.getSandbox(sandbox.id)).state).toBe("stopped");
		expect(host.calls.some((call) => call.method === "sandbox.stop")).toBe(true);
		expect((await historyOf(root, sandbox.id)).at(-1)).toBe(`sandbox.stopped: ${UNENFORCED}`);
	});

	it("is stopped once its host is back, when the stop didn't reach it", async () => {
		const { api, root, host } = await setup();
		const sandbox = await root.createSandbox({ type: "microvm", wait: true });
		// The host drops its link as the stop is sent: the stop isn't answered.
		host.hold = (method) => {
			if (method !== "sandbox.stop") return undefined;
			host.connection.closed(1006, "gone");
			return new Promise<void>(() => {});
		};
		await api.store.sandboxes.update(sandbox.id, (current) => ({
			...current,
			grants: [{ id: "grt_1", action: "deny", host: "evil.example", createdAt: 1 }],
			egressRevision: (current.egressRevision ?? 0) + 1,
		}));
		await api.service.sweep();
		await api.service.idle();
		// Not given up on (no `error` that nothing retries): running as its machine may be, and due to stop.
		const away = await api.store.sandboxes.get(sandbox.id);
		expect(away?.state).toBe("running");
		expect(away?.stopFor).toBe(UNENFORCED);
		expect(away?.stopsAt).toBeLessThanOrEqual(Date.now());
		// While it is away, sweeps leave it be; once it is back, a sweep stops it.
		await api.service.sweep();
		await api.service.idle();
		expect((await root.getSandbox(sandbox.id)).state).toBe("running");
		host.hold = undefined;
		host.connect();
		await vi.waitFor(async () => {
			await api.service.sweep();
			await api.service.idle();
			expect((await root.getSandbox(sandbox.id)).state).toBe("stopped");
		});
		expect((await historyOf(root, sandbox.id)).at(-1)).toBe(`sandbox.stopped: ${UNENFORCED}`);
		expect(host.calls.filter((call) => call.method === "sandbox.egress")).toEqual([]);
	});
});

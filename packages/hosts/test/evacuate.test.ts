// Moving every sandbox off a draining host (docs/design/disk-store.md, "Draining a host"), end to end through the
// compute API, the hosts service and its hub with fake kantel-hosts: the host is drained, each sandbox that can move
// goes to another host in its pool as a move does by default, two at a time, those that can't are skipped with the
// reason, and a control plane that goes away mid-way has its evacuation carried on by the next one's sweep.
// apps/host/test/evacuate.sh does it between three real hosts.
import { createKantelClient, type HostEvacuation, KantelApiError } from "@kantel/api/sdk";
import {
	type ComputeApi,
	type ComputeStore,
	createComputeApi,
	createMemoryStore,
	EVACUATION_LEASE_MS,
	joinTokenSpender,
	type PersonIdentity,
} from "@kantel/compute";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBackend } from "../src/backend.ts";
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

const MOVES = [
	HOST_FEATURES.mesh,
	HOST_FEATURES.sandboxMove,
	HOST_FEATURES.egressPolicy,
	HOST_FEATURES.sandboxMoveRunning,
	HOST_FEATURES.sandboxMoveMemory,
];
const FINGERPRINTS: Partial<HostFacts> = {
	cpu: { vendor: "AuthenticAMD", family: 25, model: 97, featuresHash: "sha256:0123456789abcdef" },
	runtimes: [{ image: "host-images-20261103", runtime: "firecracker=v1.17.0;kernel=6.1.155;sticky=2" }],
};

async function setup(options: { readonly now?: () => number } = {}) {
	const service = createHostsService({
		store: createMemoryHostStore(),
		publicUrl: "https://kantel.test",
		log: () => undefined,
		...(options.now === undefined ? {} : { clock: { now: options.now } }),
	});
	const backend = createHostBackend({
		hosts: service,
		publicUrl: "https://kantel.test",
		tickets: createTunnelTickets(createMemoryRelayStore()),
	});
	const store = createMemoryStore();
	/** A control plane over the same records and hosts: the first, or one started after it went. */
	const controlPlane = (on: ComputeStore) => {
		const api: ComputeApi = createComputeApi({
			backend,
			store: on,
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
		closers.push(() => api.close());
		const root = createKantelClient({
			baseUrl: "https://kantel.test/v1",
			token: "root",
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		return { api, root };
	};
	const first = controlPlane(store);
	closers.push(() => service.close());
	const pool = await first.root.createPool({ name: "agents", sync: true });
	let byte = 1;
	const join = async (into: string = pool.name) => {
		const token = await first.root.createHostJoinToken({ pool: into });
		const { hostId } = await service.register({ token: token.token });
		const host = new FakeHost(service, hostId, MOVES);
		host.moreFacts = { mesh: meshOf(byte++), ...FINGERPRINTS };
		host.connect();
		await vi.waitFor(() => expect(host.welcomed()).toBe(true));
		return host;
	};
	return { ...first, store, join, controlPlane: () => controlPlane(store) };
}

/** A microVM on `on`, running or stopped, let go of the pin its create on `on` gave it. */
async function sandboxOn(
	root: ReturnType<typeof createKantelClient>,
	api: ComputeApi,
	on: FakeHost,
	state: "running" | "stopped" | "pinned",
): Promise<string> {
	const made = await root.createSandbox({ type: "microvm", host: on.hostId, wait: true });
	on.disks.set(made.id, `disk of ${made.id}`);
	if (state !== "running") await root.stopSandbox(made.id, { wait: true });
	if (state !== "pinned") await api.store.sandboxes.update(made.id, (latest) => ({ ...latest, hostPin: undefined }));
	return made.id;
}

/** Holds every `sandbox.import` on `hosts` until released. */
function holdImports(hosts: readonly FakeHost[]): () => void {
	let release: () => void = () => undefined;
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	for (const host of hosts) host.hold = (method) => (method === "sandbox.import" ? held : undefined);
	return () => {
		for (const host of hosts) host.hold = undefined;
		release();
	};
}

const importsOn = (hosts: readonly FakeHost[]) =>
	hosts.flatMap((host) => host.calls.filter((call) => call.method === "sandbox.import")).length;

async function ended(root: ReturnType<typeof createKantelClient>, hostId: string): Promise<HostEvacuation> {
	return vi.waitFor(
		async () => {
			const evacuation = await root.getHostEvacuation(hostId);
			if (evacuation.state === "running") throw new Error("still running");
			return evacuation;
		},
		{ timeout: 15_000, interval: 50 },
	);
}

describe("moving every sandbox off a draining host", () => {
	it("drains it, moves each sandbox to another host in its pool two at a time, and skips one kept to it", async () => {
		const { root, api, join } = await setup();
		const a = await join();
		const b = await join();
		const c = await join();
		const running = [
			await sandboxOn(root, api, a, "running"),
			await sandboxOn(root, api, a, "running"),
			await sandboxOn(root, api, a, "running"),
		];
		const stopped = await sandboxOn(root, api, a, "stopped");
		const pinned = await sandboxOn(root, api, a, "pinned");
		const release = holdImports([b, c]);
		const begun = await root.startHostEvacuation(a.hostId);
		expect(begun).toMatchObject({ hostId: a.hostId, state: "running" });
		expect(begun.sandboxes.map((item) => item.sandboxId).sort()).toEqual([...running, stopped, pinned].sort());
		expect(begun.sandboxes.find((item) => item.sandboxId === pinned)).toMatchObject({
			state: "skipped",
			reason: expect.stringContaining("kept to this host"),
		});
		// Drained: nothing new lands on it as its sandboxes go.
		expect((await root.getHost(a.hostId)).state).toBe("draining");
		// Two at a time: the third waits for one of them to end.
		await vi.waitFor(() => expect(importsOn([b, c])).toBe(2));
		const under = await root.getHostEvacuation(a.hostId);
		expect(under.sandboxes.filter((item) => item.state === "moving")).toHaveLength(2);
		expect(under.sandboxes.find((item) => item.state === "moving")?.phase).toBe("copying");
		expect((await root.getHost(a.hostId)).evacuation).toMatchObject({ state: "running", remaining: 4, skipped: 1 });
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		expect(importsOn([b, c])).toBe(2);
		release();
		const done = await ended(root, a.hostId);
		expect(done).toMatchObject({ state: "done", moved: 4, remaining: 0, skipped: 1, failed: 0 });
		for (const id of [...running, stopped]) {
			const sandbox = await root.getSandbox(id);
			expect(sandbox.state).toBe("running");
			expect([b.hostId, c.hostId]).toContain(sandbox.hostId);
			expect(done.sandboxes.find((item) => item.sandboxId === id)).toMatchObject({
				state: "moved",
				hostId: sandbox.hostId,
			});
		}
		// The running ones kept their memory (the hosts match); the stopped one had none, and booted there.
		for (const id of running) {
			expect(done.sandboxes.find((item) => item.sandboxId === id)?.keptMemory).toBe(true);
		}
		expect(done.sandboxes.find((item) => item.sandboxId === stopped)?.keptMemory).toBe(false);
		expect((await root.getSandbox(pinned)).hostId).toBe(a.hostId);
		expect([...a.sandboxes.keys()]).toEqual([pinned]);
		expect((await root.getHost(a.hostId)).evacuation).toMatchObject({ state: "done", moved: 4 });
		// Asked again once it has ended, it begins again with what is still there.
		const again = await root.startHostEvacuation(a.hostId);
		expect(again.sandboxes.map((item) => item.sandboxId)).toEqual([pinned]);
		expect((await ended(root, a.hostId)).state).toBe("done");
	});

	it("skips a sandbox no other host in its pool can take, with the reason, and answers one running as it is", async () => {
		const { root, api, join } = await setup();
		const a = await join();
		await root.createPool({ name: "ci", sync: true });
		await join("ci");
		const stopped = await sandboxOn(root, api, a, "stopped");
		const begun = await root.startHostEvacuation(a.hostId);
		const twice = await root.startHostEvacuation(a.hostId);
		expect(twice.startedAt).toBe(begun.startedAt);
		const done = await ended(root, a.hostId);
		expect(done).toMatchObject({ state: "done", moved: 0, skipped: 1 });
		expect(done.sandboxes[0]).toMatchObject({ sandboxId: stopped, state: "skipped", reason: expect.any(String) });
		expect(await root.getSandbox(stopped)).toMatchObject({ state: "stopped", hostId: a.hostId });
	});

	it("stops once the host is undrained, and refuses a revoked host", async () => {
		const { root, api, join } = await setup();
		const a = await join();
		const b = await join();
		await sandboxOn(root, api, a, "stopped");
		await sandboxOn(root, api, a, "stopped");
		await sandboxOn(root, api, a, "stopped");
		const release = holdImports([b]);
		await root.startHostEvacuation(a.hostId);
		await vi.waitFor(() => expect(importsOn([b])).toBe(2));
		await root.updateHost(a.hostId, { draining: false });
		// Seen undrained while its two moves go on: it begins no more, and ends once they have.
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		expect((await root.getHostEvacuation(a.hostId)).state).toBe("running");
		release();
		const stopped = await ended(root, a.hostId);
		expect(stopped).toMatchObject({ state: "stopped", reason: "The host was undrained" });
		// The moves under way finished; the third was never begun.
		expect(stopped.moved).toBe(2);
		expect(importsOn([b])).toBe(2);
		await root.revokeHost(a.hostId);
		const refused = await root.startHostEvacuation(a.hostId).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(KantelApiError);
		expect((refused as KantelApiError).code).toBe("conflict");
	});

	it("begins no move once another gateway holds it, and is carried on once that hold runs out", async () => {
		const clock = { at: Date.now() };
		const { root, api, store, join } = await setup({ now: () => clock.at });
		const a = await join();
		const b = await join();
		for (let index = 0; index < 4; index++) await sandboxOn(root, api, a, "stopped");
		const release = holdImports([b]);
		await root.startHostEvacuation(a.hostId);
		await vi.waitFor(() => expect(importsOn([b])).toBe(2));
		// Its lease taken by another gateway (this one's run out as it stalled): it looks and begins no more.
		await store.evacuations.update(a.hostId, (current) => ({
			...current,
			lease: { token: "another", until: clock.at + EVACUATION_LEASE_MS },
		}));
		release();
		await vi.waitFor(async () =>
			expect((await store.evacuations.get(a.hostId))?.sandboxes.filter((item) => item.state === "moved")).toHaveLength(
				2,
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 2_500));
		expect(importsOn([b])).toBe(2);
		expect((await store.evacuations.get(a.hostId))?.lease?.token).toBe("another");
		expect((await store.evacuations.get(a.hostId))?.state).toBe("running");
		// That gateway gone too: the sweep here carries it on.
		clock.at += EVACUATION_LEASE_MS + 1;
		await api.service.sweep();
		expect(await ended(root, a.hostId)).toMatchObject({ state: "done", moved: 4 });
	});

	it("records a sandbox moved elsewhere as it waited as moved, and never moves it again", async () => {
		const { root, api, join } = await setup();
		const a = await join();
		const b = await join();
		const c = await join();
		const ids: string[] = [];
		for (let index = 0; index < 3; index++) ids.push(await sandboxOn(root, api, a, "stopped"));
		const release = holdImports([b]);
		// Every move of the evacuation goes to b, held, so the third waits its turn.
		await root.updateHost(c.hostId, { draining: true });
		await root.startHostEvacuation(a.hostId);
		await vi.waitFor(() => expect(importsOn([b])).toBe(2));
		const waiting = (await root.getHostEvacuation(a.hostId)).sandboxes.find((item) => item.state === "waiting");
		if (waiting === undefined) throw new Error("none waiting");
		await root.updateHost(c.hostId, { draining: false });
		const own = await root.moveSandbox(waiting.sandboxId, { hostId: c.hostId });
		expect(own.hostId).toBe(c.hostId);
		release();
		const done = await ended(root, a.hostId);
		expect(done).toMatchObject({ state: "done", moved: 3 });
		expect(done.sandboxes.find((item) => item.sandboxId === waiting.sandboxId)).toMatchObject({
			state: "moved",
			hostId: c.hostId,
		});
		const movesOf = (host: FakeHost) =>
			host.calls.filter((call) => call.method === "sandbox.import" && call.params.sandboxId === waiting.sandboxId);
		expect(movesOf(b)).toHaveLength(0);
		expect(movesOf(c)).toHaveLength(1);
	});

	it("holds its moves to the scopes of the key that began it", async () => {
		const { root, api, store, join } = await setup();
		const a = await join();
		await join();
		await sandboxOn(root, api, a, "stopped");
		const issued = await root.createApiKey({ name: "hosts", scopes: ["hosts:admin"] });
		const key = createKantelClient({
			baseUrl: "https://kantel.test/v1",
			token: issued.secret,
			fetch: (input, init) =>
				api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
		});
		await key.startHostEvacuation(a.hostId);
		expect((await store.evacuations.get(a.hostId))?.by).toMatchObject({ superAdmin: true, scopes: ["hosts:admin"] });
		expect((await ended(root, a.hostId)).moved).toBe(1);
	});

	it("settles the moves an ended evacuation left moving, from their sandboxes' records", async () => {
		const { root, api, store, join } = await setup();
		const a = await join();
		await join();
		const moved = await sandboxOn(root, api, a, "stopped");
		const stayed = await sandboxOn(root, api, a, "pinned");
		await root.startHostEvacuation(a.hostId);
		await ended(root, a.hostId);
		// As one undrained (or its host revoked) with two moves it took on from a gateway gone, still under way then.
		await store.evacuations.update(a.hostId, (current) => ({
			...current,
			state: "stopped",
			sandboxes: current.sandboxes.map((item) => ({ ...item, state: "moving" as const, claim: "gone" })),
		}));
		await api.service.sweep();
		await vi.waitFor(async () => {
			const settled = await store.evacuations.get(a.hostId);
			expect(settled?.sandboxes.find((item) => item.sandboxId === moved)?.state).toBe("moved");
			expect(settled?.sandboxes.find((item) => item.sandboxId === stayed)).toMatchObject({
				state: "failed",
				reason: expect.stringContaining("didn't finish"),
			});
		});
		expect((await root.getHostEvacuation(a.hostId)).state).toBe("stopped");
	});

	it("is carried on by the next control plane's sweep once the one carrying it on has gone", async () => {
		const clock = { at: Date.now() };
		const { root, api, store, join, controlPlane } = await setup({ now: () => clock.at });
		const a = await join();
		const b = await join();
		const c = await join();
		const ids: string[] = [];
		for (let index = 0; index < 5; index++) ids.push(await sandboxOn(root, api, a, "stopped"));
		const release = holdImports([b, c]);
		await root.startHostEvacuation(a.hostId);
		await vi.waitFor(() => expect(importsOn([b, c])).toBe(2));
		// The first control plane goes, its two moves finishing as it closes.
		const closed = api.close();
		release();
		await closed;
		const left = await store.evacuations.get(a.hostId);
		expect(left?.state).toBe("running");
		expect(left?.sandboxes.filter((item) => item.state === "moved")).toHaveLength(2);
		// As a control plane that died leaves it: still held, and one more move begun whose sandbox never got its own.
		const cut = left?.sandboxes.find((item) => item.state === "waiting")?.sandboxId;
		await store.evacuations.update(a.hostId, (current) => ({
			...current,
			lease: { token: "gone", until: clock.at + EVACUATION_LEASE_MS },
			sandboxes: current.sandboxes.map((item) =>
				item.sandboxId === cut ? { ...item, state: "moving" as const } : item,
			),
		}));
		const next = controlPlane();
		// Not before its lease runs out.
		await next.api.service.sweep();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect((await store.evacuations.get(a.hostId))?.lease?.token).toBe("gone");
		clock.at += EVACUATION_LEASE_MS + 1;
		await next.api.service.sweep();
		const done = await ended(next.root, a.hostId);
		expect(done).toMatchObject({ state: "done", moved: 5, remaining: 0 });
		// The one cut short was moved again.
		expect(done.sandboxes.find((item) => item.sandboxId === cut)).toMatchObject({ state: "moved" });
		for (const id of ids) expect([b.hostId, c.hostId]).toContain((await next.root.getSandbox(id)).hostId);
		expect(a.sandboxes.size).toBe(0);
	});
});

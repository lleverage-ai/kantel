// The pools' meshes (docs/design/disk-store.md, "2a. The mesh"), end to end through the compute API, the hosts service
// and its hub with fake kantel-hosts: a host that runs the mesh, in a pool with sync on, gets its mesh address and its
// pool's other hosts in its welcome, and `mesh.peers` whenever they change. Pools never peer, a revoked host leaves its
// peers' lists at once, and a host without the feature, or in a pool with sync off, gets nothing and behaves as before.
import { createKantelClient } from "@kantel/api/sdk";
import { type ComputeApi, createComputeApi, joinTokenSpender, type PersonIdentity } from "@kantel/compute";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBackend } from "../src/backend.ts";
import { parseHostFacts } from "../src/facts.ts";
import { formatIPv6, meshAddressCandidate, meshAddressFor, meshPrefix } from "../src/mesh.ts";
import { HOST_FEATURES, type HostMeshFacts, type HostMeshPeer, type HostWelcome } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";
import { FakeHost, facts } from "./fake-host.ts";

const PEOPLE: { readonly [token: string]: PersonIdentity } = {
	root: { userId: "usr_root", name: "Root", superAdmin: true },
};

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

/** A WireGuard public key, as WireGuard writes one: 32 bytes of `byte`, in base64. */
const key = (byte: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)));

const meshOf = (byte: number, endpoints: readonly string[] = [`[2001:db8::${byte}]:51820`]): HostMeshFacts => ({
	publicKey: key(byte),
	listenPort: 51820,
	endpoints,
});

function setup() {
	const service = createHostsService({ store: createMemoryHostStore(), publicUrl: "https://kantel.test" });
	const api: ComputeApi = createComputeApi({
		backend: createHostBackend({
			hosts: service,
			publicUrl: "https://kantel.test",
			tickets: createTunnelTickets(createMemoryRelayStore()),
		}),
		authenticatePerson: async (request) =>
			PEOPLE[request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""],
		fetch: async () => new Response(null, { status: 204 }),
		publicUrl: "https://kantel.test",
	});
	service.useJoinTokens(joinTokenSpender(api.store));
	service.useCompute({
		secrets: async () => undefined,
		recordEgress: async () => undefined,
		poolSync: (poolId) => api.service.poolSync(poolId),
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
	/** Joins a host to `pool` and connects it, running the mesh with `mesh` (none: a host without the feature). */
	const join = async (pool: string | undefined, mesh?: HostMeshFacts) => {
		const token = await root.createHostJoinToken({ ...(pool === undefined ? {} : { pool }) });
		const { hostId } = await service.register({ token: token.token, facts: facts() });
		const host = new FakeHost(service, hostId, mesh === undefined ? undefined : [HOST_FEATURES.mesh]);
		if (mesh !== undefined) host.moreFacts = { mesh };
		host.connect();
		await vi.waitFor(() => expect(host.welcomed()).toBe(true));
		return host;
	};
	return { service, api, root, join };
}

const welcomes = (host: FakeHost): HostWelcome[] =>
	host.sent.flatMap((message) =>
		message.type === "welcome" && message.welcome !== undefined ? [message.welcome] : [],
	);
const lastWelcome = (host: FakeHost): HostWelcome | undefined => welcomes(host).at(-1);
const peerLists = (host: FakeHost): (readonly HostMeshPeer[])[] =>
	host.sent.flatMap((message) => (message.type === "mesh.peers" ? [message.peers ?? []] : []));
const lastPeers = (host: FakeHost): readonly string[] | undefined =>
	peerLists(host)
		.at(-1)
		?.map((peer) => peer.hostId);

describe("Mesh addresses", () => {
	it("writes IPv6 as RFC 5952 does", () => {
		const bytes = (groups: number[]) => Uint8Array.from(groups.flatMap((group) => [group >> 8, group & 0xff]));
		expect(formatIPv6(bytes([0xfd12, 0x3456, 0x789a, 0, 0, 0, 0, 1]))).toBe("fd12:3456:789a::1");
		expect(formatIPv6(bytes([0xfd12, 0x3456, 0x789a, 0, 0xabc, 0, 0, 0]))).toBe("fd12:3456:789a:0:abc::");
		// The longest run of zeros, and of two as long, the first.
		expect(formatIPv6(bytes([0xfd00, 0, 0, 1, 0, 0, 0, 2]))).toBe("fd00:0:0:1::2");
		expect(formatIPv6(bytes([0xfd00, 0, 0, 1, 0, 0, 2, 3]))).toBe("fd00::1:0:0:2:3");
		expect(formatIPv6(bytes([1, 2, 3, 4, 5, 6, 7, 8]))).toBe("1:2:3:4:5:6:7:8");
	});

	it("gives each pool its own /48 ULA and each host a stable /128 in it, unique in the pool", async () => {
		const prefix = await meshPrefix("pool_ci");
		expect(prefix).toMatch(/^fd[0-9a-f]{2}:[0-9a-f]{1,4}:[0-9a-f]{1,4}::\/48$/);
		expect(await meshPrefix("pool_ci")).toBe(prefix);
		expect(await meshPrefix("pool_web")).not.toBe(prefix);
		const head = prefix.replace(/::\/48$/, ":");
		const addresses = new Set<string>();
		for (let at = 0; at < 200; at += 1) {
			const address = await meshAddressFor("pool_ci", `host_${at}`, addresses);
			expect(address?.startsWith(head)).toBe(true);
			expect(await meshAddressFor("pool_ci", `host_${at}`, new Set())).toBe(address);
			if (address !== undefined) addresses.add(address);
		}
		expect(addresses.size).toBe(200);
		// One another host has is passed over for the next.
		const first = await meshAddressCandidate("pool_ci", "host_x", 0);
		const second = await meshAddressFor("pool_ci", "host_x", new Set([first]));
		expect(second).toBe(await meshAddressCandidate("pool_ci", "host_x", 1));
	});

	it("keeps a host's mesh facts as it sends them, and drops malformed ones rather than refusing the hello", () => {
		const endpoints = ["[2001:db8::5]:51820", "203.0.113.9:51820", "mesh.example.com:6000"];
		const parsed = parseHostFacts({ ...facts(), mesh: { publicKey: key(7), listenPort: 51820, endpoints } });
		expect(parsed.ok && parsed.value.mesh).toEqual({ publicKey: key(7), listenPort: 51820, endpoints });
		for (const mesh of [
			{ publicKey: "k", listenPort: 51820, endpoints },
			{ publicKey: key(7), listenPort: 0, endpoints },
			{ publicKey: key(7), listenPort: 70000, endpoints },
			"mesh",
		]) {
			const dropped = parseHostFacts({ ...facts(), mesh });
			expect(dropped.ok).toBe(true);
			expect(dropped.ok && dropped.value.mesh).toBeUndefined();
		}
		// Go marshals no endpoints as null.
		const none = parseHostFacts({ ...facts(), mesh: { publicKey: key(7), listenPort: 51820, endpoints: null } });
		expect(none.ok && none.value.mesh?.endpoints).toEqual([]);
	});
});

describe("Pool meshes", () => {
	it("gives each host of a pool with sync on its address and its pool's other hosts, and tells them of a new one", async () => {
		const { root, join, service } = setup();
		const ci = await root.createPool({ name: "ci", sync: true });
		expect(ci.sync).toBe(true);
		const a = await join("ci", meshOf(1));
		const welcomeA = lastWelcome(a);
		const prefix = await meshPrefix(ci.id);
		expect(welcomeA?.mesh?.prefix).toBe(prefix);
		expect(welcomeA?.mesh?.address.startsWith(prefix.replace(/::\/48$/, ":"))).toBe(true);
		expect(welcomeA?.mesh?.peers).toEqual([]);

		const b = await join("ci", meshOf(2, ["[2001:db8::2]:51820", "198.51.100.2:51820"]));
		const welcomeB = lastWelcome(b);
		expect(welcomeB?.mesh?.prefix).toBe(prefix);
		expect(welcomeB?.mesh?.address).not.toBe(welcomeA?.mesh?.address);
		expect(welcomeB?.mesh?.peers).toEqual([
			{ hostId: a.hostId, publicKey: key(1), address: welcomeA?.mesh?.address, endpoints: ["[2001:db8::1]:51820"] },
		]);
		// A is told of B, with every endpoint B reported, as it reported them.
		await vi.waitFor(() => expect(lastPeers(a)).toEqual([b.hostId]));
		expect(peerLists(a).at(-1)).toEqual([
			{
				hostId: b.hostId,
				publicKey: key(2),
				address: welcomeB?.mesh?.address,
				endpoints: ["[2001:db8::2]:51820", "198.51.100.2:51820"],
			},
		]);
		// B isn't told of itself.
		expect(peerLists(b).every((peers) => peers.every((peer) => peer.hostId !== b.hostId))).toBe(true);

		// A reconnects: the same address, and B isn't told again (nothing it sees changed).
		const told = peerLists(b).length;
		a.connect();
		await vi.waitFor(() => expect(welcomes(a).length).toBe(2));
		expect(lastWelcome(a)?.mesh?.address).toBe(welcomeA?.mesh?.address);
		expect(lastWelcome(a)?.mesh?.peers.map((peer) => peer.hostId)).toEqual([b.hostId]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(peerLists(b).length).toBe(told);

		// A reinstalled: a new key on its next hello replaces the old, and B is told.
		a.moreFacts = { mesh: meshOf(9) };
		a.connect();
		await vi.waitFor(() => expect(peerLists(b).at(-1)?.[0]?.publicKey).toBe(key(9)));
		expect(peerLists(b).at(-1)?.[0]?.address).toBe(welcomeA?.mesh?.address);
		expect((await service.get(a.hostId)).id).toBe(a.hostId);
	});

	it("never peers hosts of different pools, nor a host without the mesh", async () => {
		const { root, join } = setup();
		await root.createPool({ name: "ci", sync: true });
		await root.createPool({ name: "web", sync: true });
		const a = await join("ci", meshOf(1));
		const other = await join("web", meshOf(2));
		const old = await join("ci");
		const b = await join("ci", meshOf(3));
		expect(lastWelcome(b)?.mesh?.peers.map((peer) => peer.hostId)).toEqual([a.hostId]);
		expect(lastWelcome(other)?.mesh?.peers).toEqual([]);
		expect(lastWelcome(other)?.mesh?.prefix).not.toBe(lastWelcome(a)?.mesh?.prefix);
		await vi.waitFor(() => expect(lastPeers(a)).toEqual([b.hostId]));
		// A host without the feature gets no mesh fields: its welcome is as before, and it is sent no peers.
		expect(welcomes(old).every((welcome) => welcome.mesh === undefined)).toBe(true);
		expect(peerLists(old)).toEqual([]);
		expect(peerLists(other)).toEqual([]);
	});

	it("sends nothing of the mesh to hosts in a pool with sync off, and brings them in and out as it is turned on and off", async () => {
		const { root, join } = setup();
		const ci = await root.createPool({ name: "ci" });
		expect(ci.sync).toBe(false);
		const a = await join("ci", meshOf(1));
		const b = await join("ci", meshOf(2));
		expect(welcomes(a).every((welcome) => welcome.mesh === undefined)).toBe(true);
		expect(lastWelcome(b)?.mesh).toBeUndefined();
		expect(peerLists(a)).toEqual([]);

		// On: each is welcomed again with its place in the mesh.
		expect((await root.updatePool("ci", { sync: true })).sync).toBe(true);
		await vi.waitFor(() => expect(lastWelcome(a)?.mesh?.peers.map((peer) => peer.hostId)).toEqual([b.hostId]));
		await vi.waitFor(() => expect(lastWelcome(b)?.mesh?.peers.map((peer) => peer.hostId)).toEqual([a.hostId]));

		// Off: an empty list, and a welcome without the mesh, which takes it down.
		expect((await root.updatePool("ci", { sync: false })).sync).toBe(false);
		await vi.waitFor(() => expect(lastWelcome(a)?.mesh).toBeUndefined());
		expect(lastPeers(a)).toEqual([]);
		await vi.waitFor(() => expect(lastWelcome(b)?.mesh).toBeUndefined());
		expect(lastPeers(b)).toEqual([]);
		// A rename leaves it as it is: nothing more is sent.
		const sent = a.sent.length;
		await root.updatePool("ci", { name: "builds" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(a.sent.length).toBe(sent);
	});

	it("takes a revoked host out of its peers' lists at once", async () => {
		const { root, join } = setup();
		await root.createPool({ name: "ci", sync: true });
		const a = await join("ci", meshOf(1));
		const b = await join("ci", meshOf(2));
		const c = await join("ci", meshOf(3));
		await vi.waitFor(() => expect(lastPeers(a)).toEqual([b.hostId, c.hostId]));
		await root.revokeHost(b.hostId);
		// Told by the time the revoke is answered.
		expect(lastPeers(a)).toEqual([c.hostId]);
		await vi.waitFor(() => expect(lastPeers(c)).toEqual([a.hostId]));
		expect(b.closedWith).toBeDefined();
	});

	it("takes a host moved to another pool out of the old pool's mesh and into the new one's", async () => {
		const { root, join } = setup();
		const ci = await root.createPool({ name: "ci", sync: true });
		const web = await root.createPool({ name: "web", sync: true });
		const a = await join("ci", meshOf(1));
		const b = await join("ci", meshOf(2));
		const w = await join("web", meshOf(3));
		await vi.waitFor(() => expect(lastPeers(a)).toEqual([b.hostId]));
		const before = lastWelcome(b)?.mesh?.address;
		await root.updateHost(b.hostId, { draining: true });
		await root.updateHost(b.hostId, { pool: "web" });
		// The old pool's hosts no longer list it, the new pool's do, and it is welcomed with its place in the new pool.
		expect(lastPeers(a)).toEqual([]);
		expect(lastPeers(w)).toEqual([b.hostId]);
		const webPrefix = await meshPrefix(web.id);
		await vi.waitFor(() => expect(lastWelcome(b)?.mesh?.prefix).toBe(webPrefix));
		expect(lastWelcome(b)?.mesh?.address).not.toBe(before);
		expect(lastWelcome(b)?.mesh?.peers.map((peer) => peer.hostId)).toEqual([w.hostId]);
		expect(await meshPrefix(ci.id)).not.toBe(await meshPrefix(web.id));
	});
});

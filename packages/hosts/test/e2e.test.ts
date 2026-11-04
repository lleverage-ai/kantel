// End-to-end encryption through the gateway (`@kantel/e2e`), end to end: the compute API keeps an organisation's
// chain and hands out a tunnel to the host's E2E responder (port 0), the host joins the chain over its credential, and
// a device's Noise session crosses the hub as stream frames. The host here is kantel-host's TypeScript twin
// (`serveSession`); the Go host replays the same bytes (apps/host/internal/e2e). What the hub carried, either way, is
// checked for the command and its output, and a key the gateway slips into the chain is refused by the host.
import { createKantelClient, KantelApiError } from "@kantel/api/sdk";
import { type ComputeApi, createComputeApi, joinTokenSpender } from "@kantel/compute";
import { utf8 } from "@kantel/e2e/bytes";
import {
	type ChainEntry,
	chainDevice,
	createHostTicket,
	extendChain,
	type SpaceState,
	signEntry,
	signHostEntry,
	verifyChain,
} from "@kantel/e2e/chain";
import { type Identity, keyId, newIdentity } from "@kantel/e2e/keys";
import { serveSession } from "@kantel/e2e/responder";
import { type ByteChannel, openSession, SessionClient } from "@kantel/e2e/session";
import { contains } from "@kantel/e2e/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createHostBackend } from "../src/backend.ts";
import { createHostsApi, HOSTS_E2E_CHAIN_PATH } from "../src/http.ts";
import { decodeStreamFrame, encodeStreamFrame, type HostFacts, type HostMessage } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService, type HostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { createTunnelTickets, HOSTS_TUNNEL_PATH } from "../src/tunnel.ts";

const SECRET_COMMAND = "cat /home/user/.env | grep OPENAI_API_KEY";
const SECRET_OUTPUT = "OPENAI_API_KEY=sk-live-the-secret-value";

const facts: HostFacts = {
	version: "0.1.0",
	protocol: 1,
	os: "linux",
	arch: "amd64",
	kernel: "6.8",
	hostname: "box",
	cpus: 16,
	memoryMiB: 32_768,
	diskGiB: 500,
	kvm: true,
	nested: true,
	tiers: ["microvm"],
	sizes: [{ name: "default", vcpus: 2, memoryMiB: 2048, diskGiB: 20 }],
	egress: "open",
};

/**
 * kantel-host with E2E: lifecycle calls from the gateway as usual, and a port.open of port 0 served by the E2E
 * responder over the space's chain, which it verifies from the genesis it pinned. Every stream frame either way is kept.
 */
class E2EHost {
	readonly identity: Promise<Identity> = newIdentity();
	readonly frames: { toHost: Uint8Array[]; toGateway: Uint8Array[] } = { toHost: [], toGateway: [] };
	readonly ran: { device: string; method: string; params: unknown }[] = [];
	state: SpaceState | undefined;
	refused: string[] = [];
	private receive!: (data: string | Uint8Array) => void;
	private readonly streams = new Map<number, (bytes: Uint8Array) => void>();
	private readonly closers = new Map<number, (reason: string) => void>();

	constructor(
		readonly service: HostsService,
		readonly hostId: string,
	) {}

	connect() {
		const held = this.service.hub.accept(this.hostId, {
			sendText: (text) => this.onText(JSON.parse(text) as HostMessage),
			sendBinary: (bytes) => this.onBinary(bytes),
			close: () => undefined,
		});
		this.receive = (data) => held.receive(data);
		this.receive(
			JSON.stringify({
				type: "hello",
				hello: {
					hostId: this.hostId,
					facts,
					sandboxes: [],
					capacity: { freeMemoryMiB: 30_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0, warm: {} },
				},
			}),
		);
	}

	private onBinary(bytes: Uint8Array) {
		this.frames.toHost.push(bytes.slice());
		const frame = decodeStreamFrame(bytes);
		if (frame !== undefined) this.streams.get(frame.stream)?.(frame.payload);
	}

	private send(stream: number, bytes: Uint8Array) {
		const frame = encodeStreamFrame(stream, bytes);
		this.frames.toGateway.push(frame.slice());
		this.receive(frame);
	}

	private onText(message: HostMessage) {
		if (message.type === "stream.close") {
			this.closers.get(message.stream ?? -1)?.(message.reason ?? "closed");
			return;
		}
		if (message.type !== "call") return;
		const p = message.params as { [key: string]: unknown };
		const answer = (result: unknown) => this.receive(JSON.stringify({ type: "result", id: message.id, result }));
		switch (message.method) {
			case "sandbox.create":
				return answer({ id: p.sandboxId, tier: "microvm", size: "default", state: "running", createdAt: 1 });
			case "sandbox.egress":
				return answer({ ok: true });
			case "port.open": {
				if (p.port !== 0 || this.state === undefined) {
					return this.receive(
						JSON.stringify({ type: "result", id: message.id, error: { code: "unsupported", message: "no" } }),
					);
				}
				const stream = Number(p.stream);
				answer({ ok: true });
				void this.serve(stream, String(p.sandboxId));
				return;
			}
			default:
				return this.receive(
					JSON.stringify({
						type: "result",
						id: message.id,
						error: { code: "unsupported", message: `The gateway may not call ${message.method}` },
					}),
				);
		}
	}

	private async serve(stream: number, sandboxId: string) {
		let listener: ((bytes: Uint8Array) => void) | undefined;
		const pending: Uint8Array[] = [];
		const closeListeners: ((reason: string) => void)[] = [];
		this.streams.set(stream, (bytes) => (listener === undefined ? pending.push(bytes) : listener(bytes)));
		this.closers.set(stream, (reason) => {
			for (const close of closeListeners) close(reason);
		});
		const channel: ByteChannel = {
			send: (bytes) => this.send(stream, bytes),
			onData: (next) => {
				listener = next;
				for (const bytes of pending.splice(0)) next(bytes);
			},
			onClose: (next) => closeListeners.push(next),
			close: () => this.receive(JSON.stringify({ type: "stream.close", stream, reason: "closed by the host" })),
		};
		const reason = await serveSession({
			channel,
			static: (await this.identity).static,
			hostId: this.hostId,
			chain: {
				state: () => this.state as SpaceState,
				extend: async (from, entries) => {
					this.state = await extendChain(this.state as SpaceState, entries, from);
					return this.state;
				},
			},
			authorize: (_device, hello) => (hello.sandbox === sandboxId ? undefined : "Relayed for another sandbox"),
			rpc: async (device, _sandbox, method, params) => {
				this.ran.push({ device: device.id, method, params });
				return { exitCode: 0, stdout: `${SECRET_OUTPUT}\n`, stderr: "" };
			},
		});
		this.refused.push(reason);
	}
}

const ROOT = { userId: "usr_root", name: "Root", superAdmin: true };
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

async function setup() {
	const service = createHostsService({ store: createMemoryHostStore(), publicUrl: "https://kantel.test" });
	const tickets = createTunnelTickets(createMemoryRelayStore());
	const api: ComputeApi = createComputeApi({
		backend: createHostBackend({ hosts: service, publicUrl: "https://kantel.test", tickets, attributionKey: "k" }),
		authenticatePerson: async (request) => (request.headers.get("authorization") === "Bearer root" ? ROOT : undefined),
		fetch: async () => new Response(null, { status: 204 }),
		publicUrl: "https://kantel.test",
	});
	service.useJoinTokens(joinTokenSpender(api.store));
	service.useCompute({
		secrets: async () => undefined,
		recordEgress: async () => undefined,
		e2eChain: {
			read: (hostId, space) => api.service.hostE2EChain(hostId, space),
			append: (hostId, space, from, entries) => api.service.appendHostE2EChain(hostId, space, from, entries),
		},
	});
	const hostsApi = createHostsApi({ hosts: service, authorizeAdmin: async () => undefined });
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
	const token = await root.createHostJoinToken({ name: "rack-1" });
	const { hostId, credential } = await service.register({ token: token.token, facts });
	const host = new E2EHost(service, hostId);
	host.connect();
	/** The host's own chain call, with its credential. */
	const hostCall = async (method: "GET" | "POST", space: string, body?: object) => {
		const url = `https://kantel.test${HOSTS_E2E_CHAIN_PATH}${method === "GET" ? `?space=${space}` : ""}`;
		const response = await hostsApi.fetch(
			new Request(url, {
				method,
				headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		return (await (response as Response).json()) as { entries: ChainEntry[] };
	};
	return { service, api, root, tickets, host, hostId, hostCall };
}

/** An organisation's E2E space through the API: Root's device starts it, the host joins it with Root's ticket. */
async function space() {
	const s = await setup();
	const sandbox = await s.root.createSandbox({ type: "microvm", wait: true });
	const accountId = sandbox.accountId;
	const device = await newIdentity();
	const by = { id: await keyId("kd", device.signer.publicKey), signer: device.signer };
	const genesis = await signEntry(
		undefined,
		accountId,
		{
			type: "genesis",
			body: { mode: "on", device: await chainDevice(device, ROOT.userId, "cli", "kantel on laptop") },
		},
		by,
		Date.now(),
	);
	await s.root.appendE2EChain(accountId, { from: 0, entries: [genesis] });
	let state = await verifyChain([genesis]);
	// `kantel-host e2e join`: the host fetches the chain over its credential, pins the ticket's genesis, signs its own
	// host.add with the ticket's key and publishes it.
	const ticket = await createHostTicket(state, by, "rack-1", Date.now() + 600_000);
	const fetched = await s.hostCall("GET", accountId);
	const pinned = state.genesis; // The ticket's, which the host reads from it.
	const hostState = await verifyChain(fetched.entries, pinned);
	const hostAdd = await signHostEntry(hostState, ticket, { id: s.hostId, identity: await s.host.identity }, Date.now());
	const published = await s.hostCall("POST", accountId, { space: accountId, from: 1, entries: [hostAdd] });
	s.host.state = await verifyChain(published.entries, pinned);
	// The device reads the chain back and verifies it from its own genesis.
	const entries = (await s.root.getE2EChain(accountId)).entries;
	state = await verifyChain(entries, state.genesis);
	return { ...s, sandbox, accountId, device, by, state, entries };
}

/** The relay's stream to the host's E2E responder, from the URL `openE2E` answered, as the gateway's tunnel opens it. */
async function tunnel(s: Awaited<ReturnType<typeof setup>>, url: string): Promise<ByteChannel> {
	const ticket = url.slice(url.indexOf(HOSTS_TUNNEL_PATH) + HOSTS_TUNNEL_PATH.length + 1);
	const grant = await s.tickets.verify(ticket, Date.now());
	if (grant === undefined) throw new Error("The ticket doesn't verify");
	let listener: ((bytes: Uint8Array) => void) | undefined;
	const pending: Uint8Array[] = [];
	const closeListeners: ((reason: string) => void)[] = [];
	const stream = await s.service.sandboxes.openPort(grant.sandboxId, grant.port, {
		data: (bytes) => (listener === undefined ? pending.push(bytes) : listener(bytes)),
		end: (reason) => {
			for (const close of closeListeners) close(reason);
		},
	});
	return {
		send: (bytes) => stream.write(bytes),
		onData: (next) => {
			listener = next;
			for (const bytes of pending.splice(0)) next(bytes);
		},
		onClose: (next) => closeListeners.push(next),
		close: () => stream.close(),
	};
}

const joined = (frames: readonly Uint8Array[]) => {
	const out = new Uint8Array(frames.reduce((n, frame) => n + frame.byteLength, 0));
	let at = 0;
	for (const frame of frames) {
		out.set(frame, at);
		at += frame.byteLength;
	}
	return out;
};

describe("E2E through the gateway", () => {
	it("runs a member's command on the host through the hub, which carries only ciphertext", async () => {
		const s = await space();
		const access = await s.root.openE2E(s.sandbox.id, {});
		expect(access).toMatchObject({ hostId: s.hostId, accountId: s.accountId });
		const client = new SessionClient(
			await openSession({
				channel: await tunnel(s, access.url),
				static: s.device.static,
				state: s.state,
				entries: s.entries,
				hostId: access.hostId,
				sandbox: s.sandbox.id,
				op: "rpc",
			}),
		);
		const result = await client.call<{ stdout: string }>("sandbox.exec", { command: SECRET_COMMAND });
		expect(result.stdout).toBe(`${SECRET_OUTPUT}\n`);
		expect(s.host.ran).toEqual([{ device: s.by.id, method: "sandbox.exec", params: { command: SECRET_COMMAND } }]);
		client.close();
		const toHost = joined(s.host.frames.toHost);
		const toGateway = joined(s.host.frames.toGateway);
		expect(toHost.byteLength).toBeGreaterThan(0);
		for (const secret of [SECRET_COMMAND, "OPENAI_API_KEY", "sk-live-the-secret-value", "sandbox.exec"]) {
			expect(contains(toHost, utf8(secret))).toBe(false);
			expect(contains(toGateway, utf8(secret))).toBe(false);
		}
		expect(contains(toHost, s.device.static.publicKey)).toBe(false);
	});

	it("keeps no chain that wouldn't verify, and no second entry at one seq", async () => {
		const s = await space();
		const intruder = await newIdentity();
		const forged = await signEntry(
			s.state,
			s.accountId,
			{ type: "device.add", body: { device: await chainDevice(intruder, ROOT.userId, "cli", "not Root's") } },
			{ id: await keyId("kd", intruder.signer.publicKey), signer: intruder.signer },
			Date.now(),
		);
		const refused = await s.root.appendE2EChain(s.accountId, { from: 2, entries: [forged] }).catch((error) => error);
		expect(refused).toBeInstanceOf(KantelApiError);
		expect((refused as KantelApiError).code).toBe("invalid");
		const mode = await signEntry(s.state, s.accountId, { type: "mode", body: { mode: "strict" } }, s.by, Date.now());
		await s.root.appendE2EChain(s.accountId, { from: 2, entries: [mode] });
		const late = await s.root.appendE2EChain(s.accountId, { from: 2, entries: [mode] }).catch((error) => error);
		expect((late as KantelApiError).code).toBe("conflict");
		// A host appends only its own host.add.
		await expect(
			s.hostCall("POST", s.accountId, { space: s.accountId, from: 3, entries: [mode] }),
		).resolves.toMatchObject({
			error: { code: "forbidden" },
		});
	});

	it("refuses a device the gateway put in the chain itself", async () => {
		const s = await space();
		// The gateway, or whoever holds its database, signs a device.add with a key of its own and stores it unchecked.
		const gateway = await newIdentity();
		const forged = await signEntry(
			s.state,
			s.accountId,
			{ type: "device.add", body: { device: await chainDevice(gateway, ROOT.userId, "cli", "kantel on laptop") } },
			{ id: await keyId("kd", gateway.signer.publicKey), signer: gateway.signer },
			Date.now(),
		);
		await s.api.store.e2eChain.insert({
			id: `${s.accountId}#${String(2).padStart(10, "0")}`,
			space: s.accountId,
			seq: 2,
			payload: forged.payload,
			sig: forged.sig,
			addedAt: Date.now(),
		});
		const access = await s.root.openE2E(s.sandbox.id, {});
		const entries = (await s.root.getE2EChain(s.accountId)).entries;
		expect(entries).toHaveLength(3);
		// The gateway's own device, bringing its chain to the host.
		const opening = openSession({
			channel: await tunnel(s, access.url),
			static: gateway.static,
			state: s.state,
			entries,
			hostId: access.hostId,
			sandbox: s.sandbox.id,
			op: "rpc",
		});
		// The host doesn't take the entry (its signer isn't in the chain), so the device isn't one it knows.
		await expect(opening).rejects.toThrow(/This device isn't in the space's chain/);
		expect(s.host.ran).toEqual([]);
		expect(s.host.state?.seq).toBe(1);
		// And a device verifying from its genesis won't take that chain either.
		await expect(verifyChain(entries, s.state.genesis)).rejects.toThrow(/isn't a device in the chain/);
	});
});

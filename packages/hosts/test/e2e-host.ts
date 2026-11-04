// A gateway with E2E for tests (e2e.test.ts, e2e-cli.test.ts): the compute API over the host backend, the hosts
// service's hub, and kantel-host's TypeScript twin, which serves port 0 with `@kantel/e2e`'s responder over the chain
// it verified from the genesis it pinned. People sign in as `Bearer <user>` for the users in `PEOPLE`.
import { createKantelClient, type KantelClient } from "@kantel/api/sdk";
import { type ComputeApi, createComputeApi, joinTokenSpender } from "@kantel/compute";
import {
	type ChainEntry,
	decodeJoinTicket,
	extendChain,
	type HostJoinTicket,
	type SpaceState,
	signHostEntry,
	ticketFor,
	verifyChain,
} from "@kantel/e2e/chain";
import { type Identity, newIdentity } from "@kantel/e2e/keys";
import { serveSession } from "@kantel/e2e/responder";
import type { ByteChannel } from "@kantel/e2e/session";
import { afterEach } from "vitest";
import { createHostBackend } from "../src/backend.ts";
import { createHostsApi, HOSTS_E2E_CHAIN_PATH } from "../src/http.ts";
import { decodeStreamFrame, encodeStreamFrame, type HostFacts, type HostMessage } from "../src/protocol.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService, type HostsService } from "../src/service.ts";
import { createMemoryHostStore } from "../src/store.ts";
import { createTunnelTickets, HOSTS_TUNNEL_PATH } from "../src/tunnel.ts";

export const SECRET_COMMAND = "cat /home/user/.env | grep OPENAI_API_KEY";
export const SECRET_OUTPUT = "OPENAI_API_KEY=sk-live-the-secret-value";

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
export class E2EHost {
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
				if (method === "sandbox.files.read") {
					return { data: Buffer.from(`${SECRET_OUTPUT}\n`).toString("base64"), size: SECRET_OUTPUT.length + 1 };
				}
				if (method === "sandbox.files.write") return { ok: true };
				if (method === "sandbox.history") {
					// As kantel-host's log answers (apps/host/internal/agent/history.go), newest first.
					const items = this.ran
						.filter((call) => call.method === "sandbox.exec")
						.map((call, i) => ({
							id: `cmd_${i}`,
							command: (call.params as { command?: string }).command,
							startedAt: 1_700_000_000_000 + i,
							endedAt: 1_700_000_000_001 + i,
							exitCode: 0,
							stdout: `${SECRET_OUTPUT}\n`,
							stderr: "",
							device: call.device,
							deviceLabel: device.label,
						}))
						.reverse();
					return { items };
				}
				return { exitCode: 0, stdout: `${SECRET_OUTPUT}\n`, stderr: "" };
			},
		});
		this.refused.push(reason);
	}
}

export const PEOPLE = {
	root: { userId: "usr_root", name: "Root", superAdmin: true },
	bob: { userId: "usr_bob", name: "Bob", superAdmin: false },
} as const;
export const ROOT = PEOPLE.root;

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

export async function setup() {
	const service = createHostsService({ store: createMemoryHostStore(), publicUrl: "https://kantel.test" });
	const tickets = createTunnelTickets(createMemoryRelayStore());
	const api: ComputeApi = createComputeApi({
		backend: createHostBackend({ hosts: service, publicUrl: "https://kantel.test", tickets, attributionKey: "k" }),
		authenticatePerson: async (request) => {
			const who = /^Bearer (\w+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
			return who === "root" || who === "bob" ? PEOPLE[who] : undefined;
		},
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
	/** The gateway's fetch, as a client's. */
	const gatewayFetch = (input: string | URL | Request, init?: RequestInit) =>
		api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 }));
	/** A client as one of `PEOPLE`, or with an API key's secret. */
	const as = (who: keyof typeof PEOPLE | (string & {})): KantelClient =>
		createKantelClient({ baseUrl: "https://kantel.test/v1", token: who, fetch: gatewayFetch });
	const root = as("root");
	const token = await root.createHostJoinToken({ name: "rack-1" });
	const { hostId, credential } = await service.register({ token: token.token, facts });
	const host = new E2EHost(service, hostId);
	host.connect();
	/** The host's own chain call, with its credential, as `kantel-host e2e join` makes it. */
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
	/** The relay's stream to the host's E2E responder, from the URL `openE2E` answered, as the gateway's tunnel opens it. */
	const tunnel = async (url: string): Promise<ByteChannel> => {
		const ticket = url.slice(url.indexOf(HOSTS_TUNNEL_PATH) + HOSTS_TUNNEL_PATH.length + 1);
		const grant = await tickets.verify(ticket, Date.now());
		if (grant === undefined) throw new Error("The ticket doesn't verify");
		let listener: ((bytes: Uint8Array) => void) | undefined;
		const pending: Uint8Array[] = [];
		const closeListeners: ((reason: string) => void)[] = [];
		const stream = await service.sandboxes.openPort(grant.sandboxId, grant.port, {
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
	};
	return { service, api, root, as, gatewayFetch, tickets, host, hostId, hostCall, tunnel };
}

export type Gateway = Awaited<ReturnType<typeof setup>>;

export const joined = (frames: readonly Uint8Array[]) => {
	const out = new Uint8Array(frames.reduce((n, frame) => n + frame.byteLength, 0));
	let at = 0;
	for (const frame of frames) {
		out.set(frame, at);
		at += frame.byteLength;
	}
	return out;
};

/**
 * `kantel-host e2e join <ticket>`: the host fetches the chain over its credential, verifies it from the ticket's
 * genesis, signs its own host.add with the ticket's key and publishes it.
 */
export async function hostJoins(s: Gateway, ticket: HostJoinTicket | string): Promise<void> {
	const join = typeof ticket === "string" ? decodeJoinTicket(ticket) : ticket;
	const { space, genesis } = ticketFor(join);
	const fetched = await s.hostCall("GET", space);
	const hostState = await verifyChain(fetched.entries, genesis);
	const hostAdd = await signHostEntry(hostState, join, { id: s.hostId, identity: await s.host.identity }, Date.now());
	const published = await s.hostCall("POST", space, { space, from: hostState.seq + 1, entries: [hostAdd] });
	s.host.state = await verifyChain(published.entries, genesis);
}

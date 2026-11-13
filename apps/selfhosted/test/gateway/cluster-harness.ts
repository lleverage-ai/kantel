// Gateway replicas over one database for tests, as main.ts makes them with hosts and a database: each has its
// cluster member, registry, relay and real HTTP server, and may have the compute API too (for who may still use what).
// A fake host speaks the protocol over a real WebSocket: it answers calls, and its sandboxes' ports echo raw bytes,
// answer HTTP with 200 and a WebSocket handshake with "hi".
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { type ComputeApi, createComputeApi, type PersonIdentity } from "@kantel/compute";
import { createSqlComputeStore, migrateComputeStore } from "@kantel/compute/sql";
import { createStubBackend } from "@kantel/compute/stub";
import { createSqlClusterStore } from "@kantel/hosts/cluster";
import { HOSTS_CONNECT_PATH } from "@kantel/hosts/http";
import { decodeStreamFrame, encodeStreamFrame, type HostMessage, type HostSandbox } from "@kantel/hosts/protocol";
import { createSqlRelayStore, migrateRelay } from "@kantel/hosts/relay-store";
import { createSqlHostStore, migrateHosts } from "@kantel/hosts/store";
import type { SqlDriver } from "@kantel/sql";
import { pgliteDatabase } from "@kantel/sql/testing";
import WebSocket from "ws";
import { createGatewayCluster, type GatewayCluster } from "../../src/gateway/cluster.ts";
import {
	type ComputeHostsConfig,
	type GatewayHostsBackend,
	gatewayHosts,
	gatewayRelay,
	withHostUpgrades,
} from "../../src/gateway/compute.ts";
import { type Listening, listen } from "../../src/gateway/node-http.ts";

export type Cleanup = () => Promise<void> | void;

export const freePort = () =>
	new Promise<number>((resolve) => {
		const probe = createServer().listen(0, "127.0.0.1", () => {
			const { port } = probe.address() as { port: number };
			probe.close(() => resolve(port));
		});
	});

export const HOSTS_CONFIG: ComputeHostsConfig = { publicUrl: "http://kantel.test", portsDomain: "kantel-ports.test" };

/** One database for the replicas: the registry's, the relay's, the cluster's and the compute API's tables. */
export async function sharedDatabase(cleanups: Cleanup[]): Promise<SqlDriver> {
	const db = await pgliteDatabase.open();
	cleanups.push(() => db.close());
	await migrateHosts(db.driver);
	await migrateRelay(db.driver);
	await migrateComputeStore(db.driver);
	return db.driver;
}

/** Who the compute API knows, by bearer, and which of their sign-ins are live: shared by every replica. */
export interface People {
	readonly byBearer: { [bearer: string]: PersonIdentity };
	readonly live: Set<string>;
}

export interface Replica {
	readonly cluster: GatewayCluster;
	readonly relay: GatewayHostsBackend;
	readonly server: Listening;
	readonly url: string;
	readonly api?: ComputeApi;
	readonly logs: string[];
	stop(): Promise<void>;
}

/** A gateway replica over `driver`, listening on 127.0.0.1. */
export async function startReplica(
	driver: SqlDriver,
	cleanups: Cleanup[],
	options: {
		readonly people?: People;
		readonly accessIntervalMs?: number;
		/** In place of the compute API's answer, such as one that fails. */
		readonly stillAllowed?: (grantee: string | undefined, sandboxId: string) => Promise<boolean>;
	} = {},
): Promise<Replica> {
	const port = await freePort();
	const url = `http://127.0.0.1:${port}`;
	const logs: string[] = [];
	const log = (message: string) => logs.push(message);
	const cluster = await createGatewayCluster({
		store: createSqlClusterStore(driver),
		url,
		heartbeatMs: 200,
		staleMs: 2000,
		log,
	});
	const service = gatewayHosts(HOSTS_CONFIG, createSqlHostStore(driver), log, cluster.cluster);
	const relay = gatewayRelay(HOSTS_CONFIG, service, createSqlRelayStore(driver), {
		cluster,
		intervalMs: options.accessIntervalMs ?? 100,
	});
	let api: ComputeApi | undefined;
	const people = options.people;
	if (people !== undefined) {
		const created = createComputeApi({
			store: createSqlComputeStore(driver),
			backend: createStubBackend(),
			authenticatePerson: async (request) => people.byBearer[request.headers.get("authorization") ?? ""],
			sessionLive: async (session) => people.live.has(session),
			fetch: async () => new Response(null, { status: 204 }),
		});
		api = created;
		relay.bind(options.stillAllowed ?? ((grantee, sandboxId) => created.service.stillAllowed(grantee, sandboxId)));
	} else {
		relay.bind(options.stillAllowed ?? (async () => true));
	}
	relay.access.start();
	await cluster.cluster.start();
	const server = await listen(
		async (request) => (await cluster.peerRoutes(request)) ?? new Response("Not found", { status: 404 }),
		port,
		{ host: "127.0.0.1", drainTimeoutMs: 100, onUpgrade: withHostUpgrades(relay, undefined) },
	);
	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		// As main.ts closes: the other replicas stop routing here, then the hosts are told to go elsewhere.
		relay.access.stop();
		await cluster.cluster.stop();
		service.close();
		await api?.close();
		await server.close();
	};
	cleanups.push(stop);
	return { cluster, relay, server, url, ...(api === undefined ? {} : { api }), logs, stop };
}

export interface ConnectedHost {
	readonly socket: WebSocket;
	readonly calls: string[];
	readonly closed: Promise<number>;
	/** The reason the gateway closed with. */
	readonly reason: Promise<string>;
	/** Every text message Kantel sent it. */
	readonly messages: HostMessage[];
	sandboxes(): HostSandbox[];
}

const HOST_FACTS = {
	version: "0.1.0",
	protocol: 1,
	os: "linux",
	arch: "amd64",
	kernel: "6.8",
	hostname: "h",
	cpus: 16,
	memoryMiB: 32_768,
	diskGiB: 500,
	kvm: true,
	nested: true,
	tiers: ["microvm"],
	sizes: [{ name: "default", vcpus: 2, memoryMiB: 2048, diskGiB: 20 }],
	egress: "proxy",
	labels: {},
};

/** What a sandbox's port answers to the first bytes of a stream. */
function portAnswer(first: string): { reply: Uint8Array[]; close: boolean; quiet: boolean } {
	const encode = (text: string) => new TextEncoder().encode(text);
	if (first.startsWith("GET ") && /upgrade: websocket/i.test(first)) {
		const key = /Sec-WebSocket-Key: (\S+)/i.exec(first)?.[1] ?? "";
		const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
		return {
			reply: [
				encode(
					`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
				),
				new Uint8Array([0x81, 0x02, 0x68, 0x69]),
			],
			close: false,
			quiet: true,
		};
	}
	if (/^(GET|POST|HEAD) /.test(first)) {
		return { reply: [encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")], close: true, quiet: true };
	}
	return { reply: [encode(`echo:${first}`)], close: false, quiet: false };
}

/** A host as kantel-host behaves, over a real WebSocket to `target`. */
export async function connectHost(
	target: { readonly url: string },
	hostId: string,
	credential: string,
	cleanups: Cleanup[],
	sandboxes: HostSandbox[] = [],
	/**
	 * `portOpenError`: refuse every `port.open` with this message, as a host may with anything. `facts`: more it says of
	 * itself in its hello, such as its features.
	 */
	options: { readonly portOpenError?: string; readonly facts?: { readonly [key: string]: unknown } } = {},
): Promise<ConnectedHost> {
	const socket = new WebSocket(`${target.url.replace("http", "ws")}${HOSTS_CONNECT_PATH}`, {
		headers: { authorization: `Bearer ${credential}` },
	});
	cleanups.push(() => socket.terminate());
	const held = new Map(sandboxes.map((sandbox) => [sandbox.id, sandbox]));
	const calls: string[] = [];
	const messages: HostMessage[] = [];
	/** Streams past their first bytes: whether they still echo. */
	const streams = new Map<number, boolean>();
	const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
	const reason = new Promise<string>((resolve) => socket.on("close", (_code, why) => resolve(why.toString())));
	const send = (message: object) => socket.send(JSON.stringify(message));
	const welcomed = new Promise<void>((resolve) => {
		socket.on("message", (data, binary) => {
			if (binary) {
				const frame = decodeStreamFrame(new Uint8Array(data as Buffer));
				if (frame === undefined || frame.payload.byteLength === 0) return;
				const known = streams.get(frame.stream);
				if (known === false) return;
				const text = new TextDecoder().decode(frame.payload);
				if (known === true) {
					socket.send(encodeStreamFrame(frame.stream, new TextEncoder().encode(`echo:${text}`)));
					return;
				}
				const answer = portAnswer(text);
				streams.set(frame.stream, !answer.quiet);
				for (const bytes of answer.reply) socket.send(encodeStreamFrame(frame.stream, bytes));
				if (answer.close) send({ type: "stream.close", stream: frame.stream, reason: "closed by the sandbox" });
				return;
			}
			const message = JSON.parse(data.toString()) as HostMessage;
			messages.push(message);
			if (message.type === "welcome") return resolve();
			if (message.type === "stream.close") {
				streams.delete(message.stream ?? 0);
				return;
			}
			if (message.type !== "call") return;
			calls.push(message.method ?? "");
			const params = message.params as { sandboxId: string };
			const answer = (result: unknown) => send({ type: "result", id: message.id, result });
			switch (message.method) {
				case "sandbox.create": {
					const sandbox: HostSandbox = {
						id: params.sandboxId,
						tier: "microvm",
						size: "default",
						state: "running",
						createdAt: 1,
					};
					held.set(sandbox.id, sandbox);
					return answer(sandbox);
				}
				case "sandbox.exec":
					send({ type: "event", call: message.id, event: { kind: "exec.output", stdout: btoa("hi\n"), at: 1 } });
					return answer({ exitCode: 0, stdout: "hi\n", stderr: "", durationMs: 1 });
				case "port.open":
					if (options.portOpenError !== undefined) {
						return send({
							type: "result",
							id: message.id,
							error: { code: "internal", message: options.portOpenError },
						});
					}
					return answer({ ok: true });
				default:
					return send({ type: "result", id: message.id, error: { code: "unsupported", message: "no" } });
			}
		});
	});
	await new Promise<void>((resolve, reject) => {
		socket.on("open", () => resolve());
		socket.on("error", reject);
	});
	send({
		type: "hello",
		hello: {
			hostId,
			facts: { ...HOST_FACTS, ...options.facts },
			sandboxes: [...held.values()],
			capacity: { freeMemoryMiB: 20_000, freeDiskGiB: 400, running: 0, stopped: 0, load1: 0, warm: {} },
		},
	});
	await welcomed;
	return { socket, calls, closed, reason, messages, sandboxes: () => [...held.values()] };
}

/** Joins a host through `target`'s registry. */
export async function joinHost(target: Replica) {
	const token = await target.relay.service.createJoinToken({ name: "box" });
	return target.relay.service.register({ token: token.token });
}

/** A WebSocket held open, and how it ended. */
export interface Session {
	readonly socket: WebSocket;
	readonly closed: Promise<number>;
}

/** Opens a WebSocket and resolves once it gets its first message: the port's echo of "ping", or its "hi". */
export function openSession(url: string, cleanups: Cleanup[], headers: Record<string, string> = {}): Promise<Session> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url, { headers });
		cleanups.push(() => socket.terminate());
		const closed = new Promise<number>((done) => socket.on("close", (code) => done(code)));
		socket.on("open", () => socket.send(Buffer.from("ping"), { binary: true }));
		socket.once("message", () => resolve({ socket, closed }));
		socket.on("error", reject);
		closed.then((code) => reject(new Error(`closed with ${code} before a message`)));
	});
}

/** How a new connection ends: `opened`, `close <code>`, or `http <status>`. */
export function attempt(url: string, cleanups: Cleanup[], headers: Record<string, string> = {}): Promise<string> {
	return new Promise((resolve) => {
		const socket = new WebSocket(url, { headers });
		cleanups.push(() => socket.terminate());
		socket.on("close", (code) => resolve(`close ${code}`));
		socket.on("unexpected-response", (_request, response) => resolve(`http ${response.statusCode}`));
		socket.on("error", () => undefined);
		socket.on("open", () => socket.send(Buffer.from("ping"), { binary: true }));
		socket.on("message", () => resolve("opened"));
	});
}

/** Resolves the close code, or "open" if the session is still up after `ms`. */
export const closedWithin = (session: Session, ms: number) =>
	Promise.race([session.closed, new Promise<string>((resolve) => setTimeout(() => resolve("open"), ms))]);

export const wsUrl = (target: { readonly url: string }, path: string) => `${target.url.replace("http", "ws")}${path}`;

// Gateway replicas reaching each other (`@kantel/hosts/cluster`): a call or a port stream for a host connected to
// another replica goes to that replica, which runs it on the host's connection.
//
//   POST /v1/hosts/cluster/call         a host call; the answer is NDJSON: {"event"} lines, then {"result"} or {"error"}
//   POST /v1/hosts/cluster/rewelcome    sends a host its welcome again
//   POST /v1/hosts/cluster/disconnect   closes a host's connection (its credential was revoked)
//   POST /v1/hosts/cluster/usage        a usage tick from a host connected to the sender, kept here too
//   GET  /v1/hosts/cluster/port         a WebSocket: "open" once the sandbox's port is, then its bytes both ways
//
// Each request is signed with the sending replica's Ed25519 key (`x-kantel-replica`, `-at`, `-nonce`, `-signature`);
// the receiver checks it against the key the sender registered in the database, and serves it only for a host
// connected to itself. The routes are on the gateway's port, so a load balancer reaches them too: unsigned, they are
// 404s.
import type { IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import {
	type ClusterStore,
	createHostCluster,
	createPeerVerifier,
	createReplicaKey,
	type HostCluster,
	type PeerTransport,
	type ReplicaKey,
	type ReplicaRecord,
	signPeerRequest,
} from "@kantel/hosts/cluster";
import { closeQuietly, HostCallError } from "@kantel/hosts/hub";
import { HOST_MAX_MESSAGE_BYTES, type HostEvent, type HostWelcome } from "@kantel/hosts/protocol";
import WebSocket, { type WebSocketServer } from "ws";
import { refusalCode, refuseUpgrade } from "./upgrade-refusal.ts";

export const CLUSTER_PATH = "/v1/hosts/cluster";

export interface GatewayCluster {
	readonly cluster: HostCluster;
	/** A replica's request to this one; undefined for any other path. */
	peerRoutes(request: Request): Promise<Response | undefined>;
	/** A replica's port stream through this one: true when the upgrade was its to take. */
	peerUpgrade(incoming: IncomingMessage, socket: Duplex, head: Buffer, sockets: WebSocketServer): boolean;
	/** Where a usage tick a peer passed on goes (`HostsService.recordSharedUsage`). Before: it is dropped. */
	useUsage(record: (hostId: string, usage: unknown) => Promise<void>): void;
}

/**
 * Where other replicas reach this one: `KANTEL_REPLICA_URL`, or this machine's first non-loopback IPv4 address on the
 * gateway's port (a container's or a pod's own address).
 */
export function replicaUrl(env: NodeJS.ProcessEnv, port: number): string {
	const configured = env.KANTEL_REPLICA_URL?.trim() ?? "";
	if (configured !== "") {
		if (!/^https?:\/\/[^/]+\/?$/.test(configured))
			throw new Error("KANTEL_REPLICA_URL is a URL such as http://10.0.3.7:8080");
		return new URL(configured).origin;
	}
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) return `http://${address.address}:${port}`;
		}
	}
	return `http://127.0.0.1:${port}`;
}

const SIGNATURE_HEADERS = ["x-kantel-replica", "x-kantel-at", "x-kantel-nonce", "x-kantel-signature"] as const;

const signedHeaders = (signed: { replica: string; at: string; nonce: string; signature: string }) => ({
	"x-kantel-replica": signed.replica,
	"x-kantel-at": signed.at,
	"x-kantel-nonce": signed.nonce,
	"x-kantel-signature": signed.signature,
});

const unavailable = (message: string, unanswered = false) =>
	new HostCallError({ code: "unavailable", message, ...(unanswered ? { unanswered } : {}) });

/** How long passing a usage tick on may take: the next comes in 5 seconds. */
const USAGE_TIMEOUT_MS = 5_000;

/** The client half: this replica's requests to others, signed with its key. */
export function createPeerTransport(options: {
	readonly replicaId: string;
	readonly key: ReplicaKey;
	readonly fetch?: typeof fetch;
}): PeerTransport {
	const send = options.fetch ?? fetch;
	const post = async (peer: ReplicaRecord, operation: string, payload: object, signal?: AbortSignal) => {
		const body = JSON.stringify(payload);
		const signed = await signPeerRequest(options.key, { from: options.replicaId, to: peer.id }, operation, body);
		// Aborted before it left: nothing was sent.
		if (signal?.aborted) throw new HostCallError({ code: "timeout", message: "The call was aborted" });
		try {
			return await send(`${peer.url}${CLUSTER_PATH}/${operation}`, {
				method: "POST",
				headers: { "content-type": "application/json", ...signedHeaders(signed) },
				body,
				...(signal === undefined ? {} : { signal }),
			});
		} catch (error) {
			// The request may have reached the peer, and the call the host, before the answer was lost.
			if (signal?.aborted) {
				throw new HostCallError({ code: "timeout", message: "The call was aborted", unanswered: true });
			}
			throw unavailable(
				`Gateway replica ${peer.id} is unreachable: ${error instanceof Error ? error.message : error}`,
				true,
			);
		}
	};
	return {
		async call(peer, hostId, method, params, callOptions) {
			const response = await post(
				peer,
				"call",
				{
					hostId,
					method,
					params,
					...(callOptions.timeoutMs === undefined ? {} : { timeoutMs: callOptions.timeoutMs }),
				},
				callOptions.signal,
			);
			if (!response.ok || response.body === null) {
				// The peer refuses a call it won't send on (4xx: unsigned, not its host) before it reaches the host. A 5xx may be
				// a proxy's on the way, and an empty answer carries none, after the peer sent it on: neither says it wasn't done.
				throw unavailable(
					`Gateway replica ${peer.id} refused the call (${response.status})`,
					response.ok || response.status >= 500,
				);
			}
			const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
			let buffered = "";
			for (;;) {
				const { value, done } = await reader.read().catch((error: unknown) => {
					// The answer's stream broke: the call was on its way, or done, on the host.
					throw unavailable(
						`Gateway replica ${peer.id} lost the call: ${error instanceof Error ? error.message : error}`,
						true,
					);
				});
				if (value !== undefined) buffered += value;
				let newline = buffered.indexOf("\n");
				while (newline >= 0) {
					const line = buffered.slice(0, newline);
					buffered = buffered.slice(newline + 1);
					newline = buffered.indexOf("\n");
					if (line.trim() === "") continue;
					const message = JSON.parse(line) as {
						event?: HostEvent;
						result?: unknown;
						error?: { code: string; message: string };
					};
					if (message.event !== undefined) callOptions.onEvent?.(message.event);
					else if (message.error !== undefined) {
						await reader.cancel().catch(() => undefined);
						throw new HostCallError(message.error);
					} else if ("result" in message) {
						await reader.cancel().catch(() => undefined);
						return message.result;
					}
				}
				if (done) throw unavailable(`Gateway replica ${peer.id} ended the call without an answer`, true);
			}
		},
		async rewelcome(peer, hostId, welcome) {
			await post(peer, "rewelcome", { hostId, welcome });
		},
		async disconnect(peer, hostId, code, reason) {
			await post(peer, "disconnect", { hostId, code, reason });
		},
		async usage(peer, hostId, usage) {
			const response = await post(peer, "usage", { hostId, usage }, AbortSignal.timeout(USAGE_TIMEOUT_MS));
			await response.body?.cancel().catch(() => undefined);
			if (!response.ok) throw unavailable(`Gateway replica ${peer.id} refused the usage tick (${response.status})`);
		},
		async openPort(peer, hostId, sandboxId, port, sink) {
			const query = new URLSearchParams({ host: hostId, sandbox: sandboxId, port: String(port) }).toString();
			const signed = await signPeerRequest(options.key, { from: options.replicaId, to: peer.id }, "port", query);
			const url = `${peer.url.replace(/^http/, "ws")}${CLUSTER_PATH}/port?${query}`;
			const socket = new WebSocket(url, { headers: signedHeaders(signed), maxPayload: HOST_MAX_MESSAGE_BYTES });
			return new Promise((resolve, reject) => {
				let opened = false;
				const fail = (reason: string) => {
					if (opened) sink.end(reason);
					else reject(unavailable(reason));
				};
				socket.on("message", (data, binary) => {
					if (!binary) {
						if (!opened && data.toString() === "open") {
							opened = true;
							resolve({
								stream: 0,
								write(bytes) {
									if (socket.readyState === WebSocket.OPEN) socket.send(bytes, { binary: true });
								},
								close() {
									if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
										socket.close(1000, "closed by the client");
									}
								},
							});
						}
						return;
					}
					const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
					sink.data(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
				});
				socket.on("close", (code, reason) => {
					const text = reason.toString();
					if (!opened && code === 4004) reject(new HostCallError({ code: "not_found", message: text }));
					else if (!opened && code === refusalCode(404))
						fail(`Gateway replica ${peer.id} refused the port stream (${text || "not signed"})`);
					else fail(text || `closed by gateway replica ${peer.id}`);
				});
				socket.on("unexpected-response", (_request, response) => {
					fail(`Gateway replica ${peer.id} refused the port stream (${response.statusCode})`);
					socket.terminate();
				});
				socket.on("error", (error) => fail(error.message));
			});
		},
	};
}

/** This replica in the cluster over `store`, with its key, its transport and the routes other replicas call. */
export async function createGatewayCluster(options: {
	readonly store: ClusterStore;
	readonly url: string;
	readonly log?: (message: string) => void;
	readonly heartbeatMs?: number;
	readonly staleMs?: number;
}): Promise<GatewayCluster> {
	const key = await createReplicaKey();
	const replicaId = `rep_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
	const staleMs = options.staleMs ?? 10_000;
	const cluster = createHostCluster({
		store: options.store,
		transport: createPeerTransport({ replicaId, key }),
		replicaId,
		url: options.url,
		key,
		staleMs,
		...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
		...(options.log === undefined ? {} : { log: options.log }),
	});
	const verify = createPeerVerifier({ replicaId, store: options.store, staleMs });
	const signedBy = async (headers: Headers | IncomingMessage["headers"], operation: string, body: string) => {
		const read = (name: string) => {
			const value = headers instanceof Headers ? headers.get(name) : headers[name];
			return typeof value === "string" ? value : undefined;
		};
		const [replicaId, at, nonce, signature] = SIGNATURE_HEADERS.map(read);
		if (replicaId === undefined || at === undefined || nonce === undefined || signature === undefined) return false;
		return verify({ replicaId, operation, at: Number(at), nonce, body, signature });
	};
	let recordUsage: ((hostId: string, usage: unknown) => Promise<void>) | undefined;
	const notFound = () => new Response("Not found", { status: 404 });

	return {
		cluster,
		async peerRoutes(request) {
			const path = new URL(request.url).pathname;
			if (!path.startsWith(`${CLUSTER_PATH}/`)) return undefined;
			const operation = path.slice(CLUSTER_PATH.length + 1);
			if (request.method !== "POST" || !["call", "rewelcome", "disconnect", "usage"].includes(operation)) {
				return notFound();
			}
			const body = await request.text();
			if (!(await signedBy(request.headers, operation, body))) return notFound();
			if (operation === "usage") {
				const input = JSON.parse(body) as { hostId?: unknown; usage?: unknown };
				if (typeof input.hostId !== "string") return new Response(null, { status: 400 });
				// Only from the replica holding the host: a peer can't speak for a host connected elsewhere.
				const owner = await options.store.getOwner(input.hostId);
				if (owner === undefined || owner.replicaId !== request.headers.get("x-kantel-replica")) {
					return new Response(null, { status: 409 });
				}
				try {
					await recordUsage?.(input.hostId, input.usage);
				} catch {
					return new Response(null, { status: 400 });
				}
				return new Response(null, { status: 204 });
			}
			const local = cluster.local();
			const input = JSON.parse(body) as {
				hostId: string;
				method?: string;
				params?: unknown;
				timeoutMs?: number;
				welcome?: HostWelcome;
				code?: number;
				reason?: string;
			};
			if (operation === "rewelcome") {
				if (input.welcome !== undefined) local.rewelcome(input.hostId, input.welcome);
				return new Response(null, { status: 204 });
			}
			if (operation === "disconnect") {
				local.disconnect(input.hostId, input.code ?? 4003, input.reason ?? "");
				return new Response(null, { status: 204 });
			}
			const encoder = new TextEncoder();
			const aborted = new AbortController();
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const line = (value: object) => {
						try {
							controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
						} catch {
							// The caller went away.
						}
					};
					// Only a host connected here: a call is never sent on to a third replica.
					local
						.call(input.hostId, String(input.method), input.params, {
							...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
							onEvent: (event) => line({ event }),
							signal: aborted.signal,
						})
						.then(
							(result) => line({ result: result ?? null }),
							(error: unknown) =>
								line({
									error:
										error instanceof HostCallError
											? {
													code: error.code,
													message: error.message,
													// Whether the host may have carried it out, for the caller to keep what it placed.
													...(error.unanswered ? { unanswered: true } : {}),
												}
											: { code: "internal", message: "The call failed on the replica holding the host" },
								}),
						)
						.finally(() => {
							try {
								controller.close();
							} catch {
								// Already closed.
							}
						});
				},
				cancel() {
					aborted.abort();
				},
			});
			return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
		},
		peerUpgrade(incoming, socket, head, sockets) {
			const url = new URL(incoming.url ?? "/", "http://gateway");
			if (url.pathname !== `${CLUSTER_PATH}/port`) return false;
			const query = url.search.slice(1);
			void (async () => {
				if (incoming.method !== "GET" || !(await signedBy(incoming.headers, "port", query))) {
					return refuseUpgrade(incoming, socket, head, 404, "No such replica stream", sockets);
				}
				const hostId = url.searchParams.get("host") ?? "";
				const sandboxId = url.searchParams.get("sandbox") ?? "";
				const port = Number(url.searchParams.get("port"));
				sockets.handleUpgrade(incoming, socket, head, (accepted) => {
					let stream: { write(bytes: Uint8Array): void; close(): void } | undefined;
					let done = false;
					accepted.on("message", (data) => {
						const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
						stream?.write(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
					});
					accepted.on("close", () => {
						done = true;
						stream?.close();
					});
					accepted.on("error", () => accepted.terminate());
					cluster
						.local()
						.openPort(hostId, sandboxId, port, {
							data: (bytes) => accepted.send(bytes, { binary: true }),
							// The host's reason: cut to fit and never thrown (`closeQuietly`).
							end: (reason) => closeQuietly(accepted, 1000, reason),
						})
						.then(
							(opened) => {
								stream = opened;
								if (done) return opened.close();
								accepted.send("open");
							},
							(error: unknown) => {
								const notFound = error instanceof HostCallError && error.code === "not_found";
								closeQuietly(accepted, notFound ? 4004 : 1011, error instanceof Error ? error.message : "");
							},
						)
						.catch(() => closeQuietly(accepted, 1011, "The stream failed"));
				});
			})().catch(() => refuseUpgrade(incoming, socket, head, 502, "The replica could not check the stream", sockets));
			return true;
		},
		useUsage(record) {
			recordUsage = record;
		},
	};
}

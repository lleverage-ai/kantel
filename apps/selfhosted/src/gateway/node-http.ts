// Serves a Fetch-style handler on node:http, which Bun and Node both run. A client that disconnects aborts the
// request's signal, so the session API's event streams and result waits end with their connection.
//
// A request's body is read whole before the handler sees it (at most MAX_BODY_BYTES, within REQUEST_TIMEOUT_MS), except
// on the few routes whose bodies are files of any size (`streamsRequestBody`): those reach the handler at once with the
// body as a stream, which the handler reads as it can.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type Duplex, Readable } from "node:stream";
import { refuseUpgrade } from "./upgrade-refusal.ts";

/** A WebSocket upgrade's handler: it takes the socket over, or refuses it. */
export type UpgradeHandler = (incoming: IncomingMessage, socket: Duplex, head: Buffer) => void;

/** The handler also gets the client's socket address: what a per-client limit counts, as no header can forge it. */
export type FetchHandler = (request: Request, client: { readonly address?: string }) => Promise<Response>;

export interface Listening {
	readonly port: number;
	readonly url: string;
	close(): Promise<void>;
}

/** The largest request body read; the APIs refuse bodies over 1 MiB themselves, this only bounds memory. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * How long a client may take to send its request body. Only the request: a response, such as an
 * event stream, may stay open for as long as the client reads it. For a streamed body, how long it may go quiet
 * between chunks instead: a 500 MB upload may take as long as it needs while it keeps coming.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The requests whose bodies are streamed to the handler rather than read first: a signed file URL's upload
 * (`PUT /v1/file-urls/{token}`), a bundle's tar (`POST /v1/bundles`) and an archive to extract
 * (`PUT /v1/sandboxes/{id}/files/archive`), any query. Each can be far larger than MAX_BODY_BYTES, and its route reads
 * it as a stream (a `rawBody` route, or the file URL's), so holding it in memory would only cap and slow it.
 */
export function streamsRequestBody(method: string | undefined, url: string | undefined): boolean {
	const path = (url ?? "/").split("?", 1)[0] ?? "/";
	if (method === "PUT") {
		return /^\/v1\/file-urls\/[A-Za-z0-9_-]+$/.test(path) || /^\/v1\/sandboxes\/[^/]+\/files\/archive$/.test(path);
	}
	return method === "POST" && path === "/v1/bundles";
}

/**
 * How long a response waits for a client that has stopped reading before giving up on it. A session's event stream
 * is pushed, so a reader that never drains would otherwise hold its frames in memory.
 */
const DRAIN_TIMEOUT_MS = 30_000;

/**
 * How long `close` lets upgraded sockets finish a close handshake already under way (the 1001 a host is sent when the
 * gateway stops) before dropping them. A round trip, not a drain: well inside a container's stop grace period.
 */
const CLOSE_GRACE_MS = 1000;

/** Resolves true once `outgoing` drains, false if it closes or `timeoutMs` passes first. */
function drained(outgoing: ServerResponse, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const done = (result: boolean) => {
			clearTimeout(timer);
			outgoing.off("drain", onDrain);
			outgoing.off("close", onClose);
			resolve(result);
		};
		const onDrain = () => done(true);
		const onClose = () => done(false);
		const timer = setTimeout(() => done(false), timeoutMs);
		outgoing.on("drain", onDrain);
		outgoing.on("close", onClose);
	});
}

function toRequest(incoming: IncomingMessage, body: Buffer | undefined, signal: AbortSignal): Request {
	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming.headers)) {
		if (typeof value === "string") headers.set(name, value);
		else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
	}
	const method = incoming.method ?? "GET";
	return new Request(`http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`, {
		method,
		headers,
		signal,
		...(body === undefined || method === "GET" || method === "HEAD" ? {} : { body: new Uint8Array(body) }),
	});
}

/** A request whose body is `incoming` itself, read as the handler reads it. */
function toStreamedRequest(incoming: IncomingMessage, signal: AbortSignal): Request {
	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming.headers)) {
		if (typeof value === "string") headers.set(name, value);
		else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
	}
	return new Request(`http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`, {
		method: incoming.method ?? "PUT",
		headers,
		signal,
		body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
		// What fetch needs for a body that is a stream: sent (here, read) as it comes.
		duplex: "half",
	} as RequestInit & { duplex: "half" });
}

async function write(
	response: Response,
	outgoing: ServerResponse,
	head: boolean,
	drainTimeoutMs: number,
): Promise<void> {
	const headers: Record<string, string | string[]> = {};
	response.headers.forEach((value, name) => {
		headers[name] = value;
	});
	const cookies = response.headers.getSetCookie();
	if (cookies.length > 0) headers["set-cookie"] = cookies;
	outgoing.writeHead(response.status, headers);
	outgoing.flushHeaders();
	if (response.body === null || head) {
		outgoing.end();
		return;
	}
	const reader = response.body.getReader();
	outgoing.on("close", () => void reader.cancel().catch(() => {}));
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (outgoing.write(value)) continue;
			// The client is behind: read nothing more until it catches up, and drop it if it never does.
			if (!(await drained(outgoing, drainTimeoutMs))) {
				await reader.cancel().catch(() => {});
				outgoing.destroy();
				return;
			}
		}
	} catch {
		// The client went away.
	}
	outgoing.end();
}

export interface ListenOptions {
	readonly host?: string;
	readonly requestTimeoutMs?: number;
	readonly drainTimeoutMs?: number;
	/** WebSocket upgrades (a browser's live view). Without it, every upgrade is refused. */
	readonly onUpgrade?: UpgradeHandler;
}

export async function listen(handler: FetchHandler, port: number, options: ListenOptions = {}): Promise<Listening> {
	const host = options.host ?? "0.0.0.0";
	const drainTimeoutMs = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
	const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
	const server: Server = createServer((incoming, outgoing) => {
		const controller = new AbortController();
		outgoing.on("close", () => {
			if (!outgoing.writableFinished) controller.abort();
		});
		const refuse = (status: number, message: string) => {
			if (outgoing.headersSent) return;
			outgoing.writeHead(status, { "content-type": "application/json", connection: "close" });
			outgoing.end(JSON.stringify({ error: { code: "invalid", message } }));
			incoming.destroy();
		};
		// Making the Request is in the try too: a Host header that makes no URL is a 500, never a throw out of the server.
		const answer = async (request: () => Request): Promise<Response> => {
			try {
				const address = incoming.socket.remoteAddress;
				return await handler(request(), address === undefined ? {} : { address });
			} catch (error) {
				console.error("[gateway]", error);
				return new Response(JSON.stringify({ error: { code: "unavailable", message: "Internal error" } }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
		};
		if (streamsRequestBody(incoming.method, incoming.url)) {
			// No deadline for the whole body, only for a pause in it. A body the handler isn't reading yet (its queue full,
			// so `incoming` paused) is the handler's wait, not the client's, and doesn't count.
			let idle: ReturnType<typeof setTimeout> | undefined;
			const arm = () => {
				clearTimeout(idle);
				idle = setTimeout(() => {
					if (incoming.isPaused()) arm();
					else refuse(408, "The request body stopped arriving");
				}, requestTimeoutMs);
			};
			const disarm = () => clearTimeout(idle);
			incoming.on("end", disarm);
			incoming.on("close", disarm);
			void (async () => {
				const response = await answer(() => {
					const request = toStreamedRequest(incoming, controller.signal);
					arm();
					// After `Readable.toWeb` has started the flow, so this listener only watches it.
					incoming.on("data", arm);
					return request;
				});
				if (outgoing.headersSent || outgoing.writableEnded) {
					// Refused already: the body stopped arriving, and the handler then failed on it.
					await response.body?.cancel().catch(() => {});
					return;
				}
				await write(response, outgoing, incoming.method === "HEAD", drainTimeoutMs);
				disarm();
				// Answered without reading all of the body (a refusal, or a sign-in that failed): once the answer is out,
				// stop taking the rest rather than read a large upload nobody wants.
				if (!incoming.complete && !incoming.destroyed) {
					if (!outgoing.writableFinished && !outgoing.destroyed) {
						await new Promise<void>((done) => {
							outgoing.once("finish", () => done());
							outgoing.once("close", () => done());
						});
					}
					incoming.destroy();
				}
			})().catch(() => outgoing.destroy());
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		// The deadline covers receiving the request only; Node's own requestTimeout is checked only every 30 s, and
		// Bun's node:http may not check it at all.
		const deadline = setTimeout(() => refuse(408, "The request took too long to arrive"), requestTimeoutMs);
		incoming.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				clearTimeout(deadline);
				refuse(413, "Request body too large");
				return;
			}
			chunks.push(chunk);
		});
		incoming.on("close", () => clearTimeout(deadline));
		incoming.on("end", async () => {
			clearTimeout(deadline);
			if (outgoing.headersSent) return;
			const body = chunks.length === 0 ? undefined : Buffer.concat(chunks);
			const response = await answer(() => toRequest(incoming, body, controller.signal));
			await write(response, outgoing, incoming.method === "HEAD", drainTimeoutMs);
		});
	});
	// Node's own limit on receiving a whole request (300 s by default) would cut a large streamed upload off; the
	// deadline above bounds every other request's body well within it, and headersTimeout still bounds the headers.
	server.requestTimeout = 0;
	const onUpgrade = options.onUpgrade;
	// Upgraded sockets, so `close` can let them finish the close frames already sent (a host's 1001) before dropping
	// them: on Bun, `closeAllConnections` destroys upgraded sockets too, where Node leaves them alone.
	const upgraded = new Set<Duplex>();
	server.on("upgrade", (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
		socket.on("error", () => socket.destroy());
		upgraded.add(socket);
		socket.on("close", () => upgraded.delete(socket));
		// No HTTP status on an upgrade: Bun drops it (upgrade-refusal.ts).
		if (onUpgrade === undefined) return refuseUpgrade(incoming, socket, head, 404, "Nothing upgrades here");
		onUpgrade(incoming, socket, head);
	});
	await new Promise<void>((resolve) => server.listen(port, host, resolve));
	const address = server.address() as AddressInfo;
	return {
		port: address.port,
		url: `http://127.0.0.1:${address.port}`,
		close: async () => {
			const open = [...upgraded].filter((socket) => !socket.destroyed);
			if (open.length > 0) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				await Promise.race([
					Promise.all(open.map((socket) => new Promise((done) => socket.once("close", done)))),
					new Promise((done) => {
						timer = setTimeout(done, Math.min(drainTimeoutMs, CLOSE_GRACE_MS));
					}),
				]);
				clearTimeout(timer);
			}
			for (const socket of upgraded) socket.destroy();
			await new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			});
		},
	};
}

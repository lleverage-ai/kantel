// Serves a Fetch-style handler on node:http, which Bun and Node both run. A client that disconnects aborts the
// request's signal, so the session API's event streams and result waits end with their connection.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type FetchHandler = (request: Request) => Promise<Response>;

export interface Listening {
	readonly port: number;
	readonly url: string;
	close(): Promise<void>;
}

/** The largest request body read; the APIs refuse bodies over 1 MiB themselves, this only bounds memory. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * How long a client may take to send its request body. Only the request: a response, such as an
 * event stream, may stay open for as long as the client reads it.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * How long a response waits for a client that has stopped reading before giving up on it. A session's event stream
 * is pushed, so a reader that never drains would otherwise hold its frames in memory.
 */
const DRAIN_TIMEOUT_MS = 30_000;

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
		const chunks: Buffer[] = [];
		let size = 0;
		const refuse = (status: number, message: string) => {
			if (outgoing.headersSent) return;
			outgoing.writeHead(status, { "content-type": "application/json", connection: "close" });
			outgoing.end(JSON.stringify({ error: { code: "invalid", message } }));
			incoming.destroy();
		};
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
			let response: Response;
			try {
				response = await handler(toRequest(incoming, body, controller.signal));
			} catch (error) {
				console.error("[gateway]", error);
				response = new Response(JSON.stringify({ error: { code: "unavailable", message: "Internal error" } }), {
					status: 500,
					headers: { "content-type": "application/json" },
				});
			}
			await write(response, outgoing, incoming.method === "HEAD", drainTimeoutMs);
		});
	});
	await new Promise<void>((resolve) => server.listen(port, host, resolve));
	const address = server.address() as AddressInfo;
	return {
		port: address.port,
		url: `http://127.0.0.1:${address.port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

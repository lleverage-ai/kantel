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

async function write(response: Response, outgoing: ServerResponse, head: boolean): Promise<void> {
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
			outgoing.write(value);
		}
	} catch {
		// The client went away.
	}
	outgoing.end();
}

export async function listen(handler: FetchHandler, port: number, host = "0.0.0.0"): Promise<Listening> {
	const server: Server = createServer((incoming, outgoing) => {
		const controller = new AbortController();
		outgoing.on("close", () => {
			if (!outgoing.writableFinished) controller.abort();
		});
		const chunks: Buffer[] = [];
		let size = 0;
		incoming.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				outgoing.writeHead(413, { "content-type": "application/json" });
				outgoing.end(JSON.stringify({ error: { code: "invalid", message: "Request body too large" } }));
				incoming.destroy();
				return;
			}
			chunks.push(chunk);
		});
		incoming.on("end", async () => {
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
			await write(response, outgoing, incoming.method === "HEAD");
		});
	});
	// Event streams outlive Node's default request timeouts.
	server.requestTimeout = 0;
	server.headersTimeout = 60_000;
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

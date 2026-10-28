/**
 * Serves a fetch-style handler on a Node `http` server. Each response chunk is written as the handler's body yields
 * it, so SSE events reach the client one by one; when the client goes away, the request's signal aborts and the
 * response body is cancelled, which cancels the upstream model call.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export interface NodeServerOptions {
	/** Default 0: any free port. */
	readonly port?: number;
	/** Default `127.0.0.1`. */
	readonly host?: string;
}

export interface NodeModelGatewayServer {
	readonly server: Server;
	/** `http://<host>:<port>`, as bound. */
	readonly url: string;
	/** Stops accepting connections, ends open ones and resolves when the server has closed. */
	close(): Promise<void>;
}

function toRequest(incoming: IncomingMessage, signal: AbortSignal): Request {
	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming.headers)) {
		if (typeof value === "string") headers.set(name, value);
		else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
	}
	const method = incoming.method ?? "GET";
	const hasBody = method !== "GET" && method !== "HEAD";
	return new Request(`http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`, {
		method,
		headers,
		signal,
		...(hasBody ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: "half" } : {}),
	} as RequestInit);
}

async function writeResponse(response: Response, outgoing: ServerResponse, signal: AbortSignal): Promise<void> {
	outgoing.writeHead(response.status, response.statusText, [...response.headers].flat());
	if (response.body === null) {
		outgoing.end();
		return;
	}
	outgoing.flushHeaders();
	const reader = response.body.getReader();
	const cancel = () => void reader.cancel().catch(() => undefined);
	signal.addEventListener("abort", cancel, { once: true });
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!outgoing.write(value)) {
				await new Promise<void>((resolve) => {
					outgoing.once("drain", resolve);
					outgoing.once("close", resolve);
				});
			}
			if (signal.aborted) return;
		}
		outgoing.end();
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}

/** Starts a Node `http` server for `handler`. */
export async function serveOnNode(
	handler: (request: Request) => Promise<Response>,
	options: NodeServerOptions = {},
): Promise<NodeModelGatewayServer> {
	const server = createServer((incoming, outgoing) => {
		const controller = new AbortController();
		// The client went away before the response finished: abort the request and cancel its body.
		outgoing.on("close", () => {
			if (!outgoing.writableFinished) controller.abort();
		});
		void (async () => {
			try {
				const response = await handler(toRequest(incoming, controller.signal));
				await writeResponse(response, outgoing, controller.signal);
			} catch {
				if (!outgoing.headersSent) {
					outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
					outgoing.end(JSON.stringify({ error: { code: "unavailable", message: "The model gateway failed" } }));
				} else {
					outgoing.destroy();
				}
			}
		})();
	});
	const host = options.host ?? "127.0.0.1";
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? 0, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const { port } = server.address() as AddressInfo;
	return {
		server,
		url: `http://${host.includes(":") ? `[${host}]` : host}:${port}`,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	};
}

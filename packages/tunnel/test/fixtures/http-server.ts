/**
 * A tiny Streamable HTTP MCP server on loopback for the tunnel's tests: sessions by `Mcp-Session-Id`, `initialize`
 * and `tools/call` answered as JSON, `tools/list` as an event stream, 202 for notifications, and 405 for the GET
 * stream it doesn't offer.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface SeenRequest {
	readonly httpMethod: string;
	readonly rpcMethod?: string;
	readonly sessionId?: string;
	readonly protocolVersion?: string;
}

async function bodyOf(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

export async function startHttpMcpServer() {
	const seen: SeenRequest[] = [];
	const sessions = new Set<string>();
	let made = 0;
	const server = createServer(async (request, response) => {
		const sessionId = request.headers["mcp-session-id"] as string | undefined;
		const protocolVersion = request.headers["mcp-protocol-version"] as string | undefined;
		const record = (rpcMethod?: string): void => {
			seen.push({
				httpMethod: request.method ?? "",
				...(rpcMethod === undefined ? {} : { rpcMethod }),
				...(sessionId === undefined ? {} : { sessionId }),
				...(protocolVersion === undefined ? {} : { protocolVersion }),
			});
		};
		if (request.method === "GET") {
			record();
			response.writeHead(405).end();
			return;
		}
		if (request.method === "DELETE") {
			record();
			if (sessionId !== undefined) sessions.delete(sessionId);
			response.writeHead(200).end();
			return;
		}
		const message = JSON.parse(await bodyOf(request)) as {
			id?: number | string;
			method?: string;
			params?: { [key: string]: unknown };
		};
		record(message.method);
		if (message.method === "initialize") {
			made += 1;
			const id = `session-${made}`;
			sessions.add(id);
			response.writeHead(200, { "content-type": "application/json", "mcp-session-id": id });
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					result: {
						protocolVersion: "2025-06-18",
						capabilities: { tools: {} },
						serverInfo: { name: "http-server", version: "1.0.0" },
					},
				}),
			);
			return;
		}
		if (sessionId === undefined || !sessions.has(sessionId)) {
			response.writeHead(404).end();
			return;
		}
		if (message.id === undefined) {
			response.writeHead(202).end();
			return;
		}
		if (message.method === "tools/list") {
			response.writeHead(200, { "content-type": "text/event-stream" });
			const tools = [{ name: "echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }];
			response.end(
				`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools } })}\n\n`,
			);
			return;
		}
		if (message.method === "tools/call") {
			const got = { arguments: message.params?.arguments, meta: message.params?._meta, sessionId };
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: message.id,
					result: { content: [{ type: "text", text: JSON.stringify(got) }] },
				}),
			);
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "No such method" } }),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		seen,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

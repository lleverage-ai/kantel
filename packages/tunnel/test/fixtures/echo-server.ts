/**
 * A stdio MCP server for the tunnel's tests, run with `node`. It lists `echo` (read-only), which answers with the
 * arguments and `_meta` it got and how often it was initialised, and `change`, which adds a tool and says the list
 * changed. It writes one line that isn't JSON first, as servers that log to stdout do.
 */
import { createInterface } from "node:readline";

interface Request {
	readonly id?: string | number;
	readonly method?: string;
	readonly params?: { readonly [key: string]: unknown };
}

const tools: object[] = [
	{
		name: "echo",
		description: "Answers with what it was given",
		inputSchema: { type: "object", properties: { text: { type: "string" } } },
		annotations: { readOnlyHint: true },
	},
	{ name: "change", description: "Adds a tool and says the tool list changed", inputSchema: { type: "object" } },
];
let initializes = 0;
let initialized = 0;

function write(message: object): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function answer(id: string | number, result: object): void {
	write({ jsonrpc: "2.0", id, result });
}

process.stdout.write("echo-server: starting (a log line, not JSON)\n");

createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line) as Request;
	if (request.id === undefined) {
		if (request.method === "notifications/initialized") initialized += 1;
		return;
	}
	switch (request.method) {
		case "initialize":
			initializes += 1;
			answer(request.id, {
				protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: { listChanged: true } },
				serverInfo: { name: "echo-server", version: "1.0.0" },
			});
			return;
		case "ping":
			answer(request.id, {});
			return;
		case "tools/list":
			answer(request.id, { tools });
			return;
		case "tools/call": {
			const name = request.params?.name;
			if (name === "echo") {
				const got = { arguments: request.params?.arguments, meta: request.params?._meta, initializes, initialized };
				answer(request.id, { content: [{ type: "text", text: JSON.stringify(got) }], structuredContent: got });
			} else if (name === "change") {
				tools.push({ name: `added${tools.length}`, inputSchema: { type: "object" } });
				answer(request.id, { content: [{ type: "text", text: "changed" }] });
				write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
			} else {
				write({ jsonrpc: "2.0", id: request.id, error: { code: -32602, message: `Unknown tool: ${String(name)}` } });
			}
			return;
		}
		default:
			write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `No ${request.method}` } });
	}
});

import { isRequest, type JsonRpcMessage, type JsonRpcRequest, parseMessage } from "../src/protocol.ts";

/** What the fake server does with a request: answer it, refuse it, or leave it waiting. */
export type FakeAnswer =
	| { readonly result: unknown }
	| { readonly error: { readonly code: number; readonly message: string } }
	| "hold";

export type FakeHandler = (request: JsonRpcRequest) => FakeAnswer;

/** The default MCP server: initialises and lists one tool, and echoes a call's arguments and `_meta`. */
export const echoHandler: FakeHandler = (request) => {
	switch (request.method) {
		case "initialize":
			return {
				result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake", version: "1" } },
			};
		case "tools/list":
			return { result: { tools: [{ name: "echo", annotations: { readOnlyHint: true } }] } };
		case "tools/call":
			return { result: { content: [{ type: "text", text: JSON.stringify(request.params) }] } };
		default:
			return { error: { code: -32601, message: `No ${request.method}` } };
	}
};

/**
 * An in-memory MCP server on the far end of a message link. `send` is what Harbour's side calls; the server answers
 * through `deliver`, a turn of the event loop later, as a socket would.
 */
export function fakeServer(handler: FakeHandler = echoHandler) {
	const received: JsonRpcMessage[] = [];
	const held = new Map<JsonRpcRequest["id"], JsonRpcRequest>();
	let deliver: (text: string) => void = () => {};
	return {
		received,
		held,
		/** Connects the server's answers to whoever reads them. */
		attach(receive: (text: string) => void): void {
			deliver = receive;
		},
		send(text: string): void {
			const message = parseMessage(text);
			if (message === undefined) throw new Error(`Not JSON-RPC: ${text}`);
			received.push(message);
			if (!isRequest(message)) return;
			const answer = handler(message);
			if (answer === "hold") {
				held.set(message.id, message);
				return;
			}
			setTimeout(() => deliver(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...answer })), 0);
		},
		/** Sends `message` to Harbour's side now. */
		push(message: unknown): void {
			deliver(JSON.stringify(message));
		},
		requests(method: string): JsonRpcRequest[] {
			return received.filter((message): message is JsonRpcRequest => isRequest(message) && message.method === method);
		},
		methods(): string[] {
			return received.map((message) => ("method" in message ? message.method : "answer"));
		},
	};
}

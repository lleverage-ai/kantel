/**
 * A local MCP server over Streamable HTTP: each message from Kantel is POSTed to it, and whatever comes back, a JSON
 * body or an event stream, is passed on message by message. The `Mcp-Session-Id` from the `initialize` answer goes
 * on every later request, and after `initialize` a GET stream is opened for what the server sends unasked (such as
 * `notifications/tools/list_changed`); a server that offers none answers 405, which is fine.
 *
 * Only a loopback URL is taken unless `allowRemote` is set: the tunnel is for a server on this machine, and
 * bridging a remote one would make this machine Kantel's way into somebody else's network.
 */
import { isRequest, isResponse, JSONRPC_INTERNAL_ERROR, type JsonRpcId, parseMessage } from "@kantel/tools/protocol";
import type { TunnelEndpoint } from "./tunnel.ts";

export interface HttpEndpointOptions {
	/** Bridge a URL that isn't on loopback too (`--allow-remote-url`). */
	readonly allowRemote?: boolean;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Whether `url` is http(s) on 127.0.0.1, localhost or [::1]. */
export function isLoopbackUrl(url: URL): boolean {
	return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname);
}

/** Each event's data in an event stream, as it comes. */
async function readEventStream(body: ReadableStream<Uint8Array>, onData: (data: string) => void): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const flush = (event: string): void => {
		const data = event
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		if (data.length > 0) onData(data);
	};
	for (;;) {
		const { done, value } = await reader.read();
		buffer += decoder.decode(value, { stream: !done });
		let end = buffer.search(/\r?\n\r?\n/);
		while (end !== -1) {
			flush(buffer.slice(0, end));
			buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
			end = buffer.search(/\r?\n\r?\n/);
		}
		if (done) break;
	}
	flush(buffer);
}

export function httpEndpoint(url: string, options: HttpEndpointOptions = {}): TunnelEndpoint {
	const target = new URL(url);
	if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error(`${url} isn't an http(s) URL`);
	if (!isLoopbackUrl(target) && options.allowRemote !== true) {
		throw new Error(`${url} isn't on loopback (127.0.0.1, localhost or [::1])`);
	}
	const listeners: ((message: string) => void)[] = [];
	const closing = new AbortController();
	let sessionId: string | undefined;
	let protocolVersion: string | undefined;
	/** Aborts the GET stream of the current session. */
	let stream: AbortController | undefined;

	const deliver = (message: string): void => {
		for (const listener of listeners) listener(message);
	};

	const fail = (id: JsonRpcId | undefined, message: string): void => {
		if (id === undefined || closing.signal.aborted) return;
		deliver(JSON.stringify({ jsonrpc: "2.0", id, error: { code: JSONRPC_INTERNAL_ERROR, message } }));
	};

	const headers = (): Record<string, string> => ({
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
		...(protocolVersion === undefined ? {} : { "mcp-protocol-version": protocolVersion }),
	});

	/** Passes on each message in `text`, a JSON body or an event's data; true when one answered `id`. */
	const pass = (text: string, id: JsonRpcId | undefined, initialize: boolean): boolean => {
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return false;
		}
		let answered = false;
		for (const item of Array.isArray(value) ? value : [value]) {
			const message = JSON.stringify(item);
			const parsed = parseMessage(message);
			if (parsed !== undefined && isResponse(parsed) && id !== undefined && parsed.id === id) {
				answered = true;
				if (initialize && parsed.error === undefined) {
					const version = (parsed.result as { protocolVersion?: unknown } | null)?.protocolVersion;
					if (typeof version === "string") protocolVersion = version;
				}
			}
			deliver(message);
		}
		return answered;
	};

	/** The GET stream for what the server sends unasked; best effort, for the session it was opened in. */
	const listen = async (controller: AbortController): Promise<void> => {
		try {
			const response = await fetch(target, {
				method: "GET",
				headers: { ...headers(), accept: "text/event-stream" },
				signal: controller.signal,
			});
			if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
				await response.body?.cancel();
				return;
			}
			if (response.body !== null) await readEventStream(response.body, (data) => pass(data, undefined, false));
		} catch {
			// Closed, or the server offers no stream: calls still work without one.
		}
	};

	/** Ends a session the server no longer needs, as MCP asks; best effort. */
	const endSession = (id: string): void => {
		fetch(target, { method: "DELETE", headers: { "mcp-session-id": id }, signal: AbortSignal.timeout(2000) }).then(
			(response) => response.body?.cancel(),
			() => {},
		);
	};

	const post = async (message: string): Promise<void> => {
		const parsed = parseMessage(message);
		const id = parsed !== undefined && isRequest(parsed) ? parsed.id : undefined;
		const initialize = parsed !== undefined && isRequest(parsed) && parsed.method === "initialize";
		if (initialize) {
			// A new initialize is a new session: Kantel reconnected.
			stream?.abort();
			stream = undefined;
			if (sessionId !== undefined) endSession(sessionId);
			sessionId = undefined;
			protocolVersion = undefined;
		}
		let response: Response;
		try {
			response = await fetch(target, { method: "POST", headers: headers(), body: message, signal: closing.signal });
		} catch (error) {
			fail(id, `Couldn't reach the MCP server: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (initialize) sessionId = response.headers.get("mcp-session-id") ?? undefined;
		if (!response.ok) {
			await response.body?.cancel();
			fail(id, `The MCP server answered ${response.status}`);
			return;
		}
		let answered = false;
		try {
			if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
				if (response.body !== null) {
					await readEventStream(response.body, (data) => {
						if (pass(data, id, initialize)) answered = true;
					});
				}
			} else {
				const text = await response.text();
				if (text.trim().length > 0) answered = pass(text, id, initialize);
			}
		} catch (error) {
			fail(id, `The MCP server's answer broke off: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		// 202 Accepted, for a notification or an answer, has no body; a request must be answered.
		if (!answered && id !== undefined) fail(id, "The MCP server sent no answer");
		// Only a session the server accepted: an initialize it refused gives no protocol version.
		if (initialize && protocolVersion !== undefined && !closing.signal.aborted) {
			stream = new AbortController();
			void listen(stream);
		}
	};

	return {
		send(message) {
			void post(message);
		},
		onMessage(listener) {
			listeners.push(listener);
		},
		close() {
			closing.abort();
			stream?.abort();
			if (sessionId !== undefined) endSession(sessionId);
		},
	};
}

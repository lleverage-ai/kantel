/**
 * A local MCP server run as a child process, MCP's stdio transport: one JSON-RPC message a line on its stdin and
 * stdout, and its stderr left on ours for its logs. A stdout line that isn't JSON is a log line too, and goes to
 * stderr rather than to Harbour.
 *
 * The child lives as long as the tunnel, across reconnects, but Harbour initialises each socket afresh. A server
 * can't be initialised twice, so the child's first `initialize` answer is kept: a later `initialize` is answered from
 * it with the new request's ID, and the `notifications/initialized` after it isn't passed on.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isNotification, isRequest, isResponse, type JsonRpcId, parseMessage } from "@harbour/tools/protocol";
import type { TunnelEndpoint } from "./tunnel.ts";

export interface StdioEndpointOptions {
	/** Added to this process's environment for the child. */
	readonly env?: { readonly [name: string]: string };
	readonly cwd?: string;
}

/** How the child ended: its exit code or signal, or why it couldn't start. */
export interface StdioExit {
	readonly code: number | null;
	readonly signal: string | null;
	readonly error?: string;
}

export interface StdioEndpoint extends TunnelEndpoint {
	/** Settles when the child exits, for whatever reason. */
	readonly exited: Promise<StdioExit>;
	/** Ends the child's stdin and stops it: SIGTERM, then SIGKILL if it hasn't gone in five seconds. */
	close(): Promise<void>;
}

const KILL_AFTER_MS = 5000;

export function stdioEndpoint(command: readonly string[], options: StdioEndpointOptions = {}): StdioEndpoint {
	const [file, ...args] = command;
	if (file === undefined) throw new Error("A stdio MCP server needs a command");
	const child = spawn(file, args, {
		env: { ...process.env, ...options.env },
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		stdio: ["pipe", "pipe", "inherit"],
	});
	let exit: StdioExit | undefined;
	const exited = new Promise<StdioExit>((resolve) => {
		child.once("exit", (code, signal) => {
			exit ??= { code, signal };
			resolve(exit);
		});
		child.once("error", (error) => {
			exit ??= { code: null, signal: null, error: error.message };
			resolve(exit);
		});
	});
	// Writing to a child that has gone fails with EPIPE; its exit says so.
	child.stdin.on("error", () => {});

	const listeners: ((message: string) => void)[] = [];
	const deliver = (message: string): void => {
		for (const listener of listeners) listener(message);
	};

	let initializeAnswer: unknown;
	let initializeId: JsonRpcId | undefined;
	let swallowInitialized = false;

	const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
	lines.on("line", (line) => {
		if (line.trim().length === 0) return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			value = undefined;
		}
		if (typeof value !== "object" || value === null) {
			process.stderr.write(`${line}\n`);
			return;
		}
		// A batch, from a server on an older MCP revision: one message a frame on the tunnel.
		for (const item of Array.isArray(value) ? value : [value]) {
			const text = Array.isArray(value) ? JSON.stringify(item) : line;
			const message = parseMessage(text);
			if (message !== undefined && isResponse(message) && initializeId !== undefined && message.id === initializeId) {
				if (message.error === undefined) initializeAnswer = message.result;
				initializeId = undefined;
			}
			deliver(text);
		}
	});

	const write = (message: string): void => {
		if (exit !== undefined) return;
		// One message a line: JSON with a line break inside is written again without it.
		child.stdin.write(`${message.includes("\n") ? JSON.stringify(JSON.parse(message)) : message}\n`);
	};

	return {
		exited,
		send(message) {
			const parsed = parseMessage(message);
			if (parsed !== undefined && isRequest(parsed) && parsed.method === "initialize") {
				if (initializeAnswer !== undefined) {
					swallowInitialized = true;
					const answer = JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: initializeAnswer });
					queueMicrotask(() => deliver(answer));
					return;
				}
				initializeId = parsed.id;
			} else if (
				swallowInitialized &&
				parsed !== undefined &&
				isNotification(parsed) &&
				parsed.method === "notifications/initialized"
			) {
				swallowInitialized = false;
				return;
			}
			write(message);
		},
		onMessage(listener) {
			listeners.push(listener);
		},
		async close() {
			if (exit !== undefined) return;
			lines.close();
			child.stdin.end();
			child.kill("SIGTERM");
			const timer = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);
			await exited;
			clearTimeout(timer);
		},
	};
}

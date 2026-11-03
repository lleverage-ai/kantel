// The MCP server: its JSON-RPC handshake, its tools and their arguments, and Kantel's errors as tool results.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Command, createKantelClient, type Sandbox } from "@kantel/api/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/commands.ts";
import { clipOutput, createMcpServer, PROTOCOL_VERSIONS, serveStdio, TOOL_DEFINITIONS } from "../src/mcp.ts";

interface Call {
	readonly method: string;
	readonly path: string;
	readonly body: unknown;
	readonly authorization: string | null;
}

const SANDBOX: Sandbox = {
	id: "sbx_mcp1",
	accountId: "acc_1",
	name: "calm-heron",
	subdomain: "calm-heron",
	type: "isolate",
	state: "running",
	visibility: "private",
	capabilities: {
		exec: true,
		files: true,
		ssh: false,
		desktop: false,
		browser: false,
		ports: true,
		docker: false,
		kvm: false,
		pause: false,
	},
	labels: {},
	autoStopMinutes: 60,
	createdBy: { kind: "api_key", id: "key_1" },
	createdAt: 0,
	cost: { currency: "USD", total: 0, ratePerHour: 0 },
	usage: { runningSeconds: 0, cpuSeconds: 0, recentCpu: [] },
};

const COMMAND: Command = {
	id: "cmd_1",
	sandboxId: "sbx_mcp1",
	command: "echo hi",
	state: "exited",
	exitCode: 0,
	stdout: "hi\n",
	stderr: "",
	truncated: false,
	startedAt: 0,
	durationMs: 12,
};

const ROUTES: { readonly [route: string]: (body: unknown) => Response } = {
	"POST /v1/sandboxes": () => Response.json(SANDBOX),
	"POST /v1/sandboxes/sbx_mcp1/commands": () => Response.json(COMMAND),
	"GET /v1/sandboxes/sbx_gone": () =>
		Response.json({ error: { code: "not_found", message: "No such sandbox" } }, { status: 404 }),
	"POST /v1/sandboxes/sbx_stopped/commands": () =>
		Response.json({ error: { code: "conflict", message: "The sandbox is stopped" } }, { status: 409 }),
};

function fakeKantel() {
	const calls: Call[] = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = init?.method ?? "GET";
		const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, path: url.pathname, body, authorization: new Headers(init?.headers).get("authorization") });
		const route = ROUTES[`${method} ${url.pathname}`];
		if (route === undefined) {
			const error = { code: "not_found", message: `No route ${method} ${url.pathname}` };
			return Response.json({ error }, { status: 404 });
		}
		return route(body);
	};
	return { fetch, calls };
}

function server() {
	const api = fakeKantel();
	const client = createKantelClient({ baseUrl: "https://kantel.test/v1", token: "ksk_agent", fetch: api.fetch });
	return { mcp: createMcpServer({ client, version: "1.2.3" }), calls: api.calls };
}

const request = (id: number, method: string, params?: object) => ({ jsonrpc: "2.0", id, method, params });

interface CallResult {
	readonly content: readonly { readonly type: string; readonly text: string }[];
	readonly structuredContent?: { readonly [key: string]: unknown };
	readonly isError?: boolean;
}

/** A tools/call's result, from its JSON-RPC answer. */
function resultOf(answer: object | undefined): CallResult {
	expect(answer).toMatchObject({ jsonrpc: "2.0", result: {} });
	return (answer as { readonly result: CallResult }).result;
}

describe("the MCP server", () => {
	it("answers initialize with its protocol version, tools capability and instructions", async () => {
		const { mcp } = server();
		const answer = await mcp.handle(
			request(1, "initialize", {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "test", version: "0" },
			}),
		);
		expect(answer).toMatchObject({
			jsonrpc: "2.0",
			id: 1,
			result: {
				protocolVersion: "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "kantel", version: "1.2.3" },
			},
		});
		const unknownVersion = await mcp.handle(request(2, "initialize", { protocolVersion: "1999-01-01" }));
		expect(unknownVersion).toMatchObject({ result: { protocolVersion: PROTOCOL_VERSIONS[0] } });
	});

	it("gives notifications no answer, and unknown methods -32601", async () => {
		const { mcp } = server();
		expect(await mcp.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
		expect(await mcp.handle(request(3, "resources/list"))).toMatchObject({ id: 3, error: { code: -32601 } });
		expect(await mcp.handle(request(4, "ping"))).toEqual({ jsonrpc: "2.0", id: 4, result: {} });
	});

	it("lists its tools, each with an object schema, and marks deleting and overwriting as destructive", async () => {
		const { mcp } = server();
		const answer = (await mcp.handle(request(5, "tools/list"))) as {
			result: { tools: { name: string; inputSchema: { type: string }; annotations: { destructiveHint?: boolean } }[] };
		};
		const names = answer.result.tools.map((tool) => tool.name);
		for (const name of [
			"sandbox_create",
			"sandbox_list",
			"sandbox_get",
			"sandbox_stop",
			"sandbox_resume",
			"sandbox_fork",
			"sandbox_delete",
			"sandbox_exec",
			"file_read",
			"file_write",
			"file_list",
			"port_expose",
			"snapshot_save",
			"snapshot_list",
			"browser_open",
			"desktop_open",
		]) {
			expect(names).toContain(name);
		}
		expect(answer.result.tools).toHaveLength(TOOL_DEFINITIONS.length);
		for (const tool of answer.result.tools) expect(tool.inputSchema.type).toBe("object");
		const destructive = answer.result.tools.filter((tool) => tool.annotations.destructiveHint === true);
		expect(destructive.map((tool) => tool.name)).toEqual(["sandbox_delete", "file_write"]);
	});

	it("creates a sandbox, waiting until it runs, and runs a command in it", async () => {
		const { mcp, calls } = server();
		const created = resultOf(
			await mcp.handle(request(6, "tools/call", { name: "sandbox_create", arguments: { labels: { task: "T-1" } } })),
		);
		expect(created.isError).toBeUndefined();
		expect(created.structuredContent).toMatchObject({ id: "sbx_mcp1", state: "running" });
		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/v1/sandboxes",
			body: { labels: { task: "T-1" }, wait: true },
			authorization: "Bearer ksk_agent",
		});
		const ran = resultOf(
			await mcp.handle(
				request(7, "tools/call", { name: "sandbox_exec", arguments: { sandboxId: "sbx_mcp1", command: "echo hi" } }),
			),
		);
		expect(ran.isError).toBeUndefined();
		expect(ran.structuredContent).toMatchObject({ exitCode: 0, stdout: "hi\n", state: "exited" });
		expect(ran.content[0]?.text).toContain("exited with code 0");
		expect(calls[1]).toMatchObject({ path: "/v1/sandboxes/sbx_mcp1/commands", body: { command: "echo hi" } });
	});

	it("answers Kantel's errors as tool results with isError, and a hint where it helps", async () => {
		const { mcp } = server();
		const missing = resultOf(
			await mcp.handle(request(8, "tools/call", { name: "sandbox_get", arguments: { sandboxId: "sbx_gone" } })),
		);
		expect(missing.isError).toBe(true);
		expect(missing.content[0]?.text).toContain("not_found: No such sandbox");
		const stopped = resultOf(
			await mcp.handle(
				request(9, "tools/call", { name: "sandbox_exec", arguments: { sandboxId: "sbx_stopped", command: "ls" } }),
			),
		);
		expect(stopped.isError).toBe(true);
		expect(stopped.content[0]?.text).toContain("sandbox_resume");
	});

	it("refuses bad arguments before calling Kantel", async () => {
		const { mcp, calls } = server();
		const missing = resultOf(await mcp.handle(request(10, "tools/call", { name: "sandbox_exec", arguments: {} })));
		expect(missing.isError).toBe(true);
		expect(missing.content[0]?.text).toContain("sandboxId is required");
		const extra = resultOf(
			await mcp.handle(request(11, "tools/call", { name: "sandbox_get", arguments: { sandboxId: "x", nope: 1 } })),
		);
		expect(extra.isError).toBe(true);
		const wrongType = resultOf(
			await mcp.handle(request(12, "tools/call", { name: "sandbox_create", arguments: { type: "vm" } })),
		);
		expect(wrongType.isError).toBe(true);
		expect(calls).toEqual([]);
		expect(await mcp.handle(request(13, "tools/call", { name: "no_such_tool" }))).toMatchObject({
			id: 13,
			error: { code: -32602 },
		});
	});

	it("answers a batch", async () => {
		const { mcp } = server();
		const answers = await mcp.handle([
			request(14, "ping"),
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			request(15, "ping"),
		]);
		expect(answers).toEqual([
			{ jsonrpc: "2.0", id: 14, result: {} },
			{ jsonrpc: "2.0", id: 15, result: {} },
		]);
	});

	it("cuts long output in the middle, keeping its head and tail", () => {
		const long = `HEAD${"x".repeat(200_000)}TAIL`;
		const clipped = clipOutput(long);
		expect(clipped.length).toBeLessThan(70_000);
		expect(clipped.startsWith("HEAD")).toBe(true);
		expect(clipped.endsWith("TAIL")).toBe(true);
		expect(clipped).toContain("characters cut here");
		expect(clipOutput("short")).toBe("short");
	});
});

describe("serving on stdio", () => {
	let configDir = "";

	beforeEach(async () => {
		configDir = await mkdtemp(join(tmpdir(), "kantel-mcp-"));
	});

	afterEach(async () => {
		await rm(configDir, { recursive: true, force: true });
	});

	async function* lines(...messages: readonly object[]): AsyncGenerator<string> {
		// Split across chunks, as a pipe may deliver it.
		const text = messages.map((message) => `${JSON.stringify(message)}\n`).join("");
		const middle = Math.floor(text.length / 2);
		yield text.slice(0, middle);
		yield text.slice(middle);
	}

	it("answers one line for each request, and none for a notification", async () => {
		const { mcp } = server();
		const out: string[] = [];
		await serveStdio(mcp, {
			stdin: lines(
				request(1, "initialize", { protocolVersion: "2025-06-18" }),
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				request(2, "tools/list"),
			),
			stdout: { write: (chunk: string) => out.push(chunk) },
		});
		const answers = out
			.join("")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { id: number });
		expect(answers.map((answer) => answer.id).sort()).toEqual([1, 2]);
	});

	it("answers a line that isn't JSON with a parse error", async () => {
		const { mcp } = server();
		const out: string[] = [];
		async function* garbage(): AsyncGenerator<string> {
			yield "not json\n";
		}
		await serveStdio(mcp, { stdin: garbage(), stdout: { write: (chunk: string) => out.push(chunk) } });
		expect(JSON.parse(out.join(""))).toMatchObject({ id: null, error: { code: -32700 } });
	});

	it("runs as kantel mcp, with the key from the environment, and keeps stdout for JSON-RPC", async () => {
		const api = fakeKantel();
		const out: string[] = [];
		const err: string[] = [];
		const code = await run(["mcp"], {
			fetch: api.fetch,
			env: { KANTEL_URL: "https://kantel.test", KANTEL_API_KEY: "ksk_agent" },
			stdin: lines(
				request(1, "initialize", { protocolVersion: "2025-06-18" }),
				request(2, "tools/call", { name: "sandbox_create", arguments: {} }),
			),
			stdout: { write: (chunk: string | Uint8Array) => out.push(String(chunk)) },
			stderr: { write: (chunk: string | Uint8Array) => err.push(String(chunk)) },
			configDir,
		});
		expect(code).toBe(0);
		const answers = out
			.join("")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { id: number; result: { structuredContent?: { id?: string } } });
		expect(answers).toHaveLength(2);
		expect(answers.find((answer) => answer.id === 2)?.result.structuredContent?.id).toBe("sbx_mcp1");
		expect(api.calls[0]?.authorization).toBe("Bearer ksk_agent");
		expect(err.join("")).toBe("");
	});
});

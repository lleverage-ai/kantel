// The MCP server: its JSON-RPC handshake, its tools and their arguments, and Kantel's errors as tool results.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Command, createKantelClient, type Sandbox } from "@kantel/api/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/commands.ts";
import {
	clipOutput,
	commandResult,
	createMcpServer,
	PROTOCOL_VERSIONS,
	serveStdio,
	TOOL_DEFINITIONS,
} from "../src/mcp.ts";

interface Call {
	readonly method: string;
	readonly path: string;
	/** The query string, such as ?limit=20. */
	readonly search: string;
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
	grants: [],
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
	usage: { runningSeconds: 0, cpuSeconds: 0, recentCpu: [], recentMemory: [] },
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

const RUNNING: Command = {
	...COMMAND,
	id: "cmd_long",
	command: "make",
	state: "running",
	stdout: "",
	exitCode: undefined,
};

/** A response after `ms`, or a rejection when `signal` aborts first, as fetch does. */
const later = (ms: number, response: () => Response, signal?: AbortSignal | null): Promise<Response> =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve(response()), ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new DOMException("aborted", "AbortError"));
		});
	});

/** cmd_long runs until it has been polled this many times. */
let pollsUntilDone = 0;

const ROUTES: {
	readonly [route: string]: (body: unknown, signal?: AbortSignal | null, url?: URL) => Response | Promise<Response>;
} = {
	"POST /v1/sandboxes": () => Response.json(SANDBOX),
	"POST /v1/sandboxes/sbx_mcp1/commands": (body) =>
		Response.json((body as { detached?: boolean }).detached === true ? RUNNING : COMMAND),
	"POST /v1/sandboxes/sbx_slow/commands": (_body, signal) => later(120, () => Response.json(COMMAND), signal),
	// Slow, and deaf to the signal, like a request that can't be aborted.
	"POST /v1/sandboxes/sbx_slow/browser": () =>
		later(300, () => Response.json({ url: "https://view.test", cdpUrl: "wss://cdp.test", expiresAt: 0 })),
	"GET /v1/sandboxes/sbx_mcp1/commands/cmd_long": () => {
		pollsUntilDone -= 1;
		return Response.json(
			pollsUntilDone > 0 ? RUNNING : { ...RUNNING, state: "exited", exitCode: 0, stdout: "built\n" },
		);
	},
	"GET /v1/sandboxes/sbx_mcp1/commands": () => Response.json({ items: [{ ...RUNNING, stdout: "lots" }, COMMAND] }),
	"GET /v1/sandboxes/sbx_many/commands": (_body, _signal, url) =>
		Response.json(
			url?.searchParams.get("cursor") === "c2"
				? { items: [{ ...COMMAND, id: "cmd_old" }] }
				: { items: [{ ...COMMAND, id: "cmd_new" }], nextCursor: "c2" },
		),
	"DELETE /v1/sandboxes/sbx_mcp1/commands/cmd_long": () =>
		Response.json({ ...RUNNING, state: "killed", exitCode: 137 }),
	"GET /v1/sandboxes/sbx_gone": () =>
		Response.json({ error: { code: "not_found", message: "No such sandbox" } }, { status: 404 }),
	"POST /v1/sandboxes/sbx_held/commands": () =>
		Response.json(
			{
				error: {
					code: "conflict",
					message: "A call with this Idempotency-Key didn't finish, so whether it took effect is unknown",
					details: { idempotencyKey: "held" },
				},
			},
			{ status: 409 },
		),
	"POST /v1/sandboxes/sbx_stopped/commands": () =>
		Response.json(
			{
				error: {
					code: "conflict",
					message: "The sandbox is stopped (auto-stop); resume it first",
					details: {
						code: "sandbox_stopped",
						sandboxId: "sbx_stopped",
						state: "stopped",
						stopReason: "auto-stop",
						hint: "Resume it with kantel resume sbx_stopped or POST /v1/sandboxes/sbx_stopped/resume, then try again",
					},
				},
			},
			{ status: 409 },
		),
	"POST /v1/sandboxes/sbx_away/resume": () =>
		Response.json(
			{
				error: {
					code: "unavailable",
					message: "No host can run a microvm sandbox now",
					details: { reason: "host_unavailable" },
				},
			},
			{ status: 503 },
		),
	"GET /v1/sandboxes/sbx_full": () =>
		Response.json({
			...SANDBOX,
			id: "sbx_full",
			state: "error",
			reason: "No host can take a microVM of size default (full)",
			placementReason: "insufficient_capacity",
		}),
	"POST /v1/sandboxes/sbx_full/resume": () =>
		Response.json({
			...SANDBOX,
			id: "sbx_full",
			state: "error",
			reason: "No host can take a microVM of size default (full)",
			placementReason: "insufficient_capacity",
		}),
	"POST /v1/sandboxes/sbx_starting/commands": () =>
		Response.json(
			{
				error: {
					code: "conflict",
					message: "The sandbox is still starting after 60 seconds; send the call again",
					details: {
						code: "sandbox_starting",
						sandboxId: "sbx_starting",
						state: "starting",
						hint: "It is still starting: send the call again in a moment",
					},
				},
			},
			{ status: 409 },
		),
};

function fakeKantel() {
	const calls: Call[] = [];
	/** Each call's `Idempotency-Key`, or null. */
	const keys: (string | null)[] = [];
	const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
		const method = init?.method ?? "GET";
		const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({
			method,
			path: url.pathname,
			search: url.search,
			body,
			authorization: new Headers(init?.headers).get("authorization"),
		});
		keys.push(new Headers(init?.headers).get("idempotency-key"));
		const route = ROUTES[`${method} ${url.pathname}`];
		if (route === undefined) {
			const error = { code: "not_found", message: `No route ${method} ${url.pathname}` };
			return Response.json({ error }, { status: 404 });
		}
		return route(body, init?.signal, url);
	};
	return { fetch, calls, keys };
}

function server(timing: { readonly pollIntervalMs?: number } = {}) {
	const api = fakeKantel();
	const client = createKantelClient({ baseUrl: "https://kantel.test/v1", token: "ksk_agent", fetch: api.fetch });
	return {
		mcp: createMcpServer({ client, version: "1.2.3", progressIntervalMs: 20, pollIntervalMs: 5, ...timing }),
		calls: api.calls,
		keys: api.keys,
	};
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
			"command_get",
			"command_list",
			"command_kill",
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
		// An agent has to choose a type: the API's default, an isolate, is rarely what one that left it out wants.
		const untyped = resultOf(
			await mcp.handle(request(5, "tools/call", { name: "sandbox_create", arguments: { labels: { task: "T-1" } } })),
		);
		expect(untyped.isError).toBe(true);
		expect(untyped.content[0]?.text).toContain("type is required");
		// A null from is no snapshot either, so it needs a type too.
		const nullFrom = resultOf(
			await mcp.handle(request(9, "tools/call", { name: "sandbox_create", arguments: { from: null } })),
		);
		expect(nullFrom.isError).toBe(true);
		expect(calls).toHaveLength(0);
		const created = resultOf(
			await mcp.handle(
				request(6, "tools/call", {
					name: "sandbox_create",
					arguments: { type: "microvm", labels: { task: "T-1" } },
				}),
			),
		);
		expect(created.isError).toBeUndefined();
		expect(created.structuredContent).toMatchObject({ id: "sbx_mcp1", state: "running" });
		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/v1/sandboxes",
			body: { type: "microvm", labels: { task: "T-1" }, wait: true },
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
		// One made from a snapshot takes the snapshot's type, so it needs none.
		const fromSnapshot = resultOf(
			await mcp.handle(request(8, "tools/call", { name: "sandbox_create", arguments: { from: "base" } })),
		);
		expect(fromSnapshot.isError).toBeUndefined();
		expect(calls[2]).toMatchObject({ path: "/v1/sandboxes", body: { from: "base", wait: true } });
	});

	it("sends a new Idempotency-Key with each sandbox_exec call, so a retried request runs it once", async () => {
		const { mcp, keys } = server();
		const exec = (id: number) =>
			mcp.handle(
				request(id, "tools/call", { name: "sandbox_exec", arguments: { sandboxId: "sbx_mcp1", command: "ls" } }),
			);
		await exec(1);
		await exec(2);
		expect(keys).toHaveLength(2);
		expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/);
		expect(keys[1]).not.toBe(keys[0]);
	});

	it("says to check before calling again when an exec's key is held, not to resume the sandbox", async () => {
		const { mcp } = server();
		const held = resultOf(
			await mcp.handle(
				request(11, "tools/call", { name: "sandbox_exec", arguments: { sandboxId: "sbx_held", command: "make" } }),
			),
		);
		expect(held.isError).toBe(true);
		expect(held.content[0]?.text).toContain("may have taken effect");
		expect(held.content[0]?.text).not.toContain("sandbox_resume");
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
		expect(stopped.structuredContent).toMatchObject({
			error: { code: "conflict", details: { code: "sandbox_stopped", state: "stopped", stopReason: "auto-stop" } },
		});
		const starting = resultOf(
			await mcp.handle(
				request(12, "tools/call", { name: "sandbox_exec", arguments: { sandboxId: "sbx_starting", command: "ls" } }),
			),
		);
		expect(starting.isError).toBe(true);
		expect(starting.content[0]?.text).toContain("call the tool again in a moment");
		expect(starting.content[0]?.text).not.toContain("sandbox_resume");
	});

	it("names why a sandbox can't be placed, with what to do about it", async () => {
		const { mcp } = server();
		const away = resultOf(
			await mcp.handle(request(20, "tools/call", { name: "sandbox_resume", arguments: { sandboxId: "sbx_away" } })),
		);
		expect(away.isError).toBe(true);
		expect(away.content[0]?.text).toContain("unavailable (host_unavailable): No host can run a microvm sandbox now");
		expect(away.content[0]?.text).toContain("Try again later");
		expect(away.structuredContent).toMatchObject({ error: { code: "unavailable", reason: "host_unavailable" } });
		// A boot that couldn't place it answers the sandbox in error, saying why.
		const full = resultOf(
			await mcp.handle(request(21, "tools/call", { name: "sandbox_resume", arguments: { sandboxId: "sbx_full" } })),
		);
		expect(full.isError).toBeUndefined();
		expect(full.content[0]?.text).toContain(
			"Sandbox sbx_full is error (insufficient_capacity): No host can take a microVM of size default (full)",
		);
		expect(full.content[0]?.text).toContain("The hosts are full now");
		// Read later, it says the same, and is still the whole sandbox.
		const got = resultOf(
			await mcp.handle(request(22, "tools/call", { name: "sandbox_get", arguments: { sandboxId: "sbx_full" } })),
		);
		expect(got.content[0]?.text).toContain("Sandbox sbx_full is error (insufficient_capacity)");
		expect(got.content[0]?.text).toContain("The hosts are full now");
		expect(got.structuredContent).toMatchObject({ id: "sbx_full", placementReason: "insufficient_capacity" });
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

	it("reports progress while a call waits, when the request carries a progress token", async () => {
		const { mcp } = server();
		const notes: { method: string; params: { progressToken: unknown; progress: number; message: string } }[] = [];
		const answer = await mcp.handle(
			request(30, "tools/call", {
				name: "sandbox_exec",
				arguments: { sandboxId: "sbx_slow", command: "make" },
				_meta: { progressToken: "tok-1" },
			}),
			(note) => notes.push(note as (typeof notes)[number]),
		);
		expect(resultOf(answer).structuredContent).toMatchObject({ state: "exited" });
		expect(notes.length).toBeGreaterThan(1);
		for (const note of notes) {
			expect(note).toMatchObject({ method: "notifications/progress", params: { progressToken: "tok-1" } });
		}
		// Each notification's progress is above the one before it, even several a second.
		const progress = notes.map((note) => note.params.progress);
		for (let index = 1; index < progress.length; index += 1) {
			expect(progress[index]).toBeGreaterThan(progress[index - 1] ?? Number.POSITIVE_INFINITY);
		}
		expect(notes[0]?.params.message).toContain("sandbox_exec");
		// None after the answer.
		const sent = notes.length;
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(notes).toHaveLength(sent);
	});

	it("ends a cancelled call at once, even when its request can't be aborted", async () => {
		const { mcp } = server();
		const notes: object[] = [];
		const started = Date.now();
		const pending = mcp.handle(
			request(40, "tools/call", {
				name: "browser_open",
				arguments: { sandboxId: "sbx_slow" },
				_meta: { progressToken: "b" },
			}),
			(note) => notes.push(note),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		await mcp.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 40 } });
		expect(await pending).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(250);
		const sent = notes.length;
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(notes).toHaveLength(sent);
	});

	it("stops command_get's wait when it is cancelled between polls", async () => {
		const { mcp, calls } = server({ pollIntervalMs: 1000 });
		pollsUntilDone = 1_000;
		const started = Date.now();
		const pending = mcp.handle(
			request(41, "tools/call", {
				name: "command_get",
				arguments: { sandboxId: "sbx_mcp1", commandId: "cmd_long", waitMs: 60_000 },
			}),
		);
		// Its first pause between polls is 250 ms: cancel in the middle of it.
		await new Promise((resolve) => setTimeout(resolve, 50));
		await mcp.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 41 } });
		expect(await pending).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(200);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(calls.filter((call) => call.path.endsWith("/cmd_long"))).toHaveLength(1);
	});

	it("sends no progress without a progress token", async () => {
		const { mcp } = server();
		const notes: object[] = [];
		await mcp.handle(
			request(31, "tools/call", { name: "sandbox_exec", arguments: { sandboxId: "sbx_slow", command: "make" } }),
			(note) => notes.push(note),
		);
		expect(notes).toEqual([]);
	});

	it("stops a call's wait on notifications/cancelled and gives it no answer", async () => {
		const { mcp, calls } = server();
		const notes: object[] = [];
		const pending = mcp.handle(
			request(32, "tools/call", {
				name: "sandbox_exec",
				arguments: { sandboxId: "sbx_slow", command: "make" },
				_meta: { progressToken: 7 },
			}),
			(note) => notes.push(note),
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(
			await mcp.handle({
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: 32, reason: "timeout" },
			}),
		).toBeUndefined();
		expect(await pending).toBeUndefined();
		const after = notes.length;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(notes).toHaveLength(after);
		// The command itself isn't killed: only the wait for it stops.
		expect(calls.filter((call) => call.method === "DELETE")).toEqual([]);
	});

	it("starts a detached command and says how to pick it up", async () => {
		const { mcp, calls } = server();
		const started = resultOf(
			await mcp.handle(
				request(33, "tools/call", {
					name: "sandbox_exec",
					arguments: { sandboxId: "sbx_mcp1", command: "make", detached: true },
				}),
			),
		);
		expect(started.isError).toBeUndefined();
		expect(started.structuredContent).toEqual({ commandId: "cmd_long", state: "running" });
		expect(started.content[0]?.text).toContain("command_get");
		expect(calls[0]?.body).toEqual({ command: "make", detached: true });
		// A detached command may have a limit of its own.
		const capped = resultOf(
			await mcp.handle(
				request(34, "tools/call", {
					name: "sandbox_exec",
					arguments: { sandboxId: "sbx_mcp1", command: "make", detached: true, timeoutMs: 1000 },
				}),
			),
		);
		expect(capped.isError).toBeUndefined();
		expect(calls[1]?.body).toEqual({ command: "make", timeoutMs: 1000, detached: true });
		// No limit and a kill that stops it, but the old limits on a host from before exec-control, said as such.
		const described = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool.description]));
		expect(described.get("sandbox_exec")).toContain("no time limit unless you give it a timeoutMs");
		expect(described.get("sandbox_exec")).toContain("predates exec-control still ends it after about 2 minutes");
		expect(described.get("command_kill")).toContain("Kill a running command and the processes it started");
		expect(described.get("command_kill")).toContain("predates exec-control it is only marked killed");
	});

	it("gets a command, waiting for it to end with waitMs", async () => {
		const { mcp, calls } = server();
		pollsUntilDone = 3;
		const done = resultOf(
			await mcp.handle(
				request(35, "tools/call", {
					name: "command_get",
					arguments: { sandboxId: "sbx_mcp1", commandId: "cmd_long", waitMs: 5000 },
				}),
			),
		);
		expect(done.structuredContent).toMatchObject({ state: "exited", exitCode: 0, stdout: "built\n" });
		expect(calls.filter((call) => call.path.endsWith("/cmd_long"))).toHaveLength(3);
	});

	it("says a command is still running when its wait runs out, and how to pick it up", async () => {
		const { mcp } = server();
		pollsUntilDone = 1_000;
		const running = resultOf(
			await mcp.handle(
				request(36, "tools/call", {
					name: "command_get",
					arguments: { sandboxId: "sbx_mcp1", commandId: "cmd_long", waitMs: 30 },
				}),
			),
		);
		expect(running.isError).toBeUndefined();
		expect(running.structuredContent).toMatchObject({ commandId: "cmd_long", state: "running" });
		expect(running.content[0]?.text).toContain("still running");
		expect(running.content[0]?.text).toContain("command_get");
		expect(running.content[0]?.text).toContain("command_kill");
	});

	it("pages through a sandbox's commands with nextCursor and cursor", async () => {
		const { mcp, calls } = server();
		const first = resultOf(
			await mcp.handle(
				request(42, "tools/call", { name: "command_list", arguments: { sandboxId: "sbx_many", limit: 1 } }),
			),
		);
		expect(first.structuredContent).toMatchObject({ items: [{ commandId: "cmd_new" }], nextCursor: "c2" });
		expect(first.content[0]?.text).toContain("cursor c2");
		const second = resultOf(
			await mcp.handle(
				request(43, "tools/call", {
					name: "command_list",
					arguments: { sandboxId: "sbx_many", limit: 1, cursor: "c2" },
				}),
			),
		);
		expect(second.structuredContent).toEqual({
			items: [{ commandId: "cmd_old", command: "echo hi", state: "exited", exitCode: 0, startedAt: 0, durationMs: 12 }],
		});
		expect(second.content[0]?.text).not.toContain("older commands");
		expect(calls.map((call) => call.search)).toEqual(["?limit=1", "?limit=1&cursor=c2"]);
	});

	it("lists commands without their output, and kills one", async () => {
		const { mcp, calls } = server();
		const listed = resultOf(
			await mcp.handle(request(37, "tools/call", { name: "command_list", arguments: { sandboxId: "sbx_mcp1" } })),
		);
		expect(listed.structuredContent).toEqual({
			items: [
				{ commandId: "cmd_long", command: "make", state: "running", exitCode: null, startedAt: 0, durationMs: 12 },
				{ commandId: "cmd_1", command: "echo hi", state: "exited", exitCode: 0, startedAt: 0, durationMs: 12 },
			],
		});
		const killed = resultOf(
			await mcp.handle(
				request(38, "tools/call", {
					name: "command_kill",
					arguments: { sandboxId: "sbx_mcp1", commandId: "cmd_long" },
				}),
			),
		);
		expect(killed.structuredContent).toMatchObject({ state: "killed" });
		expect(killed.content[0]?.text).toContain("The command was killed, and the processes it started with it.");
		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			"GET /v1/sandboxes/sbx_mcp1/commands",
			"DELETE /v1/sandboxes/sbx_mcp1/commands/cmd_long",
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

	it("writes progress as lines while a call waits, and no answer for a cancelled one", async () => {
		const { mcp } = server();
		const out: string[] = [];
		async function* slowly(): AsyncGenerator<string> {
			const call = (id: number) =>
				request(id, "tools/call", {
					name: "sandbox_exec",
					arguments: { sandboxId: "sbx_slow", command: "make" },
					_meta: { progressToken: `p${id}` },
				});
			yield `${JSON.stringify(call(1))}\n${JSON.stringify(call(2))}\n`;
			await new Promise((resolve) => setTimeout(resolve, 30));
			yield `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2 } })}\n`;
		}
		await serveStdio(mcp, { stdin: slowly(), stdout: { write: (chunk: string) => out.push(chunk) } });
		const messages = out.map((line) => JSON.parse(line) as { id?: number; method?: string; params?: object });
		expect(messages.filter((message) => message.id !== undefined).map((message) => message.id)).toEqual([1]);
		expect(messages.filter((message) => message.method === "notifications/progress")).toContainEqual(
			expect.objectContaining({ params: expect.objectContaining({ progressToken: "p1" }) }),
		);
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
				request(2, "tools/call", { name: "sandbox_create", arguments: { type: "isolate" } }),
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

describe("a killed command's answer", () => {
	it("says the process may run on only when its host couldn't stop it", () => {
		const base: Command = {
			id: "cmd_k",
			sandboxId: "sbx_mcp1",
			command: "./serve",
			state: "killed",
			exitCode: 137,
			stdout: "",
			stderr: "",
			truncated: false,
			startedAt: 1,
		};
		const text = (command: Command) => commandResult(command).content[0]?.text ?? "";
		expect(text(base)).toContain("The command was killed, and the processes it started with it.");
		const old = {
			...base,
			stderr: "Kantel marked this command killed but couldn't stop it, so it may still be running: upgrade\n",
		};
		expect(text(old)).toContain("its host couldn't stop it");
		expect(text(old)).toContain("pkill -f");
	});
});

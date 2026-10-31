// Tool servers in the runtime (`SessionRuntimeOptions.toolServers`, docs/site/src/content/docs/api/tool-servers.md):
// a profile's `<server>/<tool>` and `<server>/*` entries offer the server's tools as `<server>__<tool>`, exactly as
// the server gave them; each session keeps the tools it was first offered (its pin), in memory and across a reopen on
// SQL; calls are audited with the server, its transport and how long they took; a name too long is refused when the
// profile is saved.
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type {
	AgentProfile,
	AuditEventInput,
	AuditSink,
	HostToolCall,
	SessionRecord,
	SessionToolServer,
	SessionToolServers,
	ToolServerTool,
} from "@kantel/contracts";
import { createSessionRuntime, type SessionRuntimeOptions } from "@kantel/runtime/core";
import { createMemoryRuntime } from "@kantel/runtime/memory";
import { createSqlSessionStore, sqlPiStorage } from "@kantel/runtime/sql";
import { createScriptedModel } from "@kantel/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-tool-servers";
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;

const ECHO: ToolServerTool = {
	name: "echo",
	description: "Answers with what it was given",
	inputSchema: { type: "object", properties: { text: { type: "string" } } },
	annotations: { readOnlyHint: true },
	replay: "safe",
};
const OTHER: ToolServerTool = {
	name: "other",
	description: "Not in every profile",
	inputSchema: { type: "object" },
	replay: "unsafe",
};
const ADDED: ToolServerTool = {
	name: "added",
	description: "Added later",
	inputSchema: { type: "object" },
	replay: "unsafe",
};

const profile = (tools: string[]): AgentProfile => ({
	id: "worker",
	organisationId: ORG,
	name: "Worker",
	model: { route: "default" },
	promptLayers: [],
	tools,
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
});

interface FakeServer extends SessionToolServer {
	readonly organisationId: string;
	online: boolean;
}

/** A registry of one organisation's servers, whose calls answer with what they were given. */
function fakeToolServers() {
	const servers = new Map<string, FakeServer>();
	const calls: { readonly server: SessionToolServer; readonly call: HostToolCall }[] = [];
	const toolServers: SessionToolServers = {
		async servers(record: SessionRecord, names) {
			return [...servers.values()].filter(
				(server) => server.organisationId === record.organisationId && names.includes(server.name),
			);
		},
		async call(server, call) {
			calls.push({ server, call });
			if (servers.get(server.id)?.disabledTools.includes(call.tool) === true) {
				return { output: `Tool ${call.tool} of tool server ${server.name} is disabled`, isError: true };
			}
			if (servers.get(server.id)?.online !== true) {
				return { output: `Tool server ${server.name} is offline`, isError: true };
			}
			return { output: `${call.tool}: ${JSON.stringify(call.args)}` };
		},
	};
	const put = (
		server: Omit<FakeServer, "organisationId" | "transport" | "disabledTools" | "online"> &
			Partial<Pick<FakeServer, "disabledTools">>,
	) => {
		servers.set(server.id, {
			organisationId: ORG,
			transport: "tunnel",
			disabledTools: [],
			online: true,
			...server,
		});
	};
	const snapshot = (tools: readonly ToolServerTool[], hash: string) => ({ tools, hash, takenAt: 1 });
	return { servers, calls, toolServers, put, snapshot };
}

function recordingAudit() {
	const events: AuditEventInput[] = [];
	const sink: AuditSink = {
		async append(_ctx, appended) {
			events.push(...appended);
		},
	};
	return { events, sink };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
});

function memoryRuntime(extra: Partial<SessionRuntimeOptions> = {}) {
	const { models, script } = createScriptedModel();
	const service = createMemoryRuntime({ models, ...extra });
	closers.push(() => service.close());
	return { service, script };
}

/** The names of the tools the model was offered in request `index`. */
const offered = (script: ReturnType<typeof createScriptedModel>["script"], index: number) =>
	(script.requests[index]?.tools ?? []).map((tool) => tool.name);

async function run(service: ReturnType<typeof memoryRuntime>["service"], sessionId: string, text: string) {
	const prompt = await service.runtime.prompt(ctx, sessionId, { text });
	return service.runtime.wait(ctx, sessionId, prompt.id);
}

describe("tool servers in the runtime", () => {
	it("offers the profile's tools of a server as <server>__<tool>, as the server gave them, and calls each by its own name", async () => {
		const fake = fakeToolServers();
		fake.put({ id: "ts_1", name: "sal", snapshot: fake.snapshot([ECHO, OTHER], "sha256:one") });
		const audit = recordingAudit();
		const { service, script } = memoryRuntime({ toolServers: fake.toolServers, audit: audit.sink });
		await service.profiles.put(ctx, profile(["sal/echo"]));
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });

		script.reply({ toolCalls: [{ name: "sal__echo", args: { text: "hi" } }] }, { text: "Done" });
		expect(await run(service, session.id, "Echo")).toMatchObject({ status: "answered", answer: "Done" });

		// Only the tool the profile names, with the server's description and schema and nothing added.
		const tools = script.requests[0]?.tools ?? [];
		expect(tools.map((tool) => tool.name)).toEqual(["sal__echo"]);
		expect(tools[0]?.description).toBe(ECHO.description);
		expect(JSON.parse(JSON.stringify(tools[0]?.parameters))).toEqual(ECHO.inputSchema);

		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0]?.call;
		expect(call).toMatchObject({
			hostId: "tool-server:ts_1",
			tool: "echo",
			args: { text: "hi" },
			sessionId: session.id,
			organisationId: ORG,
			projectId: "proj",
			agentId: "worker",
		});
		expect(call?.callId).toEqual(expect.any(String));
		expect(script.requests[1]?.messages.at(-1)).toEqual({ role: "tool", text: 'echo: {"text":"hi"}' });

		const started = audit.events.find((event) => event.type === "session.tool.started");
		const finished = audit.events.find((event) => event.type === "session.tool.finished");
		expect(started?.data).toEqual({
			hostId: "tool-server:ts_1",
			tool: "sal__echo",
			toolServerId: "ts_1",
			transport: "tunnel",
		});
		expect(finished?.data).toMatchObject({
			hostId: "tool-server:ts_1",
			tool: "sal__echo",
			toolServerId: "ts_1",
			transport: "tunnel",
			outcome: "done",
		});
		expect(finished?.data?.durationMs).toEqual(expect.any(Number));
	});

	it("keeps a running session on its pin, and gives a changed snapshot to new sessions only", async () => {
		const fake = fakeToolServers();
		fake.put({ id: "ts_1", name: "sal", snapshot: fake.snapshot([ECHO], "sha256:one") });
		const { service, script } = memoryRuntime({ toolServers: fake.toolServers });
		await service.profiles.put(ctx, profile(["sal/*"]));
		const first = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		script.reply({ text: "One" });
		await run(service, first.id, "Hello");
		expect(offered(script, 0)).toEqual(["sal__echo"]);

		fake.put({ id: "ts_1", name: "sal", snapshot: fake.snapshot([ECHO, ADDED], "sha256:two") });
		await service.toolServerChanged(ORG, "sal");
		script.reply({ toolCalls: [{ name: "sal__added", args: {} }] }, { text: "Two" });
		await run(service, first.id, "Again");
		// The running session still has its first tools: the new one isn't there to call.
		expect(offered(script, 1)).toEqual(["sal__echo"]);
		expect(fake.calls).toEqual([]);

		const second = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		script.reply({ text: "Three" });
		await run(service, second.id, "Hello");
		expect(offered(script, 3)).toEqual(["sal__echo", "sal__added"]);
	});

	it("offers nothing from a server that has never listed its tools, until it does", async () => {
		const fake = fakeToolServers();
		fake.put({ id: "ts_1", name: "sal" });
		const { service, script } = memoryRuntime({ toolServers: fake.toolServers });
		await service.profiles.put(ctx, profile(["sal/*"]));
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		script.reply({ text: "None" });
		await run(service, session.id, "Hello");
		expect(offered(script, 0)).toEqual([]);

		fake.put({ id: "ts_1", name: "sal", snapshot: fake.snapshot([ECHO], "sha256:one") });
		await service.toolServerChanged(ORG, "sal");
		script.reply({ text: "Some" });
		await run(service, session.id, "Again");
		expect(offered(script, 1)).toEqual(["sal__echo"]);
	});

	it("keeps an offline server's tools offered, and its calls answer an error result", async () => {
		const fake = fakeToolServers();
		fake.put({ id: "ts_1", name: "sal", snapshot: fake.snapshot([ECHO], "sha256:one") });
		const audit = recordingAudit();
		const { service, script } = memoryRuntime({ toolServers: fake.toolServers, audit: audit.sink });
		await service.profiles.put(ctx, profile(["sal/*"]));
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		const server = fake.servers.get("ts_1");
		if (server === undefined) throw new Error("no server");
		server.online = false;

		script.reply({ toolCalls: [{ name: "sal__echo", args: { text: "hi" } }] }, { text: "Offline" });
		expect(await run(service, session.id, "Echo")).toMatchObject({ status: "answered", answer: "Offline" });
		expect(offered(script, 0)).toEqual(["sal__echo"]);
		expect(script.requests[1]?.messages.at(-1)).toEqual({ role: "tool", text: "Tool server sal is offline" });
		expect(audit.events.find((event) => event.type === "session.tool.finished")?.data).toMatchObject({
			outcome: "error",
			toolServerId: "ts_1",
		});
	});

	it("leaves a disabled tool out of a new pin, and keeps one disabled later listed with its call answering an error", async () => {
		const fake = fakeToolServers();
		fake.put({
			id: "ts_1",
			name: "sal",
			snapshot: fake.snapshot([ECHO, OTHER], "sha256:one"),
			disabledTools: ["other"],
		});
		const { service, script } = memoryRuntime({ toolServers: fake.toolServers });
		await service.profiles.put(ctx, profile(["sal/*"]));
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		script.reply({ text: "One" });
		await run(service, session.id, "Hello");
		expect(offered(script, 0)).toEqual(["sal__echo"]);

		fake.put({
			id: "ts_1",
			name: "sal",
			snapshot: fake.snapshot([ECHO, OTHER], "sha256:one"),
			disabledTools: ["echo"],
		});
		await service.toolServerChanged(ORG, "sal");
		script.reply({ toolCalls: [{ name: "sal__echo", args: {} }] }, { text: "Disabled" });
		await run(service, session.id, "Echo");
		expect(offered(script, 1)).toEqual(["sal__echo"]);
		expect(fake.calls.map((each) => each.call.tool)).toEqual(["echo"]);
		expect(script.requests[2]?.messages.at(-1)).toEqual({
			role: "tool",
			text: "Tool echo of tool server sal is disabled",
		});
	});

	it("refuses a profile naming a tool whose model name is over 50 characters", async () => {
		const fake = fakeToolServers();
		const { service } = memoryRuntime({ toolServers: fake.toolServers });
		const long = `sal/${"t".repeat(46)}`;
		await expect(service.profiles.put(ctx, profile([long]))).rejects.toMatchObject({ code: "invalid" });
		await expect(service.profiles.put(ctx, profile([`sal/${"t".repeat(45)}`]))).resolves.toBeDefined();
		// Without tool servers the entry is only a name, and saved as before.
		const plain = memoryRuntime();
		await expect(plain.service.profiles.put(ctx, profile([long]))).resolves.toBeDefined();
	});

	it("offers nothing from a server without the option", async () => {
		const { service, script } = memoryRuntime();
		await service.profiles.put(ctx, profile(["sal/*"]));
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		script.reply({ text: "Plain" });
		await run(service, session.id, "Hello");
		expect(offered(script, 0)).toEqual([]);
		await service.toolServerChanged(ORG, "sal");
	});

	it("keeps a session's pin across a reopen on the SQL store", async () => {
		const db: SqliteDatabase = await openNodeSqliteDatabase(":memory:");
		closers.push(() => db.close());
		const fake = fakeToolServers();
		fake.put({ id: "ts_1", name: "sal", snapshot: fake.snapshot([ECHO], "sha256:one") });
		const open = async () => {
			const { models, script } = createScriptedModel();
			const service = createSessionRuntime({
				store: await createSqlSessionStore(db),
				storage: (session) => sqlPiStorage(db, session.id),
				models,
				toolServers: fake.toolServers,
			});
			return { service, script };
		};

		const first = await open();
		await first.service.profiles.put(ctx, profile(["sal/*"]));
		const session = await first.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		first.script.reply({ text: "One" });
		const prompt = await first.service.runtime.prompt(ctx, session.id, { text: "Hello" });
		await first.service.runtime.wait(ctx, session.id, prompt.id);
		expect(offered(first.script, 0)).toEqual(["sal__echo"]);
		await first.service.close();

		fake.put({ id: "ts_1", name: "sal", snapshot: fake.snapshot([ECHO, ADDED], "sha256:two") });
		const second = await open();
		closers.push(() => second.service.close());
		second.script.reply({ text: "Two" });
		const again = await second.service.runtime.prompt(ctx, session.id, { text: "Again" });
		await second.service.runtime.wait(ctx, session.id, again.id);
		expect(offered(second.script, 0)).toEqual(["sal__echo"]);

		const fresh = await second.service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		second.script.reply({ text: "Three" });
		const third = await second.service.runtime.prompt(ctx, fresh.id, { text: "Hello" });
		await second.service.runtime.wait(ctx, fresh.id, third.id);
		expect(offered(second.script, 1)).toEqual(["sal__echo", "sal__added"]);
	});
});

import {
	type AuditEventInput,
	type AuditSink,
	type ConnectorCredentials,
	HarbourError,
	type ModelConnector,
	type ModelStreamEvent,
	systemContext,
} from "@harbour/contracts";
import { createMemoryModelConnectors } from "@harbour/models/directory";
import {
	createCredentialCache,
	createMemoryModelPinStore,
	createModelGateway,
	type ModelAuditFailure,
	type ModelPinStore,
	sanitiseEvent,
	singleRequestFetch,
} from "@harbour/models/gateway";
import { createModelGatewayHttp } from "@harbour/models/http";
import { Redactor } from "@harbour/models/redact";
import { createHmacSessionTokens } from "@harbour/models/tokens";
import {
	actors,
	assertAccessDenied,
	contextFor,
	createDeps,
	createExpectAssertions,
	ManualClock,
} from "@harbour/testing/harness";
import { createFakeModelUpstream } from "@harbour/testing/models";
import { createMemoryVault } from "@harbour/vault/memory";
import { describe, expect, it, vi } from "vitest";

/**
 * pi's three wire adapters, made to throw synchronously when `adapterThrow.on`, as a stand-in for any failure after the
 * key is read and before the stream starts (the gateway's outer catch).
 */
const adapterThrow = vi.hoisted(() => ({
	on: false,
	message: "",
	wrap<F extends (...args: never[]) => unknown>(original: F): F {
		return ((...args: Parameters<F>) => {
			if (adapterThrow.on) throw new Error(adapterThrow.message);
			return original(...args);
		}) as F;
	},
}));
vi.mock("@earendil-works/pi-ai/api/anthropic-messages", async (load) => {
	const original = await load<typeof import("@earendil-works/pi-ai/api/anthropic-messages")>();
	return { ...original, streamSimple: adapterThrow.wrap(original.streamSimple) };
});
vi.mock("@earendil-works/pi-ai/api/openai-completions", async (load) => {
	const original = await load<typeof import("@earendil-works/pi-ai/api/openai-completions")>();
	return { ...original, streamSimple: adapterThrow.wrap(original.streamSimple) };
});
vi.mock("@earendil-works/pi-ai/api/openai-responses", async (load) => {
	const original = await load<typeof import("@earendil-works/pi-ai/api/openai-responses")>();
	return { ...original, streamSimple: adapterThrow.wrap(original.streamSimple) };
});

const ORG = "org-a";
const PROJECT = "proj-a";
const operator = contextFor(actors.system("operator"), ORG);
const KEY = "sk-gateway-test-7d1f0e2a";
const BASE_URL = "http://cpa.internal:8317/v1";

let sessions = 0;
const scopeFor = () => {
	sessions += 1;
	return { organisationId: ORG, projectId: PROJECT, agentId: "agent-1", sessionId: `sess-${sessions}` };
};

async function setup(
	options: {
		hosts?: readonly string[];
		preset?: "cliproxyapi" | "openrouter";
		pins?: ModelPinStore;
		credentials?: ConnectorCredentials;
		audit?: AuditSink;
		onAuditFailure?: (failure: ModelAuditFailure) => void;
	} = {},
) {
	const deps = createDeps();
	deps.tenancy.bind(actors.human("viewer-a"), ORG, "viewer", PROJECT);
	const upstream = createFakeModelUpstream({ models: [{ id: "claude-sonnet-4-5" }, { id: "gpt-5" }] });
	const vault = createMemoryVault({ clock: deps.clock, audit: deps.audit, access: deps.access });
	const connectors = createMemoryModelConnectors({ clock: deps.clock, audit: deps.audit, access: deps.access });
	const item = await vault.putItem(operator, {
		owner: { kind: "platform" },
		name: "CPA",
		hosts: [...(options.hosts ?? ["cpa.internal"])],
		injection: { header: "Authorization", template: "Bearer {key}" },
		value: KEY,
	});
	await connectors.putConnector(operator, {
		id: "cpa",
		owner: { kind: "platform" },
		preset: options.preset ?? "cliproxyapi",
		baseUrl: BASE_URL,
		vaultItemId: item.id,
		catalogue: { refresh: "static", include: ["claude-sonnet-4-5", "gpt-5"] },
	});
	await connectors.putRoute(operator, {
		name: "default",
		owner: { kind: "platform" },
		connectorId: "cpa",
		modelId: "claude-sonnet-4-5",
		thinking: "low",
	});
	const gateway = createModelGateway({
		connectors,
		credentials: options.credentials ?? vault,
		clock: deps.clock,
		audit: options.audit ?? deps.audit,
		...(options.onAuditFailure === undefined ? {} : { onAuditFailure: options.onAuditFailure }),
		fetch: upstream.fetch,
		baseUrl: "http://gateway.internal",
		access: deps.access,
		...(options.pins === undefined ? {} : { pins: options.pins }),
	});
	return { deps, upstream, vault, connectors, gateway };
}

async function collect(events: AsyncIterable<ModelStreamEvent>): Promise<ModelStreamEvent[]> {
	const out: ModelStreamEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

const request = (model: string, extra: object = {}) => ({
	model,
	context: { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
	...extra,
});

async function code(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error instanceof HarbourError ? error.code : String(error);
	}
}

describe("createModelGateway", () => {
	it("streams events in the pi-messages shape, the route's thinking applying when the call names none", async () => {
		const { gateway, upstream } = await setup();
		const events = await collect(await gateway.messages(scopeFor(), request("default")));
		expect(events[0]).toEqual({ type: "start" });
		expect(events.map((event) => event.type)).toContain("thinking_end");
		const done = events.at(-1);
		expect(done).toMatchObject({ type: "done", reason: "stop", usage: { input: 120, output: 40 } });
		expect(done?.type === "done" && done.usage.cost.total).toBe(0);
		const body = upstream.calls().at(-1)?.body as { thinking?: { budget_tokens?: number } };
		expect(body.thinking?.budget_tokens).toBe(2048);
		await collect(await gateway.messages(scopeFor(), request("default", { options: { reasoning: "off" } })));
		expect((upstream.calls().at(-1)?.body as { thinking?: { type?: string } } | undefined)?.thinking?.type).toBe(
			"disabled",
		);
	});

	it("rejects a malformed request or an unknown route before streaming, recording nothing", async () => {
		const { gateway, deps } = await setup();
		const scope = scopeFor();
		expect(await code(gateway.messages(scope, { model: 3 } as never))).toBe("invalid");
		expect(await code(gateway.messages(scope, request("default", { context: "nope" }) as never))).toBe("invalid");
		expect(await code(gateway.messages(scope, request("default", { options: { reasoning: "huge" } }) as never))).toBe(
			"invalid",
		);
		expect(await code(gateway.messages(scope, request("nope")))).toBe("not_found");
		expect(await code(gateway.messages(scope, request("default:unlisted")))).toBe("not_found");
		expect(deps.audit.ofType("model.call")).toHaveLength(0);
	});

	it("takes a context in pi's shape and refuses anything else as invalid, recording nothing", async () => {
		const { gateway, deps, upstream } = await setup();
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const tool = { name: "lookup", description: "Looks up.", parameters: { type: "object" } };
		const messages = [
			{
				role: "system",
				content: [{ type: "text", text: "Be brief." }],
				sections: { tone: "dry", gone: null },
				toolsAdded: [tool],
				toolsRemoved: [{ name: "old" }],
				timestamp: 1,
			},
			{
				role: "user",
				content: [
					{ type: "text", text: "Look" },
					{ type: "image", data: "aGk=", mimeType: "image/png" },
				],
				timestamp: 2,
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "Hm", thinkingSignature: "sig" },
					{ type: "text", text: "Looking" },
					{ type: "toolCall", id: "call_1", name: "lookup", arguments: { q: "x" } },
				],
				api: "pi-messages",
				provider: "harbour",
				model: "default",
				usage,
				stopReason: "toolUse",
				timestamp: 3,
			},
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "lookup",
				content: [{ type: "text", text: "found" }],
				isError: false,
				timestamp: 4,
			},
		];
		const events = await collect(
			await gateway.messages(scopeFor(), { model: "default", context: { messages, tools: [tool] } as never }),
		);
		expect(events.at(-1)).toMatchObject({ type: "done" });
		const sent = upstream.calls().length;
		const audited = deps.audit.ofType("model.call").length;

		const [system, user, assistant, result] = messages as [object, object, { [key: string]: unknown }, object];
		const malformed: readonly (readonly [string, unknown])[] = [
			["context.systemPrompt", { systemPrompt: 1, messages: [] }],
			["context.tools[0].parameters", { messages: [], tools: [{ name: "t", description: "d" }] }],
			["context.messages[0].sections.a", { messages: [{ ...system, sections: { a: 1 } }] }],
			["context.messages[0].content[0].type", { messages: [{ ...system, content: [{ type: "image" }] }] }],
			["context.messages[0].timestamp", { messages: [{ ...user, timestamp: "now" }] }],
			["context.messages[0].content[0].mimeType", { messages: [{ ...user, content: [{ type: "image", data: "" }] }] }],
			["context.messages[0].content", { messages: [{ ...assistant, content: "Hi" }] }],
			[
				"context.messages[0].content[0].arguments",
				{ messages: [{ ...assistant, content: [{ type: "toolCall", id: "c", name: "t", arguments: "{}" }] }] },
			],
			["context.messages[0].usage.cost", { messages: [{ ...assistant, usage: { ...usage, cost: undefined } }] }],
			["context.messages[0].usage.output", { messages: [{ ...assistant, usage: { ...usage, output: "1" } }] }],
			["context.messages[0].stopReason", { messages: [{ ...assistant, stopReason: "finished" }] }],
			["context.messages[0].provider", { messages: [{ ...assistant, provider: undefined }] }],
			["context.messages[0].timestamp", { messages: [{ ...assistant, timestamp: undefined }] }],
			["context.messages[0].isError", { messages: [{ ...result, isError: "no" }] }],
			["context.messages[0].content", { messages: [{ ...result, content: "found" }] }],
			["context.messages[0].role", { messages: [{ role: "developer", content: "Hi" }] }],
		];
		for (const [field, context] of malformed) {
			const refused = gateway.messages(scopeFor(), { model: "default", context } as never);
			await expect(refused, field).rejects.toThrow(new RegExp(`^${field.replace(/[[\].]/g, "\\$&")} must be`));
			expect(await code(refused)).toBe("invalid");
		}
		expect(upstream.calls()).toHaveLength(sent);
		expect(deps.audit.ofType("model.call")).toHaveLength(audited);
	});

	it("sends tool names under Harbour's MCP namespace on CPA's Messages API, and takes it off the calls that come back", async () => {
		// CPA renames any tool that isn't an MCP tool to a random-word alias (`mcp__<w>_<w>__salon_browser_request`) on a
		// Claude subscription, and the model then calls its tools by those names in what it writes. An MCP name passes.
		const { gateway, upstream } = await setup();
		const usage = {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const declare = (name: string) => ({ name, description: "A tool.", parameters: { type: "object" } });
		const tooLong = `t${"o".repeat(50)}`;
		const tools = [declare("browser_request"), declare("mcp__docs__search"), declare("browser.open"), declare(tooLong)];
		const messages = [
			{ role: "user", content: "Open a browser", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_1", name: "browser_request", arguments: { reason: "Look" } }],
				api: "pi-messages",
				provider: "harbour",
				model: "default",
				usage,
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "browser_request",
				content: [{ type: "text", text: "Allowed" }],
				isError: false,
				timestamp: 3,
			},
		];
		const call = async (name: string, model = "default") => {
			upstream.next({ toolCall: { id: "toolu_2", name, arguments: { url: "https://example.com" } } });
			const events = await collect(
				await gateway.messages(scopeFor(), { model, context: { messages, tools } as never }),
			);
			const start = events.find((event) => event.type === "toolcall_start");
			const end = events.find((event) => event.type === "toolcall_end");
			return {
				body: upstream.calls().at(-1)?.body as { [key: string]: unknown },
				names: [start?.type === "toolcall_start" && start.toolName, end?.type === "toolcall_end" && end.toolCall.name],
			};
		};

		const messagesCall = await call("mcp__harbour__browser_request");
		const sent = messagesCall.body as {
			tools: { name: string }[];
			messages: { role: string; content: string | { type: string; name?: string }[] }[];
		};
		expect(sent.tools.map((tool) => tool.name)).toEqual([
			"mcp__harbour__browser_request",
			"mcp__docs__search",
			"browser.open",
			tooLong,
		]);
		const toolUse = sent.messages
			.flatMap((message) => (typeof message.content === "string" ? [] : message.content))
			.find((block) => block.type === "tool_use");
		expect(toolUse?.name).toBe("mcp__harbour__browser_request");
		// Streamed and final, the call carries the name the session declared.
		expect(messagesCall.names).toEqual(["browser_request", "browser_request"]);
		// A name the request didn't put under the namespace comes back as it is.
		expect((await call("mcp__docs__search")).names).toEqual(["mcp__docs__search", "mcp__docs__search"]);
		expect((await call("browser_request")).names).toEqual(["browser_request", "browser_request"]);
		expect((await call("mcp__harbour__unknown")).names).toEqual(["mcp__harbour__unknown", "mcp__harbour__unknown"]);

		// CPA renames nothing on the OpenAI APIs, so neither does the gateway.
		const responses = (await call("browser_request", "default:gpt-5")).body as { tools: { name: string }[] };
		expect(responses.tools.map((tool) => tool.name)).toContain("browser_request");
	});

	it("turns a refused key read into an error event and records the call", async () => {
		const { gateway, deps, upstream } = await setup({ hosts: ["elsewhere.internal"] });
		const scope = scopeFor();
		const events = await collect(await gateway.messages(scope, request("default")));
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "error", reason: "error" });
		expect(upstream.calls()).toHaveLength(0);
		expect(deps.audit.ofType("model.call")).toHaveLength(1);
		expect(deps.audit.ofType("model.call")[0]?.data).toMatchObject({ status: "error", costSource: "none" });
	});

	it("ends a call that throws once resolved in an error event, recorded as an error, not aborted", async () => {
		// The gateway refuses an empty key from the credential read once the call has resolved (pi would otherwise fall
		// back to host credentials): the throw must still end the stream in an error event, recorded as an error.
		const credentials: ConnectorCredentials = {
			async readConnectorCredential(_ctx, request) {
				return { itemId: request.vaultItemId, valueVersion: 1, value: "", useId: "use-1" };
			},
		};
		const { gateway, deps, upstream } = await setup({ credentials });
		const events = await collect(await gateway.messages(scopeFor(), request("default")));
		expect(events).toEqual([
			expect.objectContaining({ type: "error", reason: "error", errorMessage: expect.stringContaining("is empty") }),
		]);
		expect(upstream.calls()).toHaveLength(0);
		expect(deps.audit.ofType("model.call").map((event) => event.data?.status)).toEqual(["error"]);
	});

	it("refuses a blank key as it does an empty one, before pi could look for credentials of its own", async () => {
		const credentials: ConnectorCredentials = {
			async readConnectorCredential(_ctx, request) {
				return { itemId: request.vaultItemId, valueVersion: 1, value: " \t ", useId: "use-1" };
			},
		};
		const { gateway, upstream } = await setup({ credentials });
		const events = await collect(await gateway.messages(scopeFor(), request("default")));
		expect(events).toEqual([
			expect.objectContaining({ type: "error", reason: "error", errorMessage: expect.stringContaining("is empty") }),
		]);
		expect(upstream.calls()).toHaveLength(0);
	});

	it("ends a call whose wire adapter throws after the key is read in a redacted error event, recorded as an error", async () => {
		const { gateway, deps, upstream } = await setup();
		adapterThrow.message = `adapter exploded holding ${KEY}`;
		adapterThrow.on = true;
		let events: ModelStreamEvent[];
		try {
			events = await collect(await gateway.messages(scopeFor(), request("default")));
		} finally {
			adapterThrow.on = false;
		}
		expect(events).toEqual([
			expect.objectContaining({
				type: "error",
				reason: "error",
				errorMessage: expect.stringContaining("adapter exploded"),
			}),
		]);
		expect(JSON.stringify(events)).not.toContain(KEY);
		expect(upstream.calls()).toHaveLength(0);
		expect(deps.audit.ofType("model.call").map((event) => event.data?.status)).toEqual(["error"]);
	});

	it("keeps the protocol's own property names when the key spells one of them", async () => {
		for (const spelled of ["usage", "delta", "toolCall"]) {
			const credentials: ConnectorCredentials = {
				async readConnectorCredential(_ctx, request) {
					return { itemId: request.vaultItemId, valueVersion: 1, value: spelled, useId: "use-1" };
				},
			};
			const { gateway } = await setup({ credentials });
			const events = await collect(await gateway.messages(scopeFor(), request("default")));
			const done = events.at(-1);
			expect(done?.type).toBe("done");
			expect(done).toHaveProperty("usage.input");
			expect(typeof (done as { usage: { input: unknown } }).usage.input).toBe("number");
			for (const event of events) {
				if (event.type === "text_delta" || event.type === "thinking_delta") expect(event).toHaveProperty("delta");
			}
		}
	});

	it("records a call the consumer stops reading as aborted, and cancels the upstream", async () => {
		const { gateway, deps, upstream } = await setup();
		upstream.next({ text: "slow ".repeat(50), chunks: 50, delayMs: 20 });
		const iterator = (await gateway.messages(scopeFor(), request("default")))[Symbol.asyncIterator]();
		for (let seen = 0; seen < 3; seen += 1) await iterator.next();
		await iterator.return?.();
		expect(deps.audit.ofType("model.call")[0]?.data).toMatchObject({ status: "aborted" });
		expect(upstream.calls()[0]?.aborted).toBe(true);
	});

	it("retries a failed model.call append under one event ID, then marks the call pending and tells the host", async () => {
		/** A sink that fails its first `failures` appends. */
		const failing = (failures: number) => {
			const attempts: string[] = [];
			const stored: AuditEventInput[] = [];
			const sink: AuditSink = {
				async append(_ctx, events) {
					attempts.push(...events.map((event) => event.id));
					if (attempts.length <= failures) throw new Error("outbox unavailable");
					stored.push(...events);
				},
			};
			return { sink, attempts, stored };
		};
		const viewer = contextFor(actors.human("viewer-a"), ORG, PROJECT);

		const flaky = failing(2);
		const told: ModelAuditFailure[] = [];
		const first = await setup({ audit: flaky.sink, onAuditFailure: (failure) => told.push(failure) });
		await collect(await first.gateway.messages(scopeFor(), request("default")));
		expect(flaky.attempts).toHaveLength(3);
		expect(new Set(flaky.attempts).size).toBe(1);
		expect(flaky.stored.map((event) => event.type)).toEqual(["model.call"]);
		expect((await first.gateway.listCalls(viewer, { projectId: PROJECT })).items[0]?.auditPending).toBeUndefined();
		expect(told).toHaveLength(0);

		const down = failing(Number.POSITIVE_INFINITY);
		const second = await setup({ audit: down.sink, onAuditFailure: (failure) => told.push(failure) });
		await collect(await second.gateway.messages(scopeFor(), request("default")));
		expect(down.attempts).toHaveLength(3);
		expect(new Set(down.attempts).size).toBe(1);
		const [listed] = (await second.gateway.listCalls(viewer, { projectId: PROJECT })).items;
		expect(listed?.auditPending).toBe(true);
		expect(told).toHaveLength(1);
		expect(told[0]).toMatchObject({ record: listed, attempts: 3, event: { id: down.attempts[0], type: "model.call" } });
		expect(String(told[0]?.error)).toContain("outbox unavailable");

		// Without a handler the gateway logs one line naming the call, and none of the event's data.
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const third = await setup({ audit: failing(Number.POSITIVE_INFINITY).sink });
			await collect(await third.gateway.messages(scopeFor(), request("default")));
			expect(log).toHaveBeenCalledTimes(1);
			const line = JSON.parse(String(log.mock.calls[0]?.[0]));
			expect(line).toMatchObject({ error: "model.call audit append failed", attempts: 3 });
			expect(line.callId).toBe((await third.gateway.listCalls(viewer, { projectId: PROJECT })).items[0]?.id);
			expect(JSON.stringify(line)).not.toContain("usage");
		} finally {
			log.mockRestore();
		}
	});

	it("scales a reported cost's breakdown to the reported total", async () => {
		const { gateway, upstream } = await setup({ preset: "openrouter" });
		upstream.next({ usage: { input: 1_000_000, output: 0 }, reportedCost: 1.5 });
		const events = await collect(await gateway.messages(scopeFor(), request("default")));
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type !== "done") return;
		expect(done.usage.cost.total).toBe(1.5);
		expect(done.usage.cost.input).toBeCloseTo(1.5);
	});

	it("lists calls newest first for project viewers, never for agents or other organisations", async () => {
		const { gateway, deps } = await setup();
		const first = scopeFor();
		const second = scopeFor();
		await collect(await gateway.messages(first, request("default")));
		await collect(await gateway.messages(second, request("default")));
		const viewer = contextFor(actors.human("viewer-a"), ORG, PROJECT);
		const page = await gateway.listCalls(viewer, { projectId: PROJECT });
		expect(page.items.map((call) => call.scope.sessionId)).toEqual([second.sessionId, first.sessionId]);
		expect(JSON.stringify(page)).not.toContain(KEY);
		const other = await gateway.listCalls(contextFor(actors.system("ops"), "org-b"));
		expect(other.items).toHaveLength(0);
		await assertAccessDenied(
			createExpectAssertions(expect),
			deps,
			Promise.resolve().then(() =>
				gateway.listCalls(contextFor(actors.agent("agent-1", first.sessionId), ORG, PROJECT), { projectId: PROJECT }),
			),
			{ operation: "models.listCalls" },
		);
	});

	it("sends one upstream request per call, answering a retry with the first failure", async () => {
		let sent = 0;
		const failing = singleRequestFetch(async () => {
			sent += 1;
			return new Response("too large", { status: 400 });
		});
		expect(await (await failing("http://up/v1/messages")).text()).toBe("too large");
		const retry = await failing("http://up/v1/messages");
		expect([retry.status, await retry.text(), sent]).toEqual([400, "too large", 1]);
		const seen: number[] = [];
		const working = singleRequestFetch(
			async () => new Response("ok"),
			(response) => seen.push(response.status),
		);
		await working("http://up/v1/messages");
		await expect(working("http://up/v1/messages")).rejects.toThrow("one upstream request per call");
		expect(seen).toEqual([200]);
	});

	it("keeps the first pin when two calls of a session race", async () => {
		const pins = createMemoryModelPinStore();
		const first = await pins.pin("s", "default", { connectorId: "a", modelId: "m1", pinnedAt: 1 });
		const second = await pins.pin("s", "default", { connectorId: "b", modelId: "m2", pinnedAt: 2 });
		expect(second).toEqual(first);
		expect(await pins.get("s", "default:x")).toBeUndefined();
		await pins.pin("s", "default:x", { connectorId: "a", modelId: "x", pinnedAt: 3 });
		await pins.pin("t", "default", { connectorId: "a", modelId: "m1", pinnedAt: 4 });
		expect([...(await pins.list("s")).keys()]).toEqual(["default", "default:x"]);
	});

	it("serves a pin only while its connector serves the session's organisation", async () => {
		const pins = createMemoryModelPinStore();
		const { gateway, vault, connectors, upstream } = await setup({ pins });
		const otherOrg = contextFor(actors.system("operator"), "org-b");
		const item = await vault.putItem(otherOrg, {
			owner: { kind: "organisation", organisationId: "org-b" },
			name: "B's CPA",
			hosts: ["cpa.internal"],
			injection: { header: "Authorization", template: "Bearer {key}" },
			value: "sk-org-b-0a9c",
		});
		await connectors.putConnector(otherOrg, {
			id: "cpa-b",
			owner: { kind: "organisation", organisationId: "org-b" },
			preset: "cliproxyapi",
			baseUrl: BASE_URL,
			vaultItemId: item.id,
			catalogue: { refresh: "static", include: ["gpt-5"] },
		});
		const scope = scopeFor();
		// A pin to another organisation's connector, as a stale or tampered pin store might hold.
		await pins.pin(scope.sessionId, "default", { connectorId: "cpa-b", modelId: "gpt-5", pinnedAt: 1 });
		expect(await code(gateway.messages(scope, request("default")))).toBe("not_found");
		expect(upstream.calls()).toHaveLength(0);
		expect((await gateway.config(scope)).models.map((model) => model.id)).toEqual(["default:gpt-5"]);
	});
});

describe("createCredentialCache", () => {
	const connector = (id: string, updatedAt = 1): ModelConnector => ({
		id,
		owner: { kind: "platform" },
		preset: "cliproxyapi",
		baseUrl: BASE_URL,
		vaultItemId: `item-${id}`,
		catalogue: { refresh: "static" },
		createdAt: 1,
		updatedAt,
	});

	function setup() {
		const clock = new ManualClock();
		const reads: string[] = [];
		let valueVersion = 1;
		const credentials: ConnectorCredentials = {
			async readConnectorCredential(_ctx, request) {
				reads.push(request.connectorId);
				return {
					itemId: request.vaultItemId,
					valueVersion,
					value: `sk-${request.connectorId}-v${valueVersion}`,
					useId: `use-${reads.length}`,
				};
			},
		};
		const cache = createCredentialCache(credentials, clock, 1000);
		return { clock, reads, cache, rotate: () => (valueVersion += 1) };
	}

	it("rereads at the TTL, and drops each expired key on any access rather than holding it until the next read", async () => {
		const { clock, reads, cache } = setup();
		const scope = scopeFor();
		expect(await cache.key(connector("a"), scope)).toBe("sk-a-v1");
		clock.advance(999);
		await cache.key(connector("a"), scope);
		expect(reads).toEqual(["a"]);
		clock.advance(1);
		await cache.key(connector("a"), scope);
		expect(reads).toEqual(["a", "a"]);
		clock.advance(1000);
		await cache.key(connector("b"), scope);
		expect(cache.entries).toBe(1);
		clock.advance(1000);
		expect(cache.entries).toBe(0);
	});

	it("returns the key uncached when no timer can be set, rather than caching it with no expiry", async () => {
		const credentials: ConnectorCredentials = {
			async readConnectorCredential(_ctx, request) {
				return { itemId: request.vaultItemId, valueVersion: 1, value: "sk-no-timers", useId: "use-1" };
			},
		};
		const cache = createCredentialCache(credentials, new ManualClock(), 1000);
		const timers = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => {
			throw new Error("Timers are not allowed outside a request");
		});
		try {
			expect(await cache.key(connector("a"), scopeFor())).toBe("sk-no-timers");
		} finally {
			timers.mockRestore();
		}
		expect(cache.entries).toBe(0);
	});

	it("drops a key at its TTL even when the cache is never touched again", async () => {
		const reads: string[] = [];
		const credentials: ConnectorCredentials = {
			async readConnectorCredential(_ctx, request) {
				reads.push(request.connectorId);
				return { itemId: request.vaultItemId, valueVersion: 1, value: "sk-idle", useId: "use-1" };
			},
		};
		// The injected clock never moves, so only the real-time expiry can drop the entry.
		const cache = createCredentialCache(credentials, new ManualClock(), 30);
		await cache.key(connector("a"), scopeFor());
		expect(cache.entries).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect(cache.entries).toBe(0);
	});

	it("replaces a key whose value rotated, and drops the key of a connector since edited", async () => {
		const { clock, reads, cache, rotate } = setup();
		const scope = scopeFor();
		await cache.key(connector("a"), scope);
		rotate();
		clock.advance(1000);
		expect(await cache.key(connector("a"), scope)).toBe("sk-a-v2");
		expect(await cache.key(connector("a"), scope)).toBe("sk-a-v2");
		expect(await cache.key(connector("a", 2), scope)).toBe("sk-a-v2");
		expect(reads).toEqual(["a", "a", "a"]);
		expect(cache.entries).toBe(1);
		cache.drop(connector("a", 2));
		expect(cache.entries).toBe(0);
	});
});

describe("sanitiseEvent", () => {
	const redactor = new Redactor([KEY]);
	const usage = {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 3,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	/** What an upstream could put where the schema says string or number: pi passes it on unchecked. */
	const smuggled = { [KEY]: KEY, nested: { [KEY]: [KEY] } };

	it("rebuilds every event from the schema, so no upstream-chosen name or wrongly typed value carries the key", () => {
		const malformed = [
			{
				type: "done",
				reason: "stop",
				usage: { ...usage, [KEY]: 1, cost: { ...usage.cost, [KEY]: 2 } },
				responseId: smuggled,
			},
			{
				type: "error",
				reason: "error",
				usage,
				errorMessage: smuggled,
				responseId: smuggled,
				providerThinkingLevel: smuggled,
			},
			{ type: "text_end", contentIndex: 0, content: smuggled, contentSignature: smuggled },
			{ type: "thinking_end", contentIndex: smuggled, content: KEY, contentSignature: smuggled, redacted: smuggled },
			{ type: "toolcall_start", contentIndex: 0, id: smuggled, toolName: smuggled },
			{ type: "text_delta", contentIndex: 0, delta: smuggled },
			{
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: {
					type: smuggled,
					id: smuggled,
					name: KEY,
					arguments: { [KEY]: { [KEY]: KEY } },
					namespace: smuggled,
					thoughtSignature: smuggled,
					argumentsError: smuggled,
					[KEY]: KEY,
				},
				[KEY]: KEY,
			},
		] as unknown as ModelStreamEvent[];
		for (const event of malformed) {
			const out = sanitiseEvent(event, redactor);
			expect(JSON.stringify(out)).not.toContain(KEY);
			expect(out.type).toBe(event.type);
		}
		expect(sanitiseEvent(malformed[0]!, redactor)).toEqual({ type: "done", reason: "stop", usage });
		expect(sanitiseEvent(malformed[3]!, redactor)).toMatchObject({ contentIndex: 0, content: "[harbour:redacted]" });
	});

	it("keeps well-formed events as they are, apart from redaction", () => {
		const events = [
			{ type: "start" },
			{ type: "thinking_end", contentIndex: 1, content: "why", contentSignature: "sig", redacted: true },
			{
				type: "toolcall_end",
				contentIndex: 2,
				toolCall: { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/a" }, namespace: "fs" },
			},
			{ type: "done", reason: "toolUse", usage: { ...usage, reasoning: 1 }, responseId: "resp-1" },
		] as ModelStreamEvent[];
		for (const event of events) expect(sanitiseEvent(event, redactor)).toEqual(event);
	});
});

describe("createModelGatewayHttp", () => {
	async function http() {
		const context = await setup();
		const tokens = createHmacSessionTokens({ key: "http-test-token-key-0123456789abcdef", clock: context.deps.clock });
		const handler = createModelGatewayHttp({ gateway: context.gateway, tokens, basePath: "/models" });
		const token = (await tokens.mint(systemContext("session-runtime"), scopeFor())).token;
		return { ...context, handler, token };
	}

	it("routes only its two paths and methods", async () => {
		const { handler, token } = await http();
		const auth = { authorization: `Bearer ${token}` };
		expect((await handler(new Request("http://g/v1/config", { headers: auth }))).status).toBe(404);
		expect((await handler(new Request("http://g/models/v1/config", { method: "POST", headers: auth }))).status).toBe(
			405,
		);
		expect((await handler(new Request("http://g/models/messages", { headers: auth }))).status).toBe(405);
		const config = await handler(new Request("http://g/models/v1/config", { headers: auth }));
		expect(config.status).toBe(200);
		expect(config.headers.get("cache-control")).toBe("no-store");
		const body = (await config.json()) as { baseUrl: string; models: { id: string }[] };
		expect(body.baseUrl).toBe("http://gateway.internal");
		expect(body.models.map((model) => model.id)).toEqual(["default", "default:gpt-5"]);
	});

	it("answers 401 without a valid bearer, and 400 for a body that isn't JSON", async () => {
		const { handler, token } = await http();
		const missing = await handler(new Request("http://g/models/v1/config"));
		expect(missing.status).toBe(401);
		expect(missing.headers.get("www-authenticate")).toContain("Bearer");
		expect(await missing.json()).toEqual({
			error: { code: "unauthenticated", message: "This call needs a model session token" },
		});
		const bad = await handler(
			new Request("http://g/models/messages", {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
				body: "{nope",
			}),
		);
		expect(bad.status).toBe(400);
		expect(bad.statusText).toBe("Bad Request");
		const unknown = await handler(
			new Request("http://g/models/messages", {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
				body: JSON.stringify(request("nope")),
			}),
		);
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toMatchObject({ error: { code: "not_found" } });
	});

	it("streams SSE data lines, and cancelling the body cancels the upstream", async () => {
		const { handler, token, upstream, deps } = await http();
		const post = () =>
			handler(
				new Request("http://g/models/messages", {
					method: "POST",
					headers: { authorization: `Bearer ${token}` },
					body: JSON.stringify(request("default")),
				}),
			);
		const response = await post();
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const text = await response.text();
		const frames = text.split("\n\n").filter((frame) => frame.length > 0);
		expect(frames.every((frame) => frame.startsWith("data: "))).toBe(true);
		expect(JSON.parse(frames.at(-1)!.slice(6))).toMatchObject({ type: "done" });

		upstream.next({ text: "slow ".repeat(50), chunks: 50, delayMs: 20 });
		const slow = await post();
		const reader = slow.body!.getReader();
		await reader.read();
		await reader.read();
		await reader.cancel();
		const last = upstream.calls().at(-1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(last?.aborted).toBe(true);
		expect(deps.audit.ofType("model.call").at(-1)?.data).toMatchObject({ status: "aborted" });
	});
});

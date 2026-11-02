// The `kantel` model provider against a toy model gateway: a fetch handler serving `GET /v1/config` and an SSE
// `POST /messages` per the contract, with a fake `ModelSessionTokens` whose tokens name their session's scope.
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import {
	type AgentProfile,
	type HostToolCall,
	type JsonValue,
	KantelError,
	type ModelCallScope,
	type ModelGatewayConfig,
	type ModelMessagesRequest,
	type ModelSessionTokens,
	type ModelStreamEvent,
	type ModelUsage,
} from "@kantel/contracts";
import { createSessionRuntime } from "@kantel/runtime/core";
import { createMemoryRuntime, type MemoryRuntime } from "@kantel/runtime/memory";
import { kantelModels, kantelResolveModel } from "@kantel/runtime/models";
import { createMemorySessionStore } from "@kantel/runtime/store";
import { createScriptedModel } from "@kantel/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-models";
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;
const GATEWAY_URL = "http://model-gateway.test/";
const TTL_MS = 10 * 60_000;

const ZERO_USAGE: ModelUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const profile = (id: string, model: AgentProfile["model"], extra: Partial<AgentProfile> = {}): AgentProfile => ({
	id,
	organisationId: ORG,
	name: id,
	model,
	promptLayers: [{ name: "role", text: "You help." }],
	tools: [],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
	...extra,
});

/** Session tokens that name their scope; each mint is recorded. */
function fakeTokens(now: () => number) {
	const issued = new Map<string, { readonly scope: ModelCallScope; readonly expiresAt: number }>();
	const mints: { readonly scope: ModelCallScope; readonly ttlMs: number | undefined; readonly token: string }[] = [];
	const tokens: ModelSessionTokens = {
		async mint(context, scope, ttlMs) {
			expect(context.actor).toEqual({ kind: "system", component: "session" });
			const token = `token-${mints.length + 1}`;
			const expiresAt = now() + (ttlMs ?? 60_000);
			issued.set(token, { scope, expiresAt });
			mints.push({ scope, ttlMs, token });
			return { token, expiresAt };
		},
		async verify(_context, token) {
			const entry = issued.get(token);
			if (entry === undefined) throw new KantelError("forbidden", "Unknown token");
			if (now() >= entry.expiresAt) throw new KantelError("expired", "Expired token");
			return entry.scope;
		},
	};
	return { tokens, mints };
}

interface SeenMessages {
	readonly token: string;
	readonly scope: ModelCallScope;
	readonly body: ModelMessagesRequest;
}

type Reply = (request: SeenMessages) => readonly ModelStreamEvent[];

const textReply =
	(text: string): Reply =>
	() => [
		{ type: "start" },
		{ type: "text_start", contentIndex: 0 },
		{ type: "text_delta", contentIndex: 0, delta: text },
		{ type: "text_end", contentIndex: 0, content: text },
		{ type: "done", reason: "stop", usage: ZERO_USAGE },
	];

const gatewayModel = (id: string): ModelGatewayConfig["models"][number] => ({
	id,
	name: id,
	reasoning: true,
	input: ["text"],
	output: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

/**
 * A toy model gateway as a fetch handler. It takes the caller's scope from the bearer only, lists the routes `default`
 * and `deep` and the override `default:claude-x`, and answers each `messages` call with the next queued reply.
 */
function toyGateway(tokens: ModelSessionTokens) {
	const configs: { readonly token: string; readonly scope: ModelCallScope }[] = [];
	const messages: SeenMessages[] = [];
	const replies: Reply[] = [];
	const verify = async (request: Request) => {
		const token = /^Bearer (.+)$/u.exec(request.headers.get("authorization") ?? "")?.[1];
		if (token === undefined) return undefined;
		try {
			return { token, scope: await tokens.verify({ actor: { kind: "system", component: "model-gateway" } }, token) };
		} catch {
			return undefined;
		}
	};
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		const caller = await verify(request);
		if (caller === undefined) return new Response("Unauthorised", { status: 401 });
		const path = new URL(request.url).pathname;
		if (request.method === "GET" && path === "/v1/config") {
			configs.push(caller);
			const config: ModelGatewayConfig = {
				baseUrl: `${GATEWAY_URL}`,
				models: [gatewayModel("default"), gatewayModel("default:claude-x"), gatewayModel("deep")],
			};
			return Response.json(config);
		}
		if (request.method === "POST" && path === "/messages") {
			const seen = { ...caller, body: (await request.json()) as ModelMessagesRequest };
			messages.push(seen);
			const events = (replies.shift() ?? textReply("(no reply)"))(seen);
			const encoder = new TextEncoder();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
					controller.close();
				},
			});
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		}
		return new Response("Not found", { status: 404 });
	};
	return {
		fetch,
		configs,
		messages,
		reply(...next: Reply[]) {
			replies.push(...next);
		},
	};
}

const runtimes: MemoryRuntime[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close();
});

function setUp() {
	let offset = 0;
	const clock = { now: () => Date.now() + offset };
	const { tokens, mints } = fakeTokens(clock.now);
	const gateway = toyGateway(tokens);
	const service = createMemoryRuntime({
		models: kantelModels({ gateway: { baseUrl: GATEWAY_URL, fetch: gateway.fetch }, tokens, ttlMs: TTL_MS, clock }),
		resolveModel: kantelResolveModel,
	});
	runtimes.push(service);
	const ask = async (sessionId: string, text: string) => {
		const submission = await service.runtime.prompt(ctx, sessionId, { text });
		return service.runtime.wait(ctx, sessionId, submission.id);
	};
	return {
		service,
		gateway,
		tokens,
		mints,
		ask,
		advance(ms: number) {
			offset += ms;
		},
	};
}

describe("kantelResolveModel", () => {
	it("names the route, or route:modelId when a model is chosen, on the kantel provider", () => {
		expect(kantelResolveModel({ route: "default" })).toEqual({ provider: "kantel", modelId: "default" });
		expect(kantelResolveModel({ route: "default", modelId: "claude-x", thinking: "high" })).toEqual({
			provider: "kantel",
			modelId: "default:claude-x",
		});
	});
});

describe("kantel model provider", () => {
	it("runs a prompt end to end through the gateway with the route as the model", async () => {
		const { service, gateway, ask } = setUp();
		await service.profiles.put(ctx, profile("worker", { route: "default" }));
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		gateway.reply(textReply("Hello from the gateway"));
		expect(await ask(session.id, "Hi")).toMatchObject({ status: "answered", answer: "Hello from the gateway" });
		expect(gateway.messages).toHaveLength(1);
		expect(gateway.messages[0]?.body.model).toBe("default");
		const snapshot = await service.runtime.snapshot(ctx, session.id);
		expect(snapshot.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
	});

	it("sends route:modelId when the profile chooses a model, and its thinking as reasoning", async () => {
		const { service, gateway, ask } = setUp();
		await service.profiles.put(ctx, profile("pinned", { route: "default", modelId: "claude-x", thinking: "high" }));
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "pinned" });
		gateway.reply(textReply("Thought about it"));
		expect(await ask(session.id, "Think")).toMatchObject({ answer: "Thought about it" });
		expect(gateway.messages[0]?.body.model).toBe("default:claude-x");
		expect(gateway.messages[0]?.body.options?.reasoning).toBe("high");
	});

	it("calls the gateway with each session's own token, scoped to its organisation, project, agent and session", async () => {
		const { service, gateway, mints, ask } = setUp();
		await service.profiles.put(ctx, profile("worker", { route: "default" }));
		await service.profiles.put(ctx, profile("researcher", { route: "deep" }));
		const first = await service.runtime.create(ctx, { projectId: "proj-a", agentId: "worker" });
		const second = await service.runtime.create(ctx, { projectId: "proj-b", agentId: "researcher" });
		await ask(first.id, "One");
		await ask(second.id, "Two");
		const scopeOf = (session: typeof first) => ({
			organisationId: ORG,
			projectId: session.projectId,
			agentId: session.agentId,
			sessionId: session.id,
		});
		expect(mints.map((mint) => mint.scope)).toEqual([scopeOf(first), scopeOf(second)]);
		expect(mints.every((mint) => mint.ttlMs === TTL_MS)).toBe(true);
		// The catalogue and each call go out with the session's own bearer.
		expect(gateway.configs.map((call) => call.scope)).toEqual([scopeOf(first), scopeOf(second)]);
		expect(gateway.messages.map((call) => [call.token, call.scope, call.body.model])).toEqual([
			[mints[0]?.token, scopeOf(first), "default"],
			[mints[1]?.token, scopeOf(second), "deep"],
		]);
	});

	it("mints the session's token again once it nears expiry, and not before", async () => {
		const { service, gateway, mints, ask, advance } = setUp();
		await service.profiles.put(ctx, profile("worker", { route: "default" }));
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		await ask(session.id, "One");
		advance(TTL_MS / 4);
		await ask(session.id, "Two");
		expect(mints).toHaveLength(1);
		advance(TTL_MS / 2);
		await ask(session.id, "Three");
		expect(mints).toHaveLength(2);
		expect(gateway.messages.map((call) => call.token)).toEqual(["token-1", "token-1", "token-2"]);
	});

	it("streams a tool call through to a host tool, and its result back to the gateway", async () => {
		const { service, gateway, ask } = setUp();
		const calls: HostToolCall[] = [];
		await service.hostTools.register(
			ctx,
			"atlas",
			[{ name: "lookup", description: "Looks up", inputSchema: { type: "object" }, replay: "safe" }],
			async (call) => {
				calls.push(call);
				return { output: "forty-two" };
			},
		);
		await service.profiles.put(ctx, profile("worker", { route: "default" }, { tools: ["lookup"], hostId: "atlas" }));
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		const args = { query: "the answer" };
		gateway.reply(
			() => [
				{ type: "start" },
				{ type: "toolcall_start", contentIndex: 0, id: "call-1", toolName: "lookup" },
				{ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args).slice(0, 8) },
				{ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args).slice(8) },
				{
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: { type: "toolCall", id: "call-1", name: "lookup", arguments: args },
				},
				{ type: "done", reason: "toolUse", usage: ZERO_USAGE },
			],
			textReply("It is forty-two"),
		);
		expect(await ask(session.id, "Look it up")).toMatchObject({ answer: "It is forty-two" });
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ tool: "lookup", args, sessionId: session.id });
		// The tool is offered to the gateway (pi's transcript adds tools on system messages), and its result reaches it on
		// the next call.
		type Transcript = { messages: { role: string; content: JsonValue; toolsAdded?: { name: string }[] }[] };
		const transcriptOf = (index: number) => (gateway.messages[index]?.body.context ?? { messages: [] }) as Transcript;
		const offered = transcriptOf(0).messages.flatMap((message) => message.toolsAdded ?? []);
		expect(offered.map((tool) => tool.name)).toContain("lookup");
		const toolResult = transcriptOf(1).messages.find((message) => message.role === "toolResult");
		expect(JSON.stringify(toolResult?.content)).toContain("forty-two");
	});

	it("surfaces an upstream 429 as a retryable error, which Pi Durable retries on the same route", async () => {
		const { service, gateway, tokens, ask } = setUp();
		await service.profiles.put(ctx, profile("worker", { route: "default" }));
		const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
		const tooMany: Reply = () => [
			{ type: "start" },
			{ type: "error", reason: "error", usage: ZERO_USAGE, errorMessage: "429 Too Many Requests: slow down" },
		];

		// Straight through the session's models: the error message is the gateway's, and it counts as retryable.
		const models = await kantelModels({
			gateway: { baseUrl: GATEWAY_URL, fetch: gateway.fetch },
			tokens,
		})(session);
		gateway.reply(tooMany);
		const model = models.getModel("kantel", "default");
		if (model === undefined) throw new Error("The gateway's config lists the route");
		const failed = await models.completeSimple(model, { messages: [] });
		expect(failed).toMatchObject({ stopReason: "error", errorMessage: "429 Too Many Requests: slow down" });
		expect(isRetryableAssistantError(failed)).toBe(true);

		// Through the runtime: Pi Durable backs off and asks the same route again.
		gateway.reply(tooMany, textReply("Answered on retry"));
		expect(await ask(session.id, "Hi")).toMatchObject({ status: "answered", answer: "Answered on retry" });
		expect(gateway.messages.slice(1).map((call) => call.body.model)).toEqual(["default", "default"]);
		// Pi Durable's first backoff is 2 s of real time: room for it on a loaded host.
	}, 30_000);

	it("shares one mint between concurrent requests, mints again after a failed mint, and renews by the issued expiry", async () => {
		let now = 1_000_000;
		const clock = { now: () => now };
		const inner = fakeTokens(clock.now);
		const gateway = toyGateway(inner.tokens);
		let gate: Promise<void> | undefined;
		let failNext = false;
		const tokens: Pick<ModelSessionTokens, "mint"> = {
			async mint(context, scope, ttlMs) {
				await gate;
				if (failNext) {
					failNext = false;
					throw new KantelError("unavailable", "Issuer down");
				}
				// The issuer caps the lifetime at a minute, whatever is asked for.
				const minted = await inner.tokens.mint(context, scope, Math.min(ttlMs ?? 60_000, 60_000));
				return minted;
			},
		};
		const session = {
			id: "00000000-0000-4000-8000-0000000000aa",
			organisationId: ORG,
			projectId: "proj",
			agentId: "worker",
			status: "idle" as const,
			labels: {},
			createdBy: ctx.actor,
			createdAt: now,
			updatedAt: now,
		};
		const models = await kantelModels({
			gateway: { baseUrl: GATEWAY_URL, fetch: gateway.fetch },
			tokens,
			ttlMs: TTL_MS,
			clock,
		})(session);
		expect(inner.mints).toHaveLength(1);

		// Renewal follows the minute issued, not the ten asked for: half of it later, a new token.
		now += 31_000;
		let release = () => {};
		gate = new Promise((resolve) => {
			release = resolve;
		});
		const model = models.getModel("kantel", "default");
		if (model === undefined) throw new Error("The gateway's config lists the route");
		gateway.reply(textReply("one"), textReply("two"));
		const both = Promise.all([
			models.completeSimple(model, { messages: [] }),
			models.completeSimple(model, { messages: [] }),
		]);
		release();
		gate = undefined;
		await both;
		expect(inner.mints).toHaveLength(2);
		expect(gateway.messages.map((call) => call.token)).toEqual(["token-2", "token-2"]);

		// A failed mint fails that request only; the next one mints again.
		now += 31_000;
		failNext = true;
		const failed = await models.refresh({ providers: ["kantel"] });
		expect(failed.errors.get("kantel")?.message).toMatch(/Issuer down/);
		const retried = await models.refresh({ providers: ["kantel"] });
		expect(retried.errors.size).toBe(0);
		expect(inner.mints).toHaveLength(3);
		expect(gateway.configs.at(-1)?.token).toBe("token-3");
	});

	it("fails a session's opening as unavailable when the gateway's config can't be loaded", async () => {
		const service = createMemoryRuntime({
			models: kantelModels({
				gateway: { baseUrl: GATEWAY_URL, fetch: async () => new Response("down", { status: 503 }) },
				tokens: fakeTokens(Date.now).tokens,
			}),
			resolveModel: kantelResolveModel,
		});
		runtimes.push(service);
		await service.profiles.put(ctx, profile("worker", { route: "default" }));
		await expect(service.runtime.create(ctx, { projectId: "proj", agentId: "worker" })).rejects.toMatchObject({
			code: "unavailable",
		});
	});

	it("needs resolveModel with per-session models, and keeps a shared Models as before", () => {
		const { models } = createScriptedModel();
		const options = { store: createMemorySessionStore(), storage: () => new Promise<never>(() => {}) };
		expect(() => createSessionRuntime({ ...options, models: () => models })).toThrow(/resolveModel/);
		expect(() => createSessionRuntime({ ...options, models })).not.toThrow();
	});
});

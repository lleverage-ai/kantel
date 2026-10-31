// The models a session may name (`SessionModels`) and a prompt's `model` and `thinking`: what the pickers list, that a
// choice reaches the model call and stays with the session, clamping to what a model supports, and the refusals.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { type Authentication, type CallContext, KANTEL_MODEL_PROVIDER, KantelError } from "@kantel/contracts";
import { createSessionRuntime } from "@kantel/runtime/core";
import { bearer, createSessionApi, createSessionApiClient, staticTokenAuthenticator } from "@kantel/runtime/http";
import { createMemoryRuntime } from "@kantel/runtime/memory";
import { createSqlSessionStore, sqlPiStorage } from "@kantel/runtime/sql";
import { afterEach, describe, expect, it } from "vitest";
import { providerOf } from "../src/session-models.ts";

const operator: CallContext = {
	actor: { kind: "service", serviceId: "supervisor" },
	organisationId: "org-1",
	projectId: "proj-1",
};

type Call = { model: string; reasoning: unknown };

/** The gateway's catalogue as the runtime sees it: three routes on Kantel's provider, one that can't think. */
function gatewayModels() {
	const core = createFauxCore({
		provider: KANTEL_MODEL_PROVIDER,
		models: [
			{ id: "default", name: "Claude Sonnet 5.5", reasoning: true, input: ["text", "image"] },
			{ id: "default:gpt-5", name: "GPT-5", reasoning: true, input: ["text", "image"] },
			{ id: "default:grok-code-fast", name: "Grok Code Fast", reasoning: false, input: ["text"] },
		],
	});
	const levels: Record<string, Model<Api>["thinkingLevelMap"]> = {
		default: { minimal: null, max: "max" },
		"default:gpt-5": { off: null, xhigh: "xhigh" },
	};
	const catalogue = core.models.map((model) => ({ ...model, thinkingLevelMap: levels[model.id] }));
	const calls: Call[] = [];
	const answer = () => {
		core.appendResponses([() => fauxAssistantMessage(fauxText("ok"))]);
	};
	const provider = createProvider({
		id: core.provider,
		auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
		models: catalogue,
		api: {
			stream: (model, context, options) => {
				calls.push({ model: model.id, reasoning: (options as { reasoning?: unknown } | undefined)?.reasoning });
				answer();
				return core.stream(model, context, options);
			},
			streamSimple: (model, context, options) => {
				calls.push({ model: model.id, reasoning: options?.reasoning });
				answer();
				return core.streamSimple(model, context, options);
			},
		},
	});
	const models = createModels();
	models.setProvider(provider);
	return { models, calls };
}

const runtimes: { close(): Promise<void> }[] = [];
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close();
});

async function setup(projectId?: string) {
	const { models, calls } = gatewayModels();
	const memory = createMemoryRuntime({
		models,
		resolveModel: (choice) => ({
			provider: KANTEL_MODEL_PROVIDER,
			modelId: choice.modelId === undefined ? choice.route : `${choice.route}:${choice.modelId}`,
		}),
	});
	runtimes.push(memory);
	await memory.profiles.put(operator, {
		id: "agent-1",
		organisationId: "org-1",
		...(projectId === undefined ? {} : { projectId }),
		name: "Worker",
		model: { route: "default", thinking: "medium" },
		promptLayers: [],
		tools: [],
		skills: [],
		sandbox: { tiers: ["isolate"] },
		memoryScopes: [],
	});
	const session = await memory.runtime.create(operator, { projectId: "proj-1", agentId: "agent-1" });
	const run = async (via: "prompt" | "followUp", input: Parameters<typeof memory.runtime.prompt>[2]) => {
		const submission = await memory.runtime[via](operator, session.id, input);
		await memory.runtime.wait(operator, session.id, submission.id);
	};
	return { memory, session, calls, run };
}

const code = async (operation: Promise<unknown>) => {
	try {
		await operation;
	} catch (error) {
		return error instanceof KantelError ? error.code : String(error);
	}
	return "resolved";
};

describe("SessionModels", () => {
	it("lists the session's models with their provider, capabilities and the profile's default", async () => {
		const { memory, session } = await setup();
		const state = await memory.models.modelState(operator, session.id);
		expect(state.models).toEqual([
			{
				id: "default",
				label: "Claude Sonnet 5.5",
				provider: "Anthropic",
				capabilities: { images: true, thinking: ["off", "low", "medium", "high", "max"] },
				default: true,
			},
			{
				id: "default:gpt-5",
				label: "GPT-5",
				provider: "OpenAI",
				capabilities: { images: true, thinking: ["minimal", "low", "medium", "high", "xhigh"] },
			},
			{ id: "default:grok-code-fast", label: "Grok Code Fast", provider: "xAI", capabilities: { images: false } },
		]);
		expect(state.selected).toEqual({ model: "default", thinking: "medium" });
		expect(state.defaults).toEqual({ model: "default", thinking: "medium" });
		expect(await memory.models.listModels(operator, session.id)).toEqual(state.models);
	});

	it("lists what a new session would get before it exists", async () => {
		const { memory } = await setup("proj-1");
		const state = await memory.models.startModels(operator, { projectId: "proj-1", agentId: "agent-1" });
		expect(state.models.map((option) => option.id)).toEqual(["default", "default:gpt-5", "default:grok-code-fast"]);
		expect(state.selected).toEqual({ model: "default", thinking: "medium" });
		expect(await code(memory.models.startModels(operator, { projectId: "proj-2", agentId: "agent-1" }))).toBe(
			"invalid",
		);
		expect(await code(memory.models.startModels(operator, { projectId: "proj-1", agentId: "nobody" }))).toBe(
			"not_found",
		);
	});

	it("hides another organisation's session", async () => {
		const { memory, session } = await setup();
		const stranger: CallContext = { ...operator, organisationId: "org-2" };
		expect(await code(memory.models.modelState(stranger, session.id))).toBe("not_found");
	});
});

describe("a prompt's model and thinking level", () => {
	it("runs with the profile's model and level until the first prompt names others, then keeps them", async () => {
		const { memory, session, calls, run } = await setup();
		await run("prompt", { text: "first", model: "default:gpt-5", thinking: "high" });
		await run("followUp", { text: "second" });
		expect(calls).toEqual([
			{ model: "default:gpt-5", reasoning: "high" },
			{ model: "default:gpt-5", reasoning: "high" },
		]);
		expect((await memory.models.modelState(operator, session.id)).selected).toEqual({
			model: "default:gpt-5",
			thinking: "high",
		});
	});

	it("clamps a level the model lacks, and sends none to a model that can't think", async () => {
		const clamped = await setup();
		await clamped.run("prompt", { text: "a", thinking: "xhigh" });
		await clamped.run("prompt", { text: "b", thinking: "minimal" });
		expect(clamped.calls.map((call) => call.reasoning)).toEqual(["max", "low"]);

		const gpt = await setup();
		await gpt.run("prompt", { text: "a", model: "default:gpt-5", thinking: "off" });
		expect(gpt.calls.map((call) => call.reasoning)).toEqual(["minimal"]);

		const blind = await setup();
		await blind.run("prompt", { text: "a", model: "default:grok-code-fast", thinking: "high" });
		expect(blind.calls).toEqual([{ model: "default:grok-code-fast", reasoning: undefined }]);
		expect((await blind.memory.models.modelState(operator, blind.session.id)).selected).toEqual({
			model: "default:grok-code-fast",
		});
	});

	it("refuses a model the session can't use and an unknown level, and runs nothing", async () => {
		const { memory, session, calls } = await setup();
		expect(await code(memory.runtime.prompt(operator, session.id, { text: "x", model: "default:nope" }))).toBe(
			"invalid",
		);
		expect(
			await code(
				memory.runtime.prompt(operator, session.id, {
					text: "x",
					thinking: "extreme" as unknown as "high",
				}),
			),
		).toBe("invalid");
		expect(calls).toEqual([]);
	});
});

describe("a started session's model", () => {
	it("is fixed by the first prompt: another model is a conflict on every way in, and runs nothing", async () => {
		const { memory, session, calls, run } = await setup();
		const before = await memory.models.modelState(operator, session.id);
		expect(before.locked).toBeUndefined();
		await run("prompt", { text: "first", model: "default:gpt-5", thinking: "high" });
		expect(await memory.models.modelState(operator, session.id)).toMatchObject({
			selected: { model: "default:gpt-5", thinking: "high" },
			locked: true,
		});
		for (const via of ["prompt", "steer", "followUp"] as const) {
			const refused = memory.runtime[via](operator, session.id, { text: "switch", model: "default" });
			await expect(refused).rejects.toMatchObject({
				code: "conflict",
				message:
					"This session runs on GPT-5, and a session's model can't change once it has started. Start a new session to use Claude Sonnet 5.5.",
				details: { model: "default:gpt-5", requested: "default" },
			});
		}
		// Nothing ran, and the session kept its model and level.
		expect(calls).toEqual([{ model: "default:gpt-5", reasoning: "high" }]);
		expect((await memory.models.modelState(operator, session.id)).selected).toEqual({
			model: "default:gpt-5",
			thinking: "high",
		});
	});

	it("takes its own model named again, and a new thinking level on any later prompt", async () => {
		const { memory, session, calls, run } = await setup();
		await run("prompt", { text: "first" });
		await run("prompt", { text: "same model, less thought", model: "default", thinking: "low" });
		await run("followUp", { text: "more thought", thinking: "max" });
		expect(calls).toEqual([
			{ model: "default", reasoning: "medium" },
			{ model: "default", reasoning: "low" },
			{ model: "default", reasoning: "max" },
		]);
		expect(await memory.models.modelState(operator, session.id)).toMatchObject({
			selected: { model: "default", thinking: "max" },
			locked: true,
		});
	});

	it("stays through an edit of the first message, which can't choose another model", async () => {
		const { memory, session, calls, run } = await setup();
		await run("prompt", { text: "first", model: "default:gpt-5", thinking: "high" });
		const first = (await memory.runtime.snapshot(operator, session.id)).items.find((item) => item.kind === "user");
		if (first === undefined) throw new Error("no first message");
		const moved = memory.branching.edit(operator, session.id, { itemId: first.id, text: "again", model: "default" });
		await expect(moved).rejects.toMatchObject({ code: "conflict" });
		// The edit reruns on the session's model, not its profile's, though the first message has nothing before it.
		const edited = await memory.branching.edit(operator, session.id, {
			itemId: first.id,
			text: "again",
			thinking: "low",
		});
		await memory.runtime.wait(operator, session.id, edited.id);
		expect(calls).toEqual([
			{ model: "default:gpt-5", reasoning: "high" },
			{ model: "default:gpt-5", reasoning: "low" },
		]);
		expect(await memory.models.modelState(operator, session.id)).toMatchObject({
			selected: { model: "default:gpt-5", thinking: "low" },
			locked: true,
		});
		await expect(memory.runtime.prompt(operator, session.id, { text: "x", model: "default" })).rejects.toMatchObject({
			code: "conflict",
		});
	});

	it("carries into a fork, which starts on the model that wrote the answer and is fixed from the outset", async () => {
		const { memory, session, calls, run } = await setup();
		await run("prompt", { text: "first", model: "default:gpt-5", thinking: "high" });
		const answer = (await memory.runtime.snapshot(operator, session.id)).items.find(
			(item) => item.kind === "assistant",
		);
		if (answer === undefined) throw new Error("no answer");
		const fork = await memory.branching.fork(operator, session.id, { itemId: answer.id });
		expect(await memory.models.modelState(operator, fork.id)).toMatchObject({
			selected: { model: "default:gpt-5", thinking: "high" },
			locked: true,
		});
		await expect(memory.runtime.prompt(operator, fork.id, { text: "x", model: "default" })).rejects.toMatchObject({
			code: "conflict",
		});
		const next = await memory.runtime.prompt(operator, fork.id, { text: "go on" });
		await memory.runtime.wait(operator, fork.id, next.id);
		expect(calls.at(-1)).toEqual({ model: "default:gpt-5", reasoning: "high" });
	});
});

describe("a chosen model after a restart", () => {
	it("stays with the session when a later runtime reopens it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harbour-models-"));
		const file = join(dir, "harbour.db");
		const resolveModel = () => ({ provider: KANTEL_MODEL_PROVIDER, modelId: "default" });
		/** One process: its own connection, store and runtime on the one database file. */
		const processOn = async (models: ReturnType<typeof gatewayModels>["models"]) => {
			const db = await openNodeSqliteDatabase(file);
			const store = await createSqlSessionStore(db);
			const service = createSessionRuntime({
				store,
				storage: (record) => sqlPiStorage(db, record.id),
				models,
				resolveModel,
			});
			return {
				service,
				async close() {
					await service.close();
					await db.close();
				},
			};
		};
		const first = gatewayModels();
		const one = await processOn(first.models);
		const before = one.service;
		runtimes.push({ close: async () => rmSync(dir, { recursive: true, force: true }) });
		await before.profiles.put(operator, {
			id: "agent-1",
			organisationId: "org-1",
			name: "Worker",
			model: { route: "default" },
			promptLayers: [],
			tools: [],
			skills: [],
			sandbox: { tiers: ["isolate"] },
			memoryScopes: [],
		});
		const session = await before.runtime.create(operator, { projectId: "proj-1", agentId: "agent-1" });
		const chose = await before.runtime.prompt(operator, session.id, {
			text: "a",
			model: "default:gpt-5",
			thinking: "high",
		});
		await before.runtime.wait(operator, session.id, chose.id);
		await one.close();

		const second = gatewayModels();
		const two = await processOn(second.models);
		const after = two.service;
		runtimes.unshift(two);
		expect((await after.models.modelState(operator, session.id)).selected).toEqual({
			model: "default:gpt-5",
			thinking: "high",
		});
		const next = await after.runtime.prompt(operator, session.id, { text: "b" });
		await after.runtime.wait(operator, session.id, next.id);
		expect(second.calls).toEqual([{ model: "default:gpt-5", reasoning: "high" }]);
	});
});

describe("over HTTP", () => {
	it("serves a session's models and a new session's, and carries a prompt's choice", async () => {
		const { memory, session, calls } = await setup("proj-1");
		const auth: Authentication = { actor: operator.actor, organisationId: "org-1" };
		const api = createSessionApi({
			runtime: memory.runtime,
			models: memory.models,
			directory: memory.directory,
			profiles: memory.profiles,
			hostTools: memory.hostTools,
			authenticator: staticTokenAuthenticator({ operator: auth }),
		});
		runtimes.push(api);
		const client = createSessionApiClient({
			baseUrl: "https://harbour.test/v1",
			credentials: bearer("operator"),
			fetch: (input, init) => api.fetch(new Request(input, init)),
		});
		const state = await client.models.modelState(operator, session.id);
		expect(state.selected).toEqual({ model: "default", thinking: "medium" });
		const start = await client.models.startModels(operator, { projectId: "proj-1", agentId: "agent-1" });
		expect(start.models).toEqual(state.models);
		const submission = await client.runtime.prompt(operator, session.id, {
			text: "go",
			model: "default:gpt-5",
			thinking: "low",
		});
		await client.runtime.wait(operator, session.id, submission.id);
		expect(calls).toEqual([{ model: "default:gpt-5", reasoning: "low" }]);
		await expect(
			client.runtime.prompt(operator, session.id, { text: "go", thinking: "lots" as unknown as "low" }),
		).rejects.toMatchObject({ code: "invalid" });
		expect((await client.models.modelState(operator, session.id)).locked).toBe(true);
	});

	it("answers 409 to a message that changes a started session's model, and takes a new thinking level", async () => {
		const { memory, session, calls } = await setup("proj-1");
		const auth: Authentication = { actor: operator.actor, organisationId: "org-1" };
		const api = createSessionApi({
			runtime: memory.runtime,
			models: memory.models,
			directory: memory.directory,
			profiles: memory.profiles,
			hostTools: memory.hostTools,
			authenticator: staticTokenAuthenticator({ operator: auth }),
		});
		runtimes.push(api);
		const post = (body: unknown) =>
			api.fetch(
				new Request(`https://harbour.test/v1/sessions/${session.id}/messages`, {
					method: "POST",
					headers: { authorization: "Bearer operator", "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
			);
		const first = await post({ text: "start", model: "default:gpt-5" });
		expect(first.status).toBe(202);
		await memory.runtime.wait(operator, session.id, ((await first.json()) as { id: string }).id);
		const moved = await post({ text: "switch", model: "default" });
		expect(moved.status).toBe(409);
		expect(await moved.json()).toMatchObject({
			error: { code: "conflict", details: { model: "default:gpt-5", requested: "default" } },
		});
		const thinking = await post({ text: "think harder", thinking: "xhigh" });
		expect(thinking.status).toBe(202);
		await memory.runtime.wait(operator, session.id, ((await thinking.json()) as { id: string }).id);
		expect(calls).toEqual([
			{ model: "default:gpt-5", reasoning: "medium" },
			{ model: "default:gpt-5", reasoning: "xhigh" },
		]);
	});
});

describe("providerOf", () => {
	it("reads who serves a model off its name, and says nothing for one it doesn't know", () => {
		expect(providerOf({ id: "default:claude-opus-5", name: "Claude Opus 5" })).toBe("Anthropic");
		expect(providerOf({ id: "default:gpt-5.5-codex", name: "GPT-5.5 Codex" })).toBe("OpenAI");
		expect(providerOf({ id: "default:gemini-3-pro", name: "Gemini 3 Pro" })).toBe("Google");
		expect(providerOf({ id: "default:house-model", name: "House model" })).toBeUndefined();
	});
});

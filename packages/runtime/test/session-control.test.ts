// Session control through the public API, as a host app drives a conversation (compared with boat.dev's integrated
// agents): several conversations on one workspace, a fork, a run's result, steering and interrupting a running turn,
// switching model mid-conversation with its context kept, and files on a message. Called through the generated SDK.

import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createFauxCore, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createHarbourClient, HarbourApiError } from "@harbour/api/sdk";
import {
	type AgentProfile,
	type Authentication,
	HARBOUR_MODEL_PROVIDER,
	type PromptAttachment,
} from "@harbour/contracts";
import type { AttachmentBlock, PromptAttachments } from "@harbour/runtime";
import { createSessionApi, staticTokenAuthenticator } from "@harbour/runtime/http";
import { createMemoryRuntime, type MemoryRuntimeOptions } from "@harbour/runtime/memory";
import { createScriptedModel } from "@harbour/runtime/testing";
import type { ScriptedTurn } from "@harbour/testing/session";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-control";
const PROJECT = "proj-control";
const host: Authentication = { actor: { kind: "service", serviceId: "lleverage", keyId: "k1" }, organisationId: ORG };
const asHost = { actor: host.actor, organisationId: ORG };

const profile: AgentProfile = {
	id: "assistant",
	organisationId: ORG,
	name: "Assistant",
	model: { route: "default" },
	promptLayers: [],
	tools: [],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The SDK on the session API over an in-memory runtime, with every optional part a deployment gives it. */
async function serve(options: MemoryRuntimeOptions) {
	const memory = createMemoryRuntime(options);
	const api = createSessionApi({
		runtime: memory.runtime,
		directory: memory.directory,
		profiles: memory.profiles,
		hostTools: memory.hostTools,
		history: memory.history,
		models: memory.models,
		branching: memory.branching,
		authenticator: staticTokenAuthenticator({ host }),
	});
	cleanups.push(async () => {
		await api.close();
		await memory.close();
	});
	const fetchApi = (input: string | URL | Request, init?: RequestInit) => api.fetch(new Request(input, init));
	const client = createHarbourClient({ baseUrl: "https://harbour.test/v1", token: "host", fetch: fetchApi });
	await memory.profiles.put(asHost, profile);
	return { client, fetchApi, memory };
}

async function setUp(extra: Partial<MemoryRuntimeOptions> = {}) {
	const { models, script } = createScriptedModel();
	return { ...(await serve({ models, ...extra })), script };
}

/** A reply the test lets go of: the model's turn waits on `release`. */
function held(turn: ScriptedTurn) {
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		turn: async () => {
			await gate;
			return turn;
		},
		release: () => release(),
	};
}

async function failure(promise: Promise<unknown>): Promise<HarbourApiError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof HarbourApiError) return error;
		throw error;
	}
	throw new Error("expected the call to fail");
}

const until = async (check: () => boolean) => {
	for (let tries = 0; tries < 400 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(check()).toBe(true);
};

describe("session control: conversations", () => {
	it("lists the sessions that share a workspace, each its own conversation", async () => {
		const { client, script } = await setUp();
		script.reply({ text: "Billing done" }, { text: "Changelog done" });
		const billing = await client.createSession({ projectId: PROJECT, agentId: "assistant", workspaceId: "ws-1" });
		const changelog = await client.createSession({ projectId: PROJECT, agentId: "assistant", workspaceId: "ws-1" });
		await client.createSession({ projectId: PROJECT, agentId: "assistant", workspaceId: "ws-2" });
		const first = await client.sendMessage(billing.id, { text: "Refactor billing" });
		const second = await client.sendMessage(changelog.id, { text: "Write the changelog" });
		expect(await client.getRunResult(billing.id, { submission: first.id })).toMatchObject({ answer: "Billing done" });
		expect(await client.getRunResult(changelog.id, { submission: second.id })).toMatchObject({
			answer: "Changelog done",
		});
		const onWorkspace = await client.listSessions({ workspaceId: "ws-1" });
		expect(onWorkspace.items.map((session) => session.id).sort()).toEqual([billing.id, changelog.id].sort());
		expect((await client.listSessions({ workspaceId: "ws-none" })).items).toEqual([]);
	});

	it("forks a conversation from an answer, keeping its context in a new session", async () => {
		const { client, memory, script } = await setUp();
		script.reply({ text: "Plan A" }, { text: "Went with B" });
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant", workspaceId: "ws-1" });
		const sent = await client.sendMessage(session.id, { text: "Make a plan" });
		await client.getRunResult(session.id, { submission: sent.id });
		const answer = (await memory.runtime.snapshot(asHost, session.id)).items.find((item) => item.kind === "assistant");
		const fork = await client.forkSession(session.id, { itemId: answer?.id as string, title: "Option B" });
		expect(fork).toMatchObject({ projectId: PROJECT, agentId: "assistant", workspaceId: "ws-1", title: "Option B" });
		const next = await client.sendMessage(fork.id, { text: "Try B instead" });
		expect(await client.getRunResult(fork.id, { submission: next.id })).toMatchObject({ answer: "Went with B" });
		// The fork's model call carried the source's turns before its own.
		expect(script.requests.at(-1)?.messages.map((message) => message.text)).toEqual([
			"Make a plan",
			"Plan A",
			"Try B instead",
		]);
		expect((await client.listSessions({ workspaceId: "ws-1" })).items).toHaveLength(2);
		expect((await failure(client.forkSession(session.id, { itemId: "no-such-item" }))).code).toBe("not_found");
		expect((await failure(client.forkSession(session.id, {} as never))).code).toBe("invalid");
	});
});

describe("session control: a run's result", () => {
	it("answers 202 pending while the run goes on, then how it ended", async () => {
		const { client, fetchApi, script } = await setUp();
		const reply = held({ text: "Done at last" });
		script.reply(reply.turn);
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		const sent = await client.sendMessage(session.id, { text: "Take your time" });
		expect(await client.getRunResult(session.id, { submission: sent.id, timeoutMs: 10 })).toEqual({
			status: "pending",
			sessionId: session.id,
			submissionId: sent.id,
		});
		const raw = await fetchApi(
			`https://harbour.test/v1/sessions/${session.id}/result?${new URLSearchParams({ submission: sent.id, timeoutMs: "10" })}`,
			{ headers: { authorization: "Bearer host" } },
		);
		expect(raw.status).toBe(202);
		reply.release();
		const ended = await client.getRunResult(session.id, { submission: sent.id });
		expect(ended).toMatchObject({ status: "answered", sessionId: session.id, submissionId: sent.id });
		expect(ended).toMatchObject({ answer: "Done at last" });
	});

	it("refuses an unknown submission and a missing one", async () => {
		const { client } = await setUp();
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		expect((await failure(client.getRunResult(session.id, { submission: `${session.id}/99` }))).code).toBe("not_found");
		expect((await failure(client.getRunResult(session.id, {} as never))).code).toBe("invalid");
		expect((await failure(client.getRunResult(session.id, { submission: "x", timeoutMs: -1 }))).code).toBe("invalid");
	});
});

describe("session control: steering and interrupting a running turn", () => {
	it("steers the running turn: the message joins it after the tool round, without a stop, and shows as a steer", async () => {
		const { client, memory, script } = await setUp();
		const tests = held({ toolCalls: [{ name: "run_tests", args: { suite: "all" } }] });
		script.reply(tests.turn, { text: "Unit tests pass" });
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		const prompt = await client.sendMessage(session.id, { text: "Refactor billing and run every test" });
		await until(() => script.requests.length === 1);
		const steer = await client.sendMessage(session.id, { via: "steer", text: "Skip the integration tests" });
		expect(steer.via).toBe("steer");
		tests.release();
		const ended = await client.getRunResult(session.id, { submission: prompt.id });
		expect(ended).toMatchObject({ status: "answered", answer: "Unit tests pass" });
		// One run: the steer reached the model's next call, after the tool round in progress.
		expect(await client.getRunResult(session.id, { submission: steer.id })).toMatchObject({
			answer: "Unit tests pass",
		});
		expect(script.requests).toHaveLength(2);
		expect(script.requests[1]?.messages.at(-1)).toEqual({ role: "user", text: "Skip the integration tests" });
		const users = (await memory.runtime.snapshot(asHost, session.id)).items.filter((item) => item.kind === "user");
		expect(users.map((item) => item.kind === "user" && item.via)).toEqual(["prompt", "steer"]);
	});

	it("runs a steer that arrives as the run gives its final answer straight after it, never dropping it", async () => {
		const { client, script } = await setUp();
		const answer = held({ text: "Ran the whole suite" });
		script.reply(answer.turn, { text: "Skipped them next time round" });
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		const prompt = await client.sendMessage(session.id, { text: "Run every test" });
		await until(() => script.requests.length === 1);
		const steer = await client.sendMessage(session.id, { via: "steer", text: "Skip the integration tests" });
		answer.release();
		expect(await client.getRunResult(session.id, { submission: prompt.id })).toMatchObject({
			answer: "Ran the whole suite",
		});
		// The steer's own result is the run it started, on the same conversation, with the answer before it in context.
		expect(await client.getRunResult(session.id, { submission: steer.id })).toMatchObject({
			status: "answered",
			answer: "Skipped them next time round",
		});
		expect(script.requests[1]?.messages.map((message) => message.text)).toEqual([
			"Run every test",
			"Ran the whole suite",
			"Skip the integration tests",
		]);
	});

	it("interrupts the running turn: its result is aborted and the conversation takes the next message", async () => {
		const { client, script } = await setUp();
		const stuck = held({ text: "Too late" });
		script.reply(stuck.turn, { text: "Fresh start" });
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		const sent = await client.sendMessage(session.id, { text: "Do the long thing" });
		await until(() => script.requests.length === 1);
		// The abort settles once the model call in flight does; the scripted model ignores its signal, so let it go.
		const aborting = client.abortSession(session.id, { reason: "The user stopped it" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		stuck.release();
		await aborting;
		expect(await client.getRunResult(session.id, { submission: sent.id })).toMatchObject({ status: "aborted" });
		const next = await client.sendMessage(session.id, { text: "Something quick" });
		expect(await client.getRunResult(session.id, { submission: next.id })).toMatchObject({
			status: "answered",
			answer: "Fresh start",
		});
		// The conversation kept its memory of the interrupted turn's prompt.
		expect(script.requests.at(-1)?.messages.map((message) => message.text)).toContain("Do the long thing");
	});
});

/** The gateway's catalogue as the runtime sees it: two routes on Harbour's provider, each call recorded. */
function gatewayModels() {
	const core = createFauxCore({
		provider: HARBOUR_MODEL_PROVIDER,
		models: [
			{ id: "default", name: "Claude Sonnet 5.5", reasoning: true, input: ["text", "image"] },
			{ id: "default:gpt-5", name: "GPT-5", reasoning: true, input: ["text", "image"] },
		],
	});
	const catalogue = core.models.map((model) => ({
		...model,
		thinkingLevelMap: { minimal: null, max: null } as Model<Api>["thinkingLevelMap"],
	}));
	const calls: { model: string; said: string[] }[] = [];
	const record = (model: Model<Api>, messages: readonly Message[]) => {
		const said = messages.flatMap((message) =>
			message.role === "user" || message.role === "assistant"
				? [
						typeof message.content === "string"
							? message.content
							: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
					]
				: [],
		);
		calls.push({ model: model.id, said });
		core.appendResponses([() => fauxAssistantMessage(fauxText(`${model.id} answers`))]);
	};
	const provider = createProvider({
		id: core.provider,
		auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
		models: catalogue,
		api: {
			stream: (model, context, options) => {
				record(model, context.messages);
				return core.stream(model, context, options);
			},
			streamSimple: (model, context, options) => {
				record(model, context.messages);
				return core.streamSimple(model, context, options);
			},
		},
	});
	const models = createModels();
	models.setProvider(provider);
	return { models, calls };
}

describe("session control: switching model mid-conversation", () => {
	it("lists the models, switches on a message and keeps the conversation's context", async () => {
		const { models, calls } = gatewayModels();
		const { client } = await serve({
			models,
			resolveModel: (choice) => ({
				provider: HARBOUR_MODEL_PROVIDER,
				modelId: choice.modelId === undefined ? choice.route : `${choice.route}:${choice.modelId}`,
			}),
		});
		const before = await client.getNewSessionModels("assistant", { projectId: PROJECT });
		expect(before.models.map((option) => option.id)).toEqual(["default", "default:gpt-5"]);
		expect(before.selected).toEqual(before.defaults);
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		const first = await client.sendMessage(session.id, { text: "Start on Claude" });
		await client.getRunResult(session.id, { submission: first.id });
		const second = await client.sendMessage(session.id, { text: "Take it from here", model: "default:gpt-5" });
		expect(await client.getRunResult(session.id, { submission: second.id })).toMatchObject({
			answer: "default:gpt-5 answers",
		});
		expect(calls.map((call) => call.model)).toEqual(["default", "default:gpt-5"]);
		expect(calls[1]?.said).toEqual(["Start on Claude", "default answers", "Take it from here"]);
		expect((await client.getSessionModels(session.id)).selected?.model).toBe("default:gpt-5");
		expect((await failure(client.sendMessage(session.id, { text: "Hi", model: "no-such" }))).code).toBe("invalid");
		expect((await failure(client.getNewSessionModels("assistant", {} as never))).code).toBe("invalid");
	});

	it("answers not_supported where the server lists no models or forks nothing", async () => {
		const { models } = createScriptedModel();
		const memory = createMemoryRuntime({ models });
		const api = createSessionApi({
			runtime: memory.runtime,
			directory: memory.directory,
			profiles: memory.profiles,
			hostTools: memory.hostTools,
			authenticator: staticTokenAuthenticator({ host }),
		});
		cleanups.push(async () => {
			await api.close();
			await memory.close();
		});
		const client = createHarbourClient({
			baseUrl: "https://harbour.test/v1",
			token: "host",
			fetch: (input, init) => api.fetch(new Request(input, init)),
		});
		await memory.profiles.put(asHost, profile);
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		expect((await failure(client.getSessionModels(session.id))).code).toBe("not_supported");
		expect((await failure(client.forkSession(session.id, { itemId: "a" }))).code).toBe("not_supported");
	});
});

const notes: PromptAttachment = { id: "a1", name: "notes.md", type: "text/markdown", size: 12, kind: "file" };

/** A deployment's upload store holding `notes`. */
const uploads: PromptAttachments = {
	async read(_ctx, _session, attachments) {
		return {
			blocks: attachments.map((): AttachmentBlock => ({ type: "text", text: "The launch is on Tuesday." })),
			attachments: attachments.map(() => notes),
		};
	},
};

describe("session control: files on a message", () => {
	it("sends a message's attachments, with or without words, and the transcript names them", async () => {
		const { client, memory, script } = await setUp({ attachments: uploads });
		script.reply({ text: "Tuesday" });
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		const sent = await client.sendMessage(session.id, { text: "", attachments: [notes] });
		expect(await client.getRunResult(session.id, { submission: sent.id })).toMatchObject({ answer: "Tuesday" });
		expect(script.requests[0]?.messages[0]?.text).toContain("The launch is on Tuesday.");
		const user = (await memory.runtime.snapshot(asHost, session.id)).items.find((item) => item.kind === "user");
		expect(user).toMatchObject({ text: "", attachments: [notes] });
	});

	it("refuses attachments where the deployment stores none, and a malformed one", async () => {
		const { client } = await setUp();
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		expect((await failure(client.sendMessage(session.id, { text: "Read this", attachments: [notes] }))).code).toBe(
			"invalid",
		);
		const malformed = { ...notes, kind: "video" } as unknown as PromptAttachment;
		expect((await failure(client.sendMessage(session.id, { text: "Hi", attachments: [malformed] }))).code).toBe(
			"invalid",
		);
		expect((await failure(client.sendMessage(session.id, { text: "" }))).code).toBe("invalid");
	});
});

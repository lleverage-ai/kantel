// Contract tests for the public API's session routes (`@harbour/api`), called through the generated SDK against the
// session API over the in-memory runtime, as a host app would call a deployed Harbour.

import { createHarbourClient, HarbourApiError } from "@harbour/api/sdk";
import type { AgentProfile, Authentication } from "@harbour/contracts";
import { createSessionApi, staticTokenAuthenticator } from "@harbour/runtime/http";
import { createMemoryRuntime } from "@harbour/runtime/memory";
import { createScriptedModel } from "@harbour/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-public";
const PROJECT = "proj-public";
const host: Authentication = { actor: { kind: "service", serviceId: "lleverage", keyId: "k1" }, organisationId: ORG };

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

async function setUp() {
	const { models, script } = createScriptedModel();
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
	const fetchApi = (input: string | URL | Request, init?: RequestInit) => api.fetch(new Request(input, init));
	const client = createHarbourClient({ baseUrl: "https://harbour.test/v1", token: "host", fetch: fetchApi });
	await memory.profiles.put({ actor: host.actor, organisationId: ORG }, profile);
	return { client, fetchApi, memory, script };
}

const asHost = { actor: host.actor, organisationId: ORG };

async function failure(promise: Promise<unknown>): Promise<HarbourApiError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof HarbourApiError) return error;
		throw error;
	}
	throw new Error("expected the call to fail");
}

describe("public API: sessions", () => {
	it("creates a session and reads it back", async () => {
		const { client } = await setUp();
		const created = await client.createSession({
			projectId: PROJECT,
			agentId: "assistant",
			title: "Invoice run",
			labels: { lleverageRef: "run-42" },
		});
		expect(created).toMatchObject({
			organisationId: ORG,
			projectId: PROJECT,
			agentId: "assistant",
			title: "Invoice run",
			labels: { lleverageRef: "run-42" },
			createdBy: host.actor,
		});
		expect(await client.getSession(created.id)).toEqual(created);
	});

	it("ignores fields the create body doesn't name, so a caller can't pick another organisation", async () => {
		const { client } = await setUp();
		const created = await client.createSession({
			projectId: PROJECT,
			agentId: "assistant",
			organisationId: "org-elsewhere",
		} as never);
		expect(created.organisationId).toBe(ORG);
	});

	it("lists sessions by project, status and label, a page at a time", async () => {
		const { client } = await setUp();
		const one = await client.createSession({ projectId: PROJECT, agentId: "assistant", labels: { ref: "a" } });
		const two = await client.createSession({ projectId: PROJECT, agentId: "assistant", labels: { ref: "b" } });
		await client.createSession({ projectId: "proj-other", agentId: "assistant" });
		const inProject = await client.listSessions({ projectId: PROJECT });
		expect(inProject.items.map((session) => session.id).sort()).toEqual([one.id, two.id].sort());
		expect((await client.listSessions({ label: { ref: "b" } })).items.map((session) => session.id)).toEqual([two.id]);
		expect((await client.listSessions({ label: { ref: "c" } })).items).toEqual([]);
		expect((await client.listSessions({ projectId: PROJECT, status: "running" })).items).toEqual([]);
		const first = await client.listSessions({ projectId: PROJECT, limit: 1 });
		expect(first.items).toHaveLength(1);
		expect(first.nextCursor).toBeDefined();
		const second = await client.listSessions({ projectId: PROJECT, limit: 1, cursor: first.nextCursor as string });
		expect(second.items).toHaveLength(1);
		expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
	});

	it("aborts a session's run, with or without a reason, and leaves it open", async () => {
		const { client } = await setUp();
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		await expect(client.abortSession(session.id)).resolves.toBeUndefined();
		await expect(client.abortSession(session.id, { reason: "The user stopped it" })).resolves.toBeUndefined();
		expect((await client.getSession(session.id)).id).toBe(session.id);
	});

	it("closes a session, and closing it again does nothing", async () => {
		const { client } = await setUp();
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		await expect(client.closeSession(session.id)).resolves.toBeUndefined();
		await expect(client.closeSession(session.id)).resolves.toBeUndefined();
	});

	it("answers errors with the HarbourError's code and status", async () => {
		const { client } = await setUp();
		const missing = await failure(client.getSession("ses-missing"));
		expect([missing.status, missing.code]).toEqual([404, "not_found"]);
		const invalid = await failure(client.createSession({ projectId: PROJECT } as never));
		expect([invalid.status, invalid.code]).toEqual([400, "invalid"]);
		expect(invalid.message).toContain("agentId");
	});

	it("refuses a missing credential, a bad query and a malformed body over the wire", async () => {
		const { fetchApi } = await setUp();
		const anonymous = createHarbourClient({ baseUrl: "https://harbour.test/v1", fetch: fetchApi });
		const refused = await failure(anonymous.listSessions());
		expect([refused.status, refused.code]).toEqual([401, "unauthenticated"]);
		const call = (path: string, init: RequestInit = {}) =>
			fetchApi(`https://harbour.test/v1${path}`, { ...init, headers: { authorization: "Bearer host" } });
		for (const query of ["status=bogus", "limit=0", "limit=many"]) {
			const response = await call(`/sessions?${query}`);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: "invalid" } });
		}
		const notJson = await call("/sessions", { method: "POST", body: "{" });
		expect(await notJson.json()).toEqual({ error: { code: "invalid", message: "The body is not JSON" } });
		const badReason = await call("/sessions/ses-1/abort", { method: "POST", body: JSON.stringify({ reason: 7 }) });
		expect(badReason.status).toBe(400);
	});
});

describe("public API: messages", () => {
	it("sends a prompt, and the session answers it", async () => {
		const { client, memory, script } = await setUp();
		script.reply({ text: "Hello back" });
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		const submission = await client.sendMessage(session.id, { text: "Hello" });
		expect(submission).toMatchObject({ sessionId: session.id, via: "prompt" });
		expect(await memory.runtime.wait(asHost, session.id, submission.id)).toMatchObject({ answer: "Hello back" });
	});

	it("sends a steer or a follow-up by `via`", async () => {
		const { client } = await setUp();
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		expect((await client.sendMessage(session.id, { via: "steer", text: "Faster" })).via).toBe("steer");
		expect((await client.sendMessage(session.id, { via: "followUp", text: "Then this" })).via).toBe("followUp");
	});

	it("answers a replay with the same Idempotency-Key with the first submission, and sends nothing again", async () => {
		const { client, memory, script } = await setUp();
		script.reply({ text: "Once" }, { text: "Twice" });
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		const first = await client.sendMessage(session.id, { text: "Go" }, { idempotencyKey: "msg-1" });
		expect(first.requestId).toBe("msg-1");
		const again = await client.sendMessage(session.id, { text: "Go" }, { idempotencyKey: "msg-1" });
		expect(again).toEqual(first);
		expect(await memory.runtime.wait(asHost, session.id, first.id)).toMatchObject({ answer: "Once" });
		const later = await client.sendMessage(session.id, { text: "Go" }, { idempotencyKey: "msg-1" });
		expect(later).toEqual(first);
		expect(script.requests).toHaveLength(1);
		const snapshot = await memory.runtime.snapshot(asHost, session.id);
		expect(snapshot.items.filter((item) => item.kind === "user")).toHaveLength(1);
	});

	it("refuses a key reused for another kind of message, and sends nothing", async () => {
		const { client, memory } = await setUp();
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		const first = await client.sendMessage(session.id, { text: "Go" }, { idempotencyKey: "msg-2" });
		await memory.runtime.wait(asHost, session.id, first.id);
		const reused = await failure(
			client.sendMessage(session.id, { via: "steer", text: "Go" }, { idempotencyKey: "msg-2" }),
		);
		expect([reused.status, reused.code]).toEqual([409, "conflict"]);
		const snapshot = await memory.runtime.snapshot(asHost, session.id);
		expect(snapshot.items.filter((item) => item.kind === "user")).toHaveLength(1);
	});

	it("refuses an empty message, an unknown via and a malformed key", async () => {
		const { client } = await setUp();
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		expect((await failure(client.sendMessage(session.id, { text: "" }))).code).toBe("invalid");
		expect((await failure(client.sendMessage(session.id, { via: "shout", text: "Hi" } as never))).code).toBe("invalid");
		for (const key of ["has space", "x".repeat(256)]) {
			const refused = await failure(client.sendMessage(session.id, { text: "Hi" }, { idempotencyKey: key }));
			expect([refused.status, refused.code]).toEqual([400, "invalid"]);
		}
	});

	it("refuses a message to a closed or unknown session", async () => {
		const { client } = await setUp();
		const session = await client.createSession({ projectId: PROJECT, agentId: "assistant" });
		await client.closeSession(session.id);
		expect((await failure(client.sendMessage(session.id, { text: "Hi" }))).code).toBe("conflict");
		expect((await failure(client.sendMessage("ses-missing", { text: "Hi" }))).code).toBe("not_found");
	});

	it("sends a new session its first message", async () => {
		const { client, memory, script } = await setUp();
		script.reply({ text: "Started" });
		const created = await client.createSession({
			projectId: PROJECT,
			agentId: "assistant",
			message: { text: "Begin" },
		});
		expect(created.submission).toMatchObject({ sessionId: created.id, via: "prompt" });
		expect(await memory.runtime.wait(asHost, created.id, created.submission?.id as string)).toMatchObject({
			answer: "Started",
		});
	});

	it("closes a new session whose first message is refused, and answers the refusal", async () => {
		const { client } = await setUp();
		const refused = await failure(
			client.createSession({ projectId: PROJECT, agentId: "assistant", message: { text: "Hi", model: "no-such" } }),
		);
		expect(refused.code).toBe("invalid");
		const [session] = (await client.listSessions({ projectId: PROJECT })).items;
		expect(session).toBeDefined();
		expect((await failure(client.sendMessage(session?.id as string, { text: "Again" }))).code).toBe("conflict");
	});
});

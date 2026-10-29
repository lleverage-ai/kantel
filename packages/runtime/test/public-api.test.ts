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
	const fetchApi = (input: string | URL | Request, init?: RequestInit) => api.fetch(new Request(input, init));
	const client = createHarbourClient({ baseUrl: "https://harbour.test/v1", token: "host", fetch: fetchApi });
	await memory.profiles.put({ actor: host.actor, organisationId: ORG }, profile);
	return { client, fetchApi };
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

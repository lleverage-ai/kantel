// The stack over durable storage, in Node: SQLite stands in for D1 and the Durable Object's own SQLite, and the
// in-memory object store for R2. A second stack opened over the same storage is the Durable Object restarting.
import { DatabaseSync } from "node:sqlite";
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createMockAccess } from "@harbour/identity/testing";
import { syncSqliteDriver } from "@harbour/sql/sqlite";
import { createMemoryWorkspaceStore } from "@harbour/workspace/stored";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import { createGateway } from "../src/gateway.ts";
import {
	type BootstrapRecord,
	type BootstrapStore,
	createMemoryBootstrapStore,
	createStack,
	DEFAULT_AGENT_ID,
	type Stack,
	type StackStorage,
} from "../src/stack.ts";

const TEAM_DOMAIN = "harbour-test.cloudflareaccess.com";
const AUD = "aud-harbour-test";
const ADMIN = "tom@harbour.test";
const BASE = "https://harbour.test";

const opened: { stack: Stack; sessions: SqliteDatabase }[] = [];

afterEach(async () => {
	for (const { stack } of opened.splice(0)) await stack.runtime.close();
});

async function durableStorage(bootstrap: BootstrapStore = createMemoryBootstrapStore()): Promise<StackStorage> {
	return {
		sql: syncSqliteDriver(new DatabaseSync(":memory:")),
		sessions: await openNodeSqliteDatabase(":memory:"),
		workspaces: createMemoryWorkspaceStore(),
		bootstrap,
	};
}

async function start(storage: StackStorage) {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const config = gatewayConfig({
		HARBOUR_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		HARBOUR_ACCESS_AUD: AUD,
		HARBOUR_ADMIN_EMAIL: ADMIN,
	});
	const stack = await createStack({ config, accessFetch: mock.fetch, storage });
	opened.push({ stack, sessions: storage.sessions! });
	const gateway = createGateway(stack);
	const headers = {
		"cf-access-jwt-assertion": await mock.sign({ sub: "access-subject-1", email: ADMIN }),
		"content-type": "application/json",
	};
	const call = (path: string, init: RequestInit = {}) =>
		gateway.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
	return { stack, call };
}

describe("the stack over durable storage", () => {
	it("finds the same organisation, sessions, workspaces and audit after a restart", async () => {
		const storage = await durableStorage();
		const first = await start(storage);

		const created = await first.call("/v1/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId: first.stack.project.id, agentId: DEFAULT_AGENT_ID, title: "Kept" }),
		});
		expect(created.status).toBe(201);
		const session = (await created.json()) as { id: string };
		const prompted = await first.call(`/v1/sessions/${session.id}/prompt`, {
			method: "POST",
			body: JSON.stringify({ text: "ping" }),
		});
		const submission = (await prompted.json()) as { id: string };
		const answered = await first.call(
			`/v1/sessions/${session.id}/result?submission=${encodeURIComponent(submission.id)}&timeoutMs=5000`,
		);
		expect(await answered.json()).toMatchObject({ status: "answered", answer: "Echo: ping" });

		const workspace = await first.stack.workspaces.create(first.stack.admin, {
			owner: { kind: "project", organisationId: first.stack.organisation.id, projectId: first.stack.project.id },
		});
		await first.stack.workspaces.commit(first.stack.admin, workspace.id, {
			baseVersion: workspace.head,
			changes: [{ op: "put", path: "notes/kept.md", content: "# Kept" }],
		});
		await first.stack.runtime.close();

		const second = await start(storage);
		expect(second.stack.organisation.id).toBe(first.stack.organisation.id);
		expect(second.stack.project.id).toBe(first.stack.project.id);
		expect(second.stack.admin).toEqual(first.stack.admin);

		// The invited admin still signs in, and finds the session with its transcript.
		const listed = await second.call(`/v1/sessions?projectId=${second.stack.project.id}`);
		expect(listed.status).toBe(200);
		expect(((await listed.json()) as { items: { id: string; title: string }[] }).items).toMatchObject([
			{ id: session.id, title: "Kept" },
		]);
		const snapshot = await second.stack.runtime.runtime.snapshot(second.stack.admin, session.id);
		expect(snapshot.items.map((item) => item.kind)).toEqual(["user", "assistant"]);

		const content = await second.call(`/v1/workspaces/${workspace.id}/content?path=notes/kept.md`);
		expect(await content.text()).toBe("# Kept");

		// One bootstrap: one organisation and one project created, however many starts.
		const audit = await second.call("/v1/audit/events?type=identity.project.created");
		expect(((await audit.json()) as { items: unknown[] }).items).toHaveLength(1);
	});

	it("resumes a bootstrap that stopped half way instead of making a second organisation", async () => {
		let saved: BootstrapRecord = {};
		let failSaves = 0;
		const bootstrap: BootstrapStore = {
			load: async () => saved,
			async save(record) {
				saved = record;
				// The start fails right after the organisation is made and saved.
				if (record.organisationId !== undefined && record.projectId === undefined && failSaves++ === 0) {
					throw new Error("the object restarted");
				}
			},
		};
		const storage = await durableStorage(bootstrap);
		await expect(start(storage)).rejects.toThrow("the object restarted");
		const organisationId = saved.organisationId;
		expect(organisationId).toBeDefined();

		const { stack } = await start(storage);
		expect(stack.organisation.id).toBe(organisationId);
		expect(stack.admin.actor).toMatchObject({ kind: "human" });
		expect(saved).toEqual({
			userId: (stack.admin.actor as { userId: string }).userId,
			organisationId,
			projectId: stack.project.id,
		});
	});
});

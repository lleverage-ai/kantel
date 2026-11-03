// `onCreated`: a session's create reports how long each part of it took, for the deployment's logs (a cold create on
// Cloudflare, TASK-4486). A reporter that throws does not fail the create.
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { AgentProfile, SessionId } from "@kantel/contracts";
import { createSessionRuntime, type SessionRuntimeOptions } from "@kantel/runtime/core";
import { createSqlSessionStore, sqlPiStorage } from "@kantel/runtime/sql";
import { createScriptedModel } from "@kantel/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-create-timings";
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;
const profile: AgentProfile = {
	id: "worker",
	organisationId: ORG,
	name: "Worker",
	model: { route: "default" },
	promptLayers: [],
	tools: [],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function runtimeWith(options: Partial<SessionRuntimeOptions>) {
	const db = await openNodeSqliteDatabase(":memory:");
	const { models } = createScriptedModel();
	const service = createSessionRuntime({
		store: await createSqlSessionStore(db),
		storage: (session) => sqlPiStorage(db, session.id),
		models,
		...options,
	});
	cleanups.push(async () => {
		await service.close();
		await db.close();
	});
	await service.profiles.put(ctx, profile);
	return service;
}

describe("onCreated", () => {
	it("reports each part of a create, opening included, once", async () => {
		const reported: { sessionId: SessionId; timings: Readonly<Record<string, number>> }[] = [];
		const service = await runtimeWith({ onCreated: (sessionId, timings) => reported.push({ sessionId, timings }) });
		const record = await service.runtime.create(ctx, { projectId: "proj", agentId: profile.id });
		expect(reported).toHaveLength(1);
		expect(reported[0]?.sessionId).toBe(record.id);
		expect(Object.keys(reported[0]?.timings ?? {})).toEqual([
			"profile",
			"access",
			"store",
			"open.models",
			"open.storage",
			"open.harness",
			"open.conversation",
			"open.tools",
			"open.rest",
			"audit",
		]);
		for (const ms of Object.values(reported[0]?.timings ?? {})) expect(ms).toBeGreaterThanOrEqual(0);
		// Opening the session again later is not a create: nothing more is reported.
		await service.runtime.snapshot(ctx, record.id);
		expect(reported).toHaveLength(1);
	});

	it("creates the session when the reporter throws", async () => {
		const service = await runtimeWith({
			onCreated: () => {
				throw new Error("logs are down");
			},
		});
		const record = await service.runtime.create(ctx, { projectId: "proj", agentId: profile.id });
		expect((await service.runtime.snapshot(ctx, record.id)).sessionId).toBe(record.id);
	});
});

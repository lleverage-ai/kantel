// A session's execution environment (`SessionRuntimeOptions.environment`): built once per session when it opens, given
// to the tools of that session only, and cleaned up on abort and close. Building it acquires nothing.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { AgentProfile, SessionRecord } from "@kantel/contracts";
import { createMemoryRuntime } from "@kantel/runtime/memory";
import { createScriptedModel } from "@kantel/runtime/testing";
import { describe, expect, it } from "vitest";

const ORG = "org-env";
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;

const profile: AgentProfile = {
	id: "worker",
	organisationId: ORG,
	name: "Worker",
	model: { route: "default" },
	promptLayers: [],
	tools: ["where"],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
};

/** An environment that says which session it is for and counts its cleanups. Only `id`, `cwd` and `cleanup` are used. */
function fakeEnv(record: SessionRecord, cleanups: string[]): ExecutionEnv {
	return {
		id: `env:${record.id}`,
		cwd: "/workspace",
		cleanup: async () => {
			cleanups.push(record.id);
		},
	} as unknown as ExecutionEnv;
}

/** A tool answering with the id of the environment it was called in. */
const where: ToolRegistration = defineTool({
	name: "where",
	description: "Says where it runs",
	parameters: Type.Object({}),
	execute: async (_input, api) => ({ output: [{ type: "text", text: api.env?.id ?? "no environment" }] }),
});

function setUp(environment?: (record: SessionRecord) => ExecutionEnv | undefined) {
	const { models, script } = createScriptedModel();
	const service = createMemoryRuntime({
		models,
		tools: () => [where],
		...(environment === undefined ? {} : { environment }),
	});
	return { service, script };
}

/** What the tool answered the model in the session's last tool result. */
function toolText(script: ReturnType<typeof createScriptedModel>["script"]): string | undefined {
	const result = script.requests.at(-1)?.messages.find((message) => message.role === "tool");
	return result?.text;
}

describe("a session's execution environment", () => {
	it("is built once per session when it opens, and each session's tools get their own", async () => {
		const built: string[] = [];
		const cleanups: string[] = [];
		const { service, script } = setUp((record) => {
			built.push(record.id);
			return fakeEnv(record, cleanups);
		});
		try {
			await service.profiles.put(ctx, profile);
			const first = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
			const second = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
			expect(built).toEqual([first.id, second.id]);

			for (const session of [first, second]) {
				script.reply({ toolCalls: [{ name: "where", args: {} }] }, { text: "Done" });
				const prompt = await service.runtime.prompt(ctx, session.id, { text: "Where?" });
				await service.runtime.wait(ctx, session.id, prompt.id);
				expect(toolText(script)).toBe(`env:${session.id}`);
			}
			// Prompts reuse the environment the session opened with.
			expect(built).toEqual([first.id, second.id]);
		} finally {
			await service.close();
		}
		expect(cleanups.sort()).toEqual([...built].sort());
	});

	it("is cleaned up when the session is aborted", async () => {
		const cleanups: string[] = [];
		const { service } = setUp((record) => fakeEnv(record, cleanups));
		try {
			await service.profiles.put(ctx, profile);
			const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
			await service.runtime.abort(ctx, session.id, "stop");
			expect(cleanups).toEqual([session.id]);
		} finally {
			await service.close();
		}
	});

	it("leaves tools without one when the deployment gives none", async () => {
		const { service, script } = setUp();
		try {
			await service.profiles.put(ctx, profile);
			const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
			script.reply({ toolCalls: [{ name: "where", args: {} }] }, { text: "Done" });
			const prompt = await service.runtime.prompt(ctx, session.id, { text: "Where?" });
			await service.runtime.wait(ctx, session.id, prompt.id);
			expect(toolText(script)).toBe("no environment");
		} finally {
			await service.close();
		}
	});

	it("is not built for a session the deployment gives none", async () => {
		const cleanups: string[] = [];
		const { service, script } = setUp((record) =>
			record.workspaceId === undefined ? undefined : fakeEnv(record, cleanups),
		);
		try {
			await service.profiles.put(ctx, profile);
			const session = await service.runtime.create(ctx, { projectId: "proj", agentId: "worker" });
			script.reply({ toolCalls: [{ name: "where", args: {} }] }, { text: "Done" });
			const prompt = await service.runtime.prompt(ctx, session.id, { text: "Where?" });
			await service.runtime.wait(ctx, session.id, prompt.id);
			expect(toolText(script)).toBe("no environment");
			await service.runtime.abort(ctx, session.id);
		} finally {
			await service.close();
		}
		expect(cleanups).toEqual([]);
	});
});

import { createMemoryBrowser } from "@harbour/browser/memory";
import { createMemoryCapabilityRegistry } from "@harbour/codemode/memory";
import { type CallContext, HarbourError } from "@harbour/contracts";
import { createSessionEndHook } from "@harbour/runtime";
import { createMemoryRuntime } from "@harbour/runtime/memory";
import { createScriptedModel } from "@harbour/runtime/testing";
import { createMemorySandboxes } from "@harbour/sandbox/memory";
import { RecordingAuditSink } from "@harbour/testing/harness";
import { createMemoryVault } from "@harbour/vault/memory";
import { createMemoryWorkspaces } from "@harbour/workspace/memory";
import { describe, expect, it } from "vitest";

const operator: CallContext = {
	actor: { kind: "service", serviceId: "supervisor" },
	organisationId: "org-1",
	projectId: "proj-1",
};

describe("the runtime's session-end hook with every in-memory component", () => {
	it("registers the sandbox, browser, capability and vault teardowns, and closing ends the session's lease and grant", async () => {
		const { models } = createScriptedModel();
		const memory = createMemoryRuntime({ models });
		const sessionEnd = memory.sessionEnd;
		const workspaces = createMemoryWorkspaces();
		const sandboxes = createMemorySandboxes({ workspaces, sessionEnd });
		createMemoryBrowser({ sessionEnd });
		const registry = createMemoryCapabilityRegistry({ sessionEnd });
		createMemoryVault({ sessionEnd });
		try {
			for (const name of ["sandbox", "browser", "capability", "vault"]) {
				expect(() => sessionEnd.register(name, async () => {}), name).toThrow(HarbourError);
			}

			await memory.profiles.put(operator, {
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
			const session = await memory.runtime.create(operator, { projectId: "proj-1", agentId: "agent-1" });
			const other = await memory.runtime.create(operator, { projectId: "proj-1", agentId: "agent-1" });
			const workspace = await workspaces.create(operator, {
				owner: { kind: "organisation", organisationId: "org-1" },
			});
			const lease = await sandboxes.acquire(operator, {
				sessionId: session.id,
				workspaceId: workspace.id,
				tier: "isolate",
			});
			const kept = await sandboxes.acquire(operator, {
				sessionId: other.id,
				workspaceId: workspace.id,
				tier: "isolate",
			});
			const grant = await registry.grant(operator, { selector: { sessionId: session.id }, capabilities: ["tool.run"] });

			await memory.runtime.close(operator, session.id);

			await expect(sandboxes.exec(operator, lease.id, { command: "echo hi" })).rejects.toMatchObject({
				code: "expired",
			});
			expect((await sandboxes.exec(operator, kept.id, { command: "echo hi" })).stdout).toBe("hi\n");
			const statuses = Object.fromEntries(
				(await registry.listGrants(operator)).items.map((entry) => [entry.id, entry.status]),
			);
			expect(statuses).toEqual({ [grant.id]: "revoked" });
		} finally {
			await memory.close();
		}
	});
});

describe("the runtime's session end when the audit sink fails", () => {
	it("still runs every session's teardowns, then rejects", async () => {
		const { models } = createScriptedModel();
		const audit = new RecordingAuditSink();
		let failing: string | undefined;
		const memory = createMemoryRuntime({
			models,
			audit: {
				append: async (ctx, events) => {
					if (events.some((event) => event.type === "session.aborted" && event.sessionId === failing)) {
						throw new HarbourError("unavailable", "The audit sink is down");
					}
					await audit.append(ctx, events);
				},
			},
		});
		const ended: string[] = [];
		memory.sessionEnd.register("recorder", async (_ctx, end) => {
			ended.push(end.sessionId);
		});
		try {
			await memory.profiles.put(operator, {
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
			const parent = await memory.runtime.create(operator, { projectId: "proj-1", agentId: "agent-1" });
			const first = await memory.runtime.create(operator, {
				projectId: "proj-1",
				agentId: "agent-1",
				parentSessionId: parent.id,
			});
			const second = await memory.runtime.create(operator, {
				projectId: "proj-1",
				agentId: "agent-1",
				parentSessionId: parent.id,
			});
			failing = first.id;
			await expect(memory.runtime.abort(operator, parent.id)).rejects.toMatchObject({ code: "unavailable" });
			expect(new Set(ended)).toEqual(new Set([first.id, second.id, parent.id]));
		} finally {
			await memory.close();
		}
	});
});

describe("createSessionEndHook", () => {
	const end = {
		sessionId: "sess-1",
		organisationId: "org-1",
		projectId: "proj-1",
		agentId: "agent-1",
		reason: "aborted" as const,
		endedBy: operator.actor,
		at: 0,
	};

	it("runs every teardown even after one fails, and audits a failure once per run id", async () => {
		const audit = new RecordingAuditSink();
		const runner = createSessionEndHook({ audit });
		const ran: string[] = [];
		runner.hook.register("a", async () => {
			ran.push("a");
			throw new Error("boom");
		});
		runner.hook.register("b", async () => {
			ran.push("b");
		});
		await runner.run(end, "1");
		await runner.run(end, "1");
		expect(ran).toEqual(["a", "b", "a", "b"]);
		expect(audit.ofType("session.teardown.failed")).toHaveLength(1);
		expect(audit.ofType("session.teardown.failed")[0]?.data).toEqual({
			teardown: "a",
			reason: "aborted",
			code: "unknown",
		});
		expect(runner.names()).toEqual(["a", "b"]);
		expect(() => runner.hook.register("", async () => {})).toThrow(HarbourError);
	});
});

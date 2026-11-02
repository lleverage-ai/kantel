// The `subagent` tool on its own, on a plain in-memory session runtime with no deployment around it: the child session
// it starts, the answer it brings back, how deep it goes, and what it answers when the child doesn't. Cloudflare's stack
// (apps/cloudflare/test/subagent.test.ts) and the self-hosted gateway (apps/selfhosted/test/gateway/subagents.test.ts)
// test it again where they wire it.
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { AgentProfile, SessionRuntime } from "@kantel/contracts";
import { createMemoryRuntime, type MemoryRuntime } from "@kantel/runtime/memory";
import { createScriptedModel } from "@kantel/runtime/testing";
import {
	MAX_SUBAGENT_DEPTH,
	SUBAGENT_CALL_LABEL,
	SUBAGENT_DEPTH_LABEL,
	SUBAGENT_STOPPED,
	SUBAGENT_TOOL,
	sessionSubagentTool,
	subagentDepth,
	subagentsEnabled,
	subagentTitle,
	withSubagentTool,
} from "@kantel/subagents";
import { afterEach, describe, expect, it } from "vitest";

const ORG = "org-subagents";
const PROJECT = "proj-subagents";
const ctx = { actor: { kind: "service", serviceId: "test" }, organisationId: ORG } as const;

const profile = (tools: string[]): AgentProfile => ({
	id: "worker",
	organisationId: ORG,
	name: "Worker",
	model: { route: "default" },
	promptLayers: [],
	tools,
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
});

const opened: MemoryRuntime[] = [];
afterEach(async () => {
	for (const service of opened.splice(0)) await service.close();
});

/** A runtime whose sessions have one tool of their own, `note`, and `subagent` after it. */
async function setUp() {
	const { models, script } = createScriptedModel();
	let runtime: SessionRuntime | undefined;
	const note = defineTool({
		name: "note",
		description: "Says which session called it",
		parameters: Type.Object({}),
		execute: async (_args, api) => ({ output: [{ type: "text", text: `noted by ${api.callId}` }] }),
	});
	const service = createMemoryRuntime({
		models,
		tools: withSubagentTool(
			() => [note],
			() => {
				if (runtime === undefined) throw new Error("not ready");
				return runtime;
			},
		),
	});
	runtime = service.runtime;
	opened.push(service);
	await service.profiles.put(ctx, profile(["note", SUBAGENT_TOOL]));
	const sessions = service.runtime;
	const create = () => sessions.create(ctx, { projectId: PROJECT, agentId: "worker", workspaceId: "ws_shared" });
	const run = async (sessionId: string, text: string) => {
		const prompt = await sessions.prompt(ctx, sessionId, { text });
		return sessions.wait(ctx, sessionId, prompt.id);
	};
	const children = async (sessionId: string) =>
		(await service.directory.list(ctx, { parentSessionId: sessionId })).items;
	const toolItem = async (sessionId: string) =>
		(await sessions.snapshot(ctx, sessionId)).items.find((item) => item.kind === "tool" && item.name === SUBAGENT_TOOL);
	return { service, script, sessions, create, run, children, toolItem };
}

describe("the subagent tool", () => {
	it("is switched on by KANTEL_SUBAGENTS=on, and otherwise by the deployment's default", () => {
		expect(subagentsEnabled({})).toBe(false);
		expect(subagentsEnabled({ KANTEL_SUBAGENTS: " on " })).toBe(true);
		expect(subagentsEnabled({ KANTEL_SUBAGENTS: "off" })).toBe(false);
		// A deployment that has them on unless told otherwise.
		expect(subagentsEnabled({}, true)).toBe(true);
		expect(subagentsEnabled({ KANTEL_SUBAGENTS: "  " }, true)).toBe(true);
		expect(subagentsEnabled({ KANTEL_SUBAGENTS: "off" }, true)).toBe(false);
		expect(subagentsEnabled({ KANTEL_SUBAGENTS: "yes" }, true)).toBe(false);
	});

	it("runs the task in a child session of the same agent on the parent's workspace and answers with its answer", async () => {
		const { script, sessions, create, run, children, toolItem } = await setUp();
		const parent = await create();
		script.reply(
			{ toolCalls: [{ name: SUBAGENT_TOOL, args: { task: "Count the refund tests.\nThen say how many." } }] },
			// The child has the deployment's other tools too.
			{ toolCalls: [{ name: "note", args: {} }] },
			{ text: "There are 12." },
			{ text: "The subagent found 12." },
		);
		expect(await run(parent.id, "How many refund tests? Use a subagent.")).toMatchObject({
			status: "answered",
			answer: "The subagent found 12.",
		});

		const [child, ...others] = await children(parent.id);
		expect(others).toEqual([]);
		expect(child).toMatchObject({
			agentId: "worker",
			projectId: PROJECT,
			workspaceId: "ws_shared",
			parentSessionId: parent.id,
			title: "Count the refund tests.",
			createdBy: { kind: "agent", agentId: "worker", sessionId: parent.id },
		});
		expect(child?.labels[SUBAGENT_DEPTH_LABEL]).toBe("1");
		const call = await toolItem(parent.id);
		expect(call?.kind === "tool" ? call.callId : undefined).toBe(child?.labels[SUBAGENT_CALL_LABEL]);
		expect(call?.kind === "tool" ? [call.status, call.output] : undefined).toEqual(["done", "There are 12."]);
		// The child's transcript is the task, its own tool call and its answer.
		const items = (await sessions.snapshot(ctx, child?.id ?? "")).items;
		expect(items.map((item) => item.kind)).toEqual(["user", "tool", "assistant"]);
		expect(items[0]?.kind === "user" ? items[0].text : undefined).toBe("Count the refund tests.\nThen say how many.");
	});

	it("nests a level at a time, and isn't offered to a session at the limit", async () => {
		const { script, sessions, create, run, children, toolItem } = await setUp();
		const top = await create();
		script.reply(
			{ toolCalls: [{ name: SUBAGENT_TOOL, args: { task: "Check refunds", title: "Refunds" } }] },
			{ toolCalls: [{ name: SUBAGENT_TOOL, args: { task: "Count partials", title: "Partials" } }] },
			{ text: "3 partial." },
			{ text: "Checked: 3 partial." },
			{ text: "Done." },
		);
		expect((await run(top.id, "Check")).answer).toBe("Done.");
		const [child] = await children(top.id);
		const [grandchild] = await children(child?.id ?? "");
		expect(grandchild).toMatchObject({ title: "Partials", workspaceId: "ws_shared" });
		expect(grandchild?.labels[SUBAGENT_DEPTH_LABEL]).toBe("2");
		expect(grandchild?.createdBy).toEqual({ kind: "agent", agentId: "worker", sessionId: child?.id });

		const deepest = await sessions.create(ctx, {
			projectId: PROJECT,
			agentId: "worker",
			parentSessionId: top.id,
			labels: { [SUBAGENT_DEPTH_LABEL]: String(MAX_SUBAGENT_DEPTH) },
		});
		expect(sessionSubagentTool(() => sessions, deepest)).toBeUndefined();
		script.reply({ toolCalls: [{ name: SUBAGENT_TOOL, args: { task: "Go deeper" } }] }, { text: "Couldn't" });
		await run(deepest.id, "Deeper");
		const refused = await toolItem(deepest.id);
		expect(refused?.kind === "tool" ? refused.status : undefined).toBe("error");
		expect(await children(deepest.id)).toEqual([]);
	});

	it("answers with an error, not an answer, when the child's run fails", async () => {
		const { script, create, run, toolItem } = await setUp();
		const parent = await create();
		script.reply(
			{ toolCalls: [{ name: SUBAGENT_TOOL, args: { task: "Break" } }] },
			() => {
				throw new Error("the model is down");
			},
			{ text: "The subagent failed." },
		);
		expect((await run(parent.id, "Try")).answer).toBe("The subagent failed.");
		const call = await toolItem(parent.id);
		expect(call?.kind === "tool" ? call.status : undefined).toBe("error");
		expect(call?.kind === "tool" ? call.output : undefined).toMatch(/^The subagent failed: /);
		expect(call?.kind === "tool" ? call.output : undefined).not.toBe(SUBAGENT_STOPPED);
	});

	it("reads a session's depth from its label, and titles a child from its task", () => {
		expect(subagentDepth({ labels: {} })).toBe(0);
		expect(subagentDepth({ parentSessionId: "s", labels: {} })).toBe(1);
		expect(subagentDepth({ parentSessionId: "s", labels: { [SUBAGENT_DEPTH_LABEL]: "3" } })).toBe(3);
		expect(subagentDepth({ parentSessionId: "s", labels: { [SUBAGENT_DEPTH_LABEL]: "0" } })).toBe(1);
		expect(subagentTitle("Find the flaky test\nthen fix it", undefined)).toBe("Find the flaky test");
		expect(subagentTitle("x", "  A title ")).toBe("A title");
		expect(subagentTitle("  ", undefined)).toBe("Subagent");
		expect(subagentTitle("a".repeat(200), undefined)).toHaveLength(80);
	});
});

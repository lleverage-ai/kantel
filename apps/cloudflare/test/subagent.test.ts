// Subagents on the stack (src/subagent.ts): the `subagent` tool runs a task in a child session of the same agent, on
// the parent's workspace, labelled with the call that started it, and answers with the child's final answer. Only with
// the switch on, and only for a top-level session.
import type { CallContext } from "@harbour/contracts";
import { createScriptedModel } from "@harbour/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { CODING_TOOLS } from "../src/coding-tools.ts";
import { gatewayConfig } from "../src/config.ts";
import { createStack, DEFAULT_AGENT_ID, type Stack } from "../src/stack.ts";
import { SUBAGENT_CALL_LABEL, SUBAGENT_TOOL, subagentsEnabled, subagentTitle } from "../src/subagent.ts";

const opened: Stack[] = [];
afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close();
});

async function setUp(subagents: boolean) {
	const { models, script } = createScriptedModel();
	const stack = await createStack({
		config: gatewayConfig({ HARBOUR_ADMIN_EMAIL: "tom@harbour.test" }),
		models: () => ({ models }),
		...(subagents ? { subagents: true } : {}),
	});
	opened.push(stack);
	const admin: CallContext = stack.admin;
	const sessions = stack.runtime.runtime;
	const run = async (sessionId: string, text: string) => {
		const prompt = await sessions.prompt(admin, sessionId, { text });
		return sessions.wait(admin, sessionId, prompt.id);
	};
	const create = () => sessions.create(admin, { projectId: stack.project.id, agentId: DEFAULT_AGENT_ID });
	return { stack, admin, script, sessions, run, create };
}

describe("subagents", () => {
	it("are off unless HARBOUR_SUBAGENTS is on, and the default profile names the tool only then", async () => {
		expect(subagentsEnabled({})).toBe(false);
		expect(subagentsEnabled({ HARBOUR_SUBAGENTS: "off" })).toBe(false);
		expect(subagentsEnabled({ HARBOUR_SUBAGENTS: " on " })).toBe(true);
		const off = await setUp(false);
		expect((await off.stack.runtime.profiles.get(off.admin, DEFAULT_AGENT_ID)).tools).toEqual([...CODING_TOOLS]);
		const on = await setUp(true);
		expect((await on.stack.runtime.profiles.get(on.admin, DEFAULT_AGENT_ID)).tools).toEqual([
			...CODING_TOOLS,
			SUBAGENT_TOOL,
		]);
	});

	it("runs the task in a child session on the parent's files and answers with the child's answer", async () => {
		const { stack, admin, script, sessions, run, create } = await setUp(true);
		const parent = await create();
		script.reply(
			{
				toolCalls: [
					{
						name: SUBAGENT_TOOL,
						args: { task: "Count the refund tests and say how many.", title: "Count refund tests" },
					},
				],
			},
			{ text: "There are 12 refund tests." },
			{ text: "The subagent found 12." },
		);
		const result = await run(parent.id, "How many refund tests are there? Use a subagent.");
		expect(result.answer).toBe("The subagent found 12.");

		const children = (await stack.runtime.directory.list(admin, { parentSessionId: parent.id })).items;
		expect(children).toHaveLength(1);
		const child = children[0];
		expect(child?.title).toBe("Count refund tests");
		expect(child?.agentId).toBe(DEFAULT_AGENT_ID);
		expect(child?.workspaceId).toBe(parent.workspaceId);
		expect(child?.createdBy).toEqual({ kind: "agent", agentId: DEFAULT_AGENT_ID, sessionId: parent.id });

		// The child's own transcript is the task and its answer, and the call's label names the call in the parent's.
		const childItems = (await sessions.snapshot(admin, child?.id ?? "")).items;
		expect(childItems.map((item) => item.kind)).toEqual(["user", "assistant"]);
		const call = (await sessions.snapshot(admin, parent.id)).items.find(
			(item) => item.kind === "tool" && item.name === SUBAGENT_TOOL,
		);
		expect(call?.kind === "tool" ? call.callId : undefined).toBe(child?.labels[SUBAGENT_CALL_LABEL]);
		expect(call?.kind === "tool" ? call.output : undefined).toBe("There are 12 refund tests.");
		expect(call?.kind === "tool" ? call.status : undefined).toBe("done");
	});

	it("isn't offered to a subagent's own session", async () => {
		const { stack, admin, script, sessions, create, run } = await setUp(true);
		const parent = await create();
		const child = await sessions.create(admin, {
			projectId: stack.project.id,
			agentId: DEFAULT_AGENT_ID,
			parentSessionId: parent.id,
		});
		// The child asks for a subagent of its own: the call fails, and no grandchild is started.
		script.reply({ toolCalls: [{ name: SUBAGENT_TOOL, args: { task: "Go deeper" } }] }, { text: "Couldn't" });
		await run(child.id, "Hi");
		const call = (await sessions.snapshot(admin, child.id)).items.find((item) => item.kind === "tool");
		expect(call?.kind === "tool" ? call.status : undefined).toBe("error");
		expect((await stack.runtime.directory.list(admin, { parentSessionId: child.id })).items).toEqual([]);
	});

	it("names a child after its task's first line when not given a title", () => {
		expect(subagentTitle("Find the flaky test\nthen fix it", undefined)).toBe("Find the flaky test");
		expect(subagentTitle("x", "  ")).toBe("x");
		expect(subagentTitle("  ", undefined)).toBe("Subagent");
		expect(subagentTitle("a".repeat(200), undefined)).toHaveLength(80);
	});
});

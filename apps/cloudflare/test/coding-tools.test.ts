// A session's coding tools on the stack (#196): the file tools work on its workspace directly, as its agent, and lease
// nothing; `bash` leases the session's isolate on its first command; closing the session releases only that lease.
import type { CallContext } from "@harbour/contracts";
import { createScriptedModel } from "@harbour/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { CODING_TOOLS } from "../src/coding-tools.ts";
import { gatewayConfig } from "../src/config.ts";
import { createStack, DEFAULT_AGENT_ID, type Stack } from "../src/stack.ts";

const opened: Stack[] = [];
afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close();
});

async function setUp() {
	const { models, script } = createScriptedModel();
	const stack = await createStack({
		config: gatewayConfig({ HARBOUR_ADMIN_EMAIL: "tom@harbour.test" }),
		models: () => ({ models }),
	});
	opened.push(stack);
	const admin: CallContext = stack.admin;
	const workspace = await stack.workspaces.create(admin, {
		owner: { kind: "project", organisationId: stack.organisation.id, projectId: stack.project.id },
		seed: { name: "s", sources: [{ kind: "files", files: { "notes/plan.md": "the plan\n" } }] },
	});
	const session = (workspaceId?: string) =>
		stack.runtime.runtime.create(admin, {
			projectId: stack.project.id,
			agentId: DEFAULT_AGENT_ID,
			...(workspaceId === undefined ? {} : { workspaceId }),
		});
	const run = async (sessionId: string, text: string) => {
		const prompt = await stack.runtime.runtime.prompt(admin, sessionId, { text });
		return stack.runtime.runtime.wait(admin, sessionId, prompt.id);
	};
	const live = (sessionId: string) => stack.sandboxes.sandboxes.leases(admin, { sessionId, live: true });
	/** What each tool answered in the last request the model got. */
	const toolResults = () =>
		script.requests
			.at(-1)
			?.messages.filter((message) => message.role === "tool")
			.map((message) => message.text) ?? [];
	return { stack, admin, script, workspace, session, run, live, toolResults };
}

describe("a session's coding tools", () => {
	it("the default profile names them", async () => {
		const { stack, admin } = await setUp();
		const profile = await stack.runtime.profiles.get(admin, DEFAULT_AGENT_ID);
		expect(profile.tools).toEqual([...CODING_TOOLS]);
	});

	it("read, write, edit and ls the workspace without an isolate; bash leases one; close releases it", async () => {
		const { stack, admin, script, workspace, session, run, live, toolResults } = await setUp();
		const created = await session(workspace.id);

		script.reply(
			{
				toolCalls: [
					{ name: "read", args: { path: "notes/plan.md" } },
					{ name: "write", args: { path: "notes/new.md", content: "first\n" } },
				],
			},
			{
				toolCalls: [{ name: "edit", args: { path: "notes/new.md", edits: [{ oldText: "first", newText: "second" }] } }],
			},
			{ toolCalls: [{ name: "ls", args: { path: "notes" } }] },
			{ text: "Done" },
		);
		expect(await run(created.id, "Edit the notes")).toMatchObject({ status: "answered", answer: "Done" });
		expect(toolResults().join("\n")).toContain("new.md\nplan.md");
		const read = await stack.workspaces.read(admin, workspace.id, "notes/new.md");
		expect(new TextDecoder().decode(read.content)).toBe("second\n");
		// The file tools leased nothing.
		expect(await live(created.id)).toEqual([]);

		// Every write was committed and audited as the session's agent.
		const commits = await stack.audit.query(admin, { type: "workspace.committed", sessionId: created.id });
		const agent = { kind: "agent", agentId: DEFAULT_AGENT_ID, sessionId: created.id };
		expect(commits.items.length).toBeGreaterThanOrEqual(2);
		for (const event of commits.items) expect(event.actor).toEqual(agent);

		script.reply({ toolCalls: [{ name: "bash", args: { command: "cat notes/new.md" } }] }, { text: "Ran" });
		expect(await run(created.id, "Show it")).toMatchObject({ status: "answered", answer: "Ran" });
		expect(toolResults().join("\n")).toContain("second");
		const leased = await live(created.id);
		expect(leased.map((lease) => [lease.sessionId, lease.tier])).toEqual([[created.id, "isolate"]]);

		await stack.runtime.runtime.close(admin, created.id);
		expect(await live(created.id)).toEqual([]);
	});

	it("keeps the file tools inside the workspace", async () => {
		const { script, workspace, session, run, live, toolResults } = await setUp();
		const created = await session(workspace.id);
		script.reply(
			{
				toolCalls: [
					{ name: "read", args: { path: "/etc/passwd" } },
					{ name: "write", args: { path: "../escape.txt", content: "x" } },
				],
			},
			{ text: "Refused" },
		);
		await run(created.id, "Escape");
		const [read, write] = toolResults();
		expect(read).not.toContain("root:");
		expect(read).toMatch(/permission|outside|denied/i);
		expect(write).toMatch(/permission|outside|denied/i);
		expect(await live(created.id)).toEqual([]);
	});

	it("are not offered to a session without a workspace, and nothing is leased", async () => {
		const { script, session, run, live, toolResults } = await setUp();
		const created = await session();
		script.reply({ toolCalls: [{ name: "bash", args: { command: "echo hi" } }] }, { text: "No tools" });
		await run(created.id, "Try");
		expect(toolResults()[0]).not.toBe("hi\n");
		expect(toolResults()[0]).toMatch(/Tool bash is not available/);
		expect(await live(created.id)).toEqual([]);
	});
});

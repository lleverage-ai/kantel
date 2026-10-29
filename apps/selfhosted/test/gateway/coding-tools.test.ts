// A session's coding tools on the self-hosted gateway (#196), as on Cloudflare: the file tools work on its workspace
// directly, as its agent, and lease nothing; `bash` leases the session's isolate on its first command; closing the
// session releases it. durable.stack.test.ts runs the same on Postgres and S3.
import { type CallContext, type SessionId, systemContext } from "@harbour/contracts";
import { createScriptedModel } from "@harbour/runtime/testing";
import { CODING_TOOLS } from "@harbour/sandbox/coding-tools";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap, createGatewayComponents, type GatewayComponents } from "../../src/gateway/components.ts";

const opened: GatewayComponents[] = [];
afterEach(async () => {
	for (const components of opened.splice(0)) await components.close();
});

async function setUp() {
	const { models, script } = createScriptedModel();
	const components = createGatewayComponents({ models: { models } });
	opened.push(components);
	const seeded = await bootstrap(components, { organisation: "Tools", project: "tools" });
	// The bootstrap's operator key, as the session API would authenticate it.
	const key = await components.identity.authenticateApiKey(
		{ ...systemContext("coding-tools-test"), organisationId: seeded.organisationId },
		seeded.apiKey,
	);
	const operator: CallContext = {
		actor: key.actor,
		organisationId: seeded.organisationId,
		projectId: seeded.projectId,
	};
	const { runtime } = components.runtime;
	const session = (workspaceId?: string) =>
		runtime.create(operator, {
			projectId: seeded.projectId,
			agentId: "echo",
			...(workspaceId === undefined ? {} : { workspaceId }),
		});
	const run = async (sessionId: SessionId, text: string) => {
		const prompt = await runtime.prompt(operator, sessionId, { text });
		return runtime.wait(operator, sessionId, prompt.id);
	};
	const live = (sessionId: SessionId) =>
		components.sandboxes.leases(
			{ ...systemContext("coding-tools-test"), organisationId: seeded.organisationId },
			{ sessionId, live: true },
		);
	const toolResults = () =>
		script.requests
			.at(-1)
			?.messages.filter((message) => message.role === "tool")
			.map((message) => message.text) ?? [];
	return { components, seeded, operator, script, session, run, live, toolResults };
}

describe("a session's coding tools on the self-hosted gateway", () => {
	it("the bootstrap's profile names them, on the isolate tier", async () => {
		const { components, operator } = await setUp();
		const profile = await components.runtime.profiles.get(operator, "echo");
		expect(profile.tools).toEqual([...CODING_TOOLS]);
		expect(profile.sandbox.tiers).toEqual(["isolate"]);
		expect(components.bindings.sandboxes).toMatch(/leased on first bash/);
	});

	it("read, write, edit and ls the workspace without an isolate; bash leases one; close releases it", async () => {
		const { components, seeded, operator, script, session, run, live, toolResults } = await setUp();
		const created = await session(seeded.workspaceId);

		script.reply(
			{
				toolCalls: [
					{ name: "read", args: { path: "README.md" } },
					{ name: "write", args: { path: "notes/new.md", content: "first\n" } },
				],
			},
			{
				toolCalls: [{ name: "edit", args: { path: "notes/new.md", edits: [{ oldText: "first", newText: "second" }] } }],
			},
			{ toolCalls: [{ name: "ls", args: {} }] },
			{ text: "Done" },
		);
		expect(await run(created.id, "Edit the notes")).toMatchObject({ status: "answered", answer: "Done" });
		expect(toolResults().join("\n")).toContain("README.md\nnotes/");
		const read = await components.workspaces.read(operator, seeded.workspaceId, "notes/new.md");
		expect(new TextDecoder().decode(read.content)).toBe("second\n");
		// The file tools leased nothing.
		expect(await live(created.id)).toEqual([]);

		// Every write was committed and audited as the session's agent.
		const commits = await components.audit.query(operator, { type: "workspace.committed", sessionId: created.id });
		expect(commits.items.length).toBeGreaterThanOrEqual(2);
		for (const event of commits.items) {
			expect(event.actor).toEqual({ kind: "agent", agentId: "echo", sessionId: created.id });
		}

		script.reply({ toolCalls: [{ name: "bash", args: { command: "cat notes/new.md" } }] }, { text: "Ran" });
		expect(await run(created.id, "Show it")).toMatchObject({ status: "answered", answer: "Ran" });
		expect(toolResults().join("\n")).toContain("second");
		const leased = await live(created.id);
		expect(leased.map((lease) => [lease.sessionId, lease.tier])).toEqual([[created.id, "isolate"]]);

		await components.runtime.runtime.close(operator, created.id);
		expect(await live(created.id)).toEqual([]);
	});

	it("keeps the file tools inside the workspace, and refuses the container tier", async () => {
		const { seeded, script, session, run, live, toolResults } = await setUp();
		const created = await session(seeded.workspaceId);
		script.reply(
			{
				toolCalls: [
					{ name: "read", args: { path: "/etc/passwd" } },
					{ name: "write", args: { path: "../escape.txt", content: "x" } },
				],
			},
			{ toolCalls: [{ name: "bash", args: { command: "python3 -c 'print(1)'" } }] },
			{ text: "Refused" },
		);
		await run(created.id, "Escape");
		// The last request carries every tool result so far: the two escapes, then the command.
		const [read, write, python] = toolResults();
		expect(python).toMatch(/no container tier/);
		expect(read).not.toContain("root:");
		expect(read).toMatch(/permission|outside|denied/i);
		expect(write).toMatch(/permission|outside|denied/i);
		// No isolate lease was held for the file tools; the refused command leased nothing that outlives it on the isolate.
		expect((await live(created.id)).filter((lease) => lease.tier === "isolate")).toEqual([]);
	});

	it("are not offered to a session without a workspace, and nothing is leased", async () => {
		const { script, session, run, live, toolResults } = await setUp();
		const created = await session();
		script.reply({ toolCalls: [{ name: "bash", args: { command: "echo hi" } }] }, { text: "No tools" });
		await run(created.id, "Try");
		expect(toolResults()[0]).toMatch(/Tool bash is not available/);
		expect(await live(created.id)).toEqual([]);
	});
});

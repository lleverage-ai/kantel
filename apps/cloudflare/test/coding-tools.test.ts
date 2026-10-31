// A session's coding tools on the stack (#196): the file tools work on its workspace directly, as its agent, and lease
// nothing; `bash` leases the session's isolate on its first command; closing the session releases only that lease.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { CallContext } from "@kantel/contracts";
import { createScriptedModel } from "@kantel/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
	CODING_TOOLS,
	commandTimeoutMs,
	DEFAULT_COMMAND_TIMEOUT_MS,
	MAX_COMMAND_TIMEOUT_MS,
	sessionWorkspaceId,
} from "../src/coding-tools.ts";
import { gatewayConfig } from "../src/config.ts";
import { createStack, DEFAULT_AGENT_ID, type Stack } from "../src/stack.ts";

const opened: Stack[] = [];
afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close();
});

/** QuickJS, compiled from the package's file, as the Worker gets it from wrangler. */
const nodeEngine = async () =>
	WebAssembly.compile(
		await readFile(createRequire(import.meta.url).resolve("@jitl/quickjs-wasmfile-release-sync/wasm")),
	);

async function setUp() {
	const { models, script } = createScriptedModel();
	const stack = await createStack({
		config: gatewayConfig({ KANTEL_ADMIN_EMAIL: "tom@harbour.test" }),
		models: () => ({ models }),
		nodeEngine,
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

	it("a session started without a workspace gets its own, made by its first tool call, not before", async () => {
		const { stack, admin, script, session, run, live, toolResults } = await setUp();
		const created = await session();
		expect(created.workspaceId).toBe(sessionWorkspaceId(created.id));
		const workspaceId = created.workspaceId ?? "";

		// Talking makes nothing.
		script.reply({ text: "Hello" });
		await run(created.id, "Hi");
		await expect(stack.workspaces.get(admin, workspaceId)).rejects.toMatchObject({ code: "not_found" });

		// The first file tool makes it, empty, in the session's project; a write lands in it without an isolate.
		script.reply(
			{ toolCalls: [{ name: "ls", args: {} }] },
			{ toolCalls: [{ name: "write", args: { path: "hello.txt", content: "hi\n" } }] },
			{ text: "Written" },
		);
		expect(await run(created.id, "Write")).toMatchObject({ status: "answered", answer: "Written" });
		const record = await stack.workspaces.get(admin, workspaceId);
		expect(record.owner).toEqual({
			kind: "project",
			organisationId: stack.organisation.id,
			projectId: stack.project.id,
		});
		const read = await stack.workspaces.read(admin, workspaceId, "hello.txt");
		expect(new TextDecoder().decode(read.content)).toBe("hi\n");
		expect(await live(created.id)).toEqual([]);

		// bash sees the write, in the isolate it leases now.
		script.reply({ toolCalls: [{ name: "bash", args: { command: "cat hello.txt" } }] }, { text: "Ran" });
		await run(created.id, "Show it");
		expect(toolResults().join("\n")).toContain("hi");
		expect((await live(created.id)).map((lease) => [lease.workspaceId, lease.tier])).toEqual([
			[workspaceId, "isolate"],
		]);
	});

	it("bounds every command's time", async () => {
		expect(commandTimeoutMs(undefined)).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
		expect(commandTimeoutMs(0)).toBe(DEFAULT_COMMAND_TIMEOUT_MS);
		expect(commandTimeoutMs(5_000)).toBe(5_000);
		expect(commandTimeoutMs(24 * 60 * 60_000)).toBe(MAX_COMMAND_TIMEOUT_MS);

		const { stack, script, session, run } = await setUp();
		const created = await session();
		const asked: (number | undefined)[] = [];
		const sandboxes = stack.sandboxes.sandboxes;
		const original = sandboxes.run.bind(sandboxes);
		sandboxes.run = (ctx, input) => {
			asked.push(input.request.timeoutMs);
			return original(ctx, input);
		};
		script.reply(
			{ toolCalls: [{ name: "bash", args: { command: "echo a" } }] },
			{ toolCalls: [{ name: "bash", args: { command: "echo b", timeout: 100_000 } }] },
			{ text: "Ran" },
		);
		await run(created.id, "Run");
		expect(asked).toEqual([DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS]);
	});

	it("a session's first command alone makes its workspace, and two sessions never share one", async () => {
		const { stack, admin, script, session, run, toolResults } = await setUp();
		const first = await session();
		const second = await session();
		expect(first.workspaceId).not.toBe(second.workspaceId);
		script.reply(
			{ toolCalls: [{ name: "bash", args: { command: "echo one > a.txt && cat a.txt" } }] },
			{ text: "Ran" },
		);
		await run(first.id, "Run");
		expect(toolResults().join("\n")).toContain("one");
		const written = await stack.workspaces.read(admin, first.workspaceId ?? "", "a.txt");
		expect(new TextDecoder().decode(written.content)).toBe("one\n");
		await expect(stack.workspaces.get(admin, second.workspaceId ?? "")).rejects.toMatchObject({ code: "not_found" });
	});

	it("writes a JavaScript file, runs it with node in the isolate, and keeps what it wrote", async () => {
		const { stack, admin, script, session, run, live, toolResults } = await setUp();
		const created = await session();
		const primes = [
			"const limit = Number(process.argv[2]);",
			"const primes = [];",
			"for (let n = 2; primes.length < limit; n++) if (primes.every((p) => n % p !== 0)) primes.push(n);",
			"console.log('first ' + limit + ' primes:', primes.join(', '));",
		].join("\n");
		script.reply(
			{ toolCalls: [{ name: "write", args: { path: "primes.js", content: primes } }] },
			{ toolCalls: [{ name: "bash", args: { command: "node primes.js 10 | tee primes.txt" } }] },
			{ text: "Ran" },
		);
		await run(created.id, "Write and run a script");
		expect(toolResults().join("\n")).toContain("first 10 primes: 2, 3, 5, 7, 11, 13, 17, 19, 23, 29");
		expect(await live(created.id)).toHaveLength(1);
		const saved = await stack.workspaces.read(admin, created.workspaceId ?? "", "primes.txt");
		expect(new TextDecoder().decode(saved.content)).toContain("29");
	});

	it("refuses python, which needs the container tier", async () => {
		const { script, session, run, toolResults } = await setUp();
		const created = await session();
		script.reply({ toolCalls: [{ name: "bash", args: { command: "python3 -c 'print(1)'" } }] }, { text: "Ran" });
		await run(created.id, "Run");
		expect(toolResults().join("\n")).toContain("container tier");
	});
});

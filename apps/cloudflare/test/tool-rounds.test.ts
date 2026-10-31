// Tool calls a model makes in one step (one round) that change the session's workspace or run commands are barriers:
// each runs alone, in the order the model made the calls, so a command sees a file written before it (seen on
// harbour.myslop.app, 30 Oct 2026: `write hello.py` and `bash python3 hello.py` in one step, and python3 found no
// file). Consecutive read-only calls between them still run at once (Kantel's Pi Durable patch, partitioned rounds).
// A session's workspace, isolate and container are each made once however many calls first need them.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { CallContext } from "@kantel/contracts";
import { createScriptedModel } from "@kantel/runtime/testing";
import { afterEach, describe, expect, it } from "vitest";
import { codingTools } from "../src/coding-tools.ts";
import { gatewayConfig } from "../src/config.ts";
import { createStack, DEFAULT_AGENT_ID, type Stack } from "../src/stack.ts";
import { type FakeRun, fakePrograms, fakeSandboxContainers } from "./sandbox-container.ts";

const opened: Stack[] = [];
afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close();
});

const HELLO = 'print("hello from python")\n';

/** `fakePrograms`, plus a `python3` that "runs" a file by printing what it holds, failing as python3 does without it. */
const programs: FakeRun = (command, files) => {
	const [program, script] = command.trim().split(/\s+/);
	if (program !== "python3") return fakePrograms(command, files);
	const source = files.get(script ?? "");
	if (source === undefined) {
		return {
			exitCode: 2,
			stderr: `python3: can't open file '/workspace/${script}': [Errno 2] No such file or directory\n`,
		};
	}
	return { exitCode: 0, stdout: `ran ${script}: ${source}` };
};

async function setUp() {
	const { models, script } = createScriptedModel();
	const fakes = fakeSandboxContainers(programs);
	const stack = await createStack({
		config: gatewayConfig({ KANTEL_ADMIN_EMAIL: "tom@harbour.test" }),
		models: () => ({ models }),
		sandboxContainers: fakes.containers,
	});
	opened.push(stack);
	const admin: CallContext = stack.admin;
	// No workspace: the session's own is made by its first tool call, and its isolate and container by its first
	// commands, all within the round below (lazy acquisition).
	const session = () => stack.runtime.runtime.create(admin, { projectId: stack.project.id, agentId: DEFAULT_AGENT_ID });
	const run = async (sessionId: string, text: string) => {
		const prompt = await stack.runtime.runtime.prompt(admin, sessionId, { text });
		return stack.runtime.runtime.wait(admin, sessionId, prompt.id);
	};
	const live = (sessionId: string) => stack.sandboxes.sandboxes.leases(admin, { sessionId, live: true });
	/** What each tool answered in the last request the model got, in call order. */
	const toolResults = () =>
		script.requests
			.at(-1)
			?.messages.filter((message) => message.role === "tool")
			.map((message) => message.text) ?? [];
	return { stack, admin, script, fakes, session, run, live, toolResults };
}

describe("one round's tool calls on the session's workspace", () => {
	it("write hello.py then bash python3 hello.py, in one step: python3 finds the file (container tier)", async () => {
		const { stack, admin, script, fakes, session, run, live, toolResults } = await setUp();
		const created = await session();
		script.reply(
			{
				toolCalls: [
					{ name: "write", args: { path: "hello.py", content: HELLO } },
					{ name: "bash", args: { command: "python3 hello.py" } },
				],
			},
			{ text: "Done" },
		);
		expect(await run(created.id, "Write hello.py and run it")).toMatchObject({ status: "answered" });
		const [write, bash] = toolResults();
		expect(write).toContain("hello.py");
		expect(bash).not.toContain("Errno 2");
		expect(bash).toContain(`ran hello.py: ${HELLO}`);
		expect(fakes.of(created.id).execs).toEqual(["python3 hello.py"]);
		expect((await live(created.id)).map((lease) => lease.tier)).toEqual(["container"]);
		const saved = await stack.workspaces.read(admin, created.workspaceId ?? "", "hello.py");
		expect(new TextDecoder().decode(saved.content)).toBe(HELLO);
	});

	it("write then bash in the isolate, in one step: the command sees the file", async () => {
		const { script, session, run, toolResults } = await setUp();
		const created = await session();
		script.reply(
			{
				toolCalls: [
					{ name: "write", args: { path: "notes.txt", content: "first\n" } },
					{ name: "bash", args: { command: "cat notes.txt" } },
					{ name: "edit", args: { path: "notes.txt", edits: [{ oldText: "first", newText: "second" }] } },
					{ name: "bash", args: { command: "cat notes.txt" } },
				],
			},
			{ text: "Done" },
		);
		await run(created.id, "Write, show, edit, show");
		const [, firstCat, , secondCat] = toolResults();
		expect(firstCat).toContain("first");
		expect(secondCat).toContain("second");
	});

	it("bash writes a file and read reads it, in one step: read finds it", async () => {
		const { script, session, run, toolResults } = await setUp();
		const created = await session();
		script.reply(
			{
				toolCalls: [
					{ name: "bash", args: { command: "mkdir -p out && echo made > out/result.txt" } },
					{ name: "read", args: { path: "out/result.txt" } },
				],
			},
			{ text: "Done" },
		);
		await run(created.id, "Make and read");
		const [, read] = toolResults();
		expect(read).toContain("made");
		expect(read).not.toMatch(/not found/i);
	});
});

describe("tool concurrency classes", () => {
	it("makes write, edit and bash barriers, and leaves read and ls to run at once", () => {
		const modes = Object.fromEntries(codingTools().map((tool) => [tool.name, tool.executionMode]));
		expect(modes).toEqual({
			read: undefined,
			ls: undefined,
			write: "sequential",
			edit: "sequential",
			bash: "sequential",
		});
	});

	it("runs reads at once, and a write alone between them", async () => {
		const { stack, script, session, run, toolResults } = await setUp();
		const created = await session();
		script.reply(
			{ toolCalls: [{ name: "write", args: { path: "a.txt", content: "A\n" } }] },
			{ toolCalls: [{ name: "write", args: { path: "b.txt", content: "B\n" } }] },
			{ text: "Written" },
		);
		await run(created.id, "Write two files");

		// Each workspace read waits (a little) for another to start, and the most in flight at once is counted.
		const workspaces = stack.workspaces;
		const read = workspaces.read.bind(workspaces);
		let inFlight = 0;
		let most = 0;
		workspaces.read = async (...args: Parameters<typeof read>) => {
			inFlight++;
			most = Math.max(most, inFlight);
			for (let waited = 0; inFlight < 2 && waited < 200; waited += 10) await new Promise((r) => setTimeout(r, 10));
			try {
				return await read(...args);
			} finally {
				inFlight--;
			}
		};
		const both = {
			toolCalls: [
				{ name: "read", args: { path: "a.txt" } },
				{ name: "read", args: { path: "b.txt" } },
			],
		};
		script.reply(both, { text: "Read" });
		await run(created.id, "Read both");
		expect(toolResults().slice(-2)).toEqual(["A\n", "B\n"]);
		expect(most).toBe(2);

		most = 0;
		script.reply(
			{
				toolCalls: [
					{ name: "read", args: { path: "a.txt" } },
					{ name: "write", args: { path: "c.txt", content: "C\n" } },
					{ name: "read", args: { path: "b.txt" } },
				],
			},
			{ text: "Done" },
		);
		await run(created.id, "Read, write, read");
		expect(most).toBe(1);

		// Read, read, write, read, read: [read, read] [write] [read, read]. The reads either side of the write run two at
		// once, and those after it see what it wrote.
		most = 0;
		script.reply(
			{
				toolCalls: [
					{ name: "read", args: { path: "a.txt" } },
					{ name: "read", args: { path: "b.txt" } },
					{ name: "write", args: { path: "a.txt", content: "A2\n" } },
					{ name: "read", args: { path: "a.txt" } },
					{ name: "read", args: { path: "c.txt" } },
				],
			},
			{ text: "Done" },
		);
		await run(created.id, "Read, read, write, read, read");
		const results = toolResults().slice(-5);
		expect([results[0], results[1], results[3], results[4]]).toEqual(["A\n", "B\n", "A2\n", "C\n"]);
		expect(results[2]).toContain("a.txt");
		expect(most).toBe(2);
	});
});

describe("lazy acquisition, from concurrent first calls", () => {
	it("two first commands at once make one workspace, one container lease and one container start", async () => {
		const { stack, admin, fakes, session } = await setUp();
		const created = await session();
		const workspaceId = created.workspaceId ?? "";
		const env = stack.environment(created);
		if (env === undefined) throw new Error("the session has no environment");
		const context = BACKGROUND_CONTEXT;
		// The session's own workspace doesn't exist yet: a write and a command race to make it, and get the same one.
		const [written, echoed] = await Promise.all([
			env.writeFile("hello.py", HELLO, context),
			env.exec("echo hi", {}, context),
		]);
		expect(written.ok).toBe(true);
		expect(echoed.ok && echoed.value.exitCode).toBe(0);
		expect((await stack.workspaces.get(admin, workspaceId)).id).toBe(workspaceId);
		// hello.py was written before the session had a container. Two commands race to acquire its container lease and
		// start it: they share one of each, and both see the file.
		const [one, two] = await Promise.all([
			env.exec("python3 hello.py", {}, context),
			env.exec("python3 hello.py", {}, context),
		]);
		for (const result of [one, two]) {
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value.exitCode).toBe(0);
		}
		const leases = await stack.sandboxes.sandboxes.leases(admin, { sessionId: created.id, live: true });
		expect(leases.map((lease) => [lease.tier, lease.workspaceId])).toEqual([
			["isolate", workspaceId],
			["container", workspaceId],
		]);
		expect(fakes.of(created.id).starts).toBe(1);
	});
});

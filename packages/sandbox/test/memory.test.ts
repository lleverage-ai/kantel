import type { CallContext, SessionEnd, SessionEndHook, SessionTeardown } from "@kantel/contracts";
import { createMemorySandboxes } from "@kantel/sandbox/memory";
import { createMemoryProjectFiles, createMemoryWorkspaces } from "@kantel/workspace/memory";
import { describe, expect, it } from "vitest";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };

async function setUp() {
	const projectFiles = createMemoryProjectFiles();
	await projectFiles.seed("proj-1", { "README.md": "readme", "src/a.ts": "a" });
	const workspaces = createMemoryWorkspaces({ sources: [projectFiles] });
	const record = await workspaces.create(ctx, {
		owner: { kind: "organisation", organisationId: "org-1" },
		seed: { name: "s", sources: [{ kind: "files", files: { "docs/one.md": "one", "top.txt": "top" } }] },
		mounts: [{ path: "/project", source: "project-files", ref: "proj-1" }],
	});
	const sandboxes = createMemorySandboxes({ workspaces });
	const lease = await sandboxes.acquire(ctx, { sessionId: "sess-1", workspaceId: record.id, tier: "isolate" });
	const exec = (command: string | readonly string[], extra: { cwd?: string; stdin?: string } = {}) =>
		sandboxes.exec(ctx, lease.id, { command, ...extra });
	return { workspaces, sandboxes, record, exec };
}

describe("the in-memory shell", () => {
	it("runs echo, printf, cat, ls and cd", async () => {
		const { exec } = await setUp();
		expect((await exec("echo a  b")).stdout).toBe("a b\n");
		expect((await exec("echo -n a")).stdout).toBe("a");
		expect((await exec("printf '%s-%s\\n' a b c")).stdout).toBe("a-b\nc-\n");
		expect((await exec("printf 'x%%\\t'")).stdout).toBe("x%\t");
		expect((await exec("cat docs/one.md top.txt")).stdout).toBe("onetop");
		expect((await exec("cat", { stdin: "piped" })).stdout).toBe("piped");
		expect((await exec("ls")).stdout).toBe("docs\ntop.txt\n");
		expect((await exec("ls /project")).stdout).toBe("README.md\nsrc\n");
		expect((await exec("cd docs && ls && cat ../top.txt")).stdout).toBe("one.md\ntop");
		expect((await exec("cd /project/src && cat a.ts")).stdout).toBe("a");
		expect((await exec("ls", { cwd: "docs" })).stdout).toBe("one.md\n");
	});

	it("reports missing files, directories and unknown commands like sh", async () => {
		const { exec } = await setUp();
		expect(await exec("cat missing.txt")).toMatchObject({
			exitCode: 1,
			stderr: "cat: missing.txt: No such file or directory\n",
		});
		expect(await exec("cat docs")).toMatchObject({ exitCode: 1, stderr: "cat: docs: Is a directory\n" });
		expect(await exec("ls nope")).toMatchObject({ exitCode: 2 });
		expect(await exec("frobnicate")).toMatchObject({ exitCode: 127, stderr: "sh: frobnicate: command not found\n" });
		expect(await exec("cd ..")).toMatchObject({ exitCode: 2 });
		expect(await exec("mkdir a/b")).toMatchObject({ exitCode: 1 });
		expect(await exec("printf x > top.txt/inner")).toMatchObject({ exitCode: 1 });
		expect(await exec("printf x > /tmp/x")).toMatchObject({
			exitCode: 1,
			stderr: "sh: cannot create /tmp/x: Permission denied\n",
		});
	});

	it("refuses syntax it does not model with exit code 2 and changes nothing", async () => {
		const { exec, workspaces, record } = await setUp();
		for (const command of ["echo $HOME", "cat *.md", "true || false", "echo a | cat", "true; false", "true &&"]) {
			expect((await exec(command)).exitCode, command).toBe(2);
		}
		expect((await workspaces.get(ctx, record.id)).head).toBe(record.head);
	});

	it("runs an argv array without a shell", async () => {
		const { exec } = await setUp();
		expect(await exec(["cat", "top.txt"])).toMatchObject({ exitCode: 0, stdout: "top" });
		expect(await exec(["echo", "a && b"])).toMatchObject({ stdout: "a && b\n" });
	});

	it("keeps files written before a failing step and commits them", async () => {
		const { exec, workspaces, record } = await setUp();
		const result = await exec("printf a > kept.txt && printf b > /project/README.md");
		expect(result.exitCode).toBe(1);
		expect(result.workspaceVersion).toBe(record.head + 1);
		expect(new TextDecoder().decode((await workspaces.read(ctx, record.id, "kept.txt")).content)).toBe("a");
	});
});

describe("createMemorySandboxes with a session-end hook", () => {
	it("registers releaseSession once as the sandbox teardown, which ends the session's leases", async () => {
		const registered: [string, SessionTeardown][] = [];
		const sessionEnd: SessionEndHook = {
			register(name, teardown) {
				registered.push([name, teardown]);
				return { close: async () => {} };
			},
		};
		const workspaces = createMemoryWorkspaces();
		const record = await workspaces.create(ctx, { owner: { kind: "organisation", organisationId: "org-1" } });
		const sandboxes = createMemorySandboxes({ workspaces, sessionEnd });
		expect(registered.map(([name]) => name)).toEqual(["sandbox"]);

		const lease = await sandboxes.acquire(ctx, { sessionId: "sess-1", workspaceId: record.id, tier: "isolate" });
		const other = await sandboxes.acquire(ctx, { sessionId: "sess-2", workspaceId: record.id, tier: "isolate" });
		const end: SessionEnd = {
			sessionId: "sess-1",
			organisationId: "org-1",
			projectId: "proj-1",
			agentId: "agent-1",
			reason: "aborted",
			endedBy: ctx.actor,
			at: 0,
		};
		const teardown = registered[0]![1];
		await teardown({ actor: { kind: "system", component: "session-end" }, organisationId: "org-1" }, end);
		expect((await sandboxes.leases(ctx, { sessionId: "sess-1" })).map((ended) => [ended.id, ended.endReason])).toEqual([
			[lease.id, "aborted"],
		]);
		expect((await sandboxes.leases(ctx, { sessionId: "sess-2", live: true })).map((live) => live.id)).toEqual([
			other.id,
		]);
	});
});

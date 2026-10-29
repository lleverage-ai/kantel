/**
 * The environment's file operations go straight to the workspace (#196): they never lease a sandbox, they keep the
 * workspace's scoping (paths, mounts) and audit, and they refuse files over `maxFileBytes`. Only a command leases one,
 * and releasing the session releases only what it leased.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { CallContext } from "@harbour/contracts";
import { createInProcessIsolateBackend } from "@harbour/sandbox/isolate";
import { createSandboxExecutionEnv } from "@harbour/sandbox/pi-env";
import { createTieredSandboxes } from "@harbour/sandbox/tiered";
import { RecordingAuditSink } from "@harbour/testing/harness";
import { createMemoryProjectFiles } from "@harbour/workspace/memory";
import { createMemoryWorkspaceStore, createStoredWorkspaces } from "@harbour/workspace/stored";
import { describe, expect, it } from "vitest";
import { SimulatedContainer } from "./backends.ts";

const ORG = "org-1";
const human: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: ORG };
const agent = (sessionId: string): CallContext => ({
	actor: { kind: "agent", agentId: "worker", sessionId },
	organisationId: ORG,
});
const context = BACKGROUND_CONTEXT;
const MAX = 64;

async function setUp() {
	const audit = new RecordingAuditSink();
	const projectFiles = createMemoryProjectFiles();
	await projectFiles.seed("proj-1", { "README.md": "readme\n" });
	const workspaces = createStoredWorkspaces({ store: createMemoryWorkspaceStore(), sources: [projectFiles], audit });
	const record = await workspaces.create(human, {
		owner: { kind: "organisation", organisationId: ORG },
		seed: {
			name: "s",
			sources: [{ kind: "files", files: { "notes/plan.md": "plan\n", "big.txt": "x".repeat(MAX + 1) } }],
		},
		mounts: [{ path: "/project", source: "project-files", ref: "proj-1" }],
	});
	const sandboxes = createTieredSandboxes({
		workspaces,
		isolate: createInProcessIsolateBackend(workspaces),
		container: new SimulatedContainer(workspaces),
	});
	const envFor = (sessionId: string) =>
		createSandboxExecutionEnv({
			ctx: agent(sessionId),
			sessionId,
			workspaceId: record.id,
			sandboxes,
			workspaces,
			maxFileBytes: MAX,
		});
	const live = async (sessionId: string) => sandboxes.leases(human, { sessionId, live: true });
	return { audit, workspaces, record, sandboxes, envFor, live };
}

describe("the environment's file operations, straight on the workspace", () => {
	it("read, write, edit and list without leasing a sandbox; a command leases one, and only that is released", async () => {
		const { envFor, live, sandboxes } = await setUp();
		const env = envFor("sess-files");

		expect(getOrThrow(await env.readTextFile("notes/plan.md", context))).toBe("plan\n");
		getOrThrow(await env.writeFile("notes/new.md", "new\n", context));
		getOrThrow(await env.appendFile("notes/new.md", "more\n", context));
		getOrThrow(await env.renameFile("notes/new.md", "notes/moved.md", context));
		const listed = getOrThrow(await env.listDir("notes", context)).map((entry) => entry.name);
		expect(listed.sort()).toEqual(["moved.md", "plan.md"]);
		expect(getOrThrow(await env.readTextFile("/project/README.md", context))).toBe("readme\n");
		getOrThrow(await env.remove("notes/moved.md", undefined, context));
		expect(await live("sess-files")).toEqual([]);

		// Releasing a session that never ran a command changes nothing.
		await sandboxes.releaseSession(human, "sess-files");
		expect(await sandboxes.leases(human, { sessionId: "sess-files" })).toEqual([]);

		// The first command leases one sandbox, for this session only.
		const shell = envFor("sess-shell");
		const ran = getOrThrow(await shell.exec("cat notes/plan.md", {}, context));
		expect(ran.exitCode).toBe(0);
		const leased = await live("sess-shell");
		expect(leased.map((lease) => [lease.sessionId, lease.tier])).toEqual([["sess-shell", "isolate"]]);
		expect(await live("sess-files")).toEqual([]);

		await sandboxes.releaseSession(human, "sess-files");
		expect(await live("sess-shell")).toHaveLength(1);
		await sandboxes.releaseSession(human, "sess-shell");
		expect(await live("sess-shell")).toEqual([]);
	});

	it("audits every write as the session's agent", async () => {
		const { envFor, audit } = await setUp();
		const env = envFor("sess-audit");
		getOrThrow(await env.writeFile("a.txt", "a", context));
		getOrThrow(await env.appendFile("a.txt", "b", context));
		const commits = audit.ofType("workspace.committed").filter((event) => event.actor.kind === "agent");
		expect(commits).toHaveLength(2);
		for (const event of commits) {
			expect(event.actor).toEqual({ kind: "agent", agentId: "worker", sessionId: "sess-audit" });
		}
	});

	it("keeps paths inside the workspace and its mounts, and mounts read-only", async () => {
		const { envFor, workspaces, record, audit } = await setUp();
		const env = envFor("sess-paths");
		const code = async (result: Promise<{ ok: boolean; error?: { code: string } }>) => {
			const settled = await result;
			return settled.ok ? "ok" : settled.error?.code;
		};
		expect(await code(env.readTextFile("../outside.txt", context))).toBe("permission_denied");
		expect(await code(env.readTextFile("/workspace/../etc/passwd", context))).toBe("permission_denied");
		expect(await code(env.readTextFile("/etc/passwd", context))).toBe("permission_denied");
		expect(await code(env.writeFile("../escape.txt", "x", context))).toBe("permission_denied");
		expect(await code(env.writeFile("/project/README.md", "changed", context))).toBe("permission_denied");
		expect(await code(env.createDir("/project/new", undefined, context))).toBe("permission_denied");
		expect((await workspaces.get(human, record.id)).head).toBe(record.head);
		expect(audit.ofType("workspace.write.refused").length).toBeGreaterThan(0);
	});

	it("refuses a file over maxFileBytes, reading or writing, and commits nothing", async () => {
		const { envFor, workspaces, record } = await setUp();
		const env = envFor("sess-size");
		const read = await env.readTextFile("big.txt", context);
		expect(read.ok ? undefined : read.error.code).toBe("invalid");
		const write = await env.writeFile("too-big.txt", "y".repeat(MAX + 1), context);
		expect(write.ok ? undefined : write.error.code).toBe("invalid");
		getOrThrow(await env.writeFile("edge.txt", "z".repeat(MAX), context));
		const head = (await workspaces.get(human, record.id)).head;
		const append = await env.appendFile("edge.txt", "z", context);
		expect(append.ok ? undefined : append.error.code).toBe("invalid");
		const truncate = await env.truncateFile("edge.txt", MAX + 1, context);
		expect(truncate.ok ? undefined : truncate.error.code).toBe("invalid");
		expect((await workspaces.get(human, record.id)).head).toBe(head);
		expect(getOrThrow(await env.readTextFile("edge.txt", context))).toBe("z".repeat(MAX));
	});

	it("is refused another organisation's workspace", async () => {
		const { workspaces, sandboxes, record, live } = await setUp();
		const env = createSandboxExecutionEnv({
			ctx: { actor: { kind: "agent", agentId: "worker", sessionId: "sess-other" }, organisationId: "org-2" },
			sessionId: "sess-other",
			workspaceId: record.id,
			sandboxes,
			workspaces,
		});
		const read = await env.readTextFile("notes/plan.md", context);
		expect(read.ok).toBe(false);
		const write = await env.writeFile("x.txt", "x", context);
		expect(write.ok).toBe(false);
		expect((await workspaces.get(human, record.id)).head).toBe(record.head);
		expect(await live("sess-other")).toEqual([]);
	});
});

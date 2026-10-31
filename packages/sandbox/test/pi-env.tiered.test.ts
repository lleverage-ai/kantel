/**
 * The Pi Durable ExecutionEnv over the tiered sandboxes: the real just-bash isolate tier and the simulated container,
 * on stored workspaces. Pi's file tools, the isolate and the container all see one tree.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import type { CallContext } from "@kantel/contracts";
import { createInProcessIsolateBackend } from "@kantel/sandbox/isolate";
import { createSandboxExecutionEnv, type SandboxExecRecord } from "@kantel/sandbox/pi-env";
import { createTieredSandboxes } from "@kantel/sandbox/tiered";
import { createMemoryProjectFiles } from "@kantel/workspace/memory";
import { createMemoryWorkspaceStore, createStoredWorkspaces } from "@kantel/workspace/stored";
import { describe, expect, it } from "vitest";
import { SimulatedContainer } from "./backends.ts";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const context = BACKGROUND_CONTEXT;
const decoder = new TextDecoder();

async function setUp() {
	const projectFiles = createMemoryProjectFiles();
	await projectFiles.seed("proj-1", { "README.md": "readme\n" });
	const workspaces = createStoredWorkspaces({ store: createMemoryWorkspaceStore(), sources: [projectFiles] });
	const record = await workspaces.create(ctx, {
		owner: { kind: "organisation", organisationId: "org-1" },
		seed: { name: "s", sources: [{ kind: "files", files: { "notes/plan.md": "plan\n" } }] },
		mounts: [{ path: "/project", source: "project-files", ref: "proj-1" }],
	});
	const container = new SimulatedContainer(workspaces);
	const sandboxes = createTieredSandboxes({
		workspaces,
		isolate: createInProcessIsolateBackend(workspaces),
		container,
	});
	const records: SandboxExecRecord[] = [];
	const env = createSandboxExecutionEnv({
		ctx,
		sessionId: "sess-1",
		workspaceId: record.id,
		sandboxes,
		workspaces,
		onExec: (execRecord) => {
			records.push(execRecord);
		},
	});
	const read = async (path: string) => decoder.decode((await workspaces.read(ctx, record.id, path)).content);
	return { env, record, records, sandboxes, workspaces, read };
}

describe("createSandboxExecutionEnv over the tiered sandboxes", () => {
	it("shares one tree between Pi's file tools, the isolate's shell and the container", async () => {
		const { env, records, read } = await setUp();

		// A file tool writes; the isolate's pipeline reads it and writes its own file.
		getOrThrow(await env.writeFile("data.json", '{"items":[1,2,3]}', context));
		const piped = getOrThrow(
			await env.exec("jq '.items | length' data.json > count.txt && cat count.txt", {}, context),
		);
		expect(piped.exitCode).toBe(0);
		expect(records.at(-1)?.tier).toBe("isolate");
		expect(getOrThrow(await env.readTextFile("count.txt", context)).trim()).toBe("3");

		// The container, on its first command, sees the isolate's last write.
		const escalated = getOrThrow(await env.exec("git --version && cat count.txt", {}, context));
		expect(records.at(-1)?.tier).toBe("container");
		expect(escalated.exitCode).toBe(0);

		// The container writes; routing the next command back to the isolate checkpoints it first.
		getOrThrow(await env.exec("git --version && printf from-container > notes/c.txt", {}, context));
		const back = getOrThrow(await env.exec("cat notes/c.txt", {}, context));
		expect(records.at(-1)?.tier).toBe("isolate");
		expect(back.exitCode).toBe(0);
		expect(await read("notes/c.txt")).toBe("from-container");
		expect(getOrThrow(await env.readTextFile("notes/c.txt", context))).toBe("from-container");
	});

	it("reads /project from the shell and file tools, and refuses writes to it", async () => {
		const { env, read, workspaces, record } = await setUp();
		expect(getOrThrow(await env.readTextFile("/project/README.md", context))).toBe("readme\n");
		const write = await env.writeFile("/project/README.md", "changed", context);
		expect(write.ok ? undefined : write.error.code).toBe("permission_denied");
		const shell = getOrThrow(await env.exec("cat /project/README.md; echo x > /project/new.txt", {}, context));
		expect(shell.exitCode).not.toBe(0);
		expect(await read("notes/plan.md")).toBe("plan\n");
		expect((await workspaces.get(ctx, record.id)).head).toBe(record.head);
	});
});

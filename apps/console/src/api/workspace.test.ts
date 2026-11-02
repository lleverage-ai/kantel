// The console's file browser against the real workspace read API (`@kantel/workspace/read-api`) and session API, in
// process, with every component auditing into one store, as the gateway's stack does. Browsing a whole workspace,
// every directory listed and every file read, leaves no sandbox event in the audit log; acquiring a sandbox directly
// does leave one, so the check would see it.
import { createMemoryAuditStore } from "@kantel/audit/memory";
import type { AgentProfile, Authentication, CallContext } from "@kantel/contracts";
import { createSessionApi, staticTokenAuthenticator } from "@kantel/runtime/http";
import { createMemoryRuntime } from "@kantel/runtime/memory";
import { createScriptedModel } from "@kantel/runtime/testing";
import { createMemorySandboxes } from "@kantel/sandbox/memory";
import { textOf } from "@kantel/ui";
import { createMemoryWorkspaces } from "@kantel/workspace/memory";
import { createWorkspaceReadApi } from "@kantel/workspace/read-api";
import { afterEach, describe, expect, it } from "vitest";
import { contentOf } from "../ui/files-model.ts";
import type { WorkspaceFiles } from "./client.ts";
import { createApiClient } from "./http.ts";

const ORG = "org-console";
const tom: Authentication = { actor: { kind: "service", serviceId: "tom" }, organisationId: ORG };
const ctx: CallContext = { actor: tom.actor, organisationId: ORG };
const BASE = "https://kantel.test/v1";

const profile: AgentProfile = {
	id: "worker",
	organisationId: ORG,
	name: "Worker",
	model: { route: "default" },
	promptLayers: [],
	tools: [],
	skills: [],
	sandbox: { tiers: ["isolate"] },
	memoryScopes: [],
};

const FILES: Record<string, string | Uint8Array> = {
	"README.md": "# billing-sync\n\nThe nightly job.\n",
	"notes/plan.md": "# Plan\n\n- [x] Reproduce\n- [ ] Hand back\n",
	"notes/archive/2026-10.md": "Older notes.\n",
	"src/billing/retry.ts": "export const attempts = 5;\n",
	"assets/blob.dat": new Uint8Array([0, 1, 2, 3, 255]),
	"big.txt": "x".repeat(2048),
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setUp() {
	const audit = createMemoryAuditStore();
	const memory = createMemoryRuntime({ audit, models: createScriptedModel().models });
	const workspaces = createMemoryWorkspaces({ audit });
	const sandboxes = createMemorySandboxes({ workspaces, audit });
	const sessions = createSessionApi({
		...memory,
		authenticator: staticTokenAuthenticator({ tom }),
		keepAliveMs: 60_000,
	});
	// A small content limit, so a too-large file can be tried without making one.
	const files = createWorkspaceReadApi({ workspaces, authenticate: async () => ctx, maxContentBytes: 1024 });
	cleanups.push(async () => {
		await sessions.close();
		await memory.close();
	});
	await memory.profiles.put(ctx, profile);

	const owner = { kind: "project", organisationId: ORG, projectId: "proj-a" } as const;
	const workspace = await workspaces.create(ctx, { owner });
	await workspaces.commit(ctx, workspace.id, {
		baseVersion: workspace.head,
		changes: Object.entries(FILES).map(([path, content]) => ({ op: "put", path, content })),
	});
	const withFiles = await memory.runtime.create(ctx, {
		projectId: "proj-a",
		agentId: "worker",
		title: "Has files",
		workspaceId: workspace.id,
	});
	const without = await memory.runtime.create(ctx, { projectId: "proj-a", agentId: "worker", title: "No files" });

	const client = createApiClient({
		baseUrl: BASE,
		headers: () => ({ authorization: "Bearer tom" }),
		fetch: async (input, init) => {
			const request = new Request(input, init);
			return (await files(request)) ?? sessions.fetch(request);
		},
	});
	return { audit, sandboxes, client, workspace, withFiles: withFiles.id, without: without.id };
}

/** Lists every directory from the root down and reads every file, as a person clicking through the tree would. */
async function browseAll(files: WorkspaceFiles): Promise<{ directories: string[]; read: string[] }> {
	const directories: string[] = [];
	const read: string[] = [];
	const queue = [""];
	while (queue.length > 0) {
		const directory = queue.shift() ?? "";
		directories.push(directory);
		const { entries } = await files.list(directory);
		for (const entry of entries) {
			if (entry.kind === "directory") queue.push(entry.path);
			else {
				await files.read(entry.path).catch(() => undefined);
				read.push(entry.path);
			}
		}
	}
	return { directories, read };
}

describe("the console's file browser on the workspace read API", () => {
	it("finds a session's workspace, and says when it has none", async () => {
		const { client, workspace, withFiles, without } = await setUp();
		expect((await client.workspace(withFiles))?.id).toBe(workspace.id);
		expect(await client.workspace(without)).toBeUndefined();
		await expect(client.workspace("no-such-session")).rejects.toMatchObject({ code: "not_found" });
	});

	it("lists a directory's own entries and reads a file's bytes", async () => {
		const { client, withFiles } = await setUp();
		const files = await client.workspace(withFiles);
		if (files === undefined) throw new Error("no workspace");
		const root = await files.list("");
		expect(root.truncated).toBe(false);
		expect(root.entries.map((entry) => `${entry.kind} ${entry.path}`).sort()).toEqual([
			"directory assets",
			"directory notes",
			"directory src",
			"file README.md",
			"file big.txt",
		]);
		const notes = await files.list("notes");
		expect(notes.entries.map((entry) => entry.path).sort()).toEqual(["notes/archive", "notes/plan.md"]);

		const plan = await files.read("notes/plan.md");
		expect(new TextDecoder().decode(plan.content)).toBe(FILES["notes/plan.md"]);
		expect(plan.version).toBe(1);
		expect(contentOf("notes/plan.md", undefined, { status: "ready", file: plan })).toMatchObject({
			status: "ready",
			bytes: plan.content,
		});

		// Bytes that aren't text reach the preview as they are; it shows them as a file it can't draw.
		const blob = await files.read("assets/blob.dat");
		expect(textOf(blob.content)).toBeUndefined();
	});

	it("says a file is too large, and that a missing one isn't there", async () => {
		const { client, withFiles } = await setUp();
		const files = await client.workspace(withFiles);
		if (files === undefined) throw new Error("no workspace");
		await expect(files.read("big.txt")).rejects.toMatchObject({ code: "too_large" });
		await expect(files.read("nope.md")).rejects.toMatchObject({ code: "not_found" });
		await expect(files.list("nope")).rejects.toMatchObject({ code: "not_found" });
	});

	it("browses the whole workspace with no sandbox acquired, as the audit log shows", async () => {
		const { audit, sandboxes, client, workspace, withFiles } = await setUp();
		const files = await client.workspace(withFiles);
		if (files === undefined) throw new Error("no workspace");
		const browsed = await browseAll(files);
		expect(browsed.directories.sort()).toEqual(["", "assets", "notes", "notes/archive", "src", "src/billing"]);
		expect(browsed.read.sort()).toEqual(Object.keys(FILES).sort());

		const sandboxEvents = async () => (await audit.query(ctx, { type: "sandbox." })).items;
		// The log is written to: the workspace's commit is in it.
		expect((await audit.query(ctx, { type: "workspace.committed" })).items).toHaveLength(1);
		expect(await sandboxEvents()).toEqual([]);

		// The control: acquiring a sandbox on the same workspace is in the same log.
		await sandboxes.acquire(ctx, { sessionId: withFiles, workspaceId: workspace.id, tier: "isolate" });
		expect((await sandboxEvents()).map((event) => event.type)).toEqual(["sandbox.lease.acquired"]);
	});
});

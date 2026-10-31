import { type CallContext, isKantelError } from "@kantel/contracts";
import { createMemoryProjectFiles, createMemoryWorkspaces } from "@kantel/workspace/memory";
import { describe, expect, it } from "vitest";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const owner = { kind: "organisation", organisationId: "org-1" } as const;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function codeOf(operation: Promise<unknown>): Promise<string | undefined> {
	try {
		await operation;
	} catch (error) {
		return isKantelError(error) ? error.code : "not a KantelError";
	}
	return undefined;
}

describe("createMemoryWorkspaces", () => {
	it("records git and objects seed sources at metadata readiness without fetching them", async () => {
		const workspaces = createMemoryWorkspaces();
		const record = await workspaces.create(ctx, {
			owner,
			seed: {
				name: "repo",
				sources: [
					{ kind: "git", repo: "https://example.com/repo.git", ref: "main" },
					{ kind: "files", files: { "a.txt": "a" } },
				],
			},
		});
		expect(record.seedReadiness).toBe("metadata");
		expect(record.head).toBe(1);
		expect((await workspaces.list(ctx, record.id)).items.map((item) => item.path)).toEqual(["a.txt"]);
		const plain = await workspaces.create(ctx, { owner });
		expect(plain.seedReadiness).toBe("files");
	});

	it("rejects a tree where one path is both a file and a directory", async () => {
		const workspaces = createMemoryWorkspaces();
		const record = await workspaces.create(ctx, { owner });
		await workspaces.commit(ctx, record.id, { baseVersion: 0, changes: [{ op: "put", path: "a", content: "x" }] });
		expect(
			await codeOf(
				workspaces.commit(ctx, record.id, { baseVersion: 1, changes: [{ op: "put", path: "a/b", content: "y" }] }),
			),
		).toBe("invalid");
	});

	it("rejects deleting a missing file, an empty commit and a mount from an unknown source", async () => {
		const workspaces = createMemoryWorkspaces();
		const record = await workspaces.create(ctx, { owner });
		expect(
			await codeOf(workspaces.commit(ctx, record.id, { baseVersion: 0, changes: [{ op: "delete", path: "x" }] })),
		).toBe("not_found");
		expect(await codeOf(workspaces.commit(ctx, record.id, { baseVersion: 0, changes: [] }))).toBe("invalid");
		expect(
			await codeOf(workspaces.create(ctx, { owner, mounts: [{ path: "/skills", source: "skills", ref: "all" }] })),
		).toBe("invalid");
	});

	it("rejects an owner in another organisation", async () => {
		const workspaces = createMemoryWorkspaces();
		expect(await codeOf(workspaces.create(ctx, { owner: { kind: "organisation", organisationId: "org-2" } }))).toBe(
			"forbidden",
		);
	});

	it("rejects a bad cursor and a bad limit as invalid", async () => {
		const workspaces = createMemoryWorkspaces();
		const record = await workspaces.create(ctx, { owner });
		expect(await codeOf(workspaces.list(ctx, record.id, { cursor: "not a cursor" }))).toBe("invalid");
		expect(await codeOf(workspaces.list(ctx, record.id, { limit: 0 }))).toBe("invalid");
	});
});

describe("createMemoryProjectFiles", () => {
	it("versions each ref separately and keeps old versions readable", async () => {
		const projectFiles = createMemoryProjectFiles();
		expect(await projectFiles.latestVersion(ctx, "proj-1")).toBe("0");
		const first = await projectFiles.seed("proj-1", { "README.md": "one", "src/a.ts": "a" });
		const { version: second, actor } = await projectFiles.write(ctx, "proj-1", [
			{ op: "put", path: "README.md", content: "two" },
			{ op: "delete", path: "src/a.ts" },
		]);
		expect(actor).toEqual(ctx.actor);
		expect(await projectFiles.latestVersion(ctx, "proj-1")).toBe(second);
		expect(await projectFiles.latestVersion(ctx, "proj-2")).toBe("0");
		expect(decode(await projectFiles.read(ctx, "proj-1", first, "README.md"))).toBe("one");
		expect(decode(await projectFiles.read(ctx, "proj-1", second, "README.md"))).toBe("two");
		expect((await projectFiles.list(ctx, "proj-1", first, "")).map((entry) => [entry.path, entry.kind])).toEqual([
			["README.md", "file"],
			["src", "directory"],
		]);
		expect(await codeOf(projectFiles.read(ctx, "proj-1", second, "src/a.ts"))).toBe("not_found");
		expect(await codeOf(projectFiles.read(ctx, "proj-1", "99", "README.md"))).toBe("not_found");
		expect(await codeOf(projectFiles.write(ctx, "proj-1", [{ op: "put", path: "/abs", content: "x" }]))).toBe(
			"invalid",
		);
	});
});

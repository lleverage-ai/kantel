import { type CallContext, isHarbourError } from "@harbour/contracts";
import { createMemoryProjectFiles } from "@harbour/workspace/memory";
import {
	blobKey,
	createMemoryWorkspaceStore,
	createStoredWorkspaces,
	listAll,
	type WorkspaceStore,
} from "@harbour/workspace/stored";
import { describe, expect, it } from "vitest";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const owner = { kind: "organisation", organisationId: "org-1" } as const;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function codeOf(operation: Promise<unknown>): Promise<string | undefined> {
	try {
		await operation;
	} catch (error) {
		return isHarbourError(error) ? error.code : "not a HarbourError";
	}
	return undefined;
}

describe("createStoredWorkspaces", () => {
	it("lists 10,000 files from the tree alone, reading no file bodies", async () => {
		const store = createMemoryWorkspaceStore();
		const writer = createStoredWorkspaces({ store });
		const files: Record<string, string> = {};
		for (let index = 0; index < 10_000; index++)
			files[`src/${index % 100}/file-${index}.ts`] = `export const n = ${index};`;
		const record = await writer.create(ctx, { owner, seed: { name: "big", sources: [{ kind: "files", files }] } });

		// A fresh instance has no cached trees, as a new process would not.
		const reader = createStoredWorkspaces({ store });
		const before = { ...store.counts };
		const started = performance.now();
		const entries = await listAll(reader, ctx, record.id);
		const elapsed = performance.now() - started;
		const listed = entries.filter((entry) => entry.kind === "file");
		// `src` and its 100 directories, then the files.
		expect(entries).toHaveLength(10_101);
		expect(listed).toHaveLength(10_000);
		expect(listed.every((entry) => entry.size > 0 && entry.digest !== undefined)).toBe(true);
		expect(store.counts.blobReads - before.blobReads).toBe(0);
		// One tree object, read once and cached for the other pages.
		expect(store.counts.treeReads - before.treeReads).toBe(1);
		expect(elapsed).toBeLessThan(5_000);

		const stat = await reader.stat(ctx, record.id, "src/7/file-7.ts");
		expect(stat.size).toBe("export const n = 7;".length);
		expect(store.counts.blobReads - before.blobReads).toBe(0);
	});

	it("stores each body once by digest, and equal trees once", async () => {
		const store = createMemoryWorkspaceStore();
		const workspaces = createStoredWorkspaces({ store });
		const first = await workspaces.create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "files", files: { "a.txt": "same", "b.txt": "same" } }] },
		});
		const second = await workspaces.create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "files", files: { "a.txt": "same", "b.txt": "same" } }] },
		});
		expect(first.id).not.toBe(second.id);
		const keys = store.keys();
		expect(keys.filter((key) => key.includes("/blobs/"))).toHaveLength(1);
		expect(keys.filter((key) => key.includes("/trees/"))).toHaveLength(1);
		expect(keys.every((key) => key.startsWith("org/org-1/"))).toBe(true);
	});

	it("keeps mode bits a tier commits, and carries them over a put that names none", async () => {
		const workspaces = createStoredWorkspaces({ store: createMemoryWorkspaceStore() });
		const record = await workspaces.create(ctx, { owner });
		await workspaces.commit(ctx, record.id, {
			baseVersion: 0,
			changes: [{ op: "put", path: "run.sh", content: "#!/bin/sh\n", mode: 0o755 }],
		});
		await workspaces.commit(ctx, record.id, {
			baseVersion: 1,
			changes: [{ op: "put", path: "run.sh", content: "#!/bin/sh\necho hi\n" }],
		});
		const [entry] = (await workspaces.list(ctx, record.id)).items;
		expect(entry).toMatchObject({ path: "run.sh", mode: 0o755, version: 2 });
	});

	it("reads a body by digest only when the digest is a file of that version", async () => {
		const workspaces = createStoredWorkspaces({ store: createMemoryWorkspaceStore() });
		const record = await workspaces.create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "files", files: { "a.txt": "alpha" } }] },
		});
		const other = await workspaces.create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "files", files: { "b.txt": "beta" } }] },
		});
		const [entry] = (await workspaces.list(ctx, record.id)).items;
		const [otherEntry] = (await workspaces.list(ctx, other.id)).items;
		expect(text(await workspaces.readBlob(ctx, record.id, entry!.digest!, { version: 1 }))).toBe("alpha");
		expect(await codeOf(workspaces.readBlob(ctx, record.id, otherEntry!.digest!, { version: 1 }))).toBe("not_found");
		expect(await codeOf(workspaces.readBlob(ctx, record.id, "../x", { version: 1 }))).toBe("invalid");
		expect(
			await codeOf(workspaces.readBlob({ ...ctx, organisationId: "org-2" }, record.id, entry!.digest!, { version: 1 })),
		).toBe("not_found");
	});

	it("answers unavailable, not a wrong file, when a referenced object is missing", async () => {
		const store = createMemoryWorkspaceStore();
		const missing: WorkspaceStore = {
			...store,
			async getObject(key) {
				return key.includes("/blobs/") ? undefined : store.getObject(key);
			},
		};
		const workspaces = createStoredWorkspaces({ store: missing });
		const record = await workspaces.create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "files", files: { "a.txt": "alpha" } }] },
		});
		expect(await codeOf(workspaces.read(ctx, record.id, "a.txt"))).toBe("unavailable");
		expect((await workspaces.list(ctx, record.id)).items).toHaveLength(1);
	});

	it("writes bodies before the head moves, so a lost commit race leaves the head as the winner wrote it", async () => {
		const store = createMemoryWorkspaceStore();
		const workspaces = createStoredWorkspaces({ store });
		const record = await workspaces.create(ctx, { owner });
		const results = await Promise.allSettled([
			workspaces.commit(ctx, record.id, { baseVersion: 0, changes: [{ op: "put", path: "a", content: "1" }] }),
			workspaces.commit(ctx, record.id, { baseVersion: 0, changes: [{ op: "put", path: "a", content: "2" }] }),
		]);
		const lost = results.filter((result) => result.status === "rejected");
		expect(lost).toHaveLength(1);
		expect(isHarbourError((lost[0] as PromiseRejectedResult).reason, "conflict")).toBe(true);
		const head = await workspaces.get(ctx, record.id);
		expect(head.head).toBe(1);
		const content = text((await workspaces.read(ctx, record.id, "a")).content);
		expect(["1", "2"]).toContain(content);
		// The loser's body may be stored, but nothing refers to it.
		expect(store.keys()).toContain(blobKey("org-1", (await workspaces.stat(ctx, record.id, "a")).digest!));
	});

	it("retries a commit whose head token moved only because of a remount", async () => {
		const projectFiles = createMemoryProjectFiles();
		const store = createMemoryWorkspaceStore();
		const workspaces = createStoredWorkspaces({ store, sources: [projectFiles] });
		await projectFiles.seed("proj-1", { "README.md": "one" });
		const record = await workspaces.create(ctx, {
			owner,
			mounts: [{ path: "/project", source: "project-files", ref: "proj-1" }],
		});
		await projectFiles.seed("proj-1", { "README.md": "two" });
		let raced = false;
		const racing: WorkspaceStore = {
			...store,
			async advance(current, next, version) {
				if (!raced) {
					raced = true;
					await workspaces.remount(ctx, record.id, { path: "/project", source: "project-files", ref: "proj-1" });
				}
				return store.advance(current, next, version);
			},
		};
		const committer = createStoredWorkspaces({ store: racing, sources: [projectFiles] });
		const result = await committer.commit(ctx, record.id, {
			baseVersion: 0,
			changes: [{ op: "put", path: "a", content: "x" }],
		});
		expect(result.version).toBe(1);
		const head = await workspaces.get(ctx, record.id);
		expect(head.head).toBe(1);
		// The remount survived the commit.
		expect(head.mounts[0]?.version).toBe("2");
	});

	it("pages history from the store, newest first", async () => {
		const workspaces = createStoredWorkspaces({ store: createMemoryWorkspaceStore() });
		const record = await workspaces.create(ctx, { owner });
		for (let version = 0; version < 5; version++) {
			await workspaces.commit(ctx, record.id, {
				baseVersion: version,
				changes: [{ op: "put", path: `f${version}`, content: "x" }],
			});
		}
		const first = await workspaces.history(ctx, record.id, { limit: 4 });
		expect(first.items.map((item) => item.version)).toEqual([5, 4, 3, 2]);
		const second = await workspaces.history(ctx, record.id, { limit: 4, cursor: first.nextCursor! });
		expect(second.items.map((item) => item.version)).toEqual([1, 0]);
		expect(second.nextCursor).toBeUndefined();
		expect(text((await workspaces.read(ctx, record.id, "f0", { version: 1 })).content)).toBe("x");
		expect(await codeOf(workspaces.read(ctx, record.id, "f4", { version: 1 }))).toBe("not_found");
	});
});

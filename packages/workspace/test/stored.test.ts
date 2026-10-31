import { type CallContext, isKantelError } from "@kantel/contracts";
import { actors, contextFor, createDeps } from "@kantel/testing/harness";
import { createMemoryProjectFiles } from "@kantel/workspace/memory";
import {
	blobKey,
	createMemoryWorkspaceStore,
	createStoredWorkspaces,
	listAll,
	type WorkspaceStore,
} from "@kantel/workspace/stored";
import { describe, expect, it } from "vitest";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const owner = { kind: "organisation", organisationId: "org-1" } as const;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function codeOf(operation: Promise<unknown>): Promise<string | undefined> {
	try {
		await operation;
	} catch (error) {
		return isKantelError(error) ? error.code : "not a KantelError";
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
		expect(isKantelError((lost[0] as PromiseRejectedResult).reason, "conflict")).toBe(true);
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

	it("keeps a remount and a commit that races it: the remount retries over the committed head", async () => {
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
			async update(current, next) {
				if (!raced) {
					raced = true;
					await workspaces.commit(ctx, record.id, {
						baseVersion: 0,
						changes: [{ op: "put", path: "a", content: "x" }],
					});
				}
				return store.update(current, next);
			},
		};
		const remounter = createStoredWorkspaces({ store: racing, sources: [projectFiles] });
		const remounted = await remounter.remount(ctx, record.id, {
			path: "/project",
			source: "project-files",
			ref: "proj-1",
		});
		expect(remounted.head).toBe(1);
		expect(remounted.mounts[0]?.version).toBe("2");
		const fresh = createStoredWorkspaces({ store, sources: [projectFiles] });
		expect(text((await fresh.read(ctx, record.id, "a")).content)).toBe("x");
		expect((await fresh.get(ctx, record.id)).mounts[0]?.version).toBe("2");
	});

	it("round-trips awkward names, mode bits and old versions through a fresh instance", async () => {
		const store = createMemoryWorkspaceStore();
		const writer = createStoredWorkspaces({ store });
		const record = await writer.create(ctx, { owner });
		await writer.commit(ctx, record.id, {
			baseVersion: 0,
			changes: [
				{ op: "put", path: "__proto__", content: "p" },
				{ op: "put", path: "constructor/x", content: "c" },
				{ op: "put", path: "bin/run", content: "r", mode: 0o755 },
			],
		});
		await writer.commit(ctx, record.id, { baseVersion: 1, changes: [{ op: "delete", path: "__proto__" }] });
		const reader = createStoredWorkspaces({ store });
		const old = await listAll(reader, ctx, record.id, { version: 1 });
		expect(old.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry.mode])).toEqual([
			["__proto__", undefined],
			["bin/run", 0o755],
			["constructor/x", undefined],
		]);
		const proto = old.find((entry) => entry.path === "__proto__")!;
		expect(text(await reader.readBlob(ctx, record.id, proto.digest!, { version: 1 }))).toBe("p");
		expect(await codeOf(reader.readBlob(ctx, record.id, proto.digest!, { version: 2 }))).toBe("not_found");
		expect(await codeOf(reader.read(ctx, record.id, "__proto__"))).toBe("not_found");
	});

	it("refuses a malformed stored tree as unavailable rather than listing it", async () => {
		const store = createMemoryWorkspaceStore();
		const writer = createStoredWorkspaces({ store });
		const record = await writer.create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "files", files: { "a.txt": "alpha" } }] },
		});
		const bad = [
			{ "../x": { digest: "0".repeat(64), size: 1, version: 1 } },
			{ "a.txt": { digest: "bad", size: 1, version: 1 } },
			{ "a.txt": { digest: "0".repeat(64), size: -1, version: 1 } },
			{ "a.txt": { digest: "0".repeat(64), size: 1, version: 1.5 } },
			{ "a.txt": { digest: "0".repeat(64), size: 1, version: 1, mode: 0o17777 } },
			{ a: { digest: "0".repeat(64), size: 1, version: 1 }, "a/b": { digest: "0".repeat(64), size: 1, version: 1 } },
		];
		for (const tree of bad) {
			const corrupt: WorkspaceStore = {
				...store,
				async getObject(key) {
					return key.includes("/trees/") ? new TextEncoder().encode(JSON.stringify(tree)) : store.getObject(key);
				},
			};
			const reader = createStoredWorkspaces({ store: corrupt });
			expect(await codeOf(reader.list(ctx, record.id)), JSON.stringify(tree)).toBe("unavailable");
		}
	});

	it("does not keep a tree larger than the cache budget", async () => {
		const store = createMemoryWorkspaceStore();
		const files = { "a.txt": "a", "b.txt": "b", "c.txt": "c" };
		const record = await createStoredWorkspaces({ store }).create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "files", files }] },
		});
		const small = await createStoredWorkspaces({ store }).create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "files", files: { "x.txt": "x" } }] },
		});
		const reader = createStoredWorkspaces({ store, treeCacheEntries: 2 });
		const before = store.counts.treeReads;
		await reader.list(ctx, record.id);
		await reader.list(ctx, record.id);
		expect(store.counts.treeReads - before).toBe(2);
		await reader.list(ctx, small.id);
		await reader.list(ctx, small.id);
		expect(store.counts.treeReads - before).toBe(3);
	});

	it("checks the loser of a contested ensure against the record that won, whichever wins", async () => {
		const deps = createDeps();
		const alice = contextFor(actors.human("alice"), "org-1", "proj-1");
		const oscar = contextFor(actors.human("oscar"), "org-1", "proj-2");
		deps.tenancy.bind(alice.actor, "org-1", "operator", "proj-1");
		deps.tenancy.bind(oscar.actor, "org-1", "operator", "proj-2");
		const projectOwner = (projectId: string) => ({ kind: "project", organisationId: "org-1", projectId }) as const;
		for (const first of ["alice", "oscar"] as const) {
			const store = createMemoryWorkspaceStore();
			// Both lookups see no workspace, and `first` creates before the other tries: a real lost race.
			let lookups = 0;
			let release: () => void = () => {};
			const bothLooked = new Promise<void>((resolve) => {
				release = resolve;
			});
			let created: () => void = () => {};
			const firstCreated = new Promise<void>((resolve) => {
				created = resolve;
			});
			const barrier = (who: "alice" | "oscar"): WorkspaceStore => ({
				...store,
				async load(id) {
					const head = await store.load(id);
					if (lookups < 2) {
						lookups++;
						if (lookups === 2) release();
						await bothLooked;
					}
					return head;
				},
				async create(head, versions) {
					if (who !== first) await firstCreated;
					const won = await store.create(head, versions);
					if (who === first) created();
					return won;
				},
			});
			const asAlice = createStoredWorkspaces({ store: barrier("alice"), access: deps.access });
			const asOscar = createStoredWorkspaces({ store: barrier("oscar"), access: deps.access });
			const [byAlice, byOscar] = await Promise.allSettled([
				asAlice.ensure(alice, "pf_contested", { owner: projectOwner("proj-1") }),
				asOscar.ensure(oscar, "pf_contested", { owner: projectOwner("proj-2") }),
			]);
			const [won, lost] = first === "alice" ? [byAlice, byOscar] : [byOscar, byAlice];
			expect(won.status, first).toBe("fulfilled");
			expect(lost.status, first).toBe("rejected");
			expect(isKantelError((lost as PromiseRejectedResult).reason, "forbidden"), first).toBe(true);
			const owner = (await store.load("pf_contested"))?.record.owner;
			expect(owner).toEqual(projectOwner(first === "alice" ? "proj-1" : "proj-2"));
		}
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

	it("writes a commit's blobs and tree at once, and moves the head only after both are written", async () => {
		const store = createMemoryWorkspaceStore();
		const workspaces = createStoredWorkspaces({ store });
		const record = await workspaces.create(ctx, { owner });
		const started: string[] = [];
		let release: () => void = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let bothStarted: () => void = () => {};
		const waiting = new Promise<void>((resolve) => {
			bothStarted = resolve;
		});
		const held: WorkspaceStore = {
			...store,
			async putObject(key, bytes) {
				started.push(key.includes("/trees/") ? "tree" : "blob");
				if (started.length === 2) bothStarted();
				await released;
				return store.putObject(key, bytes);
			},
		};
		const commit = createStoredWorkspaces({ store: held }).commit(ctx, record.id, {
			baseVersion: 0,
			changes: [{ op: "put", path: "a.txt", content: "alpha" }],
		});
		// Both writes are in flight before either finishes, and the head has not moved.
		await waiting;
		expect(started.sort()).toEqual(["blob", "tree"]);
		expect((await workspaces.get(ctx, record.id)).head).toBe(0);
		release();
		expect((await commit).version).toBe(1);
		expect(text((await workspaces.read(ctx, record.id, "a.txt")).content)).toBe("alpha");
	});

	for (const [kind, alongside] of [
		["a store that writes alongside", true],
		["a store that takes the objects first", false],
	] as const) {
		for (const failing of ["blob", "tree"] as const) {
			it(`leaves the head unchanged when a commit's ${failing} write fails (${kind})`, async () => {
				const store = createMemoryWorkspaceStore();
				const workspaces = createStoredWorkspaces({ store });
				const record = await workspaces.create(ctx, {
					owner,
					seed: { name: "s", sources: [{ kind: "files", files: { "a.txt": "v1" } }] },
				});
				let advanced = 0;
				const broken: WorkspaceStore = {
					...store,
					writesAlongside: alongside,
					async putObject(key, bytes) {
						if (key.includes(failing === "blob" ? "/blobs/" : "/trees/")) throw new Error(`${failing} write failed`);
						return store.putObject(key, bytes);
					},
					async advance(current, next, version, options) {
						advanced++;
						return store.advance(current, next, version, options);
					},
				};
				await expect(
					createStoredWorkspaces({ store: broken }).commit(ctx, record.id, {
						baseVersion: 1,
						changes: [{ op: "put", path: "a.txt", content: "v2" }],
					}),
				).rejects.toThrow(`${failing} write failed`);
				// Only a store that writes alongside is reached, and it moves nothing.
				expect(advanced).toBe(alongside ? 1 : 0);
				const fresh = createStoredWorkspaces({ store });
				expect((await fresh.get(ctx, record.id)).head).toBe(1);
				expect(text((await fresh.read(ctx, record.id, "a.txt")).content)).toBe("v1");
				expect((await fresh.history(ctx, record.id)).items.map((item) => item.version)).toEqual([1, 0]);
			});
		}
	}
});

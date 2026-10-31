import { type CallContext, isKantelError, KantelError } from "@kantel/contracts";
import { createMemoryExportSink, exportManifestOf, syncExport } from "@kantel/workspace/export";
import { createMemoryProjectFiles, createMemoryWorkspaces } from "@kantel/workspace/memory";
import { createWorkspaceReadApi, createWorkspaceReadClient } from "@kantel/workspace/read-api";
import { createMemoryWorkspaceStore, createStoredWorkspaces } from "@kantel/workspace/stored";
import { describe, expect, it } from "vitest";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const owner = { kind: "organisation", organisationId: "org-1" } as const;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function codeOf(operation: Promise<unknown>): Promise<string | undefined> {
	try {
		await operation;
	} catch (error) {
		return isKantelError(error) ? error.code : `not a KantelError: ${String(error)}`;
	}
	return undefined;
}

const subjects = {
	memory: () => createMemoryWorkspaces(),
	stored: () => createStoredWorkspaces({ store: createMemoryWorkspaceStore() }),
};

describe.each(Object.entries(subjects))("syncExport over %s workspaces", (_name, make) => {
	it("writes changed notes, skips unchanged ones and removes deleted ones it wrote", async () => {
		const workspaces = make();
		const record = await workspaces.create(ctx, {
			owner,
			seed: {
				name: "s",
				sources: [{ kind: "files", files: { "notes/a.md": "a1", "notes/b.md": "b1", "src/x.ts": "x" } }],
			},
		});
		const sink = createMemoryExportSink();
		const first = await syncExport(ctx, workspaces, record.id, { prefixes: ["notes/"], sink });
		expect(first.written).toEqual(["notes/a.md", "notes/b.md"]);
		expect([...sink.files.keys()].sort()).toEqual(["notes/a.md", "notes/b.md"]);

		await workspaces.commit(ctx, record.id, {
			baseVersion: 1,
			changes: [
				{ op: "put", path: "notes/a.md", content: "a2" },
				{ op: "delete", path: "notes/b.md" },
				{ op: "put", path: "notes/deep/c.md", content: "c" },
				{ op: "put", path: "src/x.ts", content: "y" },
			],
		});
		// The host has a file of its own beside the export; the sync never touches it.
		sink.files.set("notes/host.md", new TextEncoder().encode("mine"));
		const second = await syncExport(ctx, workspaces, record.id, {
			prefixes: ["notes/"],
			sink,
			previous: first.manifest,
		});
		expect(second.written).toEqual(["notes/a.md", "notes/deep/c.md"]);
		expect(second.removed).toEqual(["notes/b.md"]);
		expect(decode(sink.files.get("notes/a.md")!)).toBe("a2");
		expect([...sink.files.keys()].sort()).toEqual(["notes/a.md", "notes/deep/c.md", "notes/host.md"]);

		const third = await syncExport(ctx, workspaces, record.id, {
			prefixes: ["notes/"],
			sink,
			previous: second.manifest,
		});
		expect(third).toMatchObject({ written: [], removed: [] });
		expect(Object.keys(third.manifest.files).sort()).toEqual(["notes/a.md", "notes/deep/c.md"]);
	});

	it("hands back what the host holds when the sink fails part-way, so the next sync puts it right", async () => {
		const workspaces = make();
		const record = await workspaces.create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "files", files: { "notes/a.md": "A" } }] },
		});
		const memory = createMemoryExportSink();
		const failing = new Set<string>();
		const sink = {
			files: memory.files,
			async write(path: string, content: Uint8Array, digest: string) {
				if (failing.has(path)) throw new KantelError("invalid", `${path} is a directory on the host`);
				return memory.write(path, content, digest);
			},
			remove: (path: string) => memory.remove(path),
		};
		const first = await syncExport(ctx, workspaces, record.id, { prefixes: ["notes/"], sink });

		// a.md changes to B and z.md is added; writing z.md fails after B is on the host.
		await workspaces.commit(ctx, record.id, {
			baseVersion: 1,
			changes: [
				{ op: "put", path: "notes/a.md", content: "B" },
				{ op: "put", path: "notes/z.md", content: "Z" },
			],
		});
		failing.add("notes/z.md");
		const failed = await syncExport(ctx, workspaces, record.id, {
			prefixes: ["notes/"],
			sink,
			previous: first.manifest,
		}).catch((error: unknown) => error);
		expect(failed).toMatchObject({ code: "invalid", details: { path: "notes/z.md" } });
		const held = exportManifestOf(failed);
		expect(Object.keys(held?.files ?? {}).sort()).toEqual(["notes/a.md", "notes/z.md"]);
		expect(held?.files["notes/a.md"]).not.toBe(first.manifest.files["notes/a.md"]);
		expect(held?.files["notes/z.md"]).toBe("");
		expect(decode(sink.files.get("notes/a.md")!)).toBe("B");

		// The workspace goes back to A without z.md; given the handed-back manifest, the sync restores A and drops z.md.
		await workspaces.commit(ctx, record.id, {
			baseVersion: 2,
			changes: [
				{ op: "put", path: "notes/a.md", content: "A" },
				{ op: "delete", path: "notes/z.md" },
			],
		});
		failing.clear();
		const retried = await syncExport(ctx, workspaces, record.id, { prefixes: ["notes/"], sink, previous: held! });
		expect(retried).toMatchObject({ written: ["notes/a.md"], removed: ["notes/z.md"] });
		expect(decode(sink.files.get("notes/a.md")!)).toBe("A");
		expect([...sink.files.keys()]).toEqual(["notes/a.md"]);
		expect(retried.manifest).toEqual(first.manifest);
	});

	it("refuses an export over maxBytes with refused and its sizes, and allows one within it", async () => {
		const workspaces = make();
		const record = await workspaces.create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "files", files: { "notes/a.md": "aaaa", "notes/b.md": "bbbb", x: "x" } }] },
		});
		let caught: unknown;
		try {
			await workspaces.export(ctx, record.id, ["notes/"], { maxBytes: 7 });
		} catch (error) {
			caught = error;
		}
		expect(isKantelError(caught, "refused")).toBe(true);
		expect((caught as KantelError).details).toEqual({ maxBytes: 7, bytes: 8 });
		expect(await workspaces.export(ctx, record.id, ["notes/"], { maxBytes: 8 })).toHaveLength(2);
		expect(await codeOf(workspaces.export(ctx, record.id, ["notes/"], { maxBytes: -1 }))).toBe("invalid");
	});

	it("keeps earlier entries outside the prefixes it was asked for, and refuses no prefix", async () => {
		const workspaces = make();
		const record = await workspaces.create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "files", files: { "notes/a.md": "a", "out/r.json": "{}" } }] },
		});
		const sink = createMemoryExportSink();
		const both = await syncExport(ctx, workspaces, record.id, { prefixes: ["notes/", "out/"], sink });
		const notesOnly = await syncExport(ctx, workspaces, record.id, {
			prefixes: ["notes/"],
			sink,
			previous: both.manifest,
		});
		expect(notesOnly.removed).toEqual([]);
		expect(Object.keys(notesOnly.manifest.files).sort()).toEqual(["notes/a.md", "out/r.json"]);
		expect(await codeOf(syncExport(ctx, workspaces, record.id, { prefixes: [], sink }))).toBe("invalid");
		expect(await codeOf(syncExport(ctx, workspaces, record.id, { prefixes: ["/etc"], sink }))).toBe("invalid");
	});
});

describe("the read API's export route", () => {
	async function setUp(maxContentBytes?: number) {
		const workspaces = createMemoryWorkspaces();
		const record = await workspaces.create(ctx, {
			owner,
			seed: {
				name: "s",
				sources: [{ kind: "files", files: { "notes/a.md": "# a", "notes/b.md": "b", "src/x.ts": "x" } }],
			},
		});
		await workspaces.commit(ctx, record.id, {
			baseVersion: 1,
			changes: [{ op: "put", path: "out/bin", content: new Uint8Array([0, 255, 1, 128]) }],
		});
		const api = createWorkspaceReadApi({
			workspaces,
			authenticate: async (request) => {
				if (request.headers.get("x-user") !== "alice") throw new KantelError("forbidden", "sign in first");
				return ctx;
			},
			...(maxContentBytes === undefined ? {} : { maxContentBytes }),
		});
		const client = createWorkspaceReadClient({
			baseUrl: "https://harbour.test/v1/workspaces",
			headers: { "x-user": "alice" },
			fetch: async (input, init) =>
				(await api(new Request(input as string, init))) ?? new Response(null, { status: 404 }),
		});
		return { workspaces, record, api, client };
	}

	it("sends the files under every prefix at head, bytes intact", async () => {
		const { client, record, workspaces } = await setUp();
		const files = await client.export(record.id, ["notes/", "out/"]);
		expect(files.map((file) => file.path)).toEqual(["notes/a.md", "notes/b.md", "out/bin"]);
		expect([...files[2]!.content]).toEqual([0, 255, 1, 128]);
		expect(files).toEqual(await workspaces.export(ctx, record.id, ["notes/", "out/"]));
		// The client is a drop-in source for a host-side sync.
		const sink = createMemoryExportSink();
		const synced = await syncExport(ctx, { export: (_ctx, id, prefixes) => client.export(id, prefixes) }, record.id, {
			prefixes: ["notes/"],
			sink,
		});
		expect(synced.written).toEqual(["notes/a.md", "notes/b.md"]);
	});

	it("refuses no prefix, a bad one, an export over the byte budget, a stranger and a reader without export", async () => {
		const { api, record, client } = await setUp(3);
		const send = async (query: string, user = "alice") =>
			(await api(
				new Request(`https://harbour.test/v1/workspaces/${record.id}/export${query}`, { headers: { "x-user": user } }),
			))!;
		expect((await send("")).status).toBe(400);
		expect((await send("?prefix=")).status).toBe(400);
		expect((await send("?prefix=%2Fetc")).status).toBe(400);
		expect((await send("?prefix=notes/")).status).toBe(413);
		expect((await send("?prefix=notes/", "mallory")).status).toBe(403);
		expect(await codeOf(client.export(record.id, ["notes/"]))).toBe("refused");
		const bare = createWorkspaceReadApi({
			workspaces: {
				get: async () => record,
				list: async () => ({ items: [] }),
				stat: async () => {
					throw new Error();
				},
				read: async () => {
					throw new Error();
				},
				history: async () => ({ items: [] }),
			},
			authenticate: async () => ctx,
		});
		const response = (await bare(new Request(`https://harbour.test/v1/workspaces/${record.id}/export?prefix=notes/`)))!;
		expect(response.status).toBe(501);
	});

	it("refuses an export over the budget from listings alone, before any body is loaded", async () => {
		const { workspaces, record } = await setUp();
		const exported: string[][] = [];
		const api = createWorkspaceReadApi({
			workspaces: {
				...workspaces,
				export: async (...args) => {
					exported.push([...args[2]]);
					return workspaces.export(...args);
				},
			},
			authenticate: async () => ctx,
			maxContentBytes: 3,
		});
		const send = async (query: string, method = "GET") =>
			(await api(new Request(`https://harbour.test/v1/workspaces/${record.id}/export${query}`, { method })))!;
		expect((await send("?prefix=notes/")).status).toBe(413);
		expect((await send("?prefix=notes/a&prefix=notes/a.md")).status).toBe(200);
		expect((await send("?prefix=src/&prefix=missing/")).status).toBe(200);
		expect((await send("?prefix=src/x.ts/")).status).toBe(200);
		expect(exported).toEqual([["notes/a", "notes/a.md"], ["src/", "missing/"], ["src/x.ts/"]]);
		const head = await send("?prefix=src/", "HEAD");
		expect(head.status).toBe(200);
		expect(head.body).toBeNull();
	});

	it("refuses an export that grew between the listing and the export, without loading its bodies", async () => {
		let bodyReads = 0;
		const inner = createMemoryWorkspaceStore();
		const store = {
			...inner,
			getObject: async (key: string) => {
				if (key.includes("/blobs/")) bodyReads++;
				return inner.getObject(key);
			},
		};
		const workspaces = createStoredWorkspaces({ store });
		const record = await workspaces.create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "files", files: { "notes/a.md": "a" } }] },
		});
		const api = createWorkspaceReadApi({
			workspaces: {
				...workspaces,
				// Another writer commits a large note after the listing has sized the export.
				list: async (...args) => {
					const page = await workspaces.list(...args);
					const head = (await workspaces.get(ctx, record.id)).head;
					if (head === record.head) {
						await workspaces.commit(ctx, record.id, {
							baseVersion: head,
							changes: [{ op: "put", path: "notes/big.md", content: "x".repeat(64) }],
						});
					}
					return page;
				},
			},
			authenticate: async () => ctx,
			maxContentBytes: 16,
		});
		bodyReads = 0;
		const response = (await api(new Request(`https://harbour.test/v1/workspaces/${record.id}/export?prefix=notes/`)))!;
		expect(response.status).toBe(413);
		expect(bodyReads).toBe(0);
	});

	it("sizes an export across pages, for directory and partial prefixes, without listing a mount", async () => {
		const projectFiles = createMemoryProjectFiles();
		await projectFiles.write!(ctx, "proj", [{ op: "put", path: "notes/big.md", content: "x".repeat(10_000) }]);
		const workspaces = createMemoryWorkspaces({ sources: [projectFiles] });
		const notes: Record<string, string> = {};
		for (let index = 0; index < 1_050; index++) notes[`notes/n${String(index).padStart(4, "0")}.md`] = "n";
		const record = await workspaces.create(ctx, {
			owner,
			mounts: [{ path: "/project", source: "project-files", ref: "proj" }],
			seed: { name: "s", sources: [{ kind: "files", files: { ...notes, "a/b/c.txt": "abc", "notesx.md": "xx" } }] },
		});
		const listed: (string | undefined)[] = [];
		let exports = 0;
		const api = createWorkspaceReadApi({
			workspaces: {
				...workspaces,
				list: async (...args) => {
					listed.push(args[2]?.path);
					return workspaces.list(...args);
				},
				export: async (...args) => {
					exports++;
					return workspaces.export(...args);
				},
			},
			authenticate: async () => ctx,
			maxContentBytes: 1_040,
		});
		const status = async (query: string) =>
			(await api(new Request(`https://harbour.test/v1/workspaces/${record.id}/export${query}`)))!.status;
		// 1,050 one-byte notes: only a sizing that pages past the first 1,000 sees the budget broken.
		expect(await status("?prefix=notes/")).toBe(413);
		expect(await status("?prefix=notes")).toBe(413);
		expect(await status("?prefix=notes/n00")).toBe(200);
		expect(await status("?prefix=a/b/")).toBe(200);
		expect(await status("?prefix=a/b/c")).toBe(200);
		expect(exports).toBe(3);
		expect(listed.every((path) => path === undefined || !path.startsWith("/"))).toBe(true);
		expect(new Set(listed)).toEqual(new Set(["notes", undefined, "a/b"]));
	});
});

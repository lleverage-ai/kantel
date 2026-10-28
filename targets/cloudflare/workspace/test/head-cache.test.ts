import type { CallContext } from "@harbour/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudflareWorkspaces, createR2WorkspaceStore, type R2BucketLike } from "../src/index.ts";
import { countingHeads, localR2, memoryHeadCache } from "./r2.ts";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const owner = { kind: "organisation", organisationId: "org-1" } as const;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const seed = { name: "s", sources: [{ kind: "files" as const, files: { "a.txt": "v1" } }] };

let r2: Awaited<ReturnType<typeof localR2>>;
beforeAll(async () => {
	r2 = await localR2();
});
afterAll(() => r2.dispose());

describe("Cloudflare workspaces with a head cache", () => {
	it("reads the head from the cache, not R2, and sees its own commits", async () => {
		const prefix = `m1-cf1/${crypto.randomUUID()}`;
		const { bucket, counts } = countingHeads(r2.bucket);
		const workspaces = createCloudflareWorkspaces({ bucket, prefix, headCache: memoryHeadCache() });
		const record = await workspaces.create(ctx, { owner, seed });
		counts.heads = 0;

		expect((await workspaces.get(ctx, record.id)).head).toBe(1);
		await workspaces.commit(ctx, record.id, { baseVersion: 1, changes: [{ op: "put", path: "a.txt", content: "v2" }] });
		expect((await workspaces.get(ctx, record.id)).head).toBe(2);
		expect(text((await workspaces.read(ctx, record.id, "a.txt")).content)).toBe("v2");
		expect((await workspaces.history(ctx, record.id)).items.map((item) => item.version)).toEqual([2, 1, 0]);
		expect(counts.heads).toBe(0);

		// R2 is still the source of truth: a store without the cache reads the same head.
		const plain = createCloudflareWorkspaces({ bucket: r2.bucket, prefix });
		expect((await plain.get(ctx, record.id)).head).toBe(2);
	});

	it("loads a head once from R2 when the cache is empty, as after a restart", async () => {
		const prefix = `m1-cf1/${crypto.randomUUID()}`;
		const record = await createCloudflareWorkspaces({ bucket: r2.bucket, prefix }).create(ctx, { owner, seed });
		const { bucket, counts } = countingHeads(r2.bucket);
		const workspaces = createCloudflareWorkspaces({ bucket, prefix, headCache: memoryHeadCache() });
		for (let i = 0; i < 3; i++) expect((await workspaces.get(ctx, record.id)).head).toBe(1);
		expect(counts.heads).toBe(1);
	});

	it("drops a head another writer moved when its next write fails on it", async () => {
		const prefix = `m1-cf1/${crypto.randomUUID()}`;
		const cache = memoryHeadCache();
		const cached = createCloudflareWorkspaces({ bucket: r2.bucket, prefix, headCache: cache });
		const record = await cached.create(ctx, { owner, seed });
		// A write that doesn't go through the cached store, which the option rules out; this is the recovery.
		await createCloudflareWorkspaces({ bucket: r2.bucket, prefix }).commit(ctx, record.id, {
			baseVersion: 1,
			changes: [{ op: "put", path: "a.txt", content: "elsewhere" }],
		});
		expect((await cached.get(ctx, record.id)).head).toBe(1);

		await expect(
			cached.commit(ctx, record.id, { baseVersion: 1, changes: [{ op: "put", path: "a.txt", content: "mine" }] }),
		).rejects.toMatchObject({ code: "conflict", details: { head: 2 } });
		expect((await cached.get(ctx, record.id)).head).toBe(2);
		expect(text((await cached.read(ctx, record.id, "a.txt")).content)).toBe("elsewhere");
	});

	// A load that read the head before a write's put landed, and answers after it: it must not cache what it read.
	for (const order of ["the load starts first", "the write starts first"] as const) {
		it(`never caches a head read before an overlapping write landed (${order})`, async () => {
			const prefix = `m1-cf1/${crypto.randomUUID()}`;
			const cache = memoryHeadCache();
			const gate = () => {
				let open: () => void = () => {};
				const closed = new Promise<void>((resolve) => {
					open = resolve;
				});
				return { closed, open };
			};
			let holdGet: ReturnType<typeof gate> | undefined;
			let holdPut: ReturnType<typeof gate> | undefined;
			const read = gate();
			const holding: R2BucketLike = {
				async get(key) {
					const object = await r2.bucket.get(key);
					// Read first, answer later: the object is the head as it was before the write.
					if (holdGet !== undefined && key.endsWith("/head")) {
						read.open();
						await holdGet.closed;
					}
					return object;
				},
				async put(key, value, options) {
					if (holdPut !== undefined && key.endsWith("/head")) await holdPut.closed;
					return r2.bucket.put(key, value, options);
				},
			};
			const store = createR2WorkspaceStore({ bucket: holding, prefix, headCache: cache });
			const record = await createCloudflareWorkspaces({ bucket: r2.bucket, prefix }).create(ctx, { owner });
			const before = (await store.load(record.id))!;
			const next = { organisationId: "org-1", record: { ...before.record, head: 1 }, tree: "tree-a" };
			const version = { info: { version: 1, at: 1, actor: ctx.actor, changed: ["a"] }, tree: "tree-a" };
			cache.heads.clear();
			holdGet = gate();

			let loading: Promise<unknown>;
			if (order === "the load starts first") {
				loading = store.load(record.id);
				await read.closed;
				expect(await store.advance(before, next, version)).toBe(true);
			} else {
				holdPut = gate();
				const advancing = store.advance(before, next, version);
				loading = store.load(record.id);
				await read.closed;
				holdPut.open();
				expect(await advancing).toBe(true);
			}
			const held = holdGet;
			holdGet = undefined;
			held.open();

			expect(((await loading) as typeof before | undefined)?.record.head).toBe(0);
			expect(JSON.parse(cache.heads.get(record.id)!.text).record.head).toBe(1);
			expect((await store.load(record.id))?.record.head).toBe(1);
		});
	}

	it("caches nothing for a write that failed, and keeps working when the cache fails", async () => {
		const prefix = `m1-cf1/${crypto.randomUUID()}`;
		const cache = memoryHeadCache();
		const store = createR2WorkspaceStore({ bucket: r2.bucket, prefix, headCache: cache });
		const record = await createCloudflareWorkspaces({ bucket: r2.bucket, prefix }).create(ctx, { owner });
		const head = (await store.load(record.id))!;
		expect(await store.create({ organisationId: "org-1", record: head.record, tree: null }, [])).toBe(false);
		expect(cache.heads.has(record.id)).toBe(false);

		const broken = createR2WorkspaceStore({
			bucket: r2.bucket,
			prefix,
			headCache: {
				get: async () => {
					throw new Error("down");
				},
				set: async () => {
					throw new Error("down");
				},
				delete: async () => undefined,
			},
		});
		expect((await broken.load(record.id))?.record.head).toBe(0);
	});
});

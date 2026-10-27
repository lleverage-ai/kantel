import type { CallContext } from "@harbour/contracts";
import { listAll } from "@harbour/workspace/stored";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCloudflareWorkspaces, createR2WorkspaceStore } from "../src/index.ts";
import { counting, localR2 } from "./r2.ts";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const owner = { kind: "organisation", organisationId: "org-1" } as const;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

let r2: Awaited<ReturnType<typeof localR2>>;
beforeAll(async () => {
	r2 = await localR2();
});
afterAll(() => r2.dispose());

describe("Cloudflare workspaces on R2", () => {
	it("lists a 10,000-file workspace without reading a file body", async () => {
		const prefix = `m1-be23/${crypto.randomUUID()}`;
		// 100 distinct bodies keep the seed quick over the local proxy; the listing reads trees only either way.
		const files: Record<string, string> = {};
		for (let index = 0; index < 10_000; index++) {
			files[`src/${index % 100}/file-${index}.ts`] = `export const n = ${index % 100};`;
		}
		const record = await createCloudflareWorkspaces({ bucket: r2.bucket, prefix }).create(ctx, {
			owner,
			seed: { name: "big", sources: [{ kind: "files", files }] },
		});
		const { bucket, counts } = counting(r2.bucket);
		const started = performance.now();
		const entries = await listAll(createCloudflareWorkspaces({ bucket, prefix }), ctx, record.id);
		const elapsedMs = Math.round(performance.now() - started);
		const result = {
			files: entries.filter((entry) => entry.kind === "file").length,
			blobReads: counts.blobs,
			treeReads: counts.trees,
			elapsedMs,
		};
		console.info(`10,000-file listing on local R2 (wrangler platform proxy): ${JSON.stringify(result)}`);
		expect(result).toMatchObject({ files: 10_000, blobReads: 0, treeReads: 1 });
	});

	it("archives each older version once the head moves past it, and reads history through the archive", async () => {
		const prefix = `m1-be23/${crypto.randomUUID()}`;
		const workspaces = createCloudflareWorkspaces({ bucket: r2.bucket, prefix });
		const record = await workspaces.create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "files", files: { "a.txt": "v1" } }] },
		});
		for (let version = 1; version < 4; version++) {
			await workspaces.commit(ctx, record.id, {
				baseVersion: version,
				changes: [{ op: "put", path: "a.txt", content: `v${version + 1}` }],
			});
		}
		const id = encodeURIComponent(record.id);
		for (const version of [0, 1, 2, 3]) {
			expect(await r2.bucket.get(`${prefix}/ws/${id}/versions/${version}.json`), `version ${version}`).not.toBeNull();
		}
		expect(await r2.bucket.get(`${prefix}/ws/${id}/versions/4.json`)).toBeNull();
		const fresh = createCloudflareWorkspaces({ bucket: r2.bucket, prefix });
		expect((await fresh.history(ctx, record.id)).items.map((item) => item.version)).toEqual([4, 3, 2, 1, 0]);
		expect(text((await fresh.read(ctx, record.id, "a.txt", { version: 2 })).content)).toBe("v2");
	});

	it("keeps the archive and history the winner's when a stale writer resumes after the head moved twice", async () => {
		const prefix = `m1-be23/${crypto.randomUUID()}`;
		const workspaces = createCloudflareWorkspaces({ bucket: r2.bucket, prefix });
		const record = await workspaces.create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "files", files: { "a.txt": "v1" } }] },
		});
		// The stale writer stops before its archive puts until the others have committed twice.
		let resume: () => void = () => {};
		const resumed = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let paused: () => void = () => {};
		const pausedAt = new Promise<void>((resolve) => {
			paused = resolve;
		});
		const stalling = {
			get: r2.bucket.get.bind(r2.bucket),
			async put(key: string, value: string | ArrayBuffer | Uint8Array, options?: Parameters<typeof r2.bucket.put>[2]) {
				if (key.includes("/versions/")) {
					paused();
					await resumed;
				}
				return r2.bucket.put(key, value, options);
			},
		};
		const stale = createCloudflareWorkspaces({ bucket: stalling, prefix }).commit(ctx, record.id, {
			baseVersion: 1,
			changes: [{ op: "put", path: "a.txt", content: "stale" }],
		});
		await pausedAt;
		await workspaces.commit(ctx, record.id, { baseVersion: 1, changes: [{ op: "put", path: "a.txt", content: "v2" }] });
		await workspaces.commit(ctx, record.id, { baseVersion: 2, changes: [{ op: "put", path: "a.txt", content: "v3" }] });
		const archive = async () =>
			Promise.all(
				[0, 1, 2].map(async (version) =>
					(await r2.bucket.get(`${prefix}/ws/${encodeURIComponent(record.id)}/versions/${version}.json`))!.text(),
				),
			);
		const archived = await archive();
		resume();
		await expect(stale).rejects.toMatchObject({ code: "conflict" });

		// The stale writer re-archived versions 0 and 1 from the head it read: the same bytes.
		expect(await archive()).toEqual(archived);
		const fresh = createCloudflareWorkspaces({ bucket: r2.bucket, prefix });
		expect((await fresh.get(ctx, record.id)).head).toBe(3);
		expect((await fresh.history(ctx, record.id)).items.map((item) => item.version)).toEqual([3, 2, 1, 0]);
		for (const [version, content] of [
			[1, "v1"],
			[2, "v2"],
			[3, "v3"],
		] as const) {
			expect(text((await fresh.read(ctx, record.id, "a.txt", { version })).content)).toBe(content);
		}
	});

	it("lets exactly one of two racing commits move the head", async () => {
		const prefix = `m1-be23/${crypto.randomUUID()}`;
		const store = createR2WorkspaceStore({ bucket: r2.bucket, prefix });
		const workspaces = createCloudflareWorkspaces({ bucket: r2.bucket, prefix });
		const record = await workspaces.create(ctx, { owner });
		const head = (await store.load(record.id))!;
		const next = (tree: string) => ({ organisationId: "org-1", record: { ...head.record, head: 1 }, tree });
		const version = (tree: string) => ({ info: { version: 1, at: 1, actor: ctx.actor, changed: ["a"] }, tree });
		const results = await Promise.all([
			store.advance(head, next("tree-a"), version("tree-a")),
			store.advance(head, next("tree-b"), version("tree-b")),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(await store.create({ organisationId: "org-1", record: head.record, tree: null }, [])).toBe(false);
	});
});

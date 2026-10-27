import { PGlite } from "@electric-sql/pglite";
import type { CallContext } from "@harbour/contracts";
import { listAll } from "@harbour/workspace/stored";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
	createMemoryObjects,
	createS3Objects,
	createSelfHostedWorkspaces,
	migrateWorkspaceStore,
	type ObjectBucket,
	pgDatabase,
	type SqlDatabase,
} from "../src/index.ts";
import { deletePrefix, dropSchemas, stackEnv } from "./stack.ts";
import { laneSchema, pgliteDatabase } from "./support.ts";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const owner = { kind: "organisation", organisationId: "org-1" } as const;
const FILES = 10_000;

/** Seeds a 10,000-file workspace, then lists it from a fresh instance, counting object reads by kind. */
async function listLarge(
	db: SqlDatabase,
	objects: ObjectBucket,
	reads: () => { blobs: number; trees: number },
	schemas = new Set<string>(),
) {
	const schema = laneSchema();
	schemas.add(schema);
	await migrateWorkspaceStore(db, schema);
	const files: Record<string, string> = {};
	for (let index = 0; index < FILES; index++)
		files[`src/${index % 100}/file-${index}.ts`] = `export const n = ${index};`;
	const record = await createSelfHostedWorkspaces({ db, objects, schema }).create(ctx, {
		owner,
		seed: { name: "big", sources: [{ kind: "files", files }] },
	});
	const before = reads();
	const started = performance.now();
	const entries = await listAll(createSelfHostedWorkspaces({ db, objects, schema }), ctx, record.id);
	const elapsedMs = Math.round(performance.now() - started);
	const after = reads();
	return {
		files: entries.filter((entry) => entry.kind === "file").length,
		blobReads: after.blobs - before.blobs,
		treeReads: after.trees - before.trees,
		elapsedMs,
	};
}

describe("a 10,000-file workspace", () => {
	it("lists on PGlite without reading a file body", async () => {
		const pglite = new PGlite();
		try {
			const objects = createMemoryObjects();
			const result = await listLarge(pgliteDatabase(pglite), objects, () => ({ ...objects.counts }));
			expect(result).toMatchObject({ files: FILES, blobReads: 0, treeReads: 1 });
		} finally {
			await pglite.close();
		}
	});

	const env = stackEnv();
	it.skipIf(env === undefined)("lists on Postgres + S3 without reading a file body", async () => {
		const pool = new pg.Pool({ connectionString: env!.databaseUrl });
		const counts = { blobs: 0, trees: 0 };
		const counting: typeof fetch = (input, init) => {
			const request = input instanceof Request ? input : new Request(input, init);
			if (request.method === "GET") {
				if (request.url.includes("/blobs/")) counts.blobs++;
				else if (request.url.includes("/trees/")) counts.trees++;
			}
			return fetch(request);
		};
		const prefix = `m1-be23/${crypto.randomUUID()}`;
		const schemas = new Set<string>();
		try {
			const objects = createS3Objects({ ...env!.s3, prefix, fetch: counting });
			await objects.ensureBucket();
			const result = await listLarge(pgDatabase(pool), objects, () => ({ ...counts }), schemas);
			console.info(`10,000-file listing on Postgres + S3: ${JSON.stringify(result)}`);
			expect(result).toMatchObject({ files: FILES, blobReads: 0, treeReads: 1 });
		} finally {
			await dropSchemas(pgDatabase(pool), schemas);
			await deletePrefix(env!.s3, prefix);
			await pool.end();
		}
	});
});

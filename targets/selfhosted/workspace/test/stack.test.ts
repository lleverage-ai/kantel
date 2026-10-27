import type { CallContext } from "@harbour/contracts";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import {
	createPostgresWorkspaceStore,
	createS3Objects,
	createSelfHostedWorkspaces,
	migrateWorkspaceStore,
	pgDatabase,
} from "../src/index.ts";
import { deletePrefix, dropSchemas, stackEnv } from "./stack.ts";
import { laneSchema } from "./support.ts";

// What only a real server shows: row locks between connections, and S3 keys with awkward characters.
const env = stackEnv();
const owner = (organisationId: string) => ({ kind: "organisation", organisationId }) as const;

describe.skipIf(env === undefined)("self-hosted workspaces on Postgres + S3", () => {
	if (env === undefined) return;
	const pools = [0, 1].map(() => new pg.Pool({ connectionString: env.databaseUrl, max: 2 }));
	const prefix = `m1-be23/${crypto.randomUUID()}`;
	const schemas = new Set<string>();
	const objects = createS3Objects({ ...env.s3, prefix });
	afterAll(async () => {
		await dropSchemas(pgDatabase(pools[0]!), schemas);
		await deletePrefix(env.s3, prefix);
		await Promise.all(pools.map((pool) => pool.end()));
	});

	async function schema(): Promise<string> {
		const name = laneSchema();
		schemas.add(name);
		await migrateWorkspaceStore(pgDatabase(pools[0]!), name);
		await objects.ensureBucket();
		return name;
	}

	it("lets exactly one of two connections advance a head both loaded, and keeps the winner's version", async () => {
		const name = await schema();
		const ctx: CallContext = { actor: { kind: "system", component: "test" }, organisationId: "org-1" };
		const record = await createSelfHostedWorkspaces({ db: pgDatabase(pools[0]!), objects, schema: name }).create(ctx, {
			owner: owner("org-1"),
		});
		for (let round = 0; round < 10; round++) {
			const stores = pools.map((pool) => createPostgresWorkspaceStore({ db: pgDatabase(pool), objects, schema: name }));
			const heads = await Promise.all(stores.map((store) => store.load(record.id)));
			const version = heads[0]!.record.head + 1;
			const results = await Promise.all(
				stores.map((store, index) =>
					store.advance(
						heads[index]!,
						{ ...heads[index]!, record: { ...heads[index]!.record, head: version }, tree: `tree-${index}` },
						{ info: { version, at: round, actor: ctx.actor, changed: [`by-${index}`] }, tree: `tree-${index}` },
					),
				),
			);
			expect(results.filter(Boolean), `round ${round}`).toHaveLength(1);
			const winner = results.indexOf(true);
			const head = await stores[0]!.load(record.id);
			expect(head?.tree).toBe(`tree-${winner}`);
			expect(await stores[0]!.treeAt(head!, version)).toBe(`tree-${winner}`);
			expect((await stores[1]!.history(head!, version + 1, 1))[0]?.changed).toEqual([`by-${winner}`]);
		}
	});

	it("keeps organisations with awkward IDs apart and readable on S3", async () => {
		const name = await schema();
		const workspaces = createSelfHostedWorkspaces({ db: pgDatabase(pools[0]!), objects, schema: name });
		for (const organisationId of ["org/ä %+&?#", "org-ä", "org%2F"]) {
			const ctx: CallContext = { actor: { kind: "system", component: "test" }, organisationId };
			const record = await workspaces.create(ctx, {
				owner: owner(organisationId),
				seed: { name: "s", sources: [{ kind: "files", files: { "dir name/ä +%.txt": organisationId } }] },
			});
			const file = await workspaces.read(ctx, record.id, "dir name/ä +%.txt");
			expect(new TextDecoder().decode(file.content)).toBe(organisationId);
		}
	});
});

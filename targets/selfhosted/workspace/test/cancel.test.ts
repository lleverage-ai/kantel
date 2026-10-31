import { PGlite } from "@electric-sql/pglite";
import type { CallContext } from "@kantel/contracts";
import { afterAll, describe, expect, it } from "vitest";
import {
	createMemoryObjects,
	createSelfHostedWorkspaces,
	migrateWorkspaceStore,
	type SqlDatabase,
} from "../src/index.ts";
import { laneSchema, pgliteDatabase } from "./support.ts";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const owner = { kind: "organisation", organisationId: "org-1" } as const;

const pglite = new PGlite();
afterAll(() => pglite.close());

describe("a cancelled commit on Postgres", () => {
	it("rolls back when the signal fires inside the head transaction", async () => {
		const real = pgliteDatabase(pglite);
		const schema = laneSchema();
		await migrateWorkspaceStore(real, schema);
		const controller = new AbortController();
		// Cancels as the head UPDATE runs: after the commit's own last check, before the transaction commits.
		const cancelling: SqlDatabase = {
			query: real.query,
			transaction: (work) =>
				real.transaction((client) =>
					work({
						async query(text, values) {
							const result = await client.query(text, values);
							if (text.includes("UPDATE") && text.includes("workspace_heads")) controller.abort();
							return result as never;
						},
					}),
				),
		};
		const objects = createMemoryObjects();
		const workspaces = createSelfHostedWorkspaces({ db: real, objects, schema });
		const record = await workspaces.create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "files", files: { "a.txt": "v1" } }] },
		});
		await expect(
			createSelfHostedWorkspaces({ db: cancelling, objects, schema }).commit(
				{ ...ctx, signal: controller.signal },
				record.id,
				{ baseVersion: 1, changes: [{ op: "put", path: "a.txt", content: "late" }] },
			),
		).rejects.toMatchObject({ code: "aborted" });
		const fresh = createSelfHostedWorkspaces({ db: real, objects, schema });
		expect((await fresh.get(ctx, record.id)).head).toBe(1);
		expect(new TextDecoder().decode((await fresh.read(ctx, record.id, "a.txt")).content)).toBe("v1");
		expect((await fresh.history(ctx, record.id)).items.map((item) => item.version)).toEqual([1, 0]);
	});
});

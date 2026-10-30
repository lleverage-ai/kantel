import { registerWorkspaceConformance } from "@harbour/testing/workspace";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3Objects, pgDatabase } from "../src/index.ts";
import { deletePrefix, dropSchemas, stackEnv } from "./stack.ts";
import { createdSchemas, providers } from "./support.ts";

// The conformance suite on a real Postgres and S3 (MinIO): set HARBOUR_TEST_DATABASE_URL and HARBOUR_TEST_S3_* (see
// ../README.md). Skipped without them, so CI's `pnpm -r test` stays service-free.
const env = stackEnv();
const pool = env === undefined ? undefined : new pg.Pool({ connectionString: env.databaseUrl, max: 8 });
const run = `m1-be23/${crypto.randomUUID()}`;

if (env !== undefined && pool !== undefined) {
	const objects = createS3Objects({ ...env.s3, prefix: run });
	beforeAll(() => objects.ensureBucket());
	afterAll(async () => {
		await dropSchemas(pgDatabase(pool), createdSchemas);
		await deletePrefix(env.s3, run);
		await pool.end();
	});
	for (const [name, provider] of Object.entries(providers(async () => ({ db: pgDatabase(pool), objects })))) {
		registerWorkspaceConformance(
			{ describe, expect, it },
			`self-hosted workspaces on Postgres + S3, ${name}`,
			provider,
			{
				projectAccess: true,
				keyed: true,
				seeding: true,
				fork: true,
				orgFiles: true,
			},
		);
	}
} else {
	describe.skip("self-hosted workspaces on Postgres + S3 (set HARBOUR_TEST_DATABASE_URL and HARBOUR_TEST_S3_*)", () => {
		it("needs the stack", () => {});
	});
}

// Kantel's workspace conformance suite against PostgresWorkspaces, on the compose stack's Postgres and MinIO.
// Each case gets its own key prefix; workspace IDs are random UUIDs, so runs never collide.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { S3Client } from "bun";
import pg from "pg";
import { registerWorkspaceConformance } from "../../../packages/testing/src/workspace.ts";
import { createMemoryProjectFiles } from "../../../packages/workspace/src/memory.ts";
import { PostgresLeases } from "../src/lease.ts";
import { migrate } from "../src/main.ts";
import { MinioWorkspace } from "../src/workspace.ts";
import { PostgresWorkspaces } from "../src/workspaces.ts";

const url = process.env.KANTEL_DATABASE_URL ?? "postgres://harbour:harbour@127.0.0.1:55432/harbour";
const s3Options = {
	endpoint: process.env.S3_ENDPOINT ?? "http://127.0.0.1:59000",
	bucket: "harbour",
	accessKeyId: "harbour",
	secretAccessKey: "harbour-dev-secret",
};
const pool = new pg.Pool({ connectionString: url });
const s3 = new S3Client({ ...s3Options, region: "us-east-1" });

beforeAll(async () => {
	await migrate(pool);
	// MinIO starts empty; reuse the spike's bucket bootstrap.
	await new MinioWorkspace(pool, new PostgresLeases(pool), s3Options).ensureBucket();
});
afterAll(() => pool.end());

const suite = "self-hosted workspaces (Postgres + MinIO)";

registerWorkspaceConformance({ describe, expect, it }, suite, async (deps, use) => {
	// Project files stay in memory: the suite needs a source with `write`; mount sources are not durable here.
	const projectFiles = createMemoryProjectFiles();
	const workspaces = new PostgresWorkspaces({
		pool,
		s3,
		clock: deps.clock,
		audit: deps.audit,
		sources: [projectFiles],
		prefix: `conformance/${crypto.randomUUID()}`,
	});
	await use({ workspaces, projectFiles });
});

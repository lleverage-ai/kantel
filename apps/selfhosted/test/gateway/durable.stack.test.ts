// The gateway on its real components (durable.ts), against the compose stack's Postgres and MinIO: the end-to-end pass,
// then a restart on the same schema that must keep the deployment, its sessions, workspace and audit trail.
//
// Runs when HARBOUR_TEST_POSTGRES_URL and HARBOUR_TEST_S3_ENDPOINT are set (bindings.ts sets them in CI). Each run gets
// a fresh schema, dropped afterwards, and its own object prefix.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallContext } from "@harbour/contracts";
import pg from "pg";
import { afterAll, describe, expect, test } from "vitest";
import { type Bootstrap, bootstrap, type GatewayComponents } from "../../src/gateway/components.ts";
import { createDurableGatewayComponents, type DurableConfig } from "../../src/gateway/durable.ts";
import { createGateway } from "../../src/gateway/gateway.ts";
import { listen } from "../../src/gateway/node-http.ts";
import { runGatewayE2e } from "./e2e.ts";

const databaseUrl = process.env.HARBOUR_TEST_POSTGRES_URL ?? "";
const s3Endpoint = process.env.HARBOUR_TEST_S3_ENDPOINT ?? "";
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const config: DurableConfig = {
	databaseUrl,
	schema: `m1sh_gateway_${run}`,
	s3: {
		endpoint: s3Endpoint,
		bucket: process.env.HARBOUR_TEST_S3_BUCKET ?? "harbour-m1-sh1",
		accessKeyId: process.env.HARBOUR_TEST_S3_ACCESS_KEY ?? "harbour",
		secretAccessKey: process.env.HARBOUR_TEST_S3_SECRET_KEY ?? "harbour-dev-secret",
		prefix: `m1-sh1/${run}/`,
	},
	log: () => {},
};
const names = { organisation: "Durable", project: "durable" };

async function serve(components: GatewayComponents, seeded: Bootstrap, consoleDir: string) {
	const gateway = createGateway({ components, consoleDir });
	const server = await listen(gateway.fetch, 0, { host: "127.0.0.1" });
	return {
		target: { baseUrl: server.url, ...seeded },
		close: async () => {
			await gateway.close();
			await server.close();
			await components.close();
		},
	};
}

describe.skipIf(databaseUrl === "" || s3Endpoint === "")("the gateway on Postgres and S3", () => {
	let scratch: string | undefined;

	afterAll(async () => {
		if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
		const client = new pg.Client({ connectionString: databaseUrl });
		await client.connect();
		try {
			await client.query(`DROP SCHEMA IF EXISTS ${config.schema} CASCADE`);
		} finally {
			await client.end();
		}
	});

	test("serves every API end to end, and keeps its deployment across a restart", { timeout: 120_000 }, async () => {
		scratch = await mkdtemp(join(tmpdir(), "harbour-durable-"));
		await writeFile(join(scratch, "index.html"), '<!doctype html><div id="root"></div>');

		const first = await createDurableGatewayComponents(config);
		expect(first.bindings).toMatchObject({ identity: "postgres", audit: "postgres", workspaces: "postgres + s3" });
		const seeded = await bootstrap(first, names);
		const one = await serve(first, seeded, scratch);
		let sessionsBefore: number;
		let auditBefore: number;
		const ctx: CallContext = {
			actor: { kind: "system", component: "durable-test" },
			organisationId: seeded.organisationId,
			projectId: seeded.projectId,
		};
		try {
			const checks = await runGatewayE2e(one.target);
			expect(checks.filter((check) => !check.ok)).toEqual([]);
			sessionsBefore = (await first.runtime.directory.list(ctx, { projectId: seeded.projectId })).items.length;
			auditBefore = (await first.audit.query(ctx, { projectId: seeded.projectId }, { limit: 500 })).items.length;
			expect(sessionsBefore).toBeGreaterThan(0);
			expect(auditBefore).toBeGreaterThan(0);
		} finally {
			await one.close();
		}

		// A new process on the same database: the bootstrap finds its deployment instead of making another.
		const second = await createDurableGatewayComponents(config);
		const again = await bootstrap(second, names, seeded);
		expect(again).toEqual(seeded);
		const two = await serve(second, again, scratch);
		try {
			const sessions = await second.runtime.directory.list(ctx, { projectId: seeded.projectId });
			expect(sessions.items.length).toBe(sessionsBefore);
			const audit = await second.audit.query(ctx, { projectId: seeded.projectId }, { limit: 500 });
			expect(audit.items.length).toBeGreaterThanOrEqual(auditBefore);
			// The README went in once: the restart's bootstrap did not commit it again.
			expect((await second.workspaces.get(ctx, seeded.workspaceId)).head).toBe(1);
			const checks = await runGatewayE2e(two.target);
			expect(checks.filter((check) => !check.ok)).toEqual([]);
		} finally {
			await two.close();
		}

		// A key that no longer authenticates (here, a fresh schema) starts the deployment over.
		const other = await createDurableGatewayComponents({ ...config, schema: `${config.schema}_b` });
		try {
			const fresh = await bootstrap(other, names, seeded);
			expect(fresh.organisationId).not.toBe(seeded.organisationId);
		} finally {
			await other.close();
			const client = new pg.Client({ connectionString: databaseUrl });
			await client.connect();
			await client.query(`DROP SCHEMA IF EXISTS ${config.schema}_b CASCADE`).finally(() => client.end());
		}
	});
});

// The gateway on its real components (durable.ts), against the compose stack's Postgres and MinIO: the end-to-end pass,
// then a restart on the same schema that must keep the deployment, its sessions, workspace and audit trail.
//
// Runs when HARBOUR_TEST_POSTGRES_URL and HARBOUR_TEST_S3_ENDPOINT are set (bindings.ts sets them in CI). Each run gets
// fresh schemas and its own object prefix, all removed afterwards.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallContext } from "@harbour/contracts";
import { AwsClient } from "aws4fetch";
import pg from "pg";
import { afterAll, describe, expect, test } from "vitest";
import { type Bootstrap, bootstrap, type GatewayComponents } from "../../src/gateway/components.ts";
import { createDurableGatewayComponents, type DurableConfig, withSearchPath } from "../../src/gateway/durable.ts";
import { createGateway } from "../../src/gateway/gateway.ts";
import { listen } from "../../src/gateway/node-http.ts";
import { runGatewayE2e } from "./e2e.ts";

const databaseUrl = process.env.HARBOUR_TEST_POSTGRES_URL ?? "";
const s3Endpoint = process.env.HARBOUR_TEST_S3_ENDPOINT ?? "";
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const prefix = `m1-sh1/${run}`;
const config: DurableConfig = {
	databaseUrl,
	schema: `m1sh_gateway_${run}`,
	s3: {
		endpoint: s3Endpoint,
		bucket: process.env.HARBOUR_TEST_S3_BUCKET ?? "harbour-m1-sh1",
		accessKeyId: process.env.HARBOUR_TEST_S3_ACCESS_KEY ?? "harbour",
		secretAccessKey: process.env.HARBOUR_TEST_S3_SECRET_KEY ?? "harbour-dev-secret",
		prefix,
	},
	log: () => {},
};
const names = { organisation: "Durable", project: "durable" };
const schemas: string[] = [];

async function sql(text: string): Promise<pg.QueryResult> {
	const client = new pg.Client({ connectionString: databaseUrl });
	await client.connect();
	try {
		return await client.query(text);
	} finally {
		await client.end();
	}
}

/** Deletes this run's objects, and only them. */
async function deleteRunObjects(): Promise<void> {
	const client = new AwsClient({
		accessKeyId: config.s3.accessKeyId,
		secretAccessKey: config.s3.secretAccessKey,
		service: "s3",
		region: "us-east-1",
	});
	const bucket = `${s3Endpoint.replace(/\/+$/, "")}/${encodeURIComponent(config.s3.bucket)}`;
	for (;;) {
		const listed = await client.fetch(`${bucket}?${new URLSearchParams({ "list-type": "2", prefix: `${prefix}/` })}`);
		const listing = await listed.text();
		if (!listed.ok) throw new Error(`listing ${prefix} failed with ${listed.status}`);
		const keys = [...listing.matchAll(/<Key>([^<]+)<\/Key>/g)]
			.map((match) => (match[1] ?? "").replaceAll("&amp;", "&"))
			.filter((key) => key.startsWith(`${prefix}/`));
		if (keys.length === 0) return;
		for (const key of keys) {
			const response = await client.fetch(`${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`, {
				method: "DELETE",
			});
			await response.body?.cancel();
			if (!response.ok) throw new Error(`deleting ${key} failed with ${response.status}`);
		}
	}
}

/** Components for `schema`, closed when `work` ends however it ends. */
async function withComponents<T>(schema: string, work: (components: GatewayComponents) => Promise<T>): Promise<T> {
	schemas.push(schema);
	const components = await createDurableGatewayComponents({ ...config, schema });
	try {
		return await work(components);
	} finally {
		await components.close();
	}
}

async function withGateway<T>(
	components: GatewayComponents,
	seeded: Bootstrap,
	consoleDir: string,
	work: (target: Parameters<typeof runGatewayE2e>[0]) => Promise<T>,
): Promise<T> {
	const gateway = createGateway({ components, consoleDir });
	try {
		const server = await listen(gateway.fetch, 0, { host: "127.0.0.1" });
		try {
			return await work({ baseUrl: server.url, ...seeded });
		} finally {
			await server.close();
		}
	} finally {
		await gateway.close();
	}
}

describe.skipIf(databaseUrl === "" || s3Endpoint === "")("the gateway on Postgres and S3", () => {
	let scratch: string | undefined;

	afterAll(async () => {
		if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
		for (const schema of schemas) await sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
		await deleteRunObjects();
	});

	test("serves every API end to end, and keeps its deployment across a restart", { timeout: 120_000 }, async () => {
		const consoleDir = await mkdtemp(join(tmpdir(), "harbour-durable-"));
		scratch = consoleDir;
		await writeFile(join(consoleDir, "index.html"), '<!doctype html><div id="root"></div>');

		let seeded: Bootstrap | undefined;
		let sessionsBefore = 0;
		let auditBefore = 0;
		const inProject = (deployment: Bootstrap): CallContext => ({
			actor: { kind: "system", component: "durable-test" },
			organisationId: deployment.organisationId,
			projectId: deployment.projectId,
		});

		await withComponents(config.schema, async (first) => {
			expect(first.bindings).toMatchObject({ identity: "postgres", audit: "postgres", workspaces: "postgres + s3" });
			const deployment = await bootstrap(first, names);
			seeded = deployment;
			await withGateway(first, deployment, consoleDir, async (target) => {
				const checks = await runGatewayE2e(target);
				expect(checks.filter((check) => !check.ok)).toEqual([]);
			});
			const ctx = inProject(deployment);
			sessionsBefore = (await first.runtime.directory.list(ctx, { projectId: deployment.projectId })).items.length;
			auditBefore = (await first.audit.query(ctx, { projectId: deployment.projectId }, { limit: 500 })).items.length;
			expect(sessionsBefore).toBeGreaterThan(0);
			expect(auditBefore).toBeGreaterThan(0);
		});
		if (seeded === undefined) throw new Error("no deployment");
		const previous = seeded;

		// A new process on the same database: the bootstrap finds its deployment instead of making another.
		await withComponents(config.schema, async (second) => {
			const again = await bootstrap(second, names, previous);
			expect(again).toEqual(previous);
			const ctx = inProject(again);
			const sessions = await second.runtime.directory.list(ctx, { projectId: again.projectId });
			expect(sessions.items.length).toBe(sessionsBefore);
			const audit = await second.audit.query(ctx, { projectId: again.projectId }, { limit: 500 });
			expect(audit.items.length).toBeGreaterThanOrEqual(auditBefore);
			// The README went in once: the restart's bootstrap did not commit it again.
			expect((await second.workspaces.get(ctx, again.workspaceId)).head).toBe(1);
			await withGateway(second, again, consoleDir, async (target) => {
				const checks = await runGatewayE2e(target);
				expect(checks.filter((check) => !check.ok)).toEqual([]);
			});
		});

		// The key still authenticates but its project is gone: the bootstrap starts over.
		await sql(`DELETE FROM ${config.schema}.identity_projects WHERE id = '${previous.projectId}'`);
		await withComponents(config.schema, async (third) => {
			const fresh = await bootstrap(third, names, previous);
			expect(fresh.projectId).not.toBe(previous.projectId);
		});

		// A key that does not authenticate at all (here, a fresh schema): the bootstrap starts over.
		await withComponents(`${config.schema}_b`, async (other) => {
			const fresh = await bootstrap(other, names, previous);
			expect(fresh.organisationId).not.toBe(previous.organisationId);
		});
	});

	test("reads a database URL as node-postgres does, a socket URL with no host included", () => {
		const socket = withSearchPath("postgres://harbour@/harbour?host=%2Fvar%2Frun%2Fpostgresql", "harbour_m1");
		expect(socket).toMatchObject({ user: "harbour", database: "harbour", host: "/var/run/postgresql" });
		expect(socket.options).toBe("-c search_path=harbour_m1");
	});

	test("leaves TLS settings for node-postgres to read, as it would from the URL", () => {
		const noVerify = new pg.Client(withSearchPath("postgres://u:p@db.example/harbour?ssl=no-verify", "harbour_m1"));
		expect((noVerify as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl).toEqual({
			rejectUnauthorized: false,
		});
		const required = new pg.Client(withSearchPath("postgres://u:p@db.example/harbour?sslmode=require", "harbour_m1"));
		expect((required as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl).toBeTruthy();
	});

	test("keeps its schema when the database URL brings options of its own", async () => {
		// A URL `options` that sets the search path elsewhere must not move the gateway's tables out of its schema.
		// Two `options` parameters: node-postgres takes the last, and so must the gateway.
		const url = new URL(databaseUrl);
		url.searchParams.append("options", "-c statement_timeout=1000");
		url.searchParams.append("options", "-c search_path=public -c statement_timeout=60000");
		const pool = new pg.Pool({ ...withSearchPath(url.toString(), config.schema), max: 1 });
		try {
			const shown = await pool.query(
				"SELECT current_setting('search_path') AS path, current_setting('statement_timeout') AS timeout",
			);
			expect(shown.rows[0]).toEqual({ path: config.schema, timeout: "1min" });
		} finally {
			await pool.end();
		}
	});
});

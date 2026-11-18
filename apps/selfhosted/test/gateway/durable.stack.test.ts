// The gateway on its real components (durable.ts), against the compose stack's Postgres: the end-to-end pass, then a
// restart on the same schema that must keep the deployment and its audit trail, and a start on a schema an older
// version used that leaves the agent plane's tables as they were.
//
// Runs when KANTEL_TEST_POSTGRES_URL is set (bindings.ts sets it in CI). Each run gets fresh schemas, all removed
// afterwards.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CallContext, systemContext } from "@kantel/contracts";
import { createAuthenticator } from "@kantel/identity/authenticator";
import { kantelSessionProvider } from "@kantel/identity/otp";
import pg from "pg";
import { afterAll, describe, expect, test } from "vitest";
import { type Bootstrap, bootstrap, type GatewayComponents } from "../../src/gateway/components.ts";
import { gatewayCompute, gatewayRelay } from "../../src/gateway/compute.ts";
import {
	connectionSettings,
	createDurableGatewayComponents,
	DATABASE_TIMEOUTS,
	type DurableConfig,
	withSearchPath,
} from "../../src/gateway/durable.ts";
import { createGateway } from "../../src/gateway/gateway.ts";
import { listen } from "../../src/gateway/node-http.ts";
import { runGatewayE2e } from "./e2e.ts";
import { tcpProxy } from "./tcp-proxy.ts";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const databaseUrl = process.env.KANTEL_TEST_POSTGRES_URL ?? "";
const run = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
const config: DurableConfig = { databaseUrl, schema: `m1sh_gateway_${run}`, log: () => {} };
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

/** Components for `schema`, closed when `work` ends however it ends. */
async function withComponents<T>(
	schema: string,
	work: (components: GatewayComponents) => Promise<T>,
	extra: Partial<DurableConfig> = {},
): Promise<T> {
	schemas.push(schema);
	const components = await createDurableGatewayComponents({ ...config, ...extra, schema });
	try {
		return await work(components);
	} finally {
		await components.close();
	}
}

/** The gateway as `serveGateway` makes it, the compute plane on the stub, listening while `work` runs. */
async function withGateway<T>(
	components: GatewayComponents,
	seeded: Bootstrap,
	consoleDir: string,
	work: (target: Parameters<typeof runGatewayE2e>[0]) => Promise<T>,
): Promise<T> {
	const authenticator = createAuthenticator({
		identity: components.identity,
		providers: [kantelSessionProvider({ sessions: components.otp.sessions })],
	});
	const compute = await gatewayCompute({
		authenticator,
		identity: components.identity,
		...(components.computeStore === undefined ? {} : { store: components.computeStore }),
	});
	const gateway = createGateway({ components, authenticator, compute: compute.api, consoleDir });
	try {
		const server = await listen(gateway.fetch, 0, { host: "127.0.0.1" });
		try {
			return await work({ baseUrl: server.url, ...seeded, computeKey: compute.superAdminKey });
		} finally {
			await server.close();
		}
	} finally {
		await gateway.close();
		await compute.close();
	}
}

describe.skipIf(databaseUrl === "")("the gateway on Postgres", () => {
	let scratch: string | undefined;

	afterAll(async () => {
		if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
		for (const schema of schemas) await sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
	});

	test("serves the compute plane and identity end to end, and keeps its deployment across a restart", {
		timeout: 120_000,
	}, async () => {
		const consoleDir = await mkdtemp(join(tmpdir(), "kantel-durable-"));
		scratch = consoleDir;
		await writeFile(join(consoleDir, "index.html"), '<!doctype html><div id="root"></div>');

		let seeded: Bootstrap | undefined;
		let auditBefore = 0;
		const inProject = (deployment: Bootstrap): CallContext => ({
			actor: { kind: "system", component: "durable-test" },
			organisationId: deployment.organisationId,
			projectId: deployment.projectId,
		});

		await withComponents(config.schema, async (first) => {
			expect(first.bindings).toEqual({
				identity: "postgres",
				audit: "postgres",
				signIn: "postgres",
				computeStore: "postgres",
			});
			const deployment = await bootstrap(first, names);
			seeded = deployment;
			await withGateway(first, deployment, consoleDir, async (target) => {
				const checks = await runGatewayE2e(target);
				expect(checks.filter((check) => !check.ok)).toEqual([]);
			});
			auditBefore = (await first.audit.query(inProject(deployment), {}, { limit: 500 })).items.length;
			expect(auditBefore).toBeGreaterThan(0);
		});
		if (seeded === undefined) throw new Error("no deployment");
		const previous = seeded;

		// A new process on the same database: the bootstrap finds its deployment instead of making another.
		await withComponents(config.schema, async (second) => {
			const again = await bootstrap(second, names, previous);
			expect(again).toEqual(previous);
			// The compute API's records outlast the restart: its super-admin from the first start is still there.
			expect(await second.computeStore?.users.get("usr_admin")).toMatchObject({ superAdmin: true });
			const audit = await second.audit.query(inProject(again), {}, { limit: 500 });
			expect(audit.items.length).toBeGreaterThanOrEqual(auditBefore);
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

	test("a schema an older version used keeps its agent-plane tables and rows, untouched", {
		timeout: 60_000,
	}, async () => {
		const schema = `${config.schema}_older`;
		schemas.push(schema);
		// What an older version left: tables of the agent plane beside identity's, with a row each.
		await sql(`CREATE SCHEMA ${schema}`);
		await sql(`CREATE TABLE ${schema}.sessions (id text PRIMARY KEY, title text NOT NULL)`);
		await sql(`INSERT INTO ${schema}.sessions VALUES ('ses_older', 'from before the upgrade')`);
		await sql(`CREATE TABLE ${schema}.vault_items (id text PRIMARY KEY, sealed bytea)`);
		await sql(`INSERT INTO ${schema}.vault_items VALUES ('vi_older', '\\x00')`);
		await withComponents(schema, async (components) => {
			const deployment = await bootstrap(components, names);
			expect(deployment.organisationId).toMatch(/^org_/);
		});
		await withComponents(schema, async (components) => {
			await bootstrap(components, names);
		});
		expect((await sql(`SELECT id, title FROM ${schema}.sessions`)).rows).toEqual([
			{ id: "ses_older", title: "from before the upgrade" },
		]);
		expect((await sql(`SELECT id FROM ${schema}.vault_items`)).rows).toEqual([{ id: "vi_older" }]);
	});

	test("the registry of hosts and the relay go in Postgres when sandboxes run on hosts, and outlast a restart", {
		timeout: 60_000,
	}, async () => {
		const computeHosts = { publicUrl: "http://127.0.0.1:58090", portsDomain: "kantel-ports.test" };
		const schema = `${config.schema}_hosts`;
		const issued = await withComponents(
			schema,
			async (components) => {
				expect(components.bindings.computeHosts).toBe("postgres");
				expect(components.bindings.computeRelay).toBe("postgres");
				if (components.computeHosts === undefined || components.relayStore === undefined) throw new Error("no hosts");
				const relay = gatewayRelay(computeHosts, components.computeHosts, components.relayStore);
				const ticket = await relay.tickets.issue({ sandboxId: "sbx_1", port: 22, expiresAt: Date.now() + 60_000 });
				const port = await relay.ports?.expose("sbx_1", 3000, { public: false, subdomain: "brave-otter-ab12cd" });
				return { ticket, url: port?.url ?? "" };
			},
			{ computeHosts },
		);
		// Started again over the same schema, the gateway still honours the URLs it gave out.
		await withComponents(
			schema,
			async (components) => {
				if (components.computeHosts === undefined || components.relayStore === undefined) throw new Error("no hosts");
				const relay = gatewayRelay(computeHosts, components.computeHosts, components.relayStore);
				relay.bind(async () => true);
				expect((await relay.tickets.verify(issued.ticket, Date.now()))?.sandboxId).toBe("sbx_1");
				expect((await relay.ports?.fetch(new Request(issued.url)))?.status).toBe(303);
				const bare = new URL(issued.url);
				bare.search = "";
				expect((await relay.ports?.fetch(new Request(bare)))?.status).toBe(401);
			},
			{ computeHosts },
		);
	});

	test("gateways starting together on an empty database all start, and the schema they make is complete", {
		timeout: 120_000,
	}, async () => {
		// No schema yet: each gateway creates it and runs every migration (audit, identity, compute, hosts, relay) at
		// once. Without the advisory locks some of them fail on a duplicate key in the catalogue.
		const computeHosts = { publicUrl: "http://127.0.0.1:58090", portsDomain: "kantel-ports.test" };
		// A schema's tables and indexes, by name.
		const tables = async (schema: string) =>
			(
				await sql(
					`SELECT tablename AS name FROM pg_tables WHERE schemaname = '${schema}'
					 UNION ALL SELECT indexname FROM pg_indexes WHERE schemaname = '${schema}' ORDER BY name`,
				)
			).rows.map((row) => String(row.name));
		// What one gateway on hosts makes, alone.
		const alone = `${config.schema}_alone`;
		schemas.push(alone);
		await (await createDurableGatewayComponents({ ...config, schema: alone, computeHosts })).close();
		const expected = await tables(alone);
		expect(expected).toEqual(
			expect.arrayContaining([
				"audit_events",
				"identity_organisations",
				"compute_api_records",
				"compute_hosts",
				"compute_relay_tickets",
			]),
		);
		const gateways = 8;
		for (let round = 0; round < 3; round++) {
			const schema = `${config.schema}_together_${round}`;
			schemas.push(schema);
			const started = await Promise.allSettled(
				Array.from({ length: gateways }, () =>
					createDurableGatewayComponents({ ...config, schema, computeHosts, cluster: { heartbeatMs: 60_000 } }),
				),
			);
			for (const result of started) if (result.status === "fulfilled") await result.value.close();
			expect(started.filter((result) => result.status === "rejected").map((result) => String(result.reason))).toEqual(
				[],
			);
			expect(await tables(schema)).toEqual(expected);
		}
	});

	test("the bootstrap makes its named projects once, and a new name brings a new key over them all", {
		timeout: 60_000,
	}, async () => {
		await withComponents(`${config.schema}_projects`, async (components) => {
			const first = await bootstrap(components, { ...names, projects: ["atlas", "durable"] });
			// A name that is the first project's is that project.
			expect(first.projects?.durable).toBe(first.projectId);
			const again = await bootstrap(components, { ...names, projects: ["atlas", "durable"] }, first);
			expect(again).toEqual(first);
			const more = await bootstrap(components, { ...names, projects: ["atlas", "durable", "dev"] }, first);
			expect(more.projects?.atlas).toBe(first.projects?.atlas);
			expect(more.projects?.dev).toMatch(/^prj_/);
			expect(more.apiKey).not.toBe(first.apiKey);
			const system = { ...systemContext("durable-test"), organisationId: first.organisationId };
			await expect(components.identity.authenticateApiKey(system, first.apiKey)).rejects.toThrow();
			const key = await components.identity.authenticateApiKey(system, more.apiKey);
			expect([...(key.projectIds ?? [])].sort()).toEqual(
				[first.projectId, more.projects?.atlas, more.projects?.dev].sort(),
			);
		});
	});

	test("reads a database URL as node-postgres does, a socket URL with no host included", () => {
		const socket = withSearchPath("postgres://harbour@/harbour?host=%2Fvar%2Frun%2Fpostgresql", "harbour_m1");
		expect(socket).toMatchObject({ user: "harbour", database: "harbour", host: "/var/run/postgresql" });
		expect(socket.options).toBe("-c search_path=harbour_m1");
	});

	test("leaves TLS settings for node-postgres to read, as it would from the URL", () => {
		const noVerify = new pg.Client(withSearchPath("postgres://u:p@db.example/kantel?ssl=no-verify", "harbour_m1"));
		expect((noVerify as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl).toEqual({
			rejectUnauthorized: false,
		});
		const required = new pg.Client(withSearchPath("postgres://u:p@db.example/kantel?sslmode=require", "harbour_m1"));
		expect((required as unknown as { connectionParameters: { ssl: unknown } }).connectionParameters.ssl).toBeTruthy();
	});

	test("bounds every wait on Postgres, and the URL's own options still win", async () => {
		const settings = connectionSettings(databaseUrl, config.schema, { ...DATABASE_TIMEOUTS, statementMs: 2_000 });
		expect(settings).toMatchObject({
			connectionTimeoutMillis: 5_000,
			keepAlive: true,
			keepAliveInitialDelayMillis: 10_000,
			query_timeout: 7_000,
		});
		const pool = new pg.Pool({ ...settings, max: 1 });
		try {
			const shown = await pool.query(
				"SELECT current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle",
			);
			expect(shown.rows[0]).toEqual({ statement: "2s", idle: "30s" });
		} finally {
			await pool.end();
		}
		const url = new URL(databaseUrl);
		url.searchParams.append("options", "-c statement_timeout=60000");
		const own = new pg.Pool({ ...connectionSettings(url.toString(), config.schema, DATABASE_TIMEOUTS), max: 1 });
		try {
			const shown = await own.query("SELECT current_setting('statement_timeout') AS statement");
			expect(shown.rows[0]).toEqual({ statement: "1min" });
		} finally {
			await own.end();
		}
	});

	test("a gateway that starts while Postgres is down waits for it, and starts once it's back", {
		timeout: 60_000,
	}, async () => {
		const proxy = await tcpProxy(databaseUrl);
		const logs: string[] = [];
		try {
			await proxy.restart();
			const schema = `${config.schema}_late`;
			schemas.push(schema);
			let settled = false;
			const starting = createDurableGatewayComponents({
				...config,
				databaseUrl: proxy.url,
				schema,
				log: (message) => logs.push(message),
				startRetryMs: [100, 200],
			});
			starting.then(
				() => (settled = true),
				() => (settled = true),
			);
			await pause(2_000);
			expect(settled).toBe(false);
			expect(logs.filter((line) => line.includes("Postgres can't be reached")).length).toBeGreaterThan(3);
			await proxy.up();
			const components = await starting;
			try {
				expect(logs).toContain("[gateway] Postgres is reachable again; starting");
				await components.computeStore?.users.put({ id: "usr_late" } as never);
				expect(await components.computeStore?.users.get("usr_late")).toEqual({ id: "usr_late" });
			} finally {
				await components.close();
			}
		} finally {
			await proxy.close();
		}
	});

	test("a gateway under load fails calls fast while Postgres restarts or vanishes, and serves again after", {
		timeout: 120_000,
	}, async () => {
		const proxy = await tcpProxy(databaseUrl);
		const logs: string[] = [];
		const schema = `${config.schema}_restart`;
		schemas.push(schema);
		const components = await createDurableGatewayComponents({
			...config,
			databaseUrl: proxy.url,
			schema,
			log: (message) => logs.push(message),
			timeouts: { connectMs: 1_000, statementMs: 1_000 },
		});
		const store = components.computeStore;
		if (store === undefined) throw new Error("no compute store");
		interface Call {
			readonly at: number;
			readonly ms: number;
			readonly error?: string;
		}
		const calls: Call[] = [];
		let running = true;
		// Eight callers, each writing a record and reading it back, over and over.
		const caller = async (n: number) => {
			for (let i = 0; running; i++) {
				const at = Date.now();
				try {
					const id = `usr_load_${n}_${i}`;
					await store.users.put({ id } as never);
					if ((await store.users.get(id)) === undefined) throw new Error(`${id} not read back`);
					calls.push({ at, ms: Date.now() - at });
				} catch (error) {
					calls.push({ at, ms: Date.now() - at, error: (error as Error).message });
					await pause(50);
				}
			}
		};
		const callers = Array.from({ length: 8 }, (_, n) => caller(n));
		const during = (from: number, to: number) => calls.filter((call) => call.at >= from && call.at < to);
		try {
			await pause(1_000);
			// A restart: every connection drops, and none is accepted for 3 s.
			const restartAt = Date.now();
			await proxy.restart();
			await pause(3_000);
			await proxy.up();
			const backAt = Date.now();
			await pause(3_000);
			// The server vanishes: connections stay open, and nothing comes back on them, for 8 s.
			const vanishAt = Date.now();
			proxy.blackhole();
			await pause(8_000);
			await proxy.restart();
			await proxy.up();
			const returnAt = Date.now();
			await pause(3_000);
			running = false;
			await Promise.all(callers);
			const endAt = Date.now();

			// Calls in flight when the connections drop may fail; every one that finished before then succeeded.
			const before = calls.filter((call) => call.at + call.ms < restartAt);
			expect(before.length).toBeGreaterThan(8);
			expect(before.filter((call) => call.error !== undefined)).toEqual([]);
			// Refused connections fail a call within its two retries (100 ms and 1 s) and the connect timeout.
			const outage = during(restartAt, backAt);
			expect(outage.filter((call) => call.error !== undefined).length).toBeGreaterThan(0);
			expect(Math.max(...outage.map((call) => call.ms))).toBeLessThan(5_000);
			// A second after it's back, every call succeeds, on the same components: no restart.
			const recovered = during(backAt + 1_000, vanishAt).filter((call) => call.at + call.ms < vanishAt);
			expect(recovered.length).toBeGreaterThan(8);
			expect(recovered.filter((call) => call.error !== undefined)).toEqual([]);
			// Unanswered statements are given up 5 s after the statement timeout, and unanswered connects after 1 s each.
			const vanished = calls.filter((call) => call.at < returnAt && call.at + call.ms > vanishAt);
			expect(vanished.filter((call) => call.error !== undefined).length).toBeGreaterThan(0);
			expect(Math.max(...vanished.map((call) => call.ms))).toBeLessThan(12_000);
			const again = during(returnAt + 1_000, endAt);
			expect(again.length).toBeGreaterThan(8);
			expect(again.filter((call) => call.error !== undefined)).toEqual([]);
			expect(logs.some((line) => line.includes("opening new ones"))).toBe(true);
		} finally {
			running = false;
			await Promise.all(callers);
			await components.close();
			await proxy.close();
		}
	});

	test("after a failover leaves its connections read-only, a gateway drops them and writes again without a restart", {
		timeout: 60_000,
	}, async () => {
		// A role of its own, so its sessions can be made read-only, as an old primary's are once it is a standby, without
		// touching anyone else's.
		const role = `kantel_failover_${run}`;
		const database = String((await sql("SELECT current_database() AS name")).rows[0]?.name);
		await sql(`CREATE ROLE ${role} LOGIN PASSWORD '${run}'`);
		await sql(`GRANT CREATE ON DATABASE ${database} TO ${role}`);
		const url = new URL(databaseUrl);
		url.username = role;
		url.password = run;
		const schema = `${config.schema}_failover`;
		schemas.push(schema);
		const logs: string[] = [];
		try {
			const components = await createDurableGatewayComponents({
				...config,
				databaseUrl: url.toString(),
				schema,
				log: (message) => logs.push(message),
			});
			const store = components.computeStore;
			if (store === undefined) throw new Error("no compute store");
			try {
				await store.users.put({ id: "usr_before" } as never);
				// The old primary comes back as a standby, and the gateway reconnects to it: its sessions are read-only.
				await sql(`ALTER ROLE ${role} SET default_transaction_read_only = on`);
				await sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${role}'`);
				await pause(200);
				await expect(store.users.put({ id: "usr_during" } as never)).rejects.toMatchObject({ code: "25006" });
				// The endpoint moves to the new primary: new sessions can write, but the gateway's open ones still can't.
				await sql(`ALTER ROLE ${role} RESET default_transaction_read_only`);
				const movedAt = Date.now();
				let written = false;
				while (!written && Date.now() - movedAt < 10_000) {
					written = await store.users.put({ id: "usr_after" } as never).then(
						() => true,
						() => false,
					);
				}
				expect(written).toBe(true);
				expect(Date.now() - movedAt).toBeLessThan(5_000);
				for (let i = 0; i < 20; i++) await store.users.put({ id: `usr_after_${i}` } as never);
				expect(await store.users.get("usr_after")).toEqual({ id: "usr_after" });
				expect(logs.some((line) => line.includes("read-only transaction"))).toBe(true);
			} finally {
				await components.close();
			}
		} finally {
			await sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
			await sql(`REVOKE CREATE ON DATABASE ${database} FROM ${role}`);
			await sql(`DROP ROLE ${role}`);
		}
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

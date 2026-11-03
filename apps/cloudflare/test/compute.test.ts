// The compute API on the Worker's gateway, in Node: an Access sign-in is a compute person (the organisation's admin its
// super-admin), sandboxes run commands on the stub, the records live in the stack object's SQLite and outlast the
// object, and a sandbox whose machine went with the object's memory gets a fresh one.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Authenticator } from "@kantel/contracts";
import { createMockAccess } from "@kantel/identity/testing";
import type { SqlValue } from "@kantel/sql";
import { describe, expect, it } from "vitest";
import { type ObjectSqlLike, objectSqlDriver } from "../src/audit-outbox.ts";
import { createStackCompute } from "../src/compute.ts";
import { gatewayConfig } from "../src/config.ts";
import { createGateway } from "../src/gateway.ts";
import { createStack } from "../src/stack.ts";

const TEAM_DOMAIN = "kantel-test.cloudflareaccess.com";
const AUD = "aud-kantel-test";
const ADMIN = "tom@kantel.test";
const BASE = "https://kantel.test";

/** A Durable Object's `ctx.storage.sql` over `node:sqlite`, as audit-outbox.test.ts has it. */
function objectSql(db: DatabaseSync) {
	const sql: ObjectSqlLike = {
		exec(query: string, ...bindings: SqlValue[]) {
			if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(query)) throw new Error(`refused: ${query}`);
			const statement = db.prepare(query);
			const values = bindings as SQLInputValue[];
			let rows: unknown[] = [];
			if (statement.columns().length > 0) rows = statement.all(...values);
			else statement.run(...values);
			return { toArray: () => rows };
		},
	};
	return objectSqlDriver(sql, <T>(work: () => T): T => {
		db.exec("BEGIN");
		try {
			const result = work();
			db.exec("COMMIT");
			return result;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	});
}

/** One stack object's start over `db` (its own SQLite); a second call over the same `db` is the object after eviction. */
async function start(db?: DatabaseSync) {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const config = gatewayConfig({
		KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		KANTEL_ACCESS_AUD: AUD,
		KANTEL_ADMIN_EMAIL: ADMIN,
	});
	const stack = await createStack({
		config,
		accessFetch: mock.fetch,
		...(db === undefined ? {} : { storage: { compute: objectSql(db) } }),
	});
	const gateway = createGateway(stack);
	const headers = { "cf-access-jwt-assertion": await mock.sign({ sub: "access-subject-1", email: ADMIN }) };
	const call = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
		const response = await gateway.fetch(
			new Request(`${BASE}${path}`, {
				method,
				headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
		return { status: response.status, body: (await response.json()) as Record<string, unknown> };
	};
	return { stack, call, close: () => stack.compute.close() };
}

describe("the compute API on the gateway", () => {
	it("signs the Access person in, the organisation's admin as the super-admin", async () => {
		const { call, close } = await start();
		const whoami = await call("GET", "/v1/whoami");
		expect(whoami.status).toBe(200);
		expect(whoami.body).toMatchObject({ superAdmin: true, mode: "hosted" });
		const hosts = await call("GET", "/v1/admin/hosts");
		expect(hosts.status).toBe(200);
		expect((hosts.body.items as { name: string }[]).map((host) => host.name)).toEqual(["stub"]);
		await close();
	});

	it("refuses an anonymous call and an identity ktk_ key with 401", async () => {
		const { call, stack, close } = await start();
		const service = await stack.identity.createServiceIdentity(stack.admin, { name: "host" });
		const key = await stack.identity.issueApiKey(stack.admin, {
			serviceId: service.id,
			projectIds: [stack.project.id],
			role: "operator",
		});
		expect((await call("GET", "/v1/whoami", undefined, { "cf-access-jwt-assertion": "" })).status).toBe(401);
		const withKey = await call("GET", "/v1/sandboxes", undefined, {
			"cf-access-jwt-assertion": "",
			authorization: `Bearer ${key.secret}`,
		});
		expect(withKey.status).toBe(401);
		// Identity's own routes still take it.
		expect((await call("GET", "/v1/me", undefined, { authorization: `Bearer ${key.secret}` })).status).toBe(200);
		await close();
	});

	it("makes a sandbox that runs commands, and a ksk_ key that works", async () => {
		const { call, close } = await start();
		const made = await call("POST", "/v1/sandboxes", { name: "demo", wait: true });
		expect(made.status).toBe(201);
		expect(made.body.state).toBe("running");
		const ran = await call("POST", `/v1/sandboxes/${made.body.id}/commands`, { command: "echo hello > a && cat a" });
		expect(ran.status).toBe(200);
		expect(ran.body).toMatchObject({ exitCode: 0, stdout: "hello\n" });
		const key = await call("POST", "/v1/api-keys", { name: "cli", scopes: ["sandboxes:read"] });
		expect(key.status).toBe(201);
		const listed = await call("GET", "/v1/sandboxes", undefined, {
			"cf-access-jwt-assertion": "",
			authorization: `Bearer ${key.body.secret}`,
		});
		expect(listed.status).toBe(200);
		expect((listed.body.items as { name: string }[]).map((sandbox) => sandbox.name)).toEqual(["demo"]);
		await close();
	});

	it("keeps the records in the object's SQLite, and gives a sandbox a fresh machine after the object's memory goes", async () => {
		const db = new DatabaseSync(":memory:");
		// The same person on each start (the stack's identity is in memory in these tests; deployed, it is in D1).
		const authenticator: Authenticator = {
			authenticate: async () => ({
				method: "cloudflare_access",
				actor: { kind: "human", userId: "usr_tom" },
				organisationId: "org_1",
			}),
		};
		const open = async () => {
			const compute = await createStackCompute({
				authenticator,
				identity: { authorize: async () => undefined },
				sql: objectSql(db),
			});
			const call = async (method: string, path: string, body?: unknown) => {
				const response = await compute.fetch(
					new Request(`${BASE}${path}`, {
						method,
						headers: { authorization: "Bearer person", "content-type": "application/json" },
						...(body === undefined ? {} : { body: JSON.stringify(body) }),
					}),
				);
				expect(response).toBeDefined();
				return { status: response?.status, body: (await response?.json()) as Record<string, unknown> };
			};
			return { compute, call };
		};

		const first = await open();
		const made = await first.call("POST", "/v1/sandboxes", { name: "kept", wait: true });
		expect(made.status).toBe(201);
		const sandboxId = String(made.body.id);
		const wrote = await first.call("POST", `/v1/sandboxes/${sandboxId}/commands`, { command: "echo 1 > here" });
		expect(wrote.body).toMatchObject({ exitCode: 0 });
		await first.compute.close();

		// The object again, over the same SQLite, with none of the first one's memory.
		const again = await open();
		const listed = await again.call("GET", "/v1/sandboxes");
		expect((listed.body.items as { id: string; state: string }[]).map(({ id, state }) => ({ id, state }))).toEqual([
			{ id: sandboxId, state: "running" },
		]);
		// Its machine is new: the file went with the old one's memory, and commands run again.
		const ran = await again.call("POST", `/v1/sandboxes/${sandboxId}/commands`, { command: "ls; echo back" });
		expect(ran.body).toMatchObject({ exitCode: 0, stdout: "back\n" });
		// It stops and starts as any other.
		expect((await again.call("POST", `/v1/sandboxes/${sandboxId}/stop`, { wait: true })).body.state).toBe("stopped");
		expect((await again.call("POST", `/v1/sandboxes/${sandboxId}/start`, { wait: true })).body.state).toBe("running");
		await again.compute.close();
	});

	it("leaves every other API path to identity, audit or a 404", async () => {
		const { call, close } = await start();
		expect((await call("GET", "/v1/me")).status).toBe(200);
		expect((await call("GET", "/v1/sessions")).status).toBe(404);
		expect((await call("GET", "/v1/compute/sandboxes")).status).toBe(404);
		await close();
	});
});

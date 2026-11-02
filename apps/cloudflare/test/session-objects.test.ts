// Session objects (`KANTEL_SESSION_OBJECTS=on`, src/session-homes.ts), in Node: the stack and a session object, each
// over its own SQLite (`node:sqlite`), sharing one D1 stand-in and one workspace store, with the session object's store
// calls answered by the stack's store in process (`stackStoreCall`), as `KantelStack.sessionStoreCall` answers them.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SessionId } from "@kantel/contracts";
import { createMockAccess } from "@kantel/identity/testing";
import type { SessionStore } from "@kantel/runtime/store";
import type { SqlValue } from "@kantel/runtime-cloudflare";
import { createMemoryObjectBucket } from "@kantel/skills/sql";
import { syncSqliteDriver } from "@kantel/sql/sqlite";
import { createMemoryWorkspaceStore } from "@kantel/workspace/stored";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import { createGateway } from "../src/gateway.ts";
import { routeRequest } from "../src/route.ts";
import {
	createSessionHomes,
	remoteSessionStore,
	type SessionHomes,
	sessionIdOfPath,
	sessionObjectsOn,
	stackStoreCall,
} from "../src/session-homes.ts";
import {
	type BootstrapRecord,
	createStack,
	DEFAULT_AGENT_ID,
	type SessionObjectStorage,
	type Stack,
} from "../src/stack.ts";

const TEAM_DOMAIN = "kantel-test.cloudflareaccess.com";
const AUD = "aud-kantel-test";
const ADMIN = "tom@kantel.test";
const BASE = "https://kantel.test";
const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

const opened: Stack[] = [];
afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close();
});

/** A Durable Object's SQL, as `ctx.storage.sql` has it, over `node:sqlite`. */
function objectSql(db: DatabaseSync) {
	return {
		exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
			if (TRANSACTION_CONTROL.test(query)) throw new Error(`Durable Object SQL refuses "${query.trim()}"`);
			const statement = db.prepare(query);
			const values = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b)) as SQLInputValue[];
			const rows = statement.columns().length > 0 ? (statement.all(...values) as T[]) : [];
			if (statement.columns().length === 0) statement.run(...values);
			return { toArray: () => rows };
		},
	};
}

/** The rest of an object's storage the session core uses: an async transaction and an alarm. */
function objectStorage(db: DatabaseSync, store?: SessionObjectStorage["store"]): SessionObjectStorage {
	let alarm: number | null = null;
	let lock: Promise<unknown> = Promise.resolve();
	return {
		sql: objectSql(db),
		transaction<T>(work: () => Promise<T>): Promise<T> {
			const next = lock.then(async () => {
				db.exec("BEGIN IMMEDIATE");
				try {
					const result = await work();
					db.exec("COMMIT");
					return result;
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			});
			lock = next.catch(() => undefined);
			return next;
		},
		setAlarm: async (at) => {
			alarm = at;
		},
		getAlarm: async () => alarm,
		...(store === undefined ? {} : { store }),
	};
}

interface World {
	readonly stack: Stack;
	readonly stackDb: DatabaseSync;
	readonly homes: SessionHomes;
	readonly stackStore: () => SessionStore;
	/** A session object named `home`, started over its own SQLite (its restart with the same `db`). */
	readonly sessionObject: (home: string, db?: DatabaseSync) => Promise<{ stack: Stack; db: DatabaseSync }>;
	readonly headers: Record<string, string>;
}

async function world(): Promise<World> {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const config = gatewayConfig({
		KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		KANTEL_ACCESS_AUD: AUD,
		KANTEL_ADMIN_EMAIL: ADMIN,
	});
	const d1 = syncSqliteDriver(new DatabaseSync(":memory:"));
	const workspaces = createMemoryWorkspaceStore();
	const skillObjects = createMemoryObjectBucket();
	const stackDb = new DatabaseSync(":memory:");
	let saved: BootstrapRecord = {};
	let stackStore: SessionStore | undefined;
	const homes = createSessionHomes(objectSql(stackDb));
	const stack = await createStack({
		config,
		accessFetch: mock.fetch,
		storage: {
			sql: d1,
			workspaces,
			skillObjects,
			bootstrap: {
				load: async () => saved,
				save: async (record) => {
					saved = record;
				},
			},
			sessions: objectStorage(stackDb, (local) => {
				stackStore = local;
				return local;
			}),
		},
	});
	opened.push(stack);
	const sessionObject = async (home: string, db = new DatabaseSync(":memory:")) => {
		// Over RPC, arguments and answers are copies.
		const call = async (method: string, args: readonly unknown[]) =>
			structuredClone(await stackStoreCall(stackStore!, homes, home, method, structuredClone(args)));
		const started = await createStack({
			config,
			accessFetch: mock.fetch,
			home: true,
			storage: {
				sql: d1,
				workspaces,
				skillObjects,
				bootstrap: { load: async () => structuredClone(saved), save: async () => {} },
				sessions: objectStorage(db, (_local, database) => remoteSessionStore(call, database)),
			},
		});
		opened.push(started);
		return { stack: started, db };
	};
	const headers = {
		"cf-access-jwt-assertion": await mock.sign({ sub: "access-subject-1", email: ADMIN }),
		"content-type": "application/json",
	};
	return { stack, stackDb, homes, stackStore: () => stackStore!, sessionObject, headers };
}

function caller(stack: Stack, headers: Record<string, string>) {
	const gateway = createGateway(stack);
	return (path: string, init: RequestInit = {}) => gateway.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function promptAndWait(call: ReturnType<typeof caller>, sessionId: string, text: string) {
	const prompted = await call(`/v1/sessions/${sessionId}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
	expect(prompted.status).toBe(202);
	const submission = (await prompted.json()) as { id: string };
	const answered = await call(
		`/v1/sessions/${sessionId}/result?submission=${encodeURIComponent(submission.id)}&timeoutMs=5000`,
	);
	return (await answered.json()) as { status: string; answer?: string };
}

describe("a session in its own object", () => {
	it("runs there, with its Pi storage and wake in that object, and is listed by the stack", async () => {
		const w = await world();
		const object = await w.sessionObject("home-1");
		// The same organisation, project and admin: read from the stack's bootstrap, never made again.
		expect(object.stack.organisation.id).toBe(w.stack.organisation.id);
		expect(object.stack.admin).toEqual(w.stack.admin);

		const inObject = caller(object.stack, w.headers);
		const created = await inObject("/v1/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId: w.stack.project.id, agentId: DEFAULT_AGENT_ID, title: "Own object" }),
		});
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };
		expect(w.homes.homeOf(id)).toBe("home-1");

		expect(await promptAndWait(inObject, id, "ping")).toMatchObject({ status: "answered", answer: "Echo: ping" });

		// The transcript's tables are the object's; the stack holds only the record, and no wake to resume it by.
		// Pi's tables are named `pi_<the session's UUID, without dashes>_…`.
		const piTables = (db: DatabaseSync) =>
			(
				db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'pi_*_durable_schema'").all() as {
					name: string;
				}[]
			).length;
		expect(piTables(object.db)).toBeGreaterThan(0);
		expect(piTables(w.stackDb)).toBe(0);
		expect(await w.stackStore().wakeable(Date.now() + 3_600_000)).toEqual([]);
		// A session object's open sessions are only its own.
		const openIn = async (home: string) =>
			((await stackStoreCall(w.stackStore(), w.homes, home, "openSessions", [])) as { record: { id: string } }[]).map(
				(session) => session.record.id,
			);
		expect(await openIn("home-1")).toEqual([id]);
		expect(await openIn("home-other")).toEqual([]);

		// The stack's directory lists it, with its status, and its default profile is the stack's.
		const listed = await caller(w.stack, w.headers)(`/v1/sessions?projectId=${w.stack.project.id}`);
		const items = ((await listed.json()) as { items: { id: string; title: string; status: string }[] }).items;
		expect(items).toMatchObject([{ id, title: "Own object" }]);
		expect((await w.stackStore().profiles(w.stack.organisation.id)).map((p) => p.id)).toEqual([DEFAULT_AGENT_ID]);
	});

	it("keeps its transcript across the object's restart", async () => {
		const w = await world();
		const first = await w.sessionObject("home-2");
		const call = caller(first.stack, w.headers);
		const created = await call("/v1/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId: w.stack.project.id, agentId: DEFAULT_AGENT_ID }),
		});
		const { id } = (await created.json()) as { id: string };
		await promptAndWait(call, id, "one");
		await first.stack.close();

		const second = await w.sessionObject("home-2", first.db);
		const snapshot = await second.stack.runtime.runtime.snapshot(second.stack.admin, id as SessionId);
		expect(snapshot.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
		expect(await promptAndWait(caller(second.stack, w.headers), id, "two")).toMatchObject({ answer: "Echo: two" });
	});
});

describe("the session objects' store", () => {
	it("keeps wakes in the object and everything else in the stack's store", async () => {
		const db = new DatabaseSync(":memory:");
		const calls: string[] = [];
		const stored = {
			record: { id: "ses_a" },
			profile: {},
			sequence: 1,
			aborts: 0,
			closed: false,
			wakeAt: 5,
		};
		const store = await remoteSessionStore(
			async (method, args) => {
				calls.push(method);
				if (method === "session") return args[0] === "ses_a" ? stored : undefined;
				return undefined;
			},
			{
				run: async (sql, ...params) => void db.prepare(sql).run(...(params as SQLInputValue[])),
				all: async <T extends object>(sql: string, ...params: (string | number | null)[]) =>
					db.prepare(sql).all(...(params as SQLInputValue[])) as T[],
				get: async <T extends object>(sql: string, ...params: (string | number | null)[]) =>
					db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined,
			},
		);
		const id = "ses_a" as SessionId;
		// The stack's wake is never the object's: none is set here yet.
		expect((await store.session(id))?.wakeAt).toBeUndefined();
		await store.setWake(id, 100);
		expect((await store.session(id))?.wakeAt).toBe(100);
		expect((await store.wakeable(99)).length).toBe(0);
		expect((await store.wakeable(100)).map((s) => s.record.id)).toEqual(["ses_a"]);
		expect(await store.nextWake(50)).toBe(100);
		expect(await store.nextWake(100)).toBeUndefined();
		await store.setWake(id, undefined);
		expect(await store.wakeable(1_000)).toEqual([]);
		expect(calls).not.toContain("setWake");
		await expect(
			stackStoreCall({} as SessionStore, createSessionHomes(objectSql(db)), "h", "setWake", []),
		).rejects.toThrow(/No such session store method/);
	});
});

describe("routing with session objects", () => {
	const ASSETS = { fetch: async () => new Response("missing", { status: 404 }) };

	function namespaces() {
		const seen: { object: string; path: string }[] = [];
		let unique = 0;
		const homes = new Map<string, string>([["ses_homed", "obj-7"]]);
		const asked: string[] = [];
		const stackStub = {
			fetch: async (request: Request) => {
				seen.push({ object: "stack", path: new URL(request.url).pathname });
				return new Response("stack");
			},
			sessionHome: async (sessionId: string) => {
				asked.push(sessionId);
				const home = homes.get(sessionId);
				return home === undefined ? (sessionId === "ses_stack" ? { stack: true as const } : {}) : { home };
			},
		};
		const sessionStub = (object: string) => ({
			fetch: async (request: Request) => {
				seen.push({ object, path: new URL(request.url).pathname });
				return new Response(object);
			},
		});
		const env = {
			STACK: { idFromName: () => "m1", get: () => stackStub },
			VAULTS: { idFromName: () => "vault", get: () => stackStub },
			ASSETS,
			SESSIONS: {
				idFromString: (id: string) => id,
				newUniqueId: () => `new-${++unique}`,
				get: (id: string) => sessionStub(id),
			},
			KANTEL_SESSION_OBJECTS: "on",
		};
		return { env, seen, asked };
	}

	it("sends a new session to a new object, and a session's requests to the object it lives in", async () => {
		const { env, seen, asked } = namespaces();
		await routeRequest(new Request(`${BASE}/v1/sessions`, { method: "POST", body: "{}" }), env);
		await routeRequest(new Request(`${BASE}/v1/sessions`, { method: "POST", body: "{}" }), env);
		await routeRequest(new Request(`${BASE}/v1/sessions/ses_homed/events`), env);
		await routeRequest(new Request(`${BASE}/v1/sessions/ses_homed/prompt`, { method: "POST", body: "{}" }), env);
		await routeRequest(new Request(`${BASE}/v1/sessions/ses_stack`), env);
		await routeRequest(new Request(`${BASE}/v1/sessions?projectId=p`), env);
		await routeRequest(
			new Request(`${BASE}/v1/browser/live`, {
				method: "POST",
				body: JSON.stringify({ sessionId: "ses_homed", browserSessionId: "b" }),
			}),
			env,
		);
		expect(seen).toEqual([
			{ object: "new-1", path: "/v1/sessions" },
			{ object: "new-2", path: "/v1/sessions" },
			{ object: "obj-7", path: "/v1/sessions/ses_homed/events" },
			{ object: "obj-7", path: "/v1/sessions/ses_homed/prompt" },
			{ object: "stack", path: "/v1/sessions/ses_stack" },
			{ object: "stack", path: "/v1/sessions" },
			{ object: "obj-7", path: "/v1/browser/live" },
		]);
		// A home, once known, is not asked for again.
		expect(asked.filter((id) => id === "ses_homed")).toHaveLength(1);
	});

	it("leaves every session to the stack while the switch is off", async () => {
		const { env, seen } = namespaces();
		const off = { ...env, KANTEL_SESSION_OBJECTS: "off" };
		await routeRequest(new Request(`${BASE}/v1/sessions`, { method: "POST", body: "{}" }), off);
		await routeRequest(new Request(`${BASE}/v1/sessions/ses_homed/events`), off);
		expect(seen.map((s) => s.object)).toEqual(["stack", "stack"]);
		expect(sessionObjectsOn({})).toBe(false);
		expect(sessionObjectsOn({ KANTEL_SESSION_OBJECTS: " on " })).toBe(true);
		expect(sessionIdOfPath("/v1/sessions/ses%5Fa/result")).toBe("ses_a");
		expect(sessionIdOfPath("/v1/sessions")).toBeUndefined();
	});
});

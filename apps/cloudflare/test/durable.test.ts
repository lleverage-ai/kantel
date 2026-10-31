// The stack over durable storage, in Node: SQLite stands in for D1 and the Durable Object's own SQLite, and the
// in-memory object store for R2. A second stack opened over the same storage is the Durable Object restarting.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { createMockAccess } from "@kantel/identity/testing";
import { createSessionRuntime } from "@kantel/runtime/core";
import { createSqlSessionStore, sqlPiStorage } from "@kantel/runtime/sql";
import type { SqlValue } from "@kantel/runtime-cloudflare";
import { createMemoryObjectBucket } from "@kantel/skills/sql";
import { syncSqliteDriver } from "@kantel/sql/sqlite";
import { createMemoryWorkspaceStore } from "@kantel/workspace/stored";
import { afterEach, describe, expect, it } from "vitest";
import { objectSqlDriver } from "../src/audit-outbox.ts";
import { gatewayConfig } from "../src/config.ts";
import { createEchoModels } from "../src/echo-model.ts";
import { createGateway } from "../src/gateway.ts";
import {
	type BootstrapRecord,
	type BootstrapStore,
	createMemoryBootstrapStore,
	createStack,
	DEFAULT_AGENT_ID,
	type SessionObjectStorage,
	type Stack,
	type StackStorage,
} from "../src/stack.ts";

const TEAM_DOMAIN = "harbour-test.cloudflareaccess.com";
const AUD = "aud-harbour-test";
const ADMIN = "tom@harbour.test";
const BASE = "https://harbour.test";

const opened: Stack[] = [];

afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close();
});

/** Statements Durable Object SQL refuses: transactions go through `ctx.storage.transaction` instead. */
const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/**
 * A Durable Object's `ctx.storage` as the session core uses it, over `node:sqlite`: `sql.exec` refusing transaction
 * control, an async `transaction` as `BEGIN IMMEDIATE` … `COMMIT` (one at a time), and an alarm it records.
 */
function objectStorage(db: DatabaseSync): SessionObjectStorage & { readonly alarms: number[] } {
	let alarm: number | null = null;
	const alarms: number[] = [];
	let lock: Promise<unknown> = Promise.resolve();
	return {
		alarms,
		sql: {
			exec<T extends Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]) {
				if (TRANSACTION_CONTROL.test(query)) throw new Error(`Durable Object SQL refuses "${query.trim()}"`);
				const statement = db.prepare(query);
				const values = bindings.map((b) => (b instanceof ArrayBuffer ? new Uint8Array(b) : b)) as SQLInputValue[];
				const rows = statement.columns().length > 0 ? (statement.all(...values) as T[]) : [];
				if (statement.columns().length === 0) statement.run(...values);
				return { toArray: () => rows };
			},
		},
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
			alarms.push(at);
		},
		getAlarm: async () => alarm,
	};
}

async function durableStorage(bootstrap: BootstrapStore = createMemoryBootstrapStore()): Promise<StackStorage> {
	const objectDb = new DatabaseSync(":memory:");
	const sessions = objectStorage(objectDb);
	// `ctx.storage.transactionSync`: nested in an open transaction it runs as a savepoint, as the object's does.
	const transactionSync = <T>(work: () => T): T => {
		const nested = objectDb.isTransaction;
		objectDb.exec(nested ? "SAVEPOINT sync" : "BEGIN");
		try {
			const result = work();
			objectDb.exec(nested ? "RELEASE sync" : "COMMIT");
			return result;
		} catch (error) {
			objectDb.exec(nested ? "ROLLBACK TO sync" : "ROLLBACK");
			throw error;
		}
	};
	return {
		sql: syncSqliteDriver(new DatabaseSync(":memory:")),
		sessions,
		workspaces: createMemoryWorkspaceStore(),
		skillObjects: createMemoryObjectBucket(),
		bootstrap,
		// Audit events queue in the object's SQLite, beside the sessions, as on Cloudflare.
		auditOutbox: {
			driver: objectSqlDriver(sessions.sql, transactionSync),
			background: (work) => void work.catch(() => undefined),
		},
	};
}

async function start(storage: StackStorage, adminEmail: string = ADMIN) {
	const mock = createMockAccess({ teamDomain: TEAM_DOMAIN, audience: AUD });
	const config = gatewayConfig({
		KANTEL_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
		KANTEL_ACCESS_AUD: AUD,
		KANTEL_ADMIN_EMAIL: adminEmail,
	});
	const stack = await createStack({ config, accessFetch: mock.fetch, storage });
	opened.push(stack);
	const gateway = createGateway(stack);
	const headers = {
		"cf-access-jwt-assertion": await mock.sign({ sub: "access-subject-1", email: ADMIN }),
		"content-type": "application/json",
	};
	const call = (path: string, init: RequestInit = {}) =>
		gateway.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
	return { stack, call };
}

describe("the stack over durable storage", () => {
	it("finds the same organisation, sessions, workspaces and audit after a restart", async () => {
		const storage = await durableStorage();
		const first = await start(storage);

		const created = await first.call("/v1/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId: first.stack.project.id, agentId: DEFAULT_AGENT_ID, title: "Kept" }),
		});
		expect(created.status).toBe(201);
		const session = (await created.json()) as { id: string };
		const prompted = await first.call(`/v1/sessions/${session.id}/prompt`, {
			method: "POST",
			body: JSON.stringify({ text: "ping" }),
		});
		const submission = (await prompted.json()) as { id: string };
		const answered = await first.call(
			`/v1/sessions/${session.id}/result?submission=${encodeURIComponent(submission.id)}&timeoutMs=5000`,
		);
		expect(await answered.json()).toMatchObject({ status: "answered", answer: "Echo: ping" });

		const workspace = await first.stack.workspaces.create(first.stack.admin, {
			owner: { kind: "project", organisationId: first.stack.organisation.id, projectId: first.stack.project.id },
		});
		await first.stack.workspaces.commit(first.stack.admin, workspace.id, {
			baseVersion: workspace.head,
			changes: [{ op: "put", path: "notes/kept.md", content: "# Kept" }],
		});
		await first.stack.close();

		const second = await start(storage);
		expect(second.stack.organisation.id).toBe(first.stack.organisation.id);
		expect(second.stack.project.id).toBe(first.stack.project.id);
		expect(second.stack.admin).toEqual(first.stack.admin);

		// The invited admin still signs in, and finds the session with its transcript.
		const listed = await second.call(`/v1/sessions?projectId=${second.stack.project.id}`);
		expect(listed.status).toBe(200);
		expect(((await listed.json()) as { items: { id: string; title: string }[] }).items).toMatchObject([
			{ id: session.id, title: "Kept" },
		]);
		const snapshot = await second.stack.runtime.runtime.snapshot(second.stack.admin, session.id);
		expect(snapshot.items.map((item) => item.kind)).toEqual(["user", "assistant"]);

		const content = await second.call(`/v1/workspaces/${workspace.id}/content?path=notes/kept.md`);
		expect(await content.text()).toBe("# Kept");

		// One bootstrap: one organisation, one user and one project, however many starts.
		expect(await counts(storage)).toEqual({ organisations: 1, users: 1, projects: 1 });
		const audit = await second.call("/v1/audit/events?type=identity.project.created");
		expect(((await audit.json()) as { items: unknown[] }).items).toHaveLength(1);
	});

	it("keeps imported skills and memory across a restart", async () => {
		const storage = await durableStorage();
		const first = await start(storage);
		const { admin } = first.stack;
		const organisation = { kind: "organisation", organisationId: first.stack.organisation.id } as const;
		const revision = await first.stack.skills.importRevision(admin, {
			owner: organisation,
			name: "kept",
			description: "Kept across restarts.",
			files: [{ path: "SKILL.md", content: "---\nname: kept\ndescription: Kept across restarts.\n---\n\nKept.\n" }],
			source: { sourceId: "test", ref: "r1" },
		});
		const space = await first.stack.memory.createSpace(admin, { owner: organisation, name: "Team" });
		await first.stack.memory.importSnapshot(admin, space.id, {
			sourceId: "test",
			ref: "r1",
			concepts: [
				{
					id: "projects/harbour/kept",
					title: "Kept",
					statement: "Memory survives a restart.",
					scope: { kind: "global" },
					sources: ["tvdavies/harbour#12"],
					setBy: "owner",
					status: "active",
					updatedAt: 1,
				},
			],
		});
		await first.stack.close();

		const second = await start(storage);
		expect(await second.stack.skills.readFile(admin, revision.skillId, 1, "SKILL.md")).toContain("Kept.");
		expect((await second.stack.skills.list(admin, {})).items.map((item) => item.name)).toEqual(["kept"]);
		expect((await second.stack.memory.listSpaces(admin)).items.map((item) => item.id)).toEqual([space.id]);
		const concepts = await second.stack.memory.listConcepts(admin, space.id);
		expect(concepts.items.map((item) => item.id)).toEqual(["projects/harbour/kept"]);
		// The file's body is in the object store, under the skills prefix, not in SQL.
		expect((storage.skillObjects as unknown as { keys(): string[] }).keys()[0]).toMatch(/^skills\/org\//);
	});

	it("keeps the prompt the user set on the default profile across restarts, and adds none of its own", async () => {
		const storage = await durableStorage();
		const first = await start(storage);
		const made = await first.stack.runtime.profiles.get(first.stack.admin, DEFAULT_AGENT_ID);
		expect(made.promptLayers).toEqual([]);

		const layers = [{ name: "organisation", text: "You work for Lleverage." }];
		await first.stack.runtime.profiles.put(first.stack.admin, { ...made, promptLayers: layers });
		await first.stack.close();

		const second = await start(storage);
		const kept = await second.stack.runtime.profiles.get(second.stack.admin, DEFAULT_AGENT_ID);
		expect(kept.promptLayers).toEqual(layers);
	});

	it("keeps the skills and memory spaces the user named on the default profile across restarts", async () => {
		const storage = await durableStorage();
		const first = await start(storage);
		const made = await first.stack.runtime.profiles.get(first.stack.admin, DEFAULT_AGENT_ID);
		expect(made).toMatchObject({ skills: [], memoryScopes: [] });
		await first.stack.runtime.profiles.put(first.stack.admin, {
			...made,
			skills: ["pr-review"],
			memoryScopes: ["space-1"],
		});
		await first.stack.close();

		const second = await start(storage);
		const kept = await second.stack.runtime.profiles.get(second.stack.admin, DEFAULT_AGENT_ID);
		expect(kept).toMatchObject({ skills: ["pr-review"], memoryScopes: ["space-1"] });
	});

	it("gives a session the skills and memory imported through the API, and again after a restart", async () => {
		const storage = await durableStorage();
		const first = await start(storage);
		const { admin, organisation } = first.stack;
		const owner = { kind: "organisation", organisationId: organisation.id };
		const post = (path: string, body: unknown) => first.call(path, { method: "POST", body: JSON.stringify(body) });
		const description = "Review a pull request.";
		const imported = await post("/v1/skills/import", {
			owner,
			name: "pr-review",
			description,
			files: [
				{ path: "SKILL.md", content: `---\nname: pr-review\ndescription: ${description}\n---\n\nRead the diff.\n` },
			],
			source: { sourceId: "agent-toolkit", ref: "abc123" },
		});
		expect(imported.status).toBe(200);
		const space = (await (await post("/v1/memory/spaces", { owner, name: "Sal memory" })).json()) as { id: string };
		const snapshot = await post(`/v1/memory/spaces/${space.id}/snapshot`, {
			sourceId: "sal-memory",
			ref: "def456",
			concepts: [
				{
					id: "personal/timezone",
					title: "Times in UK time",
					statement: "Give times in UK time.",
					tags: ["profile"],
					scope: { kind: "global" },
					sources: ["tvdavies/harbour#12"],
					setBy: "owner",
					status: "active",
					updatedAt: 1,
				},
			],
		});
		expect(snapshot.status).toBe(200);
		const made = await first.stack.runtime.profiles.get(admin, DEFAULT_AGENT_ID);
		await first.stack.runtime.profiles.put(admin, { ...made, skills: ["pr-review"], memoryScopes: [space.id] });
		await first.stack.close();

		const second = await start(storage);
		const session = await second.stack.runtime.runtime.create(admin, {
			projectId: second.stack.project.id,
			agentId: DEFAULT_AGENT_ID,
		});
		const prompt = await second.stack.runtime.runtime.prompt(admin, session.id, { text: "Review it" });
		await second.stack.runtime.runtime.wait(admin, session.id, prompt.id);
		const workspace = await second.stack.workspaces.get(admin, session.workspaceId ?? "");
		expect(workspace.mounts.map((mount) => mount.path)).toEqual(["/skills"]);
		const file = await second.stack.workspaces.read(admin, workspace.id, "/skills/pr-review/SKILL.md");
		expect(new TextDecoder().decode(file.content)).toContain("Read the diff.");
	});

	it("drops the prompt layer earlier releases wrote into the default profile, and only that", async () => {
		const storage = await durableStorage();
		const first = await start(storage);
		const made = await first.stack.runtime.profiles.get(first.stack.admin, DEFAULT_AGENT_ID);
		const mine = { name: "project", text: "Answer in Dutch." };
		await first.stack.runtime.profiles.put(first.stack.admin, {
			...made,
			promptLayers: [{ name: "role", text: "You are a helpful assistant running on Kantel." }, mine],
		});
		await first.stack.close();

		const second = await start(storage);
		const kept = await second.stack.runtime.profiles.get(second.stack.admin, DEFAULT_AGENT_ID);
		expect(kept.promptLayers).toEqual([mine]);
	});

	it("reads sessions the object stored before it hosted the session core", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harbour-sessions-"));
		const file = join(dir, "object.sqlite");
		// The object's own SQLite connection, which the core borrows and does not close.
		const objectDb = new DatabaseSync(file);
		try {
			const storage: StackStorage = {
				...(await durableStorage()),
				sessions: objectStorage(objectDb),
			};
			const first = await start(storage);
			const { organisation, project, admin } = first.stack;
			await first.stack.close();

			// What the deployed object did before: `createSessionRuntime` over chord's SQLite wrapper, default prefix.
			const old = await openNodeSqliteDatabase(file);
			const before = createSessionRuntime({
				models: createEchoModels(),
				store: await createSqlSessionStore(old),
				storage: (session) => sqlPiStorage(old, session.id),
			});
			const ctx = { actor: { kind: "service", serviceId: "before" }, organisationId: organisation.id } as const;
			const session = await before.runtime.create(ctx, {
				projectId: project.id,
				agentId: DEFAULT_AGENT_ID,
				title: "Before",
			});
			const prompt = await before.runtime.prompt(ctx, session.id, { text: "ping" });
			expect(await before.runtime.wait(ctx, session.id, prompt.id)).toMatchObject({ answer: "Echo: ping" });
			await before.close();
			await old.close();

			const after = await start(storage);
			const listed = await after.call(`/v1/sessions?projectId=${project.id}`);
			expect(((await listed.json()) as { items: { id: string; title: string }[] }).items).toMatchObject([
				{ id: session.id, title: "Before" },
			]);
			const snapshot = await after.stack.runtime.runtime.snapshot(admin, session.id);
			expect(snapshot.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
			// And it carries on: the session takes a new prompt under the core.
			const next = await after.stack.runtime.runtime.prompt(admin, session.id, { text: "again" });
			expect(await after.stack.runtime.runtime.wait(admin, session.id, next.id)).toMatchObject({
				answer: "Echo: again",
			});
		} finally {
			for (const stack of opened.splice(0)) await stack.close();
			objectDb.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("arms the object's alarm when a prompt is admitted, and runs the session core from alarm()", async () => {
		const storage = await durableStorage();
		const sessions = storage.sessions as ReturnType<typeof objectStorage>;
		const { stack, call } = await start(storage);
		const created = await call("/v1/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId: stack.project.id, agentId: DEFAULT_AGENT_ID }),
		});
		const session = (await created.json()) as { id: string };
		const before = sessions.alarms.length;
		const prompted = await call(`/v1/sessions/${session.id}/prompt`, {
			method: "POST",
			body: JSON.stringify({ text: "ping" }),
		});
		const submission = (await prompted.json()) as { id: string };
		// Admitting the prompt stored a wake and armed the alarm, so an eviction mid run is woken by the platform.
		expect(sessions.alarms.length).toBeGreaterThan(before);
		const answered = await call(
			`/v1/sessions/${session.id}/result?submission=${encodeURIComponent(submission.id)}&timeoutMs=5000`,
		);
		expect(await answered.json()).toMatchObject({ status: "answered", answer: "Echo: ping" });
		// The platform firing the alarm with nothing due is harmless.
		await stack.alarm();
	});

	it("starts again over the same object storage after a start fails", async () => {
		const bootstrap: BootstrapStore = {
			load: async () => ({}),
			save: async () => {
				throw new Error("the object restarted");
			},
		};
		const storage = await durableStorage(bootstrap);
		await expect(start(storage)).rejects.toThrow("the object restarted");
		// The failed start closed its session core; the next start opens the same object storage once the bootstrap saves.
		const retried = await start({ ...storage, bootstrap: createMemoryBootstrapStore() });
		expect((await retried.call(`/v1/sessions?projectId=${retried.stack.project.id}`)).status).toBe(200);
	});

	// Identity commits each step before the bootstrap saves it, so a start can fail with a step committed but unsaved.
	for (const step of ["userId", "organisationId", "projectId"] as const) {
		it(`reuses the committed ${step.replace("Id", "")} when a start fails before saving it`, async () => {
			let saved: BootstrapRecord = {};
			let failed = false;
			const bootstrap: BootstrapStore = {
				load: async () => saved,
				async save(record) {
					if (!failed && record[step] !== undefined) {
						failed = true;
						throw new Error("the object restarted");
					}
					saved = record;
				},
			};
			const storage = await durableStorage(bootstrap);
			await expect(start(storage)).rejects.toThrow("the object restarted");
			expect(saved[step]).toBeUndefined();

			const { stack, call } = await start(storage);
			expect(await counts(storage)).toEqual({ organisations: 1, users: 1, projects: 1 });
			expect(saved).toEqual({
				userId: (stack.admin.actor as { userId: string }).userId,
				organisationId: stack.organisation.id,
				projectId: stack.project.id,
			});
			// The invited admin signs in: there is one user with the email, not two that identity can't tell apart.
			expect((await call(`/v1/sessions?projectId=${stack.project.id}`)).status).toBe(200);
		});
	}

	it("reuses the placeholder admin when there is no admin email and a start fails before saving it", async () => {
		let saved: BootstrapRecord = {};
		let failed = false;
		const bootstrap: BootstrapStore = {
			load: async () => saved,
			async save(record) {
				if (!failed) {
					failed = true;
					throw new Error("the object restarted");
				}
				saved = record;
			},
		};
		const storage = await durableStorage(bootstrap);
		await expect(start(storage, "")).rejects.toThrow("the object restarted");
		const { stack } = await start(storage, "");
		expect(await counts(storage)).toEqual({ organisations: 1, users: 1, projects: 1 });
		expect(saved.organisationId).toBe(stack.organisation.id);
	});

	it("bootstraps again when the saved record names an organisation the directory no longer has", async () => {
		const bootstrap = createMemoryBootstrapStore();
		const first = await start(await durableStorage(bootstrap));
		// The object's storage survives; D1 is a new, empty database.
		const storage = await durableStorage(bootstrap);
		const { stack, call } = await start(storage);
		expect(stack.organisation.id).not.toBe(first.stack.organisation.id);
		expect(await bootstrap.load()).toMatchObject({ organisationId: stack.organisation.id });
		expect(await counts(storage)).toEqual({ organisations: 1, users: 1, projects: 1 });
		expect((await call(`/v1/sessions?projectId=${stack.project.id}`)).status).toBe(200);
	});

	it("looks the caller's role up once per request, not once per listed session", async () => {
		const storage = await durableStorage();
		const sql = storage.sql!;
		let roleQueries = 0;
		const counted: StackStorage = {
			...storage,
			sql: {
				dialect: sql.dialect,
				query: (text, params) => {
					// `roleOf`'s query; sign-in's membership check (`SELECT 1 …`) is separate and not memoised.
					if (text.includes("SELECT role FROM identity_role_bindings")) roleQueries++;
					return sql.query(text, params);
				},
				batch: (statements) => sql.batch(statements),
			},
		};
		const { stack, call } = await start(counted);
		for (let i = 0; i < 20; i++) {
			const created = await call("/v1/sessions", {
				method: "POST",
				body: JSON.stringify({ projectId: stack.project.id, agentId: DEFAULT_AGENT_ID, title: `S${i}` }),
			});
			expect(created.status).toBe(201);
		}

		roleQueries = 0;
		const listed = await call("/v1/sessions?limit=50");
		expect(listed.status).toBe(200);
		expect(((await listed.json()) as { items: unknown[] }).items).toHaveLength(20);
		expect(roleQueries).toBe(1);

		// The next request signs in again and looks again.
		roleQueries = 0;
		expect((await call(`/v1/sessions?projectId=${stack.project.id}`)).status).toBe(200);
		expect(roleQueries).toBe(1);
	});
});

async function counts(storage: StackStorage) {
	const count = async (table: string) => {
		const [row] = await storage.sql!.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
		return Number(row?.n);
	};
	return {
		organisations: await count("identity_organisations"),
		users: await count("identity_users"),
		projects: await count("identity_projects"),
	};
}

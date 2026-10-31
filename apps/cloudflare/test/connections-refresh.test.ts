// Token refresh on the stack (#328): a connection's next refresh arms the object's alarm, and the alarm sweeps, so a
// connection nobody uses is refreshed five minutes before its token expires and the alarm moves on to the next.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { memoryCredentials } from "@kantel/connections/memory";
import { fakeProvider } from "@kantel/connections/testing";
import { syncSqliteDriver } from "@kantel/sql/sqlite";
import { createMemoryWorkspaceStore } from "@kantel/workspace/stored";
import { afterEach, describe, expect, it } from "vitest";
import { gatewayConfig } from "../src/config.ts";
import { createStack, type SessionObjectStorage, type Stack } from "../src/stack.ts";

const START = Date.UTC(2026, 9, 31, 9, 0);
const HOUR = 3_600_000;

const opened: Stack[] = [];
afterEach(async () => {
	for (const stack of opened.splice(0)) await stack.close();
});

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/** A Durable Object's storage as the stack uses it, over `node:sqlite`, with an alarm the test reads and fires. */
function objectStorage(db: DatabaseSync): SessionObjectStorage & { alarm: number | null } {
	let lock: Promise<unknown> = Promise.resolve();
	const storage = {
		alarm: null as number | null,
		sql: {
			exec<T extends Record<string, unknown>>(query: string, ...bindings: unknown[]) {
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
		setAlarm: async (at: number) => {
			storage.alarm = at;
		},
		getAlarm: async () => storage.alarm,
	};
	return storage as SessionObjectStorage & { alarm: number | null };
}

describe("token refresh on the stack", () => {
	it("arms the alarm for a connection's refresh, refreshes it on the alarm, and arms it for the next", async () => {
		let now = START;
		const provider = fakeProvider();
		const object = objectStorage(new DatabaseSync(":memory:"));
		const sql = new DatabaseSync(":memory:");
		const stack = await createStack({
			config: gatewayConfig({}),
			clock: { now: () => now },
			storage: { sql: syncSqliteDriver(sql), sessions: object, workspaces: createMemoryWorkspaceStore() },
			connections: {
				credentials: memoryCredentials(),
				deployment: { origin: "https://harbour.test", clientMetadataPublic: false },
				fetch: provider.fetch,
			},
		});
		opened.push(stack);
		const connections = stack.connections!;
		const attempt = await connections.startConnect(stack.admin, {
			owner: { kind: "organisation", organisationId: stack.organisation.id },
			mcpUrl: provider.mcpUrl,
		});
		const { url } = await connections.authorize(stack.admin, attempt.id);
		const done = await connections.completeConnect(stack.admin, {
			state: new URL(url).searchParams.get("state")!,
			code: provider.codeFor(url),
		});
		const id = done.connectionId!;
		expect((await connections.get(stack.admin, id)).credential.expiresAt).toBe(START + HOUR);
		// Five minutes before the token expires.
		expect(object.alarm).toBe(START + HOUR - 5 * 60_000);

		now = object.alarm!;
		await stack.alarm();
		const refreshes = provider.tokenRequests.filter((params) => params.get("grant_type") === "refresh_token");
		expect(refreshes).toHaveLength(1);
		const connection = await connections.get(stack.admin, id);
		expect(connection.credential.expiresAt).toBe(now + HOUR);
		expect(connection.health).toMatchObject({ state: "ok", refreshedAt: now });
		expect(object.alarm).toBe(now + HOUR - 5 * 60_000);

		// A failing refresh arms the alarm for the end of its backoff.
		now = object.alarm!;
		provider.refreshAnswer = "unavailable";
		await stack.alarm();
		expect((await connections.get(stack.admin, id)).health).toMatchObject({ state: "refresh_failing", failures: 1 });
		expect(object.alarm).toBe(now + 30_000);
	});
});

// What one `wait: true` create costs the shared database, as a gateway replica runs it: the compute API over the host
// backend, both stores on one SQL database. Every statement is a round trip to Postgres on a self-hosted gateway, so a
// change that adds one to the create path shows up here. A round is a statement that starts while none is in flight:
// statements run together (`Promise.all`) share one.
import { createKantelClient } from "@kantel/api/sdk";
import { createComputeApi, joinTokenSpender } from "@kantel/compute";
import { createSqlComputeStore, migrateComputeStore } from "@kantel/compute/sql";
import type { SqlDriver, SqlRow, SqlValue } from "@kantel/sql";
import { nodeSqliteDatabase } from "@kantel/sql/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createHostBackend } from "../src/backend.ts";
import { createMemoryRelayStore } from "../src/relay-store.ts";
import { createHostsService } from "../src/service.ts";
import { createSqlHostStore, migrateHosts } from "../src/store.ts";
import { createTunnelTickets } from "../src/tunnel.ts";
import { FakeHost } from "./fake-host.ts";

/** A driver that records each statement, and how many rounds they took. */
function counting(inner: SqlDriver) {
	const statements: string[] = [];
	// Each statement's first parameter (the record's kind, for the compute store's) and the round it started in.
	const kinds: unknown[] = [];
	const roundOf: number[] = [];
	let inFlight = 0;
	let rounds = 0;
	const begin = (sql: string, first?: unknown) => {
		statements.push(sql.replace(/\s+/g, " ").trim());
		kinds.push(first);
		if (inFlight === 0) rounds++;
		roundOf.push(rounds);
		inFlight++;
	};
	const end = () => {
		inFlight--;
	};
	const driver: SqlDriver = {
		dialect: inner.dialect,
		query<Row extends SqlRow = SqlRow>(sql: string, params?: readonly SqlValue[]) {
			begin(sql, params?.[0]);
			return inner.query<Row>(sql, params).finally(end);
		},
		batch(batch) {
			begin(batch.map((statement) => statement.sql).join("; "));
			return inner.batch(batch).finally(end);
		},
	};
	return {
		driver,
		reset() {
			statements.length = 0;
			kinds.length = 0;
			roundOf.length = 0;
			rounds = 0;
		},
		get statements() {
			return [...statements];
		},
		get rounds() {
			return rounds;
		},
		get kinds() {
			return [...kinds];
		},
		get roundOf() {
			return [...roundOf];
		},
	};
}

const ROOT = { userId: "usr_root", name: "Root", superAdmin: true };
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

describe("a create on a gateway with shared state", () => {
	// 28 statements, each its own round, before TASK-4754 cut them.
	// The sandbox's record is written before its `sandbox.created` event (who may see an event is decided by its sandbox),
	// so they take two rounds, not one. Four statements and four rounds are account deletion's fences (#757): the key's
	// person checked against deletions once the key is found, and the account checked once the sandbox is stored
	// (`holdAccount`), each a round the create waits on as each needs what comes before it; and each event's account,
	// checked behind its write (`fenceClosedAccounts`), two rounds counted here that the create doesn't wait for. One
	// statement and one round are placement's read of every candidate host's placements, for the vCPUs booked there: one
	// read for all of them however many hosts, after the hosts' own read, which names them.
	it("answers a wait: true create in 21 statements and 15 rounds", async () => {
		const database = await nodeSqliteDatabase.open();
		closers.push(async () => {
			// The host's disconnect is recorded after the service closes: let it land first.
			await new Promise((resolve) => setTimeout(resolve, 10));
			await database.close();
		});
		await migrateComputeStore(database.driver);
		await migrateHosts(database.driver);
		const sql = counting(database.driver);
		const service = createHostsService({ store: createSqlHostStore(sql.driver), publicUrl: "https://kantel.test" });
		const api = createComputeApi({
			store: createSqlComputeStore(sql.driver),
			backend: createHostBackend({
				hosts: service,
				publicUrl: "https://kantel.test",
				tickets: createTunnelTickets(createMemoryRelayStore()),
			}),
			authenticatePerson: async (request) =>
				request.headers.get("authorization") === "Bearer root" ? ROOT : undefined,
			fetch: async () => new Response(null, { status: 204 }),
			publicUrl: "https://kantel.test",
		});
		service.useJoinTokens(joinTokenSpender(api.store));
		closers.push(
			() => service.close(),
			() => api.close(),
		);
		const client = (token: string) =>
			createKantelClient({
				baseUrl: "https://kantel.test/v1",
				token,
				fetch: (input, init) =>
					api.fetch(new Request(input, init)).then((response) => response ?? new Response(null, { status: 404 })),
			});
		const root = client("root");
		const token = await root.createHostJoinToken({ name: "box" });
		const { hostId } = await service.register({ token: token.token });
		new FakeHost(service, hostId).connect();
		// A key, as an agent calls with: its lookup is part of every call.
		const agent = client((await root.createApiKey({ name: "agent", scopes: ["sandboxes:write"] })).secret);
		// The first call with the key, and the first create, write what later ones needn't (the key's first use, the
		// host's record in the compute API).
		await agent.createSandbox({ type: "microvm", wait: true });

		sql.reset();
		const sandbox = await agent.createSandbox({ type: "microvm", wait: true });
		expect(sandbox.state).toBe("running");
		const statements = sql.statements;
		const rounds = sql.rounds;
		// The trace, when the budget is broken.
		const trace = statements.map((statement, index) => `${index + 1}. ${statement.slice(0, 140)}`).join("\n");
		expect(statements.length, trace).toBeLessThanOrEqual(21);
		expect(rounds, trace).toBeLessThanOrEqual(15);
		// The record, then its event: the event's write starts only once the record's has finished.
		const kinds = sql.kinds;
		const roundOf = sql.roundOf;
		const written = (kind: string) =>
			statements.findIndex(
				(statement, index) => statement.startsWith("INSERT INTO compute_api_records") && kinds[index] === kind,
			);
		const record = written("sandboxes");
		const event = written("events");
		expect(record, trace).toBeGreaterThanOrEqual(0);
		expect(event, trace).toBeGreaterThanOrEqual(0);
		expect(roundOf[event], trace).toBeGreaterThan(roundOf[record] ?? Number.POSITIVE_INFINITY);
		// Nothing written is read straight back.
		expect(
			statements.filter((statement) => statement.includes("FROM compute_placements WHERE sandbox_id")),
		).toHaveLength(1);
	});
});

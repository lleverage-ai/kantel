// The Postgres pool driver when the database goes away, restarts or fails over: which calls it tries again, which it
// never does, and when it asks for the pool's connections to be replaced. A scripted pool stands in for `pg`'s; the
// gateway's test against a real Postgres (apps/selfhosted durable.stack.test.ts) restarts one under load.
import { sql } from "@kantel/sql";
import {
	PostgresCommitUnknownError,
	type PostgresPool,
	postgresFailure,
	postgresPoolDriver,
	postgresRenewingPool,
} from "@kantel/sql/postgres";
import { describe, expect, it } from "vitest";

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
const readOnly = () => pgError("25006", "cannot execute INSERT in a read-only transaction");
const terminated = () => new Error("Connection terminated unexpectedly");

/**
 * A pool whose connections answer as `answer` says, for the statement and the connection's number (from 1). `connect`
 * fails with `connectFails`' next error while it has any. Records every statement and how each connection went back.
 */
function scriptedPool(
	answer: (text: string, connection: number) => Error | undefined,
	connectFails: Error[] = [],
): PostgresPool & { readonly sent: string[]; readonly released: (string | boolean)[]; connections: number } {
	const sent: string[] = [];
	const released: (string | boolean)[] = [];
	const pool = {
		sent,
		released,
		connections: 0,
		async query(): Promise<{ rows: unknown[] }> {
			throw new Error("the driver takes a connection");
		},
		async connect() {
			const failure = connectFails.shift();
			if (failure !== undefined) throw failure;
			pool.connections += 1;
			const connection = pool.connections;
			return {
				async query(text: string) {
					sent.push(`${connection}: ${text}`);
					const error = answer(text, connection);
					if (error !== undefined) throw error;
					return { rows: text.startsWith("SELECT") ? [{ n: connection }] : [] };
				},
				release(error?: Error | boolean) {
					released.push(error === true ? "closed" : error ? "closed" : "kept");
				},
			};
		},
	};
	return pool;
}

describe("postgresFailure", () => {
	it("tells a lost or unreachable database and a read-only server from everything else", () => {
		expect(postgresFailure(refused())).toBe("unavailable");
		expect(postgresFailure(terminated())).toBe("unavailable");
		expect(postgresFailure(new Error("Query read timeout"))).toBe("unavailable");
		expect(postgresFailure(new Error("timeout exceeded when trying to connect"))).toBe("unavailable");
		expect(postgresFailure(pgError("57P01", "terminating connection due to administrator command"))).toBe(
			"unavailable",
		);
		expect(postgresFailure(pgError("57P03", "the database system is starting up"))).toBe("unavailable");
		expect(postgresFailure(pgError("08006", "connection failure"))).toBe("unavailable");
		expect(postgresFailure(readOnly())).toBe("readOnly");
		expect(postgresFailure(pgError("23505", "duplicate key value violates unique constraint"))).toBe("other");
		expect(postgresFailure(pgError("57014", "canceling statement due to statement timeout"))).toBe("other");
		expect(postgresFailure(pgError("28P01", "password authentication failed"))).toBe("other");
		expect(postgresFailure(new Error("wrapped", { cause: refused() }))).toBe("unavailable");
	});
});

describe("postgresPoolDriver after a restart or failover", () => {
	it("tries a batch again when no connection could be had, and tells the pool", async () => {
		const pool = scriptedPool(() => undefined, [refused(), refused()]);
		const lost: unknown[] = [];
		const driver = postgresPoolDriver(pool, { retryMs: [1, 1], onConnectionLost: (error) => lost.push(error) });
		await driver.batch([sql("INSERT INTO t VALUES (?)", 1)]);
		expect(pool.sent).toEqual(["1: BEGIN", "1: INSERT INTO t VALUES ($1)", "1: COMMIT"]);
		expect(lost).toHaveLength(2);
	});

	it("gives up after its pauses run out, with the connection's own error", async () => {
		const pool = scriptedPool(() => undefined, [refused(), refused(), refused()]);
		const driver = postgresPoolDriver(pool, { retryMs: [1, 1] });
		await expect(driver.batch([sql("INSERT INTO t VALUES (?)", 1)])).rejects.toMatchObject({ code: "ECONNREFUSED" });
		await expect(driver.query("SELECT 1")).resolves.toEqual([{ n: 1 }]);
	});

	it("tries once with no pauses, as before", async () => {
		const pool = scriptedPool(() => undefined, [refused()]);
		await expect(postgresPoolDriver(pool).query("SELECT 1")).rejects.toMatchObject({ code: "ECONNREFUSED" });
	});

	it("drops a read-only connection and runs the batch again on another", async () => {
		const pool = scriptedPool((text, connection) =>
			connection === 1 && text.startsWith("INSERT") ? readOnly() : undefined,
		);
		const lost: unknown[] = [];
		const driver = postgresPoolDriver(pool, { retryMs: [1], onConnectionLost: (error) => lost.push(error) });
		await driver.batch([sql("INSERT INTO t VALUES (?)", 1)]);
		expect(pool.sent).toEqual([
			"1: BEGIN",
			"1: INSERT INTO t VALUES ($1)",
			"1: ROLLBACK",
			"2: BEGIN",
			"2: INSERT INTO t VALUES ($1)",
			"2: COMMIT",
		]);
		expect(pool.released).toEqual(["closed", "kept"]);
		expect(lost).toEqual([expect.objectContaining({ code: "25006" })]);
	});

	it("runs a batch again when its connection broke before COMMIT was sent", async () => {
		const pool = scriptedPool((text, connection) =>
			connection === 1 && text.startsWith("INSERT") ? terminated() : undefined,
		);
		const driver = postgresPoolDriver(pool, { retryMs: [1] });
		await driver.batch([sql("INSERT INTO t VALUES (?)", 1)]);
		// No ROLLBACK on the broken one: closing it ends the transaction.
		expect(pool.sent).toEqual([
			"1: BEGIN",
			"1: INSERT INTO t VALUES ($1)",
			"2: BEGIN",
			"2: INSERT INTO t VALUES ($1)",
			"2: COMMIT",
		]);
		expect(pool.released).toEqual(["closed", "kept"]);
	});

	it("never sends a batch again once its COMMIT may have reached the database, and says so", async () => {
		const pool = scriptedPool((text) => (text === "COMMIT" ? terminated() : undefined));
		const lost: unknown[] = [];
		const driver = postgresPoolDriver(pool, { retryMs: [1, 1], onConnectionLost: (error) => lost.push(error) });
		const failure = driver.batch([sql("INSERT INTO t VALUES (?)", 1)]);
		await expect(failure).rejects.toBeInstanceOf(PostgresCommitUnknownError);
		await expect(failure).rejects.toThrow(/may or may not have been applied \(Connection terminated unexpectedly\)/);
		expect(pool.sent).toEqual(["1: BEGIN", "1: INSERT INTO t VALUES ($1)", "1: COMMIT"]);
		expect(pool.released).toEqual(["closed"]);
		expect(lost).toHaveLength(1);
	});

	it("never sends a statement again once it may have run, and keeps a connection that only refused it", async () => {
		const broken = scriptedPool(() => terminated());
		await expect(postgresPoolDriver(broken, { retryMs: [1, 1] }).query("UPDATE t SET n = 1")).rejects.toThrow(
			"Connection terminated unexpectedly",
		);
		expect(broken.sent).toEqual(["1: UPDATE t SET n = 1"]);
		expect(broken.released).toEqual(["closed"]);

		const duplicate = scriptedPool(() => pgError("23505", "duplicate key value violates unique constraint"));
		const lost: unknown[] = [];
		const driver = postgresPoolDriver(duplicate, { retryMs: [1], onConnectionLost: (error) => lost.push(error) });
		await expect(driver.query("INSERT INTO t VALUES (1)")).rejects.toMatchObject({ code: "23505" });
		await expect(driver.batch([sql("INSERT INTO t VALUES (1)")])).rejects.toMatchObject({ code: "23505" });
		expect(duplicate.sent).toEqual(["1: INSERT INTO t VALUES (1)", "2: BEGIN", "2: ROLLBACK"]);
		expect(duplicate.released).toEqual(["kept", "closed"]);
		expect(lost).toEqual([]);
	});

	it("runs a statement a read-only server refused again on another connection", async () => {
		const pool = scriptedPool((_text, connection) => (connection < 3 ? readOnly() : undefined));
		const driver = postgresPoolDriver(pool, { retryMs: [1, 1] });
		await expect(driver.query("SELECT 1")).resolves.toEqual([{ n: 3 }]);
		expect(pool.released).toEqual(["closed", "closed", "kept"]);
	});
});

describe("postgresRenewingPool", () => {
	const endable = (name: string, ended: string[]) => ({
		name,
		query: async () => ({ rows: [{ name }] }),
		connect: async () => ({ query: async () => ({ rows: [{ name }] }), release() {} }),
		end: async () => {
			ended.push(name);
		},
	});

	it("swaps in a new pool, closes the old, and renews at most once in its interval", async () => {
		const ended: string[] = [];
		let made = 0;
		const renewed: unknown[] = [];
		const pool = postgresRenewingPool(
			() => {
				made += 1;
				return endable(`pool ${made}`, ended);
			},
			{ minIntervalMs: 60_000, onRenew: (why) => renewed.push(why) },
		);
		expect((await pool.query("SELECT 1")).rows).toEqual([{ name: "pool 1" }]);
		pool.renew(readOnly());
		pool.renew(readOnly());
		expect((await pool.query("SELECT 1")).rows).toEqual([{ name: "pool 2" }]);
		expect(made).toBe(2);
		expect(renewed).toHaveLength(1);
		await pool.end();
		expect(ended).toEqual(["pool 1", "pool 2"]);
		pool.renew(readOnly());
		expect(made).toBe(2);
	});
});

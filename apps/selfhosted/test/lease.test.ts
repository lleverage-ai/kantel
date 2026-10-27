// Session leases and fencing, against a real Postgres (the compose stack's).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pg from "pg";
import { holdLiveness, LeaseLost, PostgresLeases } from "../src/lease.ts";
import { migrate } from "../src/main.ts";
import { PostgresSqliteDatabase } from "../src/pi-postgres.ts";

const url = process.env.HARBOUR_DATABASE_URL ?? "postgres://harbour:harbour@127.0.0.1:55432/harbour";
const pool = new pg.Pool({ connectionString: url });
const leases = new PostgresLeases(pool);
const run = `${Date.now().toString(36)}-${process.pid}`;
let n = 0;

async function newSession(): Promise<string> {
	const id = `lease-test-${run}-${n++}`;
	await pool.query(`INSERT INTO harbour.sessions (id, workspace_id, pi_schema) VALUES ($1, $1, 'none')`, [id]);
	return id;
}

async function liveOwner(name: string) {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	await holdLiveness(client, name);
	return client;
}

beforeAll(() => migrate(pool));
afterAll(() => pool.end());

describe("Postgres session leases", () => {
	test("one live owner at a time; the fence starts at 1", async () => {
		const id = await newSession();
		const a = await liveOwner(`a-${run}-1`);
		const first = await leases.acquire(id, `a-${run}-1`, "http://a", 10_000);
		expect(first?.fence).toBe(1);
		expect(await leases.acquire(id, `b-${run}-1`, "http://b", 10_000)).toBeUndefined();
		expect((await leases.current(id))?.owner).toBe(`a-${run}-1`);
		await a.end();
	});

	test("a dead owner's lease is free at once, before its TTL, and the fence goes up", async () => {
		const id = await newSession();
		const a = await liveOwner(`a-${run}-2`);
		const held = await leases.acquire(id, `a-${run}-2`, "http://a", 60_000);
		expect(held?.fence).toBe(1);
		await a.end(); // the process died: Postgres drops its liveness lock
		await Bun.sleep(50);
		const taken = await leases.acquire(id, `b-${run}-2`, "http://b", 60_000);
		expect(taken?.fence).toBe(2);
		await expect(leases.check(held!)).rejects.toBeInstanceOf(LeaseLost);
	});

	test("a live but silent owner loses the lease after its TTL and can no longer renew or write", async () => {
		const id = await newSession();
		const a = await liveOwner(`a-${run}-3`);
		const held = await leases.acquire(id, `a-${run}-3`, "http://a", 300);
		expect(await leases.acquire(id, `b-${run}-3`, "http://b", 300)).toBeUndefined();
		await Bun.sleep(400);
		const b = await liveOwner(`b-${run}-3`);
		const taken = await leases.acquire(id, `b-${run}-3`, "http://b", 10_000);
		expect(taken?.fence).toBe(2);
		expect(await leases.renew(held!, 10_000)).toBeUndefined();
		await expect(leases.check(held!)).rejects.toBeInstanceOf(LeaseLost);
		await leases.check(taken!);
		await a.end();
		await b.end();
	});

	test("Pi Durable storage refuses to commit for a deposed owner", async () => {
		const id = await newSession();
		const a = await liveOwner(`a-${run}-4`);
		const held = await leases.acquire(id, `a-${run}-4`, "http://a", 300);
		const db = await PostgresSqliteDatabase.open({
			connectionString: url,
			schema: `pi_fence_${run.replace(/[^a-z0-9]/g, "_")}`,
			fence: (client) => leases.check(held!, client),
		});
		await db.exec("CREATE TABLE IF NOT EXISTS t (x INTEGER)");
		await db.run("INSERT INTO t (x) VALUES (?)", 1);
		await Bun.sleep(400);
		const b = await liveOwner(`b-${run}-4`);
		expect((await leases.acquire(id, `b-${run}-4`, "http://b", 10_000))?.fence).toBe(2);
		await expect(db.run("INSERT INTO t (x) VALUES (?)", 2)).rejects.toBeInstanceOf(LeaseLost);
		expect(await db.all<{ x: number }>("SELECT x FROM t")).toEqual([{ x: 1 }]);
		await db.close();
		await a.end();
		await b.end();
	});

	test("a takeover waits for an in-flight fenced commit to finish", async () => {
		const id = await newSession();
		const a = await liveOwner(`a-${run}-5`);
		const held = await leases.acquire(id, `a-${run}-5`, "http://a", 60_000);
		const tx = await pool.connect();
		await tx.query("BEGIN");
		await leases.check(held!, tx); // holds the lease row in share mode
		await a.end(); // owner dies mid-commit
		await Bun.sleep(50);
		let acquired = false;
		const takeover = leases.acquire(id, `b-${run}-5`, "http://b", 60_000).then((lease) => {
			acquired = true;
			return lease;
		});
		await Bun.sleep(200);
		expect(acquired).toBe(false);
		await tx.query("COMMIT");
		tx.release();
		expect((await takeover)?.fence).toBe(2);
	});
});

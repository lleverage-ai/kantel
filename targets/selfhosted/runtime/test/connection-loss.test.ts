// A pool connection lost while the database holds it: the client's `error` event fails the database instead of going
// unhandled (which would end the process), later statements reject, and closing releases the client as broken.
import { EventEmitter } from "node:events";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { openPostgresSessionDatabase, type PostgresPool } from "../src/index.ts";
import { caseSchema } from "./support.ts";

/** A pool with one client that answers every query, and emits `error` on demand, as `pg`'s client does. */
function fakePool() {
	const client = Object.assign(new EventEmitter(), {
		released: [] as (Error | boolean | undefined)[],
		async query() {
			return { rows: [] };
		},
		release(error?: Error | boolean) {
			client.released.push(error);
		},
	});
	const pool: PostgresPool = { connect: async () => client };
	return { pool, client };
}

describe("a lost pool connection", () => {
	it("fails the database, rejects later statements and releases the client as broken", async () => {
		const { pool, client } = fakePool();
		const db = await openPostgresSessionDatabase({ pool, schema: "m1_be1_fake" });
		await db.run("SELECT 1");
		const lost = new Error("terminating connection due to administrator command");
		// With no listener, EventEmitter would throw this out of `emit`.
		expect(() => client.emit("error", lost)).not.toThrow();
		await expect(db.all("SELECT 1")).rejects.toMatchObject({ cause: lost });
		await expect(db.transaction(async () => undefined)).rejects.toThrow("lost its connection");
		await db.close();
		await db.close();
		expect(client.released).toEqual([lost]);
		// Still listened to while it ends.
		expect(() => client.emit("error", new Error("again"))).not.toThrow();
	});

	it("gives a healthy client back to its pool without the database's listener", async () => {
		const { pool, client } = fakePool();
		const db = await openPostgresSessionDatabase({ pool, schema: "m1_be1_fake" });
		expect(client.listenerCount("error")).toBe(1);
		await db.close();
		expect(client.released).toEqual([undefined]);
		expect(client.listenerCount("error")).toBe(0);
	});

	const url = process.env.KANTEL_TEST_DATABASE_URL;
	const real = url === undefined || url === "" ? undefined : new pg.Pool({ connectionString: url, max: 2 });
	afterAll(async () => {
		await real?.end();
	});

	it.skipIf(real === undefined)("survives its backend being terminated on a real Postgres", async () => {
		const schema = caseSchema();
		const db = await openPostgresSessionDatabase({ pool: real!, schema });
		try {
			const row = await db.get<{ pid: number }>("SELECT pg_backend_pid() AS pid");
			await real!.query("SELECT pg_terminate_backend($1)", [row!.pid]);
			await new Promise((resolve) => setTimeout(resolve, 200));
			await expect(db.all("SELECT 1")).rejects.toThrow();
		} finally {
			await db.close();
			await real!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		}
	});
});

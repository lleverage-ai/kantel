import pg from "pg";
import { afterAll } from "vitest";
import { openPostgresSessionDatabase } from "../src/index.ts";
import { registerPostgresRuntimeConformance } from "./support.ts";

// Runs against a real Postgres only when HARBOUR_TEST_DATABASE_URL names one; each case gets its own schema
// (`m1_be1_<random>`), dropped afterwards.
const url = process.env.HARBOUR_TEST_DATABASE_URL;
const pool = url === undefined || url === "" ? undefined : new pg.Pool({ connectionString: url, max: 8 });
afterAll(async () => {
	await pool?.end();
});

registerPostgresRuntimeConformance(
	"self-hosted session runtime on Postgres (pg)",
	() => ({
		open: (schema) => openPostgresSessionDatabase({ pool: pool!, schema }),
		drop: async (schema) => {
			await pool!.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
		},
	}),
	pool === undefined,
);

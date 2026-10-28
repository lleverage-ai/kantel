import { PGlite } from "@electric-sql/pglite";
import { afterAll } from "vitest";
import { openPostgresSessionDatabase } from "../src/index.ts";
import { registerPostgresRuntimeConformance } from "./support.ts";

const db = new PGlite();
afterAll(() => db.close());

registerPostgresRuntimeConformance("self-hosted session runtime on Postgres (PGlite)", () => ({
	open: (schema) => openPostgresSessionDatabase({ connection: db, schema }),
	drop: async (schema) => {
		await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
	},
}));

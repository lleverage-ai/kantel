import { PGlite } from "@electric-sql/pglite";
import { registerWorkspaceConformance } from "@harbour/testing/workspace";
import { afterAll, describe, expect, it } from "vitest";
import { createMemoryObjects } from "../src/index.ts";
import { pgliteDatabase, providers } from "./support.ts";

// The real SQL on PGlite, with objects in memory: what CI runs. test/conformance.stack.test.ts runs the same cases on
// Postgres and MinIO.
const pglite = new PGlite();
afterAll(() => pglite.close());
const db = pgliteDatabase(pglite);

for (const [name, provider] of Object.entries(providers(async () => ({ db, objects: createMemoryObjects() })))) {
	registerWorkspaceConformance({ describe, expect, it }, `self-hosted workspaces on PGlite, ${name}`, provider, {
		projectAccess: true,
		keyed: true,
	});
}

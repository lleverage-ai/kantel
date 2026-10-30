import { createSqlMemory, migrateMemory } from "@harbour/memory/sql";
import { testDatabaseKinds } from "@harbour/sql/testing";
import { withTestTimeout } from "@harbour/testing/harness";
import { registerMemoryConformance } from "@harbour/testing/memory";
import { describe, expect, it } from "vitest";

for (const kind of testDatabaseKinds()) {
	const runner = withTestTimeout({ describe, expect, it }, kind.testTimeoutMs);
	registerMemoryConformance(
		runner,
		`SQL memory on ${kind.name}`,
		async (deps, use, settings) => {
			const database = await kind.open();
			try {
				await migrateMemory(database.driver);
				await use({
					memory: createSqlMemory({
						driver: database.driver,
						clock: deps.clock,
						audit: deps.audit,
						access: deps.access,
						...settings,
					}),
				});
			} finally {
				await database.close();
			}
		},
		{ projectAccess: true, writes: true },
	);
}

import { createSqlMemory, migrateMemory } from "@kantel/memory/sql";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { withTestTimeout } from "@kantel/testing/harness";
import { registerMemoryConformance } from "@kantel/testing/memory";
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

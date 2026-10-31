import { createMemoryObjectBucket, createSqlSkills, migrateSkills } from "@kantel/skills/sql";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { withTestTimeout } from "@kantel/testing/harness";
import { registerSkillsConformance } from "@kantel/testing/skills";
import { describe, expect, it } from "vitest";

for (const kind of testDatabaseKinds()) {
	const runner = withTestTimeout({ describe, expect, it }, kind.testTimeoutMs);
	registerSkillsConformance(
		runner,
		`SQL skills on ${kind.name}`,
		async (deps, use, settings) => {
			const database = await kind.open();
			try {
				await migrateSkills(database.driver);
				await use({
					skills: createSqlSkills({
						driver: database.driver,
						objects: createMemoryObjectBucket(),
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

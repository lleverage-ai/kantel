import { createMemoryObjectBucket, createSqlSkills, migrateSkills } from "@harbour/skills/sql";
import { testDatabaseKinds } from "@harbour/sql/testing";
import { registerSkillsConformance } from "@harbour/testing/skills";
import { describe, expect, it } from "vitest";

for (const kind of testDatabaseKinds()) {
	registerSkillsConformance(
		{ describe, expect, it },
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

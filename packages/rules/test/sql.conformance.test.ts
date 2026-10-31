import { createSqlPromptRules, migrateRules } from "@kantel/rules/sql";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { withTestTimeout } from "@kantel/testing/harness";
import { registerRulesConformance } from "@kantel/testing/rules";
import { describe, expect, it } from "vitest";

// Postgres (PGlite) and SQLite (D1 on Miniflare, as Cloudflare runs it).
for (const kind of testDatabaseKinds()) {
	const runner = withTestTimeout({ describe, expect, it }, kind.testTimeoutMs);
	registerRulesConformance(
		runner,
		`SQL prompt rules on ${kind.name}`,
		async (deps, use) => {
			const database = await kind.open();
			try {
				await migrateRules(database.driver);
				await use({
					rules: createSqlPromptRules({
						driver: database.driver,
						access: deps.access,
						audit: deps.audit,
						clock: deps.clock,
					}),
				});
			} finally {
				await database.close();
			}
		},
		{ projectAccess: true },
	);
}

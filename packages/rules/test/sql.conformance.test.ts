import { createSqlPromptRules, migrateRules } from "@harbour/rules/sql";
import { testDatabaseKinds } from "@harbour/sql/testing";
import { withTestTimeout } from "@harbour/testing/harness";
import { registerRulesConformance } from "@harbour/testing/rules";
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

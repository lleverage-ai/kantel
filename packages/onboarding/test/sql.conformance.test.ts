import { createSqlOnboarding, migrateOnboarding } from "@harbour/onboarding/sql";
import { testDatabaseKinds } from "@harbour/sql/testing";
import { withTestTimeout } from "@harbour/testing/harness";
import { registerOnboardingConformance } from "@harbour/testing/onboarding";
import { describe, expect, it } from "vitest";

// Postgres (PGlite) and SQLite (D1 on Miniflare, as Cloudflare runs it).
for (const kind of testDatabaseKinds()) {
	const runner = withTestTimeout({ describe, expect, it }, kind.testTimeoutMs);
	registerOnboardingConformance(
		runner,
		`SQL onboarding on ${kind.name}`,
		async (deps, use) => {
			const database = await kind.open();
			try {
				// Twice: the schema is idempotent.
				await migrateOnboarding(database.driver);
				await migrateOnboarding(database.driver);
				await use({
					onboarding: createSqlOnboarding({
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

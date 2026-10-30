import { createSqlSharing, migrateSharing } from "@harbour/sharing/sql";
import { testDatabaseKinds } from "@harbour/sql/testing";
import { withTestTimeout } from "@harbour/testing/harness";
import { registerSharingConformance } from "@harbour/testing/sharing";
import { describe, expect, it } from "vitest";

for (const kind of testDatabaseKinds()) {
	const runner = withTestTimeout({ describe, expect, it }, kind.testTimeoutMs);
	registerSharingConformance(runner, `SQL sharing on ${kind.name}`, async (deps, use) => {
		const database = await kind.open();
		try {
			await migrateSharing(database.driver);
			// Twice: every statement is idempotent.
			await migrateSharing(database.driver);
			await use({
				sharing: createSqlSharing({
					driver: database.driver,
					access: deps.access,
					audit: deps.audit,
					clock: deps.clock,
					resolvers: deps.resolvers,
				}),
			});
		} finally {
			await database.close();
		}
	});
}

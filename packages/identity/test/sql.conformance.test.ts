import { createSqlIdentity, migrateIdentity } from "@harbour/identity/sql";
import { testDatabaseKinds } from "@harbour/sql/testing";
import { withTestTimeout } from "@harbour/testing/harness";
import { registerIdentityConformance } from "@harbour/testing/identity";
import { describe, expect, it } from "vitest";

for (const kind of testDatabaseKinds()) {
	const runner = withTestTimeout({ describe, expect, it }, kind.testTimeoutMs);
	registerIdentityConformance(runner, `SQL identity on ${kind.name}`, async (deps, use) => {
		const database = await kind.open();
		try {
			await migrateIdentity(database.driver);
			await use({ identity: createSqlIdentity({ driver: database.driver, clock: deps.clock, audit: deps.audit }) });
		} finally {
			await database.close();
		}
	});
}

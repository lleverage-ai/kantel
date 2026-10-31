import { createSqlIdentity, migrateIdentity } from "@kantel/identity/sql";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { withTestTimeout } from "@kantel/testing/harness";
import { registerIdentityConformance } from "@kantel/testing/identity";
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

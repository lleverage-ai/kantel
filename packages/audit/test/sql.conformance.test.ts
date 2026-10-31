import { createSqlAuditOutbox, createSqlAuditStore, migrateAudit } from "@kantel/audit/sql";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { flakyAuditSink, registerAuditConformance } from "@kantel/testing/audit";
import { withTestTimeout } from "@kantel/testing/harness";
import { describe, expect, it } from "vitest";

for (const kind of testDatabaseKinds()) {
	const runner = withTestTimeout({ describe, expect, it }, kind.testTimeoutMs);
	registerAuditConformance(
		runner,
		`SQL audit store and outbox on ${kind.name}`,
		async (deps, use) => {
			const database = await kind.open();
			try {
				await migrateAudit(database.driver);
				await use({
					store: createSqlAuditStore({ driver: database.driver, clock: deps.clock, access: deps.access }),
					outbox: createSqlAuditOutbox({ driver: database.driver, clock: deps.clock }),
					flakySink: flakyAuditSink,
				});
			} finally {
				await database.close();
			}
		},
		{ projectAccess: true },
	);
}

import { createSqlAuditOutbox, createSqlAuditStore, migrateAudit } from "@harbour/audit/sql";
import { testDatabaseKinds } from "@harbour/sql/testing";
import { flakyAuditSink, registerAuditConformance } from "@harbour/testing/audit";
import { describe, expect, it } from "vitest";

for (const kind of testDatabaseKinds()) {
	registerAuditConformance(
		{ describe, expect, it },
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

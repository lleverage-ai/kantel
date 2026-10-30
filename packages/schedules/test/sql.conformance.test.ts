import { createSqlSchedules, migrateSchedules } from "@harbour/schedules/sql";
import { testDatabaseKinds } from "@harbour/sql/testing";
import { withTestTimeout } from "@harbour/testing/harness";
import { registerSchedulesConformance } from "@harbour/testing/schedules";
import { describe, expect, it } from "vitest";

for (const kind of testDatabaseKinds()) {
	const runner = withTestTimeout({ describe, expect, it }, kind.testTimeoutMs);
	registerSchedulesConformance(
		runner,
		`SQL schedules on ${kind.name}`,
		async (deps, use) => {
			const database = await kind.open();
			try {
				await migrateSchedules(database.driver);
				const open = () =>
					createSqlSchedules({ driver: database.driver, clock: deps.clock, audit: deps.audit, access: deps.access });
				await use({
					schedules: open(),
					peer: open(),
					reopen: async () => {
						// A restarted host runs the migrations again before it opens the store.
						await migrateSchedules(database.driver);
						return open();
					},
				});
			} finally {
				await database.close();
			}
		},
		{ projectAccess: true },
	);
}

// A database the sharing tables were made in before a column was added gets it from `migrateSharing`, with the
// default every earlier row means, and running it again changes nothing.
import { migrateSharing } from "@kantel/sharing/sql";
import { testDatabaseKinds } from "@kantel/sql/testing";
import { describe, expect, it } from "vitest";

/** `sharing_shares` as it first shipped, before `agent_writes`. */
const FIRST_SHARES = `CREATE TABLE sharing_shares (
	organisation_id TEXT NOT NULL,
	id TEXT NOT NULL,
	kind TEXT NOT NULL,
	resource_id TEXT NOT NULL,
	revision INTEGER,
	owner_kind TEXT NOT NULL,
	owner_organisation_id TEXT,
	owner_project_id TEXT,
	owner_user_id TEXT,
	grantee_key TEXT NOT NULL,
	permission TEXT NOT NULL,
	granted_by TEXT NOT NULL,
	granted_at REAL NOT NULL,
	request_id TEXT,
	expires_at REAL,
	parent_share_id TEXT,
	note TEXT,
	revoked_at REAL,
	revoked_by TEXT,
	revoke_reason TEXT,
	PRIMARY KEY (organisation_id, id)
)`;

for (const kind of testDatabaseKinds()) {
	describe(`sharing migrations on ${kind.name}`, () => {
		it("adds agent_writes to a table made before it, off for every share already there", async () => {
			const database = await kind.open();
			try {
				const { driver } = database;
				await driver.query(FIRST_SHARES);
				await driver.query(
					`INSERT INTO sharing_shares (organisation_id, id, kind, resource_id, owner_kind, owner_organisation_id, owner_project_id, grantee_key, permission, granted_by, granted_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					["org-a", "shr_old", "workspace", "ws-1", "project", "org-a", "proj-a", "project:proj-b", "edit", "{}", 1],
				);
				await migrateSharing(driver);
				await migrateSharing(driver);
				const rows = await driver.query("SELECT id, agent_writes FROM sharing_shares");
				expect(rows.map((row) => ({ id: row.id, agentWrites: Number(row.agent_writes) }))).toEqual([
					{ id: "shr_old", agentWrites: 0 },
				]);
			} finally {
				await database.close();
			}
		});
	});
}

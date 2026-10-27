/**
 * Finds what an earlier, unfinished bootstrap made in the SQL identity directory, so a restart reuses it instead of
 * making a second organisation or a second user with the admin's email (which would stop that person signing in:
 * identity refuses a sign-in that matches two unlinked users by email).
 *
 * The bootstrap saves each step only after identity has committed it, and identity commits before it appends its
 * audit events, so a failure in between leaves a committed row the bootstrap record doesn't name. These read-only
 * queries close that gap. They read `@harbour/identity/sql`'s tables, because `IdentityDirectory` has no way to find
 * a user by email or the organisations a user administers; `test/durable.test.ts` runs them over that package's
 * migrations, so a schema change there fails here.
 */
import { normaliseEmail } from "@harbour/contracts";
import type { SqlDriver } from "@harbour/sql";
import type { BootstrapFinder } from "./stack.ts";

/** The organisation ID the bootstrap's system context names; identity records it on the users that context makes. */
export const BOOTSTRAP_ORGANISATION = "bootstrap";

export function sqlBootstrapFinder(driver: SqlDriver): BootstrapFinder {
	const first = async (sql: string, params: readonly string[]): Promise<string | undefined> => {
		const [row] = await driver.query<{ id: unknown }>(sql, params);
		return row === undefined ? undefined : String(row.id);
	};
	return {
		user: (email) =>
			first(
				"SELECT id FROM identity_users WHERE email_normalised = ? AND created_in_organisation_id = ? ORDER BY created_at, id LIMIT 1",
				[normaliseEmail(email), BOOTSTRAP_ORGANISATION],
			),
		organisation: (userId) =>
			first(
				"SELECT organisation_id AS id FROM identity_role_bindings WHERE principal_kind = 'user' AND principal_id = ? AND scope = '*' AND role = 'admin' ORDER BY seq LIMIT 1",
				[userId],
			),
		project: (organisationId) =>
			first("SELECT id FROM identity_projects WHERE organisation_id = ? ORDER BY seq LIMIT 1", [organisationId]),
		organisationExists: async (organisationId) =>
			(await first("SELECT id FROM identity_organisations WHERE id = ?", [organisationId])) !== undefined,
	};
}

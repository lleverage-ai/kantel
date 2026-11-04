/**
 * The durable `IdentityDirectory`, on any `SqlDriver`: Postgres for the self-hosted target, D1 (or a Durable Object's
 * SQLite) for Cloudflare. It behaves as the in-memory directory in `./memory.ts` does and passes the same suite.
 *
 * - One table per record kind. A role binding is one row per organisation, principal and scope (`*` for the whole
 *   organisation), so a grant is one `INSERT … ON CONFLICT DO UPDATE` that replaces the old binding.
 * - API keys are kept only as the hex SHA-256 of their secret (looked up by it) and a display prefix; a key's projects
 *   are a JSON list in one column.
 * - There are no interactive transactions: a change that must be atomic (an organisation and its first admin) is one
 *   `batch`. Uniqueness races are settled by `UNIQUE` constraints: a second user taking an external subject fails on
 *   `identity_users.external_subject` and is reported as `conflict`, as the in-memory directory reports it.
 * - Lists bind as one JSON parameter (`json_each` / `jsonb_array_elements_text`), so no statement meets D1's
 *   100-parameter cap. Times are numbers (`DOUBLE PRECISION` / `REAL`); IDs are `TEXT`.
 * - Audit events go to the sink after the write, as the in-memory directory sends them.
 */
import {
	type Actor,
	API_KEY_LAST_USED_PRECISION_MS,
	type ApiKey,
	type ApiKeyId,
	type AuditEventType,
	type Authentication,
	type CallContext,
	type ExternalIdentity,
	externalSubjectOf,
	type IdentityDirectory,
	INVITE_TTL_MILLISECONDS,
	type Invite,
	type IssuedApiKey,
	isKantelSignInIssuer,
	type JsonValue,
	KANTEL_SIGN_IN_ISSUERS,
	KantelError,
	normaliseEmail,
	type Organisation,
	type OrganisationId,
	type Page,
	type PageRequest,
	type Principal,
	type Project,
	type ProjectId,
	type ProjectSettings,
	ROLES,
	type Role,
	type RoleBinding,
	requireSystem,
	roleSatisfies,
	type ServiceId,
	type ServiceIdentity,
	type SignIn,
	systemClock,
	systemContext,
	type User,
	type UserId,
	type UserPreferences,
} from "@kantel/contracts";
import {
	type SqlDialect,
	type SqlDriver,
	type SqlStatement,
	type SqlValue,
	sql,
	sqlNumber,
	sqlOptionalString,
} from "@kantel/sql";
import {
	apiKeyName,
	apiKeyPermissions,
	apiKeyPrefix,
	apiKeyScope,
	callsWithKey,
	changedPreferences,
	changedProjectSettings,
	checkApiKeyScope,
	generateApiKeySecret,
	hashApiKeySecret,
	inviteEmail,
	inviteeName,
	inviteRole,
	keptPreferences,
	knownProjectSettings,
	lastUsedIsStale,
	preferencesOwner,
	scopeOfKey,
	strongestRole,
} from "./index.ts";
import type { MemoryIdentityOptions } from "./memory.ts";
import { otpSchema } from "./otp-sql.ts";

export { createSqlOtpStores, otpSchema } from "./otp-sql.ts";

/** Identity appends its audit events as itself. */
const AUDIT_CONTEXT = systemContext("identity");

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;

/** The `scope` of an organisation-wide binding. Project IDs never take this value. */
const ORGANISATION_SCOPE = "*";

export interface SqlIdentityOptions extends MemoryIdentityOptions {
	readonly driver: SqlDriver;
}

/** The advisory lock every Postgres project insert takes, so projects commit in `seq` order. */
const PROJECT_ORDER_LOCK = "SELECT pg_advisory_xact_lock(7316102019)";

/** The tables and indexes, for `migrateIdentity` or a target's own migrations. Every statement is idempotent. */
export function identitySchema(dialect: SqlDialect): readonly string[] {
	const key = dialect === "postgres" ? "BIGSERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
	const time = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		// `roles_version` changes with every grant and revocation in the organisation (see `guardedRoleChange`).
		`CREATE TABLE IF NOT EXISTS identity_organisations (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			created_at ${time} NOT NULL,
			roles_version TEXT NOT NULL DEFAULT ''
		)`,
		// Never holds a row once a batch commits: `guardedRoleChange` inserts NULL here to fail a stale batch.
		`CREATE TABLE IF NOT EXISTS identity_role_guard (
			version TEXT NOT NULL
		)`,
		// `seq` keeps creation order, so listProjects pages in the order projects were made.
		`CREATE TABLE IF NOT EXISTS identity_projects (
			seq ${key},
			id TEXT NOT NULL UNIQUE,
			organisation_id TEXT NOT NULL,
			name TEXT NOT NULL,
			created_at ${time} NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS identity_projects_by_organisation ON identity_projects (organisation_id, seq)",
		// A user is global; `created_in_organisation_id` is the organisation the creating call ran in (it may name none
		// that exists, such as a bootstrap context), so it has no foreign key.
		`CREATE TABLE IF NOT EXISTS identity_users (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			email TEXT,
			email_normalised TEXT,
			external_subject TEXT UNIQUE,
			created_in_organisation_id TEXT NOT NULL,
			created_at ${time} NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS identity_users_by_email ON identity_users (email_normalised)",
		// More of Kantel's own sign-ins (an email code, GitHub, Google) linked to a user beside their `external_subject`,
		// by verified email (see `IdentityDirectory.signIn`). A subject is here or in `identity_users`, never both.
		`CREATE TABLE IF NOT EXISTS identity_user_subjects (
			external_subject TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			issuer TEXT NOT NULL,
			created_at ${time} NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS identity_user_subjects_by_user ON identity_user_subjects (user_id)",
		`CREATE TABLE IF NOT EXISTS identity_services (
			id TEXT PRIMARY KEY,
			organisation_id TEXT NOT NULL,
			name TEXT NOT NULL,
			created_at ${time} NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS identity_services_by_organisation ON identity_services (organisation_id)",
		// `scope` is a project ID, or `*` for the whole organisation. A replacing grant keeps the row's `seq`.
		`CREATE TABLE IF NOT EXISTS identity_role_bindings (
			seq ${key},
			organisation_id TEXT NOT NULL,
			principal_kind TEXT NOT NULL,
			principal_id TEXT NOT NULL,
			scope TEXT NOT NULL,
			role TEXT NOT NULL,
			granted_at ${time} NOT NULL,
			granted_by TEXT NOT NULL,
			UNIQUE (organisation_id, principal_kind, principal_id, scope)
		)`,
		"CREATE INDEX IF NOT EXISTS identity_role_bindings_by_principal ON identity_role_bindings (principal_kind, principal_id)",
		`CREATE TABLE IF NOT EXISTS identity_api_keys (
			seq ${key},
			id TEXT NOT NULL UNIQUE,
			secret_hash TEXT NOT NULL UNIQUE,
			service_id TEXT NOT NULL,
			organisation_id TEXT NOT NULL,
			project_ids TEXT NOT NULL,
			role TEXT NOT NULL,
			prefix TEXT NOT NULL,
			created_at ${time} NOT NULL,
			expires_at ${time},
			revoked_at ${time}
		)`,
		"CREATE INDEX IF NOT EXISTS identity_api_keys_by_organisation ON identity_api_keys (organisation_id, seq)",
		// A key's name and when it was last used, in a table of their own so that a directory made before them gains
		// them with a `CREATE TABLE IF NOT EXISTS`, and a use writes here rather than to the key's row. A key issued
		// before it has no row until its first use.
		`CREATE TABLE IF NOT EXISTS identity_api_key_details (
			key_id TEXT PRIMARY KEY,
			name TEXT,
			last_used_at ${time}
		)`,
		// A key's permissions beyond its role (`API_KEY_PERMISSIONS`), as a JSON list, in a table of their own for the same
		// reason. Written once, with the key; a key with none has no row.
		`CREATE TABLE IF NOT EXISTS identity_api_key_permissions (
			key_id TEXT PRIMARY KEY,
			permissions TEXT NOT NULL
		)`,
		// A key's scope (`ApiKeyScope`), in a table of its own for the same reason. Written once, with the key, for an
		// `organisation` key only: a key with no row is a `projects` key, as every key issued before scopes is.
		`CREATE TABLE IF NOT EXISTS identity_api_key_scopes (
			key_id TEXT PRIMARY KEY,
			scope TEXT NOT NULL
		)`,
		// A person's own settings (`UserPreferences`), as one JSON object, so a new setting needs no new column.
		`CREATE TABLE IF NOT EXISTS identity_user_preferences (
			user_id TEXT PRIMARY KEY,
			preferences TEXT NOT NULL,
			updated_at ${time} NOT NULL
		)`,
		// A project's own settings (`ProjectSettings`), as one JSON object for the same reason. A project with none has no row.
		`CREATE TABLE IF NOT EXISTS identity_project_settings (
			project_id TEXT PRIMARY KEY,
			settings TEXT NOT NULL,
			updated_at ${time} NOT NULL
		)`,
		// An invite is pending while `accepted_at` and `revoked_at` are unset and `expires_at` is ahead. `acceptance` is the
		// accepting sign-in's own ID, so of two that race, the one whose ID the row keeps audits it.
		`CREATE TABLE IF NOT EXISTS identity_invites (
			seq ${key},
			id TEXT NOT NULL UNIQUE,
			organisation_id TEXT NOT NULL,
			email TEXT NOT NULL,
			email_normalised TEXT NOT NULL,
			role TEXT NOT NULL,
			invited_by TEXT NOT NULL,
			created_at ${time} NOT NULL,
			expires_at ${time} NOT NULL,
			accepted_at ${time},
			accepted_by TEXT,
			acceptance TEXT,
			revoked_at ${time}
		)`,
		"CREATE INDEX IF NOT EXISTS identity_invites_by_email ON identity_invites (email_normalised)",
		"CREATE INDEX IF NOT EXISTS identity_invites_by_organisation ON identity_invites (organisation_id, seq)",
		...otpSchema(dialect),
		// The agent plane's passkey tables (`identity_passkeys`, `identity_passkey_challenges`), created before
		// TASK-4721, are no longer made here; where they exist they stay, unread.
	];
}

/** Creates the identity tables if they are missing. */
export async function migrateIdentity(driver: SqlDriver): Promise<void> {
	await driver.batch(identitySchema(driver.dialect).map((text) => ({ sql: text })));
}

/** `column` is one of the strings in the JSON array bound as one parameter, so a list never meets D1's 100-parameter cap. */
function inJsonList(dialect: SqlDialect, column: string): string {
	return dialect === "postgres"
		? `${column} IN (SELECT jsonb_array_elements_text(CAST(? AS jsonb)))`
		: `${column} IN (SELECT value FROM json_each(?))`;
}

/** Whether `error` is a not-null violation: Postgres's SQLSTATE 23502, or SQLite's (and D1's) message. */
function isNotNullViolation(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { code, message } = error as { code?: unknown; message?: unknown };
	return code === "23502" || (typeof message === "string" && /NOT NULL constraint failed/i.test(message));
}

/** Whether `error` is a unique-constraint violation: Postgres's SQLSTATE 23505, or SQLite's (and D1's) message. */
function isUniqueViolation(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { code, message } = error as { code?: unknown; message?: unknown };
	return code === "23505" || (typeof message === "string" && /UNIQUE constraint failed/i.test(message));
}

type OrganisationRow = { id: unknown; name: unknown; created_at: unknown };
type ProjectRow = { id: unknown; organisation_id: unknown; name: unknown; created_at: unknown };
type UserRow = {
	id: unknown;
	name: unknown;
	email: unknown;
	external_subject: unknown;
	created_in_organisation_id: unknown;
	created_at: unknown;
};
type ServiceRow = { id: unknown; organisation_id: unknown; name: unknown; created_at: unknown };
type BindingRow = {
	organisation_id: unknown;
	principal_kind: unknown;
	principal_id: unknown;
	scope: unknown;
	role: unknown;
	granted_at: unknown;
	granted_by: unknown;
};
type ApiKeyRow = {
	id: unknown;
	service_id: unknown;
	organisation_id: unknown;
	project_ids: unknown;
	role: unknown;
	prefix: unknown;
	created_at: unknown;
	expires_at: unknown;
	revoked_at: unknown;
	name: unknown;
	last_used_at: unknown;
	permissions: unknown;
	scope: unknown;
};
type FoundRow = { found: unknown };
type InviteRow = {
	id: unknown;
	organisation_id: unknown;
	email: unknown;
	role: unknown;
	invited_by: unknown;
	created_at: unknown;
	expires_at: unknown;
};

const INVITE_COLUMNS = "id, organisation_id, email, role, invited_by, created_at, expires_at";
/** The condition on `identity_invites` for one still pending at the time bound as its one parameter. */
const INVITE_PENDING = "accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?";

function inviteOf(row: InviteRow): Invite {
	return Object.freeze({
		id: String(row.id),
		organisationId: String(row.organisation_id),
		email: String(row.email),
		role: String(row.role) as Role,
		invitedBy: JSON.parse(String(row.invited_by)) as Actor,
		createdAt: sqlNumber(row.created_at),
		expiresAt: sqlNumber(row.expires_at),
	});
}

const PROJECT_COLUMNS = "p.id, p.organisation_id, p.name, p.created_at";
const USER_COLUMNS = "id, name, email, external_subject, created_in_organisation_id, created_at";
/** `USER_COLUMNS` of `identity_users u`. */
const USER_COLUMNS_OF_U = USER_COLUMNS.split(", ")
	.map((column) => `u.${column}`)
	.join(", ");
/**
 * `external_subject` is one of Kantel's own sign-ins' (`isKantelSignInSubject`): one `substr(external_subject, 1, ?) =
 * ?` per issuer, its prefix's length and the prefix following as parameters (`KANTEL_SUBJECT_PARAMS`).
 */
const KANTEL_SUBJECT = `(${KANTEL_SIGN_IN_ISSUERS.map(() => "substr(external_subject, 1, ?) = ?").join(" OR ")})`;
const KANTEL_SUBJECT_PARAMS: readonly SqlValue[] = KANTEL_SIGN_IN_ISSUERS.flatMap((issuer) => {
	const prefix = externalSubjectOf(issuer, "");
	return [prefix.length, prefix];
});
const BINDING_COLUMNS = "organisation_id, principal_kind, principal_id, scope, role, granted_at, granted_by";
/** Every key column, with its details; follow with a `WHERE` on `k`. */
const SELECT_KEYS =
	"SELECT k.id, k.service_id, k.organisation_id, k.project_ids, k.role, k.prefix, k.created_at, k.expires_at, k.revoked_at, d.name, d.last_used_at, kp.permissions, ks.scope FROM identity_api_keys k LEFT JOIN identity_api_key_details d ON d.key_id = k.id LEFT JOIN identity_api_key_permissions kp ON kp.key_id = k.id LEFT JOIN identity_api_key_scopes ks ON ks.key_id = k.id";

interface StoredUser {
	readonly user: User;
	/** The organisation the creating call ran in; the user is visible there even before holding a role. */
	readonly createdInOrganisationId: OrganisationId;
}

const optionalNumber = (value: unknown): number | undefined =>
	value === null || value === undefined ? undefined : sqlNumber(value);

function organisationOf(row: OrganisationRow): Organisation {
	return Object.freeze({ id: String(row.id), name: String(row.name), createdAt: sqlNumber(row.created_at) });
}

function projectOf(row: ProjectRow): Project {
	return Object.freeze({
		id: String(row.id),
		organisationId: String(row.organisation_id),
		name: String(row.name),
		createdAt: sqlNumber(row.created_at),
	});
}

function storedUserOf(row: UserRow): StoredUser {
	const email = sqlOptionalString(row.email);
	const externalSubject = sqlOptionalString(row.external_subject);
	const user: User = Object.freeze({
		id: String(row.id),
		name: String(row.name),
		...(email === undefined ? {} : { email }),
		...(externalSubject === undefined ? {} : { externalSubject }),
		createdAt: sqlNumber(row.created_at),
	});
	return { user, createdInOrganisationId: String(row.created_in_organisation_id) };
}

function serviceOf(row: ServiceRow): ServiceIdentity {
	return Object.freeze({
		id: String(row.id),
		organisationId: String(row.organisation_id),
		name: String(row.name),
		createdAt: sqlNumber(row.created_at),
	});
}

function bindingOf(row: BindingRow): RoleBinding {
	const scope = String(row.scope);
	const principalId = String(row.principal_id);
	const principal: Principal =
		String(row.principal_kind) === "user"
			? { kind: "user", userId: principalId }
			: { kind: "service", serviceId: principalId };
	return Object.freeze({
		organisationId: String(row.organisation_id),
		...(scope === ORGANISATION_SCOPE ? {} : { projectId: scope }),
		principal: Object.freeze(principal),
		role: String(row.role) as Role,
		grantedAt: sqlNumber(row.granted_at),
		grantedBy: JSON.parse(String(row.granted_by)) as Actor,
	});
}

function apiKeyOf(row: ApiKeyRow): ApiKey {
	const expiresAt = optionalNumber(row.expires_at);
	const revokedAt = optionalNumber(row.revoked_at);
	const name = sqlOptionalString(row.name);
	const lastUsedAt = optionalNumber(row.last_used_at);
	const projectIds = (JSON.parse(String(row.project_ids)) as unknown[]).map(String);
	const stored = sqlOptionalString(row.permissions);
	const permissions = stored === undefined ? undefined : apiKeyPermissions(JSON.parse(stored));
	// Only `organisation` is ever written; any other value reads as the default, `projects`.
	const organisation = sqlOptionalString(row.scope) === "organisation";
	return Object.freeze({
		id: String(row.id),
		serviceId: String(row.service_id),
		organisationId: String(row.organisation_id),
		...(organisation ? { scope: "organisation" as const } : {}),
		projectIds: Object.freeze(projectIds),
		role: String(row.role) as Role,
		...(permissions === undefined ? {} : { permissions }),
		prefix: String(row.prefix),
		...(name === undefined ? {} : { name }),
		createdAt: sqlNumber(row.created_at),
		...(lastUsedAt === undefined ? {} : { lastUsedAt }),
		...(expiresAt === undefined ? {} : { expiresAt }),
		...(revokedAt === undefined ? {} : { revokedAt }),
	});
}

const newId = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;

/** A principal as the binding columns: kind and ID. */
const principalColumns = (principal: Principal): readonly [string, string] =>
	principal.kind === "user" ? ["user", principal.userId] : ["service", principal.serviceId];

function principalOf(actor: Actor): Principal | undefined {
	if (actor.kind === "human") {
		return typeof actor.userId === "string" ? { kind: "user", userId: actor.userId } : undefined;
	}
	if (actor.kind === "service") {
		return typeof actor.serviceId === "string" ? { kind: "service", serviceId: actor.serviceId } : undefined;
	}
	return undefined;
}

function requireName(name: unknown, what: string): string {
	if (typeof name !== "string" || name.trim() === "") throw new KantelError("invalid", `${what} needs a name`);
	return name;
}

function requireRoleValue(role: unknown): Role {
	if (typeof role !== "string" || !ROLES.includes(role as Role)) throw new KantelError("invalid", "unknown role");
	return role as Role;
}

const forbidden = (message: string): KantelError => new KantelError("forbidden", message);
const notFound = (what: string): KantelError => new KantelError("not_found", `${what} not found`);
const subjectConflict = (): KantelError =>
	new KantelError("conflict", "another user already has this external subject");

/** The durable `IdentityDirectory`. Call `migrateIdentity(driver)` (or run `identitySchema`) once before using it. */
export function createSqlIdentity(options: SqlIdentityOptions): IdentityDirectory {
	const { driver } = options;
	const clock = options.clock ?? systemClock;
	const audit = options.audit;
	const workerOptions = { ...(audit === undefined ? {} : { audit }), clock };

	const keyIsLive = (key: ApiKey): boolean =>
		key.revokedAt === undefined && (key.expiresAt === undefined || clock.now() < key.expiresAt);

	/** When this instance last recorded each key's use, so a busy key skips the write it would not change. */
	const usesRecorded = new Map<ApiKeyId, number>();

	/**
	 * Records a key's use, at most once per `API_KEY_LAST_USED_PRECISION_MS`: the upsert moves `last_used_at` on only
	 * when it is unset or that much older, whichever instance wrote it. A failed write never fails the call it records.
	 */
	async function recordUse(key: ApiKey): Promise<void> {
		const now = clock.now();
		if (!lastUsedIsStale(key.lastUsedAt, now) || !lastUsedIsStale(usesRecorded.get(key.id), now)) return;
		if (usesRecorded.size >= 10_000) usesRecorded.clear();
		usesRecorded.set(key.id, now);
		try {
			await driver.query(
				`INSERT INTO identity_api_key_details (key_id, name, last_used_at) VALUES (?, NULL, ?)
				 ON CONFLICT (key_id) DO UPDATE SET last_used_at = excluded.last_used_at
				 WHERE identity_api_key_details.last_used_at IS NULL OR identity_api_key_details.last_used_at <= ?`,
				[key.id, now, now - API_KEY_LAST_USED_PRECISION_MS],
			);
		} catch {
			usesRecorded.delete(key.id);
		}
	}

	async function exists(text: string, params: readonly SqlValue[]): Promise<boolean> {
		return (await driver.query<FoundRow>(text, params)).length > 0;
	}

	async function keyById(keyId: unknown): Promise<ApiKey | undefined> {
		if (typeof keyId !== "string") return undefined;
		const [row] = await driver.query<ApiKeyRow>(`${SELECT_KEYS} WHERE k.id = ?`, [keyId]);
		return row === undefined ? undefined : apiKeyOf(row);
	}

	async function userById(userId: unknown): Promise<StoredUser | undefined> {
		if (typeof userId !== "string") return undefined;
		const [row] = await driver.query<UserRow>(`SELECT ${USER_COLUMNS} FROM identity_users WHERE id = ?`, [userId]);
		return row === undefined ? undefined : storedUserOf(row);
	}

	/** A person's settings as kept, keeping only the ones Kantel knows: a row it can't read is no settings. */
	async function preferencesOf(userId: UserId): Promise<UserPreferences> {
		const [row] = await driver.query<{ preferences: unknown }>(
			"SELECT preferences FROM identity_user_preferences WHERE user_id = ?",
			[userId],
		);
		if (row === undefined || typeof row.preferences !== "string") return {};
		try {
			return keptPreferences(JSON.parse(row.preferences));
		} catch {
			return {};
		}
	}

	/** A project's settings as kept, keeping only the ones Kantel knows: a row it can't read is no settings. */
	async function projectSettingsOf(projectId: ProjectId): Promise<ProjectSettings> {
		const [row] = await driver.query<{ settings: unknown }>(
			"SELECT settings FROM identity_project_settings WHERE project_id = ?",
			[projectId],
		);
		if (row === undefined || typeof row.settings !== "string") return {};
		try {
			return knownProjectSettings(JSON.parse(row.settings));
		} catch {
			return {};
		}
	}

	/** The project, when the caller holds a role on it; else `not_found`, as `getProject` answers. */
	async function visibleProject(ctx: CallContext, projectId: ProjectId): Promise<void> {
		await projectIn(ctx.organisationId, projectId);
		if ((await resolveRole(ctx.actor, ctx.organisationId, projectId)) === undefined) throw notFound("project");
	}

	/** The user whose subject `externalSubject` is, or who was linked to it (`identity_user_subjects`): one statement. */
	async function userBySubject(externalSubject: string): Promise<StoredUser | undefined> {
		const [row] = await driver.query<UserRow>(
			`SELECT ${USER_COLUMNS} FROM identity_users WHERE external_subject = ?
			UNION ALL
			SELECT ${USER_COLUMNS_OF_U} FROM identity_user_subjects s JOIN identity_users u ON u.id = s.user_id
			WHERE s.external_subject = ?`,
			[externalSubject, externalSubject],
		);
		return row === undefined ? undefined : storedUserOf(row);
	}

	/**
	 * The one user who signs in with `email` (normalised) another of Kantel's own ways, or undefined when none or several
	 * do. Only for a sign-in of Kantel's own (`isKantelSignInIssuer`).
	 */
	async function kantelSignInByEmail(email: string): Promise<StoredUser | undefined> {
		const rows = await driver.query<UserRow>(
			`SELECT ${USER_COLUMNS} FROM identity_users WHERE email_normalised = ? AND ${KANTEL_SUBJECT} LIMIT 2`,
			[email, ...KANTEL_SUBJECT_PARAMS],
		);
		return rows.length === 1 && rows[0] !== undefined ? storedUserOf(rows[0]) : undefined;
	}

	/**
	 * Links `externalSubject` to `user` beside the subject they have, or, when a concurrent sign-in linked it first, finds
	 * whoever now holds it. Audits `identity.user.linked` once, from the sign-in that linked.
	 */
	async function linkAnother(user: StoredUser, externalSubject: string, issuer: string): Promise<StoredUser> {
		try {
			await driver.query(
				"INSERT INTO identity_user_subjects (external_subject, user_id, issuer, created_at) VALUES (?, ?, ?, ?)",
				[externalSubject, user.user.id, issuer, clock.now()],
			);
		} catch (error) {
			const holder = await userBySubject(externalSubject).catch(() => undefined);
			if (holder !== undefined) return holder;
			throw error;
		}
		await emit(
			{ actor: { kind: "human", userId: user.user.id }, organisationId: user.createdInOrganisationId },
			"identity.user.linked",
			user.createdInOrganisationId,
			{ kind: "identity.user", id: user.user.id },
			{ issuer },
		);
		return user;
	}

	/** Whether the organisation exists, and (when given) the project exists in it. */
	async function scopeExists(organisationId: OrganisationId, projectId: ProjectId | undefined): Promise<boolean> {
		if (typeof organisationId !== "string") return false;
		if (projectId === undefined) {
			return exists("SELECT 1 AS found FROM identity_organisations WHERE id = ?", [organisationId]);
		}
		if (typeof projectId !== "string") return false;
		return exists(
			"SELECT 1 AS found FROM identity_projects p JOIN identity_organisations o ON o.id = p.organisation_id WHERE p.id = ? AND p.organisation_id = ?",
			[projectId, organisationId],
		);
	}

	/** Whether `principal` holds any binding in the organisation. */
	async function holdsBindingIn(organisationId: OrganisationId, principal: Principal): Promise<boolean> {
		const [kind, id] = principalColumns(principal);
		return exists(
			"SELECT 1 AS found FROM identity_role_bindings WHERE organisation_id = ? AND principal_kind = ? AND principal_id = ? LIMIT 1",
			[organisationId, kind, id],
		);
	}

	async function projectIn(organisationId: OrganisationId, projectId: ProjectId): Promise<Project> {
		if (typeof projectId !== "string") throw notFound("project");
		const [row] = await driver.query<ProjectRow>(`SELECT ${PROJECT_COLUMNS} FROM identity_projects p WHERE p.id = ?`, [
			projectId,
		]);
		if (row === undefined || String(row.organisation_id) !== organisationId) throw notFound("project");
		return projectOf(row);
	}

	async function serviceIn(organisationId: OrganisationId, serviceId: ServiceId): Promise<ServiceIdentity> {
		if (typeof serviceId !== "string") throw notFound("service identity");
		const [row] = await driver.query<ServiceRow>(
			"SELECT id, organisation_id, name, created_at FROM identity_services WHERE id = ?",
			[serviceId],
		);
		if (row === undefined || String(row.organisation_id) !== organisationId) throw notFound("service identity");
		return serviceOf(row);
	}

	/** The strongest role `actor` holds on `projectId`, or on the organisation as a whole when it is absent. */
	async function resolveRole(
		actor: Actor,
		organisationId: OrganisationId,
		projectId?: ProjectId,
	): Promise<Role | undefined> {
		if (actor.kind === "system") return "admin";
		if (actor.kind === "agent") return undefined;
		if (!(await scopeExists(organisationId, projectId))) return undefined;
		if (actor.kind === "service" && actor.keyId !== undefined) {
			const key = await keyById(actor.keyId);
			if (key === undefined || key.serviceId !== actor.serviceId || key.organisationId !== organisationId) {
				return undefined;
			}
			if (!keyIsLive(key)) return undefined;
			// An organisation key's role is an organisation-wide binding: on the organisation and each of its projects.
			if (scopeOfKey(key) === "organisation") return key.role;
			if (projectId === undefined || !key.projectIds.includes(projectId)) return undefined;
			return key.role;
		}
		const principal = principalOf(actor);
		if (principal === undefined) return undefined;
		const [kind, id] = principalColumns(principal);
		const rows = await driver.query<{ role: unknown }>(
			"SELECT role FROM identity_role_bindings WHERE organisation_id = ? AND principal_kind = ? AND principal_id = ? AND (scope = ? OR scope = ?)",
			[organisationId, kind, id, ORGANISATION_SCOPE, projectId ?? ORGANISATION_SCOPE],
		);
		return strongestRole(rows.map((row) => String(row.role) as Role).filter((role) => ROLES.includes(role)));
	}

	async function requireRole(
		actor: Actor,
		organisationId: OrganisationId,
		projectId: ProjectId | undefined,
		needed: Role,
	): Promise<void> {
		if (actor.kind === "agent") throw forbidden("identity never authorises an agent; the runtime does, by session");
		const held = await resolveRole(actor, organisationId, projectId);
		if (held === undefined || !roleSatisfies(held, needed)) {
			throw forbidden(`needs ${needed} on the ${projectId === undefined ? "organisation" : "project"}`);
		}
	}

	/** Whether `actor` holds any role in the organisation: a binding anywhere in it, or a live key into it. */
	async function isMember(actor: Actor, organisationId: OrganisationId): Promise<boolean> {
		if (actor.kind === "system") return true;
		if (actor.kind === "agent") return false;
		if (actor.kind === "service" && actor.keyId !== undefined) {
			const key = await keyById(actor.keyId);
			return (
				key !== undefined &&
				key.serviceId === actor.serviceId &&
				key.organisationId === organisationId &&
				keyIsLive(key)
			);
		}
		const principal = principalOf(actor);
		if (principal === undefined || typeof organisationId !== "string") return false;
		return holdsBindingIn(organisationId, principal);
	}

	async function requireMember(ctx: CallContext): Promise<void> {
		if (!(await isMember(ctx.actor, ctx.organisationId))) {
			throw forbidden("the actor holds no role in this organisation");
		}
	}

	/** Whether `actor` calls with a live organisation key of `organisationId` that carries `create_projects`. */
	async function keyMayCreateProjects(actor: Actor, organisationId: OrganisationId): Promise<boolean> {
		if (actor.kind !== "service" || actor.keyId === undefined) return false;
		const key = await keyById(actor.keyId);
		return (
			key !== undefined &&
			key.serviceId === actor.serviceId &&
			key.organisationId === organisationId &&
			keyIsLive(key) &&
			scopeOfKey(key) === "organisation" &&
			(key.permissions ?? []).includes("create_projects") &&
			(await scopeExists(organisationId, undefined))
		);
	}

	/**
	 * The `WHERE` condition (on `identity_projects p`) for the projects of the organisation `actor` holds a role on, or
	 * undefined when it holds none.
	 */
	async function visibleProjects(
		actor: Actor,
		organisationId: OrganisationId,
	): Promise<{ readonly where: string; readonly params: readonly SqlValue[] } | undefined> {
		if (typeof organisationId !== "string") return undefined;
		if (actor.kind === "system") return { where: "p.organisation_id = ?", params: [organisationId] };
		if (actor.kind === "agent") return undefined;
		if (actor.kind === "service" && actor.keyId !== undefined) {
			const key = await keyById(actor.keyId);
			if (
				key === undefined ||
				key.serviceId !== actor.serviceId ||
				key.organisationId !== organisationId ||
				!keyIsLive(key)
			) {
				return undefined;
			}
			if (scopeOfKey(key) === "organisation") return { where: "p.organisation_id = ?", params: [organisationId] };
			return {
				where: `p.organisation_id = ? AND ${inJsonList(driver.dialect, "p.id")}`,
				params: [organisationId, JSON.stringify(key.projectIds)],
			};
		}
		const principal = principalOf(actor);
		if (principal === undefined) return undefined;
		const [kind, id] = principalColumns(principal);
		return {
			where: `p.organisation_id = ? AND (
				EXISTS (SELECT 1 FROM identity_role_bindings b WHERE b.organisation_id = ? AND b.principal_kind = ? AND b.principal_id = ? AND b.scope = ?)
				OR p.id IN (SELECT b.scope FROM identity_role_bindings b WHERE b.organisation_id = ? AND b.principal_kind = ? AND b.principal_id = ? AND b.scope <> ?)
			)`,
			params: [
				organisationId,
				organisationId,
				kind,
				id,
				ORGANISATION_SCOPE,
				organisationId,
				kind,
				id,
				ORGANISATION_SCOPE,
			],
		};
	}

	async function emit(
		ctx: CallContext,
		type: AuditEventType,
		organisationId: OrganisationId,
		subject: { readonly kind: string; readonly id: string },
		data: { readonly [key: string]: JsonValue },
		projectId?: ProjectId,
	): Promise<void> {
		if (audit === undefined) return;
		await audit.append(AUDIT_CONTEXT, [
			{
				id: `identity:${type}:${crypto.randomUUID()}`,
				at: clock.now(),
				source: "identity",
				type,
				actor: ctx.actor,
				organisationId,
				...(projectId === undefined ? {} : { projectId }),
				subject,
				data,
			},
		]);
	}

	const principalData = (principal: Principal): { readonly [key: string]: JsonValue } =>
		principal.kind === "user"
			? { kind: "user", userId: principal.userId }
			: { kind: "service", serviceId: principal.serviceId };

	/**
	 * Links the one invited user an email matched to `externalSubject`, or, when a concurrent sign-in linked them first,
	 * finds whoever now holds the subject. Audits `identity.user.linked` once, from the sign-in that linked.
	 */
	async function linkInvited(only: StoredUser, externalSubject: string, issuer: string): Promise<StoredUser> {
		let linked: boolean;
		try {
			// Links only a user still unlinked; the UNIQUE subject refuses a second user taking this subject.
			const updated = await driver.query<{ id: unknown }>(
				"UPDATE identity_users SET external_subject = ? WHERE id = ? AND external_subject IS NULL RETURNING id",
				[externalSubject, only.user.id],
			);
			linked = updated.length > 0;
		} catch (error) {
			if (!isUniqueViolation(error) && (await userBySubject(externalSubject)) === undefined) throw error;
			linked = false;
		}
		if (!linked) {
			// A concurrent sign-in linked first. Whoever now holds this subject is this person; anyone else is not.
			const holder = await userBySubject(externalSubject);
			if (holder === undefined) throw forbidden("no user matches this sign-in");
			return holder;
		}
		const stored: StoredUser = { ...only, user: Object.freeze({ ...only.user, externalSubject }) };
		await emit(
			// The person signing in links themselves; the authenticator only carried their token.
			{ actor: { kind: "human", userId: stored.user.id }, organisationId: stored.createdInOrganisationId },
			"identity.user.linked",
			stored.createdInOrganisationId,
			{ kind: "identity.user", id: stored.user.id },
			{ issuer },
		);
		return stored;
	}

	/** The pending invites to a normalised email, oldest first. */
	async function pendingInvitesTo(email: string | undefined): Promise<Invite[]> {
		if (email === undefined || email === "") return [];
		const rows = await driver.query<InviteRow>(
			`SELECT ${INVITE_COLUMNS} FROM identity_invites WHERE email_normalised = ? AND ${INVITE_PENDING} ORDER BY seq`,
			[email, clock.now()],
		);
		return rows.map(inviteOf);
	}

	/**
	 * A user for someone new an invite let in, linked to their sign-in and created in `organisationId`. When a concurrent
	 * sign-in of theirs made it first, the UNIQUE subject refuses this one and theirs is used. Audited as
	 * `identity.user.created` with the person as actor, by the sign-in that made it.
	 */
	async function joinByInvite(
		identity: ExternalIdentity,
		externalSubject: string,
		organisationId: OrganisationId,
	): Promise<StoredUser> {
		const email = String(identity.email).trim();
		const user: User = Object.freeze({
			id: newId("usr"),
			name: inviteeName(identity.name, email),
			email,
			externalSubject,
			createdAt: clock.now(),
		});
		try {
			await driver.query(
				`INSERT INTO identity_users (${USER_COLUMNS}, email_normalised) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[user.id, user.name, email, externalSubject, organisationId, user.createdAt, normaliseEmail(email)],
			);
		} catch (error) {
			const holder = await userBySubject(externalSubject).catch(() => undefined);
			if (holder !== undefined) return holder;
			throw error;
		}
		await emit(
			{ actor: { kind: "human", userId: user.id }, organisationId },
			"identity.user.created",
			organisationId,
			{ kind: "identity.user", id: user.id },
			{},
		);
		return { user, createdInOrganisationId: organisationId };
	}

	/**
	 * Accepts a pending invite for `userId`, in one batch: the invite's organisation-wide role (unless they hold a role in
	 * that organisation already) granted by whoever invited them, the roles version moved on, and the invite marked
	 * accepted, each only while it is still pending. Of two sign-ins that race, one takes it; the row keeps that one's
	 * `acceptance`, so only it audits `identity.invite.accepted` (and `identity.role.granted` when it granted one).
	 */
	async function acceptInvite(invite: Invite, userId: UserId): Promise<void> {
		const now = clock.now();
		const acceptance = crypto.randomUUID();
		const organisationId = invite.organisationId;
		const principal: Principal = Object.freeze({ kind: "user", userId });
		const held = await holdsBindingIn(organisationId, principal);
		const stillPending = `EXISTS (SELECT 1 FROM identity_invites WHERE id = ? AND ${INVITE_PENDING})`;
		// Postgres reads an untyped parameter in a SELECT list as text; the time column needs it as a number.
		const time = driver.dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
		await driver.batch([
			sql(
				`INSERT INTO identity_role_bindings (${BINDING_COLUMNS})
				SELECT ?, 'user', ?, ?, ?, CAST(? AS ${time}), ? WHERE ${stillPending} AND NOT EXISTS (
					SELECT 1 FROM identity_role_bindings WHERE organisation_id = ? AND principal_kind = 'user' AND principal_id = ?
				)
				ON CONFLICT (organisation_id, principal_kind, principal_id, scope) DO NOTHING`,
				organisationId,
				userId,
				ORGANISATION_SCOPE,
				invite.role,
				now,
				JSON.stringify(invite.invitedBy),
				invite.id,
				now,
				organisationId,
				userId,
			),
			sql(
				`UPDATE identity_organisations SET roles_version = ? WHERE id = ? AND ${stillPending}`,
				crypto.randomUUID(),
				organisationId,
				invite.id,
				now,
			),
			sql(
				`UPDATE identity_invites SET accepted_at = ?, accepted_by = ?, acceptance = ? WHERE id = ? AND ${INVITE_PENDING}`,
				now,
				userId,
				acceptance,
				invite.id,
				now,
			),
		]);
		const [row] = await driver.query<{ acceptance: unknown }>("SELECT acceptance FROM identity_invites WHERE id = ?", [
			invite.id,
		]);
		if (row?.acceptance !== acceptance) return;
		if (!held) {
			await emit(
				{ actor: invite.invitedBy, organisationId },
				"identity.role.granted",
				organisationId,
				{ kind: "identity.organisation", id: organisationId },
				{ principal: principalData(principal), role: invite.role },
			);
		}
		await emit(
			{ actor: { kind: "human", userId }, organisationId },
			"identity.invite.accepted",
			organisationId,
			{ kind: "identity.invite", id: invite.id },
			{ role: invite.role, granted: !held },
		);
	}

	/** The organisation's admin, on an organisation that exists: who may invite, list invites and revoke them. */
	async function requireInviter(ctx: CallContext): Promise<void> {
		await requireRole(ctx.actor, ctx.organisationId, undefined, "admin");
		if (!(await scopeExists(ctx.organisationId, undefined))) throw notFound("organisation");
	}

	/** The organisation's roles version, read before a grant or revocation checks the caller's own role. */
	async function rolesVersion(organisationId: OrganisationId): Promise<string> {
		const [row] = await driver.query<{ roles_version: unknown }>(
			"SELECT roles_version FROM identity_organisations WHERE id = ?",
			[organisationId],
		);
		return row === undefined ? "" : String(row.roles_version);
	}

	/**
	 * Runs a grant's or revocation's `statements` only if no role in the organisation changed since `seen` was read,
	 * which was before the caller's own role was checked. Without it, a grant checked just before the caller's binding
	 * was revoked could land after the revocation and bring the binding back. With no interactive transactions, the
	 * check is in the batch: the version moves from `seen` to a new one, and a NULL insert into `identity_role_guard`
	 * fails the whole batch when it did not move (on Postgres the update waits for a concurrent change's row lock, then
	 * checks again).
	 */
	async function guardedRoleChange(
		organisationId: OrganisationId,
		seen: string,
		statements: readonly SqlStatement[],
	): Promise<void> {
		const next = crypto.randomUUID();
		try {
			await driver.batch([
				sql(
					"UPDATE identity_organisations SET roles_version = ? WHERE id = ? AND roles_version = ?",
					next,
					organisationId,
					seen,
				),
				sql(
					"INSERT INTO identity_role_guard (version) VALUES ((SELECT roles_version FROM identity_organisations WHERE id = ? AND roles_version = ?))",
					organisationId,
					next,
				),
				sql("DELETE FROM identity_role_guard WHERE version = ?", next),
				...statements,
			]);
		} catch (error) {
			if (isNotNullViolation(error)) {
				throw new KantelError("conflict", "Roles in this organisation changed during the call; try again");
			}
			throw error;
		}
	}

	const INSERT_BINDING = `INSERT INTO identity_role_bindings (${BINDING_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (organisation_id, principal_kind, principal_id, scope)
		DO UPDATE SET role = excluded.role, granted_at = excluded.granted_at, granted_by = excluded.granted_by`;

	const bindingValues = (binding: RoleBinding): SqlValue[] => {
		const [kind, id] = principalColumns(binding.principal);
		return [
			binding.organisationId,
			kind,
			id,
			binding.projectId ?? ORGANISATION_SCOPE,
			binding.role,
			binding.grantedAt,
			JSON.stringify(binding.grantedBy),
		];
	};

	return {
		async createOrganisation(ctx, input) {
			if (ctx.actor.kind !== "system") throw forbidden("only a system actor may create an organisation");
			const name = requireName(input.name, "an organisation");
			if (input.admin.kind === "service") {
				throw new KantelError("invalid", "a service identity belongs to one organisation and cannot found another");
			}
			if ((await userById(input.admin.userId)) === undefined) throw notFound("user");
			const now = clock.now();
			const organisation: Organisation = Object.freeze({ id: newId("org"), name, createdAt: now });
			const binding: RoleBinding = Object.freeze({
				organisationId: organisation.id,
				principal: Object.freeze({ kind: "user", userId: input.admin.userId }),
				role: "admin",
				grantedAt: now,
				grantedBy: ctx.actor,
			});
			// The organisation and its first admin commit together.
			await driver.batch([
				sql("INSERT INTO identity_organisations (id, name, created_at) VALUES (?, ?, ?)", organisation.id, name, now),
				{ sql: INSERT_BINDING, params: bindingValues(binding) },
			]);
			await emit(
				ctx,
				"identity.organisation.created",
				organisation.id,
				{ kind: "identity.organisation", id: organisation.id },
				{ name },
			);
			await emit(
				ctx,
				"identity.role.granted",
				organisation.id,
				{ kind: "identity.organisation", id: organisation.id },
				{ principal: principalData(binding.principal), role: binding.role },
			);
			return organisation;
		},

		async getOrganisation(ctx, id) {
			await requireMember(ctx);
			if (typeof id !== "string" || id !== ctx.organisationId) throw notFound("organisation");
			const [row] = await driver.query<OrganisationRow>(
				"SELECT id, name, created_at FROM identity_organisations WHERE id = ?",
				[id],
			);
			if (row === undefined) throw notFound("organisation");
			return organisationOf(row);
		},

		async createProject(ctx, input) {
			if (!(await keyMayCreateProjects(ctx.actor, ctx.organisationId))) {
				await requireRole(ctx.actor, ctx.organisationId, undefined, "admin");
			}
			const name = requireName(input.name, "a project");
			const project: Project = Object.freeze({
				id: newId("prj"),
				organisationId: ctx.organisationId,
				name,
				createdAt: clock.now(),
			});
			const insert = {
				sql: "INSERT INTO identity_projects (id, organisation_id, name, created_at) VALUES (?, ?, ?, ?)",
				params: [project.id, project.organisationId, name, project.createdAt],
			};
			// On Postgres the lock makes projects commit in `seq` order, so a reader paging by cursor never skips one that
			// commits late. SQLite and D1 run one write at a time anyway.
			await driver.batch(driver.dialect === "postgres" ? [{ sql: PROJECT_ORDER_LOCK }, insert] : [insert]);
			await emit(
				ctx,
				"identity.project.created",
				project.organisationId,
				{ kind: "identity.project", id: project.id },
				{ name },
				project.id,
			);
			return project;
		},

		async getProject(ctx, id) {
			await requireMember(ctx);
			const project = await projectIn(ctx.organisationId, id);
			if ((await resolveRole(ctx.actor, ctx.organisationId, id)) === undefined) throw notFound("project");
			return project;
		},

		async listProjects(ctx, page?: PageRequest): Promise<Page<Project>> {
			const limit = page?.limit ?? DEFAULT_PAGE_LIMIT;
			if (!Number.isInteger(limit) || limit < 1) throw new KantelError("invalid", "limit must be a positive integer");
			const capped = Math.min(limit, MAX_PAGE_LIMIT);
			const visible = await visibleProjects(ctx.actor, ctx.organisationId);
			if (visible === undefined) {
				if (page?.cursor !== undefined) throw new KantelError("invalid", "unknown cursor");
				return { items: [] };
			}
			const where = [visible.where];
			const params: SqlValue[] = [...visible.params];
			if (page?.cursor !== undefined) {
				// The cursor is the last project of the previous page, which must still be one the actor sees.
				const [row] = await driver.query<{ seq: unknown }>(
					`SELECT p.seq FROM identity_projects p WHERE ${visible.where} AND p.id = ?`,
					[...visible.params, String(page.cursor)],
				);
				if (row === undefined) throw new KantelError("invalid", "unknown cursor");
				where.push("p.seq > ?");
				params.push(sqlNumber(row.seq));
			}
			const rows = await driver.query<ProjectRow>(
				`SELECT ${PROJECT_COLUMNS} FROM identity_projects p WHERE ${where.join(" AND ")} ORDER BY p.seq LIMIT ?`,
				[...params, capped + 1],
			);
			const items = rows.slice(0, capped).map(projectOf);
			const last = items.at(-1);
			return rows.length > capped && last !== undefined ? { items, nextCursor: last.id } : { items };
		},

		async createUser(ctx, input) {
			if (ctx.actor.kind !== "system") await requireRole(ctx.actor, ctx.organisationId, undefined, "admin");
			const name = requireName(input.name, "a user");
			if (input.email !== undefined && typeof input.email !== "string") {
				throw new KantelError("invalid", "an email must be a string");
			}
			const externalSubject = input.externalSubject;
			if (externalSubject !== undefined) {
				if (typeof externalSubject !== "string" || externalSubject === "") {
					throw new KantelError("invalid", "an external subject must be a non-empty string");
				}
				if ((await userBySubject(externalSubject)) !== undefined) throw subjectConflict();
			}
			const user: User = Object.freeze({
				id: newId("usr"),
				name,
				...(input.email === undefined ? {} : { email: input.email }),
				...(externalSubject === undefined ? {} : { externalSubject }),
				createdAt: clock.now(),
			});
			try {
				await driver.query(
					`INSERT INTO identity_users (${USER_COLUMNS}, email_normalised) VALUES (?, ?, ?, ?, ?, ?, ?)`,
					[
						user.id,
						name,
						user.email ?? null,
						externalSubject ?? null,
						ctx.organisationId,
						user.createdAt,
						user.email === undefined ? null : normaliseEmail(user.email),
					],
				);
			} catch (error) {
				// Another user took the subject between the check and the insert: the constraint settles the race.
				if (
					externalSubject !== undefined &&
					(isUniqueViolation(error) ||
						(await userBySubject(externalSubject).then(
							(holder) => holder !== undefined,
							() => false,
						)))
				) {
					throw subjectConflict();
				}
				throw error;
			}
			await emit(ctx, "identity.user.created", ctx.organisationId, { kind: "identity.user", id: user.id }, {});
			return user;
		},

		async getUser(ctx, id) {
			await requireMember(ctx);
			const stored = await userById(id);
			if (stored === undefined) throw notFound("user");
			const visible =
				stored.createdInOrganisationId === ctx.organisationId ||
				(await holdsBindingIn(ctx.organisationId, { kind: "user", userId: stored.user.id }));
			if (!visible) throw notFound("user");
			return stored.user;
		},

		async createServiceIdentity(ctx, input) {
			await requireRole(ctx.actor, ctx.organisationId, undefined, "admin");
			const name = requireName(input.name, "a service identity");
			const service: ServiceIdentity = Object.freeze({
				id: newId("svc"),
				organisationId: ctx.organisationId,
				name,
				createdAt: clock.now(),
			});
			await driver.query("INSERT INTO identity_services (id, organisation_id, name, created_at) VALUES (?, ?, ?, ?)", [
				service.id,
				service.organisationId,
				name,
				service.createdAt,
			]);
			await emit(
				ctx,
				"identity.service.created",
				ctx.organisationId,
				{ kind: "identity.service", id: service.id },
				{ name },
			);
			return service;
		},

		async grantRole(ctx, input) {
			const role = requireRoleValue(input.role);
			if (input.projectId !== undefined) await projectIn(ctx.organisationId, input.projectId);
			const seen = await rolesVersion(ctx.organisationId);
			await requireRole(ctx.actor, ctx.organisationId, input.projectId, "admin");
			let principal: Principal;
			if (input.principal.kind === "user") {
				if ((await userById(input.principal.userId)) === undefined) throw notFound("user");
				principal = Object.freeze({ kind: "user", userId: input.principal.userId });
			} else {
				await serviceIn(ctx.organisationId, input.principal.serviceId);
				principal = Object.freeze({ kind: "service", serviceId: input.principal.serviceId });
			}
			const binding: RoleBinding = Object.freeze({
				organisationId: ctx.organisationId,
				...(input.projectId === undefined ? {} : { projectId: input.projectId }),
				principal,
				role,
				grantedAt: clock.now(),
				grantedBy: ctx.actor,
			});
			// One statement: a binding for the same principal and scope is replaced, never duplicated.
			await guardedRoleChange(ctx.organisationId, seen, [{ sql: INSERT_BINDING, params: bindingValues(binding) }]);
			await emit(
				ctx,
				"identity.role.granted",
				ctx.organisationId,
				input.projectId === undefined
					? { kind: "identity.organisation", id: ctx.organisationId }
					: { kind: "identity.project", id: input.projectId },
				{ principal: principalData(binding.principal), role },
				input.projectId,
			);
			return binding;
		},

		async revokeRole(ctx, input) {
			if (input.projectId !== undefined) await projectIn(ctx.organisationId, input.projectId);
			const seen = await rolesVersion(ctx.organisationId);
			await requireRole(ctx.actor, ctx.organisationId, input.projectId, "admin");
			const [kind, id] = principalColumns(input.principal);
			if (typeof id !== "string") throw notFound("role binding");
			const key: SqlValue[] = [ctx.organisationId, kind, id, input.projectId ?? ORGANISATION_SCOPE];
			const [removed] = await driver.query<BindingRow>(
				`SELECT ${BINDING_COLUMNS} FROM identity_role_bindings WHERE organisation_id = ? AND principal_kind = ? AND principal_id = ? AND scope = ?`,
				key,
			);
			if (removed === undefined) throw notFound("role binding");
			// The guard fails the delete if any role changed since `seen`, so the binding read above is the one removed.
			await guardedRoleChange(ctx.organisationId, seen, [
				{
					sql: "DELETE FROM identity_role_bindings WHERE organisation_id = ? AND principal_kind = ? AND principal_id = ? AND scope = ?",
					params: key,
				},
			]);
			const binding = bindingOf(removed);
			await emit(
				ctx,
				"identity.role.revoked",
				ctx.organisationId,
				input.projectId === undefined
					? { kind: "identity.organisation", id: ctx.organisationId }
					: { kind: "identity.project", id: input.projectId },
				{ principal: principalData(binding.principal), role: binding.role },
				input.projectId,
			);
		},

		async listRoleBindings(ctx, input) {
			const projectId = input?.projectId;
			if (projectId !== undefined) await projectIn(ctx.organisationId, projectId);
			await requireRole(ctx.actor, ctx.organisationId, projectId, "viewer");
			const rows =
				projectId === undefined
					? await driver.query<BindingRow>(
							`SELECT ${BINDING_COLUMNS} FROM identity_role_bindings WHERE organisation_id = ? ORDER BY seq`,
							[ctx.organisationId],
						)
					: await driver.query<BindingRow>(
							`SELECT ${BINDING_COLUMNS} FROM identity_role_bindings WHERE organisation_id = ? AND scope = ? ORDER BY seq`,
							[ctx.organisationId, projectId],
						);
			return rows.map(bindingOf);
		},

		async issueApiKey(ctx, input): Promise<IssuedApiKey> {
			const scope = apiKeyScope(input.scope);
			const projectIds = [...new Set(input.projectIds ?? [])];
			const role = requireRoleValue(input.role);
			const permissions = apiKeyPermissions(input.permissions);
			checkApiKeyScope(scope, { projectIds, role, permissions });
			if (scope === "organisation") {
				// A key never mints a key that reaches past its own projects; only a person (or Kantel) issues one.
				if (callsWithKey(ctx.actor)) throw forbidden("an API key cannot issue an organisation key");
				await requireRole(ctx.actor, ctx.organisationId, undefined, "admin");
			} else {
				if (projectIds.some((projectId) => typeof projectId !== "string")) throw notFound("project");
				const found = await driver.query<{ id: unknown }>(
					`SELECT p.id FROM identity_projects p WHERE p.organisation_id = ? AND ${inJsonList(driver.dialect, "p.id")}`,
					[ctx.organisationId, JSON.stringify(projectIds)],
				);
				if (found.length !== projectIds.length) throw notFound("project");
				for (const projectId of projectIds) await requireRole(ctx.actor, ctx.organisationId, projectId, "admin");
			}
			await serviceIn(ctx.organisationId, input.serviceId);
			const name = apiKeyName(input.name);
			// A permission reaches beyond the key's projects, so only an organisation admin may hand one out.
			if (permissions !== undefined) await requireRole(ctx.actor, ctx.organisationId, undefined, "admin");
			const now = clock.now();
			if (input.expiresAt !== undefined && input.expiresAt <= now) {
				throw new KantelError("invalid", "a key cannot expire before it is issued");
			}
			const secret = generateApiKeySecret();
			const key: ApiKey = Object.freeze({
				id: newId("key"),
				serviceId: input.serviceId,
				organisationId: ctx.organisationId,
				...(scope === "organisation" ? { scope } : {}),
				projectIds: Object.freeze(projectIds),
				role,
				...(permissions === undefined ? {} : { permissions }),
				prefix: apiKeyPrefix(secret),
				...(name === undefined ? {} : { name }),
				createdAt: now,
				...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
			});
			const insertKey = {
				sql: "INSERT INTO identity_api_keys (id, secret_hash, service_id, organisation_id, project_ids, role, prefix, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
				params: [
					key.id,
					await hashApiKeySecret(secret),
					key.serviceId,
					key.organisationId,
					JSON.stringify(key.projectIds),
					role,
					key.prefix,
					now,
					key.expiresAt ?? null,
				],
			};
			// The key, its name, its permissions and its scope land together or not at all.
			await driver.batch([
				insertKey,
				...(name === undefined
					? []
					: [
							{
								sql: "INSERT INTO identity_api_key_details (key_id, name, last_used_at) VALUES (?, ?, NULL)",
								params: [key.id, name],
							},
						]),
				...(permissions === undefined
					? []
					: [
							{
								sql: "INSERT INTO identity_api_key_permissions (key_id, permissions) VALUES (?, ?)",
								params: [key.id, JSON.stringify(permissions)],
							},
						]),
				...(scope === "organisation"
					? [sql("INSERT INTO identity_api_key_scopes (key_id, scope) VALUES (?, ?)", key.id, scope)]
					: []),
			]);
			await emit(
				ctx,
				"identity.key.issued",
				ctx.organisationId,
				{ kind: "identity.api_key", id: key.id },
				{
					serviceId: key.serviceId,
					scope,
					projectIds: [...key.projectIds],
					role,
					...(permissions === undefined ? {} : { permissions: [...permissions] }),
					...(name === undefined ? {} : { name }),
					...(key.expiresAt === undefined ? {} : { expiresAt: key.expiresAt }),
				},
			);
			return { key, secret };
		},

		async revokeApiKey(ctx, keyId) {
			const key = await keyById(keyId);
			if (key === undefined || key.organisationId !== ctx.organisationId) throw notFound("API key");
			if (scopeOfKey(key) === "organisation") await requireRole(ctx.actor, ctx.organisationId, undefined, "admin");
			for (const projectId of key.projectIds) await requireRole(ctx.actor, ctx.organisationId, projectId, "admin");
			if (key.revokedAt !== undefined) return;
			// Only the call that sets `revoked_at` audits; a concurrent second revocation is the same no-op as a late one.
			const revoked = await driver.query<{ id: unknown }>(
				"UPDATE identity_api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL RETURNING id",
				[clock.now(), key.id],
			);
			if (revoked.length === 0) return;
			await emit(
				ctx,
				"identity.key.revoked",
				ctx.organisationId,
				{ kind: "identity.api_key", id: key.id },
				{ serviceId: key.serviceId, scope: scopeOfKey(key), projectIds: [...key.projectIds], role: key.role },
			);
		},

		async listApiKeys(ctx, input) {
			await requireMember(ctx);
			const serviceId = input?.serviceId;
			const rows =
				serviceId === undefined
					? await driver.query<ApiKeyRow>(`${SELECT_KEYS} WHERE k.organisation_id = ? ORDER BY k.seq`, [
							ctx.organisationId,
						])
					: await driver.query<ApiKeyRow>(
							`${SELECT_KEYS} WHERE k.organisation_id = ? AND k.service_id = ? ORDER BY k.seq`,
							[ctx.organisationId, String(serviceId)],
						);
			/** By project ID, and `*` for the organisation. */
			const administers = new Map<string, Promise<boolean>>();
			const isAdminOn = (projectId: ProjectId | undefined): Promise<boolean> => {
				const cacheKey = projectId ?? ORGANISATION_SCOPE;
				let answer = administers.get(cacheKey);
				if (answer === undefined) {
					answer = resolveRole(ctx.actor, ctx.organisationId, projectId).then(
						(held) => held !== undefined && roleSatisfies(held, "admin"),
					);
					administers.set(cacheKey, answer);
				}
				return answer;
			};
			const listed: ApiKey[] = [];
			for (const row of rows) {
				const key = apiKeyOf(row);
				// An organisation key is shown to an organisation-wide admin only.
				if (scopeOfKey(key) === "organisation") {
					if (await isAdminOn(undefined)) listed.push(key);
					continue;
				}
				let every = true;
				for (const projectId of key.projectIds) {
					if (!(await isAdminOn(projectId))) {
						every = false;
						break;
					}
				}
				if (every) listed.push(key);
			}
			return listed;
		},

		async createInvite(ctx, input) {
			await requireInviter(ctx);
			const email = inviteEmail(input?.email);
			const role = inviteRole(input?.role);
			const normalised = normaliseEmail(email);
			const organisationId = ctx.organisationId;
			const now = clock.now();
			// Two admins inviting one email at once may both get in; signing in then accepts both and grants one role.
			if (
				await exists(
					`SELECT 1 AS found FROM identity_invites WHERE organisation_id = ? AND email_normalised = ? AND ${INVITE_PENDING} LIMIT 1`,
					[organisationId, normalised, now],
				)
			) {
				throw new KantelError("conflict", "this email has a pending invite already");
			}
			if (
				await exists(
					`SELECT 1 AS found FROM identity_users u JOIN identity_role_bindings b
					ON b.principal_kind = 'user' AND b.principal_id = u.id AND b.organisation_id = ?
					WHERE u.email_normalised = ? LIMIT 1`,
					[organisationId, normalised],
				)
			) {
				throw new KantelError("conflict", "this email belongs to a member already");
			}
			const invite: Invite = Object.freeze({
				id: newId("inv"),
				organisationId,
				email,
				role,
				invitedBy: ctx.actor,
				createdAt: now,
				expiresAt: now + INVITE_TTL_MILLISECONDS,
			});
			await driver.query(
				`INSERT INTO identity_invites (${INVITE_COLUMNS}, email_normalised) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					invite.id,
					organisationId,
					email,
					role,
					JSON.stringify(ctx.actor),
					invite.createdAt,
					invite.expiresAt,
					normalised,
				],
			);
			await emit(ctx, "identity.invite.created", organisationId, { kind: "identity.invite", id: invite.id }, { role });
			return invite;
		},

		async listInvites(ctx) {
			await requireInviter(ctx);
			const rows = await driver.query<InviteRow>(
				`SELECT ${INVITE_COLUMNS} FROM identity_invites WHERE organisation_id = ? AND ${INVITE_PENDING} ORDER BY seq LIMIT ?`,
				[ctx.organisationId, clock.now(), MAX_PAGE_LIMIT],
			);
			return rows.map(inviteOf);
		},

		async revokeInvite(ctx, inviteId) {
			await requireInviter(ctx);
			if (typeof inviteId !== "string") throw notFound("invite");
			// Only a pending invite of this organisation, and only once: a revocation racing an acceptance loses or wins whole.
			const [revoked] = await driver.query<{ role: unknown }>(
				`UPDATE identity_invites SET revoked_at = ? WHERE id = ? AND organisation_id = ? AND ${INVITE_PENDING} RETURNING role`,
				[clock.now(), inviteId, ctx.organisationId, clock.now()],
			);
			if (revoked === undefined) throw notFound("invite");
			await emit(
				ctx,
				"identity.invite.revoked",
				ctx.organisationId,
				{ kind: "identity.invite", id: inviteId },
				{ role: String(revoked.role) },
			);
		},

		async userPreferences(ctx) {
			const userId = preferencesOwner(ctx.actor);
			await requireMember(ctx);
			return preferencesOf(userId);
		},

		async setUserPreferences(ctx, change) {
			const userId = preferencesOwner(ctx.actor);
			await requireMember(ctx);
			const next = changedPreferences(await preferencesOf(userId), change);
			await driver.query(
				`INSERT INTO identity_user_preferences (user_id, preferences, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT (user_id) DO UPDATE SET preferences = excluded.preferences, updated_at = excluded.updated_at`,
				[userId, JSON.stringify(next), clock.now()],
			);
			return next;
		},

		async projectSettings(ctx, projectId) {
			await visibleProject(ctx, projectId);
			return projectSettingsOf(projectId);
		},

		async setProjectSettings(ctx, projectId, change) {
			await visibleProject(ctx, projectId);
			await requireRole(ctx.actor, ctx.organisationId, projectId, "admin");
			const next = changedProjectSettings(await projectSettingsOf(projectId), change);
			await driver.query(
				`INSERT INTO identity_project_settings (project_id, settings, updated_at) VALUES (?, ?, ?)
				 ON CONFLICT (project_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`,
				[projectId, JSON.stringify(next), clock.now()],
			);
			return next;
		},

		async authenticateApiKey(ctx, secret): Promise<Authentication> {
			await requireSystem(ctx, "identity.authenticateApiKey", workerOptions);
			let key: ApiKey | undefined;
			if (typeof secret === "string") {
				const [row] = await driver.query<ApiKeyRow>(`${SELECT_KEYS} WHERE k.secret_hash = ?`, [
					await hashApiKeySecret(secret),
				]);
				key = row === undefined ? undefined : apiKeyOf(row);
			}
			if (key === undefined || !keyIsLive(key)) throw forbidden("the API key is not valid");
			await recordUse(key);
			return {
				actor: { kind: "service", serviceId: key.serviceId, keyId: key.id },
				organisationId: key.organisationId,
				projectIds: key.projectIds,
				role: key.role,
				...(key.scope === undefined ? {} : { scope: key.scope }),
			};
		},

		async signIn(ctx, identity): Promise<SignIn> {
			await requireSystem(ctx, "identity.signIn", workerOptions);
			if (
				typeof identity?.issuer !== "string" ||
				identity.issuer === "" ||
				typeof identity.subject !== "string" ||
				identity.subject === ""
			) {
				throw new KantelError("invalid", "a sign-in needs an issuer and a subject");
			}
			const externalSubject = externalSubjectOf(identity.issuer, identity.subject);
			const email =
				identity.emailVerified === true && typeof identity.email === "string"
					? normaliseEmail(identity.email)
					: undefined;
			// Every pending invite to the verified email is accepted below, so it is one indexed read on each sign-in. It and
			// the user's read go out together: every API call signs in, and on D1 each read is a round trip (TASK-4486).
			// `external_subject` is UNIQUE, so at most one user matches.
			const [pending, found] = await Promise.all([pendingInvitesTo(email), userBySubject(externalSubject)]);
			let stored = found;
			// Someone who signs in with this email another of Kantel's ways (an email code, GitHub, Google) is this person.
			const signsInWithKantel =
				stored === undefined && email !== undefined && email !== "" && isKantelSignInIssuer(identity.issuer)
					? await kantelSignInByEmail(email)
					: undefined;
			if (signsInWithKantel !== undefined)
				stored = await linkAnother(signsInWithKantel, externalSubject, identity.issuer);
			if (stored === undefined) {
				const invited =
					email === undefined || email === ""
						? []
						: await driver.query<UserRow>(
								`SELECT ${USER_COLUMNS} FROM identity_users WHERE external_subject IS NULL AND email_normalised = ? LIMIT 2`,
								[email],
							);
				const only = invited.length === 1 && invited[0] !== undefined ? storedUserOf(invited[0]) : undefined;
				// A concurrent first sign-in may have linked the invited user since the subject lookup, taking them out of
				// the unlinked candidates; whoever now holds this subject is this person. Ambiguity is still refused.
				if (only === undefined) {
					stored = await userBySubject(externalSubject);
					const first = pending[0];
					if (stored === undefined && first !== undefined) {
						// Someone new, invited: a user of their own, in the first inviting organisation.
						stored = await joinByInvite(identity, externalSubject, first.organisationId);
					}
					if (stored === undefined) throw forbidden("no user matches this sign-in");
				} else {
					stored = await linkInvited(only, externalSubject, identity.issuer);
				}
			}
			const userId = stored.user.id;
			for (const invite of pending) await acceptInvite(invite, userId);
			const organisationIds = new Set<OrganisationId>();
			// Both reads at once, as above; the organisation of creation still comes first in the answer.
			const [created, bound] = await Promise.all([
				exists("SELECT 1 AS found FROM identity_organisations WHERE id = ?", [stored.createdInOrganisationId]),
				driver.query<{ organisation_id: unknown }>(
					"SELECT organisation_id FROM identity_role_bindings WHERE principal_kind = ? AND principal_id = ? ORDER BY seq",
					["user", userId],
				),
			]);
			if (created) organisationIds.add(stored.createdInOrganisationId);
			for (const row of bound) organisationIds.add(String(row.organisation_id));
			return { user: stored.user, organisationIds: [...organisationIds] };
		},

		async canSignIn(ctx, identity) {
			await requireSystem(ctx, "identity.canSignIn", workerOptions);
			const wellFormed =
				typeof identity?.issuer === "string" &&
				identity.issuer !== "" &&
				typeof identity.subject === "string" &&
				identity.subject !== "";
			const externalSubject = wellFormed ? externalSubjectOf(identity.issuer, identity.subject) : "";
			const email =
				wellFormed && identity.emailVerified === true && typeof identity.email === "string"
					? normaliseEmail(identity.email)
					: "";
			// The same statement whoever the identity names: both index lookups run every time, and the subject's match
			// wins over any number of unlinked users with the email, as it does in `signIn`.
			// Only one of Kantel's own sign-ins is matched by another's email.
			const kantelEmail = isKantelSignInIssuer(identity?.issuer) ? email : "";
			const [row] = await driver.query<{
				by_subject: unknown;
				by_link: unknown;
				by_kantel: unknown;
				invited: unknown;
				invites: unknown;
			}>(
				`SELECT
					(SELECT COUNT(*) FROM identity_users WHERE external_subject = ?) AS by_subject,
					(SELECT COUNT(*) FROM identity_user_subjects WHERE external_subject = ?) AS by_link,
					(SELECT COUNT(*) FROM (
						SELECT 1 AS one FROM identity_users
						WHERE email_normalised = ? AND email_normalised <> '' AND ${KANTEL_SUBJECT}
						LIMIT 2
					) AS kantel) AS by_kantel,
					(SELECT COUNT(*) FROM (
						SELECT 1 AS one FROM identity_users
						WHERE external_subject IS NULL AND email_normalised = ? AND email_normalised <> ''
						LIMIT 2
					) AS candidates) AS invited,
					(SELECT COUNT(*) FROM (
						SELECT 1 AS one FROM identity_invites
						WHERE email_normalised = ? AND email_normalised <> '' AND ${INVITE_PENDING}
						LIMIT 1
					) AS pending) AS invites`,
				[externalSubject, externalSubject, kantelEmail, ...KANTEL_SUBJECT_PARAMS, email, email, clock.now()],
			);
			if (!wellFormed || row === undefined) return false;
			const bySubject = sqlNumber(row.by_subject) + sqlNumber(row.by_link);
			if (bySubject > 0) return bySubject === 1;
			if (email === "") return false;
			if (sqlNumber(row.by_kantel) === 1) return true;
			return sqlNumber(row.invited) === 1 || sqlNumber(row.invites) > 0;
		},

		async roleOf(ctx, actor, organisationId, projectId) {
			await requireSystem(ctx, "identity.roleOf", { ...workerOptions, organisationId });
			return resolveRole(actor, organisationId, projectId);
		},

		async keyPermits(ctx, actor, organisationId, permission) {
			await requireSystem(ctx, "identity.keyPermits", { ...workerOptions, organisationId });
			if (actor?.kind !== "service" || actor.keyId === undefined) return false;
			const key = await keyById(actor.keyId);
			return (
				key !== undefined &&
				key.serviceId === actor.serviceId &&
				key.organisationId === organisationId &&
				keyIsLive(key) &&
				(key.permissions ?? []).includes(permission)
			);
		},

		async authorize(ctx, needed) {
			await requireRole(ctx.actor, ctx.organisationId, ctx.projectId, needed);
		},
	};
}

/**
 * The durable sharing store, on any `SqlDriver` (Postgres self-hosted, D1 or a Durable Object's SQLite on Cloudflare,
 * `node:sqlite` in tests). It runs the same rules as the in-memory store (`./rules.ts`) and passes the same suite.
 *
 * - Bindings and group memberships are relation tuples in one table, `sharing_tuples`: `(object, relation, subject)`,
 *   with the subject also filed under its key so "which groups is this user in" is one indexed read.
 * - A decision settles its request and inserts the share it grants in one batch: the request moves from `pending` with
 *   a writer token, and the share is inserted only where that token landed, so two racing deciders make one share.
 * - Shares, requests and uses are only ever inserted or settled, never deleted.
 */
import {
	type AccessRequest,
	type Actor,
	type BindingSubject,
	bindingSubjectKey,
	granteeKey,
	HarbourError,
	type OwnerRef,
	type RegisteredResource,
	type ResourceBinding,
	type ResourceShare,
	type ShareGrantee,
	type SharePermission,
} from "@harbour/contracts";
import {
	type SqlDialect,
	type SqlDriver,
	type SqlRow,
	type SqlValue,
	sql,
	sqlNumber,
	sqlOptionalString,
} from "@harbour/sql";
import type { BindingFilter, RequestFilter, ShareFilter, SharingRepository } from "./repository.ts";
import { createSharingStore, type SharingOptions, type SharingStore } from "./rules.ts";

/** The tables and indexes, for `migrateSharing` or a target's own migrations. Every statement is idempotent. */
export function sharingSchema(dialect: SqlDialect): readonly string[] {
	const time = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS sharing_resources (
			organisation_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			owner_kind TEXT NOT NULL,
			owner_project_id TEXT,
			owner_user_id TEXT,
			name TEXT,
			registered_by TEXT NOT NULL,
			registered_at ${time} NOT NULL,
			PRIMARY KEY (organisation_id, kind, resource_id)
		)`,
		`CREATE TABLE IF NOT EXISTS sharing_shares (
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
			agent_writes INTEGER NOT NULL DEFAULT 0,
			granted_by TEXT NOT NULL,
			granted_at ${time} NOT NULL,
			request_id TEXT,
			expires_at ${time},
			parent_share_id TEXT,
			note TEXT,
			revoked_at ${time},
			revoked_by TEXT,
			revoke_reason TEXT,
			PRIMARY KEY (organisation_id, id)
		)`,
		"CREATE INDEX IF NOT EXISTS sharing_shares_by_resource ON sharing_shares (organisation_id, kind, resource_id)",
		"CREATE INDEX IF NOT EXISTS sharing_shares_by_grantee ON sharing_shares (organisation_id, grantee_key, kind)",
		"CREATE INDEX IF NOT EXISTS sharing_shares_by_owner ON sharing_shares (organisation_id, owner_project_id)",
		"CREATE INDEX IF NOT EXISTS sharing_shares_by_parent ON sharing_shares (organisation_id, parent_share_id)",
		`CREATE TABLE IF NOT EXISTS sharing_requests (
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
			reason TEXT NOT NULL,
			requested_by TEXT NOT NULL,
			session_id TEXT,
			agent_id TEXT,
			status TEXT NOT NULL,
			created_at ${time} NOT NULL,
			expires_at ${time},
			decided_by TEXT,
			decided_at ${time},
			decision_note TEXT,
			share_id TEXT,
			writer TEXT,
			PRIMARY KEY (organisation_id, id)
		)`,
		"CREATE INDEX IF NOT EXISTS sharing_requests_by_resource ON sharing_requests (organisation_id, kind, resource_id, status)",
		"CREATE INDEX IF NOT EXISTS sharing_requests_by_grantee ON sharing_requests (organisation_id, grantee_key, status)",
		"CREATE INDEX IF NOT EXISTS sharing_requests_by_owner ON sharing_requests (organisation_id, owner_project_id, status)",
		"CREATE INDEX IF NOT EXISTS sharing_requests_by_status ON sharing_requests (organisation_id, status, created_at)",
		`CREATE TABLE IF NOT EXISTS sharing_tuples (
			organisation_id TEXT NOT NULL,
			object_kind TEXT NOT NULL,
			object_id TEXT NOT NULL,
			relation TEXT NOT NULL,
			subject_key TEXT NOT NULL,
			granted_by TEXT NOT NULL,
			granted_at ${time} NOT NULL,
			PRIMARY KEY (organisation_id, object_kind, object_id, relation, subject_key)
		)`,
		"CREATE INDEX IF NOT EXISTS sharing_tuples_by_subject ON sharing_tuples (organisation_id, subject_key, relation)",
		`CREATE TABLE IF NOT EXISTS sharing_policies (
			organisation_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			two_person_rule INTEGER NOT NULL,
			updated_by TEXT NOT NULL,
			updated_at ${time} NOT NULL,
			PRIMARY KEY (organisation_id, kind, resource_id)
		)`,
		`CREATE TABLE IF NOT EXISTS sharing_uses (
			organisation_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			revision INTEGER,
			share_id TEXT NOT NULL,
			used_at ${time} NOT NULL,
			PRIMARY KEY (organisation_id, session_id, kind, resource_id)
		)`,
	];
}

/**
 * Columns added after the tables first shipped, for a database `sharingSchema` made before them. `CREATE TABLE IF NOT
 * EXISTS` leaves an existing table as it is, so each is added where it's missing.
 */
const ADDED_COLUMNS: readonly { readonly table: string; readonly column: string; readonly definition: string }[] = [
	// Whether agents may write through the share (`ResourceShare.agentWrites`); off for every share before it.
	{ table: "sharing_shares", column: "agent_writes", definition: "INTEGER NOT NULL DEFAULT 0" },
];

/** Creates the sharing tables if they are missing, and adds any column a table made before it lacks. */
export async function migrateSharing(driver: SqlDriver): Promise<void> {
	await driver.batch(sharingSchema(driver.dialect).map((text) => ({ sql: text })));
	for (const { table, column, definition } of ADDED_COLUMNS) {
		if (driver.dialect === "postgres") {
			await driver.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
			continue;
		}
		// SQLite (D1, a Durable Object, node:sqlite) has no `IF NOT EXISTS` here: add the column only where reading it
		// fails, and where adding it fails, check it isn't there because another writer added it first.
		const present = () =>
			driver.query(`SELECT ${column} FROM ${table} LIMIT 0`).then(
				() => true,
				() => false,
			);
		if (await present()) continue;
		try {
			await driver.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
		} catch (error) {
			if (!(await present())) throw error;
		}
	}
}

export interface SqlSharingOptions extends SharingOptions {
	readonly driver: SqlDriver;
}

const SHARE_COLUMNS =
	"organisation_id, id, kind, resource_id, revision, owner_kind, owner_organisation_id, owner_project_id, owner_user_id, grantee_key, permission, agent_writes, granted_by, granted_at, request_id, expires_at, parent_share_id, note, revoked_at, revoked_by, revoke_reason";
const REQUEST_COLUMNS =
	"organisation_id, id, kind, resource_id, revision, owner_kind, owner_organisation_id, owner_project_id, owner_user_id, grantee_key, permission, reason, requested_by, session_id, agent_id, status, created_at, expires_at, decided_by, decided_at, decision_note, share_id";

/** At most this many values in one `IN (…)`, well under D1's 100 parameters. */
const IN_CHUNK = 50;

function ownerColumns(owner: OwnerRef): readonly SqlValue[] {
	switch (owner.kind) {
		case "platform":
			return ["platform", null, null, null];
		case "organisation":
			return ["organisation", owner.organisationId, null, null];
		case "project":
			return ["project", owner.organisationId, owner.projectId, null];
		case "user":
			return ["user", owner.organisationId, null, owner.userId];
	}
}

function ownerFrom(row: SqlRow): OwnerRef {
	const kind = String(row.owner_kind);
	const organisationId = String(row.owner_organisation_id ?? row.organisation_id);
	switch (kind) {
		case "platform":
			return { kind: "platform" };
		case "organisation":
			return { kind: "organisation", organisationId };
		case "project":
			return { kind: "project", organisationId, projectId: String(row.owner_project_id) };
		case "user":
			return { kind: "user", organisationId, userId: String(row.owner_user_id) };
		default:
			throw new HarbourError("unavailable", `Unknown owner kind ${kind}`);
	}
}

function granteeFrom(key: string): ShareGrantee {
	const colon = key.indexOf(":");
	const kind = key.slice(0, colon);
	const id = key.slice(colon + 1);
	switch (kind) {
		case "project":
			return { kind: "project", projectId: id };
		case "agent":
			return { kind: "agent", agentId: id };
		case "user":
			return { kind: "user", userId: id };
		case "session":
			return { kind: "session", sessionId: id };
		default:
			throw new HarbourError("unavailable", `Unknown grantee ${key}`);
	}
}

function subjectFrom(key: string): BindingSubject {
	const colon = key.indexOf(":");
	const kind = key.slice(0, colon);
	const id = key.slice(colon + 1);
	switch (kind) {
		case "user":
			return { kind: "user", userId: id };
		case "service":
			return { kind: "service", serviceId: id };
		case "group":
			return { kind: "group", groupId: id };
		default:
			throw new HarbourError("unavailable", `Unknown subject ${key}`);
	}
}

const actorText = (actor: Actor): string => JSON.stringify(actor);
const actorFrom = (value: unknown): Actor => JSON.parse(String(value)) as Actor;
const optionalNumber = (value: unknown): number | undefined =>
	value === null || value === undefined ? undefined : sqlNumber(value);

function shareFrom(row: SqlRow): ResourceShare {
	const revision = optionalNumber(row.revision);
	const requestId = sqlOptionalString(row.request_id);
	const expiresAt = optionalNumber(row.expires_at);
	const parentShareId = sqlOptionalString(row.parent_share_id);
	const note = sqlOptionalString(row.note);
	const revokedAt = optionalNumber(row.revoked_at);
	const revokedBy = sqlOptionalString(row.revoked_by);
	const revokeReason = sqlOptionalString(row.revoke_reason);
	return {
		id: String(row.id),
		organisationId: String(row.organisation_id),
		resource: { kind: String(row.kind), id: String(row.resource_id), ...(revision === undefined ? {} : { revision }) },
		owner: ownerFrom(row),
		grantee: granteeFrom(String(row.grantee_key)),
		permission: String(row.permission) as SharePermission,
		agentWrites: sqlNumber(row.agent_writes ?? 0) === 1,
		grantedBy: actorFrom(row.granted_by),
		grantedAt: sqlNumber(row.granted_at),
		...(requestId === undefined ? {} : { requestId }),
		...(expiresAt === undefined ? {} : { expiresAt }),
		...(parentShareId === undefined ? {} : { parentShareId }),
		...(note === undefined ? {} : { note }),
		...(revokedAt === undefined ? {} : { revokedAt }),
		...(revokedBy === undefined ? {} : { revokedBy: actorFrom(revokedBy) }),
		...(revokeReason === undefined ? {} : { revokeReason }),
	};
}

function requestFrom(row: SqlRow): AccessRequest {
	const revision = optionalNumber(row.revision);
	const sessionId = sqlOptionalString(row.session_id);
	const agentId = sqlOptionalString(row.agent_id);
	const expiresAt = optionalNumber(row.expires_at);
	const decidedBy = sqlOptionalString(row.decided_by);
	const note = sqlOptionalString(row.decision_note);
	const shareId = sqlOptionalString(row.share_id);
	return {
		id: String(row.id),
		organisationId: String(row.organisation_id),
		resource: { kind: String(row.kind), id: String(row.resource_id), ...(revision === undefined ? {} : { revision }) },
		owner: ownerFrom(row),
		grantee: granteeFrom(String(row.grantee_key)),
		permission: String(row.permission) as SharePermission,
		reason: String(row.reason),
		requestedBy: actorFrom(row.requested_by),
		...(sessionId === undefined ? {} : { sessionId }),
		...(agentId === undefined ? {} : { agentId }),
		status: String(row.status) as AccessRequest["status"],
		createdAt: sqlNumber(row.created_at),
		...(expiresAt === undefined ? {} : { expiresAt }),
		...(decidedBy === undefined
			? {}
			: {
					decision: {
						decidedBy: actorFrom(decidedBy),
						decidedAt: sqlNumber(row.decided_at),
						...(note === undefined ? {} : { note }),
						...(shareId === undefined ? {} : { shareId }),
					},
				}),
	};
}

function shareValues(share: ResourceShare): SqlValue[] {
	return [
		share.organisationId,
		share.id,
		share.resource.kind,
		share.resource.id,
		share.resource.revision ?? null,
		...ownerColumns(share.owner),
		granteeKey(share.grantee),
		share.permission,
		share.agentWrites ? 1 : 0,
		actorText(share.grantedBy),
		share.grantedAt,
		share.requestId ?? null,
		share.expiresAt ?? null,
		share.parentShareId ?? null,
		share.note ?? null,
		share.revokedAt ?? null,
		share.revokedBy === undefined ? null : actorText(share.revokedBy),
		share.revokeReason ?? null,
	];
}

function placeholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(", ");
}

function chunks<T>(items: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let index = 0; index < items.length; index += IN_CHUNK) out.push(items.slice(index, index + IN_CHUNK));
	return out;
}

/** A repository over SQL tables. */
export function createSqlSharingRepository(driver: SqlDriver): SharingRepository {
	const real = driver.dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";

	const findSharesWhere = async (where: string[], params: SqlValue[]): Promise<ResourceShare[]> => {
		const rows = await driver.query(
			`SELECT ${SHARE_COLUMNS} FROM sharing_shares WHERE ${where.join(" AND ")} ORDER BY granted_at DESC, id DESC`,
			params,
		);
		return rows.map(shareFrom);
	};

	return {
		async getResource(organisationId, resource) {
			const rows = await driver.query(
				"SELECT organisation_id, kind, resource_id, owner_kind, owner_project_id, owner_user_id, name, registered_by, registered_at FROM sharing_resources WHERE organisation_id = ? AND kind = ? AND resource_id = ?",
				[organisationId, resource.kind, resource.id],
			);
			const row = rows[0];
			if (row === undefined) return undefined;
			const name = sqlOptionalString(row.name);
			return {
				organisationId: String(row.organisation_id),
				resource: { kind: String(row.kind), id: String(row.resource_id) },
				owner: ownerFrom(row),
				...(name === undefined ? {} : { name }),
				registeredBy: actorFrom(row.registered_by),
				registeredAt: sqlNumber(row.registered_at),
			} satisfies RegisteredResource;
		},
		async putResource(record) {
			const owner = ownerColumns(record.owner);
			await driver.query(
				`INSERT INTO sharing_resources (organisation_id, kind, resource_id, owner_kind, owner_project_id, owner_user_id, name, registered_by, registered_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
				[
					record.organisationId,
					record.resource.kind,
					record.resource.id,
					owner[0] as SqlValue,
					owner[2] as SqlValue,
					owner[3] as SqlValue,
					record.name ?? null,
					actorText(record.registeredBy),
					record.registeredAt,
				],
			);
			return (await this.getResource(record.organisationId, record.resource)) as RegisteredResource;
		},

		async getShare(organisationId, shareId) {
			return (await findSharesWhere(["organisation_id = ?", "id = ?"], [organisationId, shareId]))[0];
		},
		async insertShare(share) {
			await driver.query(
				`INSERT INTO sharing_shares (${SHARE_COLUMNS}) VALUES (${placeholders(21)})`,
				shareValues(share),
			);
		},
		async findShares(organisationId, filter: ShareFilter) {
			const where = ["organisation_id = ?"];
			const params: SqlValue[] = [organisationId];
			if (filter.resource !== undefined) {
				where.push("kind = ?", "resource_id = ?");
				params.push(filter.resource.kind, filter.resource.id);
			}
			if (filter.kind !== undefined) {
				where.push("kind = ?");
				params.push(filter.kind);
			}
			if (filter.ownerProjectId !== undefined) {
				where.push("owner_kind = 'project'", "owner_project_id = ?");
				params.push(filter.ownerProjectId);
			}
			if (filter.granteeKeys !== undefined) {
				if (filter.granteeKeys.length === 0) return [];
				where.push(`grantee_key IN (${placeholders(filter.granteeKeys.length)})`);
				params.push(...filter.granteeKeys);
			}
			if (filter.parentShareIds === undefined) return findSharesWhere(where, params);
			const found: ResourceShare[] = [];
			for (const chunk of chunks(filter.parentShareIds)) {
				found.push(
					...(await findSharesWhere(
						[...where, `parent_share_id IN (${placeholders(chunk.length)})`],
						[...params, ...chunk],
					)),
				);
			}
			return found;
		},
		async revokeShares(organisationId, shareIds, revocation) {
			const revoked: string[] = [];
			for (const id of shareIds) {
				const rows = await driver.query(
					"UPDATE sharing_shares SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE organisation_id = ? AND id = ? AND revoked_at IS NULL RETURNING id",
					[revocation.revokedAt, actorText(revocation.revokedBy), revocation.reason ?? null, organisationId, id],
				);
				if (rows.length > 0) revoked.push(id);
			}
			return revoked;
		},

		async getRequest(organisationId, requestId) {
			const rows = await driver.query(
				`SELECT ${REQUEST_COLUMNS} FROM sharing_requests WHERE organisation_id = ? AND id = ?`,
				[organisationId, requestId],
			);
			return rows[0] === undefined ? undefined : requestFrom(rows[0]);
		},
		async insertRequest(request) {
			await driver.query(`INSERT INTO sharing_requests (${REQUEST_COLUMNS}) VALUES (${placeholders(22)})`, [
				request.organisationId,
				request.id,
				request.resource.kind,
				request.resource.id,
				request.resource.revision ?? null,
				...ownerColumns(request.owner),
				granteeKey(request.grantee),
				request.permission,
				request.reason,
				actorText(request.requestedBy),
				request.sessionId ?? null,
				request.agentId ?? null,
				request.status,
				request.createdAt,
				request.expiresAt ?? null,
				null,
				null,
				null,
				null,
			]);
		},
		async findRequests(organisationId, filter: RequestFilter) {
			const where = ["organisation_id = ?"];
			const params: SqlValue[] = [organisationId];
			if (filter.resource !== undefined) {
				where.push("kind = ?", "resource_id = ?");
				params.push(filter.resource.kind, filter.resource.id);
			}
			if (filter.granteeKey !== undefined) {
				where.push("grantee_key = ?");
				params.push(filter.granteeKey);
			}
			if (filter.status !== undefined) {
				where.push("status = ?");
				params.push(filter.status);
			}
			if (filter.ownerProjectId !== undefined) {
				where.push("owner_kind = 'project'", "owner_project_id = ?");
				params.push(filter.ownerProjectId);
			}
			if (filter.sessionId !== undefined) {
				where.push("session_id = ?");
				params.push(filter.sessionId);
			}
			const rows = await driver.query(
				`SELECT ${REQUEST_COLUMNS} FROM sharing_requests WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC`,
				params,
			);
			return rows.map(requestFrom);
		},
		async settleRequest(settled, share) {
			const writer = crypto.randomUUID();
			const decision = settled.decision;
			const statements = [
				sql(
					`UPDATE sharing_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, share_id = ?, writer = ?
					WHERE organisation_id = ? AND id = ? AND status = 'pending'`,
					settled.status,
					decision === undefined ? null : actorText(decision.decidedBy),
					decision?.decidedAt ?? null,
					decision?.note ?? null,
					decision?.shareId ?? null,
					writer,
					settled.organisationId,
					settled.id,
				),
			];
			if (share !== undefined) {
				// Only where this writer's settlement landed: casts give Postgres the columns' types.
				const values = shareValues(share);
				const casts = SHARE_COLUMNS.split(", ").map((column) => {
					if (column === "revision" || column === "agent_writes") return "CAST(? AS INTEGER)";
					if (column.endsWith("_at")) return `CAST(? AS ${real})`;
					return "CAST(? AS TEXT)";
				});
				statements.push(
					sql(
						`INSERT INTO sharing_shares (${SHARE_COLUMNS}) SELECT ${casts.join(", ")}
						WHERE EXISTS (SELECT 1 FROM sharing_requests WHERE organisation_id = ? AND id = ? AND writer = ?)`,
						...values,
						settled.organisationId,
						settled.id,
						writer,
					),
				);
			}
			await driver.batch(statements);
			const rows = await driver.query("SELECT writer FROM sharing_requests WHERE organisation_id = ? AND id = ?", [
				settled.organisationId,
				settled.id,
			]);
			return rows[0] !== undefined && String(rows[0].writer) === writer;
		},

		async putBinding(binding) {
			const subjectKey = bindingSubjectKey(binding.subject);
			await driver.query(
				`INSERT INTO sharing_tuples (organisation_id, object_kind, object_id, relation, subject_key, granted_by, granted_at)
				VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
				[
					binding.organisationId,
					binding.object.kind,
					binding.object.id,
					binding.relation,
					subjectKey,
					actorText(binding.grantedBy),
					binding.grantedAt,
				],
			);
			const stored = await this.findBindings(binding.organisationId, {
				object: { kind: binding.object.kind, id: binding.object.id },
				relation: binding.relation,
				subjectKey,
			});
			return stored[0] as ResourceBinding;
		},
		async deleteBinding(binding) {
			const rows = await driver.query(
				"DELETE FROM sharing_tuples WHERE organisation_id = ? AND object_kind = ? AND object_id = ? AND relation = ? AND subject_key = ? RETURNING subject_key",
				[
					binding.organisationId,
					binding.object.kind,
					binding.object.id,
					binding.relation,
					bindingSubjectKey(binding.subject),
				],
			);
			return rows.length > 0;
		},
		async findBindings(organisationId, filter: BindingFilter) {
			const where = ["organisation_id = ?"];
			const params: SqlValue[] = [organisationId];
			if (filter.object !== undefined) {
				where.push("object_kind = ?", "object_id = ?");
				params.push(filter.object.kind, filter.object.id);
			}
			if (filter.subjectKey !== undefined) {
				where.push("subject_key = ?");
				params.push(filter.subjectKey);
			}
			if (filter.relation !== undefined) {
				where.push("relation = ?");
				params.push(filter.relation);
			}
			const rows = await driver.query(
				`SELECT organisation_id, object_kind, object_id, relation, subject_key, granted_by, granted_at FROM sharing_tuples
				WHERE ${where.join(" AND ")} ORDER BY granted_at, object_kind, object_id, relation, subject_key`,
				params,
			);
			return rows.map(
				(row): ResourceBinding => ({
					organisationId: String(row.organisation_id),
					object: { kind: String(row.object_kind), id: String(row.object_id) },
					relation: String(row.relation) as ResourceBinding["relation"],
					subject: subjectFrom(String(row.subject_key)),
					grantedBy: actorFrom(row.granted_by),
					grantedAt: sqlNumber(row.granted_at),
				}),
			);
		},

		async getPolicy(organisationId, resource) {
			const rows = await driver.query(
				"SELECT two_person_rule FROM sharing_policies WHERE organisation_id = ? AND kind = ? AND resource_id = ?",
				[organisationId, resource.kind, resource.id],
			);
			return rows[0] === undefined ? undefined : { twoPersonRule: sqlNumber(rows[0].two_person_rule) === 1 };
		},
		async putPolicy(organisationId, resource, policy, by, at) {
			await driver.query(
				`INSERT INTO sharing_policies (organisation_id, kind, resource_id, two_person_rule, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT (organisation_id, kind, resource_id) DO UPDATE SET two_person_rule = excluded.two_person_rule,
				updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
				[organisationId, resource.kind, resource.id, policy.twoPersonRule ? 1 : 0, actorText(by), at],
			);
		},

		async putUse(use) {
			await driver.query(
				`INSERT INTO sharing_uses (organisation_id, session_id, kind, resource_id, revision, share_id, used_at)
				VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
				[
					use.organisationId,
					use.sessionId,
					use.resource.kind,
					use.resource.id,
					use.resource.revision ?? null,
					use.shareId,
					use.usedAt,
				],
			);
		},
		async findUses(organisationId, sessionId) {
			const rows = await driver.query(
				"SELECT organisation_id, session_id, kind, resource_id, revision, share_id, used_at FROM sharing_uses WHERE organisation_id = ? AND session_id = ? ORDER BY used_at, kind, resource_id",
				[organisationId, sessionId],
			);
			return rows.map((row) => {
				const revision = optionalNumber(row.revision);
				return {
					organisationId: String(row.organisation_id),
					sessionId: String(row.session_id),
					resource: {
						kind: String(row.kind),
						id: String(row.resource_id),
						...(revision === undefined ? {} : { revision }),
					},
					shareId: String(row.share_id),
					usedAt: sqlNumber(row.used_at),
				};
			});
		},
	};
}

/** The durable sharing store. Run `migrateSharing` (or `sharingSchema`) first. */
export function createSqlSharing(options: SqlSharingOptions): SharingStore {
	return createSharingStore(createSqlSharingRepository(options.driver), options);
}

/**
 * `FileShares` over SQL (D1 on Cloudflare, Postgres self-hosted, `node:sqlite` in tests): the shares of the files in
 * workspaces (`@harbour/contracts`' `shares.ts`). One row a share, its record as JSON beside the columns it is found by.
 * A change is a compare-and-set on `revision`, retried when it loses a race; one live share a file is a unique index.
 *
 * Who may do what follows the workspace: reading a share needs what reading the file needs (`workspaces.stat`), and
 * every change needs operator on the workspace's project and a person (no agent, no API key). Each change is audited
 * as `workspace.share.*`, with the share's access but never its token.
 */
import {
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	type FileShare,
	type FileShares,
	HarbourError,
	isHarbourError,
	MAX_SHARE_INVITES,
	normaliseEmail,
	type ProjectAccess,
	requireSystem,
	type ShareAccess,
	type ShareInput,
	type ShareUpdate,
	systemClock,
	systemContext,
	type UserId,
	type WorkspaceRecord,
	type Workspaces,
} from "@harbour/contracts";
import type { SqlDialect, SqlDriver, SqlRow } from "@harbour/sql";
import { projectScope } from "./tree.ts";

export interface SqlFileSharesOptions {
	readonly driver: SqlDriver;
	/** The workspaces whose files are shared: each call checks the caller can see the file through them. */
	readonly workspaces: Pick<Workspaces, "get" | "stat">;
	/** Operator on the workspace's project for each change. Without it only the workspace's own checks apply. */
	readonly access?: ProjectAccess;
	readonly audit?: AuditSink;
	readonly clock?: Clock;
}

/** The table and its indexes, for `migrateFileShares` or a target's own migrations. Every statement is idempotent. */
export function fileSharesSchema(dialect: SqlDialect): readonly string[] {
	const time = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS file_shares (
			id TEXT PRIMARY KEY,
			organisation_id TEXT NOT NULL,
			workspace_id TEXT NOT NULL,
			path TEXT NOT NULL,
			token TEXT NOT NULL UNIQUE,
			access TEXT NOT NULL,
			created_at ${time} NOT NULL,
			revoked_at ${time},
			revision INTEGER NOT NULL DEFAULT 0,
			record TEXT NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS file_shares_by_workspace ON file_shares (organisation_id, workspace_id, created_at)",
		"CREATE UNIQUE INDEX IF NOT EXISTS file_shares_live ON file_shares (workspace_id, path) WHERE revoked_at IS NULL",
	];
}

/** Creates the shares table if it is missing. */
export async function migrateFileShares(driver: SqlDriver): Promise<void> {
	await driver.batch(fileSharesSchema(driver.dialect).map((text) => ({ sql: text })));
}

const AUDIT_CONTEXT = systemContext("workspace");
/** Attempts a change makes before giving up on a race it keeps losing. */
const MAX_ATTEMPTS = 8;
const ACCESS_VALUES: readonly ShareAccess[] = ["restricted", "link"];
const MAX_TITLE = 200;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ShareRow extends SqlRow {
	readonly revision: unknown;
	readonly record: unknown;
}

/** A link's secret: 32 random bytes, base64url. */
function newToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function checkAccess(access: unknown): ShareAccess {
	if (!ACCESS_VALUES.includes(access as ShareAccess)) {
		throw new HarbourError("invalid", "access is restricted or link");
	}
	return access as ShareAccess;
}

function checkTitle(title: unknown): string | undefined {
	if (title === undefined) return undefined;
	if (typeof title !== "string") throw new HarbourError("invalid", "title is a string");
	const trimmed = title.trim();
	if (trimmed.length > MAX_TITLE) throw new HarbourError("invalid", `title is at most ${MAX_TITLE} characters`);
	return trimmed === "" ? undefined : trimmed;
}

function checkEmail(email: unknown): string {
	if (typeof email !== "string") throw new HarbourError("invalid", "email is a string");
	const trimmed = email.trim();
	if (trimmed.length > 254 || !EMAIL.test(trimmed)) throw new HarbourError("invalid", `not an email: ${trimmed}`);
	return trimmed;
}

/** The person making a change: shares are people's, never an agent's or an API key's. */
function person(ctx: CallContext): UserId {
	if (ctx.actor.kind !== "human") throw new HarbourError("forbidden", "Only a person can share a file");
	return ctx.actor.userId;
}

export function createSqlFileShares(options: SqlFileSharesOptions): FileShares {
	const { driver, workspaces, access, audit } = options;
	const clock = options.clock ?? systemClock;

	const parse = (row: ShareRow): { share: FileShare; revision: number } => ({
		share: JSON.parse(String(row.record)) as FileShare,
		revision: Number(row.revision),
	});

	async function row(id: string): Promise<{ share: FileShare; revision: number } | undefined> {
		const [found] = await driver.query<ShareRow>("SELECT revision, record FROM file_shares WHERE id = ?", [id]);
		return found === undefined ? undefined : parse(found);
	}

	/** Viewer on the file (or operator, for a change), through the workspace's own checks. */
	async function requireFile(
		ctx: CallContext,
		workspaceId: string,
		path: string,
		needed: "viewer" | "operator",
	): Promise<WorkspaceRecord> {
		if (typeof path !== "string" || path === "" || path.startsWith("/")) {
			throw new HarbourError("invalid", "path is a file's path in the workspace");
		}
		const record = await workspaces.get(ctx, workspaceId);
		const scope = projectScope(record.owner, record.sessionId);
		if (needed === "operator" && access !== undefined && scope !== undefined) {
			await access.require(ctx, {
				...scope,
				needed: "operator",
				operation: "workspace.share",
				subject: { kind: "workspace", id: workspaceId },
			});
		}
		const stat = await workspaces.stat(ctx, workspaceId, path);
		if (stat.kind !== "file") throw new HarbourError("invalid", `${path} is not a file`);
		return record;
	}

	/** The share, if the caller may see it (an unknown or unseeable one is `not_found` alike). */
	async function load(ctx: CallContext, id: string, needed: "viewer" | "operator") {
		const found = typeof id === "string" && id !== "" ? await row(id) : undefined;
		if (found === undefined || found.share.organisationId !== ctx.organisationId) {
			throw new HarbourError("not_found", `share ${String(id)} not found`);
		}
		try {
			await requireFile(ctx, found.share.workspaceId, found.share.path, needed);
		} catch (error) {
			// A file deleted since it was shared still has its share, to list and revoke.
			const gone = isHarbourError(error, "not_found") && error.details?.path !== undefined;
			if (!gone) throw error;
		}
		return found;
	}

	async function emit(ctx: CallContext, share: FileShare, type: string, data: AuditEventInput["data"] = {}) {
		await audit?.append(AUDIT_CONTEXT, [
			{
				id: `workspace:share:${share.id}:${type}:${share.updatedAt}:${crypto.randomUUID()}`,
				at: share.updatedAt,
				source: "workspace",
				type,
				actor: ctx.actor,
				organisationId: share.organisationId,
				...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
				subject: { kind: "workspace", id: share.workspaceId },
				data: { shareId: share.id, path: share.path, access: share.access, ...data },
			},
		]);
	}

	/** Changes a live share with `change`, as a compare-and-set, retried while another change wins the race. */
	async function change(
		ctx: CallContext,
		id: string,
		apply: (share: FileShare, now: number) => FileShare | undefined,
	): Promise<{ share: FileShare; changed: boolean }> {
		person(ctx);
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			const { share, revision } = await load(ctx, id, "operator");
			if (share.revokedAt !== undefined) throw new HarbourError("conflict", "This share was revoked");
			const next = apply(share, clock.now());
			if (next === undefined) return { share, changed: false };
			const updated = await driver.query(
				"UPDATE file_shares SET access = ?, revoked_at = ?, revision = ?, record = ? WHERE id = ? AND revision = ? RETURNING id",
				[next.access, next.revokedAt ?? null, revision + 1, JSON.stringify(next), id, revision],
			);
			if (updated.length === 1) return { share: next, changed: true };
		}
		throw new HarbourError("conflict", "The share kept changing; try again");
	}

	return {
		async share(ctx, input: ShareInput) {
			const userId = person(ctx);
			const accessLevel = checkAccess(input.access ?? "restricted");
			const title = checkTitle(input.title);
			const record = await requireFile(ctx, input.workspaceId, input.path, "operator");
			const now = clock.now();
			const share: FileShare = {
				id: `shr_${crypto.randomUUID()}`,
				organisationId: ctx.organisationId,
				workspaceId: record.id,
				path: input.path,
				...(title === undefined ? {} : { title }),
				access: accessLevel,
				token: newToken(),
				createdBy: userId,
				createdAt: now,
				updatedAt: now,
				invites: [],
			};
			const inserted = await driver.query(
				`INSERT INTO file_shares (id, organisation_id, workspace_id, path, token, access, created_at, revoked_at, revision, record)
				 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, ?) ON CONFLICT DO NOTHING RETURNING id`,
				[
					share.id,
					share.organisationId,
					share.workspaceId,
					share.path,
					share.token,
					share.access,
					now,
					JSON.stringify(share),
				],
			);
			if (inserted.length === 1) {
				await emit(ctx, share, "workspace.share.created");
				return share;
			}
			// The file has a live share already: that one is the file's share.
			const [existing] = await driver.query<ShareRow>(
				"SELECT revision, record FROM file_shares WHERE workspace_id = ? AND path = ? AND revoked_at IS NULL",
				[record.id, input.path],
			);
			if (existing === undefined) throw new HarbourError("conflict", "The file's share changed; try again");
			return parse(existing).share;
		},

		async list(ctx, query) {
			const record = await workspaces.get(ctx, query.workspaceId);
			const rows =
				query.path === undefined
					? await driver.query<ShareRow>(
							"SELECT revision, record FROM file_shares WHERE organisation_id = ? AND workspace_id = ? AND revoked_at IS NULL ORDER BY created_at, id",
							[ctx.organisationId, record.id],
						)
					: await driver.query<ShareRow>(
							"SELECT revision, record FROM file_shares WHERE organisation_id = ? AND workspace_id = ? AND path = ? AND revoked_at IS NULL",
							[ctx.organisationId, record.id, query.path],
						);
			return rows.map((found) => parse(found).share);
		},

		async get(ctx, id) {
			return (await load(ctx, id, "viewer")).share;
		},

		async update(ctx, id, update: ShareUpdate) {
			const accessLevel = update.access === undefined ? undefined : checkAccess(update.access);
			const title = update.title === undefined ? undefined : checkTitle(update.title);
			const { share, changed } = await change(ctx, id, (share, now) => {
				const next = {
					...share,
					...(accessLevel === undefined ? {} : { access: accessLevel }),
					...(title === undefined ? {} : { title }),
				};
				if (next.access === share.access && next.title === share.title) return undefined;
				return { ...next, updatedAt: now };
			});
			if (changed) await emit(ctx, share, "workspace.share.changed");
			return share;
		},

		async invite(ctx, id, email) {
			const address = checkEmail(email);
			const userId = person(ctx);
			const { share, changed } = await change(ctx, id, (share, now) => {
				const key = normaliseEmail(address);
				if (share.invites.some((invite) => normaliseEmail(invite.email) === key)) return undefined;
				if (share.invites.length >= MAX_SHARE_INVITES) {
					throw new HarbourError("invalid", `A share holds at most ${MAX_SHARE_INVITES} invites`);
				}
				return {
					...share,
					invites: [...share.invites, { email: address, invitedBy: userId, invitedAt: now }],
					updatedAt: now,
				};
			});
			// The audit names how many are invited, never who: an address is personal data.
			if (changed) await emit(ctx, share, "workspace.share.invited", { invites: share.invites.length });
			return share;
		},

		async removeInvite(ctx, id, email) {
			const key = normaliseEmail(checkEmail(email));
			const { share, changed } = await change(ctx, id, (share, now) => {
				const invites = share.invites.filter((invite) => normaliseEmail(invite.email) !== key);
				return invites.length === share.invites.length ? undefined : { ...share, invites, updatedAt: now };
			});
			if (changed) await emit(ctx, share, "workspace.share.uninvited", { invites: share.invites.length });
			return share;
		},

		async revoke(ctx, id) {
			person(ctx);
			const current = (await load(ctx, id, "operator")).share;
			if (current.revokedAt !== undefined) return current;
			const { share, changed } = await change(ctx, id, (share, now) => ({ ...share, revokedAt: now, updatedAt: now }));
			if (changed) await emit(ctx, share, "workspace.share.revoked");
			return share;
		},

		async open(ctx, token) {
			await requireSystem(ctx, "workspace.share.open");
			if (typeof token !== "string" || token.length < 20 || token.length > 100) return undefined;
			const [found] = await driver.query<ShareRow>("SELECT revision, record FROM file_shares WHERE token = ?", [token]);
			if (found === undefined) return undefined;
			const { share } = parse(found);
			return share.revokedAt === undefined && share.access === "link" ? share : undefined;
		},
	};
}

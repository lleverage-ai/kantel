/**
 * The durable `AuditStore` and `AuditOutbox`, on any `SqlDriver`: Postgres for the self-hosted target, D1 (or a Durable
 * Object's SQLite) for Cloudflare. They behave as the in-memory ones in `./memory.ts` do and pass the same suite.
 *
 * - The store keeps one row per `(organisation_id, id)` (`ON CONFLICT DO NOTHING`), so a retried batch never adds a
 *   row. `seq` is the table's own increasing key; on Postgres every append takes a transaction-scoped advisory lock
 *   first, so rows commit in `seq` order and a reader paging by cursor never skips a row that commits late.
 * - Rows are only ever inserted, and deleted only by `applyRetention`.
 * - Queries page by `seq` on indexes that lead with the organisation, so a page costs the same at row 100,000 as at
 *   row 1.
 * - The outbox is a table producers write in their own transaction (`auditOutboxStatements`). `drain` sends it in
 *   order, `OUTBOX_BATCH_SIZE` at a time, and deletes a batch only after the sink took it.
 */
import {
	type Actor,
	type AuditEvent,
	type AuditEventInput,
	type AuditOutbox,
	type AuditQuery,
	type AuditSink,
	type AuditStore,
	assertAuditQueryTypes,
	type CallContext,
	type Clock,
	HarbourError,
	type Page,
	type PageRequest,
	type ProjectAccess,
	type ProjectId,
	requireSystem,
	type SystemContext,
	systemClock,
	systemContext,
} from "@harbour/contracts";
import { type SqlDialect, type SqlDriver, type SqlStatement, type SqlValue, sqlNumber } from "@harbour/sql";
import { assertValidAuditEvent } from "./index.ts";
import { OUTBOX_BATCH_SIZE } from "./memory.ts";

const RELAY_CONTEXT: SystemContext = systemContext("audit.relay");
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;
/** D1 binds at most 100 parameters a statement; an event row takes 15. */
const ROWS_PER_INSERT: Readonly<Record<SqlDialect, number>> = { postgres: 200, sqlite: 6 };
/** The advisory lock key every Postgres append takes, so rows commit in `seq` order. */
const APPEND_LOCK = "SELECT pg_advisory_xact_lock(7316102018)";

/**
 * The vault record of `kind` a row is about, read from its stored event as `eventItemId` and `eventGrantId` read it: the
 * subject's ID when the subject is of that kind, or else `data.<key>` when it is a string; otherwise null. The indexes
 * on it and the queries that use them must use this exact text, so it is built in one place.
 */
function aboutExpression(dialect: SqlDialect, kind: "vault.item" | "vault.grant", key: "itemId" | "grantId"): string {
	return dialect === "postgres"
		? `(CASE WHEN (CAST(event AS jsonb) -> 'subject' ->> 'kind') = '${kind}' THEN (CAST(event AS jsonb) -> 'subject' ->> 'id') WHEN jsonb_typeof(CAST(event AS jsonb) -> 'data' -> '${key}') = 'string' THEN (CAST(event AS jsonb) -> 'data' ->> '${key}') END)`
		: `(CASE WHEN json_extract(event, '$.subject.kind') = '${kind}' THEN json_extract(event, '$.subject.id') WHEN json_type(event, '$.data.${key}') = 'text' THEN json_extract(event, '$.data.${key}') END)`;
}

const itemExpression = (dialect: SqlDialect) => aboutExpression(dialect, "vault.item", "itemId");
const grantExpression = (dialect: SqlDialect) => aboutExpression(dialect, "vault.grant", "grantId");

/** The tables and indexes, for `migrateAudit` or a target's own migrations. Every statement is idempotent. */
export function auditSchema(dialect: SqlDialect): readonly string[] {
	const key = dialect === "postgres" ? "BIGSERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
	const time = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS audit_events (
			seq ${key},
			organisation_id TEXT NOT NULL,
			id TEXT NOT NULL,
			at ${time} NOT NULL,
			recorded_at ${time} NOT NULL,
			source TEXT NOT NULL,
			type TEXT NOT NULL,
			actor_kind TEXT NOT NULL,
			actor_id TEXT NOT NULL,
			actor_scope TEXT,
			project_id TEXT,
			session_id TEXT,
			agent_id TEXT,
			subject TEXT,
			event TEXT NOT NULL,
			UNIQUE (organisation_id, id)
		)`,
		"CREATE INDEX IF NOT EXISTS audit_events_by_organisation ON audit_events (organisation_id, seq)",
		"CREATE INDEX IF NOT EXISTS audit_events_by_project ON audit_events (organisation_id, project_id, seq)",
		"CREATE INDEX IF NOT EXISTS audit_events_by_session ON audit_events (organisation_id, session_id, seq)",
		"CREATE INDEX IF NOT EXISTS audit_events_by_actor ON audit_events (organisation_id, actor_kind, actor_id, seq)",
		"CREATE INDEX IF NOT EXISTS audit_events_by_time ON audit_events (at)",
		// The vault item and grant each row is about, for `AuditQuery.itemId` and `grantId`. They index an expression over the
		// stored event rather than a column of their own, so a database made before them needs no backfill.
		`CREATE INDEX IF NOT EXISTS audit_events_by_item ON audit_events (organisation_id, ${itemExpression(dialect)}, seq)`,
		`CREATE INDEX IF NOT EXISTS audit_events_by_grant ON audit_events (organisation_id, ${grantExpression(dialect)}, seq)`,
		// The projects each organisation's rows name ("-" for none, "p:<id>" for a project), so an access-filtered query
		// reads a handful of rows here instead of a DISTINCT over the whole log. Retention leaves entries behind, which
		// costs one extra access check and nothing else.
		`CREATE TABLE IF NOT EXISTS audit_projects (
			organisation_id TEXT NOT NULL,
			project_key TEXT NOT NULL,
			PRIMARY KEY (organisation_id, project_key)
		)`,
		`CREATE TABLE IF NOT EXISTS audit_retention (
			organisation_id TEXT PRIMARY KEY,
			retention_ms ${time} NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS audit_outbox (
			position ${key},
			organisation_id TEXT NOT NULL,
			id TEXT NOT NULL,
			event TEXT NOT NULL,
			UNIQUE (organisation_id, id)
		)`,
	];
}

/** Creates the audit tables if they are missing. */
export async function migrateAudit(driver: SqlDriver): Promise<void> {
	await driver.batch(auditSchema(driver.dialect).map((text) => ({ sql: text })));
}

/** An actor as the columns the store filters on: kind, ID and (for a key or an agent's session) scope. */
function actorColumns(actor: Actor): readonly [string, string, string | null] {
	switch (actor.kind) {
		case "human":
			return ["human", actor.userId, null];
		case "service":
			return ["service", actor.serviceId, actor.keyId ?? null];
		case "agent":
			return ["agent", actor.agentId, actor.sessionId];
		case "system":
			return ["system", actor.component, null];
	}
}

function subjectColumn(subject: { readonly kind: string; readonly id: string } | undefined): string | null {
	return subject === undefined ? null : JSON.stringify([subject.kind, subject.id]);
}

const EVENT_COLUMNS =
	"organisation_id, id, at, recorded_at, source, type, actor_kind, actor_id, actor_scope, project_id, session_id, agent_id, subject, event";

function eventValues(event: AuditEventInput, recordedAt: number): SqlValue[] {
	return [
		event.organisationId,
		event.id,
		event.at,
		recordedAt,
		event.source,
		event.type,
		...actorColumns(event.actor),
		event.projectId ?? null,
		event.sessionId ?? null,
		event.agentId ?? null,
		subjectColumn(event.subject),
		JSON.stringify(event),
	];
}

function insertEvents(dialect: SqlDialect, events: readonly AuditEventInput[], recordedAt: number): SqlStatement[] {
	const statements: SqlStatement[] = [];
	const perInsert = ROWS_PER_INSERT[dialect];
	for (let start = 0; start < events.length; start += perInsert) {
		const chunk = events.slice(start, start + perInsert);
		const row = `(${Array.from({ length: 14 }, () => "?").join(", ")})`;
		statements.push({
			sql: `INSERT INTO audit_events (${EVENT_COLUMNS}) VALUES ${chunk.map(() => row).join(", ")} ON CONFLICT (organisation_id, id) DO NOTHING`,
			params: chunk.flatMap((event) => eventValues(event, recordedAt)),
		});
	}
	return statements;
}

const NO_PROJECT = "-";
const PROJECT_PREFIX = "p:";

/** One `audit_projects` insert per distinct project the events name. */
function projectInserts(events: readonly AuditEventInput[]): SqlStatement[] {
	const keys = new Set(
		events.map(
			(event) =>
				`${event.organisationId}\u0000${event.projectId === undefined ? NO_PROJECT : PROJECT_PREFIX + event.projectId}`,
		),
	);
	return [...keys].map((key) => {
		const [organisationId = "", projectKey = ""] = key.split("\u0000");
		return {
			sql: "INSERT INTO audit_projects (organisation_id, project_key) VALUES (?, ?) ON CONFLICT (organisation_id, project_key) DO NOTHING",
			params: [organisationId, projectKey],
		};
	});
}

interface EventRow {
	readonly [column: string]: unknown;
	readonly seq: unknown;
	readonly recorded_at: unknown;
	readonly event: unknown;
}

function rowToEvent(row: EventRow): AuditEvent {
	const input = JSON.parse(String(row.event)) as AuditEventInput;
	return { ...input, seq: sqlNumber(row.seq), recordedAt: sqlNumber(row.recorded_at) };
}

function forbidAgent(ctx: CallContext, what: string): void {
	if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", `An agent cannot ${what}`);
}

function assertRetention(retentionMs: number): void {
	if (!Number.isInteger(retentionMs) || retentionMs < 1) {
		throw new HarbourError("invalid", "Retention must be a positive whole number of milliseconds");
	}
}

function cursorSeq(cursor: string): number {
	const seq = Number(cursor);
	if (cursor.length === 0 || !Number.isInteger(seq) || seq < 0)
		throw new HarbourError("invalid", "Unknown page cursor");
	return seq;
}

/** `column` is one of the strings in the JSON array bound as one parameter, so a list never meets D1's 100-parameter cap. */
function inJsonList(dialect: SqlDialect, column: string): string {
	return dialect === "postgres"
		? `${column} IN (SELECT jsonb_array_elements_text(CAST(? AS jsonb)))`
		: `${column} IN (SELECT value FROM json_each(?))`;
}

/**
 * The row's type starts with one of the prefixes in the JSON array bound as one parameter. The column is qualified
 * because SQLite's `json_each` has a `type` column of its own; the database counts the prefix's characters.
 */
function underAnyPrefix(dialect: SqlDialect): string {
	return dialect === "postgres"
		? "EXISTS (SELECT 1 FROM jsonb_array_elements_text(CAST(? AS jsonb)) AS prefix(value) WHERE substr(audit_events.type, 1, length(prefix.value)) = prefix.value)"
		: "EXISTS (SELECT 1 FROM json_each(?) AS prefix WHERE substr(audit_events.type, 1, length(prefix.value)) = prefix.value)";
}

/** The `WHERE` conditions and parameters for the fields of `query`, after the organisation. */
function queryConditions(dialect: SqlDialect, query: AuditQuery): { conditions: string[]; params: SqlValue[] } {
	const conditions: string[] = [];
	const params: SqlValue[] = [];
	const equal = (column: string, value: SqlValue) => {
		conditions.push(`${column} = ?`);
		params.push(value);
	};
	if (query.projectId !== undefined) equal("project_id", query.projectId);
	if (query.sessionId !== undefined) equal("session_id", query.sessionId);
	if (query.agentId !== undefined) equal("agent_id", query.agentId);
	if (query.actor !== undefined) {
		const [kind, id, scope] = actorColumns(query.actor);
		equal("actor_kind", kind);
		equal("actor_id", id);
		// A service's key counts only when the query names one; an agent is always its session's.
		if (scope !== null) equal("actor_scope", scope);
	}
	if (query.source !== undefined) equal("source", query.source);
	if (query.type !== undefined) {
		if (query.type.endsWith(".")) {
			// SQL counts characters, not UTF-16 units as JavaScript's `length` does, so the database measures the prefix.
			conditions.push("substr(type, 1, length(CAST(? AS TEXT))) = ?");
			params.push(query.type, query.type);
		} else {
			equal("type", query.type);
		}
	}
	if (query.types !== undefined) {
		// Exact types and prefixes each as one JSON array parameter, so a long list never meets D1's 100-parameter cap.
		const exact = query.types.filter((type) => !type.endsWith("."));
		const prefixes = query.types.filter((type) => type.endsWith("."));
		const any: string[] = [];
		if (exact.length > 0) {
			any.push(inJsonList(dialect, "type"));
			params.push(JSON.stringify(exact));
		}
		if (prefixes.length > 0) {
			any.push(underAnyPrefix(dialect));
			params.push(JSON.stringify(prefixes));
		}
		conditions.push(`(${any.join(" OR ")})`);
	}
	if (query.subject !== undefined) equal("subject", subjectColumn(query.subject));
	if (query.itemId !== undefined) equal(itemExpression(dialect), query.itemId);
	if (query.grantId !== undefined) equal(grantExpression(dialect), query.grantId);
	if (query.from !== undefined) {
		conditions.push("at >= ?");
		params.push(query.from);
	}
	if (query.to !== undefined) {
		conditions.push("at < ?");
		params.push(query.to);
	}
	return { conditions, params };
}

export interface SqlAuditStoreOptions {
	readonly driver: SqlDriver;
	readonly clock?: Clock;
	/** Retention for organisations that have not set their own. Default: keep rows forever. */
	readonly retentionMs?: number;
	/** As for the in-memory store: checks access on every read and on `setRetention`. Every target passes one. */
	readonly access?: ProjectAccess;
}

/** The durable `AuditStore`. Call `migrateAudit(driver)` (or run `auditSchema`) once before using it. */
export function createSqlAuditStore(options: SqlAuditStoreOptions): AuditStore {
	const { driver } = options;
	const clock = options.clock ?? systemClock;
	if (options.retentionMs !== undefined) assertRetention(options.retentionMs);
	const defaultRetentionMs = options.retentionMs ?? null;
	const access = options.access;

	async function record(events: readonly AuditEventInput[]): Promise<void> {
		for (const event of events) assertValidAuditEvent(event);
		if (events.length === 0) return;
		const inserts = [...insertEvents(driver.dialect, events, clock.now()), ...projectInserts(events)];
		await driver.batch(driver.dialect === "postgres" ? [{ sql: APPEND_LOCK }, ...inserts] : inserts);
	}
	const self: AuditSink = { append: async (_ctx, events) => record(events) };

	/** The projects (and `null` for rows without one) the caller may view, of those the organisation's rows name. */
	async function viewableProjects(ctx: CallContext, guard: ProjectAccess): Promise<(ProjectId | null)[]> {
		const rows = await driver.query<{ project_key: unknown }>(
			"SELECT project_key FROM audit_projects WHERE organisation_id = ?",
			[ctx.organisationId],
		);
		const viewable: (ProjectId | null)[] = [];
		for (const { project_key: key } of rows) {
			const projectId = String(key) === NO_PROJECT ? null : String(key).slice(PROJECT_PREFIX.length);
			const allowed = await guard.allows(
				ctx,
				projectId === null ? { needed: "viewer" } : { projectId, needed: "viewer" },
			);
			if (allowed) viewable.push(projectId);
		}
		return viewable;
	}

	return {
		async append(ctx: SystemContext, events: readonly AuditEventInput[]): Promise<void> {
			await requireSystem(ctx, "audit.append", { audit: self, clock });
			await record(events);
		},

		async query(ctx: CallContext, query: AuditQuery, page?: PageRequest): Promise<Page<AuditEvent>> {
			forbidAgent(ctx, "read the audit log");
			assertAuditQueryTypes(query.types);
			const limit = Math.max(1, Math.min(page?.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT));
			const after = page?.cursor === undefined ? undefined : cursorSeq(page.cursor);
			const scoped = query.projectId !== undefined || query.sessionId !== undefined;
			let checkedProject: ProjectId | undefined;
			if (access !== undefined && scoped) {
				({ projectId: checkedProject } = await access.require(ctx, {
					...(query.projectId === undefined ? {} : { projectId: query.projectId }),
					...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
					needed: "viewer",
					operation: "audit.query",
				}));
			}
			const newestFirst = query.newestFirst === true;
			const { conditions, params } = queryConditions(driver.dialect, query);
			const where = ["organisation_id = ?", ...conditions];
			const values: SqlValue[] = [ctx.organisationId, ...params];
			if (checkedProject !== undefined && query.projectId === undefined) {
				// A session's rows naming another project are left out.
				where.push("(project_id IS NULL OR project_id = ?)");
				values.push(checkedProject);
			}
			if (access !== undefined && !scoped) {
				// The page stops at the last row stored before the projects were read: a project whose first row lands
				// while access is checked is not in the filter, and a cursor past its rows would skip them for good.
				const [top] = await driver.query<{ high: unknown }>(
					"SELECT MAX(seq) AS high FROM audit_events WHERE organisation_id = ?",
					[ctx.organisationId],
				);
				if (top === undefined || top.high === null || top.high === undefined) return { items: [] };
				where.push("seq <= ?");
				values.push(sqlNumber(top.high));
				const viewable = await viewableProjects(ctx, access);
				const projects = viewable.filter((projectId) => projectId !== null);
				const unprojected = viewable.includes(null);
				if (projects.length === 0 && !unprojected) return { items: [] };
				const visible = [
					...(projects.length === 0 ? [] : [inJsonList(driver.dialect, "project_id")]),
					...(unprojected ? ["project_id IS NULL"] : []),
				];
				where.push(`(${visible.join(" OR ")})`);
				if (projects.length > 0) values.push(JSON.stringify(projects));
			}
			if (after !== undefined) {
				where.push(newestFirst ? "seq < ?" : "seq > ?");
				values.push(after);
			}
			const rows = await driver.query<EventRow>(
				`SELECT seq, recorded_at, event FROM audit_events WHERE ${where.join(" AND ")} ORDER BY seq ${newestFirst ? "DESC" : "ASC"} LIMIT ?`,
				[...values, limit + 1],
			);
			const items = rows.slice(0, limit).map(rowToEvent);
			const last = items.at(-1);
			return rows.length > limit && last !== undefined ? { items, nextCursor: String(last.seq) } : { items };
		},

		async get(ctx: CallContext, eventId: string): Promise<AuditEvent> {
			forbidAgent(ctx, "read the audit log");
			const [row] = await driver.query<EventRow>(
				"SELECT seq, recorded_at, event FROM audit_events WHERE organisation_id = ? AND id = ?",
				[ctx.organisationId, eventId],
			);
			if (row === undefined) throw new HarbourError("not_found", `No audit event ${eventId}`);
			const event = rowToEvent(row);
			if (access !== undefined) {
				await access.require(ctx, {
					...(event.projectId === undefined ? {} : { projectId: event.projectId }),
					needed: "viewer",
					operation: "audit.get",
					subject: { kind: "audit.event", id: event.id },
				});
			}
			return event;
		},

		async setRetention(ctx: CallContext, retentionMs: number): Promise<void> {
			forbidAgent(ctx, "set audit retention");
			if (access !== undefined) {
				await access.require(ctx, { needed: "admin", operation: "audit.setRetention" });
			}
			assertRetention(retentionMs);
			await driver.query(
				"INSERT INTO audit_retention (organisation_id, retention_ms) VALUES (?, ?) ON CONFLICT (organisation_id) DO UPDATE SET retention_ms = excluded.retention_ms",
				[ctx.organisationId, retentionMs],
			);
		},

		async applyRetention(ctx: SystemContext): Promise<number> {
			await requireSystem(ctx, "audit.applyRetention", { audit: self, clock });
			const removed = await driver.query(
				`DELETE FROM audit_events WHERE at < ? - COALESCE(
					(SELECT retention_ms FROM audit_retention WHERE audit_retention.organisation_id = audit_events.organisation_id),
					?
				) RETURNING seq`,
				[clock.now(), defaultRetentionMs],
			);
			return removed.length;
		},
	};
}

/**
 * The statements that queue `events` in the outbox, for a producer to run in the same batch (or Postgres transaction)
 * as its own writes, so its records and their audit events commit together. An event already queued is queued once.
 */
export function auditOutboxStatements(events: readonly AuditEventInput[]): SqlStatement[] {
	for (const event of events) assertValidAuditEvent(event);
	return events.map((event) => ({
		sql: "INSERT INTO audit_outbox (organisation_id, id, event) VALUES (?, ?, ?) ON CONFLICT (organisation_id, id) DO NOTHING",
		params: [event.organisationId, event.id, JSON.stringify(event)],
	}));
}

export interface SqlAuditOutboxOptions {
	readonly driver: SqlDriver;
	readonly clock?: Clock;
}

/**
 * The durable `AuditOutbox`. Drains from one outbox run one at a time; drains from two processes may both send a
 * batch, and the store's idempotency keeps one row per event.
 */
export function createSqlAuditOutbox(options: SqlAuditOutboxOptions): AuditOutbox {
	const { driver } = options;
	const clock = options.clock ?? systemClock;
	let draining: Promise<unknown> = Promise.resolve();

	async function enqueue(events: readonly AuditEventInput[]): Promise<void> {
		await driver.batch(auditOutboxStatements(events));
	}
	const self: AuditSink = { append: async (_ctx, events) => enqueue(events) };

	async function drainNow(sink: AuditSink): Promise<number> {
		let sent = 0;
		for (;;) {
			const rows = await driver.query<{ position: unknown; event: unknown }>(
				"SELECT position, event FROM audit_outbox ORDER BY position LIMIT ?",
				[OUTBOX_BATCH_SIZE],
			);
			if (rows.length === 0) return sent;
			await sink.append(
				RELAY_CONTEXT,
				rows.map((row) => JSON.parse(String(row.event)) as AuditEventInput),
			);
			await driver.batch(
				rows.map((row) => ({ sql: "DELETE FROM audit_outbox WHERE position = ?", params: [sqlNumber(row.position)] })),
			);
			sent += rows.length;
		}
	}

	return {
		async append(ctx: SystemContext, events: readonly AuditEventInput[]): Promise<void> {
			await requireSystem(ctx, "audit.append", { audit: self, clock });
			await enqueue(events);
		},

		async drain(ctx: SystemContext, sink: AuditSink): Promise<number> {
			await requireSystem(ctx, "audit.drain", { audit: self, clock });
			const run = draining.then(() => drainNow(sink));
			draining = run.catch(() => undefined);
			return run;
		},

		async pending(ctx: SystemContext): Promise<number> {
			await requireSystem(ctx, "audit.pending", { audit: self, clock });
			const [row] = await driver.query<{ n: unknown }>("SELECT COUNT(*) AS n FROM audit_outbox");
			return row === undefined ? 0 : sqlNumber(row.n);
		},
	};
}

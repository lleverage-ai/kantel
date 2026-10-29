/**
 * The durable `Schedules`, on any `SqlDriver`: Postgres for the self-hosted target, D1 (or a Durable Object's SQLite)
 * for Cloudflare. It behaves as the in-memory store in `./memory.ts` does, through the same rules (`./rules.ts`), and
 * passes the same suite. Several schedulers may share one database: no statement relies on process memory.
 *
 * - A schedule is one row: the columns it is looked up and changed by (status, next due time, counts) beside the rest
 *   of the record as JSON. Every write bumps `revision`; a change is an `UPDATE … WHERE revision = ?` of the revision
 *   it read, and a writer that lost re-reads and tries again.
 * - `tick` moves a due schedule on (`… WHERE revision = ?`, stamping a writer token) and inserts its occurrence in the
 *   same batch only if that token landed, so of two schedulers ticking at once exactly one materialises it. An
 *   occurrence's ID is its primary key, `<scheduleId>@<dueAt>`, so a due time is materialised once.
 * - `claim` is one `UPDATE … RETURNING` of the oldest claimable occurrence that re-checks it is still claimable (on
 *   Postgres the candidate is picked `FOR UPDATE SKIP LOCKED`), so two runners never hold one occurrence.
 * - `complete` and `reportCheck` finish an occurrence only while the runner still holds it with a live lease; a check
 *   run's failure count and raised findings change in the same batch, guarded by the occurrence's new token.
 * - Times are the injected clock's, passed in, never the database's, so the fake clock drives the SQL store as it does
 *   the in-memory one.
 */
import {
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type CheckReport,
	type Clock,
	HarbourError,
	type JsonValue,
	type Occurrence,
	type OrganisationId,
	type Page,
	type ProjectAccess,
	type ProjectId,
	type Role,
	requireSystem,
	type Schedule,
	type Schedules,
	type SystemContext,
	systemClock,
	type Timestamp,
} from "@harbour/contracts";
import {
	type SqlDialect,
	type SqlDriver,
	type SqlRow,
	type SqlStatement,
	sql,
	sqlNumber,
	sqlOptionalString,
} from "@harbour/sql";
import {
	AUDIT_CONTEXT,
	assertClaimInput,
	assertValidInput,
	changeEvent,
	createdEvent,
	endedSchedule,
	forbidAgent,
	heldBy,
	isDue,
	matchesFilter,
	materialise,
	newSchedule,
	pageLimit,
	pausedSchedule,
	previewOf,
	type RaisedRecord,
	raiseEvent,
	requireOwner,
	resumedSchedule,
	settleCheck,
	updatedSchedule,
	visibleTo,
} from "./rules.ts";

export interface SqlSchedulesOptions {
	readonly driver: SqlDriver;
	readonly clock?: Clock;
	readonly audit?: AuditSink;
	/** As for the in-memory store; every target passes one. */
	readonly access?: ProjectAccess;
}

/** The tables and indexes, for `migrateSchedules` or a target's own migrations. Every statement is idempotent. */
export function schedulesSchema(dialect: SqlDialect): readonly string[] {
	const key = dialect === "postgres" ? "BIGSERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
	const time = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS schedules (
			seq ${key},
			id TEXT NOT NULL UNIQUE,
			organisation_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL,
			next_due_at ${time},
			occurrences INTEGER NOT NULL,
			updated_at ${time} NOT NULL,
			record TEXT NOT NULL,
			failures_in_row INTEGER NOT NULL DEFAULT 0,
			changes INTEGER NOT NULL DEFAULT 0,
			revision INTEGER NOT NULL DEFAULT 0,
			writer TEXT
		)`,
		"CREATE INDEX IF NOT EXISTS schedules_by_organisation ON schedules (organisation_id, seq)",
		"CREATE INDEX IF NOT EXISTS schedules_by_due ON schedules (status, next_due_at)",
		`CREATE TABLE IF NOT EXISTS schedule_occurrences (
			seq ${key},
			id TEXT NOT NULL UNIQUE,
			schedule_id TEXT NOT NULL,
			due_at ${time} NOT NULL,
			coalesced INTEGER NOT NULL,
			status TEXT NOT NULL,
			attempt INTEGER NOT NULL DEFAULT 0,
			claimed_by TEXT,
			lease_until ${time},
			finished_at ${time},
			result TEXT,
			writer TEXT
		)`,
		"CREATE INDEX IF NOT EXISTS schedule_occurrences_by_schedule ON schedule_occurrences (schedule_id, due_at)",
		"CREATE INDEX IF NOT EXISTS schedule_occurrences_by_status ON schedule_occurrences (status, due_at)",
		`CREATE TABLE IF NOT EXISTS schedule_findings (
			schedule_id TEXT NOT NULL,
			key TEXT NOT NULL,
			raised_at ${time} NOT NULL,
			value ${time},
			severity TEXT,
			seen_at ${time} NOT NULL,
			PRIMARY KEY (schedule_id, key)
		)`,
	];
}

/** Creates the schedules tables if they are missing. */
export async function migrateSchedules(driver: SqlDriver): Promise<void> {
	await driver.batch(schedulesSchema(driver.dialect).map((text) => ({ sql: text })));
}

interface ScheduleRow extends SqlRow {
	readonly seq: unknown;
	readonly organisation_id: unknown;
	readonly status: unknown;
	readonly next_due_at: unknown;
	readonly occurrences: unknown;
	readonly updated_at: unknown;
	readonly record: unknown;
	readonly failures_in_row: unknown;
	readonly changes: unknown;
	readonly revision: unknown;
}

interface OccurrenceRow extends SqlRow {
	readonly id: unknown;
	readonly schedule_id: unknown;
	readonly due_at: unknown;
	readonly coalesced: unknown;
	readonly status: unknown;
	readonly attempt: unknown;
	readonly claimed_by: unknown;
	readonly lease_until: unknown;
	readonly finished_at: unknown;
	readonly result: unknown;
	readonly writer: unknown;
}

const SCHEDULE_COLUMNS =
	"seq, organisation_id, status, next_due_at, occurrences, updated_at, record, failures_in_row, changes, revision";
const OCCURRENCE_COLUMNS =
	"id, schedule_id, due_at, coalesced, status, attempt, claimed_by, lease_until, finished_at, result, writer";
/** Attempts a change makes before giving up on a race it keeps losing. */
const MAX_ATTEMPTS = 8;
/** Rows a list reads at a time while it filters by access. */
const LIST_BATCH = 200;

interface StoredSchedule {
	readonly seq: number;
	readonly organisationId: OrganisationId;
	readonly schedule: Schedule;
	readonly failuresInRow: number;
	readonly changes: number;
	readonly revision: number;
}

/** The record column: the schedule without what the row's own columns hold. */
function recordOf(schedule: Schedule): string {
	const {
		status: _status,
		nextDueAt: _nextDueAt,
		occurrences: _occurrences,
		updatedAt: _updatedAt,
		...rest
	} = schedule;
	return JSON.stringify(rest);
}

function scheduleFrom(row: ScheduleRow): StoredSchedule {
	const record = JSON.parse(String(row.record)) as Omit<Schedule, "status" | "nextDueAt" | "occurrences" | "updatedAt">;
	const nextDueAt = row.next_due_at === null || row.next_due_at === undefined ? undefined : sqlNumber(row.next_due_at);
	return {
		seq: sqlNumber(row.seq),
		organisationId: String(row.organisation_id),
		schedule: {
			...record,
			status: String(row.status) as Schedule["status"],
			...(nextDueAt === undefined ? {} : { nextDueAt }),
			occurrences: sqlNumber(row.occurrences),
			updatedAt: sqlNumber(row.updated_at),
		},
		failuresInRow: sqlNumber(row.failures_in_row),
		changes: sqlNumber(row.changes),
		revision: sqlNumber(row.revision),
	};
}

function occurrenceFrom(row: OccurrenceRow): Occurrence {
	const claimedBy = sqlOptionalString(row.claimed_by);
	const optionalNumber = (value: unknown) => (value === null || value === undefined ? undefined : sqlNumber(value));
	const leaseUntil = optionalNumber(row.lease_until);
	const finishedAt = optionalNumber(row.finished_at);
	const result = sqlOptionalString(row.result);
	return {
		id: String(row.id),
		scheduleId: String(row.schedule_id),
		dueAt: sqlNumber(row.due_at),
		coalesced: sqlNumber(row.coalesced),
		status: String(row.status) as Occurrence["status"],
		attempt: sqlNumber(row.attempt),
		...(claimedBy === undefined ? {} : { claimedBy }),
		...(leaseUntil === undefined ? {} : { leaseUntil }),
		...(finishedAt === undefined ? {} : { finishedAt }),
		...(result === undefined ? {} : { result: JSON.parse(result) as JsonValue }),
	};
}

/** `?` cast to a column type, so Postgres types a parameter in `INSERT … SELECT` as SQLite does. */
function typed(dialect: SqlDialect, type: "text" | "integer" | "time"): string {
	if (type === "text") return "CAST(? AS TEXT)";
	if (type === "integer") return "CAST(? AS INTEGER)";
	return dialect === "postgres" ? "CAST(? AS DOUBLE PRECISION)" : "CAST(? AS REAL)";
}

/** An occurrence is open while it is due or running; a schedule never has two. */
const OPEN = "status IN ('due', 'running')";
/** Due, or running past its lease (the runner died); the second `?` is now. */
const CLAIMABLE = "(status = 'due' OR (status = 'running' AND lease_until <= ?))";

/** The durable `Schedules`. Call `migrateSchedules(driver)` (or run `schedulesSchema`) once before using it. */
export function createSqlSchedules(options: SqlSchedulesOptions): Schedules {
	const { driver } = options;
	const clock = options.clock ?? systemClock;
	const audit = options.audit;
	const access = options.access;
	const dialect = driver.dialect;

	async function emit(events: readonly AuditEventInput[]): Promise<void> {
		if (audit === undefined || events.length === 0) return;
		await audit.append(AUDIT_CONTEXT, events);
	}

	async function requireWorker(ctx: SystemContext, operation: string): Promise<void> {
		await requireSystem(ctx, operation, { ...(audit === undefined ? {} : { audit }), clock });
	}

	async function scheduleRow(scheduleId: string): Promise<StoredSchedule | undefined> {
		const [row] = await driver.query<ScheduleRow>(`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE id = ?`, [
			scheduleId,
		]);
		return row === undefined ? undefined : scheduleFrom(row);
	}

	async function occurrenceRow(occurrenceId: string): Promise<OccurrenceRow | undefined> {
		const [row] = await driver.query<OccurrenceRow>(
			`SELECT ${OCCURRENCE_COLUMNS} FROM schedule_occurrences WHERE id = ?`,
			[occurrenceId],
		);
		return row;
	}

	/** The schedule in the caller's organisation (`not_found` otherwise), once the caller holds `needed` on it. */
	async function accessibleFor(
		ctx: CallContext,
		scheduleId: string,
		needed: Role,
		operation: string,
	): Promise<StoredSchedule> {
		const stored = await scheduleRow(scheduleId);
		if (stored === undefined || stored.organisationId !== ctx.organisationId) {
			throw new HarbourError("not_found", `No schedule ${scheduleId}`);
		}
		await requireOwner(access, ctx, stored.schedule.owner, needed, operation, scheduleId);
		return stored;
	}

	/**
	 * Applies a lifecycle change: `next` decides it from the schedule as last read (`undefined` for no change), and it
	 * lands only on that revision, else the schedule is read again. Audits the change that landed.
	 */
	async function change(
		ctx: CallContext,
		first: StoredSchedule,
		next: (current: Schedule, now: Timestamp) => Schedule | undefined,
		kind: string,
	): Promise<Schedule> {
		let stored = first;
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			const now = clock.now();
			const changed = next(stored.schedule, now);
			if (changed === undefined) return stored.schedule;
			const [row] = await driver.query<{ changes: unknown }>(
				`UPDATE schedules SET status = ?, next_due_at = ?, updated_at = ?, record = ?, changes = changes + 1,
					revision = revision + 1 WHERE id = ? AND revision = ? RETURNING changes`,
				[changed.status, changed.nextDueAt ?? null, changed.updatedAt, recordOf(changed), changed.id, stored.revision],
			);
			if (row !== undefined) {
				await emit([changeEvent(ctx, stored.organisationId, changed, kind, sqlNumber(row.changes), now)]);
				return changed;
			}
			const reread = await scheduleRow(first.schedule.id);
			if (reread === undefined) throw new HarbourError("not_found", `No schedule ${first.schedule.id}`);
			stored = reread;
		}
		throw new HarbourError("conflict", `Schedule ${first.schedule.id} kept changing; try again`);
	}

	/** Materialises `stored`'s occurrence if no other scheduler moved the schedule on first; resolves it if this did. */
	async function materialiseOne(stored: StoredSchedule, now: Timestamp): Promise<Occurrence | undefined> {
		const { occurrence, next } = materialise(stored.schedule, now);
		const writer = crypto.randomUUID();
		const time = typed(dialect, "time");
		const integer = typed(dialect, "integer");
		const text = typed(dialect, "text");
		await driver.batch([
			sql(
				`UPDATE schedules SET status = ?, next_due_at = ?, occurrences = ?, updated_at = ?, revision = revision + 1,
					writer = ? WHERE id = ? AND revision = ?`,
				next.status,
				next.nextDueAt ?? null,
				next.occurrences,
				next.updatedAt,
				writer,
				next.id,
				stored.revision,
			),
			sql(
				`INSERT INTO schedule_occurrences (id, schedule_id, due_at, coalesced, status, attempt, writer)
				SELECT ${text}, ${text}, ${time}, ${integer}, 'due', 0, ${text}
				WHERE EXISTS (SELECT 1 FROM schedules WHERE id = ? AND writer = ?)
				ON CONFLICT (id) DO NOTHING`,
				occurrence.id,
				occurrence.scheduleId,
				occurrence.dueAt,
				occurrence.coalesced,
				writer,
				next.id,
				writer,
			),
		]);
		const row = await occurrenceRow(occurrence.id);
		return row !== undefined && sqlOptionalString(row.writer) === writer ? occurrenceFrom(row) : undefined;
	}

	/**
	 * Finishes `occurrenceId` at `now` if `runner` still holds it, with `also` in the same batch guarded by it. The lease is
	 * checked against the clock read here, not `now`: the reads before this may have outlasted the lease.
	 */
	async function finish(
		occurrenceId: string,
		runner: string,
		status: "succeeded" | "failed",
		result: JsonValue | undefined,
		now: Timestamp,
		also: (mine: SqlStatement) => SqlStatement[] = () => [],
	): Promise<Occurrence> {
		const writer = crypto.randomUUID();
		const mine = sql("EXISTS (SELECT 1 FROM schedule_occurrences WHERE id = ? AND writer = ?)", occurrenceId, writer);
		const leaseCheckedAt = clock.now();
		await driver.batch([
			sql(
				`UPDATE schedule_occurrences SET status = ?, finished_at = ?, result = ?, writer = ?
				WHERE id = ? AND status = 'running' AND claimed_by = ? AND lease_until > ?`,
				status,
				now,
				result === undefined ? null : JSON.stringify(result),
				writer,
				occurrenceId,
				runner,
				leaseCheckedAt,
			),
			...also(mine),
		]);
		const row = await occurrenceRow(occurrenceId);
		if (row === undefined) throw new HarbourError("not_found", `No occurrence ${occurrenceId}`);
		if (sqlOptionalString(row.writer) !== writer) {
			throw new HarbourError("conflict", `${runner} does not hold occurrence ${occurrenceId}`);
		}
		return occurrenceFrom(row);
	}

	return {
		async create(ctx, input) {
			forbidAgent(ctx, "create schedules");
			assertValidInput(ctx, input);
			await requireOwner(access, ctx, input.owner, "operator", "schedules.create");
			const now = clock.now();
			const schedule = newSchedule(ctx, input, `schedule_${crypto.randomUUID()}`, now);
			await driver.query(
				`INSERT INTO schedules (id, organisation_id, kind, status, next_due_at, occurrences, updated_at, record)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					schedule.id,
					ctx.organisationId,
					schedule.kind,
					schedule.status,
					schedule.nextDueAt ?? null,
					schedule.occurrences,
					schedule.updatedAt,
					recordOf(schedule),
				],
			);
			await emit([createdEvent(ctx, schedule, now)]);
			return schedule;
		},

		async update(ctx, scheduleId, input) {
			forbidAgent(ctx, "update schedules");
			const stored = await accessibleFor(ctx, scheduleId, "operator", "schedules.update");
			return change(ctx, stored, (current, now) => updatedSchedule(ctx, current, input, now), "updated");
		},

		async pause(ctx, scheduleId) {
			forbidAgent(ctx, "pause schedules");
			const stored = await accessibleFor(ctx, scheduleId, "operator", "schedules.pause");
			return change(ctx, stored, pausedSchedule, "paused");
		},

		async resume(ctx, scheduleId) {
			forbidAgent(ctx, "resume schedules");
			const stored = await accessibleFor(ctx, scheduleId, "operator", "schedules.resume");
			return change(ctx, stored, resumedSchedule, "resumed");
		},

		async end(ctx, scheduleId) {
			forbidAgent(ctx, "end schedules");
			const stored = await accessibleFor(ctx, scheduleId, "operator", "schedules.end");
			return change(ctx, stored, endedSchedule, "ended");
		},

		async get(ctx, scheduleId) {
			return (await accessibleFor(ctx, scheduleId, "viewer", "schedules.get")).schedule;
		},

		async list(ctx, filter, page): Promise<Page<Schedule>> {
			const limit = pageLimit(page);
			let after = 0;
			if (page?.cursor !== undefined) {
				after = Number(page.cursor);
				if (page.cursor.length === 0 || !Number.isInteger(after) || after < 0) {
					throw new HarbourError("invalid", "Unknown page cursor");
				}
			}
			const conditions = ["organisation_id = ?"];
			const params: (string | number)[] = [ctx.organisationId];
			if (filter?.kind !== undefined) {
				conditions.push("kind = ?");
				params.push(filter.kind);
			}
			if (filter?.status !== undefined) {
				conditions.push("status = ?");
				params.push(filter.status);
			}
			const viewable = new Map<ProjectId, Promise<boolean>>();
			const items: StoredSchedule[] = [];
			for (;;) {
				const rows = await driver.query<ScheduleRow>(
					`SELECT ${SCHEDULE_COLUMNS} FROM schedules WHERE ${conditions.join(" AND ")} AND seq > ? ORDER BY seq LIMIT ?`,
					[...params, after, LIST_BATCH],
				);
				const batch = rows.map(scheduleFrom).filter((stored) => matchesFilter(stored.schedule, filter));
				const visible = new Set(
					(
						await visibleTo(
							access,
							ctx,
							batch.map((stored) => stored.schedule),
							viewable,
						)
					).map((schedule) => schedule.id),
				);
				for (const stored of batch) {
					if (visible.has(stored.schedule.id)) items.push(stored);
					if (items.length > limit) break;
				}
				if (items.length > limit || rows.length < LIST_BATCH) break;
				after = sqlNumber(rows.at(-1)!.seq);
			}
			const pageItems = items.slice(0, limit);
			const last = pageItems.at(-1);
			return items.length > limit && last !== undefined
				? { items: pageItems.map((stored) => stored.schedule), nextCursor: String(last.seq) }
				: { items: pageItems.map((stored) => stored.schedule) };
		},

		async preview(ctx, scheduleId, n) {
			const schedule = (await accessibleFor(ctx, scheduleId, "viewer", "schedules.preview")).schedule;
			return previewOf(schedule, n, clock.now());
		},

		async tick(ctx) {
			await requireWorker(ctx, "schedules.tick");
			const now = clock.now();
			const rows = await driver.query<ScheduleRow>(
				`SELECT ${SCHEDULE_COLUMNS} FROM schedules s WHERE status = 'active' AND next_due_at <= ?
				AND NOT EXISTS (SELECT 1 FROM schedule_occurrences o WHERE o.schedule_id = s.id AND o.${OPEN})
				ORDER BY seq`,
				[now],
			);
			const created: Occurrence[] = [];
			for (const row of rows) {
				const stored = scheduleFrom(row);
				if (!isDue(stored.schedule, now)) continue;
				const occurrence = await materialiseOne(stored, now);
				if (occurrence !== undefined) created.push(occurrence);
			}
			return created;
		},

		async claim(ctx, runner, leaseMs) {
			await requireWorker(ctx, "schedules.claim");
			assertClaimInput(runner, leaseMs);
			const now = clock.now();
			const lock = dialect === "postgres" ? " FOR UPDATE SKIP LOCKED" : "";
			// A candidate another runner took first fails the outer re-check; then try the next one, if there is one.
			for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
				const [row] = await driver.query<OccurrenceRow>(
					`UPDATE schedule_occurrences SET status = 'running', claimed_by = ?, lease_until = ?, attempt = attempt + 1,
						writer = NULL
					WHERE seq = (SELECT seq FROM schedule_occurrences WHERE ${CLAIMABLE} ORDER BY due_at, seq LIMIT 1${lock})
					AND ${CLAIMABLE}
					RETURNING ${OCCURRENCE_COLUMNS}`,
					[runner, now + leaseMs, now, now],
				);
				if (row !== undefined) {
					const taken = occurrenceFrom(row);
					const stored = await scheduleRow(taken.scheduleId);
					if (stored === undefined) throw new HarbourError("not_found", `No schedule ${taken.scheduleId}`);
					return { ...taken, schedule: stored.schedule };
				}
				const left = await driver.query(`SELECT 1 FROM schedule_occurrences WHERE ${CLAIMABLE} LIMIT 1`, [now]);
				if (left.length === 0) return undefined;
			}
			return undefined;
		},

		async renew(ctx, occurrenceId, runner, leaseMs) {
			await requireWorker(ctx, "schedules.renew");
			assertClaimInput(runner, leaseMs);
			const now = clock.now();
			const [row] = await driver.query<OccurrenceRow>(
				`UPDATE schedule_occurrences SET lease_until = ?
				WHERE id = ? AND status = 'running' AND claimed_by = ? AND lease_until > ?
				RETURNING ${OCCURRENCE_COLUMNS}`,
				[now + leaseMs, occurrenceId, runner, now],
			);
			if (row !== undefined) return occurrenceFrom(row);
			const current = await occurrenceRow(occurrenceId);
			heldBy(current === undefined ? undefined : occurrenceFrom(current), occurrenceId, runner, now);
			throw new HarbourError("conflict", `${runner} does not hold occurrence ${occurrenceId}`);
		},

		async complete(ctx, occurrenceId, runner, outcome) {
			await requireWorker(ctx, "schedules.complete");
			const now = clock.now();
			const row = await occurrenceRow(occurrenceId);
			heldBy(row === undefined ? undefined : occurrenceFrom(row), occurrenceId, runner, now);
			return finish(occurrenceId, runner, outcome.status, outcome.result, now);
		},

		async reportCheck(ctx, occurrenceId, runner, report: CheckReport) {
			await requireWorker(ctx, "schedules.reportCheck");
			const now = clock.now();
			const row = await occurrenceRow(occurrenceId);
			const occurrence = heldBy(row === undefined ? undefined : occurrenceFrom(row), occurrenceId, runner, now);
			const stored = await scheduleRow(occurrence.scheduleId);
			if (stored === undefined) throw new HarbourError("not_found", `No schedule ${occurrence.scheduleId}`);
			const keys = [
				...new Set([...(report.findings ?? []).map((finding) => finding.key), `check-failed:${stored.schedule.id}`]),
			];
			const records = new Map<string, RaisedRecord>();
			{
				const found = await driver.query<{
					key: unknown;
					raised_at: unknown;
					value: unknown;
					severity: unknown;
					seen_at: unknown;
				}>(
					`SELECT key, raised_at, value, severity, seen_at FROM schedule_findings WHERE schedule_id = ? AND key IN ${
						dialect === "postgres"
							? "(SELECT jsonb_array_elements_text(CAST(? AS jsonb)))"
							: "(SELECT value FROM json_each(?))"
					}`,
					[stored.schedule.id, JSON.stringify(keys)],
				);
				for (const record of found) {
					const value = record.value === null || record.value === undefined ? undefined : sqlNumber(record.value);
					const severity = sqlOptionalString(record.severity);
					records.set(String(record.key), {
						at: sqlNumber(record.raised_at),
						seenAt: sqlNumber(record.seen_at),
						...(value === undefined ? {} : { value }),
						...(severity === undefined ? {} : { severity }),
					});
				}
			}
			const settled = settleCheck(
				stored.schedule,
				occurrenceId,
				stored.failuresInRow,
				(key) => records.get(key),
				report,
				now,
			);
			const time = typed(dialect, "time");
			await finish(occurrenceId, runner, settled.status, settled.result, now, (mine) => [
				sql(
					`UPDATE schedules SET failures_in_row = ? WHERE id = ? AND ${mine.sql}`,
					settled.failuresInRow,
					stored.schedule.id,
					...(mine.params ?? []),
				),
				...[...settled.records].map(([key, record]) =>
					sql(
						`INSERT INTO schedule_findings (schedule_id, key, raised_at, value, severity, seen_at)
						SELECT ${typed(dialect, "text")}, ${typed(dialect, "text")}, ${time}, ${time}, ${typed(dialect, "text")}, ${time}
						WHERE ${mine.sql}
						ON CONFLICT (schedule_id, key) DO UPDATE SET raised_at = excluded.raised_at, value = excluded.value,
							severity = excluded.severity, seen_at = excluded.seen_at`,
						stored.schedule.id,
						key,
						record.at,
						record.value ?? null,
						record.severity ?? null,
						record.seenAt,
						...(mine.params ?? []),
					),
				),
			]);
			await emit(settled.raised.map((finding) => raiseEvent(stored.organisationId, stored.schedule, finding, now)));
			return settled.raised;
		},

		async listOccurrences(ctx, scheduleId, page) {
			await accessibleFor(ctx, scheduleId, "viewer", "schedules.listOccurrences");
			const limit = pageLimit(page);
			const conditions = ["schedule_id = ?"];
			const params: (string | number)[] = [scheduleId];
			if (page?.cursor !== undefined) {
				const after = Number(page.cursor);
				if (page.cursor.length === 0 || !Number.isFinite(after))
					throw new HarbourError("invalid", "Unknown page cursor");
				conditions.push("due_at > ?");
				params.push(after);
			}
			const rows = await driver.query<OccurrenceRow>(
				`SELECT ${OCCURRENCE_COLUMNS} FROM schedule_occurrences WHERE ${conditions.join(" AND ")}
				ORDER BY due_at, seq LIMIT ?`,
				[...params, limit + 1],
			);
			const items = rows.slice(0, limit).map(occurrenceFrom);
			const last = items.at(-1);
			return rows.length > limit && last !== undefined ? { items, nextCursor: String(last.dueAt) } : { items };
		},
	};
}

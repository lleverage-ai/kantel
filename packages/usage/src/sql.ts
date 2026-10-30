/**
 * The usage ledger and the SQL sink (docs/usage-analytics.md), on `@harbour/sql`, so one implementation serves
 * Postgres (self-hosted), a Durable Object's SQLite and D1 (Cloudflare).
 *
 * - **Ledger** (`createSqlUsageLedger`): `usage_calls`, one append-only row per model call with a `seq` the database
 *   gives, unique by `(session_id, call_id)`, and `usage_cursors`, each shipper's place in it. The gateway inserts;
 *   shippers read past their cursor. Where no other sink is set, it is the record of truth.
 * - **SQL sink** (`sqlUsageSink`): the same `usage_calls` table in another database, D1 on Cloudflare, filled by a
 *   shipper. It ignores a row it has, so a batch sent twice adds nothing.
 */
import type { UsageRecord, UsageSink } from "@harbour/contracts";
import {
	type SqlDialect,
	type SqlDriver,
	type SqlStatement,
	type SqlValue,
	sql,
	sqlNumber,
	sqlOptionalString,
} from "@harbour/sql";

/** The `usage_calls` table and its indexes, and the ledger's `usage_cursors`. Idempotent. */
export function usageSchema(dialect: SqlDialect): readonly string[] {
	const key = dialect === "postgres" ? "BIGSERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY AUTOINCREMENT";
	const integer = dialect === "postgres" ? "BIGINT" : "INTEGER";
	const real = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS usage_calls (
			seq ${key},
			call_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			started_at ${integer} NOT NULL,
			recorded_at ${integer} NOT NULL,
			organisation_id TEXT NOT NULL,
			project_id TEXT NOT NULL,
			agent_id TEXT NOT NULL,
			run_id TEXT,
			route TEXT NOT NULL,
			model_id TEXT NOT NULL,
			provider TEXT NOT NULL,
			connector_id TEXT NOT NULL,
			connector_preset TEXT NOT NULL,
			api TEXT NOT NULL,
			status TEXT NOT NULL,
			stop_reason TEXT,
			error TEXT,
			input_tokens ${integer} NOT NULL,
			output_tokens ${integer} NOT NULL,
			cache_read_tokens ${integer} NOT NULL,
			cache_write_tokens ${integer} NOT NULL,
			reasoning_tokens ${integer},
			cost_usd ${real} NOT NULL,
			cost_input_usd ${real} NOT NULL,
			cost_output_usd ${real} NOT NULL,
			cost_cache_read_usd ${real} NOT NULL,
			cost_cache_write_usd ${real} NOT NULL,
			cost_source TEXT NOT NULL,
			price_version TEXT NOT NULL,
			duration_ms ${integer} NOT NULL,
			first_token_ms ${integer},
			UNIQUE (session_id, call_id)
		)`,
		"CREATE INDEX IF NOT EXISTS usage_calls_by_organisation ON usage_calls (organisation_id, started_at)",
		"CREATE INDEX IF NOT EXISTS usage_calls_by_project ON usage_calls (organisation_id, project_id, started_at)",
		`CREATE TABLE IF NOT EXISTS usage_cursors (
			sink TEXT PRIMARY KEY,
			after_seq ${integer} NOT NULL,
			pending_to_seq ${integer},
			updated_at ${integer} NOT NULL
		)`,
	];
}

export async function migrateUsage(driver: SqlDriver): Promise<void> {
	await driver.batch(usageSchema(driver.dialect).map((text) => ({ sql: text })));
}

const COLUMNS = [
	"call_id",
	"session_id",
	"started_at",
	"recorded_at",
	"organisation_id",
	"project_id",
	"agent_id",
	"run_id",
	"route",
	"model_id",
	"provider",
	"connector_id",
	"connector_preset",
	"api",
	"status",
	"stop_reason",
	"error",
	"input_tokens",
	"output_tokens",
	"cache_read_tokens",
	"cache_write_tokens",
	"reasoning_tokens",
	"cost_usd",
	"cost_input_usd",
	"cost_output_usd",
	"cost_cache_read_usd",
	"cost_cache_write_usd",
	"cost_source",
	"price_version",
	"duration_ms",
	"first_token_ms",
] as const;

const INSERT = `INSERT INTO usage_calls (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})
	ON CONFLICT (session_id, call_id) DO NOTHING`;

/** A record as `usage_calls`' columns, in `COLUMNS`' order. */
function values(record: UsageRecord, recordedAt: number): SqlValue[] {
	return [
		record.callId,
		record.sessionId,
		record.startedAt,
		recordedAt,
		record.organisationId,
		record.projectId,
		record.agentId,
		record.runId ?? null,
		record.route,
		record.modelId,
		record.provider,
		record.connectorId,
		record.connectorPreset,
		record.api,
		record.status,
		record.stopReason ?? null,
		record.error ?? null,
		record.inputTokens,
		record.outputTokens,
		record.cacheReadTokens,
		record.cacheWriteTokens,
		record.reasoningTokens ?? null,
		record.cost.total,
		record.cost.input,
		record.cost.output,
		record.cost.cacheRead,
		record.cost.cacheWrite,
		record.costSource,
		record.priceVersion,
		record.durationMs,
		record.firstTokenMs ?? null,
	];
}

type Row = { readonly [column: string]: unknown };

const optionalNumber = (value: unknown) => (value === null || value === undefined ? undefined : sqlNumber(value));

/** A `usage_calls` row as its record. */
export function recordOf(row: Row): UsageRecord {
	const runId = sqlOptionalString(row.run_id);
	const stopReason = sqlOptionalString(row.stop_reason);
	const error = sqlOptionalString(row.error);
	const reasoningTokens = optionalNumber(row.reasoning_tokens);
	const firstTokenMs = optionalNumber(row.first_token_ms);
	return {
		callId: String(row.call_id),
		startedAt: sqlNumber(row.started_at),
		organisationId: String(row.organisation_id),
		projectId: String(row.project_id),
		sessionId: String(row.session_id),
		agentId: String(row.agent_id),
		...(runId === undefined ? {} : { runId }),
		route: String(row.route),
		modelId: String(row.model_id),
		provider: String(row.provider),
		connectorId: String(row.connector_id),
		connectorPreset: String(row.connector_preset) as UsageRecord["connectorPreset"],
		api: String(row.api) as UsageRecord["api"],
		status: String(row.status) as UsageRecord["status"],
		...(stopReason === undefined ? {} : { stopReason }),
		...(error === undefined ? {} : { error }),
		inputTokens: sqlNumber(row.input_tokens),
		outputTokens: sqlNumber(row.output_tokens),
		cacheReadTokens: sqlNumber(row.cache_read_tokens),
		cacheWriteTokens: sqlNumber(row.cache_write_tokens),
		...(reasoningTokens === undefined ? {} : { reasoningTokens }),
		cost: {
			total: sqlNumber(row.cost_usd),
			input: sqlNumber(row.cost_input_usd),
			output: sqlNumber(row.cost_output_usd),
			cacheRead: sqlNumber(row.cost_cache_read_usd),
			cacheWrite: sqlNumber(row.cost_cache_write_usd),
		},
		costSource: String(row.cost_source) as UsageRecord["costSource"],
		priceVersion: String(row.price_version),
		durationMs: sqlNumber(row.duration_ms),
		...(firstTokenMs === undefined ? {} : { firstTokenMs }),
	};
}

/** One ledger row: its record and its place. */
export interface LedgerEntry {
	readonly seq: number;
	readonly recordedAt: number;
	readonly record: UsageRecord;
}

/** A sink's place in the ledger: everything up to `afterSeq` has reached it; `pendingToSeq` is a batch in flight. */
export interface UsageCursor {
	readonly afterSeq: number;
	readonly pendingToSeq?: number;
}

/** One session's totals, from its calls. */
export interface UsageTotals {
	readonly calls: number;
	readonly failed: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly costUsd: number;
}

export interface UsageLedger {
	/** Inserts `record`, unless `(sessionId, callId)` is there already. */
	record(record: UsageRecord): Promise<void>;
	/** Up to `limit` entries after `afterSeq` (and up to `toSeq`), recorded at or before `recordedBefore`, oldest first. */
	read(options: {
		readonly afterSeq: number;
		readonly toSeq?: number;
		readonly recordedBefore: number;
		readonly limit: number;
	}): Promise<LedgerEntry[]>;
	cursor(sink: string): Promise<UsageCursor>;
	/** Marks entries up to `toSeq` as being sent to `sink`, so a retry sends the same ones. */
	pending(sink: string, toSeq: number): Promise<void>;
	/** Marks entries up to `toSeq` as sent to `sink`. */
	advance(sink: string, toSeq: number): Promise<void>;
	/** One session's totals. */
	sessionTotals(sessionId: string): Promise<UsageTotals>;
}

export interface SqlUsageLedgerOptions {
	readonly driver: SqlDriver;
	/** Stamps `recorded_at`. Default `Date.now`. */
	readonly now?: () => number;
}

export function createSqlUsageLedger(options: SqlUsageLedgerOptions): UsageLedger {
	const { driver } = options;
	const now = options.now ?? Date.now;

	const setCursor = (sink: string, afterSeq: number | null, pendingToSeq: number | null): SqlStatement =>
		afterSeq === null
			? sql(
					`INSERT INTO usage_cursors (sink, after_seq, pending_to_seq, updated_at) VALUES (?, 0, ?, ?)
					ON CONFLICT (sink) DO UPDATE SET pending_to_seq = excluded.pending_to_seq, updated_at = excluded.updated_at`,
					sink,
					pendingToSeq,
					now(),
				)
			: sql(
					`INSERT INTO usage_cursors (sink, after_seq, pending_to_seq, updated_at) VALUES (?, ?, NULL, ?)
					ON CONFLICT (sink) DO UPDATE SET after_seq = excluded.after_seq, pending_to_seq = NULL,
					updated_at = excluded.updated_at`,
					sink,
					afterSeq,
					now(),
				);

	return {
		async record(record) {
			await driver.query(INSERT, values(record, now()));
		},
		async read({ afterSeq, toSeq, recordedBefore, limit }) {
			const rows = await driver.query(
				`SELECT seq, ${COLUMNS.join(", ")} FROM usage_calls
				WHERE seq > ? AND seq <= ? AND recorded_at <= ? ORDER BY seq LIMIT ?`,
				[afterSeq, toSeq ?? Number.MAX_SAFE_INTEGER, recordedBefore, limit],
			);
			return rows.map((row) => ({
				seq: sqlNumber(row.seq),
				recordedAt: sqlNumber(row.recorded_at),
				record: recordOf(row),
			}));
		},
		async cursor(sink) {
			const [row] = await driver.query("SELECT after_seq, pending_to_seq FROM usage_cursors WHERE sink = ?", [sink]);
			if (row === undefined) return { afterSeq: 0 };
			const pendingToSeq = optionalNumber(row.pending_to_seq);
			return { afterSeq: sqlNumber(row.after_seq), ...(pendingToSeq === undefined ? {} : { pendingToSeq }) };
		},
		async pending(sink, toSeq) {
			await driver.batch([setCursor(sink, null, toSeq)]);
		},
		async advance(sink, toSeq) {
			await driver.batch([setCursor(sink, toSeq, null)]);
		},
		async sessionTotals(sessionId) {
			const [row] = await driver.query(
				`SELECT count(*) AS calls,
					sum(CASE WHEN status = 'done' THEN 0 ELSE 1 END) AS failed,
					sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
					sum(cache_read_tokens) AS cache_read_tokens, sum(cache_write_tokens) AS cache_write_tokens,
					sum(cost_usd) AS cost_usd
				FROM usage_calls WHERE session_id = ?`,
				[sessionId],
			);
			const sum = (value: unknown) => (value === null || value === undefined ? 0 : sqlNumber(value));
			return {
				calls: sum(row?.calls),
				failed: sum(row?.failed),
				inputTokens: sum(row?.input_tokens),
				outputTokens: sum(row?.output_tokens),
				cacheReadTokens: sum(row?.cache_read_tokens),
				cacheWriteTokens: sum(row?.cache_write_tokens),
				costUsd: sum(row?.cost_usd),
			};
		},
	};
}

/** `usage_calls` in another database (D1 on Cloudflare), which a shipper fills; migrated with `migrateUsage`. */
export function sqlUsageSink(driver: SqlDriver, options: { readonly now?: () => number } = {}): UsageSink {
	const now = options.now ?? Date.now;
	return {
		async write(records) {
			if (records.length === 0) return;
			const recordedAt = now();
			await driver.batch(records.map((record) => ({ sql: INSERT, params: values(record, recordedAt) })));
		},
	};
}

/**
 * The environment store in SQL, for SQLite and Postgres alike: each record a JSON document beside the columns it is
 * found by. A durable gateway keeps its environments here, so a restart still knows its machines and stops them when
 * they idle, rather than leaving them running at the provider. Run `migrateEnvironments` first.
 */
import type { EnvironmentEvent, EnvironmentGrant, EnvironmentLease } from "@kantel/contracts";
import type { SqlDriver } from "@kantel/sql";
import type { EnvironmentStore, StoredEnvironment } from "./store.ts";

/** Ended leases kept per environment for the console, beside the live ones. */
const LEASE_HISTORY = 50;

/** The store's tables. */
export function environmentsSchema(dialect: SqlDriver["dialect"]): string[] {
	const real = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS environments (
			id TEXT PRIMARY KEY,
			organisation_id TEXT NOT NULL,
			machine_id TEXT,
			data TEXT NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS environments_organisation ON environments (organisation_id)",
		"CREATE INDEX IF NOT EXISTS environments_machine ON environments (machine_id)",
		`CREATE TABLE IF NOT EXISTS environment_grants (
			id TEXT PRIMARY KEY,
			environment_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			data TEXT NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS environment_grants_environment ON environment_grants (environment_id)",
		"CREATE INDEX IF NOT EXISTS environment_grants_session ON environment_grants (session_id)",
		`CREATE TABLE IF NOT EXISTS environment_leases (
			id TEXT PRIMARY KEY,
			environment_id TEXT NOT NULL,
			session_id TEXT NOT NULL,
			acquired_at ${real} NOT NULL,
			ended_at ${real},
			data TEXT NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS environment_leases_environment ON environment_leases (environment_id, acquired_at)",
		"CREATE INDEX IF NOT EXISTS environment_leases_session ON environment_leases (session_id)",
		`CREATE TABLE IF NOT EXISTS environment_events (
			id TEXT PRIMARY KEY,
			environment_id TEXT NOT NULL,
			at ${real} NOT NULL,
			data TEXT NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS environment_events_environment ON environment_events (environment_id, at)",
	];
}

/** Creates the store's tables if they are missing. */
export async function migrateEnvironments(driver: SqlDriver): Promise<void> {
	await driver.batch(environmentsSchema(driver.dialect).map((text) => ({ sql: text })));
}

const parse = <T>(row: Record<string, unknown>): T => JSON.parse(String(row.data)) as T;

/** Upserts a row: SQLite and Postgres both take `ON CONFLICT (id) DO UPDATE`. */
function upsert(table: string, columns: readonly string[]): string {
	const updates = columns.filter((column) => column !== "id").map((column) => `${column} = excluded.${column}`);
	return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT (id) DO UPDATE SET ${updates.join(", ")}`;
}

const ENVIRONMENT_UPSERT = upsert("environments", ["id", "organisation_id", "machine_id", "data"]);
const GRANT_UPSERT = upsert("environment_grants", ["id", "environment_id", "session_id", "data"]);
const LEASE_UPSERT = upsert("environment_leases", [
	"id",
	"environment_id",
	"session_id",
	"acquired_at",
	"ended_at",
	"data",
]);

export function createSqlEnvironmentStore(driver: SqlDriver): EnvironmentStore {
	// An event's ID sorts by time, then by the order this process wrote them, so a history reads newest first.
	let counter = 0;
	const eventId = (at: number) =>
		`${String(Math.trunc(at)).padStart(15, "0")}-${String(counter++ % 1_000_000).padStart(6, "0")}-${crypto.randomUUID().slice(0, 8)}`;
	return {
		async get(id) {
			const rows = await driver.query("SELECT data FROM environments WHERE id = ?", [id]);
			return rows[0] === undefined ? undefined : parse<StoredEnvironment>(rows[0]);
		},
		async list(organisationId) {
			const rows =
				organisationId === undefined
					? await driver.query("SELECT data FROM environments ORDER BY id")
					: await driver.query("SELECT data FROM environments WHERE organisation_id = ? ORDER BY id", [organisationId]);
			return rows.map((row) => parse<StoredEnvironment>(row));
		},
		async byMachine(machineId) {
			const rows = await driver.query("SELECT data FROM environments WHERE machine_id = ?", [machineId]);
			return rows[0] === undefined ? undefined : parse<StoredEnvironment>(rows[0]);
		},
		async put(stored) {
			await driver.query(ENVIRONMENT_UPSERT, [
				stored.environment.id,
				stored.environment.organisationId,
				stored.machine?.machineId ?? null,
				JSON.stringify(stored),
			]);
		},
		async grants(environmentId) {
			const rows = await driver.query("SELECT data FROM environment_grants WHERE environment_id = ? ORDER BY id", [
				environmentId,
			]);
			return rows.map((row) => parse<EnvironmentGrant>(row));
		},
		async sessionGrants(sessionId) {
			const rows = await driver.query("SELECT data FROM environment_grants WHERE session_id = ? ORDER BY id", [
				sessionId,
			]);
			return rows.map((row) => parse<EnvironmentGrant>(row));
		},
		async putGrant(grant) {
			await driver.query(GRANT_UPSERT, [grant.id, grant.environmentId, grant.sessionId, JSON.stringify(grant)]);
		},
		async leases(environmentId) {
			const live = await driver.query(
				"SELECT data FROM environment_leases WHERE environment_id = ? AND ended_at IS NULL ORDER BY acquired_at",
				[environmentId],
			);
			const ended = await driver.query(
				"SELECT data FROM environment_leases WHERE environment_id = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT ?",
				[environmentId, LEASE_HISTORY],
			);
			return [...live, ...ended].map((row) => parse<EnvironmentLease>(row));
		},
		async sessionLeases(sessionId) {
			const rows = await driver.query("SELECT data FROM environment_leases WHERE session_id = ? ORDER BY acquired_at", [
				sessionId,
			]);
			return rows.map((row) => parse<EnvironmentLease>(row));
		},
		async putLease(lease) {
			await driver.query(LEASE_UPSERT, [
				lease.id,
				lease.environmentId,
				lease.sessionId,
				lease.acquiredAt,
				lease.endedAt ?? null,
				JSON.stringify(lease),
			]);
		},
		async events(environmentId, limit) {
			const rows = await driver.query(
				"SELECT data FROM environment_events WHERE environment_id = ? ORDER BY id DESC LIMIT ?",
				[environmentId, limit],
			);
			return rows.map((row) => parse<EnvironmentEvent>(row));
		},
		async appendEvent(environmentId, event) {
			await driver.query("INSERT INTO environment_events (id, environment_id, at, data) VALUES (?, ?, ?, ?)", [
				eventId(event.at),
				environmentId,
				event.at,
				JSON.stringify(event),
			]);
		},
	};
}

/**
 * `ModelProviderStore` on SQL (`@harbour/sql`): Postgres self-hosted, D1 on Cloudflare. One table,
 * `model_provider_connections`, with a row per organisation and provider connected; the connector and routes are one
 * JSON column. It never holds a key: the connector names its vault item.
 */
import { type Clock, isModelProviderId, type OrganisationId, systemClock } from "@harbour/contracts";
import type { SqlDialect, SqlDriver, SqlRow } from "@harbour/sql";
import type { ModelProviderStore, StoredModelProvider } from "./providers.ts";

/** The table, for `migrateModelProviders` or a target's own migrations. Every statement is idempotent. */
export function modelProvidersSchema(dialect: SqlDialect): readonly string[] {
	const time = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS model_provider_connections (
			organisation_id TEXT NOT NULL,
			provider_id TEXT NOT NULL,
			record TEXT NOT NULL,
			updated_at ${time} NOT NULL,
			PRIMARY KEY (organisation_id, provider_id)
		)`,
	];
}

export async function migrateModelProviders(driver: SqlDriver): Promise<void> {
	await driver.batch(modelProvidersSchema(driver.dialect).map((text) => ({ sql: text })));
}

interface ConnectionRow extends SqlRow {
	readonly organisation_id: unknown;
	readonly provider_id: unknown;
	readonly record: unknown;
}

/** What the `record` column holds. */
type RecordColumn = Pick<StoredModelProvider, "connector" | "routes">;

function storedOf(row: ConnectionRow): StoredModelProvider | undefined {
	const providerId = String(row.provider_id);
	// A provider this version doesn't know (one since removed) is left out rather than failing the whole list.
	if (!isModelProviderId(providerId)) return undefined;
	const record = JSON.parse(String(row.record)) as Partial<RecordColumn>;
	if (typeof record.connector !== "object" || record.connector === null) return undefined;
	return {
		organisationId: String(row.organisation_id),
		providerId,
		connector: record.connector,
		routes: Array.isArray(record.routes) ? record.routes : [],
	};
}

export interface SqlModelProviderStoreOptions {
	/** Stamps `updated_at`. Default the system clock. */
	readonly clock?: Clock;
}

/** `ModelProviderStore` on SQL. Run `migrateModelProviders` (or `modelProvidersSchema` in a target's migrations) first. */
export function createSqlModelProviderStore(
	driver: SqlDriver,
	options: SqlModelProviderStoreOptions = {},
): ModelProviderStore {
	const clock = options.clock ?? systemClock;
	const select = "SELECT organisation_id, provider_id, record FROM model_provider_connections";
	const order = "ORDER BY organisation_id, provider_id";
	return {
		async list(organisationId?: OrganisationId) {
			const rows =
				organisationId === undefined
					? await driver.query<ConnectionRow>(`${select} ${order}`)
					: await driver.query<ConnectionRow>(`${select} WHERE organisation_id = ? ${order}`, [organisationId]);
			return rows.map(storedOf).filter((each): each is StoredModelProvider => each !== undefined);
		},
		async save(stored) {
			const record: RecordColumn = { connector: stored.connector, routes: stored.routes };
			await driver.query(
				`INSERT INTO model_provider_connections (organisation_id, provider_id, record, updated_at) VALUES (?, ?, ?, ?)
				ON CONFLICT (organisation_id, provider_id) DO UPDATE SET record = excluded.record, updated_at = excluded.updated_at`,
				[stored.organisationId, stored.providerId, JSON.stringify(record), clock.now()],
			);
		},
		async remove(organisationId, providerId) {
			await driver.query("DELETE FROM model_provider_connections WHERE organisation_id = ? AND provider_id = ?", [
				organisationId,
				providerId,
			]);
		},
	};
}

/**
 * The relay's shared state: tunnel tickets (desktop, browser and SSH URLs) and exposed ports. It sits in the database
 * the hosts registry uses (Postgres self-hosted), so a URL the gateway gave out still works after a restart and on
 * every replica behind a load balancer; in memory with no database.
 *
 * No secret is kept: a ticket's row holds the SHA-256 of its secret half, and a gated port's row the SHA-256 of its
 * token. A row also names who it was given to (`grantee`, opaque JSON here), so access can end when theirs does.
 */
import type { SqlDriver } from "@kantel/sql";
import { sqlNumber } from "@kantel/sql";
import { clusterSchema } from "./cluster.ts";

export interface TicketRecord {
	/** The ticket's public half. */
	readonly id: string;
	/** The SHA-256 hex of its secret half. */
	readonly secretHash: string;
	readonly sandboxId: string;
	readonly port: number;
	/** Epoch milliseconds: no connection may start after. */
	readonly expiresAt: number;
	readonly createdAt: number;
	/** Who it was given to, as JSON; absent when nobody was named. */
	readonly grantee?: string;
	/** On a desktop ticket only: `control` or `view` (`tunnel.ts`'s `DesktopMode`). */
	readonly desktop?: string;
}

export interface ExposureRecord {
	/** `{port}-{subdomain}`: the name's first label. */
	readonly label: string;
	readonly sandboxId: string;
	readonly port: number;
	/** The SHA-256 hex of its token; absent when the port is public. */
	readonly tokenHash?: string;
	readonly createdAt: number;
	/** Who exposed it, as JSON; absent when nobody was named. */
	readonly grantee?: string;
}

export interface RelayStore {
	putTicket(ticket: TicketRecord): Promise<void>;
	getTicket(id: string): Promise<TicketRecord | undefined>;
	/** Forgets tickets that expired before `before`. */
	sweepTickets(before: number): Promise<void>;
	/** Inserts or replaces the exposure with its label. */
	putExposure(exposure: ExposureRecord): Promise<void>;
	getExposure(label: string): Promise<ExposureRecord | undefined>;
	exposuresOf(sandboxId: string): Promise<ExposureRecord[]>;
	/** Removes a sandbox's exposures of `port`, or all of them without one. */
	removeExposures(sandboxId: string, port?: number): Promise<void>;
}

/** The relay's state in memory: for a gateway with no database, and tests. */
export function createMemoryRelayStore(): RelayStore {
	const tickets = new Map<string, TicketRecord>();
	const exposures = new Map<string, ExposureRecord>();
	return {
		async putTicket(ticket) {
			tickets.set(ticket.id, { ...ticket });
		},
		async getTicket(id) {
			const ticket = tickets.get(id);
			return ticket === undefined ? undefined : { ...ticket };
		},
		async sweepTickets(before) {
			for (const [id, ticket] of tickets) if (ticket.expiresAt < before) tickets.delete(id);
		},
		async putExposure(exposure) {
			exposures.set(exposure.label, { ...exposure });
		},
		async getExposure(label) {
			const exposure = exposures.get(label);
			return exposure === undefined ? undefined : { ...exposure };
		},
		async exposuresOf(sandboxId) {
			return [...exposures.values()].filter((exposure) => exposure.sandboxId === sandboxId).map((e) => ({ ...e }));
		},
		async removeExposures(sandboxId, port) {
			for (const [label, exposure] of exposures) {
				if (exposure.sandboxId === sandboxId && (port === undefined || exposure.port === port)) exposures.delete(label);
			}
		},
	};
}

/** The relay's tables, for SQLite and Postgres alike. */
export function relaySchema(dialect: SqlDriver["dialect"]): string[] {
	const real = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS compute_relay_tickets (
			id TEXT PRIMARY KEY,
			secret_hash TEXT NOT NULL,
			sandbox_id TEXT NOT NULL,
			port INTEGER NOT NULL,
			expires_at ${real} NOT NULL,
			created_at ${real} NOT NULL,
			grantee TEXT,
			desktop TEXT
		)`,
		"CREATE INDEX IF NOT EXISTS compute_relay_tickets_expiry ON compute_relay_tickets (expires_at)",
		`CREATE TABLE IF NOT EXISTS compute_port_exposures (
			label TEXT PRIMARY KEY,
			sandbox_id TEXT NOT NULL,
			port INTEGER NOT NULL,
			token_hash TEXT,
			created_at ${real} NOT NULL,
			grantee TEXT
		)`,
		"CREATE INDEX IF NOT EXISTS compute_port_exposures_sandbox ON compute_port_exposures (sandbox_id, port)",
	];
}

/**
 * Creates the relay's tables, and the replicas' (`cluster.ts`), if they are missing. On Postgres it takes an advisory
 * lock first, so replicas starting together don't race to create them.
 */
export async function migrateRelay(driver: SqlDriver): Promise<void> {
	const statements = [...relaySchema(driver.dialect), ...clusterSchema(driver.dialect)].map((text) => ({ sql: text }));
	await driver.batch(
		driver.dialect === "postgres" ? [{ sql: "SELECT pg_advisory_xact_lock(7316102021)" }, ...statements] : statements,
	);
}

const optional = (value: unknown): string | undefined =>
	value === null || value === undefined ? undefined : String(value);

const ticketOf = (row: Record<string, unknown>): TicketRecord => {
	const grantee = optional(row.grantee);
	const desktop = optional(row.desktop);
	return {
		id: String(row.id),
		secretHash: String(row.secret_hash),
		sandboxId: String(row.sandbox_id),
		port: sqlNumber(row.port),
		expiresAt: sqlNumber(row.expires_at),
		createdAt: sqlNumber(row.created_at),
		...(grantee === undefined ? {} : { grantee }),
		...(desktop === undefined ? {} : { desktop }),
	};
};

const exposureOf = (row: Record<string, unknown>): ExposureRecord => {
	const tokenHash = optional(row.token_hash);
	const grantee = optional(row.grantee);
	return {
		label: String(row.label),
		sandboxId: String(row.sandbox_id),
		port: sqlNumber(row.port),
		createdAt: sqlNumber(row.created_at),
		...(tokenHash === undefined ? {} : { tokenHash }),
		...(grantee === undefined ? {} : { grantee }),
	};
};

/** The relay's state in SQL. Run `migrateRelay` first. */
export function createSqlRelayStore(driver: SqlDriver): RelayStore {
	return {
		async putTicket(ticket) {
			await driver.query(
				"INSERT INTO compute_relay_tickets (id, secret_hash, sandbox_id, port, expires_at, created_at, grantee, desktop) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				[
					ticket.id,
					ticket.secretHash,
					ticket.sandboxId,
					ticket.port,
					ticket.expiresAt,
					ticket.createdAt,
					ticket.grantee ?? null,
					ticket.desktop ?? null,
				],
			);
		},
		async getTicket(id) {
			const [row] = await driver.query("SELECT * FROM compute_relay_tickets WHERE id = ?", [id]);
			return row === undefined ? undefined : ticketOf(row);
		},
		async sweepTickets(before) {
			await driver.query("DELETE FROM compute_relay_tickets WHERE expires_at < ?", [before]);
		},
		async putExposure(exposure) {
			await driver.query(
				`INSERT INTO compute_port_exposures (label, sandbox_id, port, token_hash, created_at, grantee) VALUES (?, ?, ?, ?, ?, ?)
				ON CONFLICT (label) DO UPDATE SET sandbox_id = excluded.sandbox_id, port = excluded.port,
					token_hash = excluded.token_hash, created_at = excluded.created_at, grantee = excluded.grantee`,
				[
					exposure.label,
					exposure.sandboxId,
					exposure.port,
					exposure.tokenHash ?? null,
					exposure.createdAt,
					exposure.grantee ?? null,
				],
			);
		},
		async getExposure(label) {
			const [row] = await driver.query("SELECT * FROM compute_port_exposures WHERE label = ?", [label]);
			return row === undefined ? undefined : exposureOf(row);
		},
		async exposuresOf(sandboxId) {
			const rows = await driver.query("SELECT * FROM compute_port_exposures WHERE sandbox_id = ? ORDER BY label", [
				sandboxId,
			]);
			return rows.map(exposureOf);
		},
		async removeExposures(sandboxId, port) {
			if (port === undefined) {
				await driver.query("DELETE FROM compute_port_exposures WHERE sandbox_id = ?", [sandboxId]);
			} else {
				await driver.query("DELETE FROM compute_port_exposures WHERE sandbox_id = ? AND port = ?", [sandboxId, port]);
			}
		},
	};
}

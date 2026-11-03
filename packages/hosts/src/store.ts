/**
 * Where the host registry keeps its records: hosts, their one-time join tokens, and which host each sandbox is on.
 * In SQL (SQLite on D1 or a Durable Object, Postgres self-hosted) or in memory, behaving the same.
 *
 * Secrets are never stored: a join token's row and a host's row hold the SHA-256 of the token or credential. A join
 * token is spent by one conditional update, so two hosts racing with the same token can't both join.
 */
import type { SqlDriver, SqlValue } from "@kantel/sql";
import type { HostCapacity, HostFacts, SandboxTier } from "./protocol.ts";

export interface HostRecord {
	readonly id: string;
	readonly name: string;
	readonly labels: { readonly [key: string]: string };
	/** The credential's SHA-256, hex. */
	readonly credentialHash: string;
	readonly revoked: boolean;
	readonly draining: boolean;
	readonly joinedAt: number;
	readonly lastSeenAt?: number;
	/** As it last said in its hello. */
	readonly facts?: HostFacts;
	/** As it last said in a hello or heartbeat. */
	readonly capacity?: HostCapacity;
}

export interface JoinTokenRecord {
	readonly id: string;
	/** The token's SHA-256, hex. */
	readonly hash: string;
	readonly name?: string;
	readonly labels: { readonly [key: string]: string };
	readonly createdAt: number;
	readonly expiresAt: number;
	readonly usedAt?: number;
	readonly hostId?: string;
}

/** Which host a sandbox is on. A sandbox stays on its host: its disk and memory are there. */
export interface PlacementRecord {
	readonly sandboxId: string;
	readonly hostId: string;
	readonly tier: SandboxTier;
	readonly size: string;
	readonly owner?: string;
	readonly vcpus: number;
	readonly memoryMiB: number;
	readonly diskGiB: number;
	readonly state: string;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface HostStore {
	insertJoinToken(token: JoinTokenRecord): Promise<void>;
	/**
	 * Spends a token, once: resolves it when it was unspent and unexpired at `now`, marking it used by `hostId`, and
	 * undefined otherwise.
	 */
	spendJoinToken(hash: string, hostId: string, now: number): Promise<JoinTokenRecord | undefined>;
	insertHost(host: HostRecord): Promise<void>;
	getHost(id: string): Promise<HostRecord | undefined>;
	hostByCredential(hash: string): Promise<HostRecord | undefined>;
	/** Every host, revoked ones too, oldest first. */
	listHosts(): Promise<HostRecord[]>;
	putHost(host: HostRecord): Promise<void>;
	putPlacement(placement: PlacementRecord): Promise<void>;
	getPlacement(sandboxId: string): Promise<PlacementRecord | undefined>;
	placementsOn(hostId: string): Promise<PlacementRecord[]>;
	removePlacement(sandboxId: string): Promise<void>;
}

/** Records in memory, for tests and a deployment with no database. */
export function createMemoryHostStore(): HostStore {
	const tokens = new Map<string, JoinTokenRecord>();
	const hosts = new Map<string, HostRecord>();
	const placements = new Map<string, PlacementRecord>();
	const copy = <T>(value: T): T => structuredClone(value);
	return {
		async insertJoinToken(token) {
			tokens.set(token.hash, copy(token));
		},
		async spendJoinToken(hash, hostId, now) {
			const token = tokens.get(hash);
			if (token === undefined || token.usedAt !== undefined || token.expiresAt <= now) return undefined;
			const spent = { ...token, usedAt: now, hostId };
			tokens.set(hash, spent);
			return copy(spent);
		},
		async insertHost(host) {
			hosts.set(host.id, copy(host));
		},
		async getHost(id) {
			const host = hosts.get(id);
			return host === undefined ? undefined : copy(host);
		},
		async hostByCredential(hash) {
			const host = [...hosts.values()].find((candidate) => candidate.credentialHash === hash);
			return host === undefined ? undefined : copy(host);
		},
		async listHosts() {
			return [...hosts.values()].sort((a, b) => a.joinedAt - b.joinedAt).map(copy);
		},
		async putHost(host) {
			hosts.set(host.id, copy(host));
		},
		async putPlacement(placement) {
			placements.set(placement.sandboxId, copy(placement));
		},
		async getPlacement(sandboxId) {
			const placement = placements.get(sandboxId);
			return placement === undefined ? undefined : copy(placement);
		},
		async placementsOn(hostId) {
			return [...placements.values()]
				.filter((placement) => placement.hostId === hostId)
				.sort((a, b) => a.createdAt - b.createdAt)
				.map(copy);
		},
		async removePlacement(sandboxId) {
			placements.delete(sandboxId);
		},
	};
}

/** The registry's tables, for SQLite and Postgres alike. */
export function hostsSchema(dialect: SqlDriver["dialect"]): string[] {
	const real = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS compute_host_join_tokens (
			hash TEXT PRIMARY KEY,
			id TEXT NOT NULL UNIQUE,
			expires_at ${real} NOT NULL,
			used_at ${real},
			data TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS compute_hosts (
			id TEXT PRIMARY KEY,
			credential_hash TEXT NOT NULL UNIQUE,
			joined_at ${real} NOT NULL,
			data TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS compute_placements (
			sandbox_id TEXT PRIMARY KEY,
			host_id TEXT NOT NULL,
			created_at ${real} NOT NULL,
			data TEXT NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS compute_placements_host ON compute_placements (host_id, created_at)",
	];
}

/** Creates the registry's tables if they are missing. */
export async function migrateHosts(driver: SqlDriver): Promise<void> {
	await driver.batch(hostsSchema(driver.dialect).map((text) => ({ sql: text })));
}

const parse = <T>(row: Record<string, unknown>): T => JSON.parse(String(row.data)) as T;

/** Records in SQL. Run `migrateHosts` first. */
export function createSqlHostStore(driver: SqlDriver): HostStore {
	const upsert = (table: string, key: string, columns: string[], values: SqlValue[]) => {
		const set = columns.filter((column) => column !== key).map((column) => `${column} = excluded.${column}`);
		return driver.query(
			`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT (${key}) DO UPDATE SET ${set.join(", ")}`,
			values,
		);
	};
	return {
		async insertJoinToken(token) {
			await driver.query(
				"INSERT INTO compute_host_join_tokens (hash, id, expires_at, used_at, data) VALUES (?, ?, ?, NULL, ?)",
				[token.hash, token.id, token.expiresAt, JSON.stringify(token)],
			);
		},
		async spendJoinToken(hash, hostId, now) {
			const rows = await driver.query(
				"UPDATE compute_host_join_tokens SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ? RETURNING data",
				[now, hash, now],
			);
			if (rows[0] === undefined) return undefined;
			const spent: JoinTokenRecord = { ...parse<JoinTokenRecord>(rows[0]), usedAt: now, hostId };
			await driver.query("UPDATE compute_host_join_tokens SET data = ? WHERE hash = ?", [JSON.stringify(spent), hash]);
			return spent;
		},
		async insertHost(host) {
			await driver.query("INSERT INTO compute_hosts (id, credential_hash, joined_at, data) VALUES (?, ?, ?, ?)", [
				host.id,
				host.credentialHash,
				host.joinedAt,
				JSON.stringify(host),
			]);
		},
		async getHost(id) {
			const rows = await driver.query("SELECT data FROM compute_hosts WHERE id = ?", [id]);
			return rows[0] === undefined ? undefined : parse<HostRecord>(rows[0]);
		},
		async hostByCredential(hash) {
			const rows = await driver.query("SELECT data FROM compute_hosts WHERE credential_hash = ?", [hash]);
			return rows[0] === undefined ? undefined : parse<HostRecord>(rows[0]);
		},
		async listHosts() {
			const rows = await driver.query("SELECT data FROM compute_hosts ORDER BY joined_at, id");
			return rows.map((row) => parse<HostRecord>(row));
		},
		async putHost(host) {
			await upsert(
				"compute_hosts",
				"id",
				["id", "credential_hash", "joined_at", "data"],
				[host.id, host.credentialHash, host.joinedAt, JSON.stringify(host)],
			);
		},
		async putPlacement(placement) {
			await upsert(
				"compute_placements",
				"sandbox_id",
				["sandbox_id", "host_id", "created_at", "data"],
				[placement.sandboxId, placement.hostId, placement.createdAt, JSON.stringify(placement)],
			);
		},
		async getPlacement(sandboxId) {
			const rows = await driver.query("SELECT data FROM compute_placements WHERE sandbox_id = ?", [sandboxId]);
			return rows[0] === undefined ? undefined : parse<PlacementRecord>(rows[0]);
		},
		async placementsOn(hostId) {
			const rows = await driver.query(
				"SELECT data FROM compute_placements WHERE host_id = ? ORDER BY created_at, sandbox_id",
				[hostId],
			);
			return rows.map((row) => parse<PlacementRecord>(row));
		},
		async removePlacement(sandboxId) {
			await driver.query("DELETE FROM compute_placements WHERE sandbox_id = ?", [sandboxId]);
		},
	};
}

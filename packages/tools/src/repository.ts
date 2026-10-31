/**
 * Where the tool servers registry keeps its records: servers and their tunnel tokens, in SQL (SQLite on D1 or a Durable
 * Object, Postgres self-hosted) or in memory, behaving the same. A server's name is unique in its organisation by a
 * constraint, so two gateways over one database can't both register it; a server's changes are conditional on the
 * revision read, so a connect and an edit racing each other settle in favour of one and the other reads again.
 *
 * A token row holds the SHA-256 of the token, never the token: the token is shown once, when it is made.
 */
import type { ToolServer, ToolServerToken } from "@kantel/contracts";
import { type SqlDriver, type SqlValue, sqlNumber } from "@kantel/sql";

export interface StoredToolServer {
	readonly server: ToolServer;
	readonly revision: number;
}

export interface StoredToolServerToken {
	readonly token: ToolServerToken;
	readonly organisationId: string;
	/** The token's SHA-256, hex. */
	readonly hash: string;
}

export interface ToolServerRepository {
	get(id: string): Promise<StoredToolServer | undefined>;
	byName(organisationId: string, name: string): Promise<StoredToolServer | undefined>;
	/** The organisation's servers, by name. */
	list(organisationId: string): Promise<StoredToolServer[]>;
	/** Inserts at revision 1; resolves `false` if the ID or the name in the organisation is taken. */
	insert(server: ToolServer): Promise<boolean>;
	/** Replaces when the stored revision is still `revision`; resolves whether it did. */
	update(server: ToolServer, revision: number): Promise<boolean>;
	/** Removes the server and its tokens. */
	remove(id: string): Promise<void>;
	insertToken(token: StoredToolServerToken): Promise<void>;
	/** A server's tokens, oldest first. */
	tokens(toolServerId: string): Promise<StoredToolServerToken[]>;
	tokenByHash(hash: string): Promise<StoredToolServerToken | undefined>;
	/** Replaces a token's record (its `lastUsedAt`); its hash never changes. */
	updateToken(token: ToolServerToken): Promise<void>;
	/** Resolves whether there was one. */
	removeToken(id: string): Promise<boolean>;
}

/** Records in memory, for tests and a deployment with no database. */
export function createMemoryToolServerRepository(): ToolServerRepository {
	const servers = new Map<string, StoredToolServer>();
	const tokens = new Map<string, StoredToolServerToken>();
	const copy = (stored: StoredToolServer): StoredToolServer => structuredClone(stored);
	const byName = (organisationId: string, name: string) =>
		[...servers.values()].find(
			(stored) => stored.server.organisationId === organisationId && stored.server.name === name,
		);
	return {
		async get(id) {
			const found = servers.get(id);
			return found === undefined ? undefined : copy(found);
		},
		async byName(organisationId, name) {
			const found = byName(organisationId, name);
			return found === undefined ? undefined : copy(found);
		},
		async list(organisationId) {
			return [...servers.values()]
				.filter((stored) => stored.server.organisationId === organisationId)
				.sort((a, b) => (a.server.name < b.server.name ? -1 : a.server.name > b.server.name ? 1 : 0))
				.map(copy);
		},
		async insert(server) {
			if (servers.has(server.id) || byName(server.organisationId, server.name) !== undefined) return false;
			servers.set(server.id, { server: structuredClone(server), revision: 1 });
			return true;
		},
		async update(server, revision) {
			const found = servers.get(server.id);
			if (found === undefined || found.revision !== revision) return false;
			servers.set(server.id, { server: structuredClone(server), revision: revision + 1 });
			return true;
		},
		async remove(id) {
			servers.delete(id);
			for (const [tokenId, stored] of tokens) if (stored.token.toolServerId === id) tokens.delete(tokenId);
		},
		async insertToken(token) {
			tokens.set(token.token.id, structuredClone(token));
		},
		async tokens(toolServerId) {
			return [...tokens.values()]
				.filter((stored) => stored.token.toolServerId === toolServerId)
				.sort((a, b) => a.token.createdAt - b.token.createdAt || (a.token.id < b.token.id ? -1 : 1))
				.map((stored) => structuredClone(stored));
		},
		async tokenByHash(hash) {
			for (const stored of tokens.values()) if (stored.hash === hash) return structuredClone(stored);
			return undefined;
		},
		async updateToken(token) {
			const found = tokens.get(token.id);
			if (found !== undefined) tokens.set(token.id, { ...found, token: structuredClone(token) });
		},
		async removeToken(id) {
			return tokens.delete(id);
		},
	};
}

/** The registry's tables, for SQLite and Postgres alike. */
export function toolServersSchema(dialect: SqlDriver["dialect"]): string[] {
	const real = dialect === "postgres" ? "DOUBLE PRECISION" : "REAL";
	return [
		`CREATE TABLE IF NOT EXISTS tool_servers (
			id TEXT PRIMARY KEY,
			organisation_id TEXT NOT NULL,
			name TEXT NOT NULL,
			data TEXT NOT NULL,
			revision INTEGER NOT NULL,
			created_at ${real} NOT NULL,
			UNIQUE (organisation_id, name)
		)`,
		`CREATE TABLE IF NOT EXISTS tool_server_tokens (
			id TEXT PRIMARY KEY,
			tool_server_id TEXT NOT NULL,
			organisation_id TEXT NOT NULL,
			hash TEXT NOT NULL UNIQUE,
			data TEXT NOT NULL,
			created_at ${real} NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS tool_server_tokens_server ON tool_server_tokens (tool_server_id, created_at)",
	];
}

/** Creates the registry's tables if they are missing. */
export async function migrateToolServers(driver: SqlDriver): Promise<void> {
	await driver.batch(toolServersSchema(driver.dialect).map((text) => ({ sql: text })));
}

const SERVER_COLUMNS = "data, revision";
const TOKEN_COLUMNS = "organisation_id, hash, data";

function serverFrom(row: Record<string, unknown>): StoredToolServer {
	return { server: JSON.parse(String(row.data)) as ToolServer, revision: sqlNumber(row.revision) };
}

function tokenFrom(row: Record<string, unknown>): StoredToolServerToken {
	return {
		token: JSON.parse(String(row.data)) as ToolServerToken,
		organisationId: String(row.organisation_id),
		hash: String(row.hash),
	};
}

/** Records in SQL. Run `migrateToolServers` first. */
export function createSqlToolServerRepository(driver: SqlDriver): ToolServerRepository {
	const changed = async (sql: string, params: SqlValue[]): Promise<boolean> =>
		(await driver.query(`${sql} RETURNING id`, params)).length > 0;
	return {
		async get(id) {
			const rows = await driver.query(`SELECT ${SERVER_COLUMNS} FROM tool_servers WHERE id = ?`, [id]);
			return rows[0] === undefined ? undefined : serverFrom(rows[0]);
		},
		async byName(organisationId, name) {
			const rows = await driver.query(
				`SELECT ${SERVER_COLUMNS} FROM tool_servers WHERE organisation_id = ? AND name = ?`,
				[organisationId, name],
			);
			return rows[0] === undefined ? undefined : serverFrom(rows[0]);
		},
		async list(organisationId) {
			const rows = await driver.query(
				`SELECT ${SERVER_COLUMNS} FROM tool_servers WHERE organisation_id = ? ORDER BY name`,
				[organisationId],
			);
			return rows.map(serverFrom);
		},
		async insert(server) {
			// No conflict target, so a taken ID and a taken name both insert nothing.
			return changed(
				"INSERT INTO tool_servers (id, organisation_id, name, data, revision, created_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT DO NOTHING",
				[server.id, server.organisationId, server.name, JSON.stringify(server), server.createdAt],
			);
		},
		async update(server, revision) {
			return changed("UPDATE tool_servers SET data = ?, revision = ? WHERE id = ? AND revision = ?", [
				JSON.stringify(server),
				revision + 1,
				server.id,
				revision,
			]);
		},
		async remove(id) {
			await driver.batch([
				{ sql: "DELETE FROM tool_server_tokens WHERE tool_server_id = ?", params: [id] },
				{ sql: "DELETE FROM tool_servers WHERE id = ?", params: [id] },
			]);
		},
		async insertToken(stored) {
			await driver.query(
				"INSERT INTO tool_server_tokens (id, tool_server_id, organisation_id, hash, data, created_at) VALUES (?, ?, ?, ?, ?, ?)",
				[
					stored.token.id,
					stored.token.toolServerId,
					stored.organisationId,
					stored.hash,
					JSON.stringify(stored.token),
					stored.token.createdAt,
				],
			);
		},
		async tokens(toolServerId) {
			const rows = await driver.query(
				`SELECT ${TOKEN_COLUMNS} FROM tool_server_tokens WHERE tool_server_id = ? ORDER BY created_at, id`,
				[toolServerId],
			);
			return rows.map(tokenFrom);
		},
		async tokenByHash(hash) {
			const rows = await driver.query(`SELECT ${TOKEN_COLUMNS} FROM tool_server_tokens WHERE hash = ?`, [hash]);
			return rows[0] === undefined ? undefined : tokenFrom(rows[0]);
		},
		async updateToken(token) {
			await driver.query("UPDATE tool_server_tokens SET data = ? WHERE id = ?", [JSON.stringify(token), token.id]);
		},
		async removeToken(id) {
			return changed("DELETE FROM tool_server_tokens WHERE id = ?", [id]);
		},
	};
}

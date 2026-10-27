/**
 * The vault on Cloudflare (#13 on #17): `VaultDurableObjectCore` from `@harbour/vault-cloudflare` over the
 * `HarbourVault` Durable Object's SQLite, with its audit events in the stack's D1 audit store. Portable (no
 * `cloudflare:workers`), so the tests build it in Node over `node:sqlite`; `src/vault-object.ts` is the object.
 *
 * The object serves the vault's egress decision API (`@harbour/vault/egress-api`) at `/v1/egress/decisions` and
 * `/v1/connector-credentials`. Both are worker calls: only the egress gateway and the model gateway may make them, each
 * with its own shared key. Nothing a person or an agent holds opens them.
 *
 * Its secrets, as Worker secrets (the deploy workflow sets each one that exists as a repository secret):
 *
 * - `HARBOUR_VAULT_KEY`: the 256-bit key item values are sealed with, base64. Without it the vault answers every call
 *   `unavailable` (503) rather than run with a key that would not survive a restart.
 * - `HARBOUR_VAULT_MODEL_GATEWAY_TOKEN`, `HARBOUR_VAULT_EGRESS_GATEWAY_TOKEN`: each component's shared key for the
 *   egress decision API, at least 16 characters. A component without one is refused (`forbidden`).
 */

import { createSqlAuditStore, migrateAudit } from "@harbour/audit/sql";
import { type AuditSink, type Clock, HarbourError, type SystemContext, systemClock } from "@harbour/contracts";
import type { SqlDriver } from "@harbour/sql";
import { createSharedKeyAuthenticator, EGRESS_API_PATHS } from "@harbour/vault/egress-api";
import { type SqlStorageLike, VaultDurableObjectCore } from "@harbour/vault-cloudflare";

export interface VaultVars {
	readonly HARBOUR_VAULT_KEY?: string;
	readonly HARBOUR_VAULT_MODEL_GATEWAY_TOKEN?: string;
	readonly HARBOUR_VAULT_EGRESS_GATEWAY_TOKEN?: string;
}

/** The components that may call the egress decision API, and the secret holding each one's shared key. */
export const COMPONENT_TOKENS = {
	"model-gateway": "HARBOUR_VAULT_MODEL_GATEWAY_TOKEN",
	"egress-gateway": "HARBOUR_VAULT_EGRESS_GATEWAY_TOKEN",
} as const satisfies Readonly<Record<string, keyof VaultVars>>;

/** Whether the vault's egress decision API answers this path, rather than the stack. */
export function isVaultPath(path: string): boolean {
	return path === EGRESS_API_PATHS.decisions || path === EGRESS_API_PATHS.connectorCredentials;
}

const trimmed = (value: string | undefined): string => (value ?? "").trim();

/** Each component that has a shared key, by component name. */
export function componentKeys(vars: VaultVars): Record<string, string> {
	const keys: Record<string, string> = {};
	for (const [component, name] of Object.entries(COMPONENT_TOKENS)) {
		const token = trimmed(vars[name]);
		if (token !== "") keys[component] = token;
	}
	return keys;
}

export interface VaultCoreOptions {
	/** The object's `ctx.storage.sql`. */
	readonly sql: SqlStorageLike;
	/** The object's `ctx.storage.transactionSync`, bound to its storage. */
	readonly transactionSync: <T>(work: () => T) => T;
	/** Where the vault's audit events go: the stack's D1 audit store (`vaultAuditSink`). */
	readonly audit?: AuditSink;
	readonly vars: VaultVars;
	readonly clock?: Clock;
}

/**
 * Builds the vault over the object's SQLite, migrating its tables. Refuses (`unavailable`) without `HARBOUR_VAULT_KEY`,
 * and (`invalid`) with a key that is not 32 bytes of base64 or a component token shorter than 16 characters.
 */
export function createVaultCore(options: VaultCoreOptions): VaultDurableObjectCore {
	const cipherKey = trimmed(options.vars.HARBOUR_VAULT_KEY);
	if (cipherKey === "") throw new HarbourError("unavailable", "The vault has no key: set HARBOUR_VAULT_KEY");
	const keys = componentKeys(options.vars);
	return new VaultDurableObjectCore({
		sql: options.sql,
		transactionSync: options.transactionSync,
		cipherKey,
		clock: options.clock ?? systemClock,
		...(options.audit === undefined ? {} : { audit: options.audit }),
		// No component keys: the core's default authenticator refuses every call.
		...(Object.keys(keys).length === 0 ? {} : { authenticate: createSharedKeyAuthenticator({ keys }) }),
	});
}

/**
 * The vault's audit events, appended to the stack's audit store in D1, so the audit view shows them beside the rest.
 * The audit tables are made on first use (idempotently), in case the vault is called before the stack has started.
 */
export function vaultAuditSink(driver: SqlDriver, clock: Clock = systemClock): AuditSink {
	const store = createSqlAuditStore({ driver, clock });
	let migrated: Promise<void> | undefined;
	return {
		async append(ctx: SystemContext, events) {
			migrated ??= migrateAudit(driver).catch((error: unknown) => {
				migrated = undefined;
				throw error;
			});
			await migrated;
			await store.append(ctx, events);
		},
	};
}

/** The vault's answer when it cannot start: no detail beyond the code, as on the egress API. */
export function vaultUnavailable(error: unknown): Response {
	const reason = error instanceof HarbourError ? error.message : "The vault did not start";
	return Response.json(
		{ error: { code: "unavailable", message: reason } },
		{ status: 503, headers: { "cache-control": "no-store" } },
	);
}

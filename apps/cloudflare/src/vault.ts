/**
 * The vault on Cloudflare (#13 on #17): `VaultDurableObjectCore` from `@kantel/vault-cloudflare` over the
 * `KantelVault` Durable Object's SQLite, with its audit events in the stack's D1 audit store. Portable (no
 * `cloudflare:workers`), so the tests build it in Node over `node:sqlite`; `src/vault-object.ts` is the object.
 *
 * The object serves the vault's egress decision API (`@kantel/vault/egress-api`) at `/v1/egress/decisions` and
 * `/v1/connector-credentials`. Both are worker calls: only the egress gateway and the model gateway may make them, each
 * with its own shared key. Nothing a person or an agent holds opens them.
 *
 * Its secrets, as Worker secrets (the deploy workflow sets each one that exists as a repository secret):
 *
 * - `KANTEL_VAULT_KEY`: the 256-bit key item values are sealed with, base64. Without it the vault answers every call
 *   `unavailable` (503) rather than run with a key that would not survive a restart.
 * - `KANTEL_VAULT_MODEL_GATEWAY_TOKEN`, `KANTEL_VAULT_EGRESS_GATEWAY_TOKEN`: each component's shared key for the
 *   egress decision API, at least 16 characters. A component without one is refused (`forbidden`).
 *
 * The vault approval API (`/v1/vault/…`, `@kantel/vault/approval-api`) is not served here: `KantelStack` serves it,
 * since it signs people in and holds project access, and calls this object over RPC for each vault call
 * (`answerApprovalCall` here, `approvalVaultOver` there).
 */

import { createSqlAuditStore, migrateAudit } from "@kantel/audit/sql";
import type { CeilingVault } from "@kantel/connections/rules";
import {
	type AuditSink,
	type CallContext,
	type Clock,
	type ErrorCode,
	isKantelError,
	KantelError,
	PLATFORM_ORGANISATION,
	type SystemContext,
	systemClock,
	systemContext,
} from "@kantel/contracts";
import type { SqlDriver } from "@kantel/sql";
import type { ApprovalVault } from "@kantel/vault/approval-api";
import { createSharedKeyAuthenticator, EGRESS_API_PATHS } from "@kantel/vault/egress-api";
import { type SqlStorageLike, VaultDurableObjectCore } from "@kantel/vault-cloudflare";
import { CPA_HOST, CPA_INJECTION, cpaItemName, cpaKey, type ModelsVars } from "./models.ts";

export interface VaultVars {
	readonly KANTEL_VAULT_KEY?: string;
	readonly KANTEL_VAULT_MODEL_GATEWAY_TOKEN?: string;
	readonly KANTEL_VAULT_EGRESS_GATEWAY_TOKEN?: string;
}

/** The components that may call the egress decision API, and the secret holding each one's shared key. */
export const COMPONENT_TOKENS = {
	"model-gateway": "KANTEL_VAULT_MODEL_GATEWAY_TOKEN",
	"egress-gateway": "KANTEL_VAULT_EGRESS_GATEWAY_TOKEN",
} as const satisfies Readonly<Record<string, keyof VaultVars>>;

/** Whether the vault's egress decision API answers this path, rather than the stack. */
export function isVaultPath(path: string): boolean {
	return (Object.values(EGRESS_API_PATHS) as string[]).includes(path);
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
 * Builds the vault over the object's SQLite, migrating its tables. Refuses (`unavailable`) without `KANTEL_VAULT_KEY`,
 * and (`invalid`) with a key that is not 32 bytes of base64 or a component token shorter than 16 characters.
 */
export function createVaultCore(options: VaultCoreOptions): VaultDurableObjectCore {
	const cipherKey = trimmed(options.vars.KANTEL_VAULT_KEY);
	if (cipherKey === "") throw new KantelError("unavailable", "The vault has no key: set KANTEL_VAULT_KEY");
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

/** Where the vault object remembers the platform items it made, by name: its own key-value storage. */
export interface SeededItems {
	get(name: string): Promise<string | undefined>;
	put(name: string, itemId: string): Promise<void>;
}

const MIN_CPA_KEY_LENGTH = 16;

/** The caller that makes the deployment's platform items: Kantel's operator, outside every organisation. */
export const VAULT_SEED_CONTEXT: CallContext = {
	...systemContext("cloudflare.vault-seed"),
	organisationId: PLATFORM_ORGANISATION,
};

/**
 * The platform item holding CPA's key (`src/models.ts`): the one this object made for this key, or a new one, bound to
 * CPA's host. Refuses (`unavailable`) when the Worker has no `KANTEL_CPA_API_KEY`, or a short one: the model
 * gateway's redaction skips very short secrets, and the item's name would let a short key be guessed. A new key makes
 * a new item, as the vault has no way to replace an item's value, so the gateway never reads the old one again.
 */
export async function seedCpaItem(
	core: Pick<VaultDurableObjectCore, "vault">,
	seeded: SeededItems,
	vars: ModelsVars,
): Promise<string> {
	const key = cpaKey(vars);
	if (key === undefined) {
		throw new KantelError("unavailable", "The vault has no CLIProxyAPI key: set KANTEL_CPA_API_KEY");
	}
	// The deploy refuses a short key too (scripts/vault-secrets.ts); this catches one set another way.
	if (key.length < MIN_CPA_KEY_LENGTH || /\s/.test(key)) {
		throw new KantelError("unavailable", "KANTEL_CPA_API_KEY must be at least 16 characters with no spaces");
	}
	const name = await cpaItemName(key);
	const existing = await seeded.get(name);
	if (existing !== undefined) return existing;
	const item = await core.vault.putItem(VAULT_SEED_CONTEXT, {
		owner: { kind: "platform" },
		name,
		description: "CLIProxyAPI's client key, from the KANTEL_CPA_API_KEY Worker secret",
		hosts: [CPA_HOST],
		injection: CPA_INJECTION,
		value: key,
	});
	await seeded.put(name, item.id);
	return item.id;
}

/** The vault calls the approval API makes, and the only ones `KantelStack` may make over RPC. */
export const APPROVAL_METHODS = [
	"getProposal",
	"listProposals",
	"approvalView",
	"decide",
	"getItem",
	"getGrant",
	"listGrants",
	"revokeGrant",
	"getSessionAccess",
	"setSessionAccess",
	"getSessionUsage",
] as const satisfies readonly (keyof ApprovalVault)[];

export type ApprovalMethod = (typeof APPROVAL_METHODS)[number];

/**
 * One approval call's outcome as it crosses RPC. Workers RPC keeps an error's message but not its fields, so a
 * `KantelError`'s code travels in the result and is thrown again on the stack's side.
 */
export type ApprovalCallResult =
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly code: ErrorCode; readonly message: string };

/** The parts of a call context that cross RPC: an abort signal does not, and stays on the stack's side. */
function portableContext(ctx: CallContext): CallContext {
	return {
		actor: ctx.actor,
		organisationId: ctx.organisationId,
		...(ctx.projectId === undefined ? {} : { projectId: ctx.projectId }),
		...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
	};
}

/**
 * The VaultDO's side of an approval call from `KantelStack`. Only `APPROVAL_METHODS`; `vault` is a function so a vault
 * that cannot start (no key) answers `unavailable` like every other call. The caller's context is trusted as given: only
 * code in this Worker holds the binding, and the stack authenticated the person and checked project access first.
 */
export async function answerApprovalCall(
	vault: () => ApprovalVault,
	method: string,
	ctx: CallContext,
	args: readonly unknown[],
): Promise<ApprovalCallResult> {
	try {
		if (!(APPROVAL_METHODS as readonly string[]).includes(method)) {
			throw new KantelError("not_supported", `The vault takes no ${method} call from the stack`);
		}
		const call = vault()[method as ApprovalMethod] as (ctx: CallContext, ...rest: unknown[]) => Promise<unknown>;
		return { ok: true, value: await call(portableContext(ctx), ...args) };
	} catch (error) {
		if (isKantelError(error)) return { ok: false, code: error.code, message: error.message };
		console.error("kantel: a vault approval call failed", error instanceof Error ? error.message : "unknown error");
		return { ok: false, code: "unavailable", message: "The vault call failed" };
	}
}

/** `KantelStack`'s side: an `ApprovalVault` whose every call goes to the VaultDO through `send`. */
export function approvalVaultOver(
	send: (method: ApprovalMethod, ctx: CallContext, args: readonly unknown[]) => Promise<ApprovalCallResult>,
): ApprovalVault {
	const call =
		(method: ApprovalMethod) =>
		async (ctx: CallContext, ...args: unknown[]): Promise<never> => {
			ctx.signal?.throwIfAborted();
			// Optional arguments left out stay out: `undefined` would cross RPC as a value.
			while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
			const result = await send(method, portableContext(ctx), args);
			if (!result.ok) throw new KantelError(result.code, result.message);
			return result.value as never;
		};
	return Object.fromEntries(APPROVAL_METHODS.map((method) => [method, call(method)])) as unknown as ApprovalVault;
}

/** The ceiling calls the connections service makes over RPC (#332): the one ceiling bounds vault grants and rules. */
export const CEILING_METHODS = ["getCeiling", "setCeiling"] as const;
export type CeilingMethod = (typeof CEILING_METHODS)[number];

/**
 * The VaultDO's side of a ceiling call from `KantelStack`, which has signed the person in and checked they are the
 * organisation's admin (to set it). Answered as `answerApprovalCall` answers, codes kept.
 */
export async function answerCeilingCall(
	vault: () => CeilingVault,
	method: string,
	ctx: CallContext,
	args: readonly unknown[],
): Promise<ApprovalCallResult> {
	try {
		if (!(CEILING_METHODS as readonly string[]).includes(method)) {
			throw new KantelError("not_supported", `The vault takes no ${method} call from the stack`);
		}
		const call = vault()[method as CeilingMethod] as (ctx: CallContext, ...rest: unknown[]) => Promise<unknown>;
		return { ok: true, value: await call(portableContext(ctx), ...args) };
	} catch (error) {
		if (isKantelError(error)) return { ok: false, code: error.code, message: error.message };
		console.error("kantel: a vault ceiling call failed", error instanceof Error ? error.message : "unknown error");
		return { ok: false, code: "unavailable", message: "The vault call failed" };
	}
}

/** `KantelStack`'s side of the ceiling calls, for `vaultCeiling` in `@kantel/connections`. */
export function ceilingVaultOver(
	send: (method: CeilingMethod, ctx: CallContext, args: readonly unknown[]) => Promise<ApprovalCallResult>,
): CeilingVault {
	const call = async (method: CeilingMethod, ctx: CallContext, args: readonly unknown[]): Promise<never> => {
		const result = await send(method, portableContext(ctx), args);
		if (!result.ok) throw new KantelError(result.code, result.message);
		return result.value as never;
	};
	return {
		getCeiling: (ctx) => call("getCeiling", ctx, []),
		setCeiling: (ctx, routes) => call("setCeiling", ctx, [routes]),
	};
}

/** The vault's answer when it cannot start: no detail beyond the code, as on the egress API. */
export function vaultUnavailable(error: unknown): Response {
	const reason = error instanceof KantelError ? error.message : "The vault did not start";
	return Response.json(
		{ error: { code: "unavailable", message: reason } },
		{ status: 503, headers: { "cache-control": "no-store" } },
	);
}

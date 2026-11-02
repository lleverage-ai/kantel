/**
 * Model providers (TASK-4602): an organisation connects its own inference at run time, as the console's first-run
 * onboarding does, rather than only through the deployment's `KANTEL_MODEL_CONNECTORS` or `KANTEL_CPA_URL`.
 * docs/site/src/content/docs/api/model-providers.md documents the API.
 *
 * - **A connection is a model connector.** Saving one puts an organisation-owned `ModelConnector` in the model
 *   gateway's directory, on the provider's connector preset (`MODEL_PROVIDER_PRESETS`), so sessions call it through
 *   the gateway as they call a platform connector: same catalogue, keys, usage and audit.
 * - **The key goes into the vault.** An organisation item bound to the base URL's host, made with the caller's own
 *   context, so the vault checks they are an admin. The connector names the item; nothing here keeps the key, and no
 *   answer carries it. A new key makes a new item; the vault has no way to replace an item's value.
 * - **The default model is the organisation's `default` route**, which the `assistant` profile names and which
 *   replaces the deployment's `default` for the organisation's sessions (nearest owner wins).
 * - **Kept in the store** (SQL on durable components, memory otherwise) and put back in the directory at start
 *   (`restore`), as the gateway's directory is in memory.
 *
 * Reading the state needs viewer across the organisation; everything else needs an organisation admin.
 */

import { createRouter, modelProviderRoutes } from "@kantel/api";
import {
	type CallContext,
	CLOUDFLARE_ID,
	type Clock,
	type ConnectorModels,
	cloudflareAiGatewayBaseUrl,
	KantelError,
	MODEL_PROVIDER_PRESETS,
	MODEL_PROVIDERS,
	type ModelConnector,
	type ModelConnectors,
	type ModelGateway,
	type ModelProvider,
	type ModelProviderConnection,
	type ModelProviderDefault,
	type ModelProviderInput,
	type ModelProviderModel,
	type ModelProvidersState,
	type ProjectAccess,
	systemContext,
} from "@kantel/contracts";
import { MODEL_GATEWAY_COMPONENT } from "@kantel/models/gateway";
import { listProviderModels } from "@kantel/models/providers";
import { errorResponse } from "@kantel/runtime/http";
import type { SqlDriver } from "@kantel/sql";
import type { KantelVault } from "@kantel/vault/engine";

/** The route the organisation's default model is: the one the `assistant` profile names. */
export const DEFAULT_ROUTE_NAME = "default";

/** A connection ID: what a connector ID may be. */
const CONNECTION_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 4096;

/** One saved connection, beside the connector it is. */
export interface StoredModelProvider {
	readonly organisationId: string;
	readonly connection: ModelProviderConnection;
	readonly connector: Omit<ModelConnector, "createdAt" | "updatedAt">;
}

export interface ModelProviderStore {
	/** An organisation's connections, or every organisation's (for `restore`). */
	list(organisationId?: string): Promise<readonly StoredModelProvider[]>;
	get(organisationId: string, id: string): Promise<StoredModelProvider | undefined>;
	put(stored: StoredModelProvider): Promise<void>;
	remove(organisationId: string, id: string): Promise<void>;
	getDefault(organisationId: string): Promise<ModelProviderDefault | undefined>;
	/** Every organisation's default, for `restore`. */
	defaults(): Promise<readonly { readonly organisationId: string; readonly value: ModelProviderDefault }[]>;
	putDefault(organisationId: string, value: ModelProviderDefault): Promise<void>;
	removeDefault(organisationId: string): Promise<void>;
}

export function createMemoryModelProviderStore(): ModelProviderStore {
	const connections = new Map<string, StoredModelProvider>();
	const defaults = new Map<string, ModelProviderDefault>();
	const key = (organisationId: string, id: string) => `${organisationId}\u0000${id}`;
	return {
		async list(organisationId) {
			return [...connections.values()]
				.filter((stored) => organisationId === undefined || stored.organisationId === organisationId)
				.sort((a, b) => a.connection.id.localeCompare(b.connection.id));
		},
		async get(organisationId, id) {
			return connections.get(key(organisationId, id));
		},
		async put(stored) {
			connections.set(key(stored.organisationId, stored.connection.id), stored);
		},
		async remove(organisationId, id) {
			connections.delete(key(organisationId, id));
		},
		async getDefault(organisationId) {
			return defaults.get(organisationId);
		},
		async defaults() {
			return [...defaults.entries()].map(([organisationId, value]) => ({ organisationId, value }));
		},
		async putDefault(organisationId, value) {
			defaults.set(organisationId, value);
		},
		async removeDefault(organisationId) {
			defaults.delete(organisationId);
		},
	};
}

/** The store's tables, for SQLite and Postgres alike: each record a JSON document beside the columns it is found by. */
export function modelProvidersSchema(): string[] {
	return [
		`CREATE TABLE IF NOT EXISTS model_provider_connections (
			organisation_id TEXT NOT NULL,
			id TEXT NOT NULL,
			data TEXT NOT NULL,
			PRIMARY KEY (organisation_id, id)
		)`,
		`CREATE TABLE IF NOT EXISTS model_provider_defaults (
			organisation_id TEXT PRIMARY KEY,
			data TEXT NOT NULL
		)`,
	];
}

export async function migrateModelProviders(driver: SqlDriver): Promise<void> {
	await driver.batch(modelProvidersSchema().map((text) => ({ sql: text })));
}

export function createSqlModelProviderStore(driver: SqlDriver): ModelProviderStore {
	const parse = <T>(row: { readonly [column: string]: unknown }): T => JSON.parse(String(row.data)) as T;
	return {
		async list(organisationId) {
			const rows =
				organisationId === undefined
					? await driver.query("SELECT data FROM model_provider_connections ORDER BY organisation_id, id")
					: await driver.query("SELECT data FROM model_provider_connections WHERE organisation_id = ? ORDER BY id", [
							organisationId,
						]);
			return rows.map((row) => parse<StoredModelProvider>(row));
		},
		async get(organisationId, id) {
			const rows = await driver.query(
				"SELECT data FROM model_provider_connections WHERE organisation_id = ? AND id = ?",
				[organisationId, id],
			);
			return rows[0] === undefined ? undefined : parse<StoredModelProvider>(rows[0]);
		},
		async put(stored) {
			await driver.query(
				"INSERT INTO model_provider_connections (organisation_id, id, data) VALUES (?, ?, ?) ON CONFLICT (organisation_id, id) DO UPDATE SET data = excluded.data",
				[stored.organisationId, stored.connection.id, JSON.stringify(stored)],
			);
		},
		async remove(organisationId, id) {
			await driver.query("DELETE FROM model_provider_connections WHERE organisation_id = ? AND id = ?", [
				organisationId,
				id,
			]);
		},
		async getDefault(organisationId) {
			const rows = await driver.query("SELECT data FROM model_provider_defaults WHERE organisation_id = ?", [
				organisationId,
			]);
			return rows[0] === undefined ? undefined : parse<ModelProviderDefault>(rows[0]);
		},
		async defaults() {
			const rows = await driver.query(
				"SELECT organisation_id, data FROM model_provider_defaults ORDER BY organisation_id",
			);
			return rows.map((row) => ({
				organisationId: String(row.organisation_id),
				value: parse<ModelProviderDefault>(row),
			}));
		},
		async putDefault(organisationId, value) {
			await driver.query(
				"INSERT INTO model_provider_defaults (organisation_id, data) VALUES (?, ?) ON CONFLICT (organisation_id) DO UPDATE SET data = excluded.data",
				[organisationId, JSON.stringify(value)],
			);
		},
		async removeDefault(organisationId) {
			await driver.query("DELETE FROM model_provider_defaults WHERE organisation_id = ?", [organisationId]);
		},
	};
}

/** What the service needs of the model gateway (`PlatformModelGateway`, models.ts). */
export interface ModelProvidersGateway {
	/** The gateway's connector directory, built on demand. */
	directory(): Promise<ModelConnectors>;
	/** The gateway's model API, for the console's connector list (`GET /v1/connectors`). */
	modelGateway(): Promise<ModelGateway>;
	/** Lets the gateway reach `baseUrl`'s origin: it reaches only its connectors' origins. */
	allowOrigin(baseUrl: string): void;
	/** The deployment's own `default` route, if it configured one. */
	readonly platformDefault?: { readonly connectorId: string; readonly modelId: string };
	/** How the gateway reaches upstreams, and so how a test does. Default the global fetch. */
	readonly fetch?: typeof fetch;
}

export interface ModelProvidersOptions {
	readonly store: ModelProviderStore;
	readonly access: () => ProjectAccess;
	readonly vault: () => KantelVault | undefined;
	readonly gateway: ModelProvidersGateway;
	/** How a test reaches the provider. Default the global fetch. */
	readonly fetch?: typeof fetch;
	readonly clock?: Clock;
}

export interface ModelProviders {
	state(ctx: CallContext): Promise<ModelProvidersState>;
	test(
		ctx: CallContext,
		input: ModelProviderInput & { readonly connectionId?: string },
	): Promise<readonly ModelProviderModel[]>;
	put(ctx: CallContext, id: string, input: ModelProviderInput): Promise<ModelProviderConnection>;
	remove(ctx: CallContext, id: string): Promise<void>;
	models(ctx: CallContext, id: string): Promise<readonly ModelProviderModel[]>;
	setDefault(
		ctx: CallContext,
		input: { readonly connectionId: string; readonly modelId: string },
	): Promise<ModelProviderDefault>;
	/** Puts every saved connection and default back in the gateway's directory: at start, after the gateway's seed. */
	restore(): Promise<void>;
	/** The connectors the caller sees and their models, for the console's Models page (`GET /v1/connectors`). */
	connectorModels(ctx: CallContext, projectId: string): Promise<readonly ConnectorModels[]>;
	/** Whether the organisation's sessions have a default model: its own, or the deployment's. */
	configured(organisationId: string): Promise<boolean>;
	/** What to do once an organisation has a default model, such as give the bootstrap project its `assistant`. */
	onDefault(hook: (organisationId: string) => Promise<void>): void;
}

const organisationOf = (ctx: CallContext): string => {
	if (typeof ctx.organisationId !== "string" || ctx.organisationId === "") {
		throw new KantelError("forbidden", "Sign in to an organisation first");
	}
	return ctx.organisationId;
};

/** The base URL a connection calls, from what the caller sent and the provider's preset. */
export function providerBaseUrl(input: ModelProviderInput): {
	readonly baseUrl: string;
	readonly accountId?: string;
	readonly gatewayId?: string;
} {
	if (!(MODEL_PROVIDERS as readonly unknown[]).includes(input.provider)) {
		throw new KantelError("invalid", `provider must be one of ${MODEL_PROVIDERS.join(", ")}`);
	}
	const preset = MODEL_PROVIDER_PRESETS[input.provider];
	if (preset.baseUrl === "cloudflare") {
		const accountId = input.accountId?.trim() ?? "";
		const gatewayId = input.gatewayId?.trim() || "default";
		if (!CLOUDFLARE_ID.test(accountId)) throw new KantelError("invalid", "Give your Cloudflare account ID");
		if (!CLOUDFLARE_ID.test(gatewayId)) throw new KantelError("invalid", "The gateway ID is letters, digits, - and _");
		return { baseUrl: cloudflareAiGatewayBaseUrl(accountId, gatewayId), accountId, gatewayId };
	}
	if (preset.baseUrl === "fixed") return { baseUrl: preset.defaultBaseUrl ?? "" };
	const given = input.baseUrl?.trim() || preset.defaultBaseUrl || "";
	let url: URL;
	try {
		url = new URL(given);
	} catch {
		throw new KantelError("invalid", "The base URL must be an absolute http or https URL");
	}
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
		throw new KantelError("invalid", "The base URL must be an http or https URL, with no credentials in it");
	}
	if (url.search !== "" || url.hash !== "") throw new KantelError("invalid", "The base URL takes no query or fragment");
	return { baseUrl: url.toString().replace(/\/+$/, "") };
}

const hostOf = (baseUrl: string) => new URL(baseUrl).hostname.toLowerCase();

function assertKey(key: unknown): asserts key is string {
	if (typeof key !== "string" || key.trim().length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
		throw new KantelError("invalid", `The key must be ${MIN_KEY_LENGTH} to ${MAX_KEY_LENGTH} characters`);
	}
}

export function createModelProviders(options: ModelProvidersOptions): ModelProviders {
	const { store, gateway } = options;
	let defaultHook: ((organisationId: string) => Promise<void>) | undefined;
	const fetcher = options.fetch ?? gateway.fetch;
	const now = () => new Date(options.clock?.now() ?? Date.now()).toISOString();
	const vault = (): KantelVault => {
		const found = options.vault();
		if (found === undefined) {
			throw new KantelError("unavailable", "Model provider keys are kept in the vault: set KANTEL_VAULT_CIPHER_KEY");
		}
		return found;
	};
	const requireAdmin = (ctx: CallContext, operation: string) =>
		options.access().require(ctx, { needed: "admin", operation });
	const directoryContext = (organisationId: string): CallContext => ({
		...systemContext("model-providers"),
		organisationId,
	});

	/** The saved key of a connection, read as the gateway reads it, for a test or a model list. */
	async function savedKey(stored: StoredModelProvider, baseUrl: string): Promise<string> {
		if (hostOf(baseUrl) !== hostOf(stored.connection.baseUrl)) {
			throw new KantelError("invalid", "The saved key is for another host: enter the key again");
		}
		const credential = await vault().readConnectorCredential(
			{ ...systemContext(MODEL_GATEWAY_COMPONENT), organisationId: stored.organisationId },
			{
				connectorId: stored.connector.id,
				owner: stored.connector.owner,
				vaultItemId: stored.connector.vaultItemId,
				baseUrl,
				scope: {
					organisationId: stored.organisationId,
					agentId: "console",
					sessionId: `model-provider-test-${crypto.randomUUID()}`,
				},
			},
		);
		return credential.value;
	}

	async function listWith(provider: ModelProvider, baseUrl: string, key: string) {
		return listProviderModels({
			preset: MODEL_PROVIDER_PRESETS[provider].connectorPreset,
			baseUrl,
			key,
			...(fetcher === undefined ? {} : { fetch: fetcher }),
		});
	}

	const found = async (organisationId: string, id: string) => {
		const stored = await store.get(organisationId, id);
		if (stored === undefined) throw new KantelError("not_found", `There's no model provider connection ${id}`);
		return stored;
	};

	return {
		async state(ctx) {
			const organisationId = organisationOf(ctx);
			// Whether there is a model is anyone's in the organisation to know, a project's operator's included: the console
			// asks to choose between onboarding and "ask an admin". The connections are the organisation's viewers' to see.
			const access = options.access();
			const inProject =
				ctx.projectId !== undefined && (await access.allows(ctx, { needed: "viewer", projectId: ctx.projectId }));
			const viewer = await access.allows(ctx, { needed: "viewer" });
			if (!viewer && !inProject) {
				await access.require(ctx, { needed: "viewer", operation: "model-providers.read" });
			}
			const canManage = await access.allows(ctx, { needed: "admin" });
			const connections = viewer ? (await store.list(organisationId)).map((stored) => stored.connection) : [];
			const chosen = await store.getDefault(organisationId);
			return {
				configured: chosen !== undefined || gateway.platformDefault !== undefined,
				canManage,
				connections,
				...(chosen === undefined ? {} : { default: chosen }),
				...(gateway.platformDefault === undefined ? {} : { platformDefault: gateway.platformDefault }),
			};
		},

		async test(ctx, input) {
			const organisationId = organisationOf(ctx);
			await requireAdmin(ctx, "model-providers.test");
			const { baseUrl } = providerBaseUrl(input);
			let key: string;
			if (input.apiKey !== undefined && input.apiKey !== "") {
				assertKey(input.apiKey);
				key = input.apiKey;
			} else if (input.connectionId !== undefined) {
				key = await savedKey(await found(organisationId, input.connectionId), baseUrl);
			} else {
				throw new KantelError("invalid", "Give the key to test with");
			}
			return listWith(input.provider, baseUrl, key);
		},

		async put(ctx, id, input) {
			const organisationId = organisationOf(ctx);
			await requireAdmin(ctx, "model-providers.put");
			if (!CONNECTION_ID.test(id)) {
				throw new KantelError("invalid", "A connection ID is lowercase letters, digits and -, up to 64 characters");
			}
			const where = providerBaseUrl(input);
			const preset = MODEL_PROVIDER_PRESETS[input.provider];
			const existing = await store.get(organisationId, id);
			const directory = await gateway.directory();
			if (existing === undefined) {
				// Connector IDs are unique across the platform: not one the deployment configured, nor another organisation's.
				const taken = await directory.getConnector(directoryContext(organisationId), id).then(
					() => true,
					() => false,
				);
				if (taken) throw new KantelError("conflict", `Connector ${id} exists already: choose another ID`);
			}
			let vaultItemId: string;
			if (input.apiKey !== undefined && input.apiKey !== "") {
				assertKey(input.apiKey);
				const item = await vault().putItem(ctx, {
					owner: { kind: "organisation", organisationId },
					name: `model-provider-${id}-${Date.now().toString(36)}`,
					description: `${preset.label} key for model provider connection ${id}`,
					hosts: [hostOf(where.baseUrl)],
					injection: { header: "Authorization", template: "Bearer {key}" },
					value: input.apiKey,
				});
				vaultItemId = item.id;
			} else if (existing !== undefined && hostOf(existing.connection.baseUrl) === hostOf(where.baseUrl)) {
				vaultItemId = existing.connector.vaultItemId;
			} else {
				throw new KantelError(
					"invalid",
					existing === undefined ? "Give the provider's key" : "The base URL's host changed: enter the key again",
				);
			}
			const connector: Omit<ModelConnector, "createdAt" | "updatedAt"> = {
				id,
				owner: { kind: "organisation", organisationId },
				preset: preset.connectorPreset,
				baseUrl: where.baseUrl,
				vaultItemId,
				catalogue: { refresh: "gateway" },
			};
			gateway.allowOrigin(where.baseUrl);
			await directory.putConnector(ctx, connector);
			const at = now();
			const connection: ModelProviderConnection = {
				id,
				provider: input.provider,
				baseUrl: where.baseUrl,
				...(where.accountId === undefined ? {} : { accountId: where.accountId }),
				...(where.gatewayId === undefined ? {} : { gatewayId: where.gatewayId }),
				vaultItemId,
				createdAt: existing?.connection.createdAt ?? at,
				updatedAt: at,
			};
			await store.put({ organisationId, connection, connector });
			return connection;
		},

		async remove(ctx, id) {
			const organisationId = organisationOf(ctx);
			await requireAdmin(ctx, "model-providers.remove");
			await found(organisationId, id);
			const directory = await gateway.directory();
			const chosen = await store.getDefault(organisationId);
			if (chosen?.connectionId === id) {
				await directory.deleteRoute(ctx, { kind: "organisation", organisationId }, DEFAULT_ROUTE_NAME).catch(() => {});
				await store.removeDefault(organisationId);
			}
			await directory.deleteConnector(ctx, id).catch((error: unknown) => {
				if (!(error instanceof KantelError && error.code === "not_found")) throw error;
			});
			await store.remove(organisationId, id);
		},

		async models(ctx, id) {
			const organisationId = organisationOf(ctx);
			await requireAdmin(ctx, "model-providers.models");
			const stored = await found(organisationId, id);
			return listWith(
				stored.connection.provider,
				stored.connection.baseUrl,
				await savedKey(stored, stored.connection.baseUrl),
			);
		},

		async setDefault(ctx, input) {
			const organisationId = organisationOf(ctx);
			await requireAdmin(ctx, "model-providers.default");
			if (typeof input.connectionId !== "string" || typeof input.modelId !== "string") {
				throw new KantelError("invalid", "Name the connection and the model: { connectionId, modelId }");
			}
			if (input.modelId === "" || /[\s:]/.test(input.modelId)) {
				throw new KantelError("invalid", "A model ID has no spaces or colons");
			}
			await found(organisationId, input.connectionId);
			const directory = await gateway.directory();
			await directory.putRoute(ctx, {
				name: DEFAULT_ROUTE_NAME,
				owner: { kind: "organisation", organisationId },
				connectorId: input.connectionId,
				modelId: input.modelId,
			});
			const value: ModelProviderDefault = {
				connectionId: input.connectionId,
				modelId: input.modelId,
				updatedAt: now(),
			};
			await store.putDefault(organisationId, value);
			await defaultHook?.(organisationId);
			return value;
		},

		async connectorModels(ctx, projectId) {
			return (await gateway.modelGateway()).listConnectorModels(ctx, { projectId });
		},

		async configured(organisationId) {
			return gateway.platformDefault !== undefined || (await store.getDefault(organisationId)) !== undefined;
		},

		onDefault(hook) {
			defaultHook = hook;
		},

		async restore() {
			const stored = await store.list();
			if (stored.length === 0) return;
			const directory = await gateway.directory();
			for (const { organisationId, connector } of stored) {
				gateway.allowOrigin(connector.baseUrl);
				await directory.putConnector(directoryContext(organisationId), connector);
			}
			for (const { organisationId, value } of await store.defaults()) {
				await directory.putRoute(directoryContext(organisationId), {
					name: DEFAULT_ROUTE_NAME,
					owner: { kind: "organisation", organisationId },
					connectorId: value.connectionId,
					modelId: value.modelId,
				});
			}
		},
	};
}
/** The console's connector list, as Cloudflare's gateway serves it (apps/cloudflare/src/connectors.ts). */
export const CONNECTORS_PATH = "/v1/connectors";

export const MODEL_PROVIDERS_BASE = "/v1/model-providers";
/** The most a request's JSON body may be: a key and a few short fields. */
const BODY_LIMIT = 16 * 1024;

export const isModelProvidersPath = (path: string) =>
	path === CONNECTORS_PATH || path === MODEL_PROVIDERS_BASE || path.startsWith(`${MODEL_PROVIDERS_BASE}/`);

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * The model providers API (`@kantel/api`'s `modelProviderRoutes`, docs/site/src/content/docs/api/model-providers.md),
 * and `GET /v1/connectors?projectId=`: the connectors the caller sees and their models, as Cloudflare's gateway
 * answers the console's Models page.
 */
export function createModelProvidersApi(options: {
	readonly providers: ModelProviders;
	readonly authenticate: (request: Request) => Promise<CallContext>;
}): (request: Request) => Promise<Response> {
	const { providers } = options;
	const router = createRouter(
		modelProviderRoutes,
		{
			getModelProviders: (ctx: CallContext) => providers.state(ctx),
			testModelProvider: async (ctx: CallContext, { body }) => ({ items: await providers.test(ctx, body) }),
			putModelProviderConnection: (ctx: CallContext, { params, body }) => providers.put(ctx, params.connectionId, body),
			deleteModelProviderConnection: async (ctx: CallContext, { params }) => {
				await providers.remove(ctx, params.connectionId);
				return undefined;
			},
			listModelProviderModels: async (ctx: CallContext, { params }) => ({
				items: await providers.models(ctx, params.connectionId),
			}),
			setModelProviderDefault: (ctx: CallContext, { body }) => providers.setDefault(ctx, body),
		},
		{ maxBodyBytes: BODY_LIMIT },
	);
	return async (request) => {
		try {
			const url = new URL(request.url);
			if (url.pathname === CONNECTORS_PATH) {
				if (request.method !== "GET") throw new KantelError("invalid", "GET only");
				const projectId = url.searchParams.get("projectId") ?? "";
				if (projectId === "") throw new KantelError("invalid", "Name the project: ?projectId=");
				const ctx = await options.authenticate(request);
				return json({ items: await providers.connectorModels(ctx, projectId) });
			}
			const ctx = await options.authenticate(request);
			return (await router(ctx, request)) ?? errorResponse(new KantelError("not_found", "There's no such route"));
		} catch (error) {
			return errorResponse(error);
		}
	};
}

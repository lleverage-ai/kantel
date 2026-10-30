/**
 * Model providers (`ModelProviders`, contracts/model-providers.ts) over the connector directory, the vault and,
 * for subscriptions, CLIProxyAPI's management API (`./cpa-management.ts`). It is what onboarding and a host app call to
 * connect the models an organisation's agents run on.
 *
 * - **A key provider**: the key becomes an organisation vault item (`model-<provider>-<6 hex>`) bound to the base URL's
 *   host, with the preset's key header as its injection rule; then the organisation connector `org-<provider>` names
 *   that item, with a route named after the provider and, when the organisation has no `default` route of its own (or
 *   the caller asks), `default` too. The key is never verified against the provider, returned or audited.
 * - **A subscription**: signed in through CPA, which keeps the tokens. The sign-in's ID is CPA's `state`. Its
 *   connection is read off CPA's credential files and served by the platform's CPA connector.
 * - Reading needs an organisation-wide viewer; everything else an organisation-wide admin, which no agent is. `system`
 *   passes. Each change is audited with source `models`.
 * - A `ModelProviderStore` keeps each connection's connector and routes (never a key), so a gateway whose directory is
 *   in memory can put them back after a restart (`replayModelProviders`).
 */
import {
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	type ConnectorPreset,
	type DefaultModelRoute,
	HarbourError,
	type InjectionRule,
	isModelProviderId,
	isSystemActor,
	type JsonValue,
	MODEL_PROVIDER_IDS,
	type ModelConnector,
	type ModelConnectors,
	type ModelProvider,
	type ModelProviderAuth,
	type ModelProviderConnection,
	type ModelProviderId,
	type ModelProviders,
	type ModelRoute,
	type ModelSignIn,
	type OrganisationId,
	type ProjectAccess,
	requireSystem,
	type SystemContext,
	systemClock,
	systemContext,
	type Vault,
} from "@harbour/contracts";
import type { CpaAuthFile, CpaAuthProvider, CpaAuthStatus, CpaManagement } from "./cpa-management.ts";
import { allPages } from "./page.ts";
import { presetSpec } from "./presets.ts";

/** One provider as Harbour offers it. */
export interface ModelProviderSpec {
	readonly id: ModelProviderId;
	readonly name: string;
	readonly description: string;
	readonly auth: ModelProviderAuth;
	readonly preset: ConnectorPreset;
	/** For a key provider: the base URL unless the caller names one. Absent when the caller must. */
	readonly baseUrl?: string;
	/** For a key provider: the model its route serves unless the caller names one. */
	readonly defaultModel?: string;
	readonly keyUrl?: string;
	readonly keyPrefix?: string;
	/** For a subscription: the provider CPA's management API signs in, and the names its credential files carry. */
	readonly cpa?: { readonly provider: CpaAuthProvider; readonly files: readonly string[] };
}

export const MODEL_PROVIDER_SPECS: { readonly [id in ModelProviderId]: ModelProviderSpec } = {
	claude: {
		id: "claude",
		name: "Claude",
		description: "Your Claude Pro or Max subscription, signed in through CLIProxyAPI.",
		auth: "subscription",
		preset: "cliproxyapi",
		cpa: { provider: "anthropic", files: ["claude", "anthropic"] },
	},
	chatgpt: {
		id: "chatgpt",
		name: "ChatGPT",
		description: "Your ChatGPT Plus or Pro subscription, signed in through CLIProxyAPI.",
		auth: "subscription",
		preset: "cliproxyapi",
		cpa: { provider: "codex", files: ["codex"] },
	},
	anthropic: {
		id: "anthropic",
		name: "Anthropic",
		description: "Claude models on Anthropic's API, billed to your Anthropic organisation.",
		auth: "key",
		preset: "anthropic",
		baseUrl: "https://api.anthropic.com",
		defaultModel: "claude-sonnet-5-5",
		keyUrl: "https://console.anthropic.com/settings/keys",
		keyPrefix: "sk-ant-",
	},
	openai: {
		id: "openai",
		name: "OpenAI",
		description: "GPT models on OpenAI's API, billed to your OpenAI organisation.",
		auth: "key",
		preset: "openai",
		baseUrl: "https://api.openai.com/v1",
		defaultModel: "gpt-5",
		keyUrl: "https://platform.openai.com/api-keys",
		keyPrefix: "sk-",
	},
	openrouter: {
		id: "openrouter",
		name: "OpenRouter",
		description: "Models from many providers with one OpenRouter key.",
		auth: "key",
		preset: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		defaultModel: "anthropic/claude-sonnet-5",
		keyUrl: "https://openrouter.ai/keys",
		keyPrefix: "sk-or-",
	},
	"vercel-ai-gateway": {
		id: "vercel-ai-gateway",
		name: "Vercel AI Gateway",
		description: "Models from many providers through Vercel's AI Gateway.",
		auth: "key",
		preset: "vercel-ai-gateway",
		baseUrl: "https://ai-gateway.vercel.sh/v1",
		defaultModel: "anthropic/claude-sonnet-5",
	},
	"openai-compatible": {
		id: "openai-compatible",
		name: "OpenAI-compatible server",
		description: "Any server that speaks OpenAI's API, such as vLLM, Ollama or your own proxy.",
		auth: "key",
		preset: "openai-compatible",
	},
};

/** What a store keeps of one connection: its connector and routes, never a key. */
export interface StoredModelProvider {
	readonly organisationId: OrganisationId;
	readonly providerId: ModelProviderId;
	readonly connector: Omit<ModelConnector, "createdAt" | "updatedAt">;
	readonly routes: readonly Omit<ModelRoute, "updatedAt">[];
}

export interface ModelProviderStore {
	/** The organisation's connections, or every organisation's without one. */
	list(organisationId?: OrganisationId): Promise<readonly StoredModelProvider[]>;
	/** Writes a connection, replacing the one stored for its organisation and provider. */
	save(record: StoredModelProvider): Promise<void>;
	remove(organisationId: OrganisationId, providerId: ModelProviderId): Promise<void>;
}

export interface ModelProvidersOptions {
	readonly connectors: ModelConnectors;
	readonly vault: Pick<Vault, "putItem">;
	/** Checks organisation roles. Without it only agents are refused. */
	readonly access?: ProjectAccess;
	readonly audit?: AuditSink;
	readonly clock?: Clock;
	/** CPA's management API. Without it subscriptions are unavailable. */
	readonly subscriptions?: CpaManagement;
	/** Where connections are kept for `replayModelProviders`. */
	readonly store?: ModelProviderStore;
	/**
	 * Whether key providers can be connected. `false` or a reason marks them unavailable, such as where the deployment
	 * runs no model gateway to use a key. Default `true`.
	 */
	readonly keyProviders?: boolean | { readonly reason: string };
	/**
	 * The ID of an organisation's connector for a key provider. Default `org-<providerId>`. Connector IDs are unique
	 * across the directory, so a directory several organisations share needs IDs that name the organisation.
	 */
	readonly connectorId?: (organisationId: OrganisationId, providerId: ModelProviderId) => string;
}

/** The reason subscriptions are unavailable without CPA's management API. */
export const SUBSCRIPTIONS_UNAVAILABLE =
	"This deployment has no CLIProxyAPI management key (HARBOUR_CPA_MANAGEMENT_KEY)";
const KEYS_UNAVAILABLE = "This deployment runs no model gateway, so it can't use a provider's key";
const REFUSAL = "The caller may not do this in this organisation";
const AGENT_REFUSAL = "Agents may not connect or disconnect model providers";
const DEFAULT_ROUTE = "default";
/** The connector a subscription is reported as served by when the platform has no CPA connector. */
const CPA_CONNECTOR_FALLBACK = "cliproxyapi";
const AUDIT_CONTEXT: SystemContext = systemContext("models");

const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 4096;
const MAX_URL_LENGTH = 2048;
const MAX_REDIRECT_URL_LENGTH = 8192;
const MAX_MODEL_LENGTH = 256;
const MAX_SIGN_IN_ID_LENGTH = 512;
/** The hosts a base URL may reach over plain http. */
const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]", "::1"];

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The connector ID `createModelProviders` uses by default: `org-<providerId>`. */
export const defaultProviderConnectorId = (_organisationId: OrganisationId, providerId: ModelProviderId): string =>
	`org-${providerId}`;

function providerSpec(providerId: unknown): ModelProviderSpec {
	if (!isModelProviderId(providerId)) {
		throw new HarbourError("invalid", `A model provider is one of ${MODEL_PROVIDER_IDS.join(", ")}`);
	}
	return MODEL_PROVIDER_SPECS[providerId];
}

/** The key, without surrounding whitespace, or `invalid`. */
function checkKey(value: unknown): string {
	const key = typeof value === "string" ? value.trim() : "";
	if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH || /\s/.test(key)) {
		throw new HarbourError("invalid", `A key is ${MIN_KEY_LENGTH} to ${MAX_KEY_LENGTH} characters with no spaces`);
	}
	return key;
}

/** The base URL to use, without trailing slashes: absolute, https (http only to this machine), or `invalid`. */
function checkBaseUrl(value: unknown, spec: ModelProviderSpec): string {
	const given = value ?? spec.baseUrl;
	if (given === undefined) throw new HarbourError("invalid", `${spec.name} needs a base URL`);
	let url: URL | undefined;
	try {
		url = typeof given === "string" && given.length <= MAX_URL_LENGTH ? new URL(given) : undefined;
	} catch {
		url = undefined;
	}
	if (url === undefined) {
		throw new HarbourError("invalid", "A base URL is an absolute URL, such as https://llm.example.com/v1");
	}
	const local = LOCAL_HOSTS.includes(url.hostname);
	if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
		throw new HarbourError("invalid", "A base URL is https, or http only to localhost");
	}
	if (url.username !== "" || url.password !== "") {
		throw new HarbourError("invalid", "A base URL can't carry credentials: give the key as the key");
	}
	if (url.search !== "" || url.hash !== "") {
		throw new HarbourError("invalid", "A base URL has no query or fragment");
	}
	return (given as string).replace(/\/+$/, "");
}

function checkModel(value: unknown, spec: ModelProviderSpec): string {
	const model = value ?? spec.defaultModel;
	if (model === undefined) throw new HarbourError("invalid", `${spec.name} needs a model ID`);
	if (!isNonEmptyString(model) || model.length > MAX_MODEL_LENGTH || /[\s:]/.test(model)) {
		throw new HarbourError("invalid", "A model ID is one ID, with no spaces or `:`");
	}
	return model;
}

function checkSignInId(value: unknown): string {
	if (!isNonEmptyString(value) || value.length > MAX_SIGN_IN_ID_LENGTH) {
		throw new HarbourError("invalid", "A sign-in ID is the one startSignIn gave");
	}
	return value;
}

function checkRedirectUrl(value: unknown): string {
	let url: URL | undefined;
	try {
		url = typeof value === "string" && value.length <= MAX_REDIRECT_URL_LENGTH ? new URL(value) : undefined;
	} catch {
		url = undefined;
	}
	if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) {
		throw new HarbourError("invalid", "The redirect URL is the whole address the browser ended on");
	}
	return value as string;
}

/** How the vault places the key, by the preset's key header for the model's wire API. */
export function providerInjection(preset: ConnectorPreset, modelId: string): InjectionRule {
	const spec = presetSpec(preset);
	return spec.keyHeader(spec.defaultApi(modelId, undefined, undefined)) === "x-api-key"
		? { header: "x-api-key", template: "{key}" }
		: { header: "Authorization", template: "Bearer {key}" };
}

function randomHex(bytes: number): string {
	return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What every description of a provider carries, before availability and connection. */
function baseOf(spec: ModelProviderSpec): Omit<ModelProvider, "available"> {
	return {
		id: spec.id,
		name: spec.name,
		description: spec.description,
		auth: spec.auth,
		preset: spec.preset,
		...(spec.baseUrl === undefined ? {} : { baseUrl: spec.baseUrl }),
		...(spec.defaultModel === undefined ? {} : { defaultModel: spec.defaultModel }),
		...(spec.keyUrl === undefined ? {} : { keyUrl: spec.keyUrl }),
		...(spec.keyPrefix === undefined ? {} : { keyPrefix: spec.keyPrefix }),
	};
}

interface Snapshot {
	readonly connectors: readonly ModelConnector[];
	readonly routes: readonly ModelRoute[];
}

const organisationRoutes = (snapshot: Snapshot, organisationId: OrganisationId): readonly ModelRoute[] =>
	snapshot.routes.filter(
		(route) => route.owner.kind === "organisation" && route.owner.organisationId === organisationId,
	);

const organisationConnector = (
	snapshot: Snapshot,
	organisationId: OrganisationId,
	connectorId: string,
): ModelConnector | undefined =>
	snapshot.connectors.find(
		(connector) =>
			connector.id === connectorId &&
			connector.owner.kind === "organisation" &&
			connector.owner.organisationId === organisationId,
	);

/** What `default` resolves to for the organisation: its own route, else the platform's. */
function defaultRouteOf(snapshot: Snapshot, organisationId: OrganisationId): DefaultModelRoute | undefined {
	const own = organisationRoutes(snapshot, organisationId).find((route) => route.name === DEFAULT_ROUTE);
	if (own !== undefined) return { connectorId: own.connectorId, modelId: own.modelId, owner: "organisation" };
	const platform = snapshot.routes.find((route) => route.owner.kind === "platform" && route.name === DEFAULT_ROUTE);
	if (platform !== undefined)
		return { connectorId: platform.connectorId, modelId: platform.modelId, owner: "platform" };
	return undefined;
}

function signInOf(spec: ModelProviderSpec, id: string, status: CpaAuthStatus): ModelSignIn {
	switch (status.status) {
		case "wait":
			return { id, providerId: spec.id, status: "pending" };
		case "ok":
			return { id, providerId: spec.id, status: "completed" };
		case "error":
			return { id, providerId: spec.id, status: "failed", error: status.error ?? "The sign-in failed" };
	}
}

export function createModelProviders(options: ModelProvidersOptions): ModelProviders {
	const { connectors: directory, vault, access, audit, subscriptions, store } = options;
	const clock = options.clock ?? systemClock;
	const connectorIdOf = options.connectorId ?? defaultProviderConnectorId;
	const keyUnavailable: string | undefined =
		options.keyProviders === undefined || options.keyProviders === true
			? undefined
			: options.keyProviders === false
				? KEYS_UNAVAILABLE
				: options.keyProviders.reason;

	function assertCaller(ctx: CallContext): void {
		if (
			typeof ctx !== "object" ||
			ctx === null ||
			typeof ctx.actor !== "object" ||
			ctx.actor === null ||
			!isNonEmptyString(ctx.organisationId)
		) {
			throw new HarbourError("forbidden", REFUSAL);
		}
	}

	/** An organisation-wide admin, or Harbour itself. Never an agent; `ProjectAccess` audits a refusal. */
	async function requireAdmin(ctx: CallContext, operation: string): Promise<void> {
		assertCaller(ctx);
		if (isSystemActor(ctx.actor)) return;
		if (ctx.actor.kind === "agent") {
			if (access !== undefined) await access.require(ctx, { needed: "admin", operation });
			throw new HarbourError("forbidden", AGENT_REFUSAL, { operation });
		}
		await access?.require(ctx, { needed: "admin", operation });
	}

	async function requireViewer(ctx: CallContext): Promise<void> {
		assertCaller(ctx);
		if (isSystemActor(ctx.actor)) return;
		await access?.require(ctx, { needed: "viewer", operation: "models.provider.list" });
	}

	async function record(
		ctx: CallContext,
		type: string,
		providerId: ModelProviderId,
		data: { readonly [key: string]: JsonValue },
		id?: string,
	): Promise<void> {
		if (audit === undefined) return;
		const event: AuditEventInput = {
			id: id ?? `models:${type}:${crypto.randomUUID()}`,
			at: clock.now(),
			source: "models",
			type,
			actor: ctx.actor,
			organisationId: ctx.organisationId,
			subject: { kind: "models.provider", id: providerId },
			data,
		};
		await audit.append(AUDIT_CONTEXT, [event]);
	}

	/** The connectors and routes the caller sees. One after the other, so a refusal is audited once. */
	async function snapshot(ctx: CallContext): Promise<Snapshot> {
		const connectors = await allPages((page) => directory.listConnectors(ctx, page));
		const routes = await allPages((page) => directory.listRoutes(ctx, undefined, page));
		return { connectors, routes };
	}

	function describeKey(spec: ModelProviderSpec, organisationId: OrganisationId, state: Snapshot): ModelProvider {
		const availability =
			keyUnavailable === undefined ? { available: true } : { available: false, unavailableReason: keyUnavailable };
		const connector = organisationConnector(state, organisationId, connectorIdOf(organisationId, spec.id));
		if (connector === undefined) return { ...baseOf(spec), ...availability };
		const served = organisationRoutes(state, organisationId).filter((route) => route.connectorId === connector.id);
		const own = served.find((route) => route.name === spec.id) ?? served[0];
		const connection: ModelProviderConnection = {
			connectorId: connector.id,
			routes: served.map((route) => route.name),
			...(own === undefined ? {} : { modelId: own.modelId }),
			baseUrl: connector.baseUrl,
			connectedAt: connector.updatedAt,
		};
		return { ...baseOf(spec), ...availability, connection };
	}

	function describeSubscription(
		spec: ModelProviderSpec,
		state: Snapshot,
		files: readonly CpaAuthFile[] | undefined,
	): ModelProvider {
		if (subscriptions === undefined) {
			return { ...baseOf(spec), available: false, unavailableReason: SUBSCRIPTIONS_UNAVAILABLE };
		}
		const names = spec.cpa?.files ?? [];
		const file = files?.find(
			(each) =>
				each.disabled !== true &&
				[each.provider, each.type].some((name) => name !== undefined && names.includes(name.toLowerCase())),
		);
		if (file === undefined) return { ...baseOf(spec), available: true };
		const cpa = state.connectors.find(
			(connector) => connector.owner.kind === "platform" && connector.preset === "cliproxyapi",
		);
		const connectorId = cpa?.id ?? CPA_CONNECTOR_FALLBACK;
		const connection: ModelProviderConnection = {
			connectorId,
			routes: state.routes
				.filter((route) => route.owner.kind === "platform" && route.connectorId === connectorId)
				.map((route) => route.name),
			...(isNonEmptyString(file.email) ? { account: file.email } : {}),
		};
		return { ...baseOf(spec), available: true, connection };
	}

	function subscriptionOf(providerId: unknown): {
		readonly spec: ModelProviderSpec;
		readonly provider: CpaAuthProvider;
		readonly cpa: CpaManagement;
	} {
		const spec = providerSpec(providerId);
		if (spec.cpa === undefined) throw new HarbourError("invalid", `${spec.name} takes a key, not a sign-in`);
		if (subscriptions === undefined) throw new HarbourError("unavailable", SUBSCRIPTIONS_UNAVAILABLE);
		return { spec, provider: spec.cpa.provider, cpa: subscriptions };
	}

	/** Audits a sign-in that has settled, once whoever polls it: the event's ID is the sign-in's and its outcome. */
	async function settled(ctx: CallContext, signIn: ModelSignIn): Promise<ModelSignIn> {
		if (signIn.status !== "pending") {
			await record(
				ctx,
				"models.provider.signin",
				signIn.providerId,
				{ providerId: signIn.providerId, signInId: signIn.id, status: signIn.status },
				`models:provider.signin:${signIn.providerId}:${signIn.id}:${signIn.status}`,
			);
		}
		return signIn;
	}

	return {
		async list(ctx) {
			await requireViewer(ctx);
			const state = await snapshot(ctx);
			let files: readonly CpaAuthFile[] | undefined;
			if (subscriptions !== undefined) {
				try {
					files = (await subscriptions.authFiles()).files;
				} catch {
					// CPA being down hides a subscription's connection, not the list.
					files = undefined;
				}
			}
			const items = MODEL_PROVIDER_IDS.map((id) => {
				const spec = MODEL_PROVIDER_SPECS[id];
				return spec.auth === "key"
					? describeKey(spec, ctx.organisationId, state)
					: describeSubscription(spec, state, files);
			});
			const defaultRoute = defaultRouteOf(state, ctx.organisationId);
			return defaultRoute === undefined ? { items } : { items, defaultRoute };
		},

		async connectKey(ctx, providerId, input) {
			await requireAdmin(ctx, "models.provider.connect");
			const spec = providerSpec(providerId);
			if (spec.auth !== "key") {
				throw new HarbourError("invalid", `${spec.name} is a subscription: sign in to it rather than giving a key`);
			}
			if (keyUnavailable !== undefined) throw new HarbourError("unavailable", keyUnavailable);
			if (typeof input !== "object" || input === null) {
				throw new HarbourError("invalid", "Connecting a provider takes its key");
			}
			const key = checkKey(input.key);
			const baseUrl = checkBaseUrl(input.baseUrl, spec);
			const modelId = checkModel(input.model, spec);
			if (input.makeDefault !== undefined && typeof input.makeDefault !== "boolean") {
				throw new HarbourError("invalid", "makeDefault is true or false");
			}

			const organisationId = ctx.organisationId;
			const owner = { kind: "organisation", organisationId } as const;
			const connectorId = connectorIdOf(organisationId, spec.id);
			const before = await snapshot(ctx);
			const ownDefault = organisationRoutes(before, organisationId).find((route) => route.name === DEFAULT_ROUTE);
			// `default` moves here when asked or when the organisation has none, and stays here when it was here.
			const takeDefault =
				input.makeDefault === true || ownDefault === undefined || ownDefault.connectorId === connectorId;

			const item = await vault.putItem(ctx, {
				owner,
				name: `model-${spec.id}-${randomHex(3)}`,
				description: `${spec.name} API key for the model gateway's ${connectorId} connector`,
				hosts: [new URL(baseUrl).hostname],
				injection: providerInjection(spec.preset, modelId),
				value: key,
			});
			const connector: Omit<ModelConnector, "createdAt" | "updatedAt"> = {
				id: connectorId,
				owner,
				preset: spec.preset,
				baseUrl,
				vaultItemId: item.id,
				catalogue: { refresh: "gateway" },
			};
			await directory.putConnector(ctx, connector);
			const routes: Omit<ModelRoute, "updatedAt">[] = [{ name: spec.id, owner, connectorId, modelId }];
			if (takeDefault) routes.push({ name: DEFAULT_ROUTE, owner, connectorId, modelId });
			for (const route of routes) await directory.putRoute(ctx, route);

			if (store !== undefined) {
				if (takeDefault) {
					// Another provider that had `default` no longer puts it back on a replay.
					for (const other of await store.list(organisationId)) {
						if (other.providerId === spec.id || !other.routes.some((route) => route.name === DEFAULT_ROUTE)) continue;
						await store.save({ ...other, routes: other.routes.filter((route) => route.name !== DEFAULT_ROUTE) });
					}
				}
				await store.save({ organisationId, providerId: spec.id, connector, routes });
			}
			await record(ctx, "models.provider.connected", spec.id, {
				providerId: spec.id,
				connectorId,
				routes: routes.map((route) => route.name),
			});
			return describeKey(spec, organisationId, await snapshot(ctx));
		},

		async startSignIn(ctx, providerId) {
			await requireAdmin(ctx, "models.provider.signin");
			const { spec, provider, cpa } = subscriptionOf(providerId);
			const started = await cpa.authUrl(provider);
			await record(ctx, "models.provider.signin", spec.id, {
				providerId: spec.id,
				signInId: started.state,
				status: "pending",
			});
			return { id: started.state, providerId: spec.id, status: "pending", url: started.url };
		},

		async signInStatus(ctx, providerId, signInId) {
			await requireAdmin(ctx, "models.provider.signin");
			const { spec, cpa } = subscriptionOf(providerId);
			const id = checkSignInId(signInId);
			return settled(ctx, signInOf(spec, id, await cpa.authStatus(id)));
		},

		async finishSignIn(ctx, providerId, signInId, redirectUrl) {
			await requireAdmin(ctx, "models.provider.signin");
			const { spec, provider, cpa } = subscriptionOf(providerId);
			const id = checkSignInId(signInId);
			const address = checkRedirectUrl(redirectUrl);
			// The address carries the provider's code: it goes to CPA and nowhere else.
			await cpa.submitCallback(provider, id, address);
			return settled(ctx, signInOf(spec, id, await cpa.authStatus(id)));
		},

		async disconnect(ctx, providerId) {
			await requireAdmin(ctx, "models.provider.disconnect");
			const spec = providerSpec(providerId);
			if (spec.auth !== "key") throw new HarbourError("invalid", "Sign out of a subscription in CLIProxyAPI");
			const organisationId = ctx.organisationId;
			const connectorId = connectorIdOf(organisationId, spec.id);
			const state = await snapshot(ctx);
			const connector = organisationConnector(state, organisationId, connectorId);
			// Its routes, `default` among them when it names this connector.
			const served = organisationRoutes(state, organisationId).filter((route) => route.connectorId === connectorId);
			for (const route of served) await directory.deleteRoute(ctx, route.owner, route.name);
			if (connector !== undefined) await directory.deleteConnector(ctx, connectorId);
			let stored = false;
			if (store !== undefined) {
				stored = (await store.list(organisationId)).some((each) => each.providerId === spec.id);
				if (stored) await store.remove(organisationId, spec.id);
			}
			if (connector === undefined && served.length === 0 && !stored) {
				throw new HarbourError("not_found", `${spec.name} isn't connected`);
			}
			await record(ctx, "models.provider.disconnected", spec.id, {
				providerId: spec.id,
				connectorId,
				routes: served.map((route) => route.name),
			});
		},
	};
}

/** A `ModelProviderStore` in memory. */
export function createMemoryModelProviderStore(): ModelProviderStore {
	const records = new Map<string, StoredModelProvider>();
	const keyOf = (organisationId: OrganisationId, providerId: ModelProviderId) => `${organisationId}\u0000${providerId}`;
	return {
		async list(organisationId) {
			return [...records.values()]
				.filter((each) => organisationId === undefined || each.organisationId === organisationId)
				.sort((a, b) => a.organisationId.localeCompare(b.organisationId) || a.providerId.localeCompare(b.providerId));
		},
		async save(record) {
			// A copy, as a durable store would keep: a caller's later change to its object doesn't reach the store.
			records.set(keyOf(record.organisationId, record.providerId), JSON.parse(JSON.stringify(record)));
		},
		async remove(organisationId, providerId) {
			records.delete(keyOf(organisationId, providerId));
		},
	};
}

/** A directory reached through `get` on every call: for a model gateway built on first use. */
export function lateModelConnectors(get: () => Promise<ModelConnectors>): ModelConnectors {
	return {
		putConnector: async (ctx, input) => (await get()).putConnector(ctx, input),
		getConnector: async (ctx, id) => (await get()).getConnector(ctx, id),
		listConnectors: async (ctx, page) => (await get()).listConnectors(ctx, page),
		deleteConnector: async (ctx, id) => (await get()).deleteConnector(ctx, id),
		putRoute: async (ctx, input) => (await get()).putRoute(ctx, input),
		listRoutes: async (ctx, filter, page) => (await get()).listRoutes(ctx, filter, page),
		deleteRoute: async (ctx, owner, name) => (await get()).deleteRoute(ctx, owner, name),
		setProjectPolicy: async (ctx, policy) => (await get()).setProjectPolicy(ctx, policy),
		getProjectPolicy: async (ctx, projectId) => (await get()).getProjectPolicy(ctx, projectId),
		resolve: async (ctx, scope) => (await get()).resolve(ctx, scope),
	};
}

/**
 * Puts every stored connection's connector and routes back into `connectors`, as `ctx` (a `system` caller) in each
 * connection's organisation: for a gateway whose directory was rebuilt after a restart. Resolves with how many
 * connections it put back.
 */
export async function replayModelProviders(
	connectors: ModelConnectors,
	store: ModelProviderStore,
	ctx: SystemContext,
): Promise<number> {
	await requireSystem(ctx, "models.provider.replay");
	const records = await store.list();
	const contextOf = (organisationId: OrganisationId): CallContext => ({ ...ctx, organisationId });
	// Connectors first, so every route finds its connector.
	for (const record of records) await connectors.putConnector(contextOf(record.organisationId), record.connector);
	for (const record of records) {
		for (const route of record.routes) await connectors.putRoute(contextOf(record.organisationId), route);
	}
	return records.length;
}

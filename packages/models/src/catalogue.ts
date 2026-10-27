/**
 * The model catalogue (docs/model-connectors.md, "Catalogue and model IDs"). Metadata comes from pi-ai's generated
 * catalogue, joined by the upstream's model ID or by `override.canonical`, with the upstream's own listing and the
 * connector's overrides on top. What is available is decided by the connector: for `refresh: "gateway"` the upstream's
 * list (`/v1/models`, LiteLLM's `/model/info`), read with the connector's key and cached for a TTL; for `static`,
 * `include` and the overrides. `include` limits either. A model with no pi match is offered only when an override
 * supplies `contextWindow` and `maxTokens`.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import { OPENROUTER_MODELS } from "@earendil-works/pi-ai/providers/openrouter.models";
import { VERCEL_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/vercel-ai-gateway.models";
import type {
	Clock,
	ModelCallScope,
	ModelConnector,
	ModelOverride,
	ModelRates,
	ModelWireApi,
} from "@harbour/contracts";
import { catalogueUrl, presetSpec, upstreamBaseUrl } from "./presets.ts";
import { Redactor } from "./redact.ts";

/** Default lifetime of a refreshed catalogue listing. */
export const DEFAULT_CATALOGUE_TTL_MS = 10 * 60_000;
/** How long after a failed refresh the catalogue waits before trying the upstream again. */
export const CATALOGUE_RETRY_MS = 10_000;
/** Default bound on one refresh, in real time. */
export const DEFAULT_CATALOGUE_REFRESH_TIMEOUT_MS = 10_000;

const WIRE_APIS: readonly string[] = ["anthropic-messages", "openai-completions", "openai-responses"];
const isWireApi = (api: string): api is ModelWireApi => WIRE_APIS.includes(api);

/** pi's catalogues the gateway borrows metadata from, first-party ones first. */
const PI_CATALOGUES: readonly { readonly provider: string; readonly models: ReadonlyMap<string, Model<Api>> }[] = [
	["anthropic", ANTHROPIC_MODELS],
	["openai", OPENAI_MODELS],
	["google", GOOGLE_MODELS],
	["openrouter", OPENROUTER_MODELS],
	["vercel-ai-gateway", VERCEL_AI_GATEWAY_MODELS],
].map(([provider, models]) => ({
	provider: provider as string,
	models: new Map(Object.entries(models as unknown as { readonly [id: string]: Model<Api> })),
}));

/** First-party catalogues describe the model itself, so their compat holds on any upstream speaking the same API. */
const FIRST_PARTY = new Set(["anthropic", "openai"]);

/**
 * pi's catalogue entry for `id`: in `preferProvider`'s catalogue first, then as `<provider>/<id>` (such as
 * `anthropic/claude-opus-5-5`), then in every catalogue in turn.
 */
export function findPiModel(id: string, preferProvider?: string): Model<Api> | undefined {
	const inCatalogue = (provider: string, modelId: string) =>
		PI_CATALOGUES.find((catalogue) => catalogue.provider === provider)?.models.get(modelId);
	if (preferProvider !== undefined) {
		const preferred = inCatalogue(preferProvider, id);
		if (preferred !== undefined) return preferred;
	}
	const slash = id.indexOf("/");
	if (slash > 0) {
		const prefixed = inCatalogue(id.slice(0, slash), id.slice(slash + 1));
		if (prefixed !== undefined) return prefixed;
	}
	for (const catalogue of PI_CATALOGUES) {
		const found = catalogue.models.get(id);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** What an upstream's own listing says about one model. */
export interface ListedModel {
	readonly id: string;
	readonly name?: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly rates?: ModelRates;
}

const asRecord = (value: unknown): { readonly [key: string]: unknown } | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as { readonly [key: string]: unknown })
		: undefined;

function positive(...values: unknown[]): number | undefined {
	for (const value of values) {
		const number = typeof value === "string" ? Number.parseFloat(value) : value;
		if (typeof number === "number" && Number.isFinite(number) && number > 0) return number;
	}
	return undefined;
}

/** A $/token price as $/1M tokens; absent or negative is undefined. */
function perMillion(value: unknown): number | undefined {
	const number = typeof value === "string" ? Number.parseFloat(value) : value;
	return typeof number === "number" && Number.isFinite(number) && number >= 0
		? Number((number * 1_000_000).toFixed(6))
		: undefined;
}

function ratesOf(entry: { readonly [key: string]: unknown }): ModelRates | undefined {
	const pricing = asRecord(entry.pricing);
	const info = asRecord(entry.model_info);
	const input = perMillion(pricing?.prompt ?? pricing?.input ?? info?.input_cost_per_token);
	const output = perMillion(pricing?.completion ?? pricing?.output ?? info?.output_cost_per_token);
	if (input === undefined || output === undefined) return undefined;
	return {
		input,
		output,
		cacheRead: perMillion(pricing?.input_cache_read ?? info?.cache_read_input_token_cost) ?? 0,
		cacheWrite: perMillion(pricing?.input_cache_write ?? info?.cache_creation_input_token_cost) ?? 0,
	};
}

/**
 * Parses an upstream's model listing: `{ data: [...] }` as OpenAI, Anthropic, OpenRouter and Vercel serve it at
 * `/v1/models`, and LiteLLM at `/model/info` (`model_name` and `model_info`). Unknown fields are ignored.
 */
export function parseCatalogueListing(body: unknown): readonly ListedModel[] {
	const data = asRecord(body)?.data;
	if (!Array.isArray(data)) return [];
	const listed: ListedModel[] = [];
	for (const raw of data) {
		const entry = asRecord(raw);
		const id = entry?.id ?? entry?.model_name;
		if (entry === undefined || typeof id !== "string" || id.length === 0) continue;
		const top = asRecord(entry.top_provider);
		const info = asRecord(entry.model_info);
		const name = entry.name ?? entry.display_name;
		const contextWindow = positive(
			entry.context_window,
			entry.context_length,
			top?.context_length,
			entry.max_input_tokens,
			info?.max_input_tokens,
		);
		const maxTokens = positive(entry.max_tokens, top?.max_completion_tokens, info?.max_output_tokens, info?.max_tokens);
		const rates = ratesOf(entry);
		listed.push({
			id,
			...(typeof name === "string" ? { name } : {}),
			...(contextWindow === undefined ? {} : { contextWindow }),
			...(maxTokens === undefined ? {} : { maxTokens }),
			...(rates === undefined ? {} : { rates }),
		});
	}
	return listed;
}

/**
 * An upstream's listing made safe to show while its key is at hand: names redacted, and models whose ID holds the key
 * dropped, since an ID is what clients call a model by and can't be redacted.
 */
export function sanitisedListing(listed: readonly ListedModel[], redactor: Redactor): readonly ListedModel[] {
	return listed
		.filter((model) => redactor.text(model.id) === model.id)
		.map((model) => (model.name === undefined ? model : { ...model, name: redactor.text(model.name) }));
}

/** A model a connector offers: its upstream ID, wire API and the pi `Model` the gateway streams with. */
export interface OfferedModel {
	readonly id: string;
	readonly api: ModelWireApi;
	readonly model: Model<ModelWireApi>;
}

const ZERO_RATES: ModelRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Builds the upstream pi `Model` for `modelId` on `connector`, or undefined when there is no metadata for it: no pi
 * match and no override with `contextWindow` and `maxTokens`. Precedence: the override, then the upstream's listing,
 * then pi's catalogue.
 */
export function upstreamModel(
	connector: ModelConnector,
	modelId: string,
	listed?: ListedModel,
): OfferedModel | undefined {
	const spec = presetSpec(connector.preset);
	const override: ModelOverride | undefined = connector.catalogue.overrides?.[modelId];
	const pi = findPiModel(override?.canonical ?? modelId, spec.piProvider);
	if (pi === undefined && (override?.contextWindow === undefined || override.maxTokens === undefined)) return undefined;
	const piApi = pi !== undefined && isWireApi(pi.api) && spec.apis.includes(pi.api) ? pi.api : undefined;
	const catalogueApi = pi?.provider === spec.piProvider ? piApi : undefined;
	const api =
		override?.api !== undefined && spec.apis.includes(override.api)
			? override.api
			: spec.defaultApi(modelId, override?.canonical, catalogueApi);
	const borrowedCompat =
		pi !== undefined && pi.api === api && (pi.provider === spec.piProvider || FIRST_PARTY.has(pi.provider))
			? (pi.compat as { readonly [key: string]: unknown } | undefined)
			: undefined;
	const compat =
		borrowedCompat === undefined && connector.compat === undefined
			? undefined
			: { ...borrowedCompat, ...connector.compat };
	const rates = override?.rates ?? listed?.rates;
	const model: Model<ModelWireApi> = {
		id: modelId,
		name: override?.name ?? listed?.name ?? pi?.name ?? modelId,
		api,
		provider: spec.piProvider,
		baseUrl: upstreamBaseUrl(connector.baseUrl, api),
		reasoning: override?.reasoning ?? pi?.reasoning ?? false,
		...(pi?.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: pi.thinkingLevelMap }),
		...(pi?.promptCache === undefined ? {} : { promptCache: pi.promptCache }),
		input: [...(override?.input ?? pi?.input ?? ["text"])],
		cost: rates === undefined ? (pi?.cost ?? { ...ZERO_RATES }) : { ...rates },
		contextWindow: override?.contextWindow ?? listed?.contextWindow ?? pi!.contextWindow,
		maxTokens: override?.maxTokens ?? listed?.maxTokens ?? pi!.maxTokens,
		...(compat === undefined ? {} : { compat: compat as Model<ModelWireApi>["compat"] }),
	};
	return { id: modelId, api, model };
}

/** How the catalogue reads a connector's key: the gateway's credential cache. */
export interface CatalogueKeys {
	key(connector: ModelConnector, scope: ModelCallScope, signal?: AbortSignal): Promise<string>;
	/** Drops the cached key after the upstream answered 401. */
	drop(connector: ModelConnector): void;
}

export interface ModelCatalogueOptions {
	readonly keys: CatalogueKeys;
	readonly fetch?: typeof fetch;
	readonly clock: Clock;
	/** How long a refreshed listing is used before the next refresh. Default 10 minutes. */
	readonly ttlMs?: number;
	/**
	 * How long one refresh may take, key read included, before it counts as failed. Default 10 s. Real time
	 * (`AbortSignal.timeout`), not `clock`'s.
	 */
	readonly refreshTimeoutMs?: number;
}

export interface ModelCatalogue {
	/**
	 * The models `connector` offers, by upstream ID, refreshing its listing when stale. Aborting `signal` rejects with
	 * its reason at once; a refresh it was waiting on carries on for the connector's other callers, until it times out.
	 */
	offered(
		connector: ModelConnector,
		scope: ModelCallScope,
		signal?: AbortSignal,
	): Promise<ReadonlyMap<string, OfferedModel>>;
}

/** `promise`, or a rejection with `signal`'s reason as soon as it aborts. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return promise;
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

interface Listing {
	readonly at: number;
	readonly models: ReadonlyMap<string, ListedModel>;
}

export function createModelCatalogue(options: ModelCatalogueOptions): ModelCatalogue {
	const ttlMs = options.ttlMs ?? DEFAULT_CATALOGUE_TTL_MS;
	const refreshTimeoutMs = options.refreshTimeoutMs ?? DEFAULT_CATALOGUE_REFRESH_TIMEOUT_MS;
	const listings = new Map<string, Listing>();
	const inFlight = new Map<string, Promise<Listing | undefined>>();
	const failures = new Map<string, number>();
	const cacheKey = (connector: ModelConnector) =>
		`${JSON.stringify(connector.id)}|${connector.updatedAt}|${connector.baseUrl}`;

	/**
	 * Reads the upstream's listing. Shared by concurrent callers, so it takes none's abort signal; it is bounded by
	 * `refreshTimeoutMs` instead.
	 */
	async function refresh(connector: ModelConnector, scope: ModelCallScope): Promise<Listing | undefined> {
		const spec = presetSpec(connector.preset);
		const signal = AbortSignal.timeout(refreshTimeoutMs);
		const key = await abortable(options.keys.key(connector, scope, signal), signal);
		const anthropicOnly = spec.apis.every((api) => api === "anthropic-messages");
		const response = await (options.fetch ?? fetch)(catalogueUrl(connector), {
			signal,
			headers: {
				accept: "application/json",
				...spec.catalogueHeaders,
				...(anthropicOnly ? { "x-api-key": key } : { authorization: `Bearer ${key}` }),
			},
		});
		if (response.status === 401) options.keys.drop(connector);
		if (!response.ok) {
			await response.body?.cancel();
			return undefined;
		}
		const listed = sanitisedListing(parseCatalogueListing(await response.json()), new Redactor([key]));
		return { at: options.clock.now(), models: new Map(listed.map((model) => [model.id, model])) };
	}

	/** The connector's current listing: cached for the TTL; after a failed refresh, the last one for `RETRY_MS`. */
	async function listing(
		connector: ModelConnector,
		scope: ModelCallScope,
		signal: AbortSignal | undefined,
	): Promise<Listing | undefined> {
		const key = cacheKey(connector);
		const cached = listings.get(key);
		const now = options.clock.now();
		if (cached !== undefined && now - cached.at < ttlMs) return cached;
		const failedAt = failures.get(key);
		if (failedAt !== undefined && now - failedAt < CATALOGUE_RETRY_MS) return cached;
		let pending = inFlight.get(key);
		if (pending === undefined) {
			pending = refresh(connector, scope)
				.catch(() => undefined)
				.finally(() => inFlight.delete(key));
			inFlight.set(key, pending);
		}
		const fresh = await abortable(pending, signal);
		if (fresh === undefined) {
			failures.set(key, options.clock.now());
			return cached;
		}
		failures.delete(key);
		for (const stale of listings.keys())
			if (stale.startsWith(`${JSON.stringify(connector.id)}|`)) listings.delete(stale);
		listings.set(key, fresh);
		return fresh;
	}

	return {
		async offered(connector, scope, signal) {
			signal?.throwIfAborted();
			const include = connector.catalogue.include;
			const overrides = Object.keys(connector.catalogue.overrides ?? {});
			let listed: ReadonlyMap<string, ListedModel> = new Map();
			let ids: readonly string[];
			if (connector.catalogue.refresh === "gateway") {
				const current = await listing(connector, scope, signal);
				// Until a refresh has worked, a gateway connector offers what it would offer if static.
				if (current === undefined) ids = [...(include ?? []), ...overrides];
				else {
					listed = current.models;
					ids = [...listed.keys()];
				}
			} else ids = [...(include ?? []), ...overrides];
			const offered = new Map<string, OfferedModel>();
			for (const id of ids) {
				if (offered.has(id) || (include !== undefined && !include.includes(id))) continue;
				const model = upstreamModel(connector, id, listed.get(id));
				if (model !== undefined) offered.set(id, model);
			}
			return offered;
		},
	};
}

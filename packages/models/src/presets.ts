/**
 * Connector presets: one table, and the only provider-specific code in the gateway (packages/models/CONTRACT.md).
 * A preset fixes:
 *
 * - the pi-ai provider ID, which pi uses to detect compat quirks: the built-in IDs for OpenRouter, Vercel AI Gateway,
 *   Anthropic and OpenAI; `litellm`, `cliproxyapi` and the `*-compatible` ones get their own;
 * - the wire APIs it speaks, and which one a model uses when its override names none;
 * - where the key goes (pi's adapters place it: `Authorization: Bearer` for the OpenAI APIs, `x-api-key` for
 *   `anthropic-messages`);
 * - the attribution and session-affinity headers built from the call's scope, and any body changes (`onPayload`);
 * - where cost comes from: the upstream's report, pi's `calculateCost` from catalogue rates, or none (tokens only);
 * - any namespace tool names travel under, for an upstream that would otherwise rename them (tool-names.ts);
 * - how its catalogue refreshes;
 * - the image APIs it generates images over, if any, which one an image-only model takes, what a chat image call may
 *   send, where an image call's cost comes from, and whether a model's image output is read off its name (for an
 *   upstream whose catalogue lists IDs only).
 *
 * A connector's `baseUrl` is the upstream's OpenAI-style API root, such as `http://cliproxyapi.internal:8317/v1`. The
 * OpenAI APIs post under it (`/chat/completions`, `/responses`); `anthropic-messages` posts to `<root>/v1/messages`,
 * where the root is the base URL without a trailing `/v1` (the Anthropic SDK adds it), so an Anthropic-only base URL
 * may be given either way.
 */
import { clampOpenAIPromptCacheKey } from "@earendil-works/pi-ai/api/openai-prompt-cache";
import type {
	ConnectorPreset,
	ModelCallScope,
	ModelConnector,
	ModelImageApi,
	ModelModality,
	ModelWireApi,
} from "@kantel/contracts";
import { KANTEL_TOOL_NAMESPACE } from "./tool-names.ts";

/** Where reported cost comes from: the upstream (`usage.cost`), pi's `calculateCost`, or nowhere (tokens only). */
export type PresetCostSource = "reported" | "computed" | "none";

export interface ConnectorPresetSpec {
	readonly preset: ConnectorPreset;
	/** The pi-ai provider ID the upstream `Model` carries. */
	readonly piProvider: string;
	/** The wire APIs the upstream speaks; the first is the fallback default. */
	readonly apis: readonly ModelWireApi[];
	/**
	 * The wire API a model uses when its override names none. `catalogueApi` is the API of the pi catalogue entry the
	 * model joined, when that entry is the preset's own provider's.
	 */
	defaultApi(modelId: string, canonical: string | undefined, catalogueApi: ModelWireApi | undefined): ModelWireApi;
	/** The header the key travels in, per wire API. The gateway sets it itself (`keyHeaders`), never pi's `apiKey`. */
	readonly keyHeader: (api: ModelWireApi) => "authorization" | "x-api-key";
	/** The header carrying the session ID for affinity, if the upstream has one. */
	readonly affinityHeader?: string;
	/** The body field carrying the session ID for affinity, if the upstream takes it there instead. */
	readonly affinityBodyField?: string;
	/** Attribution and affinity headers for one call. Never a key. */
	headers(scope: ModelCallScope, api: ModelWireApi): { readonly [name: string]: string };
	/** Rewrites the upstream request body for attribution or routing; returns undefined to leave it unchanged. */
	onPayload?(payload: unknown, scope: ModelCallScope, api: ModelWireApi, connector: ModelConnector): unknown;
	/**
	 * The namespace the gateway puts tool names under on `api`, and takes off the calls that come back, if any
	 * (`namespaceToolNames`).
	 */
	toolNamespace?(api: ModelWireApi): string | undefined;
	readonly cost: PresetCostSource;
	/** The catalogue path under the connector's root (its base URL without a trailing `/v1`). */
	readonly cataloguePath: "/v1/models" | "/model/info";
	/** Extra headers the catalogue request needs, besides the key. */
	readonly catalogueHeaders?: { readonly [name: string]: string };
	/**
	 * The image APIs the upstream generates images over; the first is the default, which a model's `imageApi` override
	 * may change. Empty: no model on it makes images (Anthropic), whatever an override says.
	 */
	readonly imageApis: readonly ModelImageApi[];
	/**
	 * The image API an image-only model (no `text` in its output) uses when its override names none, if not the first
	 * of `imageApis`: Vercel documents its image-only models (gpt-image, Flux, Imagen) on `/images/generations`, where
	 * they take `n`, `size` and `quality`, rather than on chat completions.
	 */
	readonly imageOnlyApi?: ModelImageApi;
	/** Whether a `chat-modalities` call takes `image_config` (OpenRouter's `aspect_ratio`). Vercel documents none. */
	readonly chatImageConfig?: boolean;
	/**
	 * Where an image call's cost comes from, when not as `cost` says. Vercel answers `usage.cost` on chat completions
	 * (outside its documented schema, so a call without it is computed).
	 */
	readonly imageCost?: PresetCostSource;
	/**
	 * Whether a model's image output is read off its ID (`outputByName`) when neither an override nor the catalogue
	 * says: for upstreams whose catalogue lists IDs only (OpenAI, CLIProxyAPI, the compatible presets).
	 */
	readonly imageOutputByName: boolean;
	/**
	 * Adds attribution to an image request's JSON body (`openai-images` generations); returns undefined to leave it as it
	 * is. An edit's multipart body carries only the headers.
	 */
	imagePayload?(body: { readonly [key: string]: unknown }, scope: ModelCallScope): { readonly [key: string]: unknown };
}

/**
 * What a model gives back, read off its ID, for an upstream whose catalogue doesn't say: `gpt-image-*`, `dall-e-*` and
 * `imagen*` make images only; another `*-image*` model (`gemini-2.5-flash-image`, `gpt-5-image`) text and images.
 * Undefined when the name says nothing.
 */
export function outputByName(modelId: string): readonly ModelModality[] | undefined {
	const id = modelId.toLowerCase();
	if (/(^|[/:])(gpt-image|dall-e|imagen)/.test(id)) return ["image"];
	if (/-image(?:$|[-.:@/])/.test(id)) return ["text", "image"];
	return undefined;
}

const ALL_APIS: readonly ModelWireApi[] = ["openai-completions", "anthropic-messages", "openai-responses"];

const bearerOrApiKey = (api: ModelWireApi) => (api === "anthropic-messages" ? "x-api-key" : "authorization");

/** The key as the upstream takes it on `api`: `x-api-key` on Anthropic's, `Authorization: Bearer` on OpenAI's. */
export function keyHeaders(
	spec: Pick<ConnectorPresetSpec, "keyHeader">,
	api: ModelWireApi,
	key: string,
): { readonly [name: string]: string } {
	return spec.keyHeader(api) === "x-api-key" ? { "x-api-key": key } : { authorization: `Bearer ${key}` };
}

const isClaude = (modelId: string, canonical: string | undefined) => /claude/i.test(`${canonical ?? ""} ${modelId}`);
const isOpenAiReasoningFamily = (modelId: string, canonical: string | undefined) =>
	/(^|[/\s])(gpt-|o\d|codex)/i.test(`${canonical ?? ""} ${modelId}`);

function asRecord(payload: unknown): { readonly [key: string]: unknown } | undefined {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload)
		? (payload as { readonly [key: string]: unknown })
		: undefined;
}

/**
 * The value Anthropic's `metadata.user_id` carries: the session, under its organisation, project and agent. An
 * organisation session's project segment is `-`, which no project ID is.
 */
export function attributionUserId(scope: ModelCallScope): string {
	return `harbour/${scope.organisationId}/${scope.projectId ?? "-"}/${scope.agentId}/${scope.sessionId}`;
}

/** Sets `metadata.user_id` on an Anthropic Messages body. */
function withAnthropicUserId(payload: unknown, scope: ModelCallScope): unknown {
	const body = asRecord(payload);
	if (body === undefined) return undefined;
	return { ...body, metadata: { ...asRecord(body.metadata), user_id: attributionUserId(scope) } };
}

/**
 * LiteLLM's tags for one call: organisation, project, agent and session, so spend shows per project. An organisation
 * session has no project tag.
 */
export function litellmTags(scope: ModelCallScope): readonly string[] {
	return [
		`organisation:${scope.organisationId}`,
		...(scope.projectId === undefined ? [] : [`project:${scope.projectId}`]),
		`agent:${scope.agentId}`,
		`session:${scope.sessionId}`,
	];
}

/**
 * The scope's IDs under the keys Lleverage's agent-service sends LiteLLM (`organisation_id`, `project_id`,
 * `session_id`), so one LiteLLM's spend reads the same for both; `agent_id` besides. An organisation session has no
 * `project_id`.
 */
export function litellmSpendMetadata(scope: ModelCallScope): { readonly [key: string]: string } {
	return {
		organisation_id: scope.organisationId,
		...(scope.projectId === undefined ? {} : { project_id: scope.projectId }),
		agent_id: scope.agentId,
		session_id: scope.sessionId,
	};
}

/** LiteLLM's `metadata` on a JSON body: the tags, the session and the scope's IDs. */
function withLitellmMetadata(
	body: { readonly [key: string]: unknown },
	scope: ModelCallScope,
): { readonly [key: string]: unknown } {
	return {
		...body,
		metadata: {
			...asRecord(body.metadata),
			...litellmSpendMetadata(scope),
			tags: litellmTags(scope),
			harbour_organisation_id: scope.organisationId,
			harbour_project_id: scope.projectId,
			harbour_agent_id: scope.agentId,
		},
	};
}

const sessionIdHeader = (scope: ModelCallScope) => ({ "x-session-id": scope.sessionId });

export const CONNECTOR_PRESET_SPECS: { readonly [preset in ConnectorPreset]: ConnectorPresetSpec } = {
	litellm: {
		preset: "litellm",
		piProvider: "litellm",
		apis: ALL_APIS,
		defaultApi: (modelId, canonical) => (isClaude(modelId, canonical) ? "anthropic-messages" : "openai-completions"),
		keyHeader: bearerOrApiKey,
		// The tags, and the IDs as spend-log metadata: in headers, so they reach LiteLLM on every wire API, Messages
		// included, whose body `metadata` takes only Anthropic's `user_id`.
		headers: (scope) => ({
			"x-litellm-tags": litellmTags(scope).join(","),
			"x-litellm-spend-logs-metadata": JSON.stringify(litellmSpendMetadata(scope)),
		}),
		onPayload(payload, scope, api) {
			if (api === "anthropic-messages") return withAnthropicUserId(payload, scope);
			const body = asRecord(payload);
			return body === undefined ? undefined : withLitellmMetadata(body, scope);
		},
		cost: "reported",
		cataloguePath: "/model/info",
		imageApis: ["openai-images"],
		imageOutputByName: false,
		imagePayload: withLitellmMetadata,
	},
	"vercel-ai-gateway": {
		preset: "vercel-ai-gateway",
		piProvider: "vercel-ai-gateway",
		apis: ["anthropic-messages", "openai-completions", "openai-responses"],
		defaultApi: (_modelId, _canonical, catalogueApi) => catalogueApi ?? "anthropic-messages",
		keyHeader: bearerOrApiKey,
		affinityHeader: "x-session-id",
		headers: sessionIdHeader,
		onPayload(payload, _scope, api, connector) {
			// pi applies `vercelGatewayRouting` only on `openai-completions`; Messages needs it set here.
			const routing = asRecord(connector.compat?.vercelGatewayRouting);
			const body = asRecord(payload);
			if (api !== "anthropic-messages" || routing === undefined || body === undefined) return undefined;
			const gateway: { [key: string]: unknown } = {};
			if (routing.only !== undefined) gateway.only = routing.only;
			if (routing.order !== undefined) gateway.order = routing.order;
			if (Object.keys(gateway).length === 0) return undefined;
			return { ...body, providerOptions: { ...asRecord(body.providerOptions), gateway } };
		},
		cost: "computed",
		cataloguePath: "/v1/models",
		// Language models with the `image-generation` tag make images over chat completions; image-only models (its
		// listing's `type: "image"`) over the Images API.
		imageApis: ["chat-modalities", "openai-images"],
		imageOnlyApi: "openai-images",
		chatImageConfig: false,
		imageCost: "reported",
		imageOutputByName: false,
	},
	openrouter: {
		preset: "openrouter",
		piProvider: "openrouter",
		apis: ["openai-completions", "anthropic-messages"],
		defaultApi: (_modelId, _canonical, catalogueApi) => catalogueApi ?? "openai-completions",
		keyHeader: bearerOrApiKey,
		affinityHeader: "x-session-id",
		headers: sessionIdHeader,
		cost: "reported",
		cataloguePath: "/v1/models",
		imageApis: ["chat-modalities"],
		chatImageConfig: true,
		imageOutputByName: false,
	},
	anthropic: {
		preset: "anthropic",
		piProvider: "anthropic",
		apis: ["anthropic-messages"],
		defaultApi: () => "anthropic-messages",
		keyHeader: () => "x-api-key",
		headers: () => ({}),
		onPayload: (payload, scope) => withAnthropicUserId(payload, scope),
		cost: "computed",
		cataloguePath: "/v1/models",
		catalogueHeaders: { "anthropic-version": "2023-06-01" },
		imageApis: [],
		imageOutputByName: false,
	},
	openai: {
		preset: "openai",
		piProvider: "openai",
		apis: ["openai-responses", "openai-completions"],
		defaultApi: (_modelId, _canonical, catalogueApi) => catalogueApi ?? "openai-responses",
		keyHeader: () => "authorization",
		headers: () => ({}),
		affinityBodyField: "prompt_cache_key",
		// `prompt_cache_key` keeps a session on one cache (pi sets it on Responses, and on Chat Completions only for
		// api.openai.com); `user` attributes the call.
		onPayload(payload, scope) {
			const body = asRecord(payload);
			if (body === undefined) return undefined;
			const cacheKey = body.prompt_cache_key ?? clampOpenAIPromptCacheKey(scope.sessionId);
			return {
				...body,
				...(cacheKey === undefined ? {} : { prompt_cache_key: cacheKey }),
				user: attributionUserId(scope),
			};
		},
		cost: "computed",
		cataloguePath: "/v1/models",
		imageApis: ["openai-images"],
		imageOutputByName: true,
		// The Images API takes `user` for attribution, but not `prompt_cache_key`.
		imagePayload: (body, scope) => ({ ...body, user: attributionUserId(scope) }),
	},
	cliproxyapi: {
		preset: "cliproxyapi",
		piProvider: "cliproxyapi",
		apis: ALL_APIS,
		defaultApi: (modelId, canonical) =>
			isClaude(modelId, canonical)
				? "anthropic-messages"
				: isOpenAiReasoningFamily(modelId, canonical)
					? "openai-responses"
					: "openai-completions",
		keyHeader: bearerOrApiKey,
		// CPA keeps a session on one upstream credential when `routing.session-affinity` is on.
		affinityHeader: "x-session-affinity",
		headers: (scope) => ({ "x-session-affinity": scope.sessionId }),
		// On a Claude subscription credential CPA renames every tool that isn't an MCP tool to a random-word alias, which
		// is all the model ever sees of it; an MCP name it leaves alone.
		toolNamespace: (api) => (api === "anthropic-messages" ? KANTEL_TOOL_NAMESPACE : undefined),
		cost: "none",
		cataloguePath: "/v1/models",
		// CPA serves gpt-image models at /v1/images/generations on a Codex login.
		imageApis: ["openai-images"],
		imageOutputByName: true,
	},
	"openai-compatible": {
		preset: "openai-compatible",
		piProvider: "openai-compatible",
		apis: ["openai-completions", "openai-responses"],
		defaultApi: () => "openai-completions",
		keyHeader: () => "authorization",
		headers: () => ({}),
		cost: "computed",
		cataloguePath: "/v1/models",
		imageApis: ["openai-images"],
		imageOutputByName: true,
	},
	"anthropic-compatible": {
		preset: "anthropic-compatible",
		piProvider: "anthropic-compatible",
		apis: ["anthropic-messages"],
		defaultApi: () => "anthropic-messages",
		keyHeader: () => "x-api-key",
		headers: () => ({}),
		onPayload: (payload, scope) => withAnthropicUserId(payload, scope),
		cost: "computed",
		cataloguePath: "/v1/models",
		catalogueHeaders: { "anthropic-version": "2023-06-01" },
		imageApis: [],
		imageOutputByName: false,
	},
};

export function presetSpec(preset: ConnectorPreset): ConnectorPresetSpec {
	return CONNECTOR_PRESET_SPECS[preset];
}

const trimSlashes = (url: string) => url.replace(/\/+$/, "");

/** The connector's root: its base URL without trailing slashes or a trailing `/v1`. */
export function connectorRoot(baseUrl: string): string {
	return trimSlashes(baseUrl).replace(/\/v1$/, "");
}

/** The base URL pi's adapter for `api` takes: the API root for OpenAI APIs, the root without `/v1` for Messages. */
export function upstreamBaseUrl(baseUrl: string, api: ModelWireApi): string {
	return api === "anthropic-messages" ? connectorRoot(baseUrl) : trimSlashes(baseUrl);
}

/** Where an `openai-images` call posts: `<API root>/images/generations`, or `/images/edits` with reference images. */
export function imagesUrl(baseUrl: string, edit: boolean): string {
	return `${trimSlashes(baseUrl)}/images/${edit ? "edits" : "generations"}`;
}

/** Where a `chat-modalities` call posts: `<API root>/chat/completions`. */
export function chatCompletionsUrl(baseUrl: string): string {
	return `${trimSlashes(baseUrl)}/chat/completions`;
}

/** Where the connector's catalogue is read. */
export function catalogueUrl(connector: Pick<ModelConnector, "baseUrl" | "preset">): string {
	return `${connectorRoot(connector.baseUrl)}${presetSpec(connector.preset).cataloguePath}`;
}

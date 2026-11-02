/**
 * Model providers: an organisation connecting its own inference, as the console's first-run onboarding and its Models
 * page do (docs/site/src/content/docs/api/model-providers.md). A provider connection is an organisation-owned model
 * connector (`ModelConnector`) on one of four OpenAI-compatible upstreams, its key in the organisation's vault; the
 * default model is the organisation's `default` route (`ModelRoute`), which the `assistant` profile names.
 *
 * The key is write-only: it goes into the vault when a connection is saved, and no answer ever carries it or any part
 * of it.
 */
import type { ConnectorPreset } from "./models.ts";

/** The upstreams a connection can be made to. Each speaks OpenAI's API and lists its models. */
export type ModelProvider = "cliproxyapi" | "litellm" | "cloudflare-ai-gateway" | "openrouter";

export const MODEL_PROVIDERS: readonly ModelProvider[] = ["cliproxyapi", "litellm", "cloudflare-ai-gateway", "openrouter"];

/** What a provider asks for and where it is, for a form or a headless caller. */
export interface ModelProviderPreset {
	readonly provider: ModelProvider;
	readonly label: string;
	/** One line on what it is. */
	readonly description: string;
	/** The model connector preset a connection to it is made with. */
	readonly connectorPreset: ConnectorPreset;
	/**
	 * `url`: the caller gives the base URL (`defaultBaseUrl` is a suggestion); `fixed`: always `defaultBaseUrl`;
	 * `cloudflare`: built from a Cloudflare account ID and AI Gateway ID (`cloudflareAiGatewayBaseUrl`).
	 */
	readonly baseUrl: "url" | "fixed" | "cloudflare";
	readonly defaultBaseUrl?: string;
	/** What the key is called on the provider's side. */
	readonly keyLabel: string;
	/** Where the provider documents its API. */
	readonly docsUrl: string;
}

export const MODEL_PROVIDER_PRESETS: { readonly [provider in ModelProvider]: ModelProviderPreset } = {
	cliproxyapi: {
		provider: "cliproxyapi",
		label: "CLI Proxy API",
		description: "Your Claude, ChatGPT or Gemini subscriptions, through CLIProxyAPI.",
		connectorPreset: "cliproxyapi",
		baseUrl: "url",
		defaultBaseUrl: "http://host.docker.internal:8317/v1",
		keyLabel: "Client API key",
		docsUrl: "https://help.router-for.me/",
	},
	litellm: {
		provider: "litellm",
		label: "LiteLLM",
		description: "A LiteLLM proxy in front of any provider, with its own keys and spend.",
		connectorPreset: "litellm",
		baseUrl: "url",
		defaultBaseUrl: "http://host.docker.internal:4000/v1",
		keyLabel: "Virtual key",
		docsUrl: "https://docs.litellm.ai/docs/proxy/user_keys",
	},
	"cloudflare-ai-gateway": {
		provider: "cloudflare-ai-gateway",
		label: "Cloudflare AI Gateway",
		description: "Many providers through one Cloudflare gateway, billed to your Cloudflare account.",
		connectorPreset: "cloudflare-ai-gateway",
		baseUrl: "cloudflare",
		keyLabel: "Cloudflare API token",
		docsUrl: "https://developers.cloudflare.com/ai-gateway/usage/chat-completion/",
	},
	openrouter: {
		provider: "openrouter",
		label: "OpenRouter",
		description: "Hundreds of models from one OpenRouter key.",
		connectorPreset: "openrouter",
		baseUrl: "fixed",
		defaultBaseUrl: "https://openrouter.ai/api/v1",
		keyLabel: "API key",
		docsUrl: "https://openrouter.ai/docs/api-reference/list-available-models",
	},
};

/** A Cloudflare account or AI Gateway ID: what Cloudflare's dashboard shows, and nothing that changes the path. */
export const CLOUDFLARE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * AI Gateway's OpenAI-compatible endpoint for one gateway: `/chat/completions` and `/models` under it
 * (https://developers.cloudflare.com/ai-gateway/usage/chat-completion/).
 */
export function cloudflareAiGatewayBaseUrl(accountId: string, gatewayId: string): string {
	return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat`;
}

/** What a caller sends to test or save a connection. */
export interface ModelProviderInput {
	readonly provider: ModelProvider;
	/** For a `url` provider. Default its `defaultBaseUrl`. */
	readonly baseUrl?: string;
	/** For Cloudflare AI Gateway. */
	readonly accountId?: string;
	/** For Cloudflare AI Gateway. Default `default`, the gateway Cloudflare makes on the first request. */
	readonly gatewayId?: string;
	/**
	 * The key. Required to make a connection; leave it out to keep a saved connection's key, while its host is
	 * unchanged. A test leaves it out to use the saved connection's (`connectionId`).
	 */
	readonly apiKey?: string;
}

/** A saved connection: never its key. */
export interface ModelProviderConnection {
	/** The model connector's ID, such as `openrouter`. */
	readonly id: string;
	readonly provider: ModelProvider;
	readonly baseUrl: string;
	readonly accountId?: string;
	readonly gatewayId?: string;
	/** The vault item that holds the key. Never the key. */
	readonly vaultItemId: string;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** One model a provider lists. */
export interface ModelProviderModel {
	readonly id: string;
	readonly name?: string;
	readonly contextWindow?: number;
}

/** The organisation's default model: its `default` route. */
export interface ModelProviderDefault {
	readonly connectionId: string;
	readonly modelId: string;
	readonly updatedAt?: string;
}

/** `GET /v1/model-providers`. */
export interface ModelProvidersState {
	/** Whether sessions have a model to call: the organisation's default, or one the deployment configured. */
	readonly configured: boolean;
	/** Whether the caller may change connections and the default (an organisation admin). */
	readonly canManage: boolean;
	readonly connections: readonly ModelProviderConnection[];
	readonly default?: ModelProviderDefault;
	/** A default the deployment set (`KANTEL_MODEL_CONNECTORS`, `KANTEL_CPA_URL`), which the organisation's replaces. */
	readonly platformDefault?: { readonly connectorId: string; readonly modelId: string };
}

/** `POST /v1/model-providers/test` and `GET /v1/model-providers/connections/:id/models`. */
export interface ModelProviderModels {
	readonly items: readonly ModelProviderModel[];
}

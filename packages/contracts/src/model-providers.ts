/**
 * Model providers: how an organisation connects the models its agents run on, by subscription or by key, through the
 * model gateway's own paths (docs/model-connectors.md). It is what the console's onboarding and a host app call alike.
 *
 * - **A key provider** (Anthropic, OpenAI, OpenRouter, Vercel AI Gateway, any OpenAI-compatible server): the key goes
 *   into the vault as an organisation item bound to the provider's host, written once and never returned, and the
 *   model gateway gets an organisation connector naming that item, with a route named after the provider. The first
 *   one an organisation connects also takes its `default` route, which every agent profile names unless it says
 *   otherwise; an organisation's route is nearer than the platform's, so it wins. Harbour doesn't try the key with the
 *   provider: a wrong one shows at the first model call.
 * - **A subscription** (Claude, ChatGPT): signed in through the deployment's CLIProxyAPI, the gateway's existing path
 *   to subscriptions. CLIProxyAPI keeps the subscription's tokens and refreshes them; Harbour holds only CLIProxyAPI's
 *   client key, in the vault, as it already does. Offered only where the operator has given the gateway CLIProxyAPI's
 *   management key, since a sign-in there serves every organisation on the deployment.
 * - Reading needs an organisation-wide viewer; connecting, signing in and disconnecting need an organisation-wide
 *   admin, which no agent holds. No call returns or audits a key.
 *
 * Harbour adds nothing to a model's prompt on any of these paths.
 */
import type { CallContext, Timestamp } from "./common.ts";
import type { ConnectorPreset } from "./models.ts";

export type ModelProviderId =
	| "claude"
	| "chatgpt"
	| "anthropic"
	| "openai"
	| "openrouter"
	| "vercel-ai-gateway"
	| "openai-compatible";

export type ModelProviderAuth = "subscription" | "key";

export interface ModelProviderConnection {
	/** The model gateway connector that serves it. */
	readonly connectorId: string;
	/** The routes it serves: one named after the provider, and `default` when it took that. */
	readonly routes: readonly string[];
	/** The upstream model its route serves. */
	readonly modelId?: string;
	readonly baseUrl?: string;
	readonly connectedAt?: Timestamp;
	/** For a subscription: the account signed in, as CLIProxyAPI names it (an email), when it does. */
	readonly account?: string;
}

export interface ModelProvider {
	readonly id: ModelProviderId;
	readonly name: string;
	readonly description: string;
	readonly auth: ModelProviderAuth;
	/** The gateway preset its connector uses (`CONNECTOR_PRESET_SPECS`). */
	readonly preset: ConnectorPreset;
	/** For a key provider: the base URL used unless the caller names one. Absent when the caller must (any server). */
	readonly baseUrl?: string;
	/** The model a new connection's route serves unless the caller names one. */
	readonly defaultModel?: string;
	/** Where a person gets a key. */
	readonly keyUrl?: string;
	/** How keys start, as a hint for the field (`sk-ant-`). */
	readonly keyPrefix?: string;
	/** Whether this deployment can connect it. */
	readonly available: boolean;
	/** Why not, when it can't. */
	readonly unavailableReason?: string;
	/** The organisation's connection to it, when it has one. Never a secret. */
	readonly connection?: ModelProviderConnection;
}

/** The route sessions run on when their profile names `default`, as the gateway would resolve it now. */
export interface DefaultModelRoute {
	readonly connectorId: string;
	readonly modelId: string;
	/** Whose route it is: the deployment's (`platform`) or the organisation's own. */
	readonly owner: "platform" | "organisation";
}

export interface ModelProviderList {
	readonly items: readonly ModelProvider[];
	/** What `default` resolves to for the organisation now; absent when nothing serves it, so sessions can't run yet. */
	readonly defaultRoute?: DefaultModelRoute;
}

export interface ConnectModelKeyInput {
	/** The provider's API key. Stored in the vault and never returned. */
	readonly key: string;
	/** Another base URL, such as a proxy's; required for `openai-compatible`. https only, except to localhost. */
	readonly baseUrl?: string;
	/** The model the provider's route serves; default the provider's `defaultModel`. */
	readonly model?: string;
	/** Make it the organisation's `default` route even when another provider has it. Default: only if none does. */
	readonly makeDefault?: boolean;
}

export type ModelSignInStatus = "pending" | "completed" | "failed";

/** A subscription sign-in under way: open `url`, sign in with the provider, and poll until it settles. */
export interface ModelSignIn {
	readonly id: string;
	readonly providerId: ModelProviderId;
	readonly status: ModelSignInStatus;
	/** The provider's sign-in page. Present while pending. */
	readonly url?: string;
	/** Why it failed. */
	readonly error?: string;
}

export interface ModelProviders {
	/** Every provider, with whether this deployment can connect it and the organisation's connection to it. */
	list(ctx: CallContext): Promise<ModelProviderList>;
	/**
	 * Connects a key provider for the organisation, or replaces its key: a new vault item, the connector and its routes.
	 * Rejects with `invalid` for a subscription or a malformed key, base URL or model ID, and `unavailable` where the
	 * deployment can't use a key (see `ModelProvider.available`).
	 */
	connectKey(ctx: CallContext, providerId: ModelProviderId, input: ConnectModelKeyInput): Promise<ModelProvider>;
	/**
	 * Starts signing in to a subscription. `invalid` for a key provider; `unavailable` where the deployment can't (see
	 * `ModelProvider.available`).
	 */
	startSignIn(ctx: CallContext, providerId: ModelProviderId): Promise<ModelSignIn>;
	/** Where a sign-in is. */
	signInStatus(ctx: CallContext, providerId: ModelProviderId, signInId: string): Promise<ModelSignIn>;
	/**
	 * Finishes a sign-in whose provider couldn't redirect back to the deployment (a remote machine): the address the
	 * browser ended up on, which carries the code.
	 */
	finishSignIn(
		ctx: CallContext,
		providerId: ModelProviderId,
		signInId: string,
		redirectUrl: string,
	): Promise<ModelSignIn>;
	/**
	 * Removes the organisation's connector for a key provider and its routes, `default` among them when it names that
	 * connector. Its vault item stays, with no route to it. `invalid` for a subscription, which is signed out in
	 * CLIProxyAPI; `not_found` when the provider isn't connected.
	 */
	disconnect(ctx: CallContext, providerId: ModelProviderId): Promise<void>;
}

export const MODEL_PROVIDER_IDS: readonly ModelProviderId[] = [
	"claude",
	"chatgpt",
	"anthropic",
	"openai",
	"openrouter",
	"vercel-ai-gateway",
	"openai-compatible",
];

export const isModelProviderId = (value: unknown): value is ModelProviderId =>
	typeof value === "string" && (MODEL_PROVIDER_IDS as readonly string[]).includes(value);

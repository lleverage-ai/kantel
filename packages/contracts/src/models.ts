/**
 * Models. The runtime never calls a provider: it calls Harbour's internal model gateway, a platform service, over pi's
 * own `pi-messages` protocol, and the gateway decides which connector serves the call, attaches that connector's key
 * and streams pi events back (docs/model-connectors.md, decided by Tom on 27 Oct 2026).
 *
 * - A connector is configuration, not code: a preset (which fixes the pi-ai provider, wire APIs, key header and
 *   attribution), a base URL, the vault item holding its key, and a catalogue source.
 * - Connectors belong to the platform or an organisation. Projects only narrow them (allowed connectors and models)
 *   and may own routes over them; a project can never bring a connector (decision 2).
 * - Routes resolve platform → organisation → project, the nearest owner's route of a name winning, then the project's
 *   policy filters the result. Agents name a route (`ModelChoice.route`), never a connector, a URL or a key.
 * - The first call of a session pins `(connector, modelId)` for each route it uses, so editing a route never changes a
 *   running conversation's model.
 * - v1 has no Harbour-level cross-provider failover (decision 3): the gateway makes one upstream attempt per request
 *   and forwards the upstream's error text, redacted, so Pi Durable decides retries on the same route.
 *
 * The wire protocol is pi-ai's `pi-messages`, unchanged: `GET /v1/config` returns `{ baseUrl, models }` with one model
 * per route the session may use (its `id` is the route name), and `POST <baseUrl>/messages` takes `{ model, context,
 * options }` and answers with an SSE stream of `ModelStreamEvent`s ending in `done` or `error`. Every request carries
 * `Authorization: Bearer <session token>`; the gateway takes the caller's scope from the token, never from the body,
 * and ignores the client's other headers for the upstream request.
 *
 * Contracts hold no Pi types: the request context and the events are their JSON forms.
 */
import type {
	AgentId,
	CallContext,
	JsonValue,
	OrganisationId,
	Page,
	PageRequest,
	ProjectId,
	SessionId,
	SystemContext,
	Timestamp,
} from "./common.ts";

/** The paths of the gateway's HTTP API, relative to its base URL. */
export const MODEL_GATEWAY_PATHS = {
	config: "/v1/config",
	messages: "/messages",
} as const;

/** The pi-ai provider ID and API the runtime uses for every model call. */
export const HARBOUR_MODEL_PROVIDER = "harbour";
export const HARBOUR_MODEL_API = "pi-messages";

/** The wire APIs connectors speak upstream; all are implemented by pi-ai. */
export type ModelWireApi = "anthropic-messages" | "openai-completions" | "openai-responses";

/**
 * A preset fixes the pi-ai provider, the wire APIs, where the key goes and how scope reaches the upstream as
 * attribution and session affinity. `openai-compatible` and `anthropic-compatible` are for anything else.
 */
export type ConnectorPreset =
	| "litellm"
	| "vercel-ai-gateway"
	| "openrouter"
	| "anthropic"
	| "openai"
	| "cliproxyapi"
	| "openai-compatible"
	| "anthropic-compatible";

export const CONNECTOR_PRESETS: readonly ConnectorPreset[] = [
	"litellm",
	"vercel-ai-gateway",
	"openrouter",
	"anthropic",
	"openai",
	"cliproxyapi",
	"openai-compatible",
	"anthropic-compatible",
];

/** Who owns a connector: the platform's operator, or a tenant. Never a project (decision 2). */
export type ConnectorOwner =
	| { readonly kind: "platform" }
	| { readonly kind: "organisation"; readonly organisationId: OrganisationId };

/** Who owns a route. A project's route must use a connector its organisation or the platform owns. */
export type RouteOwner =
	| ConnectorOwner
	| { readonly kind: "project"; readonly organisationId: OrganisationId; readonly projectId: ProjectId };

/** A thinking level a route or a call asks for: pi's levels. */
export type ModelThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Rates in US dollars per million tokens. */
export interface ModelRates {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

/** What a connector's catalogue says about a model, or what an override supplies. */
export interface ModelOverride {
	/** A pi-ai catalogue ID (such as `anthropic/claude-opus-5-5`) to borrow metadata from, for aliases. */
	readonly canonical?: string;
	readonly name?: string;
	/** The wire API this model uses, on a connector whose preset speaks more than one. */
	readonly api?: ModelWireApi;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly reasoning?: boolean;
	readonly input?: readonly ("text" | "image")[];
	readonly rates?: ModelRates;
}

export interface ModelConnector {
	/** Unique across the platform, such as `lleverage-litellm` or `sal-cliproxyapi`. */
	readonly id: string;
	readonly owner: ConnectorOwner;
	readonly preset: ConnectorPreset;
	/** The upstream's base URL, such as `http://cliproxyapi.internal:8317/v1`. Its host must be one of the item's hosts. */
	readonly baseUrl: string;
	/** The vault item the gateway reads for this connector's key. Never a value. */
	readonly vaultItemId: string;
	readonly catalogue: {
		/** `gateway`: refresh what is available from the upstream's own list; `static`: only `include` and overrides. */
		readonly refresh: "gateway" | "static";
		/** Model IDs offered; absent means everything the upstream lists. */
		readonly include?: readonly string[];
		readonly overrides?: { readonly [modelId: string]: ModelOverride };
	};
	/** pi-ai compat options passed through to the upstream model, such as `openRouterRouting`. */
	readonly compat?: { readonly [key: string]: JsonValue };
	readonly createdAt: Timestamp;
	readonly updatedAt: Timestamp;
}

export interface ModelRoute {
	/**
	 * What `ModelChoice.route` names, such as `default`, `deep` or `fast`. Never contains `:`, which separates a route
	 * from a model override on the wire (`putRoute` rejects it with `invalid`).
	 */
	readonly name: string;
	readonly owner: RouteOwner;
	readonly connectorId: string;
	/** The upstream's own model ID, never translated across gateways. */
	readonly modelId: string;
	readonly thinking?: ModelThinking;
	readonly updatedAt: Timestamp;
}

/** A project's narrowing of its organisation's connectors. It can't add a connector or a model. */
export interface ProjectModelPolicy {
	readonly organisationId: OrganisationId;
	readonly projectId: ProjectId;
	/** Allowed connector IDs; absent means every connector the organisation and the platform own. */
	readonly connectors?: readonly string[];
	/** Allowed upstream model IDs on those connectors; absent means all of them. */
	readonly models?: readonly string[];
	readonly updatedAt: Timestamp;
}

/** Who is calling the gateway: the claims of a verified session token. */
export interface ModelCallScope {
	readonly organisationId: OrganisationId;
	readonly projectId: ProjectId;
	readonly agentId: AgentId;
	readonly sessionId: SessionId;
}

/** A route as resolved for one session: the route record and the connector serving it, after the project's policy. */
export interface ResolvedModelRoute {
	readonly route: ModelRoute;
	readonly connector: ModelConnector;
}

/**
 * The connector directory. Platform connectors and routes are changed by Harbour's operator only (a `system` caller);
 * an organisation's by an organisation-wide admin; a project's routes by an admin on the project; a project's policy by
 * an organisation-wide admin, since it bounds the project. Reads need viewer. Agents read and change nothing here.
 * Every change is audited.
 */
export interface ModelConnectors {
	/**
	 * Creates or replaces a connector. Rejects with `invalid` for an unknown preset or a base URL that isn't http(s).
	 * The vault, not the directory, checks at each key read that the item belongs to the connector's owner and is bound
	 * to the base URL's host.
	 */
	putConnector(ctx: CallContext, input: Omit<ModelConnector, "createdAt" | "updatedAt">): Promise<ModelConnector>;
	/** The platform's connectors and the caller's organisation's. Another organisation's are `not_found`. */
	getConnector(ctx: CallContext, connectorId: string): Promise<ModelConnector>;
	listConnectors(ctx: CallContext, page?: PageRequest): Promise<Page<ModelConnector>>;
	deleteConnector(ctx: CallContext, connectorId: string): Promise<void>;

	/**
	 * Creates or replaces the route `name` of `owner`. Rejects with `refused` when the connector isn't the platform's or
	 * the route owner's organisation's, or when a project route names a connector or model its project's policy
	 * excludes. Sessions that already pinned the route keep their pin.
	 */
	putRoute(ctx: CallContext, input: Omit<ModelRoute, "updatedAt">): Promise<ModelRoute>;
	/** The routes visible to the caller: the platform's, the organisation's and its projects'. */
	listRoutes(
		ctx: CallContext,
		filter?: { readonly projectId?: ProjectId },
		page?: PageRequest,
	): Promise<Page<ModelRoute>>;
	deleteRoute(ctx: CallContext, owner: RouteOwner, name: string): Promise<void>;

	setProjectPolicy(ctx: CallContext, policy: Omit<ProjectModelPolicy, "updatedAt">): Promise<ProjectModelPolicy>;
	/** A project without a policy reads as one with neither list: no narrowing. */
	getProjectPolicy(ctx: CallContext, projectId: ProjectId): Promise<ProjectModelPolicy>;

	/**
	 * A worker call for the gateway: the routes `scope` may use, each name resolved platform → organisation → project
	 * (nearest wins) and kept only when its connector and model pass the project's policy. Only a `system` caller.
	 */
	resolve(ctx: SystemContext, scope: ModelCallScope): Promise<readonly ResolvedModelRoute[]>;
}

/** What the gateway asks the vault for: one connector's key, for one session's call. */
export interface ConnectorCredentialRequest {
	readonly connectorId: string;
	readonly owner: ConnectorOwner;
	readonly vaultItemId: string;
	readonly baseUrl: string;
	/** The session the key is read for; the vault records it on the use. */
	readonly scope: ModelCallScope;
}

export interface ConnectorCredential {
	readonly itemId: string;
	/** Changes when the item's value rotates; the gateway drops a cached value whose version is stale. */
	readonly valueVersion: number;
	/** The key. Only the gateway ever holds it, in memory, for a few minutes at most. */
	readonly value: string;
	readonly useId: string;
}

/**
 * The vault's narrow credential read for connectors (proposed change 4 of docs/model-connectors.md). A worker call:
 * only the model gateway, as `system`, may make it; any other caller is `forbidden`, audited once as `access.denied`,
 * and records no use. The vault checks that the item belongs to the connector's owner (a platform item for a platform
 * connector, the organisation's own for an organisation's) and that the base URL's host is one of the item's `hosts`;
 * otherwise `refused`, with a denied use recorded. Unlike egress, plain http is allowed, since an upstream may be
 * internal (CPA on Sal's host is http on the tailnet). An item without a value is `refused` too. Every read records a
 * use.
 */
export interface ConnectorCredentials {
	readConnectorCredential(ctx: SystemContext, request: ConnectorCredentialRequest): Promise<ConnectorCredential>;
}

/** Issues and checks the short-lived tokens the runtime calls the gateway with. Only platform services hold the key. */
export interface ModelSessionTokens {
	/** A worker call for the session runtime: a token for `scope`, valid for `ttlMs` (the issuer caps it). */
	mint(
		ctx: SystemContext,
		scope: ModelCallScope,
		ttlMs?: number,
	): Promise<{ readonly token: string; readonly expiresAt: Timestamp }>;
	/**
	 * A worker call for the gateway: the token's scope. Rejects with `forbidden` for a token that isn't valid, and
	 * `expired` past its expiry. Like every worker call, any caller but `system` is `forbidden`, audited as
	 * `access.denied`.
	 */
	verify(ctx: SystemContext, token: string): Promise<ModelCallScope>;
}

/** One model in `GET /v1/config`, as pi-ai's `pi-messages` client reads it. */
export interface ModelGatewayModel {
	/** The route name, or `<route>:<modelId>` for an override (see `ModelGateway.config`). */
	readonly id: string;
	readonly name: string;
	readonly reasoning: boolean;
	/** pi thinking level → the upstream's value; `null` marks a level unsupported. */
	readonly thinkingLevelMap?: { readonly [level: string]: string | null };
	readonly input: readonly ("text" | "image")[];
	readonly cost: ModelRates;
	readonly contextWindow: number;
	readonly maxTokens: number;
}

export interface ModelGatewayConfig {
	/** Where the client posts `messages`. */
	readonly baseUrl: string;
	readonly models: readonly ModelGatewayModel[];
}

/** The body of `POST /messages`, as pi-ai's `pi-messages` client sends it. */
export interface ModelMessagesRequest {
	/**
	 * A route name, or `<route>:<modelId>` for a model the route's connector allows the project, split at the first
	 * `:` (upstream model IDs may contain colons). Always one of the IDs `config` listed.
	 */
	readonly model: string;
	/** pi's `Context` (system prompt, messages, tools) as JSON. Passed to the upstream, never logged or audited. */
	readonly context: JsonValue;
	readonly options?: {
		readonly temperature?: number;
		readonly maxTokens?: number;
		readonly reasoning?: ModelThinking;
		readonly cacheRetention?: "none" | "short" | "long";
		readonly sessionId?: string;
		readonly toolChoice?: JsonValue;
	};
}

/** Token counts and cost of one call, in pi's `Usage` shape. */
export interface ModelUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	/** Reasoning tokens, a subset of `output`, when the upstream reports them. */
	readonly reasoning?: number;
	readonly totalTokens: number;
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
}

/** One SSE event of the `messages` stream: pi-ai's `PiMessagesEvent`, as JSON. */
export type ModelStreamEvent =
	| { readonly type: "start" }
	| { readonly type: "text_start"; readonly contentIndex: number }
	| { readonly type: "text_delta"; readonly contentIndex: number; readonly delta: string }
	| {
			readonly type: "text_end";
			readonly contentIndex: number;
			readonly content: string;
			readonly contentSignature?: string;
	  }
	| { readonly type: "thinking_start"; readonly contentIndex: number }
	| { readonly type: "thinking_delta"; readonly contentIndex: number; readonly delta: string }
	| {
			readonly type: "thinking_end";
			readonly contentIndex: number;
			readonly content: string;
			readonly contentSignature?: string;
			readonly redacted?: boolean;
	  }
	| { readonly type: "toolcall_start"; readonly contentIndex: number; readonly id: string; readonly toolName: string }
	| { readonly type: "toolcall_delta"; readonly contentIndex: number; readonly delta: string }
	| {
			readonly type: "toolcall_end";
			readonly contentIndex: number;
			readonly toolCall: {
				readonly type: "toolCall";
				readonly id: string;
				readonly name: string;
				readonly arguments: { readonly [key: string]: JsonValue };
				/** Set when the model's arguments didn't parse; `arguments` is then empty and the call must not run. */
				readonly argumentsError?: string;
				readonly namespace?: string;
				readonly thoughtSignature?: string;
			};
	  }
	| {
			readonly type: "done";
			readonly reason: "stop" | "length" | "toolUse";
			readonly usage: ModelUsage;
			readonly responseId?: string;
			readonly providerThinkingLevel?: string;
	  }
	| {
			readonly type: "error";
			readonly reason: "aborted" | "error";
			readonly usage: ModelUsage;
			/** The upstream's error text, verbatim after redaction, so Durable can tell a retryable error. */
			readonly errorMessage?: string;
			readonly responseId?: string;
			readonly providerThinkingLevel?: string;
	  };

/**
 * What the gateway records for every call. It audits each one as a `model.call` event (source `session`, subject
 * `{ kind: "model.call", id }`) with the record's fields as data: never a prompt, a completion or a key.
 */
export interface ModelCallRecord {
	readonly id: string;
	readonly at: Timestamp;
	readonly scope: ModelCallScope;
	readonly route: string;
	readonly connectorId: string;
	readonly modelId: string;
	readonly status: "done" | "error" | "aborted";
	readonly stopReason?: string;
	readonly durationMs: number;
	readonly usage: ModelUsage;
	/** Where `usage.cost` came from: the upstream's report, catalogue rates, or none (tokens only, such as CPA). */
	readonly costSource: "reported" | "computed" | "none";
}

/**
 * The gateway, behind its HTTP API. `session` is the scope of a verified token: an HTTP binding verifies the bearer
 * with `ModelSessionTokens` and passes its claims here, never anything from the body.
 */
export interface ModelGateway {
	/**
	 * The session's routes as pi models, each with the metadata of the upstream model it is (or would be) pinned to.
	 * Overrides are listed too, as `<route>:<modelId>` with that model's own metadata, for every other model the route's
	 * connector offers (its catalogue as last refreshed, limited by `catalogue.include`) that the project's policy
	 * allows. A model ID the runtime sends must be one listed here.
	 */
	config(session: ModelCallScope, signal?: AbortSignal): Promise<ModelGatewayConfig>;
	/**
	 * Streams one call. Rejects before streaming with `not_found` for a route the session can't use and `refused` for
	 * a model its project's policy excludes. Once streaming, every failure is a terminal `error` event: an upstream
	 * error's text verbatim after redaction, one upstream attempt per call. Aborting `signal` cancels the upstream
	 * request. Each call that resolved a route (a connector and model chosen) records one `ModelCallRecord`; a call
	 * rejected before that records none.
	 */
	messages(
		session: ModelCallScope,
		request: ModelMessagesRequest,
		signal?: AbortSignal,
	): Promise<AsyncIterable<ModelStreamEvent>>;
	/** The calls recorded for the caller's organisation, newest first. Viewer on the project or session filtered by. */
	listCalls(
		ctx: CallContext,
		filter?: { readonly projectId?: ProjectId; readonly sessionId?: SessionId },
		page?: PageRequest,
	): Promise<Page<ModelCallRecord>>;
}

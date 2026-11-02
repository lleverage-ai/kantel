/**
 * The runtime's one model provider, `kantel`: pi-ai's own `pi-messages` client pointed at Kantel's internal model
 * gateway (packages/models/CONTRACT.md). The runtime holds a short-lived session token, never a provider key; the gateway
 * decides which connector serves each call.
 *
 * - `kantelResolveModel` maps a profile's `ModelChoice` to the gateway's model ID: the route, or `<route>:<modelId>`.
 *   The choice's `thinking` already travels as the conversation's thinking level, which Pi Durable sends as the
 *   request's `reasoning` option.
 * - `kantelProvider` is the pi-ai provider: its models come from `GET <baseUrl>/v1/config`, and every request carries
 *   `Authorization: Bearer <session token>` through the given `fetch`, so a Cloudflare service binding can carry it.
 * - `kantelModels` builds a `Models` per session for `createSessionRuntime({ models })`, with a token minted for the
 *   session's scope and minted again before it expires.
 * - `kantelImages` gives each session the gateway's `images` operation (`POST <baseUrl>/images`) and its config's
 *   models, for `createSessionRuntime({ images })` and the `generate_image` tool. Image-only models are left out of the
 *   chat catalogue `kantelProvider` publishes, so no chat picker offers one.
 */
import type { Model, Models } from "@earendil-works/pi-ai";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { getRadiusModelsFromConfig, type RadiusGatewayConfig } from "@earendil-works/pi-ai/providers/radius-config";
import {
	type Clock,
	type ErrorCode,
	type KANTEL_MODEL_API,
	KANTEL_MODEL_PROVIDER,
	KantelError,
	MODEL_GATEWAY_PATHS,
	type ModelCallScope,
	type ModelChoice,
	type ModelGatewayModel,
	type ModelImagesResult,
	type ModelSessionTokens,
	type SessionRecord,
	systemClock,
	systemContext,
} from "@kantel/contracts";
import type { SessionImages } from "./images.ts";
import type { ResolvedModel } from "./index.ts";

/** How the runtime reaches the model gateway. */
export interface KantelGateway {
	/** The gateway's base URL, such as `http://model-gateway.internal:8080`. */
	readonly baseUrl: string;
	/** The fetch every gateway request goes through, such as a service binding's. Default: `globalThis.fetch`. */
	readonly fetch?: typeof globalThis.fetch;
}

export interface KantelProviderOptions extends KantelGateway {
	/** The bearer of every request, read at each request so a token that is about to expire can be replaced. */
	readonly token: string | (() => string | Promise<string>);
}

export interface KantelModelsOptions {
	readonly gateway: KantelGateway;
	readonly tokens: Pick<ModelSessionTokens, "mint">;
	/** The lifetime asked for each session token; the issuer may cap it. Default: the issuer's. */
	readonly ttlMs?: number;
	readonly clock?: Clock;
}

/** A profile's model choice as the gateway's model ID: the route, or `<route>:<modelId>` when a model is chosen. */
export function kantelResolveModel(choice: ModelChoice): ResolvedModel {
	return {
		provider: KANTEL_MODEL_PROVIDER,
		modelId: choice.modelId === undefined ? choice.route : `${choice.route}:${choice.modelId}`,
	};
}

const ERROR_CODES: readonly ErrorCode[] = [
	"invalid",
	"not_found",
	"forbidden",
	"conflict",
	"expired",
	"refused",
	"exhausted",
	"unavailable",
	"aborted",
	"not_supported",
];
const isErrorCode = (code: unknown): code is ErrorCode => ERROR_CODES.includes(code as ErrorCode);

const gatewayUrl = (baseUrl: string, path: string) => `${baseUrl.replace(/\/+$/u, "")}${path}`;

function isGatewayConfig(value: unknown): value is RadiusGatewayConfig {
	if (typeof value !== "object" || value === null) return false;
	const config = value as { baseUrl?: unknown; models?: unknown };
	return typeof config.baseUrl === "string" && Array.isArray(config.models);
}

/** Whether a config model gives text: one with no `output` (an older gateway) does. */
const chats = (model: unknown) => {
	const output = (model as { output?: unknown }).output;
	return !Array.isArray(output) || output.includes("text");
};

/** The gateway's catalogue for the bearer of `token`: one pi model per route the session may chat with. */
async function loadGatewayModels(
	gateway: KantelGateway,
	token: string,
	signal: AbortSignal,
): Promise<Model<typeof KANTEL_MODEL_API>[]> {
	const config = await loadGatewayConfig(gateway, token, signal);
	return getRadiusModelsFromConfig(KANTEL_MODEL_PROVIDER, {
		...config,
		models: config.models.filter(chats),
	} as RadiusGatewayConfig);
}

/** The gateway's config for the bearer of `token`, as it answered. */
async function loadGatewayConfig(
	gateway: KantelGateway,
	token: string,
	signal: AbortSignal | undefined,
): Promise<RadiusGatewayConfig & { readonly models: readonly ModelGatewayModel[] }> {
	const url = gatewayUrl(gateway.baseUrl, MODEL_GATEWAY_PATHS.config);
	const response = await (gateway.fetch ?? globalThis.fetch)(url, {
		headers: { accept: "application/json", authorization: `Bearer ${token}` },
		...(signal === undefined ? {} : { signal }),
	});
	if (!response.ok) {
		throw new Error(`The model gateway's config failed: ${response.status} ${response.statusText}`);
	}
	const config: unknown = await response.json();
	if (!isGatewayConfig(config)) throw new Error("The model gateway's config is malformed");
	return config as RadiusGatewayConfig & { readonly models: readonly ModelGatewayModel[] };
}

/** The `kantel` provider: pi-ai's `pi-messages` client against the model gateway, its models from `/v1/config`. */
export function kantelProvider(options: KantelProviderOptions): Provider<typeof KANTEL_MODEL_API> {
	const { token, fetch } = options;
	const streams = piMessagesApi();
	const bearer = async () => (typeof token === "string" ? token : await token());
	// Known after the first refresh; empty before it.
	let catalogue: readonly Model<typeof KANTEL_MODEL_API>[] = [];
	const withFetch = <T extends object | undefined>(streamOptions: T) =>
		fetch === undefined ? streamOptions : { ...streamOptions, fetch };
	return {
		id: KANTEL_MODEL_PROVIDER,
		name: "Kantel",
		baseUrl: options.baseUrl,
		auth: {
			apiKey: {
				name: "Kantel session token",
				resolve: async () => ({ auth: { apiKey: await bearer() }, source: "Kantel session token" }),
			},
		},
		getModels: () => catalogue,
		refreshModels: async (context) => {
			if (!context.allowNetwork || context.signal.aborted) return;
			const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
			const models = await loadGatewayModels(options, key ?? (await bearer()), context.signal);
			if (context.signal.aborted) return;
			await context.publish({
				update: () => {
					catalogue = models;
				},
			});
		},
		stream: (model, context, streamOptions) => streams.stream(model, context, withFetch(streamOptions)),
		streamSimple: (model, context, streamOptions) => streams.streamSimple(model, context, withFetch(streamOptions)),
	};
}

/**
 * The runtime's `models` for the model gateway: for each session, a `Models` with only the `kantel` provider, its
 * catalogue loaded from the gateway, and a token for the session's organisation, project, agent and session. The token
 * is minted when first needed and again once half its lifetime has passed, so no request leaves with one about to
 * expire. A gateway whose config can't be loaded fails the session's opening with `unavailable`; the next use tries
 * again. Pass `resolveModel: kantelResolveModel` with it.
 */
/**
 * The session's token source: a token minted for its scope when first needed, and again once half its lifetime has
 * passed. Concurrent requests share one mint.
 */
function sessionToken(options: KantelModelsOptions, session: SessionRecord): () => string | Promise<string> {
	const clock = options.clock ?? systemClock;
	const scope: ModelCallScope = {
		organisationId: session.organisationId,
		projectId: session.projectId,
		agentId: session.agentId,
		sessionId: session.id,
	};
	let current: { readonly token: string; readonly renewAt: number } | undefined;
	let minting: Promise<string> | undefined;
	const mint = async () => {
		const mintedAt = clock.now();
		const { token, expiresAt } = await options.tokens.mint(systemContext("session"), scope, options.ttlMs);
		current = { token, renewAt: mintedAt + (expiresAt - mintedAt) / 2 };
		return token;
	};
	return () => {
		if (current !== undefined && clock.now() < current.renewAt) return current.token;
		minting ??= mint().finally(() => {
			minting = undefined;
		});
		return minting;
	};
}

/**
 * The gateway's image operation for each session (`SessionImages`): its config's models, and `POST <baseUrl>/images`
 * with the session's token. A refusal rejects with the gateway's `KantelError` code and message.
 */
export function kantelImages(options: KantelModelsOptions): (session: SessionRecord) => SessionImages {
	return (session) => {
		const token = sessionToken(options, session);
		const { gateway } = options;
		return {
			async models(signal) {
				return (await loadGatewayConfig(gateway, await token(), signal)).models;
			},
			async generate(request, signal) {
				const response = await (gateway.fetch ?? globalThis.fetch)(
					gatewayUrl(gateway.baseUrl, MODEL_GATEWAY_PATHS.images),
					{
						method: "POST",
						headers: {
							accept: "application/json",
							"content-type": "application/json",
							authorization: `Bearer ${await token()}`,
						},
						body: JSON.stringify(request),
						...(signal === undefined ? {} : { signal }),
					},
				);
				const body: unknown = await response.json().catch(() => undefined);
				if (!response.ok) {
					const error = (body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
					const message =
						typeof error?.message === "string" ? error.message : `${response.status} ${response.statusText}`;
					throw new KantelError(isErrorCode(error?.code) ? error.code : "unavailable", message);
				}
				return body as ModelImagesResult;
			},
		};
	};
}

export function kantelModels(options: KantelModelsOptions): (session: SessionRecord) => Promise<Models> {
	return async (session) => {
		const token = sessionToken(options, session);
		const models = createModels();
		models.setProvider(kantelProvider({ ...options.gateway, token }));
		const refreshed = await models.refresh({ providers: [KANTEL_MODEL_PROVIDER] });
		const failure = refreshed.errors.get(KANTEL_MODEL_PROVIDER);
		if (failure !== undefined) {
			throw new KantelError("unavailable", `Could not load the session's models: ${failure.message}`);
		}
		return models;
	};
}

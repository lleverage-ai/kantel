/**
 * The runtime's one model provider, `harbour`: pi-ai's own `pi-messages` client pointed at Harbour's internal model
 * gateway (docs/model-connectors.md). The runtime holds a short-lived session token, never a provider key; the gateway
 * decides which connector serves each call.
 *
 * - `harbourResolveModel` maps a profile's `ModelChoice` to the gateway's model ID: the route, or `<route>:<modelId>`.
 *   The choice's `thinking` already travels as the conversation's thinking level, which Pi Durable sends as the
 *   request's `reasoning` option.
 * - `harbourProvider` is the pi-ai provider: its models come from `GET <baseUrl>/v1/config`, and every request carries
 *   `Authorization: Bearer <session token>` through the given `fetch`, so a Cloudflare service binding can carry it.
 * - `harbourModels` builds a `Models` per session for `createSessionRuntime({ models })`, with a token minted for the
 *   session's scope and minted again before it expires.
 */
import type { Model, Models } from "@earendil-works/pi-ai";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { getRadiusModelsFromConfig, type RadiusGatewayConfig } from "@earendil-works/pi-ai/providers/radius-config";
import {
	type Clock,
	type HARBOUR_MODEL_API,
	HARBOUR_MODEL_PROVIDER,
	HarbourError,
	MODEL_GATEWAY_PATHS,
	type ModelCallScope,
	type ModelChoice,
	type ModelSessionTokens,
	type SessionRecord,
	systemClock,
	systemContext,
} from "@harbour/contracts";
import type { ResolvedModel } from "./index.ts";

/** How the runtime reaches the model gateway. */
export interface HarbourGateway {
	/** The gateway's base URL, such as `http://model-gateway.internal:8080`. */
	readonly baseUrl: string;
	/** The fetch every gateway request goes through, such as a service binding's. Default: `globalThis.fetch`. */
	readonly fetch?: typeof globalThis.fetch;
}

export interface HarbourProviderOptions extends HarbourGateway {
	/** The bearer of every request, read at each request so a token that is about to expire can be replaced. */
	readonly token: string | (() => string | Promise<string>);
}

export interface HarbourModelsOptions {
	readonly gateway: HarbourGateway;
	readonly tokens: Pick<ModelSessionTokens, "mint">;
	/** The lifetime asked for each session token; the issuer may cap it. Default: the issuer's. */
	readonly ttlMs?: number;
	readonly clock?: Clock;
}

/** A profile's model choice as the gateway's model ID: the route, or `<route>:<modelId>` when a model is chosen. */
export function harbourResolveModel(choice: ModelChoice): ResolvedModel {
	return {
		provider: HARBOUR_MODEL_PROVIDER,
		modelId: choice.modelId === undefined ? choice.route : `${choice.route}:${choice.modelId}`,
	};
}

const gatewayUrl = (baseUrl: string, path: string) => `${baseUrl.replace(/\/+$/u, "")}${path}`;

function isGatewayConfig(value: unknown): value is RadiusGatewayConfig {
	if (typeof value !== "object" || value === null) return false;
	const config = value as { baseUrl?: unknown; models?: unknown };
	return typeof config.baseUrl === "string" && Array.isArray(config.models);
}

/** The gateway's catalogue for the bearer of `token`: one pi model per route the session may use. */
async function loadGatewayModels(
	gateway: HarbourGateway,
	token: string,
	signal: AbortSignal,
): Promise<Model<typeof HARBOUR_MODEL_API>[]> {
	const url = gatewayUrl(gateway.baseUrl, MODEL_GATEWAY_PATHS.config);
	const response = await (gateway.fetch ?? globalThis.fetch)(url, {
		headers: { accept: "application/json", authorization: `Bearer ${token}` },
		signal,
	});
	if (!response.ok) {
		throw new Error(`The model gateway's config failed: ${response.status} ${response.statusText}`);
	}
	const config: unknown = await response.json();
	if (!isGatewayConfig(config)) throw new Error("The model gateway's config is malformed");
	return getRadiusModelsFromConfig(HARBOUR_MODEL_PROVIDER, config);
}

/** The `harbour` provider: pi-ai's `pi-messages` client against the model gateway, its models from `/v1/config`. */
export function harbourProvider(options: HarbourProviderOptions): Provider<typeof HARBOUR_MODEL_API> {
	const { token, fetch } = options;
	const streams = piMessagesApi();
	const bearer = async () => (typeof token === "string" ? token : await token());
	// Known after the first refresh; empty before it.
	let catalogue: readonly Model<typeof HARBOUR_MODEL_API>[] = [];
	const withFetch = <T extends object | undefined>(streamOptions: T) =>
		fetch === undefined ? streamOptions : { ...streamOptions, fetch };
	return {
		id: HARBOUR_MODEL_PROVIDER,
		name: "Harbour",
		baseUrl: options.baseUrl,
		auth: {
			apiKey: {
				name: "Harbour session token",
				resolve: async () => ({ auth: { apiKey: await bearer() }, source: "Harbour session token" }),
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
 * The runtime's `models` for the model gateway: for each session, a `Models` with only the `harbour` provider, its
 * catalogue loaded from the gateway, and a token for the session's organisation, project, agent and session. The token
 * is minted when first needed and again once half its lifetime has passed, so no request leaves with one about to
 * expire. A gateway whose config can't be loaded fails the session's opening with `unavailable`; the next use tries
 * again. Pass `resolveModel: harbourResolveModel` with it.
 */
export function harbourModels(options: HarbourModelsOptions): (session: SessionRecord) => Promise<Models> {
	const clock = options.clock ?? systemClock;
	return async (session) => {
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
		const token = () => {
			if (current !== undefined && clock.now() < current.renewAt) return current.token;
			// Concurrent requests share one mint.
			minting ??= mint().finally(() => {
				minting = undefined;
			});
			return minting;
		};
		const models = createModels();
		models.setProvider(harbourProvider({ ...options.gateway, token }));
		const refreshed = await models.refresh({ providers: [HARBOUR_MODEL_PROVIDER] });
		const failure = refreshed.errors.get(HARBOUR_MODEL_PROVIDER);
		if (failure !== undefined) {
			throw new HarbourError("unavailable", `Could not load the session's models: ${failure.message}`);
		}
		return models;
	};
}

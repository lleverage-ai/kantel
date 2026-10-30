/**
 * The model gateway service (M1-BE9, docs/model-connectors.md): `@harbour/models` built from config, behind one fetch
 * handler. Hosts adapt it: `node.ts` serves it on a Node `http` server (self-hosted), `worker.ts` is a Worker entry
 * (Cloudflare, called through a service binding with no public route).
 *
 * | Path | What |
 * | --- | --- |
 * | `GET <basePath>/v1/config`, `POST <basePath>/messages` | pi-ai's `pi-messages` protocol (`@harbour/models/http`) |
 * | `GET /healthz` | liveness, no auth |
 *
 * Connector keys are read through a `ConnectorCredentials`: in production the vault's egress decision API, through
 * `egressConnectorCredentials(createEgressDecisionClient(...))`, which the vault authenticates as the gateway's
 * component.
 */
import {
	type AuditSink,
	type CallContext,
	type Clock,
	type ConnectorCredentials,
	HarbourError,
	type ModelConnector,
	type ModelConnectors,
	type ModelGateway,
	type ModelRoute,
	type ModelSessionTokens,
	PLATFORM_ORGANISATION,
	type ProjectModelPolicy,
	systemContext,
	type UsageWriter,
} from "@harbour/contracts";
import { createMemoryModelConnectors } from "@harbour/models/directory";
import { createModelGateway, type ModelPinStore } from "@harbour/models/gateway";
import { createModelGatewayHttp } from "@harbour/models/http";
import { createHmacSessionTokens } from "@harbour/models/tokens";
import type { EgressDecisionClient } from "@harbour/vault/egress-api";

/** The connectors, routes and policies the gateway serves. JSON, so a host can read it from a file or a variable. */
export interface ModelGatewayConfig {
	/** The gateway's base URL as session hosts reach it; `/v1/config` returns it. */
	readonly baseUrl: string;
	/** Route prefix for the model API, without a trailing slash, such as `/models`. Default none. */
	readonly basePath?: string;
	readonly connectors: readonly Omit<ModelConnector, "createdAt" | "updatedAt">[];
	readonly routes: readonly Omit<ModelRoute, "updatedAt">[];
	readonly policies?: readonly Omit<ProjectModelPolicy, "updatedAt">[];
}

export interface ModelGatewayAppOptions {
	readonly config: ModelGatewayConfig;
	/** The session token key, shared with the session runtime that mints tokens. At least 32 bytes. */
	readonly tokenKey: string;
	readonly credentials: ConnectorCredentials;
	/** Where `model.call` and directory events go: an outbox in production. */
	readonly audit: AuditSink;
	/** How the gateway reaches upstreams. Default `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	readonly clock?: Clock;
	readonly pins?: ModelPinStore;
	/** Where each call's usage record goes: the host's usage ledger (`@harbour/usage`). Without it, none is written. */
	readonly usage?: UsageWriter;
}

export interface ModelGatewayApp {
	readonly handler: (request: Request) => Promise<Response>;
	readonly gateway: ModelGateway;
	readonly connectors: ModelConnectors;
	readonly tokens: ModelSessionTokens;
}

/** The caller that loads `config` into the directory: Harbour's operator, outside every organisation. */
export const MODEL_GATEWAY_CONFIG_CONTEXT: CallContext = {
	...systemContext("model-gateway.config"),
	organisationId: PLATFORM_ORGANISATION,
};

export const HEALTH_PATH = "/healthz";

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks `value` has the shape of a `ModelGatewayConfig`; anything else is `invalid`. The directory checks each
 * connector, route and policy in full when the app loads them.
 */
export function parseModelGatewayConfig(value: unknown): ModelGatewayConfig {
	const list = (field: unknown) => field === undefined || (Array.isArray(field) && field.every(isRecord));
	if (
		!isRecord(value) ||
		typeof value.baseUrl !== "string" ||
		(value.basePath !== undefined && typeof value.basePath !== "string") ||
		!Array.isArray(value.connectors) ||
		!Array.isArray(value.routes) ||
		!list(value.connectors) ||
		!list(value.routes) ||
		!list(value.policies)
	) {
		throw new HarbourError(
			"invalid",
			"The model gateway config needs a baseUrl and lists of connectors and routes, and optionally of policies",
		);
	}
	let url: URL;
	try {
		url = new URL(value.baseUrl);
	} catch {
		throw new HarbourError("invalid", "The model gateway's baseUrl must be an absolute URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new HarbourError("invalid", "The model gateway's baseUrl must be http or https");
	}
	return value as unknown as ModelGatewayConfig;
}

/**
 * Adapts the vault's egress decision client to `ConnectorCredentials`. The client authenticates as its own component
 * with a shared key, so the call context's actor is not sent; its abort signal is.
 */
export function egressConnectorCredentials(
	client: Pick<EgressDecisionClient, "readConnectorCredential">,
): ConnectorCredentials {
	return {
		readConnectorCredential: (ctx, request) => client.readConnectorCredential(request, ctx.signal),
	};
}

/** Builds the gateway, loads `config` into a memory directory and returns the service's fetch handler. */
export async function createModelGatewayApp(options: ModelGatewayAppOptions): Promise<ModelGatewayApp> {
	const config = parseModelGatewayConfig(options.config);
	const clock = options.clock;
	const connectors = createMemoryModelConnectors({ ...(clock === undefined ? {} : { clock }), audit: options.audit });
	for (const policy of config.policies ?? []) await connectors.setProjectPolicy(MODEL_GATEWAY_CONFIG_CONTEXT, policy);
	for (const connector of config.connectors) await connectors.putConnector(MODEL_GATEWAY_CONFIG_CONTEXT, connector);
	for (const route of config.routes) await connectors.putRoute(MODEL_GATEWAY_CONFIG_CONTEXT, route);

	const tokens = createHmacSessionTokens({
		key: options.tokenKey,
		...(clock === undefined ? {} : { clock }),
		audit: options.audit,
	});
	const gateway = createModelGateway({
		connectors,
		credentials: options.credentials,
		audit: options.audit,
		baseUrl: config.baseUrl,
		...(clock === undefined ? {} : { clock }),
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		...(options.pins === undefined ? {} : { pins: options.pins }),
		...(options.usage === undefined ? {} : { usage: options.usage }),
	});
	const models = createModelGatewayHttp({
		gateway,
		tokens,
		...(config.basePath === undefined ? {} : { basePath: config.basePath }),
	});

	const handler = async (request: Request): Promise<Response> => {
		if (new URL(request.url).pathname === HEALTH_PATH) {
			return new Response("ok\n", {
				headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
			});
		}
		return models(request);
	};
	return { handler, gateway, connectors, tokens };
}

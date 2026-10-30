/**
 * The model gateway on Cloudflare (#17, step 2): sessions call `@harbour/model-gateway` over pi-ai's `pi-messages`
 * protocol, and the gateway calls CLIProxyAPI on Sal's host through the `MODELS` Workers VPC service (the `sal-app`
 * tunnel, so CPA has no public route). Portable (no `cloudflare:workers`): `src/stack-object.ts` passes the bindings in,
 * and the tests run it in Node over a fake upstream.
 *
 * - **Where it runs.** In the stack's own object, beside the runtime that calls it. The runtime's `harbour` provider
 *   reaches it through a `fetch` that calls the gateway's handler directly, so no request leaves the isolate until the
 *   gateway calls CPA. The gateway's own `fetch` reaches only CPA's host, and only through the VPC service.
 * - **Session tokens.** Minted and verified by this one gateway, so the key is 32 random bytes made when the object
 *   starts and never stored. A restarted object makes a new key; each session mints a new token when it reopens.
 * - **CPA's key.** The connector names a platform vault item, never a value. The vault object makes that item from the
 *   `HARBOUR_CPA_API_KEY` Worker secret it holds (`src/vault.ts`), and the gateway reads it through the vault, which
 *   checks the item's host and records each use. A rotated secret makes a new item, named from a hash of the value.
 * - **Models.** One platform route, `default`, the route the default agent profile names, to `HARBOUR_DEFAULT_MODEL`
 *   (default `claude-sonnet-5-5`); every other model CPA lists is offered as `default:<model>`.
 *
 * Without the `MODELS` binding or the CPA key, sessions stay on the echo model (`src/echo-model.ts`).
 */
import type { AuditSink, Clock, ConnectorCredentials, InjectionRule, UsageWriter } from "@harbour/contracts";
import { HarbourError } from "@harbour/contracts";
import { createModelGatewayApp, type ModelGatewayApp, type ModelGatewayConfig } from "@harbour/model-gateway";
import type { SessionRuntimeOptions } from "@harbour/runtime/core";
import { harbourModels, harbourResolveModel } from "@harbour/runtime/models";

export interface ModelsVars {
	/** CLIProxyAPI's client key (a Worker secret). The vault object keeps it as a platform item. */
	readonly HARBOUR_CPA_API_KEY?: string;
	/** The upstream model the `default` route serves. Default `DEFAULT_MODEL`. */
	readonly HARBOUR_DEFAULT_MODEL?: string;
}

/**
 * The host CPA is called on. The VPC service decides where a request goes, whatever the URL says, so this name only
 * fills the Host header; it is also the host the vault item is bound to.
 */
export const CPA_HOST = "cliproxyapi.harbour.internal";
export const CPA_BASE_URL = `http://${CPA_HOST}/v1`;
export const CPA_CONNECTOR_ID = "sal-cliproxyapi";
/** CPA takes its client key as a bearer token. */
export const CPA_INJECTION: InjectionRule = { header: "Authorization", template: "Bearer {key}" };
/** The gateway as the runtime addresses it. Never resolved: the runtime's fetch hands each request to the gateway. */
export const GATEWAY_BASE_URL = "http://model-gateway.harbour.internal";
export const DEFAULT_ROUTE = "default";
export const DEFAULT_MODEL = "claude-sonnet-5-5";

const trimmed = (value: string | undefined): string => (value ?? "").trim();

/** CPA's key, or `undefined` when the Worker has none. */
export function cpaKey(vars: ModelsVars): string | undefined {
	const key = trimmed(vars.HARBOUR_CPA_API_KEY);
	return key === "" ? undefined : key;
}

/** The model the `default` route serves. Refuses (`invalid`) a value with spaces or a colon, which no model ID has. */
export function defaultModel(vars: ModelsVars): string {
	const model = trimmed(vars.HARBOUR_DEFAULT_MODEL);
	if (model === "") return DEFAULT_MODEL;
	if (/[\s:]/.test(model)) throw new HarbourError("invalid", "HARBOUR_DEFAULT_MODEL must be one model ID");
	return model;
}

/**
 * The vault item's name for this key: `cliproxyapi-` and the first 12 hex digits of its SHA-256. A rotated key gets a
 * new item, so the old value is never served again; the digest reveals nothing usable about a random key.
 */
export async function cpaItemName(key: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
	const hex = [...digest.slice(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `cliproxyapi-${hex}`;
}

/** What the gateway needs of the vault: CPA's item, and the connector key read. */
export interface ModelsVault {
	/** The platform item holding CPA's key: the vault object finds it, or makes it from the key it holds. */
	cpaItem(): Promise<string>;
	readonly readConnectorCredential: ConnectorCredentials["readConnectorCredential"];
}

export interface GatewayModelsOptions {
	/** The `MODELS` VPC service's fetch. */
	readonly upstream: (input: Request) => Promise<Response>;
	readonly vault: ModelsVault;
	/** Where `model.call` events go: the stack's audit store. */
	readonly audit: AuditSink;
	readonly modelId: string;
	readonly clock?: Clock;
	/** Where each call's usage record goes: the stack object's usage ledger (`src/usage.ts`). */
	readonly usage?: UsageWriter;
}

/** The runtime's `models` and `resolveModel`. */
export type StackModels = Pick<SessionRuntimeOptions, "models" | "resolveModel">;

/** The gateway's one connector (CPA) and one route. */
export function modelGatewayConfig(vaultItemId: string, modelId: string): ModelGatewayConfig {
	return {
		baseUrl: GATEWAY_BASE_URL,
		connectors: [
			{
				id: CPA_CONNECTOR_ID,
				owner: { kind: "platform" },
				preset: "cliproxyapi",
				baseUrl: CPA_BASE_URL,
				vaultItemId,
				catalogue: { refresh: "gateway" },
			},
		],
		routes: [{ name: DEFAULT_ROUTE, owner: { kind: "platform" }, connectorId: CPA_CONNECTOR_ID, modelId }],
	};
}

/** A fetch that reaches CPA through the VPC service and refuses any other host, so no call leaves another way. */
export function cpaOnly(upstream: GatewayModelsOptions["upstream"]): typeof fetch {
	return async (input, init) => {
		const request = new Request(input, init);
		if (new URL(request.url).hostname !== CPA_HOST) {
			throw new HarbourError("refused", "The model gateway on Cloudflare reaches only CLIProxyAPI");
		}
		return upstream(request);
	};
}

/**
 * Sessions on the model gateway. The gateway is built on the first session's first call (it needs the vault item), and
 * built again on the next call if that fails, so a vault that was not ready yet does not stick.
 */
export function createGatewayModels(options: GatewayModelsOptions): StackModels {
	// The app takes the key as a string of at least 32 characters: 32 random bytes in hex are 64.
	const tokenKey = [...crypto.getRandomValues(new Uint8Array(32))]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	let app: Promise<ModelGatewayApp> | undefined;
	const gateway = (): Promise<ModelGatewayApp> => {
		if (app === undefined) {
			const building = (async () =>
				createModelGatewayApp({
					config: modelGatewayConfig(await options.vault.cpaItem(), options.modelId),
					tokenKey,
					credentials: { readConnectorCredential: options.vault.readConnectorCredential },
					audit: options.audit,
					fetch: cpaOnly(options.upstream),
					...(options.clock === undefined ? {} : { clock: options.clock }),
					...(options.usage === undefined ? {} : { usage: options.usage }),
				}))();
			app = building;
			building.catch(() => {
				if (app === building) app = undefined;
			});
		}
		return app;
	};
	return {
		models: harbourModels({
			gateway: {
				baseUrl: GATEWAY_BASE_URL,
				fetch: async (input, init) => (await gateway()).handler(new Request(input, init)),
			},
			tokens: { mint: async (ctx, scope, ttlMs) => (await gateway()).tokens.mint(ctx, scope, ttlMs) },
			...(options.clock === undefined ? {} : { clock: options.clock }),
		}),
		resolveModel: harbourResolveModel,
	};
}

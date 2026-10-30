/**
 * The model gateway on the self-hosted gateway (#232, as Cloudflare's `src/models.ts` for #17): sessions call
 * `@harbour/model-gateway` in this process over pi-ai's `pi-messages` protocol, and the gateway calls CLIProxyAPI
 * (CPA) at `HARBOUR_CPA_URL`. Next to Sal (`deploy/compose/next-to-sal.yaml`, on the host's network) that is CPA's
 * address on Sal's host.
 *
 * - **Where it runs.** In the gateway's process, beside the runtime that calls it. The runtime's `harbour` provider
 *   reaches it through a `fetch` that calls the gateway's handler directly; the gateway's own `fetch` reaches only
 *   CPA's host.
 * - **Session tokens.** Minted and verified by this one gateway, so the key is 32 random bytes made at start and never
 *   stored. A restarted gateway makes a new key; each session mints a new token when it reopens.
 * - **CPA's key.** The connector names a platform vault item, never a value. At the first model call the gateway
 *   finds that item in its vault, or makes it from `HARBOUR_CPA_API_KEY`, and reads the key through the vault, which
 *   checks the item's host and records each use. So it needs the vault (`HARBOUR_VAULT_CIPHER_KEY` on Postgres). A
 *   rotated key makes a new item, named from a hash of the value.
 * - **Models.** One platform route, `default`, to `HARBOUR_DEFAULT_MODEL` (default `claude-sonnet-5-5`); every other
 *   model CPA lists is offered as `default:<model>`. The bootstrap's `assistant` profile names it. The `echo` route
 *   stays on the echo model, so the bootstrap's `echo` profile and the end-to-end checks work as before.
 *
 * Without `HARBOUR_CPA_URL` and `HARBOUR_CPA_API_KEY`, sessions stay on the echo model.
 */

import type { Models, MutableModels } from "@earendil-works/pi-ai/models";
import {
	type AuditSink,
	type CallContext,
	type Clock,
	HarbourError,
	type InjectionRule,
	type ModelChoice,
	PLATFORM_ORGANISATION,
	systemContext,
	type UsageWriter,
} from "@harbour/contracts";
import { createModelGatewayApp, type ModelGatewayApp, type ModelGatewayConfig } from "@harbour/model-gateway";
import { harbourModels, harbourResolveModel } from "@harbour/runtime/models";
import type { HarbourVault } from "@harbour/vault/engine";
import { ECHO_ROUTE, echoProvider, type GatewayModels, type ModelGatewaySource } from "./components.ts";

export interface CpaConfig {
	/** CPA's API root with its `/v1`, such as `http://127.0.0.1:8317/v1`. */
	readonly baseUrl: string;
	/** CPA's client key. The vault keeps it as a platform item; the gateway never holds it otherwise. */
	readonly apiKey: string;
	/** The upstream model the `default` route serves. */
	readonly modelId: string;
}

export const CPA_CONNECTOR_ID = "sal-cliproxyapi";
/** CPA takes its client key as a bearer token. */
export const CPA_INJECTION: InjectionRule = { header: "Authorization", template: "Bearer {key}" };
/** The gateway as the runtime addresses it. Never resolved: the runtime's fetch hands each request to the gateway. */
export const GATEWAY_BASE_URL = "http://model-gateway.harbour.internal";
export const DEFAULT_ROUTE = "default";
export const DEFAULT_MODEL = "claude-sonnet-5-5";
const MIN_CPA_KEY_LENGTH = 16;

/** The caller that makes the deployment's platform items: Harbour's operator, outside every organisation. */
const VAULT_SEED_CONTEXT: CallContext = {
	...systemContext("selfhosted.vault-seed"),
	organisationId: PLATFORM_ORGANISATION,
};

/**
 * CPA from the environment, or `undefined` when neither `HARBOUR_CPA_URL` nor `HARBOUR_CPA_API_KEY` is set. Throws on
 * one without the other, a URL that isn't http(s), a key under 16 characters or with spaces (the model gateway's
 * redaction skips very short secrets, and the item's name would let a short key be guessed), or a model ID with spaces
 * or a colon.
 */
export function cpaConfig(env: NodeJS.ProcessEnv = process.env): CpaConfig | undefined {
	const url = env.HARBOUR_CPA_URL?.trim() ?? "";
	const apiKey = env.HARBOUR_CPA_API_KEY?.trim() ?? "";
	if (url === "" && apiKey === "") return undefined;
	if (url === "" || apiKey === "") throw new Error("HARBOUR_CPA_URL and HARBOUR_CPA_API_KEY go together");
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("HARBOUR_CPA_URL must be a URL, such as http://127.0.0.1:8317/v1");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("HARBOUR_CPA_URL must be an http: or https: URL");
	}
	if (apiKey.length < MIN_CPA_KEY_LENGTH || /\s/.test(apiKey)) {
		throw new Error("HARBOUR_CPA_API_KEY must be at least 16 characters with no spaces");
	}
	const modelId = env.HARBOUR_DEFAULT_MODEL?.trim() || DEFAULT_MODEL;
	if (/[\s:]/.test(modelId)) throw new Error("HARBOUR_DEFAULT_MODEL must be one model ID");
	return { baseUrl: url.replace(/\/+$/, ""), apiKey, modelId };
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

/** The platform item holding CPA's key, as the bootstrap file records it (`Bootstrap.cpaItem`). */
export interface CpaItem {
	readonly name: string;
	readonly id: string;
}

/**
 * The platform item holding CPA's key: `previous`, the one an earlier start of this deployment made, when it was made
 * for this key; otherwise a new one bound to CPA's host. The vault lists no platform items and has no way to replace
 * an item's value, so the bootstrap file remembers the item, and a new key makes a new item.
 */
export async function seedCpaItem(vault: HarbourVault, cpa: CpaConfig, previous?: CpaItem): Promise<CpaItem> {
	const name = await cpaItemName(cpa.apiKey);
	if (previous?.name === name) return previous;
	const item = await vault.putItem(VAULT_SEED_CONTEXT, {
		owner: { kind: "platform" },
		name,
		description: "CLIProxyAPI's client key, from the gateway's HARBOUR_CPA_API_KEY",
		hosts: [new URL(cpa.baseUrl).hostname],
		injection: CPA_INJECTION,
		value: cpa.apiKey,
	});
	return { name, id: item.id };
}

/** The gateway's one connector (CPA) and one route. */
export function modelGatewayConfig(cpa: CpaConfig, vaultItemId: string): ModelGatewayConfig {
	return {
		baseUrl: GATEWAY_BASE_URL,
		connectors: [
			{
				id: CPA_CONNECTOR_ID,
				owner: { kind: "platform" },
				preset: "cliproxyapi",
				baseUrl: cpa.baseUrl,
				vaultItemId,
				catalogue: { refresh: "gateway" },
			},
		],
		routes: [{ name: DEFAULT_ROUTE, owner: { kind: "platform" }, connectorId: CPA_CONNECTOR_ID, modelId: cpa.modelId }],
	};
}

/** A fetch that reaches only CPA's origin and refuses any other, so no call leaves another way. */
export function cpaOnly(cpa: CpaConfig, upstream: typeof fetch = fetch): typeof fetch {
	const origin = new URL(cpa.baseUrl).origin;
	return async (input, init) => {
		const request = new Request(input, init);
		if (new URL(request.url).origin !== origin) {
			throw new HarbourError("refused", "The self-hosted model gateway reaches only CLIProxyAPI");
		}
		return upstream(request);
	};
}

/** What CPA said to the start's check of its key and the `default` route's model (`probeCpa`). */
export type CpaProbe =
	| { readonly result: "ok"; readonly models: number }
	| { readonly result: "model_missing"; readonly models: number }
	| { readonly result: "key_refused"; readonly status: number }
	| { readonly result: "failed"; readonly detail: string };

const CPA_PROBE_TIMEOUT_MS = 5_000;

/**
 * Asks CPA for its model list with the configured key, as the model gateway's catalogue does at a session's first
 * model call. A key CPA doesn't know, or a `default` model it doesn't list, leaves the route out of every session's
 * catalogue, so sessions fail with `no_model` and nothing else says why: the start logs this instead. Never throws, and
 * the result carries no part of the key.
 */
export async function probeCpa(cpa: CpaConfig, upstream: typeof fetch = fetch): Promise<CpaProbe> {
	try {
		const response = await cpaOnly(cpa, upstream)(`${cpa.baseUrl}/models`, {
			headers: { accept: "application/json", authorization: `Bearer ${cpa.apiKey}` },
			signal: AbortSignal.timeout(CPA_PROBE_TIMEOUT_MS),
		});
		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel();
			return { result: "key_refused", status: response.status };
		}
		if (!response.ok) {
			await response.body?.cancel();
			return { result: "failed", detail: `HTTP ${response.status}` };
		}
		const body = (await response.json()) as { data?: unknown };
		const ids = Array.isArray(body.data)
			? body.data.flatMap((model) =>
					typeof model === "object" && model !== null && typeof (model as { id?: unknown }).id === "string"
						? [(model as { id: string }).id]
						: [],
				)
			: [];
		return { result: ids.includes(cpa.modelId) ? "ok" : "model_missing", models: ids.length };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { result: "failed", detail: message.split(cpa.apiKey).join("[redacted]") };
	}
}

/** The start's log line for `probeCpa`'s result: what is wrong and what to change, never the key. */
export function describeCpaProbe(cpa: CpaConfig, probe: CpaProbe): string {
	switch (probe.result) {
		case "ok":
			return `[gateway] CLIProxyAPI accepted the key and lists ${cpa.modelId} (${probe.models} models)`;
		case "model_missing":
			return (
				`[gateway] warning: CLIProxyAPI lists ${probe.models} models but not ${cpa.modelId}, so sessions on route ` +
				`default fail with no_model: set HARBOUR_DEFAULT_MODEL to a model it lists`
			);
		case "key_refused":
			return (
				`[gateway] warning: CLIProxyAPI refused HARBOUR_CPA_API_KEY (HTTP ${probe.status}), so sessions on route ` +
				`default fail with no_model: use one of the api-keys in CLIProxyAPI's config`
			);
		case "failed":
			return (
				`[gateway] warning: could not check CLIProxyAPI at ${cpa.baseUrl} (${probe.detail}); sessions on route ` +
				`default fail with no_model until it answers`
			);
	}
}

export interface GatewayModelsOptions {
	readonly cpa: CpaConfig;
	/** CPA's platform item, once the start has seeded it (`seedCpaItem`). The first model call waits for it. */
	readonly item: Promise<string>;
	/** The gateway's vault, once the components have made it. Read at the first model call. */
	readonly vault: () => HarbourVault | undefined;
	/** Where `model.call` events go: the gateway's audit store. */
	readonly audit: AuditSink;
	/** CPA's fetch; default the global one. Tests pass a fake upstream's. */
	readonly upstream?: typeof fetch;
	readonly clock?: Clock;
	/** Where each call's usage row goes: the Postgres usage ledger (`usage.ts`). */
	readonly usage?: UsageWriter;
}

/** `ModelGatewaySource`, and the seeding the start does once the components and the bootstrap are ready. */
export interface CpaModelGateway extends ModelGatewaySource {
	/**
	 * Finds or makes CPA's item in the components' vault (`seedCpaItem`) and hands it to the gateway, which waits for
	 * it: a session resumed before this answers once it is done. Resolves the item for the bootstrap file.
	 */
	seed(vault: HarbourVault | undefined, previous?: CpaItem): Promise<CpaItem>;
}

/** The components' model gateway over CPA: sessions on `createGatewayModels`, the bootstrap's profile on `default`. */
export function modelGatewaySource(
	cpa: CpaConfig,
	options: Pick<GatewayModelsOptions, "upstream" | "clock"> = {},
): CpaModelGateway {
	let seeded: (itemId: string) => void = () => {};
	const item = new Promise<string>((resolve) => {
		seeded = resolve;
	});
	return {
		route: DEFAULT_ROUTE,
		build: ({ vault, audit, usage }) =>
			createGatewayModels({ ...options, cpa, item, vault, audit, ...(usage === undefined ? {} : { usage }) }),
		async seed(vault, previous) {
			if (vault === undefined)
				throw new Error("HARBOUR_CPA_API_KEY is kept in the vault: set HARBOUR_VAULT_CIPHER_KEY");
			const found = await seedCpaItem(vault, cpa, previous);
			seeded(found.id);
			return found;
		},
	};
}

/**
 * Sessions on the model gateway, with the `echo` route kept on the echo model. The gateway is built at the first
 * model call (it needs the vault item), and built again on the next call if that fails.
 */
export function createGatewayModels(options: GatewayModelsOptions): GatewayModels {
	const vault = (): HarbourVault => {
		const found = options.vault();
		if (found === undefined) {
			throw new HarbourError("unavailable", "The model gateway needs the vault: set HARBOUR_VAULT_CIPHER_KEY");
		}
		return found;
	};
	// The app takes the key as a string of at least 32 characters: 32 random bytes in hex are 64.
	const tokenKey = [...crypto.getRandomValues(new Uint8Array(32))]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	let app: Promise<ModelGatewayApp> | undefined;
	const gateway = (): Promise<ModelGatewayApp> => {
		if (app === undefined) {
			const building = (async () =>
				createModelGatewayApp({
					config: modelGatewayConfig(options.cpa, await options.item),
					tokenKey,
					credentials: { readConnectorCredential: (ctx, request) => vault().readConnectorCredential(ctx, request) },
					audit: options.audit,
					fetch: cpaOnly(options.cpa, options.upstream),
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
	const sessionModels = harbourModels({
		gateway: {
			baseUrl: GATEWAY_BASE_URL,
			fetch: async (input, init) => (await gateway()).handler(new Request(input, init)),
		},
		tokens: { mint: async (ctx, scope, ttlMs) => (await gateway()).tokens.mint(ctx, scope, ttlMs) },
		...(options.clock === undefined ? {} : { clock: options.clock }),
	});
	const echo = echoProvider();
	return {
		models: async (session) => {
			// `harbourModels` makes each session's collection with pi-ai's `createModels`, which is mutable.
			const models = (await sessionModels(session)) as Partial<MutableModels> & Models;
			if (typeof models.setProvider !== "function") throw new Error("the session's models cannot take the echo model");
			models.setProvider(echo);
			return models;
		},
		resolveModel: (choice: ModelChoice) =>
			choice.route === ECHO_ROUTE && choice.modelId === undefined
				? { provider: echo.id, modelId: ECHO_ROUTE }
				: harbourResolveModel(choice),
	};
}

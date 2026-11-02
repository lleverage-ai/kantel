/**
 * The model gateway on the self-hosted gateway (#232, as Cloudflare's `src/models.ts` for #17): sessions call
 * `@kantel/model-gateway` in this process over pi-ai's `pi-messages` protocol, and the gateway calls the deployment's
 * platform connectors. By default that is one connector, CLIProxyAPI (CPA) at `KANTEL_CPA_URL`; next to a host
 * app (`deploy/compose/next-to-sal.yaml`, on the host's network) that is CPA's address on the host.
 * `KANTEL_MODEL_CONNECTORS` (or `KANTEL_MODEL_CONNECTORS_FILE`) replaces it with connectors of any preset, such as
 * one LiteLLM key for a whole deployment (`modelConnectorsConfig`).
 *
 * - **Where it runs.** In the gateway's process, beside the runtime that calls it. The runtime's `kantel` provider
 *   reaches it through a `fetch` that calls the gateway's handler directly; the gateway's own `fetch` reaches only the
 *   configured connectors' origins (`connectorsOnly`).
 * - **Session tokens.** Minted and verified by this one gateway, so the key is 32 random bytes made at start and never
 *   stored. A restarted gateway makes a new key; each session mints a new token when it reopens.
 * - **Keys.** Each connector names a platform vault item, never a value. At start the gateway finds that item in its
 *   vault, or makes it from the connector's key variable (`KANTEL_CPA_API_KEY` for CPA), and reads the key through the
 *   vault, which checks the item's host and records each use. So it needs the vault (`KANTEL_VAULT_CIPHER_KEY` on
 *   Postgres). A rotated key makes a new item, named from a hash of the value.
 * - **Models.** A platform route `default`, which the bootstrap's `assistant` profile names: to `KANTEL_DEFAULT_MODEL`
 *   (default `claude-sonnet-5-5`) on the one connector, or as the connectors config's `routes` say. Every other model a
 *   route's connector lists is offered as `<route>:<model>`. The `echo` route stays on the echo model, so the
 *   bootstrap's `echo` profile and the end-to-end checks work as before.
 *
 * Without any of these, sessions stay on the echo model.
 */

import { readFileSync } from "node:fs";
import type { Models, MutableModels } from "@earendil-works/pi-ai/models";
import {
	type AuditSink,
	type CallContext,
	type Clock,
	CONNECTOR_PRESETS,
	type ConnectorPreset,
	type InjectionRule,
	type JsonValue,
	KantelError,
	type ModelChoice,
	type ModelConnector,
	type ModelThinking,
	PLATFORM_ORGANISATION,
	systemContext,
	type UsageWriter,
} from "@kantel/contracts";
import { createModelGatewayApp, type ModelGatewayApp, type ModelGatewayConfig } from "@kantel/model-gateway";
import { kantelModels, kantelResolveModel } from "@kantel/runtime/models";
import type { KantelVault } from "@kantel/vault/engine";
import { ECHO_ROUTE, echoProvider, type GatewayModels, type ModelGatewaySource } from "./components.ts";

export interface CpaConfig {
	/** CPA's API root with its `/v1`, such as `http://127.0.0.1:8317/v1`. */
	readonly baseUrl: string;
	/** CPA's client key. The vault keeps it as a platform item; the gateway never holds it otherwise. */
	readonly apiKey: string;
	/** The upstream model the `default` route serves. */
	readonly modelId: string;
}

/** One platform connector as the deployment configures it: a `ModelConnector` with its key, before seeding. */
export interface PlatformConnector {
	/** Unique in the deployment, such as `lleverage-litellm`. */
	readonly id: string;
	readonly preset: ConnectorPreset;
	/** The upstream's API root, without a trailing slash, such as `http://litellm.litellm.svc.cluster.local/v1`. */
	readonly baseUrl: string;
	/** The key. The vault keeps it as a platform item; the gateway never holds it otherwise. */
	readonly apiKey: string;
	/** The environment variable the key came from, for messages. Never the value. */
	readonly keyVariable: string;
	/** What the vault item's name starts with, before the key's hash: `cliproxyapi` for CPA, else the connector's ID. */
	readonly itemPrefix: string;
	readonly catalogue: ModelConnector["catalogue"];
	readonly compat?: { readonly [key: string]: JsonValue };
}

export interface PlatformRoute {
	readonly name: string;
	readonly connectorId: string;
	readonly modelId: string;
	readonly thinking?: ModelThinking;
}

/** The deployment's platform connectors and routes. */
export interface PlatformModels {
	readonly connectors: readonly PlatformConnector[];
	readonly routes: readonly PlatformRoute[];
	/**
	 * Where the routes came from, for the start's hints: `default-model` (the `default` route to
	 * `KANTEL_DEFAULT_MODEL`), or `config` (the connectors config's `routes`).
	 */
	readonly routesFrom: "default-model" | "config";
}

export const CPA_CONNECTOR_ID = "sal-cliproxyapi";
/** CPA takes its client key as a bearer token. */
export const CPA_INJECTION: InjectionRule = { header: "Authorization", template: "Bearer {key}" };
/** Anthropic's API, and those like it, take the key as `x-api-key`. */
const API_KEY_INJECTION: InjectionRule = { header: "x-api-key", template: "{key}" };
/** The gateway as the runtime addresses it. Never resolved: the runtime's fetch hands each request to the gateway. */
export const GATEWAY_BASE_URL = "http://model-gateway.harbour.internal";
export const DEFAULT_ROUTE = "default";
export const DEFAULT_MODEL = "claude-sonnet-5-5";
const MIN_KEY_LENGTH = 16;
const CONNECTOR_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The caller that makes the deployment's platform items: Kantel's operator, outside every organisation. */
const VAULT_SEED_CONTEXT: CallContext = {
	...systemContext("selfhosted.vault-seed"),
	organisationId: PLATFORM_ORGANISATION,
};

/** Throws unless `url` is an http(s) URL; `variable` names where it came from. Returns it without trailing slashes. */
function httpUrl(url: string, variable: string, example: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`${variable} must be a URL, such as ${example}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`${variable} must be an http: or https: URL`);
	}
	return url.replace(/\/+$/, "");
}

/**
 * A key is held to the components' rule: 16 characters or more, no spaces. The model gateway's redaction skips very
 * short secrets, and the item's name would let a short key be guessed.
 */
function assertKey(key: string, variable: string): void {
	if (key.length < MIN_KEY_LENGTH || /\s/.test(key)) {
		throw new Error(`${variable} must be at least 16 characters with no spaces`);
	}
}

/** One model ID: no spaces and no colon, which separates a route from a model on the wire. */
const isModelId = (value: string) => value !== "" && !/[\s:]/.test(value);

function defaultModelOf(env: NodeJS.ProcessEnv): string {
	const modelId = env.KANTEL_DEFAULT_MODEL?.trim() || DEFAULT_MODEL;
	if (!isModelId(modelId)) throw new Error("KANTEL_DEFAULT_MODEL must be one model ID");
	return modelId;
}

/**
 * CPA from the environment, or `undefined` when neither `KANTEL_CPA_URL` nor `KANTEL_CPA_API_KEY` is set. Throws on
 * one without the other, a URL that isn't http(s), a key under 16 characters or with spaces, or a model ID with spaces
 * or a colon.
 */
export function cpaConfig(env: NodeJS.ProcessEnv = process.env): CpaConfig | undefined {
	const url = env.KANTEL_CPA_URL?.trim() ?? "";
	const apiKey = env.KANTEL_CPA_API_KEY?.trim() ?? "";
	if (url === "" && apiKey === "") return undefined;
	if (url === "" || apiKey === "") throw new Error("KANTEL_CPA_URL and KANTEL_CPA_API_KEY go together");
	const baseUrl = httpUrl(url, "KANTEL_CPA_URL", "http://127.0.0.1:8317/v1");
	assertKey(apiKey, "KANTEL_CPA_API_KEY");
	return { baseUrl, apiKey, modelId: defaultModelOf(env) };
}

/** CPA as the deployment's one platform connector, `sal-cliproxyapi`, with its `default` route: the default setup. */
export function cpaModels(cpa: CpaConfig): PlatformModels {
	return {
		connectors: [
			{
				id: CPA_CONNECTOR_ID,
				preset: "cliproxyapi",
				baseUrl: cpa.baseUrl,
				apiKey: cpa.apiKey,
				keyVariable: "KANTEL_CPA_API_KEY",
				itemPrefix: "cliproxyapi",
				catalogue: { refresh: "gateway" },
			},
		],
		routes: [{ name: DEFAULT_ROUTE, connectorId: CPA_CONNECTOR_ID, modelId: cpa.modelId }],
		routesFrom: "default-model",
	};
}

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const THINKING: readonly ModelThinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The connectors config, from `KANTEL_MODEL_CONNECTORS` (the JSON itself) or `KANTEL_MODEL_CONNECTORS_FILE` (a path
 * to it, such as a mounted ConfigMap), or `undefined` when neither is set. Its shape:
 *
 * ```json
 * {
 *   "connectors": [{ "id": "lleverage-litellm", "preset": "litellm",
 *                    "baseUrl": "http://litellm.litellm.svc.cluster.local/v1", "apiKeyEnv": "KANTEL_LITELLM_API_KEY" }],
 *   "routes": [{ "name": "default", "connectorId": "lleverage-litellm", "modelId": "claude-sonnet-5-5" }]
 * }
 * ```
 *
 * A connector may also give `catalogue` (`refresh`, `include`, `overrides`, as `ModelConnector`'s) and `compat`. The
 * key is never in the config: `apiKeyEnv` names the variable that holds it, such as one set from a Kubernetes Secret.
 * Without `routes`, the `default` route serves `KANTEL_DEFAULT_MODEL` on the first connector. Throws, naming what is
 * wrong and never a key, on bad JSON, an unknown preset, a missing or short key, a duplicate ID or route, a route on
 * no listed connector, routes without `default`, or a route named `echo` (the echo model's).
 */
export function modelConnectorsConfig(
	env: NodeJS.ProcessEnv = process.env,
	readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): PlatformModels | undefined {
	const inline = env.KANTEL_MODEL_CONNECTORS?.trim() ?? "";
	const file = env.KANTEL_MODEL_CONNECTORS_FILE?.trim() ?? "";
	if (inline === "" && file === "") return undefined;
	if (inline !== "" && file !== "") {
		throw new Error("Set KANTEL_MODEL_CONNECTORS or KANTEL_MODEL_CONNECTORS_FILE, not both");
	}
	const source = inline !== "" ? "KANTEL_MODEL_CONNECTORS" : `KANTEL_MODEL_CONNECTORS_FILE (${file})`;
	let text = inline;
	if (file !== "") {
		try {
			text = readFile(file);
		} catch (error) {
			throw new Error(`Could not read ${source}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`${source} must be JSON: { "connectors": [...], "routes": [...] }`);
	}
	if (!isRecord(value) || !Array.isArray(value.connectors) || value.connectors.length === 0) {
		throw new Error(`${source} needs a non-empty "connectors" list`);
	}
	const connectors: PlatformConnector[] = [];
	for (const [index, entry] of value.connectors.entries()) {
		const where = `${source}: connector ${index + 1}`;
		if (!isRecord(entry)) throw new Error(`${where} must be an object`);
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		if (!CONNECTOR_ID.test(id)) {
			throw new Error(`${where} needs an "id" of lowercase letters, digits and dashes, such as lleverage-litellm`);
		}
		if (connectors.some((connector) => connector.id === id))
			throw new Error(`${source}: connector ${id} is listed twice`);
		const preset = entry.preset;
		if (typeof preset !== "string" || !(CONNECTOR_PRESETS as readonly string[]).includes(preset)) {
			throw new Error(
				`${source}: connector ${id} has an unknown preset ${JSON.stringify(preset)}: use one of ${CONNECTOR_PRESETS.join(", ")}`,
			);
		}
		if (typeof entry.baseUrl !== "string") throw new Error(`${source}: connector ${id} needs a "baseUrl"`);
		const baseUrl = httpUrl(entry.baseUrl.trim(), `connector ${id}'s baseUrl`, "http://litellm.example.internal/v1");
		const keyVariable = typeof entry.apiKeyEnv === "string" ? entry.apiKeyEnv.trim() : "";
		if (!VARIABLE_NAME.test(keyVariable)) {
			throw new Error(
				`${source}: connector ${id} needs an "apiKeyEnv" naming the variable that holds its key, such as KANTEL_LITELLM_API_KEY`,
			);
		}
		const apiKey = env[keyVariable]?.trim() ?? "";
		if (apiKey === "") throw new Error(`${keyVariable}, connector ${id}'s key, is not set`);
		assertKey(apiKey, keyVariable);
		if (entry.catalogue !== undefined && !isRecord(entry.catalogue)) {
			throw new Error(`${source}: connector ${id}'s "catalogue" must be an object`);
		}
		if (entry.compat !== undefined && !isRecord(entry.compat)) {
			throw new Error(`${source}: connector ${id}'s "compat" must be an object`);
		}
		// The directory checks the catalogue's fields in full when the gateway loads it.
		const catalogue = { refresh: "gateway", ...entry.catalogue } as ModelConnector["catalogue"];
		connectors.push({
			id,
			preset: preset as ConnectorPreset,
			baseUrl,
			apiKey,
			keyVariable,
			itemPrefix: id,
			catalogue,
			...(entry.compat === undefined ? {} : { compat: entry.compat as { readonly [key: string]: JsonValue } }),
		});
	}
	if (value.routes === undefined) {
		return {
			connectors,
			routes: [{ name: DEFAULT_ROUTE, connectorId: connectors[0]!.id, modelId: defaultModelOf(env) }],
			routesFrom: "default-model",
		};
	}
	if (!Array.isArray(value.routes)) throw new Error(`${source}: "routes" must be a list`);
	const routes: PlatformRoute[] = [];
	for (const [index, entry] of value.routes.entries()) {
		const where = `${source}: route ${index + 1}`;
		if (!isRecord(entry)) throw new Error(`${where} must be an object`);
		const name = typeof entry.name === "string" ? entry.name.trim() : "";
		if (name === "" || /[\s:]/.test(name)) throw new Error(`${where} needs a "name" with no spaces or colon`);
		if (name === ECHO_ROUTE) throw new Error(`${source}: route ${ECHO_ROUTE} is the echo model's; name it otherwise`);
		if (routes.some((route) => route.name === name)) throw new Error(`${source}: route ${name} is listed twice`);
		const connectorId = typeof entry.connectorId === "string" ? entry.connectorId.trim() : "";
		if (!connectors.some((connector) => connector.id === connectorId)) {
			throw new Error(
				`${source}: route ${name} names connector ${JSON.stringify(entry.connectorId)}, which isn't listed`,
			);
		}
		const modelId = typeof entry.modelId === "string" ? entry.modelId.trim() : "";
		if (!isModelId(modelId)) throw new Error(`${source}: route ${name} needs a "modelId", one model ID`);
		if (entry.thinking !== undefined && !(THINKING as readonly unknown[]).includes(entry.thinking)) {
			throw new Error(`${source}: route ${name}'s "thinking" must be one of ${THINKING.join(", ")}`);
		}
		routes.push({
			name,
			connectorId,
			modelId,
			...(entry.thinking === undefined ? {} : { thinking: entry.thinking as ModelThinking }),
		});
	}
	if (!routes.some((route) => route.name === DEFAULT_ROUTE)) {
		throw new Error(`${source}: "routes" needs a route named ${DEFAULT_ROUTE}, which the assistant profile uses`);
	}
	return { connectors, routes, routesFrom: "config" };
}

/**
 * The deployment's platform connectors: the connectors config when it is set, else CPA, else `undefined` (the echo
 * model). The two don't mix: to keep CPA beside other connectors, list it in the config as a `cliproxyapi` connector.
 */
export function platformModels(
	env: NodeJS.ProcessEnv = process.env,
	readFile?: (path: string) => string,
): PlatformModels | undefined {
	const configured = modelConnectorsConfig(env, readFile);
	const cpa = cpaConfig(env);
	if (configured !== undefined && cpa !== undefined) {
		throw new Error(
			"Set KANTEL_MODEL_CONNECTORS or KANTEL_CPA_URL, not both: list CLIProxyAPI in the connectors config as a cliproxyapi connector",
		);
	}
	return configured ?? (cpa === undefined ? undefined : cpaModels(cpa));
}

async function keyDigest(key: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
	return [...digest.slice(0, 6)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The vault item's name for this key: `cliproxyapi-` and the first 12 hex digits of its SHA-256. A rotated key gets a
 * new item, so the old value is never served again; the digest reveals nothing usable about a random key.
 */
export async function cpaItemName(key: string): Promise<string> {
	return `cliproxyapi-${await keyDigest(key)}`;
}

/** A connector's item name: its prefix (`cliproxyapi` for CPA, as before, else its ID) and its key's digest. */
export async function connectorItemName(connector: Pick<PlatformConnector, "itemPrefix" | "apiKey">): Promise<string> {
	return `${connector.itemPrefix}-${await keyDigest(connector.apiKey)}`;
}

/** A platform item holding a connector's key, as the bootstrap file records it (`Bootstrap.modelItems`). */
export interface ConnectorItem {
	readonly name: string;
	readonly id: string;
}

/** CPA's item, as the bootstrap file records it (`Bootstrap.cpaItem`). */
export type CpaItem = ConnectorItem;

/**
 * The platform item holding a connector's key: `previous`, the one an earlier start of this deployment made, when it
 * was made for this key; otherwise a new one bound to the connector's host. The vault lists no platform items and has
 * no way to replace an item's value, so the bootstrap file remembers the item, and a new key makes a new item.
 */
export async function seedConnectorItem(
	vault: KantelVault,
	connector: PlatformConnector,
	previous?: ConnectorItem,
): Promise<ConnectorItem> {
	const name = await connectorItemName(connector);
	if (previous?.name === name) return previous;
	const anthropicStyle = connector.preset === "anthropic" || connector.preset === "anthropic-compatible";
	const item = await vault.putItem(VAULT_SEED_CONTEXT, {
		owner: { kind: "platform" },
		name,
		description:
			connector.id === CPA_CONNECTOR_ID && connector.preset === "cliproxyapi"
				? "CLIProxyAPI's client key, from the gateway's KANTEL_CPA_API_KEY"
				: `Model connector ${connector.id}'s key (${connector.preset}), from the gateway's ${connector.keyVariable}`,
		hosts: [new URL(connector.baseUrl).hostname],
		injection: anthropicStyle ? API_KEY_INJECTION : CPA_INJECTION,
		value: connector.apiKey,
	});
	return { name, id: item.id };
}

/** CPA's item: `seedConnectorItem` for the default CPA connector. */
export async function seedCpaItem(vault: KantelVault, cpa: CpaConfig, previous?: CpaItem): Promise<CpaItem> {
	return seedConnectorItem(vault, cpaModels(cpa).connectors[0]!, previous);
}

/** The gateway's platform connectors and routes, each connector on its seeded item (`items`, by connector ID). */
export function modelGatewayConfig(
	models: PlatformModels,
	items: { readonly [connectorId: string]: string },
): ModelGatewayConfig {
	return {
		baseUrl: GATEWAY_BASE_URL,
		connectors: models.connectors.map((connector) => {
			const vaultItemId = items[connector.id];
			if (vaultItemId === undefined) throw new Error(`connector ${connector.id} has no vault item yet`);
			return {
				id: connector.id,
				owner: { kind: "platform" as const },
				preset: connector.preset,
				baseUrl: connector.baseUrl,
				vaultItemId,
				catalogue: connector.catalogue,
				...(connector.compat === undefined ? {} : { compat: connector.compat }),
			};
		}),
		routes: models.routes.map((route) => ({
			name: route.name,
			owner: { kind: "platform" as const },
			connectorId: route.connectorId,
			modelId: route.modelId,
			...(route.thinking === undefined ? {} : { thinking: route.thinking }),
		})),
	};
}

/**
 * A fetch that reaches only the connectors' origins and refuses any other, so no call leaves another way. The origins
 * are whatever the deployment configured, so an in-cluster LiteLLM such as `http://litellm.litellm.svc.cluster.local`
 * is reached directly.
 */
export function connectorsOnly(
	models: Pick<PlatformModels, "connectors">,
	upstream: typeof fetch = fetch,
): typeof fetch {
	const origins = new Set(models.connectors.map((connector) => new URL(connector.baseUrl).origin));
	return async (input, init) => {
		const request = new Request(input, init);
		if (!origins.has(new URL(request.url).origin)) {
			throw new KantelError("refused", "The self-hosted model gateway reaches only its configured model connectors");
		}
		return upstream(request);
	};
}

/** What a connector said to the start's check of its key and its routes' models (`probeConnector`). */
export type ConnectorProbe =
	| { readonly result: "ok"; readonly models: number }
	| { readonly result: "model_missing"; readonly models: number; readonly missing: readonly string[] }
	| { readonly result: "key_refused"; readonly status: number }
	| { readonly result: "failed"; readonly detail: string };

const PROBE_TIMEOUT_MS = 5_000;

/** The routes on `connector`. */
const routesOn = (models: PlatformModels, connector: PlatformConnector) =>
	models.routes.filter((route) => route.connectorId === connector.id);

/**
 * Asks the connector's `/v1/models` with its key, as the model gateway's catalogue does at a session's first model
 * call. A key it doesn't know, or a route's model it doesn't list, leaves the route out of every session's catalogue,
 * so sessions fail with `no_model` and nothing else says why: the start logs this instead. Every preset's upstream
 * answers `/v1/models` under its root (LiteLLM's catalogue is `/model/info`, but it serves both). Never throws, and the
 * result carries no part of the key.
 */
export async function probeConnector(
	models: PlatformModels,
	connector: PlatformConnector,
	upstream: typeof fetch = fetch,
): Promise<ConnectorProbe> {
	const anthropicStyle = connector.preset === "anthropic" || connector.preset === "anthropic-compatible";
	try {
		const root = connector.baseUrl.replace(/\/v1$/, "");
		const response = await connectorsOnly(models, upstream)(`${root}/v1/models`, {
			headers: {
				accept: "application/json",
				...(anthropicStyle
					? { "x-api-key": connector.apiKey, "anthropic-version": "2023-06-01" }
					: { authorization: `Bearer ${connector.apiKey}` }),
			},
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
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
		const missing = [...new Set(routesOn(models, connector).map((route) => route.modelId))].filter(
			(modelId) => !ids.includes(modelId),
		);
		return missing.length === 0
			? { result: "ok", models: ids.length }
			: { result: "model_missing", models: ids.length, missing };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { result: "failed", detail: message.split(connector.apiKey).join("[redacted]") };
	}
}

/** CPA's check: `probeConnector` on the default CPA connector. */
export async function probeCpa(cpa: CpaConfig, upstream: typeof fetch = fetch): Promise<ConnectorProbe> {
	const models = cpaModels(cpa);
	return probeConnector(models, models.connectors[0]!, upstream);
}

const isCpa = (connector: PlatformConnector) => connector.id === CPA_CONNECTOR_ID && connector.preset === "cliproxyapi";

/** The start's log line for `probeConnector`'s result: what is wrong and what to change, never the key. */
export function describeConnectorProbe(
	models: PlatformModels,
	connector: PlatformConnector,
	probe: ConnectorProbe,
): string {
	const label = isCpa(connector) ? "CLIProxyAPI" : `model connector ${connector.id} (${connector.preset})`;
	const routes = routesOn(models, connector).map((route) => route.name);
	const onRoutes = `sessions on route${routes.length === 1 ? "" : "s"} ${routes.join(", ") || "(none)"}`;
	switch (probe.result) {
		case "ok":
			return `[gateway] ${label} accepted the key and lists ${[...new Set(routesOn(models, connector).map((route) => route.modelId))].join(", ")} (${probe.models} models)`;
		case "model_missing": {
			const missingRoutes = routesOn(models, connector)
				.filter((route) => probe.missing.includes(route.modelId))
				.map((route) => route.name);
			const fix =
				models.routesFrom === "default-model"
					? "set KANTEL_DEFAULT_MODEL to a model it lists"
					: "change the route's modelId in the connectors config to a model it lists";
			return (
				`[gateway] warning: ${label} lists ${probe.models} models but not ${probe.missing.join(", ")}, so sessions on ` +
				`route${missingRoutes.length === 1 ? "" : "s"} ${missingRoutes.join(", ")} fail with no_model: ${fix}`
			);
		}
		case "key_refused":
			return (
				`[gateway] warning: ${label} refused ${connector.keyVariable} (HTTP ${probe.status}), so ${onRoutes} fail ` +
				`with no_model: ${isCpa(connector) ? "use one of the api-keys in CLIProxyAPI's config" : `check the key in ${connector.keyVariable}`}`
			);
		case "failed":
			return (
				`[gateway] warning: could not check ${label} at ${connector.baseUrl} (${probe.detail}); ${onRoutes} fail ` +
				`with no_model until it answers`
			);
	}
}

/** CPA's line: `describeConnectorProbe` on the default CPA connector. */
export function describeCpaProbe(cpa: CpaConfig, probe: ConnectorProbe): string {
	const models = cpaModels(cpa);
	return describeConnectorProbe(models, models.connectors[0]!, probe);
}

export interface GatewayModelsOptions {
	readonly models: PlatformModels;
	/** Each connector's platform item, by connector ID, once the start has seeded them. The first model call waits. */
	readonly items: Promise<{ readonly [connectorId: string]: string }>;
	/** The gateway's vault, once the components have made it. Read at the first model call. */
	readonly vault: () => KantelVault | undefined;
	/** Where `model.call` events go: the gateway's audit store. */
	readonly audit: AuditSink;
	/** The connectors' fetch; default the global one. Tests pass a fake upstream's. */
	readonly upstream?: typeof fetch;
	readonly clock?: Clock;
	/** Where each call's usage row goes: the Postgres usage ledger (`usage.ts`). */
	readonly usage?: UsageWriter;
}

/** What an earlier start seeded, by connector ID (`Bootstrap.modelItems`). */
export type ConnectorItems = { readonly [connectorId: string]: ConnectorItem };

/** `ModelGatewaySource`, and the seeding the start does once the components and the bootstrap are ready. */
export interface PlatformModelGateway extends ModelGatewaySource {
	readonly platform: PlatformModels;
	/**
	 * Finds or makes each connector's item in the components' vault (`seedConnectorItem`) and hands them to the gateway,
	 * which waits for them: a session resumed before this answers once it is done. Resolves the items for the bootstrap
	 * file.
	 */
	seed(vault: KantelVault | undefined, previous?: ConnectorItems): Promise<ConnectorItems>;
}

/**
 * The components' model gateway over the platform connectors: sessions on `createGatewayModels`, the bootstrap's
 * profile on `default`. Takes CPA's config for the default setup.
 */
export function modelGatewaySource(
	config: PlatformModels | CpaConfig,
	options: Pick<GatewayModelsOptions, "upstream" | "clock"> = {},
): PlatformModelGateway {
	const platform = "connectors" in config ? config : cpaModels(config);
	let seeded: (items: { readonly [connectorId: string]: string }) => void = () => {};
	const items = new Promise<{ readonly [connectorId: string]: string }>((resolve) => {
		seeded = resolve;
	});
	return {
		route: DEFAULT_ROUTE,
		platform,
		build: ({ vault, audit, usage }) =>
			createGatewayModels({
				...options,
				models: platform,
				items,
				vault,
				audit,
				...(usage === undefined ? {} : { usage }),
			}),
		async seed(vault, previous = {}) {
			if (vault === undefined) {
				throw new Error("Model connector keys are kept in the vault: set KANTEL_VAULT_CIPHER_KEY");
			}
			const found: { [connectorId: string]: ConnectorItem } = {};
			for (const connector of platform.connectors) {
				found[connector.id] = await seedConnectorItem(vault, connector, previous[connector.id]);
			}
			seeded(Object.fromEntries(Object.entries(found).map(([id, item]) => [id, item.id])));
			return found;
		},
	};
}

/**
 * Sessions on the model gateway, with the `echo` route kept on the echo model. The gateway is built at the first
 * model call (it needs the vault items), and built again on the next call if that fails.
 */
export function createGatewayModels(options: GatewayModelsOptions): GatewayModels {
	const vault = (): KantelVault => {
		const found = options.vault();
		if (found === undefined) {
			throw new KantelError("unavailable", "The model gateway needs the vault: set KANTEL_VAULT_CIPHER_KEY");
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
					config: modelGatewayConfig(options.models, await options.items),
					tokenKey,
					credentials: {
						readConnectorCredential: (ctx, request) => vault().readConnectorCredential(ctx, request),
						assertSessionOpen: (ctx, scope) => vault().assertSessionOpen(ctx, scope),
					},
					audit: options.audit,
					fetch: connectorsOnly(options.models, options.upstream),
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
	const sessionModels = kantelModels({
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
			// `kantelModels` makes each session's collection with pi-ai's `createModels`, which is mutable.
			const models = (await sessionModels(session)) as Partial<MutableModels> & Models;
			if (typeof models.setProvider !== "function") throw new Error("the session's models cannot take the echo model");
			models.setProvider(echo);
			return models;
		},
		resolveModel: (choice: ModelChoice) =>
			choice.route === ECHO_ROUTE && choice.modelId === undefined
				? { provider: echo.id, modelId: ECHO_ROUTE }
				: kantelResolveModel(choice),
	};
}

/**
 * The model gateway: `createModelGateway` implements `ModelGateway` (contracts/models.ts) over a connector directory,
 * the vault's connector credential read and pi-ai's wire APIs (docs/model-connectors.md).
 *
 * - **Resolution and pins.** A call resolves its route through `ModelConnectors.resolve` and pins `(connector,
 *   modelId)` per `(sessionId, model ID)` on first use in a `ModelPinStore`; later calls of the session use the pin,
 *   so a route edit, or the route's deletion, never moves a running conversation. The pinned connector's owner, the
 *   project's policy and the connector's catalogue are checked on every call. `config` lists what calls would use.
 * - **The key.** Read through `ConnectorCredentials.readConnectorCredential` as `system("model-gateway")`, kept in
 *   memory for at most `credentialTtlMs` (default 120 s, capped at 5 min) per connector, replaced when a read returns
 *   a newer `valueVersion` and dropped when the upstream answers 401.
 * - **The upstream call.** One attempt: `maxRetries: 0`, and a fetch that sends one request per call
 *   (`singleRequestFetch`). Through the wire API's `streamSimple` with the key in the preset's header (never pi's
 *   `apiKey`), the abort signal, the session ID, the thinking level (`options.reasoning`, else the route's), the
 *   preset's headers and `onPayload`, and `fetch`. The client's headers are never forwarded. Where the preset names a
 *   tool namespace (CLIProxyAPI on Messages), tool names go up under it and come back without it (tool-names.ts).
 * - **Events.** pi's events become `ModelStreamEvent`s, with every known secret redacted (see redact.ts) and
 *   `usage.cost` filled from the upstream's report or pi's `calculateCost`.
 * - **Images.** `images` makes one call over the model's image API (images.ts: `openai-images` or
 *   `chat-modalities`), resolved and pinned as `messages` is, with the same key header, attribution headers, routing
 *   compat and `onPayload` (on a chat image call) and redaction, recorded with `operation: "images"` and the
 *   image count in its usage. `listConnectorModels` and `testImage` serve the console's connector list and test.
 * - **Accounting.** Each call that resolved a route records one `ModelCallRecord` and appends one `model.call` audit
 *   event (source `session`), as `system("model-gateway")`. Neither holds a prompt, a completion or a key. A failed
 *   append is retried; if it still fails the record is marked `auditPending` and the host told (`onAuditFailure`).
 *   With `usage`, the same call's `UsageRecord` (usage.ts, docs/usage-analytics.md) is written beside the append, so
 *   it adds no wait of its own; a write that keeps failing is logged (`onUsageFailure`) and never fails the call.
 */
import type {
	AssistantMessageEvent,
	Context,
	Model,
	SimpleStreamOptions,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import { streamSimple as anthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as openaiCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as openaiResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { calculateCost } from "@earendil-works/pi-ai/models";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
	type AuditEventInput,
	type AuditSink,
	type CallContext,
	type Clock,
	type ConnectorCredentials,
	type ConnectorModel,
	type ConnectorModels,
	HarbourError,
	isHarbourError,
	isSystemActor,
	type JsonValue,
	type ModelCallRecord,
	type ModelCallScope,
	type ModelConnector,
	type ModelConnectors,
	type ModelGateway,
	type ModelGatewayModel,
	type ModelImagesRequest,
	type ModelImagesResult,
	type ModelMessagesRequest,
	type ModelStreamEvent,
	type ModelThinking,
	type ModelUsage,
	type ModelWireApi,
	type ProjectAccess,
	type ProjectModelPolicy,
	type SystemContext,
	systemClock,
	systemContext,
	type Timestamp,
	type UsageWriter,
} from "@harbour/contracts";
import { type CatalogueKeys, createModelCatalogue, type OfferedModel } from "./catalogue.ts";
import { assertPiContext } from "./context.ts";
import { MODEL_THINKING_LEVELS } from "./directory.ts";
import {
	assertImagesRequest,
	CONSOLE_AGENT,
	chatModalitiesBody,
	chatModalitiesImages,
	imageRate,
	openaiImages,
	pricedImages,
	TEST_IMAGE_PROMPT,
	TEST_IMAGE_ROUTE,
} from "./images.ts";
import { allPages, pageOf } from "./page.ts";
import { keyHeaders, presetSpec, upstreamBaseUrl } from "./presets.ts";
import { Redactor, StreamRedactor } from "./redact.ts";
import { connectorServes, overrideId, parseModelRequestId, policyAllows } from "./resolution.ts";
import { namespaceToolNames } from "./tool-names.ts";
import { logUsageFailure, type UsageDetails, type UsageWriteFailure, usageRecordOf, writeUsage } from "./usage.ts";

/** The component name the gateway acts as. */
export const MODEL_GATEWAY_COMPONENT = "model-gateway";
const GATEWAY_CONTEXT: SystemContext = systemContext(MODEL_GATEWAY_COMPONENT);

export const DEFAULT_CREDENTIAL_TTL_MS = 120_000;
export const MAX_CREDENTIAL_TTL_MS = 300_000;
/** How many call records the gateway keeps in memory for `listCalls`; the audit log is the durable record. */
export const MAX_KEPT_CALLS = 10_000;

/** A session's pinned upstream for one model ID (a route, or `<route>:<modelId>`). */
export interface ModelPin {
	readonly connectorId: string;
	readonly modelId: string;
	readonly pinnedAt: Timestamp;
}

/** Where pins live. In memory by default; a target can make it durable so pins survive a restart. */
export interface ModelPinStore {
	get(sessionId: string, modelRequestId: string): Promise<ModelPin | undefined>;
	/** Stores `pin` unless the session already pinned `modelRequestId`, and resolves the pin that holds. */
	pin(sessionId: string, modelRequestId: string, pin: ModelPin): Promise<ModelPin>;
	/** Every pin the session holds, by the model ID it was pinned for. */
	list(sessionId: string): Promise<ReadonlyMap<string, ModelPin>>;
}

export function createMemoryModelPinStore(): ModelPinStore {
	const pins = new Map<string, ModelPin>();
	const key = (sessionId: string, modelRequestId: string) => JSON.stringify([sessionId, modelRequestId]);
	return {
		async get(sessionId, modelRequestId) {
			return pins.get(key(sessionId, modelRequestId));
		},
		async pin(sessionId, modelRequestId, pin) {
			const existing = pins.get(key(sessionId, modelRequestId));
			if (existing !== undefined) return existing;
			pins.set(key(sessionId, modelRequestId), pin);
			return pin;
		},
		async list(sessionId) {
			const held = new Map<string, ModelPin>();
			for (const [stored, pin] of pins) {
				const [session, modelRequestId] = JSON.parse(stored) as [string, string];
				if (session === sessionId) held.set(modelRequestId, pin);
			}
			return held;
		},
	};
}

export interface ModelGatewayOptions {
	readonly connectors: ModelConnectors;
	/** The vault's connector credential read: the vault itself, or a client of its egress decision API. */
	readonly credentials: ConnectorCredentials;
	readonly clock?: Clock;
	/** Where `model.call` events go: an outbox in production. */
	readonly audit: AuditSink;
	/** How the gateway reaches upstreams and their catalogues. Default `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	readonly pins?: ModelPinStore;
	/** How long a connector's key is kept in memory. Default 120 s, capped at 5 min. */
	readonly credentialTtlMs?: number;
	/** How long a refreshed catalogue listing is used. Default 10 min. */
	readonly catalogueTtlMs?: number;
	/** How long one catalogue refresh may take before it counts as failed. Default 10 s, in real time. */
	readonly catalogueRefreshTimeoutMs?: number;
	/** The gateway's base URL as clients reach it; `config` returns it. */
	readonly baseUrl: string;
	/** Checks `listCalls` callers. Without it, `listCalls` checks only the organisation and that the caller is no agent. */
	readonly access?: ProjectAccess;
	/**
	 * Told when a call's `model.call` event could not be appended after retrying, with the record (now marked
	 * `auditPending`) and the event, to append later under the same ID. Defaults to logging one line naming the call and
	 * the error, nothing more of it.
	 */
	readonly onAuditFailure?: (failure: ModelAuditFailure) => void | Promise<void>;
	/** Where each call's usage record goes: a usage ledger (`@harbour/usage`). Without it, none is written. */
	readonly usage?: UsageWriter;
	/** Told when a usage record could not be written after retrying. Defaults to logging one line naming the call. */
	readonly onUsageFailure?: (failure: UsageWriteFailure) => void | Promise<void>;
}

/** A `model.call` event the gateway could not append. */
export interface ModelAuditFailure {
	readonly record: ModelCallRecord;
	readonly event: AuditEventInput;
	readonly error: unknown;
	readonly attempts: number;
}

/** How many times the gateway tries to append one `model.call` event, at once and under the same event ID. */
const AUDIT_ATTEMPTS = 3;

function logAuditFailure({ record, error, attempts }: ModelAuditFailure): void {
	console.error(
		JSON.stringify({
			error: "model.call audit append failed",
			callId: record.id,
			organisationId: record.scope.organisationId,
			sessionId: record.scope.sessionId,
			attempts,
			message: error instanceof Error ? error.message : String(error),
		}),
	);
}

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const WIRE_STREAMS: {
	readonly [api in ModelWireApi]: (
		model: Model<api>,
		context: ReturnType<typeof normalizeContext>,
		options?: SimpleStreamOptions,
	) => AsyncIterable<AssistantMessageEvent>;
} = {
	"anthropic-messages": anthropicMessages,
	"openai-completions": openaiCompletions,
	"openai-responses": openaiResponses,
};

function emptyUsage(): ModelUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Rejects with `invalid` unless `request` has the shape of a `ModelMessagesRequest`. */
function assertMessagesRequest(request: unknown): asserts request is ModelMessagesRequest {
	if (!isRecord(request) || typeof request.model !== "string") {
		throw new HarbourError("invalid", "A messages request names a model");
	}
	assertPiContext(request.context);
	const options = request.options;
	if (options === undefined || options === null) return;
	if (!isRecord(options)) throw new HarbourError("invalid", "A messages request's options must be an object");
	const reasoning = options.reasoning;
	if (reasoning !== undefined && reasoning !== null && !MODEL_THINKING_LEVELS.includes(reasoning as ModelThinking)) {
		throw new HarbourError("invalid", `Unknown thinking level ${String(reasoning)}`);
	}
}

/**
 * The one way an event leaves the gateway: `event` rebuilt field by field from the `ModelStreamEvent` schema. The
 * upstream may have set any of its values, and pi does not check their types, so:
 * - only the schema's own fields are copied, under the schema's own names, so a key that spells one (`usage`, `delta`)
 *   cannot break the event, and no property name the upstream chose survives outside a tool call's `arguments`;
 * - every string (content, signatures, tool-call IDs, names and namespaces, response IDs, thinking levels, error text)
 *   is redacted, and a value of the wrong type is dropped (optional) or replaced by an empty one (required);
 * - a tool call's `arguments`, whose property names the upstream chose, are redacted names and values alike.
 * Deltas reach it already redacted by the call's `StreamRedactor`, which alone can catch a secret split across them.
 */
export function sanitiseEvent(event: ModelStreamEvent, redactor: Redactor): ModelStreamEvent {
	const raw = event as unknown as { readonly [field: string]: unknown };
	const text = (value: unknown): string | undefined => (typeof value === "string" ? redactor.text(value) : undefined);
	const optional = <F extends string>(source: { readonly [field: string]: unknown }, field: F) => {
		const value = text(source[field]);
		return (value === undefined ? {} : { [field]: value }) as { readonly [K in F]?: string };
	};
	const contentIndex = finiteOr(raw.contentIndex, 0);
	switch (event.type) {
		case "start":
			return { type: "start" };
		case "text_start":
		case "thinking_start":
			return { type: event.type, contentIndex };
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return { type: event.type, contentIndex, delta: text(raw.delta) ?? "" };
		case "text_end":
			return { type: "text_end", contentIndex, content: text(raw.content) ?? "", ...optional(raw, "contentSignature") };
		case "thinking_end":
			return {
				type: "thinking_end",
				contentIndex,
				content: text(raw.content) ?? "",
				...optional(raw, "contentSignature"),
				...(raw.redacted === true ? { redacted: true } : {}),
			};
		case "toolcall_start":
			return { type: "toolcall_start", contentIndex, id: text(raw.id) ?? "", toolName: text(raw.toolName) ?? "" };
		case "toolcall_end": {
			const call = (isRecord(raw.toolCall) ? raw.toolCall : {}) as { readonly [field: string]: unknown };
			const args = isRecord(call.arguments) ? (redactor.json(call.arguments as JsonValue) as JsonObject) : {};
			return {
				type: "toolcall_end",
				contentIndex,
				toolCall: {
					type: "toolCall",
					id: text(call.id) ?? "",
					name: text(call.name) ?? "",
					arguments: args,
					...optional(call, "argumentsError"),
					...optional(call, "namespace"),
					...optional(call, "thoughtSignature"),
				},
			};
		}
		case "done":
			return {
				type: "done",
				reason: event.reason === "length" || event.reason === "toolUse" ? event.reason : "stop",
				usage: usageOf(raw.usage),
				...optional(raw, "responseId"),
				...optional(raw, "providerThinkingLevel"),
			};
		case "error":
			return {
				type: "error",
				reason: event.reason === "aborted" ? "aborted" : "error",
				usage: usageOf(raw.usage),
				...optional(raw, "errorMessage"),
				...optional(raw, "responseId"),
				...optional(raw, "providerThinkingLevel"),
			};
	}
}

const sanitised = sanitiseEvent;

type JsonObject = { readonly [key: string]: JsonValue };

function finiteOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** `ModelUsage` rebuilt from whatever arrived: numbers only, under the schema's names. */
function usageOf(value: unknown): ModelUsage {
	const usage = isRecord(value) ? value : {};
	const cost = isRecord(usage.cost) ? usage.cost : {};
	return {
		input: finiteOr(usage.input, 0),
		output: finiteOr(usage.output, 0),
		cacheRead: finiteOr(usage.cacheRead, 0),
		cacheWrite: finiteOr(usage.cacheWrite, 0),
		...(typeof usage.reasoning === "number" && Number.isFinite(usage.reasoning) ? { reasoning: usage.reasoning } : {}),
		totalTokens: finiteOr(usage.totalTokens, 0),
		cost: {
			input: finiteOr(cost.input, 0),
			output: finiteOr(cost.output, 0),
			cacheRead: finiteOr(cost.cacheRead, 0),
			cacheWrite: finiteOr(cost.cacheWrite, 0),
			total: finiteOr(cost.total, 0),
		},
	};
}

/** What `serving` serves, or undefined when it can't be served: the model is gone, or the policy refuses it. */
async function servableOrNone<T>(serving: Promise<T>): Promise<T | undefined> {
	try {
		return await serving;
	} catch (error) {
		if (isHarbourError(error, "not_found") || isHarbourError(error, "refused")) return undefined;
		throw error;
	}
}

/**
 * The fetch one call hands pi: it sends the first request upstream and no other, so pi's own retries (its Anthropic
 * strict-tools fallback re-posts after certain 400s, whatever `maxRetries` says) can't make a second upstream attempt.
 * A later request is answered with a copy of the first response when that was an error, so pi fails the call with the
 * first response's error, as it would have without retrying; after a first response that succeeded it is rejected.
 */
export function singleRequestFetch(inner: typeof fetch, onResponse?: (response: Response) => void): typeof fetch {
	let sent = false;
	let firstFailure: Response | undefined;
	return async (input, init) => {
		if (sent) {
			if (firstFailure !== undefined) return firstFailure.clone();
			throw new Error("The model gateway makes one upstream request per call");
		}
		sent = true;
		const response = await inner(input, init);
		onResponse?.(response);
		if (!response.ok) firstFailure = response.clone();
		return response;
	};
}

/** The upstream's reported cost in US dollars, from a raw stream event, when it carries one (`usage.cost`). */
function reportedCostOf(raw: unknown): number | undefined {
	if (!isRecord(raw)) return undefined;
	for (const holder of [raw, raw.response, raw.message]) {
		const usage = isRecord(holder) ? holder.usage : undefined;
		if (isRecord(usage) && typeof usage.cost === "number" && Number.isFinite(usage.cost)) return usage.cost;
	}
	return undefined;
}

/**
 * The gateway's credential cache, as `CatalogueKeys` and for the upstream call: at most one key per connector, held for
 * less than `ttlMs`. Every access first drops each entry that has expired, so a key is not kept in memory past its TTL
 * for want of another call to its connector, and the entry of a connector since edited (its `updatedAt` moved). A read
 * replaces the entry unless a concurrent one already holds a newer `valueVersion`.
 */
export function createCredentialCache(
	credentials: ConnectorCredentials,
	clock: Clock,
	ttlMs: number,
): CatalogueKeys & { readonly entries: number } {
	interface Entry {
		readonly identity: string;
		readonly value: string;
		readonly valueVersion: number;
		readonly readAt: number;
	}
	/** By connector ID. */
	const entries = new Map<string, Entry>();
	const identityOf = (connector: ModelConnector) =>
		JSON.stringify([connector.vaultItemId, connector.baseUrl, connector.owner, connector.updatedAt]);
	const sweep = () => {
		const now = clock.now();
		for (const [connectorId, entry] of entries) if (now - entry.readAt >= ttlMs) entries.delete(connectorId);
	};
	/**
	 * Drops `entry` after `ttlMs` of real time even if the cache is never touched again, so an idle gateway does not
	 * hold a key past its TTL. Unreferenced on Node so it never keeps the process alive. The sweep above still applies
	 * the injected clock on every access.
	 */
	const expireLater = (connectorId: string, entry: Entry): boolean => {
		try {
			const timer: unknown = setTimeout(() => {
				if (entries.get(connectorId) === entry) entries.delete(connectorId);
			}, ttlMs);
			(timer as { unref?: () => void }).unref?.();
			return true;
		} catch {
			// No timers here (a Worker outside a request): the key is not cached, rather than cached with no expiry.
			return false;
		}
	};
	/** The connector's entry, after dropping one held for an earlier version of the connector. */
	const entryOf = (connector: ModelConnector) => {
		const entry = entries.get(connector.id);
		if (entry === undefined || entry.identity === identityOf(connector)) return entry;
		entries.delete(connector.id);
		return undefined;
	};
	return {
		get entries() {
			sweep();
			return entries.size;
		},
		async key(connector, scope, signal) {
			sweep();
			const hit = entryOf(connector);
			if (hit !== undefined) return hit.value;
			const credential = await credentials.readConnectorCredential(
				{ ...GATEWAY_CONTEXT, organisationId: scope.organisationId, ...(signal === undefined ? {} : { signal }) },
				{
					connectorId: connector.id,
					owner: connector.owner,
					vaultItemId: connector.vaultItemId,
					baseUrl: connector.baseUrl,
					scope,
				},
			);
			// An empty key would leave the request with no auth header at all, which is when pi falls back to credentials
			// of its own from the host's environment (Anthropic workload identity federation): refused here instead.
			// Blank counts as empty: pi treats a whitespace-only header as no auth.
			if (typeof credential.value !== "string" || credential.value.trim().length === 0) {
				throw new HarbourError("unavailable", `The key for connector ${connector.id} is empty`);
			}
			sweep();
			const current = entryOf(connector);
			if (current === undefined || credential.valueVersion >= current.valueVersion) {
				const entry: Entry = {
					identity: identityOf(connector),
					value: credential.value,
					valueVersion: credential.valueVersion,
					readAt: clock.now(),
				};
				entries.set(connector.id, entry);
				if (!expireLater(connector.id, entry)) entries.delete(connector.id);
			}
			return credential.value;
		},
		drop(connector) {
			entries.delete(connector.id);
		},
	};
}

/** An upstream model a session may call: the connector serving it and the model as its catalogue offers it. */
interface ServedModel {
	readonly connector: ModelConnector;
	readonly target: OfferedModel;
}

/** What one call streams from, once resolved: its route's name and thinking, the connector and the upstream model. */
interface ResolvedCall extends ServedModel {
	readonly requestId: string;
	readonly routeName: string;
	/** The route's thinking level, when the route currently resolves for the session. */
	readonly thinking?: ModelThinking;
}

export function createModelGateway(options: ModelGatewayOptions): ModelGateway {
	const clock = options.clock ?? systemClock;
	const pins = options.pins ?? createMemoryModelPinStore();
	const upstreamFetch = options.fetch ?? ((input, init) => fetch(input, init));
	const credentialTtlMs = Math.min(
		Math.max(0, options.credentialTtlMs ?? DEFAULT_CREDENTIAL_TTL_MS),
		MAX_CREDENTIAL_TTL_MS,
	);
	const keys = createCredentialCache(options.credentials, clock, credentialTtlMs);
	const catalogue = createModelCatalogue({
		keys,
		fetch: upstreamFetch,
		clock,
		...(options.catalogueTtlMs === undefined ? {} : { ttlMs: options.catalogueTtlMs }),
		...(options.catalogueRefreshTimeoutMs === undefined ? {} : { refreshTimeoutMs: options.catalogueRefreshTimeoutMs }),
	});
	const calls: ModelCallRecord[] = [];
	const { connectors } = options;
	const onAuditFailure = options.onAuditFailure ?? logAuditFailure;
	const onUsageFailure = options.onUsageFailure ?? logUsageFailure;

	const directoryContext = (scope: ModelCallScope): CallContext => ({
		actor: GATEWAY_CONTEXT.actor,
		organisationId: scope.organisationId,
	});

	async function policyOf(scope: ModelCallScope): Promise<ProjectModelPolicy> {
		return connectors.getProjectPolicy(directoryContext(scope), scope.projectId);
	}

	/** `modelId` on `connector`, if the project's policy allows it (else `refused`) and the catalogue offers it. */
	async function serve(
		scope: ModelCallScope,
		requestId: string,
		connector: ModelConnector,
		modelId: string,
		policy: ProjectModelPolicy,
		signal: AbortSignal | undefined,
	): Promise<ServedModel> {
		if (!policyAllows(policy, connector.id, modelId)) {
			throw new HarbourError("refused", "The project's model policy excludes this model");
		}
		const target = (await catalogue.offered(connector, scope, signal)).get(modelId);
		if (target === undefined) throw new HarbourError("not_found", `Model ${requestId} is not offered`);
		return { connector, target };
	}

	/**
	 * What a session's pin serves, whatever its route now points at. Only the pinned target is rechecked: its connector
	 * still exists and its owner serves the session's organisation, and `serve`'s policy and catalogue checks.
	 */
	async function servePin(
		scope: ModelCallScope,
		requestId: string,
		pin: ModelPin,
		policy: ProjectModelPolicy,
		signal: AbortSignal | undefined,
	): Promise<ServedModel> {
		let connector: ModelConnector;
		try {
			connector = await connectors.getConnector(directoryContext(scope), pin.connectorId);
		} catch (error) {
			if (isHarbourError(error, "not_found")) {
				throw new HarbourError("not_found", `The connector pinned for ${requestId} is gone`);
			}
			throw error;
		}
		if (!connectorServes(connector, scope.organisationId)) {
			throw new HarbourError("not_found", `The connector pinned for ${requestId} is gone`);
		}
		return serve(scope, requestId, connector, pin.modelId, policy, signal);
	}

	function gatewayModel(id: string, offered: OfferedModel): ModelGatewayModel {
		const { model } = offered;
		return {
			id,
			name: model.name,
			reasoning: model.reasoning,
			...(model.thinkingLevelMap === undefined
				? {}
				: { thinkingLevelMap: model.thinkingLevelMap as { readonly [level: string]: string | null } }),
			input: [...model.input],
			output: [...offered.output],
			cost: {
				input: model.cost.input,
				output: model.cost.output,
				cacheRead: model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
				...(imageRate(model.cost) === undefined ? {} : { image: imageRate(model.cost) }),
			},
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		};
	}

	/**
	 * Resolves a call to its connector and upstream model: the session's pin for `requestId` when it has one, whatever
	 * the route now points at, else the route's current connector and model, which it then pins. Aborting `signal`
	 * rejects with its reason, pinning nothing.
	 */
	async function resolveCall(
		scope: ModelCallScope,
		requestId: string,
		signal: AbortSignal | undefined,
	): Promise<ResolvedCall> {
		const parsed = parseModelRequestId(requestId);
		if (parsed === undefined) throw new HarbourError("not_found", `No model route ${requestId} for this session`);
		const routes = await connectors.resolve(GATEWAY_CONTEXT, scope);
		const resolved = routes.find((entry) => entry.route.name === parsed.route);
		const policy = await policyOf(scope);
		const callOf = (served: ServedModel): ResolvedCall => ({
			requestId,
			routeName: parsed.route,
			...(resolved?.route.thinking === undefined ? {} : { thinking: resolved.route.thinking }),
			...served,
		});

		const existing = await pins.get(scope.sessionId, requestId);
		if (existing !== undefined) return callOf(await servePin(scope, requestId, existing, policy, signal));
		if (resolved === undefined) throw new HarbourError("not_found", `No model route ${requestId} for this session`);
		// Checked before pinning, so a request that can't be served pins nothing.
		const chosen = await serve(
			scope,
			requestId,
			resolved.connector,
			parsed.modelId ?? resolved.route.modelId,
			policy,
			signal,
		);
		// A call aborted while it resolved never ran, so it pins nothing.
		signal?.throwIfAborted();
		const held = await pins.pin(scope.sessionId, requestId, {
			connectorId: chosen.connector.id,
			modelId: chosen.target.id,
			pinnedAt: clock.now(),
		});
		// Another call of the session pinned first: follow its pin.
		return callOf(
			held.connectorId === chosen.connector.id && held.modelId === chosen.target.id
				? chosen
				: await servePin(scope, requestId, held, policy, signal),
		);
	}

	/**
	 * Keeps the call for `listCalls` and appends its `model.call` event, trying up to `AUDIT_ATTEMPTS` times under one
	 * event ID (sinks are idempotent by it). If every attempt fails the call is kept marked `auditPending` and the host
	 * is told through `onAuditFailure`; the call itself has happened and is not failed after the fact. The call's usage
	 * record is written at the same time, when there is a `usage` writer.
	 */
	async function record(call: ModelCallRecord, details: UsageDetails): Promise<void> {
		await Promise.all([
			append(call),
			options.usage === undefined ? undefined : writeUsage(options.usage, usageRecordOf(call, details), onUsageFailure),
		]);
	}

	async function append(call: ModelCallRecord): Promise<void> {
		calls.push(call);
		if (calls.length > MAX_KEPT_CALLS) calls.splice(0, calls.length - MAX_KEPT_CALLS);
		const { scope } = call;
		const event: AuditEventInput = {
			id: `models:call:${call.id}`,
			at: call.at,
			source: "session",
			type: "model.call",
			actor: { kind: "agent", agentId: scope.agentId, sessionId: scope.sessionId },
			organisationId: scope.organisationId,
			projectId: scope.projectId,
			sessionId: scope.sessionId,
			agentId: scope.agentId,
			subject: { kind: "model.call", id: call.id },
			data: {
				route: call.route,
				connectorId: call.connectorId,
				modelId: call.modelId,
				...(call.operation === undefined ? {} : { operation: call.operation }),
				status: call.status,
				...(call.stopReason === undefined ? {} : { stopReason: call.stopReason }),
				durationMs: call.durationMs,
				usage: call.usage as unknown as JsonValue,
				costSource: call.costSource,
			},
		};
		let error: unknown;
		for (let attempt = 1; attempt <= AUDIT_ATTEMPTS; attempt += 1) {
			try {
				await options.audit.append(GATEWAY_CONTEXT, [event]);
				return;
			} catch (failure) {
				error = failure;
			}
		}
		const pending: ModelCallRecord = { ...call, auditPending: true };
		const at = calls.lastIndexOf(call);
		if (at !== -1) calls[at] = pending;
		try {
			await onAuditFailure({ record: pending, event, error, attempts: AUDIT_ATTEMPTS });
		} catch {
			// The host's handler failing changes nothing: the record stays marked pending.
		}
	}

	async function* stream(
		scope: ModelCallScope,
		call: ResolvedCall,
		request: ModelMessagesRequest,
		signal: AbortSignal | undefined,
	): AsyncGenerator<ModelStreamEvent> {
		const id = crypto.randomUUID();
		const startedAt = clock.now();
		const spec = presetSpec(call.connector.preset);
		const controller = new AbortController();
		const onAbort = () => controller.abort(signal?.reason);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		let recorded = false;
		let reportedCost: number | undefined;
		/** When the upstream's first event came, for the usage record's time to first token. */
		let firstEventAt: number | undefined;

		const finish = async (
			status: ModelCallRecord["status"],
			stopReason: string | undefined,
			usage: ModelUsage,
			costSource: ModelCallRecord["costSource"],
			error?: string,
		) => {
			recorded = true;
			await record(
				{
					id,
					at: startedAt,
					scope,
					route: call.routeName,
					connectorId: call.connector.id,
					modelId: call.target.id,
					status,
					...(stopReason === undefined ? {} : { stopReason }),
					durationMs: Math.max(0, clock.now() - startedAt),
					usage,
					costSource,
				},
				{
					connector: call.connector,
					api: call.target.api,
					rates: call.target.model.cost,
					...(error === undefined ? {} : { error: redactor.text(error) }),
					...(firstEventAt === undefined ? {} : { firstTokenMs: Math.max(0, firstEventAt - startedAt) }),
				},
			);
		};

		const priced = (
			usage: Usage,
		): { readonly usage: ModelUsage; readonly costSource: ModelCallRecord["costSource"] } => {
			const counts = {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
				totalTokens: usage.totalTokens,
			};
			if (spec.cost === "none") return { usage: { ...counts, cost: emptyUsage().cost }, costSource: "none" };
			const computed = calculateCost(call.target.model, {
				...usage,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			});
			if (spec.cost === "reported" && reportedCost !== undefined) {
				// Keep the computed split, scaled to the reported total; without one the total stands alone.
				const scale = computed.total > 0 ? reportedCost / computed.total : 0;
				const cost = {
					input: computed.input * scale,
					output: computed.output * scale,
					cacheRead: computed.cacheRead * scale,
					cacheWrite: computed.cacheWrite * scale,
					total: reportedCost,
				};
				return { usage: { ...counts, cost }, costSource: "reported" };
			}
			return { usage: { ...counts, cost: { ...computed } }, costSource: "computed" };
		};

		// Until the key is read there is no secret to redact; every event still leaves through `sanitised`.
		let redactor = new Redactor([]);
		try {
			let key: string;
			try {
				key = await keys.key(call.connector, scope, controller.signal);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const aborted = controller.signal.aborted;
				await finish(aborted ? "aborted" : "error", aborted ? "aborted" : "error", emptyUsage(), "none", message);
				yield sanitised(
					{ type: "error", reason: aborted ? "aborted" : "error", usage: emptyUsage(), errorMessage: message },
					redactor,
				);
				return;
			}
			redactor = new Redactor([key]);
			const deltas = new StreamRedactor(redactor);
			const api = call.target.api;
			const level = request.options?.reasoning ?? call.thinking;
			const fetchOnce = singleRequestFetch(upstreamFetch, (response) => {
				if (response.status === 401) keys.drop(call.connector);
			});
			const namespace = spec.toolNamespace?.(api);
			const { context, restore: toolName } =
				namespace === undefined
					? { context: normalizeContext(request.context as unknown as Context), restore: (name: string) => name }
					: namespaceToolNames(normalizeContext(request.context as unknown as Context), namespace);
			const streamOptions: SimpleStreamOptions = {
				// The key goes in the preset's header, set here and last, never as pi's `apiKey`: from the key's form pi
				// would otherwise pick an auth scheme (an Anthropic `sk-ant-oat` key becomes OAuth with Claude Code's
				// identity; a non-`sk-` key to api.openai.com a ChatGPT sign-in).
				signal: controller.signal,
				sessionId: scope.sessionId,
				fetch: fetchOnce,
				maxRetries: 0,
				headers: { ...spec.headers(scope, api), ...keyHeaders(spec, api, key) },
				...(level === undefined || level === "off" ? {} : { reasoning: level }),
				...(request.options?.temperature === undefined ? {} : { temperature: request.options.temperature }),
				...(request.options?.maxTokens === undefined ? {} : { maxTokens: request.options.maxTokens }),
				...(request.options?.cacheRetention === undefined ? {} : { cacheRetention: request.options.cacheRetention }),
				...(request.options?.toolChoice === undefined || request.options.toolChoice === null
					? {}
					: { toolChoice: request.options.toolChoice as SimpleStreamOptions["toolChoice"] }),
				...(spec.onPayload === undefined
					? {}
					: {
							onPayload: (payload: unknown) => spec.onPayload?.(payload, scope, api, call.connector),
						}),
				onProviderStreamEvent: (raw: unknown) => {
					const cost = reportedCostOf(raw);
					if (cost !== undefined) reportedCost = cost;
				},
			};
			const upstream = (WIRE_STREAMS[api] as (...args: unknown[]) => AsyncIterable<AssistantMessageEvent>)(
				call.target.model,
				context,
				streamOptions,
			);

			const signatureOf = (event: AssistantMessageEvent & { readonly contentIndex: number }) => {
				const block = "partial" in event ? event.partial.content[event.contentIndex] : undefined;
				const signature =
					block?.type === "text"
						? block.textSignature
						: block?.type === "thinking"
							? block.thinkingSignature
							: undefined;
				return signature === undefined ? {} : { contentSignature: signature };
			};
			const flush = (type: "text_delta" | "thinking_delta" | "toolcall_delta", contentIndex: number) => {
				const rest = deltas.end(contentIndex);
				return rest.length === 0 ? [] : [{ type, contentIndex, delta: rest } as const];
			};

			for await (const event of upstream) {
				// pi's `start` comes before the upstream answers; anything after it is the upstream's first output.
				if (firstEventAt === undefined && event.type !== "start") firstEventAt = clock.now();
				const out: ModelStreamEvent[] = [];
				switch (event.type) {
					case "start":
						out.push({ type: "start" });
						break;
					case "text_start":
					case "thinking_start":
						out.push({ type: event.type, contentIndex: event.contentIndex });
						break;
					case "toolcall_start": {
						const block = event.partial.content[event.contentIndex] as ToolCall | undefined;
						out.push({
							type: "toolcall_start",
							contentIndex: event.contentIndex,
							id: block?.id ?? "",
							toolName: toolName(block?.name ?? ""),
						});
						break;
					}
					case "text_delta":
					case "thinking_delta":
					case "toolcall_delta": {
						const released = deltas.push(event.contentIndex, event.delta);
						if (released.length > 0) out.push({ type: event.type, contentIndex: event.contentIndex, delta: released });
						break;
					}
					case "text_end":
						out.push(...flush("text_delta", event.contentIndex), {
							type: "text_end",
							contentIndex: event.contentIndex,
							content: event.content,
							...signatureOf(event),
						});
						break;
					case "thinking_end": {
						const block = event.partial.content[event.contentIndex];
						out.push(...flush("thinking_delta", event.contentIndex), {
							type: "thinking_end",
							contentIndex: event.contentIndex,
							content: event.content,
							...signatureOf(event),
							...(block?.type === "thinking" && block.redacted !== undefined ? { redacted: block.redacted } : {}),
						});
						break;
					}
					case "toolcall_end": {
						const tool = event.toolCall;
						out.push(...flush("toolcall_delta", event.contentIndex), {
							type: "toolcall_end",
							contentIndex: event.contentIndex,
							toolCall: {
								type: "toolCall",
								id: tool.id,
								name: toolName(tool.name),
								arguments: tool.arguments as { readonly [key: string]: JsonValue },
								...(tool.argumentsError === undefined ? {} : { argumentsError: tool.argumentsError }),
								...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
								...(tool.thoughtSignature === undefined ? {} : { thoughtSignature: tool.thoughtSignature }),
							},
						});
						break;
					}
					case "done": {
						const { usage, costSource } = priced(event.message.usage);
						const message = event.message;
						if (event.reason === "deferred") {
							const errorMessage = "The upstream deferred the response, which the gateway does not support";
							await finish("error", "error", usage, costSource, errorMessage);
							yield sanitised({ type: "error", reason: "error", usage, errorMessage }, redactor);
							return;
						}
						await finish("done", event.reason, usage, costSource);
						yield sanitised(
							{
								type: "done",
								reason: event.reason,
								usage,
								...(message.responseId === undefined ? {} : { responseId: message.responseId }),
								...(message.providerThinkingLevel === undefined
									? {}
									: { providerThinkingLevel: message.providerThinkingLevel }),
							},
							redactor,
						);
						return;
					}
					case "error": {
						const { usage, costSource } = priced(event.error.usage);
						const message = event.error;
						await finish(
							event.reason === "aborted" ? "aborted" : "error",
							event.reason,
							usage,
							costSource,
							message.errorMessage,
						);
						yield sanitised(
							{
								type: "error",
								reason: event.reason,
								usage,
								...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
								...(message.responseId === undefined ? {} : { responseId: message.responseId }),
								...(message.providerThinkingLevel === undefined
									? {}
									: { providerThinkingLevel: message.providerThinkingLevel }),
							},
							redactor,
						);
						return;
					}
				}
				for (const converted of out) yield sanitised(converted, redactor);
			}
			// pi's streams always end with done or error; a stream that doesn't is an error the runtime may retry.
			const ended = "The upstream stream ended without a terminal event";
			await finish("error", "error", emptyUsage(), spec.cost === "none" ? "none" : "computed", ended);
			yield sanitised({ type: "error", reason: "error", usage: emptyUsage(), errorMessage: ended }, redactor);
		} catch (error) {
			// A throw once the call resolved, from pi or the gateway itself, ends the call in an error event, recorded as
			// one; only a real abort is recorded as aborted.
			if (recorded) throw error;
			const aborted = controller.signal.aborted;
			const reason = aborted ? "aborted" : "error";
			const errorMessage = error instanceof Error ? error.message : String(error);
			await finish(reason, reason, emptyUsage(), spec.cost === "none" ? "none" : "computed", errorMessage);
			yield sanitised({ type: "error", reason, usage: emptyUsage(), errorMessage }, redactor);
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (!recorded) {
				// The consumer stopped reading (a client disconnect): cancel the upstream and record the call as aborted.
				controller.abort();
				await finish("aborted", "aborted", emptyUsage(), spec.cost === "none" ? "none" : "computed");
			}
		}
	}

	/** Checks a console caller: `needed` on `projectId`, or across the organisation; agents never pass. */
	async function requireCaller(
		ctx: CallContext,
		needed: "viewer" | "admin",
		operation: string,
		projectId: string | undefined,
	): Promise<void> {
		if (typeof ctx !== "object" || ctx === null || typeof ctx.actor !== "object" || ctx.actor === null) {
			throw new HarbourError("forbidden", "The caller may not do this in this project");
		}
		if (isSystemActor(ctx.actor)) return;
		if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", "The caller may not do this in this project");
		await options.access?.require(ctx, { needed, operation, ...(projectId === undefined ? {} : { projectId }) });
	}

	/**
	 * One `images` call to `served`, recorded as `routeName`: the upstream request over the model's image API, its
	 * images, usage and cost, and the call's `ModelCallRecord` and `model.call` event.
	 */
	async function generate(
		scope: ModelCallScope,
		served: ServedModel,
		routeName: string,
		request: ModelImagesRequest,
		signal: AbortSignal | undefined,
	): Promise<ModelImagesResult> {
		const { connector, target } = served;
		if (target.imageApi === undefined || !target.output.includes("image")) {
			throw new HarbourError("invalid", `Model ${request.model} doesn't make images`);
		}
		const spec = presetSpec(connector.preset);
		// A chat image call's body is built first, so a size the upstream can't be asked for is refused before any record.
		const chatBody =
			target.imageApi === "chat-modalities"
				? chatModalitiesBody({
						modelId: target.id,
						output: target.output,
						request,
						imageConfig: spec.chatImageConfig === true,
						...(target.model.compat === undefined
							? {}
							: { compat: target.model.compat as { readonly [key: string]: unknown } }),
					})
				: undefined;
		const imageCost = spec.imageCost ?? spec.cost;
		const id = crypto.randomUUID();
		const startedAt = clock.now();
		const controller = new AbortController();
		const onAbort = () => controller.abort(signal?.reason);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		let recorded = false;
		// Recorded as `messages` records its calls: the `model.call` event, and the usage record under the image API.
		const finish = (
			status: ModelCallRecord["status"],
			usage: ModelUsage,
			costSource: ModelCallRecord["costSource"],
			priced: { readonly error?: string; readonly priceVersion?: string } = {},
		) => {
			recorded = true;
			return record(
				{
					id,
					at: startedAt,
					scope,
					route: routeName,
					connectorId: connector.id,
					modelId: target.id,
					operation: "images",
					status,
					stopReason: status === "done" ? "stop" : status,
					durationMs: Math.max(0, clock.now() - startedAt),
					usage,
					costSource,
				},
				// Its usage row, under the image API it was made over (not the chat wire whose base URL it shares).
				{
					connector,
					api: target.imageApi ?? "openai-images",
					rates: target.model.cost,
					...(priced.priceVersion === undefined ? {} : { priceVersion: priced.priceVersion }),
					...(priced.error === undefined ? {} : { error: redactor.text(priced.error) }),
				},
			);
		};
		const failedCostSource = spec.cost === "none" ? "none" : "computed";
		let redactor = new Redactor([]);
		/** Whether the key was read: a call that failed before it reached no upstream, and costs nothing (as `messages`). */
		let keyRead = false;
		try {
			const key = await keys.key(connector, scope, controller.signal);
			keyRead = true;
			redactor = new Redactor([key]);
			// Both image APIs post under the connector's OpenAI-style API root, with the key and attribution as chat does.
			const baseUrl = upstreamBaseUrl(connector.baseUrl, "openai-completions");
			const headers = { ...spec.headers(scope, "openai-completions"), ...keyHeaders(spec, "openai-completions", key) };
			const call =
				chatBody === undefined
					? await openaiImages({
							fetch: upstreamFetch,
							baseUrl,
							modelId: target.id,
							request,
							headers,
							...(spec.imagePayload === undefined
								? {}
								: { payload: (body: { readonly [key: string]: unknown }) => spec.imagePayload!(body, scope) }),
							signal: controller.signal,
						})
					: await chatModalitiesImages({
							fetch: upstreamFetch,
							baseUrl,
							// The chat body takes the preset's `onPayload`, as a chat call's does.
							body:
								(spec.onPayload?.(chatBody, scope, "openai-completions", connector) as
									| { readonly [key: string]: unknown }
									| undefined) ?? chatBody,
							headers,
							signal: controller.signal,
						});
			if (call.status === 401) keys.drop(connector);
			if (!call.ok) {
				// An answer without an image may still have been billed (a chat model that only wrote text): keep what it cost.
				const billed =
					call.tokens === undefined && call.reportedCost === undefined
						? undefined
						: pricedImages(imageCost, target, { ...call, images: [] });
				const usage = billed?.usage ?? { ...emptyUsage(), images: 0 };
				await finish(controller.signal.aborted ? "aborted" : "error", usage, billed?.costSource ?? failedCostSource, {
					error: `${call.status}: ${call.errorMessage}`,
					...(billed?.priceVersion === undefined ? {} : { priceVersion: billed.priceVersion }),
				});
				throw new HarbourError(
					call.status === 400 || call.status === 422 ? "invalid" : call.status === 429 ? "exhausted" : "unavailable",
					redactor.text(`${call.status}: ${call.errorMessage}`),
				);
			}
			const { usage, costSource, priceVersion } = pricedImages(imageCost, target, call);
			await finish("done", usage, costSource, priceVersion === undefined ? {} : { priceVersion });
			return {
				images: call.images.map((image) => ({
					mimeType: image.mimeType,
					data: image.data,
					...(image.revisedPrompt === undefined ? {} : { revisedPrompt: redactor.text(image.revisedPrompt) }),
				})),
				...(call.text === undefined ? {} : { text: redactor.text(call.text) }),
				usage,
				route: routeName,
				modelId: target.id,
			};
		} catch (error) {
			// An upstream's refusal was recorded with its answer; a key read, a network failure or an abort is recorded here.
			const aborted = controller.signal.aborted;
			if (!recorded) {
				await finish(
					aborted ? "aborted" : "error",
					{ ...emptyUsage(), images: 0 },
					keyRead ? failedCostSource : "none",
					{
						error: error instanceof Error ? error.message : String(error),
					},
				);
			}
			if (isHarbourError(error) && !aborted) throw error;
			const message = redactor.text(error instanceof Error ? error.message : String(error));
			throw new HarbourError(aborted ? "aborted" : "unavailable", message);
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	return {
		// Lists what `messages` would serve: each ID the session pinned through its pin, route or no route, and each
		// unpinned route and override through the route's current connector.
		async config(session, signal) {
			const routes = await connectors.resolve(GATEWAY_CONTEXT, session);
			const policy = await policyOf(session);
			const held = await pins.list(session.sessionId);
			/** Each model ID to list, with what serves it when the session hasn't pinned it. */
			const listed = new Map<string, ServedModel | undefined>();
			for (const resolved of routes) {
				const name = resolved.route.name;
				const { connector } = resolved;
				const offered = await catalogue.offered(connector, session, signal);
				const routeModel = offered.get(resolved.route.modelId);
				listed.set(
					name,
					routeModel === undefined || !policyAllows(policy, connector.id, routeModel.id)
						? undefined
						: { connector, target: routeModel },
				);
				for (const [id, model] of offered) {
					if (id === resolved.route.modelId || !policyAllows(policy, connector.id, id)) continue;
					listed.set(overrideId(name, id), { connector, target: model });
				}
			}
			for (const id of held.keys()) if (!listed.has(id)) listed.set(id, undefined);
			const models: ModelGatewayModel[] = [];
			for (const [id, unpinned] of listed) {
				const pin = held.get(id);
				const served = pin === undefined ? unpinned : await servableOrNone(servePin(session, id, pin, policy, signal));
				if (served !== undefined) models.push(gatewayModel(id, served.target));
			}
			return { baseUrl: options.baseUrl, models };
		},

		async messages(session, request, signal) {
			assertMessagesRequest(request);
			const call = await resolveCall(session, request.model, signal);
			if (!call.target.output.includes("text")) {
				throw new HarbourError("invalid", `Model ${request.model} makes images only; call images`);
			}
			return stream(session, call, request, signal);
		},

		async images(session, request, signal) {
			assertImagesRequest(request);
			const call = await resolveCall(session, request.model, signal);
			return generate(session, call, call.routeName, request, signal);
		},

		async listConnectorModels(ctx, filter) {
			await requireCaller(ctx, "viewer", "models.listConnectorModels", filter?.projectId);
			const inOrganisation: CallContext = { actor: GATEWAY_CONTEXT.actor, organisationId: ctx.organisationId };
			const policy =
				filter?.projectId === undefined
					? undefined
					: await connectors.getProjectPolicy(inOrganisation, filter.projectId);
			const listed = await allPages((page) => connectors.listConnectors(inOrganisation, page));
			const routes = await allPages((page) =>
				connectors.listRoutes(
					inOrganisation,
					filter?.projectId === undefined ? undefined : { projectId: filter.projectId },
					page,
				),
			);
			// A catalogue refresh reads the connector's key; the console has no session, so the read is attributed to it.
			const scope: ModelCallScope = {
				organisationId: ctx.organisationId,
				projectId: filter?.projectId ?? CONSOLE_AGENT,
				agentId: CONSOLE_AGENT,
				sessionId: CONSOLE_AGENT,
			};
			const result: ConnectorModels[] = [];
			for (const connector of listed) {
				if (policy?.connectors !== undefined && !policy.connectors.includes(connector.id)) continue;
				const offered = await catalogue.offered(connector, scope, ctx.signal);
				const models: ConnectorModel[] = [];
				for (const target of offered.values()) {
					if (policy !== undefined && !policyAllows(policy, connector.id, target.id)) continue;
					models.push({
						id: target.id,
						name: target.model.name,
						input: [...target.model.input],
						output: [...target.output],
						...(target.imageApi === undefined ? {} : { imageApi: target.imageApi }),
						...(target.model.contextWindow > 0 ? { contextWindow: target.model.contextWindow } : {}),
					});
				}
				result.push({
					id: connector.id,
					owner: connector.owner,
					preset: connector.preset,
					routes: routes
						.filter((route) => route.connectorId === connector.id)
						.map((route) => ({ name: route.name, modelId: route.modelId })),
					models,
				});
			}
			return result;
		},

		async testImage(ctx, input) {
			if (
				typeof input !== "object" ||
				input === null ||
				typeof input.projectId !== "string" ||
				input.projectId === ""
			) {
				throw new HarbourError("invalid", "A test image is made in a project");
			}
			await requireCaller(ctx, "admin", "models.testImage", input.projectId);
			const scope: ModelCallScope = {
				organisationId: ctx.organisationId,
				projectId: input.projectId,
				agentId: CONSOLE_AGENT,
				sessionId: `connector-test:${crypto.randomUUID()}`,
			};
			let connector: ModelConnector;
			try {
				connector = await connectors.getConnector(directoryContext(scope), input.connectorId);
			} catch (error) {
				if (isHarbourError(error, "not_found"))
					throw new HarbourError("not_found", `No connector ${input.connectorId}`);
				throw error;
			}
			const served = await serve(scope, input.modelId, connector, input.modelId, await policyOf(scope), ctx.signal);
			const request: ModelImagesRequest = {
				model: input.modelId,
				prompt: input.prompt ?? TEST_IMAGE_PROMPT,
				count: 1,
				aspect: "square",
				quality: "low",
			};
			assertImagesRequest(request);
			return generate(scope, served, TEST_IMAGE_ROUTE, request, ctx.signal);
		},

		async listCalls(ctx, filter, page) {
			if (typeof ctx !== "object" || ctx === null || typeof ctx.actor !== "object" || ctx.actor === null) {
				throw new HarbourError("forbidden", "The caller may not do this in this project");
			}
			if (options.access !== undefined) {
				await options.access.require(ctx, {
					needed: "viewer",
					operation: "models.listCalls",
					...(filter?.projectId === undefined ? {} : { projectId: filter.projectId }),
					...(filter?.sessionId === undefined ? {} : { sessionId: filter.sessionId }),
				});
			} else if (ctx.actor.kind === "agent" && !isSystemActor(ctx.actor)) {
				throw new HarbourError("forbidden", "The caller may not do this in this project");
			}
			const matching = calls
				.filter(
					(call) =>
						call.scope.organisationId === ctx.organisationId &&
						(filter?.projectId === undefined || call.scope.projectId === filter.projectId) &&
						(filter?.sessionId === undefined || call.scope.sessionId === filter.sessionId),
				)
				.reverse();
			return pageOf(matching, page);
		},
	};
}

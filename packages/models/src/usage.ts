/**
 * The gateway's usage record for one call (docs/usage-analytics.md): `ModelCallRecord`'s facts plus what analytics
 * groups by and the audit event leaves out (the connector's preset and wire API, who made the model, the prices used,
 * the error text and time to first token).
 */
import type {
	ModelCallRecord,
	ModelConnector,
	ModelImageApi,
	ModelRates,
	ModelWireApi,
	UsageRecord,
	UsageWriter,
} from "@harbour/contracts";
import { findPiModel } from "./catalogue.ts";

/** The longest error text a record keeps. */
export const MAX_USAGE_ERROR_LENGTH = 500;

/** The model makers pi's first-party catalogues name, which `providerOf` trusts. */
const MAKERS = new Set(["anthropic", "openai", "google"]);

/**
 * Who made `modelId` (or the connector override's `canonical` for it): the prefix of a namespaced ID
 * (`anthropic/claude-…` on OpenRouter or Vercel), else the first-party pi catalogue that lists it, else a guess from
 * the name, else `unknown`.
 */
export function providerOf(modelId: string, canonical?: string): string {
	const id = canonical ?? modelId;
	const slash = id.indexOf("/");
	if (slash > 0) return id.slice(0, slash).toLowerCase();
	const pi = findPiModel(id);
	if (pi !== undefined && MAKERS.has(pi.provider)) return pi.provider;
	if (/claude/i.test(id)) return "anthropic";
	if (/^(gpt-|o\d|codex|chatgpt|dall-e)/i.test(id)) return "openai";
	if (/gemini|gemma|imagen/i.test(id)) return "google";
	return "unknown";
}

/** The prices that made a call's cost, as `UsageRecord.priceVersion`. */
export function priceVersionOf(costSource: ModelCallRecord["costSource"], rates: ModelRates): string {
	if (costSource !== "computed") return costSource;
	return `rates:${rates.input}/${rates.output}/${rates.cacheRead}/${rates.cacheWrite}`;
}

export interface UsageDetails {
	readonly connector: Pick<ModelConnector, "preset" | "catalogue">;
	/** The chat call's wire API, or the image call's image API. */
	readonly api: ModelWireApi | ModelImageApi;
	readonly rates: ModelRates;
	/** Which prices made the cost, when not `priceVersionOf(costSource, rates)`: an image call priced per image. */
	readonly priceVersion?: string;
	readonly error?: string;
	readonly firstTokenMs?: number;
}

/** The usage record of `call`. */
export function usageRecordOf(call: ModelCallRecord, details: UsageDetails): UsageRecord {
	const { usage, scope } = call;
	const canonical = details.connector.catalogue.overrides?.[call.modelId]?.canonical;
	const error = details.error?.trim();
	return {
		callId: call.id,
		startedAt: call.at,
		organisationId: scope.organisationId,
		projectId: scope.projectId,
		sessionId: scope.sessionId,
		agentId: scope.agentId,
		route: call.route,
		modelId: call.modelId,
		provider: providerOf(call.modelId, canonical),
		connectorId: call.connectorId,
		connectorPreset: details.connector.preset,
		api: details.api,
		status: call.status,
		...(call.stopReason === undefined ? {} : { stopReason: call.stopReason }),
		...(error === undefined || error === "" ? {} : { error: error.slice(0, MAX_USAGE_ERROR_LENGTH) }),
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		...(usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning }),
		images: usage.images ?? 0,
		cost: { ...usage.cost },
		costSource: call.costSource,
		priceVersion: details.priceVersion ?? priceVersionOf(call.costSource, details.rates),
		durationMs: call.durationMs,
		...(details.firstTokenMs === undefined ? {} : { firstTokenMs: details.firstTokenMs }),
	};
}

/** A usage write the gateway gave up on, after retrying. */
export interface UsageWriteFailure {
	readonly record: UsageRecord;
	readonly error: unknown;
	readonly attempts: number;
}

/** How many times the gateway tries to write one usage record. */
export const USAGE_ATTEMPTS = 3;

/**
 * Writes `record`, trying up to `USAGE_ATTEMPTS` times; the writer ignores a record it has, so a retry adds nothing.
 * Never rejects: a write that keeps failing goes to `onFailure`, and the call it describes goes on unaffected.
 */
export async function writeUsage(
	writer: UsageWriter,
	record: UsageRecord,
	onFailure: (failure: UsageWriteFailure) => void | Promise<void>,
): Promise<void> {
	let error: unknown;
	for (let attempt = 1; attempt <= USAGE_ATTEMPTS; attempt += 1) {
		try {
			await writer.record(record);
			return;
		} catch (failure) {
			error = failure;
		}
	}
	try {
		await onFailure({ record, error, attempts: USAGE_ATTEMPTS });
	} catch {
		// The host's handler failing changes nothing.
	}
}

/** The default for a usage write that failed: one log line naming the call and the error. */
export function logUsageFailure({ record, error, attempts }: UsageWriteFailure): void {
	console.error(
		JSON.stringify({
			error: "usage record write failed",
			callId: record.callId,
			organisationId: record.organisationId,
			sessionId: record.sessionId,
			attempts,
			message: error instanceof Error ? error.message : String(error),
		}),
	);
}

/**
 * Usage analytics (docs/usage-analytics.md): one immutable record per model call, written by the model gateway where
 * it sees the provider's response, kept in a local ledger and shipped in batches to analytics sinks. Experimental,
 * behind each target's `HARBOUR_USAGE` switch.
 */
import type { AgentId, OrganisationId, ProjectId, SessionId, Timestamp } from "./common.ts";
import type { ConnectorPreset, ModelImageApi, ModelWireApi } from "./models.ts";

/** One model call's usage. Immutable; `(sessionId, callId)` is its idempotency key. */
export interface UsageRecord {
	/** The gateway's ID for the call. A call Pi Durable retries is a new call with its own ID. */
	readonly callId: string;
	/** When the call started. */
	readonly startedAt: Timestamp;
	readonly organisationId: OrganisationId;
	readonly projectId: ProjectId;
	readonly sessionId: SessionId;
	/** The agent profile the session runs. */
	readonly agentId: AgentId;
	/** The run (Pi Durable submission) the call belongs to, once the runtime sends it. */
	readonly runId?: string;
	/** The route the session asked for. */
	readonly route: string;
	/** The upstream model that served the call. */
	readonly modelId: string;
	/** Who made the model (`anthropic`, `openai`, `google`, …), `unknown` when it can't be told. */
	readonly provider: string;
	readonly connectorId: string;
	/** The connector's kind (`cliproxyapi`, `litellm`, `openrouter`, …). */
	readonly connectorPreset: ConnectorPreset;
	/** The wire API of a messages call, or the image API of an `images` call. */
	readonly api: ModelWireApi | ModelImageApi;
	readonly status: "done" | "error" | "aborted";
	readonly stopReason?: string;
	/** The upstream's error text, redacted and cut to 500 characters. */
	readonly error?: string;
	/** Input not read from or written to the provider's cache. */
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	/** A subset of `outputTokens`, when the upstream reports it. */
	readonly reasoningTokens?: number;
	/** US dollars; zero when `costSource` is `none`. */
	readonly cost: {
		readonly total: number;
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
	};
	readonly costSource: "reported" | "computed" | "none";
	/**
	 * Which prices made `cost`: `rates:<input>/<output>/<cacheRead>/<cacheWrite>` in US dollars per million tokens for a
	 * computed cost (the connector's catalogue rates at call time), `reported` or `none`.
	 */
	readonly priceVersion: string;
	readonly durationMs: number;
	/** Time from the call's start to the upstream's first streamed event; absent when none came. */
	readonly firstTokenMs?: number;
}

/** Where the gateway writes each call's record, on the call's path: a local ledger. */
export interface UsageWriter {
	/** Stores `record` unless one with its `(sessionId, callId)` is stored already. */
	record(record: UsageRecord): Promise<void>;
}

/** An analytics store the shipper fills from the ledger: ClickHouse, D1, Postgres. */
export interface UsageSink {
	/**
	 * Stores `records`, ignoring any whose `(sessionId, callId)` it holds already. `batchId` is the same each time one
	 * batch is sent again, for a store that deduplicates by batch. Rejects to have the batch sent again.
	 */
	write(records: readonly UsageRecord[], batchId: string): Promise<void>;
}

/**
 * The capability registry: one registry that direct tool calls, code-mode scripts and saved programs all call.
 *
 * A capability is a host-authorised action with a credential-free schema. Discovery shows a caller only what it may
 * call, so nothing is typed but unavailable. Every call is checked against the caller's grants again, at call time,
 * and journalled: the journal, not an activity log, is what makes a call replayable. Harbour makes no exactly-once
 * promise; each capability declares how it may be replayed, and a call that began and never committed is reported as
 * uncertain for an operator to settle.
 *
 * Host tools (`HostToolBridge` in `session.ts`) are capabilities served by a host over a callback.
 */
import type {
	Actor,
	AgentId,
	CallContext,
	JsonSchema,
	JsonValue,
	OrganisationId,
	Page,
	PageRequest,
	ProjectId,
	ReplayPolicy,
	SessionId,
	Subscription,
	Timestamp,
} from "./common.ts";

/** Dotted names, such as `github.issue.read` or `sal.task_outcome`. */
export type CapabilityName = string;

export interface CapabilityDefinition {
	readonly name: CapabilityName;
	/** Changes when the input or output meaning changes; journalled with every call. */
	readonly version: string;
	readonly description: string;
	readonly inputSchema: JsonSchema;
	readonly outputSchema?: JsonSchema;
	readonly replay: ReplayPolicy;
	/** Where it runs. `host` capabilities are served by a registered provider. */
	readonly runsIn: "isolate" | "container" | "host";
}

/** Which callers a capability grant applies to. Absent fields match anything within the organisation. */
export interface CapabilitySelector {
	readonly projectId?: ProjectId;
	readonly agentId?: AgentId;
	readonly sessionId?: SessionId;
}

export interface CapabilityGrant {
	readonly id: string;
	readonly organisationId: OrganisationId;
	readonly selector: CapabilitySelector;
	/** Exact names, or a namespace ending in `.*` (`github.*` covers `github.issue.read`). */
	readonly capabilities: readonly string[];
	readonly grantedBy: Actor;
	readonly createdAt: Timestamp;
	readonly expiresAt?: Timestamp;
	readonly status: "active" | "revoked" | "expired";
}

export interface CapabilityInvocation {
	/** Stable across retries of the same call; the journal is keyed by it. */
	readonly callId: string;
	readonly capability: CapabilityName;
	readonly version: string;
	readonly args: JsonValue;
	readonly organisationId: OrganisationId;
	readonly projectId: ProjectId;
	readonly sessionId: SessionId;
	readonly agentId: AgentId;
}

export interface CapabilityResult {
	readonly output: JsonValue;
	readonly isError?: boolean;
}

export type CapabilityHandler = (invocation: CapabilityInvocation, signal: AbortSignal) => Promise<CapabilityResult>;

export type JournalStatus =
	/** The handler has been called and has not returned. After a crash this means the call may have run. */
	| "started"
	| "committed"
	| "failed"
	/** Settled by an operator after a call that began and never committed. */
	| "resolved";

export interface JournalEntry {
	readonly callId: string;
	readonly capability: CapabilityName;
	readonly version: string;
	/** Hex SHA-256 of the canonical JSON of the arguments. */
	readonly inputFingerprint: string;
	readonly sessionId: SessionId;
	readonly agentId: AgentId;
	readonly replay: ReplayPolicy;
	readonly status: JournalStatus;
	readonly result?: CapabilityResult;
	readonly error?: string;
	readonly startedAt: Timestamp;
	readonly settledAt?: Timestamp;
	readonly resolvedBy?: Actor;
}

export interface InvokeInput {
	readonly callId: string;
	readonly capability: CapabilityName;
	readonly args: JsonValue;
	/** Fails with `conflict` if the registered version differs (a program built against an older version). */
	readonly expectVersion?: string;
}

export interface CapabilityRegistry {
	/**
	 * Registers capabilities served by `handler`. Agents may not register (`forbidden`). A name already registered by
	 * another provider is `conflict`. Closing the subscription unregisters them.
	 */
	register(
		ctx: CallContext,
		definitions: readonly CapabilityDefinition[],
		handler: CapabilityHandler,
	): Promise<Subscription>;
	/**
	 * What the caller may call. For an agent actor, only capabilities an active grant covers for its session, agent
	 * and project; for a human or service, every registered capability of the organisation.
	 */
	discover(ctx: CallContext): Promise<readonly CapabilityDefinition[]>;
	grant(
		ctx: CallContext,
		input: {
			readonly selector: CapabilitySelector;
			readonly capabilities: readonly string[];
			readonly ttlMs?: number;
		},
	): Promise<CapabilityGrant>;
	revokeGrant(ctx: CallContext, grantId: string): Promise<CapabilityGrant>;
	listGrants(ctx: CallContext, page?: PageRequest): Promise<Page<CapabilityGrant>>;
	/**
	 * Calls a capability as the agent in `ctx` (an agent actor; `projectId` required). Grants are checked on every call,
	 * including retries: a revoked grant refuses even a call ID seen before.
	 *
	 * Replay by call ID: a committed or failed call returns its journalled result without calling the handler again.
	 * The same call ID with different arguments or capability is `conflict`. A call still `started`, for an `unsafe`
	 * capability, is `refused` (it may have run; an operator resolves it); for `safe` and `idempotent` ones the handler
	 * is called again with the same call ID.
	 */
	invoke(ctx: CallContext, input: InvokeInput): Promise<CapabilityResult>;
	journal(ctx: CallContext, callId: string): Promise<JournalEntry>;
	listJournal(
		ctx: CallContext,
		filter: { readonly sessionId?: SessionId; readonly status?: JournalStatus },
		page?: PageRequest,
	): Promise<Page<JournalEntry>>;
	/** The operator path for a call that began and never committed. Humans and services only. */
	resolve(ctx: CallContext, callId: string, result: CapabilityResult): Promise<JournalEntry>;
}

/**
 * Session runtime and directory. A session is one durable agent conversation (one Pi Durable harness), owned by an
 * organisation and project and run with an agent profile. A host prompts, steers, follows up, aborts and watches it,
 * and serves host tools over an authenticated callback.
 *
 * Pi types never appear here; the runtime projects Pi Durable's transcript onto `@harbour/protocol` items.
 */
import type { ServerFrame, SessionSnapshot, SessionStatus, Usage } from "@harbour/protocol";
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
	WorkspaceId,
} from "./common.ts";
import type { ModelThinking } from "./models.ts";
import type { SandboxPolicy } from "./sandbox.ts";

export type { SessionStatus } from "@harbour/protocol";

export interface PromptLayer {
	/** Such as `worker`, `role`, `brief`. Layers are joined in order. */
	readonly name: string;
	readonly text: string;
}

/** A named model route, resolved by the runtime (on Harbour, a vault route to a model gateway). */
export interface ModelChoice {
	readonly route: string;
	readonly modelId?: string;
	readonly thinking?: "off" | "low" | "medium" | "high";
}

/** What a session runs with. Host apps register their profiles (such as Sal's `sal-worker`). */
export interface AgentProfile {
	readonly id: AgentId;
	readonly organisationId: OrganisationId;
	readonly projectId?: ProjectId;
	readonly name: string;
	readonly model: ModelChoice;
	readonly promptLayers: readonly PromptLayer[];
	/** Tool and capability names the agent may call, including host tools. */
	readonly tools: readonly string[];
	/** Skill IDs the session lists, by name, description and path. */
	readonly skills: readonly string[];
	readonly sandbox: SandboxPolicy;
	/** Memory scopes recall may read. */
	readonly memoryScopes: readonly string[];
	/** Host tools are served by this host; see `HostToolBridge`. */
	readonly hostId?: string;
}

export interface SessionRecord {
	readonly id: SessionId;
	readonly organisationId: OrganisationId;
	readonly projectId: ProjectId;
	readonly agentId: AgentId;
	readonly parentSessionId?: SessionId;
	readonly workspaceId?: WorkspaceId;
	readonly title?: string;
	readonly status: SessionStatus;
	/** Host labels, such as `{ docketTask: "TASK-3347" }`. */
	readonly labels: { readonly [key: string]: string };
	readonly createdBy: Actor;
	readonly createdAt: Timestamp;
	readonly updatedAt: Timestamp;
}

export interface CreateSessionInput {
	readonly projectId: ProjectId;
	readonly agentId: AgentId;
	readonly title?: string;
	readonly labels?: { readonly [key: string]: string };
	readonly workspaceId?: WorkspaceId;
	/** Creates a child session owned by this parent; aborting the parent aborts it. */
	readonly parentSessionId?: SessionId;
}

/**
 * A file a person attached to a prompt (the composer's picker, a drop or a paste), already uploaded by the host. The
 * host owns the upload: where the bytes are stored, scanning and size limits. The prompt carries only this reference.
 *
 * Proposed (27 Oct 2026, alongside `@harbour/ui`'s composer): the reference runtime doesn't read attachments yet, and
 * how it reads one through the host that uploaded it is open question 14 in docs/contracts.md.
 */
export interface PromptAttachment {
	/** The host's ID for the upload. Unique within the prompt. */
	readonly id: string;
	/** The file's name as the person saw it, such as `invoice.pdf` or `pasted-text.txt`. */
	readonly name: string;
	/** The MIME type, such as `image/png` or `text/plain`. */
	readonly type: string;
	/** In bytes. */
	readonly size: number;
	/**
	 * `image`: a PNG, JPEG, GIF or WebP a model can look at; `file`: any other file; `text`: a large paste the composer
	 * folded into a file instead of the prompt's text.
	 */
	readonly kind: "image" | "file" | "text";
}

export interface PromptInput {
	/** The prompt's words. Proposed: may be empty when `attachments` has at least one item. */
	readonly text: string;
	/** Retrying with the same requestId returns the same submission instead of submitting twice. */
	readonly requestId?: string;
	/** Proposed: files the host uploaded for this prompt, in the order the person attached them. */
	readonly attachments?: readonly PromptAttachment[];
	/**
	 * Proposed: a `ModelOption.id` from `SessionModels.listModels`, which this input's run and the session's later runs
	 * use (a steer's from the run's next model call). Absent keeps the session's current model. An ID the session can't
	 * use is `invalid`, and one with a
	 * `disabledReason` is `refused`; an image attachment for a model whose `capabilities.images` is `false` is `invalid`.
	 */
	readonly model?: string;
}

/**
 * One model a person may choose for a session: one of the models `ModelGateway.config` lists for it (a route, or a
 * route's model override), as the composer's model picker shows it. The organisation's and project's configuration
 * (connectors, routes and the project's policy, see models.ts) decide the list; this only describes it.
 */
export interface ModelOption {
	/** `ModelGatewayModel.id`: a route name such as `default`, or `<route>:<modelId>` for an override. */
	readonly id: string;
	/** What a person reads, such as `Claude Sonnet 4.5`. */
	readonly label: string;
	/** Who serves the model, for grouping the list, such as `Anthropic`. */
	readonly provider?: string;
	/** One short line, such as `Fast, for small edits`. */
	readonly description?: string;
	/** What the model takes. A field left out is unknown, and clients act only on what is given. */
	readonly capabilities?: {
		/** Reads images: `ModelGatewayModel.input` includes `image`. */
		readonly images?: boolean;
		/** The thinking levels it supports: the levels `ModelGatewayModel.thinkingLevelMap` doesn't map to `null`. */
		readonly thinking?: readonly ModelThinking[];
	};
	/**
	 * The model the session runs with when a prompt names none: its agent profile's route, until a prompt names
	 * another. At most one option.
	 */
	readonly default?: boolean;
	/** Set when the model is listed but can't be chosen now, with the reason a person reads. Shown dimmed, not hidden. */
	readonly disabledReason?: string;
}

/**
 * Proposed (27 Oct 2026): the models a session's prompts may name, for a client's model picker. A separate interface so
 * that no existing `SessionRuntime` has to change to adopt it.
 */
export interface SessionModels {
	/**
	 * The models the session may use, in the order to show them: what the gateway's `config` lists for the session,
	 * after the project's policy, with exactly one `default` when the session's own route is among them. The caller needs
	 * viewer on the session's project; another organisation's session is `not_found`.
	 */
	listModels(ctx: CallContext, sessionId: SessionId): Promise<readonly ModelOption[]>;
}

export interface Submission {
	readonly id: string;
	readonly sessionId: SessionId;
	readonly via: "prompt" | "steer" | "followUp";
	readonly requestId?: string;
}

/** How a run (an input to its final answer) ended. */
export interface RunResult {
	readonly sessionId: SessionId;
	readonly submissionId: string;
	readonly status: "answered" | "failed" | "aborted";
	readonly answer?: string;
	readonly error?: string;
	readonly usage?: Usage;
}

export interface WatchOptions {
	/** Resume after this cursor; a snapshot is sent when the runtime cannot resume from it. */
	readonly after?: string;
}

/**
 * Why the session-end hook runs: `aborted` (the session stays usable, and later input starts a new run) or
 * `session_ended` (closed for good).
 */
export type SessionEndReason = "aborted" | "session_ended";

/** What the session-end hook tells each teardown. */
export interface SessionEnd {
	readonly sessionId: SessionId;
	readonly organisationId: OrganisationId;
	readonly projectId: ProjectId;
	readonly agentId: AgentId;
	readonly parentSessionId?: SessionId;
	readonly reason: SessionEndReason;
	/** Who closed or aborted the session (for a child, whoever aborted its parent). */
	readonly endedBy: Actor;
	readonly at: Timestamp;
}

/**
 * One component's teardown: it ends everything it holds for `end.sessionId`. `ctx` is a `system` context in the
 * session's organisation, so a teardown never fails a permission check. A teardown must be idempotent: when the session
 * holds nothing more in the component, it changes nothing and audits nothing.
 */
export type SessionTeardown = (ctx: CallContext, end: SessionEnd) => Promise<void>;

/**
 * Settled 27 Oct 2026 (open question 8): one session-end hook. The runtime runs it when a session is closed and when
 * it is aborted (a parent's abort or close runs it for each child too). Components register their teardown once, at
 * wiring time: the sandbox releases its leases, the browser closes its browser sessions and ends its grants (grants
 * passed on from them end too), and the capability registry and the vault end the session's grants.
 *
 * Every registered teardown runs, in registration order, even when one before it fails. A failure is audited as
 * `session.teardown.failed` with the teardown's name and error code, never its message, and does not fail `close` or
 * `abort`. Closing a closed session runs nothing.
 */
export interface SessionEndHook {
	/** Adds a teardown under a unique name (`conflict` if the name is taken). Closing the subscription removes it. */
	register(name: string, teardown: SessionTeardown): Subscription;
}

export interface SessionRuntime {
	/**
	 * Creates a session (idle, with no transcript). The actor needs operator on the project; an agent may create one
	 * only in its own session's project. A child session is in its parent's project.
	 */
	create(ctx: CallContext, input: CreateSessionInput): Promise<SessionRecord>;
	/** Durably admits user input. Starts a run when idle; queues it when busy. */
	prompt(ctx: CallContext, sessionId: SessionId, input: PromptInput): Promise<Submission>;
	/** Joins the running turn after its current tool round; behaves as `prompt` when idle. */
	steer(ctx: CallContext, sessionId: SessionId, input: PromptInput): Promise<Submission>;
	/** Queues input to run after the current run finishes. */
	followUp(ctx: CallContext, sessionId: SessionId, input: PromptInput): Promise<Submission>;
	/**
	 * Stops the running turn, cascades to child sessions and runs the session-end hook (`aborted`), so the session's
	 * browsers, browser, capability and vault grants and sandbox leases end. The session stays usable: a later prompt
	 * starts a new run. Aborting a closed session does nothing.
	 */
	abort(ctx: CallContext, sessionId: SessionId, reason?: string): Promise<void>;
	/** Waits for the run that `submissionId` started or joined to end. */
	wait(ctx: CallContext, sessionId: SessionId, submissionId: string): Promise<RunResult>;
	/** Streams protocol frames: hello, then deltas after `after` or a snapshot, then live deltas. */
	watch(
		ctx: CallContext,
		sessionId: SessionId,
		options: WatchOptions,
		onFrame: (frame: ServerFrame) => void,
	): Promise<Subscription>;
	snapshot(ctx: CallContext, sessionId: SessionId): Promise<SessionSnapshot>;
	/**
	 * Ends the session for good: aborts work, runs the session-end hook (`session_ended`) and marks it done. Later
	 * prompts reject with `conflict`; closing it again does nothing.
	 */
	close(ctx: CallContext, sessionId: SessionId): Promise<void>;
}

export interface SessionFilter {
	readonly projectId?: ProjectId;
	readonly agentId?: AgentId;
	readonly status?: SessionStatus;
	readonly parentSessionId?: SessionId;
	/** Every label given must match. */
	readonly labels?: { readonly [key: string]: string };
}

/** Where sessions are found: by organisation, project, agent, parent and labels. */
export interface SessionDirectory {
	get(ctx: CallContext, sessionId: SessionId): Promise<SessionRecord>;
	/** Newest first. Only sessions in `ctx.organisationId`. */
	list(ctx: CallContext, filter?: SessionFilter, page?: PageRequest): Promise<Page<SessionRecord>>;
	children(ctx: CallContext, sessionId: SessionId): Promise<readonly SessionRecord[]>;
}

export interface AgentProfiles {
	put(ctx: CallContext, profile: AgentProfile): Promise<AgentProfile>;
	get(ctx: CallContext, agentId: AgentId): Promise<AgentProfile>;
	list(ctx: CallContext, page?: PageRequest): Promise<Page<AgentProfile>>;
}

/** A tool served by a host app (Sal's task_outcome, its brokered Slack and Drive tools). */
export interface HostToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: JsonSchema;
	readonly replay: ReplayPolicy;
}

export interface HostToolCall {
	readonly hostId: string;
	readonly sessionId: SessionId;
	readonly organisationId: OrganisationId;
	readonly projectId: ProjectId;
	readonly agentId: AgentId;
	/** Stable across retries of the same call. */
	readonly callId: string;
	readonly tool: string;
	readonly args: JsonValue;
}

export interface HostToolResult {
	readonly output: string;
	readonly isError?: boolean;
	readonly structured?: JsonValue;
}

export type HostToolHandler = (call: HostToolCall, signal: AbortSignal) => Promise<HostToolResult>;

/**
 * How a host serves its tools. On a deployed target the handler is an authenticated HTTPS callback; in memory it is a
 * function. A tool named in a profile but not registered fails the call with an error result.
 */
export interface HostToolBridge {
	register(
		ctx: CallContext,
		hostId: string,
		tools: readonly HostToolDefinition[],
		handler: HostToolHandler,
	): Promise<Subscription>;
	list(ctx: CallContext, hostId: string): Promise<readonly HostToolDefinition[]>;
}

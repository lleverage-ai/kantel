// The self-hosted spike's internal shapes, next to Kantel's real contracts.
//
// What the real contracts cover is taken from packages/contracts: the tier
// type and the tool-to-tier table (apps/selfhosted/src/sandbox/router.ts), and
// the `Workspaces` contract, which apps/selfhosted/src/workspaces.ts implements
// on Postgres + MinIO and which passes packages/testing's workspace suite.
// What is left here is spike-internal: the manifest-per-command store the
// session host runs on today, the per-command sandbox runner, the session lease
// that stands in for a Durable Object (no contract covers it), and the spike's
// HTTP API.

// ---------------------------------------------------------------- workspace

/** One path in a workspace version. Paths are relative, without a leading slash. */
export type ManifestEntry =
	| { kind: "file"; sha: string; size: number; mode: number }
	| { kind: "symlink"; target: string }
	| { kind: "dir" };

/** A whole workspace version: path to entry. File bodies are content-addressed blobs. */
export type Manifest = Record<string, ManifestEntry>;

export interface WorkspaceHead {
	workspaceId: string;
	/** Opaque version ID; "empty" for a workspace with no commits. */
	version: string;
	seq: number;
}

export interface WorkspaceCommit {
	base: string;
	manifest: Manifest;
	/** Which tier produced the change, for the audit trail. */
	tier: SandboxTier | "host";
	changed: string[];
}

export interface Workspace {
	head(workspaceId: string): Promise<WorkspaceHead>;
	manifest(workspaceId: string, version: string): Promise<Manifest>;
	readBlob(workspaceId: string, sha: string): Promise<Uint8Array>;
	putBlob(workspaceId: string, bytes: Uint8Array): Promise<string>;
	/**
	 * Commit a new version on top of `base`. Fails if `base` is not the head
	 * (one writer per session) or if the caller's lease fence is stale.
	 */
	commit(workspaceId: string, commit: WorkspaceCommit, fence: LeaseFence): Promise<WorkspaceHead>;
}

// ------------------------------------------------------------------ sandbox

import type { SandboxTier } from "../../packages/contracts/src/sandbox.ts";

/** The tool picks the tier, not the agent. */
export type { SandboxTier };

export interface SandboxExecRequest {
	sessionId: string;
	workspaceId: string;
	/** The workspace version the command runs on; the result carries the next one. */
	version: string;
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
}

export interface SandboxExecResult {
	tier: SandboxTier;
	exitCode: number;
	stdout: string;
	stderr: string;
	/** The manifest after the command; committed by the caller at the end of every command. */
	manifest: Manifest;
	changed: string[];
	timings: Record<string, number>;
}

export interface SandboxTierRunner {
	readonly tier: SandboxTier;
	exec(request: SandboxExecRequest, manifest: Manifest, signal?: AbortSignal): Promise<SandboxExecResult>;
}

// -------------------------------------------------------------------- lease

/** Proof of ownership that every durable write carries. A higher fence deposes a lower one. */
export interface LeaseFence {
	sessionId: string;
	owner: string;
	fence: number;
}

export interface Lease extends LeaseFence {
	ownerUrl: string;
	expiresAt: number;
}

/**
 * The self-hosted stand-in for a Durable Object: at most one live owner per
 * session, a fencing token that increases on every takeover, and expiry so a
 * dead owner's sessions move within one TTL.
 */
export interface SessionLeases {
	acquire(sessionId: string, owner: string, ownerUrl: string, ttlMs: number): Promise<Lease | undefined>;
	renew(lease: LeaseFence, ttlMs: number): Promise<Lease | undefined>;
	release(lease: LeaseFence): Promise<void>;
	current(sessionId: string): Promise<Lease | undefined>;
	/** Throws if `lease` is no longer the live owner. Writers call this inside their transaction. */
	check(lease: LeaseFence): Promise<void>;
}

// ----------------------------------------------------- spike HTTP API (both targets)

export interface CreateSessionRequest {
	sessionId?: string;
}

export interface CreateSessionResponse {
	sessionId: string;
	workspaceId: string;
	owner: string;
}

export interface PromptRequest {
	text: string;
	requestId: string;
}

export type SessionStatus = "idle" | "active" | "failed";

export interface ToolCallSummary {
	id: string;
	name: string;
	args: unknown;
	isError?: boolean;
	output?: string;
	tier?: SandboxTier;
}

export interface SessionState {
	sessionId: string;
	workspaceId: string;
	status: SessionStatus;
	owner: string | null;
	fence: number | null;
	workspace: WorkspaceHead;
	/** Tool calls currently running, from Pi Durable's live document. */
	running: ToolCallSummary[];
	/** The settled answer of the latest input, if any. */
	answer?: string;
	/** Every tool result so far, oldest first. */
	toolResults: ToolCallSummary[];
}

/** The scripted, research-style task both targets run. */
export interface ResearchSpec {
	kind: "research";
	/** The page to fetch through the vault. */
	url: string;
	/** Insert a long container call so the scenario can kill the owner mid-call. */
	crash?: boolean;
}

/** A fixed list of tool calls, for conformance cases. */
export interface ExecSpec {
	kind: "exec";
	steps: { tool: "bash" | "write"; args: Record<string, unknown> }[];
	/** Carry on after a failing step instead of stopping. */
	keepGoing?: boolean;
}

export type ScenarioSpec = ResearchSpec | ExecSpec;

export const SCENARIO_PREFIX = "harbour-scenario ";

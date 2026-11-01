/**
 * Sandboxes: one sandbox per session, two tiers over the same workspace.
 *
 * - The tier is chosen by the tool (a routing table), never by the agent.
 * - The isolate tier runs file tools, bash with jq and pipes, and code mode, and commits the workspace at the end of
 *   every command.
 * - The container tier runs real binaries (git, bun, node, python, gh, linear-cli) on the same workspace version and
 *   commits when its lease is released.
 * - Every sandbox is a lease with a TTL that the runtime owns; a lease past its TTL is released by `sweep` even if
 *   nobody asks.
 * - The only way out is the vault: sandboxes never hold credential values.
 * - Mounts are read-only: a command that writes under a mount point fails and the source is unchanged.
 */
import type { CallContext, SessionId, SystemContext, Timestamp, WorkspaceId } from "./common.ts";
import type { WorkspaceVersion } from "./workspace.ts";

export type SandboxTier = "isolate" | "container";

export interface SandboxPolicy {
	/** Tiers this agent may use. A route to a tier not listed is refused. */
	readonly tiers: readonly SandboxTier[];
	readonly containerSize?: string;
	/** Default lease TTL in milliseconds. */
	readonly leaseTtlMs?: number;
}

/**
 * One row of the tool-to-tier table. A row matches a tool name, and for shell tools optionally the program a command
 * starts (its first word, after any `cd ... &&`). The first matching row wins.
 */
export interface TierRoute {
	readonly tool: string;
	/** Programs that send a shell command to this tier, such as `git` or `bun`. Absent: any command. */
	readonly programs?: readonly string[];
	/**
	 * With `programs`: the row matches only a single simple command (no `&&`, `;` or pipes) whose first argument is one
	 * of these, such as git's read subcommands. Absent: any arguments.
	 */
	readonly subcommands?: readonly string[];
	readonly tier: SandboxTier;
}

/** The default table: file tools and plain shell in the isolate; real binaries in the container. */
export const DEFAULT_TIER_ROUTES: readonly TierRoute[] = [
	{
		tool: "bash",
		programs: [
			"git",
			"bun",
			"bunx",
			"node",
			"npm",
			"npx",
			"pnpm",
			"python",
			"python3",
			"pip",
			"gh",
			"linear-cli",
			"linear",
		],
		tier: "container",
	},
	{ tool: "bash", tier: "isolate" },
	{ tool: "read", tier: "isolate" },
	{ tool: "write", tier: "isolate" },
	{ tool: "edit", tier: "isolate" },
	{ tool: "grep", tier: "isolate" },
	{ tool: "find", tier: "isolate" },
	{ tool: "ls", tier: "isolate" },
	{ tool: "codemode", tier: "isolate" },
];

export type LeaseEndReason = "released" | "expired" | "session_ended" | "aborted";

export interface SandboxLease {
	readonly id: string;
	readonly sessionId: SessionId;
	readonly workspaceId: WorkspaceId;
	readonly tier: SandboxTier;
	/** The workspace version the sandbox started on. */
	readonly baseVersion: WorkspaceVersion;
	readonly acquiredAt: Timestamp;
	readonly expiresAt: Timestamp;
	readonly endedAt?: Timestamp;
	readonly endReason?: LeaseEndReason;
}

export interface ExecRequest {
	/** A shell command (run with `sh -c`) or an argv array run without a shell. */
	readonly command: string | readonly string[];
	/** Relative to the workspace root. */
	readonly cwd?: string;
	/** Non-secret variables only. Credentials are injected by the vault on the way out, never here. */
	readonly env?: { readonly [name: string]: string };
	readonly stdin?: string;
	readonly timeoutMs?: number;
}

export interface ExecResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly tier: SandboxTier;
	readonly leaseId: string;
	/** The workspace head after the command (the isolate commits after every command that changed files). */
	readonly workspaceVersion: WorkspaceVersion;
	readonly durationMs: number;
	readonly truncated?: boolean;
}

/** Held and busy time per tier, for the held/bound ratio. */
export interface SandboxUsage {
	readonly tier: SandboxTier;
	readonly leases: number;
	readonly heldMs: number;
	readonly busyMs: number;
}

export interface Sandboxes {
	/** Starts a sandbox of `tier` on the workspace's head. A session holds at most one live lease per tier. */
	acquire(
		ctx: CallContext,
		input: {
			readonly sessionId: SessionId;
			readonly workspaceId: WorkspaceId;
			readonly tier: SandboxTier;
			readonly ttlMs?: number;
		},
	): Promise<SandboxLease>;
	/** Extends a live lease. Rejects with `expired` once it has ended. */
	renew(ctx: CallContext, leaseId: string, ttlMs: number): Promise<SandboxLease>;
	/** Ends a lease; the container tier commits its changes first. Idempotent. */
	release(ctx: CallContext, leaseId: string, reason?: LeaseEndReason): Promise<SandboxLease>;
	/** Runs a command on a live lease. Rejects with `expired` on an ended lease. */
	exec(ctx: CallContext, leaseId: string, request: ExecRequest): Promise<ExecResult>;

	/**
	 * The facade the runtime uses: routes `tool` (and the command's program) through the tier table, reuses or acquires
	 * the session's lease on that tier, and runs the command. When the route leads to the container, the session's
	 * isolate changes are already committed, so the container sees the isolate's last write.
	 */
	run(
		ctx: CallContext,
		input: {
			readonly sessionId: SessionId;
			readonly workspaceId: WorkspaceId;
			readonly tool: string;
			readonly request: ExecRequest;
		},
	): Promise<ExecResult>;

	/** Which tier a tool call would run on, from the routing table. */
	route(tool: string, command?: string | readonly string[]): SandboxTier;

	leases(
		ctx: CallContext,
		filter: { readonly sessionId: SessionId; readonly live?: boolean },
	): Promise<readonly SandboxLease[]>;
	/**
	 * Ends every live lease of a session (session end or abort); the `sandbox` session-end teardown. When the session
	 * holds no live lease it changes nothing and audits nothing, so running it again is a no-op.
	 */
	releaseSession(ctx: CallContext, sessionId: SessionId, reason?: LeaseEndReason): Promise<void>;
	/**
	 * Releases every lease past its TTL as `expired`; returns them. Hosts call this from an alarm. A worker call: any
	 * actor but `system` is `forbidden` and releases nothing.
	 */
	sweep(ctx: SystemContext): Promise<readonly SandboxLease[]>;
	usage(ctx: CallContext, sessionId: SessionId): Promise<readonly SandboxUsage[]>;
}

/**
 * Draft contracts for the M0-CF1 spike.
 *
 * M0-BE1 (#2) owns the real contracts in packages/contracts. These are the smallest shapes the Cloudflare spike needs,
 * kept here so the spike can be built before #2 lands. They carry no Pi Durable types, so the runtime can be swapped
 * without touching them. See spikes/cloudflare/README.md, "Reconciling with M0-BE1", for how each maps onto #2.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Workspace: a versioned file tree on object storage, shared by both sandbox tiers.
// ---------------------------------------------------------------------------------------------------------------------

/** An immutable version of a workspace, such as "v7". */
export type WorkspaceVersion = string;

export interface WorkspaceEntry {
  /** Relative to the workspace root, with `/` separators and no leading slash. */
  readonly path: string;
  /** SHA-256 of the contents, hex. Blobs are content-addressed. */
  readonly hash: string;
  readonly size: number;
  /** POSIX mode bits, such as 0o644 or 0o755. */
  readonly mode: number;
}

export interface WorkspaceManifest {
  readonly workspaceId: string;
  readonly version: WorkspaceVersion;
  readonly parent?: WorkspaceVersion;
  readonly entries: Readonly<Record<string, WorkspaceEntry>>;
}

export type WorkspaceChange =
  | { readonly kind: "put"; readonly path: string; readonly hash: string; readonly size: number; readonly mode: number }
  | { readonly kind: "delete"; readonly path: string };

export class WorkspaceConflict extends Error {
  constructor(
    readonly expected: WorkspaceVersion,
    readonly actual: WorkspaceVersion,
  ) {
    super(`workspace head is ${actual}, not ${expected}`);
  }
}

/**
 * One writer per workspace: commit is a compare-and-swap on the head, so a second writer fails with WorkspaceConflict
 * instead of losing a write. Listing reads only the manifest; bodies are read lazily by hash.
 */
export interface Workspace {
  readonly id: string;
  head(): Promise<WorkspaceVersion>;
  manifest(version: WorkspaceVersion): Promise<WorkspaceManifest>;
  readBlob(hash: string): Promise<Uint8Array | null>;
  /** Stores a blob and returns its hash. Idempotent. */
  putBlob(bytes: Uint8Array): Promise<string>;
  /** Applies changes on top of `base`, which must be the head. Returns the new head; no changes returns `base`. */
  commit(base: WorkspaceVersion, changes: readonly WorkspaceChange[]): Promise<WorkspaceVersion>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sandbox: one facade, two tiers, picked by the command rather than by the agent.
// ---------------------------------------------------------------------------------------------------------------------

export type SandboxTier = "isolate" | "container";

export interface ExecRequest {
  readonly command: string;
  /** Absolute path inside the sandbox; defaults to the workspace root. */
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** Milliseconds per phase, for the cold-start table. Keys are phase names such as "container.start". */
export type PhaseTimings = Record<string, number>;

export interface ExecResult {
  readonly tier: SandboxTier;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Workspace version the command started from. */
  readonly base: WorkspaceVersion;
  /** Workspace version after the command's commit; equal to `base` when nothing changed. */
  readonly version: WorkspaceVersion;
  readonly changed: number;
  readonly timings: PhaseTimings;
}

/** A tier runs one command against one workspace version and commits what it changed before returning. */
export interface SandboxTierRunner {
  readonly tier: SandboxTier;
  exec(request: ExecRequest, base: WorkspaceVersion): Promise<ExecResult>;
  /** Releases what the tier holds (a container lease); safe to call when nothing is held. */
  release(): Promise<void>;
}

export interface Sandbox {
  /** Which tier would run this command. */
  route(command: string): SandboxTier;
  exec(request: ExecRequest): Promise<ExecResult>;
  release(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Vault: the only way out. A stub here: static policies, one injected header, an audit of every use.
// ---------------------------------------------------------------------------------------------------------------------

export interface VaultPolicy {
  /** Exact host the policy covers. */
  readonly host: string;
  readonly methods: readonly string[];
  /** Header to inject and the vault item whose value goes in it. The sandbox never sees the value. */
  readonly inject?: { readonly header: string; readonly item: string };
}

export interface VaultUse {
  readonly at: number;
  readonly sessionId: string;
  readonly tier: SandboxTier;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly decision: "allowed" | "denied";
  /** The injected header's name and item, never its value. */
  readonly injected?: { readonly header: string; readonly item: string };
  readonly status?: number;
  /** Times the item's value was found in the response and redacted before it reached the sandbox. */
  readonly redactions?: number;
}

export interface Vault {
  policies(): readonly VaultPolicy[];
  uses(sessionId: string): Promise<readonly VaultUse[]>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Session runtime: the minimum the spike's HTTP surface exposes; see spikes/scenario/README.md for the wire shape.
// ---------------------------------------------------------------------------------------------------------------------

export interface ScenarioStep {
  /** Tool the scripted model calls: "bash", "read", "write" or "edit". */
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** Short label for logs and assertions. */
  readonly label: string;
}

export interface Scenario {
  readonly name: string;
  readonly steps: readonly ScenarioStep[];
  readonly finalAnswer: string;
  /** Files the workspace starts with. */
  readonly seed: Readonly<Record<string, string>>;
}

export interface SessionToolResult {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly isError: boolean;
  readonly text: string;
}

export interface SessionState {
  readonly sessionId: string;
  readonly submission?: { readonly id: string; readonly status: string; readonly reason?: string };
  readonly toolResults: readonly SessionToolResult[];
  readonly answer?: string;
  readonly workspace: { readonly id: string; readonly head: WorkspaceVersion };
  readonly execs: readonly { readonly command: string; readonly tier: SandboxTier; readonly timings: PhaseTimings }[];
}

export interface SessionRuntime {
  setup(sessionId: string, scenario: Scenario): Promise<void>;
  prompt(sessionId: string, content: string, requestId: string): Promise<{ readonly submissionId: string }>;
  state(sessionId: string): Promise<SessionState>;
  /** Kills the session owner, as a crash would. The next request reopens it and resumes. */
  kill(sessionId: string): Promise<void>;
}

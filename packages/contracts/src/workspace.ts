/**
 * Workspace: a versioned file tree per task or session, plus read-only mounts and the seed spec.
 *
 * Paths:
 * - Workspace paths are relative POSIX paths (`notes/x.md`), never starting with `/` and never containing `..`.
 * - Mounts appear at absolute mount points (`/project`, `/skills`). A path under a mount point reads the mount.
 *
 * Settled rule: project files (and skills) are a read-only mount at a pinned version. Nothing writes through a mount.
 * `commit` refuses any change under a mount point, and a sandbox command that writes there fails. Writes to project
 * files go through the source's tools (`MountSource.write`), which carry the acting user and create a new source
 * version; existing mounts keep their pinned version until remounted.
 */
import type { Actor, CallContext, OwnerRef, Page, PageRequest, SessionId, Timestamp, WorkspaceId } from "./common.ts";
import type { SandboxTier } from "./sandbox.ts";

/** A workspace version. Versions increase by one per commit; version 0 is the empty tree. */
export type WorkspaceVersion = number;

export type FileKind = "file" | "directory";

export interface FileEntry {
	readonly path: string;
	readonly kind: FileKind;
	/** Bytes; 0 for directories. */
	readonly size: number;
	/** Hex SHA-256 of the content, for files. */
	readonly digest?: string;
	/** The version that last changed this path. */
	readonly version: WorkspaceVersion | string;
}

export type MountSourceKind = "project-files" | "skills" | (string & {});

/** A read-only view of a source at a pinned version. `readOnly` is always true; there is no writable mount. */
export interface Mount {
	/** Absolute mount point, such as `/project` or `/skills`. */
	readonly path: string;
	readonly source: MountSourceKind;
	/** The source's own reference, such as a project ID. */
	readonly ref: string;
	/** The source version the mount is pinned to. */
	readonly version: string;
	readonly readOnly: true;
}

export interface MountRequest {
	readonly path: string;
	readonly source: MountSourceKind;
	readonly ref: string;
	/** Pin to this version; the source's latest when absent. */
	readonly version?: string;
}

export type SeedSource =
	| {
			readonly kind: "git";
			readonly repo: string;
			/** A branch, tag or commit; resolved to a commit when the session starts. */
			readonly ref: string;
			/** Commits of history; blobs are fetched lazily. */
			readonly history?: number;
			readonly sparse?: readonly string[];
			/** Where in the workspace; the root when absent. */
			readonly into?: string;
	  }
	| { readonly kind: "files"; readonly files: { readonly [path: string]: string } }
	| { readonly kind: "objects"; readonly prefix: string; readonly into?: string };

export interface SeedDependencyStep {
	readonly run: string;
	/** Files and labels whose contents key the cached layer, such as `pnpm-lock.yaml` and `image`. */
	readonly key: readonly string[];
}

/**
 * How a host app or project declares a workspace's starting state. v0 supports `files` and `git` sources; M0-BE2's
 * measurements and M2-BE1 shape the rest.
 */
export interface SeedSpec {
	readonly name: string;
	readonly sources: readonly SeedSource[];
	readonly deps?: readonly SeedDependencyStep[];
	readonly mounts?: readonly MountRequest[];
	readonly tier?: SandboxTier;
	readonly size?: string;
}

/** Seeds report readiness in stages, so an agent can read before dependencies exist. */
export type SeedReadiness = "pending" | "metadata" | "files" | "dependencies" | "failed";

export interface WorkspaceRecord {
	readonly id: WorkspaceId;
	readonly owner: OwnerRef;
	readonly sessionId?: SessionId;
	readonly head: WorkspaceVersion;
	readonly mounts: readonly Mount[];
	readonly seed?: SeedSpec;
	readonly seedReadiness: SeedReadiness;
	readonly createdAt: Timestamp;
	readonly updatedAt: Timestamp;
}

export type WorkspaceChange =
	| { readonly op: "put"; readonly path: string; readonly content: Uint8Array | string }
	| { readonly op: "delete"; readonly path: string };

export interface CommitRequest {
	/** The version the writer read. A commit on any other head rejects with `conflict`. */
	readonly baseVersion: WorkspaceVersion;
	readonly changes: readonly WorkspaceChange[];
	/** The session (and sandbox lease) writing; one writer per session. */
	readonly writer?: { readonly sessionId?: SessionId; readonly leaseId?: string };
	readonly message?: string;
}

export interface CommitResult {
	readonly version: WorkspaceVersion;
	readonly changed: readonly string[];
}

export interface FileContent {
	readonly path: string;
	readonly content: Uint8Array;
	readonly version: WorkspaceVersion | string;
	readonly digest: string;
}

export interface ListOptions extends PageRequest {
	/** A directory; the root when absent. A mount point lists the mount. */
	readonly path?: string;
	readonly version?: WorkspaceVersion;
	/** Include everything below `path`, not only direct children. */
	readonly recursive?: boolean;
}

export interface WorkspaceVersionInfo {
	readonly version: WorkspaceVersion;
	readonly at: Timestamp;
	readonly actor: Actor;
	readonly changed: readonly string[];
	readonly message?: string;
}

export interface Workspaces {
	/** Creates a workspace at version 0, applies `seed` files (as version 1 when it has any) and pins `mounts`. */
	create(
		ctx: CallContext,
		input: {
			readonly owner: OwnerRef;
			readonly sessionId?: SessionId;
			readonly seed?: SeedSpec;
			readonly mounts?: readonly MountRequest[];
		},
	): Promise<WorkspaceRecord>;
	get(ctx: CallContext, id: WorkspaceId): Promise<WorkspaceRecord>;

	/** Lists entries without reading file bodies. */
	list(ctx: CallContext, id: WorkspaceId, options?: ListOptions): Promise<Page<FileEntry>>;
	stat(
		ctx: CallContext,
		id: WorkspaceId,
		path: string,
		options?: { readonly version?: WorkspaceVersion },
	): Promise<FileEntry>;
	/** Reads one file at `version` (head when absent), or from a mount for an absolute path. */
	read(
		ctx: CallContext,
		id: WorkspaceId,
		path: string,
		options?: { readonly version?: WorkspaceVersion },
	): Promise<FileContent>;

	/**
	 * Applies changes atomically as one new version. Rejects with `conflict` when `baseVersion` is not the head, with
	 * `refused` for any path under a mount point (and audits `workspace.write.refused`), and with `invalid` for a path
	 * that is not a normalised relative path.
	 */
	commit(ctx: CallContext, id: WorkspaceId, request: CommitRequest): Promise<CommitResult>;

	history(ctx: CallContext, id: WorkspaceId, page?: PageRequest): Promise<Page<WorkspaceVersionInfo>>;

	/** Re-pins a mount to a newer source version (or the latest). */
	remount(ctx: CallContext, id: WorkspaceId, mount: MountRequest): Promise<WorkspaceRecord>;

	/** Files under `prefixes` (such as `notes/`) at head, for handing back to the host. */
	export(ctx: CallContext, id: WorkspaceId, prefixes: readonly string[]): Promise<readonly FileContent[]>;
}

/**
 * A source that can be mounted read-only, such as a project's files or the skills a session may see. Writes go
 * through `write`, as a tool call does, carrying the acting user; they create a new source version.
 */
export interface MountSource {
	readonly kind: MountSourceKind;
	latestVersion(ctx: CallContext, ref: string): Promise<string>;
	list(ctx: CallContext, ref: string, version: string, path: string): Promise<readonly FileEntry[]>;
	read(ctx: CallContext, ref: string, version: string, path: string): Promise<Uint8Array>;
	/** Optional: sources such as skills are written through their own APIs instead. */
	write?(
		ctx: CallContext,
		ref: string,
		changes: readonly WorkspaceChange[],
	): Promise<{ readonly version: string; readonly actor: Actor }>;
}

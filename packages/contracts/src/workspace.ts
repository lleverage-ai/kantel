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

/*
 * Seeding. The shape follows M0-BE2's measurements (docs/measurements/m0-be2-seeding/results.md, issue #5):
 *  1. Where the bytes come from is a host decision. The same spec seeds from a node-local mirror on a self-hosted
 *     node and from a snapshot on Cloudflare, so the spec names what (repo, commit, cone, dependency key), the host
 *     picks how (`SeedMethod`) and reports which it used (`SeedReport`).
 *  2. A prepared snapshot keyed by (repo commit, lockfile hash, image) is the fastest route to a large repo with its
 *     dependencies, but it can be cold, so the spec carries a stable cache key derivation and a `prepare` policy,
 *     and the host never blocks a session on a snapshot.
 *  3. Readiness is staged: source is ready seconds before dependencies on every host. `files` means `git status`
 *     works in the cone.
 *  4. `git status` is fast only when the restored tree matches the index's stat data. A tree restored from bytes
 *     needs one index refresh, which `ResolvedSeedSource.indexState` records.
 */

/** A git source, with the commit pinned before the seed starts (cache keys need it). */
export interface GitSeedSource {
	readonly kind: "git";
	/** `owner/name` on the host's git provider, or a full URL. Credentials come from the vault, never the spec. */
	readonly repo: string;
	/** A branch, tag or commit; resolved to `commit` when the session starts. */
	readonly ref: string;
	/** Filled in by the host when it resolves `ref`; a spec may also pin it. */
	readonly commit?: string;
	/** Commits of history to make available; blobs outside the cone are fetched lazily. Default 50. */
	readonly history?: number;
	/** Cone-mode sparse checkout directories. Absent means the whole tree. */
	readonly sparse?: readonly string[];
	/** Where in the workspace; the root when absent. */
	readonly into?: string;
}

export type SeedSource =
	| GitSeedSource
	| { readonly kind: "files"; readonly files: { readonly [path: string]: string } }
	| { readonly kind: "objects"; readonly prefix: string; readonly into?: string };

export interface SeedDependencyStep {
	/** The install command, run in the workspace root when no cached layer matches. */
	readonly run: string;
	/**
	 * Files and labels whose contents key the cached layer, such as `pnpm-lock.yaml` and `image:<digest>`.
	 * The host hashes them (sha256 over path + contents, in order) into `SeedReport.depsKey`.
	 */
	readonly key: readonly string[];
	/** Paths the step produces, restored as one layer. Default: every `node_modules` under the root. */
	readonly outputs?: readonly string[];
}

/**
 * How the host may seed. The spec can restrict the set; the host chooses within it and reports its choice.
 * Measured costs per method are in docs/measurements/m0-be2-seeding/results.md.
 */
export type SeedMethod =
	/** A prepared container or VM snapshot with source, index and dependencies already in place. */
	| "snapshot"
	/** `git worktree add` or `clone --shared/--reference` against a node-local bare mirror. */
	| "mirror"
	/** A read-only lower layer (directory or SquashFS) under a writable overlay. Self-hosted only. */
	| "overlay"
	/** Copy a directory archive from object storage (tar+zstd, DirectoryBackup). */
	| "archive"
	/** Network clone from the git provider (shallow, blobless, sparse). The fallback that always works. */
	| "clone"
	/** isomorphic-git over a lazily read file tree, for the isolate tier. Source only, no dependencies. */
	| "lazy";

/** How a host app or project declares a workspace's starting state: what to seed, not how. */
export interface SeedSpec {
	readonly name: string;
	readonly sources: readonly SeedSource[];
	readonly deps?: readonly SeedDependencyStep[];
	readonly mounts?: readonly MountRequest[];
	readonly tier?: SandboxTier;
	readonly size?: string;
	/** Methods the host may use, in the spec author's preference order. Absent: any, host's order. */
	readonly methods?: readonly SeedMethod[];
	/**
	 * When the host should build a reusable snapshot for this spec:
	 *  - `on-change` (default): after the first seed at a new cache key, in the background;
	 *  - `never`: always seed from scratch (one-off repos);
	 *  - `eager`: as soon as the spec or its default branch changes, before anyone asks.
	 */
	readonly prepare?: "on-change" | "never" | "eager";
	/** Use a snapshot for an older commit of the same branch and fetch forward, if within this many commits. */
	readonly staleWithin?: number;
}

/**
 * Seeds report readiness in stages, so an agent can read before dependencies exist. `files` means `git status` works
 * for the cone; `dependencies` means `deps` are restored.
 */
export type SeedReadiness = "pending" | "metadata" | "files" | "dependencies" | "failed";

/** One source as the host resolved it, in spec order. */
export type ResolvedSeedSource =
	| {
			readonly kind: "git";
			readonly repo: string;
			readonly commit: string;
			readonly sparse?: readonly string[];
			readonly into: string;
			/**
			 * `fresh`: the tree came from git checkout or a snapshot with a settled index; status is fast.
			 * `refreshed`: the tree came from bytes and the host ran `git update-index --refresh` once.
			 */
			readonly indexState: "fresh" | "refreshed";
	  }
	/** sha256 over the sorted (path, contents) pairs. */
	| { readonly kind: "files"; readonly digest: string }
	/** The object prefix and the version or ETag set that was read. */
	| { readonly kind: "objects"; readonly prefix: string; readonly version: string; readonly into: string };

/** What the host did, recorded on the workspace and in the audit log, and the input to the next seed's choice. */
export interface SeedReport {
	readonly method: SeedMethod;
	/**
	 * sha256 over the canonical JSON of (sources, depsKey, mounts, image digest), with `sources` the
	 * ResolvedSeedSource list without `indexState`. Equal keys mean a prepared snapshot can be reused.
	 */
	readonly cacheKey: string;
	readonly sources: readonly ResolvedSeedSource[];
	readonly depsKey?: string;
	/** Whether a snapshot was used, and if so how many commits it had to fetch forward per git source. */
	readonly snapshot?: { readonly id: string; readonly fetchedForward: readonly number[] };
	/** Milliseconds from seed start to each readiness stage. */
	readonly timings: { readonly [stage in Exclude<SeedReadiness, "pending" | "failed">]?: number };
}

export interface WorkspaceRecord {
	readonly id: WorkspaceId;
	readonly owner: OwnerRef;
	readonly sessionId?: SessionId;
	readonly head: WorkspaceVersion;
	readonly mounts: readonly Mount[];
	readonly seed?: SeedSpec;
	readonly seedReadiness: SeedReadiness;
	/** How the host seeded, once it has resolved the sources; absent before then and for a workspace with no seed. */
	readonly seedReport?: SeedReport;
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

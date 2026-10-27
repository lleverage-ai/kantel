/**
 * M0-BE2 proposal for the SeedSpec contract. Not imported anywhere: M0-BE1 (#2) owns packages/contracts and
 * decides what to adopt. This is written as a delta on packages/contracts/src/workspace.ts at PR #39
 * (583b3296d01f6708ae29ed0fdd5e30c292e548f3); everything not mentioned stays as it is there.
 *
 * What the measurements in results.md say the contract has to express:
 *  1. Where the bytes come from is a host decision, not a spec decision. The same spec must seed from a
 *     node-local mirror on a self-hosted node and from a snapshot on Cloudflare. So the spec names *what*
 *     (repo, commit, cone, dependency key) and the host picks *how* (SeedMethod), and reports which it used.
 *  2. A prepared snapshot keyed by (repo commit, lockfile hash, image) is the only route under ~2 s for the
 *     large repo on Cloudflare; everything else pays a multi-second restore. So the spec carries a stable
 *     `cacheKey` derivation and an explicit `prepare` policy.
 *  3. Readiness is staged. Source is ready seconds before dependencies on every host, so agents can read and
 *     run git while `deps` restores. #39's stages are enough if `files` is defined as "git status works in
 *     the cone"; no new stage is needed.
 *  4. Git status speed depends on the restored tree matching the index's stat data. A seed that copies files
 *     (tar, DirectoryBackup, SquashFS without a settled index) must refresh the index once, so the host needs
 *     to know whether the tree came from git (fast) or from bytes (needs refresh). That is SeedReport.indexState.
 */

import type { MountRequest, SandboxTier } from "@harbour/contracts";

/** The git source, as in #39, with the commit pinned before the seed starts (cache keys need it). */
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

/** Stages as in #39. `files` means "git status works for the cone"; `dependencies` means `deps` are restored. */
export type SeedReadiness = "pending" | "metadata" | "files" | "dependencies" | "failed";

/** What the host did, recorded on the workspace and in the audit log, and the input to the next seed's choice. */
export interface SeedReport {
	readonly method: SeedMethod;
	/** sha256 of (commit, cone, depsKey, image digest). Equal keys mean a snapshot can be reused. */
	readonly cacheKey: string;
	readonly commit: string;
	readonly depsKey?: string;
	/** Whether a snapshot was used, and if so how many commits it had to fetch forward. */
	readonly snapshot?: { readonly id: string; readonly fetchedForward: number };
	/**
	 * `fresh`: the tree came from git checkout or a snapshot with a settled index; status is fast.
	 * `refreshed`: the tree came from bytes and the host ran `git update-index --refresh` once.
	 */
	readonly indexState: "fresh" | "refreshed";
	/** Milliseconds from seed start to each readiness stage. */
	readonly timings: { readonly [stage in Exclude<SeedReadiness, "pending" | "failed">]?: number };
}

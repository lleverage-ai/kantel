/**
 * Seed spec v0: static files and git refs, resolved at create. Where a git tree's bytes come from is the host's
 * choice, made by the `GitFetcher` it configures (a GitHub tarball through the vault's egress here, `git` itself in the
 * self-hosted target); without one, a git source is recorded at `metadata` readiness and not fetched, as before.
 *
 * v0 imports the tree at the resolved commit as workspace files, without `.git`: the report says `refreshed`, because
 * a tier that needs git status initialises the repository over the files and refreshes the index once. History,
 * dependency steps, snapshots and `objects` sources are M2-BE1's.
 */
import {
	type CallContext,
	type Clock,
	type GitSeedSource,
	HarbourError,
	type ResolvedSeedSource,
	type SeedReadiness,
	type SeedReport,
	type SeedSpec,
} from "@harbour/contracts";
import { normalizeWorkspacePath, sha256Hex, toBytes } from "./index.ts";
import { treeShapeConflict } from "./tree.ts";

/** One file of a fetched tree, its path relative to the repository root. */
export interface SeedFile {
	readonly path: string;
	readonly content: Uint8Array;
	/** Unix mode bits, such as 0o755 for an executable. */
	readonly mode?: number;
}

/** A git tree at one commit. */
export interface GitTree {
	/** The full commit ID `ref` resolved to. */
	readonly commit: string;
	readonly files: AsyncIterable<SeedFile> | Iterable<SeedFile>;
}

/** Fetches the tree a git source names. The caller's context is passed for audit and egress policy. */
export interface GitFetcher {
	fetch(ctx: CallContext, source: GitSeedSource): Promise<GitTree>;
}

export interface Seeders {
	readonly git?: GitFetcher;
}

/** A seed as create applies it. */
export interface ResolvedSeed {
	/** Workspace path to content and mode, later sources winning. */
	readonly files: ReadonlyMap<string, { readonly content: string | Uint8Array; readonly mode?: number }>;
	readonly readiness: SeedReadiness;
	/** Present when every source resolved and at least one was a git source. */
	readonly report?: SeedReport;
}

/** Fetches and merges the seed's sources, in order. A source that cannot be resolved leaves the seed at `metadata`. */
export async function resolveSeed(
	ctx: CallContext,
	seed: SeedSpec | undefined,
	seeders: Seeders,
	clock: Clock,
): Promise<ResolvedSeed> {
	const files = new Map<string, { content: string | Uint8Array; mode?: number }>();
	if (seed === undefined) return { files, readiness: "files" };
	const started = clock.now();
	const resolved: ResolvedSeedSource[] = [];
	let pending = false;
	let fetchedGit = false;
	for (const source of seed.sources) {
		switch (source.kind) {
			case "files": {
				const entries = Object.entries(source.files).map(([path, content]) => [normalizeWorkspacePath(path), content]);
				for (const [path, content] of entries) files.set(path!, { content: content! });
				resolved.push({ kind: "files", digest: await filesDigest(entries as [string, string][]) });
				break;
			}
			case "git": {
				if (seeders.git === undefined) {
					pending = true;
					break;
				}
				const into = source.into === undefined || source.into === "" ? "" : normalizeWorkspacePath(source.into);
				const sparse = source.sparse?.map((dir) => normalizeWorkspacePath(dir.replace(/\/+$/, "")));
				const tree = await seeders.git.fetch(ctx, source);
				if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(tree.commit)) {
					throw new HarbourError("unavailable", `the git fetcher returned a bad commit for ${source.repo}`);
				}
				for await (const file of tree.files) {
					const path = normalizeWorkspacePath(file.path);
					if (sparse !== undefined && !sparse.some((dir) => path === dir || path.startsWith(`${dir}/`))) continue;
					files.set(into === "" ? path : `${into}/${path}`, {
						content: file.content,
						...(file.mode === undefined ? {} : { mode: file.mode }),
					});
				}
				resolved.push({
					kind: "git",
					repo: source.repo,
					commit: tree.commit,
					...(sparse === undefined ? {} : { sparse }),
					into,
					indexState: "refreshed",
				});
				fetchedGit = true;
				break;
			}
			default:
				// `objects` sources are not fetched in v0.
				pending = true;
		}
	}
	const shape = treeShapeConflict(files.keys());
	if (shape !== undefined) throw new HarbourError("invalid", shape);
	if (pending) return { files, readiness: "metadata" };
	if (!fetchedGit) return { files, readiness: "files" };
	const report: SeedReport = {
		method: "clone",
		cacheKey: await cacheKey(resolved, seed),
		sources: resolved,
		timings: { files: clock.now() - started },
	};
	return { files, readiness: "files", report };
}

/** sha256 over the sorted (path, contents) pairs, as `ResolvedSeedSource` documents. */
async function filesDigest(entries: readonly [string, string][]): Promise<string> {
	const sorted = [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return sha256Hex(toBytes(JSON.stringify(sorted)));
}

/** sha256 over the canonical JSON of (sources without indexState, depsKey, mounts, image digest). */
async function cacheKey(resolved: readonly ResolvedSeedSource[], seed: SeedSpec): Promise<string> {
	const sources = resolved.map((source) => {
		if (source.kind !== "git") return source;
		const { indexState: _indexState, ...rest } = source;
		return rest;
	});
	return sha256Hex(toBytes(canonical({ sources, depsKey: null, mounts: seed.mounts ?? [], image: null })));
}

/** JSON with object keys sorted, so equal values hash equally. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * Seed spec v1's resolver: static files, git refs, archives and object prefixes, resolved at create, with dependency
 * steps keyed by their lockfiles and seed status events for each readiness stage.
 *
 * Where a source's bytes come from is the host's choice, made by the `Seeders` it configures: a git tree from a GitHub
 * tarball through the vault's egress (`./git-tarball.ts`) or off a warm mirror (`@kantel/mirror`), an archive over
 * `fetch` (`./archive.ts`). A source without a seeder is recorded at `metadata` readiness and not fetched.
 *
 * The tree arrives as workspace files, without `.git` unless the fetcher adds one (the tarball fetcher's `history`: a
 * shallow, blobless clone's): the report says `refreshed`, because a tier that needs git status initialises the
 * repository over the files, or hashes them against the seeded index, once. Dependency steps are keyed here (equal keys
 * share a layer, so a changed lockfile changes only its step's key); running them, or restoring their layer, is the
 * sandbox tier's, which reports `dependencies` readiness.
 */
import {
	type CallContext,
	type Clock,
	type DependencyStageUpdate,
	type GitSeedSource,
	KantelError,
	isKantelError,
	type Mount,
	type OrganisationId,
	type ResolvedSeedSource,
	type SandboxTier,
	type SeedDependencyReport,
	type SeedDependencyStep,
	type Seeders,
	type SeedFile,
	type SeedMethod,
	type SeedReadiness,
	type SeedReport,
	type SeedSpec,
	type SeedStatusEvent,
	type SeedStatusSink,
	type SessionId,
	type WorkspaceId,
	type WorkspaceRecord,
} from "@kantel/contracts";
import { unpackArchive } from "./archive.ts";
import { normalizeWorkspacePath, sha256Hex, toBytes } from "./index.ts";
import { treeShapeConflict } from "./tree.ts";

export type { ArchiveFetcher, GitFetcher, GitTree, ObjectsSeeder, Seeders, SeedFile } from "@kantel/contracts";

/** A seed as create applies it. */
export interface ResolvedSeed {
	/** Workspace path to content and mode, later sources winning. */
	readonly files: ReadonlyMap<string, { readonly content: string | Uint8Array; readonly mode?: number }>;
	readonly readiness: SeedReadiness;
	/** Present when every source resolved and the seed fetched something or has dependency steps. */
	readonly report?: SeedReport;
}

/** Who the seed is for, so its status events name the workspace; and where they go. */
export interface SeedProgress {
	readonly workspaceId: WorkspaceId;
	readonly organisationId: OrganisationId;
	readonly sessionId?: SessionId;
	readonly onStatus?: SeedStatusSink;
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** Bare-word dependency key entries a host may define through `Seeders.labels`. */
const LABEL = /^[a-z][a-z0-9-]*:/;

/**
 * Fetches and merges the seed's sources, in order, and keys its dependency steps. A source that cannot be resolved
 * leaves the seed at `metadata`. `mounts` are the workspace's pinned mounts, which the cache key includes. With
 * `progress`, emits a `seed.status` event as each stage is reached (`metadata`, `files`), or `failed` before rejecting.
 */
export async function resolveSeed(
	ctx: CallContext,
	seed: SeedSpec | undefined,
	seeders: Seeders,
	clock: Clock,
	mounts: readonly Mount[] = [],
	progress?: SeedProgress,
): Promise<ResolvedSeed> {
	const files = new Map<string, { content: string | Uint8Array; mode?: number }>();
	if (seed === undefined) return { files, readiness: "files" };
	const started = clock.now();
	const emit = statusEmitter(progress, clock, started);
	const timings: { metadata?: number; files?: number } = {};
	let method: SeedMethod | undefined;
	const metadata = (sources: readonly ResolvedSeedSource[]) => {
		if (timings.metadata !== undefined) return;
		timings.metadata = clock.now() - started;
		emit("metadata", { ...(method === undefined ? {} : { method }), sources });
	};
	try {
		method = chooseMethod(seed, seeders);
		// Pin every git ref first when the fetcher can, so `metadata` is reported before the bytes arrive.
		const commits = new Map<number, string>();
		const resolveRef = seeders.git?.resolve?.bind(seeders.git);
		if (resolveRef !== undefined && seed.sources.some((source) => source.kind === "git")) {
			for (const [index, source] of seed.sources.entries()) {
				if (source.kind !== "git") continue;
				commits.set(index, checkCommit(source.commit ?? (await resolveRef(ctx, source)), source));
			}
			metadata(pinned(seed, commits));
		}

		const resolved: ResolvedSeedSource[] = [];
		let pending = false;
		let fetched = false;
		for (const [index, source] of seed.sources.entries()) {
			switch (source.kind) {
				case "files": {
					const entries = Object.entries(source.files).map(
						([path, content]) => [normalizeWorkspacePath(path), content] as [string, string],
					);
					for (const [path, content] of entries) files.set(path, { content });
					resolved.push({ kind: "files", digest: await filesDigest(entries) });
					break;
				}
				case "git": {
					if (seeders.git === undefined) {
						pending = true;
						break;
					}
					const into = intoPath(source.into);
					const sparse = source.sparse?.map((dir) => normalizeWorkspacePath(dir.replace(/\/+$/, "")));
					const commit = commits.get(index);
					const tree = await seeders.git.fetch(ctx, commit === undefined ? source : { ...source, commit });
					checkCommit(tree.commit, source);
					if (commit !== undefined && tree.commit !== commit) {
						throw new KantelError("unavailable", `the git fetcher returned another commit for ${source.repo}`);
					}
					for await (const file of tree.files) {
						const path = normalizeWorkspacePath(file.path);
						if (sparse !== undefined && !sparse.some((dir) => path === dir || path.startsWith(`${dir}/`))) continue;
						put(files, into, path, file);
					}
					resolved.push({
						kind: "git",
						repo: source.repo,
						commit: tree.commit,
						...(sparse === undefined ? {} : { sparse }),
						into,
						indexState: "refreshed",
					});
					fetched = true;
					break;
				}
				case "archive": {
					if (seeders.archive === undefined) {
						pending = true;
						break;
					}
					const into = intoPath(source.into);
					const bytes = await seeders.archive.fetch(ctx, source);
					const digest = await sha256Hex(bytes);
					if (source.digest !== undefined && digest !== source.digest) {
						throw new KantelError("unavailable", `the archive at ${source.url} does not match its digest`, {
							expected: source.digest,
							actual: digest,
						});
					}
					for (const file of await unpackArchive(bytes, source))
						put(files, into, normalizeWorkspacePath(file.path), file);
					resolved.push({ kind: "archive", url: source.url, digest, into });
					fetched = true;
					break;
				}
				case "objects": {
					if (seeders.objects === undefined) {
						pending = true;
						break;
					}
					const into = intoPath(source.into);
					const read = await seeders.objects.read(ctx, source);
					for await (const file of read.files) put(files, into, normalizeWorkspacePath(file.path), file);
					resolved.push({ kind: "objects", prefix: source.prefix, version: read.version, into });
					fetched = true;
					break;
				}
			}
		}
		const shape = treeShapeConflict(files.keys());
		if (shape !== undefined) throw new KantelError("invalid", shape);
		if (pending) {
			metadata(resolved);
			return { files, readiness: "metadata" };
		}
		metadata(resolved);
		const deps = seed.deps === undefined ? undefined : await keyDependencies(seed.deps, files, seeders.labels ?? {});
		if (!fetched && deps === undefined) {
			emit("files", { sources: resolved });
			return { files, readiness: "files" };
		}
		const depsKey = deps === undefined ? undefined : await sha256Hex(toBytes(canonical(deps.map((step) => step.key))));
		timings.files = clock.now() - started;
		const report: SeedReport = {
			method: method ?? "clone",
			cacheKey: await cacheKey(resolved, mounts, depsKey, seeders.labels?.image),
			sources: resolved,
			...(depsKey === undefined ? {} : { depsKey }),
			...(deps === undefined ? {} : { deps }),
			timings,
		};
		emit("files", {
			method: report.method,
			sources: resolved,
			...(depsKey === undefined ? {} : { depsKey }),
			...(deps === undefined ? {} : { deps }),
		});
		return { files, readiness: "files", report };
	} catch (error) {
		emit("failed", {
			...(method === undefined ? {} : { method }),
			error: isKantelError(error)
				? { code: error.code, message: error.message }
				: { code: "unavailable", message: "the seed failed" },
		});
		throw error;
	}
}

/**
 * The method the seed will use: the git fetcher's (`clone` by default) when there is a git source, else `archive`.
 * A spec that restricts `methods` to ones this host cannot use is `not_supported`, before anything is fetched.
 */
function chooseMethod(seed: SeedSpec, seeders: Seeders): SeedMethod | undefined {
	const kinds = new Set(seed.sources.map((source) => source.kind));
	const method: SeedMethod | undefined = kinds.has("git")
		? (seeders.git?.method ?? "clone")
		: kinds.has("archive") || kinds.has("objects")
			? "archive"
			: undefined;
	if (method !== undefined && seed.methods !== undefined && !seed.methods.includes(method)) {
		throw new KantelError(
			"not_supported",
			`this host seeds ${seed.name} by ${method}, which the spec does not allow (${seed.methods.join(", ")})`,
			{ method, allowed: [...seed.methods] },
		);
	}
	return method;
}

function checkCommit(commit: string, source: GitSeedSource): string {
	if (typeof commit !== "string" || !COMMIT.test(commit)) {
		throw new KantelError("unavailable", `the git fetcher returned a bad commit for ${source.repo}`);
	}
	return commit;
}

/** The git sources pinned so far, for the `metadata` event. */
function pinned(seed: SeedSpec, commits: ReadonlyMap<number, string>): ResolvedSeedSource[] {
	const out: ResolvedSeedSource[] = [];
	for (const [index, source] of seed.sources.entries()) {
		const commit = commits.get(index);
		if (source.kind !== "git" || commit === undefined) continue;
		const sparse = source.sparse?.map((dir) => normalizeWorkspacePath(dir.replace(/\/+$/, "")));
		out.push({
			kind: "git",
			repo: source.repo,
			commit,
			...(sparse === undefined ? {} : { sparse }),
			into: intoPath(source.into),
			indexState: "refreshed",
		});
	}
	return out;
}

function intoPath(into: string | undefined): string {
	return into === undefined || into === "" ? "" : normalizeWorkspacePath(into.replace(/\/+$/, ""));
}

function put(
	files: Map<string, { content: string | Uint8Array; mode?: number }>,
	into: string,
	path: string,
	file: SeedFile,
): void {
	files.set(into === "" ? path : `${into}/${path}`, {
		content: file.content,
		...(file.mode === undefined ? {} : { mode: file.mode }),
	});
}

/**
 * Each step's key: sha256 over the canonical JSON of its command, outputs, tier and key entries, where a path entry
 * carries the sha256 of the seeded file's contents (null when absent) and a label is hashed as written (a bare word
 * the host defines as its value). Files are read from the seeded tree, so the key is known as soon as files are.
 */
export async function keyDependencies(
	steps: readonly SeedDependencyStep[],
	files: ReadonlyMap<string, { readonly content: string | Uint8Array }>,
	labels: { readonly [label: string]: string } = {},
): Promise<SeedDependencyReport[]> {
	const out: SeedDependencyReport[] = [];
	for (const [index, step] of steps.entries()) {
		const entries: unknown[] = [];
		for (const entry of step.key) {
			if (LABEL.test(entry)) entries.push({ label: entry });
			else if (Object.hasOwn(labels, entry)) entries.push({ label: `${entry}:${labels[entry]}` });
			else {
				const path = normalizeWorkspacePath(entry);
				const file = files.get(path);
				entries.push({ path, digest: file === undefined ? null : await sha256Hex(toBytes(file.content)) });
			}
		}
		const tier: SandboxTier = step.tier ?? "container";
		const key = await sha256Hex(
			toBytes(canonical({ run: step.run, outputs: step.outputs ?? null, tier, key: entries })),
		);
		out.push({ name: step.name ?? String(index), key, tier });
	}
	return out;
}

function statusEmitter(progress: SeedProgress | undefined, clock: Clock, started: number) {
	return (
		readiness: SeedReadiness,
		fields: Omit<
			SeedStatusEvent,
			"type" | "workspaceId" | "organisationId" | "sessionId" | "readiness" | "at" | "elapsedMs"
		>,
	): void => {
		const sink = progress?.onStatus;
		if (progress === undefined || sink === undefined) return;
		const at = clock.now();
		const event: SeedStatusEvent = {
			type: "seed.status",
			workspaceId: progress.workspaceId,
			organisationId: progress.organisationId,
			...(progress.sessionId === undefined ? {} : { sessionId: progress.sessionId }),
			readiness,
			at,
			elapsedMs: at - started,
			...fields,
		};
		sendSeedStatus(sink, event);
	};
}

/**
 * A workspace record moved on by its seed's dependency stage, for `Workspaces.recordDependencies`. Checks that the
 * workspace is at `files` and that the update names the seed's steps, with their keys, in order. The status event
 * goes to `onStatus` once the caller has stored the record.
 */
export function dependencyStage(
	record: WorkspaceRecord,
	organisationId: OrganisationId,
	update: DependencyStageUpdate,
	now: number,
): { readonly record: WorkspaceRecord; readonly event: SeedStatusEvent } {
	const report = record.seedReport;
	if (record.seedReadiness !== "files" || report?.deps === undefined) {
		throw new KantelError(
			"conflict",
			`workspace ${record.id} is ${record.seedReadiness}, not waiting for its dependency stage`,
			{ readiness: record.seedReadiness },
		);
	}
	const deps = update.deps;
	if (
		!Array.isArray(deps) ||
		deps.length > report.deps.length ||
		(update.error === undefined && deps.length !== report.deps.length) ||
		deps.some((step, index) => step.key !== report.deps?.[index]?.key || step.name !== report.deps?.[index]?.name)
	) {
		throw new KantelError("invalid", "the dependency stage must name the seed's steps, with their keys, in order");
	}
	const readiness: SeedReadiness = update.error === undefined ? "dependencies" : "failed";
	const merged = report.deps.map((step, index) => {
		const layer = deps[index]?.layer;
		return layer === "restored" || layer === "built" ? { ...step, layer } : step;
	});
	const elapsedMs = Math.max(0, now - record.createdAt);
	const seedReport: SeedReport = {
		...report,
		deps: merged,
		timings: readiness === "dependencies" ? { ...report.timings, dependencies: elapsedMs } : report.timings,
	};
	const next: WorkspaceRecord = { ...record, seedReadiness: readiness, seedReport, updatedAt: now };
	const event: SeedStatusEvent = {
		type: "seed.status",
		workspaceId: record.id,
		organisationId,
		...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
		readiness,
		at: now,
		elapsedMs,
		method: report.method,
		sources: report.sources,
		...(report.depsKey === undefined ? {} : { depsKey: report.depsKey }),
		deps: merged,
		...(update.error === undefined
			? {}
			: { error: { code: update.error.code, message: String(update.error.message).slice(0, 500) } }),
	};
	return { record: next, event };
}

/** Sends one event to a sink, which never fails the caller, whether it throws or rejects. */
export function sendSeedStatus(sink: SeedStatusSink | undefined, event: SeedStatusEvent): void {
	if (sink === undefined) return;
	try {
		void Promise.resolve(sink(event)).catch(() => undefined);
	} catch {
		// Ignored, as above.
	}
}

/** sha256 over the sorted (path, contents) pairs, as `ResolvedSeedSource` documents. */
async function filesDigest(entries: readonly [string, string][]): Promise<string> {
	const sorted = [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return sha256Hex(toBytes(JSON.stringify(sorted)));
}

/**
 * sha256 over the canonical JSON of (sources without indexState, depsKey, pinned mounts, image digest). The mounts are
 * the effective ones, sorted by mount point, each with the version it is pinned to. A seed with no dependency steps
 * and no image label keys as it did in v0.
 */
async function cacheKey(
	resolved: readonly ResolvedSeedSource[],
	mounts: readonly Mount[],
	depsKey: string | undefined,
	image: string | undefined,
): Promise<string> {
	const sources = resolved.map((source) => {
		if (source.kind !== "git") return source;
		const { indexState: _indexState, ...rest } = source;
		return rest;
	});
	const pinnedMounts = [...mounts]
		.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
		.map(({ path, source, ref, version }) => ({ path, source, ref, version }));
	return sha256Hex(
		toBytes(canonical({ sources, depsKey: depsKey ?? null, mounts: pinnedMounts, image: image ?? null })),
	);
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

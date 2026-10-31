/**
 * Seeding conformance (seed spec v1, M2-BE1): the cases every workspace implementation that seeds runs, with the
 * fixture seeders they fetch from. A provider wires `deps.seeders` as its workspaces' `seeders` and `deps.onSeedStatus`
 * as their `onSeedStatus`; the cases then check what was seeded, reported and emitted, and what was fetched.
 */
import type {
	ArchiveFetcher,
	CallContext,
	GitFetcher,
	GitSeedSource,
	OwnerRef,
	SeedDependencyReport,
	Seeders,
	SeedFile,
	SeedSpec,
	SeedStatusEvent,
	SeedStatusSink,
	Workspaces,
} from "@kantel/contracts";
import { KantelError } from "@kantel/contracts";
import type { ConformanceAssertions, ConformanceCase, ConformanceDeps } from "./harness.ts";

/** The fixture repository, its two commits and what changes between them: only `pnpm-lock.yaml`. */
export const SEED_FIXTURE = {
	repo: "harbour-fixtures/site",
	commits: {
		main: "1111111111111111111111111111111111111111",
		"lock-bump": "2222222222222222222222222222222222222222",
	},
	archiveUrl: "https://archives.harbour.test/tools.tar.gz",
	labels: { image: "sha256:fixture-image" },
} as const;

const FIXTURE_FILES: Record<string, string> = {
	"README.md": "# site\n",
	"package.json": '{ "name": "site" }\n',
	".nvmrc": "22\n",
	"src/index.ts": "export const site = 1;\n",
	"src/lib/util.ts": "export const util = 2;\n",
	"docs/guide.md": "# guide\n",
	"bin/run": "#!/bin/sh\necho run\n",
};

function treeAt(ref: keyof typeof SEED_FIXTURE.commits): SeedFile[] {
	const lock = ref === "main" ? "lockfileVersion: '9.0'\n# v1\n" : "lockfileVersion: '9.0'\n# v2\n";
	const encoder = new TextEncoder();
	return [...Object.entries(FIXTURE_FILES), ["pnpm-lock.yaml", lock] as const].map(([path, text]) => ({
		path,
		content: encoder.encode(text),
		...(path === "bin/run" ? { mode: 0o755 } : {}),
	}));
}

/** The seeders a seeding provider wires, what they were asked for, and the events its workspaces emitted. */
export interface SeedingFixture {
	readonly seeders: Seeders;
	readonly onSeedStatus: SeedStatusSink;
	/** Every fetch and resolve, as `resolve <repo> <ref>`, `fetch <repo> <commit>` or `archive <url>`. */
	readonly calls: string[];
	readonly events: SeedStatusEvent[];
	/** The fixture archive's bytes (gzip'd tar of `tools/fmt.sh`, `tools/README.md`) and their sha256. */
	archive(): Promise<{ readonly bytes: Uint8Array; readonly digest: string }>;
}

export function createSeedingFixture(): SeedingFixture {
	const calls: string[] = [];
	const events: SeedStatusEvent[] = [];
	let archive: Promise<{ bytes: Uint8Array; digest: string }> | undefined;
	const commitOf = (source: GitSeedSource): string => {
		if (source.repo !== SEED_FIXTURE.repo) {
			throw new KantelError("not_supported", `the fixture has no repository ${source.repo}`);
		}
		const commit =
			source.commit ??
			(Object.hasOwn(SEED_FIXTURE.commits, source.ref)
				? SEED_FIXTURE.commits[source.ref as keyof typeof SEED_FIXTURE.commits]
				: Object.values(SEED_FIXTURE.commits).find((known) => known === source.ref));
		if (commit === undefined) throw new KantelError("not_found", `${source.repo} has no ref ${source.ref}`);
		return commit;
	};
	const git: GitFetcher = {
		method: "clone",
		async resolve(_ctx, source) {
			calls.push(`resolve ${source.repo} ${source.ref}`);
			return commitOf(source);
		},
		async fetch(_ctx, source) {
			const commit = commitOf(source);
			calls.push(`fetch ${source.repo} ${commit}`);
			const ref = (Object.keys(SEED_FIXTURE.commits) as (keyof typeof SEED_FIXTURE.commits)[]).find(
				(name) => SEED_FIXTURE.commits[name] === commit,
			);
			if (ref === undefined) throw new KantelError("not_found", `${source.repo} has no commit ${commit}`);
			return { commit, files: treeAt(ref) };
		},
	};
	const fixture: SeedingFixture = {
		calls,
		events,
		onSeedStatus: (event) => {
			events.push(event);
		},
		archive: () => {
			archive ??= buildArchive();
			return archive;
		},
		seeders: {
			git,
			archive: {
				async fetch(_ctx, source) {
					calls.push(`archive ${source.url}`);
					if (source.url !== SEED_FIXTURE.archiveUrl)
						throw new KantelError("not_found", `no archive at ${source.url}`);
					return (await fixture.archive()).bytes;
				},
			} satisfies ArchiveFetcher,
			labels: SEED_FIXTURE.labels,
		},
	};
	return fixture;
}

async function buildArchive(): Promise<{ bytes: Uint8Array; digest: string }> {
	const tar = tarOf([
		{ name: "tools-1.0/tools/fmt.sh", body: "#!/bin/sh\nexec fmt\n", mode: 0o755 },
		{ name: "tools-1.0/tools/README.md", body: "# tools\n" },
	]);
	const stream = new Blob([tar as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("gzip"));
	const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return { bytes, digest: [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("") };
}

/** A minimal ustar archive of regular files. */
function tarOf(entries: readonly { name: string; body: string; mode?: number }[]): Uint8Array {
	const encoder = new TextEncoder();
	const blocks: Uint8Array[] = [];
	for (const entry of entries) {
		const body = encoder.encode(entry.body);
		const header = new Uint8Array(512);
		const put = (offset: number, text: string) => header.set(encoder.encode(text), offset);
		put(0, entry.name);
		put(100, `${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`);
		put(108, "0000000\0");
		put(116, "0000000\0");
		put(124, `${body.length.toString(8).padStart(11, "0")}\0`);
		put(136, "00000000000\0");
		put(148, "        ");
		put(156, "0");
		put(257, "ustar\0");
		put(263, "00");
		let sum = 0;
		for (const byte of header) sum += byte;
		put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
		blocks.push(header);
		const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
		padded.set(body);
		blocks.push(padded);
	}
	blocks.push(new Uint8Array(1024));
	const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
	let offset = 0;
	for (const block of blocks) {
		out.set(block, offset);
		offset += block.length;
	}
	return out;
}

/** What the seeding cases need from the suite: a subject's workspaces with the fixture wired, and the callers. */
export interface SeedingCaseOptions {
	readonly assertions: ConformanceAssertions;
	readonly withSeeding: (
		run: (workspaces: Workspaces, fixture: SeedingFixture, deps: ConformanceDeps) => Promise<void>,
	) => () => Promise<void>;
	readonly ctx: CallContext;
	/** A caller in another organisation. */
	readonly otherCtx: CallContext;
	readonly owner: OwnerRef;
}

const decoder = new TextDecoder();

export function seedingCases(options: SeedingCaseOptions): ConformanceCase[] {
	const a = options.assertions;
	const { ctx, owner } = options;
	const gitSeed = (ref: string, extra: Partial<SeedSpec> = {}): SeedSpec => ({
		version: 1,
		name: "site",
		sources: [{ kind: "git", repo: SEED_FIXTURE.repo, ref, sparse: ["src/", "bin"], into: "repo" }],
		...extra,
	});
	const deps: SeedSpec["deps"] = [
		{ name: "pnpm", run: "pnpm install --frozen-lockfile", key: ["repo/pnpm-lock.yaml", "repo/.nvmrc", "image"] },
		{ name: "toolchain", run: "mise install", key: ["repo/.nvmrc", "toolchain:node@22"] },
	];
	const fullSeed = (ref: string): SeedSpec => ({
		version: 1,
		name: "site",
		sources: [{ kind: "git", repo: SEED_FIXTURE.repo, ref, into: "repo" }],
		deps,
	});
	return [
		{
			name: "seeding: a git source is pinned to its commit, cut to its cone under into, and seeded as version 1",
			run: options.withSeeding(async (workspaces) => {
				const record = await workspaces.create(ctx, {
					owner,
					seed: {
						...gitSeed("main"),
						sources: [
							...gitSeed("main").sources,
							{ kind: "files", files: { "notes/plan.md": "plan", "repo/src/index.ts": "overridden" } },
						],
					},
				});
				a.strictEqual(record.head, 1);
				a.strictEqual(record.seedReadiness, "files");
				const listed = await workspaces.list(ctx, record.id, { recursive: true });
				a.deepEqual(
					listed.items.filter((item) => item.kind === "file").map((item) => item.path),
					["notes/plan.md", "repo/bin/run", "repo/src/index.ts", "repo/src/lib/util.ts"],
				);
				a.strictEqual(
					decoder.decode((await workspaces.read(ctx, record.id, "repo/src/index.ts")).content),
					"overridden",
				);
				a.partialDeepEqual(record.seedReport, {
					method: "clone",
					sources: [
						{
							kind: "git",
							repo: SEED_FIXTURE.repo,
							commit: SEED_FIXTURE.commits.main,
							sparse: ["src", "bin"],
							into: "repo",
							indexState: "refreshed",
						},
						{ kind: "files" },
					],
				});
				a.ok(/^[0-9a-f]{64}$/.test(record.seedReport?.cacheKey ?? ""), "the cache key is a sha256");
				a.deepEqual(await workspaces.get(ctx, record.id), record);
			}),
		},
		{
			name: "seeding: emits metadata then files for the workspace, the commit pinned at metadata",
			run: options.withSeeding(async (workspaces, fixture, deps) => {
				const record = await workspaces.create(ctx, { owner, seed: fullSeed("main") });
				const events = fixture.events.filter((event) => event.workspaceId === record.id);
				a.deepEqual(
					events.map((event) => event.readiness),
					["metadata", "files"],
				);
				a.partialDeepEqual(events[0], {
					type: "seed.status",
					organisationId: ctx.organisationId,
					method: "clone",
					sources: [{ kind: "git", commit: SEED_FIXTURE.commits.main }],
				});
				a.partialDeepEqual(events[1], {
					depsKey: record.seedReport?.depsKey,
					deps: [{ name: "pnpm" }, { name: "toolchain" }],
				});
				for (const event of events) {
					a.strictEqual(event.at, deps.clock.now());
					a.ok(event.elapsedMs >= 0, "elapsed time is not negative");
				}
				// The git ref was resolved before the tree was read.
				a.deepEqual(fixture.calls, [
					`resolve ${SEED_FIXTURE.repo} main`,
					`fetch ${SEED_FIXTURE.repo} ${SEED_FIXTURE.commits.main}`,
				]);
			}),
		},
		{
			name: "seeding: equal seeds share a cache key, and a moved ref changes it",
			run: options.withSeeding(async (workspaces) => {
				const first = await workspaces.create(ctx, { owner, seed: gitSeed("main") });
				const again = await workspaces.create(ctx, { owner, seed: gitSeed("main") });
				const moved = await workspaces.create(ctx, { owner, seed: gitSeed("lock-bump") });
				a.strictEqual(again.seedReport?.cacheKey, first.seedReport?.cacheKey);
				a.ok(moved.seedReport?.cacheKey !== first.seedReport?.cacheKey, "a moved ref has another cache key");
				a.partialDeepEqual(moved.seedReport?.sources[0], { commit: SEED_FIXTURE.commits["lock-bump"] });
			}),
		},
		{
			name: "seeding: a changed lockfile changes only its dependency step's key, and the steps run in the container tier",
			run: options.withSeeding(async (workspaces) => {
				const before = await workspaces.create(ctx, { owner, seed: fullSeed("main") });
				const after = await workspaces.create(ctx, { owner, seed: fullSeed("lock-bump") });
				const [pnpmBefore, toolsBefore] = before.seedReport?.deps ?? [];
				const [pnpmAfter, toolsAfter] = after.seedReport?.deps ?? [];
				a.partialDeepEqual(pnpmBefore, { name: "pnpm", tier: "container" });
				a.ok(/^[0-9a-f]{64}$/.test(pnpmBefore?.key ?? ""), "a step key is a sha256");
				a.ok(pnpmAfter?.key !== pnpmBefore?.key, "the lockfile's step has a new key");
				a.strictEqual(toolsAfter?.key, toolsBefore?.key, "the other step keeps its key");
				a.ok(after.seedReport?.depsKey !== before.seedReport?.depsKey, "the seed's depsKey moves");
				// Not run yet: the layer is the sandbox tier's to restore or build.
				a.strictEqual(pnpmBefore?.layer, undefined);
				a.strictEqual(before.seedReadiness, "files");
			}),
		},
		{
			name: "seeding: the host's image label keys the dependency layer and the cache",
			run: options.withSeeding(async (workspaces) => {
				const plain = await workspaces.create(ctx, {
					owner,
					seed: { ...fullSeed("main"), deps: [{ run: "pnpm i", key: ["repo/pnpm-lock.yaml", "image"] }] },
				});
				const literal = await workspaces.create(ctx, {
					owner,
					seed: {
						...fullSeed("main"),
						deps: [{ run: "pnpm i", key: ["repo/pnpm-lock.yaml", `image:${SEED_FIXTURE.labels.image}`] }],
					},
				});
				a.strictEqual(plain.seedReport?.deps?.[0]?.key, literal.seedReport?.deps?.[0]?.key);
				a.strictEqual(plain.seedReport?.deps?.[0]?.name, "0");
			}),
		},
		{
			name: "seeding: an archive source is unpacked under into and pinned by its digest",
			run: options.withSeeding(async (workspaces, fixture) => {
				const { digest } = await fixture.archive();
				const record = await workspaces.create(ctx, {
					owner,
					seed: {
						version: 1,
						name: "tools",
						sources: [{ kind: "archive", url: SEED_FIXTURE.archiveUrl, digest, strip: 1, into: "vendor" }],
					},
				});
				a.strictEqual(record.seedReadiness, "files");
				a.strictEqual(
					decoder.decode((await workspaces.read(ctx, record.id, "vendor/tools/fmt.sh")).content),
					"#!/bin/sh\nexec fmt\n",
				);
				a.partialDeepEqual(record.seedReport, {
					method: "archive",
					sources: [{ kind: "archive", url: SEED_FIXTURE.archiveUrl, digest, into: "vendor" }],
				});
			}),
		},
		{
			name: "seeding: an archive that does not match its digest fails the create as unavailable and emits failed",
			run: options.withSeeding(async (workspaces, fixture) => {
				await a.rejectsWithCode(
					workspaces.create(ctx, {
						owner,
						seed: {
							version: 1,
							name: "tools",
							sources: [{ kind: "archive", url: SEED_FIXTURE.archiveUrl, digest: "0".repeat(64) }],
						},
					}),
					"unavailable",
				);
				const last = fixture.events.at(-1);
				a.partialDeepEqual(last, { readiness: "failed", error: { code: "unavailable" } });
			}),
		},
		{
			name: "seeding: a caller refused the create fetches nothing; an unknown ref fails it as not_found",
			run: options.withSeeding(async (workspaces, fixture) => {
				await a.rejectsWithCode(workspaces.create(options.otherCtx, { owner, seed: gitSeed("main") }), "forbidden");
				a.deepEqual(fixture.calls, []);
				a.deepEqual(fixture.events, []);
				await a.rejectsWithCode(workspaces.create(ctx, { owner, seed: gitSeed("gone") }), "not_found");
				a.partialDeepEqual(fixture.events.at(-1), { readiness: "failed", error: { code: "not_found" } });
			}),
		},
		{
			name: "seeding: a spec that allows only methods the host lacks is not_supported, and nothing is fetched",
			run: options.withSeeding(async (workspaces, fixture) => {
				await a.rejectsWithCode(
					workspaces.create(ctx, { owner, seed: gitSeed("main", { methods: ["snapshot", "overlay"] }) }),
					"not_supported",
				);
				a.deepEqual(fixture.calls, []);
			}),
		},
		{
			name: "seeding: the dependency stage moves files to dependencies with each step's layer, once, and a failed stage is failed",
			run: options.withSeeding(async (workspaces, fixture) => {
				const record = await workspaces.create(ctx, { owner, seed: fullSeed("main") });
				const record2 = await workspaces.create(ctx, { owner, seed: fullSeed("main") });
				if (workspaces.recordDependencies === undefined) throw new Error("recordDependencies is required with seeding");
				const keyed = record.seedReport?.deps ?? [];
				// Steps out of order, or with other keys, are not this seed's.
				await a.rejectsWithCode(
					workspaces.recordDependencies(ctx, record.id, { deps: [...keyed].reverse() }),
					"invalid",
				);
				await a.rejectsWithCode(
					workspaces.recordDependencies(options.otherCtx, record.id, { deps: keyed }),
					"not_found",
				);
				const [pnpm, toolchain] = keyed;
				const recorded = await workspaces.recordDependencies(ctx, record.id, {
					deps: [
						{ ...(pnpm as SeedDependencyReport), layer: "built" },
						{ ...(toolchain as SeedDependencyReport), layer: "restored" },
					],
				});
				a.strictEqual(recorded.seedReadiness, "dependencies");
				a.partialDeepEqual(recorded.seedReport?.deps, [{ name: "pnpm", layer: "built" }, { layer: "restored" }]);
				a.ok(recorded.seedReport?.timings.dependencies !== undefined, "the stage is timed");
				a.strictEqual(recorded.head, record.head);
				a.deepEqual(await workspaces.get(ctx, record.id), recorded);
				a.partialDeepEqual(fixture.events.at(-1), {
					workspaceId: record.id,
					readiness: "dependencies",
					depsKey: record.seedReport?.depsKey,
					deps: [{ layer: "built" }, { layer: "restored" }],
				});
				// Once only.
				await a.rejectsWithCode(workspaces.recordDependencies(ctx, record.id, { deps: keyed }), "conflict");

				const failed = await workspaces.recordDependencies(ctx, record2.id, {
					deps: [{ ...(pnpm as SeedDependencyReport), layer: "built" }],
					error: { code: "unavailable", message: "step toolchain exited with 1" },
				});
				a.strictEqual(failed.seedReadiness, "failed");
				a.partialDeepEqual(failed.seedReport?.deps, [{ layer: "built" }, { name: "toolchain" }]);
				a.strictEqual(failed.seedReport?.deps?.[1]?.layer, undefined);
				a.partialDeepEqual(fixture.events.at(-1), {
					workspaceId: record2.id,
					readiness: "failed",
					error: { code: "unavailable", message: "step toolchain exited with 1" },
				});
			}),
		},
		{
			name: "seeding: a source the host has no seeder for waits at metadata",
			run: options.withSeeding(async (workspaces) => {
				const record = await workspaces.create(ctx, {
					owner,
					seed: { version: 1, name: "objects", sources: [{ kind: "objects", prefix: "datasets/2026/" }] },
				});
				a.strictEqual(record.seedReadiness, "metadata");
				a.strictEqual(record.seedReport, undefined);
				a.strictEqual(record.head, 0);
			}),
		},
	];
}

import { type CallContext, isKantelError, type SeedStatusEvent } from "@kantel/contracts";
import { createSeedingFixture, SEED_FIXTURE } from "@kantel/testing/workspace";
import { createHttpArchiveFetcher, unpackArchive } from "@kantel/workspace/archive";
import { keyDependencies, resolveSeed } from "@kantel/workspace/seed";
import { parseSeedSpec } from "@kantel/workspace/seed-spec";
import { describe, expect, it } from "vitest";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const clock = { now: () => 1_000 };

function codeOf(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		return isKantelError(error) ? error.code : `not a KantelError: ${String(error)}`;
	}
	return undefined;
}

describe("parseSeedSpec", () => {
	it("reads a v1 spec file with every source kind, dependency steps and policy", () => {
		const spec = {
			version: 1,
			name: "lleverage-monorepo",
			sources: [
				{ kind: "git", repo: "lleverage-ai/lleverage", ref: "main", history: 50, sparse: ["apps/agent-service"] },
				{ kind: "files", files: { "notes/plan.md": "# Plan" } },
				{ kind: "objects", prefix: "datasets/", into: "data" },
				{ kind: "archive", url: "https://example.test/a.tar.gz", digest: "a".repeat(64), strip: 1, into: "vendor" },
			],
			deps: [{ name: "pnpm", run: "pnpm install --frozen-lockfile", key: ["pnpm-lock.yaml", ".nvmrc", "image"] }],
			mounts: [{ path: "/project", source: "project-files", ref: "proj-1" }],
			tier: "container",
			size: "standard-4",
			methods: ["snapshot", "mirror", "clone"],
			prepare: "on-change",
			staleWithin: 20,
			hydration: "lazy",
		};
		expect(parseSeedSpec(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
	});

	it("reads a v0 spec unchanged", () => {
		const v0 = { name: "notes", sources: [{ kind: "files", files: { "a.md": "a" } }] };
		expect(parseSeedSpec(v0)).toEqual(v0);
	});

	it.each([
		["a non-object", 1],
		["another version", { version: 2, name: "x", sources: [] }],
		["no name", { sources: [] }],
		["an unknown kind", { name: "x", sources: [{ kind: "svn" }] }],
		["a short commit", { name: "x", sources: [{ kind: "git", repo: "a/b", ref: "main", commit: "abc" }] }],
		["a negative history", { name: "x", sources: [{ kind: "git", repo: "a/b", ref: "main", history: -1 }] }],
		["an http archive", { name: "x", sources: [{ kind: "archive", url: "http://example.test/a.tar" }] }],
		["credentials in a URL", { name: "x", sources: [{ kind: "archive", url: "https://u:p@example.test/a.tar" }] }],
		["a bad digest", { name: "x", sources: [{ kind: "archive", url: "https://example.test/a", digest: "x" }] }],
		["a step without a key", { name: "x", sources: [], deps: [{ run: "pnpm i" }] }],
		["a step with an empty key", { name: "x", sources: [], deps: [{ run: "pnpm i", key: [] }] }],
		["an unknown tier", { name: "x", sources: [], deps: [{ run: "x", key: ["a"], tier: "vm" }] }],
		["an unknown method", { name: "x", sources: [], methods: ["rsync"] }],
		["a repeated method", { name: "x", sources: [], methods: ["clone", "clone"] }],
		["an unknown prepare", { name: "x", sources: [], prepare: "always" }],
		["an unknown hydration", { name: "x", sources: [], hydration: "later" }],
	])("rejects %s as invalid", (_name, value) => {
		expect(codeOf(() => parseSeedSpec(value))).toBe("invalid");
	});
});

describe("keyDependencies", () => {
	const files = new Map([
		["pnpm-lock.yaml", { content: "lock v1" }],
		[".nvmrc", { content: "22" }],
	]);

	it("keys a step by its files' contents and labels, in order", async () => {
		const [first] = await keyDependencies([{ run: "pnpm i", key: ["pnpm-lock.yaml", "toolchain:node@22"] }], files);
		const [same] = await keyDependencies([{ run: "pnpm i", key: ["pnpm-lock.yaml", "toolchain:node@22"] }], files);
		const [reordered] = await keyDependencies([{ run: "pnpm i", key: ["toolchain:node@22", "pnpm-lock.yaml"] }], files);
		const [otherCommand] = await keyDependencies(
			[{ run: "npm ci", key: ["pnpm-lock.yaml", "toolchain:node@22"] }],
			files,
		);
		const changed = new Map([...files, ["pnpm-lock.yaml", { content: "lock v2" }]]);
		const [bumped] = await keyDependencies([{ run: "pnpm i", key: ["pnpm-lock.yaml", "toolchain:node@22"] }], changed);
		expect(first).toEqual({ name: "0", key: expect.stringMatching(/^[0-9a-f]{64}$/), tier: "container" });
		expect(same?.key).toBe(first?.key);
		for (const other of [reordered, otherCommand, bumped]) expect(other?.key).not.toBe(first?.key);
	});

	it("hashes a missing file as absent and replaces a bare host label with its value", async () => {
		const [missing] = await keyDependencies([{ run: "x", key: ["yarn.lock"] }], files);
		const [present] = await keyDependencies(
			[{ run: "x", key: ["yarn.lock"] }],
			new Map([["yarn.lock", { content: "" }]]),
		);
		expect(missing?.key).not.toBe(present?.key);
		const [bare] = await keyDependencies([{ run: "x", key: ["image"] }], files, { image: "sha256:1" });
		const [literal] = await keyDependencies([{ run: "x", key: ["image:sha256:1"] }], files);
		const [otherImage] = await keyDependencies([{ run: "x", key: ["image"] }], files, { image: "sha256:2" });
		expect(bare?.key).toBe(literal?.key);
		expect(otherImage?.key).not.toBe(bare?.key);
	});
});

describe("resolveSeed status events", () => {
	it("names the workspace and session, and a sink that throws or rejects never fails the seed", async () => {
		const fixture = createSeedingFixture();
		const seen: SeedStatusEvent[] = [];
		const seed = { name: "s", sources: [{ kind: "git" as const, repo: SEED_FIXTURE.repo, ref: "main" }] };
		const progress = { workspaceId: "ws-1", organisationId: "org-1", sessionId: "sess-1" };
		const resolved = await resolveSeed(ctx, seed, fixture.seeders, clock, [], {
			...progress,
			onStatus: (event) => {
				seen.push(event);
				throw new Error("sink down");
			},
		});
		expect(resolved.readiness).toBe("files");
		expect(seen.map((event) => [event.readiness, event.workspaceId, event.sessionId])).toEqual([
			["metadata", "ws-1", "sess-1"],
			["files", "ws-1", "sess-1"],
		]);
		await expect(
			resolveSeed(ctx, seed, fixture.seeders, clock, [], {
				...progress,
				onStatus: () => Promise.reject(new Error("x")),
			}),
		).resolves.toMatchObject({ readiness: "files" });
	});

	it("reports metadata after the fetch when the git fetcher cannot resolve on its own", async () => {
		const fixture = createSeedingFixture();
		const { resolve: _resolve, ...git } = fixture.seeders.git!;
		const events: SeedStatusEvent[] = [];
		const seed = { name: "s", sources: [{ kind: "git" as const, repo: SEED_FIXTURE.repo, ref: "main" }] };
		const resolved = await resolveSeed(ctx, seed, { git }, clock, [], {
			workspaceId: "ws-1",
			organisationId: "org-1",
			onStatus: (event) => {
				events.push(event);
			},
		});
		expect(events.map((event) => event.readiness)).toEqual(["metadata", "files"]);
		expect(events[0]?.sources).toEqual(resolved.report?.sources);
		expect(resolved.report?.timings).toEqual({ metadata: 0, files: 0 });
	});
});

describe("archives", () => {
	it("unpacks a gzip'd or plain tar, dropping leading segments", async () => {
		const { bytes } = await createSeedingFixture().archive();
		const files = await unpackArchive(bytes, { url: "https://example.test/a.tgz", strip: 1 });
		expect(files.map((file) => [file.path, file.mode])).toEqual([
			["tools/fmt.sh", 0o755],
			["tools/README.md", undefined],
		]);
		const deeper = await unpackArchive(bytes, { url: "https://example.test/a.tgz", strip: 2 });
		expect(deeper.map((file) => file.path)).toEqual(["fmt.sh", "README.md"]);
	});

	it("refuses an archive over its budget and one that is not gzip after its magic", async () => {
		const { bytes } = await createSeedingFixture().archive();
		await expect(unpackArchive(bytes, { url: "u" }, { maxFiles: 1 })).rejects.toMatchObject({ code: "exhausted" });
		await expect(unpackArchive(bytes, { url: "u" }, { maxBytes: 100 })).rejects.toMatchObject({ code: "exhausted" });
		const broken = new Uint8Array([0x1f, 0x8b, 1, 2, 3, 4]);
		await expect(unpackArchive(broken, { url: "u" })).rejects.toMatchObject({ code: "unavailable" });
	});

	it("fetches over the given fetch, and maps 404 and failures to codes", async () => {
		const calls: string[] = [];
		const fetcher = createHttpArchiveFetcher({
			fetch: (async (input: string | URL | Request) => {
				calls.push(String(input));
				if (String(input).endsWith("/missing")) return new Response("", { status: 404 });
				if (String(input).endsWith("/down")) return new Response("", { status: 502 });
				return new Response(new Uint8Array([1, 2, 3]));
			}) as typeof fetch,
			maxBytes: 4,
		});
		expect(await fetcher.fetch(ctx, { kind: "archive", url: "https://example.test/ok" })).toEqual(
			new Uint8Array([1, 2, 3]),
		);
		await expect(fetcher.fetch(ctx, { kind: "archive", url: "https://example.test/missing" })).rejects.toMatchObject({
			code: "not_found",
		});
		await expect(fetcher.fetch(ctx, { kind: "archive", url: "https://example.test/down" })).rejects.toMatchObject({
			code: "unavailable",
		});
		expect(calls).toHaveLength(3);
	});
});

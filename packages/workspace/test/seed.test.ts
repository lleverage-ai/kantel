import { type CallContext, type GitSeedSource, isHarbourError } from "@harbour/contracts";
import { createGitHubTarballFetcher, gitHubRepo, parseTar } from "@harbour/workspace/git-tarball";
import { createMemoryWorkspaces } from "@harbour/workspace/memory";
import { type GitFetcher, resolveSeed } from "@harbour/workspace/seed";
import { createMemoryWorkspaceStore, createStoredWorkspaces } from "@harbour/workspace/stored";
import { describe, expect, it } from "vitest";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const owner = { kind: "organisation", organisationId: "org-1" } as const;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encoder = new TextEncoder();
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";

async function codeOf(operation: Promise<unknown>): Promise<string | undefined> {
	try {
		await operation;
	} catch (error) {
		return isHarbourError(error) ? error.code : `not a HarbourError: ${String(error)}`;
	}
	return undefined;
}

interface TarEntry {
	readonly name: string;
	readonly type?: "0" | "2" | "5" | "x" | "L" | "g";
	readonly mode?: number;
	readonly body?: string;
	readonly prefix?: string;
}

/** A ustar archive, written the way git archive writes GitHub's tarballs. */
function tar(entries: readonly TarEntry[]): Uint8Array {
	const blocks: Uint8Array[] = [];
	for (const entry of entries) {
		const body = encoder.encode(entry.body ?? "");
		const header = new Uint8Array(512);
		const put = (offset: number, text: string) => header.set(encoder.encode(text), offset);
		put(0, entry.name);
		put(100, `${(entry.mode ?? 0o644).toString(8).padStart(7, "0")}\0`);
		put(108, "0000000\0");
		put(116, "0000000\0");
		put(124, `${body.length.toString(8).padStart(11, "0")}\0`);
		put(136, "00000000000\0");
		put(148, "        ");
		put(156, entry.type ?? "0");
		put(257, "ustar\0");
		put(263, "00");
		if (entry.prefix !== undefined) put(345, entry.prefix);
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

/** One pax record; its length counts UTF-8 bytes, digits included. */
function pax(path: string): string {
	const bytes = encoder.encode(` path=${path}\n`).length;
	let length = bytes + 1;
	while (String(length).length + bytes !== length) length = String(length).length + bytes;
	return `${length} path=${path}\n`;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

const top = `tvdavies-site-${COMMIT.slice(0, 7)}`;
const longPath = `docs/${"deep/".repeat(30)}file.md`;
const REPO_TAR = tar([
	{ name: "pax_global_header", type: "g", body: pax("ignored") },
	{ name: `${top}/`, type: "5", mode: 0o755 },
	{ name: `${top}/README.md`, body: "# site\n" },
	{ name: `${top}/bin/run`, mode: 0o775, body: "#!/bin/sh\necho hi\n" },
	{ name: `${top}/src/index.ts`, body: "export const x = 1;\n" },
	{ name: `${top}/src/link`, type: "2" },
	{ name: "PaxHeader", type: "x", body: pax(`${top}/${longPath}`) },
	{ name: `${top}/docs/truncated`, body: "long\n" },
	{ name: "ustar.md", prefix: `${top}/nested`, body: "prefixed\n" },
]);

/**
 * A fake GitHub: `main` resolves to COMMIT, `v2` (and `v3`, annotated) to OTHER over `ls-refs`, an abbreviated
 * `0123456` to COMMIT over the REST API; both commits serve REPO_TAR. Records every URL asked for.
 */
/** An annotated tag object; `ls-refs` with `peel` names the commit it points at. */
const TAG_OBJECT = "fedcba9876543210fedcba9876543210fedcba98";

/** tvdavies/site's refs, as `ls-refs` lists them: `[ref, oid, peeled?]`. */
const SITE_REFS: readonly (readonly [string, string, string?])[] = [
	["HEAD", COMMIT],
	["refs/heads/main", COMMIT],
	["refs/heads/main-old", OTHER],
	["refs/tags/v2", OTHER],
	["refs/tags/v3", TAG_OBJECT, OTHER],
];

const pkt = (text: string) => `${(encoder.encode(text).length + 4).toString(16).padStart(4, "0")}${text}`;

/** What GitHub's upload-pack answers an `ls-refs` request with: the refs under its prefixes, peeled when asked. */
function lsRefsReply(request: string): string {
	const prefixes = [...request.matchAll(/ref-prefix (\S+)\n/g)].map((match) => match[1]!);
	const peel = request.includes("peel\n");
	const lines = SITE_REFS.filter(([ref]) => prefixes.some((prefix) => ref.startsWith(prefix))).map(
		([ref, oid, peeled]) => pkt(`${oid} ${ref}${peel && peeled !== undefined ? ` peeled:${peeled}` : ""}\n`),
	);
	return `${lines.join("")}0000`;
}

function fakeGitHub() {
	const calls: string[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push(url);
		if (url === "https://github.com/tvdavies/site.git/git-upload-pack") {
			return new Response(lsRefsReply(String(init?.body ?? "")));
		}
		const ref = /\/repos\/tvdavies\/site\/commits\/(.+)$/.exec(url)?.[1];
		if (ref !== undefined) {
			const commit = { "0123456": COMMIT }[decodeURIComponent(ref)];
			return commit === undefined ? new Response("{}", { status: 422 }) : new Response(commit);
		}
		if (url === `https://codeload.github.com/tvdavies/site/tar.gz/${COMMIT}` || url.endsWith(OTHER)) {
			return new Response(await gzip(REPO_TAR));
		}
		return new Response("not found", { status: 404 });
	}) as typeof globalThis.fetch;
	return { calls, fetch };
}

describe("parseTar", () => {
	it("yields regular files with pax and ustar-prefix paths and executable bits, and skips links", () => {
		const skipped = { symlinks: 0, other: 0 };
		const files = [...parseTar(REPO_TAR, skipped)];
		expect(files.map((file) => [file.path, file.mode])).toEqual([
			[`${top}/README.md`, undefined],
			[`${top}/bin/run`, 0o755],
			[`${top}/src/index.ts`, undefined],
			[`${top}/${longPath}`, undefined],
			[`${top}/nested/ustar.md`, undefined],
		]);
		expect(decode(files[1]!.content)).toBe("#!/bin/sh\necho hi\n");
		expect(skipped).toEqual({ symlinks: 1, other: 0 });
	});

	it("reads a pax path with non-ASCII characters by its byte length", () => {
		const name = "top/docs/café-ünïcødé-日本語.md";
		const files = [
			...parseTar(
				tar([
					{ name: "PaxHeader", type: "x", body: pax(name) },
					{ name: "top/x", body: "é" },
				]),
			),
		];
		expect(files.map((file) => file.path)).toEqual([name]);
		const broken = tar([
			{ name: "PaxHeader", type: "x", body: `99 path=${name}\n` },
			{ name: "top/x", body: "" },
		]);
		expect(() => [...parseTar(broken)]).toThrow(/pax/);
	});

	it("rejects an archive truncated mid-body, mid-header or before its end, a bad checksum and a malformed size", () => {
		const whole = tar([
			{ name: "a/b", body: "x".repeat(600) },
			{ name: "a/c", body: "y" },
		]);
		expect(() => [...parseTar(whole.subarray(0, 700))]).toThrow(/truncated/);
		// Ends cleanly after the first file's padding: no end-of-archive block.
		expect(() => [...parseTar(whole.subarray(0, 512 + 1024))]).toThrow(/truncated/);
		expect(() => [...parseTar(whole.subarray(0, 512 + 1024 + 100))]).toThrow(/truncated/);
		expect(() => [...parseTar(new Uint8Array(0))]).toThrow(/truncated/);
		const corrupt = tar([{ name: "a/b", body: "x" }]);
		corrupt[0] = "z".charCodeAt(0);
		expect(() => [...parseTar(corrupt)]).toThrow(/checksum/);
		const bad = tar([{ name: "a/b", body: "x" }]);
		bad.set(encoder.encode("zzzzzzzzzzz"), 124);
		expect(() => [...parseTar(bad)]).toThrow(/malformed|checksum/);
	});
});

describe("createGitHubTarballFetcher", () => {
	it("resolves a ref to a commit, then reads the commit's tarball without its top directory", async () => {
		const github = fakeGitHub();
		const fetcher = createGitHubTarballFetcher({ fetch: github.fetch });
		const tree = await fetcher.fetch(ctx, { kind: "git", repo: "tvdavies/site", ref: "main" });
		expect(tree.commit).toBe(COMMIT);
		expect([...(tree.files as Iterable<{ path: string }>)].map((file) => file.path)).toEqual([
			"README.md",
			"bin/run",
			"src/index.ts",
			longPath,
			"nested/ustar.md",
		]);
		expect(fetcher.skipped.symlinks).toBe(1);
		// No REST API: the ref is resolved over git's smart HTTP protocol, which has no per-IP hourly budget.
		expect(github.calls).toEqual([
			"https://github.com/tvdavies/site.git/git-upload-pack",
			`https://codeload.github.com/tvdavies/site/tar.gz/${COMMIT}`,
		]);
	});

	it("resolves branches, tags (an annotated one to its commit) and full refs exactly, as git does", async () => {
		const github = fakeGitHub();
		const fetcher = createGitHubTarballFetcher({ fetch: github.fetch });
		const resolve = (ref: string) => fetcher.resolve!(ctx, { kind: "git", repo: "tvdavies/site", ref });
		expect(await resolve("main")).toBe(COMMIT);
		expect(await resolve("refs/heads/main-old")).toBe(OTHER);
		expect(await resolve("v2")).toBe(OTHER);
		expect(await resolve("v3")).toBe(OTHER);
		expect(await resolve("HEAD")).toBe(COMMIT);
		// `main` is a prefix of `main-old`, but only an exact name resolves.
		expect(await codeOf(resolve("mai"))).toBe("not_found");
		expect(github.calls.every((url) => url.startsWith("https://github.com/"))).toBe(true);
		// Only an abbreviated commit, which ls-refs can't resolve, falls back to the REST API.
		expect(await resolve("0123456")).toBe(COMMIT);
		expect(github.calls.at(-1)).toBe("https://api.github.com/repos/tvdavies/site/commits/0123456");
		expect(await codeOf(resolve("main..v2"))).toBe("invalid");
	});

	it("skips the API for a pinned commit and reports unknown refs and foreign repos", async () => {
		const github = fakeGitHub();
		const fetcher = createGitHubTarballFetcher({ fetch: github.fetch });
		const source: GitSeedSource = {
			kind: "git",
			repo: "https://github.com/tvdavies/site.git",
			ref: "main",
			commit: COMMIT,
		};
		expect((await fetcher.fetch(ctx, source)).commit).toBe(COMMIT);
		expect(github.calls).toEqual([`https://codeload.github.com/tvdavies/site/tar.gz/${COMMIT}`]);
		expect(await codeOf(fetcher.fetch(ctx, { kind: "git", repo: "tvdavies/site", ref: "nope" }))).toBe("not_found");
		expect(await codeOf(fetcher.fetch(ctx, { kind: "git", repo: "https://gitlab.com/a/b", ref: "main" }))).toBe(
			"not_supported",
		);
		expect(await codeOf(fetcher.fetch(ctx, { kind: "git", repo: "tvdavies/site", ref: "x", commit: "abc" }))).toBe(
			"invalid",
		);
		for (const repo of ["../etc", "./repo", "owner/.", "owner/..", "https://github.com/owner/..", "a/b/c"]) {
			expect(() => gitHubRepo(repo), repo).toThrow();
		}
		expect(gitHubRepo("https://github.com/o.k/re-po.git")).toEqual(["o.k", "re-po"]);
	});

	it("refuses a tarball over its byte or file budget", async () => {
		const github = fakeGitHub();
		const small = createGitHubTarballFetcher({ fetch: github.fetch, maxBytes: 1024 });
		expect(await codeOf(small.fetch(ctx, { kind: "git", repo: "tvdavies/site", ref: "main" }))).toBe("exhausted");
		const few = createGitHubTarballFetcher({ fetch: github.fetch, maxFiles: 2 });
		expect(await codeOf(few.fetch(ctx, { kind: "git", repo: "tvdavies/site", ref: "main" }))).toBe("exhausted");
	});
});

const subjects = {
	memory: (git: GitFetcher | undefined) => createMemoryWorkspaces(git === undefined ? {} : { seeders: { git } }),
	stored: (git: GitFetcher | undefined) =>
		createStoredWorkspaces({ store: createMemoryWorkspaceStore(), ...(git === undefined ? {} : { seeders: { git } }) }),
};

describe.each(Object.entries(subjects))("git-ref seeding on %s workspaces", (_name, make) => {
	it("imports the tree at the resolved commit as version 1 and reports how", async () => {
		const workspaces = make(createGitHubTarballFetcher({ fetch: fakeGitHub().fetch }));
		const record = await workspaces.create(ctx, {
			owner,
			seed: {
				name: "site",
				sources: [
					{ kind: "git", repo: "tvdavies/site", ref: "main", into: "repo", sparse: ["src/", "bin"] },
					{ kind: "files", files: { "notes/plan.md": "plan", "repo/src/index.ts": "overridden" } },
				],
			},
		});
		expect(record.head).toBe(1);
		expect(record.seedReadiness).toBe("files");
		const listed = await workspaces.list(ctx, record.id, { recursive: true });
		expect(listed.items.filter((item) => item.kind === "file").map((item) => item.path)).toEqual([
			"notes/plan.md",
			"repo/bin/run",
			"repo/src/index.ts",
		]);
		expect(decode((await workspaces.read(ctx, record.id, "repo/bin/run")).content)).toContain("echo hi");
		expect(decode((await workspaces.read(ctx, record.id, "repo/src/index.ts")).content)).toBe("overridden");
		expect(record.seedReport).toMatchObject({
			method: "clone",
			sources: [
				{
					kind: "git",
					repo: "tvdavies/site",
					commit: COMMIT,
					sparse: ["src", "bin"],
					into: "repo",
					indexState: "refreshed",
				},
				{ kind: "files" },
			],
		});
		expect(record.seedReport?.cacheKey).toMatch(/^[0-9a-f]{64}$/);
		expect(await workspaces.get(ctx, record.id)).toEqual(record);
	});

	it("gives equal seeds an equal cache key and a moved ref a different one", async () => {
		const workspaces = make(createGitHubTarballFetcher({ fetch: fakeGitHub().fetch }));
		const seed = (ref: string) => ({ name: "s", sources: [{ kind: "git" as const, repo: "tvdavies/site", ref }] });
		const first = await workspaces.create(ctx, { owner, seed: seed("main") });
		const again = await workspaces.create(ctx, { owner, seed: seed("main") });
		const moved = await workspaces.create(ctx, { owner, seed: seed("v2") });
		expect(again.seedReport?.cacheKey).toBe(first.seedReport?.cacheKey);
		expect(moved.seedReport?.cacheKey).not.toBe(first.seedReport?.cacheKey);
		expect(moved.seedReport?.sources[0]).toMatchObject({ commit: OTHER, into: "" });
	});

	it("keys the cache on the pinned mounts, whichever request pinned them", async () => {
		const github = createGitHubTarballFetcher({ fetch: fakeGitHub().fetch });
		const seed = { name: "s", sources: [{ kind: "git" as const, repo: "tvdavies/site", ref: "main" }] };
		const clock = { now: () => 0 };
		const mount = (version: string) =>
			({ path: "/project", source: "project-files", ref: "p", version, readOnly: true }) as const;
		const keyOf = async (mounts: Parameters<typeof resolveSeed>[4]) =>
			(await resolveSeed(ctx, seed, { git: github }, clock, mounts)).report?.cacheKey;
		const skills = { path: "/skills", source: "skills", ref: "s", version: "pins:", readOnly: true } as const;
		expect(await keyOf([mount("1"), skills])).toBe(await keyOf([skills, mount("1")]));
		expect(await keyOf([mount("1")])).not.toBe(await keyOf([mount("2")]));
		expect(await keyOf([])).not.toBe(await keyOf([mount("1")]));
	});

	it("fetches nothing for a caller who may not create, and fails the create when the fetch fails", async () => {
		const github = fakeGitHub();
		const workspaces = make(createGitHubTarballFetcher({ fetch: github.fetch }));
		const seed = { name: "s", sources: [{ kind: "git" as const, repo: "tvdavies/site", ref: "main" }] };
		const foreign = { kind: "organisation", organisationId: "org-2" } as const;
		expect(await codeOf(workspaces.create(ctx, { owner: foreign, seed }))).toBe("forbidden");
		expect(github.calls).toEqual([]);
		const missing = { name: "s", sources: [{ kind: "git" as const, repo: "tvdavies/site", ref: "gone" }] };
		expect(await codeOf(workspaces.create(ctx, { owner, seed: missing }))).toBe("not_found");
	});

	it("leaves a git source at metadata without a fetcher", async () => {
		const workspaces = make(undefined);
		const record = await workspaces.create(ctx, {
			owner,
			seed: { name: "s", sources: [{ kind: "git", repo: "tvdavies/site", ref: "main" }] },
		});
		expect(record.seedReadiness).toBe("metadata");
		expect(record.seedReport).toBeUndefined();
		expect(record.head).toBe(0);
	});
});

it("keeps executable bits from a git seed in stored workspaces", async () => {
	const workspaces = subjects.stored(createGitHubTarballFetcher({ fetch: fakeGitHub().fetch }));
	const record = await workspaces.create(ctx, {
		owner,
		seed: { name: "s", sources: [{ kind: "git", repo: "tvdavies/site", ref: "main" }] },
	});
	const entries = (await workspaces.list(ctx, record.id, { path: "bin" })).items;
	expect(entries).toEqual([expect.objectContaining({ path: "bin/run", mode: 0o755 })]);
	expect((await workspaces.stat(ctx, record.id, "README.md")) as { mode?: number }).not.toHaveProperty("mode");
});

describe.skipIf(process.env.HARBOUR_TEST_GITHUB !== "1")("git-ref seeding from github.com", () => {
	it("seeds octocat/Hello-World at master", async () => {
		const workspaces = subjects.stored(createGitHubTarballFetcher());
		const record = await workspaces.create(ctx, {
			owner,
			seed: { name: "hello", sources: [{ kind: "git", repo: "octocat/Hello-World", ref: "master" }] },
		});
		expect(record.seedReport?.sources[0]).toMatchObject({
			kind: "git",
			commit: expect.stringMatching(/^[0-9a-f]{40}$/),
		});
		expect(decode((await workspaces.read(ctx, record.id, "README")).content)).toContain("Hello World");
	}, 30_000);
});

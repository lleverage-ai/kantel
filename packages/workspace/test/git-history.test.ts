// A git source's history as a shallow, blobless `.git` (#21): fetched from a real `git upload-pack` (protocol v2,
// stateless, as GitHub's smart HTTP serves it), then read back by git itself and by isomorphic-git.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isKantelError, KantelError, type SeedFile } from "@kantel/contracts";
import { fetchGitHistory, parseFetchReply, shallowFetchRequest } from "@kantel/workspace/git-history";
import { createGitHubTarballFetcher } from "@kantel/workspace/git-tarball";
import git from "isomorphic-git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const encoder = new TextEncoder();
const pkt = (text: string) => `${(encoder.encode(text).length + 4).toString(16).padStart(4, "0")}${text}`;

let origin: string;
const scratch: string[] = [];
const commits: string[] = [];

function run(cwd: string, args: readonly string[], input?: Uint8Array | string, env: Record<string, string> = {}) {
	return execFileSync(
		"git",
		["-c", "user.name=Kantel", "-c", "user.email=harbour@example.test", "-c", "commit.gpgsign=false", ...args],
		{ cwd, env: { ...process.env, ...GIT_ENV, ...env }, ...(input === undefined ? {} : { input }), maxBuffer: 1 << 26 },
	);
}

function commit(message: string, files: Record<string, string>, date: string) {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(origin, path)), { recursive: true });
		writeFileSync(join(origin, path), content);
	}
	run(origin, ["add", "-A"]);
	run(origin, ["commit", "--quiet", "-m", message], undefined, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
	commits.unshift(run(origin, ["rev-parse", "HEAD"]).toString().trim());
}

/**
 * Stands in for github.com: `git-upload-pack` POSTs go to the real upload-pack over the origin repository (ls-refs
 * and fetch alike); anything else is a 404. Records the requests.
 */
function fakeGitHub() {
	const calls: { url: string; body: string }[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const body = String(init?.body ?? "");
		calls.push({ url, body });
		if (!url.endsWith("/harbour-fixtures/site.git/git-upload-pack")) return new Response("", { status: 404 });
		const reply = run(origin, ["upload-pack", "--stateless-rpc", "."], body, { GIT_PROTOCOL: "version=2" });
		return new Response(new Uint8Array(reply));
	}) as typeof globalThis.fetch;
	return { calls, fetch };
}

/** Writes seed files under a new directory, as the workspace would hold them. */
function checkout(files: readonly SeedFile[]): string {
	const dir = mkdtempSync(join(tmpdir(), "harbour-history-"));
	scratch.push(dir);
	for (const file of files) {
		mkdirSync(dirname(join(dir, file.path)), { recursive: true });
		writeFileSync(join(dir, file.path), file.content);
	}
	return dir;
}

beforeAll(() => {
	origin = mkdtempSync(join(tmpdir(), "harbour-history-origin-"));
	scratch.push(origin);
	run(origin, ["init", "--quiet", "--initial-branch=main"]);
	run(origin, ["config", "uploadpack.allowFilter", "true"]);
	// As GitHub does, for a partial clone's lazy fetches.
	run(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
	for (let index = 1; index <= 6; index++) {
		commit(
			`Change ${index}\n\nThe body of change ${index}.`,
			{ "README.md": `# site ${index}\n`, [`src/file-${index}.ts`]: `export const n = ${index};\n` },
			`2026-10-0${index}T00:00:00Z`,
		);
	}
	run(origin, ["tag", "v1", commits[2] as string]);
});

afterAll(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe("the shallow fetch exchange", () => {
	it("asks for the commit and the commits behind it, without blobs, in protocol v2 framing", () => {
		const request = shallowFetchRequest("0123456789abcdef0123456789abcdef01234567", 3);
		expect(request).toBe(
			[
				pkt("command=fetch\n"),
				pkt("agent=harbour\n"),
				"0001",
				pkt("no-progress\n"),
				pkt("ofs-delta\n"),
				pkt("deepen 3\n"),
				pkt("filter blob:none\n"),
				pkt("want 0123456789abcdef0123456789abcdef01234567\n"),
				pkt("done\n"),
				"0000",
			].join(""),
		);
	});

	it("refuses a server error, a reply with no pack and a truncated one", () => {
		expect(() => parseFetchReply(encoder.encode(`${pkt("ERR upload-pack: not our ref\n")}0000`))).toThrow(
			/not our ref/,
		);
		expect(() => parseFetchReply(encoder.encode(`${pkt("shallow-info\n")}0001${pkt("packfile\n")}0000`))).toThrow(
			/no pack/,
		);
		expect(() => parseFetchReply(encoder.encode(pkt("shallow-info\n")))).toThrow(KantelError);
		const band3 = `${pkt("packfile\n")}${pkt("\u0003the pack failed\n")}0000`;
		expect(() => parseFetchReply(encoder.encode(band3))).toThrow(/the pack failed/);
	});
});

describe("fetchGitHistory", () => {
	it("writes a shallow, blobless .git that git reads as a clone of the branch", async () => {
		const github = fakeGitHub();
		const files = await fetchGitHistory(
			{ fetch: github.fetch, blobs: false },
			{ repo: "harbour-fixtures/site", ref: "main", commit: commits[0] as string, depth: 3 },
		);
		expect(files.every((file) => file.path.startsWith(".git/"))).toBe(true);
		const dir = checkout(files);
		const text = (path: string) => new TextDecoder().decode(files.find((file) => file.path === path)?.content);
		expect(text(".git/HEAD")).toBe("ref: refs/heads/main\n");
		expect(text(".git/shallow")).toBe(`${commits[2]}\n`);
		expect(text(".git/config")).toContain("partialclonefilter = blob:none");

		// git sees three commits on main, tracking origin, and no blobs in the pack.
		expect(run(dir, ["log", "--format=%H %s"]).toString()).toBe(
			`${commits[0]} Change 6\n${commits[1]} Change 5\n${commits[2]} Change 4\n`,
		);
		expect(run(dir, ["rev-parse", "--abbrev-ref", "HEAD@{upstream}"]).toString()).toBe("origin/main\n");
		const objects = run(dir, ["cat-file", "--batch-all-objects", "--batch-check=%(objecttype)"]).toString();
		expect(new Set(objects.trim().split("\n"))).toEqual(new Set(["commit", "tree"]));
		// Its index is the commit's tree: with the files checked out (here, from the origin), nothing has changed.
		for (const path of run(origin, ["ls-files"]).toString().trim().split("\n")) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), run(origin, ["show", `HEAD:${path}`]));
		}
		run(dir, ["update-index", "--refresh"]);
		expect(run(dir, ["ls-files", "--stage"]).toString()).toBe(run(origin, ["ls-files", "--stage"]).toString());
		expect(run(dir, ["status", "--porcelain"]).toString()).toBe("");

		// isomorphic-git reads the same log, stopping at the shallow boundary.
		const log = await git.log({ fs: await import("node:fs"), dir });
		expect(log.map((entry) => entry.oid)).toEqual(commits.slice(0, 3));
		expect(log[0]?.commit.message).toBe("Change 6\n\nThe body of change 6.\n");
	});

	it("brings the blobs of recent diffs, and every blob of a small commit, in a second pack", async () => {
		const github = fakeGitHub();
		const blobsOf = (files: readonly SeedFile[]) => {
			const objects = run(checkout(files), [
				"cat-file",
				"--batch-all-objects",
				"--batch-check=%(objecttype) %(objectname)",
			]);
			return new Set(
				objects
					.toString()
					.trim()
					.split("\n")
					.filter((line) => line.startsWith("blob "))
					.map((line) => line.slice(5)),
			);
		};
		const blob = (rev: string) => run(origin, ["rev-parse", rev]).toString().trim();
		const source = { repo: "harbour-fixtures/site", ref: "main", commit: commits[0] as string, depth: 4 };

		// The last two commits each changed README.md and added a file: both sides of each change.
		const recent = await fetchGitHistory({ fetch: github.fetch, blobs: { commits: 2, headFiles: 0 } }, source);
		expect(recent.filter((file) => file.path.endsWith(".pack"))).toHaveLength(2);
		expect(blobsOf(recent)).toEqual(
			new Set([
				blob("HEAD:README.md"),
				blob("HEAD~1:README.md"),
				blob("HEAD~2:README.md"),
				blob("HEAD:src/file-6.ts"),
				blob("HEAD:src/file-5.ts"),
			]),
		);
		// isomorphic-git reads them.
		const dir = checkout(recent);
		const { blob: readme } = await git.readBlob({
			fs: await import("node:fs"),
			dir,
			oid: commits[1] as string,
			filepath: "README.md",
		});
		expect(new TextDecoder().decode(readme)).toBe("# site 5\n");

		// A commit with few files brings them all, so the working tree diffs against it.
		const small = await fetchGitHistory({ fetch: github.fetch, blobs: { commits: 0 } }, source);
		const tree = run(origin, ["ls-tree", "-r", "--format=%(objectname)", "HEAD"]).toString().trim().split("\n");
		expect(blobsOf(small)).toEqual(new Set(tree));

		// Blobs that don't come leave the history as it was, and say why.
		const errors: unknown[] = [];
		const failing = (async (input: string | URL | Request, init?: RequestInit) =>
			String(init?.body ?? "").includes("deepen") || String(init?.body ?? "").includes("ls-refs")
				? github.fetch(input, init)
				: new Response("", { status: 500 })) as typeof globalThis.fetch;
		const without = await fetchGitHistory(
			{ fetch: failing, blobs: { onError: (error) => errors.push(error) } },
			source,
		);
		expect(without.filter((file) => file.path.endsWith(".pack"))).toHaveLength(1);
		expect(blobsOf(without).size).toBe(0);
		expect(isKantelError(errors[0], "unavailable")).toBe(true);
	});

	it("detaches HEAD for a tag or a commit, and asks GitHub's git endpoint only", async () => {
		const github = fakeGitHub();
		const tagged = await fetchGitHistory(
			{ fetch: github.fetch },
			{ repo: "https://github.com/harbour-fixtures/site", ref: "v1", commit: commits[2] as string, depth: 50 },
		);
		const head = (files: readonly SeedFile[]) =>
			new TextDecoder().decode(files.find((file) => file.path === ".git/HEAD")?.content);
		expect(head(tagged)).toBe(`${commits[2]}\n`);
		// The whole history fits in 50: nothing is shallow.
		expect(tagged.find((file) => file.path === ".git/shallow")?.content.byteLength).toBe(0);
		expect(run(checkout(tagged), ["log", "--oneline"]).toString().trim().split("\n")).toHaveLength(4);
		expect(new Set(github.calls.map((call) => call.url))).toEqual(
			new Set(["https://github.com/harbour-fixtures/site.git/git-upload-pack"]),
		);

		const pinned = await fetchGitHistory(
			{ fetch: github.fetch },
			{ repo: "harbour-fixtures/site", ref: commits[1] as string, commit: commits[1] as string, depth: 1 },
		);
		expect(head(pinned)).toBe(`${commits[1]}\n`);
		expect(run(checkout(pinned), ["log", "--format=%s"]).toString()).toBe("Change 5\n");
	});

	it("is not_found for a repository Kantel can't read, and refuses a bad commit or depth", async () => {
		const github = fakeGitHub();
		const missing = fetchGitHistory(
			{ fetch: github.fetch },
			{ repo: "harbour-fixtures/gone", ref: "main", commit: commits[0] as string, depth: 3 },
		);
		await expect(missing).rejects.toSatisfy((error: unknown) => isKantelError(error, "not_found"));
		await expect(
			fetchGitHistory({ fetch: github.fetch }, { repo: "harbour-fixtures/site", ref: "main", commit: "abc", depth: 3 }),
		).rejects.toSatisfy((error: unknown) => isKantelError(error, "invalid"));
		await expect(
			fetchGitHistory(
				{ fetch: github.fetch },
				{ repo: "harbour-fixtures/site", ref: "main", commit: commits[0] as string, depth: 0 },
			),
		).rejects.toSatisfy((error: unknown) => isKantelError(error, "invalid"));
	});
});

describe("the tarball fetcher with history", () => {
	/** GitHub with a tarball of one file next to the real upload-pack. */
	function withTarball() {
		const github = fakeGitHub();
		const tar = new Uint8Array(1024);
		const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			if (String(input).startsWith("https://codeload.github.com/")) {
				return new Response(new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip")));
			}
			return github.fetch(input, init);
		}) as typeof globalThis.fetch;
		return { github, fetch };
	}

	it("adds the .git to the tree, and seeds the tree alone when the history fails", async () => {
		const { fetch } = withTarball();
		const fetcher = createGitHubTarballFetcher({ fetch, history: {} });
		const ctx = { actor: { kind: "human" as const, userId: "user-1" }, organisationId: "org-1" };
		const tree = await fetcher.fetch(ctx, { kind: "git", repo: "harbour-fixtures/site", ref: "main", history: 2 });
		const paths = [...(tree.files as SeedFile[])].map((file) => file.path);
		expect(tree.commit).toBe(commits[0]);
		expect(paths).toContain(".git/HEAD");
		expect(paths).toContain(".git/index");

		// No history for a sparse source, `history: 0` or a fetcher without the option.
		const sparse = await fetcher.fetch(ctx, {
			kind: "git",
			repo: "harbour-fixtures/site",
			ref: "main",
			sparse: ["src"],
		});
		expect(sparse.files).toEqual([]);
		const none = await fetcher.fetch(ctx, { kind: "git", repo: "harbour-fixtures/site", ref: "main", history: 0 });
		expect(none.files).toEqual([]);
		const plain = await createGitHubTarballFetcher({ fetch }).fetch(ctx, {
			kind: "git",
			repo: "harbour-fixtures/site",
			ref: "main",
		});
		expect(plain.files).toEqual([]);

		const errors: unknown[] = [];
		const failing = createGitHubTarballFetcher({
			fetch: (async (input: string | URL | Request, init?: RequestInit) => {
				const body = String(init?.body ?? "");
				if (body.includes("command=fetch")) return new Response("", { status: 500 });
				return fetch(input, init);
			}) as typeof globalThis.fetch,
			history: { onError: (error) => errors.push(error) },
		});
		const alone = await failing.fetch(ctx, { kind: "git", repo: "harbour-fixtures/site", ref: "main" });
		expect(alone).toEqual({ commit: commits[0], files: [] });
		expect(errors).toHaveLength(1);
		expect(isKantelError(errors[0], "unavailable")).toBe(true);
	});
});

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CallContext } from "@kantel/contracts";
import { createGitMirrorCache, createMirrorGitFetcher, type GitMirrorCache, startMirrorWarmer } from "@kantel/mirror";
import { createMemoryWorkspaceStore, createStoredWorkspaces } from "@kantel/workspace/stored";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ctx: CallContext = { actor: { kind: "system", component: "mirror" }, organisationId: "org-1" };
/** git without the host's own configuration, so a developer's settings never change what the tests see. */
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

let base: string;
const remotes = new Map<string, string>();

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-c", "user.name=Kantel", "-c", "user.email=kantel@example.test", "-c", "commit.gpgsign=false", ...args],
		{ cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" },
	).trim();
}

function write(root: string, files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), content);
	}
}

/** An upstream repository with two commits on main (the second bumps only the lockfile) and a tag on the first. */
function upstream(name: string): { dir: string; first: string; second: string } {
	const dir = join(base, "upstream", name);
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "--quiet", "--initial-branch=main");
	write(dir, {
		"README.md": "# site\n",
		"pnpm-lock.yaml": "lock v1\n",
		"src/index.ts": "export const site = 1;\n",
		"src/lib/util.ts": "export const util = 2;\n",
		"docs/guide.md": "# guide\n",
		"bin/run": "#!/bin/sh\necho run\n",
	});
	chmodSync(join(dir, "bin/run"), 0o755);
	git(dir, "add", "-A");
	git(dir, "commit", "--quiet", "-m", "first");
	const first = git(dir, "rev-parse", "HEAD");
	git(dir, "tag", "v1");
	write(dir, { "pnpm-lock.yaml": "lock v2\n" });
	git(dir, "commit", "--quiet", "-am", "bump the lockfile");
	const second = git(dir, "rev-parse", "HEAD");
	remotes.set(`fixtures/${name}`, `file://${dir}`);
	return { dir, first, second };
}

function cache(overrides: Partial<Parameters<typeof createGitMirrorCache>[0]> = {}): GitMirrorCache {
	return createGitMirrorCache({
		root: join(base, "mirrors", crypto.randomUUID()),
		remoteUrl: (repo) => {
			const url = remotes.get(repo);
			if (url === undefined) return `file://${join(base, "upstream", "missing")}`;
			return url;
		},
		env: GIT_ENV,
		...overrides,
	});
}

let site: ReturnType<typeof upstream>;

beforeAll(() => {
	base = mkdtempSync(join(tmpdir(), "kantel-mirror-"));
	site = upstream("site");
	upstream("other");
	upstream("third");
});

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("the mirror cache", () => {
	it("clones a bare mirror once for concurrent callers, and resolves branches, tags and commits", async () => {
		const mirrors = cache();
		const [a, b] = await Promise.all([mirrors.sync(ctx, "fixtures/site"), mirrors.sync(ctx, "fixtures/site")]);
		expect(a).toEqual(b);
		expect(mirrors.stats().fills).toBe(1);
		expect(existsSync(join(a.path, "HEAD"))).toBe(true);
		expect(git(a.path, "rev-parse", "--is-bare-repository")).toBe("true");
		expect(await mirrors.resolve(ctx, "fixtures/site", "main")).toBe(site.second);
		expect(await mirrors.resolve(ctx, "fixtures/site", "v1")).toBe(site.first);
		expect(await mirrors.resolve(ctx, "fixtures/site", site.first)).toBe(site.first);
		// Fresh: none of those fetched again.
		expect(mirrors.stats().fills).toBe(1);
	});

	it("fetches when a ref or commit is missing, and answers not_found once fetched", async () => {
		const repo = upstream("moving");
		const mirrors = cache();
		await mirrors.sync(ctx, "fixtures/moving");
		git(repo.dir, "checkout", "--quiet", "-b", "feature");
		write(repo.dir, { "src/feature.ts": "export const feature = true;\n" });
		git(repo.dir, "add", "-A");
		git(repo.dir, "commit", "--quiet", "-m", "feature");
		const feature = git(repo.dir, "rev-parse", "HEAD");
		expect(await mirrors.resolve(ctx, "fixtures/moving", "feature")).toBe(feature);
		expect(mirrors.stats().fills).toBe(2);
		await expect(mirrors.resolve(ctx, "fixtures/moving", "nope")).rejects.toMatchObject({ code: "not_found" });
		await expect(mirrors.resolve(ctx, "fixtures/moving", "f".repeat(40))).rejects.toMatchObject({ code: "not_found" });
		await expect(mirrors.resolve(ctx, "fixtures/moving", "--upload-pack=x")).rejects.toMatchObject({ code: "invalid" });
		await expect(mirrors.resolve(ctx, "fixtures/moving", "main..feature")).rejects.toMatchObject({ code: "invalid" });
	});

	it("reports a repository that is not there as not_found, and refuses credentials in a remote URL", async () => {
		await expect(cache().sync(ctx, "fixtures/absent")).rejects.toMatchObject({ code: "not_found" });
		const leaky = cache({ remoteUrl: () => "https://user:token@example.test/a.git" });
		await expect(leaky.sync(ctx, "a/b")).rejects.toMatchObject({ code: "invalid" });
		await expect(createGitMirrorCache({ root: base }).sync(ctx, "ssh://host/x")).rejects.toMatchObject({
			code: "not_supported",
		});
	});

	it("bounds fills across repositories", async () => {
		const mirrors = cache({ maxConcurrentFills: 1 });
		await Promise.all(["fixtures/site", "fixtures/other", "fixtures/third"].map((repo) => mirrors.sync(ctx, repo)));
		expect(mirrors.stats()).toEqual({ fills: 3, maxInFlight: 1 });
	});

	it("checks out a blobless, cone-sparse clone off the mirror with settled stat config and the real origin", async () => {
		const mirrors = cache();
		const dest = join(base, "checkouts", crypto.randomUUID());
		const result = await mirrors.checkout(ctx, {
			repo: "fixtures/site",
			commit: site.first,
			dest,
			sparse: ["src/"],
		});
		expect(result).toMatchObject({ dest, commit: site.first, mode: "reference" });
		expect(Object.keys(result.timings)).toEqual(["clone", "sparse", "checkout"]);
		expect(readFileSync(join(dest, "src/lib/util.ts"), "utf8")).toBe("export const util = 2;\n");
		// Cone mode keeps the root's files and leaves other directories out.
		expect(existsSync(join(dest, "README.md"))).toBe(true);
		expect(existsSync(join(dest, "docs"))).toBe(false);
		expect(readFileSync(join(dest, "pnpm-lock.yaml"), "utf8")).toBe("lock v1\n");
		expect(git(dest, "rev-parse", "HEAD")).toBe(site.first);
		expect(git(dest, "status", "--porcelain")).toBe("");
		expect(git(dest, "config", "core.checkStat")).toBe("minimal");
		expect(git(dest, "config", "core.trustctime")).toBe("false");
		expect(git(dest, "remote", "get-url", "origin")).toBe(remotes.get("fixtures/site"));
		// The objects are borrowed from the mirror, not copied.
		expect(readFileSync(join(dest, ".git/objects/info/alternates"), "utf8")).toContain(mirrors.path("fixtures/site"));
		await expect(
			mirrors.checkout(ctx, { repo: "fixtures/site", commit: site.first, dest, sparse: ["src"] }),
		).rejects.toMatchObject({ code: "conflict" });
		await expect(
			mirrors.checkout(ctx, { repo: "fixtures/site", commit: site.first, dest: `${dest}-x`, sparse: ["../etc"] }),
		).rejects.toMatchObject({ code: "invalid" });
	});

	it("adds and releases a worktree in the mirror, with the whole tree and executable bits", async () => {
		const mirrors = cache();
		const dest = join(base, "worktrees", crypto.randomUUID());
		const result = await mirrors.checkout(ctx, { repo: "fixtures/site", commit: site.second, dest, mode: "worktree" });
		expect(result.mode).toBe("worktree");
		expect(readFileSync(join(dest, "pnpm-lock.yaml"), "utf8")).toBe("lock v2\n");
		expect(statSync(join(dest, "bin/run")).mode & 0o111).not.toBe(0);
		expect(git(dest, "status", "--porcelain")).toBe("");
		expect(git(dest, "config", "core.checkStat")).toBe("minimal");
		const mirror = mirrors.path("fixtures/site");
		expect(git(mirror, "worktree", "list")).toContain(dest);
		await mirrors.release(ctx, "fixtures/site", dest);
		expect(existsSync(dest)).toBe(false);
		expect(git(mirror, "worktree", "list")).not.toContain(dest);
	});

	it("keeps mirrors warm on an interval, reporting failures without throwing", async () => {
		const repo = upstream("warm");
		const mirrors = cache();
		const errors: string[] = [];
		const warmer = startMirrorWarmer(mirrors, {
			ctx,
			repos: () => ["fixtures/warm", "fixtures/absent"],
			intervalMs: 60_000,
			onError: (name) => errors.push(name),
		});
		await warmer.tick();
		warmer.stop();
		expect(errors).toContain("fixtures/absent");
		expect(await mirrors.resolve(ctx, "fixtures/warm", "main")).toBe(repo.second);
	});
});

describe("seeding workspace files off the mirror", () => {
	it("seeds a stored workspace by mirror, pinning the ref first, with modes kept", async () => {
		const workspaces = createStoredWorkspaces({
			store: createMemoryWorkspaceStore(),
			seeders: { git: createMirrorGitFetcher(cache()) },
		});
		const record = await workspaces.create(ctx, {
			owner: { kind: "organisation", organisationId: "org-1" },
			seed: {
				version: 1,
				name: "site",
				sources: [{ kind: "git", repo: "fixtures/site", ref: "v1", sparse: ["src", "bin"], into: "repo" }],
				deps: [{ name: "pnpm", run: "pnpm install", key: ["repo/pnpm-lock.yaml"] }],
			},
		});
		expect(record.seedReport).toMatchObject({
			method: "mirror",
			sources: [{ kind: "git", repo: "fixtures/site", commit: site.first, into: "repo" }],
		});
		const files = (await workspaces.list(ctx, record.id, { recursive: true })).items
			.filter((entry) => entry.kind === "file")
			.map((entry) => entry.path);
		expect(files).toEqual(["repo/bin/run", "repo/src/index.ts", "repo/src/lib/util.ts"]);
		const run = (await workspaces.list(ctx, record.id, { path: "repo/bin" })).items[0] as { mode?: number };
		expect(run.mode).toBe(0o755);
	});
});

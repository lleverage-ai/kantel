// `kantel sync --git`: the patch made here, the base chosen, and a whole sync into a "sandbox" that is a second clone
// on this machine, its commands run by sh as a microVM would run them.
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Command, KantelClient, Sandbox, Snapshot } from "@kantel/api/sdk";
import { KantelApiError } from "@kantel/api/sdk";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	applyScript,
	buildPatch,
	checkoutPath,
	chooseBase,
	defaultCheckout,
	resolveLocalBase,
	sendParts,
	syncGit,
} from "../src/sync.ts";
import { PART } from "../src/transfer.ts";

const exec = promisify(execFile);

beforeAll(() => {
	// Git as it comes: no one's global config (signing, hooks, renames) in these repositories.
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	process.env.GIT_AUTHOR_NAME = "test";
	process.env.GIT_AUTHOR_EMAIL = "test@example.com";
	process.env.GIT_COMMITTER_NAME = "test";
	process.env.GIT_COMMITTER_EMAIL = "test@example.com";
});

let root = "";
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "kantel-sync-test-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

/** A repository at `root/local` with one commit, and `root/sandbox`, a clone of it: the sandbox's checkout. */
async function repositories(): Promise<{ local: string; sandbox: string; base: string }> {
	const local = join(root, "local");
	await mkdir(join(local, "src"), { recursive: true });
	await git(local, "init", "-q", "-b", "main");
	await writeFile(join(local, ".gitignore"), "node_modules/\n*.log\n");
	await writeFile(join(local, "src", "a.ts"), "export const a = 1;\n");
	await writeFile(join(local, "src", "gone.ts"), "export {};\n");
	await writeFile(join(local, "run.sh"), "#!/bin/sh\necho hi\n");
	await writeFile(join(local, "logo.bin"), Buffer.from([0, 1, 2, 3, 255, 254, 0, 0]));
	await git(local, "add", "-A");
	await git(local, "commit", "-q", "-m", "base");
	const base = await git(local, "rev-parse", "HEAD");
	const sandbox = join(root, "sandbox");
	await git(root, "clone", "-q", local, sandbox);
	return { local, sandbox, base };
}

/** Edits the working tree at `local`: a change, a deletion, a new file, an ignored one, a binary and a mode change. */
async function edit(local: string): Promise<void> {
	await writeFile(join(local, "src", "a.ts"), "export const a = 2;\n");
	await unlink(join(local, "src", "gone.ts"));
	await mkdir(join(local, "src", "new"), { recursive: true });
	await writeFile(join(local, "src", "new", "b.ts"), "export const b = 'new';\n");
	await writeFile(join(local, "debug.log"), "ignored\n");
	await mkdir(join(local, "node_modules", "x"), { recursive: true });
	await writeFile(join(local, "node_modules", "x", "index.js"), "ignored\n");
	await writeFile(join(local, "logo.bin"), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7) % 256)));
	await chmod(join(local, "run.sh"), 0o755);
	await symlink("src/a.ts", join(local, "link.ts"));
}

/** A tree's ID as git would commit the working tree at `dir` (every untracked, unignored file added). */
async function workingTree(dir: string): Promise<string> {
	const index = join(root, `index-${Math.random()}`);
	await exec("git", ["read-tree", "HEAD"], { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: index } });
	await exec("git", ["add", "-A"], { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: index } });
	return (
		await exec("git", ["write-tree"], { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: index } })
	).stdout.trim();
}

describe("the base", () => {
	const checkout = { top: "/home/user/app" };

	it("is --base, then the checkout's .kantel-base-sha, then its snapshot's git.base label, then its HEAD", () => {
		const label = { commit: "c3", snapshot: "app-warm" };
		const all = { ...checkout, recorded: "c2", head: "c4" };
		expect(chooseBase({ flag: "c1", checkout: all, label, sandboxId: "sbx_1" })).toEqual({
			commit: "c1",
			source: "flag",
			from: "--base",
		});
		expect(chooseBase({ checkout: all, label, sandboxId: "sbx_1" })).toMatchObject({ commit: "c2", source: "file" });
		expect(chooseBase({ checkout: { ...checkout, head: "c4" }, label, sandboxId: "sbx_1" })).toEqual({
			commit: "c3",
			source: "label",
			from: "the git.base label on app-warm",
		});
		expect(chooseBase({ checkout: { ...checkout, head: "c4" }, sandboxId: "sbx_1" })).toMatchObject({
			commit: "c4",
			source: "head",
		});
	});

	it("with none recorded and nothing checked out, says so and how to give one", () => {
		expect(() => chooseBase({ checkout, sandboxId: "sbx_1" })).toThrow(
			/^\/home\/user\/app in sbx_1 has no base commit recorded: .*--base <commit>, or copy the whole tree with kantel push$/,
		);
	});

	it("must be in the local repository, and is given in full", async () => {
		const { local, base } = await repositories();
		expect(await resolveLocalBase(local, { commit: base.slice(0, 8), source: "label", from: "x" })).toBe(base);
		const missing = "0123456789abcdef0123456789abcdef01234567";
		await expect(
			resolveLocalBase(local, { commit: missing, source: "file", from: "its .kantel-base-sha" }),
		).rejects.toThrow(
			`the base commit ${missing} (its .kantel-base-sha) isn't in your repository at ${local}: fetch it (git fetch origin ${missing})`,
		);
	});

	it("defaults to /home/user/<the repository's name>, and --to resolves under the home as push's does", () => {
		expect(defaultCheckout("/Users/me/src/lleverage")).toBe("/home/user/lleverage");
		expect(checkoutPath("app")).toBe("/home/user/app");
		expect(checkoutPath("~/app")).toBe("/home/user/app");
		expect(checkoutPath("/srv/app/../app")).toBe("/srv/app");
	});
});

describe("the patch", () => {
	it("holds tracked changes, deletions, modes, links, binaries and new files, not ignored ones", async () => {
		const { local, sandbox, base } = await repositories();
		await edit(local);
		const status = await git(local, "status", "--porcelain");
		const before = await readFile(join(local, ".git", "index"));
		const patch = await buildPatch(local, base, { defaultExcludes: true });
		// Your index stays as it was.
		expect((await readFile(join(local, ".git", "index"))).equals(before)).toBe(true);
		expect(await git(local, "status", "--porcelain")).toBe(status);
		expect(patch.tree).toBe(await workingTree(local));
		expect(patch.files).toBe(6);
		expect(patch.skipped).toEqual([]);
		const text = patch.patch.toString("utf8");
		expect(text).toContain("GIT binary patch");
		expect(text).toContain("old mode 100644\nnew mode 100755");
		expect(text).not.toContain("debug.log");
		expect(text).not.toContain("node_modules");
		// Applied to a clone at the base, it gives the same tree.
		const file = join(root, "p.patch");
		await writeFile(file, patch.patch);
		await git(sandbox, "apply", "--index", file);
		expect(await git(sandbox, "write-tree")).toBe(patch.tree);
		expect(await readFile(join(sandbox, "logo.bin"))).toEqual(await readFile(join(local, "logo.bin")));
	});

	it("sees a change of the same size made in the second the index was written", async () => {
		const { local, base } = await repositories();
		const file = join(local, "src", "a.ts");
		const then = new Date("2026-01-01T00:00:00Z");
		await utimes(file, then, then);
		await git(local, "update-index", "-q", "--really-refresh"); // The index has src/a.ts at `then`.
		// Changed at the same size in the same second, and the index written in that second too: "racily clean",
		// which git tells only by the index file's own time.
		await writeFile(file, "export const a = 2;\n");
		await utimes(file, then, then);
		await utimes(join(local, ".git", "index"), then, then);
		const patch = await buildPatch(local, base, { defaultExcludes: true });
		expect(patch.files).toBe(1);
		expect(patch.patch.toString("utf8")).toContain("+export const a = 2;");
	});

	it("is empty when the working tree is the base", async () => {
		const { local, base } = await repositories();
		const patch = await buildPatch(local, base, { defaultExcludes: true });
		expect(patch.patch.length).toBe(0);
		expect(patch.files).toBe(0);
		expect(patch.tree).toBe(await git(local, "rev-parse", "HEAD^{tree}"));
	});

	it("takes staged changes and commits made since the base", async () => {
		const { local, base } = await repositories();
		await writeFile(join(local, "committed.ts"), "1\n");
		await git(local, "add", "committed.ts");
		await git(local, "commit", "-q", "-m", "later");
		await writeFile(join(local, "staged.ts"), "2\n");
		await git(local, "add", "staged.ts");
		const patch = await buildPatch(local, base, { defaultExcludes: true });
		expect(patch.tree).toBe(await workingTree(local));
		expect(patch.files).toBe(2);
	});

	it("leaves new .env files, agents' settings and changed credentials at the base, naming each", async () => {
		const { local, base } = await repositories();
		await writeFile(join(local, ".env.local"), "SECRET=1\n");
		await writeFile(join(local, ".env.example"), "SECRET=\n");
		await mkdir(join(local, ".claude"));
		await writeFile(join(local, ".claude", "settings.local.json"), "{}\n");
		const patch = await buildPatch(local, base, { defaultExcludes: true });
		const text = patch.patch.toString("utf8");
		expect(text).toContain(".env.example");
		expect(text).not.toContain(".env.local");
		expect(text).not.toContain("settings.local.json");
		expect(patch.skipped.map((skipped) => skipped.path)).toEqual([".claude/settings.local.json", ".env.local"]);
		expect(patch.files).toBe(1);
		const all = await buildPatch(local, base, { defaultExcludes: false });
		expect(all.files).toBe(3);
		expect(all.tree).toBe(await workingTree(local));
	});

	it("leaves Kantel's config at the base's version, whatever the excludes", async () => {
		const { local, base } = await repositories();
		const config = join(local, ".config", "kantel");
		await mkdir(config, { recursive: true });
		await writeFile(join(config, "config.json"), '{"apiKey":"ksk_secret"}\n');
		await writeFile(join(local, ".config", "other.json"), "{}\n");
		for (const defaultExcludes of [true, false]) {
			const patch = await buildPatch(local, base, { defaultExcludes, keep: [config] });
			expect(patch.patch.toString("utf8")).not.toContain("ksk_secret");
			expect(patch.patch.toString("utf8")).toContain(".config/other.json");
			expect(patch.skipped).toEqual([{ path: ".config/kantel", why: "Kantel's config, with your API key" }]);
		}
	});

	it("classifies changes under the repository's own name, as push does: config.json in a .docker repository", async () => {
		const docker = join(root, ".docker");
		await mkdir(docker);
		await git(docker, "init", "-q");
		await writeFile(join(docker, "a.json"), "{}\n");
		await git(docker, "add", "-A");
		await git(docker, "commit", "-q", "-m", "base");
		const base = await git(docker, "rev-parse", "HEAD");
		await writeFile(join(docker, "config.json"), '{"auths":{"r":{"auth":"c2VjcmV0"}}}\n');
		const patch = await buildPatch(docker, base, { defaultExcludes: true });
		expect(patch.files).toBe(0);
		expect(patch.skipped).toEqual([{ path: "config.json", why: "credentials", byDefault: true }]);
		const all = await buildPatch(docker, base, { defaultExcludes: false });
		expect(all.patch.toString("utf8")).toContain("c2VjcmV0");
	});

	it("leaves out a repository inside the tree", async () => {
		const { local, base } = await repositories();
		await mkdir(join(local, "vendor", "lib"), { recursive: true });
		await git(join(local, "vendor", "lib"), "init", "-q");
		await writeFile(join(local, "vendor", "lib", "x.ts"), "x\n");
		const patch = await buildPatch(local, base, { defaultExcludes: true });
		expect(patch.skipped).toEqual([{ path: "vendor/lib", why: "a git repository of its own" }]);
		expect(patch.files).toBe(0);
	});
});

/**
 * A client whose sandbox is `sandbox` (a microVM made from snapshot `snap_1`, labelled `labels`): its commands run
 * here with sh, and its files are written here, as the files API would in the microVM.
 */
function client(options: {
	readonly labels?: Record<string, string>;
	readonly type?: Sandbox["type"];
	/** Changes each command before it runs. */
	readonly rewrite?: (command: string) => string;
}) {
	const commands: string[] = [];
	const written: string[] = [];
	const fake = {
		async getSandbox(id: string) {
			return { id, type: options.type ?? "microvm", source: { snapshotId: "snap_1" } } as unknown as Sandbox;
		},
		async getSnapshot(id: string) {
			if (options.labels === undefined) throw new KantelApiError(404, "not_found", "no snapshot");
			return { id, name: "app-warm", labels: options.labels } as unknown as Snapshot;
		},
		async writeFile(_id: string, body: { path: string; content: string; encoding?: string }) {
			written.push(body.path);
			await writeFile(body.path, Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8"));
			return { path: body.path, size: 0 };
		},
		async runCommand(sandboxId: string, body: { command: string }) {
			commands.push(body.command);
			const line = options.rewrite?.(body.command) ?? body.command;
			let exitCode = 0;
			let stdout = "";
			let stderr = "";
			try {
				({ stdout, stderr } = await exec("sh", ["-c", line], { encoding: "utf8" }));
			} catch (error) {
				const failed = error as { code: number; stdout: string; stderr: string };
				({ stdout, stderr } = failed);
				exitCode = failed.code;
			}
			return { id: "cmd_1", sandboxId, command: body.command, state: "exited", exitCode, stdout, stderr } as Command;
		},
	};
	return { client: fake as unknown as KantelClient, commands, written };
}

describe("a sync", () => {
	it("brings the sandbox's checkout to the working tree, keeping its ignored files, and proves the trees match", async () => {
		const { local, sandbox, base } = await repositories();
		await edit(local);
		// The sandbox has moved on: a commit of its own, a change, an untracked file, and its ignored node_modules.
		await writeFile(join(sandbox, "theirs.ts"), "x\n");
		await git(sandbox, "add", "theirs.ts");
		await git(sandbox, "commit", "-q", "-m", "theirs");
		await writeFile(join(sandbox, "src", "a.ts"), "dirty\n");
		await writeFile(join(sandbox, "scratch.txt"), "untracked\n");
		await mkdir(join(sandbox, "node_modules", "dep"), { recursive: true });
		await writeFile(join(sandbox, "node_modules", "dep", "index.js"), "kept\n");
		await writeFile(join(sandbox, ".kantel-base-sha"), `${base}\n`);
		const fake = client({});
		const synced = await syncGit(fake.client, "sbx_1", { top: local, to: sandbox, defaultExcludes: true });
		expect(synced).toMatchObject({ sandboxId: "sbx_1", path: sandbox, base, baseSource: "file", files: 6 });
		expect(synced.tree).toBe(await workingTree(local));
		expect(await git(sandbox, "write-tree")).toBe(synced.tree);
		expect(await git(sandbox, "rev-parse", "HEAD")).toBe(base);
		// Staged, as git apply --index leaves it, with nothing else changed or untracked.
		expect((await git(sandbox, "status", "--porcelain")).split("\n").sort()).toEqual(
			[
				"?? .kantel-base-sha",
				"A  link.ts",
				"A  src/new/b.ts",
				"D  src/gone.ts",
				"M  logo.bin",
				"M  run.sh",
				"M  src/a.ts",
			].sort(),
		);
		expect(await readFile(join(sandbox, "src", "a.ts"), "utf8")).toBe("export const a = 2;\n");
		expect((await stat(join(sandbox, "run.sh"))).mode & 0o111).not.toBe(0);
		await expect(stat(join(sandbox, "scratch.txt"))).rejects.toThrow();
		await expect(stat(join(sandbox, "theirs.ts"))).rejects.toThrow();
		expect(await readFile(join(sandbox, "node_modules", "dep", "index.js"), "utf8")).toBe("kept\n");
		expect(await readFile(join(sandbox, ".kantel-base-sha"), "utf8")).toBe(`${base}\n`);
		// The patch went up in parts under /tmp, which the sandbox side removed.
		expect(fake.written.length).toBeGreaterThan(0);
		expect(fake.written.every((path) => /^\/tmp\/\.kantel-sync-[0-9a-f]{12}-\d{6}$/.test(path))).toBe(true);
		for (const path of fake.written) await expect(stat(path)).rejects.toThrow();
		expect(fake.commands).toHaveLength(2);
		expect(synced.timings.totalMs).toBeGreaterThanOrEqual(0);
	});

	it("again, with nothing new, sends nothing and still checks the tree", async () => {
		const { local, sandbox, base } = await repositories();
		await writeFile(join(sandbox, "scratch.txt"), "untracked\n");
		const fake = client({});
		const synced = await syncGit(fake.client, "sbx_1", { top: local, to: sandbox, defaultExcludes: true });
		expect(synced).toMatchObject({ base, baseSource: "head", files: 0, patchBytes: 0, sentBytes: 0 });
		expect(fake.written).toEqual([]);
		await expect(stat(join(sandbox, "scratch.txt"))).rejects.toThrow();
	});

	it("takes the base from the git.base label on the sandbox's snapshot", async () => {
		const { local, sandbox, base } = await repositories();
		await writeFile(join(sandbox, "theirs.ts"), "x\n");
		await git(sandbox, "add", "theirs.ts");
		await git(sandbox, "commit", "-q", "-m", "theirs");
		await writeFile(join(local, "mine.ts"), "y\n");
		const synced = await syncGit(client({ labels: { "git.base": base.slice(0, 12) } }).client, "sbx_1", {
			top: local,
			to: sandbox,
			defaultExcludes: true,
		});
		expect(synced).toMatchObject({ base, baseSource: "label", files: 1 });
		expect(await git(sandbox, "rev-parse", "HEAD")).toBe(base);
	});

	it("refuses a base the sandbox's checkout doesn't have", async () => {
		const { local, sandbox } = await repositories();
		await writeFile(join(local, "later.ts"), "1\n");
		await git(local, "add", "later.ts");
		await git(local, "commit", "-q", "-m", "later");
		const later = await git(local, "rev-parse", "HEAD");
		const fake = client({});
		await expect(
			syncGit(fake.client, "sbx_1", { top: local, to: sandbox, base: later, defaultExcludes: true }),
		).rejects.toThrow(`the base commit ${later.slice(0, 10)} (--base) isn't in ${sandbox} in sbx_1: fetch it there`);
		// Nothing was reset, and the parts are gone.
		expect(await git(sandbox, "status", "--porcelain")).toBe("");
		for (const path of fake.written) await expect(stat(path)).rejects.toThrow();
	});

	it("refuses a base this repository doesn't have", async () => {
		const { local, sandbox } = await repositories();
		await writeFile(join(sandbox, "theirs.ts"), "x\n");
		await git(sandbox, "add", "theirs.ts");
		await git(sandbox, "commit", "-q", "-m", "theirs");
		const theirs = await git(sandbox, "rev-parse", "HEAD");
		await expect(
			syncGit(client({}).client, "sbx_1", { top: local, to: sandbox, defaultExcludes: true }),
		).rejects.toThrow(
			`the base commit ${theirs} (its HEAD) isn't in your repository at ${local}: fetch it (git fetch origin ${theirs})`,
		);
	});

	it("refuses a checkout with no base, a path that isn't a checkout, and an isolate", async () => {
		const { local } = await repositories();
		const empty = join(root, "empty");
		await mkdir(empty);
		await git(empty, "init", "-q");
		await expect(syncGit(client({}).client, "sbx_1", { top: local, to: empty, defaultExcludes: true })).rejects.toThrow(
			`${empty} in sbx_1 has no base commit recorded`,
		);
		const plain = join(root, "plain");
		await mkdir(plain);
		await expect(syncGit(client({}).client, "sbx_1", { top: local, to: plain, defaultExcludes: true })).rejects.toThrow(
			`${plain} in sbx_1 isn't a git checkout`,
		);
		await expect(
			syncGit(client({}).client, "sbx_1", { top: local, to: join(root, "nowhere"), defaultExcludes: true }),
		).rejects.toThrow(`${join(root, "nowhere")} isn't in sbx_1: sync --git needs a clone of this repository there`);
		await expect(
			syncGit(client({ type: "isolate" }).client, "sbx_1", { top: local, to: plain, defaultExcludes: true }),
		).rejects.toThrow("sbx_1 is an isolate: sync --git needs a microVM");
	});

	it("says so when the patch doesn't apply, leaving the checkout at the base", async () => {
		const { local, sandbox, base } = await repositories();
		await writeFile(join(local, "src", "a.ts"), "export const a = 3;\n");
		// A patch cut short on the way.
		const fake = client({ rewrite: (command) => command.replace("gzip -dc >", "gzip -dc | head -c 120 >") });
		await expect(syncGit(fake.client, "sbx_1", { top: local, to: sandbox, defaultExcludes: true })).rejects.toThrow(
			new RegExp(
				`^the patch didn't apply to ${sandbox} in sbx_1: .*It's left at ${base.slice(0, 10)}, with nothing applied$`,
				"s",
			),
		);
		for (const path of fake.written) await expect(stat(path)).rejects.toThrow();
	});

	it("says so when the trees don't match after the patch", async () => {
		const { local, sandbox } = await repositories();
		await writeFile(join(local, "src", "a.ts"), "export const a = 3;\n");
		// A change git apply doesn't make: a file staged on the sandbox's side after it.
		const fake = client({
			rewrite: (command) =>
				command.replace("t=$(git write-tree)", "echo extra > extra.ts && git add extra.ts; t=$(git write-tree)"),
		});
		await expect(syncGit(fake.client, "sbx_1", { top: local, to: sandbox, defaultExcludes: true })).rejects.toThrow(
			new RegExp(
				`^after the patch ${sandbox} in sbx_1 has tree [0-9a-f]{10}, not this working tree's [0-9a-f]{10}: A {2}extra\\.ts`,
			),
		);
	});
});

describe("sending the patch", () => {
	it("starts no part after one fails, and settles the rest before it throws", async () => {
		let started = 0;
		let settled = 0;
		const fake = {
			async writeFile(_id: string, body: { path: string }) {
				started++;
				const first = body.path.endsWith("-000000");
				await new Promise((done) => setTimeout(done, first ? 5 : 30));
				settled++;
				if (first) throw new Error("part 0 failed");
				return { path: body.path, size: 0 };
			},
		} as unknown as KantelClient;
		const content = Buffer.alloc(PART * 20, 1);
		await expect(sendParts(fake, "sbx_1", "/tmp/.kantel-sync-x", content)).rejects.toThrow("part 0 failed");
		// The six that started at once all landed or failed before it threw, and none started after the failure.
		expect(settled).toBe(started);
		expect(started).toBe(6);
		await new Promise((done) => setTimeout(done, 50));
		expect(started).toBe(6);
	});
});

describe("the sandbox side", () => {
	it("resets, cleans (keeping ignored files and .kantel-base-sha), applies and checks, removing the parts", () => {
		const script = applyScript({
			top: "/home/user/my app",
			base: "b".repeat(40),
			tree: "t".repeat(40),
			parts: "/tmp/.kantel-sync-abc-*",
			patch: "/tmp/.kantel-sync-abc.patch",
		});
		expect(script).toContain("cd '/home/user/my app' || exit 1; ");
		expect(script).toContain(`git reset -q --hard ${"b".repeat(40)} && git clean -fdq -e /.kantel-base-sha`);
		expect(script).toContain(
			"cat /tmp/.kantel-sync-abc-* | gzip -dc > /tmp/.kantel-sync-abc.patch && git apply --index --whitespace=nowarn /tmp/.kantel-sync-abc.patch",
		);
		expect(script).toContain(`[ "$t" = ${"t".repeat(40)} ]`);
		expect(script.match(/rm -f \/tmp\/\.kantel-sync-abc-\* \/tmp\/\.kantel-sync-abc\.patch/g)?.length).toBe(4);
	});
});

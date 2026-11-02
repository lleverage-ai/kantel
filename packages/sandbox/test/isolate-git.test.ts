import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type CallContext, DEFAULT_TIER_ROUTES } from "@kantel/contracts";
import { commandSubcommand, routeTool } from "@kantel/sandbox";
import { createInProcessIsolateBackend } from "@kantel/sandbox/isolate";
import { createIsolateGitCommand, gitDate, ISOLATE_GIT_ROUTES } from "@kantel/sandbox/isolate-git";
import { createTieredSandboxes } from "@kantel/sandbox/tiered";
import { createMemoryWorkspaceStore, createStoredWorkspaces } from "@kantel/workspace/stored";
import type { ModedChange } from "@kantel/workspace/tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SimulatedContainer } from "./backends.ts";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

let repo: string;

/** Thirty lines with a function header every ten, so hunks carry git's default function context. */
const LONG = Array.from({ length: 30 }, (_, index) =>
	index % 10 === 0 ? `function part${index}() {` : `\treturn ${index};`,
);

function git(...args: string[]): string {
	return execFileSync(
		"git",
		["-c", "user.name=Kantel", "-c", "user.email=kantel@example.test", "-c", "commit.gpgsign=false", ...args],
		{
			cwd: repo,
			env: {
				...process.env,
				...GIT_ENV,
				GIT_AUTHOR_DATE: "2026-10-01T00:00:00Z",
				GIT_COMMITTER_DATE: "2026-10-01T00:00:00Z",
			},
			encoding: "utf8",
		},
	);
}

function write(files: Record<string, string>): void {
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		writeFileSync(join(repo, path), content);
	}
}

/** Every file under the repository, `.git` included, as workspace changes. */
function walk(dir: string, out: ModedChange[] = []): ModedChange[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		const stats = statSync(path);
		if (stats.isDirectory()) walk(path, out);
		else out.push({ op: "put", path: relative(repo, path), content: readFileSync(path), mode: stats.mode & 0o777 });
	}
	return out;
}

beforeAll(() => {
	repo = mkdtempSync(join(tmpdir(), "kantel-isolate-git-"));
	git("init", "--quiet", "--initial-branch=main");
	git("remote", "add", "origin", "https://github.com/kantel-fixtures/site.git");
	write({
		"README.md": "# site\n",
		"src/index.ts": "export const a = 1;\n",
		"src/gone.ts": "gone\n",
		"src/long.ts": LONG.join("\n"),
		"docs/old.md": "old\n",
	});
	git("add", "-A");
	git("commit", "--quiet", "-m", "first");
	// Two hunks in one file, a file without its last newline, a new file and a deleted one.
	const long = [...LONG];
	long[4] = "\treturn four;";
	long[24] = "\treturn 25; // changed";
	write({ "src/index.ts": "export const a = 2;\n", "src/long.ts": `${long.join("\n")}\n`, "docs/new.md": "new\n" });
	rmSync(join(repo, "docs/old.md"));
	git("add", "-A");
	git("commit", "--quiet", "-m", "second\n\nwith a body");
	// Work in progress: one staged edit, one unstaged edit, one deletion and one new file.
	write({ "README.md": "# site, staged\n" });
	git("add", "README.md");
	write({ "src/index.ts": "export const a = 3;\n", "notes.md": "new\n" });
	rmSync(join(repo, "src/gone.ts"));
	// Loose objects and a packed ref, as a real clone has both.
	git("pack-refs", "--all");
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

async function setUp() {
	const workspaces = createStoredWorkspaces({ store: createMemoryWorkspaceStore() });
	const record = await workspaces.create(ctx, { owner: { kind: "organisation", organisationId: "org-1" } });
	await workspaces.commit(ctx, record.id, { baseVersion: 0, changes: walk(repo) });
	const sandboxes = createTieredSandboxes({
		workspaces,
		isolate: createInProcessIsolateBackend(workspaces, { commands: [createIsolateGitCommand()] }),
		container: new SimulatedContainer(workspaces),
		routes: ISOLATE_GIT_ROUTES,
	});
	const run = (command: string) =>
		sandboxes.run(ctx, { sessionId: "sess-1", workspaceId: record.id, tool: "bash", request: { command } });
	return { workspaces, record, run };
}

describe("git reads in the isolate tier", () => {
	it("answers status, log, rev-parse, ls-files, show and cat-file as git does, writing nothing", async () => {
		const { workspaces, record, run } = await setUp();
		const same = async (command: string) => {
			const result = await run(command);
			expect(result.tier, command).toBe("isolate");
			expect(result.stderr, command).toBe("");
			expect(result.stdout, command).toBe(git(...command.split(" ").slice(1)));
		};
		await same("git status --porcelain");
		await same("git log --oneline");
		await same("git log -n 1 --oneline");
		await same("git rev-parse HEAD");
		await same("git rev-parse --short HEAD~1");
		await same("git rev-parse --abbrev-ref HEAD");
		await same("git ls-files");
		await same("git show HEAD~1:src/index.ts");
		await same("git cat-file -t HEAD");
		await same("git cat-file -p HEAD:src");
		// Diffs: a commit's, between revisions, and of the work in progress.
		await same("git show HEAD");
		await same("git show HEAD~1");
		await same("git show --name-status HEAD");
		await same("git show --name-only HEAD");
		await same("git show -s HEAD");
		await same("git diff HEAD~1 HEAD");
		await same("git diff HEAD~1..HEAD -- src");
		await same("git diff --stat HEAD~1 HEAD");
		await same("git diff");
		await same("git diff --cached");
		await same("git diff HEAD");
		await same("git diff --name-status HEAD");
		const head = git("rev-parse", "HEAD").trim();
		expect((await run("git log -1")).stdout).toBe(
			`commit ${head}\nAuthor: Kantel <kantel@example.test>\nDate:   Thu Oct 1 00:00:00 2026 +0000\n\n    second\n    \n    with a body\n`,
		);
		await same("git log");
		// 06:33:59 UTC, in the author's zone.
		expect(gitDate(1791873239, -420)).toBe("Tue Oct 13 13:33:59 2026 +0700");
		expect(gitDate(1791873239, 330)).toBe("Tue Oct 13 01:03:59 2026 -0530");
		const long = (await run("git status")).stdout;
		expect(long).toContain("On branch main\n");
		expect(long).toContain("Changes to be committed:\n\tmodified:   README.md\n");
		expect(long).toContain("\tdeleted:   src/gone.ts\n");
		expect(long).toContain("Untracked files:\n\tnotes.md\n");
		// Reads commit nothing.
		expect((await workspaces.get(ctx, record.id)).head).toBe(record.head + 1);
	});

	it("sends writes, lists and other subcommands to the container, and refuses writes inside the isolate", async () => {
		const { run } = await setUp();
		expect((await run("git commit -m x")).tier).toBe("container");
		expect((await run("git status && git push")).tier).toBe("container");
		expect((await run("git branch -D main")).tier).toBe("container");
		// Inside an isolate script, a write fails and says where it runs.
		const result = await run("echo start; git commit -m x");
		expect(result.tier).toBe("isolate");
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("git commit is not available in the isolate tier");
		const branch = await run(
			"echo; git branch --show-current; git remote get-url origin; git config --get remote.origin.url",
		);
		expect(branch.stdout).toBe(
			"\nmain\nhttps://github.com/kantel-fixtures/site.git\nhttps://github.com/kantel-fixtures/site.git\n",
		);
	});

	it("fails as git does outside a repository", async () => {
		const workspaces = createStoredWorkspaces({ store: createMemoryWorkspaceStore() });
		const record = await workspaces.create(ctx, {
			owner: { kind: "organisation", organisationId: "org-1" },
			seed: { name: "plain", sources: [{ kind: "files", files: { "a.txt": "a" } }] },
		});
		const sandboxes = createTieredSandboxes({
			workspaces,
			isolate: createInProcessIsolateBackend(workspaces, { commands: [createIsolateGitCommand()] }),
			container: new SimulatedContainer(workspaces),
			routes: ISOLATE_GIT_ROUTES,
		});
		const result = await sandboxes.run(ctx, {
			sessionId: "sess-1",
			workspaceId: record.id,
			tool: "bash",
			request: { command: "git status" },
		});
		expect(result).toMatchObject({ tier: "isolate", exitCode: 128 });
		expect(result.stderr).toContain("not a git repository");
	});

	it("routes by subcommand only for a single simple command", () => {
		expect(commandSubcommand("git status")).toBe("status");
		expect(commandSubcommand("FOO=1 git log -1")).toBe("log");
		expect(commandSubcommand("git status | head")).toBeUndefined();
		expect(commandSubcommand(["git", "show"])).toBe("show");
		expect(routeTool(ISOLATE_GIT_ROUTES, "bash", "git log")).toBe("isolate");
		expect(routeTool(ISOLATE_GIT_ROUTES, "bash", "git push")).toBe("container");
		expect(routeTool(ISOLATE_GIT_ROUTES, "bash", "cd src && git status")).toBe("container");
		expect(routeTool(DEFAULT_TIER_ROUTES, "bash", "git status")).toBe("container");
	});
});

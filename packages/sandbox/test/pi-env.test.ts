import { BACKGROUND_CONTEXT, type Context, withAbortSignal } from "@earendil-works/chord/context";
import { type ExecutionEnv, getOrThrow, type Result } from "@earendil-works/pi-durable/env";
import {
	createEnvConformance,
	createExpectAssertions,
	registerEnvConformance,
} from "@earendil-works/pi-durable/testing";
import { type CallContext, type ErrorCode, HarbourError, type Sandboxes, type Workspaces } from "@harbour/contracts";
import { createMemorySandboxes } from "@harbour/sandbox/memory";
import { createSandboxExecutionEnv, type SandboxExecRecord } from "@harbour/sandbox/pi-env";
import { createMemoryProjectFiles, createMemoryWorkspaces } from "@harbour/workspace/memory";
import { describe, expect, it } from "vitest";

const ctx: CallContext = { actor: { kind: "human", userId: "user-1" }, organisationId: "org-1" };
const ORG = { kind: "organisation", organisationId: "org-1" } as const;
const context = BACKGROUND_CONTEXT;
const decoder = new TextDecoder();

function abortedContext(): Context {
	const controller = new AbortController();
	controller.abort();
	return withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
}

function codeOf<T, E extends { readonly code: string }>(result: Result<T, E>): string | undefined {
	return result.ok ? undefined : result.error.code;
}

interface SetUpOptions {
	readonly wrapWorkspaces?: (inner: Workspaces) => Workspaces;
	readonly wrapSandboxes?: (inner: Sandboxes) => Sandboxes;
	readonly root?: string;
}

async function setUp(options: SetUpOptions = {}) {
	const projectFiles = createMemoryProjectFiles();
	await projectFiles.seed("proj-1", { "README.md": "readme\n", "src/a.ts": "a" });
	const memoryWorkspaces = createMemoryWorkspaces({ sources: [projectFiles] });
	const record = await memoryWorkspaces.create(ctx, {
		owner: ORG,
		seed: { name: "s", sources: [{ kind: "files", files: { "docs/one.md": "one\ntwo\n" } }] },
		mounts: [{ path: "/project", source: "project-files", ref: "proj-1" }],
	});
	const memorySandboxes = createMemorySandboxes({ workspaces: memoryWorkspaces });
	const workspaces = options.wrapWorkspaces?.(memoryWorkspaces) ?? memoryWorkspaces;
	const sandboxes = options.wrapSandboxes?.(memorySandboxes) ?? memorySandboxes;
	const records: SandboxExecRecord[] = [];
	const env = createSandboxExecutionEnv({
		ctx,
		sessionId: "sess-1",
		workspaceId: record.id,
		sandboxes,
		workspaces,
		...(options.root === undefined ? {} : { root: options.root }),
		onExec: (execRecord) => {
			records.push(execRecord);
		},
	});
	const readHead = async (path: string) => decoder.decode((await memoryWorkspaces.read(ctx, record.id, path)).content);
	const head = async () => (await memoryWorkspaces.get(ctx, record.id)).head;
	return {
		env,
		record,
		records,
		projectFiles,
		workspaces: memoryWorkspaces,
		sandboxes: memorySandboxes,
		readHead,
		head,
	};
}

describe("createSandboxExecutionEnv: files", () => {
	it("names the environment after the workspace and starts at the root", async () => {
		const { env, record } = await setUp();
		expect(env.id).toBe(`harbour:${record.id}`);
		expect(env.cwd).toBe("/workspace");
	});

	it("writes, appends, edits and reads files as commits visible through workspaces.read", async () => {
		const { env, readHead, head } = await setUp();
		const start = await head();

		getOrThrow(await env.writeFile("notes/a.md", "hello", context));
		expect(await head()).toBe(start + 1);
		expect(await readHead("notes/a.md")).toBe("hello");

		getOrThrow(await env.appendFile("notes/a.md", " world", context));
		expect(await head()).toBe(start + 2);
		expect(await readHead("notes/a.md")).toBe("hello world");

		// An edit, as Pi's edit tool makes one: read, replace, write back.
		const before = getOrThrow(await env.readTextFile("/workspace/notes/a.md", context));
		getOrThrow(await env.writeFile("notes/a.md", before.replace("world", "there"), context));
		expect(await head()).toBe(start + 3);
		expect(await readHead("notes/a.md")).toBe("hello there");
		expect(getOrThrow(await env.readTextFile("notes/a.md", context))).toBe("hello there");
		expect(decoder.decode(getOrThrow(await env.readBinaryFile("notes/a.md", context)))).toBe("hello there");

		getOrThrow(await env.truncateFile("notes/a.md", 5, context));
		expect(await readHead("notes/a.md")).toBe("hello");
		getOrThrow(await env.truncateFile("notes/a.md", 7, context));
		expect(await readHead("notes/a.md")).toBe("hello\0\0");

		expect(getOrThrow(await env.fileInfo("notes/a.md", context))).toEqual({
			name: "a.md",
			path: "/workspace/notes/a.md",
			kind: "file",
			size: 7,
			mtimeMs: 0,
		});
		expect(getOrThrow(await env.fileInfo(".", context))).toMatchObject({ path: "/workspace", kind: "directory" });
		expect(getOrThrow(await env.exists("notes/a.md", context))).toBe(true);
		expect(getOrThrow(await env.exists("notes/missing.md", context))).toBe(false);
		expect(getOrThrow(await env.listDir(".", context)).map((entry) => [entry.name, entry.kind, entry.path])).toEqual([
			["docs", "directory", "/workspace/docs"],
			["notes", "directory", "/workspace/notes"],
		]);
		getOrThrow(await env.flushFile("notes/a.md", context));
	});

	it("reads lines like a line reader and through the binary and text readers", async () => {
		const { env } = await setUp();
		getOrThrow(await env.writeFile("lines.txt", "a\nb\nc", context));
		expect(getOrThrow(await env.readTextLines("docs/one.md", undefined, context))).toEqual(["one", "two"]);
		expect(getOrThrow(await env.readTextLines("lines.txt", { maxLines: 2 }, context))).toEqual(["a", "b"]);
		expect(getOrThrow(await env.readTextLines("lines.txt", { maxLines: 0 }, context))).toEqual([]);

		const lines = getOrThrow(await env.openTextLineReader("lines.txt", context));
		expect(getOrThrow(await lines.readLine(context))).toEqual({ text: "a", terminated: true });
		expect(getOrThrow(await lines.readLine(context))).toEqual({ text: "b", terminated: true });
		expect(getOrThrow(await lines.readLine(context))).toEqual({ text: "c", terminated: false });
		expect(getOrThrow(await lines.readLine(context))).toBeUndefined();
		expect(codeOf(await lines.readLine(abortedContext()))).toBe("aborted");
		await lines.close(context);
		expect(codeOf(await lines.readLine(context))).toBe("invalid");

		const binary = getOrThrow(await env.openBinaryReader("lines.txt", undefined, context));
		expect(getOrThrow(await binary.info(context))).toMatchObject({ name: "lines.txt", kind: "file", size: 5 });
		expect(decoder.decode(getOrThrow(await binary.read(2, 1, context)))).toBe("b");
		expect(getOrThrow(await binary.scanLines({ startLine: 1, endLine: 2 }, context))).toMatchObject({
			newlines: 2,
			start: 2,
			end: 3,
		});
		await binary.close(context);
		expect(codeOf(await binary.read(0, 1, context))).toBe("invalid");
	});

	it("pages a directory and refuses missing paths, files and use after close", async () => {
		const { env } = await setUp();
		for (const name of ["a", "b", "c", "d", "e"]) getOrThrow(await env.writeFile(`dir/${name}.txt`, name, context));
		const reader = getOrThrow(await env.openDirReader("dir", context));
		const pages: string[][] = [];
		for (let page = 0; page < 10; page++) {
			const next = getOrThrow(await reader.next(2, context));
			pages.push(next.entries.map((entry) => entry.name));
			if (next.done) break;
		}
		expect(pages).toEqual([["a.txt", "b.txt"], ["c.txt", "d.txt"], ["e.txt"]]);
		expect(getOrThrow(await reader.next(2, context))).toEqual({ entries: [], done: true });
		expect(codeOf(await reader.next(0, context))).toBe("invalid");
		expect(codeOf(await reader.next(1, abortedContext()))).toBe("aborted");
		await reader.close(context);
		expect(codeOf(await reader.next(1, context))).toBe("invalid");

		expect(codeOf(await env.openDirReader("missing", context))).toBe("not_found");
		expect(codeOf(await env.openDirReader("dir/a.txt", context))).toBe("not_directory");
		expect(codeOf(await env.listDir("dir/a.txt", context))).toBe("not_directory");
	});

	it("renames a file or a directory in one commit", async () => {
		const { env, readHead, head } = await setUp();
		getOrThrow(await env.writeFile("dir/a.txt", "a", context));
		getOrThrow(await env.writeFile("dir/sub/b.txt", "b", context));

		let before = await head();
		getOrThrow(await env.renameFile("dir/a.txt", "dir/c.txt", context));
		expect(await head()).toBe(before + 1);
		expect(await readHead("dir/c.txt")).toBe("a");
		expect(getOrThrow(await env.exists("dir/a.txt", context))).toBe(false);

		before = await head();
		getOrThrow(await env.renameFile("dir", "moved", context));
		expect(await head()).toBe(before + 1);
		expect(await readHead("moved/c.txt")).toBe("a");
		expect(await readHead("moved/sub/b.txt")).toBe("b");
		expect(getOrThrow(await env.exists("dir", context))).toBe(false);

		expect(codeOf(await env.renameFile("missing.txt", "other.txt", context))).toBe("not_found");
		expect(codeOf(await env.renameFile("moved", "moved/inner", context))).toBe("invalid");
	});

	it("removes files and directories, honouring recursive and force", async () => {
		const { env, head } = await setUp();
		getOrThrow(await env.writeFile("dir/a.txt", "a", context));
		getOrThrow(await env.writeFile("dir/sub/b.txt", "b", context));

		expect(codeOf(await env.remove("dir", undefined, context))).toBe("is_directory");
		const before = await head();
		getOrThrow(await env.remove("dir", { recursive: true }, context));
		expect(await head()).toBe(before + 1);
		expect(getOrThrow(await env.exists("dir", context))).toBe(false);

		getOrThrow(await env.remove("docs/one.md", undefined, context));
		expect(getOrThrow(await env.exists("docs/one.md", context))).toBe(false);
		expect(codeOf(await env.remove("missing.txt", undefined, context))).toBe("not_found");
		getOrThrow(await env.remove("missing.txt", { force: true }, context));
		expect(codeOf(await env.remove(".", { recursive: true }, context))).toBe("permission_denied");
	});

	it("creates directories without a commit, refusing a file in the way", async () => {
		const { env, head } = await setUp();
		const before = await head();
		getOrThrow(await env.createDir("fresh/deeper", { recursive: true }, context));
		getOrThrow(await env.createDir("docs", undefined, context));
		getOrThrow(await env.createDir(".", undefined, context));
		// Nothing is committed: the environment keeps the directory.
		expect(await head()).toBe(before);
		expect(getOrThrow(await env.exists("fresh/deeper", context))).toBe(true);
		expect(codeOf(await env.createDir("docs/one.md", undefined, context))).toBe("not_directory");
		expect(codeOf(await env.createDir("docs/one.md/inner", undefined, context))).toBe("not_directory");
	});

	it("keeps the directories createDir and createTempDir make until they are removed or moved", async () => {
		const { env, head } = await setUp();
		const before = await head();
		getOrThrow(await env.createDir("fresh/deeper", undefined, context));
		expect(await head()).toBe(before);
		expect(getOrThrow(await env.exists("fresh", context))).toBe(true);
		expect(getOrThrow(await env.fileInfo("fresh/deeper", context))).toEqual({
			name: "deeper",
			path: "/workspace/fresh/deeper",
			kind: "directory",
			size: 0,
			mtimeMs: 0,
		});
		expect(getOrThrow(await env.canonicalPath("fresh/deeper", context))).toBe("/workspace/fresh/deeper");
		expect(getOrThrow(await env.listDir(".", context)).map((entry) => [entry.name, entry.kind])).toEqual([
			["docs", "directory"],
			["fresh", "directory"],
		]);
		expect(getOrThrow(await env.listDir("fresh/deeper", context))).toEqual([]);
		const empty = getOrThrow(await env.openDirReader("fresh/deeper", context));
		expect(getOrThrow(await empty.next(10, context))).toEqual({ entries: [], done: true });
		await empty.close(context);

		// It is a directory, not a file.
		expect(codeOf(await env.readTextFile("fresh", context))).toBe("is_directory");
		expect(codeOf(await env.openBinaryReader("fresh/deeper", undefined, context))).toBe("is_directory");
		expect(codeOf(await env.writeFile("fresh/deeper", "x", context))).toBe("is_directory");
		expect(codeOf(await env.appendFile("fresh/deeper", "x", context))).toBe("is_directory");
		expect(codeOf(await env.truncateFile("fresh/deeper", 0, context))).toBe("is_directory");
		expect(await head()).toBe(before);

		// A file below one makes it a workspace directory, listed once beside the empty one.
		getOrThrow(await env.writeFile("fresh/deeper/a.txt", "a", context));
		getOrThrow(await env.createDir("fresh/other", undefined, context));
		expect(getOrThrow(await env.listDir("fresh", context)).map((entry) => [entry.name, entry.kind])).toEqual([
			["deeper", "directory"],
			["other", "directory"],
		]);
		const reader = getOrThrow(await env.openDirReader("fresh", context));
		const pages: string[][] = [];
		for (let page = 0; page < 10; page++) {
			const next = getOrThrow(await reader.next(1, context));
			if (next.entries.length > 0) pages.push(next.entries.map((entry) => entry.name));
			if (next.done) break;
		}
		await reader.close(context);
		expect(pages).toEqual([["deeper"], ["other"]]);

		// Removed, it is gone; nothing is committed for one with no file below it.
		expect(codeOf(await env.remove("fresh/other", undefined, context))).toBe("is_directory");
		let start = await head();
		getOrThrow(await env.remove("fresh/other", { recursive: true }, context));
		expect(await head()).toBe(start);
		expect(getOrThrow(await env.exists("fresh/other", context))).toBe(false);
		getOrThrow(await env.remove("fresh", { recursive: true }, context));
		expect(await head()).toBe(start + 1);
		expect(getOrThrow(await env.exists("fresh", context))).toBe(false);
		expect(getOrThrow(await env.exists("fresh/deeper", context))).toBe(false);

		// Renamed, it moves with what is below it.
		getOrThrow(await env.createDir("made/inner", undefined, context));
		start = await head();
		getOrThrow(await env.renameFile("made", "moved", context));
		expect(await head()).toBe(start);
		expect(getOrThrow(await env.exists("made", context))).toBe(false);
		expect(getOrThrow(await env.fileInfo("moved/inner", context))).toMatchObject({ kind: "directory" });
		expect(codeOf(await env.renameFile("moved", "/project/moved", context))).toBe("permission_denied");

		const temp = getOrThrow(await env.createTempDir("run-", context));
		expect(getOrThrow(await env.fileInfo(temp, context))).toMatchObject({ path: temp, kind: "directory" });
		const tempReader = getOrThrow(await env.openDirReader(temp, context));
		expect(getOrThrow(await tempReader.next(10, context))).toEqual({ entries: [], done: true });
		await tempReader.close(context);
		expect(await head()).toBe(start);
	});

	it("renames a directory only onto a missing path or an empty directory, and a file onto a file", async () => {
		const { env, head, readHead } = await setUp();
		getOrThrow(await env.writeFile("src/a.txt", "new", context));
		getOrThrow(await env.writeFile("dst/a.txt", "old", context));
		getOrThrow(await env.writeFile("dst/keep.txt", "keep", context));
		getOrThrow(await env.createDir("full/sub", undefined, context));
		const before = await head();
		expect(codeOf(await env.renameFile("src", "dst", context))).toBe("invalid");
		expect(codeOf(await env.renameFile("src", "full", context))).toBe("invalid");
		expect(codeOf(await env.renameFile("src", "docs/one.md", context))).toBe("invalid");
		expect(codeOf(await env.renameFile("src", "src/inner", context))).toBe("invalid");
		expect(codeOf(await env.renameFile("src/a.txt", "dst", context))).toBe("is_directory");
		expect(codeOf(await env.renameFile("src/a.txt", "full", context))).toBe("is_directory");
		expect(await head()).toBe(before);
		expect(await readHead("dst/a.txt")).toBe("old");
		expect(await readHead("src/a.txt")).toBe("new");

		// A directory replaces an empty directory.
		getOrThrow(await env.createDir("empty", undefined, context));
		getOrThrow(await env.renameFile("src", "empty", context));
		expect(await head()).toBe(before + 1);
		expect(await readHead("empty/a.txt")).toBe("new");
		expect(getOrThrow(await env.exists("src", context))).toBe(false);

		// A file replaces a file, as rename(2) does.
		getOrThrow(await env.renameFile("empty/a.txt", "dst/a.txt", context));
		expect(await readHead("dst/a.txt")).toBe("new");
		expect(await readHead("dst/keep.txt")).toBe("keep");
	});

	it("reports reads, stats and listings below a file as not_directory, and exists as false", async () => {
		const { env } = await setUp();
		expect(codeOf(await env.readTextFile("docs/one.md/child", context))).toBe("not_directory");
		expect(codeOf(await env.readBinaryFile("docs/one.md/child", context))).toBe("not_directory");
		expect(codeOf(await env.fileInfo("docs/one.md/child", context))).toBe("not_directory");
		expect(codeOf(await env.listDir("docs/one.md/child", context))).toBe("not_directory");
		expect(codeOf(await env.openDirReader("docs/one.md/child/deeper", context))).toBe("not_directory");
		expect(getOrThrow(await env.exists("docs/one.md/child", context))).toBe(false);
		expect(codeOf(await env.readTextFile("docs/missing/child", context))).toBe("not_found");
		expect(codeOf(await env.fileInfo("missing/child", context))).toBe("not_found");
	});

	it("retries a write on a moved head, deriving the change again from the new head", async () => {
		let sneak = true;
		const { env, readHead } = await setUp({
			wrapWorkspaces: (inner) => ({
				...inner,
				async commit(callCtx, id, request) {
					if (sneak && request.message?.startsWith("append") === true) {
						// Another writer commits between the env reading the head and committing on it.
						sneak = false;
						const { head } = await inner.get(callCtx, id);
						await inner.commit(callCtx, id, {
							baseVersion: head,
							changes: [{ op: "put", path: "log.txt", content: "aX" }],
						});
					}
					return inner.commit(callCtx, id, request);
				},
			}),
		});
		getOrThrow(await env.writeFile("log.txt", "a", context));
		getOrThrow(await env.appendFile("log.txt", "b", context));
		expect(sneak).toBe(false);
		expect(await readHead("log.txt")).toBe("aXb");
	});

	it("keeps temporary files and directories under .tmp in the workspace", async () => {
		const { env, readHead } = await setUp();
		const file = getOrThrow(await env.createTempFile({ prefix: "pi-", suffix: ".log" }, context));
		expect(file).toMatch(/^\/workspace\/\.tmp\/pi-.+\.log$/);
		expect(await readHead(file.slice("/workspace/".length))).toBe("");

		const dir = getOrThrow(await env.createTempDir("run-", context));
		expect(dir).toMatch(/^\/workspace\/\.tmp\/run-.+$/);
		getOrThrow(await env.writeFile(`${dir}/out.txt`, "x", context));
		expect(getOrThrow(await env.readTextFile(`${dir}/out.txt`, context))).toBe("x");
	});

	it("does not support watching", async () => {
		const { env } = await setUp();
		expect(codeOf(await env.watch([{ path: "." }], () => {}, context))).toBe("not_supported");
		await env.cleanup(context);
	});
});

describe("createSandboxExecutionEnv: paths and mounts", () => {
	it("resolves paths against cwd and the root", async () => {
		const { env } = await setUp();
		expect(getOrThrow(await env.absolutePath("notes/../a.txt", context))).toBe("/workspace/a.txt");
		expect(getOrThrow(await env.absolutePath("/workspace", context))).toBe("/workspace");
		expect(getOrThrow(await env.canonicalPath("./docs//one.md", context))).toBe("/workspace/docs/one.md");
		expect(getOrThrow(await env.joinPath(["/workspace", "a", "../b"], context))).toBe("/workspace/b");
		expect(getOrThrow(await env.joinPath(["a", "./b/", "c"], context))).toBe("a/b/c");

		env.cwd = "/workspace/docs";
		expect(getOrThrow(await env.readTextFile("one.md", context))).toBe("one\ntwo\n");
		expect(getOrThrow(await env.absolutePath("one.md", context))).toBe("/workspace/docs/one.md");
		expect(getOrThrow(await env.readTextFile("../../project/README.md", context))).toBe("readme\n");
	});

	it("rejects paths outside the root that are under no mount", async () => {
		const { env, head } = await setUp();
		const before = await head();
		expect(codeOf(await env.readTextFile("/etc/passwd", context))).toBe("permission_denied");
		expect(codeOf(await env.writeFile("../escape.txt", "x", context))).toBe("permission_denied");
		expect(codeOf(await env.absolutePath("..", context))).toBe("permission_denied");
		expect(codeOf(await env.listDir("/", context))).toBe("permission_denied");
		expect(codeOf(await env.renameFile("docs/one.md", "/tmp/one.md", context))).toBe("permission_denied");
		expect(codeOf(await env.exec("true", { cwd: "/tmp" }, context))).toBe("spawn_error");
		expect(await head()).toBe(before);
	});

	it("places the workspace at a configured root", async () => {
		const { env } = await setUp({ root: "/home/agent/" });
		expect(env.cwd).toBe("/home/agent");
		expect(getOrThrow(await env.readTextFile("/home/agent/docs/one.md", context))).toBe("one\ntwo\n");
		expect(getOrThrow(await env.absolutePath("docs", context))).toBe("/home/agent/docs");
		expect(codeOf(await env.readTextFile("/workspace/docs/one.md", context))).toBe("permission_denied");
	});

	it("reads mounts and never writes them, leaving the source unchanged", async () => {
		const { env, projectFiles, head, readHead } = await setUp();
		const version = await projectFiles.latestVersion(ctx, "proj-1");
		const before = await head();

		expect(getOrThrow(await env.readTextFile("/project/README.md", context))).toBe("readme\n");
		expect(
			getOrThrow(await env.listDir("/project", context)).map((entry) => [entry.name, entry.kind, entry.path]),
		).toEqual([
			["README.md", "file", "/project/README.md"],
			["src", "directory", "/project/src"],
		]);
		expect(getOrThrow(await env.fileInfo("/project/src", context))).toMatchObject({ kind: "directory" });
		expect(getOrThrow(await env.exists("/project/missing.md", context))).toBe(false);

		const refused = [
			await env.writeFile("/project/README.md", "x", context),
			await env.writeFile("/project/new.md", "x", context),
			await env.appendFile("/project/README.md", "x", context),
			await env.truncateFile("/project/README.md", 0, context),
			await env.remove("/project/README.md", undefined, context),
			await env.renameFile("/project/README.md", "moved.md", context),
			await env.renameFile("docs/one.md", "/project/one.md", context),
			await env.createDir("/project/new", undefined, context),
		];
		expect(refused.map(codeOf)).toEqual(refused.map(() => "permission_denied"));

		const shell = getOrThrow(await env.exec("printf x > /project/README.md", undefined, context));
		expect(shell.exitCode).not.toBe(0);

		expect(await projectFiles.latestVersion(ctx, "proj-1")).toBe(version);
		expect(decoder.decode(await projectFiles.read(ctx, "proj-1", version, "README.md"))).toBe("readme\n");
		expect(getOrThrow(await env.readTextFile("/project/README.md", context))).toBe("readme\n");
		expect(await readHead("docs/one.md")).toBe("one\ntwo\n");
		expect(await head()).toBe(before);
	});

	it("maps HarbourError codes to FileError codes", async () => {
		let failure: unknown;
		const { env } = await setUp({
			wrapWorkspaces: (inner) => ({
				...inner,
				async read(callCtx, id, path, readOptions) {
					if (failure !== undefined) throw failure;
					return inner.read(callCtx, id, path, readOptions);
				},
			}),
		});
		const cases: readonly (readonly [ErrorCode, string])[] = [
			["not_found", "not_found"],
			["refused", "permission_denied"],
			["forbidden", "permission_denied"],
			["invalid", "invalid"],
			["aborted", "aborted"],
			["unavailable", "unknown"],
			["conflict", "unknown"],
			["expired", "unknown"],
		];
		for (const [code, expected] of cases) {
			failure = new HarbourError(code, `failed with ${code}`);
			expect(codeOf(await env.readTextFile("docs/one.md", context)), code).toBe(expected);
		}
		failure = new Error("not a HarbourError");
		expect(codeOf(await env.readTextFile("docs/one.md", context))).toBe("unknown");
		failure = undefined;

		expect(codeOf(await env.readTextFile("missing.md", context))).toBe("not_found");
		expect(codeOf(await env.readTextFile("docs", context))).toBe("is_directory");
		expect(codeOf(await env.readTextFile(".", context))).toBe("is_directory");
		expect(codeOf(await env.writeFile("docs", "x", context))).toBe("is_directory");
		expect(codeOf(await env.writeFile("docs/one.md/inner", "x", context))).toBe("not_directory");
		expect(codeOf(await env.readTextFile("docs/one.md", abortedContext()))).toBe("aborted");
		expect(codeOf(await env.writeFile("docs/x.md", "x", abortedContext()))).toBe("aborted");
	});
});

describe("createSandboxExecutionEnv: shell", () => {
	it("runs bash on the isolate, and the file it writes is readable through the env", async () => {
		const { env, records, readHead } = await setUp();
		const chunks: [string, string][] = [];
		const onOutput = (text: string, _context: Context, info: { stream: string }) => {
			chunks.push([info.stream, text]);
		};
		const written = getOrThrow(await env.exec("printf hi > notes/a.txt", { onOutput }, context));
		expect(written.exitCode).toBe(0);
		expect(records.at(-1)).toMatchObject({ command: "printf hi > notes/a.txt", cwd: "", tier: "isolate", exitCode: 0 });
		expect(getOrThrow(await env.readTextFile("notes/a.txt", context))).toBe("hi");
		expect(await readHead("notes/a.txt")).toBe("hi");
		expect(chunks).toEqual([]);

		const failed = getOrThrow(await env.exec("echo out && cat missing.txt", { onOutput }, context));
		expect(failed.exitCode).toBe(1);
		expect(chunks).toEqual([
			["stdout", "out\n"],
			["stderr", "cat: missing.txt: No such file or directory\n"],
		]);
	});

	it("routes git --version to the container tier", async () => {
		const { env, records, sandboxes } = await setUp();
		let stdout = "";
		const result = getOrThrow(
			await env.exec(
				"git --version",
				{
					onOutput: (text, _context, info) => {
						if (info.stream === "stdout") stdout += text;
					},
				},
				context,
			),
		);
		expect(result.exitCode).toBe(0);
		expect(stdout).toMatch(/^git version/);
		expect(records.at(-1)).toMatchObject({ command: "git --version", tier: "container" });
		const leases = await sandboxes.leases(ctx, { sessionId: "sess-1", live: true });
		expect(leases.map((lease) => lease.tier)).toEqual(["container"]);
	});

	it("runs commands in cwd, relative to the root", async () => {
		const { env, records } = await setUp();
		let stdout = "";
		const onOutput = (text: string) => {
			stdout += text;
		};
		getOrThrow(await env.exec("ls", { cwd: "docs", onOutput }, context));
		getOrThrow(await env.exec("ls", { cwd: "/workspace/docs", onOutput }, context));
		env.cwd = "/workspace/docs";
		getOrThrow(await env.exec(["ls"], { onOutput }, context));
		expect(stdout).toBe("one.md\none.md\none.md\n");
		expect(records.map((record) => record.cwd)).toEqual(["docs", "docs", "docs"]);
		expect(codeOf(await env.exec("ls", { cwd: "/project" }, context))).toBe("spawn_error");
	});

	it("maps timeout, env and cwd onto the request, and abort and timeout onto ExecutionError codes", async () => {
		const runs: { ctx: CallContext; input: Parameters<Sandboxes["run"]>[1] }[] = [];
		let behaviour: "run" | "stall" | Error = "run";
		const { env, record } = await setUp({
			wrapSandboxes: (inner) => ({
				...inner,
				async run(callCtx, input) {
					runs.push({ ctx: callCtx, input });
					if (behaviour === "run") return inner.run(callCtx, input);
					if (behaviour !== "stall") throw behaviour;
					// A command that never finishes on its own; it stops when the call's signal aborts.
					return new Promise<never>((_resolve, reject) => {
						callCtx.signal?.addEventListener("abort", () => reject(new HarbourError("aborted", "stopped")));
					});
				},
			}),
		});

		getOrThrow(await env.exec("echo hi", { timeout: 2.5, env: { GREETING: "hi" }, cwd: "docs" }, context));
		expect(runs.at(-1)?.input).toEqual({
			sessionId: "sess-1",
			workspaceId: record.id,
			tool: "bash",
			request: { command: "echo hi", cwd: "docs", env: { GREETING: "hi" }, timeoutMs: 2500 },
		});

		behaviour = "stall";
		expect(codeOf(await env.exec("sleep 5", { timeout: 0.05 }, context))).toBe("timeout");
		expect(runs.at(-1)?.ctx.signal?.aborted).toBe(true);

		const controller = new AbortController();
		const running = env.exec("sleep 5", undefined, withAbortSignal(controller.signal, context));
		setTimeout(() => controller.abort(), 20);
		expect(codeOf(await running)).toBe("aborted");
		expect(runs.at(-1)?.ctx.signal?.aborted).toBe(true);

		const calls = runs.length;
		expect(codeOf(await env.exec("echo hi", undefined, abortedContext()))).toBe("aborted");
		expect(runs.length).toBe(calls);

		behaviour = new HarbourError("aborted", "the lease ended");
		expect(codeOf(await env.exec("echo hi", undefined, context))).toBe("aborted");
		behaviour = new HarbourError("unavailable", "no sandbox capacity");
		expect(codeOf(await env.exec("echo hi", undefined, context))).toBe("shell_unavailable");
		behaviour = new HarbourError("forbidden", "not an operator");
		expect(codeOf(await env.exec("echo hi", undefined, context))).toBe("unknown");

		expect(codeOf(await env.exec([], undefined, context))).toBe("spawn_error");
		expect(codeOf(await env.exec("echo hi", { timeout: 0 }, context))).toBe("timeout");
	});

	it("reports a failing onExec as a callback error", async () => {
		const { workspaces, sandboxes, record } = await setUp();
		const env = createSandboxExecutionEnv({
			ctx,
			sessionId: "sess-1",
			workspaceId: record.id,
			sandboxes,
			workspaces,
			onExec: async () => {
				throw new Error("recording failed");
			},
		});
		expect(codeOf(await env.exec("true", undefined, context))).toBe("callback_error");
	});

	it("cleanup stops every command still running, and later commands run as usual", async () => {
		const runs: CallContext[] = [];
		let stall = true;
		const { env } = await setUp({
			wrapSandboxes: (inner) => ({
				...inner,
				async run(callCtx, input) {
					runs.push(callCtx);
					if (!stall) return inner.run(callCtx, input);
					// Never finishes and ignores its signal, like a sandbox that cannot stop a command.
					return new Promise<never>(() => {});
				},
			}),
		});
		const first = env.exec("sleep 5", undefined, context);
		const second = env.exec(["sleep", "5"], { timeout: 60 }, context);
		for (let wait = 0; wait < 200 && runs.length < 2; wait++) await new Promise((resolve) => setTimeout(resolve, 5));
		expect(runs.length).toBe(2);
		await env.cleanup(context);
		expect(codeOf(await first)).toBe("aborted");
		expect(codeOf(await second)).toBe("aborted");
		expect(runs.map((run) => run.signal?.aborted)).toEqual([true, true]);

		stall = false;
		expect(getOrThrow(await env.exec("echo hi", undefined, context)).exitCode).toBe(0);
		expect(runs.at(-1)?.signal?.aborted).toBe(false);
	});

	it("spills output over either threshold to one new file under .tmp, still delivering every chunk", async () => {
		const { env, head, readHead } = await setUp();
		const lines = Array.from({ length: 10 }, (_, index) => `line ${index}\n`).join("");
		getOrThrow(await env.writeFile("big.txt", lines, context));
		let delivered = "";
		const onOutput = (text: string) => {
			delivered += text;
		};

		// At the thresholds, nothing is spilled.
		let before = await head();
		const spill = { afterBytes: lines.length, afterLines: 10 };
		expect(getOrThrow(await env.exec("cat big.txt", { onOutput, spill }, context))).toEqual({ exitCode: 0 });
		expect(await head()).toBe(before);
		expect(delivered).toBe(lines);

		// Over the lines threshold: the complete output is one new file, in one commit.
		delivered = "";
		const overLines = getOrThrow(
			await env.exec("cat big.txt", { onOutput, spill: { afterBytes: 1_000_000, afterLines: 9 } }, context),
		);
		expect(overLines.exitCode).toBe(0);
		expect(overLines.spillPath).toMatch(/^\/workspace\/\.tmp\/pi-output-.+\.log$/);
		expect(await head()).toBe(before + 1);
		expect(await readHead((overLines.spillPath ?? "").slice("/workspace/".length))).toBe(lines);
		expect(delivered).toBe(lines);

		// Over the bytes threshold: stdout then stderr, as delivered.
		before = await head();
		const overBytes = getOrThrow(
			await env.exec("echo out && cat missing.txt", { spill: { afterBytes: 10, afterLines: 1000 } }, context),
		);
		expect(overBytes.exitCode).toBe(1);
		expect(await head()).toBe(before + 1);
		expect(getOrThrow(await env.readTextFile(overBytes.spillPath ?? "", context))).toBe(
			"out\ncat: missing.txt: No such file or directory\n",
		);

		// Without spill options nothing is spilled, however long the output.
		expect(getOrThrow(await env.exec("cat big.txt", undefined, context))).toEqual({ exitCode: 0 });
		expect(await head()).toBe(before + 1);
	});

	it("says when the sandbox truncated the output, in the delivered output and in the spill", async () => {
		const { env } = await setUp({
			wrapSandboxes: (inner) => ({
				...inner,
				async run(callCtx, input) {
					return { ...(await inner.run(callCtx, input)), truncated: true };
				},
			}),
		});
		const chunks: [string, string][] = [];
		const onOutput = (text: string, _context: Context, info: { stream: string }) => {
			chunks.push([info.stream, text]);
		};
		const spill = { afterBytes: 1000, afterLines: 1 };
		const result = getOrThrow(await env.exec("printf partial", { onOutput, spill }, context));
		expect(chunks).toEqual([
			["stdout", "partial"],
			["stderr", "\n[output truncated by the sandbox]\n"],
		]);
		expect(getOrThrow(await env.readTextFile(result.spillPath ?? "", context))).toBe(
			"partial\n[output truncated by the sandbox]\n",
		);

		chunks.length = 0;
		getOrThrow(await env.exec("echo whole", { onOutput }, context));
		expect(chunks).toEqual([
			["stdout", "whole\n"],
			["stderr", "[output truncated by the sandbox]\n"],
		]);
	});

	it("reports a missing argv program as a spawn error, and a string command's 127 as an exit code", async () => {
		const { env, records } = await setUp();
		const chunks: string[] = [];
		const onOutput = (text: string) => {
			chunks.push(text);
		};
		const missing = await env.exec(["no-such-program", "arg"], { onOutput }, context);
		expect(codeOf(missing)).toBe("spawn_error");
		expect(missing.ok ? undefined : missing.error.message).toBe("sh: no-such-program: command not found");
		expect(chunks).toEqual([]);
		expect(records.at(-1)).toMatchObject({ command: ["no-such-program", "arg"], exitCode: 127 });

		const shell = getOrThrow(await env.exec("no-such-program", { onOutput }, context));
		expect(shell.exitCode).toBe(127);
		expect(chunks).toEqual(["sh: no-such-program: command not found\n"]);
	});
});

/**
 * Pi Durable's runner-independent `ExecutionEnv` conformance. Symbolic-link cases are not registered (`symlinks:
 * false`: workspaces have no links) and `listFiles` is not implemented, so its cases are not registered either. Each
 * skipped case, with why:
 */
const SKIPPED: { readonly [name: string]: string } = {
	"watch reports a missing file's creation, changes, replacement and removal": "watch is not supported",
	"watch reports a missing target whose ancestors are created": "watch is not supported",
	"watch follows directories created together with their contents": "watch is not supported",
	"watch keeps watching a path whose parent is renamed and recreated": "watch is not supported",
	"watch skips excluded entries and reports a rename out of them": "watch is not supported",
	"watch keeps recursive coverage where a non-recursive target overlaps": "watch is not supported",
	"watch follows a directory replaced at the same path": "watch is not supported",
	"watch stops reporting once closed": "watch is not supported",
	"argv exec passes arguments to the program without shell parsing":
		"needs a real `sh -c` with positional parameters; the in-memory shell has no `sh` program or expansions",
	"exec reports the stream of every chunk in both forms":
		"needs `sh -c`, `;` and `>&2`, which the in-memory shell does not run",
	"argv exec honors cwd and exit codes": "needs `sh -c` and `;`, which the in-memory shell does not run",
	"windowed exec keeps the exact tail and counts what it skips":
		"needs a `sh -c` while loop with arithmetic, which the in-memory shell does not run",
	"argv exec distinguishes timeout from abort":
		"needs `sh -c 'sleep 2'`; the in-memory shell has no sleep (timeout and abort are covered above with a stalled sandbox)",
};

async function withConformanceEnv(use: (env: ExecutionEnv) => Promise<void>): Promise<void> {
	// A fresh, empty workspace per case, so the env's cwd (the root) is a fresh, empty, writable directory.
	const workspaces = createMemoryWorkspaces();
	const record = await workspaces.create(ctx, { owner: ORG });
	const sandboxes = createMemorySandboxes({ workspaces });
	await use(
		createSandboxExecutionEnv({ ctx, sessionId: "sess-conformance", workspaceId: record.id, sandboxes, workspaces }),
	);
}

registerEnvConformance(
	{
		describe,
		expect,
		it: (name, test, timeoutMs) => (SKIPPED[name] === undefined ? it(name, test, timeoutMs) : it.skip(name, test)),
	},
	"createSandboxExecutionEnv conformance",
	withConformanceEnv,
	{ symlinks: false },
);

describe("the conformance skip list", () => {
	it("names only cases the suite has", () => {
		const names = createEnvConformance({
			assertions: createExpectAssertions(expect),
			withEnv: async () => {},
			symlinks: false,
		}).map((testCase) => testCase.name);
		for (const name of Object.keys(SKIPPED)) expect(names, name).toContain(name);
	});
});

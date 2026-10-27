import { describe, expect, it } from "vitest";
import {
	type DirectoryState,
	entryName,
	fileKind,
	focusAfterRemoval,
	formatBytes,
	isNote,
	nextFocus,
	noteTitle,
	parentPath,
	placeholderPath,
	sortEntries,
	type TreeRow,
	textLines,
	visibleRows,
	type WorkspaceEntry,
} from "./workspace-model.ts";

const file = (path: string, size = 10): WorkspaceEntry => ({ path, kind: "file", size, version: 1 });
const dir = (path: string): WorkspaceEntry => ({ path, kind: "directory", size: 0, version: 1 });
const ready = (...entries: WorkspaceEntry[]): DirectoryState => ({ status: "ready", entries });

const tree = new Map<string, DirectoryState>([
	["", ready(file("README.md", 2048), dir("src"), file("package.json"), dir("docs"))],
	["src", ready(file("src/server.ts"), dir("src/billing"), file("src/app.ts"))],
	["src/billing", ready(file("src/billing/retry.ts"), file("src/billing/idempotency.ts"))],
	["docs", ready(file("docs/runbook.md"))],
]);

const summary = (rows: readonly TreeRow[]) => rows.map((row) => `${row.depth} ${row.kind} ${row.name}`);

describe("entryName and parentPath", () => {
	it("splits relative paths", () => {
		expect(entryName("src/billing/retry.ts")).toBe("retry.ts");
		expect(entryName("README.md")).toBe("README.md");
		expect(parentPath("src/billing/retry.ts")).toBe("src/billing");
		expect(parentPath("README.md")).toBe("");
	});

	it("accepts a leading slash for a mount", () => {
		expect(entryName("/project")).toBe("project");
		expect(entryName("/project/README.md")).toBe("README.md");
		expect(parentPath("/project/README.md")).toBe("/project");
		expect(parentPath("/project")).toBe("");
	});

	it("ignores a trailing slash and handles the root", () => {
		expect(entryName("src/billing/")).toBe("billing");
		expect(parentPath("src/billing/")).toBe("src");
		expect(entryName("")).toBe("");
		expect(parentPath("")).toBe("");
	});
});

describe("sortEntries", () => {
	it("puts directories first, then names case-insensitively in natural order", () => {
		const sorted = sortEntries([
			file("b.ts"),
			dir("zeta"),
			file("A.ts"),
			file("step-10.md"),
			dir("Alpha"),
			file("step-2.md"),
			file("a.ts"),
		]);
		expect(sorted.map((entry) => entry.path)).toEqual([
			"Alpha",
			"zeta",
			"A.ts",
			"a.ts",
			"b.ts",
			"step-2.md",
			"step-10.md",
		]);
	});

	it("doesn't change its input", () => {
		const input = [file("b"), file("a")];
		sortEntries(input);
		expect(input.map((entry) => entry.path)).toEqual(["b", "a"]);
	});
});

describe("visibleRows", () => {
	it("shows only the root's entries while nothing is expanded", () => {
		expect(summary(visibleRows(tree, new Set()))).toEqual([
			"1 directory docs",
			"1 directory src",
			"1 file package.json",
			"1 file README.md",
		]);
	});

	it("flattens nested expanded directories in order", () => {
		const rows = visibleRows(tree, new Set(["src", "src/billing"]));
		expect(summary(rows)).toEqual([
			"1 directory docs",
			"1 directory src",
			"2 directory billing",
			"3 file idempotency.ts",
			"3 file retry.ts",
			"2 file app.ts",
			"2 file server.ts",
			"1 file package.json",
			"1 file README.md",
		]);
		const billing = rows.find((row) => row.path === "src/billing");
		expect(billing).toMatchObject({ setSize: 3, position: 1, state: "ready" });
		expect(rows.find((row) => row.path === "README.md")).toMatchObject({ size: 2048, setSize: 4, position: 4 });
	});

	it("skips an expanded directory whose parent is collapsed", () => {
		expect(summary(visibleRows(tree, new Set(["src/billing"])))).toHaveLength(4);
	});

	it("shows a loading row for an expanded directory that is loading or not yet listed", () => {
		const directories = new Map(tree);
		directories.set("src", { status: "loading" });
		const rows = visibleRows(directories, new Set(["src", "docs/missing"]));
		const loading = rows.find((row) => row.kind === "loading");
		expect(loading).toMatchObject({
			path: placeholderPath("src", "loading"),
			name: "Loading",
			depth: 2,
			parent: "src",
			state: "loading",
		});
		expect(rows.find((row) => row.path === "src")?.state).toBe("loading");

		const unlisted = visibleRows(new Map<string, DirectoryState>([["", ready(dir("lib"))]]), new Set(["lib"]));
		expect(summary(unlisted)).toEqual(["1 directory lib", "2 loading Loading"]);
		expect(unlisted[0]?.state).toBeUndefined();
	});

	it("shows an error row with the message for a directory that failed", () => {
		const directories = new Map(tree);
		directories.set("docs", { status: "error", message: "Couldn't list this folder." });
		const rows = visibleRows(directories, new Set(["docs"]));
		expect(rows[1]).toMatchObject({
			kind: "error",
			name: "Couldn't list this folder.",
			message: "Couldn't list this folder.",
			depth: 2,
			parent: "docs",
		});
	});

	it("says when an expanded directory is empty, and when a listing is truncated", () => {
		const directories = new Map<string, DirectoryState>([
			["", { status: "ready", entries: [dir("empty"), file("a.ts")], truncated: true }],
			["empty", ready()],
		]);
		const rows = visibleRows(directories, new Set(["empty"]));
		expect(summary(rows)).toEqual([
			"1 directory empty",
			"2 empty No files",
			"1 file a.ts",
			"1 truncated Some files are not shown",
		]);
		expect(rows[3]).toMatchObject({ setSize: 3, position: 3, path: placeholderPath("", "truncated") });
	});

	it("returns nothing until the root is ready", () => {
		expect(visibleRows(new Map<string, DirectoryState>(), new Set())).toEqual([]);
		expect(visibleRows(new Map<string, DirectoryState>([["", { status: "loading" }]]), new Set())).toEqual([]);
		const failed = new Map<string, DirectoryState>([["", { status: "error", message: "No" }]]);
		expect(visibleRows(failed, new Set())).toEqual([]);
	});

	it("lists a mount by its absolute path, from another root", () => {
		const directories = new Map<string, DirectoryState>([
			["", ready(dir("/project"), file("notes.md"))],
			["/project", ready(file("/project/README.md"), dir("/project/docs"))],
			["/project/docs", ready(file("/project/docs/guide.md"))],
		]);
		expect(summary(visibleRows(directories, new Set(["/project", "/project/docs"])))).toEqual([
			"1 directory project",
			"2 directory docs",
			"3 file guide.md",
			"2 file README.md",
			"1 file notes.md",
		]);
		expect(summary(visibleRows(directories, new Set(), "/project"))).toEqual(["1 directory docs", "1 file README.md"]);
	});

	it("doesn't recurse into a listing that names its own directory", () => {
		const directories = new Map<string, DirectoryState>([
			["", ready(dir("loop"))],
			["loop", ready(dir("loop"))],
		]);
		expect(summary(visibleRows(directories, new Set(["loop"])))).toEqual(["1 directory loop", "2 directory loop"]);
	});
});

describe("nextFocus", () => {
	const expanded = new Set(["src", "src/billing"]);
	const rows = visibleRows(tree, expanded);
	const move = (from: string | undefined, key: string, open: ReadonlySet<string> = expanded) =>
		nextFocus(rows, from, key, open);

	it("moves down and up a row, staying put at the ends", () => {
		expect(move("docs", "ArrowDown")).toEqual({ type: "focus", path: "src" });
		expect(move("src/billing/retry.ts", "ArrowDown")).toEqual({ type: "focus", path: "src/app.ts" });
		expect(move("README.md", "ArrowDown")).toEqual({ type: "focus", path: "README.md" });
		expect(move("src/app.ts", "ArrowUp")).toEqual({ type: "focus", path: "src/billing/retry.ts" });
		expect(move("docs", "ArrowUp")).toEqual({ type: "focus", path: "docs" });
	});

	it("goes to the first and last rows with Home and End", () => {
		expect(move("src/app.ts", "Home")).toEqual({ type: "focus", path: "docs" });
		expect(move("src/app.ts", "End")).toEqual({ type: "focus", path: "README.md" });
	});

	it("opens a closed directory, or moves into an open one, with ArrowRight", () => {
		expect(move("docs", "ArrowRight")).toEqual({ type: "toggle", path: "docs" });
		expect(move("src", "ArrowRight")).toEqual({ type: "focus", path: "src/billing" });
		expect(move("src/app.ts", "ArrowRight")).toBeUndefined();
	});

	it("closes an open directory, or moves to the parent, with ArrowLeft", () => {
		expect(move("src/billing", "ArrowLeft")).toEqual({ type: "toggle", path: "src/billing" });
		expect(move("src/billing/retry.ts", "ArrowLeft")).toEqual({ type: "focus", path: "src/billing" });
		expect(move("src/app.ts", "ArrowLeft")).toEqual({ type: "focus", path: "src" });
		expect(move("docs", "ArrowLeft")).toBeUndefined();
		expect(move("README.md", "ArrowLeft")).toBeUndefined();
	});

	it("moves from a placeholder row like any other row", () => {
		const directories = new Map(tree);
		directories.set("docs", { status: "loading" });
		const withLoading = visibleRows(directories, new Set(["docs"]));
		const loading = placeholderPath("docs", "loading");
		expect(nextFocus(withLoading, loading, "ArrowLeft", new Set(["docs"]))).toEqual({ type: "focus", path: "docs" });
		expect(nextFocus(withLoading, loading, "ArrowRight", new Set(["docs"]))).toBeUndefined();
		expect(nextFocus(withLoading, "docs", "ArrowRight", new Set(["docs"]))).toEqual({ type: "focus", path: loading });
	});

	it("starts at the first row without a current one, and ignores other keys", () => {
		expect(move(undefined, "ArrowDown")).toEqual({ type: "focus", path: "docs" });
		expect(move("gone.ts", "ArrowUp")).toEqual({ type: "focus", path: "docs" });
		expect(move("src", "Enter")).toBeUndefined();
		expect(move("src", "a")).toBeUndefined();
		expect(nextFocus([], undefined, "ArrowDown", expanded)).toBeUndefined();
	});
});

describe("formatBytes", () => {
	it("says bytes under a kilobyte", () => {
		expect(formatBytes(0)).toBe("0 bytes");
		expect(formatBytes(1)).toBe("1 byte");
		expect(formatBytes(812)).toBe("812 bytes");
		expect(formatBytes(1023)).toBe("1023 bytes");
	});

	it("uses one decimal under 10 and none above", () => {
		expect(formatBytes(1024)).toBe("1 KB");
		expect(formatBytes(1229)).toBe("1.2 KB");
		expect(formatBytes(48 * 1024 + 300)).toBe("48 KB");
		expect(formatBytes(3.4 * 1024 * 1024)).toBe("3.4 MB");
		expect(formatBytes(16 * 1024 * 1024)).toBe("16 MB");
		expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.5 GB");
	});

	it("moves up a unit rather than say 1024", () => {
		expect(formatBytes(1024 * 1024 - 1)).toBe("1 MB");
	});

	it("treats nonsense as nothing", () => {
		expect(formatBytes(-5)).toBe("0 bytes");
		expect(formatBytes(Number.NaN)).toBe("0 bytes");
	});
});

describe("fileKind, isNote and noteTitle", () => {
	it("tells notes, images, binaries and text apart by extension", () => {
		expect(fileKind("README.md")).toBe("markdown");
		expect(fileKind("/project/docs/guide.markdown")).toBe("markdown");
		expect(fileKind("notes/Plan.MDX")).toBe("markdown");
		expect(fileKind("logo.png")).toBe("image");
		expect(fileKind("icons/close.svg")).toBe("image");
		expect(fileKind("release.tar.gz")).toBe("binary");
		expect(fileKind("fonts/Inter.woff2")).toBe("binary");
		expect(fileKind("src/app.ts")).toBe("text");
		expect(fileKind("Makefile")).toBe("text");
		expect(fileKind(".gitignore")).toBe("text");
	});

	it("knows a note and its title", () => {
		expect(isNote("notes/release-notes.md")).toBe(true);
		expect(isNote("src/app.ts")).toBe(false);
		expect(noteTitle("notes/release-notes.md")).toBe("release-notes");
		expect(noteTitle("/project/README.markdown")).toBe("README");
		expect(noteTitle("src/app.ts")).toBe("app.ts");
		expect(noteTitle(".md")).toBe(".md");
	});
});

describe("textLines", () => {
	it("splits on any line break and doesn't count a final one as a line", () => {
		expect(textLines("")).toEqual([]);
		expect(textLines("one")).toEqual(["one"]);
		expect(textLines("one\ntwo\n")).toEqual(["one", "two"]);
		expect(textLines("one\r\ntwo\rthree")).toEqual(["one", "two", "three"]);
		expect(textLines("one\n\n")).toEqual(["one", ""]);
		expect(textLines("\n")).toEqual([""]);
	});
});

describe("focusAfterRemoval", () => {
	const open = new Set(["docs"]);
	const loading = new Map(tree).set("docs", { status: "loading" });
	const before = visibleRows(loading, open);
	const placeholder = placeholderPath("docs", "loading");

	it("moves from a Loading row to the first file that arrives", () => {
		expect(focusAfterRemoval(before, visibleRows(tree, open), placeholder)).toBe("docs/runbook.md");
	});

	it("moves to the directory when its listing failed or came back empty", () => {
		const failed = new Map(tree).set("docs", { status: "error", message: "No access" });
		expect(focusAfterRemoval(before, visibleRows(failed, open), placeholder)).toBe(placeholderPath("docs", "error"));
		const empty = new Map(tree).set("docs", ready());
		expect(focusAfterRemoval(before, visibleRows(empty, open), placeholder)).toBe(placeholderPath("docs", "empty"));
		expect(focusAfterRemoval(before, visibleRows(tree, new Set()), placeholder)).toBe("docs");
	});

	it("takes the row now in a root row's place", () => {
		const rows = visibleRows(tree, new Set());
		const without = new Map(tree).set("", ready(file("README.md", 2048), dir("src"), file("package.json")));
		expect(focusAfterRemoval(rows, visibleRows(without, new Set()), "docs")).toBe("src");
	});
});

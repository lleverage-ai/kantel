// Pure helpers for the workspace components (FileTree, FileViewer, NoteViewer): names and parents of paths, the order
// a directory lists in, the rows an expanded tree shows, tree keyboard moves, what kind a file is and how big it is.
//
// Paths are the workspace read API's: the root directory is "", entries are relative ("src/app.ts"), and a read-only
// mount appears at an absolute mount point ("/project", "/project/README.md"). @harbour/ui doesn't depend on
// @harbour/contracts, so the entry type here is declared structurally: a contracts `FileEntry` is a `WorkspaceEntry`.

export type WorkspaceEntryKind = "file" | "directory";

/** One file or directory in a listing. Structurally compatible with `FileEntry` from @harbour/contracts. */
export type WorkspaceEntry = {
	/** The full path from the workspace root: "src/app.ts", or "/project/README.md" under a mount. */
	readonly path: string;
	readonly kind: WorkspaceEntryKind;
	/** Bytes; 0 for directories. */
	readonly size: number;
	/** Hex SHA-256 of the content, for files. */
	readonly digest?: string;
	/** The version that last changed this path. */
	readonly version?: number | string;
};

/** What the host knows about one directory's listing. The tree reads one of these per directory path. */
export type DirectoryState =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly message: string }
	| {
			readonly status: "ready";
			readonly entries: readonly WorkspaceEntry[];
			/** The listing stopped at a page limit: more entries exist than are shown. */
			readonly truncated?: boolean;
	  };

/** Rows the tree shows in place of a directory's children: while it loads, when it failed, when it has none. */
export type TreePlaceholderKind = "loading" | "error" | "empty" | "truncated";

export type TreeRowKind = WorkspaceEntryKind | TreePlaceholderKind;

/** One visible row of the tree, in display order. */
export type TreeRow = {
	/**
	 * The entry's path. A placeholder row's path is its directory's path, a double slash and its kind ("src//loading"),
	 * which no normalised path can be, so every row's path is unique and can key it.
	 */
	readonly path: string;
	/** What the row says: the entry's name, "Loading", an error's message. */
	readonly name: string;
	readonly kind: TreeRowKind;
	/** 1 for the root's children, as `aria-level`. */
	readonly depth: number;
	/** Bytes, for a file; 0 otherwise. */
	readonly size: number;
	/** How many rows share this row's parent, for `aria-setsize`. */
	readonly setSize: number;
	/** This row's place among them, from 1, for `aria-posinset`. */
	readonly position: number;
	/** A directory's listing status, absent before it is first listed. A loading or error row's own status. */
	readonly state?: DirectoryState["status"];
	/** An error row's message. */
	readonly message?: string;
	/** A placeholder row's directory. */
	readonly parent?: string;
};

function trimTrailingSlashes(path: string): string {
	let end = path.length;
	while (end > 0 && path[end - 1] === "/") end--;
	return path.slice(0, end);
}

/** The last segment of a path: "app.ts" for "src/app.ts", "project" for "/project". "" for the root. */
export function entryName(path: string): string {
	const trimmed = trimTrailingSlashes(path);
	return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** The directory a path is in: "src" for "src/app.ts", "/project" for "/project/README.md", "" for a top-level path. */
export function parentPath(path: string): string {
	const trimmed = trimTrailingSlashes(path);
	const slash = trimmed.lastIndexOf("/");
	return slash <= 0 ? "" : trimmed.slice(0, slash);
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Directories first, then by name, case-insensitive and with numbers in number order ("step-2" before "step-10"). */
export function compareEntries(a: WorkspaceEntry, b: WorkspaceEntry): number {
	if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
	const byName = collator.compare(entryName(a.path), entryName(b.path));
	if (byName !== 0) return byName;
	return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** A sorted copy of a listing: directories first, then by name. Doesn't change its input. */
export function sortEntries<T extends WorkspaceEntry>(entries: readonly T[]): T[] {
	return [...entries].sort(compareEntries);
}

const placeholderNames: Record<Exclude<TreePlaceholderKind, "error">, string> = {
	loading: "Loading",
	empty: "No files",
	truncated: "Some files are not shown",
};

/** The path a placeholder row for `directory` gets. */
export function placeholderPath(directory: string, kind: TreePlaceholderKind): string {
	return `${directory}//${kind}`;
}

function placeholder(directory: string, state: DirectoryState | undefined, depth: number): TreeRow {
	const shared = { size: 0, depth, setSize: 1, position: 1, parent: directory };
	if (state === undefined || state.status === "loading") {
		return {
			...shared,
			path: placeholderPath(directory, "loading"),
			name: placeholderNames.loading,
			kind: "loading",
			state: "loading",
		};
	}
	if (state.status === "error") {
		return {
			...shared,
			path: placeholderPath(directory, "error"),
			name: state.message,
			kind: "error",
			state: "error",
			message: state.message,
		};
	}
	return { ...shared, path: placeholderPath(directory, "empty"), name: placeholderNames.empty, kind: "empty" };
}

/**
 * The rows an expanded tree shows, in order: each listed directory's entries sorted, and under each expanded
 * directory its children, or one placeholder row while it loads (also when it has no state yet), when it failed
 * (the message) or when it is empty. A truncated listing ends with a "Some files are not shown" row. Nothing while
 * the root itself isn't ready: the tree shows its own loading, error and empty states for that.
 */
export function visibleRows(
	directories: ReadonlyMap<string, DirectoryState>,
	expanded: ReadonlySet<string>,
	root = "",
): TreeRow[] {
	const rows: TreeRow[] = [];
	const rootState = directories.get(root);
	if (rootState?.status !== "ready") return rows;

	const walk = (
		directory: string,
		listing: Extract<DirectoryState, { status: "ready" }>,
		depth: number,
		ancestors: ReadonlySet<string>,
	): void => {
		const entries = sortEntries(listing.entries);
		const truncated = listing.truncated === true;
		const setSize = entries.length + (truncated ? 1 : 0);
		entries.forEach((entry, index) => {
			const state = entry.kind === "directory" ? directories.get(entry.path) : undefined;
			rows.push({
				path: entry.path,
				name: entryName(entry.path) || entry.path,
				kind: entry.kind,
				depth,
				size: entry.kind === "file" ? entry.size : 0,
				setSize,
				position: index + 1,
				...(state === undefined ? {} : { state: state.status }),
			});
			// A listing that names its own directory or an ancestor would recurse forever: show it, don't open it.
			if (entry.kind !== "directory" || !expanded.has(entry.path) || ancestors.has(entry.path)) return;
			if (state?.status === "ready" && (state.entries.length > 0 || state.truncated === true)) {
				walk(entry.path, state, depth + 1, new Set([...ancestors, entry.path]));
			} else {
				rows.push(placeholder(entry.path, state, depth + 1));
			}
		});
		if (truncated) {
			rows.push({
				path: placeholderPath(directory, "truncated"),
				name: placeholderNames.truncated,
				kind: "truncated",
				depth,
				size: 0,
				setSize,
				position: setSize,
				parent: directory,
			});
		}
	};

	walk(root, rootState, 1, new Set([root]));
	return rows;
}

/** What a key does in the tree: move focus to a row, or open or close a directory. */
export type TreeMove =
	| { readonly type: "focus"; readonly path: string }
	| { readonly type: "toggle"; readonly path: string };

/**
 * The WAI-ARIA tree pattern's arrow keys, over the visible rows. ArrowDown and ArrowUp move one row (staying put at
 * the ends), Home and End go to the first and last row. ArrowRight opens a closed directory, or moves into an open
 * one's first child. ArrowLeft closes an open directory, or moves to the row's parent. Returns undefined when the key
 * does nothing here, so the caller leaves the event alone. With no current row, the first row takes focus.
 */
export function nextFocus(
	rows: readonly TreeRow[],
	currentPath: string | undefined,
	key: string,
	expanded: ReadonlySet<string>,
): TreeMove | undefined {
	const first = rows[0];
	const last = rows[rows.length - 1];
	if (first === undefined || last === undefined) return undefined;
	const index = currentPath === undefined ? -1 : rows.findIndex((row) => row.path === currentPath);
	const row = rows[index];
	const focus = (target: TreeRow): TreeMove => ({ type: "focus", path: target.path });
	switch (key) {
		case "Home":
			return focus(first);
		case "End":
			return focus(last);
		case "ArrowDown":
			return focus(rows[index + 1] ?? last);
		case "ArrowUp": {
			const previous = index <= 0 ? undefined : rows[index - 1];
			return focus(previous ?? first);
		}
		case "ArrowRight": {
			if (row === undefined) return focus(first);
			if (row.kind !== "directory") return undefined;
			if (!expanded.has(row.path)) return { type: "toggle", path: row.path };
			const child = rows[index + 1];
			return child !== undefined && child.depth > row.depth ? focus(child) : undefined;
		}
		case "ArrowLeft": {
			if (row === undefined) return focus(first);
			if (row.kind === "directory" && expanded.has(row.path)) return { type: "toggle", path: row.path };
			for (let at = index - 1; at >= 0; at--) {
				const candidate = rows[at];
				if (candidate !== undefined && candidate.depth < row.depth) return focus(candidate);
			}
			return undefined;
		}
		default:
			return undefined;
	}
}

/**
 * Where focus goes when the focused row is gone, such as a "Loading" row once its listing arrives: the first child of
 * the directory it was under, if that is open with rows, or else the directory itself; for a row at the root, the
 * row now in its place. `previous` is the rows the path was in.
 */
export function focusAfterRemoval(
	previous: readonly TreeRow[],
	next: readonly TreeRow[],
	path: string,
): string | undefined {
	const index = previous.findIndex((row) => row.path === path);
	const gone = previous[index];
	if (gone === undefined) return next[0]?.path;
	for (let at = index - 1; at >= 0; at--) {
		const parent = previous[at];
		if (parent === undefined || parent.depth >= gone.depth) continue;
		const found = next.findIndex((row) => row.path === parent.path);
		if (found === -1) break;
		const child = next[found + 1];
		return child !== undefined && child.depth > parent.depth ? child.path : parent.path;
	}
	return (next[Math.min(index, next.length - 1)] ?? next[0])?.path;
}

/** How a file is best shown: rendered as a note, as text, as an image, or not at all. */
export type WorkspaceFileKind = "markdown" | "text" | "image" | "binary";

const markdownExtensions = new Set(["md", "markdown", "mdx"]);
const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);
const binaryExtensions = new Set([
	"zip",
	"gz",
	"tgz",
	"bz2",
	"xz",
	"zst",
	"7z",
	"rar",
	"tar",
	"jar",
	"pdf",
	"exe",
	"dll",
	"so",
	"dylib",
	"bin",
	"o",
	"a",
	"class",
	"pyc",
	"wasm",
	"woff",
	"woff2",
	"ttf",
	"otf",
	"eot",
	"mp3",
	"mp4",
	"m4a",
	"mov",
	"wav",
	"ogg",
	"webm",
	"sqlite",
	"db",
	"lockb",
]);

/** The lower-case extension of a path's name, "" when it has none ("Makefile", ".gitignore"). */
export function fileExtension(path: string): string {
	const name = entryName(path);
	const dot = name.lastIndexOf(".");
	return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * How a file is best shown, by its extension: Markdown (.md, .markdown, .mdx), an image, a known binary format, or
 * text, which is everything else, including names with no extension. A guess for choosing a viewer: the host still
 * shows "binary" when the content turns out not to be text.
 */
export function fileKind(path: string): WorkspaceFileKind {
	const ext = fileExtension(path);
	if (markdownExtensions.has(ext)) return "markdown";
	if (imageExtensions.has(ext)) return "image";
	if (binaryExtensions.has(ext)) return "binary";
	return "text";
}

/** Whether a path is a note, shown with NoteViewer: .md, .markdown or .mdx. */
export function isNote(path: string): boolean {
	return fileKind(path) === "markdown";
}

/** A note's title: its file name without the Markdown extension ("release-notes" for "notes/release-notes.md"). */
export function noteTitle(path: string): string {
	const name = entryName(path) || path;
	const dot = name.lastIndexOf(".");
	return dot > 0 && markdownExtensions.has(name.slice(dot + 1).toLowerCase()) ? name.slice(0, dot) : name;
}

const byteUnits = ["KB", "MB", "GB", "TB"] as const;

/**
 * A size for people: "0 bytes", "1 byte", "812 bytes", "1.2 KB", "48 KB", "3.4 MB". Binary units (1 KB is 1,024
 * bytes), one decimal under 10 and none above, a trailing ".0" dropped.
 */
export function formatBytes(bytes: number): string {
	const whole = Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0;
	if (whole < 1024) return whole === 1 ? "1 byte" : `${whole} bytes`;
	let value = whole / 1024;
	let unit = 0;
	while (value >= 1024 && unit < byteUnits.length - 1) {
		value /= 1024;
		unit++;
	}
	let text = value < 10 ? value.toFixed(1) : String(Math.round(value));
	// 1023.6 KB rounds to 1024 KB: say 1 MB instead.
	if (text === "1024" && unit < byteUnits.length - 1) {
		unit++;
		text = "1";
	}
	return `${text.replace(/\.0$/, "")} ${byteUnits[unit] ?? "TB"}`;
}

/** The most lines FileViewer renders; past this it shows the first ones and says how many more there are. */
export const fileViewerLineCap = 5000;

/**
 * A text's lines, split at "\n", "\r\n" or "\r". A final line break ends the last line rather than starting an
 * empty one, as editors number them. "" has no lines.
 */
export function textLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split(/\r\n|\r|\n/);
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

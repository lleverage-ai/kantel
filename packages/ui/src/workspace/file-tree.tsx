import {
	type CSSProperties,
	type FocusEvent,
	type KeyboardEvent,
	memo,
	type ReactNode,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { ChevronRightIcon, FileIcon, XCircleIcon } from "../primitives/icons.tsx";
import { Skeleton, Spinner } from "../primitives/spinner.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import {
	type DirectoryState,
	focusAfterRemoval,
	formatBytes,
	nextFocus,
	type TreeRow,
	visibleRows,
} from "./workspace-model.ts";
import "./file-tree.css";

export type FileTreeProps = {
	/** The tree's accessible name: "Files", "Project files". */
	label: string;
	/** Every listing the host has, by directory path ("" is the root). A directory with no entry here shows as loading. */
	directories: ReadonlyMap<string, DirectoryState>;
	/** The open directories, by path. The tree is controlled: `onToggle` asks the host to change this. */
	expanded: ReadonlySet<string>;
	/** The file being shown, if any. */
	selectedPath?: string | undefined;
	/** Open or close a directory. The host lists a directory it opens for the first time. */
	onToggle: (path: string) => void;
	/** Called with a file's path when it is chosen by click, Enter or Space. */
	onSelect?: ((path: string) => void) | undefined;
	/** A link for each file; files become links when given, so they open in a new tab with the browser's own gestures. */
	hrefFor?: ((path: string) => string) | undefined;
	/** Replaces the default empty state, for a root that is listed and has nothing in it. */
	empty?: ReactNode;
	/** The directory the tree starts at. Default "", the workspace root; "/project" shows only the project mount. */
	root?: string | undefined;
};

/** The parts of a click the tree reads; a React mouse event has them all. */
type Click = {
	currentTarget: HTMLElement;
	button: number;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	shiftKey: boolean;
};

type TreeItemProps = {
	row: TreeRow;
	expanded: boolean;
	selected: boolean;
	tabbable: boolean;
	href: string | undefined;
	onClick: (event: Click) => void;
	onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
	onFocus: (event: FocusEvent<HTMLElement>) => void;
};

function leadFor(kind: TreeRow["kind"]): ReactNode {
	switch (kind) {
		case "directory":
			return <ChevronRightIcon size="sm" className="hb-file-tree-chevron" />;
		case "file":
			return <FileIcon size="sm" />;
		case "loading":
			return <Spinner size="sm" />;
		case "error":
			return <XCircleIcon size="sm" />;
		default:
			return null;
	}
}

/**
 * One row of the tree. A file with a link is the link itself, so the row is one element and one focus stop; every
 * other row is a div. Rows are memoised: moving focus re-renders the two rows whose tab stop changed.
 */
const TreeItem = memo(
	function TreeItem({ row, expanded, selected, tabbable, href, onClick, onKeyDown, onFocus }: TreeItemProps) {
		const isEntry = row.kind === "file" || row.kind === "directory";
		const className = `hb-file-tree-item hb-file-tree-${row.kind} hb-focusable${selected ? " hb-file-tree-selected" : ""}`;
		const style = { "--hb-file-tree-depth": row.depth - 1 } as CSSProperties;
		const body = (
			<>
				<span className="hb-file-tree-lead">{leadFor(row.kind)}</span>
				<span className="hb-file-tree-text">
					<span className="hb-file-tree-name" title={row.name}>
						{row.name}
					</span>
					{row.kind === "file" ? <span className="hb-file-tree-size">{formatBytes(row.size)}</span> : null}
				</span>
			</>
		);
		if (row.kind === "file" && href !== undefined) {
			return (
				<a
					href={href}
					role="treeitem"
					aria-level={row.depth}
					aria-setsize={row.setSize}
					aria-posinset={row.position}
					aria-selected={selected}
					tabIndex={tabbable ? 0 : -1}
					className={className}
					style={style}
					data-path={row.path}
					onClick={onClick}
					onKeyDown={onKeyDown}
					onFocus={onFocus}
				>
					{body}
				</a>
			);
		}
		return (
			<div
				role="treeitem"
				aria-level={row.depth}
				aria-setsize={row.setSize}
				aria-posinset={row.position}
				aria-selected={isEntry ? selected : undefined}
				aria-expanded={row.kind === "directory" ? expanded : undefined}
				tabIndex={tabbable ? 0 : -1}
				className={className}
				style={style}
				data-path={row.path}
				onClick={onClick}
				onKeyDown={onKeyDown}
				onFocus={onFocus}
			>
				{body}
			</div>
		);
	},
	(before, after) =>
		before.expanded === after.expanded &&
		before.selected === after.selected &&
		before.tabbable === after.tabbable &&
		before.href === after.href &&
		before.onClick === after.onClick &&
		before.onKeyDown === after.onKeyDown &&
		before.onFocus === after.onFocus &&
		sameRow(before.row, after.row),
);

/** Rows are rebuilt whenever the tree's input changes; a row whose fields are the same needn't render again. */
function sameRow(a: TreeRow, b: TreeRow): boolean {
	return (
		a === b ||
		(a.path === b.path &&
			a.name === b.name &&
			a.kind === b.kind &&
			a.depth === b.depth &&
			a.size === b.size &&
			a.setSize === b.setSize &&
			a.position === b.position &&
			a.state === b.state)
	);
}

const skeletonRows = [
	{ id: "a", depth: 0, width: "44%" },
	{ id: "b", depth: 0, width: "36%" },
	{ id: "c", depth: 1, width: "58%" },
	{ id: "d", depth: 1, width: "48%" },
	{ id: "e", depth: 1, width: "64%" },
	{ id: "f", depth: 0, width: "40%" },
	{ id: "g", depth: 0, width: "52%" },
];

function TreeSkeleton() {
	return (
		<div className="hb-file-tree" aria-busy="true">
			<span className="hb-sr-only">Loading files</span>
			{skeletonRows.map((row) => (
				<div
					key={row.id}
					className="hb-file-tree-skeleton-row"
					style={{ "--hb-file-tree-depth": row.depth } as CSSProperties}
				>
					<Skeleton width={row.width} />
				</div>
			))}
		</div>
	);
}

/**
 * A workspace's files as a WAI-ARIA tree: directories open and close in place, files are chosen (or followed, as
 * links). Read-only and presentational: the host lists directories through the workspace read API and passes every
 * listing it has in `directories`, keyed by path; the tree asks for changes through `onToggle` and `onSelect`.
 *
 * The root's own states replace the tree: placeholder rows while it lists, a notice when it failed, an empty state
 * when it has no files. A directory listing inline shows a "Loading" row under it, and one that failed a quiet error
 * row with the message.
 *
 * Keyboard: one Tab stop (the last focused row, else the selected file, else the first row). Up and Down move a row,
 * Home and End to the ends, Right opens a directory or moves into it, Left closes it or moves to the parent, Enter
 * and Space open a directory or choose a file.
 */
export function FileTree({
	label,
	directories,
	expanded,
	selectedPath,
	onToggle,
	onSelect,
	hrefFor,
	empty,
	root = "",
}: FileTreeProps) {
	const rows = useMemo(() => visibleRows(directories, expanded, root), [directories, expanded, root]);
	const paths = useMemo(() => new Set(rows.map((row) => row.path)), [rows]);
	const [focusedPath, setFocusedPath] = useState<string>();
	const treeRef = useRef<HTMLDivElement>(null);
	// The handlers read the latest props through a ref, so they keep one identity and the memoised rows stay put.
	const latest = useRef({ rows, expanded, onToggle, onSelect });
	latest.current = { rows, expanded, onToggle, onSelect };

	const focusPath = useCallback((path: string) => {
		setFocusedPath(path);
		for (const element of treeRef.current?.querySelectorAll<HTMLElement>("[data-path]") ?? []) {
			if (element.dataset.path === path) {
				element.focus();
				return;
			}
		}
	}, []);

	const onClick = useCallback((event: Click) => {
		const path = event.currentTarget.dataset.path;
		const row = latest.current.rows.find((candidate) => candidate.path === path);
		if (row === undefined) return;
		if (row.kind === "directory") {
			latest.current.onToggle(row.path);
			return;
		}
		if (row.kind !== "file") return;
		// A link opened in a new tab or window doesn't change what this page shows.
		const elsewhere = event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
		if (event.currentTarget instanceof HTMLAnchorElement && elsewhere) return;
		latest.current.onSelect?.(row.path);
	}, []);

	const onKeyDown = useCallback(
		(event: KeyboardEvent<HTMLElement>) => {
			if (event.altKey || event.ctrlKey || event.metaKey) return;
			const target = event.currentTarget;
			const path = target.dataset.path;
			if (path === undefined) return;
			const current = latest.current;
			if (event.key === "Enter" || event.key === " ") {
				const row = current.rows.find((candidate) => candidate.path === path);
				if (row?.kind === "directory") {
					event.preventDefault();
					current.onToggle(path);
				} else if (row?.kind === "file") {
					// Enter follows a link by itself (and its click selects); Space would scroll the page instead.
					if (target instanceof HTMLAnchorElement) {
						if (event.key === " ") {
							event.preventDefault();
							target.click();
						}
					} else {
						event.preventDefault();
						current.onSelect?.(path);
					}
				}
				return;
			}
			const move = nextFocus(current.rows, path, event.key, current.expanded);
			if (move === undefined) return;
			event.preventDefault();
			if (move.type === "toggle") current.onToggle(move.path);
			else focusPath(move.path);
		},
		[focusPath],
	);

	const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
		const path = event.currentTarget.dataset.path;
		if (path !== undefined) setFocusedPath(path);
	}, []);

	// When the focused row goes, as a "Loading" row does once its listing arrives, focus moves to the row that takes its
	// place, so the arrow keys keep working. Only when the tree had focus: it never takes focus from anything else.
	// Whether it had focus is read before the rows change, since a removed element's focus falls to the body.
	const hadFocus = useRef(false);
	const previousRows = useRef(rows);
	if (previousRows.current !== rows) {
		const active = typeof document === "undefined" ? null : document.activeElement;
		hadFocus.current = active !== null && treeRef.current?.contains(active) === true;
	}
	useLayoutEffect(() => {
		const previous = previousRows.current;
		previousRows.current = rows;
		if (previous === rows || focusedPath === undefined || paths.has(focusedPath)) return;
		const replacement = focusAfterRemoval(previous, rows, focusedPath);
		const active = document.activeElement;
		const lost = active === null || active === document.body;
		if (replacement !== undefined && hadFocus.current && lost) focusPath(replacement);
		else setFocusedPath(replacement);
	}, [rows, paths, focusedPath, focusPath]);

	const rootState = directories.get(root);
	if (rootState === undefined || rootState.status === "loading") return <TreeSkeleton />;
	if (rootState.status === "error") {
		return (
			<div className="hb-file-tree">
				<Notice level="error">{rootState.message}</Notice>
			</div>
		);
	}
	if (rows.length === 0) {
		return <div className="hb-file-tree">{empty ?? <EmptyState title="This workspace has no files yet" />}</div>;
	}

	const tabStop =
		focusedPath !== undefined && paths.has(focusedPath)
			? focusedPath
			: selectedPath !== undefined && paths.has(selectedPath)
				? selectedPath
				: rows[0]?.path;

	return (
		<div ref={treeRef} role="tree" aria-label={label} className="hb-file-tree">
			{rows.map((row) => (
				<TreeItem
					key={row.path}
					row={row}
					expanded={row.kind === "directory" && expanded.has(row.path)}
					selected={row.path === selectedPath}
					tabbable={row.path === tabStop}
					href={row.kind === "file" ? hrefFor?.(row.path) : undefined}
					onClick={onClick}
					onKeyDown={onKeyDown}
					onFocus={onFocus}
				/>
			))}
		</div>
	);
}

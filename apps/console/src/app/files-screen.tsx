import {
	Badge,
	Button,
	type DirectoryState,
	EmptyState,
	FilePreview,
	FileTree,
	Notice,
	parentPath,
	Spinner,
	saveFile,
} from "@harbour/ui";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConsoleClient, WorkspaceFiles } from "../api/client.ts";
import {
	ancestorsOf,
	contentOf,
	entryFor,
	previewOfPath,
	shouldRead,
	siblingsOf,
	worthPrefetching,
} from "../ui/files-model.ts";
import { createPreviewCache, usePreviewContent } from "../ui/preview-cache.ts";
import { filesPath, navigate, sessionPath } from "./router.ts";

// A session's workspace, read-only: the file tree beside the open file on a desktop, one at a time on a phone. Every
// read is a GET on the workspace read API through `ConsoleClient.workspace`, which has nothing that writes or starts a
// sandbox. The tree and the file preview are @harbour/ui's (the preview the same panel the session opens files in);
// this file only fetches and lays them out. Files read are kept while the screen is open, so going back to one, or
// Previous and Next through a folder, shows it at once.

type WorkspaceState =
	| { readonly status: "loading" }
	| { readonly status: "none" }
	| { readonly status: "error"; readonly message: string }
	| { readonly status: "ready"; readonly files: WorkspaceFiles };

const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
/** One message in place of the tree or the file, centred. */
const MESSAGE = "grid h-full place-items-center p-4";

/** The session's workspace, or why there isn't one. */
function useWorkspace(client: ConsoleClient, sessionId: string): WorkspaceState {
	const [state, setState] = useState<WorkspaceState>({ status: "loading" });
	useEffect(() => {
		let live = true;
		setState({ status: "loading" });
		client.workspace(sessionId).then(
			(files) => live && setState(files === undefined ? { status: "none" } : { status: "ready", files }),
			(reason: unknown) => live && setState({ status: "error", message: messageOf(reason) }),
		);
		return () => {
			live = false;
		};
	}, [client, sessionId]);
	return state;
}

/** The listings the tree has, and a way to list a directory once (again after a failure). */
function useDirectories(files: WorkspaceFiles | undefined) {
	const [directories, setDirectories] = useState<ReadonlyMap<string, DirectoryState>>(new Map());
	const asked = useRef(new Set<string>());
	const controller = useRef(new AbortController());
	useEffect(() => {
		if (files === undefined) return;
		const current = new AbortController();
		controller.current = current;
		asked.current = new Set();
		setDirectories(new Map());
		return () => current.abort();
	}, [files]);

	const list = useCallback(
		(path: string) => {
			if (files === undefined || asked.current.has(path)) return;
			asked.current.add(path);
			const signal = controller.current.signal;
			const set = (state: DirectoryState) => {
				if (!signal.aborted) setDirectories((previous) => new Map(previous).set(path, state));
			};
			set({ status: "loading" });
			files.list(path, signal).then(
				({ entries, truncated }) => set({ status: "ready", entries, truncated }),
				(reason: unknown) => {
					// A failed listing may be asked for again, by closing and opening its directory.
					asked.current.delete(path);
					set({ status: "error", message: messageOf(reason) });
				},
			);
		},
		[files],
	);
	return { directories, list };
}

export function FilesScreen({
	client,
	projectId,
	sessionId,
	project,
	path,
	narrow,
}: {
	client: ConsoleClient;
	projectId: string;
	sessionId: string;
	project?: string | undefined;
	/** The open file, if any. */
	path?: string | undefined;
	/** A phone: the tree or the file, not both. */
	narrow: boolean;
}) {
	const workspace = useWorkspace(client, sessionId);
	const files = workspace.status === "ready" ? workspace.files : undefined;
	const { directories, list } = useDirectories(files);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

	// The root, and every directory above the open file, opened and listed.
	useEffect(() => {
		if (files === undefined) return;
		list("");
		if (path === undefined) return;
		const above = ancestorsOf(path, parentPath).filter((directory) => directory !== "");
		for (const directory of above) list(directory);
		setExpanded((previous) =>
			above.every((directory) => previous.has(directory)) ? previous : new Set([...previous, ...above]),
		);
	}, [files, path, list]);

	const onToggle = useCallback(
		(directory: string) => {
			setExpanded((previous) => {
				const next = new Set(previous);
				if (next.has(directory)) next.delete(directory);
				else next.add(directory);
				return next;
			});
			list(directory);
		},
		[list],
	);

	const listing = path === undefined ? undefined : directories.get(parentPath(path));
	const entry =
		path === undefined ? undefined : entryFor(listing?.status === "ready" ? listing.entries : undefined, path);
	const cache = useMemo(
		() =>
			files === undefined
				? undefined
				: createPreviewCache(
						(file: string, signal) => files.read(file, signal),
						(file) => file,
						{
							nameOf: (file: string) => file.slice(file.lastIndexOf("/") + 1),
						},
					),
		[files],
	);
	const reading = path !== undefined && shouldRead(path, entry) ? path : undefined;
	const read = usePreviewContent(cache, reading);
	const preview = useMemo(() => (path === undefined ? undefined : previewOfPath(path, entry)), [path, entry]);
	const content = path === undefined || reading !== undefined ? read : contentOf(path, entry, undefined);
	const siblings = useMemo(() => siblingsOf(listing?.status === "ready" ? listing.entries : undefined), [listing]);
	// The files either side are read once this one has arrived, so Previous and Next show theirs at once.
	useEffect(() => {
		if (cache === undefined || path === undefined || content.status !== "ready") return;
		const at = siblings.findIndex((file) => file.key === path);
		const entries = listing?.status === "ready" ? listing.entries : [];
		for (const near of [siblings[at + 1], siblings[at - 1]]) {
			const nearEntry = near === undefined ? undefined : entryFor(entries, near.path);
			if (nearEntry !== undefined && worthPrefetching(nearEntry)) cache.load(nearEntry.path);
		}
	}, [cache, path, content.status, siblings, listing]);
	const download = useMemo(
		() =>
			content.status !== "ready" || preview === undefined || content.bytes.byteLength === 0
				? undefined
				: () => saveFile(content.bytes, preview.name, content.contentType || "application/octet-stream"),
		[content, preview],
	);

	const toSession = () => navigate(sessionPath(projectId, sessionId));
	const toTree = () => navigate(filesPath(projectId, sessionId));
	const hrefFor = useCallback((file: string) => filesPath(projectId, sessionId, file), [projectId, sessionId]);
	const onSelect = useCallback(
		(file: string) => navigate(filesPath(projectId, sessionId, file)),
		[projectId, sessionId],
	);

	const fileOpen = path !== undefined;
	const pane = narrow ? (fileOpen ? "file" : "tree") : "both";
	// On a phone the open file's viewer has its own Back, to the tree; until it is on screen the header is the way out.
	const header = !(pane === "file" && files !== undefined);
	const rootFailed = directories.get("")?.status === "error";

	let body: ReactNode;
	if (workspace.status === "loading") {
		body = (
			<div className={MESSAGE}>
				<Spinner label="Opening the workspace" />
			</div>
		);
	} else if (workspace.status === "error") {
		body = (
			<div className={MESSAGE}>
				<Notice level="error">{workspace.message}</Notice>
			</div>
		);
	} else if (workspace.status === "none") {
		body = (
			<div className={MESSAGE}>
				<EmptyState title="This session has no workspace">
					A session started with a workspace shows its files here.
				</EmptyState>
			</div>
		);
	} else {
		body = (
			<div
				className={`grid flex-1 min-h-0 ${pane === "both" ? "grid-cols-[var(--hb-sidebar-width)_minmax(0,1fr)]" : "grid-cols-[minmax(0,1fr)]"}`}
			>
				{pane === "file" ? null : (
					<div className={`min-h-0 py-2 px-1.5 overflow-y-auto ${pane === "both" ? "border-r border-border" : ""}`}>
						<FileTree
							label="Files"
							directories={directories}
							expanded={expanded}
							selectedPath={path}
							onToggle={onToggle}
							onSelect={onSelect}
							hrefFor={hrefFor}
						/>
						{rootFailed ? (
							<div className="flex py-2 px-1.5">
								<Button size="sm" onClick={() => list("")}>
									Try again
								</Button>
							</div>
						) : null}
					</div>
				)}
				{pane === "tree" ? null : (
					<div className="min-w-0 min-h-0">
						{preview === undefined ? (
							<div className={MESSAGE}>
								<EmptyState title="No file open">Pick a file to read it.</EmptyState>
							</div>
						) : null}
						<FilePreview
							layout="docked"
							file={preview}
							content={content}
							onClose={toTree}
							siblings={siblings}
							onNavigate={(next) => navigate(filesPath(projectId, sessionId, next.path), { replace: true })}
							onDownload={download}
							onBack={narrow ? toTree : undefined}
						/>
					</div>
				)}
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full" data-pane={pane}>
			{!header ? (
				<h1 className="hb-sr-only">Files</h1>
			) : (
				<div
					className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 min-h-[calc(var(--hb-control-md)+var(--hb-step-2)*2)] pt-[max(var(--hb-step-2),env(safe-area-inset-top))] pb-2 border-b border-border ${narrow ? "px-3" : "px-4"}`}
				>
					<Button variant="ghost" size="sm" onClick={toSession}>
						Back to the session
					</Button>
					<h1 className="m-0 text-md font-strong leading-tight">Files</h1>
					{project === undefined ? null : <span className="text-muted text-xs">{project}</span>}
					<Badge>Read-only</Badge>
				</div>
			)}
			{body}
		</div>
	);
}

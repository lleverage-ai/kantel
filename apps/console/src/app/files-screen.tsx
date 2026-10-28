import {
	Badge,
	Button,
	type DirectoryState,
	EmptyState,
	FileTree,
	FileViewer,
	NoteViewer,
	Notice,
	parentPath,
	Spinner,
} from "@harbour/ui";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConsoleClient, WorkspaceFiles } from "../api/client.ts";
import { ancestorsOf, entryFor, type FileRead, isImageType, mediaType, shouldRead, viewOf } from "../ui/files-model.ts";
import { filesPath, navigate, sessionPath } from "./router.ts";

// A session's workspace, read-only: the file tree beside the open file on a desktop, one at a time on a phone. Every
// read is a GET on the workspace read API through `ConsoleClient.workspace`, which has nothing that writes or starts a
// sandbox. The tree, the file viewer and the note viewer are @harbour/ui's; this file only fetches and lays them out.

type WorkspaceState =
	| { readonly status: "loading" }
	| { readonly status: "none" }
	| { readonly status: "error"; readonly message: string }
	| { readonly status: "ready"; readonly files: WorkspaceFiles };

const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));
const codeOf = (reason: unknown) =>
	typeof reason === "object" && reason !== null && "code" in reason ? String(reason.code) : "unavailable";

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

/** The open file's bytes, read once per file, or nothing for a file that isn't asked for. */
function useFileRead(files: WorkspaceFiles | undefined, path: string | undefined, read: boolean): FileRead | undefined {
	const [state, setState] = useState<{ path: string; read: FileRead }>();
	useEffect(() => {
		if (files === undefined || path === undefined || !read) return;
		const controller = new AbortController();
		setState({ path, read: { status: "loading" } });
		files.read(path, controller.signal).then(
			(file) => !controller.signal.aborted && setState({ path, read: { status: "ready", file } }),
			(reason: unknown) =>
				!controller.signal.aborted &&
				setState({ path, read: { status: "error", code: codeOf(reason), message: messageOf(reason) } }),
		);
		return () => controller.abort();
	}, [files, path, read]);
	return state !== undefined && state.path === path && read ? state.read : undefined;
}

/**
 * An object URL for an image the content route returned, made from the bytes already read (so the console's own
 * credentials and recorded sources work alike), and revoked when the file changes or the screen goes.
 */
function useImageUrl(read: FileRead | undefined): string | undefined {
	const file = read?.status === "ready" && isImageType(read.file.contentType) ? read.file : undefined;
	const [made, setMade] = useState<{ readonly file: object; readonly url: string }>();
	useEffect(() => {
		if (file === undefined) return;
		const url = URL.createObjectURL(
			new Blob([file.content as Uint8Array<ArrayBuffer>], { type: mediaType(file.contentType) }),
		);
		setMade({ file, url });
		return () => URL.revokeObjectURL(url);
	}, [file]);
	return made !== undefined && made.file === file ? made.url : undefined;
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
	const read = useFileRead(files, path, path !== undefined && shouldRead(path, entry));
	const imageSrc = useImageUrl(read);
	const view = useMemo(
		() => (path === undefined ? undefined : viewOf(path, entry, read, imageSrc)),
		[path, entry, read, imageSrc],
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
			<div className="files-message">
				<Spinner label="Opening the workspace" />
			</div>
		);
	} else if (workspace.status === "error") {
		body = (
			<div className="files-message">
				<Notice level="error">{workspace.message}</Notice>
			</div>
		);
	} else if (workspace.status === "none") {
		body = (
			<div className="files-message">
				<EmptyState title="This session has no workspace">
					A session started with a workspace shows its files here.
				</EmptyState>
			</div>
		);
	} else {
		body = (
			<div className="files-body">
				{pane === "file" ? null : (
					<div className="files-tree">
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
							<div className="files-retry">
								<Button size="sm" onClick={() => list("")}>
									Try again
								</Button>
							</div>
						) : null}
					</div>
				)}
				{pane === "tree" ? null : (
					<div className="files-viewer">
						{view === undefined || path === undefined ? (
							<div className="files-message">
								<EmptyState title="No file open">Pick a file to read it.</EmptyState>
							</div>
						) : view.viewer === "note" ? (
							<NoteViewer path={path} state={view.state} onBack={narrow ? toTree : undefined} />
						) : (
							<FileViewer path={path} state={view.state} onBack={narrow ? toTree : undefined} />
						)}
					</div>
				)}
			</div>
		);
	}

	return (
		<div className="files" data-pane={pane}>
			{!header ? (
				<h1 className="hb-sr-only">Files</h1>
			) : (
				<div className="files-header">
					<Button variant="ghost" size="sm" onClick={toSession}>
						Back to the session
					</Button>
					<h1 className="files-title">Files</h1>
					{project === undefined ? null : <span className="files-meta">{project}</span>}
					<Badge>Read-only</Badge>
				</div>
			)}
			{body}
		</div>
	);
}

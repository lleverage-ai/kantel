// A sandbox's or a snapshot's files as a file browser (compute console): one folder at a time in dense rows, folders
// first, with the path as breadcrumbs and Up over them, and the file picked in the preview beside the list (in its
// place on a phone). Where the browser is (the folder, and the file open in it) is the host's to keep, in the address
// on the console, so Back, Forward and links work.
//
// Everything is read on demand through the `source` the host binds: a folder's entries when it opens, and a file's
// first part only when it's picked, the next on Load more. Nothing is read ahead, and a file the preview can't show (a
// binary, by its name or its bytes) is read no further. Stories bind the source to fixtures.

import { type MouseEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { FilePreview, type FilePreviewBody } from "../preview/file-preview.tsx";
import { Breadcrumbs, type Crumb } from "../primitives/breadcrumbs.tsx";
import { Button, buttonClass, buttonLabelClass, IconButton } from "../primitives/button.tsx";
import { fileTypeIcon } from "../primitives/file-icons.ts";
import { PageHeader } from "../primitives/form-layout.tsx";
import { compactAge } from "../primitives/format.ts";
import { useLoad } from "../primitives/load.ts";
import { FolderUpIcon, LucideFolderIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Notice } from "../primitives/surface.tsx";
import {
	bytesText,
	DeviceSetupError,
	type FilePart,
	type FileRange,
	FileTooLargeError,
	type SandboxFolder,
	type SnapshotEntry,
} from "./compute-model.ts";
import { messageOf, None, table, tableFrame, td, th } from "./parts.tsx";

/** Where the browser is: the open folder from the root, with no leading slash ("" is the root), and its open file. */
export interface FilesAt {
	readonly path: string;
	/** The name of the file open in the preview, in that folder. */
	readonly file?: string;
}

/** What the browser reads, on demand. */
export interface FilesSource {
	/** A folder's entries, or a running sandbox's folder, which says when it has more than Kantel read. */
	list(id: string, path: string): Promise<readonly SnapshotEntry[] | SandboxFolder>;
	/** A part of a file. */
	read(id: string, path: string, range: FileRange): Promise<FilePart>;
	/** A link to download a file or folder (a tarball), or undefined where there is none. */
	downloadUrl?(id: string, path: string): string | undefined;
}

export interface SnapshotFilesProps {
	readonly source: FilesSource;
	/** The snapshot's ID, or a running sandbox's. */
	readonly snapshotId: string;
	/**
	 * What the snapshot is called, as the heading: a saved snapshot's name, or a sandbox's and when it was taken. None
	 * under a sandbox page's tabs, where the page says whose files they are.
	 */
	readonly label?: string;
	/** The line under the heading. */
	readonly lede?: string;
	readonly at: FilesAt;
	readonly now: number;
	/** Says where the back button goes: "Back to saved snapshots". No back button without `onBack`. */
	readonly backLabel?: string;
	readonly onBack?: () => void;
	/** Opens a folder, or a file in the preview, or closes it. */
	readonly onNavigate: (at: FilesAt) => void;
	/** The address of a place in the browser, so its folders and files are links. */
	readonly href?: (at: FilesAt) => string;
}

/** How much of a file the preview reads at a time, and the most it reads before leaving the rest to Download. */
export const PREVIEW_PART_BYTES = 256 * 1024;
export const PREVIEW_MAX_BYTES = 4 * 1024 * 1024;
/** Download reads a file in parts of the API's largest, up to this much. */
const DOWNLOAD_PART_BYTES = 1024 * 1024;
export const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024;

/** Files the preview doesn't read at all: images, archives, media, fonts, binaries and databases. */
const BINARY_EXTENSIONS = new Set(
	(
		"png jpg jpeg gif webp bmp ico tif tiff avif heic psd pdf zip gz tgz bz2 xz zst 7z rar tar jar war whl deb rpm " +
		"wasm so dylib dll exe bin o a class pyc node mp3 mp4 m4a mov avi mkv webm wav flac ogg ttf otf woff woff2 " +
		"sqlite sqlite3 db iso dmg img qcow2 raw"
	).split(" "),
);

/** A file the preview leaves alone by its name. */
export function binaryByName(name: string): boolean {
	const dot = name.lastIndexOf(".");
	return dot > 0 && BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * The text of a file's first bytes, or undefined for a binary (a NUL, or bytes that aren't UTF-8). Short of the whole
 * file, a character cut off at the end waits for the next part.
 */
export function textOf(bytes: Uint8Array, whole: boolean): string | undefined {
	if (bytes.includes(0)) return undefined;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: !whole });
	} catch {
		return undefined;
	}
}

/** Folders first, then files, by name. */
export function sortEntries(entries: readonly SnapshotEntry[]): SnapshotEntry[] {
	return [...entries].sort((a, b) =>
		a.kind === b.kind ? a.name.localeCompare(b.name, "en-GB") : a.kind === "folder" ? -1 : 1,
	);
}

/** The folder above `path`; the root's is itself. */
export const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

const isFolder = (value: readonly SnapshotEntry[] | SandboxFolder): value is SandboxFolder => !Array.isArray(value);

const join = (folder: string, name: string): string => (folder === "" ? name : `${folder}/${name}`);

/** A primary click on a link the browser follows itself; any other is left to the browser (a new tab). */
const follow = (event: MouseEvent, go: () => void) => {
	if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	event.preventDefault();
	go();
};

export function SnapshotFiles({
	source,
	snapshotId,
	label,
	lede = "The files as they were when this snapshot was taken.",
	at,
	now,
	backLabel,
	onBack,
	onNavigate,
	href,
}: SnapshotFilesProps) {
	const { path } = at;
	const { state, reload } = useLoad(() => source.list(snapshotId, path), [source, snapshotId, path]);
	const folder: SandboxFolder | undefined =
		state.status !== "ready" ? undefined : isFolder(state.value) ? state.value : { entries: state.value, more: false };
	const entries = folder === undefined ? undefined : sortEntries(folder.entries);
	const openEntry =
		at.file === undefined ? undefined : entries?.find((entry) => entry.kind === "file" && entry.name === at.file);
	// A file named in the address opens at once, before its folder is read (and where the folder doesn't list it).
	const open: SnapshotEntry | undefined =
		at.file === undefined ? undefined : (openEntry ?? { name: at.file, path: join(path, at.file), kind: "file" });
	const folderHref = source.downloadUrl?.(snapshotId, path);

	const segments = path === "" ? [] : path.split("/");
	const place = (to: string) => ({
		key: to,
		...(href === undefined ? {} : { href: href({ path: to }) }),
		onSelect: () => onNavigate({ path: to }),
	});
	const parents: Crumb[] =
		segments.length === 0
			? []
			: [
					{ ...place(""), label: "Root" },
					...segments.slice(0, -1).map((segment, index) => ({
						...place(segments.slice(0, index + 1).join("/")),
						label: segment,
					})),
				];

	const opened = open !== undefined;
	return (
		<>
			{onBack === undefined ? null : (
				<div>
					<button
						type="button"
						onClick={onBack}
						className="kt-focusable m-0 cursor-pointer rounded-xs border-0 bg-transparent p-0 text-xs text-muted hover:text-fg hover:underline"
					>
						{backLabel ?? "Back"}
					</button>
				</div>
			)}
			{label === undefined ? null : <PageHeader title={label} lede={lede} />}
			<div className="grid min-w-0 items-start gap-3 lg:grid-cols-2">
				<div className={`flex min-w-0 flex-col gap-2 ${opened ? "max-lg:hidden" : "lg:col-span-2"}`}>
					<div className="flex min-h-control-md min-w-0 items-center gap-1.5">
						<IconButton
							variant="ghost"
							size="sm"
							label="Up"
							title="Up a folder"
							icon={<FolderUpIcon />}
							disabled={segments.length === 0}
							onClick={() => onNavigate({ path: parentOf(path) })}
							className="-ml-1"
						/>
						<Breadcrumbs
							label="Folder"
							parents={parents}
							current={<span className="truncate">{segments.at(-1) ?? "Root"}</span>}
						/>
						{folderHref === undefined ? null : (
							<a
								className={`${buttonClass("ghost", "sm")} no-underline`}
								href={folderHref}
								download
								title="Download this folder as a tarball"
							>
								<span className={buttonLabelClass}>Download</span>
							</a>
						)}
					</div>
					{state.status === "error" && state.error instanceof DeviceSetupError ? (
						<p className="m-0 px-3 py-2 text-sm text-muted">{state.error.message}</p>
					) : state.status === "error" ? (
						<Notice
							level="error"
							action={
								<Button size="xs" onClick={reload}>
									Try again
								</Button>
							}
						>
							{messageOf(state.error, "Kantel couldn't read this folder.")}
						</Notice>
					) : entries === undefined ? (
						<div className="px-3 py-2" aria-busy="true">
							<span className="kt-sr-only">Loading the folder</span>
							<Skeleton width="40%" />
						</div>
					) : entries.length === 0 ? (
						<p className="m-0 px-3 py-2 text-sm text-muted">Empty folder.</p>
					) : (
						<EntryList
							entries={entries}
							open={open?.name}
							now={now}
							href={href === undefined ? undefined : (entry) => href(atOf(entry))}
							onOpen={(entry) => onNavigate(atOf(entry))}
						/>
					)}
					{folder?.more === true ? (
						<p className="m-0 text-xs text-muted">The first {entries?.length.toLocaleString("en")} only.</p>
					) : null}
				</div>
				{open === undefined ? null : (
					<FileView
						key={`${snapshotId}:${open.path}`}
						entry={open}
						source={source}
						snapshotId={snapshotId}
						onClose={() => onNavigate({ path })}
					/>
				)}
			</div>
		</>
	);
}

/** Where opening an entry goes: into a folder, or its file in the preview. */
const atOf = (entry: SnapshotEntry): FilesAt =>
	entry.kind === "folder" ? { path: entry.path } : { path: parentOf(entry.path), file: entry.name };

/**
 * The folder's entries as dense rows in the console's table style: the icon and name, the size and when it changed.
 * One line each at any width; on a phone the time folds away, and the size sits beside the name. Never cards.
 */
function EntryList({
	entries,
	open,
	now,
	href,
	onOpen,
}: {
	entries: readonly SnapshotEntry[];
	open: string | undefined;
	now: number;
	href: ((entry: SnapshotEntry) => string) | undefined;
	onOpen: (entry: SnapshotEntry) => void;
}) {
	return (
		<div className={tableFrame}>
			<table className={`${table} table-fixed`}>
				<thead>
					<tr>
						<th className={th} scope="col">
							Name
						</th>
						<th className={`${th} w-20 text-right`} scope="col">
							Size
						</th>
						<th className={`${th} w-20 text-right max-sm:hidden`} scope="col">
							Modified
						</th>
					</tr>
				</thead>
				<tbody>
					{entries.map((entry) => {
						const current = entry.kind === "file" && entry.name === open;
						const Icon = entry.kind === "folder" ? LucideFolderIcon : fileTypeIcon({ name: entry.name, type: "" });
						const name: ReactNode = (
							<>
								<span className="flex flex-none text-muted">
									<Icon size="sm" />
								</span>
								<span className="min-w-0 truncate">{entry.name}</span>
							</>
						);
						// The name covers its row, so the whole row opens it.
						const opener =
							"kt-focusable flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-xs text-left text-fg no-underline before:absolute before:inset-0";
						return (
							<tr
								key={entry.path}
								className={`relative ${current ? "bg-selected" : "hover:bg-hover"}`}
								data-entry={entry.path}
								data-row={current ? "selected" : undefined}
							>
								<td className={`${td} max-w-0 py-1`}>
									{href === undefined ? (
										<button
											type="button"
											className={opener}
											onClick={() => onOpen(entry)}
											{...(entry.kind === "file" ? { "aria-pressed": current } : {})}
										>
											{name}
										</button>
									) : (
										<a
											className={opener}
											href={href(entry)}
											onClick={(event) => follow(event, () => onOpen(entry))}
											{...(current ? { "aria-current": "true" } : {})}
										>
											{name}
										</a>
									)}
								</td>
								<td className={`${td} py-1 text-right text-muted tabular-nums`}>
									{entry.sizeBytes === undefined || entry.kind === "folder" ? <None /> : bytesText(entry.sizeBytes)}
								</td>
								<td className={`${td} py-1 text-right text-muted tabular-nums max-sm:hidden`}>
									{entry.modifiedAt === undefined ? <None /> : compactAge(entry.modifiedAt, now)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

type Reading =
	| { readonly status: "loading" }
	| { readonly status: "error"; readonly error: unknown }
	/** No preview: a binary, or a file too big to read here (`tooLarge`: nor to download). */
	| { readonly status: "none"; readonly size?: number; readonly tooLarge?: boolean }
	| {
			readonly status: "text";
			readonly bytes: Uint8Array;
			readonly text: string;
			readonly size: number;
			readonly more: "idle" | "loading" | "done";
	  };

/**
 * A file's preview, read a part at a time: the first when it opens, the next on Load more, up to PREVIEW_MAX_BYTES.
 * A file that turns out not to be text is read no further.
 */
export function useFileReading(
	source: Pick<FilesSource, "read">,
	id: string,
	entry: Pick<SnapshotEntry, "name" | "path" | "sizeBytes">,
) {
	const [reading, setReading] = useState<Reading>({ status: "loading" });
	const [attempt, setAttempt] = useState(0);
	const latest = useRef(reading);
	latest.current = reading;
	const live = useRef(true);
	useEffect(() => {
		live.current = true;
		return () => {
			live.current = false;
		};
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is Try again.
	useEffect(() => {
		let current = true;
		if (binaryByName(entry.name)) {
			setReading({ status: "none", ...(entry.sizeBytes === undefined ? {} : { size: entry.sizeBytes }) });
			return;
		}
		setReading({ status: "loading" });
		source.read(id, entry.path, { offset: 0, length: PREVIEW_PART_BYTES }).then(
			(part) => {
				if (current) setReading(readingOf(part.bytes, part.size));
			},
			(error: unknown) => {
				if (!current) return;
				if (error instanceof FileTooLargeError) {
					const size = error.size ?? entry.sizeBytes;
					setReading({ status: "none", tooLarge: true, ...(size === undefined ? {} : { size }) });
				} else setReading({ status: "error", error });
			},
		);
		return () => {
			current = false;
		};
	}, [source, id, entry.path, entry.name, attempt]);

	const more = useCallback(() => {
		const now = latest.current;
		if (now.status !== "text" || now.more !== "idle") return;
		setReading({ ...now, more: "loading" });
		source.read(id, entry.path, { offset: now.bytes.byteLength, length: PREVIEW_PART_BYTES }).then(
			(part) => {
				if (!live.current || latest.current.status !== "text" || latest.current.bytes !== now.bytes) return;
				const bytes = new Uint8Array(now.bytes.byteLength + part.bytes.byteLength);
				bytes.set(now.bytes);
				bytes.set(part.bytes, now.bytes.byteLength);
				const next = readingOf(bytes, part.size);
				// Text that stops being text further on: what was shown stays, and no more is read.
				setReading(next.status === "text" ? next : { ...now, more: "done" });
			},
			() => {
				if (live.current) setReading({ ...now, more: "idle" });
			},
		);
	}, [source, id, entry.path]);

	return { reading, more, retry: () => setAttempt((value) => value + 1) };
}

function readingOf(bytes: Uint8Array, size: number): Reading {
	const whole = bytes.byteLength >= size;
	const text = textOf(bytes, whole);
	if (text === undefined) return { status: "none", size };
	return {
		status: "text",
		bytes,
		text,
		size,
		more: whole || bytes.byteLength >= PREVIEW_MAX_BYTES ? "done" : "idle",
	};
}

/** Reads a whole file in parts and saves it, as Download does; at most DOWNLOAD_MAX_BYTES. */
export async function readWhole(source: Pick<FilesSource, "read">, id: string, path: string): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	let offset = 0;
	let size = Number.POSITIVE_INFINITY;
	while (offset < size) {
		const part = await source.read(id, path, { offset, length: DOWNLOAD_PART_BYTES });
		size = part.size;
		if (size > DOWNLOAD_MAX_BYTES) throw new Error(`At ${bytesText(size)}, it's too big to download here.`);
		if (part.bytes.byteLength === 0) break;
		parts.push(part.bytes);
		offset += part.bytes.byteLength;
	}
	const whole = new Uint8Array(offset);
	let at = 0;
	for (const part of parts) {
		whole.set(part, at);
		at += part.byteLength;
	}
	return whole;
}

function saveBytes(bytes: Uint8Array, name: string): void {
	const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.rel = "noopener";
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The file picked, in the preview. */
function FileView({
	entry,
	source,
	snapshotId,
	onClose,
}: {
	entry: SnapshotEntry;
	source: FilesSource;
	snapshotId: string;
	onClose: () => void;
}) {
	const { reading, more, retry } = useFileReading(source, snapshotId, entry);
	const [downloading, setDownloading] = useState<"idle" | "busy" | Error>("idle");
	const href = source.downloadUrl?.(snapshotId, entry.path);
	const size = entry.sizeBytes ?? (reading.status === "text" || reading.status === "none" ? reading.size : undefined);
	const download = () => {
		setDownloading("busy");
		readWhole(source, snapshotId, entry.path).then(
			(bytes) => {
				saveBytes(bytes, entry.name);
				setDownloading("idle");
			},
			(error: unknown) =>
				setDownloading(error instanceof Error ? error : new Error("Kantel couldn't download this file.")),
		);
	};
	const body: FilePreviewBody =
		downloading instanceof Error
			? { status: "error", message: downloading.message, onRetry: () => setDownloading("idle") }
			: reading.status === "loading"
				? { status: "loading" }
				: reading.status === "error" && reading.error instanceof DeviceSetupError
					? { status: "error", message: reading.error.message }
					: reading.status === "error"
						? { status: "error", message: messageOf(reading.error, "Kantel couldn't read this file."), onRetry: retry }
						: reading.status === "none"
							? { status: "none" }
							: {
									status: "text",
									text: reading.text,
									shown: reading.bytes.byteLength,
									size: reading.size,
									...(reading.more === "done" ? {} : { onMore: more, loadingMore: reading.more === "loading" }),
								};
	const tooBig =
		(size !== undefined && size > DOWNLOAD_MAX_BYTES) || (reading.status === "none" && reading.tooLarge === true);
	return (
		<FilePreview
			name={entry.name}
			path={`/${entry.path}`}
			{...(size === undefined ? {} : { size })}
			body={body}
			{...(href !== undefined
				? { downloadHref: href }
				: tooBig
					? {}
					: { onDownload: download, downloading: downloading === "busy" })}
			onClose={onClose}
			onBack={onClose}
			className="max-h-160 lg:sticky lg:top-0"
		/>
	);
}

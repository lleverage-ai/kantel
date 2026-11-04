// A snapshot's files (compute console, experimental): one folder at a time, folders first, with breadcrumbs back up
// the path, and the file picked beside the list (below it on a phone) in the theme's syntax colours. A file Kantel
// can't show (a binary, or one too big) and the open folder (as a tarball) have a Download link. Every read goes
// through the `SnapshotsSource` the host binds; stories bind it to fixtures.

import { useState } from "react";
import { Code, languageForPath } from "../code/code.tsx";
import { Breadcrumbs, type Crumb } from "../primitives/breadcrumbs.tsx";
import { Button, buttonClass, buttonLabelClass } from "../primitives/button.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { compactAge } from "../primitives/format.ts";
import { FileIcon, FolderIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { bytesText, type SandboxFolder, type SnapshotEntry, type SnapshotsSource } from "./compute-model.ts";
import { cellSub, messageOf, None, rowHover, TableFrame, table, tableFrame, td, th } from "./parts.tsx";

export interface SnapshotFilesProps {
	/** A folder's entries, or a running sandbox's folder, which says when it has more than Kantel read. */
	readonly source: Pick<SnapshotsSource, "read" | "downloadUrl"> & {
		list(snapshotId: string, path: string): Promise<readonly SnapshotEntry[] | SandboxFolder>;
	};
	readonly snapshotId: string;
	/**
	 * What the snapshot is called, as the heading: a saved snapshot's name, or a sandbox's and when it was taken. None
	 * under a sandbox page's tabs, where the page says whose files they are.
	 */
	readonly label?: string;
	/** The line under the heading. */
	readonly lede?: string;
	/** The open folder from the snapshot's root, with no leading slash; "" is the root. */
	readonly path: string;
	readonly now: number;
	/** Says where the back button goes: "Back to saved snapshots". No back button without `onBack`. */
	readonly backLabel?: string;
	readonly onBack?: () => void;
	readonly onOpenFolder: (path: string) => void;
	/** A file in the open folder to show at once, for a story or a link. */
	readonly initialFile?: string;
}

const isFolder = (value: readonly SnapshotEntry[] | SandboxFolder): value is SandboxFolder => !Array.isArray(value);

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));

/** A link styled as a button, so a download is a real link the browser can save. */
const downloadLink = `${buttonClass("secondary", "sm")} no-underline`;

export function SnapshotFiles({
	source,
	snapshotId,
	label,
	lede = "The files as they were when this snapshot was taken.",
	path,
	now,
	backLabel,
	onBack,
	onOpenFolder,
	initialFile,
}: SnapshotFilesProps) {
	const { state, reload } = useLoad(() => source.list(snapshotId, path), [source, snapshotId, path]);
	const [picked, setPicked] = useState(initialFile);
	// A file picked in another folder isn't shown here.
	const open = picked !== undefined && parentOf(picked) === path ? picked : undefined;
	const folder: SandboxFolder | undefined =
		state.status !== "ready" ? undefined : isFolder(state.value) ? state.value : { entries: state.value, more: false };
	const entries = folder?.entries
		? [...folder.entries].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1))
		: undefined;
	const openEntry = entries?.find((entry) => entry.path === open);
	const folderHref = source.downloadUrl(snapshotId, path);

	const segments = path === "" ? [] : path.split("/");
	const parents: Crumb[] =
		segments.length === 0
			? []
			: [
					{ key: "", label: "Root", onSelect: () => onOpenFolder("") },
					...segments.slice(0, -1).map((segment, at) => {
						const to = segments.slice(0, at + 1).join("/");
						return { key: to, label: segment, onSelect: () => onOpenFolder(to) };
					}),
				];

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
			<div className="flex min-w-0 items-center gap-3">
				<Breadcrumbs label="Folder" parents={parents} current={<span>{segments.at(-1) ?? "Root"}</span>} />
				{folderHref === undefined ? null : (
					<a className={downloadLink} href={folderHref} download title="Download this folder as a tarball">
						<span className={buttonLabelClass}>Download folder</span>
					</a>
				)}
			</div>
			{state.status === "error" ? (
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={reload}>
							Try again
						</Button>
					}
				>
					{messageOf(state.error, "Kantel couldn't read this folder.")}
				</Notice>
			) : entries === undefined ? (
				<div className={tableFrame} aria-busy="true">
					<div className="flex flex-col gap-3 p-4">
						{[0, 1, 2].map((row) => (
							<Skeleton key={row} />
						))}
					</div>
				</div>
			) : entries.length === 0 ? (
				<EmptyState title="This folder is empty" />
			) : (
				<div className="grid min-w-0 items-start gap-4 lg:grid-cols-2">
					{folder?.more === true ? (
						<p className="m-0 text-sm text-muted lg:col-span-2">
							Showing the first {entries.length.toLocaleString("en")} in this folder.
						</p>
					) : null}
					<EntryTable
						entries={entries}
						open={open}
						now={now}
						onOpen={(entry) => (entry.kind === "folder" ? onOpenFolder(entry.path) : setPicked(entry.path))}
					/>
					{openEntry === undefined ? (
						<p className="m-0 hidden rounded-panel border border-dashed border-border p-4 text-muted lg:block">
							Pick a file to see it here.
						</p>
					) : (
						<FileView key={openEntry.path} entry={openEntry} source={source} snapshotId={snapshotId} now={now} />
					)}
				</div>
			)}
		</>
	);
}

function EntryTable({
	entries,
	open,
	now,
	onOpen,
}: {
	entries: readonly SnapshotEntry[];
	open: string | undefined;
	now: number;
	onOpen: (entry: SnapshotEntry) => void;
}) {
	return (
		<TableFrame>
			<table className={table}>
				<thead>
					<tr>
						<th className={th} scope="col">
							Name
						</th>
						<th className={`${th} text-right`} scope="col">
							Size
						</th>
						<th className={th} scope="col">
							Modified
						</th>
					</tr>
				</thead>
				<tbody>
					{entries.map((entry) => {
						const current = entry.path === open;
						return (
							<tr
								key={entry.path}
								className={current ? "bg-selected" : rowHover}
								data-entry={entry.path}
								data-row={current ? "selected" : undefined}
							>
								<td className={`${td} w-full max-w-0`}>
									<button
										type="button"
										className="kt-focusable flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-xs text-left text-fg"
										onClick={() => onOpen(entry)}
										{...(entry.kind === "file" ? { "aria-pressed": current } : {})}
									>
										<span className="flex-none text-muted">
											{entry.kind === "folder" ? <FolderIcon size="sm" /> : <FileIcon size="sm" />}
										</span>
										<span className="min-w-0 truncate">{entry.name}</span>
									</button>
								</td>
								<td className={`${td} text-right text-muted tabular-nums`}>
									{entry.sizeBytes === undefined ? <None /> : bytesText(entry.sizeBytes)}
								</td>
								<td className={`${td} text-muted`}>
									{entry.modifiedAt === undefined ? <None /> : compactAge(entry.modifiedAt, now)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</TableFrame>
	);
}

/** The file picked: its text in syntax colours, or a Download link when Kantel can't show it. */
function FileView({
	entry,
	source,
	snapshotId,
	now,
}: {
	entry: SnapshotEntry;
	source: Pick<SnapshotsSource, "read" | "downloadUrl">;
	snapshotId: string;
	now: number;
}) {
	const { state, reload } = useLoad(() => source.read(snapshotId, entry.path), [source, snapshotId, entry.path]);
	const href = source.downloadUrl(snapshotId, entry.path);
	const facts = [
		entry.sizeBytes === undefined ? undefined : bytesText(entry.sizeBytes),
		entry.modifiedAt === undefined ? undefined : `modified ${compactAge(entry.modifiedAt, now)} ago`,
	].filter((fact) => fact !== undefined);
	return (
		<section
			className="flex min-w-0 flex-col overflow-hidden rounded-panel border border-border bg-panel"
			aria-label={entry.name}
		>
			<div className="flex min-w-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
				<div className="min-w-0">
					<span className="block truncate font-medium text-fg">{entry.name}</span>
					{facts.length === 0 ? null : <span className={cellSub}>{facts.join(", ")}</span>}
				</div>
				{href === undefined ? null : (
					<a className={downloadLink} href={href} download>
						<span className={buttonLabelClass}>Download</span>
					</a>
				)}
			</div>
			{state.status === "error" ? (
				<div className="p-3">
					<Notice
						level="error"
						action={
							<Button size="xs" onClick={reload}>
								Try again
							</Button>
						}
					>
						{messageOf(state.error, "Kantel couldn't read this file.")}
					</Notice>
				</div>
			) : state.status === "loading" ? (
				<div className="p-3" aria-busy="true">
					<Skeleton lines={4} />
				</div>
			) : state.value === undefined ? (
				<p className="m-0 p-4 text-muted">
					Kantel can't show this file here.
					{href === undefined ? null : (
						<>
							{" "}
							<a className="text-fg underline decoration-border-strong underline-offset-2" href={href} download>
								Download it
							</a>{" "}
							to open it.
						</>
					)}
				</p>
			) : (
				<pre
					className="kt-focusable kt-selectable m-0 max-h-96 overflow-auto bg-code-surface px-3 py-2.5 font-mono text-code leading-normal text-fg"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable to scroll by keyboard.
					tabIndex={0}
				>
					<Code code={state.value} language={languageForPath(entry.path)} />
				</pre>
			)}
		</section>
	);
}

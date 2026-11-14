// The Snapshots page (compute console, experimental): an account's saved snapshots, each sandbox's own history, and
// the files in any of them. Saved snapshots have a name, stay until deleted, and new sandboxes start from them; a
// sandbox's history is taken when it stops and regularly while it runs, and dropped after 14 days. Every call goes
// through the `SnapshotsSource` the host binds; stories bind it to fixtures. The view is plain state the host can
// mirror in its address (`view` and `onViewChange`), as the Environments page's is.

import { type ReactNode, useCallback, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { SegmentedControl, SelectField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { compactAge } from "../primitives/format.ts";
import { FolderIcon, PlusIcon } from "../primitives/icons.tsx";
import { useLoad, useReloadOn } from "../primitives/load.ts";
import { EllipsisIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { BaseOutdatedBadge } from "./base-outdated.tsx";
import {
	bytesText,
	type ComputeAccount,
	expiresText,
	SANDBOX_KIND_LABELS,
	type Sandbox,
	type SandboxKind,
	type SandboxSnapshot,
	type SavedSnapshot,
	type SnapshotReason,
	type SnapshotsSource,
} from "./compute-model.ts";
import { cellSub, computePage, messageOf, rowHover, TableFrame, table, tableFrame, td, th } from "./parts.tsx";
import { type FilesAt, filesRoot, SnapshotFiles } from "./snapshot-files.tsx";

/** The files view at another place in the same snapshot. */
const filesView = (view: FilesView, at: FilesAt): SnapshotsView => {
	const { file: _file, path: _path, ...rest } = view;
	return {
		...rest,
		...(at.path === undefined ? {} : { path: at.path }),
		...(at.file === undefined ? {} : { file: at.file }),
	};
};

type FilesView = Extract<SnapshotsView, { name: "files" }>;

/** Where the page is: the saved snapshots, one sandbox's history, or the files in a snapshot. */
export type SnapshotsView =
	| { readonly name: "saved" }
	| { readonly name: "sandbox"; readonly sandboxId?: string }
	| {
			readonly name: "files";
			readonly snapshotId: string;
			/**
			 * The heading over the files: a saved snapshot's name, or a sandbox's and when it was taken. None where it isn't
			 * known (the page opened from a link to the files).
			 */
			readonly label?: string;
			/**
			 * The kind of sandbox it's of, which says where its files start (an isolate's at /workspace). Asked of the source
			 * where it isn't known (the page opened from a link to the files).
			 */
			readonly kind?: SandboxKind;
			/** The open folder from the filesystem's root ("" is /); where its files start when absent. */
			readonly path?: string;
			/** The file open in that folder's preview. */
			readonly file?: string;
			/** Where the back button goes; the saved snapshots when absent. */
			readonly back?: SnapshotsView;
	  };

export interface SnapshotsPageProps {
	readonly source: SnapshotsSource;
	/** The account's sandboxes, to pick whose history to show. */
	readonly sandboxes: { list(accountId: string): Promise<readonly Sandbox[]> };
	readonly account: ComputeAccount;
	/** A fixed time, for stories. */
	readonly now?: number;
	readonly view?: SnapshotsView;
	readonly onViewChange?: (view: SnapshotsView) => void;
	/** Where to start, when the page keeps its own view. */
	readonly initialView?: SnapshotsView;
	/** Starts a new sandbox from a saved snapshot; without it the menu doesn't offer one. */
	readonly onStartFrom?: (saved: SavedSnapshot) => void;
	/** The address of a view, so a snapshot's folders and files are links. */
	readonly viewHref?: (view: SnapshotsView) => string;
}

/**
 * The files of a snapshot whose kind of sandbox a link didn't say, once the source says: until then a line's skeleton,
 * and where it can't, the whole snapshot from its root.
 */
function KindOf({
	source,
	snapshotId,
	children,
}: {
	source: SnapshotsSource;
	snapshotId: string;
	children: (kind: SandboxKind | undefined) => ReactNode;
}) {
	const { state } = useLoad(() => source.kindOf?.(snapshotId) ?? Promise.resolve(undefined), [source, snapshotId]);
	if (state.status === "loading") return <Skeleton width="40%" />;
	return children(state.status === "ready" ? state.value : undefined);
}

const SNAPSHOT_REASON_LABELS: Readonly<Record<SnapshotReason, string>> = {
	stop: "Stopped",
	periodic: "Regular save",
	fork: "Before a fork",
};

/** A saved snapshot's labels as `key=value, …`, or undefined with none. */
function labelsText(entry: SavedSnapshot): string | undefined {
	const pairs = Object.entries(entry.labels ?? {})
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}=${value}`);
	return pairs.length === 0 ? undefined : pairs.join(", ");
}

const TABS: readonly { value: "saved" | "sandbox"; label: string }[] = [
	{ value: "saved", label: "Saved" },
	{ value: "sandbox", label: "By sandbox" },
];

type NoticeSetter = (notice: { level: "info" | "error"; text: string } | undefined) => void;

/** "2m ago", or "just now" under a minute. */
export const agoText = (at: number, now: number): string => {
	const age = compactAge(at, now);
	return age === "now" ? "just now" : `${age} ago`;
};

const backLabel = (back: SnapshotsView): string =>
	back.name === "saved"
		? "Back to saved snapshots"
		: back.name === "sandbox"
			? "Back to history"
			: `Back to ${back.label ?? "the snapshot"}`;

export function SnapshotsPage({
	source,
	sandboxes,
	account,
	now: fixedNow,
	view: controlled,
	onViewChange,
	initialView = { name: "saved" },
	onStartFrom,
	viewHref,
}: SnapshotsPageProps) {
	const [own, setOwn] = useState<SnapshotsView>(initialView);
	const view = controlled ?? own;
	const go = useCallback(
		(next: SnapshotsView) => {
			setOwn(next);
			onViewChange?.(next);
		},
		[onViewChange],
	);
	const [notice, setNotice] = useState<{ level: "info" | "error"; text: string }>();
	const now = fixedNow ?? Date.now();

	if (view.name === "files") {
		const back = view.back ?? { name: "saved" };
		const files = (kind: SandboxKind | undefined) => (
			<SnapshotFiles
				key={view.snapshotId}
				source={source}
				snapshotId={view.snapshotId}
				root={filesRoot(kind)}
				{...(view.label === undefined ? {} : { label: view.label })}
				at={{
					...(view.path === undefined ? {} : { path: view.path }),
					...(view.file === undefined ? {} : { file: view.file }),
				}}
				now={now}
				backLabel={backLabel(back)}
				onBack={() => go(back)}
				onNavigate={(at) => go(filesView(view, at))}
				{...(viewHref === undefined ? {} : { href: (at: FilesAt) => viewHref(filesView(view, at)) })}
			/>
		);
		return (
			<div className={computePage}>
				{view.kind !== undefined || source.kindOf === undefined ? (
					files(view.kind)
				) : (
					<KindOf source={source} snapshotId={view.snapshotId}>
						{files}
					</KindOf>
				)}
			</div>
		);
	}

	const browse = (snapshotId: string, label: string, kind: SandboxKind) =>
		go({ name: "files", snapshotId, label, kind, back: view });
	return (
		<div className={computePage}>
			<PageHeader
				title="Snapshots"
				lede="Saved snapshots stay until you delete them, and new sandboxes start from them."
			/>
			{notice === undefined ? null : (
				<Notice
					level={notice.level}
					action={
						<Button size="xs" variant="ghost" onClick={() => setNotice(undefined)}>
							Dismiss
						</Button>
					}
				>
					{notice.text}
				</Notice>
			)}
			<div className="flex flex-wrap items-center justify-between gap-2">
				<SegmentedControl
					label="Show snapshots"
					options={TABS}
					value={view.name}
					onChange={(tab) => {
						setNotice(undefined);
						go(tab === "saved" ? { name: "saved" } : { name: "sandbox" });
					}}
				/>
			</div>
			{view.name === "saved" ? (
				<SavedList
					source={source}
					account={account}
					now={now}
					{...(onStartFrom === undefined ? {} : { onStartFrom })}
					onBrowse={(saved) => browse(saved.id, saved.name, saved.kind)}
					onNotice={setNotice}
				/>
			) : (
				<BySandbox
					source={source}
					sandboxes={sandboxes}
					account={account}
					sandboxId={view.sandboxId}
					now={now}
					onPick={(sandboxId) => go({ name: "sandbox", sandboxId })}
					onBrowse={(box, snap) => browse(snap.id, `${box.name}, ${agoText(snap.takenAt, now)}`, box.kind)}
					onNotice={setNotice}
				/>
			)}
		</div>
	);
}

function TableSkeleton() {
	return (
		<div className={tableFrame} aria-busy="true">
			<div className="flex flex-col gap-3 p-4">
				{[0, 1, 2, 3].map((row) => (
					<Skeleton key={row} />
				))}
			</div>
		</div>
	);
}

function ReadFailed({ error, fallback, onRetry }: { error: unknown; fallback: string; onRetry: () => void }) {
	return (
		<Notice
			level="error"
			action={
				<Button size="sm" onClick={onRetry}>
					Try again
				</Button>
			}
		>
			{messageOf(error, fallback)}
		</Notice>
	);
}

function SavedList({
	source,
	account,
	now,
	onStartFrom,
	onBrowse,
	onNotice,
}: {
	source: SnapshotsSource;
	account: ComputeAccount;
	now: number;
	onStartFrom?: (saved: SavedSnapshot) => void;
	onBrowse: (saved: SavedSnapshot) => void;
	onNotice: NoticeSetter;
}) {
	const { state, reload } = useLoad(() => source.saved(account.id), [source, account.id]);
	// Deleted here, ahead of the next read.
	const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
	const [deleting, setDeleting] = useState<SavedSnapshot>();

	if (state.status === "error") {
		return <ReadFailed error={state.error} fallback="Kantel couldn't read the saved snapshots." onRetry={reload} />;
	}
	if (state.status === "loading") return <TableSkeleton />;
	const saved = state.value.filter((entry) => !removed.has(entry.id));
	if (saved.length === 0) {
		return (
			<EmptyState title="No saved snapshots yet">
				Save one from a sandbox's menu on the Sandboxes page. It stays until you delete it, and new sandboxes can start
				from it.
			</EmptyState>
		);
	}
	return (
		<>
			<TableFrame fill>
				<table className={table}>
					<thead>
						<tr>
							<th className={th} scope="col">
								Name
							</th>
							<th className={th} scope="col">
								Saved from
							</th>
							<th className={th} scope="col">
								Type
							</th>
							<th className={`${th} text-right`} scope="col">
								Size
							</th>
							<th className={th} scope="col">
								Created
							</th>
							<th className={`${th} text-right`} scope="col">
								Uses
							</th>
							<th className={th} scope="col">
								<span className="kt-sr-only">Actions</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{saved.map((entry) => {
							const entries: MenuEntry[] = [
								...(onStartFrom === undefined
									? []
									: [
											{
												kind: "item" as const,
												id: "start",
												label: "Start a sandbox from it",
												icon: <PlusIcon size="sm" />,
												onSelect: () => onStartFrom(entry),
											},
										]),
								{
									kind: "item",
									id: "browse",
									label: "Browse files",
									icon: <FolderIcon size="sm" />,
									onSelect: () => onBrowse(entry),
								},
								{ kind: "separator", id: "sep-delete" },
								{
									kind: "item",
									id: "delete",
									label: "Delete",
									icon: <TrashIcon />,
									danger: true,
									onSelect: () => setDeleting(entry),
								},
							];
							return (
								<tr key={entry.id} className={`${rowHover} [&>td]:align-baseline`} data-snapshot={entry.id}>
									<td className={td}>
										<span className="block max-w-(--kt-card-width) truncate font-medium text-fg">{entry.name}</span>
										{entry.description === undefined || entry.description === "" ? null : (
											<span className={`${cellSub} max-w-(--kt-card-width) truncate`} title={entry.description}>
												{entry.description}
											</span>
										)}
										{/* Its saver's labels, such as the commit a checkout in it is at, so a stale cache shows. */}
										{labelsText(entry) === undefined ? null : (
											<span
												className={`${cellSub} max-w-(--kt-card-width) truncate font-mono`}
												title={labelsText(entry)}
												data-snapshot-labels
											>
												{labelsText(entry)}
											</span>
										)}
										{entry.base?.outdated === true ? (
											<span className="mt-1 flex">
												<BaseOutdatedBadge base={entry.base} now={now} subject="snapshot" />
											</span>
										) : null}
									</td>
									{/* On a phone (table.css): where it came from on a line of its own, then the type, size and uses,
									    then when and by whom. */}
									<td className={td} data-phone="line">
										<span className="text-fg">{entry.sandboxName}</span>
										{entry.sandboxId === undefined ? <span className={cellSub}>Since deleted</span> : null}
									</td>
									{/* Plain words, as the sandboxes list gives a type: a tag here would outweigh the name. On a phone the
									    type, size and uses carry their column's name before them, as a key card's facts do. */}
									<td className={td} data-phone="pair">
										{SANDBOX_KIND_LABELS[entry.kind]}
									</td>
									<td className={`${td} text-right tabular-nums`} data-phone="pair">
										{bytesText(entry.sizeBytes)}
									</td>
									{/* On a phone, when and by whom on the card's last line, after what it is, its size and its uses. */}
									<td className={`${td} whitespace-nowrap`} data-phone="bare line last">
										<span className="text-fg" title={new Date(entry.createdAt).toLocaleString("en-GB")}>
											{compactAge(entry.createdAt, now)}
										</span>
										{entry.createdBy === undefined ? null : <span className={cellSub}>by {entry.createdBy}</span>}
									</td>
									<td className={`${td} text-right tabular-nums`} data-phone="pair">
										{entry.uses.toLocaleString("en-GB")}
									</td>
									<td className={`${td} w-0 pl-6 text-right`}>
										{/* What a saved snapshot is for, in reach on its row; the rest stays in the menu. A wider gutter keeps
										    Start apart from the Uses figure before it. */}
										<span className="inline-flex items-center gap-1">
											{onStartFrom === undefined ? null : (
												<Button
													size="sm"
													onClick={() => onStartFrom(entry)}
													aria-label={`Start a sandbox from ${entry.name}`}
												>
													Start
												</Button>
											)}
											<Menu label={`Actions for ${entry.name}`} icon={<EllipsisIcon />} entries={entries} align="end" />
										</span>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</TableFrame>
			<DeleteDialog
				open={deleting !== undefined}
				title="Delete saved snapshot?"
				onClose={() => setDeleting(undefined)}
				onDelete={async () => {
					if (deleting === undefined) return;
					await source.removeSaved(deleting.id);
					setRemoved((current) => new Set(current).add(deleting.id));
					onNotice({ level: "info", text: `Deleted ${deleting.name}.` });
					reload();
				}}
			>
				<p>
					<strong>{deleting?.name}</strong> goes for good. Sandboxes already started from it keep their own disks.
				</p>
			</DeleteDialog>
		</>
	);
}

function BySandbox({
	source,
	sandboxes,
	account,
	sandboxId,
	now,
	onPick,
	onBrowse,
	onNotice,
}: {
	source: SnapshotsSource;
	sandboxes: SnapshotsPageProps["sandboxes"];
	account: ComputeAccount;
	sandboxId: string | undefined;
	now: number;
	onPick: (sandboxId: string) => void;
	onBrowse: (box: Sandbox, snap: SandboxSnapshot) => void;
	onNotice: NoticeSetter;
}) {
	const { state, reload } = useLoad(() => sandboxes.list(account.id), [sandboxes, account.id]);
	if (state.status === "error") {
		return <ReadFailed error={state.error} fallback="Kantel couldn't read the sandboxes." onRetry={reload} />;
	}
	if (state.status === "loading") return <TableSkeleton />;
	const list = state.value;
	const chosen = list.find((box) => box.id === sandboxId) ?? list.find((box) => box.snapshot !== undefined) ?? list[0];
	if (chosen === undefined) {
		return (
			<EmptyState title="No sandboxes yet">
				Each sandbox keeps its own history here: Kantel takes a snapshot when it stops, and regularly while it runs.
			</EmptyState>
		);
	}
	return (
		<>
			<div className="max-w-(--kt-card-width)">
				<SelectField
					label="Sandbox"
					// Where a sandbox's own history is explained: the page's lede keeps to saved snapshots.
					hint="Taken when it stops and regularly while it runs, and kept for 14 days."
					value={chosen.id}
					onChange={(event) => onPick(event.currentTarget.value)}
					options={list.map((box) => ({
						value: box.id,
						label: box.snapshot === undefined ? `${box.name} (no snapshots)` : box.name,
					}))}
				/>
			</div>
			<SandboxHistory
				key={chosen.id}
				source={source}
				sandbox={chosen}
				now={now}
				fill
				onBrowse={(snap) => onBrowse(chosen, snap)}
				onNotice={onNotice}
			/>
		</>
	);
}

/** One sandbox's history: its own snapshots, newest first, each with Browse files and Delete. Its page's Snapshots tab. */
export function SandboxHistory({
	source,
	sandbox,
	now,
	fill = false,
	onBrowse,
	onNotice,
}: {
	source: SnapshotsSource;
	sandbox: Sandbox;
	now: number;
	/** The table fills the room its page leaves (TableFrame's `fill`): on Snapshots, not on a sandbox's own tab. */
	fill?: boolean;
	onBrowse: (snap: SandboxSnapshot) => void;
	onNotice: NoticeSetter;
}) {
	const { state, reload } = useLoad(() => source.history(sandbox.id), [source, sandbox.id]);
	// A stop or a save while it's shown adds a snapshot: read the history again.
	useReloadOn(sandbox.snapshot?.id, reload);
	const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
	const [deleting, setDeleting] = useState<SandboxSnapshot>();

	if (state.status === "error") {
		return (
			<ReadFailed error={state.error} fallback={`Kantel couldn't read ${sandbox.name}'s history.`} onRetry={reload} />
		);
	}
	if (state.status === "loading") return <TableSkeleton />;
	const history = state.value.filter((snap) => !removed.has(snap.id));
	if (history.length === 0) {
		return (
			<EmptyState title="No history yet">
				Kantel takes a snapshot of {sandbox.name} when it stops, and regularly while it runs. Each is kept for 14 days.
			</EmptyState>
		);
	}
	return (
		<>
			<TableFrame fill={fill}>
				<table className={table}>
					<thead>
						<tr>
							<th className={th} scope="col">
								Taken
							</th>
							<th className={th} scope="col">
								Why
							</th>
							<th className={`${th} text-right`} scope="col">
								Size
							</th>
							<th className={th} scope="col">
								Expires
							</th>
							<th className={th} scope="col">
								<span className="kt-sr-only">Actions</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{history.map((snap) => {
							const entries: MenuEntry[] = [
								{
									kind: "item",
									id: "browse",
									label: "Browse files",
									icon: <FolderIcon size="sm" />,
									onSelect: () => onBrowse(snap),
								},
								{ kind: "separator", id: "sep-delete" },
								{
									kind: "item",
									id: "delete",
									label: "Delete",
									icon: <TrashIcon />,
									danger: true,
									onSelect: () => setDeleting(snap),
								},
							];
							return (
								<tr key={snap.id} className={rowHover} data-snapshot={snap.id}>
									<td className={td}>
										<span className="text-fg" title={new Date(snap.takenAt).toLocaleString("en-GB")}>
											{agoText(snap.takenAt, now)}
										</span>
									</td>
									<td className={td}>{SNAPSHOT_REASON_LABELS[snap.reason]}</td>
									<td className={`${td} text-right tabular-nums`}>{bytesText(snap.sizeBytes)}</td>
									<td className={`${td} text-muted`}>{expiresText(snap.expiresAt, now)}</td>
									<td className={`${td} w-0 text-right`}>
										<Menu
											label={`Actions for the snapshot ${agoText(snap.takenAt, now)}`}
											icon={<EllipsisIcon />}
											entries={entries}
											align="end"
										/>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</TableFrame>
			<DeleteDialog
				open={deleting !== undefined}
				title="Delete snapshot?"
				onClose={() => setDeleting(undefined)}
				onDelete={async () => {
					if (deleting === undefined) return;
					await source.removeSnapshot(deleting.id);
					setRemoved((current) => new Set(current).add(deleting.id));
					onNotice({
						level: "info",
						text: `Deleted ${sandbox.name}'s snapshot from ${agoText(deleting.takenAt, now)}.`,
					});
					reload();
				}}
			>
				<p>
					{sandbox.name}'s snapshot from {deleting === undefined ? "" : agoText(deleting.takenAt, now)} goes for good.
				</p>
			</DeleteDialog>
		</>
	);
}

/** Asks before a delete; stays open with the reason when it fails. */
function DeleteDialog({
	open,
	title,
	children,
	onClose,
	onDelete,
}: {
	open: boolean;
	title: string;
	children: ReactNode;
	onClose: () => void;
	onDelete: () => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const close = () => {
		setFailure(undefined);
		onClose();
	};
	return (
		<Dialog
			open={open}
			title={title}
			onClose={close}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button
						variant="danger"
						busy={busy}
						onClick={() => {
							setBusy(true);
							onDelete().then(
								() => {
									setBusy(false);
									close();
								},
								(caught: unknown) => {
									setBusy(false);
									setFailure(messageOf(caught, "Kantel couldn't delete it. Try again."));
								},
							);
						}}
					>
						Delete
					</Button>
				</>
			}
		>
			{children}
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

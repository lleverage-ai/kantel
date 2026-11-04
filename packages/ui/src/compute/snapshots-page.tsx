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
import { useLoad } from "../primitives/load.ts";
import { EllipsisIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import {
	bytesText,
	type ComputeAccount,
	expiresText,
	SANDBOX_KIND_LABELS,
	type Sandbox,
	type SandboxSnapshot,
	type SavedSnapshot,
	type SnapshotReason,
	type SnapshotsSource,
} from "./compute-model.ts";
import { cellSub, computePage, messageOf, rowHover, TableFrame, table, tableFrame, td, th } from "./parts.tsx";
import { SnapshotFiles } from "./snapshot-files.tsx";

/** Where the page is: the saved snapshots, one sandbox's history, or the files in a snapshot. */
export type SnapshotsView =
	| { readonly name: "saved" }
	| { readonly name: "sandbox"; readonly sandboxId?: string }
	| {
			readonly name: "files";
			readonly snapshotId: string;
			/** The heading over the files: a saved snapshot's name, or a sandbox's and when it was taken. */
			readonly label: string;
			/** The open folder from the snapshot's root; the root when absent. */
			readonly path?: string;
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
}

const SNAPSHOT_REASON_LABELS: Readonly<Record<SnapshotReason, string>> = {
	stop: "Stopped",
	periodic: "Regular save",
	fork: "Before a fork",
};

const TABS: readonly { value: "saved" | "sandbox"; label: string }[] = [
	{ value: "saved", label: "Saved" },
	{ value: "sandbox", label: "By sandbox" },
];

type NoticeSetter = (notice: { level: "info" | "error"; text: string } | undefined) => void;

/** "2m ago", or "just now" under a minute. */
const agoText = (at: number, now: number): string => {
	const age = compactAge(at, now);
	return age === "now" ? "just now" : `${age} ago`;
};

const backLabel = (back: SnapshotsView): string =>
	back.name === "saved"
		? "Back to saved snapshots"
		: back.name === "sandbox"
			? "Back to history"
			: `Back to ${back.label}`;

export function SnapshotsPage({
	source,
	sandboxes,
	account,
	now: fixedNow,
	view: controlled,
	onViewChange,
	initialView = { name: "saved" },
	onStartFrom,
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
		return (
			<div className={computePage}>
				<SnapshotFiles
					key={view.snapshotId}
					source={source}
					snapshotId={view.snapshotId}
					label={view.label}
					path={view.path ?? ""}
					now={now}
					backLabel={backLabel(back)}
					onBack={() => go(back)}
					onOpenFolder={(path) => go({ ...view, path })}
				/>
			</div>
		);
	}

	const browse = (snapshotId: string, label: string) => go({ name: "files", snapshotId, label, back: view });
	return (
		<div className={computePage}>
			<PageHeader
				title="Snapshots"
				lede="Saved snapshots have a name and stay until you delete them; new sandboxes start from them. Each sandbox also keeps its own history, taken when it stops and regularly while it runs, for 14 days."
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
					onBrowse={(saved) => browse(saved.id, saved.name)}
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
					onBrowse={(box, snap) => browse(snap.id, `${box.name}, ${agoText(snap.takenAt, now)}`)}
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
			<TableFrame>
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
								<tr key={entry.id} className={rowHover} data-snapshot={entry.id}>
									<td className={td}>
										<span className="block max-w-(--kt-card-width) truncate font-medium text-fg">{entry.name}</span>
									</td>
									<td className={td}>
										<span className="text-fg">{entry.sandboxName}</span>
										{entry.sandboxId === undefined ? <span className={cellSub}>Since deleted</span> : null}
									</td>
									<td className={td}>
										<Badge tone={entry.kind === "microvm" ? "accent" : "neutral"}>
											{SANDBOX_KIND_LABELS[entry.kind]}
										</Badge>
									</td>
									<td className={`${td} text-right tabular-nums`}>{bytesText(entry.sizeBytes)}</td>
									<td className={td}>
										<span className="text-fg" title={new Date(entry.createdAt).toLocaleString("en-GB")}>
											{compactAge(entry.createdAt, now)}
										</span>
										<span className={cellSub}>by {entry.createdBy}</span>
									</td>
									<td className={`${td} text-right tabular-nums`}>{entry.uses.toLocaleString("en-GB")}</td>
									<td className={`${td} w-0 text-right`}>
										<Menu label={`Actions for ${entry.name}`} icon={<EllipsisIcon />} entries={entries} align="end" />
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
				onBrowse={(snap) => onBrowse(chosen, snap)}
				onNotice={onNotice}
			/>
		</>
	);
}

function SandboxHistory({
	source,
	sandbox,
	now,
	onBrowse,
	onNotice,
}: {
	source: SnapshotsSource;
	sandbox: Sandbox;
	now: number;
	onBrowse: (snap: SandboxSnapshot) => void;
	onNotice: NoticeSetter;
}) {
	const { state, reload } = useLoad(() => source.history(sandbox.id), [source, sandbox.id]);
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
			<TableFrame>
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

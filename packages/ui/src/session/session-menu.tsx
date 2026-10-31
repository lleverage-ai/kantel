import { useEffect, useRef, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import {
	ArchiveIcon,
	EllipsisIcon,
	FilterIcon,
	MarkReadIcon,
	MarkUnreadIcon,
	PinIcon,
	RenameIcon,
	TrashIcon,
	UnarchiveIcon,
	UnpinIcon,
} from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import { type SessionListView, type SessionSummary, sessionViewChoices } from "./session-model.ts";

/** What a session row's menu can do to its session. */
export type SessionAction = "unread" | "pin" | "rename" | "archive" | "delete";

/**
 * The session list's menu actions, given by the console: each changes the session on the host and resolves once it
 * has (the list shows the change then, and says so if it failed). Pass a stable object: rows are memoised on it.
 */
export type SessionMenuActions = {
	setUnread(sessionId: string, unread: boolean): Promise<void>;
	setPinned(sessionId: string, pinned: boolean): Promise<void>;
	setArchived(sessionId: string, archived: boolean): Promise<void>;
	rename(sessionId: string, title: string): Promise<void>;
	remove(sessionId: string): Promise<void>;
};

/**
 * A session row's "…" menu, after Claude.ai's: Mark as unread, Pin, Rename, Archive and Delete, each with its Lucide
 * icon and one key (U, P, R, A, D) that works while the menu is open. Each flips to its opposite when it applies
 * (Mark as read, Unpin, Unarchive). Delete is red, and asks first.
 */
export function SessionRowMenu({
	session,
	onAction,
	defaultOpen,
}: {
	session: SessionSummary;
	onAction: (session: SessionSummary, action: SessionAction) => void;
	/** Opens with the page, for the workbench. */
	defaultOpen?: boolean;
}) {
	const entries: MenuEntry[] = [
		{
			kind: "item",
			id: "unread",
			label: session.unread === true ? "Mark as read" : "Mark as unread",
			icon: session.unread === true ? <MarkReadIcon /> : <MarkUnreadIcon />,
			shortcut: "U",
			onSelect: () => onAction(session, "unread"),
		},
		{ kind: "separator", id: "after-unread" },
		{
			kind: "item",
			id: "pin",
			label: session.pinned === true ? "Unpin" : "Pin",
			icon: session.pinned === true ? <UnpinIcon /> : <PinIcon />,
			shortcut: "P",
			onSelect: () => onAction(session, "pin"),
		},
		{
			kind: "item",
			id: "rename",
			label: "Rename",
			icon: <RenameIcon />,
			shortcut: "R",
			onSelect: () => onAction(session, "rename"),
		},
		{ kind: "separator", id: "after-rename" },
		{
			kind: "item",
			id: "archive",
			label: session.archived === true ? "Unarchive" : "Archive",
			icon: session.archived === true ? <UnarchiveIcon /> : <ArchiveIcon />,
			shortcut: "A",
			onSelect: () => onAction(session, "archive"),
		},
		{
			kind: "item",
			id: "delete",
			label: "Delete",
			icon: <TrashIcon />,
			shortcut: "D",
			danger: true,
			onSelect: () => onAction(session, "delete"),
		},
	];
	return (
		<Menu
			label={`Actions for ${session.title}`}
			icon={<EllipsisIcon />}
			entries={entries}
			align="start"
			{...(defaultOpen === undefined ? {} : { defaultOpen })}
		/>
	);
}

/** The filter button by the list's heading: Status, Last activity, Group by and Sort by, as Claude.ai's. */
export function SessionFilterMenu({
	view,
	onViewChange,
	defaultOpen,
}: {
	view: SessionListView;
	onViewChange: (view: SessionListView) => void;
	defaultOpen?: boolean;
}) {
	const set =
		<Key extends keyof SessionListView>(key: Key) =>
		(value: string) =>
			onViewChange({ ...view, [key]: value as SessionListView[Key] });
	const entries: MenuEntry[] = [
		{
			kind: "choices",
			id: "status",
			label: "Status",
			choices: sessionViewChoices.status,
			value: view.status,
			onChoose: set("status"),
		},
		{
			kind: "choices",
			id: "activity",
			label: "Last activity",
			choices: sessionViewChoices.activity,
			value: view.activity,
			onChoose: set("activity"),
		},
		{ kind: "separator", id: "after-filters" },
		{
			kind: "choices",
			id: "group",
			label: "Group by",
			choices: sessionViewChoices.groupBy,
			value: view.groupBy,
			onChoose: set("groupBy"),
		},
		{
			kind: "choices",
			id: "sort",
			label: "Sort by",
			choices: sessionViewChoices.sortBy,
			value: view.sortBy,
			onChoose: set("sortBy"),
		},
	];
	return (
		<Menu
			label="Filter sessions"
			icon={<FilterIcon />}
			entries={entries}
			align="end"
			{...(defaultOpen === undefined ? {} : { defaultOpen })}
		/>
	);
}

/** Names a session anew: its title in a field, Save to keep it. */
export function RenameSessionDialog({
	session,
	onRename,
	onClose,
}: {
	/** The session being renamed; none, and the dialog is closed. */
	session: SessionSummary | undefined;
	onRename: (sessionId: string, title: string) => Promise<void>;
	onClose: () => void;
}) {
	const [title, setTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const field = useRef<HTMLInputElement>(null);
	const sessionId = session?.id;
	const current = session?.title;

	useEffect(() => {
		if (sessionId === undefined) return;
		setTitle(current ?? "");
		setBusy(false);
		setError(undefined);
		requestAnimationFrame(() => field.current?.select());
	}, [sessionId, current]);

	const save = () => {
		if (session === undefined || busy) return;
		const next = title.trim();
		if (next === "") {
			setError("A session needs a title.");
			return;
		}
		if (next === session.title) {
			onClose();
			return;
		}
		setBusy(true);
		onRename(session.id, next).then(onClose, (reason: unknown) => {
			setBusy(false);
			setError(reason instanceof Error ? reason.message : String(reason));
		});
	};

	return (
		<Dialog
			open={session !== undefined}
			title="Rename session"
			onClose={onClose}
			onSubmit={save}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy}>
						Save
					</Button>
				</>
			}
		>
			<TextField
				ref={field}
				label="Title"
				value={title}
				maxLength={200}
				onChange={(event) => setTitle(event.target.value)}
				{...(error === undefined ? {} : { error })}
			/>
		</Dialog>
	);
}

/** Asks before a session is deleted: it can't be brought back. */
export function DeleteSessionDialog({
	session,
	onDelete,
	onClose,
}: {
	session: SessionSummary | undefined;
	onDelete: (sessionId: string) => Promise<void>;
	onClose: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string>();
	const sessionId = session?.id;

	useEffect(() => {
		if (sessionId === undefined) return;
		setBusy(false);
		setError(undefined);
	}, [sessionId]);

	const confirm = () => {
		if (session === undefined || busy) return;
		setBusy(true);
		onDelete(session.id).then(onClose, (reason: unknown) => {
			setBusy(false);
			setError(reason instanceof Error ? reason.message : String(reason));
		});
	};

	return (
		<Dialog
			open={session !== undefined}
			title="Delete session?"
			onClose={onClose}
			onSubmit={confirm}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="danger" busy={busy}>
						Delete
					</Button>
				</>
			}
		>
			<p>
				{session === undefined ? null : <strong>{session.title}</strong>} will be deleted for everyone in this project,
				and anything it's still doing will stop. You can't undo this.
			</p>
			{error === undefined ? null : <p className="kt-dialog-error">{error}</p>}
		</Dialog>
	);
}

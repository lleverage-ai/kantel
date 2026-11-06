// What a sandbox's ⋯ menu does, on its page and on its row in the list: Fork, Save snapshot, Auto-stop, Idle stop,
// Restart on latest base (for one on an outdated base) and Delete, and the dialogs they open. The ways in (Browser, Desktop,
// SSH), its logs, egress and snapshots are on its page, not here.

import { type ReactNode, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "../primitives/button.tsx";
import { CheckboxField, SelectField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { ClockIcon, ForkIcon } from "../primitives/icons.tsx";
import { ReplayIcon, SnapshotIcon, TrashIcon } from "../primitives/lucide.tsx";
import type { MenuEntry } from "../primitives/menu.tsx";
import {
	type Sandbox,
	type SandboxesSource,
	type SavedSnapshot,
	type SaveSnapshotOptions,
	sandboxActions,
} from "./compute-model.ts";
import { autoStopChanges, idleStopChanges } from "./one-change.ts";
import { messageOf } from "./parts.tsx";

export type SandboxNotice = { readonly level: "info" | "error"; readonly text: string };

/** How long a sandbox runs before auto-stop stops it, as New sandbox and Auto-stop offer it. */
export const AUTO_STOP_CHOICES = [
	{ value: "15", label: "15 minutes" },
	{ value: "60", label: "1 hour" },
	{ value: "480", label: "8 hours" },
	{ value: "1440", label: "1 day" },
	{ value: "never", label: "Never" },
] as const;

/** How long a sandbox may go unused before its idle stop stops it, as New sandbox and Idle stop offer it. */
export const IDLE_STOP_CHOICES = [
	{ value: "never", label: "Never" },
	{ value: "15", label: "15 minutes" },
	{ value: "30", label: "30 minutes" },
	{ value: "60", label: "1 hour" },
	{ value: "240", label: "4 hours" },
] as const;

/** What counts as use, for the idle stop's fields. */
export const IDLE_STOP_HINT =
	"Unused means no commands, SSH, desktop or browser, and no traffic to its hosted ports. It keeps its disk.";

export interface SandboxMenuCalls {
	readonly source: SandboxesSource;
	/** Saves a sandbox's latest snapshot under a name; without it there's no Save snapshot. */
	readonly save?: (sandboxId: string, name: string, options?: SaveSnapshotOptions) => Promise<SavedSnapshot>;
	/**
	 * A sandbox changed or was made (a fork); `null` when it was deleted. `asked`, where given, is what `asked` read as the
	 * call was made: the answer is dropped if the sandbox changed since (a Stop or a Delete that answered first).
	 */
	readonly onChange: (box: Sandbox | null, id: string, asked?: number) => void;
	/** Where a sandbox's changes have got to, as the list counts them; without it every answer applies. */
	readonly asked?: (id: string) => number;
	readonly onNotice: (notice: SandboxNotice | undefined) => void;
}

/**
 * Sets a sandbox's auto-stop: one change at a time to each sandbox's, from its page or its row, even once the dialog
 * has gone, so a slow earlier one can't land after a later one and undo it. Its answer is dropped if the sandbox
 * changed meanwhile (stopped or deleted), so it can't bring back a row a Delete took away.
 */
export async function setAutoStop(
	{ source, onChange, asked }: Pick<SandboxMenuCalls, "source" | "onChange" | "asked">,
	id: string,
	minutes: number | undefined,
): Promise<void> {
	const since = asked?.(id);
	const changed = await autoStopChanges.run(id, async () => source.setAutoStop?.(id, minutes));
	if (changed !== undefined) onChange(changed, changed.id, since);
}

/** Sets a sandbox's idle stop, one change at a time to each sandbox's, as `setAutoStop` does its auto-stop. */
export async function setIdleStop(
	{ source, onChange, asked }: Pick<SandboxMenuCalls, "source" | "onChange" | "asked">,
	id: string,
	minutes: number | undefined,
): Promise<void> {
	const since = asked?.(id);
	const changed = await idleStopChanges.run(id, async () => source.setIdleStop?.(id, minutes));
	if (changed !== undefined) onChange(changed, changed.id, since);
}

/** Whether a sandbox can be restarted on the latest base now: it's on an outdated one, and running, stopped or failed. */
export const canRestartOnLatest = (sandbox: Pick<Sandbox, "state" | "base">): boolean =>
	sandbox.base?.outdated === true &&
	(sandbox.state === "running" || sandbox.state === "stopped" || sandbox.state === "error");

/**
 * The menu's items for `sandbox`, and the dialogs they open (render `dialogs` once beside the menu). Each item is
 * there whatever the state, disabled when it can't be done now, so the menu doesn't change shape under the pointer;
 * Restart on latest base is there only for a sandbox on an outdated base that can restart now, where the source can
 * do it. `restartOnLatest` opens its confirmation from elsewhere on the page (the sandbox page's notice), when offered.
 */
export function useSandboxMenu(
	sandbox: Sandbox | undefined,
	calls: SandboxMenuCalls,
): { entries: readonly MenuEntry[]; dialogs: ReactNode; restartOnLatest?: () => void } {
	const { source, save, onChange, asked, onNotice } = calls;
	const [open, setOpen] = useState<"delete" | "save" | "auto-stop" | "idle-stop" | "restart">();
	const close = () => setOpen(undefined);
	const can = sandboxActions(sandbox?.state ?? "stopped");
	const running = sandbox?.state === "running" || sandbox?.state === "starting";
	const { restartOnLatest } = source;
	const restartable = sandbox !== undefined && restartOnLatest !== undefined && canRestartOnLatest(sandbox);

	const entries: MenuEntry[] =
		sandbox === undefined
			? []
			: [
					{
						kind: "item",
						id: "fork",
						label: "Fork",
						icon: <ForkIcon size="sm" />,
						disabled: !can.fork || sandbox.snapshot === undefined,
						onSelect: () => {
							source.fork(sandbox.id).then(
								(fork) => {
									onChange(fork, fork.id);
									onNotice({ level: "info", text: `Forked ${sandbox.name} as ${fork.name}.` });
								},
								(caught: unknown) =>
									onNotice({
										level: "error",
										text: messageOf(caught, `Kantel couldn't fork ${sandbox.name}. Try again.`),
									}),
							);
						},
					},
					...(save === undefined
						? []
						: [
								{
									kind: "item" as const,
									id: "save",
									label: "Save snapshot",
									icon: <SnapshotIcon />,
									disabled: sandbox.snapshot === undefined,
									onSelect: () => setOpen("save"),
								},
							]),
					...(source.setAutoStop === undefined
						? []
						: [
								{
									kind: "item" as const,
									id: "auto-stop",
									label: "Auto-stop",
									icon: <ClockIcon size="sm" />,
									disabled: !running,
									onSelect: () => setOpen("auto-stop"),
								},
							]),
					...(source.setIdleStop === undefined
						? []
						: [
								{
									kind: "item" as const,
									id: "idle-stop",
									label: "Idle stop",
									icon: <ClockIcon size="sm" />,
									disabled: !running,
									onSelect: () => setOpen("idle-stop"),
								},
							]),
					...(restartable
						? [
								{
									kind: "item" as const,
									id: "restart-on-latest",
									label: "Restart on latest base",
									icon: <ReplayIcon size="sm" />,
									onSelect: () => setOpen("restart"),
								},
							]
						: []),
					{ kind: "separator", id: "sep-delete" },
					{
						kind: "item",
						id: "delete",
						label: "Delete",
						icon: <TrashIcon />,
						danger: true,
						onSelect: () => setOpen("delete"),
					},
				];

	const dialogs = (
		<>
			<DeleteDialog
				sandboxes={open === "delete" && sandbox !== undefined ? [sandbox] : undefined}
				onClose={close}
				onDelete={async ([box]) => {
					if (box === undefined) return;
					await source.remove(box.id);
					onChange(null, box.id);
					onNotice({ level: "info", text: `Deleted ${box.name} and its snapshots.` });
				}}
			/>
			{save === undefined ? null : (
				<SaveSnapshotDialog
					sandbox={open === "save" ? sandbox : undefined}
					onClose={close}
					onSave={async (box, name, options) => {
						await save(box.id, name, options);
						onNotice({ level: "info", text: `Saved ${box.name} as ${name}.` });
					}}
				/>
			)}
			{source.setAutoStop === undefined ? null : (
				<AutoStopDialog
					sandbox={open === "auto-stop" ? sandbox : undefined}
					onClose={close}
					onSet={(box, minutes) => setAutoStop(calls, box.id, minutes)}
				/>
			)}
			{source.setIdleStop === undefined ? null : (
				<IdleStopDialog
					sandbox={open === "idle-stop" ? sandbox : undefined}
					onClose={close}
					onSet={(box, minutes) => setIdleStop(calls, box.id, minutes)}
				/>
			)}
			{restartOnLatest === undefined ? null : (
				<RestartOnLatestDialog
					sandbox={open === "restart" ? sandbox : undefined}
					onClose={close}
					onRestart={async (box) => {
						// As the row's own calls: an answer overtaken by a later change to it (a Delete) is dropped.
						const since = asked?.(box.id);
						const restarted = await source.restartOnLatest?.(box.id);
						if (restarted === undefined) return;
						onChange(restarted, restarted.id, since);
						onNotice({
							level: "info",
							text: `Restarting ${box.name} on ${box.base?.latest?.version ?? "the latest base"}.`,
						});
					}}
				/>
			)}
		</>
	);
	return { entries, dialogs, ...(restartable ? { restartOnLatest: () => setOpen("restart") } : {}) };
}

/** A dialog whose one action may fail: it stays open with the reason. */
function useAttempt(onDone: () => void) {
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const run = (call: () => Promise<void>, fallback: string) => {
		setBusy(true);
		call().then(
			() => {
				setBusy(false);
				setFailure(undefined);
				onDone();
			},
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, fallback));
			},
		);
	};
	return { busy, failure, setFailure, run };
}

/** Delete permanently, for one sandbox from its menu or several ticked in the list. */
export function DeleteDialog({
	sandboxes,
	onClose,
	onDelete,
}: {
	sandboxes: readonly Sandbox[] | undefined;
	onClose: () => void;
	onDelete: (boxes: readonly Sandbox[]) => Promise<void>;
}) {
	const sandbox = sandboxes?.length === 1 ? sandboxes[0] : undefined;
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	// Which attempt the dialog is showing: one that settles after the dialog closed (or was opened again) leaves it be.
	const attempt = useRef(0);
	const close = () => {
		attempt.current += 1;
		setBusy(false);
		setFailure(undefined);
		onClose();
	};
	return (
		<Dialog
			open={sandboxes !== undefined && sandboxes.length > 0}
			title="Delete permanently?"
			onClose={close}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button
						variant="danger"
						busy={busy}
						onClick={() => {
							if (sandboxes === undefined) return;
							const mine = ++attempt.current;
							setBusy(true);
							setFailure(undefined);
							onDelete(sandboxes).then(
								() => {
									if (attempt.current === mine) close();
								},
								(caught: unknown) => {
									if (attempt.current !== mine) return;
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
			{sandbox !== undefined || sandboxes === undefined ? (
				<p>
					<strong>{sandbox?.name}</strong> and every snapshot of it go for good. Saved snapshots made from it stay.
				</p>
			) : (
				<p>
					<strong>{sandboxes.length} sandboxes</strong> and every snapshot of them go for good. Saved snapshots made
					from them stay.
				</p>
			)}
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

/** Save snapshot: a name, and for a running microVM whether to keep its memory too (the disk alone by default). */
export function SaveSnapshotDialog({
	sandbox,
	onClose,
	onSave,
}: {
	sandbox: Sandbox | undefined;
	onClose: () => void;
	onSave: (box: Sandbox, name: string, options?: SaveSnapshotOptions) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [memory, setMemory] = useState(false);
	const close = () => {
		setName("");
		setMemory(false);
		setFailure(undefined);
		onClose();
	};
	const { busy, failure, setFailure, run } = useAttempt(close);
	// Only a running microVM has memory to keep: a stopped one is saved as its latest snapshot is.
	const live = sandbox?.kind === "microvm" && sandbox.state === "running";
	const submit = () => {
		if (sandbox === undefined || name.trim() === "") return;
		run(
			() => onSave(sandbox, name.trim(), live && memory ? { memory: true } : undefined),
			"Kantel couldn't save it. Try again.",
		);
	};
	return (
		<Dialog
			open={sandbox !== undefined}
			title="Save snapshot"
			onClose={close}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy} disabled={name.trim() === ""}>
						Save
					</Button>
				</>
			}
		>
			{live ? (
				<p>
					Keeps <strong>{sandbox?.name}</strong>'s disk as it is now under a name until you delete it. New sandboxes of
					any size can start from it.
				</p>
			) : (
				<p>
					Keeps <strong>{sandbox?.name}</strong>'s latest snapshot under a name until you delete it. New sandboxes can
					start from it.
				</p>
			)}
			<div className="flex flex-col gap-4 pt-2">
				<TextField
					label="Name"
					value={name}
					onChange={(event) => setName(event.currentTarget.value)}
					placeholder="node22-base"
					mono
				/>
				{live ? (
					<CheckboxField
						label="Keep its memory too"
						hint="A sandbox made from it carries on where this one is instead of starting up, but has to be the same size. It also takes as much disk space as the sandbox's memory."
						checked={memory}
						onChange={(event) => setMemory(event.currentTarget.checked)}
					/>
				) : null}
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

/** Restart on latest base: what it keeps and what it loses, then Restart. */
function RestartOnLatestDialog({
	sandbox,
	onClose,
	onRestart,
}: {
	sandbox: Sandbox | undefined;
	onClose: () => void;
	onRestart: (box: Sandbox) => Promise<void>;
}) {
	const { busy, failure, setFailure, run } = useAttempt(onClose);
	const close = () => {
		setFailure(undefined);
		onClose();
	};
	const latest = sandbox?.base?.latest?.version;
	return (
		<Dialog
			open={sandbox !== undefined}
			title="Restart on the latest base?"
			onClose={close}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button
						variant="primary"
						busy={busy}
						onClick={() => {
							if (sandbox === undefined) return;
							run(() => onRestart(sandbox), `Kantel couldn't restart ${sandbox.name}. Try again.`);
						}}
					>
						Restart
					</Button>
				</>
			}
		>
			<p>
				Kantel saves its disk, stops it and starts it again on{" "}
				{latest === undefined ? "the latest base" : <strong className="font-mono">{latest}</strong>}. Running processes
				and memory are lost; files on its disk stay. Nothing is patched while it runs.
			</p>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

/** "1 minute", "45 minutes", "2 hours", "1 day": an idle stop's minutes as its choice reads. */
function idleStopLabel(minutes: number): string {
	const [count, unit] =
		minutes % 1440 === 0 ? [minutes / 1440, "day"] : minutes % 60 === 0 ? [minutes / 60, "hour"] : [minutes, "minute"];
	return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * The Idle stop dialog's choices and its first one for a sandbox: the presets, and its own minutes among them where it
 * has a time they don't offer (set by the CLI or API), so saving without a new choice keeps that time, not a preset's.
 */
export function idleStopChoices(minutes: number | undefined): {
	readonly options: readonly { readonly value: string; readonly label: string }[];
	readonly choice: string;
} {
	if (minutes === undefined) return { options: IDLE_STOP_CHOICES, choice: "never" };
	const choice = String(minutes);
	if (IDLE_STOP_CHOICES.some((offered) => offered.value === choice)) return { options: IDLE_STOP_CHOICES, choice };
	const [never, ...presets] = IDLE_STOP_CHOICES;
	const options = [...presets, { value: choice, label: idleStopLabel(minutes) }].sort(
		(a, b) => Number(a.value) - Number(b.value),
	);
	return { options: [never, ...options], choice };
}

function IdleStopDialog({
	sandbox,
	onClose,
	onSet,
}: {
	sandbox: Sandbox | undefined;
	onClose: () => void;
	onSet: (box: Sandbox, minutes: number | undefined) => Promise<void>;
}) {
	const [choice, setChoice] = useState<string>();
	const { busy, failure, setFailure, run } = useAttempt(onClose);
	const changing = useSyncExternalStore(idleStopChanges.subscribe, idleStopChanges.changing);
	const elsewhere = !busy && sandbox !== undefined && changing.has(sandbox.id);
	// What it has now, until another is picked.
	const offered = idleStopChoices(sandbox?.idleStopMinutes);
	const shown = choice ?? offered.choice;
	const close = () => {
		setFailure(undefined);
		setChoice(undefined);
		onClose();
	};
	return (
		<Dialog
			open={sandbox !== undefined}
			title="Idle stop"
			onClose={close}
			onSubmit={() => {
				if (sandbox === undefined) return;
				run(async () => {
					await onSet(sandbox, shown === "never" ? undefined : Number(shown));
					setChoice(undefined);
				}, "Kantel couldn't change it. Try again.");
			}}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy || elsewhere}>
						Save
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-2 pt-2">
				<SelectField
					label="Stop when unused for"
					value={shown}
					onChange={(event) => setChoice(event.currentTarget.value)}
					options={offered.options}
				/>
				<span className="text-sm text-muted">{IDLE_STOP_HINT} Counts from now; its auto-stop still applies.</span>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

function AutoStopDialog({
	sandbox,
	onClose,
	onSet,
}: {
	sandbox: Sandbox | undefined;
	onClose: () => void;
	onSet: (box: Sandbox, minutes: number | undefined) => Promise<void>;
}) {
	const [choice, setChoice] = useState<string>("60");
	const { busy, failure, setFailure, run } = useAttempt(onClose);
	// A change from another view, or from before this dialog last closed, still on its way.
	const changing = useSyncExternalStore(autoStopChanges.subscribe, autoStopChanges.changing);
	const elsewhere = !busy && sandbox !== undefined && changing.has(sandbox.id);
	const close = () => {
		setFailure(undefined);
		onClose();
	};
	return (
		<Dialog
			open={sandbox !== undefined}
			title="Auto-stop"
			onClose={close}
			onSubmit={() => {
				if (sandbox === undefined) return;
				run(
					() => onSet(sandbox, choice === "never" ? undefined : Number(choice)),
					"Kantel couldn't change it. Try again.",
				);
			}}
			actions={
				<>
					<Button onClick={close}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy || elsewhere}>
						Save
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-2 pt-2">
				<SelectField
					label="Stop after"
					value={choice}
					onChange={(event) => setChoice(event.currentTarget.value)}
					options={AUTO_STOP_CHOICES}
				/>
				<span className="text-sm text-muted">Counts from now.</span>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

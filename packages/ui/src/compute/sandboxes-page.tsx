// The Sandboxes page (compute console, experimental): an account's sandboxes in one table, with each one's state,
// type, auto-stop countdown, latest snapshot, cost (hosted) and CPU sparkline, and a menu of what can be done with
// it: copy the ssh command, open its desktop or browser, read its command history, stop, resume, fork, recover, save
// a snapshot or delete it for good. New sandbox shows the new row at once, starting, and the page follows it until
// it's running. Every call goes through the `SandboxesSource` the host binds; stories bind it to fixtures.

import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, buttonClass } from "../primitives/button.tsx";
import { SegmentedControl, SelectField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { compactAge, duration } from "../primitives/format.ts";
import { ForkIcon, GlobeIcon, PlusIcon, StopIcon, TerminalIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { AppWindowIcon, EllipsisIcon, PlayIcon, ProxyIcon, ReconnectIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge, StatusLabel } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import {
	type ComputeAccount,
	type CreateSandboxInput,
	costText,
	type Environment,
	type HostingMode,
	SANDBOX_KIND_LABELS,
	SANDBOX_SIZES,
	SANDBOX_STATE_LABELS,
	SANDBOX_STATE_STATUS,
	type Sandbox,
	type SandboxCommand,
	type SandboxesSource,
	type SandboxKind,
	type SandboxSize,
	type SavedSnapshot,
	sandboxActions,
	sandboxMoving,
	shortId,
	sizeText,
	stopsInText,
} from "./compute-model.ts";
import {
	cellMono,
	cellSub,
	computePage,
	messageOf,
	rowHover,
	Sparkline,
	TableFrame,
	table,
	tableFrame,
	td,
	th,
} from "./parts.tsx";
import { ChangeCounter, keepShown, stillToDo } from "./sandbox-selection.ts";

export type SandboxFilter = "all" | "running" | "stopped";

export interface SandboxesPageProps {
	readonly source: SandboxesSource;
	readonly account: ComputeAccount;
	readonly hosting: HostingMode;
	/** Saved snapshots a new sandbox can start from, and saving one from a sandbox. */
	readonly snapshots?: {
		saved(accountId: string): Promise<readonly SavedSnapshot[]>;
		save(sandboxId: string, name: string): Promise<SavedSnapshot>;
	};
	/** A sandbox's snapshots on the Snapshots page. */
	readonly snapshotsHref?: (sandboxId: string) => string;
	/** The account's environments, which New sandbox offers to start from. */
	readonly environments?: (accountId: string) => Promise<readonly Environment[]>;
	/** Opens a sandbox's egress page: its log, placeholders and grants. */
	readonly onEgress?: (sandboxId: string) => void;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** How often the list is read again while a sandbox is starting or stopping, in milliseconds. Default 1000. */
	readonly pollMs?: number;
	/** Open New sandbox when the page opens, for a story or a `?new` link. */
	readonly creating?: boolean;
	/**
	 * The deployment has no host yet, and the person may add one: with no sandboxes, the page says sandboxes need a host
	 * and links here (the Hosts page's Add a host) rather than offering New sandbox.
	 */
	readonly addHostHref?: string;
	/**
	 * The person's account has no host of its own yet, and may add one. The deployment may still have shared hosts the
	 * account can use, so with no sandboxes New sandbox stays the action, with a link here to add a host beside it.
	 */
	readonly ownHostHref?: string;
}

const AUTO_STOP_CHOICES = [
	{ value: "15", label: "15 minutes" },
	{ value: "60", label: "1 hour" },
	{ value: "480", label: "8 hours" },
	{ value: "1440", label: "1 day" },
	{ value: "never", label: "Never (always on)" },
] as const;

const FILTERS: readonly { value: SandboxFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "running", label: "Running" },
	{ value: "stopped", label: "Stopped" },
];

const matches = (box: Sandbox, filter: SandboxFilter): boolean =>
	filter === "all" || (filter === "stopped") === (box.state === "stopped" || box.state === "error");

/** A search finds a sandbox by its name, hostname, ID or environment, ignoring case. */
const found = (box: Sandbox, query: string): boolean => {
	const words = query.trim().toLowerCase();
	if (words === "") return true;
	return [box.name, box.hostname, box.id, box.environment?.name ?? ""].some((text) =>
		text.toLowerCase().includes(words),
	);
};

/** Re-renders every `ms` while `on`, so countdowns keep up. */
function useTick(on: boolean, ms: number): void {
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!on) return;
		const timer = setInterval(() => setTick((value) => value + 1), ms);
		return () => clearInterval(timer);
	}, [on, ms]);
}

export function SandboxesPage({
	source,
	account,
	hosting,
	snapshots,
	snapshotsHref,
	environments,
	onEgress,
	now: fixedNow,
	pollMs = 1000,
	creating = false,
	addHostHref,
	ownHostHref,
}: SandboxesPageProps) {
	const { state, reload } = useLoad(() => source.list(account.id), [source, account.id]);
	// Sandboxes made or changed here, ahead of the next read: a new one shows the moment New sandbox is pressed.
	const [local, setLocal] = useState<ReadonlyMap<string, Sandbox | null>>(new Map());
	const [filter, setFilter] = useState<SandboxFilter>("all");
	const [query, setQuery] = useState("");
	const [newOpen, setNewOpen] = useState(creating);
	const [notice, setNotice] = useState<{ level: "info" | "error"; text: string }>();
	useTick(fixedNow === undefined, 30_000);
	const now = fixedNow ?? Date.now();

	const listed = state.status === "ready" ? state.value : undefined;
	const sandboxes = useMemo(() => {
		if (listed === undefined) return undefined;
		const byId = new Map(listed.map((box) => [box.id, box]));
		for (const [id, box] of local) {
			if (box === null) byId.delete(id);
			else byId.set(id, box);
		}
		return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
	}, [listed, local]);

	// Read again while anything is between states, then forget what this page changed: the list has it now.
	const moving = sandboxes?.some((box) => sandboxMoving(box.state)) === true;
	// biome-ignore lint/correctness/useExhaustiveDependencies: each read schedules the next while something moves.
	useEffect(() => {
		if (!moving) return;
		const timer = setTimeout(reload, pollMs);
		return () => clearTimeout(timer);
	}, [moving, reload, pollMs, listed]);
	useEffect(() => {
		if (listed === undefined) return;
		setLocal((current) => {
			if (current.size === 0) return current;
			const next = new Map(current);
			for (const [id, box] of current) {
				const read = listed.some((entry) => entry.id === id);
				// A change is forgotten once a read has the sandbox (or, for a delete, no longer has it); a new one's
				// placeholder stays until its create answers.
				if (box === null ? !read : read) next.delete(id);
			}
			return next.size === current.size ? current : next;
		});
	}, [listed]);

	// What this page changed shows at once, and the list is read again behind it. A bulk stop's answer passes what it
	// asked, so it doesn't undo a change (a delete) that came after it.
	const changes = useRef(new ChangeCounter()).current;
	const change = useCallback(
		(box: Sandbox | null, id: string, asked?: number) => {
			if (!changes.take(id, asked)) return;
			setLocal((current) => new Map(current).set(id, box));
			if (!id.startsWith("pending_")) reload();
		},
		[reload, changes],
	);

	const create = async (input: CreateSandboxInput) => {
		setNewOpen(false);
		// The row shows at once under a temporary id; the real one replaces it when the call answers.
		const pendingId = `pending_${Date.now().toString(36)}`;
		const placeholder: Sandbox = {
			id: pendingId,
			name: input.name?.trim() || "new-sandbox",
			hostname: "",
			accountId: input.accountId,
			kind: input.kind,
			size: input.size,
			state: "starting",
			createdAt: Date.now(),
			createdBy: "",
			usage: [],
		};
		change(placeholder, pendingId);
		try {
			const made = await source.create(input);
			setLocal((current) => {
				const next = new Map(current);
				next.delete(pendingId);
				return next.set(made.id, made);
			});
			reload();
		} catch (caught) {
			change(null, pendingId);
			setNotice({ level: "error", text: messageOf(caught, "Kantel couldn't create the sandbox. Try again.") });
		}
	};

	const counts = useMemo(() => {
		const all = sandboxes ?? [];
		return {
			all: all.length,
			running: all.filter((box) => matches(box, "running")).length,
			stopped: all.filter((box) => matches(box, "stopped")).length,
		};
	}, [sandboxes]);
	const shown = sandboxes?.filter((box) => matches(box, filter) && found(box, query));

	return (
		<div className={computePage}>
			<PageHeader
				title="Sandboxes"
				lede={
					account.kind === "organisation"
						? `Sandboxes in ${account.name}. Everyone in the organisation can see and use them.`
						: "Your own sandboxes. Switch to an organisation to share them."
				}
				actions={
					<Button variant="primary" icon={<PlusIcon size="sm" />} onClick={() => setNewOpen(true)}>
						New sandbox
					</Button>
				}
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
			{state.status === "error" && sandboxes === undefined ? (
				<Notice
					level="error"
					action={
						<Button size="sm" onClick={reload}>
							Try again
						</Button>
					}
				>
					{messageOf(state.error, "Kantel couldn't read the sandboxes.")}
				</Notice>
			) : sandboxes === undefined ? (
				<SandboxesSkeleton />
			) : sandboxes.length === 0 && addHostHref !== undefined ? (
				<EmptyState
					title="Add a host to run sandboxes on"
					action={
						<a className={`${buttonClass("primary", "sm")} no-underline`} href={addHostHref}>
							<PlusIcon size="sm" />
							Add a host
						</a>
					}
				>
					Sandboxes run on hosts: Linux machines running the Kantel host agent. This install has none yet. Adding one
					takes one command on the machine, which then dials out to this console, so it needs no inbound ports.
				</EmptyState>
			) : sandboxes.length === 0 ? (
				<EmptyState
					title="No sandboxes yet"
					action={
						<div className="flex flex-wrap items-center justify-center gap-2">
							<Button variant="primary" icon={<PlusIcon size="sm" />} onClick={() => setNewOpen(true)}>
								New sandbox
							</Button>
							{ownHostHref === undefined ? null : (
								<a className={`${buttonClass("secondary", "sm")} no-underline`} href={ownHostHref}>
									Add a host of your own
								</a>
							)}
						</div>
					}
				>
					A sandbox is a Linux machine for an agent: an isolate that starts in milliseconds, or a microVM with root,
					Docker and its own kernel. Make one here, or from the CLI with kantel new.
					{ownHostHref === undefined
						? null
						: " If there's no host here for your account, add a Linux machine of your own: one command on it, and only your account's sandboxes run there."}
				</EmptyState>
			) : (
				<>
					{/* The search takes the row, and the filter sits after it; on a phone the search is the row's whole width
					    and the filter wraps under it. */}
					<div className="flex flex-wrap items-center gap-2">
						<TextField
							label="Search sandboxes"
							hideLabel
							type="search"
							placeholder="Search by name, hostname or ID"
							className="min-w-0 flex-[1_1_var(--kt-popover-width)]"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
						<SegmentedControl
							label="Show sandboxes"
							options={FILTERS.map((option) => ({ ...option, count: counts[option.value] }))}
							value={filter}
							onChange={setFilter}
						/>
					</div>
					<SandboxTable
						sandboxes={shown ?? []}
						hosting={hosting}
						now={now}
						source={source}
						{...(snapshots === undefined ? {} : { save: snapshots.save })}
						{...(snapshotsHref === undefined ? {} : { snapshotsHref })}
						{...(onEgress === undefined ? {} : { onEgress })}
						onChange={change}
						asked={(id) => changes.ask(id)}
						onNotice={setNotice}
					/>
				</>
			)}
			<NewSandboxDialog
				open={newOpen}
				account={account}
				hosting={hosting}
				sizeFigures={source.sizeFigures ?? true}
				{...(snapshots === undefined ? {} : { savedSnapshots: () => snapshots.saved(account.id) })}
				{...(environments === undefined ? {} : { environments: () => environments(account.id) })}
				onClose={() => setNewOpen(false)}
				onCreate={(input) => void create(input)}
			/>
		</div>
	);
}

function SandboxesSkeleton() {
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

type NoticeSetter = (notice: { level: "info" | "error"; text: string } | undefined) => void;

function SandboxTable({
	sandboxes,
	hosting,
	now,
	source,
	save,
	snapshotsHref,
	onEgress,
	onChange,
	asked,
	onNotice,
}: {
	sandboxes: readonly Sandbox[];
	hosting: HostingMode;
	now: number;
	source: SandboxesSource;
	save?: (sandboxId: string, name: string) => Promise<SavedSnapshot>;
	snapshotsHref?: (sandboxId: string) => string;
	onEgress?: (sandboxId: string) => void;
	onChange: (box: Sandbox | null, id: string, asked?: number) => void;
	/** Where a sandbox's changes have got to, for `onChange` from an answer that may be overtaken. */
	asked: (id: string) => number;
	onNotice: NoticeSetter;
}) {
	const [history, setHistory] = useState<Sandbox>();
	const [deleting, setDeleting] = useState<readonly Sandbox[]>();
	const [saving, setSaving] = useState<Sandbox>();
	// The sandboxes ticked, by ID. One a search, a filter or a delete hides is dropped, so it can't come back ticked.
	const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
	const selectable = sandboxes.filter((box) => !box.id.startsWith("pending_"));
	const shownIds = selectable.map((box) => box.id).join(" ");
	useEffect(() => setTicked((current) => keepShown(current, shownIds.split(" "))), [shownIds]);
	const selected = selectable.filter((box) => ticked.has(box.id));
	const allTicked = selectable.length > 0 && selected.length === selectable.length;
	const someTicked = selected.length > 0 && !allTicked;
	const tickAll = (on: boolean) => setTicked(on ? new Set(selectable.map((box) => box.id)) : new Set());
	const tick = (id: string, on: boolean) =>
		setTicked((current) => {
			const next = new Set(current);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});
	const stoppable = selected.filter((box) => sandboxActions(box.state).stop);
	const [stopping, setStopping] = useState(false);
	const stopSelected = async () => {
		setStopping(true);
		// Each answer shows as it comes, unless that sandbox changed since (a row's own stop or delete).
		const results = await Promise.allSettled(
			stoppable.map(async (box) => {
				const since = asked(box.id);
				onChange(await source.stop(box.id), box.id, since);
			}),
		);
		setStopping(false);
		const failed = results.filter((result) => result.status === "rejected").length;
		if (failed > 0) onNotice({ level: "error", text: `Kantel couldn't stop ${failed} of them. Try again.` });
	};
	if (sandboxes.length === 0) {
		return <p className="m-0 text-sm text-muted">No sandboxes match.</p>;
	}
	return (
		<>
			<TableFrame
				bar={
					<SelectionBar
						count={selected.length}
						all={allTicked}
						some={someTicked}
						onAll={tickAll}
						actions={
							<>
								<Button
									size="sm"
									icon={<StopIcon size="sm" />}
									disabled={stoppable.length === 0}
									busy={stopping}
									onClick={() => void stopSelected()}
								>
									Stop
								</Button>
								<Button size="sm" variant="danger" icon={<TrashIcon />} onClick={() => setDeleting(selected)}>
									Delete
								</Button>
							</>
						}
					/>
				}
			>
				<table className={table}>
					<thead>
						<tr>
							<th className={`${th} w-0 pr-0`} scope="col">
								<TickBox
									label="Select all sandboxes"
									checked={allTicked}
									indeterminate={someTicked}
									disabled={selectable.length === 0}
									onChange={tickAll}
								/>
							</th>
							<th className={th} scope="col">
								Name
							</th>
							<th className={th} scope="col">
								ID
							</th>
							<th className={th} scope="col">
								State
							</th>
							<th className={th} scope="col">
								Created
							</th>
							<th className={th} scope="col">
								Type
							</th>
							<th className={th} scope="col">
								Stops in
							</th>
							<th className={th} scope="col">
								Snapshot
							</th>
							{hosting === "hosted" ? (
								<th className={`${th} text-right`} scope="col">
									Cost
								</th>
							) : null}
							<th className={th} scope="col">
								Usage
							</th>
							<th className={th} scope="col">
								<span className="kt-sr-only">Actions</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{sandboxes.map((box) => (
							<SandboxRow
								key={box.id}
								sandbox={box}
								hosting={hosting}
								now={now}
								source={source}
								canSave={save !== undefined}
								{...(snapshotsHref === undefined ? {} : { snapshotsHref })}
								{...(onEgress === undefined ? {} : { onEgress })}
								onChange={onChange}
								onNotice={onNotice}
								onHistory={setHistory}
								onDelete={(box) => setDeleting([box])}
								onSave={setSaving}
								ticked={ticked.has(box.id)}
								onTick={(on) => tick(box.id, on)}
							/>
						))}
					</tbody>
				</table>
			</TableFrame>
			<HistoryDialog sandbox={history} source={source} now={now} onClose={() => setHistory(undefined)} />
			<DeleteDialog
				sandboxes={deleting}
				onClose={() => setDeleting(undefined)}
				onDelete={async (boxes) => {
					const results = await Promise.allSettled(boxes.map((box) => source.remove(box.id)));
					const gone = boxes.filter((_, at) => results[at]?.status === "fulfilled");
					for (const box of gone) onChange(null, box.id);
					setTicked(new Set());
					const failure = results.find((result) => result.status === "rejected");
					if (failure !== undefined) {
						// The dialog stays open on the ones that are left, so Delete again doesn't retry the deleted.
						setDeleting(stillToDo(boxes, results));
						throw failure.reason;
					}
					onNotice({
						level: "info",
						text:
							gone.length === 1
								? `Deleted ${gone[0]?.name} and its snapshots.`
								: `Deleted ${gone.length} sandboxes and their snapshots.`,
					});
				}}
			/>
			{save === undefined ? null : (
				<SaveSnapshotDialog
					sandbox={saving}
					onClose={() => setSaving(undefined)}
					onSave={async (box, name) => {
						await save(box.id, name);
						onNotice({ level: "info", text: `Saved ${box.name} as ${name}.` });
					}}
				/>
			)}
		</>
	);
}

function SandboxRow({
	sandbox,
	hosting,
	now,
	source,
	canSave,
	snapshotsHref,
	onEgress,
	onChange,
	onNotice,
	onHistory,
	onDelete,
	onSave,
	ticked,
	onTick,
}: {
	sandbox: Sandbox;
	hosting: HostingMode;
	now: number;
	source: SandboxesSource;
	canSave: boolean;
	snapshotsHref?: (sandboxId: string) => string;
	onEgress?: (sandboxId: string) => void;
	onChange: (box: Sandbox | null, id: string) => void;
	onNotice: NoticeSetter;
	onHistory: (box: Sandbox) => void;
	onDelete: (box: Sandbox) => void;
	onSave: (box: Sandbox) => void;
	ticked: boolean;
	onTick: (on: boolean) => void;
}) {
	const pending = sandbox.id.startsWith("pending_");
	const can = sandboxActions(sandbox.state);
	const peak = Math.round(Math.max(0, ...sandbox.usage) * 100);

	const act = async (what: string, call: () => Promise<Sandbox>, then?: (box: Sandbox) => void) => {
		try {
			const box = await call();
			onChange(box, box.id);
			then?.(box);
		} catch (caught) {
			onNotice({ level: "error", text: messageOf(caught, `Kantel couldn't ${what} ${sandbox.name}. Try again.`) });
		}
	};
	const openAccess = async (which: "ssh" | "desktop" | "watch" | "browser") => {
		try {
			const access = await source.access(sandbox.id);
			if (which === "ssh") {
				await navigator.clipboard?.writeText(access.ssh);
				onNotice({ level: "info", text: `Copied: ${access.ssh}` });
			} else {
				const url = { desktop: access.desktopUrl, watch: access.desktopViewUrl, browser: access.browserUrl }[which];
				window.open(url, "_blank", "noopener");
			}
		} catch (caught) {
			onNotice({ level: "error", text: messageOf(caught, "Kantel couldn't reach the sandbox. Try again.") });
		}
	};

	const entries: MenuEntry[] = [
		{
			kind: "item",
			id: "ssh",
			label: "Copy SSH command",
			icon: <TerminalIcon size="sm" />,
			disabled: !can.connect,
			onSelect: () => void openAccess("ssh"),
		},
		{
			kind: "item",
			id: "desktop",
			label: "Open desktop",
			icon: <AppWindowIcon />,
			disabled: !can.connect || sandbox.kind === "isolate",
			onSelect: () => void openAccess("desktop"),
		},
		{
			kind: "item",
			id: "watch",
			label: "Watch desktop",
			icon: <AppWindowIcon />,
			disabled: !can.connect || sandbox.kind === "isolate",
			onSelect: () => void openAccess("watch"),
		},
		{
			kind: "item",
			id: "browser",
			label: "Open browser",
			icon: <GlobeIcon size="sm" />,
			disabled: !can.connect || sandbox.kind === "isolate",
			onSelect: () => void openAccess("browser"),
		},
		{ kind: "item", id: "history", label: "Command history", onSelect: () => onHistory(sandbox) },
		...(onEgress === undefined || pending
			? []
			: [
					{
						kind: "item" as const,
						id: "egress",
						label: "Egress log and grants",
						icon: <ProxyIcon />,
						onSelect: () => onEgress(sandbox.id),
					},
				]),
		{ kind: "separator", id: "sep-power" },
		can.stop
			? {
					kind: "item",
					id: "stop",
					label: "Stop",
					icon: <StopIcon size="sm" />,
					onSelect: () => void act("stop", () => source.stop(sandbox.id)),
				}
			: {
					kind: "item",
					id: "resume",
					label: "Resume",
					icon: <PlayIcon />,
					disabled: !can.resume,
					onSelect: () => void act("resume", () => source.resume(sandbox.id)),
				},
		{
			kind: "item",
			id: "fork",
			label: "Fork",
			icon: <ForkIcon size="sm" />,
			disabled: !can.fork || sandbox.snapshot === undefined,
			onSelect: () =>
				void act(
					"fork",
					() => source.fork(sandbox.id),
					(box) => onNotice({ level: "info", text: `Forked ${sandbox.name} as ${box.name}.` }),
				),
		},
		{
			kind: "item",
			id: "recover",
			label: "Recover",
			icon: <ReconnectIcon />,
			disabled: !can.recover,
			onSelect: () => void act("recover", () => source.recover(sandbox.id)),
		},
		...(canSave
			? [
					{
						kind: "item" as const,
						id: "save",
						label: "Save snapshot",
						disabled: sandbox.snapshot === undefined,
						onSelect: () => onSave(sandbox),
					},
				]
			: []),
		{ kind: "separator", id: "sep-delete" },
		{
			kind: "item",
			id: "delete",
			label: "Delete permanently",
			icon: <TrashIcon />,
			danger: true,
			onSelect: () => onDelete(sandbox),
		},
	];

	const status = SANDBOX_STATE_STATUS[sandbox.state];
	return (
		<tr className={`kt-sandbox-row ${rowHover}`} data-sandbox={sandbox.id}>
			<td className={`${td} w-0 pr-0`}>
				<TickBox label={`Select ${sandbox.name}`} checked={ticked} disabled={pending} onChange={onTick} />
			</td>
			<td className={td}>
				<span className="block max-w-(--kt-card-width) truncate font-medium text-fg">{sandbox.name}</span>
				{sandbox.hostname === "" ? null : <span className={`${cellSub} truncate`}>{sandbox.hostname}</span>}
				{sandbox.environment === undefined ? null : (
					<span className={`${cellSub} truncate`}>Environment {sandbox.environment.name}</span>
				)}
			</td>
			<td className={td}>
				<span className={cellMono} title={sandbox.id}>
					{pending ? "–" : shortId(sandbox.id)}
				</span>
			</td>
			<td className={td}>
				<span title={sandbox.error}>
					<StatusLabel status={status}>{SANDBOX_STATE_LABELS[sandbox.state]}</StatusLabel>
				</span>
			</td>
			<td className={td}>
				<span className="text-muted" title={new Date(sandbox.createdAt).toLocaleString("en-GB")}>
					{compactAge(sandbox.createdAt, now)}
				</span>
			</td>
			<td className={td}>
				<span className="flex items-center gap-2">
					<Badge tone={sandbox.kind === "microvm" ? "accent" : "neutral"}>{SANDBOX_KIND_LABELS[sandbox.kind]}</Badge>
					<span className="text-xs text-muted">{sizeText(sandbox.resources ?? sandbox.size)}</span>
				</span>
			</td>
			<td className={td}>
				<span className={sandbox.stopsAt === undefined ? "text-muted" : "text-fg"}>{stopsInText(sandbox, now)}</span>
			</td>
			<td className={td}>
				{sandbox.snapshot === undefined ? (
					<span className="text-faint">None yet</span>
				) : snapshotsHref === undefined ? (
					<span className="text-muted">{compactAge(sandbox.snapshot.takenAt, now)}</span>
				) : (
					<a
						className="text-muted underline decoration-border-strong underline-offset-2 hover:text-fg"
						href={snapshotsHref(sandbox.id)}
					>
						{compactAge(sandbox.snapshot.takenAt, now)}
					</a>
				)}
			</td>
			{hosting === "hosted" ? (
				<td className={`${td} text-right tabular-nums`}>{costText(sandbox.costCents ?? 0)}</td>
			) : null}
			<td className={td}>
				<span className="flex items-center gap-2">
					<Sparkline
						values={sandbox.usage}
						tone={sandbox.state === "running" ? "done" : sandbox.state === "error" ? "error" : "idle"}
						label={`CPU over the last hour for ${sandbox.name}, peak ${peak}%`}
					/>
					<span className="w-8 text-right text-xs text-muted tabular-nums">
						{sandbox.state === "running" ? `${Math.round((sandbox.usage.at(-1) ?? 0) * 100)}%` : ""}
					</span>
				</span>
			</td>
			<td className={`${td} w-0 text-right`}>
				{pending ? null : (
					<Menu label={`Actions for ${sandbox.name}`} icon={<EllipsisIcon />} entries={entries} align="end" />
				)}
			</td>
		</tr>
	);
}

/** New sandbox: a name, isolate or microVM, a size, when it stops and what it starts from. Creating closes it at once. */
function NewSandboxDialog({
	open,
	account,
	hosting,
	sizeFigures,
	savedSnapshots,
	environments,
	onClose,
	onCreate,
}: {
	open: boolean;
	account: ComputeAccount;
	hosting: HostingMode;
	sizeFigures: boolean;
	savedSnapshots?: () => Promise<readonly SavedSnapshot[]>;
	environments?: () => Promise<readonly Environment[]>;
	onClose: () => void;
	onCreate: (input: CreateSandboxInput) => void;
}) {
	const [name, setName] = useState("");
	const [kind, setKind] = useState<SandboxKind>("microvm");
	const [size, setSize] = useState<SandboxSize>("medium");
	const [autoStop, setAutoStop] = useState("60");
	const [from, setFrom] = useState("");
	const [environment, setEnvironment] = useState("");
	const [saved, setSaved] = useState<readonly SavedSnapshot[]>([]);
	const [envs, setEnvs] = useState<readonly Environment[]>([]);
	const asked = useRef(false);
	useEffect(() => {
		if (!open || asked.current) return;
		asked.current = true;
		savedSnapshots?.().then(setSaved, () => setSaved([]));
		environments?.().then(setEnvs, () => setEnvs([]));
	}, [open, savedSnapshots, environments]);
	const valid = name === "" || /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(name);
	const fromOptions = saved.filter((entry) => entry.kind === kind);
	const submit = () => {
		if (!valid) return;
		onCreate({
			accountId: account.id,
			...(name === "" ? {} : { name }),
			kind,
			size: kind === "isolate" ? "small" : size,
			...(from === "" ? {} : { fromSnapshot: from }),
			...(environment === "" ? {} : { environmentId: environment }),
			...(autoStop === "never" ? {} : { autoStopMinutes: Number(autoStop) }),
		});
		setName("");
		setFrom("");
		setEnvironment("");
	};
	return (
		<Dialog
			open={open}
			title="New sandbox"
			onClose={onClose}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="primary" disabled={!valid}>
						Create
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-4 pt-2">
				<TextField
					label="Name"
					hint={`Lowercase letters, digits and dashes. ${
						account.slug === undefined ? "Its address starts with it." : `Its address is <name>.${account.slug}.`
					} Leave it empty for one Kantel picks.`}
					value={name}
					onChange={(event) => setName(event.currentTarget.value)}
					placeholder="api-server"
					mono
					{...(valid ? {} : { error: "Use lowercase letters, digits and dashes, up to 40." })}
				/>
				<div className="flex flex-col gap-1.5">
					<span className="text-sm font-medium text-fg">Type</span>
					<SegmentedControl
						label="Type"
						options={[
							{ value: "microvm", label: "MicroVM" },
							{ value: "isolate", label: "Isolate" },
						]}
						value={kind}
						onChange={setKind}
					/>
					<span className="text-xs text-muted">
						{kind === "microvm"
							? "A Firecracker microVM: root, Docker, systemd and /dev/kvm inside. Up in about a second."
							: "A V8 isolate with a shell and JavaScript. Up in milliseconds, nearly free, no Docker."}
					</span>
				</div>
				{kind === "microvm" ? (
					<SelectField
						label="Size"
						value={size}
						onChange={(event) => setSize(event.currentTarget.value as SandboxSize)}
						options={SANDBOX_SIZES.map((spec) => ({
							value: spec.size,
							label: sizeFigures
								? `${spec.label}: ${spec.vcpus} vCPU, ${spec.memoryGb} GB, ${spec.diskGb} GB disk${
										hosting === "hosted" && spec.centsPerHour !== undefined
											? `, ${costText(spec.centsPerHour)} an hour`
											: ""
									}`
								: spec.label,
						}))}
					/>
				) : null}
				{envs.length === 0 ? null : (
					<SelectField
						label="Environment"
						hint="Its variables, secret files, repositories and egress grants. A protected variable is a placeholder in the sandbox."
						value={environment}
						onChange={(event) => setEnvironment(event.currentTarget.value)}
						options={[{ value: "", label: "None" }, ...envs.map((env) => ({ value: env.id, label: env.name }))]}
					/>
				)}
				<SelectField
					label="Stop after"
					hint="It keeps its disk as a snapshot when it stops, so you can resume it."
					value={autoStop}
					onChange={(event) => setAutoStop(event.currentTarget.value)}
					options={AUTO_STOP_CHOICES}
				/>
				{savedSnapshots === undefined ? null : (
					<SelectField
						label="Start from"
						value={from}
						onChange={(event) => setFrom(event.currentTarget.value)}
						options={[
							{ value: "", label: kind === "microvm" ? "A clean Ubuntu 24.04" : "A clean isolate" },
							...fromOptions.map((entry) => ({ value: entry.id, label: `Saved snapshot ${entry.name}` })),
						]}
					/>
				)}
			</div>
		</Dialog>
	);
}

function HistoryDialog({
	sandbox,
	source,
	now,
	onClose,
}: {
	sandbox: Sandbox | undefined;
	source: SandboxesSource;
	now: number;
	onClose: () => void;
}) {
	const [commands, setCommands] = useState<readonly SandboxCommand[] | "loading" | Error>("loading");
	useEffect(() => {
		if (sandbox === undefined) return;
		let live = true;
		setCommands("loading");
		source.history(sandbox.id).then(
			(list) => live && setCommands(list),
			(caught: unknown) => live && setCommands(caught instanceof Error ? caught : new Error(String(caught))),
		);
		return () => {
			live = false;
		};
	}, [sandbox, source]);
	let body: ReactNode;
	if (commands === "loading") body = <Skeleton />;
	else if (commands instanceof Error) body = <p className="kt-dialog-error">{commands.message}</p>;
	else if (commands.length === 0) body = <p>No commands have run in it yet.</p>;
	else
		body = (
			<ol className="m-0 flex max-h-(--kt-popover-height) list-none flex-col divide-y divide-border overflow-y-auto p-0">
				{commands.map((command) => (
					<li key={command.id} className="flex flex-col gap-0.5 py-2">
						<code className="font-mono text-code text-fg break-all">{command.command}</code>
						<span className="text-xs text-muted">
							{compactAge(command.startedAt, now)} ago by {command.by}
							{command.durationMs === undefined ? ", running" : `, took ${duration(command.durationMs)}`}
							{command.exitCode === undefined ? "" : `, exit ${command.exitCode}`}
						</span>
					</li>
				))}
			</ol>
		);
	return (
		<Dialog
			open={sandbox !== undefined}
			title={sandbox === undefined ? "Command history" : `Command history of ${sandbox.name}`}
			onClose={onClose}
			actions={<Button onClick={onClose}>Close</Button>}
		>
			<div className="w-(--kt-card-width) max-w-full">{body}</div>
		</Dialog>
	);
}

/** A row's checkbox, or the header's for all of them: `indeterminate` when some are ticked. */
function TickBox({
	id,
	label,
	checked,
	indeterminate = false,
	disabled = false,
	onChange,
}: {
	id?: string;
	label: string;
	checked: boolean;
	indeterminate?: boolean;
	disabled?: boolean;
	onChange: (on: boolean) => void;
}) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (ref.current !== null) ref.current.indeterminate = indeterminate;
	}, [indeterminate]);
	return (
		<input
			ref={ref}
			id={id}
			type="checkbox"
			className="kt-checkbox kt-focusable m-0 block size-3.5 cursor-pointer accent-accent disabled:cursor-default"
			aria-label={label}
			checked={checked}
			disabled={disabled}
			onChange={(event) => onChange(event.target.checked)}
		/>
	);
}

/**
 * Over the table: what acts on the ticked sandboxes, once any are, and on a phone's cards Select all, which the table's
 * header has everywhere else.
 */
function SelectionBar({
	count,
	all,
	some,
	onAll,
	actions,
}: {
	count: number;
	all: boolean;
	some: boolean;
	onAll: (on: boolean) => void;
	actions: ReactNode;
}) {
	const allId = useId();
	return (
		<div
			className={`kt-selection-bar min-h-control-sm flex-wrap items-center gap-x-3 gap-y-2 ${count === 0 ? "kt-table-cards-only" : "flex"}`}
		>
			{/* Shown only on the cards: the table's header has its own. */}
			<span className="kt-table-cards-only items-center gap-2 px-4 text-sm text-muted">
				<TickBox id={allId} label="Select all" checked={all} indeterminate={some} onChange={onAll} />
				<label htmlFor={allId} className="cursor-pointer">
					Select all
				</label>
			</span>
			{count === 0 ? null : (
				<>
					<span className="text-sm text-fg tabular-nums" aria-live="polite">
						{count} selected
					</span>
					<span className="ml-auto flex flex-wrap items-center gap-2">
						{actions}
						<Button size="sm" variant="ghost" onClick={() => onAll(false)}>
							Clear
						</Button>
					</span>
				</>
			)}
		</div>
	);
}

function DeleteDialog({
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
	const close = () => {
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
							setBusy(true);
							onDelete(sandboxes).then(
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

function SaveSnapshotDialog({
	sandbox,
	onClose,
	onSave,
}: {
	sandbox: Sandbox | undefined;
	onClose: () => void;
	onSave: (box: Sandbox, name: string) => Promise<void>;
}) {
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const close = () => {
		setName("");
		setFailure(undefined);
		onClose();
	};
	const submit = () => {
		if (sandbox === undefined || name.trim() === "") return;
		setBusy(true);
		onSave(sandbox, name.trim()).then(
			() => {
				setBusy(false);
				close();
			},
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't save it. Try again."));
			},
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
			<p>
				Keeps <strong>{sandbox?.name}</strong>'s latest snapshot under a name until you delete it. New sandboxes can
				start from it.
			</p>
			<div className="pt-2">
				<TextField
					label="Name"
					value={name}
					onChange={(event) => setName(event.currentTarget.value)}
					placeholder="node22-base"
					mono
				/>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}

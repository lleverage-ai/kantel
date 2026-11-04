// The Sandboxes page (compute console): an account's sandboxes, for finding one and seeing its state. A table on a wide
// screen (name, with what went wrong under it, state, machine, environment, when it stops, its CPU live over the last
// two minutes, when it was made) and rows on a phone; each row opens the sandbox's page. Browser and Desktop show on a
// running microVM's row under the pointer and open in the console, Recover on a failed one's, and ⋯ has Stop, Fork,
// Save snapshot, Auto-stop, Restart on latest base (beside the state, a sandbox on an outdated base says so) and
// Delete. New makes a sandbox at once with the defaults (a medium
// microVM that stops after an hour); its caret opens New sandbox to choose. Either way the new row shows at once,
// starting, at the top, and the page follows it until it's running. Rows can be ticked (Select all is the table's head,
// or over a phone's rows) to stop or delete several at once. Every call goes through the `SandboxesSource` the host
// binds; stories bind it to fixtures.

import { type MouseEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, buttonClass, buttonLabelClass } from "../primitives/button.tsx";
import { SegmentedControl, SelectField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { compactAge } from "../primitives/format.ts";
import { ChevronRightIcon, GlobeIcon, PlusIcon, StopIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { DesktopIcon, EllipsisIcon, PlayIcon, ReconnectIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import { SliderField } from "../primitives/slider.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { SplitButton } from "../primitives/split-button.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { BaseOutdatedBadge } from "./base-outdated.tsx";
import {
	type ComputeAccount,
	type CreateSandboxInput,
	costText,
	customShapes,
	DEFAULT_SANDBOX_SHAPES,
	type Environment,
	fitMemory,
	type HostingMode,
	memoryRangeFor,
	memoryText,
	microvmsAvailable,
	onGrid,
	presetOf,
	SANDBOX_KIND_LABELS,
	SANDBOX_STATE_LABELS,
	SANDBOX_STATE_STATUS,
	type Sandbox,
	type SandboxesSource,
	type SandboxKind,
	type SandboxShape,
	type SandboxShapes,
	type SandboxState,
	type SavedSnapshot,
	sandboxActions,
	sandboxMoving,
	shapeCentsPerHour,
	shapeCreatable,
	sizeText,
	stopsInText,
	vcpuRangeFor,
} from "./compute-model.ts";
import { lineOf, ROW_SPAN_MS, seriesOf, useLiveUsage } from "./live-usage.ts";
import { computePage, messageOf, Sparkline } from "./parts.tsx";
import { AUTO_STOP_CHOICES, DeleteDialog, type SandboxNotice, useSandboxMenu } from "./sandbox-actions.tsx";
import { popOut } from "./sandbox-screen.tsx";
import { ChangeCounter, changeTaken, keepShown, retryTargets } from "./sandbox-selection.ts";

/** A view of one sandbox's page that a row links to. */
export type SandboxRowView = "overview" | "desktop" | "browser";

export type SandboxFilter = "all" | "running" | "stopped" | "error";

export interface SandboxesPageProps {
	readonly source: SandboxesSource;
	readonly account: ComputeAccount;
	readonly hosting: HostingMode;
	/** Saved snapshots a new sandbox can start from, and saving one from a sandbox. */
	readonly snapshots?: {
		saved(accountId: string): Promise<readonly SavedSnapshot[]>;
		save(sandboxId: string, name: string): Promise<SavedSnapshot>;
	};
	/** The address of a sandbox's page, or of its desktop or browser there. Without it rows open nothing. */
	readonly sandboxHref?: (sandboxId: string, view?: SandboxRowView) => string;
	/** Goes to a path in the app; without it a row's link is followed. */
	readonly navigate?: (path: string) => void;
	/** The account's environments, which New sandbox offers to start from. */
	readonly environments?: (accountId: string) => Promise<readonly Environment[]>;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** How often the list is read again while a sandbox is starting or stopping, in milliseconds. Default 1000. */
	readonly pollMs?: number;
	/** Open New sandbox when the page opens, for a story or a `?new` link. */
	readonly creating?: boolean;
	/** A phone: rows rather than the table. */
	readonly narrow?: boolean;
	/**
	 * The deployment has no host yet, and the person may add one: there is no New (nothing could run it), and with no
	 * sandboxes the page says sandboxes need a host and links here (the Hosts page's Add a host).
	 */
	readonly addHostHref?: string;
	/**
	 * The person's account has no host of its own yet, and may add one. The deployment may still have shared hosts the
	 * account can use, so with no sandboxes New stays the action, with a link here to add a host beside it.
	 */
	readonly ownHostHref?: string;
	/**
	 * With `addHostHref`, what the page shows in place of its list while there are no sandboxes: the first run, which
	 * adds the host right here. Without it, a link to Hosts' Add host.
	 */
	readonly firstRun?: ReactNode;
}

/**
 * What New makes without asking: "MicroVM, the deployment's default shape, stops after 1 hour". No shape: the API
 * gives the default.
 */
export const QUICK_SANDBOX = { kind: "microvm", autoStopMinutes: 60 } as const satisfies Omit<
	CreateSandboxInput,
	"accountId"
>;

const FILTERS: readonly { value: SandboxFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "running", label: "Running" },
	{ value: "stopped", label: "Stopped" },
	{ value: "error", label: "Error" },
];

/** Which filter a state counts under: a failed sandbox isn't a stopped one, and a paused one is. */
const bucket = (state: SandboxState): Exclude<SandboxFilter, "all"> =>
	state === "error" ? "error" : state === "stopped" || state === "paused" ? "stopped" : "running";

const matches = (box: Sandbox, filter: SandboxFilter): boolean => filter === "all" || bucket(box.state) === filter;

/**
 * The sandboxes the list shows: those in the filter whose name has the search in it. The search field is there at every
 * width, so a search typed on a wider window can be cleared on a phone too.
 */
export const sandboxesShown = (
	sandboxes: readonly Sandbox[],
	filter: SandboxFilter,
	search: string,
): readonly Sandbox[] => {
	const needle = search.trim().toLowerCase();
	return sandboxes.filter((box) => matches(box, filter) && box.name.toLowerCase().includes(needle));
};

/**
 * Whether a row draws its CPU line: only while the sandbox runs, or has just stopped answering. A stopped, paused or
 * starting one shows nothing rather than a flat line. One with no samples yet draws a faint flat line.
 */
export const showsCpu = (box: Pick<Sandbox, "state">): boolean =>
	box.state === "running" || box.state === "stopping" || box.state === "error";

/** "in 52m", "Always on", "Now", or a dash: when auto-stop stops it. */
function stopsText(box: Sandbox, now: number): string {
	const text = stopsInText(box, now);
	return /^\d/.test(text) ? `in ${text}` : text;
}

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
	sandboxHref,
	navigate,
	environments,
	now: fixedNow,
	pollMs = 1000,
	creating = false,
	narrow = false,
	addHostHref,
	ownHostHref,
	firstRun,
}: SandboxesPageProps) {
	const { state, reload } = useLoad(() => source.list(account.id), [source, account.id]);
	// Sandboxes made or changed here, ahead of the next read: a new one shows the moment New is pressed.
	const [local, setLocal] = useState<ReadonlyMap<string, Sandbox | null>>(new Map());
	const [filter, setFilter] = useState<SandboxFilter>("all");
	const [search, setSearch] = useState("");
	const [newOpen, setNewOpen] = useState(creating);
	const [notice, setNotice] = useState<SandboxNotice>();
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
			// An answer overtaken by a later change isn't shown, but the list is still read again, so it catches up.
			const taken = changeTaken(changes, id, asked);
			if (taken.show) setLocal((current) => new Map(current).set(id, box));
			if (taken.reload) reload();
		},
		[reload, changes],
	);

	const create = async (input: CreateSandboxInput) => {
		setNewOpen(false);
		// The new row is at the top, so show it whatever was filtered.
		setFilter("all");
		setSearch("");
		// The row shows at once under a temporary id; the real one replaces it when the call answers.
		const pendingId = `pending_${Date.now().toString(36)}`;
		const placeholder: Sandbox = {
			id: pendingId,
			name: input.name?.trim() || "new-sandbox",
			hostname: "",
			accountId: input.accountId,
			kind: input.kind,
			size: "medium",
			...(input.shape === undefined
				? {}
				: { resources: { vcpus: input.shape.vcpus, memoryGb: input.shape.memoryMb / 1024, diskGb: 0 } }),
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
		return Object.fromEntries(
			FILTERS.map((option) => [option.value, all.filter((box) => matches(box, option.value)).length]),
		) as Record<SandboxFilter, number>;
	}, [sandboxes]);
	const shown = sandboxes === undefined ? undefined : sandboxesShown(sandboxes, filter, search);

	// With no host anywhere, nothing could run a new sandbox: no New until one is added.
	const newButton =
		addHostHref === undefined ? (
			<SplitButton
				label="New"
				icon={<PlusIcon size="sm" />}
				onClick={() => void create({ accountId: account.id, ...QUICK_SANDBOX })}
				moreLabel="New sandbox with options"
				onMore={() => setNewOpen(true)}
			/>
		) : undefined;

	return (
		<div className={computePage}>
			{/* The title and New on one line, on a phone too, where PageHeader would put New under the title. */}
			<header className="kt-page-header flex min-h-control-md min-w-0 items-center justify-between gap-4 border-b border-border pb-3">
				<h1 className={`kt-page-header-title m-0 truncate font-strong leading-tight text-fg text-heading`}>
					Sandboxes
				</h1>
				{newButton}
			</header>
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
			) : sandboxes.length === 0 && addHostHref !== undefined && firstRun !== undefined ? (
				firstRun
			) : sandboxes.length === 0 && addHostHref !== undefined ? (
				<EmptyState
					title="Add a host to run sandboxes on"
					action={
						<a className={`${buttonClass("primary", "sm")} no-underline`} href={addHostHref}>
							<PlusIcon size="sm" />
							<span className={buttonLabelClass}>Add host</span>
						</a>
					}
				>
					Any Linux machine with outbound HTTPS. It dials out, so it needs no open ports.
				</EmptyState>
			) : sandboxes.length === 0 ? (
				<EmptyState
					title="No sandboxes yet"
					action={
						ownHostHref === undefined ? undefined : (
							<a className="text-sm text-accent-text" href={ownHostHref}>
								Add a host of your own
							</a>
						)
					}
				>
					A Linux machine for an agent: an isolate that starts in milliseconds, or a microVM with root, Docker and its
					own kernel. Press New, or run kantel new.
				</EmptyState>
			) : (
				<>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<SegmentedControl
							label="Show sandboxes"
							options={FILTERS.filter(
								(option) => option.value !== "error" || counts.error > 0 || filter === "error",
							).map((option) => ({ ...option, count: counts[option.value] }))}
							value={filter}
							onChange={setFilter}
						/>
						<div className={narrow ? "w-full" : "w-(--kt-popover-width) max-w-full"}>
							<TextField
								label="Search sandboxes"
								hideLabel
								type="search"
								placeholder="Search"
								value={search}
								onChange={(event) => setSearch(event.currentTarget.value)}
							/>
						</div>
					</div>
					<SandboxList
						sandboxes={shown ?? []}
						hosting={hosting}
						now={now}
						narrow={narrow}
						source={source}
						{...(snapshots === undefined ? {} : { save: snapshots.save })}
						{...(sandboxHref === undefined ? {} : { sandboxHref })}
						{...(navigate === undefined ? {} : { navigate })}
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
				{...(source.shapes === undefined ? {} : { shapes: () => readShapes(source, account.id) })}
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
		<div className="flex flex-col gap-3 py-2" aria-busy="true">
			{[0, 1, 2, 3].map((row) => (
				<Skeleton key={row} />
			))}
		</div>
	);
}

type RowCalls = {
	source: SandboxesSource;
	save?: (sandboxId: string, name: string) => Promise<SavedSnapshot>;
	sandboxHref?: (sandboxId: string, view?: SandboxRowView) => string;
	navigate?: (path: string) => void;
	onChange: (box: Sandbox | null, id: string, asked?: number) => void;
	/** What to pass `onChange` with a call's answer, read as the call is made, so a later change to it wins. */
	asked?: (id: string) => number;
	onNotice: (notice: SandboxNotice | undefined) => void;
};

/** The table on a wide screen, rows on a phone, and what acts on the ticked ones. */
function SandboxList({
	sandboxes,
	hosting,
	now,
	narrow,
	source,
	save,
	sandboxHref,
	navigate,
	onChange,
	asked,
	onNotice,
}: {
	sandboxes: readonly Sandbox[];
	hosting: HostingMode;
	now: number;
	narrow: boolean;
	/** Where a sandbox's changes have got to, for `onChange` from an answer that may be overtaken. */
	asked: (id: string) => number;
} & RowCalls) {
	const [deleting, setDeleting] = useState<readonly Sandbox[]>();
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
	const calls: RowCalls = {
		source,
		...(save === undefined ? {} : { save }),
		...(sandboxHref === undefined ? {} : { sandboxHref }),
		...(navigate === undefined ? {} : { navigate }),
		onChange,
		asked,
		onNotice,
	};
	const list = narrow ? (
		<ul className="kt-sandbox-rows m-0 flex list-none flex-col p-0">
			{sandboxes.map((box) => (
				<SandboxPhoneRow
					key={box.id}
					sandbox={box}
					now={now}
					calls={calls}
					ticked={ticked.has(box.id)}
					onTick={(on) => tick(box.id, on)}
				/>
			))}
		</ul>
	) : (
		<div className="kt-compute-table min-w-0 overflow-x-auto">
			<table className="w-full border-collapse text-left text-md">
				<thead>
					<tr>
						<th className={`${head} w-0 pr-0`} scope="col">
							<TickBox
								label="Select all sandboxes"
								checked={allTicked}
								indeterminate={someTicked}
								disabled={selectable.length === 0}
								onChange={tickAll}
							/>
						</th>
						<th className={head} scope="col">
							Name
						</th>
						<th className={head} scope="col">
							State
						</th>
						<th className={head} scope="col">
							Machine
						</th>
						<th className={head} scope="col">
							Environment
						</th>
						<th className={head} scope="col">
							Stops
						</th>
						<th className={head} scope="col">
							CPU
						</th>
						{hosting === "hosted" ? (
							<th className={`${head} text-right`} scope="col">
								Cost
							</th>
						) : null}
						<th className={`${head} text-right`} scope="col">
							Created
						</th>
						<th className={head} scope="col">
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
							calls={calls}
							ticked={ticked.has(box.id)}
							onTick={(on) => tick(box.id, on)}
						/>
					))}
				</tbody>
			</table>
		</div>
	);
	return (
		// Select all sits right over the rows it ticks, closer to them than the page's gap.
		<div className="flex min-w-0 flex-col gap-2">
			<SelectionBar
				narrow={narrow}
				count={selected.length}
				all={allTicked}
				some={someTicked}
				disabled={selectable.length === 0}
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
			{list}
			<DeleteDialog
				sandboxes={deleting}
				onClose={() => setDeleting(undefined)}
				onDelete={async (boxes) => {
					const results = await Promise.allSettled(boxes.map((box) => source.remove(box.id)));
					const gone = boxes.filter((_, at) => results[at]?.status === "fulfilled");
					for (const box of gone) onChange(null, box.id);
					const failure = results.find((result) => result.status === "rejected");
					if (failure !== undefined) {
						// The dialog stays open on the ones that are left, so Delete again doesn't retry the deleted, unless it was
						// closed meanwhile or opened again on others.
						setDeleting((current) => retryTargets(current, boxes, results));
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
		</div>
	);
}

/** The table: no frame round it, a hairline under the head and under every row. */
const head = "h-control-md border-b border-border px-2 py-0 text-sm font-medium whitespace-nowrap text-muted";
const cell = "border-b border-border px-2 py-3 align-middle whitespace-nowrap";

/** Follows a link in the app without reloading, unless it's a modified click (a new tab). */
const follow = (navigate: ((path: string) => void) | undefined) => (event: LinkClick) => {
	if (navigate === undefined || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
	event.preventDefault();
	navigate(event.currentTarget.getAttribute("href") ?? "");
};

/** The click on an anchor, as much of it as `follow` and `screenLink` read. */
type LinkClick = Pick<
	MouseEvent<HTMLAnchorElement>,
	"button" | "metaKey" | "ctrlKey" | "shiftKey" | "preventDefault"
> & {
	readonly currentTarget: Pick<HTMLAnchorElement, "getAttribute">;
};

/**
 * A row's Browser and Desktop: to the sandbox's page, or each to a tab of its own where the console can't frame them
 * (`screens` "tab"), as on the sandbox's page. `openTab` runs during the click, so the browser lets the tab open.
 */
export function screenLink(
	screens: SandboxesSource["screens"],
	navigate: ((path: string) => void) | undefined,
	openTab: (view: "browser" | "desktop") => void,
): (view: "browser" | "desktop") => (event: LinkClick) => void {
	if (screens !== "tab") return () => follow(navigate);
	return (view) => (event) => {
		if (event.button !== 0) return;
		event.preventDefault();
		openTab(view);
	};
}

/** What a row can do: its buttons, and ⋯ with Stop and the sandbox menu's four. */
function useRowActions(sandbox: Sandbox, calls: RowCalls) {
	const { source, save, onChange, asked, onNotice } = calls;
	const pending = sandbox.id.startsWith("pending_");
	const can = sandboxActions(sandbox.state);
	const windows = can.connect && sandbox.kind === "microvm";
	const menu = useSandboxMenu(sandbox, {
		source,
		...(save === undefined ? {} : { save }),
		onChange,
		...(asked === undefined ? {} : { asked }),
		onNotice,
	});

	const act = async (what: string, call: () => Promise<Sandbox>) => {
		try {
			// As the menu's: an answer overtaken by a later change to it (a Delete) is dropped.
			const since = asked?.(sandbox.id);
			const box = await call();
			onChange(box, box.id, since);
		} catch (caught) {
			onNotice({ level: "error", text: messageOf(caught, `Kantel couldn't ${what} ${sandbox.name}. Try again.`) });
		}
	};
	const resume = () => void act("resume", () => source.resume(sandbox.id));
	const recover = () => void act("recover", () => source.recover(sandbox.id));

	const entries: MenuEntry[] = [
		{
			kind: "item",
			id: "stop",
			label: "Stop",
			icon: <StopIcon size="sm" />,
			disabled: !can.stop,
			onSelect: () => void act("stop", () => source.stop(sandbox.id)),
		},
		{ kind: "separator", id: "sep-stop" },
		...menu.entries,
	];
	const actions = pending ? null : (
		<>
			<Menu label={`Actions for ${sandbox.name}`} icon={<EllipsisIcon />} entries={entries} align="end" />
			{menu.dialogs}
		</>
	);
	const { sandboxHref } = calls;
	const href =
		pending || sandboxHref === undefined ? undefined : (view?: SandboxRowView) => sandboxHref(sandbox.id, view);
	const onLink = follow(calls.navigate);
	const onScreen = screenLink(source.screens, calls.navigate, (view) =>
		popOut(view, undefined, () => source.access(sandbox.id)),
	);
	return { pending, can, windows, resume, recover, actions, href, onLink, onScreen };
}

/** The state, in its colour. */
const StateLabel = ({ state }: { state: SandboxState }) => (
	<StatusLabel status={SANDBOX_STATE_STATUS[state]}>{SANDBOX_STATE_LABELS[state]}</StatusLabel>
);

/**
 * CPU over the last two minutes, as a line read again every few seconds, or nothing when it isn't running. Without a
 * live source it's the sandbox's recent CPU as listed, which doesn't move. A row in error says what happened in words
 * instead, so it draws no line.
 */
function Cpu({ sandbox, source, percent = false }: { sandbox: Sandbox; source: SandboxesSource; percent?: boolean }) {
	const shown = showsCpu(sandbox) && sandbox.state !== "error";
	const live = useLiveUsage(shown ? source.usageSeries : undefined, sandbox.id, {
		keepMs: ROW_SPAN_MS,
	});
	if (!shown) return null;
	const series = seriesOf(live);
	const line = lineOf(series, (point) => point.cpu, ROW_SPAN_MS);
	// Without a live source, its recent CPU as listed, untimed.
	const values = series === undefined ? (live.status === "off" ? sandbox.usage : []) : line.values;
	const loading = live.status === "loading";
	const latest = values.at(-1);
	const peak = Math.round(Math.max(0, ...values) * 100);
	const label =
		values.length === 0
			? `No CPU readings for ${sandbox.name} yet`
			: `CPU ${series === undefined ? "lately" : "over the last 2 minutes"} for ${sandbox.name}, peak ${peak}%`;
	return (
		<span className="inline-flex items-center gap-2">
			<Sparkline
				values={values}
				tone="done"
				label={loading ? `Reading ${sandbox.name}'s CPU` : label}
				loading={loading}
				{...(series === undefined ? {} : { timed: line.timed })}
			/>
			{percent && sandbox.state === "running" ? (
				<span className="w-8 text-right text-xs text-muted tabular-nums">
					{latest === undefined ? <span className="text-faint">–</span> : `${Math.round(latest * 100)}%`}
				</span>
			) : null}
		</span>
	);
}

/** Shown under the pointer or keyboard focus on the row, and always on a touch screen. */
const onHover =
	"opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100 transition-opacity";

/** A link styled as a ghost button: Browser and Desktop open in the console. */
const ghostLink = `${buttonClass("ghost", "sm")} relative no-underline`;

function SandboxRow({
	sandbox,
	hosting,
	now,
	calls,
	ticked,
	onTick,
}: {
	sandbox: Sandbox;
	hosting: HostingMode;
	now: number;
	calls: RowCalls;
	ticked: boolean;
	onTick: (on: boolean) => void;
}) {
	const { pending, can, windows, resume, recover, actions, href, onLink, onScreen } = useRowActions(sandbox, calls);
	const stops = stopsText(sandbox, now);
	// What went wrong gets a line of its own under the row, across the columns, rather than truncating in the name's.
	const failure = sandbox.state === "error" ? sandbox.error : undefined;
	const tone = ticked ? "bg-selected" : "hover:bg-hover";
	const row = (
		// The name's link covers the row (its ::after), so anywhere on it opens the sandbox; the tick box and the buttons
		// sit above it.
		<tr
			className={`kt-sandbox-row group/row relative ${tone} ${failure === undefined ? "" : "[&>td]:border-b-0 [&>td]:pb-1"}`}
			data-sandbox={sandbox.id}
		>
			<td className={`${cell} w-0 pr-0`}>
				<TickBox label={`Select ${sandbox.name}`} checked={ticked} disabled={pending} onChange={onTick} />
			</td>
			{/* The name takes the room the other columns leave, and truncates, so the row's actions never go off the edge. */}
			<td className={`${cell} w-full min-w-40 max-w-0`}>
				{href === undefined ? (
					<span className="block truncate font-medium text-fg" title={sandbox.name}>
						{sandbox.name}
					</span>
				) : (
					<a
						className="kt-focusable block truncate font-medium text-fg no-underline after:absolute after:inset-0"
						href={href()}
						title={sandbox.name}
						onClick={onLink}
					>
						{sandbox.name}
					</a>
				)}
			</td>
			<td className={cell}>
				{sandbox.base?.outdated === true ? (
					<span className="flex items-center gap-2">
						<StateLabel state={sandbox.state} />
						<BaseOutdatedBadge base={sandbox.base} now={now} />
					</span>
				) : (
					<StateLabel state={sandbox.state} />
				)}
			</td>
			<td className={cell}>
				{SANDBOX_KIND_LABELS[sandbox.kind]}{" "}
				<span className="text-faint">{sizeText(sandbox.resources ?? sandbox.size)}</span>
			</td>
			<td className={cell}>
				{sandbox.environment === undefined ? <span className="text-faint">–</span> : sandbox.environment.name}
			</td>
			<td className={cell}>
				<span className={stops === "–" ? "text-faint" : stops === "Always on" ? "text-fg" : "text-muted"}>{stops}</span>
			</td>
			<td className={cell}>
				<Cpu sandbox={sandbox} source={calls.source} percent />
			</td>
			{hosting === "hosted" ? (
				<td className={`${cell} text-right tabular-nums`}>{costText(sandbox.costCents ?? 0)}</td>
			) : null}
			<td className={`${cell} text-right`}>
				<span className="text-muted tabular-nums" title={new Date(sandbox.createdAt).toLocaleString("en-GB")}>
					{compactAge(sandbox.createdAt, now)}
				</span>
			</td>
			<td className={`${cell} w-0 text-right`}>
				<span className="relative flex items-center justify-end gap-1">
					{windows && href !== undefined ? (
						// Over the columns to its left while shown, so the hidden buttons take no width from every row. The
						// canvas under the row's own hover tint matches the row it sits on.
						<span className={`absolute right-full mr-1 rounded-control bg-canvas ${onHover}`}>
							<span className="flex gap-1 rounded-control bg-hover pl-2">
								<a className={ghostLink} href={href("browser")} onClick={onScreen("browser")}>
									<GlobeIcon size="sm" />
									<span className={buttonLabelClass}>Browser</span>
								</a>
								<a className={ghostLink} href={href("desktop")} onClick={onScreen("desktop")}>
									<DesktopIcon size="sm" />
									<span className={buttonLabelClass}>Desktop</span>
								</a>
							</span>
						</span>
					) : can.recover ? (
						<Button size="sm" icon={<ReconnectIcon size="sm" />} onClick={recover}>
							Recover
						</Button>
					) : can.resume ? (
						<span className={onHover}>
							<Button size="sm" variant="ghost" icon={<PlayIcon size="sm" />} onClick={resume}>
								Resume
							</Button>
						</span>
					) : null}
					{actions}
				</span>
			</td>
		</tr>
	);
	if (failure === undefined) return row;
	return (
		<>
			{row}
			<tr className={`kt-sandbox-row-failure ${ticked ? "bg-selected" : ""}`}>
				<td className="border-b border-border p-0" />
				<td
					className="border-b border-border px-2 pt-0 pb-2.5 text-sm text-status-error"
					colSpan={hosting === "hosted" ? 9 : 8}
				>
					{failure}
				</td>
			</tr>
		</>
	);
}

/**
 * A phone's row, all of it a link to the sandbox's page: the name with its CPU and state beside it, the machine and
 * when it stops under it, and a chevron. The page has the actions. The tick box is beside the link, not in it.
 */
function SandboxPhoneRow({
	sandbox,
	now,
	calls,
	ticked,
	onTick,
}: {
	sandbox: Sandbox;
	now: number;
	calls: RowCalls;
	ticked: boolean;
	onTick: (on: boolean) => void;
}) {
	const { pending, href, actions, can, recover } = useRowActions(sandbox, calls);
	const stops = stopsText(sandbox, now);
	const body = (
		<div className="flex min-w-0 flex-1 flex-col gap-1">
			<div className="flex min-w-0 items-center gap-3">
				<span className="min-w-0 flex-1 truncate text-md font-medium text-fg">{sandbox.name}</span>
				<Cpu sandbox={sandbox} source={calls.source} percent />
				<StateLabel state={sandbox.state} />
			</div>
			{sandbox.state === "error" && sandbox.error !== undefined ? (
				<span className="line-clamp-2 text-sm text-status-error">{sandbox.error}</span>
			) : (
				<span className="flex min-w-0 flex-wrap gap-x-3 text-sm text-muted">
					<span>
						{SANDBOX_KIND_LABELS[sandbox.kind]}, {sizeText(sandbox.resources ?? sandbox.size)}
					</span>
					{sandbox.environment === undefined ? null : <span>{sandbox.environment.name}</span>}
					{stops === "–" ? null : <span>{stops === "Always on" || stops === "Now" ? stops : `Stops ${stops}`}</span>}
					<BaseOutdatedBadge base={sandbox.base} now={now} />
				</span>
			)}
		</div>
	);
	return (
		<li
			className={`kt-sandbox-row flex min-w-0 flex-wrap items-center gap-x-3 border-b border-border ${ticked ? "bg-selected" : ""}`}
			data-sandbox={sandbox.id}
		>
			<TickBox label={`Select ${sandbox.name}`} checked={ticked} disabled={pending} onChange={onTick} />
			{href === undefined ? (
				<div className="flex min-w-0 flex-1 items-center gap-2 py-3">
					{body}
					{actions}
				</div>
			) : (
				<a
					className="kt-focusable flex min-w-0 flex-1 items-center gap-2 py-3 text-inherit no-underline"
					href={href()}
					onClick={follow(calls.navigate)}
				>
					{body}
					<ChevronRightIcon size="sm" className="flex-none text-faint" />
				</a>
			)}
			{can.recover && href !== undefined ? (
				<div className="basis-full pb-3 pl-6.5">
					<Button size="sm" icon={<ReconnectIcon size="sm" />} onClick={recover}>
						Recover
					</Button>
				</div>
			) : null}
		</li>
	);
}

/** A row's checkbox, or the head's for all of them: `indeterminate` when some are ticked. Above a row's link. */
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
			className="kt-checkbox kt-focusable relative z-1 m-0 block size-3.5 flex-none cursor-pointer accent-accent disabled:cursor-default"
			aria-label={label}
			checked={checked}
			disabled={disabled}
			onChange={(event) => onChange(event.target.checked)}
		/>
	);
}

/**
 * Over the list: what acts on the ticked sandboxes, once any are, and on a phone Select all, which the table's head has
 * on a wide screen. Nothing on a wide screen until something is ticked.
 */
function SelectionBar({
	narrow,
	count,
	all,
	some,
	disabled,
	onAll,
	actions,
}: {
	narrow: boolean;
	count: number;
	all: boolean;
	some: boolean;
	disabled: boolean;
	onAll: (on: boolean) => void;
	actions: ReactNode;
}) {
	const allId = useId();
	if (!narrow && count === 0) return null;
	return (
		<div className="kt-selection-bar flex min-h-control-sm flex-wrap items-center gap-x-3 gap-y-2">
			{narrow ? (
				<span className="flex items-center gap-3 text-sm text-muted">
					<TickBox
						id={allId}
						label="Select all"
						checked={all}
						indeterminate={some}
						disabled={disabled}
						onChange={onAll}
					/>
					<label htmlFor={allId} className="cursor-pointer">
						{count === 0 ? "Select all" : `${count} selected`}
					</label>
				</span>
			) : (
				<span className="text-sm text-fg tabular-nums" aria-live="polite">
					{count} selected
				</span>
			)}
			{count === 0 ? null : (
				<span className="ml-auto flex flex-wrap items-center gap-2">
					{actions}
					<Button size="sm" variant="ghost" onClick={() => onAll(false)}>
						Clear
					</Button>
				</span>
			)}
		</div>
	);
}

/** The account's shapes from its source; the dialog asks only where the source can say. */
const readShapes = (source: SandboxesSource, accountId: string): Promise<SandboxShapes> =>
	source.shapes === undefined ? Promise.resolve(DEFAULT_SANDBOX_SHAPES) : source.shapes(accountId);

/**
 * New sandbox's sliders. A microVM: vCPUs, then memory, which follows the vCPUs within what each may hold; a tick
 * marks each shape the hosts offer by name. An isolate: memory alone, since it shares its account's VM's CPU. Under
 * them, the shape in a line and its price where there is one (hosted). Where no host makes a shape off the presets
 * (older hosts), a microVM is one of the presets, chosen from a list.
 */
export function ShapeFields({
	kind,
	shapes,
	hosting,
	shape,
	onVcpus,
	onMemory,
	onPreset,
}: {
	kind: SandboxKind;
	shapes: SandboxShapes;
	hosting: HostingMode;
	shape: SandboxShape;
	onVcpus: (vcpus: number) => void;
	onMemory: (memoryMb: number) => void;
	/** A preset chosen whole, where only presets may be. */
	onPreset: (shape: SandboxShape) => void;
}) {
	const cents = hosting === "hosted" ? shapeCentsPerHour(shapes, kind, shape) : undefined;
	const price = cents === undefined ? "" : `, ${costText(cents)} an hour`;
	if (kind === "isolate") {
		const range = shapes.isolate.memoryMb;
		return (
			<div className="flex flex-col gap-4">
				<SliderField
					label="Memory"
					value={shape.memoryMb}
					min={range.min}
					max={range.max}
					step={range.step}
					format={memoryText}
					marks={[range.default]}
					onChange={onMemory}
				/>
				<p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
					<span>Shared CPU: an isolate runs on its account's VM and shares its CPU.</span>
					{cents === undefined ? null : <span>{costText(cents)} an hour.</span>}
				</p>
			</div>
		);
	}
	const { presets } = shapes.microvm;
	const cpuRange = vcpuRangeFor(shapes);
	const memory = memoryRangeFor(shapes, shape.vcpus);
	// No disk is promised: it is the host's to give (by its sizes, or the snapshot it starts from), and the sandbox shows
	// the disk it got once it runs.
	const summary = (
		<p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
			<span>
				{shape.vcpus} vCPU, {memoryText(shape.memoryMb)} memory
				{price}
			</span>
		</p>
	);
	if (!customShapes(shapes)) {
		// An option is a whole shape: hosts may give one name different shapes, and each submits its own.
		const shapeKey = (entry: SandboxShape) => `${entry.vcpus}/${entry.memoryMb}`;
		const options = [...new Map(presets.map((entry) => [shapeKey(entry), entry])).values()];
		const chosen = presetOf(shapes, shape) ?? options[0];
		if (chosen === undefined) {
			return (
				<Notice level="warning">
					These hosts make only their named sizes, and name none this console knows, so no microVM can be made here.
					Update kantel-host, or use an isolate.
				</Notice>
			);
		}
		return (
			<div className="flex flex-col gap-4">
				<SelectField
					label="Size"
					hint="These hosts make only their named sizes; update kantel-host for any vCPUs and memory."
					value={shapeKey(chosen)}
					onChange={(event) => {
						const next = options.find((entry) => shapeKey(entry) === event.currentTarget.value);
						if (next !== undefined) onPreset({ vcpus: next.vcpus, memoryMb: next.memoryMb });
					}}
					options={options.map((entry) => ({
						value: shapeKey(entry),
						label: `${entry.vcpus} vCPU, ${memoryText(entry.memoryMb)}`,
					}))}
				/>
				{summary}
			</div>
		);
	}
	return (
		<div className="flex flex-col gap-4">
			<SliderField
				label="vCPUs"
				value={shape.vcpus}
				min={cpuRange.min}
				max={cpuRange.max}
				step={cpuRange.step}
				format={(value) => `${value} vCPU`}
				marks={presets.map((entry) => entry.vcpus)}
				onChange={onVcpus}
			/>
			<SliderField
				label="Memory"
				value={shape.memoryMb}
				min={memory.min}
				max={memory.max}
				step={memory.step}
				format={memoryText}
				marks={presets.filter((entry) => entry.vcpus === shape.vcpus).map((entry) => entry.memoryMb)}
				onChange={onMemory}
			/>
			{summary}
		</div>
	);
}

/** Where New sandbox's shapes are: read (or the source can't say, so the defaults stand), being read, or not read. */
type ShapesRead = "ready" | "reading" | "failed";

export function NewSandboxDialog({
	open,
	account,
	hosting,
	shapes: loadShapes,
	savedSnapshots,
	environments,
	onClose,
	onCreate,
}: {
	open: boolean;
	account: ComputeAccount;
	hosting: HostingMode;
	shapes?: () => Promise<SandboxShapes>;
	savedSnapshots?: () => Promise<readonly SavedSnapshot[]>;
	environments?: () => Promise<readonly Environment[]>;
	onClose: () => void;
	onCreate: (input: CreateSandboxInput) => void;
}) {
	const [name, setName] = useState("");
	const [kind, setKind] = useState<SandboxKind>("microvm");
	const [shapes, setShapes] = useState<SandboxShapes>(DEFAULT_SANDBOX_SHAPES);
	const [vcpus, setVcpus] = useState(DEFAULT_SANDBOX_SHAPES.microvm.vcpus.default);
	const [memoryMb, setMemoryMb] = useState(DEFAULT_SANDBOX_SHAPES.microvm.memoryMb.default);
	const [isolateMb, setIsolateMb] = useState(DEFAULT_SANDBOX_SHAPES.isolate.memoryMb.default);
	const [autoStop, setAutoStop] = useState("60");
	const [from, setFrom] = useState("");
	const [environment, setEnvironment] = useState("");
	const [saved, setSaved] = useState<readonly SavedSnapshot[]>([]);
	const [envs, setEnvs] = useState<readonly Environment[]>([]);
	// A source that says what its hosts offer: nothing may be chosen or created until it has, so a create never goes
	// with the sample's figures. One that can't say keeps the defaults.
	const [shapesRead, setShapesRead] = useState<ShapesRead>(loadShapes === undefined ? "ready" : "reading");
	const asked = useRef(false);
	const readShapesNow = useCallback(() => {
		if (loadShapes === undefined) return;
		setShapesRead("reading");
		loadShapes().then(
			(read) => {
				// Set once, before any slider can move: the controls show only once this lands.
				const presets = read.microvm.presets;
				const cpus = vcpuRangeFor(read).default;
				const start = customShapes(read)
					? { vcpus: cpus, memoryMb: fitMemory(read, cpus, read.microvm.memoryMb.default) }
					: (presets.find(
							(preset) =>
								preset.vcpus === read.microvm.vcpus.default && preset.memoryMb === read.microvm.memoryMb.default,
						) ?? presets[0]);
				setShapes(read);
				if (start !== undefined) {
					setVcpus(start.vcpus);
					setMemoryMb(start.memoryMb);
				}
				setIsolateMb(onGrid(read.isolate.memoryMb, read.isolate.memoryMb.default));
				// No host runs microVMs: an isolate is all that can be made.
				if (!microvmsAvailable(read)) setKind("isolate");
				setShapesRead("ready");
			},
			() => setShapesRead("failed"),
		);
	}, [loadShapes]);
	useEffect(() => {
		if (!open || asked.current) return;
		asked.current = true;
		savedSnapshots?.().then(setSaved, () => setSaved([]));
		environments?.().then(setEnvs, () => setEnvs([]));
		readShapesNow();
	}, [open, savedSnapshots, environments, readShapesNow]);
	const valid = name === "" || /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(name);
	const fromOptions = saved.filter((entry) => entry.kind === kind);
	const shape: SandboxShape = kind === "isolate" ? { vcpus: 0, memoryMb: isolateMb } : { vcpus, memoryMb };
	// A microVM's shape is one the hosts can make: a preset, or one within both memory bounds.
	const noMicrovms = shapesRead === "ready" && !microvmsAvailable(shapes);
	const ready = valid && shapesRead === "ready" && shapeCreatable(shapes, kind, shape);
	const submit = () => {
		if (!ready) return;
		onCreate({
			accountId: account.id,
			...(name === "" ? {} : { name }),
			kind,
			shape,
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
					<Button type="submit" variant="primary" disabled={!ready}>
						Create
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-4 pt-2">
				<TextField
					label="Name (optional)"
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
							{ value: "microvm", label: "MicroVM", ...(noMicrovms ? { disabled: true } : {}) },
							{ value: "isolate", label: "Isolate" },
						]}
						value={kind}
						onChange={setKind}
					/>
					<span className="text-xs text-muted">
						{noMicrovms
							? "None of this organisation's hosts run microVMs, so only isolates can be made here."
							: kind === "microvm"
								? "A Firecracker microVM: root, Docker, systemd and /dev/kvm inside. Up in about a second."
								: "A V8 isolate with a shell and JavaScript. Up in milliseconds, nearly free, no Docker."}
					</span>
				</div>
				{shapesRead === "reading" ? (
					<p className="text-xs text-muted" role="status">
						Reading what the hosts offer…
					</p>
				) : shapesRead === "failed" ? (
					<Notice
						level="error"
						action={
							<Button size="sm" onClick={readShapesNow}>
								Try again
							</Button>
						}
					>
						Kantel couldn't read what the hosts offer, so a size can't be chosen yet.
					</Notice>
				) : (
					<ShapeFields
						kind={kind}
						shapes={shapes}
						hosting={hosting}
						shape={shape}
						onVcpus={(next) => {
							setVcpus(next);
							setMemoryMb((current) => fitMemory(shapes, next, current));
						}}
						onMemory={(next) => (kind === "isolate" ? setIsolateMb(next) : setMemoryMb(next))}
						onPreset={(next) => {
							setVcpus(next.vcpus);
							setMemoryMb(next.memoryMb);
						}}
					/>
				)}
				{envs.length === 0 ? null : (
					<SelectField
						label="Environment"
						value={environment}
						onChange={(event) => setEnvironment(event.currentTarget.value)}
						options={[{ value: "", label: "None" }, ...envs.map((env) => ({ value: env.id, label: env.name }))]}
					/>
				)}
				<SelectField
					label="Stop after"
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

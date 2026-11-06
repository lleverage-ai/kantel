// The Sandboxes page (compute console): an account's sandboxes, for finding one and seeing its state. A condensed table
// on a wide screen, after boat.dev's (Tom, 5 Nov 2026): the name (renamed in place) with its address under it, its ID
// to copy, state, when it was made, its type, a countdown to its auto-stop, its latest snapshot, its cost (hosted) and
// its CPU, RAM, disk and IO as one small chart, which opens its metrics dialog. A search over names, addresses and IDs,
// and State, Snapshot, Type and Created by filters, sit over it. In an organisation, or where more than one person or
// API key made them, each row says who made it under when ("You" for the viewer). Rows on a phone; each row opens the
// sandbox's page. Browser and Desktop show on a running microVM's row under the pointer and open in the console,
// Recover on a failed one's, and ⋯ has Stop, Fork, Save snapshot, Auto-stop, Restart on latest base (beside the state,
// a sandbox on an outdated base says so) and Delete. New makes a sandbox at once with the defaults (a medium microVM
// that stops after an hour); its caret opens New sandbox to choose. Either way the new row shows at once, starting, at
// the top, and the page follows it until it's running. Rows can be ticked (Select all is the table's head, or over a
// phone's rows) to stop or delete several at once. Every call goes through the `SandboxesSource` the host binds;
// stories bind it to fixtures.

import { type MouseEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, buttonClass, buttonLabelClass, IconButton } from "../primitives/button.tsx";
import { CopyButton, inputClass, SegmentedControl, SelectField, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { compactAge, HOUR, MINUTE } from "../primitives/format.ts";
import { ChevronDownIcon, ChevronRightIcon, GlobeIcon, PencilIcon, PlusIcon, StopIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { DesktopIcon, EllipsisIcon, PlayIcon, ReconnectIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Menu, type MenuEntry } from "../primitives/menu.tsx";
import { SideScroll } from "../primitives/side-scroll.tsx";
import { SliderField } from "../primitives/slider.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { SplitButton } from "../primitives/split-button.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { HelpHint, Tooltip } from "../primitives/tooltip.tsx";
import { BaseOutdatedBadge } from "./base-outdated.tsx";
import {
	type ComputeAccount,
	type CreateSandboxInput,
	costText,
	customShapes,
	DEFAULT_SANDBOX_SHAPES,
	diskRangeFor,
	type Environment,
	fitDisk,
	fitMemory,
	type HostChoice,
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
	sandboxMachineText,
	sandboxMoving,
	sandboxScreen,
	sandboxSpec,
	shapeCentsPerHour,
	shapeCreatable,
	sizeText,
	stopsInText,
	type Template,
	vcpuRangeFor,
} from "./compute-model.ts";
import { useFollowSandboxes } from "./live-sandboxes.ts";
import { seriesOf, useLiveUsage } from "./live-usage.ts";
import { computePage, messageOf } from "./parts.tsx";
import {
	AUTO_STOP_CHOICES,
	DeleteDialog,
	IDLE_STOP_CHOICES,
	IDLE_STOP_HINT,
	type SandboxNotice,
	useSandboxMenu,
} from "./sandbox-actions.tsx";
import {
	creatorCount,
	creatorFilters,
	creatorText,
	filterCounts,
	filtered,
	NO_FILTERS,
	type SandboxFilters,
	SNAPSHOT_FILTERS,
	STATE_FILTERS,
	sandboxesShown,
	TYPE_FILTERS,
} from "./sandbox-filters.ts";
import { popOut } from "./sandbox-screen.tsx";
import { ChangeCounter, changeTaken, keepShown, retryTargets } from "./sandbox-selection.ts";
import { buildPollMs, TEMPLATE_POLL_MS } from "./template-view.ts";
import { resourcesText, templatePickHint } from "./templates-page.tsx";
import { ROW_USAGE_SPAN_MS, SandboxMetricsDialog, UsageSparkline } from "./usage-metrics.tsx";

export { sandboxesShown } from "./sandbox-filters.ts";

/** A view of one sandbox's page that a row links to. */
export type SandboxRowView = "overview" | "desktop" | "browser";

export interface SandboxesPageProps {
	readonly source: SandboxesSource;
	readonly account: ComputeAccount;
	/** The signed-in person's ID: their sandboxes say "You", and Created by offers them first. */
	readonly viewerId?: string;
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
	/** The account's templates (experimental), which New sandbox offers to make the machine from. */
	readonly templates?: (accountId: string) => Promise<readonly Template[]>;
	/** The template New sandbox starts with picked: a template page's New sandbox. */
	readonly template?: string;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** How often the list is read again while a sandbox is starting or stopping, in milliseconds. Default 1000. */
	readonly pollMs?: number;
	/** Open New sandbox when the page opens, for a story or a `?new` link. */
	readonly creating?: boolean;
	/** The filters and search it opens with, for a story. */
	readonly initialFilters?: SandboxFilters;
	/** The sandbox whose metrics it opens with, by ID, for a story. */
	readonly metricsOf?: string;
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

/**
 * Whether a sandbox is read live: only while it runs, or has just stopped answering. A stopped, paused or starting one
 * isn't read; its row draws a faint flat line, still a way into its metrics.
 */
export const showsCpu = (box: Pick<Sandbox, "state">): boolean =>
	box.state === "running" || box.state === "stopping" || box.state === "error";

/** "in 52m", "Always on", "Now", or a dash: when auto-stop stops it. */
function stopsText(box: Sandbox, now: number): string {
	const text = stopsInText(box, now);
	return /^\d/.test(text) ? `in ${text}` : text;
}

/**
 * The time left before auto-stop stops it: "4:07" under 10 minutes, ticking each second, "52m" or "6h 10m" above,
 * "Always on", "Now", or a dash when it isn't running.
 */
export function countdownText(box: Pick<Sandbox, "state" | "stopsAt">, now: number): string {
	const text = stopsInText(box, now);
	if (box.stopsAt === undefined || !/^\d/.test(text)) return text;
	const left = box.stopsAt - now;
	if (left >= 10 * MINUTE) return text;
	const seconds = Math.ceil(left / 1000);
	return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
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
	viewerId,
	hosting,
	snapshots,
	sandboxHref,
	navigate,
	environments,
	templates,
	template,
	now: fixedNow,
	pollMs = 1000,
	creating = false,
	initialFilters,
	metricsOf,
	narrow = false,
	addHostHref,
	ownHostHref,
	firstRun,
}: SandboxesPageProps) {
	const { state, reload } = useLoad(() => source.list(account.id), [source, account.id]);
	// Sandboxes made or changed here, ahead of the next read: a new one shows the moment New is pressed.
	const [local, setLocal] = useState<ReadonlyMap<string, Sandbox | null>>(new Map());
	const [filters, setFilters] = useState<SandboxFilters>(initialFilters ?? NO_FILTERS);
	const [newOpen, setNewOpen] = useState(creating);
	// The sandbox whose metrics are open, by ID, so the dialog follows it as the list is read again.
	const [metricsId, setMetricsId] = useState(metricsOf);
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
	// And at once when one changes elsewhere: the CLI, the API, an auto-stop.
	useFollowSandboxes(source, account.id, reload);
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
		setFilters(NO_FILTERS);
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
				: {
						resources: {
							vcpus: input.shape.vcpus,
							memoryGb: input.shape.memoryMb / 1024,
							diskGb: input.shape.diskGb ?? 0,
						},
					}),
			state: "starting",
			createdAt: Date.now(),
			createdBy: "",
			...(viewerId === undefined ? {} : { creator: { kind: "user", id: viewerId } }),
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

	const shown = sandboxes === undefined ? undefined : sandboxesShown(sandboxes, filters, now);
	// Who made each one tells apart only where others can make them too.
	const creatorOf =
		sandboxes !== undefined && (account.kind === "organisation" || creatorCount(sandboxes) > 1)
			? (box: Sandbox) => creatorText(box, viewerId)
			: undefined;
	const metricsBox = metricsId === undefined ? undefined : sandboxes?.find((box) => box.id === metricsId);

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
					<SandboxToolbar
						sandboxes={sandboxes}
						filters={filters}
						viewerId={viewerId}
						now={now}
						narrow={narrow}
						onChange={setFilters}
					/>
					<SandboxList
						sandboxes={shown ?? []}
						{...(creatorOf === undefined ? {} : { creatorOf })}
						hosting={hosting}
						now={now}
						fixedNow={fixedNow !== undefined}
						narrow={narrow}
						filtered={filtered(filters)}
						onClearFilters={() => setFilters(NO_FILTERS)}
						onMetrics={setMetricsId}
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
				{...(source.shapes === undefined ? {} : { shapes: (hostId) => readShapes(source, account.id, hostId) })}
				{...(source.hosts === undefined ? {} : { hosts: () => source.hosts?.(account.id) ?? Promise.resolve([]) })}
				{...(snapshots === undefined ? {} : { savedSnapshots: () => snapshots.saved(account.id) })}
				{...(environments === undefined ? {} : { environments: () => environments(account.id) })}
				{...(templates === undefined ? {} : { templates: () => templates(account.id) })}
				{...(template === undefined ? {} : { template })}
				now={now}
				onClose={() => setNewOpen(false)}
				onCreate={(input) => void create(input)}
			/>
			<SandboxMetricsDialog sandbox={metricsBox} source={source} onClose={() => setMetricsId(undefined)} />
		</div>
	);
}

/** A filter's dropdown: "State: Running", with each option's count, the current one ticked. */
function FilterMenu<V extends string>({
	name,
	value,
	options,
	counts,
	onChange,
}: {
	name: string;
	value: V;
	options: readonly { value: V; label: string; short?: string }[];
	counts: ReadonlyMap<V, number>;
	onChange: (value: V) => void;
}) {
	const current = options.find((option) => option.value === value) ?? options[0];
	const any = value === options[0]?.value;
	return (
		<Menu
			label={`Filter by ${name.toLowerCase()}`}
			triggerClassName={`${buttonClass("secondary", "sm")} kt-sandbox-filter ${any ? "" : "bg-selected"}`}
			trigger={
				<>
					<span className={buttonLabelClass}>
						<span className="text-muted">{name}</span>
						{any ? null : <span className="text-fg">: {current?.short ?? current?.label}</span>}
					</span>
					<ChevronDownIcon size="sm" className="text-faint" />
				</>
			}
			size="sm"
			entries={options.map((option) => ({
				kind: "item",
				id: option.value,
				label: option.label,
				detail: String(counts.get(option.value) ?? 0),
				checked: option.value === value,
				onSelect: () => onChange(option.value),
			}))}
		/>
	);
}

/**
 * Over the table: the search, then the State, Snapshot, Type and Created by filters, and Clear while any narrows the
 * list.
 */
function SandboxToolbar({
	sandboxes,
	filters,
	viewerId,
	now,
	narrow,
	onChange,
}: {
	sandboxes: readonly Sandbox[];
	filters: SandboxFilters;
	viewerId: string | undefined;
	now: number;
	narrow: boolean;
	onChange: (filters: SandboxFilters) => void;
}) {
	const counts = <K extends "state" | "snapshot" | "type" | "creator">(
		key: K,
		options: readonly { value: NonNullable<SandboxFilters[K]> }[],
	) => filterCounts(sandboxes, filters, key, options, now);
	// Type tells apart only where there are both, and Created by where more than one person or key made them.
	const types = new Set(sandboxes.map((box) => box.kind)).size > 1;
	const creator = filters.creator ?? "all";
	const creators = creatorCount(sandboxes) > 1 || creator !== "all" ? creatorFilters(sandboxes, viewerId) : undefined;
	return (
		<div className="kt-sandbox-toolbar flex flex-wrap items-center gap-2">
			<div className={narrow ? "w-full" : "w-(--kt-popover-width) max-w-full"}>
				<TextField
					label="Search sandboxes"
					hideLabel
					type="search"
					placeholder="Search name, subdomain or ID"
					value={filters.search}
					onChange={(event) => onChange({ ...filters, search: event.currentTarget.value })}
				/>
			</div>
			<FilterMenu
				name="State"
				value={filters.state}
				options={STATE_FILTERS}
				counts={counts("state", STATE_FILTERS)}
				onChange={(state) => onChange({ ...filters, state })}
			/>
			<FilterMenu
				name="Snapshot"
				value={filters.snapshot}
				options={SNAPSHOT_FILTERS}
				counts={counts("snapshot", SNAPSHOT_FILTERS)}
				onChange={(snapshot) => onChange({ ...filters, snapshot })}
			/>
			{types || filters.type !== "all" ? (
				<FilterMenu
					name="Type"
					value={filters.type}
					options={TYPE_FILTERS}
					counts={counts("type", TYPE_FILTERS)}
					onChange={(type) => onChange({ ...filters, type })}
				/>
			) : null}
			{creators === undefined ? null : (
				<FilterMenu
					name="Created by"
					value={creator}
					options={creators}
					counts={counts("creator", creators)}
					onChange={(value) => onChange({ ...filters, creator: value })}
				/>
			)}
			{filtered({ ...filters, search: "" }) ? (
				<Button
					size="sm"
					variant="ghost"
					onClick={() => onChange({ ...filters, state: "all", snapshot: "all", type: "all", creator: "all" })}
				>
					Clear filters
				</Button>
			) : null}
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
	/** Opens a sandbox's metrics dialog. */
	onMetrics?: (id: string) => void;
};

/** The table on a wide screen, rows on a phone, and what acts on the ticked ones. */
function SandboxList({
	sandboxes,
	hosting,
	now,
	fixedNow,
	narrow,
	filtered: narrowed,
	onClearFilters,
	creatorOf,
	onMetrics,
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
	/** The time is fixed (a story): countdowns don't tick. */
	fixedNow: boolean;
	narrow: boolean;
	/** Something narrows the list, so an empty one says so and offers to clear it. */
	filtered: boolean;
	onClearFilters: () => void;
	/** Who made a sandbox, as its row says it under when; without it rows don't say. */
	creatorOf?: (box: Sandbox) => string;
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
		return (
			<p className="m-0 flex items-center gap-2 text-sm text-muted">
				No sandboxes match.
				{narrowed ? (
					<Button size="xs" variant="ghost" onClick={onClearFilters}>
						Clear search and filters
					</Button>
				) : null}
			</p>
		);
	}
	const calls: RowCalls = {
		source,
		...(onMetrics === undefined ? {} : { onMetrics }),
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
					{...(creatorOf === undefined ? {} : { creator: creatorOf(box) })}
					now={now}
					calls={calls}
					ticked={ticked.has(box.id)}
					onTick={(on) => tick(box.id, on)}
				/>
			))}
		</ul>
	) : (
		<SideScroll className="kt-compute-table min-w-0" surface="canvas" fill>
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
							Name / subdomain
						</th>
						<th className={head} scope="col">
							Sandbox ID
						</th>
						<th className={head} scope="col">
							State
						</th>
						<th className={head} scope="col">
							{creatorOf === undefined ? "Created" : "Created / by"}
						</th>
						<th className={head} scope="col">
							Type
						</th>
						<th className={head} scope="col">
							<HeadHint label="Stops in">
								When auto-stop stops it, and saves a snapshot to start from again. Its page can push this back or make
								it always on.
							</HeadHint>
						</th>
						<th className={head} scope="col">
							<HeadHint label="Snapshot">
								When its latest snapshot was saved: on stop, every so often while it runs, or by a fork. It starts again
								from this one.
							</HeadHint>
						</th>
						{hosting === "hosted" ? (
							<th className={`${head} text-right`} scope="col">
								<HeadHint label="Cost" end>
									What it has cost this billing period. Billing has the account's total.
								</HeadHint>
							</th>
						) : null}
						<th className={head} scope="col">
							<HeadHint label="Usage">
								CPU, RAM, disk and IO over the last 10 minutes, as a share of what it has. Click a chart for its metrics
								over an hour, a day or a week, and its busiest processes.
							</HeadHint>
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
							{...(creatorOf === undefined ? {} : { creator: creatorOf(box) })}
							hosting={hosting}
							now={now}
							fixedNow={fixedNow}
							calls={calls}
							ticked={ticked.has(box.id)}
							onTick={(on) => tick(box.id, on)}
						/>
					))}
				</tbody>
			</table>
		</SideScroll>
	);
	return (
		// Select all sits right over the rows it ticks, closer to them than the page's gap. The table fills the room under
		// the header and filters (`kt-fill`, base.css), so New and the filters stay in view down a long list.
		<div className="kt-fill flex min-w-0 flex-col gap-2">
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
const cell = "border-b border-border px-2 py-2 align-middle whitespace-nowrap";

/** A column's heading with a "?" that says what it means. */
function HeadHint({ label, end = false, children }: { label: string; end?: boolean; children: ReactNode }) {
	return (
		<span className={`inline-flex items-center gap-1 ${end ? "justify-end" : ""}`}>
			{label}
			<HelpHint label={`About ${label.toLowerCase()}`}>{children}</HelpHint>
		</span>
	);
}

/**
 * The time left to its auto-stop, ticking each second in its last 10 minutes and each 30 seconds before. Its tooltip
 * has the time it stops at.
 */
function Countdown({ sandbox, now: listNow, live }: { sandbox: Sandbox; now: number; live: boolean }) {
	const left = sandbox.stopsAt === undefined ? undefined : sandbox.stopsAt - Date.now();
	const running = sandbox.state === "running" || sandbox.state === "starting";
	useTick(
		live && running && left !== undefined && left > -1000,
		left !== undefined && left < 10 * MINUTE ? 1000 : 30_000,
	);
	const now = live ? Date.now() : listNow;
	const text = countdownText(sandbox, now);
	const soon = sandbox.stopsAt !== undefined && running && sandbox.stopsAt - now < 10 * MINUTE;
	const tone =
		text === "–" ? "text-faint" : soon ? "text-status-waiting" : text === "Always on" ? "text-fg" : "text-muted";
	const shown = <span className={`tabular-nums ${tone}`}>{text}</span>;
	if (sandbox.stopsAt === undefined || !running) return shown;
	const at = new Date(sandbox.stopsAt);
	return (
		<Tooltip
			content={`Stops at ${at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}${sandbox.stopsAt - now > 12 * HOUR ? `, ${at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}` : ""}`}
		>
			<span className="relative z-1">{shown}</span>
		</Tooltip>
	);
}

/** "2h ago" for a time, with the date and time in a tooltip. */
function When({ at, now }: { at: number; now: number }) {
	return (
		<Tooltip content={new Date(at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}>
			<span className="relative z-1 text-muted tabular-nums">{compactAge(at, now)}</span>
		</Tooltip>
	);
}

/** "sbx_9f2k…7d1q": an ID's start and end, which tell them apart; the whole of it in a tooltip. */
export function shortId(id: string): string {
	const [prefix, rest] = id.includes("_")
		? [id.slice(0, id.indexOf("_") + 1), id.slice(id.indexOf("_") + 1)]
		: ["", id];
	return rest.length <= 10 ? id : `${prefix}${rest.slice(0, 4)}…${rest.slice(-4)}`;
}

/** Its ID, shortened, and a button that copies the whole of it. */
function IdCell({ sandbox }: { sandbox: Sandbox }) {
	if (sandbox.id.startsWith("pending_")) return <span className="text-faint">–</span>;
	return (
		<span className="relative z-1 inline-flex items-center gap-0.5">
			<Tooltip content={<span className="font-mono text-code">{sandbox.id}</span>}>
				<span className="font-mono text-code text-muted">{shortId(sandbox.id)}</span>
			</Tooltip>
			<CopyButton
				text={sandbox.id}
				label={`Copy ${sandbox.name}'s ID`}
				iconOnly
				size="xs"
				variant="ghost"
				className={onHover}
			/>
		</span>
	);
}

/** Its latest snapshot's age, or None; its tooltip has when, and that it starts from it. */
function SnapshotCell({ sandbox, now }: { sandbox: Sandbox; now: number }) {
	if (sandbox.snapshot === undefined) return <span className="text-faint">None</span>;
	if (sandbox.snapshot.takenAt === undefined) return <span className="text-muted">Saved</span>;
	return <When at={sandbox.snapshot.takenAt} now={now} />;
}

/**
 * The name, a link to its page, with its address under it, truncated with the whole of each in a tooltip. With a
 * rename, a pencil beside it under the pointer turns it into a field: Enter or leaving it renames, Escape doesn't.
 */
function NameCell({
	sandbox,
	href,
	onLink,
	calls,
}: {
	sandbox: Sandbox;
	href: string | undefined;
	onLink: (event: LinkClick) => void;
	calls: RowCalls;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(sandbox.name);
	const [busy, setBusy] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const rename = calls.source.rename;
	const pending = sandbox.id.startsWith("pending_");
	useEffect(() => {
		if (editing) input.current?.select();
	}, [editing]);
	const save = async () => {
		const name = draft.trim();
		if (rename === undefined || busy) return;
		if (name === "" || name === sandbox.name) {
			setEditing(false);
			return;
		}
		setBusy(true);
		try {
			const since = calls.asked?.(sandbox.id);
			calls.onChange(await rename(sandbox.id, name), sandbox.id, since);
			setEditing(false);
		} catch (caught) {
			calls.onNotice({ level: "error", text: messageOf(caught, `Kantel couldn't rename ${sandbox.name}. Try again.`) });
			input.current?.focus();
		} finally {
			setBusy(false);
		}
	};
	if (editing)
		return (
			<span className="relative z-1 flex min-w-0 flex-col gap-0.5">
				<input
					ref={input}
					className={`${inputClass} h-control-xs py-0 font-medium`}
					aria-label={`New name for ${sandbox.name}`}
					value={draft}
					disabled={busy}
					spellCheck={false}
					autoCapitalize="off"
					onChange={(event) => setDraft(event.currentTarget.value.toLowerCase())}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							void save();
						} else if (event.key === "Escape") {
							event.preventDefault();
							setDraft(sandbox.name);
							setEditing(false);
						}
					}}
					onBlur={() => void save()}
				/>
				<span className="truncate text-xs text-faint">Enter renames it; its address stays. Escape doesn't.</span>
			</span>
		);
	const name =
		href === undefined ? (
			<span className="block truncate font-medium text-fg">{sandbox.name}</span>
		) : (
			<a
				className="kt-focusable relative z-1 block truncate font-medium text-fg no-underline hover:underline"
				href={href}
				onClick={onLink}
			>
				{sandbox.name}
			</a>
		);
	const address = sandbox.hostname === "" ? undefined : sandbox.hostname;
	return (
		<span className="flex min-w-0 items-center gap-1">
			<span className="flex min-w-0 flex-col">
				{/* The tooltip only where the name is cut short. */}
				<Tooltip content={sandbox.name} whenTruncated className="w-full">
					{name}
				</Tooltip>
				{address === undefined ? null : (
					<Tooltip
						content={
							<span className="flex flex-col">
								<span className="font-mono text-code">{address}</span>
								{sandbox.environment === undefined ? null : (
									<span className="text-muted">From {sandbox.environment.name}</span>
								)}
							</span>
						}
					>
						<span className="relative z-1 block w-fit max-w-full truncate text-sm text-muted">{address}</span>
					</Tooltip>
				)}
			</span>
			{rename === undefined || pending ? null : (
				<span className={`relative z-1 flex-none ${onHover}`}>
					<IconButton
						size="xs"
						variant="ghost"
						label={`Rename ${sandbox.name}`}
						icon={<PencilIcon size="sm" />}
						onClick={() => {
							setDraft(sandbox.name);
							setEditing(true);
						}}
					/>
				</span>
			)}
		</span>
	);
}

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
 * A row's Desktop (or Browser): its page of its own, which the link opens in a new tab, or the screen itself in a tab
 * where the console can't frame it (`screens` "tab"), as on the sandbox's page. `openTab` runs during the click, so
 * the browser lets the tab open.
 */
export function screenLink(
	screens: SandboxesSource["screens"],
	openTab: (view: "browser" | "desktop") => void,
): (view: "browser" | "desktop") => (event: LinkClick) => void {
	// The link's own new tab.
	if (screens !== "tab") return () => () => {};
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
	// Its one screen: the desktop, where it has one (the browser runs on it), or else its browser.
	const screen = sandboxScreen(sandbox);
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
	const onScreen = screenLink(source.screens, (view) => popOut(view, undefined, () => source.access(sandbox.id)));
	return { pending, can, windows, screen, resume, recover, actions, href, onLink, onScreen };
}

/** The state, in its colour. */
const StateLabel = ({ state }: { state: SandboxState }) => (
	<StatusLabel status={SANDBOX_STATE_STATUS[state]}>{SANDBOX_STATE_LABELS[state]}</StatusLabel>
);

/**
 * Its CPU, RAM, disk and IO over the last 10 minutes as one small chart, read again every few seconds while it runs;
 * a click opens its metrics. Without a live source it's its recent CPU as listed, which doesn't move. One that isn't
 * running, or a row in error, is a faint flat line, still a way into its history.
 */
function Usage({ sandbox, calls }: { sandbox: Sandbox; calls: RowCalls }) {
	const running = showsCpu(sandbox) && sandbox.state !== "error";
	const live = useLiveUsage(running ? calls.source.usageSeries : undefined, sandbox.id, {
		keepMs: ROW_USAGE_SPAN_MS,
	});
	if (sandbox.id.startsWith("pending_")) return null;
	const { onMetrics } = calls;
	return (
		<UsageSparkline
			name={sandbox.name}
			series={seriesOf(live)}
			fallback={live.status === "off" ? sandbox.usage : []}
			loading={live.status === "loading"}
			running={running}
			{...(onMetrics === undefined ? {} : { onOpen: () => onMetrics(sandbox.id) })}
		/>
	);
}

/** Shown under the pointer or keyboard focus on the row, and always on a touch screen. */
const onHover =
	"opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100 pointer-coarse:opacity-100 transition-opacity";

function SandboxRow({
	sandbox,
	creator,
	hosting,
	now,
	fixedNow,
	calls,
	ticked,
	onTick,
}: {
	sandbox: Sandbox;
	/** Who made it, said under when it was made; absent, the row doesn't say. */
	creator?: string;
	hosting: HostingMode;
	now: number;
	fixedNow: boolean;
	calls: RowCalls;
	ticked: boolean;
	onTick: (on: boolean) => void;
}) {
	const { pending, can, windows, screen, resume, recover, actions, href, onLink, onScreen } = useRowActions(
		sandbox,
		calls,
	);
	// What went wrong gets a line of its own under the row, across the columns, rather than truncating in the name's.
	const failure = sandbox.state === "error" ? sandbox.error : undefined;
	const tone = ticked ? "bg-selected" : "hover:bg-hover";
	const spec = sandboxSpec(sandbox);
	const row = (
		// A link under the whole row opens the sandbox; the tick box, the name, the ID, the chart and the buttons sit above
		// it, and so do the bits with tooltips.
		<tr
			className={`kt-sandbox-row group/row relative ${tone} ${failure === undefined ? "" : "[&>td]:border-b-0 [&>td]:pb-1"}`}
			data-sandbox={sandbox.id}
		>
			<td className={`${cell} w-0 pr-0`}>
				{href === undefined ? null : (
					// biome-ignore lint/a11y/useAnchorContent: a pointer's way in only; the name is the link a keyboard and a screen reader use.
					<a className="absolute inset-0" href={href()} tabIndex={-1} aria-hidden="true" onClick={onLink} />
				)}
				<TickBox label={`Select ${sandbox.name}`} checked={ticked} disabled={pending} onChange={onTick} />
			</td>
			{/* The name takes the room the other columns leave, and truncates, so the row's actions never go off the edge. */}
			<td className={`${cell} w-full min-w-44 max-w-0`}>
				<NameCell sandbox={sandbox} href={href?.()} onLink={onLink} calls={calls} />
			</td>
			<td className={cell}>
				<IdCell sandbox={sandbox} />
			</td>
			<td className={cell}>
				{sandbox.base?.outdated === true ? (
					<span className="relative z-1 flex flex-col items-start gap-0.5">
						<StateLabel state={sandbox.state} />
						<BaseOutdatedBadge base={sandbox.base} now={now} />
					</span>
				) : (
					<StateLabel state={sandbox.state} />
				)}
			</td>
			<td className={cell}>
				{creator === undefined ? (
					<When at={sandbox.createdAt} now={now} />
				) : (
					<span className="flex flex-col">
						<When at={sandbox.createdAt} now={now} />
						<span className={`max-w-40 truncate text-sm ${creator === "You" ? "text-fg" : "text-muted"}`}>
							{creator}
						</span>
					</span>
				)}
			</td>
			<td className={cell}>
				<Tooltip
					content={`${sandboxMachineText(sandbox)}${sandbox.environment === undefined ? "" : `, from ${sandbox.environment.name}`}`}
				>
					<span className="relative z-1 flex flex-col">
						<span>{SANDBOX_KIND_LABELS[sandbox.kind]}</span>
						<span className="text-sm text-muted">{sizeText(spec)}</span>
					</span>
				</Tooltip>
			</td>
			<td className={cell}>
				<Countdown sandbox={sandbox} now={now} live={!fixedNow} />
			</td>
			<td className={cell}>
				<SnapshotCell sandbox={sandbox} now={now} />
			</td>
			{hosting === "hosted" ? (
				<td className={`${cell} text-right tabular-nums`}>{costText(sandbox.costCents ?? 0)}</td>
			) : null}
			<td className={cell}>
				<Usage sandbox={sandbox} calls={calls} />
			</td>
			<td className={`${cell} w-0 text-right`}>
				<span className="relative z-1 flex items-center justify-end gap-0.5">
					{windows && screen !== undefined && href !== undefined ? (
						// An icon under the pointer, so it takes little room from every row and never covers its usage.
						<Tooltip content={screen === "desktop" ? "Open its desktop in a new tab" : "Open its browser in a new tab"}>
							<a
								className={`${buttonClass("ghost", "xs", true)} no-underline ${onHover}`}
								href={href(screen)}
								target="_blank"
								rel="noopener"
								aria-label={`${screen === "desktop" ? "Desktop" : "Browser"} of ${sandbox.name}`}
								onClick={onScreen(screen)}
							>
								{screen === "desktop" ? <DesktopIcon size="sm" /> : <GlobeIcon size="sm" />}
							</a>
						</Tooltip>
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
					{href === undefined ? null : (
						<a
							className={`${buttonClass("ghost", "xs", true)} no-underline`}
							href={href()}
							aria-label={`Open ${sandbox.name}`}
							onClick={onLink}
						>
							<ChevronRightIcon size="sm" />
						</a>
					)}
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
					colSpan={hosting === "hosted" ? 10 : 9}
				>
					{failure}
				</td>
			</tr>
		</>
	);
}

/**
 * A phone's row, a link to the sandbox's page: the name with its state beside it, the machine and when it stops under
 * it, then its usage chart and a chevron. The page has the actions. The tick box and the usage chart (a button that
 * opens its metrics) are beside the link, not in it.
 */
function SandboxPhoneRow({
	sandbox,
	creator,
	now,
	calls,
	ticked,
	onTick,
}: {
	sandbox: Sandbox;
	/** Who made it, said with the machine; absent, the row doesn't say. */
	creator?: string;
	now: number;
	calls: RowCalls;
	ticked: boolean;
	onTick: (on: boolean) => void;
}) {
	const { pending, href, actions, can, recover } = useRowActions(sandbox, calls);
	const stops = stopsText(sandbox, now);
	// Who made it, on a failed one's row too, where its error takes the machine's line.
	const made = creator === undefined || creator === "" ? undefined : creator === "You" ? "Yours" : `By ${creator}`;
	const body = (
		<div className="flex min-w-0 flex-1 flex-col gap-1">
			<div className="flex min-w-0 items-center gap-3">
				<span className="min-w-0 flex-1 truncate text-md font-medium text-fg">{sandbox.name}</span>
				<StateLabel state={sandbox.state} />
			</div>
			{sandbox.state === "error" && sandbox.error !== undefined ? (
				<>
					<span className="line-clamp-2 text-sm text-status-error">{sandbox.error}</span>
					{made === undefined ? null : <span className="text-sm text-muted">{made}</span>}
				</>
			) : (
				<span className="flex min-w-0 flex-wrap gap-x-3 text-sm text-muted">
					<span>{sandboxMachineText(sandbox)}</span>
					{sandbox.environment === undefined ? null : <span>{sandbox.environment.name}</span>}
					{made === undefined ? null : <span>{made}</span>}
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
					<Usage sandbox={sandbox} calls={calls} />
					{actions}
				</div>
			) : (
				<>
					<a
						className="kt-focusable flex min-w-0 flex-1 items-center gap-2 py-3 text-inherit no-underline"
						href={href()}
						onClick={follow(calls.navigate)}
					>
						{body}
					</a>
					<Usage sandbox={sandbox} calls={calls} />
					<ChevronRightIcon size="sm" className="flex-none text-faint" />
				</>
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

/** The account's shapes from its source, or one host's; the dialog asks only where the source can say. */
const readShapes = (source: SandboxesSource, accountId: string, hostId?: string): Promise<SandboxShapes> =>
	source.shapes === undefined ? Promise.resolve(DEFAULT_SANDBOX_SHAPES) : source.shapes(accountId, hostId);

/**
 * New sandbox's sliders. A microVM: vCPUs, then memory, which follows the vCPUs within what each may hold, then its
 * disk where the hosts take one off their presets; a tick marks each shape the hosts offer by name. An isolate: memory
 * alone, since it shares its account's VM's CPU. Under them, the shape in a line and its price where there is one
 * (hosted). Where no host makes a shape off the presets (older hosts), a microVM is one of the presets, chosen from a
 * list, with its preset's disk.
 */
export function ShapeFields({
	kind,
	shapes,
	hosting,
	shape,
	diskKept = false,
	diskInherited = false,
	onVcpus,
	onMemory,
	onDisk,
	onPreset,
}: {
	kind: SandboxKind;
	shapes: SandboxShapes;
	hosting: HostingMode;
	shape: SandboxShape;
	/** It starts from a snapshot, which keeps its own disk: no disk may be chosen. */
	diskKept?: boolean;
	/**
	 * It is a template's own machine, whose disk its host gives, until a disk is chosen (`onDisk`): no disk is shown as
	 * chosen, since none is asked for.
	 */
	diskInherited?: boolean;
	onVcpus: (vcpus: number) => void;
	onMemory: (memoryMb: number) => void;
	onDisk: (diskGb: number) => void;
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
	// A disk is chosen only where the hosts take one off their presets and it doesn't start from a snapshot, which keeps
	// its own. Otherwise it is the host's to give, and the sandbox shows the disk it got once it runs. Disk isn't priced.
	const diskRange = diskRangeFor(shapes);
	const disk =
		diskRange === undefined || diskKept || diskInherited
			? undefined
			: (shape.diskGb ?? onGrid(diskRange, diskRange.default));
	const summary = (
		<p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
			<span>
				{shape.vcpus} vCPU, {memoryText(shape.memoryMb)} memory
				{disk === undefined ? "" : `, ${disk} GB disk`}
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
			{diskRange === undefined ? null : diskKept ? (
				<p className="text-xs text-muted">A sandbox made from a snapshot keeps its disk.</p>
			) : disk === undefined ? (
				<div className="flex flex-wrap items-center justify-between gap-2">
					<p className="text-xs text-muted">Disk: the template's own, as its host gives it.</p>
					<Button size="xs" variant="ghost" onClick={() => onDisk(onGrid(diskRange, diskRange.default))}>
						Choose a disk
					</Button>
				</div>
			) : (
				<SliderField
					label="Disk"
					value={disk}
					min={diskRange.min}
					max={diskRange.max}
					step={diskRange.step}
					format={(value) => `${value} GB`}
					marks={[...new Set(presets.map((entry) => entry.diskGb))]}
					onChange={onDisk}
				/>
			)}
			{summary}
		</div>
	);
}

/** Where New sandbox's shapes are: read (or the source can't say, so the defaults stand), being read, or not read. */
type ShapesRead = "ready" | "reading" | "failed";

/** New sandbox's read of the account's templates: loading, read, or failed with nothing read yet. */
export type TemplatesRead =
	| { readonly status: "loading" }
	| { readonly status: "failed" }
	| { readonly status: "ready"; readonly value: readonly Template[] };

/**
 * The template asked for in New sandbox (picked, or named by the page that opened it): the list's record of it, still
 * `pending` while the list is read, or a `problem` once it can't be had. Create waits on the first and shows the
 * second, so a sandbox asked for from a template is never quietly made without it.
 */
export function requestedTemplate(
	templateId: string,
	read: TemplatesRead,
	type: NewSandboxType,
): { readonly template?: Template; readonly pending: boolean; readonly problem?: string } {
	if (templateId === "") return { pending: false };
	// An isolate takes no template, but only one the user chose drops it: one picked for them keeps it, refused.
	if (type.kind === "isolate")
		return type.chosen
			? { pending: false }
			: {
					pending: false,
					problem:
						"A template makes a microVM, and none of this organisation's hosts run them. Pick None or choose Isolate to make a clean isolate.",
				};
	if (read.status === "loading") return { pending: true };
	if (read.status === "failed")
		return { pending: false, problem: "Kantel couldn't read the templates. Close this and try again, or pick None." };
	const template = read.value.find((entry) => entry.id === templateId);
	return template === undefined
		? { pending: false, problem: "That template isn't in this account. Pick another, or None." }
		: { template, pending: false };
}

/** The type New sandbox makes, and whether the user chose it rather than having it picked for them. */
export interface NewSandboxType {
	readonly kind: SandboxKind;
	readonly chosen: boolean;
}

/**
 * The type New sandbox makes: the one chosen, else a microVM. Where no host runs microVMs an isolate is all that can
 * be made, so it's an isolate, chosen only if the user chose it.
 */
export function newSandboxType(chosen: SandboxKind | undefined, microvms: boolean): NewSandboxType {
	if (!microvms) return { kind: "isolate", chosen: chosen === "isolate" };
	return { kind: chosen ?? "microvm", chosen: chosen !== undefined };
}

/** What New sandbox's form asks for. */
export interface NewSandboxForm {
	readonly accountId: string;
	readonly name: string;
	readonly kind: SandboxKind;
	readonly shape: SandboxShape;
	/** Whether the sliders were moved from the template's own vCPUs, memory and disk. */
	readonly shapeChosen: boolean;
	readonly from: string;
	/** Whether the snapshot it starts from holds memory, so the sandbox is that snapshot's machine. */
	readonly fromMemory?: boolean;
	readonly environment: string;
	/** The template a microVM is made from, resolved by `requestedTemplate`. */
	readonly template?: Template;
	readonly autoStop: string;
	/** Minutes unused before its idle stop, or `never`; absent: none. */
	readonly idleStop?: string;
	/** The host it goes on; absent or empty: Kantel picks. */
	readonly host?: string;
}

/**
 * The create New sandbox sends. A microVM from a template whose sliders weren't moved names no shape, so the
 * template's own vCPUs and memory apply; moved, the shape overrides them, and the sandbox boots fresh (a template's
 * snapshot restores only into its own machine). A template's sandbox starts from its snapshot, not a saved one. One
 * from a saved snapshot that holds memory names no shape either: it restores only into the machine it was saved from.
 * A disk goes only with a microVM that doesn't start from a saved snapshot: one that does keeps the snapshot's disk.
 */
export function newSandboxInput(form: NewSandboxForm): CreateSandboxInput {
	const template = form.kind === "microvm" ? form.template : undefined;
	const from = form.from === "" || template !== undefined ? undefined : form.from;
	const keepsMachine = form.kind === "microvm" && from !== undefined && form.fromMemory === true;
	const { diskGb, ...withoutDisk } = form.shape;
	const shape = diskGb === undefined || form.kind === "isolate" || from !== undefined ? withoutDisk : form.shape;
	return {
		accountId: form.accountId,
		...(form.name === "" ? {} : { name: form.name }),
		kind: form.kind,
		...((template !== undefined && !form.shapeChosen) || keepsMachine ? {} : { shape }),
		...(from === undefined ? {} : { fromSnapshot: from }),
		...(form.environment === "" ? {} : { environmentId: form.environment }),
		...(template === undefined ? {} : { templateId: template.id }),
		...(form.autoStop === "never" ? {} : { autoStopMinutes: Number(form.autoStop) }),
		...(form.idleStop === undefined || form.idleStop === "never" ? {} : { idleStopMinutes: Number(form.idleStop) }),
		...(form.host === undefined || form.host === "" ? {} : { hostId: form.host }),
	};
}

/**
 * The host picker's options: Kantel's pick, then each host that can take the type now. One that can't is listed only
 * while it is the one picked, with why, so a choice never silently changes.
 */
export function hostOptions(
	hosts: readonly HostChoice[],
	kind: SandboxKind,
	picked: string,
): { value: string; label: string }[] {
	const why = (host: HostChoice) =>
		host.state !== "online" ? host.state : host.kinds.includes(kind) ? undefined : `no ${kind}s`;
	const label = (host: HostChoice) => {
		const reason = why(host);
		const name = host.shared ? `${host.name} (shared)` : host.name;
		return reason === undefined ? name : `${name}: ${reason}`;
	};
	return [
		{ value: "", label: "Any host" },
		...hosts
			.filter((host) => why(host) === undefined || host.id === picked)
			.map((host) => ({ value: host.id, label: label(host) })),
	];
}

/** Why the picked host can't take a sandbox of `kind` now, or undefined when it can (or none is picked). */
export function hostProblem(hosts: readonly HostChoice[], kind: SandboxKind, picked: string): string | undefined {
	if (picked === "") return undefined;
	const host = hosts.find((each) => each.id === picked);
	if (host === undefined) return "That host is gone. Pick another.";
	if (host.state !== "online") return `${host.name} is ${host.state}, so it takes no new sandboxes.`;
	if (!host.kinds.includes(kind)) return `${host.name} doesn't run ${kind}s.`;
	return undefined;
}

/**
 * Reads the account's templates each time New sandbox opens, and again while one builds so the picker's hint keeps up.
 * A failed read keeps the last list, and is shown only when there's none.
 */
function useTemplatesRead(
	open: boolean,
	templates: (() => Promise<readonly Template[]>) | undefined,
	pollMs: number,
): TemplatesRead {
	const [read, setRead] = useState<TemplatesRead>(
		templates === undefined ? { status: "ready", value: [] } : { status: "loading" },
	);
	const [generation, setGeneration] = useState(0);
	// The page passes a new function each render: the read follows the latest without reading again for it.
	const latest = useRef(templates);
	latest.current = templates;
	const offered = templates !== undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `generation` is a read again.
	useEffect(() => {
		const list = latest.current;
		if (!open || list === undefined) return;
		let live = true;
		list().then(
			(value) => {
				if (live) setRead({ status: "ready", value });
			},
			() => {
				// A fresh object keeps the polling going after a failed read of a list already shown.
				if (live) setRead((current) => (current.status === "ready" ? { ...current } : { status: "failed" }));
			},
		);
		return () => {
			live = false;
		};
	}, [open, offered, generation]);
	const wait = open && read.status === "ready" ? buildPollMs(read.value, pollMs) : undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies: each read schedules the next while a template builds.
	useEffect(() => {
		if (wait === undefined) return;
		const timer = setTimeout(() => setGeneration((value) => value + 1), wait);
		return () => clearTimeout(timer);
	}, [wait, read]);
	return read;
}

export function NewSandboxDialog({
	open,
	account,
	hosting,
	shapes: loadShapes,
	savedSnapshots,
	environments,
	templates,
	template: initialTemplate,
	hosts: loadHosts,
	now,
	onClose,
	onCreate,
}: {
	open: boolean;
	account: ComputeAccount;
	hosting: HostingMode;
	/** What the hosts offer: all the account may use, or with `hostId` that one host's. */
	shapes?: (hostId?: string) => Promise<SandboxShapes>;
	/** The hosts it may be put on (`SandboxesSource.hosts`); absent or none, no picker. */
	hosts?: () => Promise<readonly HostChoice[]>;
	savedSnapshots?: () => Promise<readonly SavedSnapshot[]>;
	environments?: () => Promise<readonly Environment[]>;
	templates?: () => Promise<readonly Template[]>;
	template?: string;
	now: number;
	onClose: () => void;
	onCreate: (input: CreateSandboxInput) => void;
}) {
	const [name, setName] = useState("");
	const [chosenKind, setChosenKind] = useState<SandboxKind>();
	const [shapes, setShapes] = useState<SandboxShapes>(DEFAULT_SANDBOX_SHAPES);
	const [vcpus, setVcpus] = useState(DEFAULT_SANDBOX_SHAPES.microvm.vcpus.default);
	const [memoryMb, setMemoryMb] = useState(DEFAULT_SANDBOX_SHAPES.microvm.memoryMb.default);
	// A microVM's disk, where the hosts take one off their presets.
	const [diskGb, setDiskGb] = useState(fitDisk(DEFAULT_SANDBOX_SHAPES));
	const [isolateMb, setIsolateMb] = useState(DEFAULT_SANDBOX_SHAPES.isolate.memoryMb.default);
	const [autoStop, setAutoStop] = useState("60");
	const [idleStop, setIdleStop] = useState("never");
	const [from, setFrom] = useState("");
	const [environment, setEnvironment] = useState("");
	const [saved, setSaved] = useState<readonly SavedSnapshot[]>([]);
	const [envs, setEnvs] = useState<readonly Environment[]>([]);
	const [hostList, setHostList] = useState<readonly HostChoice[]>([]);
	const [host, setHost] = useState("");
	// A source that says what its hosts offer: nothing may be chosen or created until it has, so a create never goes
	// with the sample's figures. One that can't say keeps the defaults.
	const [shapesRead, setShapesRead] = useState<ShapesRead>(loadShapes === undefined ? "ready" : "reading");
	const [templateId, setTemplateId] = useState(initialTemplate ?? "");
	const tplRead = useTemplatesRead(open, templates, TEMPLATE_POLL_MS);
	// Whether the sliders were moved from a picked template's own vCPUs, memory and disk.
	const [shapeChosen, setShapeChosen] = useState(false);
	const asked = useRef(false);
	// The newest read of the shapes: one for a host picked before it lands is dropped.
	const shapesReads = useRef(0);
	const readShapesNow = useCallback(
		(hostId?: string) => {
			if (loadShapes === undefined) return;
			const read = ++shapesReads.current;
			setShapesRead("reading");
			loadShapes(hostId === undefined || hostId === "" ? undefined : hostId).then(
				(shapesOf) => {
					if (read !== shapesReads.current) return;
					// Set on each read, before any slider can move: the controls show only once this lands.
					const presets = shapesOf.microvm.presets;
					const cpus = vcpuRangeFor(shapesOf).default;
					const start = customShapes(shapesOf)
						? { vcpus: cpus, memoryMb: fitMemory(shapesOf, cpus, shapesOf.microvm.memoryMb.default) }
						: (presets.find(
								(preset) =>
									preset.vcpus === shapesOf.microvm.vcpus.default &&
									preset.memoryMb === shapesOf.microvm.memoryMb.default,
							) ?? presets[0]);
					setShapes(shapesOf);
					if (start !== undefined) {
						setVcpus(start.vcpus);
						setMemoryMb(start.memoryMb);
					}
					setDiskGb(fitDisk(shapesOf));
					setIsolateMb(onGrid(shapesOf.isolate.memoryMb, shapesOf.isolate.memoryMb.default));
					setShapesRead("ready");
				},
				() => {
					if (read === shapesReads.current) setShapesRead("failed");
				},
			);
		},
		[loadShapes],
	);
	useEffect(() => {
		if (!open || asked.current) return;
		asked.current = true;
		savedSnapshots?.().then(setSaved, () => setSaved([]));
		environments?.().then(setEnvs, () => setEnvs([]));
		// Hosts it can't read leave Kantel to pick, as with none.
		loadHosts?.().then(setHostList, () => setHostList([]));
		readShapesNow();
	}, [open, savedSnapshots, environments, loadHosts, readShapesNow]);
	const valid = name === "" || /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(name);
	const noMicrovms = shapesRead === "ready" && !microvmsAvailable(shapes);
	const type = newSandboxType(chosenKind, !noMicrovms);
	const kind = type.kind;
	const fromOptions = saved.filter((entry) => entry.kind === kind);
	const tpls = tplRead.status === "ready" ? tplRead.value : [];
	const requested = requestedTemplate(templateId, tplRead, type);
	const picked = requested.template;
	// A template's sandbox gets the template's own vCPUs and memory until a slider moves.
	const ownShape = picked !== undefined && !shapeChosen;
	// A sandbox from a saved snapshot keeps the snapshot's disk, so none is asked for; a template's takes no saved one.
	const diskKept = from !== "" && picked === undefined;
	const disk = diskKept || diskGb === undefined ? {} : { diskGb };
	// A saved snapshot that holds memory restores only into the machine it was saved from: no slider can change it.
	const startFrom =
		kind === "microvm" && picked === undefined ? fromOptions.find((entry) => entry.id === from) : undefined;
	const keepsMachine = startFrom?.memory === true;
	const shape: SandboxShape =
		kind === "isolate"
			? { vcpus: 0, memoryMb: isolateMb }
			: ownShape
				? // Its host gives the template's machine its disk: none is chosen until one is (`diskInherited`).
					{ vcpus: picked.spec.vcpus, memoryMb: picked.spec.memoryMb }
				: { vcpus, memoryMb, ...disk };
	// A microVM's shape is one the hosts can make: a preset, or one within both memory bounds, and any disk in range.
	const hostError = hostProblem(hostList, kind, host);
	const ready =
		valid &&
		hostError === undefined &&
		shapesRead === "ready" &&
		(ownShape || keepsMachine || shapeCreatable(shapes, kind, shape)) &&
		!requested.pending &&
		requested.problem === undefined;
	const submit = () => {
		if (!ready) return;
		onCreate(
			newSandboxInput({
				accountId: account.id,
				name,
				kind,
				shape,
				shapeChosen,
				from,
				fromMemory: keepsMachine,
				environment,
				...(picked === undefined ? {} : { template: picked }),
				autoStop,
				idleStop,
				host,
			}),
		);
		setName("");
		setFrom("");
		setEnvironment("");
		setTemplateId("");
		setShapeChosen(false);
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
					<Button type="submit" variant="primary" busy={requested.pending} disabled={!ready}>
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
						onChange={setChosenKind}
					/>
					<span className="text-xs text-muted">
						{noMicrovms
							? "None of this organisation's hosts run microVMs, so only isolates can be made here."
							: kind === "microvm"
								? "A Firecracker microVM: root, Docker, systemd and /dev/kvm inside. Up in about a second."
								: "A V8 isolate with a shell and JavaScript. Up in milliseconds, nearly free, no Docker."}
					</span>
				</div>
				{/* A requested template stays in view when an isolate was picked for the user, refused until they choose. */}
				{(kind === "microvm" ? tpls.length > 0 || templateId !== "" : templateId !== "" && !type.chosen) ? (
					<SelectField
						label="Template"
						value={templateId}
						onChange={(event) => {
							setTemplateId(event.currentTarget.value);
							setShapeChosen(false);
						}}
						hint={
							picked !== undefined
								? templatePickHint(picked, now, shape)
								: requested.pending
									? "Reading the templates."
									: "Experimental."
						}
						{...(requested.problem === undefined ? {} : { error: requested.problem })}
						options={[
							{ value: "", label: "None: Kantel's base image" },
							// The one asked for, until the list has it: it stays picked rather than becoming None.
							...(templateId === "" || tpls.some((entry) => entry.id === templateId)
								? []
								: [{ value: templateId, label: templateId }]),
							...tpls.map((entry) => ({
								value: entry.id,
								label: `${entry.name} (v${entry.version}, ${resourcesText(entry.spec)})`,
							})),
						]}
					/>
				) : null}
				{shapesRead === "reading" ? (
					<p className="text-xs text-muted" role="status">
						Reading what the hosts offer…
					</p>
				) : shapesRead === "failed" ? (
					<Notice
						level="error"
						action={
							<Button size="sm" onClick={() => readShapesNow(host)}>
								Try again
							</Button>
						}
					>
						Kantel couldn't read what the hosts offer, so a size can't be chosen yet.
					</Notice>
				) : keepsMachine ? (
					<p className="text-xs text-muted">
						This snapshot holds its sandbox's memory, so the new sandbox is the machine it was saved from
						{startFrom?.machine === undefined
							? "."
							: `: ${startFrom.machine.vcpus} vCPU, ${memoryText(startFrom.machine.memoryMb)} memory.`}
					</p>
				) : (
					<ShapeFields
						kind={kind}
						shapes={shapes}
						hosting={hosting}
						shape={shape}
						diskKept={diskKept}
						diskInherited={ownShape}
						onVcpus={(next) => {
							// From what the sliders show: a picked template's own shape until one moves.
							setShapeChosen(true);
							setVcpus(next);
							setMemoryMb(fitMemory(shapes, next, shape.memoryMb));
						}}
						onMemory={(next) => {
							if (kind === "isolate") {
								setIsolateMb(next);
								return;
							}
							setShapeChosen(true);
							setVcpus(shape.vcpus);
							setMemoryMb(next);
						}}
						onDisk={(next) => {
							setShapeChosen(true);
							setVcpus(shape.vcpus);
							setMemoryMb(shape.memoryMb);
							setDiskGb(next);
						}}
						onPreset={(next) => {
							setShapeChosen(true);
							setVcpus(next.vcpus);
							setMemoryMb(next.memoryMb);
						}}
					/>
				)}
				{hostList.length === 0 ? null : (
					<SelectField
						label="Host"
						value={host}
						onChange={(event) => {
							const picked = event.currentTarget.value;
							setHost(picked);
							// What that host offers, or every host's again: the sliders start over from its defaults.
							setShapeChosen(false);
							readShapesNow(picked);
						}}
						options={hostOptions(hostList, kind, host)}
						hint="It stays on the host it starts on."
						{...(hostError === undefined ? {} : { error: hostError })}
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
				<SelectField
					label="Stop when unused for"
					value={idleStop}
					onChange={(event) => setIdleStop(event.currentTarget.value)}
					options={IDLE_STOP_CHOICES}
					hint={IDLE_STOP_HINT}
				/>
				{savedSnapshots === undefined || picked !== undefined ? null : (
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

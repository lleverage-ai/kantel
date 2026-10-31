import type { AuditEvent } from "@harbour/contracts";
import { type KeyboardEvent, memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { VList, type VListHandle } from "virtua";
import { Button } from "../primitives/button.tsx";
import { SelectField } from "../primitives/controls.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { ChevronDownIcon, ChevronRightIcon } from "../primitives/icons.tsx";
import { EllipsisIcon, FilterIcon } from "../primitives/lucide.tsx";
import { Menu } from "../primitives/menu.tsx";
import { Skeleton, Spinner } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import {
	type AuditDirectory,
	type AuditFilters,
	type AuditLinks,
	type AuditSource,
	actorKey,
	actorName,
	DEFAULT_FILTERS,
	describeEvent,
	eventBrowserSession,
	exportName,
	isFiltered,
	KINDS,
	RANGES,
	rangeBounds,
	readAll,
	toJsonl,
	toQuery,
} from "./audit-model.ts";
import { CredentialUsagePanel } from "./credential-usage.tsx";
import { PAGE_SIZE, useAuditFeed } from "./use-audit-feed.ts";

// The audit log as a filterable, virtualised timeline, newest first. Only the rows near the viewport are mounted, so a
// log of any length costs the same to scroll; pages are read from the store as the reader nears the end of what's
// loaded. Each row reads as a sentence ("Tom Davies approved Linear API key for POST api.linear.app/graphql") and
// links to the session turn or vault request it came from. Export writes every event the filters match as JSONL.

// Styled with Tailwind utilities (src/tokens/tailwind.css). The hb-audit-list, hb-audit-row and hb-audit-status classes
// carry no style: scripts/audit-perf.ts finds the list by them. Under `max-sm:` (a phone) a row's sentence and link
// take the whole second line.

/** The page: header, filters, the credential summary and the timeline. Headings and paragraphs inside it, the
 * primitives' included, sit flush, as they did when each set its own margin to 0. */
const page = "hb-audit flex min-w-0 flex-col gap-4 text-sm text-fg [&_h1]:m-0 [&_h2]:m-0 [&_p]:m-0";
/**
 * The filters as a logs toolbar, after Vercel's and Stripe's logs: When and What on one row with a Filters toggle for
 * the rest and the count at its far end, and the rarer filters (credential, who, project, agent, session) on a second
 * compact row the toggle opens. Each row wraps on a narrow screen.
 */
const toolbarRow = "flex min-w-0 flex-wrap items-center gap-2";
/** The timeline scrolls inside a fixed-height box so the virtual list knows its viewport. */
const viewport = "relative h-[70vh] min-h-[calc(var(--hb-control-lg)*8)] max-sm:h-[75vh]";
const rowToggle =
	"hb-focusable inline-flex size-control-xs cursor-pointer items-center justify-center self-center rounded-sm border-0 bg-transparent p-0 text-faint hover:bg-hover hover:text-fg";
/** Under the toggle's column on a desktop, so the details line up with the time. */
const rowDetails =
	"flex flex-col gap-2 pr-3 pb-2.5 pl-[calc(var(--hb-control-xs)+var(--hb-step-1_5)+var(--hb-step-2))] max-sm:pl-3";
const dt = "text-muted";
const dd = "hb-mono m-0 wrap-anywhere";

/** How close to the end of the loaded rows asks for the next page, in rows. */
const LOAD_AHEAD_ROWS = 40;
/** How far beyond the viewport rows stay mounted, in CSS pixels. */
const BUFFER_PX = 600;

export interface Choice {
	readonly value: string;
	readonly label: string;
}

export interface AuditViewProps {
	readonly source: AuditSource;
	readonly directory?: AuditDirectory;
	readonly links?: AuditLinks;
	/** The options each filter offers. A filter with no options is hidden. */
	readonly choices?: {
		/** The organisations the viewer may read, the current one first. Hidden unless there are two or more. */
		readonly organisations?: readonly Choice[];
		readonly actors?: readonly Choice[];
		readonly projects?: readonly Choice[];
		readonly agents?: readonly Choice[];
		readonly sessions?: readonly Choice[];
		readonly credentials?: readonly Choice[];
	};
	readonly initialFilters?: AuditFilters;
	/** The time ranges are measured from; the current time when absent. */
	readonly now?: number;
	/** Check for newer events this often (ms), and offer to show them. Off when absent. */
	readonly pollMs?: number;
	/** Called with the export instead of downloading it: for hosts that save elsewhere, and for tests. */
	readonly onExport?: (jsonl: string, fileName: string, count: number) => void;
}

const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const absolute = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium" });
const count = new Intl.NumberFormat("en-GB");

type Entry = { readonly day: string; readonly key: string } | { readonly event: AuditEvent; readonly key: string };

/** A local calendar day as a number, cheaply: formatting every event's date would cost more than the rest of a page. */
const dayNumber = (at: number) => {
	const date = new Date(at);
	return date.getFullYear() * 10_000 + date.getMonth() * 100 + date.getDate();
};

/**
 * The events with a heading before each new local day. When the events only grew at the end (the next page), only
 * the new ones are walked, so reading page 500 costs what reading page 1 did.
 */
function useDayEntries(events: readonly AuditEvent[]): readonly Entry[] {
	const built = useRef<{ events: readonly AuditEvent[]; entries: Entry[]; day: number | undefined }>({
		events: [],
		entries: [],
		day: undefined,
	});
	return useMemo(() => {
		const previous = built.current;
		const grew =
			previous.events.length > 0 &&
			events.length >= previous.events.length &&
			events[previous.events.length - 1] === previous.events.at(-1);
		const entries = grew ? previous.entries.slice() : [];
		let day = grew ? previous.day : undefined;
		for (let index = grew ? previous.events.length : 0; index < events.length; index += 1) {
			const event = events[index]!;
			const next = dayNumber(event.at);
			if (next !== day) {
				const label = dayFormat.format(event.at);
				entries.push({ day: label, key: `day:${next}` });
				day = next;
			}
			entries.push({ event, key: event.id });
		}
		built.current = { events, entries, day };
		return entries;
	}, [events]);
}

function Select({
	label,
	value,
	options,
	onChange,
	any,
}: {
	label: string;
	value: string;
	options: readonly Choice[];
	onChange: (value: string) => void;
	any?: string;
}) {
	// A toolbar's select: its options say what it filters ("Last 24 hours", "Anyone"), so its label is for screen readers.
	return (
		<SelectField
			label={label}
			hideLabel
			value={value}
			options={any === undefined ? options : [{ value: "", label: any }, ...options]}
			onChange={(event) => onChange(event.target.value)}
		/>
	);
}

const AuditRow = memo(function AuditRow({
	event,
	directory,
	links,
	open,
	active,
	onToggle,
	onFocusRow,
	onBrowser,
}: {
	event: AuditEvent;
	directory: AuditDirectory;
	links: AuditLinks;
	open: boolean;
	/** The row holding the list's one Tab stop; arrow keys move it (see AuditView). */
	active: boolean;
	onToggle: (id: string) => void;
	onFocusRow: (id: string) => void;
	/** Narrows the log to one browser session's history; absent while it already is. */
	onBrowser: ((browserSessionId: string) => void) | undefined;
}) {
	const line = describeEvent(event, directory, links);
	const browserSession = eventBrowserSession(event);
	const actor = actorName(event.actor, directory);
	const detailsId = `audit-${event.seq}`;
	const project = event.projectId === undefined ? undefined : (directory.project?.(event.projectId) ?? event.projectId);
	// The session's name, unless the row already links to it by name.
	const sessionName =
		event.sessionId === undefined ? undefined : (directory.session?.(event.sessionId) ?? event.sessionId);
	const session = line.link?.label === sessionName ? undefined : sessionName;
	return (
		<div className="hb-audit-row border-t border-border data-open:bg-sunken" data-open={open || undefined}>
			<div className="grid grid-cols-[auto_auto_auto_minmax(0,1fr)_auto] items-baseline gap-2 py-2 pr-3 pl-1.5 max-sm:grid-cols-[auto_auto_minmax(0,1fr)] max-sm:gap-y-1">
				<button
					type="button"
					id={`audit-toggle-${event.seq}`}
					tabIndex={active ? 0 : -1}
					aria-describedby={active ? "hb-audit-keys" : undefined}
					onFocus={() => onFocusRow(event.id)}
					className={rowToggle}
					aria-expanded={open}
					aria-controls={open ? detailsId : undefined}
					aria-label={`Details: ${actor} ${line.action}`}
					onClick={() => onToggle(event.id)}
				>
					{open ? <ChevronDownIcon /> : <ChevronRightIcon />}
				</button>
				<time
					className="font-mono text-xs text-faint tabular-nums"
					dateTime={new Date(event.at).toISOString()}
					title={absolute.format(event.at)}
				>
					{timeFormat.format(event.at)}
				</time>
				<span className="inline-flex">
					<Badge tone={line.tone}>{line.label}</Badge>
				</span>
				<p className="m-0 min-w-0 wrap-anywhere max-sm:col-[2/-1]">
					<span className="font-medium">{actor}</span> {line.action}
					{project === undefined && session === undefined ? null : (
						<span className="ml-2 inline-flex flex-wrap gap-x-2 text-xs text-faint">
							{project === undefined ? null : <span>{project}</span>}
							{session === undefined ? null : <span>{session}</span>}
						</span>
					)}
				</p>
				{line.link === undefined ? null : (
					<a
						className="hb-focusable rounded-xs text-xs whitespace-nowrap text-accent-text no-underline hover:underline max-sm:col-[2/-1]"
						href={line.link.href}
						tabIndex={active ? 0 : -1}
						onFocus={() => onFocusRow(event.id)}
					>
						{line.link.label}
					</a>
				)}
			</div>
			{open ? (
				<div id={detailsId} className={rowDetails}>
					<dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
						<dt className={dt}>Type</dt>
						<dd className={dd}>{event.type}</dd>
						<dt className={dt}>At</dt>
						<dd className="m-0 wrap-anywhere">{absolute.format(event.at)}</dd>
						<dt className={dt}>Actor</dt>
						<dd className={dd}>{actorKey(event.actor)}</dd>
						{event.subject === undefined ? null : (
							<>
								<dt className={dt}>Subject</dt>
								<dd className={dd}>
									{event.subject.kind} {event.subject.id}
								</dd>
							</>
						)}
						<dt className={dt}>Event</dt>
						<dd className={dd}>
							{event.id} (seq {event.seq})
						</dd>
					</dl>
					{event.data === undefined ? null : (
						<pre className="hb-selectable m-0 rounded-control bg-code-surface px-2.5 py-2 font-mono text-code whitespace-pre-wrap wrap-anywhere">
							{JSON.stringify(event.data, null, 2)}
						</pre>
					)}
					{browserSession === undefined || onBrowser === undefined ? null : (
						<div className="flex gap-1.5">
							<Button size="sm" variant="secondary" onClick={() => onBrowser(browserSession)}>
								This browser's history
							</Button>
						</div>
					)}
				</div>
			) : null}
		</div>
	);
});

type ExportState =
	| { readonly phase: "idle" }
	| { readonly phase: "running"; readonly count: number }
	| { readonly phase: "failed" };

function download(jsonl: string, fileName: string) {
	const url = URL.createObjectURL(new Blob([jsonl], { type: "application/x-ndjson" }));
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	anchor.click();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function AuditView({
	source,
	directory = {},
	links = {},
	choices = {},
	initialFilters = DEFAULT_FILTERS,
	now: fixedNow,
	pollMs,
	onExport,
}: AuditViewProps) {
	const [filters, setFilters] = useState<AuditFilters>(initialFilters);
	// Ranges are measured from when the filters were last set, so the query holds still while the reader scrolls.
	const [now, setNow] = useState(() => fixedNow ?? Date.now());
	const query = useMemo(() => toQuery(filters, now), [filters, now]);
	const feed = useAuditFeed(source, query, pollMs);
	const entries = useDayEntries(feed.events);
	const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
	// The list is one Tab stop, on the active row; arrow keys, Home and End move it. A log of thousands of rows would
	// otherwise be thousands of Tab presses between the filters and the foot of the list.
	const [activeId, setActiveId] = useState<string>();
	const activeIndex = useMemo(() => {
		const index =
			activeId === undefined ? -1 : entries.findIndex((entry) => entry.key === activeId && !("day" in entry));
		return index === -1 ? entries.findIndex((entry) => !("day" in entry)) : index;
	}, [entries, activeId]);
	const [exporting, setExporting] = useState<ExportState>({ phase: "idle" });
	const abort = useRef<AbortController | undefined>(undefined);
	const list = useRef<VListHandle>(null);
	// The second row of filters: shown while any of them is set (a link may arrive with one) until the reader toggles it.
	const [moreOpen, setMoreOpen] = useState<boolean>();
	const moreId = useId();

	const update = useCallback(
		(change: Partial<AuditFilters>) => {
			// Projects, agents, sessions and credentials belong to one organisation, so a new one clears them.
			setFilters((previous) =>
				"organisationId" in change && change.organisationId !== previous.organisationId
					? {
							range: previous.range,
							kind: previous.kind,
							...(previous.actor === undefined ? {} : { actor: previous.actor }),
							...change,
						}
					: { ...previous, ...change },
			);
			setNow(fixedNow ?? Date.now());
			setOpen(new Set());
			setActiveId(undefined);
			list.current?.scrollTo(0);
		},
		[fixedNow],
	);
	const showBrowser = useCallback((browserSession: string) => update({ browserSession }), [update]);
	const toggle = useCallback((id: string) => {
		setOpen((previous) => {
			const next = new Set(previous);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	}, []);

	const onListKey = useCallback(
		(e: KeyboardEvent<HTMLDivElement>) => {
			if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key) || activeIndex === -1) return;
			const step = e.key === "ArrowDown" || e.key === "End" ? 1 : -1;
			let target = e.key === "Home" ? 0 : e.key === "End" ? entries.length - 1 : activeIndex + step;
			while (target >= 0 && target < entries.length && "day" in entries[target]!) target += e.key === "Home" ? 1 : step;
			const entry = entries[target];
			if (entry === undefined || "day" in entry) return;
			e.preventDefault();
			setActiveId(entry.key);
			list.current?.scrollToIndex(target, { align: "nearest" });
			// Focus once the row is mounted, measured and holds the Tab stop: a far jump (Home, End) can take a few frames,
			// and the virtual list keeps a row hidden, so unfocusable, until it has measured it.
			const id = `audit-toggle-${entry.event.seq}`;
			let frames = 0;
			const focus = () => {
				const button = document.getElementById(id);
				frames += 1;
				if (button !== null && button.tabIndex === 0) button.focus();
				if (document.activeElement !== button && frames < 30) requestAnimationFrame(focus);
			};
			requestAnimationFrame(focus);
		},
		[entries, activeIndex],
	);

	const { loadMore, hasMore, loadingMore, error } = feed;
	const onScroll = useCallback(() => {
		const handle = list.current;
		if (handle === null || !hasMore || loadingMore || error !== undefined) return;
		const end = handle.findItemIndex(handle.scrollOffset + handle.viewportSize);
		if (end >= entries.length - LOAD_AHEAD_ROWS) loadMore();
	}, [entries.length, hasMore, loadingMore, error, loadMore]);
	// A short first page (a narrow filter) may not fill the list: read on until it scrolls or the log ends.
	useEffect(() => {
		if (!feed.loading) onScroll();
	}, [feed.loading, onScroll]);

	useEffect(() => () => abort.current?.abort(), []);
	const runExport = useCallback(async () => {
		abort.current?.abort();
		const controller = new AbortController();
		abort.current = controller;
		setExporting({ phase: "running", count: 0 });
		const events: AuditEvent[] = [];
		// A cancelled export, or one a newer export replaced, never touches the state again.
		const mine = () => abort.current === controller && !controller.signal.aborted;
		try {
			// Oldest first in the file, as a log reads.
			for await (const page of readAll(source, { ...query, newestFirst: false }, { signal: controller.signal })) {
				events.push(...page);
				if (mine()) setExporting({ phase: "running", count: events.length });
			}
			if (!mine()) return;
			const jsonl = toJsonl(events);
			const name = exportName(filters, now);
			if (onExport === undefined) download(jsonl, name);
			else onExport(jsonl, name, events.length);
			setExporting({ phase: "idle" });
		} catch {
			if (mine()) setExporting({ phase: "failed" });
		} finally {
			if (abort.current === controller) abort.current = undefined;
		}
	}, [source, query, filters, now, onExport]);
	const cancelExport = useCallback(() => {
		abort.current?.abort();
		setExporting({ phase: "idle" });
	}, []);

	// Rolling ranges have no upper bound, so newer events are already inside the query: reading it again shows them.
	const { showNewer } = feed;
	const showNewest = useCallback(() => {
		list.current?.scrollTo(0);
		showNewer();
	}, [showNewer]);

	const rangeLabel = RANGES.find((range) => range.value === filters.range)?.label ?? "";
	const credentialLabel = choices.credentials?.find((choice) => choice.value === filters.credential)?.label;
	const { from, to } = rangeBounds(filters.range, now);

	// The filters behind the Filters toggle, those the host offers choices for, and how many of them are set.
	const filled = (value: string | undefined) => value !== undefined && value !== "";
	const offered = (options: readonly Choice[] | undefined): options is readonly Choice[] =>
		options !== undefined && options.length > 0;
	const more = [
		[choices.credentials, filters.credential],
		[choices.actors, filters.actor],
		[choices.projects, filters.projectId],
		[choices.agents, filters.agentId],
		[choices.sessions, filters.sessionId],
	] as const;
	const moreOffered = more.some(([options]) => offered(options));
	const moreSet = more.filter(([options, value]) => offered(options) && filled(value)).length;
	const showMore = moreOffered && (moreOpen ?? moreSet > 0);

	return (
		<section className={page} aria-labelledby="hb-audit-title">
			<PageHeader
				titleId="hb-audit-title"
				title="Audit log"
				actions={
					// Export is rare, so it waits in the overflow menu. While it runs, its progress and Cancel
					// take the menu's place: a menu item can show neither.
					exporting.phase === "running" ? (
						<>
							<span className="inline-flex items-center gap-1.5 text-muted tabular-nums" role="status">
								<Spinner size="sm" /> Exporting {count.format(exporting.count)} events
							</span>
							<Button size="sm" variant="ghost" onClick={cancelExport}>
								Cancel
							</Button>
						</>
					) : (
						<Menu
							label="More"
							icon={<EllipsisIcon />}
							size="sm"
							align="end"
							entries={[
								{
									kind: "item",
									id: "export",
									label: "Export JSONL",
									disabled: feed.loading,
									onSelect: () => void runExport(),
								},
							]}
						/>
					)
				}
			/>
			{exporting.phase === "failed" ? (
				<Notice level="error">The export couldn't read every event, so nothing was saved. Try again.</Notice>
			) : null}

			<form className="flex min-w-0 flex-col gap-2" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
				<div className={toolbarRow}>
					{/* The organisation scopes every other filter (a new one clears them), so it leads the row. */}
					{choices.organisations === undefined || choices.organisations.length < 2 ? null : (
						<Select
							label="Organisation"
							value={filters.organisationId ?? choices.organisations[0]!.value}
							options={choices.organisations}
							onChange={(value) =>
								update({ organisationId: value === choices.organisations?.[0]?.value ? undefined : value })
							}
						/>
					)}
					<Select
						label="When"
						value={filters.range}
						options={RANGES}
						onChange={(value) => update({ range: value as AuditFilters["range"] })}
					/>
					<Select
						label="What"
						value={filters.kind}
						options={KINDS}
						onChange={(value) => update({ kind: value as AuditFilters["kind"] })}
					/>
					{moreOffered ? (
						<Button
							size="sm"
							variant="ghost"
							icon={<FilterIcon size="sm" />}
							aria-expanded={showMore}
							{...(showMore ? { "aria-controls": moreId } : {})}
							onClick={() => setMoreOpen(!showMore)}
						>
							{moreSet > 0 ? `Filters ${moreSet}` : "Filters"}
						</Button>
					) : null}
					{filters.browserSession === undefined || filters.browserSession === "" ? null : (
						<span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted">
							Browser session
							<code className="hb-mono truncate text-fg">{filters.browserSession}</code>
							<Button size="sm" variant="ghost" onClick={() => update({ browserSession: "" })}>
								Every browser
							</Button>
						</span>
					)}
					{isFiltered(filters) ? (
						<Button
							size="sm"
							variant="ghost"
							onClick={() =>
								update({
									...DEFAULT_FILTERS,
									range: filters.range,
									actor: "",
									projectId: "",
									agentId: "",
									sessionId: "",
									credential: "",
									browserSession: "",
								})
							}
						>
							Clear filters
						</Button>
					) : null}
					{/* The count at the row's far end, quiet, as a logs toolbar keeps it. audit-perf.ts reads data-loaded. A
					    span, not a p: the page's flush-paragraph rule would beat ml-auto. */}
					<span
						className="hb-audit-status ml-auto text-xs text-faint tabular-nums"
						role="status"
						data-loaded={feed.events.length}
					>
						{feed.loading
							? "Reading the audit log"
							: `${count.format(feed.events.length)} ${feed.events.length === 1 ? "event" : "events"}${feed.hasMore ? " so far" : ""}`}
					</span>
				</div>
				{showMore ? (
					<div id={moreId} className={toolbarRow}>
						{offered(choices.credentials) ? (
							<Select
								label="Credential"
								value={filters.credential ?? ""}
								options={choices.credentials}
								any="Any credential"
								onChange={(value) => update({ credential: value })}
							/>
						) : null}
						{offered(choices.actors) ? (
							<Select
								label="Who"
								value={filters.actor ?? ""}
								options={choices.actors}
								any="Anyone"
								onChange={(value) => update({ actor: value })}
							/>
						) : null}
						{offered(choices.projects) ? (
							<Select
								label="Project"
								value={filters.projectId ?? ""}
								options={choices.projects}
								any="Every project"
								onChange={(value) => update({ projectId: value })}
							/>
						) : null}
						{offered(choices.agents) ? (
							<Select
								label="Agent"
								value={filters.agentId ?? ""}
								options={choices.agents}
								any="Every agent"
								onChange={(value) => update({ agentId: value })}
							/>
						) : null}
						{offered(choices.sessions) ? (
							<Select
								label="Session"
								value={filters.sessionId ?? ""}
								options={choices.sessions}
								any="Every session"
								onChange={(value) => update({ sessionId: value })}
							/>
						) : null}
					</div>
				) : null}
			</form>

			{filters.credential === undefined || filters.credential === "" ? null : (
				<CredentialUsagePanel
					source={source}
					itemId={filters.credential}
					{...(filters.organisationId === undefined ? {} : { organisationId: filters.organisationId })}
					title={`${credentialLabel ?? filters.credential}, ${rangeLabel.toLowerCase()}`}
					{...(from === undefined ? {} : { from })}
					{...(to === undefined ? {} : { to })}
					directory={directory}
					links={links}
				/>
			)}

			{feed.newer > 0 ? (
				<div className="flex justify-center">
					<Button size="sm" variant="secondary" onClick={showNewest}>
						{feed.newer >= PAGE_SIZE
							? `${PAGE_SIZE} or more newer events`
							: `${feed.newer} newer ${feed.newer === 1 ? "event" : "events"}`}
					</Button>
				</div>
			) : null}

			{feed.loading ? (
				<div className="flex flex-col gap-4 py-2.5" aria-hidden="true">
					{[0, 1, 2, 3, 4, 5].map((row) => (
						<Skeleton key={row} />
					))}
				</div>
			) : feed.error !== undefined && feed.events.length === 0 ? (
				<Notice
					level="error"
					action={
						<Button size="sm" variant="secondary" onClick={feed.retry}>
							Try again
						</Button>
					}
				>
					Couldn't read the audit log. Nothing in it has changed; try again.
				</Notice>
			) : feed.events.length === 0 ? (
				<EmptyState title={isFiltered(filters) ? "No events match these filters" : "Nothing happened in this time"}>
					{isFiltered(filters) ? "Widen the time or clear a filter." : "Pick a longer time to see older events."}
				</EmptyState>
			) : (
				<div className="flex min-w-0 flex-col overflow-hidden rounded-panel border border-border bg-panel">
					{/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move focus between the rows' own buttons. */}
					<div className={viewport} onKeyDown={onListKey}>
						<p id="hb-audit-keys" className="hb-sr-only">
							Up and down arrows move between events; Home and End go to the newest and oldest loaded.
						</p>
						<VList<Entry>
							ref={list}
							data={entries}
							onScroll={onScroll}
							className="hb-audit-list absolute inset-0 overscroll-contain"
							aria-label="Audit events"
							bufferSize={BUFFER_PX}
							keepMounted={activeIndex === -1 ? [] : [activeIndex]}
						>
							{(entry, index) =>
								"day" in entry ? (
									<h2 key={entry.key} className="relative m-0 px-3 pt-3 pb-1.5 text-xs font-medium text-muted">
										{entry.day}
									</h2>
								) : (
									<AuditRow
										key={entry.key}
										event={entry.event}
										directory={directory}
										links={links}
										open={open.has(entry.event.id)}
										active={index === activeIndex}
										onToggle={toggle}
										onFocusRow={setActiveId}
										onBrowser={filters.browserSession ? undefined : showBrowser}
									/>
								)
							}
						</VList>
					</div>
					<div className="flex min-h-control-lg items-center justify-center gap-2 border-t border-border px-3 py-1.5 text-xs text-faint">
						{feed.error !== undefined ? (
							<>
								<span className="text-status-error">Couldn't read the next page.</span>
								<Button size="sm" variant="secondary" onClick={feed.retry}>
									Try again
								</Button>
							</>
						) : feed.hasMore || feed.loadingMore ? (
							// One button through both states, so keyboard focus on it survives a page arriving.
							<Button
								size="sm"
								variant="ghost"
								onClick={feed.loadMore}
								aria-busy={feed.loadingMore || undefined}
								{...(feed.loadingMore ? { icon: <Spinner size="sm" /> } : {})}
							>
								{feed.loadingMore ? "Reading older events" : "Load older events"}
							</Button>
						) : (
							<span className="inline-flex items-center gap-1.5">Start of the log for these filters</span>
						)}
					</div>
				</div>
			)}
		</section>
	);
}

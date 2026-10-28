import type { AuditEvent } from "@harbour/contracts";
import { type KeyboardEvent, memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { VList, type VListHandle } from "virtua";
import { Button } from "../primitives/button.tsx";
import { ChevronDownIcon, ChevronRightIcon } from "../primitives/icons.tsx";
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
import "./audit-view.css";

// The audit log as a filterable, virtualised timeline, newest first. Only the rows near the viewport are mounted, so a
// log of any length costs the same to scroll; pages are read from the store as the reader nears the end of what's
// loaded. Each row reads as a sentence ("Tom Davies approved Linear API key for POST api.linear.app/graphql") and
// links to the session turn or vault request it came from. Export writes every event the filters match as JSONL.

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
	const id = useId();
	return (
		<div className="hb-audit-filter">
			<label className="hb-audit-filter-label" htmlFor={id}>
				{label}
			</label>
			<select id={id} className="hb-audit-select hb-focusable" value={value} onChange={(e) => onChange(e.target.value)}>
				{any === undefined ? null : <option value="">{any}</option>}
				{options.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</div>
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
}: {
	event: AuditEvent;
	directory: AuditDirectory;
	links: AuditLinks;
	open: boolean;
	/** The row holding the list's one Tab stop; arrow keys move it (see AuditView). */
	active: boolean;
	onToggle: (id: string) => void;
	onFocusRow: (id: string) => void;
}) {
	const line = describeEvent(event, directory, links);
	const actor = actorName(event.actor, directory);
	const detailsId = `audit-${event.seq}`;
	const project = event.projectId === undefined ? undefined : (directory.project?.(event.projectId) ?? event.projectId);
	// The session's name, unless the row already links to it by name.
	const sessionName =
		event.sessionId === undefined ? undefined : (directory.session?.(event.sessionId) ?? event.sessionId);
	const session = line.link?.label === sessionName ? undefined : sessionName;
	return (
		<div className="hb-audit-row" data-open={open || undefined}>
			<div className="hb-audit-row-main">
				<button
					type="button"
					id={`audit-toggle-${event.seq}`}
					tabIndex={active ? 0 : -1}
					aria-describedby={active ? "hb-audit-keys" : undefined}
					onFocus={() => onFocusRow(event.id)}
					className="hb-audit-row-toggle hb-focusable"
					aria-expanded={open}
					aria-controls={open ? detailsId : undefined}
					aria-label={`Details: ${actor} ${line.action}`}
					onClick={() => onToggle(event.id)}
				>
					{open ? <ChevronDownIcon /> : <ChevronRightIcon />}
				</button>
				<time
					className="hb-audit-row-time"
					dateTime={new Date(event.at).toISOString()}
					title={absolute.format(event.at)}
				>
					{timeFormat.format(event.at)}
				</time>
				<span className="hb-audit-row-badge">
					<Badge tone={line.tone}>{line.label}</Badge>
				</span>
				<p className="hb-audit-row-text">
					<span className="hb-audit-row-actor">{actor}</span> {line.action}
					{project === undefined && session === undefined ? null : (
						<span className="hb-audit-row-where">
							{project === undefined ? null : <span>{project}</span>}
							{session === undefined ? null : <span>{session}</span>}
						</span>
					)}
				</p>
				{line.link === undefined ? null : (
					<a
						className="hb-audit-row-link hb-focusable"
						href={line.link.href}
						tabIndex={active ? 0 : -1}
						onFocus={() => onFocusRow(event.id)}
					>
						{line.link.label}
					</a>
				)}
			</div>
			{open ? (
				<div id={detailsId} className="hb-audit-row-details">
					<dl className="hb-audit-detail-list">
						<dt>Type</dt>
						<dd className="hb-mono">{event.type}</dd>
						<dt>At</dt>
						<dd>{absolute.format(event.at)}</dd>
						<dt>Actor</dt>
						<dd className="hb-mono">{actorKey(event.actor)}</dd>
						{event.subject === undefined ? null : (
							<>
								<dt>Subject</dt>
								<dd className="hb-mono">
									{event.subject.kind} {event.subject.id}
								</dd>
							</>
						)}
						<dt>Event</dt>
						<dd className="hb-mono">
							{event.id} (seq {event.seq})
						</dd>
					</dl>
					{event.data === undefined ? null : (
						<pre className="hb-audit-row-data hb-selectable">{JSON.stringify(event.data, null, 2)}</pre>
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

	return (
		<section className="hb-audit" aria-labelledby="hb-audit-title">
			<header className="hb-audit-head">
				<div className="hb-audit-head-text">
					<h1 id="hb-audit-title" className="hb-audit-title">
						Audit log
					</h1>
					<p className="hb-audit-subtitle">Who did what on Harbour: people, agents and the system.</p>
				</div>
				<div className="hb-audit-export">
					{exporting.phase === "running" ? (
						<>
							<span className="hb-audit-export-progress" role="status">
								<Spinner size="sm" /> Exporting {count.format(exporting.count)} events
							</span>
							<Button size="sm" variant="ghost" onClick={cancelExport}>
								Cancel
							</Button>
						</>
					) : (
						<Button size="sm" variant="secondary" onClick={() => void runExport()} disabled={feed.loading}>
							Export JSONL
						</Button>
					)}
				</div>
			</header>
			{exporting.phase === "failed" ? (
				<Notice level="error">The export couldn't read every event, so nothing was saved. Try again.</Notice>
			) : null}

			<form className="hb-audit-filters" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
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
				{choices.credentials === undefined || choices.credentials.length === 0 ? null : (
					<Select
						label="Credential"
						value={filters.credential ?? ""}
						options={choices.credentials}
						any="Any credential"
						onChange={(value) => update({ credential: value })}
					/>
				)}
				{choices.actors === undefined || choices.actors.length === 0 ? null : (
					<Select
						label="Who"
						value={filters.actor ?? ""}
						options={choices.actors}
						any="Anyone"
						onChange={(value) => update({ actor: value })}
					/>
				)}
				{choices.projects === undefined || choices.projects.length === 0 ? null : (
					<Select
						label="Project"
						value={filters.projectId ?? ""}
						options={choices.projects}
						any="Every project"
						onChange={(value) => update({ projectId: value })}
					/>
				)}
				{choices.agents === undefined || choices.agents.length === 0 ? null : (
					<Select
						label="Agent"
						value={filters.agentId ?? ""}
						options={choices.agents}
						any="Every agent"
						onChange={(value) => update({ agentId: value })}
					/>
				)}
				{choices.sessions === undefined || choices.sessions.length === 0 ? null : (
					<Select
						label="Session"
						value={filters.sessionId ?? ""}
						options={choices.sessions}
						any="Every session"
						onChange={(value) => update({ sessionId: value })}
					/>
				)}
				{isFiltered(filters) ? (
					<div className="hb-audit-filter hb-audit-filter-clear">
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
								})
							}
						>
							Clear filters
						</Button>
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

			<p className="hb-audit-status" role="status" data-loaded={feed.events.length}>
				{feed.loading
					? "Reading the audit log"
					: `${count.format(feed.events.length)} ${feed.events.length === 1 ? "event" : "events"}${feed.hasMore ? " so far, newest first" : ", newest first"}`}
			</p>

			{feed.newer > 0 ? (
				<div className="hb-audit-newer">
					<Button size="sm" variant="secondary" onClick={showNewest}>
						{feed.newer >= PAGE_SIZE
							? `${PAGE_SIZE} or more newer events`
							: `${feed.newer} newer ${feed.newer === 1 ? "event" : "events"}`}
					</Button>
				</div>
			) : null}

			{feed.loading ? (
				<div className="hb-audit-loading" aria-hidden="true">
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
				<div className="hb-audit-timeline">
					{/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move focus between the rows' own buttons. */}
					<div className="hb-audit-viewport" onKeyDown={onListKey}>
						<p id="hb-audit-keys" className="hb-sr-only">
							Up and down arrows move between events; Home and End go to the newest and oldest loaded.
						</p>
						<VList<Entry>
							ref={list}
							data={entries}
							onScroll={onScroll}
							className="hb-audit-list"
							aria-label="Audit events"
							bufferSize={BUFFER_PX}
							keepMounted={activeIndex === -1 ? [] : [activeIndex]}
						>
							{(entry, index) =>
								"day" in entry ? (
									<h2 key={entry.key} className="hb-audit-day">
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
									/>
								)
							}
						</VList>
					</div>
					<div className="hb-audit-foot">
						{feed.error !== undefined ? (
							<>
								<span className="hb-audit-foot-error">Couldn't read the next page.</span>
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
							<span className="hb-audit-foot-text">Start of the log for these filters</span>
						)}
					</div>
				</div>
			)}
		</section>
	);
}

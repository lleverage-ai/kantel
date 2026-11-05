// The egress log (compute console): what left sandboxes through their hosts' proxies, newest first. Filter to what was
// denied or had a protected variable swapped in, to one sandbox, or by host or path. A denial opens in place to say
// why in a sentence and offer the fixes: bind the protected variable whose placeholder it carried, in its
// environment, or add a rule allowing the host. On a phone each request is two lines. The Egress page shows every
// sandbox's; a sandbox's own page can show its own with `sandboxColumn` off. Values never appear: the log names a
// protected variable, never what it holds.

import { Fragment, type ReactNode, useId, useState } from "react";
import { Button, buttonClass, buttonLabelClass } from "../primitives/button.tsx";
import { SegmentedControl, SelectField, TextField } from "../primitives/controls.tsx";
import { compactAge } from "../primitives/format.ts";

/** "now" or "3m ago": the log's one way of saying when, at every width. */
const agoText = (at: number, now: number): string => {
	const age = compactAge(at, now);
	return age === "now" ? "now" : `${age} ago`;
};

import { ChevronDownIcon, ChevronRightIcon } from "../primitives/icons.tsx";
import { BreakableCommand } from "../primitives/one-time-secret.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { bytesText } from "./compute-model.ts";
import { type DenialFix, denialFixes, type LoggedEntry, type ProtectedVariableRow } from "./egress-overview.ts";
import { cellMono, TableFrame, table, td, th } from "./parts.tsx";

export type EgressLogFilter = "all" | "denied" | "swapped";

const FILTERS: readonly { value: EgressLogFilter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "denied", label: "Denied" },
	{ value: "swapped", label: "Swapped" },
];

const ALL_SANDBOXES = "";

const matches = (entry: LoggedEntry, filter: EgressLogFilter): boolean =>
	filter === "all" || (filter === "denied" ? entry.decision === "denied" : entry.swapped.length > 0);

/** The port, unless it is the scheme's own. */
const hostText = (entry: LoggedEntry): string =>
	entry.port === 443 || entry.port === 80 ? entry.host : `${entry.host}:${entry.port}`;

/** "412 B", or a dash for none. */
const sizeText = (bytes: number): string => (bytes === 0 ? "–" : bytesText(bytes));

export interface EgressLogProps {
	readonly entries: readonly LoggedEntry[];
	/** The protected variables, to name the one a denied placeholder was for. */
	readonly variables?: readonly ProtectedVariableRow[];
	readonly now: number;
	/** A phone: each request as two lines, and only the filter over them. */
	readonly narrow?: boolean;
	/** Which sandbox each request came from, and a choice of one. Off on one sandbox's own page. */
	readonly sandboxColumn?: boolean;
	/** An environment's page, where a protected variable is bound to more hosts. */
	readonly environmentHref?: (environmentId: string) => string;
	/** Add a rule allowing a denied request's host. Absent, the log offers no such fix. */
	readonly onAllow?: (entry: LoggedEntry) => void;
	/** Said when nothing has been logged. */
	readonly emptyText?: string;
	/** Show this filter, and these denials open, first: for a story. */
	readonly initialFilter?: EgressLogFilter;
	readonly initialOpen?: readonly string[];
}

export function EgressLog({
	entries,
	variables = [],
	now,
	narrow = false,
	sandboxColumn = true,
	environmentHref,
	onAllow,
	emptyText = "Nothing has left a sandbox yet.",
	initialFilter = "all",
	initialOpen = [],
}: EgressLogProps) {
	const [filter, setFilter] = useState<EgressLogFilter>(initialFilter);
	const [sandbox, setSandbox] = useState(ALL_SANDBOXES);
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(initialOpen));
	const toggle = (id: string) =>
		setOpen((current) => {
			const next = new Set(current);
			if (!next.delete(id)) next.add(id);
			return next;
		});

	const sandboxes = [...new Map(entries.map((entry) => [entry.sandboxId, entry.sandboxName])).entries()].sort((a, b) =>
		a[1].localeCompare(b[1]),
	);
	const inSandbox = entries.filter((entry) => sandbox === ALL_SANDBOXES || entry.sandboxId === sandbox);
	const needle = query.trim().toLowerCase();
	const searched = inSandbox.filter(
		(entry) => needle === "" || `${hostText(entry)}${entry.path ?? ""}`.toLowerCase().includes(needle),
	);
	const shown = searched.filter((entry) => matches(entry, filter));
	const counts = {
		all: undefined,
		denied: searched.filter((entry) => matches(entry, "denied")).length,
		swapped: searched.filter((entry) => matches(entry, "swapped")).length,
	};
	const choosing = sandboxColumn && sandboxes.length > 1;

	const filters = (
		<div className="flex min-w-0 flex-wrap items-center gap-2">
			<div className={narrow ? "basis-full" : "contents"}>
				<SegmentedControl
					label="Show"
					options={FILTERS.map((option) => ({
						...option,
						...(counts[option.value] === undefined ? {} : { count: counts[option.value] }),
						// Denials are the log's problems: their count in the error colour, as the sandboxes' Error count is.
						alert: option.value === "denied" && (counts.denied ?? 0) > 0,
					}))}
					value={filter}
					onChange={setFilter}
				/>
			</div>
			{/* On a phone the sandbox and the search share the line under the filter, so the log starts sooner. */}
			{choosing ? (
				<SelectField
					label="Sandbox"
					hideLabel
					{...(narrow ? { className: "min-w-0 flex-1" } : { width: "short" as const })}
					value={sandbox}
					onChange={(event) => setSandbox(event.currentTarget.value)}
					options={[
						{ value: ALL_SANDBOXES, label: "All sandboxes" },
						...sandboxes.map(([id, name]) => ({ value: id, label: name })),
					]}
				/>
			) : null}
			{
				<TextField
					className={narrow ? "min-w-0 flex-1" : "ml-auto"}
					label="Search the log"
					hideLabel
					{...(narrow ? {} : { width: "short" as const })}
					type="search"
					placeholder="Host or path"
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
					spellCheck={false}
				/>
			}
		</div>
	);

	const fixes = (entry: LoggedEntry) => (
		<Fixes
			entry={entry}
			fixes={denialFixes(entry, variables).filter((fix) => fix.kind !== "allow" || onAllow !== undefined)}
			{...(environmentHref === undefined ? {} : { environmentHref })}
			{...(onAllow === undefined ? {} : { onAllow })}
		/>
	);

	const body =
		shown.length === 0 ? (
			<p className="m-0 py-2 text-sm text-muted">{entries.length === 0 ? emptyText : "Nothing matches."}</p>
		) : narrow ? (
			<ul className="m-0 flex list-none flex-col rounded-panel border border-border bg-raised p-0">
				{shown.map((entry) => (
					<PhoneEntry
						key={entry.id}
						entry={entry}
						now={now}
						sandboxColumn={sandboxColumn}
						open={open.has(entry.id)}
						onToggle={() => toggle(entry.id)}
						fixes={fixes(entry)}
					/>
				))}
			</ul>
		) : (
			// Nothing in a row but a denial takes focus, so the frame does: it scrolls sideways on a narrow window.
			<TableFrame className="kt-focusable" role="region" tabIndex={0} aria-label="Egress log">
				<table className={table}>
					<thead>
						<tr>
							<th className={th} scope="col">
								When
							</th>
							{sandboxColumn ? (
								<th className={th} scope="col">
									Sandbox
								</th>
							) : null}
							<th className={th} scope="col">
								Request
							</th>
							<th className={th} scope="col">
								Decision
							</th>
							<th className={`${th} text-right`} scope="col">
								Status
							</th>
							<th className={th} scope="col">
								Swapped
							</th>
							<th className={`${th} text-right`} scope="col">
								Sent, received
							</th>
						</tr>
					</thead>
					<tbody>
						{shown.map((entry) => (
							<WideEntry
								key={entry.id}
								entry={entry}
								now={now}
								sandboxColumn={sandboxColumn}
								open={open.has(entry.id)}
								onToggle={() => toggle(entry.id)}
								fixes={fixes(entry)}
							/>
						))}
					</tbody>
				</table>
			</TableFrame>
		);

	return (
		<div className="flex min-w-0 flex-col gap-3">
			{filters}
			{body}
		</div>
	);
}

/** Whether a request opens: a denial with something to say. */
const opens = (entry: LoggedEntry): boolean =>
	entry.decision === "denied" && (entry.reason !== undefined || entry.rule !== undefined);

/** `GET api.github.com/user`: the method muted, the host in full strength, the path muted. */
function RequestText({ entry, wrap = false }: { entry: LoggedEntry; wrap?: boolean }) {
	if (!wrap) {
		// The wide log: the method and host on the first line, the path under the host on a second, so a long path is
		// read rather than cut at the column's edge.
		return (
			<>
				<span className="block truncate">
					<span className="inline-block w-18 text-muted">{entry.method}</span>
					<span className="font-medium text-fg">{hostText(entry)}</span>
				</span>
				{entry.path === undefined || entry.path === "" ? null : (
					// The whole path, broken after its slashes where it's longer than the column, never cut off.
					<span className="block pl-18 whitespace-normal wrap-break-word text-muted">
						<BreakableCommand command={entry.path} />
					</span>
				)}
			</>
		);
	}
	return (
		<>
			{/* Wrapped, the method and host stay together on one line and the path breaks only after a slash. */}
			<span className="whitespace-nowrap">
				<span className="text-muted">{entry.method} </span>
				<span className="font-medium text-fg">{hostText(entry)}</span>
			</span>
			<span className="text-muted">{entry.path === undefined ? null : <BreakableCommand command={entry.path} />}</span>
		</>
	);
}

/** The request, as a button that opens the denial's reason when there is one. `wrap`: all of it, over lines (a phone). */
function RequestCell({
	entry,
	open,
	detailId,
	onToggle,
	wrap = false,
	chevron = true,
}: {
	entry: LoggedEntry;
	open: boolean;
	detailId: string;
	onToggle: () => void;
	wrap?: boolean;
	/** The wide log draws its chevrons at the row's end instead, in a column of their own. */
	chevron?: boolean;
}) {
	const text = `${entry.method} ${hostText(entry)}${entry.path ?? ""}`;
	if (!opens(entry)) {
		return (
			<span className={`${cellMono} block ${wrap ? "wrap-break-word" : "min-w-0"}`} title={text}>
				<RequestText entry={entry} wrap={wrap} />
			</span>
		);
	}
	const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
	return (
		<button
			type="button"
			className={`kt-focusable -ml-1 flex w-full max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-1 py-0.5 text-left hover:bg-hover`}
			aria-expanded={open}
			aria-controls={detailId}
			title={text}
			onClick={onToggle}
		>
			<span className={`${cellMono} block min-w-0 ${wrap ? "wrap-break-word" : ""}`}>
				<RequestText entry={entry} wrap={wrap} />
			</span>
			{/* On a phone's card the chevron keeps to the card's right edge, wherever the request ends. */}
			{chevron ? (
				<Chevron size="sm" className={`ml-auto flex-none text-faint${wrap ? " mt-0.5 self-start" : ""}`} />
			) : null}
		</button>
	);
}

const statusCode = "text-sm text-muted tabular-nums";

function Decision({
	entry,
	code = true,
	open,
}: {
	entry: LoggedEntry;
	code?: boolean;
	/** The wide log's chevron for a row that opens, beside the decision it explains rather than past the last column. */
	open?: boolean;
}) {
	return (
		<span className="flex items-baseline gap-2">
			{/* The sandbox list's status pattern: a dot and the word, the word quiet for Allowed and red for Denied. */}
			{entry.decision === "allowed" ? (
				<StatusLabel status="done" quiet>
					Allowed
				</StatusLabel>
			) : (
				<StatusLabel status="error">Denied</StatusLabel>
			)}
			{/* A phone's meta line has the server's status beside the decision; the wide log gives it a column. */}
			{!code || entry.status === undefined ? null : <span className={statusCode}>{entry.status}</span>}
			{open === undefined ? null : (
				<span className="self-center text-faint" aria-hidden="true">
					{open ? <ChevronDownIcon size="sm" /> : <ChevronRightIcon size="sm" />}
				</span>
			)}
		</span>
	);
}

function WideEntry({
	entry,
	now,
	sandboxColumn,
	open,
	onToggle,
	fixes,
}: {
	entry: LoggedEntry;
	now: number;
	sandboxColumn: boolean;
	open: boolean;
	onToggle: () => void;
	fixes: ReactNode;
}) {
	const detailId = useId();
	const expanded = open && opens(entry);
	return (
		<Fragment>
			{/* A row that opens is one target: a click anywhere on it opens it, as its request button does from the
			    keyboard, and its chevron sits beside the decision it explains. */}
			<tr
				data-egress={entry.id}
				data-decision={entry.decision}
				// Every cell on the first line of text of the request, by baseline, so a row with a path under its host reads straight across.
				className={`[&>td]:align-baseline ${expanded ? "bg-hover" : ""} ${opens(entry) ? "cursor-pointer hover:bg-hover" : ""}`}
				onClick={
					opens(entry)
						? (event) => {
								if (!(event.target as HTMLElement).closest("button, a")) onToggle();
							}
						: undefined
				}
			>
				<td className={td}>
					<span className="text-muted tabular-nums" title={new Date(entry.at).toLocaleString("en-GB")}>
						{agoText(entry.at, now)}
					</span>
				</td>
				{sandboxColumn ? (
					<td className={td}>
						<span className="block max-w-(--kt-menu-width) truncate text-fg">{entry.sandboxName}</span>
					</td>
				) : null}
				<td className={`${td} w-full max-w-0`}>
					<RequestCell entry={entry} open={expanded} detailId={detailId} onToggle={onToggle} chevron={false} />
				</td>
				<td className={td}>
					<Decision entry={entry} code={false} {...(opens(entry) ? { open: expanded } : {})} />
				</td>
				{/* The server's answer, apart from Kantel's decision: a dash where the request never reached it. */}
				<td className={`${td} text-right`}>
					{entry.status === undefined ? (
						<span className="text-faint">–</span>
					) : (
						<span className={statusCode}>{entry.status}</span>
					)}
				</td>
				<td className={td}>
					<Swapped names={entry.swapped} />
				</td>
				<td className={`${td} text-right text-muted tabular-nums`}>
					{sizeText(entry.bytesUp)} / {sizeText(entry.bytesDown)}
				</td>
			</tr>
			{expanded ? (
				<tr id={detailId} data-egress-detail={entry.id}>
					{/* Under the request: the when (and sandbox) columns stay empty, so the reason reads as the row's. */}
					<td className={td} colSpan={sandboxColumn ? 2 : 1} />
					<td className={`${td} whitespace-normal`} colSpan={5}>
						<Detail entry={entry} fixes={fixes} />
					</td>
				</tr>
			) : null}
		</Fragment>
	);
}

function PhoneEntry({
	entry,
	now,
	sandboxColumn,
	open,
	onToggle,
	fixes,
}: {
	entry: LoggedEntry;
	now: number;
	sandboxColumn: boolean;
	open: boolean;
	onToggle: () => void;
	fixes: ReactNode;
}) {
	const detailId = useId();
	const expanded = open && opens(entry);
	return (
		<li
			className="flex min-w-0 flex-col gap-1 border-b border-border px-3 py-3 last:border-b-0"
			data-egress={entry.id}
			data-decision={entry.decision}
		>
			{/* Three tiers: the request whole; the outcome on the left and when on the right; then, quieter, which
			    sandbox, what was swapped in and how much moved. */}
			{/* The first line: the request, and on the right when it was with the chevron's slot, kept on every card
			    (empty where nothing opens) so every card's right edge lines up. */}
			<div className="flex min-w-0 items-start gap-3">
				<span className="min-w-0 flex-1">
					<RequestCell entry={entry} open={expanded} detailId={detailId} onToggle={onToggle} wrap chevron={false} />
				</span>
				<span className="flex flex-none items-center gap-1 pt-0.5 text-sm text-muted">
					<span className="tabular-nums" title={new Date(entry.at).toLocaleString("en-GB")}>
						{agoText(entry.at, now)}
					</span>
					<span className="flex w-4 justify-end text-faint" aria-hidden="true">
						{opens(entry) ? expanded ? <ChevronDownIcon size="sm" /> : <ChevronRightIcon size="sm" /> : null}
					</span>
				</span>
			</div>
			<div className="flex min-w-0 items-baseline gap-3 text-sm text-muted">
				<Decision entry={entry} />
			</div>
			<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-sm text-muted empty:hidden">
				{sandboxColumn ? <span className="text-fg">{entry.sandboxName}</span> : null}
				{entry.swapped.length === 0 ? null : (
					<span>
						Swapped <span className="font-mono text-fg">{entry.swapped.join(", ")}</span>
					</span>
				)}
				{/* What moved, in words; nothing at all is left unsaid rather than shown as dashes. */}
				{entry.bytesUp === 0 && entry.bytesDown === 0 ? null : (
					<span className="tabular-nums">
						{[
							entry.bytesUp === 0 ? undefined : `${bytesText(entry.bytesUp)} sent`,
							entry.bytesDown === 0 ? undefined : `${bytesText(entry.bytesDown)} received`,
						]
							.filter((part) => part !== undefined)
							.join(", ")}
					</span>
				)}
			</div>
			{expanded ? (
				<div id={detailId} className="pt-1">
					<Detail entry={entry} fixes={fixes} />
				</div>
			) : null}
		</li>
	);
}

function Swapped({ names }: { names: readonly string[] }) {
	if (names.length === 0) return <span className="text-faint">–</span>;
	return <span className={`${cellMono} text-fg`}>{names.join(", ")}</span>;
}

/** Why a denial was denied, the rule that did it, and its fixes. */
function Detail({ entry, fixes }: { entry: LoggedEntry; fixes: ReactNode }) {
	return (
		<div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
			<div className="flex min-w-0 flex-col gap-0.5">
				{entry.reason === undefined ? null : <p className="m-0 text-sm text-fg">{entry.reason}</p>}
				{entry.rule === undefined ? null : <p className={`${cellMono} m-0`}>{entry.rule}</p>}
			</div>
			{fixes}
		</div>
	);
}

function Fixes({
	entry,
	fixes,
	environmentHref,
	onAllow,
}: {
	entry: LoggedEntry;
	fixes: readonly DenialFix[];
	environmentHref?: (environmentId: string) => string;
	onAllow?: (entry: LoggedEntry) => void;
}) {
	const shown = fixes.filter((fix) => fix.kind !== "bind" || environmentHref !== undefined);
	if (shown.length === 0) return null;
	return (
		<div className="flex flex-wrap items-center gap-2">
			{shown.map((fix) =>
				fix.kind === "bind" && environmentHref !== undefined ? (
					<a key="bind" className={buttonClass("secondary", "sm")} href={environmentHref(fix.environment.id)}>
						<span className={buttonLabelClass}>
							{fix.variable === undefined
								? `Bind it in ${fix.environment.name}`
								: `Bind ${fix.variable} to ${entry.host}`}
						</span>
					</a>
				) : fix.kind === "allow" && onAllow !== undefined ? (
					<Button key="allow" size="sm" variant="ghost" onClick={() => onAllow(entry)}>
						Allow {entry.host}
					</Button>
				) : null,
			)}
		</div>
	);
}

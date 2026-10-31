import type { Concept, MemoryProposal, MemorySearchHit, MemorySpace } from "@kantel/contracts";
import { useCallback, useState } from "react";
import type { AuditDirectory } from "../audit/audit-model.ts";
import { Button } from "../primitives/button.tsx";
import { SegmentedControl, SelectField, TextField } from "../primitives/controls.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { ListRow } from "../primitives/list-row.tsx";
import { useLoad } from "../primitives/load.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { ConceptDetail } from "./concept-detail.tsx";
import { groupConcepts, isStale, type MemoryPageSource, readAll, SET_BY } from "./memory-model.ts";
import { MemoryProposals } from "./memory-proposals.tsx";
import { MemoryRecall } from "./memory-recall.tsx";
import { memoryBadges, memoryFaint, memoryLoading, memoryRows } from "./memory-styles.ts";
// Only the phone layout is left in CSS; see the file.
import "./memory-page.css";

/** Groups of rows by scope, or the search's count over its matches. */
const groups = "flex min-w-0 flex-col gap-5";

export type MemoryView = "concepts" | "recall" | "proposals";

export interface MemoryPageProps {
	/** `Memory`, bound to the viewer (see `bindMemory`). */
	readonly source: MemoryPageSource;
	/** The spaces the viewer may read, the current one first, as `Memory.listSpaces` gives them. */
	readonly spaces: readonly MemorySpace[];
	/** Concept IDs recalled whatever the query, as the host's sessions get them; the recall view uses them. */
	readonly profile?: readonly string[];
	readonly directory?: AuditDirectory;
	/** The time the page measures from, for stories. Default `Date.now()` when it renders. */
	readonly now?: number;
	readonly initialView?: MemoryView;
	readonly initialSelected?: string;
	readonly initialStatus?: Concept["status"];
	/** A search to show when the page opens. */
	readonly initialSearch?: string;
	/** A recall to run when the recall view opens, with the project and job scopes it names. */
	readonly initialRecall?: { readonly query: string; readonly projects?: string; readonly jobs?: string };
	readonly onSelect?: (conceptId: string | undefined) => void;
}

const STATUSES: readonly { value: Concept["status"]; label: string }[] = [
	{ value: "active", label: "Active" },
	{ value: "superseded", label: "Superseded" },
	{ value: "forgotten", label: "Forgotten" },
];

/**
 * A memory space: its concepts by scope with search, what a session would recall for a message, and the proposals
 * waiting for a person. Opening a concept shows its statement, sources, freshness and history beside the list; on a
 * phone it replaces the list, with a way back. Approving or rejecting a proposal goes through `Memory.decide` and the
 * page reads again.
 */
export function MemoryPage({
	source,
	spaces,
	profile,
	directory = {},
	now: fixedNow,
	initialView = "concepts",
	initialSelected,
	initialStatus = "active",
	initialSearch = "",
	initialRecall,
	onSelect,
}: MemoryPageProps) {
	const [spaceId, setSpaceId] = useState(spaces[0]?.id ?? "");
	const [view, setView] = useState<MemoryView>(initialView);
	const [status, setStatus] = useState<Concept["status"]>(initialStatus);
	const [search, setSearch] = useState(initialSearch);
	const [selected, setSelected] = useState<string | undefined>(initialSelected);
	const now = fixedNow ?? Date.now();
	const space = spaces.find((item) => item.id === spaceId);

	const concepts = useLoad(
		() => readAll<Concept>((page) => source.listConcepts(spaceId, { status }, page)),
		[source, spaceId, status],
	);
	const term = search.trim();
	const hits = useLoad<readonly MemorySearchHit[] | undefined>(
		async () =>
			term === ""
				? undefined
				: source.search({ spaceIds: [spaceId], query: term, limit: 10, includeInactive: status !== "active" }),
		[source, spaceId, term, status],
	);
	// A read-only source serves no proposals: no Proposals view, and nothing to decide.
	const { listProposals, decide: decideOn } = source;
	const writable = listProposals !== undefined && decideOn !== undefined;
	const proposals = useLoad(
		async () =>
			listProposals === undefined ? [] : readAll<MemoryProposal>((page) => listProposals(spaceId, undefined, page)),
		[listProposals, spaceId],
	);
	const shown: MemoryView = view === "proposals" && !writable ? "concepts" : view;
	const pendingCount =
		proposals.state.status === "ready"
			? proposals.state.value.filter((proposal) => proposal.status === "pending").length
			: undefined;

	const open = useCallback(
		(id: string | undefined) => {
			setSelected(id);
			onSelect?.(id);
		},
		[onSelect],
	);
	const openConcept = useCallback(
		(id: string) => {
			setView("concepts");
			open(id);
		},
		[open],
	);
	const decide = useCallback(
		async (proposalId: string, outcome: "apply" | "reject") => {
			if (decideOn === undefined) return;
			await decideOn(proposalId, { outcome });
			proposals.reload();
			concepts.reload();
		},
		[decideOn, proposals.reload, concepts.reload],
	);

	// No concept open: the list alone at a reading width, as Linear's list before an issue opens and Claude.ai's
	// Settings > Memory. A concept open: the list beside it (the two columns are memory-page.css's).
	const listOnly = shown !== "concepts" || selected === undefined;

	return (
		<div
			className={`kt-memory flex w-full min-w-0 flex-col gap-6 text-sm leading-normal text-fg ${listOnly ? "max-w-content" : ""}`}
			data-view={listOnly ? "list" : "detail"}
		>
			<PageHeader
				className="kt-memory-head"
				title="Memory"
				{...(spaces.length < 2
					? {}
					: {
							actions: (
								<SelectField
									label="Space"
									className="w-[calc(var(--kt-sidebar-width)*0.75)] max-w-full"
									options={spaces.map((item) => ({ value: item.id, label: item.name }))}
									value={spaceId}
									onChange={(event) => {
										setSpaceId(event.target.value);
										open(undefined);
									}}
								/>
							),
						})}
			/>
			{/* The view switch is its own row, with where the space was loaded from faint at its end; the concept filters
			    are a second row over the list, so neither crowds at a list's width or on a phone (Linear's view tabs over
			    its filter bar). */}
			<div className="kt-memory-views flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 [&>.kt-segmented]:max-w-full">
				<SegmentedControl
					label="View"
					value={shown}
					onChange={setView}
					options={[
						{ value: "concepts", label: "Concepts" },
						{ value: "recall", label: "Recall" },
						...(writable
							? [
									{
										value: "proposals" as const,
										label: "Proposals",
										...(pendingCount === undefined || pendingCount === 0 ? {} : { count: pendingCount }),
									},
								]
							: []),
					]}
				/>
				{space?.snapshot === undefined ? null : (
					<p className="m-0 min-w-0 text-xs text-faint wrap-anywhere">
						Loaded from {space.snapshot.sourceId} at {space.snapshot.ref.slice(0, 7)}
					</p>
				)}
			</div>

			{shown === "recall" ? (
				<MemoryRecall
					source={source}
					spaceIds={[spaceId]}
					{...(profile === undefined ? {} : { profile })}
					{...(initialRecall === undefined
						? {}
						: {
								initialQuery: initialRecall.query,
								initialProjects: initialRecall.projects ?? "",
								initialJobs: initialRecall.jobs ?? "",
							})}
					onOpen={openConcept}
				/>
			) : shown === "proposals" ? (
				proposals.state.status === "loading" ? (
					<div className={memoryLoading}>
						<span className="kt-sr-only">Loading proposals</span>
						<Skeleton lines={3} />
						<Skeleton lines={3} />
					</div>
				) : proposals.state.status === "error" ? (
					<Notice
						level="error"
						action={
							<Button size="xs" onClick={proposals.reload}>
								Try again
							</Button>
						}
					>
						Couldn't read the proposals. Nothing was decided; try again.
					</Notice>
				) : (
					<MemoryProposals
						proposals={proposals.state.value}
						directory={directory}
						now={now}
						onDecide={decide}
						onOpen={openConcept}
					/>
				)
			) : (
				<div className="kt-memory-body grid min-w-0 items-start gap-6">
					<section className="kt-memory-list flex min-w-0 flex-col gap-4" aria-label="Concepts">
						{/* One toolbar row, search first, then the status as a compact select: it wraps when narrow. */}
						<div className="flex min-w-0 flex-wrap items-center gap-2">
							<TextField
								label="Search memory"
								hideLabel
								className="min-w-0 flex-[1_1_calc(var(--kt-sidebar-width)*0.5)]"
								type="search"
								placeholder="Search memory"
								value={search}
								onChange={(event) => setSearch(event.target.value)}
							/>
							<SelectField
								label="Status"
								hideLabel
								className="max-w-full flex-none"
								options={STATUSES}
								value={status}
								onChange={(event) => setStatus(event.target.value as Concept["status"])}
							/>
						</div>
						{term !== "" ? (
							<SearchResults hits={hits.state} selected={selected} onOpen={open} retry={hits.reload} term={term} />
						) : concepts.state.status === "loading" ? (
							<div className={memoryLoading}>
								<span className="kt-sr-only">Loading concepts</span>
								<Skeleton lines={2} />
								<Skeleton lines={2} />
								<Skeleton lines={2} />
							</div>
						) : concepts.state.status === "error" ? (
							<Notice
								level="error"
								action={
									<Button size="xs" onClick={concepts.reload}>
										Try again
									</Button>
								}
							>
								Couldn't read the concepts. Nothing has changed; try again.
							</Notice>
						) : concepts.state.value.length === 0 ? (
							<EmptyState title={status === "active" ? "Nothing remembered yet" : `No ${status} concepts`}>
								{status === "active"
									? "When a person approves a proposal, or a host loads a snapshot, its concepts show here."
									: "Concepts move here when they are replaced or forgotten."}
							</EmptyState>
						) : (
							<div className={groups}>
								{groupConcepts(concepts.state.value, directory.project).map((group) => (
									<section
										key={group.key}
										className="flex min-w-0 flex-col gap-1.5"
										aria-labelledby={`kt-memory-${group.key}`}
									>
										{/* Inset as the rows' text is. */}
										<h2 id={`kt-memory-${group.key}`} className="m-0 px-2.5 text-xs font-medium text-muted">
											{group.label}
										</h2>
										<ul className={memoryRows}>
											{group.concepts.map((concept) => (
												<li key={concept.id}>
													<ConceptRow
														concept={concept}
														stale={isStale(concept, now)}
														selected={concept.id === selected}
														onOpen={open}
													/>
												</li>
											))}
										</ul>
									</section>
								))}
							</div>
						)}
					</section>
					{selected === undefined ? null : (
						<section className="kt-memory-detail min-w-0" aria-label="Concept">
							<ConceptDetail
								key={`${spaceId}:${selected}`}
								source={source}
								spaceId={spaceId}
								conceptId={selected}
								directory={directory}
								now={now}
								onOpen={open}
								onBack={() => open(undefined)}
								onChanged={() => {
									concepts.reload();
									proposals.reload();
									hits.reload();
								}}
							/>
						</section>
					)}
				</div>
			)}
		</div>
	);
}

function ConceptRow({
	concept,
	stale,
	selected,
	onOpen,
	meta,
	extra,
}: {
	concept: Concept;
	stale: boolean;
	selected: boolean;
	onOpen: (id: string) => void;
	meta?: string;
	extra?: string;
}) {
	return (
		<ListRow
			density="comfortable"
			overline={<span className="kt-mono">{concept.id}</span>}
			title={concept.title}
			meta={meta ?? concept.description ?? concept.statement}
			trailing={
				<span className={memoryBadges}>
					{extra === undefined ? null : <span className="text-xs whitespace-nowrap text-faint">{extra}</span>}
					{stale ? <Badge tone="waiting">Stale</Badge> : null}
					{concept.setBy === "owner" ? <Badge tone={SET_BY.owner.tone}>Owner</Badge> : null}
				</span>
			}
			selected={selected}
			quiet={concept.status !== "active"}
			onSelect={() => onOpen(concept.id)}
		/>
	);
}

function SearchResults({
	hits,
	selected,
	onOpen,
	retry,
	term,
}: {
	hits: ReturnType<typeof useLoad<readonly MemorySearchHit[] | undefined>>["state"];
	selected: string | undefined;
	onOpen: (id: string) => void;
	retry: () => void;
	term: string;
}) {
	if (hits.status === "loading") {
		return (
			<div className={memoryLoading}>
				<span className="kt-sr-only">Searching</span>
				<Skeleton lines={2} />
				<Skeleton lines={2} />
			</div>
		);
	}
	if (hits.status === "error") {
		return (
			<Notice
				level="error"
				action={
					<Button size="xs" onClick={retry}>
						Try again
					</Button>
				}
			>
				Couldn't search this space. Try again.
			</Notice>
		);
	}
	const found = hits.value ?? [];
	if (found.length === 0) {
		return <EmptyState title={`Nothing matches "${term}"`}>Try other words, or fewer.</EmptyState>;
	}
	return (
		<div className={groups}>
			<p className={`m-0 ${memoryFaint}`} role="status">
				{found.length === 1 ? "1 match" : `${found.length} matches`}, best first
			</p>
			<ul className={memoryRows}>
				{found.map((hit) => (
					<li key={`${hit.concept.spaceId}:${hit.concept.id}`}>
						<ConceptRow
							concept={hit.concept}
							stale={hit.stale}
							selected={hit.concept.id === selected}
							onOpen={onOpen}
							meta={hit.snippet}
							extra={`Score ${hit.score.toFixed(1)}`}
						/>
					</li>
				))}
			</ul>
		</div>
	);
}

import type { Concept, MemoryProposal, MemorySearchHit, MemorySpace } from "@harbour/contracts";
import { useCallback, useState } from "react";
import type { AuditDirectory } from "../audit/audit-model.ts";
import { Button } from "../primitives/button.tsx";
import { SegmentedControl, SelectField, TextField } from "../primitives/controls.tsx";
import { ListRow } from "../primitives/list-row.tsx";
import { useLoad } from "../primitives/load.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { ConceptDetail } from "./concept-detail.tsx";
import { groupConcepts, isStale, type MemoryPageSource, readAll, SET_BY } from "./memory-model.ts";
import { MemoryProposals } from "./memory-proposals.tsx";
import { MemoryRecall } from "./memory-recall.tsx";
import "./memory-page.css";

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

	return (
		<div className="hb-memory" data-view={shown === "concepts" && selected !== undefined ? "detail" : "list"}>
			<header className="hb-memory-head">
				<div className="hb-memory-heading">
					<h1 className="hb-memory-title">Memory</h1>
					<p className="hb-memory-lede">
						What sessions recall: short facts with their sources, kept true by proposals a person approves.
						{space?.snapshot === undefined
							? ""
							: ` Loaded from ${space.snapshot.sourceId} at ${space.snapshot.ref.slice(0, 7)}.`}
					</p>
				</div>
				{spaces.length < 2 ? null : (
					<SelectField
						label="Space"
						options={spaces.map((item) => ({ value: item.id, label: item.name }))}
						value={spaceId}
						onChange={(event) => {
							setSpaceId(event.target.value);
							open(undefined);
						}}
					/>
				)}
			</header>
			<div className="hb-memory-views">
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
					<div className="hb-memory-loading">
						<span className="hb-sr-only">Loading proposals</span>
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
				<div className="hb-memory-body">
					<section className="hb-memory-list" aria-label="Concepts">
						<div className="hb-memory-controls">
							<SegmentedControl label="Status" value={status} onChange={setStatus} options={STATUSES} />
							<TextField
								label="Search"
								type="search"
								placeholder="Words in a title, tag or statement"
								value={search}
								onChange={(event) => setSearch(event.target.value)}
							/>
						</div>
						{term !== "" ? (
							<SearchResults hits={hits.state} selected={selected} onOpen={open} retry={hits.reload} term={term} />
						) : concepts.state.status === "loading" ? (
							<div className="hb-memory-loading">
								<span className="hb-sr-only">Loading concepts</span>
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
							<div className="hb-memory-groups">
								{groupConcepts(concepts.state.value, directory.project).map((group) => (
									<section key={group.key} className="hb-memory-group" aria-labelledby={`hb-memory-${group.key}`}>
										<h2 id={`hb-memory-${group.key}`} className="hb-memory-group-title">
											{group.label}
										</h2>
										<ul className="hb-memory-rows">
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
					<section className="hb-memory-detail" aria-label="Concept">
						{selected === undefined ? (
							<div className="hb-memory-placeholder">
								<EmptyState title="Pick a concept">See its statement, its sources and how it changed.</EmptyState>
							</div>
						) : (
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
						)}
					</section>
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
			overline={<span className="hb-mono">{concept.id}</span>}
			title={concept.title}
			meta={meta ?? concept.description ?? concept.statement}
			trailing={
				<span className="hb-memory-badges">
					{extra === undefined ? null : <span className="hb-memory-score">{extra}</span>}
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
			<div className="hb-memory-loading">
				<span className="hb-sr-only">Searching</span>
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
		<div className="hb-memory-groups">
			<p className="hb-memory-count" role="status">
				{found.length === 1 ? "1 match" : `${found.length} matches`}, best first
			</p>
			<ul className="hb-memory-rows">
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

import type { Concept, MemoryProposal } from "@harbour/contracts";
import { useEffect, useRef, useState } from "react";
import { type AuditDirectory, actorName } from "../audit/audit-model.ts";
import { Button } from "../primitives/button.tsx";
import { useLoad } from "../primitives/load.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { Field, FieldList, Notice, Panel } from "../primitives/surface.tsx";
import { ClockTime } from "../primitives/time.tsx";
import { ConceptChange } from "./concept-change.tsx";
import {
	CONCEPT_STATUS,
	conceptHistory,
	isStale,
	type MemoryPageSource,
	PROPOSAL_STATUS,
	readAll,
	SET_BY,
	scopeText,
	sourceHref,
	WRITE_LABELS,
	writeSentence,
} from "./memory-model.ts";

export interface ConceptDetailProps {
	readonly source: MemoryPageSource;
	readonly spaceId: string;
	readonly conceptId: string;
	readonly directory?: AuditDirectory;
	readonly now: number;
	/** Opens another concept: the one that superseded this one, or the rule an exception overrides. */
	readonly onOpen?: (conceptId: string) => void;
	/** Shows a Back button, for the phone layout where the concept replaces the list. */
	readonly onBack?: () => void;
	/** Called after the viewer corrected or forgot it, or left a proposal pending, so the host reads its lists again. */
	readonly onChanged?: () => void;
}

/**
 * One concept: its statement, where it applies, who set it, its sources and its freshness, and its history as the
 * proposals that changed it. With a source that can propose, an active concept can be corrected or forgotten by the
 * viewer (see `ConceptChange`).
 */
export function ConceptDetail({
	source,
	spaceId,
	conceptId,
	directory = {},
	now,
	onOpen,
	onBack,
	onChanged,
}: ConceptDetailProps) {
	const [changing, setChanging] = useState<"correct" | "forget">();
	const { state, reload } = useLoad(async () => {
		const [concept, proposals] = await Promise.all([
			source.getConcept(spaceId, conceptId),
			readAll<MemoryProposal>((page) => source.listProposals(spaceId, undefined, page)),
		]);
		return { concept, history: conceptHistory(proposals, conceptId) };
	}, [source, spaceId, conceptId]);
	const heading = useRef<HTMLHeadingElement>(null);
	const ready = state.status === "ready";
	useEffect(() => {
		if (ready) heading.current?.focus({ preventScroll: true });
	}, [ready]);

	const back =
		onBack === undefined ? null : (
			<div className="hb-memory-back">
				<Button size="sm" variant="ghost" onClick={onBack}>
					All concepts
				</Button>
			</div>
		);

	if (state.status !== "ready") {
		return (
			<div className="hb-concept">
				{back}
				{state.status === "loading" ? (
					<div className="hb-memory-loading" aria-busy="true">
						<span className="hb-sr-only">Loading the concept</span>
						<Skeleton width="45%" />
						<Skeleton lines={3} />
						<Skeleton lines={3} />
					</div>
				) : (
					<Notice
						level="error"
						action={
							<Button size="xs" onClick={reload}>
								Try again
							</Button>
						}
					>
						Couldn't read this concept. It may have been removed, or Harbour is unavailable.
					</Notice>
				)}
			</div>
		);
	}

	const { concept, history } = state.value;
	const stale = isStale(concept, now);
	return (
		<article className="hb-concept" aria-labelledby="hb-concept-title">
			{back}
			<header className="hb-concept-head">
				<div className="hb-concept-title-row">
					<h2 id="hb-concept-title" className="hb-concept-title" ref={heading} tabIndex={-1}>
						{concept.title}
					</h2>
					{source.propose === undefined || concept.status !== "active" || changing !== undefined ? null : (
						<span className="hb-concept-actions">
							<Button size="sm" onClick={() => setChanging("correct")}>
								Correct
							</Button>
							<Button size="sm" variant="ghost" onClick={() => setChanging("forget")}>
								Forget
							</Button>
						</span>
					)}
				</div>
				<p className="hb-concept-id hb-mono">{concept.id}</p>
				<div className="hb-concept-tags">
					<Badge>{scopeText(concept.scope, directory.project)}</Badge>
					<Badge tone={SET_BY[concept.setBy].tone}>{SET_BY[concept.setBy].label}</Badge>
					{concept.status === "active" ? null : (
						<Badge tone={CONCEPT_STATUS[concept.status].tone}>{CONCEPT_STATUS[concept.status].label}</Badge>
					)}
					{stale ? <Badge tone="waiting">Stale</Badge> : null}
				</div>
			</header>

			{concept.status === "superseded" && concept.supersededBy !== undefined ? (
				<Notice
					level="info"
					announce={false}
					action={
						onOpen === undefined ? undefined : (
							<Button size="xs" onClick={() => onOpen(concept.supersededBy!)}>
								Open it
							</Button>
						)
					}
				>
					Replaced by <span className="hb-mono">{concept.supersededBy}</span>. Recall no longer shows this one.
				</Notice>
			) : concept.status === "forgotten" ? (
				<Notice level="info" announce={false}>
					Forgotten. Recall no longer shows it; it stays here for its history.
				</Notice>
			) : stale ? (
				<Notice level="warning" announce={false}>
					Past its date for checking, so recall marks it stale and ranks it lower. Correct it or forget it.
				</Notice>
			) : null}

			{changing === undefined ? null : (
				<ConceptChange
					key={`${changing}:${concept.version}`}
					mode={changing}
					concept={concept}
					source={source}
					now={now}
					onCancel={() => setChanging(undefined)}
					onDone={() => {
						setChanging(undefined);
						reload();
						onChanged?.();
					}}
					{...(onChanged === undefined ? {} : { onProposed: onChanged })}
				/>
			)}

			<Panel header={<h3 className="hb-memory-section">Statement</h3>}>
				<p className="hb-concept-statement hb-selectable">{concept.statement}</p>
				{concept.description === undefined ? null : <p className="hb-concept-description">{concept.description}</p>}
				{concept.tags.length === 0 ? null : (
					<div className="hb-concept-tags">
						{concept.tags.map((tag) => (
							<Badge key={tag}>{tag}</Badge>
						))}
					</div>
				)}
			</Panel>

			<Panel header={<h3 className="hb-memory-section">Sources</h3>}>
				<ul className="hb-concept-sources">
					{concept.sources.map((item) => {
						const href = sourceHref(item);
						return (
							<li key={item} className="hb-mono">
								{href === undefined ? (
									item
								) : (
									<a className="hb-concept-link hb-focusable" href={href} target="_blank" rel="noreferrer">
										{item}
									</a>
								)}
							</li>
						);
					})}
				</ul>
			</Panel>

			<Panel header={<h3 className="hb-memory-section">Details</h3>}>
				<FieldList>
					<Field label="Version">{concept.version}</Field>
					<Field label="Updated">
						<ClockTime at={concept.updatedAt} now={now} />
					</Field>
					{concept.staleAfter === undefined ? null : (
						<Field label="Check by">
							<ClockTime at={concept.staleAfter} now={now} />
						</Field>
					)}
					{concept.overrides === undefined ? null : (
						<Field label="Overrides">
							{onOpen === undefined ? (
								<span className="hb-mono">{concept.overrides}</span>
							) : (
								<button
									type="button"
									className="hb-concept-link hb-mono hb-focusable"
									onClick={() => onOpen(concept.overrides!)}
								>
									{concept.overrides}
								</button>
							)}
						</Field>
					)}
					{extensionsOf(concept).length === 0 ? null : (
						<Field label="Host data">{extensionsOf(concept).join(", ")}</Field>
					)}
				</FieldList>
			</Panel>

			<Panel header={<h3 className="hb-memory-section">History</h3>}>
				{history.length === 0 ? (
					<p className="hb-memory-note">No proposals changed it here. It may have come from a snapshot import.</p>
				) : (
					<ol className="hb-concept-history">
						{history.map((proposal) => (
							<li key={proposal.id} className="hb-concept-event">
								<span className="hb-concept-event-badge">
									<Badge tone={PROPOSAL_STATUS[proposal.status].tone}>{WRITE_LABELS[proposal.write.op]}</Badge>
								</span>
								<span className="hb-concept-event-text">
									<span>
										{actorName(proposal.proposedBy, directory)} proposed to {writeSentence(proposal.write)}
									</span>
									{proposal.write.op === "forget" ? (
										<span className="hb-concept-event-meta">Because: {proposal.write.reason}</span>
									) : null}
									<span className="hb-concept-event-meta">
										{proposal.status === "applied" ? "Applied" : "Rejected"}
										{proposal.decidedBy === undefined ? "" : ` by ${actorName(proposal.decidedBy, directory)}`}
										{proposal.decidedAt === undefined ? null : (
											<>
												, <ClockTime at={proposal.decidedAt} now={now} />
											</>
										)}
										{proposal.note === undefined ? "" : `: ${proposal.note}`}
									</span>
								</span>
							</li>
						))}
					</ol>
				)}
			</Panel>
		</article>
	);
}

const extensionsOf = (concept: Concept) => Object.keys(concept.extensions ?? {}).sort();

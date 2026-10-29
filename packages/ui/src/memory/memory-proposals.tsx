import { isHarbourError, type MemoryProposal } from "@harbour/contracts";
import { useState } from "react";
import { type AuditDirectory, actorName } from "../audit/audit-model.ts";
import { Button } from "../primitives/button.tsx";
import { Disclosure } from "../primitives/controls.tsx";
import { ListRow } from "../primitives/list-row.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Field, FieldList, Notice, Panel } from "../primitives/surface.tsx";
import { ClockTime } from "../primitives/time.tsx";
import {
	PROPOSAL_STATUS,
	scopeText,
	sortProposals,
	sourceHref,
	WRITE_LABELS,
	writeConcept,
	writeSentence,
	writeTarget,
} from "./memory-model.ts";

export interface MemoryProposalsProps {
	readonly proposals: readonly MemoryProposal[];
	readonly directory?: AuditDirectory;
	readonly now: number;
	/** Applies or rejects; the page reads the proposals again after. */
	readonly onDecide: (proposalId: string, outcome: "apply" | "reject") => Promise<void>;
	/** Opens a concept the proposal names. */
	readonly onOpen?: (conceptId: string) => void;
}

type Deciding = { readonly id: string; readonly outcome: "apply" | "reject" };
type Failed = Deciding & { readonly message: string };

/** Why a decision failed, in a sentence: the store's conflicts say what changed. */
export function decisionError(error: unknown, outcome: "apply" | "reject"): string {
	if (isHarbourError(error, "conflict")) {
		const duplicate = error.details?.duplicateOf;
		return typeof duplicate === "string"
			? `Refused: it nearly repeats ${duplicate}. Reject it, or correct that concept instead.`
			: "Refused: the concept changed since this was proposed. Nothing was written; reject it and propose again.";
	}
	if (isHarbourError(error, "forbidden")) return "You can't decide proposals in this space.";
	return `Couldn't ${outcome === "apply" ? "approve" : "reject"} it. Nothing was written; try again.`;
}

/**
 * Proposed memory writes, waiting for a person: what each would remember, correct, replace or forget, who proposed it
 * and from which session, with Approve and Reject. A proposal that nearly repeats an existing concept says so, since
 * approving it would be refused. Decided proposals are kept below, newest first.
 */
export function MemoryProposals({ proposals, directory = {}, now, onDecide, onOpen }: MemoryProposalsProps) {
	const { pending, decided } = sortProposals(proposals);
	const [deciding, setDeciding] = useState<Deciding>();
	const [failed, setFailed] = useState<Failed>();

	const decide = async (id: string, outcome: "apply" | "reject") => {
		setDeciding({ id, outcome });
		setFailed(undefined);
		try {
			await onDecide(id, outcome);
		} catch (error) {
			setFailed({ id, outcome, message: decisionError(error, outcome) });
		} finally {
			setDeciding(undefined);
		}
	};

	return (
		<div className="hb-memory-proposals">
			{pending.length === 0 ? (
				<EmptyState title="Nothing waiting">
					When an agent proposes something to remember or change, it waits here for a person to approve.
				</EmptyState>
			) : (
				<ul className="hb-memory-proposal-list">
					{pending.map((proposal) => {
						const concept = writeConcept(proposal.write);
						const target = writeTarget(proposal.write);
						return (
							<li key={proposal.id}>
								<Panel
									tone="approval"
									aria-labelledby={`hb-proposal-${proposal.id}`}
									header={
										<div className="hb-memory-proposal-head">
											<Badge tone="approval">{WRITE_LABELS[proposal.write.op]}</Badge>
											<h3 id={`hb-proposal-${proposal.id}`} className="hb-memory-proposal-title">
												{actorName(proposal.proposedBy, directory)} proposes to {writeSentence(proposal.write)}
											</h3>
											<span className="hb-memory-proposal-age">
												<ClockTime at={proposal.createdAt} now={now} />
											</span>
										</div>
									}
									footer={
										<div className="hb-memory-proposal-actions">
											<Button
												variant="primary"
												size="sm"
												busy={deciding?.id === proposal.id && deciding.outcome === "apply"}
												disabled={deciding !== undefined}
												onClick={() => void decide(proposal.id, "apply")}
											>
												Approve
											</Button>
											<Button
												size="sm"
												busy={deciding?.id === proposal.id && deciding.outcome === "reject"}
												disabled={deciding !== undefined}
												onClick={() => void decide(proposal.id, "reject")}
											>
												Reject
											</Button>
										</div>
									}
								>
									{proposal.duplicateOf === undefined ? null : (
										<Notice
											level="warning"
											announce={false}
											action={
												onOpen === undefined ? undefined : (
													<Button size="xs" onClick={() => onOpen(proposal.duplicateOf!)}>
														Compare
													</Button>
												)
											}
										>
											Nearly repeats <span className="hb-mono">{proposal.duplicateOf}</span>, so approving it will be
											refused. Reject it, or correct that concept instead.
										</Notice>
									)}
									{concept === undefined ? null : (
										<div className="hb-memory-proposal-concept">
											<p className="hb-memory-proposal-concept-title">{concept.title}</p>
											<p className="hb-selectable">{concept.statement}</p>
										</div>
									)}
									<FieldList>
										{concept === undefined ? null : (
											<Field label="Applies">{scopeText(concept.scope, directory.project)}</Field>
										)}
										{proposal.write.op === "forget" ? <Field label="Because">{proposal.write.reason}</Field> : null}
										{concept === undefined ? null : (
											<Field label="Sources">
												<span className="hb-memory-proposal-sources">
													{concept.sources.map((item) => {
														const href = sourceHref(item);
														return href === undefined ? (
															<span key={item} className="hb-mono">
																{item}
															</span>
														) : (
															<a
																key={item}
																className="hb-concept-link hb-mono hb-focusable"
																href={href}
																target="_blank"
																rel="noreferrer"
															>
																{item}
															</a>
														);
													})}
												</span>
											</Field>
										)}
										{proposal.sessionId === undefined ? null : (
											<Field label="From session">
												{directory.session?.(proposal.sessionId) ?? (
													<span className="hb-mono">{proposal.sessionId}</span>
												)}
											</Field>
										)}
										{proposal.write.op === "remember" || onOpen === undefined ? null : (
											<Field label="Changes">
												<button
													type="button"
													className="hb-concept-link hb-mono hb-focusable"
													onClick={() => onOpen(target)}
												>
													{target}
												</button>
											</Field>
										)}
									</FieldList>
									{failed?.id === proposal.id ? <Notice level="error">{failed.message}</Notice> : null}
								</Panel>
							</li>
						);
					})}
				</ul>
			)}

			{decided.length === 0 ? null : (
				<Disclosure summary={`Decided (${decided.length})`} className="hb-memory-decided">
					<ul className="hb-memory-rows">
						{decided.map((proposal) => (
							<li key={proposal.id}>
								<ListRow
									density="comfortable"
									overline={WRITE_LABELS[proposal.write.op]}
									title={writeTarget(proposal.write)}
									meta={
										<>
											{actorName(proposal.proposedBy, directory)}
											{proposal.decidedBy === undefined
												? ""
												: `, decided by ${actorName(proposal.decidedBy, directory)}`}
											{proposal.decidedAt === undefined ? null : (
												<>
													, <ClockTime at={proposal.decidedAt} now={now} />
												</>
											)}
										</>
									}
									trailing={
										<Badge tone={PROPOSAL_STATUS[proposal.status].tone}>{PROPOSAL_STATUS[proposal.status].label}</Badge>
									}
									quiet
									{...(onOpen === undefined || proposal.status !== "applied"
										? {}
										: { onSelect: () => onOpen(writeTarget(proposal.write)) })}
								/>
							</li>
						))}
					</ul>
				</Disclosure>
			)}
		</div>
	);
}

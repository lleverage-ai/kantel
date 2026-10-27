import { useEffect, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { KeyIcon } from "../primitives/icons.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Notice } from "../primitives/surface.tsx";
import { type AuditDirectory, type AuditLinks, type AuditSource, actorName } from "./audit-model.ts";
import { type CredentialUsage, credentialUsage } from "./usage.ts";

// Above the timeline when a credential is picked: which sessions used it in the range, how often, and who approved
// each grant those uses went through. The answer to "which sessions used the Linear key yesterday and who approved
// it", without reading the timeline row by row.

const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayTime = new Intl.DateTimeFormat("en-GB", {
	day: "numeric",
	month: "short",
	hour: "2-digit",
	minute: "2-digit",
});
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

export interface CredentialUsagePanelProps {
	readonly source: AuditSource;
	readonly itemId: string;
	/** The organisation whose log to read, as the timeline's; the host's current one when left out. */
	readonly organisationId?: string;
	/** "Linear API key, yesterday". */
	readonly title: string;
	readonly from?: number;
	readonly to?: number;
	readonly directory?: AuditDirectory;
	readonly links?: AuditLinks;
}

type State =
	| { readonly phase: "loading" }
	| { readonly phase: "ready"; readonly usage: CredentialUsage }
	| { readonly phase: "failed" };

export function CredentialUsagePanel({
	source,
	itemId,
	organisationId,
	title,
	from,
	to,
	directory = {},
	links = {},
}: CredentialUsagePanelProps) {
	const [state, setState] = useState<State>({ phase: "loading" });
	const [attempt, setAttempt] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the read on "Try again".
	useEffect(() => {
		const controller = new AbortController();
		setState({ phase: "loading" });
		credentialUsage(source, {
			itemId,
			...(organisationId === undefined ? {} : { organisationId }),
			...(from === undefined ? {} : { from }),
			...(to === undefined ? {} : { to }),
			signal: controller.signal,
		}).then(
			(usage) => {
				if (!controller.signal.aborted) setState({ phase: "ready", usage });
			},
			() => {
				if (!controller.signal.aborted) setState({ phase: "failed" });
			},
		);
		return () => controller.abort();
	}, [source, itemId, organisationId, from, to, attempt]);

	const at = (when: number, reference: number) => (sameDay(when, reference) ? time.format(when) : dayTime.format(when));

	return (
		<section className="hb-audit-usage" aria-labelledby="hb-audit-usage-title">
			<h2 id="hb-audit-usage-title" className="hb-audit-usage-title">
				<KeyIcon size="sm" /> {title}
			</h2>
			{state.phase === "loading" ? (
				<div className="hb-audit-usage-loading" aria-hidden="true">
					<Skeleton lines={2} />
				</div>
			) : state.phase === "failed" ? (
				<Notice
					level="error"
					action={
						<Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
							Try again
						</Button>
					}
				>
					Couldn't work out who used it.
				</Notice>
			) : state.usage.sessions.length === 0 && state.usage.unattributed === 0 ? (
				<p className="hb-audit-usage-none">No session used it in this time.</p>
			) : (
				<>
					<p className="hb-audit-usage-summary">{summary(state.usage)}</p>
					<ul className="hb-audit-usage-list">
						{state.usage.sessions.map((session) => {
							const name = directory.session?.(session.sessionId) ?? session.sessionId;
							const agent =
								session.agentId === undefined ? undefined : (directory.agent?.(session.agentId) ?? session.agentId);
							const project =
								session.projectId === undefined
									? undefined
									: (directory.project?.(session.projectId) ?? session.projectId);
							return (
								<li key={session.sessionId} className="hb-audit-usage-row">
									<div className="hb-audit-usage-session">
										{links.session === undefined ? (
											<span className="hb-audit-usage-name">{name}</span>
										) : (
											<a className="hb-audit-usage-name hb-focusable" href={links.session(session.sessionId)}>
												{name}
											</a>
										)}
										<span className="hb-audit-usage-meta">
											{[agent, project].filter((part) => part !== undefined).join(" in ")}
										</span>
									</div>
									<div className="hb-audit-usage-uses">
										<span>
											{session.injected} {session.injected === 1 ? "use" : "uses"}
											{session.refused === 0 ? "" : `, ${session.refused} refused`}
										</span>
										<span className="hb-audit-usage-meta">
											{session.first === session.last
												? at(session.first, session.first)
												: `${at(session.first, session.first)} to ${at(session.last, session.first)}`}
										</span>
									</div>
									<div className="hb-audit-usage-approvals">
										{session.via.map((via) => {
											const approval = state.usage.approvals.get(via);
											if (approval === undefined)
												return (
													<span key={via} className="hb-audit-usage-meta">
														{state.usage.policies.includes(via) ? "Standing policy" : "Approval not in this log"}
													</span>
												);
											const by = actorName(approval.approvedBy, directory);
											const when = dayTime.format(approval.approvedAt);
											return (
												<span key={via}>
													Approved by <span className="hb-audit-usage-approver">{by}</span>{" "}
													{approval.proposalId !== undefined && links.proposal !== undefined ? (
														<a className="hb-audit-usage-when hb-focusable" href={links.proposal(approval.proposalId)}>
															{when}
														</a>
													) : (
														<span className="hb-audit-usage-meta">{when}</span>
													)}
												</span>
											);
										})}
									</div>
								</li>
							);
						})}
					</ul>
				</>
			)}
		</section>
	);
}

function summary(usage: CredentialUsage): string {
	const uses = usage.sessions.reduce((sum, session) => sum + session.injected, 0);
	const sessions = usage.sessions.length;
	const approvers = new Set([...usage.approvals.values()].map((approval) => JSON.stringify(approval.approvedBy))).size;
	const parts = [
		`Used ${uses} ${uses === 1 ? "time" : "times"} by ${sessions} ${sessions === 1 ? "session" : "sessions"}`,
		approvers === 0 ? "" : `, under grants from ${approvers} ${approvers === 1 ? "approver" : "approvers"}`,
		usage.unattributed === 0 ? "" : `, and ${usage.unattributed} times outside a session`,
	];
	return `${parts.join("")}.`;
}

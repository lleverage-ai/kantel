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

// Styled with Tailwind utilities (src/tokens/tailwind.css). A row is three columns (the session, its uses, who approved
// them), stacked on a phone.
const row =
	"grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1 border-t border-border py-2 max-sm:grid-cols-1";
const cell = "flex min-w-0 flex-col gap-0.5 wrap-anywhere";
const meta = "text-xs text-faint";
const link = "hb-focusable rounded-xs text-accent-text no-underline hover:underline";

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
		<section
			className="flex flex-col gap-within rounded-panel border border-border bg-panel p-pad-card"
			aria-labelledby="hb-audit-usage-title"
		>
			<h2
				id="hb-audit-usage-title"
				className="m-0 flex items-center gap-1.5 text-sm font-medium [&_.hb-icon]:text-faint"
			>
				<KeyIcon size="sm" /> {title}
			</h2>
			{state.phase === "loading" ? (
				<div aria-hidden="true">
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
				<p className="m-0 text-muted">No session used it in this time.</p>
			) : (
				<>
					<p className="m-0 text-muted">{summary(state.usage)}</p>
					<ul className="m-0 flex list-none flex-col p-0">
						{state.usage.sessions.map((session) => {
							const name = directory.session?.(session.sessionId) ?? session.sessionId;
							const agent =
								session.agentId === undefined ? undefined : (directory.agent?.(session.agentId) ?? session.agentId);
							const project =
								session.projectId === undefined
									? undefined
									: (directory.project?.(session.projectId) ?? session.projectId);
							const sessionHref = links.session?.(session.sessionId, undefined, session.projectId);
							return (
								<li key={session.sessionId} className={row}>
									<div className={cell}>
										{sessionHref === undefined ? (
											<span className="font-medium text-fg">{name}</span>
										) : (
											<a className={`${link} font-medium`} href={sessionHref}>
												{name}
											</a>
										)}
										<span className={meta}>{[agent, project].filter((part) => part !== undefined).join(" in ")}</span>
									</div>
									<div className={`${cell} tabular-nums`}>
										<span>
											{session.injected} {session.injected === 1 ? "use" : "uses"}
											{session.refused === 0 ? "" : `, ${session.refused} refused`}
										</span>
										<span className={meta}>
											{session.first === session.last
												? at(session.first, session.first)
												: `${at(session.first, session.first)} to ${at(session.last, session.first)}`}
										</span>
									</div>
									<div className={cell}>
										{session.via.map((via) => {
											const approval = state.usage.approvals.get(via);
											if (approval === undefined)
												return (
													<span key={via} className={meta}>
														{state.usage.policies.includes(via) ? "Standing policy" : "Approval not in this log"}
													</span>
												);
											const by = actorName(approval.approvedBy, directory);
											const when = dayTime.format(approval.approvedAt);
											const proposalHref =
												approval.proposalId === undefined ? undefined : links.proposal?.(approval.proposalId);
											return (
												<span key={via}>
													Approved by <span className="font-medium">{by}</span>{" "}
													{proposalHref !== undefined ? (
														<a className={`${link} text-xs`} href={proposalHref}>
															{when}
														</a>
													) : (
														<span className={meta}>{when}</span>
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

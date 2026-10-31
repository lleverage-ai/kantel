// Who can use a connection, and where it was used (#335). The connection's page shows:
// - "Who can use it": where the connection reaches (which sessions, who may see them, unattended runs, agents), and
//   for a person's own connection the projects it's shared with, with Share and Stop sharing. Only that person shares
//   it; an organisation admin sees it, its rules and its shares, and can stop a share, but never use or share it.
// - "Recent uses": each use with its session and step, who the session acted for, who could see it, and why one was
//   refused. Kantel records one for every attempt, allowed or not, so "which connection did this session use, at which
//   step, and why was it refused" has an answer. A use in someone else's private session shows only when it happened,
//   how it ended and who it acted for: the API redacts the rest for a viewer who can't open the session.

import { useId, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { SelectField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { compactAge } from "../primitives/format.ts";
import { CheckCircleIcon, ClockIcon, LockIcon, XCircleIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { ProjectIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { Notice } from "../primitives/surface.tsx";
import {
	type Connection,
	type ConnectionShareView,
	type ConnectionSharingSource,
	type ConnectionsViewer,
	type ConnectionUseOutcome,
	type ConnectionUseView,
	canShare,
	canUnshare,
	EGRESS_REFUSAL_LABELS,
	HELD_APPROVAL_LABELS,
	type HeldApproval,
	isPrivateUse,
	type PrivateUseView,
	type RecentUseView,
	reachFacts,
	shareableProjects,
	shareConsequence,
	shareText,
	USE_OUTCOME_LABELS,
} from "./connections-model.ts";

const message = (caught: unknown, fallback: string) =>
	caught instanceof Error && caught.message !== "" ? caught.message : fallback;

const projectName = (viewer: ConnectionsViewer, projectId: string) =>
	viewer.projects.find((project) => project.id === projectId)?.name ?? projectId;

const sectionHeading = "m-0 text-sm font-strong text-fg";
const sectionLead = "m-0 max-w-prose text-xs leading-normal text-muted";

export interface ConnectionSharingProps {
	readonly connection: Connection;
	readonly viewer: ConnectionsViewer;
	readonly people?: ((userId: string) => string | undefined) | undefined;
	readonly now: number;
	/** The share and unshare calls. Without them the shares show, with no controls. */
	readonly source?: ConnectionSharingSource | undefined;
	/** The connection after a share or unshare, for the page to keep. */
	readonly onChange?: (connection: Connection) => void;
}

/** "Who can use it": where a connection reaches, and a person's shares to projects. */
export function ConnectionSharingSection({
	connection,
	viewer,
	people,
	now,
	source,
	onChange,
}: ConnectionSharingProps) {
	const headingId = useId();
	const [current, setCurrent] = useState(connection);
	const [picked, setPicked] = useState<string>("");
	const [confirming, setConfirming] = useState<string>();
	const [busy, setBusy] = useState<string>();
	const [error, setError] = useState<string>();
	const [done, setDone] = useState<string>();

	const personal = current.owner.kind === "user";
	const mine = canShare(current, viewer);
	const shares = personal ? (current.shares ?? []) : [];
	const options = shareableProjects(current, viewer);
	const choice = picked !== "" && options.some((p) => p.id === picked) ? picked : (options[0]?.id ?? "");
	const ownerName =
		current.owner.kind === "user" ? (people?.(current.owner.userId) ?? current.owner.userId) : undefined;

	const apply = async (key: string, work: () => Promise<Connection>, said: (next: Connection) => string) => {
		setBusy(key);
		setError(undefined);
		setDone(undefined);
		try {
			const next = await work();
			setCurrent(next);
			onChange?.(next);
			setDone(said(next));
			return true;
		} catch (caught) {
			setError(message(caught, "Couldn't change the sharing. Try again."));
			return false;
		} finally {
			setBusy(undefined);
		}
	};

	const share = async (projectId: string) => {
		if (source === undefined) return;
		const ok = await apply(
			`share:${projectId}`,
			() => source.share(current.id, projectId),
			() =>
				`Shared with ${projectName(viewer, projectId)}. Its agents can use ${current.name} from their next request.`,
		);
		if (ok) {
			setConfirming(undefined);
			setPicked("");
		}
	};

	const unshare = (projectId: string) =>
		source === undefined
			? undefined
			: apply(
					`unshare:${projectId}`,
					() => source.unshare(current.id, projectId),
					() =>
						`Stopped sharing with ${projectName(viewer, projectId)}. Its agents' next request through ${current.name} is refused.`,
				);

	return (
		<section className="kt-connection-sharing flex min-w-0 flex-col gap-4" aria-labelledby={headingId}>
			<div className="flex min-w-0 flex-col gap-1">
				<h3 id={headingId} className={sectionHeading}>
					Who can use it
				</h3>
				<p className={sectionLead}>
					{personal
						? "A personal connection works only in sessions acting for its owner that nobody else can see, so what it returns stays theirs. Sharing it with a project lets that project's agents use it."
						: "Checked before every request, ahead of the rules: a session outside this is refused, whatever the rules say."}
				</p>
			</div>

			{personal && !mine && ownerName !== undefined ? (
				<Notice level="info" announce={false}>
					This is {ownerName}'s own connection. You can see it, its rules and where it's shared, but only {ownerName}{" "}
					can use it or share it.
				</Notice>
			) : null}

			<div className="flex min-w-0 flex-col rounded-panel border border-border bg-panel">
				<dl className="m-0 grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2.5 p-4 max-sm:grid-cols-1 max-sm:gap-y-1">
					{reachFacts(current, viewer, people).map((fact) => (
						<div key={fact.label} className="contents">
							<dt className="text-xs text-muted max-sm:pt-1.5 max-sm:first:pt-0">{fact.label}</dt>
							<dd className="m-0 flex min-w-0 items-start gap-1.5 text-sm text-fg">
								{fact.closed === true ? (
									<span className="mt-0.5 flex shrink-0 text-faint" aria-hidden="true">
										<LockIcon size="sm" />
									</span>
								) : null}
								<span className="wrap-anywhere">{fact.text}</span>
							</dd>
						</div>
					))}
				</dl>

				{personal ? (
					<div className="flex min-w-0 flex-col gap-3 border-0 border-t border-solid border-border p-4">
						<h4 className="m-0 text-xs font-medium text-muted">Shared with</h4>
						{shares.length === 0 ? (
							<p className="m-0 text-sm text-muted">
								{mine ? "No projects yet. Only your own private sessions can use it." : "No projects."}
							</p>
						) : (
							<ul className="m-0 flex list-none flex-col p-0">
								{shares.map((item) => (
									<ShareRow
										key={item.projectId}
										share={item}
										name={projectName(viewer, item.projectId)}
										now={now}
										busy={busy === `unshare:${item.projectId}`}
										onUnshare={
											source !== undefined && canUnshare(current, viewer)
												? () => void unshare(item.projectId)
												: undefined
										}
									/>
								))}
							</ul>
						)}
						{mine && source !== undefined ? (
							options.length === 0 ? (
								<p className="m-0 text-xs text-faint">It's shared with every project you're in.</p>
							) : (
								<div className="flex min-w-0 items-end gap-2 max-sm:flex-col max-sm:items-stretch">
									<SelectField
										label="Share with a project"
										className="min-w-0 flex-1"
										value={choice}
										onChange={(event) => setPicked(event.target.value)}
										options={options.map((project) => ({ value: project.id, label: `${project.name} project` }))}
									/>
									<Button disabled={choice === ""} onClick={() => setConfirming(choice)}>
										Share
									</Button>
								</div>
							)
						) : null}
					</div>
				) : null}
			</div>

			{error === undefined ? null : <Notice level="error">{error}</Notice>}
			{done === undefined ? null : (
				<Notice
					level="info"
					action={
						<Button variant="ghost" size="sm" onClick={() => setDone(undefined)}>
							Dismiss
						</Button>
					}
				>
					{done}
				</Notice>
			)}

			<Dialog
				open={confirming !== undefined}
				title={confirming === undefined ? "Share" : `Share ${current.name} with ${projectName(viewer, confirming)}?`}
				onClose={() => setConfirming(undefined)}
				actions={
					<>
						<Button onClick={() => setConfirming(undefined)} disabled={busy !== undefined}>
							Cancel
						</Button>
						<Button
							variant="primary"
							busy={confirming !== undefined && busy === `share:${confirming}`}
							onClick={() => confirming !== undefined && void share(confirming)}
						>
							Share
						</Button>
					</>
				}
			>
				{confirming === undefined ? null : (
					<p className="m-0">{shareConsequence(current, projectName(viewer, confirming))}</p>
				)}
			</Dialog>
		</section>
	);
}

function ShareRow({
	share,
	name,
	now,
	busy,
	onUnshare,
}: {
	share: ConnectionShareView;
	name: string;
	now: number;
	busy: boolean;
	onUnshare?: (() => void) | undefined;
}) {
	return (
		<li className="flex min-w-0 items-center gap-3 border-0 border-t border-solid border-border py-2.5 first:border-t-0 first:pt-0 last:pb-0">
			<span className="flex shrink-0 text-faint" aria-hidden="true">
				<ProjectIcon size="sm" />
			</span>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="text-sm text-fg">{name} project</span>
				<span className="text-xs text-faint">{shareText(share, now, compactAge)}</span>
			</span>
			{onUnshare === undefined ? null : (
				<Button variant="ghost" size="sm" busy={busy} onClick={onUnshare}>
					Stop sharing
				</Button>
			)}
		</li>
	);
}

// ---------------------------------------------------------------------------------------------------------------------
// Recent uses

const OUTCOME_ICON: Record<ConnectionUseOutcome, typeof CheckCircleIcon> = {
	allowed: CheckCircleIcon,
	denied: XCircleIcon,
	held: ClockIcon,
};

/** A held use's approval, as its badge's tone (#481): still waiting is the approval colour, an end is settled. */
const HELD_APPROVAL_TONE: Record<HeldApproval, "approval" | "done" | "error" | "idle"> = {
	waiting: "approval",
	approved: "done",
	denied: "error",
	expired: "idle",
	withdrawn: "idle",
};

const OUTCOME_TONE: Record<ConnectionUseOutcome, string> = {
	allowed: "text-status-done",
	denied: "text-status-error",
	held: "text-status-approval",
};

export interface ConnectionUsesProps {
	readonly connectionId: string;
	readonly load: (connectionId: string) => Promise<readonly RecentUseView[]>;
	readonly now: number;
	/** Opens a session, from a use's session name. */
	readonly onOpenSession?: ((sessionId: string) => void) | undefined;
	/** How many to show. Default 20. */
	readonly limit?: number;
}

/** "Recent uses": which session and step used the connection, for whom, who could see it, and why one was refused. */
export function ConnectionUsesSection({ connectionId, load, now, onOpenSession, limit = 20 }: ConnectionUsesProps) {
	const headingId = useId();
	// `load` is read fresh on each load (useLoad keeps the latest), so a new function each render reads nothing again.
	const uses = useLoad(() => load(connectionId), [connectionId]);
	return (
		<section className="kt-connection-uses flex min-w-0 flex-col gap-3" aria-labelledby={headingId}>
			<div className="flex min-w-0 flex-col gap-1">
				<h3 id={headingId} className={sectionHeading}>
					Recent uses
				</h3>
				<p className={sectionLead}>
					Every time an agent tried to use it: the session and step, who the session acted for, who could see it, and
					why a request was refused.
				</p>
			</div>
			{uses.state.status === "loading" ? (
				<div className="flex flex-col gap-3" aria-busy="true">
					<Skeleton lines={2} />
					<Skeleton lines={2} />
				</div>
			) : uses.state.status === "error" ? (
				<Notice level="error" action={<Button onClick={uses.reload}>Try again</Button>}>
					Couldn't load its uses. Check your connection and try again.
				</Notice>
			) : uses.state.value.length === 0 ? (
				<p className="m-0 text-sm text-muted">No agent has used it yet.</p>
			) : (
				<ul className="m-0 flex list-none flex-col rounded-panel border border-border bg-panel p-0">
					{uses.state.value
						.slice(0, limit)
						.map((use) =>
							isPrivateUse(use) ? (
								<PrivateUseRow key={use.id} use={use} now={now} />
							) : (
								<UseRow key={use.id} use={use} now={now} onOpenSession={onOpenSession} />
							),
						)}
				</ul>
			)}
		</section>
	);
}

const useRow = "flex min-w-0 items-start gap-3 border-0 border-t border-solid border-border px-4 py-3 first:border-t-0";

/**
 * A use in someone else's private session (#335): when and how it ended, and who it acted for. The session, its step
 * and what it asked for stay with that person and the connection's owner.
 */
function PrivateUseRow({ use, now }: { use: PrivateUseView; now: number }) {
	const Icon = OUTCOME_ICON[use.outcome];
	return (
		<li className={useRow}>
			<span className={`mt-0.5 flex shrink-0 ${OUTCOME_TONE[use.outcome]}`}>
				<Icon size="sm" />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
					<span className={`text-sm font-medium ${OUTCOME_TONE[use.outcome]}`}>{USE_OUTCOME_LABELS[use.outcome]}</span>
					<span className="inline-flex min-w-0 items-baseline gap-1 text-sm text-fg">
						<span className="flex shrink-0 self-center text-muted">
							<LockIcon size="sm" />
						</span>
						in a private session
					</span>
				</div>
				<span className="text-xs text-muted wrap-anywhere">
					{use.actingFor === undefined ? "" : `Acting for ${use.actingFor}. `}
					The session is private, so what it asked for isn't shown.
				</span>
			</div>
			<span className="shrink-0 text-xs text-faint tabular-nums">{compactAge(use.at, now)} ago</span>
		</li>
	);
}

function UseRow({
	use,
	now,
	onOpenSession,
}: {
	use: ConnectionUseView;
	now: number;
	onOpenSession?: ((sessionId: string) => void) | undefined;
}) {
	const Icon = OUTCOME_ICON[use.outcome];
	const session = use.sessionTitle ?? use.sessionId;
	return (
		<li className={useRow}>
			<span className={`mt-0.5 flex shrink-0 ${OUTCOME_TONE[use.outcome]}`}>
				<Icon size="sm" />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
					<span className={`text-sm font-medium ${OUTCOME_TONE[use.outcome]}`}>{USE_OUTCOME_LABELS[use.outcome]}</span>
					<code className="kt-mono kt-selectable min-w-0 text-code text-fg wrap-anywhere">{use.what}</code>
					{use.outcome === "held" && use.approval !== undefined ? (
						<Badge tone={HELD_APPROVAL_TONE[use.approval]}>{HELD_APPROVAL_LABELS[use.approval]}</Badge>
					) : null}
					{use.via === "sandbox" ? <Badge>From the shell</Badge> : null}
				</div>
				<span className="text-xs text-muted wrap-anywhere">
					In{" "}
					{onOpenSession === undefined ? (
						<span className="text-fg">{session}</span>
					) : (
						<button
							type="button"
							className="kt-focusable m-0 cursor-pointer rounded-xs border-0 bg-transparent p-0 text-xs text-fg hover:underline"
							onClick={() => onOpenSession(use.sessionId)}
						>
							{session}
						</button>
					)}
					{use.toolCallId === undefined ? "" : `, step ${use.toolCallId}`}
					{use.actingFor === undefined ? ", with no person behind it" : `, acting for ${use.actingFor}`}.{" "}
					{use.audience === "private" ? "Only they could see it." : "Others could see it."}
				</span>
				{use.refusal === undefined || use.outcome === "allowed" ? null : (
					<span className="flex min-w-0 flex-wrap items-center gap-2">
						<Badge tone={use.outcome === "denied" ? "error" : "approval"}>
							{EGRESS_REFUSAL_LABELS[use.refusal] ?? use.refusal}
						</Badge>
						<code className="kt-mono kt-selectable text-xs text-muted">{use.refusal}</code>
					</span>
				)}
				{use.reason === undefined || use.outcome === "allowed" ? null : (
					<span
						className={`text-xs wrap-anywhere ${use.outcome === "denied" ? "text-status-error" : use.approval === undefined || use.approval === "waiting" ? "text-status-approval" : "text-muted"}`}
					>
						{use.reason}
					</span>
				)}
			</div>
			<span className="shrink-0 text-xs text-faint tabular-nums">{compactAge(use.at, now)} ago</span>
		</li>
	);
}

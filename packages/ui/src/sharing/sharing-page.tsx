// The sharing page (docs/design/sharing.md): for one project, the requests waiting on the viewer, what the project
// shares with others, what others share with it, and its own requests. Every write goes through the source, and the
// server decides each one; the page only offers what the request allows (a grant no wider than asked).

import type { AccessRequest, ResourceShare, SharePermission } from "@harbour/contracts";
import { useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CheckboxField, SelectField } from "../primitives/controls.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { useLoad } from "../primitives/load.ts";
import { ownerName } from "../primitives/owner.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice, Panel } from "../primitives/surface.tsx";
import { ClockTime } from "../primitives/time.tsx";
import {
	actorText,
	agentWritesText,
	expiryText,
	grantablePermissions,
	granteeText,
	grantInput,
	offersAgentWrites,
	PERMISSION_HINTS,
	PERMISSION_LABELS,
	REQUEST_STATUS_LABELS,
	readOverview,
	resourceText,
	type SharingDirectory,
	type SharingOverview,
	type SharingSource,
	sentenceCase,
	shareState,
	sortShares,
} from "./sharing-model.ts";
import {
	sharingActions,
	sharingBody,
	sharingDetail,
	sharingReason,
	sharingResource,
	sharingRow,
	sharingRows,
	sharingTitle,
	sharingWhat,
} from "./sharing-styles.ts";

export interface SharingProject {
	readonly id: string;
	readonly name: string;
}

export interface SharingPageProps {
	readonly source: SharingSource;
	/** The projects the viewer can pick between, by name. */
	readonly projects: readonly SharingProject[];
	readonly initialProjectId?: string;
	readonly directory?: SharingDirectory;
	/** The time the page measures expiry from. Default now. */
	readonly now?: number;
}

export function SharingPage({ source, projects, initialProjectId, directory = {}, now }: SharingPageProps) {
	const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id);
	const [failure, setFailure] = useState<string>();
	const [busy, setBusy] = useState<string>();
	const { state, reload } = useLoad(
		async () => (projectId === undefined ? undefined : readOverview(source, projectId)),
		[source, projectId],
	);
	const names: SharingDirectory = {
		...directory,
		project: (id) => directory.project?.(id) ?? projects.find((project) => project.id === id)?.name,
	};
	const act = async (key: string, write: () => Promise<unknown>) => {
		setBusy(key);
		setFailure(undefined);
		try {
			await write();
			reload();
		} catch (error) {
			setFailure(error instanceof Error ? error.message : "That didn't work");
		} finally {
			setBusy(undefined);
		}
	};

	return (
		<div className="flex w-full max-w-content min-w-0 flex-col gap-6 text-sm leading-normal text-fg [&_p]:m-0">
			<PageHeader title="Sharing" />
			{projects.length > 1 && projectId !== undefined ? (
				<SelectField
					label="Project"
					width="short"
					value={projectId}
					options={projects.map((project) => ({ value: project.id, label: project.name }))}
					onChange={(event) => setProjectId(event.target.value)}
				/>
			) : null}
			{failure === undefined ? null : <Notice level="error">{failure}</Notice>}
			{projectId === undefined ? (
				<EmptyState title="No project to show">Sharing is per project, and you're in none yet.</EmptyState>
			) : state.status === "loading" ? (
				<div className={sharingBody} aria-busy="true">
					<Skeleton lines={3} />
					<Skeleton lines={3} />
				</div>
			) : state.status === "error" ? (
				<Notice level="error" action={<Button onClick={reload}>Try again</Button>}>
					The project's sharing couldn't be read.
				</Notice>
			) : state.value === undefined ? null : (
				<SharingView
					overview={state.value}
					directory={names}
					now={now ?? Date.now()}
					busy={busy}
					onDecide={(request, decision) => act(request.id, () => source.decideRequest(request.id, decision))}
					onRevoke={(share) => act(share.id, () => source.revokeShare(share.id))}
					onWithdraw={(request) => act(request.id, () => source.withdrawRequest(request.id))}
				/>
			)}
		</div>
	);
}

export interface SharingViewProps {
	readonly overview: SharingOverview;
	readonly directory?: SharingDirectory;
	readonly now: number;
	/** The request or share whose write is under way. */
	readonly busy?: string | undefined;
	readonly onDecide: (request: AccessRequest, decision: ReturnType<typeof grantInput> | { decision: "reject" }) => void;
	readonly onRevoke: (share: ResourceShare) => void;
	readonly onWithdraw: (request: AccessRequest) => void;
}

/**
 * The page's four lists, drawn from what was read. After Notion's share settings, a list shows only when it has
 * something in it, and a project with nothing in any of them says so once, rather than in four empty cards.
 */
export function SharingView({ overview, directory = {}, now, busy, onDecide, onRevoke, onWithdraw }: SharingViewProps) {
	if (
		overview.inbox.length === 0 &&
		overview.outgoing.length === 0 &&
		overview.incoming.length === 0 &&
		overview.requests.length === 0
	) {
		return <EmptyState title="Nothing shared yet">Shares and requests for access show here.</EmptyState>;
	}
	return (
		<div className={sharingBody}>
			{overview.inbox.length === 0 ? null : (
				<Panel header={<h2 className={sharingTitle}>Requests to decide</h2>} aria-label="Requests to decide">
					<ul className={sharingRows}>
						{overview.inbox.map((request) => (
							<InboxRow
								key={request.id}
								request={request}
								directory={directory}
								now={now}
								busy={busy === request.id}
								onDecide={onDecide}
							/>
						))}
					</ul>
				</Panel>
			)}
			{overview.outgoing.length === 0 ? null : (
				<ShareList
					title="Shared by this project"
					empty="This project shares nothing with others."
					shares={overview.outgoing}
					directory={directory}
					now={now}
					busy={busy}
					action="Revoke"
					onRevoke={onRevoke}
					side="outgoing"
				/>
			)}
			{overview.incoming.length === 0 ? null : (
				<ShareList
					title="Shared with this project"
					empty="Nothing is shared with this project."
					shares={overview.incoming}
					directory={directory}
					now={now}
					busy={busy}
					action="Detach"
					onRevoke={onRevoke}
					side="incoming"
				/>
			)}
			{overview.requests.length === 0 ? null : (
				<Panel header={<h2 className={sharingTitle}>This project's requests</h2>} aria-label="This project's requests">
					<ul className={sharingRows}>
						{overview.requests.map((request) => (
							<li key={request.id} className={sharingRow}>
								<div className={sharingWhat}>
									<span className={sharingResource}>{resourceText(request.resource, directory)}</span>
									<span className={sharingDetail}>
										{PERMISSION_LABELS[request.permission]} for {granteeText(request.grantee, directory)}, asked by{" "}
										{actorText(request.requestedBy, directory)} <ClockTime at={request.createdAt} now={now} />
									</span>
									<span className={sharingReason}>{request.reason}</span>
								</div>
								<div className={sharingActions}>
									<Badge
										tone={request.status === "granted" ? "done" : request.status === "pending" ? "accent" : "neutral"}
									>
										{REQUEST_STATUS_LABELS[request.status]}
									</Badge>
									{request.status === "pending" ? (
										<Button
											size="sm"
											variant="ghost"
											disabled={busy === request.id}
											onClick={() => onWithdraw(request)}
										>
											Withdraw
										</Button>
									) : null}
								</div>
							</li>
						))}
					</ul>
				</Panel>
			)}
		</div>
	);
}

export function InboxRow({
	request,
	directory,
	now,
	busy,
	onDecide,
}: {
	request: AccessRequest;
	directory: SharingDirectory;
	now: number;
	busy: boolean;
	onDecide: SharingViewProps["onDecide"];
}) {
	const [permission, setPermission] = useState<SharePermission>(request.permission);
	const [agentWrites, setAgentWrites] = useState(false);
	const choices = grantablePermissions(request.permission);
	return (
		<li className={sharingRow}>
			<div className={sharingWhat}>
				<span className={sharingResource}>{resourceText(request.resource, directory)}</span>
				<span className={sharingDetail}>
					{PERMISSION_LABELS[request.permission]} for {granteeText(request.grantee, directory)}, asked by{" "}
					{actorText(request.requestedBy, directory)} <ClockTime at={request.createdAt} now={now} />
					{request.expiresAt === undefined ? null : `, for ${expiryText(request.expiresAt, now).replace(/ left$/, "")}`}
				</span>
				<span className={sharingReason}>{request.reason}</span>
			</div>
			<div className={sharingActions}>
				{choices.length > 1 ? (
					<SelectField
						label="Grant"
						hideLabel
						width="short"
						value={permission}
						title={PERMISSION_HINTS[permission]}
						options={choices.map((value) => ({ value, label: PERMISSION_LABELS[value] }))}
						onChange={(event) => setPermission(event.target.value as SharePermission)}
					/>
				) : null}
				{offersAgentWrites(permission) ? (
					<CheckboxField
						label="Let agents write"
						title="Agents in the grantee's sessions may change it too. Without this they only propose."
						checked={agentWrites}
						disabled={busy}
						onChange={(event) => setAgentWrites(event.target.checked)}
					/>
				) : null}
				<Button
					size="sm"
					variant="primary"
					disabled={busy}
					onClick={() => onDecide(request, grantInput(request, { permission, agentWrites }))}
				>
					Grant
				</Button>
				<Button size="sm" variant="secondary" disabled={busy} onClick={() => onDecide(request, { decision: "reject" })}>
					Reject
				</Button>
			</div>
		</li>
	);
}

export function ShareList({
	title,
	empty,
	shares,
	directory,
	now,
	busy,
	action,
	onRevoke,
	side,
	heading: Heading = "h2",
}: {
	title: string;
	empty: string;
	shares: readonly ResourceShare[];
	directory: SharingDirectory;
	now: number;
	busy: string | undefined;
	action: string;
	onRevoke: (share: ResourceShare) => void;
	/** `resource` names only the grantee: the panel is already on the resource. */
	side: "outgoing" | "incoming" | "resource";
	heading?: "h2" | "h3";
}) {
	return (
		<Panel header={<Heading className={sharingTitle}>{title}</Heading>} aria-label={title}>
			{shares.length === 0 ? (
				<EmptyState title={empty} />
			) : (
				<ul className={sharingRows}>
					{sortShares(shares, now).map((share) => {
						const state = shareState(share, now);
						return (
							<li key={share.id} className={sharingRow}>
								<div className={sharingWhat}>
									<span className={sharingResource}>
										{side === "resource"
											? sentenceCase(granteeText(share.grantee, directory)) +
												(share.resource.revision === undefined ? "" : `, revision ${share.resource.revision}`)
											: resourceText(share.resource, directory)}
									</span>
									<span className={sharingDetail}>
										{side === "outgoing"
											? `With ${granteeText(share.grantee, directory)}, shared by `
											: side === "incoming"
												? `From ${ownerName(share.owner, directory)}, shared by `
												: "Shared by "}
										{actorText(share.grantedBy, directory)} <ClockTime at={share.grantedAt} now={now} />
										{share.expiresAt === undefined ? null : state === "expired" ? (
											<>
												, ended <ClockTime at={share.expiresAt} now={now} />
											</>
										) : (
											`, ${expiryText(share.expiresAt, now)}`
										)}
									</span>
									{share.parentShareId === undefined ? null : (
										<span className={sharingReason}>Passed on by a supervising session.</span>
									)}
								</div>
								<div className={sharingActions}>
									<Badge tone={state === "active" ? "accent" : "neutral"}>{PERMISSION_LABELS[share.permission]}</Badge>
									{agentWritesText(share) === undefined ? null : <Badge>{agentWritesText(share)}</Badge>}
									{state === "active" ? (
										<Button size="sm" variant="ghost" disabled={busy === share.id} onClick={() => onRevoke(share)}>
											{action}
										</Button>
									) : (
										<Badge>{state === "revoked" ? "Revoked" : "Expired"}</Badge>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</Panel>
	);
}

// The sharing page (docs/design/sharing.md): for one project, the requests waiting on the viewer, what the project
// shares with others, what others share with it, and its own requests. Every write goes through the source, and the
// server decides each one; the page only offers what the request allows (a grant no wider than asked).

import type { AccessRequest, ResourceShare, SharePermission } from "@harbour/contracts";
import { useState } from "react";
import { Button } from "../primitives/button.tsx";
import { SelectField } from "../primitives/controls.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { useLoad } from "../primitives/load.ts";
import { ownerName } from "../primitives/owner.ts";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge } from "../primitives/status.tsx";
import { EmptyState, Notice, Panel } from "../primitives/surface.tsx";
import { ClockTime } from "../primitives/time.tsx";
import {
	actorText,
	expiryText,
	grantablePermissions,
	granteeText,
	grantInput,
	PERMISSION_HINTS,
	PERMISSION_LABELS,
	REQUEST_STATUS_LABELS,
	readOverview,
	resourceText,
	type SharingDirectory,
	type SharingOverview,
	type SharingSource,
	shareState,
	sortShares,
} from "./sharing-model.ts";
import "./sharing-page.css";

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
		<div className="hb-sharing">
			<PageHeader
				title="Sharing"
				lede="Skills, memory, vault items and workspaces this project shares with others, what others share with it, and the requests for access waiting on you."
			/>
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
				<div className="hb-sharing-loading" aria-busy="true">
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

/** The page's four lists, drawn from what was read. */
export function SharingView({ overview, directory = {}, now, busy, onDecide, onRevoke, onWithdraw }: SharingViewProps) {
	return (
		<div className="hb-sharing-body">
			<Panel header={<h2 className="hb-sharing-title">Requests to decide</h2>} aria-label="Requests to decide">
				{overview.inbox.length === 0 ? (
					<EmptyState title="Nothing waiting on you" />
				) : (
					<ul className="hb-sharing-rows">
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
				)}
			</Panel>
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
			<Panel
				header={<h2 className="hb-sharing-title">This project's requests</h2>}
				aria-label="This project's requests"
			>
				{overview.requests.length === 0 ? (
					<EmptyState title="No requests from this project" />
				) : (
					<ul className="hb-sharing-rows">
						{overview.requests.map((request) => (
							<li key={request.id} className="hb-sharing-row">
								<div className="hb-sharing-what">
									<span className="hb-sharing-resource">{resourceText(request.resource, directory)}</span>
									<span className="hb-sharing-detail">
										{PERMISSION_LABELS[request.permission]} for {granteeText(request.grantee, directory)}, asked by{" "}
										{actorText(request.requestedBy, directory)} <ClockTime at={request.createdAt} now={now} />
									</span>
									<span className="hb-sharing-reason">{request.reason}</span>
								</div>
								<div className="hb-sharing-actions">
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
				)}
			</Panel>
		</div>
	);
}

function InboxRow({
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
	const choices = grantablePermissions(request.permission);
	return (
		<li className="hb-sharing-row">
			<div className="hb-sharing-what">
				<span className="hb-sharing-resource">{resourceText(request.resource, directory)}</span>
				<span className="hb-sharing-detail">
					{PERMISSION_LABELS[request.permission]} for {granteeText(request.grantee, directory)}, asked by{" "}
					{actorText(request.requestedBy, directory)} <ClockTime at={request.createdAt} now={now} />
					{request.expiresAt === undefined ? null : `, for ${expiryText(request.expiresAt, now).replace(/ left$/, "")}`}
				</span>
				<span className="hb-sharing-reason">{request.reason}</span>
			</div>
			<div className="hb-sharing-actions">
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
				<Button
					size="sm"
					variant="primary"
					disabled={busy}
					onClick={() => onDecide(request, grantInput(request, { permission }))}
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

function ShareList({
	title,
	empty,
	shares,
	directory,
	now,
	busy,
	action,
	onRevoke,
	side,
}: {
	title: string;
	empty: string;
	shares: readonly ResourceShare[];
	directory: SharingDirectory;
	now: number;
	busy: string | undefined;
	action: string;
	onRevoke: (share: ResourceShare) => void;
	side: "outgoing" | "incoming";
}) {
	return (
		<Panel header={<h2 className="hb-sharing-title">{title}</h2>} aria-label={title}>
			{shares.length === 0 ? (
				<EmptyState title={empty} />
			) : (
				<ul className="hb-sharing-rows">
					{sortShares(shares, now).map((share) => {
						const state = shareState(share, now);
						return (
							<li key={share.id} className="hb-sharing-row">
								<div className="hb-sharing-what">
									<span className="hb-sharing-resource">{resourceText(share.resource, directory)}</span>
									<span className="hb-sharing-detail">
										{side === "outgoing"
											? `With ${granteeText(share.grantee, directory)}`
											: `From ${ownerName(share.owner, directory)}`}
										, shared by {actorText(share.grantedBy, directory)} <ClockTime at={share.grantedAt} now={now} />
										{share.expiresAt === undefined ? null : state === "expired" ? (
											<>
												, ended <ClockTime at={share.expiresAt} now={now} />
											</>
										) : (
											`, ${expiryText(share.expiresAt, now)}`
										)}
									</span>
									{share.parentShareId === undefined ? null : (
										<span className="hb-sharing-reason">Passed on by a supervising session.</span>
									)}
								</div>
								<div className="hb-sharing-actions">
									<Badge tone={state === "active" ? "accent" : "neutral"}>{PERMISSION_LABELS[share.permission]}</Badge>
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

// "Your connections" (#339): every connection the viewer can see, grouped by owner, each with its account, where it
// may be used, its health and when it was last used; and one connection's own page. Two connections to the same
// service read apart by their account and their usage line ("Personal to Tom Davies, only in sessions acting as Tom
// Davies" beside "Shared across Acme").

import { type ReactNode, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { CopyButton } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { compactAge } from "../primitives/format.ts";
import {
	OrganisationIcon,
	PersonIcon,
	PlugIcon,
	ProjectIcon,
	ReconnectIcon,
	ServerIcon,
	UnplugIcon,
} from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge, type BadgeTone } from "../primitives/status.tsx";
import { EmptyState, Field, FieldList, Notice } from "../primitives/surface.tsx";
import {
	accountText,
	type Connection,
	type ConnectionHealth,
	type ConnectionsViewer,
	type DisconnectResult,
	groupConnections,
	HEALTH_LABELS,
	healthText,
	secretText,
	usageText,
} from "./connections-model.ts";
import { ProviderLogo } from "./provider-logo.tsx";

const HEALTH_TONE: Record<ConnectionHealth, BadgeTone> = {
	healthy: "done",
	refresh_failing: "waiting",
	needs_reconnect: "approval",
	error: "error",
	failing_test: "error",
	disabled: "neutral",
};

export type PeopleNames = (userId: string) => string | undefined;

/** The owner's icon: a person, a project or the organisation. */
function OwnerIcon({ connection }: { connection: Connection }) {
	const kind = connection.owner.kind;
	return kind === "user" ? (
		<PersonIcon size="sm" />
	) : kind === "project" ? (
		<ProjectIcon size="sm" />
	) : (
		<OrganisationIcon size="sm" />
	);
}

function KindFallback({ connection }: { connection: Connection }) {
	return connection.kind === "mcp" ? <ServerIcon /> : connection.kind === "key" ? <PlugIcon /> : undefined;
}

export interface ConnectionRowProps {
	readonly connection: Connection;
	readonly viewer: ConnectionsViewer;
	readonly people?: PeopleNames | undefined;
	readonly now: number;
	readonly onOpen?: ((connection: Connection) => void) | undefined;
	readonly onReconnect?: ((connection: Connection) => void) | undefined;
	readonly onDisconnect?: ((connection: Connection) => void) | undefined;
	/** The reconnect under way, if it is this one's. */
	readonly busy?: boolean;
}

/** One connection: the service and account, where it may be used, its rules and last use, health and actions. */
export function ConnectionRow({
	connection,
	viewer,
	people,
	now,
	onOpen,
	onReconnect,
	onDisconnect,
	busy = false,
}: ConnectionRowProps) {
	const account = accountText(connection);
	const problem = healthText(connection, now);
	const title = (
		<span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
			<span className="font-medium text-fg">{connection.name}</span>
			{account === undefined ? null : <span className="text-muted wrap-anywhere">{account}</span>}
		</span>
	);
	return (
		<li className="flex min-w-0 items-start gap-3 border-t border-border py-3 first:border-t-0 first:pt-0 last:pb-0 max-sm:flex-wrap">
			<ProviderLogo
				name={connection.name}
				icon={connection.icon}
				size="sm"
				fallback={<KindFallback connection={connection} />}
			/>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				{onOpen === undefined ? (
					title
				) : (
					<button
						type="button"
						className="kt-focusable m-0 min-w-0 cursor-pointer rounded-xs border-0 bg-transparent p-0 text-left hover:underline"
						onClick={() => onOpen(connection)}
						aria-label={`${connection.name}${account === undefined ? "" : `, ${account}`}`}
					>
						{title}
					</button>
				)}
				<span className="flex min-w-0 items-start gap-1.5 text-xs text-muted">
					<span className="mt-0.5 shrink-0 text-faint">
						<OwnerIcon connection={connection} />
					</span>
					<span className="wrap-anywhere">{usageText(connection, viewer, people)}</span>
				</span>
				{problem === undefined ? null : (
					<span
						className={`text-xs wrap-anywhere ${connection.health === "refresh_failing" ? "text-muted" : "text-status-approval"}`}
					>
						{problem}
					</span>
				)}
				<span className="text-xs text-faint">
					{[
						connection.rulesSummary,
						connection.lastUsedAt === undefined ? "Not used yet" : `Used ${compactAge(connection.lastUsedAt, now)} ago`,
					]
						.filter(Boolean)
						.join(". ")}
				</span>
			</div>
			<div className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:justify-end">
				<Badge tone={HEALTH_TONE[connection.health]}>{HEALTH_LABELS[connection.health]}</Badge>
				{connection.health === "needs_reconnect" && onReconnect !== undefined ? (
					<Button
						variant="primary"
						size="sm"
						busy={busy}
						icon={<ReconnectIcon size="sm" />}
						onClick={() => onReconnect(connection)}
					>
						Reconnect
					</Button>
				) : null}
				{onDisconnect === undefined ? null : (
					<Button variant="ghost" size="sm" icon={<UnplugIcon size="sm" />} onClick={() => onDisconnect(connection)}>
						Disconnect
					</Button>
				)}
			</div>
		</li>
	);
}

/** What Disconnect did upstream, in a sentence (#329). */
export function disconnectText(connection: Connection, result: DisconnectResult): string {
	const name =
		accountText(connection) === undefined ? connection.name : `${connection.name} (${accountText(connection)})`;
	const there = result.revokeUrl === undefined ? ` in ${connection.name}'s settings` : ` at ${result.revokeUrl}`;
	if (result.revoked === true) return `Disconnected ${name}. ${connection.name} revoked the access too.`;
	if (result.revoked === "none") return `Disconnected ${name}. It held no credential, so there was nothing to revoke.`;
	if (result.revoked === "unknown")
		return `Disconnected ${name}. Kantel deleted its credential; to be sure, remove its access${there} too.`;
	if (result.revoked === "unsupported")
		return connection.kind === "key"
			? `Disconnected ${name}. Kantel deleted the key, but it still works at ${connection.name} until you revoke it there.`
			: `Disconnected ${name}. Kantel deleted its credential, but ${connection.name} gives apps no way to revoke access, so remove it${there} too.`;
	return `Disconnected ${name} here and deleted its credential, but ${connection.name} didn't revoke the access${result.reason === undefined ? "" : ` (${result.reason.replace(/\.$/, "")})`}. Remove its access${there}.`;
}

/** Confirms a disconnect: what stops working, and that Kantel asks the provider to revoke. */
export function DisconnectDialog({
	connection,
	busy,
	error,
	onCancel,
	onConfirm,
}: {
	connection: Connection | undefined;
	busy: boolean;
	error?: string | undefined;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const account = connection === undefined ? undefined : accountText(connection);
	return (
		<Dialog
			open={connection !== undefined}
			title={
				connection === undefined
					? "Disconnect"
					: `Disconnect ${connection.name}${account === undefined ? "" : ` (${account})`}?`
			}
			onClose={onCancel}
			actions={
				<>
					<Button onClick={onCancel} disabled={busy}>
						Cancel
					</Button>
					<Button variant="danger" busy={busy} onClick={onConfirm}>
						Disconnect
					</Button>
				</>
			}
		>
			{connection === undefined ? null : (
				<div className="flex flex-col gap-2">
					<p className="m-0">
						Agents lose access at once, and sessions that use it will ask for a connection again.{" "}
						{connection.kind === "key"
							? "Kantel deletes the key."
							: `Kantel also asks ${connection.name} to revoke the access it granted.`}
					</p>
					{error === undefined ? null : <Notice level="error">{error}</Notice>}
				</div>
			)}
		</Dialog>
	);
}

export interface ConnectionListProps {
	readonly connections: readonly Connection[];
	readonly viewer: ConnectionsViewer;
	readonly people?: PeopleNames | undefined;
	readonly now: number;
	readonly loading?: boolean;
	readonly error?: string | undefined;
	readonly onRetry?: () => void;
	readonly onOpen?: (connection: Connection) => void;
	readonly onReconnect?: (connection: Connection) => void;
	/** Disconnects one; the list shows what happened upstream. */
	readonly onDisconnect?: (connection: Connection) => Promise<DisconnectResult>;
	readonly onBrowse?: () => void;
	/** The connection whose reconnect is under way. */
	readonly reconnecting?: string | undefined;
}

/** The viewer's connections grouped by owner: theirs first, then each project's, then the organisation's. */
export function ConnectionList({
	connections,
	viewer,
	people,
	now,
	loading = false,
	error,
	onRetry,
	onOpen,
	onReconnect,
	onDisconnect,
	onBrowse,
	reconnecting,
}: ConnectionListProps) {
	const [confirming, setConfirming] = useState<Connection>();
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const [done, setDone] = useState<string>();

	const confirm = async () => {
		if (confirming === undefined || onDisconnect === undefined) return;
		setBusy(true);
		setFailure(undefined);
		try {
			const result = await onDisconnect(confirming);
			setDone(disconnectText(confirming, result));
			setConfirming(undefined);
		} catch (caught) {
			setFailure(caught instanceof Error ? caught.message : "Couldn't disconnect it. Try again.");
		} finally {
			setBusy(false);
		}
	};

	if (error !== undefined)
		return (
			<Notice level="error" action={onRetry === undefined ? undefined : <Button onClick={onRetry}>Try again</Button>}>
				{error}
			</Notice>
		);
	if (loading)
		return (
			<div className="flex flex-col gap-4" aria-busy="true">
				<GroupFrame title={<Skeleton width="30%" />}>
					<Skeleton lines={2} />
					<Skeleton lines={2} />
				</GroupFrame>
			</div>
		);

	const groups = groupConnections(connections, viewer, people);
	return (
		<div className="flex min-w-0 flex-col gap-4">
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
			{groups.length === 0 ? (
				<EmptyState
					title="No connections yet"
					action={
						onBrowse === undefined ? undefined : (
							<Button variant="primary" icon={<PlugIcon size="sm" />} onClick={onBrowse}>
								Browse services
							</Button>
						)
					}
				>
					Connect a service and your agents can use it, without ever seeing its credentials.
				</EmptyState>
			) : (
				groups.map((group) => (
					<GroupFrame key={group.key} title={group.title} count={group.connections.length}>
						<ul className="m-0 flex list-none flex-col p-0">
							{group.connections.map((connection) => (
								<ConnectionRow
									key={connection.id}
									connection={connection}
									viewer={viewer}
									people={people}
									now={now}
									onOpen={onOpen}
									onReconnect={onReconnect}
									onDisconnect={onDisconnect === undefined ? undefined : (c) => setConfirming(c)}
									busy={reconnecting === connection.id}
								/>
							))}
						</ul>
					</GroupFrame>
				))
			)}
			<DisconnectDialog
				connection={confirming}
				busy={busy}
				error={failure}
				onCancel={() => {
					setConfirming(undefined);
					setFailure(undefined);
				}}
				onConfirm={() => void confirm()}
			/>
		</div>
	);
}

function GroupFrame({ title, count, children }: { title: ReactNode; count?: number; children: ReactNode }) {
	return (
		<section className="flex min-w-0 flex-col rounded-panel border border-border bg-panel">
			<header className="flex items-center gap-2 border-0 border-b border-solid border-border px-4 py-2.5">
				<h3 className="m-0 min-w-0 flex-1 text-sm font-strong text-fg">{title}</h3>
				{count === undefined ? null : <span className="text-xs text-faint">{count}</span>}
			</header>
			<div className="flex min-w-0 flex-col gap-2 p-4">{children}</div>
		</section>
	);
}

export interface ConnectionDetailProps {
	readonly connection: Connection;
	readonly viewer: ConnectionsViewer;
	readonly people?: PeopleNames | undefined;
	readonly now: number;
	readonly onReconnect?: (connection: Connection) => void;
	readonly onDisconnect?: (connection: Connection) => void;
	readonly reconnecting?: boolean;
	/** In place of the actions while a reconnect runs: its progress. */
	readonly progress?: ReactNode;
	/** The rules editor (#341), in place of the one-line summary. */
	readonly rules?: ReactNode;
	/** Who can use it and where it's shared (#335), above the rules. */
	readonly sharing?: ReactNode;
	/** Its recent uses (#335), under the placeholders. */
	readonly uses?: ReactNode;
}

/** One connection's page (#339): its account, who may use it, what it may reach, its placeholders and its health. */
export function ConnectionDetail({
	connection,
	viewer,
	people,
	now,
	onReconnect,
	onDisconnect,
	reconnecting = false,
	progress,
	rules,
	sharing,
	uses,
}: ConnectionDetailProps) {
	const account = accountText(connection);
	const problem = healthText(connection, now);
	// A failing refresh is Kantel's to retry: it says so, and Reconnect stays below with the other actions.
	const urgent = connection.health !== "refresh_failing";
	return (
		<div className="flex min-w-0 flex-col gap-5">
			<header className="flex min-w-0 items-start gap-4 max-sm:flex-col">
				<ProviderLogo
					name={connection.name}
					icon={connection.icon}
					size="lg"
					fallback={<KindFallback connection={connection} />}
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<h2 className="m-0 text-lg font-strong text-fg wrap-anywhere">
						{connection.name}
						{account === undefined ? null : <span className="font-regular text-muted"> {account}</span>}
					</h2>
					<p className="m-0 flex items-start gap-1.5 text-sm text-muted">
						<span className="mt-0.5 shrink-0 text-faint">
							<OwnerIcon connection={connection} />
						</span>
						{usageText(connection, viewer, people)}
					</p>
				</div>
				<Badge tone={HEALTH_TONE[connection.health]}>{HEALTH_LABELS[connection.health]}</Badge>
			</header>
			{problem === undefined ? null : (
				<Notice
					level={
						connection.health === "refresh_failing"
							? "info"
							: connection.health === "needs_reconnect"
								? "warning"
								: "error"
					}
					action={
						onReconnect === undefined || connection.kind === "key" || !urgent ? undefined : (
							<Button
								variant="primary"
								busy={reconnecting}
								icon={<ReconnectIcon size="sm" />}
								onClick={() => onReconnect(connection)}
							>
								Reconnect
							</Button>
						)
					}
				>
					{problem}
				</Notice>
			)}
			{progress}
			<FieldList>
				{connection.account === undefined ? null : <Field label="Account">{connection.account}</Field>}
				<Field label="Connected">
					{connection.createdBy === undefined ? "" : `By ${connection.createdBy}, `}
					{compactAge(connection.createdAt, now)} ago
				</Field>
				<Field label="Last used">
					{connection.lastUsedAt === undefined ? "Not used yet" : `${compactAge(connection.lastUsedAt, now)} ago`}
				</Field>
				<Field label="Sent to">
					<span className="flex flex-wrap gap-1.5">
						{connection.hosts.map((host) => (
							<code key={host} className="kt-mono kt-selectable rounded-xs bg-sunken px-1.5">
								{host}
							</code>
						))}
					</span>
				</Field>
				{connection.mcp === undefined ? null : (
					<Field label="MCP server">
						<code className="kt-mono kt-selectable wrap-anywhere">{connection.mcp.url}</code>
						{connection.mcp.tools === undefined ? null : (
							<span className="text-muted">, {connection.mcp.tools} tools</span>
						)}
					</Field>
				)}
				{connection.scopes === undefined || connection.scopes.length === 0 ? null : (
					<Field label="Granted scopes">
						<span className="flex flex-wrap gap-1.5">
							{connection.scopes.map((scope) => (
								<code key={scope} className="kt-mono kt-selectable rounded-xs bg-sunken px-1.5 wrap-anywhere">
									{scope}
								</code>
							))}
						</span>
					</Field>
				)}
				{connection.client === undefined ? null : <Field label="OAuth client">{connection.client.label}</Field>}
				{connection.key === undefined ? null : <Field label="Key">{secretText(connection.key)}</Field>}
				{rules !== undefined || connection.rulesSummary === undefined ? null : (
					<Field label="Rules">{connection.rulesSummary}</Field>
				)}
			</FieldList>
			{sharing}
			{rules}
			{connection.placeholders === undefined || connection.placeholders.length === 0 ? null : (
				<section className="flex min-w-0 flex-col gap-2" aria-label="Placeholders">
					<h3 className="m-0 text-sm font-strong text-fg">Placeholders</h3>
					<p className="m-0 text-xs text-muted">
						An agent writes one of these where the credential goes. Kantel's egress proxy swaps in the real value on the
						way out, only to the hosts above.
					</p>
					{connection.placeholders.map((placeholder) => (
						<div key={placeholder} className="flex min-w-0 items-center gap-2">
							<code className="min-w-0 flex-1 rounded-control border border-border-input bg-sunken px-2.5 py-1.5 font-mono text-code select-all wrap-anywhere">
								{placeholder}
							</code>
							<CopyButton text={placeholder} iconOnly label="Copy placeholder" />
						</div>
					))}
				</section>
			)}
			{uses}
			<div className="flex flex-wrap gap-2 border-0 border-t border-solid border-border pt-4">
				{onReconnect === undefined || connection.kind === "key" || connection.health === "needs_reconnect" ? null : (
					<Button busy={reconnecting} icon={<ReconnectIcon size="sm" />} onClick={() => onReconnect(connection)}>
						Reconnect
					</Button>
				)}
				{onDisconnect === undefined ? null : (
					<Button variant="danger" icon={<UnplugIcon size="sm" />} onClick={() => onDisconnect(connection)}>
						Disconnect
					</Button>
				)}
			</div>
		</div>
	);
}

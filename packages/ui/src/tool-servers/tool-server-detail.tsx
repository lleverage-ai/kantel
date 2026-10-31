import type { IssuedToolServerToken, ToolServer, ToolServerToken, ToolServerToolView } from "@harbour/contracts";
import { useEffect, useState } from "react";
import { Button, buttonClass, buttonLabelClass } from "../primitives/button.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { FormSection } from "../primitives/form-layout.tsx";
import { compactAge } from "../primitives/format.ts";
import { useLoad } from "../primitives/load.ts";
import { ReconnectIcon, TrashIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { Badge, StatusDot, StatusLabel } from "../primitives/status.tsx";
import { EmptyState, Field, FieldList, Notice, Panel } from "../primitives/surface.tsx";
import { Switch } from "../primitives/switch.tsx";
import { ClockTime } from "../primitives/time.tsx";
import {
	CALL_OUTCOME_LABELS,
	CALL_OUTCOME_STATUS,
	latencyText,
	olderTokens,
	REPLAY_LABELS,
	sortTokens,
	TOOL_SERVER_STATE_STATUS,
	type ToolServerCall,
	type ToolServerProject,
	type ToolServersSource,
	TRANSPORT_LABELS,
	tokenUsedText,
	toolServerScopeText,
	toolServerState,
	toolServerStatusText,
} from "./tool-servers-model.ts";
import { TunnelTokenReveal } from "./tunnel-token.tsx";

/** A line of facts, wrapping between them. */
const meta = "m-0 flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs text-faint wrap-anywhere";
/** A list in a hairline frame, a hairline between rows. */
const rows = "m-0 flex list-none flex-col divide-y divide-border rounded-panel border border-border bg-panel p-0";

const messageOf = (caught: unknown, fallback: string) => (caught instanceof Error ? caught.message : fallback);

/** What needs confirming: removing the server, or revoking one token. */
type Confirming = { readonly kind: "remove" } | { readonly kind: "revoke"; readonly token: ToolServerToken };

/**
 * One tool server: its status, owner and transport and what it said about itself; its tools, each with the name the
 * model sees, its description exactly as the server gave it, its replay class and an Enabled switch that applies at
 * once; its tunnel tokens, with rotation; its recent calls; and Remove.
 */
export function ToolServerDetail({
	server,
	source,
	organisation,
	projects,
	origin,
	now,
	onRemoved,
}: {
	server: ToolServer;
	source: ToolServersSource;
	organisation: string;
	projects: readonly ToolServerProject[];
	origin: string;
	now: number;
	onRemoved: (server: ToolServer) => void;
}) {
	const id = server.id;
	const tools = useLoad(() => source.tools(id), [source, id]);
	const tokens = useLoad(() => source.listTokens(id), [source, id]);
	const calls = useLoad(() => source.recentCalls(id), [source, id]);

	const state = toolServerState(server.connection);
	const info = server.connection.serverInfo;
	const [confirming, setConfirming] = useState<Confirming>();
	const [confirmBusy, setConfirmBusy] = useState(false);
	const [confirmError, setConfirmError] = useState<string>();

	const confirm = async () => {
		if (confirming === undefined) return;
		setConfirmBusy(true);
		setConfirmError(undefined);
		try {
			if (confirming.kind === "remove") {
				await source.remove(id);
				setConfirming(undefined);
				onRemoved(server);
				return;
			}
			await source.revokeToken(id, confirming.token.id);
			setConfirming(undefined);
			tokens.reload();
		} catch (caught) {
			setConfirmError(messageOf(caught, "Harbour couldn't do that. Try again."));
		} finally {
			setConfirmBusy(false);
		}
	};
	const closeConfirm = () => {
		if (confirmBusy) return;
		setConfirming(undefined);
		setConfirmError(undefined);
	};

	return (
		<div className="flex min-w-0 flex-col gap-6">
			<Panel aria-label={`About ${server.name}`} className="max-w-content">
				<FieldList>
					<Field label="Status">
						<StatusLabel status={TOOL_SERVER_STATE_STATUS[state]}>
							{toolServerStatusText(server.connection, now)}
						</StatusLabel>
					</Field>
					<Field label="Owner">{toolServerScopeText(server, organisation, projects)}</Field>
					<Field label="Transport">{TRANSPORT_LABELS[server.transport]}</Field>
					<Field label="Server">
						{info === undefined ? (
							<span className="text-muted">Not known until it connects</span>
						) : (
							<span className="font-mono text-code">
								{info.name}
								{info.version === undefined ? "" : ` ${info.version}`}
							</span>
						)}
					</Field>
				</FieldList>
			</Panel>

			{state === "offline" ? (
				<Notice level="warning" announce={false}>
					Sessions get an error from its tools until it reconnects. Start the tunnel again where the server runs.
				</Notice>
			) : state === "never" ? (
				<Notice level="info" announce={false}>
					It hasn't connected yet. Run the tunnel command with its token where your MCP server runs, and its tools
					appear here.
				</Notice>
			) : null}

			<ToolsSection server={server} source={source} tools={tools} />

			<TokensSection
				server={server}
				source={source}
				origin={origin}
				now={now}
				tokens={tokens}
				onRevoke={(token) => setConfirming({ kind: "revoke", token })}
			/>

			<CallsSection auditHref={source.auditHref(id)} calls={calls} now={now} />

			<FormSection
				level={2}
				title="Remove tool server"
				description="Its tokens stop working and its tunnel closes. Sessions get an error from its tools from their next call."
			>
				<div>
					<Button
						variant="danger"
						size="sm"
						icon={<TrashIcon size="sm" />}
						onClick={() => setConfirming({ kind: "remove" })}
					>
						Remove {server.name}
					</Button>
				</div>
			</FormSection>

			<Dialog
				open={confirming !== undefined}
				title={
					confirming?.kind === "revoke" ? `Revoke the token ${confirming.token.prefix}…?` : `Remove ${server.name}?`
				}
				onClose={closeConfirm}
				actions={
					<>
						<Button onClick={closeConfirm} disabled={confirmBusy}>
							Cancel
						</Button>
						<Button variant="danger" busy={confirmBusy} onClick={() => void confirm()}>
							{confirming?.kind === "revoke" ? "Revoke token" : "Remove server"}
						</Button>
					</>
				}
			>
				<p>
					{confirming?.kind === "revoke"
						? "A tunnel running with it closes at once, and it can't connect again. This can't be undone."
						: `Its tokens stop working, its tunnel closes, and sessions get an error from its tools from their next call. This can't be undone.`}
				</p>
				{confirmError === undefined ? null : <p className="hb-dialog-error">{confirmError}</p>}
			</Dialog>
		</div>
	);
}

type Load<T> = ReturnType<typeof useLoad<T>>;

function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
	return (
		<Notice
			level="error"
			action={
				<Button size="xs" onClick={onRetry}>
					Try again
				</Button>
			}
		>
			Harbour couldn't read {what}. Check your connection and try again.
		</Notice>
	);
}

function RowsLoading({ label }: { label: string }) {
	return (
		<div className="flex flex-col gap-4" aria-busy="true">
			<span className="hb-sr-only">{label}</span>
			<Skeleton lines={2} />
			<Skeleton lines={2} />
		</div>
	);
}

function ToolsSection({
	server,
	source,
	tools,
}: {
	server: ToolServer;
	source: ToolServersSource;
	tools: Load<Awaited<ReturnType<ToolServersSource["tools"]>>>;
}) {
	// A switch shows where it's going while the change saves, then what the server says.
	const [saving, setSaving] = useState<Readonly<Record<string, boolean>>>({});
	const [failed, setFailed] = useState<Readonly<Record<string, string>>>({});
	const list = tools.state.status === "ready" ? tools.state.value.tools : undefined;
	const count = list?.length;

	const toggle = async (tool: ToolServerToolView, enabled: boolean) => {
		setSaving((now) => ({ ...now, [tool.name]: enabled }));
		setFailed(({ [tool.name]: _, ...rest }) => rest);
		try {
			await source.setToolEnabled(server.id, tool.name, enabled);
			tools.reload();
		} catch (caught) {
			setFailed((now) => ({
				...now,
				[tool.name]: messageOf(caught, `Harbour couldn't ${enabled ? "enable" : "disable"} it. Try again.`),
			}));
			setSaving(({ [tool.name]: _, ...rest }) => rest);
		}
	};
	// The reload has the new value: the switch shows the server's from here.
	useEffect(() => {
		if (list !== undefined) setSaving({});
	}, [list]);

	return (
		<FormSection
			level={2}
			title={count === undefined ? "Tools" : `Tools (${count})`}
			description="Each goes to the model with the server's own name, description and schema. A change applies to new sessions; a running session keeps the tools it started with. Read-only tools may be run again; Harbour never reruns an unsafe one."
		>
			{tools.state.status === "error" ? (
				<LoadError what={`${server.name}'s tools`} onRetry={tools.reload} />
			) : list === undefined ? (
				<RowsLoading label="Loading tools" />
			) : list.length === 0 ? (
				<EmptyState title="No tools yet">
					{server.snapshot === undefined
						? "They appear when the server connects and lists them."
						: "The server listed no tools."}
				</EmptyState>
			) : (
				<ul className={rows} aria-label={`${server.name}'s tools`}>
					{list.map((tool) => {
						const pending = saving[tool.name];
						return (
							<li key={tool.name} className="flex min-w-0 flex-col gap-1.5 px-3 py-2.5">
								<div className="flex min-w-0 items-start gap-3">
									<div className="flex min-w-0 flex-1 flex-col gap-0.5">
										<p className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
											<span
												className={`font-mono text-code font-medium wrap-anywhere ${tool.enabled ? "text-fg" : "text-muted"}`}
											>
												{tool.name}
											</span>
											<Badge tone={tool.replay === "safe" ? "neutral" : "approval"}>{REPLAY_LABELS[tool.replay]}</Badge>
										</p>
										<p className={meta}>
											<span>
												The model sees <code className="font-mono">{tool.modelName}</code>
											</span>
										</p>
									</div>
									<Switch
										label={`Enable ${tool.name}`}
										hideLabel
										checked={pending ?? tool.enabled}
										busy={pending !== undefined}
										onChange={(enabled) => void toggle(tool, enabled)}
									/>
								</div>
								{/* The server's words, as it gave them: never rewritten. */}
								<p className="m-0 text-sm whitespace-pre-wrap text-muted wrap-anywhere">{tool.description}</p>
								{tool.unavailableReason === undefined ? null : (
									<p className="m-0 text-xs text-status-approval wrap-anywhere">
										Sessions aren't offered it: {tool.unavailableReason}
									</p>
								)}
								{failed[tool.name] === undefined ? null : (
									<p className="m-0 text-xs text-status-error" role="alert">
										{failed[tool.name]}
									</p>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</FormSection>
	);
}

function TokensSection({
	server,
	source,
	origin,
	now,
	tokens,
	onRevoke,
}: {
	server: ToolServer;
	source: ToolServersSource;
	origin: string;
	now: number;
	tokens: Load<readonly ToolServerToken[]>;
	onRevoke: (token: ToolServerToken) => void;
}) {
	const [issued, setIssued] = useState<{ token: IssuedToolServerToken; older: readonly ToolServerToken[] }>();
	// After the new token is stored: the ones it replaces, offered for revoking.
	const [offer, setOffer] = useState<readonly ToolServerToken[]>();
	const [busy, setBusy] = useState<"rotate" | "revoke-old">();
	const [failure, setFailure] = useState<string>();
	const list = tokens.state.status === "ready" ? sortTokens(tokens.state.value) : undefined;

	const rotate = async () => {
		setBusy("rotate");
		setFailure(undefined);
		setOffer(undefined);
		try {
			const made = await source.createToken(server.id);
			setIssued({ token: made, older: olderTokens(list ?? [], made.token.id) });
			tokens.reload();
		} catch (caught) {
			setFailure(messageOf(caught, "Harbour couldn't make a new token. Try again."));
		} finally {
			setBusy(undefined);
		}
	};

	const revokeOld = async (older: readonly ToolServerToken[]) => {
		setBusy("revoke-old");
		setFailure(undefined);
		try {
			for (const token of older) await source.revokeToken(server.id, token.id);
			setOffer(undefined);
		} catch (caught) {
			setFailure(messageOf(caught, "Harbour couldn't revoke the old token. Try again."));
		} finally {
			setBusy(undefined);
			tokens.reload();
		}
	};

	return (
		<FormSection
			level={2}
			title="Tunnel tokens"
			description="The tunnel connects with one of these. Harbour keeps only a hash of each, so a lost token is rotated, not shown again."
			action={
				issued === undefined ? (
					<Button
						size="sm"
						icon={<ReconnectIcon size="sm" />}
						busy={busy === "rotate"}
						disabled={busy !== undefined}
						onClick={() => void rotate()}
					>
						Rotate token
					</Button>
				) : undefined
			}
		>
			{issued === undefined ? null : (
				<TunnelTokenReveal
					server={server}
					issued={issued.token}
					origin={origin}
					rotated
					onAcknowledge={() => {
						setOffer(issued.older.length === 0 ? undefined : issued.older);
						setIssued(undefined);
					}}
				/>
			)}
			{offer === undefined ? null : (
				<Notice
					level="info"
					action={
						<span className="flex flex-wrap gap-2">
							<Button size="xs" variant="danger" busy={busy === "revoke-old"} onClick={() => void revokeOld(offer)}>
								{offer.length === 1 ? "Revoke old token" : "Revoke old tokens"}
							</Button>
							<Button size="xs" variant="ghost" disabled={busy !== undefined} onClick={() => setOffer(undefined)}>
								Keep {offer.length === 1 ? "it" : "them"}
							</Button>
						</span>
					}
				>
					{offer.length === 1
						? `Revoke the old token, ${offer[0]?.prefix}…, once the tunnel runs with the new one? A tunnel still using it closes when it's revoked.`
						: `Revoke the ${offer.length} older tokens once the tunnel runs with the new one? A tunnel still using one closes when it's revoked.`}
				</Notice>
			)}
			{failure === undefined ? null : <Notice level="error">{failure}</Notice>}
			{tokens.state.status === "error" ? (
				<LoadError what={`${server.name}'s tokens`} onRetry={tokens.reload} />
			) : list === undefined ? (
				<RowsLoading label="Loading tokens" />
			) : list.length === 0 ? (
				<EmptyState title="No tokens">Rotate token makes one, so the tunnel can connect.</EmptyState>
			) : (
				<ul className={rows} aria-label={`${server.name}'s tokens`}>
					{list.map((token) => (
						<li key={token.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5">
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="font-mono text-code text-fg">{token.prefix}…</span>
								<p className={meta}>
									<span>Created {compactAge(token.createdAt, now)} ago</span>
									<span>{tokenUsedText(token, now)}</span>
								</p>
							</div>
							<Button
								size="xs"
								variant="danger"
								aria-label={`Revoke ${token.prefix}`}
								disabled={busy !== undefined}
								onClick={() => onRevoke(token)}
							>
								Revoke
							</Button>
						</li>
					))}
				</ul>
			)}
		</FormSection>
	);
}

/** How long a call took: "184 ms", "Error after 30 s", "Running". */
function callTimeText(entry: ToolServerCall): string {
	const took = entry.durationMs === undefined ? undefined : latencyText(entry.durationMs);
	if (entry.outcome === "ok") return took ?? "Running";
	const label = CALL_OUTCOME_LABELS[entry.outcome];
	return took === undefined ? label : `${label} after ${took}`;
}

function CallsSection({
	auditHref,
	calls,
	now,
}: {
	auditHref: string;
	calls: Load<readonly ToolServerCall[]>;
	now: number;
}) {
	const list = calls.state.status === "ready" ? calls.state.value : undefined;
	return (
		<FormSection
			level={2}
			title="Recent calls"
			description="The latest calls sessions made to its tools. The audit log has every one, with its arguments and result."
			action={
				<a className={`${buttonClass("secondary", "sm")} no-underline`} href={auditHref}>
					<span className={buttonLabelClass}>Open in audit</span>
				</a>
			}
		>
			{calls.state.status === "error" ? (
				<LoadError what="its recent calls" onRetry={calls.reload} />
			) : list === undefined ? (
				<RowsLoading label="Loading recent calls" />
			) : list.length === 0 ? (
				<EmptyState title="No calls yet">Calls appear here when a session uses one of its tools.</EmptyState>
			) : (
				<ul className={rows} aria-label="Recent calls">
					{list.map((entry) => (
						<li key={entry.callId} className="flex min-w-0 items-start gap-3 px-3 py-2">
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="flex min-w-0 items-baseline gap-2 [&>.hb-status-dot]:translate-y-(--hb-on-cap)">
									<StatusDot status={CALL_OUTCOME_STATUS[entry.outcome]} label={CALL_OUTCOME_LABELS[entry.outcome]} />
									<span className="font-mono text-code text-fg wrap-anywhere">{entry.tool}</span>
								</span>
								<span className="min-w-0 truncate text-xs text-muted">{entry.sessionTitle ?? entry.sessionId}</span>
							</div>
							<div className="flex flex-none flex-col items-end gap-0.5 text-xs text-faint tabular-nums">
								<ClockTime at={entry.startedAt} now={now} />
								<span>{callTimeText(entry)}</span>
							</div>
						</li>
					))}
				</ul>
			)}
		</FormSection>
	);
}

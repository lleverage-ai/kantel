// The Tool servers page (docs/design/private-mcp-tools.md, section 1): the MCP servers an organisation's or a project's
// sessions can call for tools, adding one with its tunnel token and command, and each server's tools, tokens and
// recent calls. Every call goes through the `ToolServersSource` the host binds to `/v1/tool-servers`; stories bind it
// to fixtures. The view is plain state the host can mirror in its address (`view` and `onViewChange`), as the
// Connections page's is.

import type { CreatedToolServer, ToolServer } from "@kantel/contracts";
import { type ReactNode, useCallback, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { PageHeader } from "../primitives/form-layout.tsx";
import { ChevronRightIcon, PlusIcon } from "../primitives/icons.tsx";
import { useLoad } from "../primitives/load.ts";
import { OrganisationIcon, ProjectIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { StatusLabel } from "../primitives/status.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import { AddToolServer } from "./add-tool-server.tsx";
import { ToolServerDetail } from "./tool-server-detail.tsx";
import {
	statsText,
	TOOL_SERVER_STATE_STATUS,
	type ToolServerProject,
	type ToolServerStats,
	type ToolServersSource,
	TRANSPORT_LABELS,
	toolCountText,
	toolServerScopeText,
	toolServerState,
	toolServerStatusText,
} from "./tool-servers-model.ts";

/** Where the page is. */
export type ToolServersView =
	| { readonly name: "list" }
	| { readonly name: "add" }
	| { readonly name: "server"; readonly serverId: string };

export interface ToolServersPageProps {
	readonly source: ToolServersSource;
	/** The organisation's name, for its servers' scope. */
	readonly organisation: string;
	/** The projects a server may belong to, by name. */
	readonly projects: readonly ToolServerProject[];
	/** A project's page: its own servers and the organisation's, and a new one is the project's. */
	readonly project?: ToolServerProject;
	/** Kantel's address, as the tunnel command names it: `https://harbour.example.com`. */
	readonly origin: string;
	/** A fixed time, for stories. */
	readonly now?: number;
	/** The view, when the host keeps it in its address. */
	readonly view?: ToolServersView;
	readonly onViewChange?: (view: ToolServersView) => void;
	/** Where to start, when the page keeps its own view. */
	readonly initialView?: ToolServersView;
	/** A server just added, its token on screen: for stories. */
	readonly initialCreated?: CreatedToolServer;
	/** Whether the page has its own heading. */
	readonly heading?: boolean;
}

const pageFrame =
	"kt-tool-servers-page flex w-full max-w-[calc(var(--kt-content-width)_+_var(--kt-sidebar-width))] min-w-0 flex-col gap-5 text-sm leading-normal text-fg";

export function ToolServersPage({
	source,
	organisation,
	projects,
	project,
	origin,
	now: fixedNow,
	view: controlled,
	onViewChange,
	initialView = { name: "list" },
	initialCreated,
	heading = true,
}: ToolServersPageProps) {
	const [own, setOwn] = useState<ToolServersView>(initialView);
	const view = controlled ?? own;
	const [notice, setNotice] = useState<string>();
	const go = useCallback(
		(next: ToolServersView) => {
			setOwn(next);
			onViewChange?.(next);
		},
		[onViewChange],
	);
	const now = fixedNow ?? Date.now();
	const back = () => go({ name: "list" });

	let body: ReactNode;
	if (view.name === "add") {
		body = (
			<>
				<Trail current="Add tool server" onBack={back} />
				{heading ? (
					<PageHeader
						title="Add tool server"
						lede="An MCP server for your agents' tools. Kantel gives each tool to the model as the server describes it."
					/>
				) : null}
				<AddToolServer
					organisation={organisation}
					projects={projects}
					project={project}
					origin={origin}
					onCreate={(input) => source.create(input)}
					onDone={(server) => go({ name: "server", serverId: server.id })}
					onCancel={back}
					initialCreated={initialCreated}
				/>
			</>
		);
	} else if (view.name === "server") {
		body = (
			<ServerView
				key={view.serverId}
				serverId={view.serverId}
				source={source}
				organisation={organisation}
				projects={projects}
				origin={origin}
				now={now}
				heading={heading}
				onBack={back}
				onRemoved={(server) => {
					setNotice(`Removed ${server.name}. Its tokens no longer work.`);
					back();
				}}
			/>
		);
	} else {
		body = (
			<>
				{heading ? (
					<PageHeader
						title="Tool servers"
						{...(project === undefined
							? {}
							: { lede: `The ${project.name} project's own tool servers, and ${organisation}'s.` })}
						actions={
							<Button
								variant="primary"
								icon={<PlusIcon size="sm" />}
								onClick={() => {
									setNotice(undefined);
									go({ name: "add" });
								}}
							>
								Add tool server
							</Button>
						}
					/>
				) : null}
				{notice === undefined ? null : (
					<Notice
						level="info"
						action={
							<Button size="xs" variant="ghost" onClick={() => setNotice(undefined)}>
								Dismiss
							</Button>
						}
					>
						{notice}
					</Notice>
				)}
				<ServerList
					source={source}
					organisation={organisation}
					projects={projects}
					project={project}
					now={now}
					onOpen={(server) => {
						setNotice(undefined);
						go({ name: "server", serverId: server.id });
					}}
					onAdd={() => go({ name: "add" })}
				/>
			</>
		);
	}

	return <div className={pageFrame}>{body}</div>;
}

/** The way back to the list, above an add form or a server. */
function Trail({ current, onBack }: { current: string; onBack: () => void }) {
	return (
		<nav aria-label="Breadcrumb">
			<ol className="m-0 flex list-none items-center gap-1.5 p-0 text-xs text-muted">
				<li>
					<button
						type="button"
						onClick={onBack}
						className="kt-focusable m-0 cursor-pointer rounded-xs border-0 bg-transparent p-0 text-muted hover:text-fg hover:underline"
					>
						Tool servers
					</button>
				</li>
				<li aria-hidden="true" className="flex text-faint">
					<ChevronRightIcon size="sm" />
				</li>
				<li aria-current="page" className="min-w-0 truncate text-fg">
					{current}
				</li>
			</ol>
		</nav>
	);
}

/** A line of facts about a server, wrapping between them. */
const rowMeta = "m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted";

function ServerList({
	source,
	organisation,
	projects,
	project,
	now,
	onOpen,
	onAdd,
}: {
	source: ToolServersSource;
	organisation: string;
	projects: readonly ToolServerProject[];
	project: ToolServerProject | undefined;
	now: number;
	onOpen: (server: ToolServer) => void;
	onAdd: () => void;
}) {
	const projectId = project?.id;
	const servers = useLoad(() => source.list(projectId === undefined ? undefined : { projectId }), [source, projectId]);
	const ids = servers.state.status === "ready" ? servers.state.value.map((server) => server.id) : [];
	const idsKey = ids.join(",");
	const stats = useLoad(
		async (): Promise<Readonly<Record<string, ToolServerStats>> | undefined> =>
			ids.length === 0 || source.stats === undefined ? undefined : source.stats(ids),
		[source, idsKey],
	);
	const statsFor = (id: string) => (stats.state.status === "ready" ? stats.state.value?.[id] : undefined);

	if (servers.state.status === "error")
		return (
			<Notice
				level="error"
				action={
					<Button size="xs" onClick={servers.reload}>
						Try again
					</Button>
				}
			>
				Kantel couldn't read the tool servers. Check your connection and try again.
			</Notice>
		);
	if (servers.state.status === "loading")
		return (
			<div className="flex flex-col gap-5 rounded-panel border border-border bg-panel p-3" aria-busy="true">
				<span className="kt-sr-only">Loading tool servers</span>
				<Skeleton lines={2} />
				<Skeleton lines={2} />
				<Skeleton lines={2} />
			</div>
		);
	const list = servers.state.value;
	if (list.length === 0)
		return (
			<EmptyState
				title="No tool servers yet"
				action={
					<Button variant="primary" icon={<PlusIcon size="sm" />} onClick={onAdd}>
						Add tool server
					</Button>
				}
			>
				Add an MCP server and your agents can call its tools. A private one connects through a tunnel it opens to
				Kantel, so nothing on your side is exposed and its credentials stay with you.
			</EmptyState>
		);

	return (
		<ul
			className="m-0 flex list-none flex-col divide-y divide-border rounded-panel border border-border bg-panel p-0"
			aria-label="Tool servers"
		>
			{list.map((server) => {
				const state = toolServerState(server.connection);
				const day = statsText(statsFor(server.id));
				return (
					<li key={server.id} className="min-w-0">
						<button
							type="button"
							onClick={() => onOpen(server)}
							className="kt-focusable flex w-full min-w-0 cursor-pointer flex-wrap items-start justify-between gap-x-4 gap-y-1.5 rounded-panel border-0 bg-transparent px-3 py-2.5 text-left text-fg hover:bg-hover"
						>
							<span className="flex min-w-0 flex-[1_1_var(--kt-sidebar-width)] flex-col gap-1">
								<span className="text-md font-medium wrap-anywhere">{server.name}</span>
								<span className={rowMeta}>
									<span className="inline-flex min-w-0 items-center gap-1">
										<span className="flex text-faint">
											{server.projectId === undefined ? <OrganisationIcon size="sm" /> : <ProjectIcon size="sm" />}
										</span>
										{toolServerScopeText(server, organisation, projects)}
									</span>
									<span>{TRANSPORT_LABELS[server.transport]}</span>
									<span>{toolCountText(server)}</span>
								</span>
							</span>
							<span className="flex min-w-0 flex-none flex-col items-end gap-1 max-sm:items-start">
								<StatusLabel status={TOOL_SERVER_STATE_STATUS[state]}>
									{toolServerStatusText(server.connection, now)}
								</StatusLabel>
								{day === undefined ? null : <span className="text-xs text-faint tabular-nums">{day}</span>}
							</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}

function ServerView({
	serverId,
	source,
	organisation,
	projects,
	origin,
	now,
	heading,
	onBack,
	onRemoved,
}: {
	serverId: string;
	source: ToolServersSource;
	organisation: string;
	projects: readonly ToolServerProject[];
	origin: string;
	now: number;
	heading: boolean;
	onBack: () => void;
	onRemoved: (server: ToolServer) => void;
}) {
	const server = useLoad(() => source.get(serverId), [source, serverId]);
	const found = server.state.status === "ready" ? server.state.value : undefined;
	return (
		<>
			<Trail current={found?.name ?? "Tool server"} onBack={onBack} />
			{server.state.status === "error" ? (
				<Notice
					level="error"
					action={
						<Button size="xs" onClick={server.reload}>
							Try again
						</Button>
					}
				>
					Kantel couldn't read this tool server. It may have been removed, or the connection dropped.
				</Notice>
			) : found === undefined ? (
				<div className="flex max-w-content flex-col gap-4" aria-busy="true">
					<span className="kt-sr-only">Loading the tool server</span>
					<Skeleton width="30%" />
					<Skeleton lines={3} />
				</div>
			) : (
				<>
					{heading ? <PageHeader title={found.name} lede={found.description} /> : null}
					<ToolServerDetail
						server={found}
						source={source}
						organisation={organisation}
						projects={projects}
						origin={origin}
						now={now}
						onRemoved={onRemoved}
					/>
				</>
			)}
		</>
	);
}

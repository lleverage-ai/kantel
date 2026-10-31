// The Tool servers page's model (docs/design/private-mcp-tools.md, section 1): the calls the page makes, and the words
// and commands it shows. The records are @harbour/contracts' (`ToolServer`, `ToolServerTools`, `ToolServerToken`); the
// console binds `ToolServersSource` to `/v1/tool-servers`, stories and the recorded console to fixtures.
//
// A tunnel token's secret is in a `CreatedToolServer` or an `IssuedToolServerToken` once, when it is made, and nowhere
// else: the page shows it, then forgets it.

import type {
	CreatedToolServer,
	CreateToolServerInput,
	IssuedToolServerToken,
	ProjectId,
	ReplayPolicy,
	ToolServer,
	ToolServerConnection,
	ToolServerFilter,
	ToolServerId,
	ToolServerToken,
	ToolServerTokenId,
	ToolServerTools,
	ToolServerTransport,
} from "@harbour/contracts";
import { compactAge } from "../primitives/format.ts";
import type { Status } from "../tokens/tokens.ts";

/** A server's calls over the last day, for the list. */
export interface ToolServerStats {
	readonly calls24h: number;
	/** The median call's duration, absent with no calls. */
	readonly p50Ms?: number;
}

/** How a call ended: the server answered, answered with an error, or wasn't connected to answer. */
export type ToolServerCallOutcome = "ok" | "error" | "offline";

/** One call to a server's tool, from the audit log's `session.tool.started` and `session.tool.finished`. */
export interface ToolServerCall {
	readonly callId: string;
	readonly sessionId: string;
	readonly sessionTitle?: string;
	/** The server's own name for the tool. */
	readonly tool: string;
	readonly startedAt: number;
	/** Absent while the call runs. */
	readonly durationMs?: number;
	readonly outcome: ToolServerCallOutcome;
}

/** The calls the page makes, bound to the viewer by the host. */
export interface ToolServersSource {
	/** The servers the viewer may read, by name; with a project, its own and the organisation's. */
	list(filter?: ToolServerFilter): Promise<readonly ToolServer[]>;
	/** A tunnel server comes with its first token. */
	create(input: CreateToolServerInput): Promise<CreatedToolServer>;
	get(id: ToolServerId): Promise<ToolServer>;
	tools(id: ToolServerId): Promise<ToolServerTools>;
	/** Turns one tool on or off for new sessions; the host does it with the update's `disabledTools`. */
	setToolEnabled(id: ToolServerId, tool: string, enabled: boolean): Promise<void>;
	createToken(id: ToolServerId): Promise<IssuedToolServerToken>;
	listTokens(id: ToolServerId): Promise<readonly ToolServerToken[]>;
	revokeToken(id: ToolServerId, tokenId: ToolServerTokenId): Promise<void>;
	remove(id: ToolServerId): Promise<void>;
	/** Calls and latency over the last day, by server. Without it the list leaves them out. */
	stats?(ids: readonly ToolServerId[]): Promise<Readonly<Record<ToolServerId, ToolServerStats>>>;
	/** The server's latest calls, newest first. */
	recentCalls(id: ToolServerId): Promise<readonly ToolServerCall[]>;
	/** The audit view filtered to the server, for Open in audit. */
	auditHref(id: ToolServerId): string;
}

/** A project a server may belong to, by name. */
export interface ToolServerProject {
	readonly id: ProjectId;
	readonly name: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Words

/** Where the server's side is: connected now, offline after it was, or never connected. */
export type ToolServerState = "connected" | "offline" | "never";

export function toolServerState(connection: ToolServerConnection): ToolServerState {
	if (connection.status === "connected") return "connected";
	return connection.lastSeenAt === undefined && connection.connectedAt === undefined ? "never" : "offline";
}

/** The status colour for each state: offline is worth a look, not an error (a run's worker stops between runs). */
export const TOOL_SERVER_STATE_STATUS: Readonly<Record<ToolServerState, Status>> = {
	connected: "done",
	offline: "approval",
	never: "idle",
};

/** "Connected", "Offline, last seen 2h ago", "Not connected yet". */
export function toolServerStatusText(connection: ToolServerConnection, now: number): string {
	switch (toolServerState(connection)) {
		case "connected":
			return "Connected";
		case "never":
			return "Not connected yet";
		case "offline": {
			if (connection.lastSeenAt === undefined) return "Offline";
			const age = compactAge(connection.lastSeenAt, now);
			return age === "now" ? "Offline, last seen just now" : `Offline, last seen ${age} ago`;
		}
	}
}

export const TRANSPORT_LABELS: Readonly<Record<ToolServerTransport, string>> = {
	tunnel: "Tunnel",
	http: "HTTP",
	callback: "Callback",
};

/** Who owns the server: the organisation, by name ("Acme"), or a project ("Sal project"). */
export function toolServerScopeText(
	server: Pick<ToolServer, "projectId">,
	organisation: string,
	projects: readonly ToolServerProject[],
): string {
	if (server.projectId === undefined) return organisation;
	const project = projects.find((candidate) => candidate.id === server.projectId);
	return `${project?.name ?? server.projectId} project`;
}

/** "Read-only" for a tool safe to run again, "Idempotent", or "Unsafe": Harbour never reruns it. */
export const REPLAY_LABELS: Readonly<Record<ReplayPolicy, string>> = {
	safe: "Read-only",
	idempotent: "Idempotent",
	unsafe: "Unsafe",
};

/** How many tools the server listed: "6 tools", "1 tool", or "No tools yet" before it has connected. */
export function toolCountText(server: Pick<ToolServer, "snapshot">): string {
	const count = server.snapshot?.tools.length;
	if (count === undefined) return "No tools yet";
	return count === 1 ? "1 tool" : `${count} tools`;
}

/** "180 ms", "1.2 s". */
export function latencyText(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)} ms`;
	return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** A day's calls and their median, for the list: "140 calls, p50 180 ms", "No calls in the last day". */
export function statsText(stats: ToolServerStats | undefined): string | undefined {
	if (stats === undefined) return undefined;
	if (stats.calls24h === 0) return "No calls in the last day";
	const calls = stats.calls24h === 1 ? "1 call" : `${stats.calls24h.toLocaleString("en-GB")} calls`;
	return stats.p50Ms === undefined ? calls : `${calls}, p50 ${latencyText(stats.p50Ms)}`;
}

export const CALL_OUTCOME_LABELS: Readonly<Record<ToolServerCallOutcome, string>> = {
	ok: "Done",
	error: "Error",
	offline: "Offline",
};

export const CALL_OUTCOME_STATUS: Readonly<Record<ToolServerCallOutcome, Status>> = {
	ok: "done",
	error: "error",
	offline: "approval",
};

// ---------------------------------------------------------------------------------------------------------------------
// The tunnel

/** The loopback Streamable HTTP endpoint the command's `--url` form shows. */
export const TUNNEL_LOOPBACK_URL = "http://127.0.0.1:8123/mcp";

/** The placeholder for the person's own stdio server command. */
export const TUNNEL_STDIO_PLACEHOLDER = "<your stdio MCP server command>";

/** What the tunnel bridges to on the person's side: a stdio server it starts, or a loopback HTTP one already running. */
export type TunnelTarget = "stdio" | "url";

/**
 * The command that connects a server: `npx @harbour/tunnel --harbour <origin> --server <id> --token <hbt_…>`, then
 * `-- <your stdio MCP server command>` or `--url http://127.0.0.1:8123/mcp`.
 */
export function tunnelCommand(origin: string, serverId: ToolServerId, token: string, target: TunnelTarget): string {
	const base = `npx @harbour/tunnel --harbour ${origin.replace(/\/+$/, "")} --server ${serverId} --token ${token}`;
	return target === "stdio" ? `${base} -- ${TUNNEL_STDIO_PLACEHOLDER}` : `${base} --url ${TUNNEL_LOOPBACK_URL}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tokens

/** Tokens newest first. */
export function sortTokens(tokens: readonly ToolServerToken[]): readonly ToolServerToken[] {
	return [...tokens].sort((a, b) => b.createdAt - a.createdAt);
}

/** "Last used 3h ago", "Never used". */
export function tokenUsedText(token: ToolServerToken, now: number): string {
	if (token.lastUsedAt === undefined) return "Never used";
	const age = compactAge(token.lastUsedAt, now);
	return age === "now" ? "Last used just now" : `Last used ${age} ago`;
}

/** The tokens a rotation leaves behind: every one but the new token. */
export function olderTokens(tokens: readonly ToolServerToken[], kept: ToolServerTokenId): readonly ToolServerToken[] {
	return tokens.filter((token) => token.id !== kept);
}

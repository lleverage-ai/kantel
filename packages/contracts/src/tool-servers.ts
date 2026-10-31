/**
 * Tool servers (docs/design/private-mcp-tools.md): MCP servers Kantel calls for tools, owned by an organisation or by
 * one of its projects. A private server is reached through a Kantel tunnel: a client on the user's side (the
 * `@kantel/tunnel` command, or the SDK in-process) dials out over a WebSocket, which one Durable Object per server
 * holds on Cloudflare and the gateway holds self-hosted, and MCP JSON-RPC rides that socket. Public MCP over HTTPS
 * (`http`) and today's signed host callbacks (`callback`) are the other two transports of the same record; phase 1
 * builds `tunnel` only.
 *
 * Phase 1 is experimental: a deployment turns it on with `KANTEL_TOOL_SERVERS=experimental` (`toolServersEnabled`).
 *
 * Rules every implementation keeps:
 * - Kantel adds no prompt text: each tool's name, description and input schema go to the model as the server gave
 *   them, under the name `<server>__<tool>`.
 * - A tunnel token is shown once, when it is made, and stored hashed. No read, list, event or log carries it.
 * - Calls are made by the runtime, outside the sandbox. No credential of the server's ever reaches Kantel, and none of
 *   Kantel's reaches the server.
 * - A session keeps the tools it was first offered from a server (its pin), so a changed `tools/list` reaches new
 *   sessions only.
 */
import type {
	Actor,
	CallContext,
	JsonSchema,
	OrganisationId,
	OwnerRef,
	Page,
	PageRequest,
	ProjectId,
	ReplayPolicy,
	Timestamp,
} from "./common.ts";

/** A tool server's ID, `ts_…`. */
export type ToolServerId = string;
/** A tunnel token's ID, `tst_…`. The token itself is `hbt_…`. */
export type ToolServerTokenId = string;

/** How Kantel reaches a tool server. Phase 1 builds `tunnel`. */
export type ToolServerTransport =
	/** The server's side dials out to Kantel over a WebSocket and MCP JSON-RPC rides it. */
	| "tunnel"
	/** Streamable HTTP to a public URL, with a vault credential (phase 2). */
	| "http"
	/** Today's signed HTTPS host callbacks (phase 3). */
	| "callback";

/** Who owns a tool server: an organisation, or a project inside it whose sessions alone see it. */
export type ToolServerOwner = Extract<OwnerRef, { readonly kind: "organisation" | "project" }>;

/** The deployment switch, an environment variable on both targets. */
export const TOOL_SERVERS_SWITCH = "KANTEL_TOOL_SERVERS";

/** Whether the switch's value turns tool servers on: only `experimental` does, while they are. */
export function toolServersEnabled(value: string | undefined): boolean {
	return value?.trim().toLowerCase() === "experimental";
}

/** MCP's tool annotations, as the server gave them. Hints only: they are never trusted for access. */
export interface ToolServerToolAnnotations {
	readonly title?: string;
	readonly readOnlyHint?: boolean;
	readonly destructiveHint?: boolean;
	readonly idempotentHint?: boolean;
	readonly openWorldHint?: boolean;
}

/** One tool as the server listed it in `tools/list`. */
export interface ToolServerTool {
	/** The server's own name for it, as `tools/call` takes it. */
	readonly name: string;
	readonly description: string;
	readonly inputSchema: JsonSchema;
	readonly annotations?: ToolServerToolAnnotations;
	/** From the annotations: `readOnlyHint: true` is `safe`, anything else `unsafe`. */
	readonly replay: ReplayPolicy;
}

/** A server's tools as Kantel last took them, on connect and whenever the server says they changed. */
export interface ToolServerSnapshot {
	readonly tools: readonly ToolServerTool[];
	/** `sha256:<hex>` of the tools' canonical JSON, so a change is one comparison. */
	readonly hash: string;
	readonly takenAt: Timestamp;
}

/** Whether the server's side is connected now. */
export interface ToolServerConnection {
	readonly status: "connected" | "offline";
	/** When the current connection opened. */
	readonly connectedAt?: Timestamp;
	/** The last time Kantel heard from the server (a message, a ping), connected or not. */
	readonly lastSeenAt?: Timestamp;
	/** What the server said about itself in `initialize`. */
	readonly serverInfo?: { readonly name: string; readonly version?: string };
}

export interface ToolServer {
	readonly id: ToolServerId;
	readonly organisationId: OrganisationId;
	/** The owning project; absent for a server the organisation owns, which every project may use. */
	readonly projectId?: ProjectId;
	/**
	 * A slug, unique in the organisation (so a session never sees two servers of one name, its project's and the
	 * organisation's): lower-case letters, digits and single hyphens, at most `TOOL_SERVER_NAME_MAX` characters. It is
	 * the `<server>` in tool names, and can't be changed.
	 */
	readonly name: string;
	/** What it is for, for people; never sent to a model. */
	readonly description?: string;
	readonly transport: ToolServerTransport;
	/** The latest snapshot; absent until the server has connected once. */
	readonly snapshot?: ToolServerSnapshot;
	/** Tools sessions are not offered. Every other tool in the snapshot is enabled, a new one included. */
	readonly disabledTools: readonly string[];
	readonly connection: ToolServerConnection;
	readonly createdBy: Actor;
	readonly createdAt: Timestamp;
	readonly updatedAt: Timestamp;
}

/** A tunnel token as reads show it: never the token itself. */
export interface ToolServerToken {
	readonly id: ToolServerTokenId;
	readonly toolServerId: ToolServerId;
	/** The token's first characters (`hbt_` and four more), to tell tokens apart. */
	readonly prefix: string;
	readonly createdBy: Actor;
	readonly createdAt: Timestamp;
	readonly lastUsedAt?: Timestamp;
}

/** A token just made: the only time `secret` is given. */
export interface IssuedToolServerToken {
	readonly token: ToolServerToken;
	/** `hbt_…`. Shown once; Kantel keeps only its hash. */
	readonly secret: string;
}

/** The prefix every tunnel token starts with. */
export const TUNNEL_TOKEN_PREFIX = "hbt_";

export interface CreateToolServerInput {
	/** The owning project; absent for an organisation-owned server. */
	readonly projectId?: ProjectId;
	readonly name: string;
	readonly description?: string;
	/** Phase 1 accepts `tunnel` only. */
	readonly transport: ToolServerTransport;
}

/** A tunnel server is made with its first token. */
export interface CreatedToolServer {
	readonly server: ToolServer;
	readonly token?: IssuedToolServerToken;
}

/** What to change about a server. Each field left out is left as it is. */
export interface ToolServerUpdate {
	readonly description?: string;
	/** Replaces the disabled list. */
	readonly disabledTools?: readonly string[];
}

export interface ToolServerFilter {
	/** Only this project's servers and the organisation's (what its sessions could see). */
	readonly projectId?: ProjectId;
}

/** One tool of a server's snapshot, with what a session would see. */
export interface ToolServerToolView extends ToolServerTool {
	readonly enabled: boolean;
	/** `<server>__<tool>`: the name the model sees. */
	readonly modelName: string;
	/** Why a session can't be offered it although it may be enabled, such as a name too long; absent when it can. */
	readonly unavailableReason?: string;
}

export interface ToolServerTools {
	readonly toolServerId: ToolServerId;
	readonly hash?: string;
	readonly takenAt?: Timestamp;
	readonly tools: readonly ToolServerToolView[];
}

/**
 * The registry. Reading needs viewer on the owner (the project, or the organisation for an organisation-owned
 * server); creating, changing and removing need admin on it; making and revoking tokens needs operator. Another
 * organisation's server is `not_found`.
 */
export interface ToolServers {
	create(ctx: CallContext, input: CreateToolServerInput): Promise<CreatedToolServer>;
	get(ctx: CallContext, id: ToolServerId): Promise<ToolServer>;
	/** Servers the caller may read, by name. */
	list(ctx: CallContext, filter?: ToolServerFilter, page?: PageRequest): Promise<Page<ToolServer>>;
	update(ctx: CallContext, id: ToolServerId, change: ToolServerUpdate): Promise<ToolServer>;
	/** Removes the server and its tokens, and closes its tunnel. */
	remove(ctx: CallContext, id: ToolServerId): Promise<void>;
	/** A new tunnel token. Older ones keep working until revoked. */
	createToken(ctx: CallContext, id: ToolServerId): Promise<IssuedToolServerToken>;
	listTokens(ctx: CallContext, id: ToolServerId): Promise<readonly ToolServerToken[]>;
	/** Revokes a token and closes any tunnel it opened. */
	revokeToken(ctx: CallContext, id: ToolServerId, tokenId: ToolServerTokenId): Promise<void>;
	/** The latest snapshot, with what is enabled. */
	tools(ctx: CallContext, id: ToolServerId): Promise<ToolServerTools>;
}

// Names.

/** The longest server name. */
export const TOOL_SERVER_NAME_MAX = 32;
const SERVER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Why `name` can't be a tool server's name, or undefined when it can. */
export function toolServerNameProblem(name: string): string | undefined {
	if (name.length === 0 || name.length > TOOL_SERVER_NAME_MAX) {
		return `A tool server's name is 1 to ${TOOL_SERVER_NAME_MAX} characters`;
	}
	if (!SERVER_NAME.test(name)) return "A tool server's name is lower-case letters, digits and single hyphens";
	return undefined;
}

/** Between the server and the tool in the name the model sees. */
export const TOOL_SERVER_TOOL_SEPARATOR = "__";

/**
 * The longest name the model may see for a server's tool. Anthropic allows 64 characters, and the model gateway sends
 * each tool to CLIProxyAPI as `mcp__harbour__<name>` (`KANTEL_TOOL_NAMESPACE` in `@kantel/models`), so a name longer
 * than 64 less those 14 would reach the model under an alias. A test in `@kantel/models` keeps the two in step.
 */
export const TOOL_SERVER_MODEL_NAME_MAX = 50;
const MODEL_NAME = /^[A-Za-z0-9_-]+$/;

/** The name the model sees for `tool` of `server`. */
export function toolServerModelName(server: string, tool: string): string {
	return `${server}${TOOL_SERVER_TOOL_SEPARATOR}${tool}`;
}

/** Why the model can't be given `tool` of `server` by name, or undefined when it can. */
export function toolServerModelNameProblem(server: string, tool: string): string | undefined {
	const name = toolServerModelName(server, tool);
	if (!MODEL_NAME.test(tool)) return `${name}: a tool's name is letters, digits, "_" and "-"`;
	if (name.length > TOOL_SERVER_MODEL_NAME_MAX) {
		return `${name} is ${name.length} characters; a tool server's tool is at most ${TOOL_SERVER_MODEL_NAME_MAX} with its server's name`;
	}
	return undefined;
}

/** A profile's `tools` entry naming a server's tool (`<server>/<tool>`) or all of them (`<server>/*`). */
export interface ToolServerEntry {
	readonly server: string;
	/** A tool's name, or `*` for every enabled tool. */
	readonly tool: string;
}

/** The entry `entry` names, or undefined for a plain tool name (one without `/`). */
export function parseToolServerEntry(entry: string): ToolServerEntry | undefined {
	const slash = entry.indexOf("/");
	if (slash === -1) return undefined;
	return { server: entry.slice(0, slash), tool: entry.slice(slash + 1) };
}

/**
 * Why a profile's `tools` entries can't be saved, one line each; empty when they can. Checks the tool-server entries
 * only: a well-formed server name, a tool, and a model name within `TOOL_SERVER_MODEL_NAME_MAX`. A `<server>/*`
 * entry's tools aren't known until the server lists them, so one whose name is too long is left out of the session
 * then, and the server's tools view says why.
 */
export function toolServerEntryProblems(tools: readonly string[]): readonly string[] {
	const problems: string[] = [];
	for (const entry of tools) {
		const parsed = parseToolServerEntry(entry);
		if (parsed === undefined) continue;
		const serverProblem = toolServerNameProblem(parsed.server);
		if (serverProblem !== undefined) {
			problems.push(`${entry}: ${serverProblem}`);
			continue;
		}
		if (parsed.tool === "*") continue;
		if (parsed.tool === "") {
			problems.push(`${entry}: name a tool, or * for all of them`);
			continue;
		}
		const nameProblem = toolServerModelNameProblem(parsed.server, parsed.tool);
		if (nameProblem !== undefined) problems.push(nameProblem);
	}
	return problems;
}

/** Whether a profile's entries name `tool` of `server`. */
export function entriesInclude(tools: readonly string[], server: string, tool: string): boolean {
	return tools.includes(`${server}/*`) || tools.includes(`${server}/${tool}`);
}

/** The server names a profile's entries mention, once each. */
export function entryServers(tools: readonly string[]): readonly string[] {
	const servers = new Set<string>();
	for (const entry of tools) {
		const parsed = parseToolServerEntry(entry);
		if (parsed !== undefined) servers.add(parsed.server);
	}
	return [...servers];
}

/** The replay class MCP annotations give a tool: `readOnlyHint: true` is `safe`, anything else `unsafe`. */
export function replayOf(annotations: ToolServerToolAnnotations | undefined): ReplayPolicy {
	return annotations?.readOnlyHint === true ? "safe" : "unsafe";
}

// Calls.

/**
 * The `_meta` keys each `tools/call` carries, the same fields as a `HostToolCall`, so a server can key an unsafe tool's
 * effects by the call and enforce its own rules.
 */
export const TOOL_SERVER_META = {
	sessionId: "harbour/sessionId",
	organisationId: "harbour/organisationId",
	projectId: "harbour/projectId",
	agentId: "harbour/agentId",
	/** Stable across retries of the same call. */
	callId: "harbour/callId",
} as const;

/** How long a tool call may take before Kantel gives up on it: ten minutes, as for host tools. */
export const TOOL_SERVER_CALL_TIMEOUT_MS = 10 * 60_000;

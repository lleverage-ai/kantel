/**
 * The tool servers registry (`ToolServers` in `@harbour/contracts`), with the system calls the holder of the tunnels
 * makes: checking a token before an upgrade, and keeping each server's connection and snapshot on its record.
 *
 * Access is `ProjectAccess` on the owner (the project, or the organisation for a server it owns): viewer to read, admin
 * to create, change and remove, operator to make and revoke tokens. Another organisation's server is `not_found`. An
 * agent never manages servers or tokens, whatever its role: a token opens the tunnel, and whoever holds the tunnel
 * answers the server's tool calls.
 *
 * A token is shown once, in the answer that makes it; the record keeps its SHA-256 and nothing reads it back. No audit
 * event carries one.
 */
import {
	type Actor,
	type AuditEventInput,
	type AuditEventType,
	type AuditSink,
	type CallContext,
	type Clock,
	type CreatedToolServer,
	type CreateToolServerInput,
	HarbourError,
	type IssuedToolServerToken,
	type JsonValue,
	type Page,
	type PageRequest,
	type ProjectAccess,
	type Role,
	type SessionRecord,
	systemClock,
	systemContext,
	type Timestamp,
	type ToolServer,
	type ToolServerFilter,
	type ToolServerId,
	type ToolServerSnapshot,
	type ToolServers,
	type ToolServerToken,
	type ToolServerTokenId,
	type ToolServerTools,
	type ToolServerUpdate,
	TUNNEL_TOKEN_PREFIX,
	toolServerModelName,
	toolServerModelNameProblem,
	toolServerNameProblem,
} from "@harbour/contracts";
import type { ToolServerRef, TunnelLinks } from "./links.ts";
import type { McpServerInfo } from "./mcp-client.ts";
import { TUNNEL_CLOSE_SERVER_REMOVED, TUNNEL_CLOSE_TOKEN_REVOKED } from "./protocol.ts";
import type { ToolServerRepository } from "./repository.ts";

/** A token the tunnel's upgrade was checked against: which server it opens, and with which token. */
export interface TunnelGrant extends ToolServerRef {
	readonly tokenId: ToolServerTokenId;
}

export interface TunnelConnected {
	readonly serverInfo: McpServerInfo | undefined;
	readonly snapshot: ToolServerSnapshot;
	readonly at: Timestamp;
}

export interface ToolServersService extends ToolServers {
	/**
	 * The grant a tunnel token gives for `serverId`, recording its use; undefined for no token or a wrong one. Rejects
	 * with `not_found` for an unknown server and `forbidden` for a token of another server, so the upgrade can answer
	 * 404 and 403 as the protocol says.
	 */
	authenticateTunnel(serverId: ToolServerId, secret: string): Promise<TunnelGrant | undefined>;
	/** The server initialised and listed its tools over a new tunnel. */
	connected(grant: TunnelGrant, info: TunnelConnected): Promise<void>;
	/** The server's tools changed while connected. */
	snapshotChanged(ref: ToolServerRef, snapshot: ToolServerSnapshot): Promise<void>;
	/** The server's tunnel closed. */
	disconnected(ref: ToolServerRef, at: Timestamp): Promise<void>;
	/**
	 * The servers named in `names` a session may use (`SessionToolServers.servers`): its organisation's, owned by the
	 * organisation or by the session's project. An organisation-scoped session sees organisation-owned ones only.
	 */
	forSession(record: SessionRecord, names: readonly string[]): Promise<readonly ToolServer[]>;
	/** The server as stored now, for a call; undefined once removed. */
	lookup(ref: ToolServerRef): Promise<ToolServer | undefined>;
}

export interface ToolServersOptions {
	readonly repository: ToolServerRepository;
	/** Late-bound, for a host that builds access after the runtime that needs this service. */
	readonly access: () => ProjectAccess;
	readonly audit?: AuditSink;
	readonly clock?: Clock;
	/** Whatever holds the tunnels, to close one on a removal or a revocation. */
	readonly links?: () => TunnelLinks | undefined;
	/** A server connected, disconnected or changed its tools: the runtime reinstalls the sessions that name it. */
	readonly onChange?: (organisationId: string, server: ToolServer) => void;
}

const SELF = systemContext("tool-servers");
const SYSTEM_ACTOR: Actor = SELF.actor;
const AGENT_REFUSAL = "An agent may not manage tool servers or their tokens";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/** How many times a change reads again after losing a race. */
const CHANGE_ATTEMPTS = 5;
/** The bytes of randomness in a token, after its prefix. */
const TOKEN_BYTES = 32;
/** How much of a token reads show: the prefix and four more characters. */
const TOKEN_PREFIX_LENGTH = TUNNEL_TOKEN_PREFIX.length + 4;

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const randomId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

/** A token's SHA-256, hex: what the record keeps. */
export async function hashTunnelToken(secret: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function optionalString(value: unknown, what: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new HarbourError("invalid", `${what} is a string`);
	return value;
}

function disabledToolsOf(value: unknown): readonly string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
		throw new HarbourError("invalid", "A server's disabled tools are a list of tool names");
	}
	return [...new Set(value as string[])];
}

export function createToolServers(options: ToolServersOptions): ToolServersService {
	const { repository: repo } = options;
	const clock = options.clock ?? systemClock;
	const access = () => options.access();

	const audit = async (
		actor: Actor,
		server: Pick<ToolServer, "id" | "organisationId" | "projectId">,
		type: AuditEventType,
		data?: { readonly [key: string]: JsonValue },
	) => {
		if (options.audit === undefined) return;
		const event: AuditEventInput = {
			id: `tool_server:${randomId("ev")}`,
			at: clock.now(),
			source: "tool_server",
			type,
			actor,
			organisationId: server.organisationId,
			...(server.projectId === undefined ? {} : { projectId: server.projectId }),
			subject: { kind: "tool_server", id: server.id },
			...(data === undefined ? {} : { data }),
		};
		try {
			await options.audit.append(SELF, [event]);
		} catch {
			// An audit outage never fails a registry change or a tunnel.
		}
	};

	const changed = (server: ToolServer) => {
		try {
			options.onChange?.(server.organisationId, server);
		} catch {
			// The runtime's to report; the record is saved.
		}
	};

	const ownerCheck = (server: Pick<ToolServer, "id" | "projectId">, needed: Role, operation: string) => ({
		...(server.projectId === undefined ? {} : { projectId: server.projectId }),
		needed,
		operation,
		subject: { kind: "tool_server", id: server.id },
	});

	const forbidAgent = (ctx: CallContext) => {
		if (ctx.actor.kind === "agent") throw new HarbourError("forbidden", AGENT_REFUSAL);
	};

	/** The caller's organisation's server, or `not_found`. */
	const load = async (ctx: CallContext, id: ToolServerId) => {
		const stored = await repo.get(id);
		if (stored === undefined || stored.server.organisationId !== ctx.organisationId) {
			throw new HarbourError("not_found", `No tool server ${id}`);
		}
		return stored;
	};

	const readable = async (ctx: CallContext, id: ToolServerId, operation: string) => {
		const { server } = await load(ctx, id);
		await access().require(ctx, ownerCheck(server, "viewer", operation));
		return server;
	};

	/**
	 * Applies `apply` to the stored server, reading again when another change won the race. `apply` returning undefined
	 * leaves it as it is. Resolves undefined when the server is gone.
	 */
	const change = async (
		id: ToolServerId,
		apply: (server: ToolServer) => ToolServer | undefined,
	): Promise<{ readonly before: ToolServer; readonly after: ToolServer } | undefined> => {
		for (let attempt = 0; attempt < CHANGE_ATTEMPTS; attempt += 1) {
			const stored = await repo.get(id);
			if (stored === undefined) return undefined;
			const next = apply(stored.server);
			if (next === undefined) return { before: stored.server, after: stored.server };
			if (await repo.update(next, stored.revision)) return { before: stored.server, after: next };
		}
		throw new HarbourError("conflict", "The tool server kept changing while this was saved; try again");
	};

	const issueToken = async (actor: Actor, server: ToolServer): Promise<IssuedToolServerToken> => {
		const secret = `${TUNNEL_TOKEN_PREFIX}${base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))}`;
		const token: ToolServerToken = {
			id: randomId("tst"),
			toolServerId: server.id,
			prefix: secret.slice(0, TOKEN_PREFIX_LENGTH),
			createdBy: actor,
			createdAt: clock.now(),
		};
		await repo.insertToken({ token, organisationId: server.organisationId, hash: await hashTunnelToken(secret) });
		await audit(actor, server, "tool_server.token.created", { tokenId: token.id, prefix: token.prefix });
		return { token, secret };
	};

	const snapshotEvent = (actor: Actor, server: ToolServer, before: ToolServer, snapshot: ToolServerSnapshot) =>
		audit(actor, server, "tool_server.tools.changed", {
			...(before.snapshot === undefined ? {} : { oldHash: before.snapshot.hash }),
			newHash: snapshot.hash,
			tools: snapshot.tools.length,
		});

	return {
		async create(ctx: CallContext, input: CreateToolServerInput): Promise<CreatedToolServer> {
			forbidAgent(ctx);
			if (typeof input !== "object" || input === null) throw new HarbourError("invalid", "A tool server is an object");
			const name = typeof input.name === "string" ? input.name : "";
			const nameProblem = toolServerNameProblem(name);
			if (nameProblem !== undefined) throw new HarbourError("invalid", nameProblem);
			if (input.transport !== "tunnel") {
				throw new HarbourError("invalid", "Only tunnel tool servers can be registered yet");
			}
			const projectId = optionalString(input.projectId, "A tool server's project");
			const description = optionalString(input.description, "A tool server's description");
			const id = randomId("ts");
			await access().require(
				ctx,
				ownerCheck({ id, ...(projectId === undefined ? {} : { projectId }) }, "admin", "tool_server.create"),
			);
			const now = clock.now();
			const server: ToolServer = {
				id,
				organisationId: ctx.organisationId,
				...(projectId === undefined ? {} : { projectId }),
				name,
				...(description === undefined ? {} : { description }),
				transport: input.transport,
				disabledTools: [],
				connection: { status: "offline" },
				createdBy: ctx.actor,
				createdAt: now,
				updatedAt: now,
			};
			if (!(await repo.insert(server))) {
				throw new HarbourError("conflict", `The organisation already has a tool server named ${name}`);
			}
			await audit(ctx.actor, server, "tool_server.created", { name, transport: server.transport });
			const token = await issueToken(ctx.actor, server);
			return { server, token };
		},

		get: (ctx, id) => readable(ctx, id, "tool_server.read"),

		async list(ctx: CallContext, filter?: ToolServerFilter, page?: PageRequest): Promise<Page<ToolServer>> {
			const limit = Math.min(Math.max(1, Math.floor(page?.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
			const projectId = filter?.projectId;
			const cursor = page?.cursor;
			const visible: ToolServer[] = [];
			const seeOrganisation = await access().allows(ctx, { needed: "viewer" });
			const seeProject = new Map<string, boolean>();
			for (const { server } of await repo.list(ctx.organisationId)) {
				if (cursor !== undefined && server.name <= cursor) continue;
				if (projectId !== undefined && server.projectId !== undefined && server.projectId !== projectId) continue;
				let allowed = seeOrganisation;
				if (server.projectId !== undefined) {
					let known = seeProject.get(server.projectId);
					if (known === undefined) {
						known = await access().allows(ctx, { projectId: server.projectId, needed: "viewer" });
						seeProject.set(server.projectId, known);
					}
					allowed = known;
				}
				if (!allowed) continue;
				if (visible.length === limit) return { items: visible, nextCursor: visible[visible.length - 1]!.name };
				visible.push(server);
			}
			return { items: visible };
		},

		async update(ctx: CallContext, id: ToolServerId, update: ToolServerUpdate): Promise<ToolServer> {
			forbidAgent(ctx);
			if (typeof update !== "object" || update === null) throw new HarbourError("invalid", "A change is an object");
			const description = optionalString(update.description, "A tool server's description");
			const disabledTools = update.disabledTools === undefined ? undefined : disabledToolsOf(update.disabledTools);
			const { server } = await load(ctx, id);
			await access().require(ctx, ownerCheck(server, "admin", "tool_server.update"));
			const result = await change(id, (current) => ({
				...current,
				...(description === undefined ? {} : { description }),
				...(disabledTools === undefined ? {} : { disabledTools }),
				updatedAt: clock.now(),
			}));
			if (result === undefined) throw new HarbourError("not_found", `No tool server ${id}`);
			await audit(ctx.actor, result.after, "tool_server.updated", {
				fields: [
					...(description === undefined ? [] : ["description"]),
					...(disabledTools === undefined ? [] : ["disabledTools"]),
				],
				...(disabledTools === undefined ? {} : { disabledTools: [...disabledTools] }),
			});
			return result.after;
		},

		async remove(ctx: CallContext, id: ToolServerId): Promise<void> {
			forbidAgent(ctx);
			const { server } = await load(ctx, id);
			await access().require(ctx, ownerCheck(server, "admin", "tool_server.delete"));
			await repo.remove(id);
			await audit(ctx.actor, server, "tool_server.deleted", { name: server.name });
			await options
				.links?.()
				?.close(
					{ organisationId: server.organisationId, toolServerId: id },
					TUNNEL_CLOSE_SERVER_REMOVED,
					"The tool server was removed",
				)
				.catch(() => undefined);
		},

		async createToken(ctx: CallContext, id: ToolServerId): Promise<IssuedToolServerToken> {
			forbidAgent(ctx);
			const { server } = await load(ctx, id);
			await access().require(ctx, ownerCheck(server, "operator", "tool_server.token.create"));
			return issueToken(ctx.actor, server);
		},

		async listTokens(ctx: CallContext, id: ToolServerId): Promise<readonly ToolServerToken[]> {
			await readable(ctx, id, "tool_server.token.list");
			return (await repo.tokens(id)).map((stored) => stored.token);
		},

		async revokeToken(ctx: CallContext, id: ToolServerId, tokenId: ToolServerTokenId): Promise<void> {
			forbidAgent(ctx);
			const { server } = await load(ctx, id);
			await access().require(ctx, ownerCheck(server, "operator", "tool_server.token.revoke"));
			const token = (await repo.tokens(id)).find((stored) => stored.token.id === tokenId);
			if (token === undefined || !(await repo.removeToken(tokenId))) {
				throw new HarbourError("not_found", `Tool server ${id} has no token ${tokenId}`);
			}
			await audit(ctx.actor, server, "tool_server.token.revoked", { tokenId, prefix: token.token.prefix });
			await options
				.links?.()
				?.close(
					{ organisationId: server.organisationId, toolServerId: id },
					TUNNEL_CLOSE_TOKEN_REVOKED,
					"The tunnel token was revoked",
					tokenId,
				)
				.catch(() => undefined);
		},

		async tools(ctx: CallContext, id: ToolServerId): Promise<ToolServerTools> {
			const server = await readable(ctx, id, "tool_server.tools");
			const disabled = new Set(server.disabledTools);
			return {
				toolServerId: server.id,
				...(server.snapshot === undefined ? {} : { hash: server.snapshot.hash, takenAt: server.snapshot.takenAt }),
				tools: (server.snapshot?.tools ?? []).map((tool) => {
					const unavailableReason = toolServerModelNameProblem(server.name, tool.name);
					return {
						...tool,
						enabled: !disabled.has(tool.name),
						modelName: toolServerModelName(server.name, tool.name),
						...(unavailableReason === undefined ? {} : { unavailableReason }),
					};
				}),
			};
		},

		async authenticateTunnel(serverId, secret) {
			const stored = await repo.get(serverId);
			if (stored === undefined) throw new HarbourError("not_found", `No tool server ${serverId}`);
			if (!secret.startsWith(TUNNEL_TOKEN_PREFIX)) return undefined;
			const token = await repo.tokenByHash(await hashTunnelToken(secret));
			if (token === undefined) return undefined;
			if (token.token.toolServerId !== serverId) {
				throw new HarbourError("forbidden", "The tunnel token is for another tool server");
			}
			await repo.updateToken({ ...token.token, lastUsedAt: clock.now() });
			return { organisationId: stored.server.organisationId, toolServerId: serverId, tokenId: token.token.id };
		},

		async connected(grant, info) {
			const result = await change(grant.toolServerId, (current) => ({
				...current,
				snapshot: info.snapshot,
				connection: {
					status: "connected",
					connectedAt: info.at,
					lastSeenAt: info.at,
					...(info.serverInfo === undefined ? {} : { serverInfo: info.serverInfo }),
				},
				updatedAt: clock.now(),
			}));
			if (result === undefined) return;
			await audit(SYSTEM_ACTOR, result.after, "tool_server.connected", {
				tokenId: grant.tokenId,
				tools: info.snapshot.tools.length,
				...(info.serverInfo === undefined ? {} : { serverName: info.serverInfo.name }),
			});
			if (result.before.snapshot?.hash !== info.snapshot.hash) {
				await snapshotEvent(SYSTEM_ACTOR, result.after, result.before, info.snapshot);
			}
			changed(result.after);
		},

		async snapshotChanged(ref, snapshot) {
			const result = await change(ref.toolServerId, (current) =>
				current.snapshot?.hash === snapshot.hash
					? undefined
					: {
							...current,
							snapshot,
							connection: { ...current.connection, lastSeenAt: snapshot.takenAt },
							updatedAt: clock.now(),
						},
			);
			if (result === undefined || result.before === result.after) return;
			await snapshotEvent(SYSTEM_ACTOR, result.after, result.before, snapshot);
			changed(result.after);
		},

		async disconnected(ref, at) {
			const result = await change(ref.toolServerId, (current) => {
				const { connectedAt: _connectedAt, ...rest } = current.connection;
				return { ...current, connection: { ...rest, status: "offline", lastSeenAt: at }, updatedAt: clock.now() };
			});
			if (result === undefined) return;
			await audit(SYSTEM_ACTOR, result.after, "tool_server.disconnected");
			changed(result.after);
		},

		async forSession(record, names) {
			const servers: ToolServer[] = [];
			for (const name of new Set(names)) {
				const stored = await repo.byName(record.organisationId, name);
				if (stored === undefined) continue;
				const { server } = stored;
				if (server.projectId !== undefined && server.projectId !== record.projectId) continue;
				servers.push(server);
			}
			return servers;
		},

		async lookup(ref) {
			const stored = await repo.get(ref.toolServerId);
			return stored === undefined || stored.server.organisationId !== ref.organisationId ? undefined : stored.server;
		},
	};
}

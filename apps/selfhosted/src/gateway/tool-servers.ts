/**
 * Tool servers on the self-hosted gateway (docs/site/src/content/docs/api/tool-servers.md): the registry in the
 * gateway's store (Postgres when durable, memory otherwise), the tunnels held in this process, and the runtime's port
 * over both. Experimental: on only with `KANTEL_TOOL_SERVERS=experimental`, and with it off there is nothing here, no
 * routes, no tables and no upgrade path.
 *
 * A tunnel is `GET /v1/tool-servers/{id}/connect` upgraded to a WebSocket, with `Authorization: Bearer hbt_…`. The
 * token is checked before the upgrade is accepted, and a refusal is a plain HTTP answer on the raw socket (401 for no
 * token or a wrong one, 403 for another server's, 404 for an unknown server), so the client can tell to stop.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type AuditSink, isKantelError, type ProjectAccess, toolServersEnabled } from "@kantel/contracts";
import type { SessionRuntimeOptions } from "@kantel/runtime/core";
import { tunnelServerId } from "@kantel/tools/http";
import { createTunnelHub, type TunnelHub } from "@kantel/tools/hub";
import { TUNNEL_CLOSE_GOING_AWAY, TUNNEL_MAX_MESSAGE_BYTES } from "@kantel/tools/protocol";
import type { ToolServerRepository } from "@kantel/tools/repository";
import { createToolServers, type ToolServersService } from "@kantel/tools/service";
import { sessionToolServers } from "@kantel/tools/session";
import { WebSocketServer } from "ws";
import type { UpgradeHandler } from "./node-http.ts";

/** Whether tool servers are on, from the environment. */
export function toolServersConfig(env: NodeJS.ProcessEnv): boolean {
	return toolServersEnabled(env.KANTEL_TOOL_SERVERS);
}

/** What the gateway holds of tool servers once they are on. */
export interface GatewayToolServers {
	readonly service: ToolServersService;
	readonly hub: TunnelHub;
}

/** The runtime's half: what a session reinstalls its tools through when a server it names changes. */
interface ToolServerChanges {
	toolServerChanged(organisationId: string, serverName: string): Promise<void>;
}

/**
 * The registry and the tunnels, with the runtime's option ready before the runtime is built. The runtime is attached
 * after, so a server's connect or changed tools reaches the sessions that name it.
 */
export function gatewayToolServers(options: {
	readonly repository: ToolServerRepository;
	readonly audit: AuditSink;
	readonly access: () => ProjectAccess;
	readonly log?: (message: string) => void;
}) {
	const log = options.log ?? ((message: string) => console.error(message));
	let runtime: ToolServerChanges | undefined;
	let hub: TunnelHub | undefined;
	const service = createToolServers({
		repository: options.repository,
		access: options.access,
		audit: options.audit,
		links: () => hub,
		onChange: (organisationId, server) => {
			runtime?.toolServerChanged(organisationId, server.name).catch((error) => {
				log(`[gateway] sessions naming tool server ${server.name} kept their tools: ${error}`);
			});
		},
	});
	const held = createTunnelHub({ service });
	hub = held;
	return {
		service,
		hub: held,
		/** The runtime's `toolServers`. */
		runtimeOption: sessionToolServers({ service, links: () => held }) satisfies SessionRuntimeOptions["toolServers"],
		attach(target: ToolServerChanges): GatewayToolServers {
			runtime = target;
			return { service, hub: held };
		},
	};
}

const STATUS_TEXT: { readonly [status: number]: string } = {
	400: "Bad Request",
	401: "Unauthorized",
	403: "Forbidden",
	404: "Not Found",
	500: "Internal Server Error",
};

/** A tunnel upgrade's handler: `upgrade` answers `false` for a path that isn't a tunnel's, leaving it to the next. */
export interface ToolServerUpgrades {
	upgrade(incoming: IncomingMessage, socket: Duplex, head: Buffer): boolean;
	/** Closes every tunnel, as the gateway stops: the clients reconnect to the next one. */
	close(): void;
}

export function toolServerUpgrades(toolServers: GatewayToolServers): ToolServerUpgrades {
	const sockets = new WebSocketServer({ noServer: true, maxPayload: TUNNEL_MAX_MESSAGE_BYTES });
	return {
		upgrade(incoming, socket, head) {
			const path = new URL(incoming.url ?? "/", "http://gateway").pathname;
			const serverId = tunnelServerId(path);
			if (serverId === undefined) return false;
			const refuse = (status: number) => {
				socket.end(
					`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Refused"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
				);
			};
			if (incoming.method !== "GET") {
				refuse(400);
				return true;
			}
			const authorization = incoming.headers.authorization ?? "";
			const secret = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
			if (secret === undefined) {
				refuse(401);
				return true;
			}
			void toolServers.service.authenticateTunnel(serverId, secret).then(
				(grant) => {
					if (grant === undefined) return refuse(401);
					sockets.handleUpgrade(incoming, socket, head, (accepted) => {
						const tunnel = toolServers.hub.accept(grant, {
							send: (text) => accepted.send(text),
							close: (code, reason) => accepted.close(code, reason),
						});
						accepted.on("message", (data, binary) => {
							if (binary) {
								const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
								tunnel.receive(new Uint8Array(bytes));
							} else {
								tunnel.receive(data.toString());
							}
						});
						accepted.on("close", (code, reason) => tunnel.closed(code, reason.toString()));
						accepted.on("error", () => accepted.terminate());
					});
				},
				(error: unknown) => {
					if (isKantelError(error) && error.code === "not_found") return refuse(404);
					if (isKantelError(error) && error.code === "forbidden") return refuse(403);
					refuse(500);
				},
			);
			return true;
		},
		close() {
			toolServers.hub.closeAll(TUNNEL_CLOSE_GOING_AWAY, "The gateway is stopping");
			sockets.close();
		},
	};
}

/** Tunnels first, then whatever served upgrades before (a browser's live view); undefined when there is neither. */
export function withToolServerUpgrades(
	tunnels: ToolServerUpgrades | undefined,
	next: UpgradeHandler | undefined,
): UpgradeHandler | undefined {
	if (tunnels === undefined) return next;
	return (incoming, socket, head) => {
		if (tunnels.upgrade(incoming, socket, head)) return;
		if (next !== undefined) {
			next(incoming, socket, head);
			return;
		}
		socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
	};
}

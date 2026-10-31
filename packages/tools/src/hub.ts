/**
 * Tool servers' tunnels held in this process: the self-hosted gateway's, and tests'. The host checks the token and
 * accepts the upgrade, then hands each socket here with the grant it was checked against; the hub builds a
 * `TunnelConnection` on it, reports the server's connection and tools to the registry, and serves `TunnelLinks` from
 * whichever socket is current.
 *
 * One socket per server: a newer one for the same server takes over, and the older is closed with 4008. Only the
 * current socket's close marks the server offline, so a takeover never reads as a disconnect.
 */
import { type Clock, HarbourError, systemClock } from "@harbour/contracts";
import { TunnelConnection, type TunnelSocket } from "./connection.ts";
import type { ToolServerRef, TunnelLinks } from "./links.ts";
import { TUNNEL_CLOSE_REPLACED } from "./protocol.ts";
import type { ToolServersService, TunnelGrant } from "./service.ts";

/** What the host gives the hub of a socket it accepted. */
export interface AcceptedTunnel {
	/** A frame from the socket: text as a string, binary as bytes. */
	receive(frame: string | ArrayBuffer | ArrayBufferView): void;
	/** The socket closed from the other side, or failed. */
	closed(code: number, reason: string): void;
}

export interface TunnelHub extends TunnelLinks {
	accept(grant: TunnelGrant, socket: TunnelSocket): AcceptedTunnel;
	/** Closes every tunnel, as when the process stops; the clients reconnect to whichever process is next. */
	closeAll(code: number, reason: string): void;
}

export interface TunnelHubOptions {
	readonly service: Pick<ToolServersService, "connected" | "snapshotChanged" | "disconnected" | "lookup">;
	readonly clock?: Clock;
}

interface Held {
	readonly grant: TunnelGrant;
	readonly connection: TunnelConnection;
}

const keyOf = (ref: ToolServerRef) => `${ref.organisationId}\u0000${ref.toolServerId}`;

export function createTunnelHub(options: TunnelHubOptions): TunnelHub {
	const { service } = options;
	const clock = options.clock ?? systemClock;
	const held = new Map<string, Held>();
	const report = (work: () => Promise<void>) => {
		// The registry's outage is its own to report; the tunnel carries on.
		void work().catch(() => undefined);
	};

	return {
		accept(grant, socket) {
			const key = keyOf(grant);
			let entry: Held | undefined;
			const current = () => entry !== undefined && held.get(key) === entry;
			const connection = new TunnelConnection({
				socket,
				clock,
				onReady: async ({ serverInfo, snapshot }) => {
					if (current()) await service.connected(grant, { serverInfo, snapshot, at: clock.now() });
				},
				onSnapshot: async (snapshot) => {
					if (current()) await service.snapshotChanged(grant, snapshot);
				},
				onClosed: () => {
					if (!current()) return;
					held.delete(key);
					report(() => service.disconnected(grant, clock.now()));
				},
			});
			entry = { grant, connection };
			const older = held.get(key);
			held.set(key, entry);
			older?.connection.close(TUNNEL_CLOSE_REPLACED, "A newer connection for the tool server took over");
			report(() => connection.start());
			return {
				receive: (frame) => connection.receive(frame),
				closed: (code, reason) => connection.close(code, reason),
			};
		},

		async call(ref, input, signal) {
			const found = held.get(keyOf(ref));
			if (found === undefined) {
				const server = await service.lookup(ref).catch(() => undefined);
				throw new HarbourError("unavailable", `Tool server ${server?.name ?? ref.toolServerId} is offline`);
			}
			return found.connection.callTool({ ...input, signal });
		},

		async close(ref, code, reason, tokenId) {
			const found = held.get(keyOf(ref));
			if (found === undefined || (tokenId !== undefined && found.grant.tokenId !== tokenId)) return;
			found.connection.close(code, reason);
		},

		closeAll(code, reason) {
			for (const { connection } of [...held.values()]) connection.close(code, reason);
		},
	};
}

/**
 * Refusing a WebSocket upgrade, the same way on Bun and Node.
 *
 * Bun's `node:http` drops anything written to an upgrade's socket before a handshake: a plain `HTTP/1.1 401` reply
 * never reaches the client, which sees only "Connection ended", and the socket may stay open. So the gateway never
 * answers an upgrade with an HTTP status. It completes the handshake with its own `ws` server and closes at once with
 * a code that says why, before reading anything the client sends; nothing reaches a sandbox.
 *
 * The codes (RFC 6455 leaves 4000 to 4999 to applications):
 *
 * | Code | Meaning, as the HTTP status it replaces |
 * | --- | --- |
 * | 4401 | 401: no credential or token (an exposed port's name without its token) |
 * | 4403 | 403: the credential is good but its holder may not (whoever exposed the port lost access) |
 * | 4404 | 404: nothing upgrades at this path (a path the gateway doesn't serve, an unsigned replica stream) |
 * | 4502 | 502: the gateway couldn't check the request (its store or a replica didn't answer) |
 *
 * That is 4000 plus the HTTP status. The gateway's other close codes are unchanged: 4003 for a tunnel, desktop or host
 * credential that is wrong, expired or revoked (`HOST_CLOSE_REVOKED`, `RELAY_CLOSE_REVOKED`; kantel-host reads it as
 * "stop, don't retry"), 4004 for a replica's port stream whose sandbox port isn't there, 4002 and 4008 from the hub.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";

/** The close code that stands for an HTTP refusal: 4000 plus the status (401 → 4401). */
export function refusalCode(status: number): number {
	return 4000 + status;
}

/** One server for refusals where there isn't one already (`node-http.ts` with no upgrade handler). */
let fallback: WebSocketServer | undefined;

function fallbackServer(): WebSocketServer {
	if (fallback === undefined) fallback = new WebSocketServer({ noServer: true, maxPayload: 1024 });
	return fallback;
}

/**
 * Refuses the upgrade with `status`'s close code and `reason` (cut to 120 characters: a close frame holds 123 bytes). A request
 * that isn't a valid WebSocket upgrade gets `ws`'s own 400 and is dropped; a socket already gone or already upgraded
 * is destroyed.
 */
export function refuseUpgrade(
	incoming: IncomingMessage,
	socket: Duplex,
	head: Buffer,
	status: number,
	reason: string,
	sockets?: WebSocketServer,
): void {
	if (socket.destroyed) return;
	const server = sockets ?? fallbackServer();
	try {
		server.handleUpgrade(incoming, socket, head, (accepted) => {
			accepted.on("error", () => accepted.terminate());
			accepted.close(refusalCode(status), reason.slice(0, 120));
		});
	} catch {
		socket.destroy();
	}
}

/**
 * Harbour's side of the tunnel for the tests: a `ws` server on loopback that checks the path and the token at the
 * upgrade, as the Worker and the gateway do, and runs `TunnelConnection` from `@harbour/tools` on each socket.
 */
import { createServer, STATUS_CODES } from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolServerSnapshot } from "@harbour/contracts";
import { TunnelConnection, type TunnelReady, tunnelPath } from "@harbour/tools";
import { type WebSocket, WebSocketServer } from "ws";

export interface HarbourSide {
	readonly ws: WebSocket;
	readonly connection: TunnelConnection;
	readonly ready: Promise<TunnelReady>;
	readonly snapshots: ToolServerSnapshot[];
	/** Every text frame the tunnel sent. */
	readonly frames: string[];
}

export interface FakeHarbourOptions {
	readonly serverId: string;
	readonly token: string;
	/** False to leave the client's pings unanswered. */
	readonly answerPings?: boolean;
	/** Headers the upgrade must carry as well, as Cloudflare Access wants its service token's; 403 otherwise. */
	readonly requireHeaders?: { readonly [name: string]: string };
}

export async function startHarbour(options: FakeHarbourOptions) {
	const sides: HarbourSide[] = [];
	const waiting: (() => void)[] = [];
	const wss = new WebSocketServer({ noServer: true });
	const http = createServer((_request, response) => response.writeHead(404).end());
	http.on("upgrade", (request, socket, head) => {
		const refuse = (status: number): void => {
			socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
		};
		if (request.url !== tunnelPath(options.serverId)) return refuse(404);
		for (const [name, value] of Object.entries(options.requireHeaders ?? {})) {
			if (request.headers[name.toLowerCase()] !== value) return refuse(403);
		}
		if (request.headers.authorization !== `Bearer ${options.token}`) return refuse(401);
		wss.handleUpgrade(request, socket, head, (ws) => {
			const snapshots: ToolServerSnapshot[] = [];
			const frames: string[] = [];
			let onReady: (info: TunnelReady) => void = () => {};
			const ready = new Promise<TunnelReady>((resolve) => {
				onReady = resolve;
			});
			const connection = new TunnelConnection({
				socket: { send: (text) => ws.send(text), close: (code, reason) => ws.close(code, reason) },
				onReady,
				onSnapshot: (snapshot) => {
					snapshots.push(snapshot);
				},
			});
			ws.on("message", (data, isBinary) => {
				if (isBinary) {
					connection.receive(data as Buffer);
					return;
				}
				const text = data.toString();
				frames.push(text);
				if (text === "ping" && options.answerPings === false) return;
				connection.receive(text);
			});
			ws.on("close", (code, reason) => connection.close(code, reason.toString()));
			sides.push({ ws, connection, ready, snapshots, frames });
			for (const wake of waiting.splice(0)) wake();
			void connection.start();
		});
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	const { port } = http.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${port}`,
		sides,
		/** The `n`th socket the tunnel opened, counting from 0, once it has. */
		async side(n: number): Promise<HarbourSide> {
			while (sides[n] === undefined) await new Promise<void>((resolve) => waiting.push(resolve));
			return sides[n]!;
		},
		close: () =>
			new Promise<void>((resolve) => {
				for (const client of wss.clients) client.terminate();
				http.closeAllConnections();
				http.close(() => resolve());
			}),
	};
}

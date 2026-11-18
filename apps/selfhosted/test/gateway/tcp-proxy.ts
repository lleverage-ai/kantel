// A TCP proxy in front of a test's Postgres, to take the database away from a gateway and give it back as a restart or a
// failover would: `restart` drops every connection and refuses new ones until `up`; `blackhole` keeps the connections
// open but passes nothing either way, as when the server's machine vanishes without closing them.
import { createServer, type Server, type Socket, connect as tcpConnect } from "node:net";

export interface TcpProxy {
	/** The proxy's URL for `databaseUrl`: the same, through the proxy. */
	readonly url: string;
	/** Drops every connection and refuses new ones until `up`. */
	restart(): Promise<void>;
	/** Stops passing anything on the open connections, and leaves new ones unanswered, until `up`. */
	blackhole(): void;
	/** Accepts and passes connections again. */
	up(): Promise<void>;
	close(): Promise<void>;
}

export async function tcpProxy(databaseUrl: string): Promise<TcpProxy> {
	const target = new URL(databaseUrl);
	const targetPort = Number(target.port || "5432");
	const pairs = new Set<[Socket, Socket]>();
	let silent = false;
	const accept = (client: Socket) => {
		const server = tcpConnect(targetPort, target.hostname);
		const pair: [Socket, Socket] = [client, server];
		pairs.add(pair);
		const end = () => {
			pairs.delete(pair);
			client.destroy();
			server.destroy();
		};
		client.on("data", (chunk) => {
			if (!silent) server.write(chunk);
		});
		server.on("data", (chunk) => {
			if (!silent) client.write(chunk);
		});
		for (const socket of pair) {
			socket.on("error", end);
			socket.on("close", end);
		}
	};
	let listener: Server = createServer(accept);
	const listen = (port: number) =>
		new Promise<number>((resolve, reject) => {
			listener.once("error", reject);
			listener.listen(port, "127.0.0.1", () => {
				const address = listener.address();
				resolve(typeof address === "object" && address !== null ? address.port : port);
			});
		});
	const port = await listen(0);
	const stop = () => new Promise<void>((resolve) => listener.close(() => resolve()));
	const proxied = new URL(databaseUrl);
	proxied.hostname = "127.0.0.1";
	proxied.port = String(port);
	return {
		url: proxied.toString(),
		async restart() {
			const stopped = stop();
			for (const [client, server] of pairs) {
				client.destroy();
				server.destroy();
			}
			await stopped;
		},
		blackhole() {
			silent = true;
		},
		async up() {
			silent = false;
			if (!listener.listening) {
				listener = createServer(accept);
				await listen(port);
			}
		},
		async close() {
			for (const [client, server] of pairs) {
				client.destroy();
				server.destroy();
			}
			if (listener.listening) await stop();
		},
	};
}

// Sockets for `pg` that look the database's host name up again on every connection.
//
// Bun's own lookup (behind `net.connect`, `dns.lookup` and `dns.resolve4`) remembers that a name didn't resolve and
// keeps answering ENOTFOUND for it while it is asked again, long after the name is back (Bun 1.3.14). In Compose a
// stopped container's name stops resolving, so a gateway that tried to connect while Postgres was stopped, at start
// or after a long outage, never reached it again. Bun's lookup through the system resolver doesn't keep answers, so
// these sockets resolve the name with it and connect to the address; under Node, `dns.lookup` keeps nothing either.
import { lookup } from "node:dns/promises";
import { isIP, Socket } from "node:net";

/** The name's address, asked of the system's resolver now, never a remembered answer. */
export async function lookupFresh(host: string): Promise<string> {
	const bun = (
		globalThis as { Bun?: { dns: { lookup(host: string, options: object): Promise<{ address: string }[]> } } }
	).Bun;
	if (bun === undefined) return (await lookup(host)).address;
	let found: { address: string }[];
	try {
		found = await bun.dns.lookup(host, { backend: "system" });
	} catch (error) {
		// Answered as Node's would be, so the driver tells it from other failures (`postgresFailure`).
		throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`, { cause: error }), {
			code: "ENOTFOUND",
			hostname: host,
		});
	}
	const first = found[0];
	if (first === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
	return first.address;
}

/**
 * A socket whose `connect(port, host)` looks `host` up with `lookupFresh` first. An address, or a Unix socket's path,
 * is connected to as it is. A failed lookup destroys the socket with its error, as `net` does.
 */
export class FreshLookupSocket extends Socket {
	override connect(...args: unknown[]): this {
		const connect = Socket.prototype.connect as (this: Socket, ...a: unknown[]) => Socket;
		const [port, host] = args;
		if (typeof host !== "string" || isIP(host) !== 0 || args.length !== 2) {
			connect.apply(this, args);
			return this;
		}
		lookupFresh(host).then(
			(address) => {
				if (!this.destroyed) connect.call(this, Number(port), address);
			},
			(error: Error) => {
				if (!this.destroyed) this.destroy(error);
			},
		);
		return this;
	}
}

/** `pg`'s `stream` setting for it: a new socket for each connection. */
export const freshLookupStream = (): Socket => new FreshLookupSocket();

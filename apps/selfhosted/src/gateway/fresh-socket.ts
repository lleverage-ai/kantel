// Sockets for `pg` that look the database's host name up again on every connection.
//
// Bun's own lookup (behind `net.connect`, `dns.lookup` and `dns.resolve4`) remembers that a name didn't resolve and
// keeps answering ENOTFOUND for it while it is asked again, long after the name is back (Bun 1.3.14). In Compose a
// stopped container's name stops resolving, so a gateway that tried to connect while Postgres was stopped, at start
// or after a long outage, never reached it again. Bun's lookup through the system resolver doesn't keep answers, so
// these sockets give `net` that one as their `lookup`; under Node, `dns.lookup` keeps nothing either. `net` still gets
// every address and tries the next family when one can't be reached, as it does with its own lookup.
import { lookup } from "node:dns/promises";
import { type LookupFunction, Socket } from "node:net";

export interface LookupAddress {
	readonly address: string;
	readonly family: number;
}

type BunDns = { lookup(host: string, options: object): Promise<{ address: string; family: number }[]> };

/**
 * A Bun lookup's failure as Node would report it, so the driver tells it from other failures (`postgresFailure`): a name
 * that doesn't resolve is ENOTFOUND, a resolver that didn't answer in time ETIMEDOUT, and any other resolver failure
 * EAI_AGAIN (try again). Anything that isn't a resolver's failure is as it was. The original is the `cause`.
 */
export function nodeDnsError(host: string, error: unknown): unknown {
	const code = String((error as { code?: unknown })?.code ?? "");
	if (!/^(DNS_|EAI_)/.test(code)) return error;
	const node = /NOTFOUND|NODATA|NONAME/.test(code)
		? "ENOTFOUND"
		: /TIMEOUT|TIMEDOUT/.test(code)
			? "ETIMEDOUT"
			: "EAI_AGAIN";
	return Object.assign(new Error(`getaddrinfo ${node} ${host}`, { cause: error }), { code: node, hostname: host });
}

/** The name's addresses, asked of the system's resolver now, never a remembered answer. */
export async function lookupFresh(host: string): Promise<LookupAddress[]> {
	const bun = (globalThis as { Bun?: { dns: BunDns } }).Bun;
	if (bun === undefined) return lookup(host, { all: true });
	let found: { address: string; family: number }[];
	try {
		found = await bun.dns.lookup(host, { backend: "system" });
	} catch (error) {
		throw nodeDnsError(host, error);
	}
	if (found.length === 0) {
		throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND", hostname: host });
	}
	return found.map(({ address, family }) => ({ address, family }));
}

/** `resolve` as `net`'s `lookup` option: all the addresses when asked for all, as `net` does, else the first. */
export const lookupOption = (resolve: (host: string) => Promise<LookupAddress[]>): LookupFunction =>
	((
		host: string,
		options: { readonly all?: boolean },
		callback: (error: Error | null, address?: string | LookupAddress[], family?: number) => void,
	) => {
		resolve(host).then(
			(addresses) => {
				const first = addresses[0] as LookupAddress;
				if (options?.all) callback(null, addresses);
				else callback(null, first.address, first.family);
			},
			(error: Error) => callback(error),
		);
	}) as unknown as LookupFunction;

const freshLookup = lookupOption(lookupFresh);

/**
 * A socket whose `connect(port, host)` looks `host` up with `lookupFresh` (tests give another `resolve`). An address,
 * or a Unix socket's path, is connected to as it is (`net` looks neither up).
 */
export class FreshLookupSocket extends Socket {
	readonly #lookup: LookupFunction;

	constructor(resolve?: (host: string) => Promise<LookupAddress[]>) {
		super();
		this.#lookup = resolve === undefined ? freshLookup : lookupOption(resolve);
	}

	override connect(...args: unknown[]): this {
		const connect = Socket.prototype.connect as (this: Socket, ...a: unknown[]) => Socket;
		const [port, host] = args;
		if (args.length === 2 && typeof host === "string") {
			connect.call(this, { port: Number(port), host, lookup: this.#lookup });
		} else {
			connect.apply(this, args);
		}
		return this;
	}
}

/** `pg`'s `stream` setting for it: a new socket for each connection. */
export const freshLookupStream = (): Socket => new FreshLookupSocket();

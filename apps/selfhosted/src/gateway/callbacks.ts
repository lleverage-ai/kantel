// Which host-tool callback URLs the gateway's session API may call (`KANTEL_CALLBACK_ORIGINS`).
//
// Each entry is an origin, `scheme://host[:port]`, matched exactly; or `scheme://host:*`, any port on that host. The
// second form is for a host app that serves its callbacks on a port the OS picks, as Sal's Kantel worker does on
// `http://127.0.0.1:<port>` (tvdavies/sal src/harbour/worker.ts): a gateway next to Sal sets
// `KANTEL_CALLBACK_ORIGINS=http://127.0.0.1:*`. With no entries the session API keeps its default, `https:` only.
//
// The gateway calls whatever a key holder registers within this list, so an entry with `*` lets any operator key make
// the gateway POST signed tool calls to any port on that host. Name the narrowest host that works, and only on a
// gateway whose keys are the host app's own.

export interface CallbackOrigin {
	readonly protocol: "http:" | "https:";
	/** As `URL.hostname` gives it: lower case, IPv6 in brackets. */
	readonly hostname: string;
	/** The port, `""` for the scheme's default, or `"*"` for any. */
	readonly port: string;
}

const ANY_PORT = /^(https?:\/\/[^/?#]+):\*$/i;

/** Parses one `KANTEL_CALLBACK_ORIGINS` entry; throws on anything but an origin or an origin with `:*`. */
export function parseCallbackOrigin(entry: string): CallbackOrigin {
	const anyPort = ANY_PORT.exec(entry);
	const base = anyPort === null ? entry : (anyPort[1] as string);
	const fail = (why: string) => new Error(`KANTEL_CALLBACK_ORIGINS: ${JSON.stringify(entry)} ${why}`);
	let url: URL;
	try {
		url = new URL(base);
	} catch {
		throw fail("is not an origin");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw fail("must be http: or https:");
	// Only the port may be a wildcard: a host is always named.
	if (url.hostname.includes("*")) throw fail("must name its host");
	// A path, query, fragment or user name makes the origin differ from what was written; so does a default port
	// written out.
	if (url.origin.toLowerCase() !== base.replace(/\/$/, "").toLowerCase()) throw fail("must be an origin only");
	if (anyPort !== null && url.port !== "") throw fail("names a port before *");
	return { protocol: url.protocol, hostname: url.hostname, port: anyPort === null ? url.port : "*" };
}

/** Parses the comma-separated list; blank entries are skipped. */
export function parseCallbackOrigins(value: string | undefined): readonly CallbackOrigin[] {
	return (value ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "")
		.map(parseCallbackOrigin);
}

/** The session API's `allowCallbackUrl` for `origins`. */
export function callbackUrlAllowed(origins: readonly CallbackOrigin[]): (url: URL) => boolean {
	return (url) =>
		origins.some(
			(origin) =>
				origin.protocol === url.protocol &&
				origin.hostname === url.hostname &&
				(origin.port === "*" || origin.port === url.port),
		);
}

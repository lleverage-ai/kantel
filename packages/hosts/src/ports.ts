/**
 * Exposed ports: a sandbox's port at `https://{port}-{subdomain}.{domain}`, where `{domain}` is a wildcard name the
 * operator points at the gateway (`KANTEL_COMPUTE_PORTS_DOMAIN`). The sandbox has no address of its own: the gateway
 * answers the name and relays each request to the port over the connection the sandbox's host keeps open.
 *
 * Token-gated unless exposed `public`: the URL carries `?_token=…` (32 random bytes), which the gateway trades for a
 * cookie on that one name (HttpOnly, host-only, SameSite=Lax) and takes off before the sandbox sees the request, as
 * boat.dev does. An API client can send the cookie itself: `Cookie: _kantel_port=…`. Exposing a port again, or
 * hiding it, ends its token. A request for a name nobody exposed, or without the token, never reaches a sandbox.
 */
import type { PortSink, PortStream } from "./hub.ts";
import { PortHttpError, proxyHttp } from "./port-http.ts";

export const PORT_TOKEN_PARAM = "_token";
export const PORT_COOKIE = "_kantel_port";

export interface PortRouterOptions {
	/** The wildcard name's parent: `ports.kantel.example` for `*.ports.kantel.example`. */
	readonly domain: string;
	/** What the URLs use (default https). */
	readonly scheme?: "https" | "http";
	/** Opens a byte stream to a sandbox's port (`HostsService.sandboxes.openPort`). */
	openPort(sandboxId: string, port: number, sink: PortSink): Promise<PortStream>;
}

export interface Exposure {
	readonly sandboxId: string;
	readonly port: number;
	/** Absent: public. */
	readonly token?: string;
}

/** Where an upgrade on a port's name may go, or why not. */
export type PortUpgrade =
	| {
			readonly ok: true;
			readonly sandboxId: string;
			readonly port: number;
			readonly path: string;
			readonly host: string;
	  }
	| { readonly ok: false; readonly status: number; readonly reason: string };

export interface PortRouter {
	readonly domain: string;
	expose(
		sandboxId: string,
		port: number,
		options: { readonly public: boolean; readonly subdomain: string },
	): { url: string };
	hide(sandboxId: string, port: number): void;
	/** Ends every port of a sandbox (deleted, stopped). */
	forget(sandboxId: string): void;
	/** The answer for a request to a port's name; undefined when the request isn't for one. */
	fetch(request: Request, client?: { readonly address?: string }): Promise<Response | undefined>;
	/** For a WebSocket upgrade: undefined when it isn't for a port's name. */
	upgrade(host: string, path: string, cookie: string | undefined): PortUpgrade | undefined;
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Compares in time that doesn't depend on where the strings differ. */
function same(a: string, b: string): boolean {
	const x = new TextEncoder().encode(a);
	const y = new TextEncoder().encode(b);
	let diff = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}

function cookiesNamed(header: string | null | undefined, name: string): string[] {
	if (header === null || header === undefined) return [];
	return header
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${name}=`))
		.map((part) => part.slice(name.length + 1));
}

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
	new Response(`${body}\n`, {
		status,
		headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers },
	});

export function createPortRouter(options: PortRouterOptions): PortRouter {
	const domain = options.domain.toLowerCase().replace(/^\.+|\.+$/g, "");
	const scheme = options.scheme ?? "https";
	/** By `{port}-{subdomain}`. */
	const exposures = new Map<string, Exposure>();

	/** The exposure a host name is for: undefined when it isn't under the domain, null when it names none. */
	function lookup(hostname: string): Exposure | null | undefined {
		const name = hostname.toLowerCase().replace(/\.$/, "");
		if (!name.endsWith(`.${domain}`)) return undefined;
		const label = name.slice(0, -(domain.length + 1));
		if (!/^\d{1,5}-[a-z0-9-]+$/.test(label)) return null;
		return exposures.get(label) ?? null;
	}

	/** Whether a request carries the exposure's token, in the query or the cookie. */
	function admitted(exposure: Exposure, query: string | null, cookie: string | null | undefined): boolean {
		if (exposure.token === undefined) return true;
		const token = exposure.token;
		if (query !== null) return same(query, token);
		return cookiesNamed(cookie, PORT_COOKIE).some((value) => same(value, token));
	}

	return {
		domain,
		expose(sandboxId, port, { public: isPublic, subdomain }) {
			const label = `${port}-${subdomain.toLowerCase()}`;
			if (!/^[a-z0-9-]+$/.test(subdomain)) throw new Error("A sandbox's subdomain is letters, digits and dashes");
			const token = isPublic ? undefined : base64url(crypto.getRandomValues(new Uint8Array(32)));
			exposures.set(label, { sandboxId, port, ...(token === undefined ? {} : { token }) });
			const url = `${scheme}://${label}.${domain}/`;
			return { url: token === undefined ? url : `${url}?${PORT_TOKEN_PARAM}=${token}` };
		},
		hide(sandboxId, port) {
			for (const [label, exposure] of exposures) {
				if (exposure.sandboxId === sandboxId && exposure.port === port) exposures.delete(label);
			}
		},
		forget(sandboxId) {
			for (const [label, exposure] of exposures) if (exposure.sandboxId === sandboxId) exposures.delete(label);
		},
		async fetch(request, client) {
			const url = new URL(request.url);
			const exposure = lookup(url.hostname);
			if (exposure === undefined) return undefined;
			if (exposure === null) return text(404, "No sandbox port is exposed here.");
			const query = url.searchParams.get(PORT_TOKEN_PARAM);
			if (!admitted(exposure, query, request.headers.get("cookie"))) {
				return text(401, "This port needs its token: open the URL Kantel gave you, with its _token.");
			}
			if (query !== null) {
				url.searchParams.delete(PORT_TOKEN_PARAM);
				if (exposure.token !== undefined && (request.method === "GET" || request.method === "HEAD")) {
					// Trade the token for a cookie on this one name, and take it out of the address bar and history.
					const secure = scheme === "https" ? "; Secure" : "";
					return new Response(null, {
						status: 303,
						headers: {
							location: `${url.pathname}${url.search}`,
							"set-cookie": `${PORT_COOKIE}=${exposure.token}; Path=/; HttpOnly; SameSite=Lax${secure}`,
							"cache-control": "no-store",
							"referrer-policy": "no-referrer",
						},
					});
				}
			}
			const forwarded: Record<string, string> = { "x-forwarded-proto": scheme, "x-forwarded-host": url.host };
			if (client?.address !== undefined) forwarded["x-forwarded-for"] = client.address;
			try {
				return await proxyHttp((sink) => options.openPort(exposure.sandboxId, exposure.port, sink), request, {
					host: url.host,
					path: `${url.pathname}${url.search}`,
					forwarded,
					dropCookies: [PORT_COOKIE],
				});
			} catch (error) {
				if (error instanceof PortHttpError) return text(error.status, error.message);
				return text(502, "The sandbox's port didn't answer.");
			}
		},
		upgrade(host, path, cookie) {
			const hostname = host.replace(/:\d+$/, "");
			const exposure = lookup(hostname);
			if (exposure === undefined) return undefined;
			if (exposure === null) return { ok: false, status: 404, reason: "No sandbox port is exposed here" };
			const url = new URL(path, "http://port");
			const query = url.searchParams.get(PORT_TOKEN_PARAM);
			if (!admitted(exposure, query, cookie)) return { ok: false, status: 401, reason: "This port needs its token" };
			url.searchParams.delete(PORT_TOKEN_PARAM);
			return {
				ok: true,
				sandboxId: exposure.sandboxId,
				port: exposure.port,
				path: `${url.pathname}${url.search}`,
				host,
			};
		},
	};
}

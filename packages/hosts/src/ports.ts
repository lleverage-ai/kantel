/**
 * Exposed ports: a sandbox's port at `https://{port}-{subdomain}.{domain}`, where `{domain}` is a wildcard name the
 * operator points at the gateway (`KANTEL_COMPUTE_PORTS_DOMAIN`). The sandbox has no address of its own: the gateway
 * answers the name and relays each request to the port over the connection the sandbox's host keeps open.
 *
 * Token-gated unless exposed `public`: the URL carries `?_token=…` (32 random bytes), which the gateway trades for a
 * cookie on that one name (HttpOnly, host-only, SameSite=Lax) and takes off before the sandbox sees the request, as
 * boat.dev does. An API client can send the cookie itself: `Cookie: _kantel_port=…`. Exposing a port again, or
 * hiding it, ends its token. A request for a name nobody exposed, or without the token, never reaches a sandbox.
 *
 * Exposures are kept in the relay store (`relay-store.ts`), so they outlast a gateway restart and every replica answers
 * every port's name. The store keeps the SHA-256 of a token, never the token: the URL with it is shown once, when the
 * port is exposed.
 */
import type { PortSink, PortStream } from "./hub.ts";
import { PortHttpError, proxyHttp } from "./port-http.ts";
import type { ExposureRecord, RelayStore } from "./relay-store.ts";
import { sameSecret, sha256Hex } from "./tunnel.ts";

export const PORT_TOKEN_PARAM = "_token";
export const PORT_COOKIE = "_kantel_port";

export interface PortRouterOptions {
	/** The wildcard name's parent: `ports.kantel.example` for `*.ports.kantel.example`. */
	readonly domain: string;
	/** What the URLs use (default https). */
	readonly scheme?: "https" | "http";
	/** Opens a byte stream to a sandbox's port (`HostsService.sandboxes.openPort`). */
	openPort(sandboxId: string, port: number, sink: PortSink): Promise<PortStream>;
	/** Where exposures are kept: shared by the gateway's replicas. */
	readonly store: RelayStore;
	readonly now?: () => number;
	/**
	 * Whether whoever exposed a port still may use it (their key or sign-in still good, still in the account). Asked on
	 * every request and upgrade; absent, everyone may.
	 */
	stillAllowed?(grantee: string | undefined, sandboxId: string): Promise<boolean>;
}

/** Where an upgrade on a port's name may go, or why not. */
export type PortUpgrade =
	| {
			readonly ok: true;
			readonly sandboxId: string;
			readonly port: number;
			readonly path: string;
			readonly host: string;
			/** Who exposed it, as JSON, when they were named. */
			readonly grantee?: string;
	  }
	| { readonly ok: false; readonly status: number; readonly reason: string };

export interface PortRouter {
	readonly domain: string;
	/** The URL, with its token unless public: the only time the token is shown. */
	expose(
		sandboxId: string,
		port: number,
		options: { readonly public: boolean; readonly subdomain: string; readonly grantee?: string },
	): Promise<{ url: string }>;
	hide(sandboxId: string, port: number): Promise<void>;
	/** Ends every port of a sandbox (deleted, stopped). */
	forget(sandboxId: string): Promise<void>;
	/** The answer for a request to a port's name; undefined when the request isn't for one. */
	fetch(request: Request, client?: { readonly address?: string }): Promise<Response | undefined>;
	/** For a WebSocket upgrade: undefined when it isn't for a port's name. */
	upgrade(host: string, path: string, cookie: string | undefined): Promise<PortUpgrade | undefined>;
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A port's URL as the sandbox's records keep it: never with its token. */
export function withoutPortToken(url: string): string {
	const parsed = new URL(url);
	if (!parsed.searchParams.has(PORT_TOKEN_PARAM)) return url;
	parsed.searchParams.delete(PORT_TOKEN_PARAM);
	return parsed.toString();
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
	const { store } = options;
	const now = options.now ?? Date.now;

	/** The exposure a host name is for: undefined when it isn't under the domain, null when it names none. */
	async function lookup(hostname: string): Promise<ExposureRecord | null | undefined> {
		const name = hostname.toLowerCase().replace(/\.$/, "");
		if (!name.endsWith(`.${domain}`)) return undefined;
		const label = name.slice(0, -(domain.length + 1));
		if (!/^\d{1,5}-[a-z0-9-]+$/.test(label)) return null;
		return (await store.getExposure(label)) ?? null;
	}

	/** The token a request carries that matches the exposure's, from the query or a cookie; "" for a public port. */
	async function admitted(
		exposure: ExposureRecord,
		query: string | null,
		cookie: string | null | undefined,
	): Promise<string | undefined> {
		const hash = exposure.tokenHash;
		if (hash === undefined) return "";
		const offered = query !== null ? [query] : cookiesNamed(cookie, PORT_COOKIE);
		for (const value of offered) if (sameSecret(await sha256Hex(value), hash)) return value;
		return undefined;
	}

	return {
		domain,
		async expose(sandboxId, port, { public: isPublic, subdomain, grantee }) {
			const label = `${port}-${subdomain.toLowerCase()}`;
			if (!/^[a-z0-9-]+$/.test(subdomain)) throw new Error("A sandbox's subdomain is letters, digits and dashes");
			const token = isPublic ? undefined : base64url(crypto.getRandomValues(new Uint8Array(32)));
			await store.putExposure({
				label,
				sandboxId,
				port,
				createdAt: now(),
				...(token === undefined ? {} : { tokenHash: await sha256Hex(token) }),
				...(grantee === undefined ? {} : { grantee }),
			});
			const url = `${scheme}://${label}.${domain}/`;
			return { url: token === undefined ? url : `${url}?${PORT_TOKEN_PARAM}=${token}` };
		},
		hide(sandboxId, port) {
			return store.removeExposures(sandboxId, port);
		},
		forget(sandboxId) {
			return store.removeExposures(sandboxId);
		},
		async fetch(request, client) {
			const url = new URL(request.url);
			const exposure = await lookup(url.hostname);
			if (exposure === undefined) return undefined;
			if (exposure === null) return text(404, "No sandbox port is exposed here.");
			const query = url.searchParams.get(PORT_TOKEN_PARAM);
			const token = await admitted(exposure, query, request.headers.get("cookie"));
			if (token === undefined) {
				return text(401, "This port needs its token: open the URL Kantel gave you, with its _token.");
			}
			if (options.stillAllowed !== undefined && !(await options.stillAllowed(exposure.grantee, exposure.sandboxId))) {
				return text(403, "Whoever exposed this port no longer has access to its sandbox.");
			}
			if (query !== null) {
				url.searchParams.delete(PORT_TOKEN_PARAM);
				if (exposure.tokenHash !== undefined && (request.method === "GET" || request.method === "HEAD")) {
					// Trade the token for a cookie on this one name, and take it out of the address bar and history.
					const secure = scheme === "https" ? "; Secure" : "";
					return new Response(null, {
						status: 303,
						headers: {
							location: `${url.pathname}${url.search}`,
							"set-cookie": `${PORT_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}`,
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
		async upgrade(host, path, cookie) {
			const hostname = host.replace(/:\d+$/, "");
			const exposure = await lookup(hostname);
			if (exposure === undefined) return undefined;
			if (exposure === null) return { ok: false, status: 404, reason: "No sandbox port is exposed here" };
			const url = new URL(path, "http://port");
			const query = url.searchParams.get(PORT_TOKEN_PARAM);
			if ((await admitted(exposure, query, cookie)) === undefined) {
				return { ok: false, status: 401, reason: "This port needs its token" };
			}
			if (options.stillAllowed !== undefined && !(await options.stillAllowed(exposure.grantee, exposure.sandboxId))) {
				return { ok: false, status: 403, reason: "Whoever exposed this port no longer has access" };
			}
			url.searchParams.delete(PORT_TOKEN_PARAM);
			return {
				ok: true,
				sandboxId: exposure.sandboxId,
				port: exposure.port,
				path: `${url.pathname}${url.search}`,
				host,
				...(exposure.grantee === undefined ? {} : { grantee: exposure.grantee }),
			};
		},
	};
}
